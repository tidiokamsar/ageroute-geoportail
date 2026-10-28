import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Garde de conformite au paragraphe 7.1 du mandat v2.1 : « requetes spatiales en SQL
 * parametre (`$queryRaw` avec gabarits, JAMAIS de concatenation de chaines) ».
 *
 * POURQUOI UNE GARDE PLUTOT QU'UNE REECRITURE
 *
 * Le 14/10/2026, trois usages de `$queryRawUnsafe` subsistaient, et l'examen a montre que
 * AUCUN n'interpole de valeur d'appelant :
 *
 *   geo/appariement.ts   parametres POSITIONNELS ($1, $2, $3) passes dans un tableau. Les
 *                        valeurs sont donc liees par le pilote ; seule la structure —
 *                        perimetre et borne d'emprise — vient d'un ensemble ferme. C'est la
 *                        forme documentee pour des parametres positionnels, et la requete est
 *                        critique en performance (un commentaire du fichier mesure 2,5 s sans
 *                        le filtre d'emprise contre quelques millisecondes avec).
 *   lib/reseau.ts        AUCUN parametre : une chaine statique avec une clause choisie parmi
 *                        trois litteraux.
 *
 * Les reecrire en gabarits serait du brassage, avec un risque de regression sur un chemin de
 * performance et sur l'API publique, pour un gain de securite nul.
 *
 * Ce qui manquait n'etait donc pas la reecriture, c'etait la GARANTIE. Le matin du 14/10,
 * `reseau/couverture.reseau.ts` a interpole `AND t."regionId" = ${regionId}` dans le texte
 * d'une requete, et rien ne l'a signale : la validation Zod vivait dans la route, pas dans la
 * fonction. Ce test aurait echoue.
 *
 * CE QU'IL IMPOSE
 *
 * Tout fichier qui emploie `$queryRawUnsafe` doit figurer ci-dessous avec sa raison. Un
 * nouveau fichier fait echouer le test, ce qui force une decision consciente plutot qu'une
 * habitude.
 */

/**
 * Fichiers autorises a employer `$queryRawUnsafe`, avec leur raison et, quand il y en a une,
 * la GARDE qui doit etre presente dans le fichier.
 *
 * `garde` rend la justification verifiable : dire « c'est protege par une liste blanche » sans
 * que la liste existe serait une excuse, pas une garantie.
 */
const AUTORISES: Readonly<Record<string, { raison: string; garde?: string }>> = {
  "geo/appariement.ts": {
    raison:
      "parametres positionnels ($1, $2, $3) lies par le pilote ; seule la structure est "
      + "interpolee, depuis un ensemble ferme. Requete critique en performance : le filtre "
      + "d'emprise fait passer la requete de 2,5 s a quelques millisecondes.",
  },
  "lib/reseau.ts": {
    raison:
      "aucun parametre : chaine statique, clause choisie parmi trois litteraux. "
      + "Un fragment Prisma.sql equivalent existe desormais (fragmentPerimetre) pour les "
      + "nouveaux appelants.",
  },
  "lib/geo.ts": {
    raison:
      "le nom de TABLE est interpole parce qu'un identifiant SQL ne peut pas etre lie comme "
      + "parametre — c'est la seule technique possible. Il est donc filtre par une liste "
      + "blanche qui leve une exception sinon, et les valeurs passent en parametres "
      + "positionnels.",
    garde: "ALLOWED_TABLES",
  },
  "api-v2/export.routes.ts": {
    raison:
      "le nom de TABLE est interpole parce qu'un identifiant SQL ne peut pas etre lie comme "
      + "parametre — meme technique que lib/geo.ts. La table vient d'une liste blanche fermee "
      + "(TABLES, refusee sinon avec TABLE_REFUSEE) ; les identifiants de la selection passent "
      + "en parametre positionnel ($1::text[]).",
    garde: "TABLES",
  },
};

const RACINE = join(__dirname, "..");

function fichiersTs(repertoire: string, acc: string[] = []): string[] {
  for (const entree of readdirSync(repertoire)) {
    const chemin = join(repertoire, entree);
    if (statSync(chemin).isDirectory()) {
      fichiersTs(chemin, acc);
    } else if (entree.endsWith(".ts") && !entree.endsWith(".test.ts")) {
      acc.push(chemin);
    }
  }
  return acc;
}

/**
 * Le fichier APPELLE-T-IL `$queryRawUnsafe`, plutot que d'en parler ?
 *
 * Les commentaires sont retires avant la recherche. Sans cela, ce test se declenchait sur sa
 * propre explication : `reseau/couverture.reseau.ts` cite `$queryRawUnsafe` dans le
 * commentaire qui raconte pourquoi il ne l'emploie plus. Un test qui confond une mention et
 * un usage interdit d'expliquer ses propres corrections.
 */
function emploie(source: string): boolean {
  const sansCommentaires = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
  return /\$queryRawUnsafe/.test(sansCommentaires);
}

/** Chemin relatif a `src`, en separateurs POSIX, pour que la liste soit lisible. */
function relatif(chemin: string): string {
  return chemin.slice(RACINE.length + 1).split("\\").join("/");
}

describe("Paragraphe 7.1 : aucune concatenation de valeur dans une requete SQL", () => {
  const fichiers = fichiersTs(RACINE);

  it("parcourt bien l'arborescence des sources", () => {
    // Si ce compte tombe a zero, le test passerait en ne verifiant rien.
    expect(fichiers.length).toBeGreaterThan(50);
  });

  it("seuls les fichiers justifies emploient $queryRawUnsafe", () => {
    const usagers = fichiers
      .filter((f) => emploie(readFileSync(f, "utf8")))
      .map(relatif)
      .sort();

    const nonJustifies = usagers.filter((f) => !(f in AUTORISES));

    expect(nonJustifies, nonJustifies.length
      ? `Ces fichiers emploient $queryRawUnsafe sans justification : ${nonJustifies.join(", ")}.`
        + " Employez $queryRaw avec un gabarit, ou ajoutez le fichier a AUTORISES en disant"
        + " pourquoi l'interpolation ne porte aucune valeur d'appelant."
      : undefined,
    ).toEqual([]);
  });

  it("la liste des justifications ne contient pas de fichier disparu", () => {
    // Une justification orpheline laisse croire qu'un risque est connu et accepte, alors que
    // le fichier n'existe plus : la liste perdrait son sens.
    const existants = new Set(fichiers.map(relatif));
    const orphelins = Object.keys(AUTORISES).filter((f) => !existants.has(f));
    expect(orphelins).toEqual([]);
  });

  it("chaque justification dit pourquoi, et pas seulement que c'est permis", () => {
    for (const [fichier, { raison }] of Object.entries(AUTORISES)) {
      expect(raison.length, fichier).toBeGreaterThan(40);
      expect(raison.toLowerCase(), fichier).toMatch(/parametre|litteraux|statique|positionnel|liste blanche/);
    }
  });

  it("une justification qui invoque une garde doit la trouver dans le fichier", () => {
    for (const [fichier, { garde }] of Object.entries(AUTORISES)) {
      if (!garde) continue;
      const source = readFileSync(join(RACINE, fichier), "utf8");
      expect(source, `${fichier} invoque la garde ${garde}, qui ne s'y trouve pas`)
        .toContain(garde);
    }
  });

  it("le module de couverture reseau n'y figure pas : il a ete corrige, pas excuse", () => {
    // Memoire du 14/10/2026. Le reinscrire ici serait documenter une regression.
    expect(Object.keys(AUTORISES)).not.toContain("reseau/couverture.reseau.ts");
    const source = readFileSync(join(RACINE, "reseau/couverture.reseau.ts"), "utf8");
    // Le mot subsiste dans un commentaire explicatif ; ce qui compte est l'absence d'appel.
    expect(source).not.toMatch(/prisma\.\$queryRawUnsafe/);
  });
});

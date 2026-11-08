/**
 * GARDE-FOU DE LA FRONTIERE DIGITALROAD (arbitrage D1, critere A29).
 *
 * Le paragraphe 14.12 pose TI-01 : « AUCUNE ENTREPRISE, AUCUN MARCHE, AUCUN MONTANT
 * CONTRACTUEL : des qu'un prestataire ou un marche intervient, l'objet vit dans DigitalRoad ».
 * Le critere A29 le redit a la sortie : « aucun paiement, decompte ou marche n'est cree ni
 * modifie par la plateforme ».
 *
 * CE TEST EXISTE PARCE QUE LA FRONTIERE EST TENUE PAR UNE ABSENCE, et qu'une absence ne se
 * defend pas toute seule. `taches_internes` n'a aucune colonne de montant ni de marche : la
 * regle est donc structurelle plutot que documentaire. Mais rien n'empeche quelqu'un d'ajouter
 * un jour `montantEstime` « juste pour information » — et ce jour-la, la plateforme aurait
 * commence a dupliquer l'ERP sans qu'aucune alarme ne sonne.
 *
 * C'est le meme dispositif que `lib/sql-parametre.test.ts` pour le SQL concatene : une regle
 * qu'on ne peut pas confier a la relecture est confiee a un test.
 *
 * ET IL VERIFIE AUSSI LA PRESENCE, pas seulement l'absence. Un garde-fou qui n'interdit que
 * passerait sur un modele vide : il faut donc que les champs exiges par TI-01 soient la.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RACINE = join(__dirname, "..", "..");

/**
 * Retire les commentaires avant d'analyser.
 *
 * NECESSAIRE, et l'experience l'a montre : un premier garde-fou de ce depot se declenchait sur
 * sa propre explication. Les commentaires de ce modele CITENT les mots interdits — « aucun
 * montant, aucun marche » — donc les scanner ferait echouer le test precisement parce que la
 * regle y est bien expliquee.
 */
function sansCommentaires(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*(\/\/\/?|--).*$/gm, "")
    .replace(/\s(\/\/\/?|--)\s.*$/gm, "");
}

/** Le bloc `model TacheInterne { ... }` du schema, commentaires retires. */
function modeleTacheInterne(): string {
  const schema = readFileSync(join(RACINE, "prisma", "schema.prisma"), "utf8");
  const bloc = /^model TacheInterne \{([\s\S]*?)^\}/m.exec(schema);
  expect(bloc, "le modele TacheInterne a disparu du schema").not.toBeNull();
  return sansCommentaires(bloc![1]);
}

/**
 * Les mots qui trahiraient un objet contractuel.
 *
 * `quantite` n'y est PAS, et c'est la nuance centrale de TI-01 : une quantite constatee est un
 * fait de terrain, un montant est un engagement. Interdire les quantites viderait la tache
 * interne de son contenu ; les autoriser sans interdire les montants ouvrirait la porte a l'ERP.
 */
const MOTS_CONTRACTUELS = [
  "montant",
  "prix",
  "cout",
  "marche",
  "entreprise",
  "prestataire",
  "decompte",
  "paiement",
  "facture",
  "devise",
  "gnf",
  "attributaire",
  "titulaire",
  "bailleur",
];

describe("TI-01 : la frontiere DigitalRoad est tenue par l'absence des colonnes", () => {
  it("le modele TacheInterne ne porte aucun champ contractuel", () => {
    const modele = modeleTacheInterne();

    for (const mot of MOTS_CONTRACTUELS) {
      const trouve = new RegExp(`^\\s*\\w*${mot}\\w*\\s`, "im").exec(modele);
      expect(
        trouve,
        `champ interdit par TI-01 dans TacheInterne : « ${trouve?.[0]?.trim()} ». ` +
          `Des qu'un marche ou un prestataire intervient, l'objet vit dans DigitalRoad ` +
          `(arbitrage D1, critere A29).`,
      ).toBeNull();
    }
  });

  it("le modele ne cite aucune relation vers un objet contractuel", () => {
    const modele = modeleTacheInterne();

    // Les modeles contractuels du depot, geles par l'ADR-003. Une relation vers l'un d'eux
    // depuis une tache interne serait exactement la duplication que D1 interdit.
    for (const type of ["Marche", "Decompte", "OrdreTravaux", "Chantier", "Bailleur"]) {
      expect(
        new RegExp(`\\b${type}\\b`).test(modele),
        `relation interdite vers ${type} : l'ADR-003 gele ces objets et D1 maintient la frontiere`,
      ).toBe(false);
    }
  });

  it("la migration n'ecrit aucune colonne contractuelle ni cle vers marches", () => {
    const sql = sansCommentaires(
      readFileSync(
        join(RACINE, "prisma", "migrations", "20261014210000_taches_internes", "migration.sql"),
        "utf8",
      ),
    );

    // On ne regarde que la creation de `taches_internes` : le reste du fichier cree le
    // referentiel des natures, dont les libelles sont du texte libre.
    const creation = /CREATE TABLE IF NOT EXISTS "taches_internes" \(([\s\S]*?)\n\);/m.exec(sql);
    expect(creation, "la creation de taches_internes a disparu de la migration").not.toBeNull();

    for (const mot of MOTS_CONTRACTUELS) {
      expect(
        new RegExp(`"\\w*${mot}\\w*"`, "i").test(creation![1]),
        `colonne interdite par TI-01 contenant « ${mot} »`,
      ).toBe(false);
    }
    expect(
      /REFERENCES\s+"(marches|decomptes|ordres_travaux|chantiers)"/i.test(creation![1]),
      "cle etrangere interdite vers un objet contractuel",
    ).toBe(false);
  });
});

describe("TI-01 : et les champs que le mandat exige sont bien la", () => {
  // SANS CE BLOC, le garde-fou ci-dessus passerait sur un modele vide — il n'interdit que.
  // Le paragraphe 14.12 enumere ce qu'une tache interne doit porter ; on le verifie.
  const EXIGES: [string, string][] = [
    ["reference", "identifiant stable"],
    ["tronconId", "perimetre geographique"],
    ["defautId", "defaut d'origine"],
    ["ouvrageId", "actif d'origine"],
    ["responsableId", "responsable"],
    ["echeanceLe", "echeance"],
    ["preuveAvantChemin", "preuve avant"],
    ["preuveApresChemin", "preuve apres"],
    ["quantiteConstatee", "quantites constatees"],
    ["clotureeLe", "cloture"],
    ["clientOperationId", "idempotence hors ligne"],
    ["deletedAt", "suppression logique uniquement"],
  ];

  it.each(EXIGES)("porte %s, pour %s", (champ) => {
    expect(new RegExp(`^\\s*${champ}\\s`, "m").test(modeleTacheInterne())).toBe(true);
  });

  it("l'unite accompagne la quantite, sinon le chiffre ne veut rien dire", () => {
    expect(/^\s*quantiteUnite\s/m.test(modeleTacheInterne())).toBe(true);
  });

  it("la nature est un referentiel administrable, pas une enumeration figee", () => {
    const schema = readFileSync(join(RACINE, "prisma", "schema.prisma"), "utf8");
    // `ALTER TYPE ... ADD VALUE` est irreversible : la decision D-06 en montre le cout, avec
    // `ClasseRoute` qui n'a aucune valeur pour les 19 846 km de routes communautaires.
    expect(/^model ReferentielNatureTache \{/m.test(schema)).toBe(true);
    expect(/^enum NatureTacheInterne \{/m.test(schema)).toBe(false);
  });
});

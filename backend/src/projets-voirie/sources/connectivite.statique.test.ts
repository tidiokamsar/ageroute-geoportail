import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * AUCUNE CONNEXION N EST DEDUITE D UNE PROXIMITE (lot S1 ; cahier v2, 20.3 ; decision architecturale 2, section 5). Test STATIQUE : il lit le code.
 *
 * Une relation CONNECTE_A n est ecrite que par deux fonctions connues : la saisie humaine (`insererRelationManuelle`, via la route B1) et la
 * declaration d un fichier importe (`insererConnexionsDeclarees`, resolution par le NOM d un objet du meme jeu). Le detecteur ci-dessous refuse :
 *   1. tout texte SQL (litteral gabarit) qui ecrit dans `reseau_relations` en mentionnant CONNECTE_A ET qui contient un predicat ou une mesure
 *      spatiale (ST_DWithin, ST_Intersects, ST_Touches, ST_Distance, ST_Buffer, ST_Within, ST_Covers, ST_Contains, ST_Equals, ST_Snap, ST_ClosestPoint,
 *      l operateur && ou <->) ;
 *   2. toute fonction exportee, autre que les deux autorisees, dont le corps ecrit CONNECTE_A.
 * La mutation (un extrait qui propose des connexions par ST_DWithin) prouve que le detecteur echoue quand il le doit.
 */
const SRC = join(__dirname, "..", "..");
const SPATIAL = /\bST_(DWithin|Intersects|Touches|Distance|Buffer|Within|Covers|CoveredBy|Contains|Equals|Snap|ClosestPoint|Crosses|Overlaps)\b|&&|<->/i;
const AUTORISEES = new Set(["insererRelationManuelle", "insererConnexionsDeclarees"]);

/** Litteraux gabarits (entre accents graves) d un source, sans les commentaires de ligne. */
function gabarits(texte: string): string[] {
  const sans = texte.replace(/^\s*\/\/.*$/gm, "");
  return [...sans.matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}

/** Violations du detecteur dans un texte source (nom de fichier pour le message). */
export function detecterConnexionsDeduites(texte: string, fichier: string): string[] {
  const violations: string[] = [];
  for (const g of gabarits(texte)) {
    if (/reseau_relations/.test(g) && /CONNECTE_A/.test(g) && /\b(INSERT|UPDATE)\b/i.test(g) && SPATIAL.test(g)) {
      violations.push(`${fichier} : ecriture de CONNECTE_A appuyee sur un predicat spatial`);
    }
  }
  for (const m of texte.matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*\(([\s\S]*?)\n\}/g)) {
    const [, nom, corps] = m;
    if (/CONNECTE_A/.test(corps) && /\b(INSERT|UPDATE)\b[\s\S]*reseau_relations|reseau_relations[\s\S]*\b(INSERT|UPDATE)\b/i.test(corps) && !AUTORISEES.has(nom)) {
      violations.push(`${fichier} : la fonction ${nom} ecrit CONNECTE_A (seules ${[...AUTORISEES].join(" et ")} le peuvent)`);
    }
  }
  return violations;
}

function sources(dossier: string): string[] {
  const sortie: string[] = [];
  for (const nom of readdirSync(dossier)) {
    const p = join(dossier, nom);
    if (statSync(p).isDirectory()) { if (nom !== "node_modules") sortie.push(...sources(p)); }
    else if (/\.ts$/.test(nom) && !/\.test\.ts$/.test(nom) && !/\.d\.ts$/.test(nom)) sortie.push(p);
  }
  return sortie;
}

describe("aucune connexion deduite d'une proximite", () => {
  it("le code du depot ne contient aucune ecriture de CONNECTE_A appuyee sur un predicat spatial, ni hors des deux fonctions autorisees", () => {
    const violations = sources(SRC).flatMap((f) => detecterConnexionsDeduites(readFileSync(f, "utf8"), relative(SRC, f)));
    expect(violations).toEqual([]);
  });

  it("les deux fonctions autorisees existent et sont bien celles qui ecrivent CONNECTE_A (garde contre un renommage qui viderait le test)", () => {
    const depot = readFileSync(join(SRC, "projets-voirie", "reseaux", "reseaux.depot.ts"), "utf8");
    expect(depot).toMatch(/export async function insererConnexionsDeclarees/);
    expect(depot).toMatch(/export async function insererRelationManuelle/);
    expect(depot).toMatch(/'CONNECTE_A'::"TypeRelationReseau"/);
  });

  it("MUTATION : une fonction qui proposerait des connexions par proximite (ST_DWithin) est detectee", () => {
    const mutant = [
      "export async function proposerConnexions(tx: Tx, jeuId: string) {",
      "  await tx.$executeRaw`INSERT INTO \"reseau_relations\" (\"typeRelation\", \"sourceObjetId\", \"cibleObjetId\") SELECT 'CONNECTE_A', a.\"id\", b.\"id\" FROM objets a JOIN objets b ON ST_DWithin(a.\"geom\", b.\"geom\", 0.5)`;",
      "}",
    ].join("\n");
    const v = detecterConnexionsDeduites(mutant, "mutant.ts");
    expect(v.length).toBe(2);
    expect(v[0]).toMatch(/predicat spatial/);
    expect(v[1]).toMatch(/proposerConnexions/);
  });

  it("MUTATION : la meme ecriture sans predicat spatial mais hors des fonctions autorisees est detectee ; l'operateur && aussi", () => {
    expect(detecterConnexionsDeduites("export async function relierTout(tx: Tx) {\n  await tx.$executeRaw`INSERT INTO \"reseau_relations\" VALUES ('CONNECTE_A')`;\n}", "m.ts")).toHaveLength(1);
    expect(detecterConnexionsDeduites("const q = `UPDATE \"reseau_relations\" SET x = 'CONNECTE_A' WHERE a.g && b.g`;", "m.ts")).toHaveLength(1);
  });
});

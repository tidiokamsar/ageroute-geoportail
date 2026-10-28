import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * ISOLATION DU MODULE (contrat v2, regles 5 et 10). Tests statiques : ils lisent le code source.
 *
 *   1. AUCUNE ecriture hors des tables du module et de `audit_logs` : ni SQL (`INSERT INTO`, `UPDATE`, `DELETE FROM`), ni delegue Prisma
 *      (`tx.xxx.create/update/delete...`) sur une table du referentiel officiel (troncons, ouvrages, portions, chantiers...).
 *      Le banc PostGIS le prouve aussi sur la base (comptes de TOUTES les tables avant/apres).
 *   2. AUCUN autre code ne lit les donnees du module : ni l'API publique, ni les tuiles, ni les exports de la carte, ni la recherche.
 *      Seules exceptions : `lib/access.ts` (types d'entite de l'historique d'audit), le montage et la cle de module.
 *   3. Aucune requete SQL non parametree dans le module.
 */
const SRC = join(__dirname, "..");
const MODULE = join(SRC, "projets-voirie");
const ROUTES = join(SRC, "api-v2", "projets-voirie.routes.ts");

function sources(dossier: string): string[] {
  const sortie: string[] = [];
  for (const nom of readdirSync(dossier)) {
    const p = join(dossier, nom);
    if (statSync(p).isDirectory()) sortie.push(...sources(p));
    else if (/\.ts$/.test(nom) && !/\.test\.ts$/.test(nom) && !/\.d\.ts$/.test(nom)) sortie.push(p);
  }
  return sortie;
}
const lire = (p: string) => readFileSync(p, "utf8");

const TABLES_DU_MODULE = ["projets_voirie", "projets_voirie_jeux", "projets_voirie_objets", "concessionnaires_reseau", "audit_logs"];
const DELEGUES_DU_MODULE = ["projetVoirie", "jeuDonneesProjet", "objetProjet", "concessionnaireReseau", "auditLog"];

const fichiersDuModule = [...sources(MODULE), ROUTES];

describe("le module n'ecrit que dans ses propres tables", () => {
  it("le module contient du code a verifier (garde contre une lecture qui ne trouve rien)", () => {
    expect(fichiersDuModule.length).toBeGreaterThan(8);
  });

  it("SQL : INSERT INTO, UPDATE et DELETE FROM ne visent que les tables du module et audit_logs", () => {
    const ecritures: string[] = [];
    for (const f of fichiersDuModule) {
      const code = lire(f);
      for (const m of code.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?([a-z_]+)"?/g)) {
        // Un « UPDATE » en commentaire ou en action d'audit n'est pas suivi d'un nom de table en minuscules.
        ecritures.push(`${relative(SRC, f)} -> ${m[1]}`);
      }
    }
    expect(ecritures.length, "au moins l'insertion des objets").toBeGreaterThan(0);
    const hors = ecritures.filter((e) => !TABLES_DU_MODULE.includes(e.split(" -> ")[1]));
    expect(hors, `ecritures SQL hors du module :\n${hors.join("\n")}`).toEqual([]);
  });

  it("Prisma : create / update / delete / upsert ne visent que les delegues du module", () => {
    const hors: string[] = [];
    let trouvees = 0;
    for (const f of fichiersDuModule) {
      for (const m of lire(f).matchAll(/\b(?:tx|prisma)\.([a-zA-Z]+)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/g)) {
        trouvees += 1;
        if (!DELEGUES_DU_MODULE.includes(m[1])) hors.push(`${relative(SRC, f)} -> ${m[1]}.${m[2]}`);
      }
    }
    expect(trouvees).toBeGreaterThan(5);
    expect(hors, `ecritures Prisma hors du module :\n${hors.join("\n")}`).toEqual([]);
  });

  it("aucune requete brute non parametree ($queryRawUnsafe, $executeRawUnsafe) dans le module", () => {
    const fautifs = fichiersDuModule.filter((f) => /\$(?:query|execute)RawUnsafe/.test(lire(f)));
    expect(fautifs.map((f) => relative(SRC, f))).toEqual([]);
  });

  it("le module ne cree ni ordre, ni decision, ni deplacement : aucune ecriture sur les ordres de travaux, programmations, propositions, chantiers ou le referentiel", () => {
    const interdits = /\b(ordreTravaux|ordres_travaux|programmeBudgetaire|ficheIntervention|chantier|propositionTeledetection|troncon|ouvrage|portion|defaut|observation)\b/i;
    for (const f of fichiersDuModule) {
      const code = lire(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const m of code.matchAll(/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?([a-z_]+)"?|(?:tx|prisma)\.([a-zA-Z]+)\.(?:create|update|upsert|delete)/g)) {
        expect(interdits.test(m[1] ?? m[2] ?? ""), `${relative(SRC, f)} : ${m[0]}`).toBe(false);
      }
    }
  });
});

describe("rien d'autre dans le code ne lit les donnees du module (jamais d'API publique, de tuile ni d'export de carte)", () => {
  const MOTIFS = /projets_voirie|concessionnaires_reseau|\b(?:projetVoirie|jeuDonneesProjet|objetProjet|concessionnaireReseau)\b|\bJeuDonneesProjet\b|\bObjetProjet\b|\bProjetVoirie\b|\bConcessionnaireReseau\b|projets-voirie\//;
  const ALLOWED = new Set([
    // Types d'entite de l'historique d'audit, controles par la cle de module (MODULE_PAR_ENTITE).
    join("lib", "access.ts"),
    // Montage du routeur.
    join("api-v2", "index.ts"),
    join("api-v2", "projets-voirie.routes.ts"),
    // Cle de module.
    join("lib", "modules.ts"),
  ]);

  it("aucun fichier hors du module ne reference ses tables, modeles ou services (hors audit, montage, cle de module)", () => {
    const intrus: string[] = [];
    for (const f of sources(SRC)) {
      const rel = relative(SRC, f);
      if (rel.startsWith(`projets-voirie${sep}`) || ALLOWED.has(rel)) continue;
      if (MOTIFS.test(lire(f))) intrus.push(rel);
    }
    expect(intrus, `fichiers qui lisent ou referencent le module :\n${intrus.join("\n")}`).toEqual([]);
  });

  it("en particulier : API publique, tuiles, export et recherche n'y touchent pas (garde contre une exception ajoutee a la liste)", () => {
    for (const dossier of ["modules/public", "tuiles"]) {
      for (const f of sources(join(SRC, dossier))) expect(MOTIFS.test(lire(f)), relative(SRC, f)).toBe(false);
    }
    for (const f of [join(SRC, "api-v2", "export.routes.ts"), join(SRC, "modules", "search", "search.routes.ts")]) {
      expect(MOTIFS.test(lire(f)), relative(SRC, f)).toBe(false);
    }
    expect([...ALLOWED].some((a) => /public|tuiles|export|search/.test(a))).toBe(false);
  });

  it("le routeur du module n'est monte que sous /api/v2 (jamais sous /api/public)", () => {
    const app = lire(join(SRC, "app.ts"));
    expect(/projets-?voirie/i.test(app)).toBe(false);
    expect(lire(join(SRC, "api-v2", "index.ts"))).toMatch(/apiV2Router\.use\("\/projets-voirie", projetsVoirieV2Router\)/);
  });

  it("la cle de module existe cote serveur et n'est portee par aucun profil metier (geste d'administration)", () => {
    expect(lire(join(SRC, "lib", "modules.ts"))).toContain('"projets-voirie"');
    expect(lire(join(SRC, "lib", "profils.ts"))).not.toContain("projets-voirie");
  });
});

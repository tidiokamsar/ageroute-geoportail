// Banc d'integration des complements de coherence de la partie E (A30) : voir tests-integration/README.md.
// Lancer (DATABASE_URL pointe sur `replay`) : npx tsx tests-integration/coherence.integration.mts
//
// Le banc travaille dans un CLONE jetable de `replay` (essai_coherence), cree puis detruit par lui-meme, et
// lui applique la migration 20261025120000 (absente de `replay` tant qu'elle n'y est pas rejouee). Il eprouve
// par le SERVICE (`teledetection.service`) et par la base : ce que la migration refuse, ce que la vue signale,
// et que sa descente rend exactement la regle d'origine.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { evaluerCible } from "./lib/garde.ts";
import { creerClone, supprimerClone, urlClone } from "./lib/clone.ts";
import { verifier, conclure } from "./lib/verdict.ts";

const ORIGINE = process.env.DATABASE_URL;
const cible = evaluerCible(ORIGINE);
if (!cible.ok || cible.base !== "replay") {
  console.error("Banc d'integration refuse : DATABASE_URL doit etre une base locale nommee replay (le clone est cree par le banc).");
  process.exit(3);
}
const NOM_CLONE = "essai_coherence";
await creerClone(ORIGINE!, NOM_CLONE);
const URL_CLONE = urlClone(ORIGINE!, NOM_CLONE);
process.env.DATABASE_URL = URL_CLONE;
console.log("Cible du banc : clone jetable " + NOM_CLONE);

const ICI = dirname(fileURLToPath(import.meta.url));
const R = new URL("../src/", pathToFileURL(process.argv[1]).href).href;
const imp = (p: string) => import(R + p + ".ts");
const { prisma } = await imp("lib/prisma");
const td = await imp("teledetection/teledetection.service");

const require = createRequire(import.meta.url);
const pg = require("pg");
const MIGRATION = join(ICI, "../prisma/migrations/20261025120000_teledetection_coherence_complements/migration.sql");
const DESCENTE = join(ICI, "../prisma/descentes/20261025120000_teledetection_coherence_complements.sql");

async function sqlMulti(texte: string) {
  const c = new pg.Client({ connectionString: URL_CLONE });
  await c.connect();
  try { await c.query(texte); } finally { await c.end(); }
}
const sql = (q: string, ...a: unknown[]) => prisma.$executeRawUnsafe(q, ...a);
const lire = <T = Record<string, unknown>>(q: string, ...a: unknown[]) => prisma.$queryRawUnsafe<T[]>(q, ...a);
async function echec(f: () => Promise<unknown>): Promise<string | null> {
  try { await f(); return null; } catch (e) { return e instanceof td.RefusTeledetection ? `${e.code}` : String((e as Error).message ?? e); }
}
const ctx = { auteurId: "u-coh" };
const EMPRISE = { type: "Polygon", coordinates: [[[-13.7, 9.5], [-13.4, 9.5], [-13.4, 9.8], [-13.7, 9.8], [-13.7, 9.5]]] };
const produit = (code: string, date: string) => ({
  code, palier: 0, source: "Sentinel-1 GRD", nature: "RADAR", dateAcquisition: new Date(date), resolutionM: 10,
  incertitude: "chatoiement radar", provenance: `scene-${code}`, licence: "relevee a la source", versionTraitement: "v0", emprise: EMPRISE,
});
// Depuis le workflow EO (migrations 20261028*), une proposition deposee doit porter ses limites (LIMITES_REQUISES) : le banc de lot/17 les fournit.
const point = (x: number, y: number) => ({ type: "INONDATION", geometrie: { type: "Point", coordinates: [x, y] }, limites: ["resolution native 10 m, banc d'integration"] });

async function main() {
  const vueAvant = (await lire<{ d: string }>(`SELECT pg_get_viewdef('coherence_teledetection'::regclass) AS d`))[0].d;
  await sqlMulti(readFileSync(MIGRATION, "utf8"));
  verifier("la migration s'applique au clone", (await lire<{ n: number }>(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'earth_observation_products_garde'`))[0].n === 1);

  await sql(`INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt") VALUES ('u-coh','coh@local.invalid','Integ','x','GESTIONNAIRE',now())`);
  await sql(`INSERT INTO regions (nom) VALUES ('Region integ coherence')`);
  await sql(`INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt")
    VALUES ('t-coh', 'COH-A', 'Troncon integ', 'RN', (SELECT id FROM regions WHERE nom='Region integ coherence'), 1.1, 'BITUME', 0, 1.1,
    ST_SetSRID(ST_MakeLine(ST_MakePoint(-13.60, 9.64), ST_MakePoint(-13.59, 9.64)), 4326), now())`);

  const apres = await td.enregistrerProduit(prisma, produit("COH-APRES", "2026-10-02"), ctx);
  const avant = await td.enregistrerProduit(prisma, produit("COH-AVANT", "2026-09-01"), ctx);
  const retire = await td.enregistrerProduit(prisma, produit("COH-RETIRE", "2026-08-01"), ctx);
  await sql(`UPDATE earth_observation_products SET "deletedAt" = now() WHERE id = $1`, retire.id);

  // ---- par le service ----
  const lot = await td.deposerPropositions(prisma, { produitId: apres.id, produitReferenceId: avant.id, methode: "diff v0", toleranceRattachementM: 50, propositions: [point(-13.595, 9.6401), point(-13.5, 9.7)] }, ctx);
  const ratt = await lire<{ tronconId: string | null }>(`SELECT "tronconId" FROM propositions_teledetection WHERE id = ANY($1::text[]) ORDER BY "tronconId" NULLS LAST`, lot.ids);
  verifier("un lot coherent passe le declencheur remplace : 2 deposees, 1 rattachee a sa distance mesuree", lot.deposees === 2 && ratt[0].tronconId === "t-coh", { lot, ratt });
  verifier("une reference retiree est refusee par le service (REFERENCE_INEXISTANTE)", (await echec(() => td.deposerPropositions(prisma, { produitId: apres.id, produitReferenceId: retire.id, methode: "m", propositions: [point(-13.6, 9.6)] }, ctx))) === "REFERENCE_INEXISTANTE");
  verifier("la regle d'origine tient : hors emprise refuse (HORS_EMPRISE)", (await echec(() => td.deposerPropositions(prisma, { produitId: apres.id, methode: "m", propositions: [point(-9.9, 10.1)] }, ctx))) === "HORS_EMPRISE");

  // ---- par la base, chemins que le service ne prend pas ----
  const direct = (produitId: string, extra = "", valeurs = "") => echec(() => sql(`INSERT INTO propositions_teledetection (id, "produitId", type, methode, geom, "creeParId"${extra}) VALUES ('x-${Math.random()}', $1, 'INONDATION', 'm', ST_SetSRID(ST_MakePoint(-13.595, 9.6401), 4326), 'u-coh'${valeurs})`, produitId));
  verifier("en base : une proposition sur un produit retire est refusee", /retire du registre/.test((await direct(retire.id)) ?? ""));
  verifier("en base : une distance au troncon declaree (0,5 m) au lieu de mesuree est refusee", /declaree 0.5 m/.test((await direct(apres.id, `, "tronconId", "distanceTronconM"`, `, 't-coh', 0.5`)) ?? ""));
  verifier("en base : la licence d'un produit cite ne se modifie plus", /provenance est figee/.test((await echec(() => sql(`UPDATE earth_observation_products SET licence = 'autre' WHERE id = $1`, apres.id))) ?? ""));
  verifier("en base : aucun produit ne se supprime physiquement", /suppression physique refusee/.test((await echec(() => sql(`DELETE FROM earth_observation_products WHERE id = $1`, retire.id))) ?? ""));

  // ---- la vue, lue par le service ----
  const c0 = await td.coherence(prisma);
  verifier("jeu coherent : aucune anomalie", c0.anomalies.length === 0, c0);
  await sql(`INSERT INTO missions (id, code, intitule, type, statut, "createurId", "updatedAt") VALUES ('m-coh', 'COH-M', 'Verification', 'SURVEILLANCE', 'TERMINEE', 'u-coh', now())`);
  await sql(`UPDATE propositions_teledetection SET "missionId" = 'm-coh' WHERE id = $1`, lot.ids[1]);
  await sql(`UPDATE earth_observation_products SET "deletedAt" = now() WHERE id = $1`, apres.id);
  const c1 = await td.coherence(prisma);
  const regles = c1.anomalies.map((a: { regle: string; gravite: string }) => `${a.regle}:${a.gravite}`).sort();
  verifier("apres coup : mission terminee sans verdict et produit retire avec 2 propositions en attente, A_EXAMINER",
    JSON.stringify(regles) === JSON.stringify(["MISSION_SANS_VERDICT:A_EXAMINER", "PRODUIT_RETIRE_EN_ATTENTE:A_EXAMINER", "PRODUIT_RETIRE_EN_ATTENTE:A_EXAMINER"]) && c1.bloquantes === 0, regles);

  // ---- la descente rend la regle d'origine ----
  await sqlMulti(readFileSync(DESCENTE, "utf8"));
  const vueApres = (await lire<{ d: string }>(`SELECT pg_get_viewdef('coherence_teledetection'::regclass) AS d`))[0].d;
  verifier("apres descente, la vue est EXACTEMENT celle d'origine", vueApres === vueAvant);
  verifier("apres descente, le declencheur du registre a disparu", (await lire<{ n: number }>(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'earth_observation_products_garde'`))[0].n === 0);
  conclure();
}

main().catch((e) => { console.error(e); process.exitCode = 2; }).finally(async () => { await prisma.$disconnect(); await supprimerClone(ORIGINE!, NOM_CLONE); });

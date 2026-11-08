// Banc d'integration de la fiche d'inspection terrain (BDRI, lot F) : voir tests-integration/README.md.
// Lancer (DATABASE_URL pointe sur `replay`) : npx tsx tests-integration/inspection-terrain.integration.mts
//
// Clone jetable `essai_inspection_terrain` de `replay`, migration 20261027120000 appliquee. Eprouve : une inspection
// anterieure garde exactement ce qu'elle disait ; le service refuse une portion d'un autre troncon et une mission qui
// n'est pas celle de l'agent ; la base refuse un constat ou une methode inconnus et une section incoherente.
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
const NOM_CLONE = "essai_inspection_terrain";
await creerClone(ORIGINE!, NOM_CLONE);
const URL_CLONE = urlClone(ORIGINE!, NOM_CLONE);
process.env.DATABASE_URL = URL_CLONE;
console.log("Cible du banc : clone jetable " + NOM_CLONE);

const ICI = dirname(fileURLToPath(import.meta.url));
const R = new URL("../src/", pathToFileURL(process.argv[1]).href).href;
const imp = (p: string) => import(R + p + ".ts");
const { prisma } = await imp("lib/prisma");
const { inspectionsService } = await imp("modules/inspections/inspections.service");

const require = createRequire(import.meta.url);
const pg = require("pg");
const MIGRATION = join(ICI, "../prisma/migrations/20261027120000_inspection_terrain_complements/migration.sql");
async function sqlMulti(texte: string) {
  const c = new pg.Client({ connectionString: URL_CLONE });
  await c.connect();
  try { await c.query(texte); } finally { await c.end(); }
}
const sql = (q: string, ...a: unknown[]) => prisma.$executeRawUnsafe(q, ...a);
const lire = <T = Record<string, unknown>>(q: string, ...a: unknown[]) => prisma.$queryRawUnsafe<T[]>(q, ...a);
async function erreur(f: () => Promise<unknown>): Promise<string> {
  try { await f(); return ""; } catch (e) { return String((e as Error).message ?? e); }
}

async function main() {
  await sql(`INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt") VALUES ('u-agent','a@local.invalid','Agent','x','INSPECTEUR',now()), ('u-autre','o@local.invalid','Autre','x','INSPECTEUR',now())`);
  await sql(`INSERT INTO regions (nom) VALUES ('Region integ inspection')`);
  const r = (await lire<{ id: number }>(`SELECT id FROM regions WHERE nom = 'Region integ inspection'`))[0].id;
  for (const t of ["T-1", "T-2"]) {
    await sql(`INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", "updatedAt") VALUES ($1, $1, $1, 'RN', $2, 1, 'BITUME', 0, 1, now())`, t, r);
  }
  await sql(`INSERT INTO inspections (id, "tronconId", "inspecteurId", "dateInspection", "etatObserve") VALUES ('I-ANCIENNE', 'T-1', 'u-agent', now() - interval '1 year', 'MOYEN')`);

  await sqlMulti(readFileSync(MIGRATION, "utf8"));
  const ancienne = (await lire<Record<string, unknown>>(`SELECT "constatDefauts", "methodeObservation", "statutValidation", "missionId", "portionId" FROM inspections WHERE id = 'I-ANCIENNE'`))[0];
  verifier("une inspection anterieure garde ce qu'elle disait : rien n'est deduit pour elle", Object.values(ancienne).every((v) => v === null), ancienne);

  await sql(`INSERT INTO portions (id, "tronconId", "debutM", "finM", origine, "creeParId", "updatedAt") VALUES ('P-2', 'T-2', 0, 500, (enum_range(NULL::"OriginePortion"))[1], 'u-agent', now())`);
  await sql(`INSERT INTO missions (id, code, intitule, type, statut, "createurId", "assigneId", "updatedAt") VALUES ('M-AUTRE', 'M-1', 'Mission d''un autre', 'INSPECTION', 'EN_COURS', 'u-autre', 'u-autre', now())`);

  const ok = await inspectionsService.create({
    tronconId: "T-1", inspecteurId: "u-agent", dateInspection: new Date(), etatObserve: "BON", constatDefauts: "AUCUN_DEFAUT_OBSERVE",
    methodeObservation: "VISUELLE_EN_VEHICULE", conditionsObservation: "temps sec", debutM: 100, finM: 600,
  }, "u-agent");
  verifier("une inspection de section (intervalle) avec constat et methode s'enregistre", ok.constatDefauts === "AUCUN_DEFAUT_OBSERVE" && ok.debutM === 100 && ok.methodeObservation === "VISUELLE_EN_VEHICULE");
  verifier("refus : une portion d'un autre troncon", /n'appartient pas au tronçon/.test(await erreur(() => inspectionsService.create({ tronconId: "T-1", inspecteurId: "u-agent", dateInspection: new Date(), etatObserve: "BON", portionId: "P-2" }, "u-agent"))));
  verifier("une portion du troncon inspecte est acceptee", (await inspectionsService.create({ tronconId: "T-2", inspecteurId: "u-agent", dateInspection: new Date(), etatObserve: "MOYEN", portionId: "P-2" }, "u-agent")).portionId === "P-2");
  verifier("refus : une mission qui n'est pas celle de l'agent", /ni la vôtre/.test(await erreur(() => inspectionsService.create({ tronconId: "T-1", inspecteurId: "u-agent", dateInspection: new Date(), etatObserve: "BON", missionId: "M-AUTRE" }, "u-agent"))));

  verifier("la base refuse un constat inconnu", /inspection_constat_connu/.test(await erreur(() => sql(`UPDATE inspections SET "constatDefauts" = 'PEUT_ETRE' WHERE id = 'I-ANCIENNE'`))));
  verifier("la base refuse une methode inconnue", /inspection_methode_connue/.test(await erreur(() => sql(`UPDATE inspections SET "methodeObservation" = 'IRI_LASER' WHERE id = 'I-ANCIENNE'`))));
  verifier("la base refuse une borne de section seule", /inspection_section_bornes/.test(await erreur(() => sql(`UPDATE inspections SET "debutM" = 10 WHERE id = 'I-ANCIENNE'`))));
  verifier("la base refuse portion ET intervalle", /inspection_section_une_definition/.test(await erreur(() => sql(`UPDATE inspections SET "portionId" = 'P-2', "debutM" = 0, "finM" = 10 WHERE id = 'I-ANCIENNE'`))));
  conclure();
}

main().catch((e) => { console.error(e); process.exitCode = 2; }).finally(async () => { await prisma.$disconnect(); await supprimerClone(ORIGINE!, NOM_CLONE); });

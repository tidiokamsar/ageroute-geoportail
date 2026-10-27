// Banc d'integration des liens chantier / troncons ou sections (BDRI, lot G) : voir tests-integration/README.md.
// Lancer (DATABASE_URL pointe sur `replay`) : npx tsx tests-integration/sections.integration.mts
//
// Clone jetable `essai_sections` de `replay`, migration 20261027110000 appliquee, puis eprouve PAR LE SERVICE :
// lier un troncon entier, une portion, un intervalle ; les refus (hors trace, sans trace, portion d'un autre
// troncon, doublon) ; le retrait motive ; l'impossibilite d'effacer ; la vue « chantiers d'un troncon ».
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
const NOM_CLONE = "essai_sections";
await creerClone(ORIGINE!, NOM_CLONE);
const URL_CLONE = urlClone(ORIGINE!, NOM_CLONE);
process.env.DATABASE_URL = URL_CLONE;
console.log("Cible du banc : clone jetable " + NOM_CLONE);

const ICI = dirname(fileURLToPath(import.meta.url));
const R = new URL("../src/", pathToFileURL(process.argv[1]).href).href;
const imp = (p: string) => import(R + p + ".ts");
const { prisma } = await imp("lib/prisma");
const sec = await imp("chantiers/sections.service");

const require = createRequire(import.meta.url);
const pg = require("pg");
const MIGRATION = join(ICI, "../prisma/migrations/20261027110000_chantier_sections/migration.sql");
async function sqlMulti(texte: string) {
  const c = new pg.Client({ connectionString: URL_CLONE });
  await c.connect();
  try { await c.query(texte); } finally { await c.end(); }
}
const sql = (q: string, ...a: unknown[]) => prisma.$executeRawUnsafe(q, ...a);
const lire = <T = Record<string, unknown>>(q: string, ...a: unknown[]) => prisma.$queryRawUnsafe<T[]>(q, ...a);
const n = async (q: string, ...a: unknown[]) => Number((await lire<{ n: number }>(q, ...a))[0].n);
async function code(f: () => Promise<unknown>): Promise<string | null> {
  try { await f(); return null; } catch (e) { return e instanceof sec.RefusSection ? e.code : String((e as Error).message ?? e); }
}

async function main() {
  await sqlMulti(readFileSync(MIGRATION, "utf8"));
  verifier("la migration s'applique au clone", (await n(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'chantier_sections_sans_suppression'`)) === 1);
  await sql(`INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt") VALUES ('u-g','g@local.invalid','Gestionnaire','x','ADMIN',now())`);
  await sql(`INSERT INTO regions (nom) VALUES ('Region integ sections')`);
  const regionId = await n(`SELECT id AS n FROM regions WHERE nom = 'Region integ sections'`);
  const troncon = (id: string, geom: string | null) => sql(`INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt")
    VALUES ($1, $1, $1, 'RN', $2, 1.1, 'BITUME', 0, 1.1, ${geom ?? "NULL"}, now())`, id, regionId);
  await troncon("T-A", `ST_SetSRID(ST_MakeLine(ST_MakePoint(-13.60, 9.64), ST_MakePoint(-13.59, 9.64)), 4326)`); // ~1 097 m
  await troncon("T-B", `ST_SetSRID(ST_MakeLine(ST_MakePoint(-13.59, 9.64), ST_MakePoint(-13.58, 9.64)), 4326)`);
  await troncon("T-SANS", null);
  await sql(`INSERT INTO portions (id, "tronconId", "debutM", "finM", origine, "creeParId", "updatedAt") VALUES ('P-B', 'T-B', 0, 500, (enum_range(NULL::"OriginePortion"))[1], 'u-g', now())`);
  await sql(`INSERT INTO chantiers (id, intitule, entreprise, "regionId", "tronconId", statut, "dateDebutReelle", "updatedAt") VALUES ('C-1', 'Rehabilitation Coyah-Kindia', 'ETP', $1, 'T-A', 'EN_COURS', now() - interval '30 days', now())`, regionId);

  const entier = await sec.ajouter("C-1", { tronconId: "T-B" }, "u-g");
  verifier("lier un troncon entier (aucune borne)", entier.debutM === null && entier.portionId === null);
  const intervalle = await sec.ajouter("C-1", { tronconId: "T-A", debutM: 200, finM: 800 }, "u-g");
  verifier("lier un intervalle en metres le long du trace", intervalle.debutM === 200 && intervalle.finM === 800);
  verifier("lier une portion existante du meme troncon", (await sec.ajouter("C-1", { tronconId: "T-B", portionId: "P-B" }, "u-g")).portionId === "P-B");

  verifier("refus : la fin depasse le trace (HORS_TRONCON)", (await code(() => sec.ajouter("C-1", { tronconId: "T-A", debutM: 0, finM: 5000 }, "u-g"))) === "HORS_TRONCON");
  verifier("refus : intervalle sur un troncon sans trace (SANS_TRACE), jamais cru", (await code(() => sec.ajouter("C-1", { tronconId: "T-SANS", debutM: 0, finM: 100 }, "u-g"))) === "SANS_TRACE");
  verifier("refus : portion d'un autre troncon (PORTION_HORS_TRONCON)", (await code(() => sec.ajouter("C-1", { tronconId: "T-A", portionId: "P-B" }, "u-g"))) === "PORTION_HORS_TRONCON");
  verifier("refus : portion ET intervalle (DEUX_DEFINITIONS)", (await code(() => sec.ajouter("C-1", { tronconId: "T-B", portionId: "P-B", debutM: 0, finM: 10 }, "u-g"))) === "DEUX_DEFINITIONS");
  verifier("refus : le meme lien en vigueur deux fois (DEJA_LIE)", (await code(() => sec.ajouter("C-1", { tronconId: "T-A", debutM: 200, finM: 800 }, "u-g"))) === "DEJA_LIE");
  verifier("chaque lien est audite (CREATE ChantierSection)", (await n(`SELECT count(*)::int AS n FROM audit_logs WHERE "entityType" = 'ChantierSection' AND action = 'CREATE'`)) === 3);

  verifier("retrait sans motif refuse", (await code(() => sec.retirer(intervalle.id, "", "u-g"))) === "MOTIF_EXIGE");
  const retire = await sec.retirer(intervalle.id, "emprise reduite au PK 0+500", "u-g");
  verifier("retrait motive : date, auteur et motif poses ; le lien reste en base", retire.retireLe !== null && retire.retirePar.nomComplet === "Gestionnaire" && (await n(`SELECT count(*)::int AS n FROM chantier_sections`)) === 3);
  verifier("un lien retire peut etre relie a nouveau (l'unicite ne vaut que pour les liens en vigueur)", (await sec.ajouter("C-1", { tronconId: "T-A", debutM: 200, finM: 800 }, "u-g")).id !== intervalle.id);
  verifier("aucun lien ne s'efface (declencheur)", /ne s'efface pas/.test((await code(() => sql(`DELETE FROM chantier_sections`))) ?? ""));

  const vueA = await sec.parTroncon("T-A");
  verifier("chantiers d'un troncon : le principal, avec ses sections dont la retiree marquee",
    vueA.length === 1 && vueA[0].principal === true && vueA[0].sections.length === 2 && vueA[0].sections.some((s: { retireLe: Date | null }) => s.retireLe !== null), vueA);
  const vueB = await sec.parTroncon("T-B");
  verifier("chantiers d'un troncon : lie par section seulement (pas principal), la portion donne ses bornes",
    vueB.length === 1 && vueB[0].principal === false && vueB[0].sections.some((s: { debutM: number | null; finM: number | null }) => s.debutM === 0 && s.finM === 500), vueB);
  verifier("le troncon principal du chantier n'a pas ete touche", (await lire<{ t: string }>(`SELECT "tronconId" AS t FROM chantiers WHERE id = 'C-1'`))[0].t === "T-A");
  conclure();
}

main().catch((e) => { console.error(e); process.exitCode = 2; }).finally(async () => { await prisma.$disconnect(); await supprimerClone(ORIGINE!, NOM_CLONE); });

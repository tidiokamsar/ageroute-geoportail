// Banc d'integration du registre des anomalies du referentiel des troncons (BDRI, lot C) : voir
// tests-integration/README.md. Lancer (DATABASE_URL pointe sur `replay`) : npx tsx tests-integration/registre.integration.mts
//
// Le banc travaille dans un CLONE jetable de `replay` (essai_registre), cree puis detruit par lui-meme, et lui
// applique la migration 20261027100000. Il eprouve PAR LE SERVICE, contre PostGIS reel : ce que l'analyse
// constate, qu'elle est idempotente, le cycle de decision, l'application en compare-et-echange avec sa trace
// d'audit, l'annulation, le tout-ou-rien d'un groupe, et qu'aucun troncon n'est supprime.
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
const NOM_CLONE = "essai_registre";
await creerClone(ORIGINE!, NOM_CLONE);
const URL_CLONE = urlClone(ORIGINE!, NOM_CLONE);
process.env.DATABASE_URL = URL_CLONE;
console.log("Cible du banc : clone jetable " + NOM_CLONE);

const ICI = dirname(fileURLToPath(import.meta.url));
const R = new URL("../src/", pathToFileURL(process.argv[1]).href).href;
const imp = (p: string) => import(R + p + ".ts");
const { prisma } = await imp("lib/prisma");
const reg = await imp("referentiel/registre.service");
const syn = await imp("referentiel/synthese.depot");
const { tronconsService } = await imp("modules/troncons/troncons.service");

const require = createRequire(import.meta.url);
const pg = require("pg");
const MIGRATION = join(ICI, "../prisma/migrations/20261027100000_registre_anomalies_referentiel/migration.sql");

async function sqlMulti(texte: string) {
  const c = new pg.Client({ connectionString: URL_CLONE });
  await c.connect();
  try { await c.query(texte); } finally { await c.end(); }
}
const sql = (q: string, ...a: unknown[]) => prisma.$executeRawUnsafe(q, ...a);
const lire = <T = Record<string, unknown>>(q: string, ...a: unknown[]) => prisma.$queryRawUnsafe<T[]>(q, ...a);
async function echec(f: () => Promise<unknown>): Promise<string | null> {
  try { await f(); return null; } catch (e) { return e instanceof reg.RefusRegistre ? `${e.code}` : String((e as Error).message ?? e); }
}
const n = async (q: string, ...a: unknown[]) => Number((await lire<{ n: number }>(q, ...a))[0].n);
const SEUILS = { ecartLongueurPct: 10, ecartPkPct: 10 };

/** Ligne de ~1,1 km vers l'est a 9,64 N, decalee de `dy` degres (1e-5 deg ~ 1,1 m). */
const ligne = (x0: number, dy = 0) => `ST_SetSRID(ST_MakeLine(ST_MakePoint(${x0}, ${9.64 + dy}), ST_MakePoint(${x0 + 0.01}, ${9.64 + dy})), 4326)`;

async function troncon(id: string, o: { nom?: string; classe?: string; revetement?: string; longueurKm?: number; pkDebut?: number; pkFin?: number; geom?: string | null; archive?: boolean } = {}) {
  await sql(`INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "deletedAt", "updatedAt")
    VALUES ($1, $1, $2, $3::"ClasseRoute", (SELECT id FROM regions WHERE nom = 'Region integ registre'), $4, $5::"Revetement", $6, $7, ${o.geom ?? "NULL"}, ${o.archive ? "now()" : "NULL"}, now())`,
    id, o.nom ?? `Troncon ${id}`, o.classe ?? "RN", o.longueurKm ?? 1.1, o.revetement ?? "BITUME", o.pkDebut ?? 0, o.pkFin ?? 1.1);
}

async function main() {
  await sqlMulti(readFileSync(MIGRATION, "utf8"));
  verifier("la migration s'applique au clone", (await n(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'decisions_anomalie_ajout_seul'`)) === 1);

  await sql(`INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt") VALUES
    ('u-a','a@local.invalid','Proposant','x','ADMIN',now()), ('u-b','b@local.invalid','Validateur','x','ADMIN',now())`);
  await sql(`INSERT INTO regions (nom) VALUES ('Region integ registre')`);
  const regionId = await n(`SELECT id AS n FROM regions WHERE nom = 'Region integ registre'`);

  await troncon("T-SAIN", { nom: "Coyah Kindia", geom: ligne(-13.60) });
  await troncon("T-PK0", { pkDebut: 0, pkFin: 0, geom: null });
  await troncon("T-INV", { pkDebut: 20, pkFin: 7.5, longueurKm: 5, geom: ligne(-13.50) });
  await troncon("T-DOUBLE", { geom: ligne(-13.60, 0.00002) });            // ~2 m du sain : doublon potentiel
  await troncon("T-ARCHIVE", { geom: ligne(-13.60, -0.00002), archive: true });
  await troncon("T-HOMONYME", { nom: "COYAH  kindia ", geom: ligne(-13.30) }); // meme nom, ailleurs
  await troncon("T-INVALIDE", { geom: `ST_GeomFromText('LINESTRING(-13.2 9.7, -13.2 9.7)', 4326)` });
  await troncon("T-INVERSE", { geom: `ST_SetSRID(ST_MakeLine(ST_MakePoint(9.64, -13.60), ST_MakePoint(9.65, -13.60)), 4326)` });
  await troncon("T-NR", { classe: "NON_CLASSEE", revetement: "NON_RENSEIGNE", geom: ligne(-13.10) });
  const tronconsAvant = await n(`SELECT count(*)::int AS n FROM troncons`);

  // ---- analyse ----
  const b1 = await reg.analyser({ regionId }, SEUILS, "u-a");
  const regles = async (id: string) => (await lire<{ regle: string }>(`SELECT regle FROM anomalies_referentiel WHERE "tronconId" = $1 ORDER BY regle`, id)).map((r) => r.regle).join(",");
  verifier("un troncon sain ne produit aucune anomalie", (await regles("T-SAIN")).split(",").every((r) => r === "DOUBLON_POTENTIEL" || r === "NOM_IDENTIQUE"), await regles("T-SAIN"));
  verifier("PK 0 -> 0 et geometrie absente sont constates", (await regles("T-PK0")) === "GEOMETRIE_ABSENTE,PK_NON_RENSEIGNES", await regles("T-PK0"));
  verifier("PK de fin avant le debut et ecart de longueur declaree / geometrique (5 km contre ~1,1 km)", (await regles("T-INV")) === "ECART_LONGUEUR_GEOMETRIQUE,PK_FIN_AVANT_DEBUT", await regles("T-INV"));
  verifier("geometrie invalide : constatee avec la raison PostGIS, sans longueur", (await regles("T-INVALIDE")) === "GEOMETRIE_INVALIDE"
    && /point/i.test(String((await lire<{ r: string }>(`SELECT valeurs->>'raison' AS r FROM anomalies_referentiel WHERE "tronconId" = 'T-INVALIDE'`))[0].r)));
  verifier("coordonnees inversees : hors de l'emprise nationale", (await regles("T-INVERSE")).includes("GEOMETRIE_HORS_EMPRISE"), await regles("T-INVERSE"));
  verifier("classe et revetement non renseignes : nommes", (await regles("T-NR")) === "ATTRIBUTS_NON_RENSEIGNES");
  const doublons = await lire<{ t: string; autre: string; archive: boolean }>(`SELECT "tronconId" AS t, valeurs->>'autreTronconId' AS autre, (valeurs->>'autreArchive')::boolean AS archive FROM anomalies_referentiel WHERE regle = 'DOUBLON_POTENTIEL' ORDER BY 1, 2`);
  verifier("doublon potentiel constate sur les deux troncons, archive compris (actif contre archive)",
    JSON.stringify(doublons.map((d) => `${d.t}>${d.autre}:${d.archive}`)) === JSON.stringify(["T-ARCHIVE>T-DOUBLE:false", "T-ARCHIVE>T-SAIN:false", "T-DOUBLE>T-ARCHIVE:true", "T-DOUBLE>T-SAIN:false", "T-SAIN>T-ARCHIVE:true", "T-SAIN>T-DOUBLE:false"]), doublons);
  verifier("meme nom sans recouvrement : NOM_IDENTIQUE (pas un doublon), sans accents ni casse", (await regles("T-HOMONYME")) === "NOM_IDENTIQUE", await regles("T-HOMONYME"));
  verifier("le bilan compte les constats et ne dit pas tronque", b1.nouvelles > 0 && b1.tronque === false && b1.tronconsExamines === 8, b1);
  verifier("chaque nouvelle anomalie a sa decision initiale A_EXAMINER", (await n(`SELECT count(*)::int AS n FROM decisions_anomalie`)) === b1.nouvelles);
  verifier("l'analyse est tracee dans audit_logs", (await n(`SELECT count(*)::int AS n FROM audit_logs WHERE "entityType" = 'AnalyseReferentiel' AND "entityId" = $1`, b1.analyseId)) === 1);

  const b2 = await reg.analyser({ regionId }, SEUILS, "u-a");
  verifier("relancee sur des donnees inchangees, l'analyse ne cree rien (idempotente)", b2.nouvelles === 0 && b2.confirmees === b1.nouvelles && b2.disparues === 0, b2);

  // ---- decision, application, annulation ----
  const id = async (t: string, r: string) => String((await lire<{ id: string }>(`SELECT id FROM anomalies_referentiel WHERE "tronconId" = $1 AND regle = $2`, t, r))[0].id);
  const aPk = await id("T-PK0", "PK_NON_RENSEIGNES");
  await reg.decider(aPk, { statut: "CORRECTION_PROPOSEE", correction: { champ: "pkFin", nouvelle: "2,5", justification: "PV de reception 2024", source: "PV 2024-17" } }, "u-a");
  const corr = (await lire<{ c: { ancienne: number; nouvelle: number } }>(`SELECT correction AS c FROM anomalies_referentiel WHERE id = $1`, aPk))[0].c;
  verifier("la proposition garde l'ancienne valeur LUE en base (0) et la nouvelle normalisee (2,5)", corr.ancienne === 0 && corr.nouvelle === 2.5, corr);
  verifier("le proposant ne valide pas sa propre correction (AUTO_VALIDATION)", (await echec(() => reg.decider(aPk, { statut: "VALIDEE" }, "u-a"))) === "AUTO_VALIDATION");
  verifier("une correction non validee ne s'applique pas", (await echec(() => reg.appliquer([aPk], "u-a"))) === "NON_APPLICABLE");
  await reg.decider(aPk, { statut: "VALIDEE", commentaire: "PV verifie" }, "u-b");

  await sql(`UPDATE troncons SET "pkFin" = 1 WHERE id = 'T-PK0'`);
  const p1 = await reg.previsualiser([aPk]);
  verifier("la previsualisation voit la valeur qui a bouge et n'ecrit rien", p1[0].applicable === false && p1[0].actuelle === 1 && p1[0].constatee === 0, p1);
  verifier("valeur modifiee depuis la proposition : l'application est refusee (VALEUR_A_CHANGE)", (await echec(() => reg.appliquer([aPk], "u-b"))) === "VALEUR_A_CHANGE");
  verifier("... et rien n'a ete ecrit", (await n(`SELECT "pkFin"::int AS n FROM troncons WHERE id = 'T-PK0'`)) === 1 && (await lire<{ s: string }>(`SELECT statut AS s FROM anomalies_referentiel WHERE id = $1`, aPk))[0].s === "VALIDEE");
  await sql(`UPDATE troncons SET "pkFin" = 0 WHERE id = 'T-PK0'`);

  const auditsAvant = await n(`SELECT count(*)::int AS n FROM audit_logs WHERE "entityType" = 'Troncon' AND "entityId" = 'T-PK0'`);
  const r1 = await reg.appliquer([aPk], "u-b");
  const pkFin = (await lire<{ v: number }>(`SELECT "pkFin" AS v FROM troncons WHERE id = 'T-PK0'`))[0].v;
  const audit = (await lire<{ b: Record<string, unknown>; a: Record<string, unknown> }>(`SELECT before AS b, after AS a FROM audit_logs WHERE "entityType" = 'Troncon' AND "entityId" = 'T-PK0' ORDER BY "createdAt" DESC LIMIT 1`))[0];
  verifier("correction validee appliquee : pkFin 0 -> 2,5", r1.appliquees === 1 && Number(pkFin) === 2.5);
  verifier("audit_logs garde l'ancienne et la nouvelle valeur, la justification, la source et l'anomalie",
    (await n(`SELECT count(*)::int AS n FROM audit_logs WHERE "entityType" = 'Troncon' AND "entityId" = 'T-PK0'`)) === auditsAvant + 1
    && audit.b.pkFin === 0 && audit.a.pkFin === 2.5 && audit.a.justification === "PV de reception 2024" && audit.a.source === "PV 2024-17" && audit.a.anomalieId === aPk, audit);
  verifier("l'anomalie est CORRIGEE, avec une decision de plus", (await lire<{ s: string }>(`SELECT statut AS s FROM anomalies_referentiel WHERE id = $1`, aPk))[0].s === "CORRIGEE"
    && (await n(`SELECT count(*)::int AS n FROM decisions_anomalie WHERE "anomalieId" = $1`, aPk)) === 4);
  verifier("la provenance du champ corrige est ecrite (valeurs_qualite)", (await n(`SELECT count(*)::int AS n FROM valeurs_qualite WHERE "entityType" = 'Troncon' AND "entityId" = 'T-PK0' AND champ = 'pkFin'`)) >= 1);

  verifier("annulation sans motif refusee", (await echec(() => reg.annuler(aPk, "", "u-b"))) === "MOTIF_EXIGE");
  await reg.annuler(aPk, "PV conteste par la DR", "u-b");
  verifier("annulation : pkFin revient a 0, l'anomalie revient a VALIDEE", Number((await lire<{ v: number }>(`SELECT "pkFin" AS v FROM troncons WHERE id = 'T-PK0'`))[0].v) === 0
    && (await lire<{ s: string }>(`SELECT statut AS s FROM anomalies_referentiel WHERE id = $1`, aPk))[0].s === "VALIDEE");

  // ---- groupe : tout ou rien ----
  const aClasse = await id("T-NR", "ATTRIBUTS_NON_RENSEIGNES");
  const aInv = await id("T-INV", "PK_FIN_AVANT_DEBUT");
  await reg.decider(aClasse, { statut: "CORRECTION_PROPOSEE", correction: { champ: "classe", nouvelle: "RR", justification: "arrete de classement", source: "Arrete 2019-044" } }, "u-a");
  await reg.decider(aClasse, { statut: "VALIDEE" }, "u-b");
  await reg.decider(aInv, { statut: "CORRECTION_PROPOSEE", correction: { champ: "pkDebut", nouvelle: 2.5, justification: "releve PK terrain", source: "Releve 2026-10" } }, "u-a");
  await reg.decider(aInv, { statut: "VALIDEE" }, "u-b");
  await sql(`UPDATE troncons SET "pkDebut" = 19 WHERE id = 'T-INV'`);
  verifier("groupe dont une correction est perimee : refuse en bloc", (await echec(() => reg.appliquer([aClasse, aInv], "u-b"))) === "VALEUR_A_CHANGE");
  verifier("... et la correction valide du groupe n'a pas ete appliquee non plus", (await lire<{ c: string }>(`SELECT classe::text AS c FROM troncons WHERE id = 'T-NR'`))[0].c === "NON_CLASSEE");
  await sql(`UPDATE troncons SET "pkDebut" = 20 WHERE id = 'T-INV'`);
  const r2 = await reg.appliquer([aClasse, aInv], "u-b");
  verifier("groupe a jour : les deux corrections passent ensemble", r2.appliquees === 2 && (await lire<{ c: string }>(`SELECT classe::text AS c FROM troncons WHERE id = 'T-NR'`))[0].c === "RR");

  // ---- rejet, disparition, journal ----
  const aHom = await id("T-HOMONYME", "NOM_IDENTIQUE");
  verifier("un rejet sans motif est refuse", (await echec(() => reg.decider(aHom, { statut: "REJETEE" }, "u-a"))) === "MOTIF_EXIGE");
  await reg.decider(aHom, { statut: "REJETEE", commentaire: "deux routes distinctes de meme nom" }, "u-a");
  await sql(`UPDATE troncons SET geom = ${ligne(-13.40)} WHERE id = 'T-INVERSE'`);
  const b3 = await reg.analyser({ regionId }, SEUILS, "u-a");
  verifier("une anomalie ouverte qui ne se constate plus recoit disparueLe ; son statut ne change pas",
    b3.disparues >= 1 && (await lire<{ s: string; d: Date | null }>(`SELECT statut AS s, "disparueLe" AS d FROM anomalies_referentiel WHERE "tronconId" = 'T-INVERSE' AND regle = 'GEOMETRIE_HORS_EMPRISE'`))[0].d !== null, b3);
  verifier("le journal des decisions refuse toute modification", /ajout seul/.test((await echec(() => sql(`UPDATE decisions_anomalie SET commentaire = 'x'`))) ?? ""));
  verifier("le journal des decisions refuse toute suppression", /ajout seul/.test((await echec(() => sql(`DELETE FROM decisions_anomalie`))) ?? ""));

  const csv = await reg.exporterCsv({ regionId, inclureDisparues: true });
  verifier("l'export CSV porte une ligne par anomalie, le libelle et la correction", csv.split("\n").filter(Boolean).length === 1 + (await n(`SELECT count(*)::int AS n FROM anomalies_referentiel`)) && /PK non renseign/.test(csv) && /PV 2024-17/.test(csv));
  const l = await reg.lister({ regionId, statut: "CORRIGEE" });
  verifier("la liste filtre par statut et compte par statut", l.total === 2 && l.data.every((a: { statut: string }) => a.statut === "CORRIGEE") && l.parStatut.REJETEE === 1, l.parStatut);

  // ---- synthese et filtres de la liste, contre la base ----
  const sy = await syn.synthese(regionId);
  verifier("synthese : le nombre de troncons est COMPTE (8 actifs du reseau classe, l'archive exclu)", sy.troncons === 8, sy.troncons);
  verifier("synthese : PK non renseignes, sans trace et trace invalide comptes", sy.completude.pkNonRenseignes === 1 && sy.completude.sansGeometrie === 1 && sy.completude.geometriesInvalides === 1, sy.completude);
  verifier("synthese : longueur declaree et geometrique distinctes, methode nommee", sy.longueur.declareeKm > sy.longueur.geometriqueKm && sy.longueur.geometriqueKm > 5 && /ST_Length/.test(sy.longueur.methodeGeometrique), sy.longueur);
  verifier("synthese : ventilation par revetement et compte du registre", sy.parRevetement.some((v: { cle: string; troncons: number }) => v.cle === "NON_RENSEIGNE" && v.troncons === 1) && sy.registre.ouvertes > 0 && sy.registre.doublonsPotentiels >= 2, sy.registre);
  const sansTrace = await tronconsService.list({ geometrie: "absente", region: "Region integ registre" });
  verifier("liste : le filtre « sans trace » rend le seul troncon sans geometrie, drapeau aGeometrie faux", sansTrace.data.length === 1 && sansTrace.data[0].id === "T-PK0" && sansTrace.data[0].aGeometrie === false);
  const parPk = (await tronconsService.list({ search: "5", region: "Region integ registre" })).data.map((t: { id: string }) => t.id);
  verifier("liste : un PK cherche (5) trouve le troncon dont l'intervalle le contient (T-INV, 2,5 a 7,5) et pas les autres", parPk.includes("T-INV") && !parPk.includes("T-SAIN"), parPk);
  const avecTrace = await tronconsService.list({ geometrie: "presente", region: "Region integ registre" });
  verifier("liste : longueur geometrique par ligne, longueur declaree intacte", avecTrace.data.some((t: { id: string; longueurKm: number; longueurGeometriqueKm: number | null }) => t.id === "T-INV" && t.longueurKm === 5 && t.longueurGeometriqueKm !== null && t.longueurGeometriqueKm < 1.2));

  // ---- lot I : le trace est controle avant d'etre ecrit, et ecrit dans la transaction ----
  const ligneGeo = (x: number, y: number) => ({ type: "LineString", coordinates: [[x, y], [x + 0.01, y]] });
  const nouveau = (code: string, geom: unknown) => ({ code, nom: `Essai ${code}`, classe: "RN", regionId, longueurKm: 1.1, revetement: "BITUME", pkDebut: 0, pkFin: 1.1, geom });
  const erreur = async (f: () => Promise<unknown>) => { try { await f(); return null; } catch (e) { return String((e as Error).message); } };
  const tronconsAvantI = await n(`SELECT count(*)::int AS n FROM troncons`);
  verifier("creation avec un trace invalide (deux points confondus) : refusee avec la raison PostGIS, rien n'est ecrit",
    /invalide \(Too few points/.test((await erreur(() => tronconsService.createWithGeom(nouveau("I-INV", { type: "LineString", coordinates: [[-13.2, 9.7], [-13.2, 9.7]] }), "u-a"))) ?? "")
    && (await n(`SELECT count(*)::int AS n FROM troncons`)) === tronconsAvantI);
  verifier("creation avec latitude et longitude inversees : refusee (emprise nationale), rien n'est ecrit",
    /emprise de la Guin/.test((await erreur(() => tronconsService.createWithGeom(nouveau("I-INVERSE", ligneGeo(9.64, -13.6)), "u-a"))) ?? "")
    && (await n(`SELECT count(*)::int AS n FROM troncons WHERE code = 'I-INVERSE'`)) === 0);
  const cree = await tronconsService.createWithGeom(nouveau("I-OK", ligneGeo(-13.0, 9.64)), "u-a");
  const audits = await lire<{ action: string; after: Record<string, unknown> }>(`SELECT action::text AS action, after FROM audit_logs WHERE "entityType" = 'Troncon' AND "entityId" = $1 ORDER BY "createdAt", action`, cree.id);
  verifier("creation avec un trace valide : le trace est ecrit, et audite (CREATE de l'entite puis UPDATE du trace)",
    (await n(`SELECT count(*)::int AS n FROM troncons WHERE id = $1 AND geom IS NOT NULL`, cree.id)) === 1
    && audits.map((x) => x.action).join(",") === "CREATE,UPDATE" && (audits[1].after as { geom?: { points: number } }).geom?.points === 2, audits);
  verifier("modification avec un trace hors emprise : refusee, ni le trace ni les champs ne bougent",
    /emprise/.test((await erreur(() => tronconsService.updateWithGeom(cree.id, { nom: "Renomme", geom: ligneGeo(9.64, -13.6) }, "u-a"))) ?? "")
    && (await lire<{ nom: string }>(`SELECT nom FROM troncons WHERE id = $1`, cree.id))[0].nom === "Essai I-OK");
  await sql(`UPDATE troncons SET "deletedAt" = now() WHERE id = $1`, cree.id);

  verifier("aucun troncon n'a ete supprime par le registre (le seul archivage est celui du troncon d'essai du lot I)", (await n(`SELECT count(*)::int AS n FROM troncons`)) === tronconsAvant + 1
    && (await n(`SELECT count(*)::int AS n FROM troncons WHERE "deletedAt" IS NOT NULL`)) === 2);
  conclure();
}

main().catch((e) => { console.error(e); process.exitCode = 2; }).finally(async () => { await prisma.$disconnect(); await supprimerClone(ORIGINE!, NOM_CLONE); });

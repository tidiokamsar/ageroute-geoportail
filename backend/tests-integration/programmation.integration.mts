// Banc d'integration du moteur de risque et de programmation (paragraphe 7.7, A22) : voir tests-integration/README.md.
// Lancer (DATABASE_URL pointe sur `replay`) : npx tsx tests-integration/programmation.integration.mts
//
// Les services committent et les declencheurs font echouer des requetes : le banc travaille dans un CLONE jetable
// de `replay`, cree puis detruit par lui-meme (essai_programmation). La base `replay` n'est jamais ecrite.
// `replay` ne contient pas encore la migration 20261023100000 : le banc l'applique au clone (elle est idempotente).
//
// L'ORACLE : les nombres du moteur (risque, risque attendu, cout) sont recalcules par une REQUETE SQL qui ne partage
// aucun code avec le moteur TypeScript (arithmetique NUMERIC exacte, parametres lus dans la table), et le classement
// glouton est refait ici en BigInt a partir de ces seuls nombres.
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
const NOM_CLONE = "essai_programmation";
await creerClone(ORIGINE!, NOM_CLONE);
const URL_CLONE = urlClone(ORIGINE!, NOM_CLONE);
process.env.DATABASE_URL = URL_CLONE;
console.log("Cible du banc : clone jetable " + NOM_CLONE);

const ICI = dirname(fileURLToPath(import.meta.url));
const R = new URL("../src/", pathToFileURL(process.argv[1]).href).href;
const imp = (p: string) => import(R + p + ".ts");
const { prisma } = await imp("lib/prisma");
const moteur = await imp("programmation/moteur.service");
const { VALEURS_AMORCAGE_PROVISOIRES, VERSION_AMORCAGE } = await imp("programmation/parametres.noyau");

const require = createRequire(import.meta.url);
const pg = require("pg");

const MIGRATION = join(ICI, "../prisma/migrations/20261023100000_moteur_programmation/migration.sql");

async function sqlMulti(texte: string) {
  const c = new pg.Client({ connectionString: URL_CLONE });
  await c.connect();
  try { await c.query(texte); } finally { await c.end(); }
}
const sql = (q: string, ...a: unknown[]) => prisma.$executeRawUnsafe(q, ...a);
const lire = <T = Record<string, unknown>>(q: string, ...a: unknown[]) => prisma.$queryRawUnsafe<T[]>(q, ...a);

/** Message d'erreur d'un appel qui doit echouer, ou null s'il a reussi. */
async function echec(f: () => Promise<unknown>): Promise<string | null> {
  try { await f(); return null; } catch (e) { return e instanceof moteur.RefusMoteur ? `${e.code}|${e.message}` : String((e as Error).message ?? e); }
}
const codeRefus = (m: string | null) => (m ? m.split("|")[0] : null);

const U_ADMIN = "00000000-0000-4000-8000-000000000001";
const U_GEST = "00000000-0000-4000-8000-000000000002";
const ctxAdmin = { userId: U_ADMIN, email: "admin@essai.invalid" };
const ctxGest = { userId: U_GEST, email: "gest@essai.invalid" };

async function troncon(code: string, o: { etat: string; rev?: string; jma?: number | null; longueurKm: number; region?: string; lng?: number; lat?: number; ligne?: [number, number][]; src?: string | null; statut?: string | null; supprime?: boolean }) {
  const pts = o.ligne ?? [[-13.6, o.lat ?? 9.6], [-13.58, o.lat ?? 9.6]];
  const wkt = `LINESTRING(${pts.map(([x, y]) => `${x} ${y}`).join(", ")})`;
  await sql(
    `INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, etat, "pkDebut", "pkFin", "traficMoyenJma", "sourceReference", "statutValidation", "deletedAt", geom, "updatedAt")
     VALUES ($1, $2, $3, 'RN', (SELECT id FROM regions WHERE nom = $4), $5, $6::"Revetement", $7::"EtatPatrimoine", 0, $5, $8, $9, $10::"StatutValidation", $11, ST_GeomFromText($12, 4326), now())`,
    `t-${code}`, code, `Troncon ${code}`, o.region ?? "Region PRG1", o.longueurKm, o.rev ?? "BITUME", o.etat, o.jma ?? null, o.src ?? null, o.statut ?? null, o.supprime ? new Date() : null, wkt);
}
async function pointNoir(tronconCode: string, n: number, supprime = false) {
  for (let i = 0; i < n; i++) {
    await sql(
      `INSERT INTO points_noirs (id, description, "regionId", "tronconId", gravite, "deletedAt", "updatedAt")
       VALUES (gen_random_uuid()::text, 'pn essai', (SELECT "regionId" FROM troncons WHERE code = $1), (SELECT id FROM troncons WHERE code = $1), 'FORTE'::"Gravite", $2, now())`,
      tronconCode, supprime ? new Date() : null);
  }
}

/** Oracle SQL : risque, risque attendu et cout, sans aucun code du moteur. Parametres lus dans la table. Horizon 1 an. */
async function oracleSql(version: string) {
  return lire<{ code: string; risque: string; attendu: string; cout: string; len_m: string; traitement: string }>(`
    WITH p AS (SELECT valeurs AS v FROM parametres_programmation WHERE version = $1),
    t AS (
      SELECT tr.id, tr.code, tr.etat::text AS etat, tr."traficMoyenJma" AS jma,
             round(CASE WHEN tr."longueurKm" > 0 THEN tr."longueurKm" * 1000 ELSE ST_Length(tr.geom::geography) END)::bigint AS len_m,
             (SELECT count(*) FROM points_noirs x WHERE x."tronconId" = tr.id AND x."deletedAt" IS NULL)::numeric AS npn,
             CASE tr.revetement::text WHEN 'BITUME' THEN 'bitume' WHEN 'TERRE' THEN 'terre_laterite' WHEN 'LATERITE' THEN 'terre_laterite' WHEN 'PAVE' THEN 'pave' END AS fam
        FROM troncons tr
       WHERE tr.code LIKE 'PRG-%' AND tr."deletedAt" IS NULL AND (tr."statutValidation" IS NULL OR tr."statutValidation" = 'VALIDE')
         AND (tr."sourceReference" IS NULL OR NOT (tr."sourceReference" LIKE 'voirie_locale:%' OR tr."sourceReference" LIKE 'hors_territoire:%'))
         AND tr.etat::text IN ('BON','MOYEN','MAUVAIS','CRITIQUE') AND tr."traficMoyenJma" IS NOT NULL
    ),
    w AS (
      SELECT t.*, p.v,
             (p.v->'poidsRisque'->>'ETAT')::numeric AS we, (p.v->'poidsRisque'->>'TRAFIC_IMPORTANCE')::numeric AS wt, (p.v->'poidsRisque'->>'SECURITE')::numeric AS ws,
             (p.v->'etatVersRisque'->>t.etat)::numeric AS fe,
             round(least(t.jma::numeric / (p.v->>'traficPlafondJma')::numeric, 1) * 100, 4) AS ft,
             round(least(t.npn / (p.v->>'pointsNoirsPlafond')::numeric, 1) * 100, 4) AS fs,
             CASE t.etat WHEN 'BON' THEN 'MOYEN' WHEN 'MOYEN' THEN 'MAUVAIS' WHEN 'MAUVAIS' THEN 'CRITIQUE' END AS suivant,
             CASE WHEN t.jma < (p.v->'seuilsClasseTrafic'->>'t1MaxJma')::numeric THEN 'T1_faible'
                  WHEN t.jma < (p.v->'seuilsClasseTrafic'->>'t2MaxJma')::numeric THEN 'T2_moyen' ELSE 'T3_fort' END AS classe
        FROM t, p
    ),
    r AS (
      SELECT w.*, round((we * fe + wt * ft + ws * fs) / (we + wt + ws), 4) AS risque,
             round((we * (v->'etatVersRisque'->>suivant)::numeric + wt * ft + ws * fs) / (we + wt + ws), 4) AS risque_suivant
        FROM w
    ),
    m AS (
      SELECT r.*, CASE r.etat WHEN 'BON' THEN d."pBonVersMoyen" WHEN 'MOYEN' THEN d."pMoyenVersMauvais" WHEN 'MAUVAIS' THEN d."pMauvaisVersCritique" ELSE 0 END AS ph
        FROM r LEFT JOIN matrices_degradation d ON d."familleRevetement" = r.fam AND d."classeTrafic" = r.classe
    )
    SELECT m.code, m.risque::text AS risque,
           round(CASE WHEN m.suivant IS NULL THEN m.risque ELSE m.risque + m.ph::numeric * (m.risque_suivant - m.risque) END, 4)::text AS attendu,
           (b."coutKmGnf" * m.len_m / 1000)::text AS cout, m.len_m::text AS len_m, c."traitementCode" AS traitement
      FROM m
      JOIN conditions_traitement c ON c."familleRevetement" = m.fam AND c."etatDepart" = m.etat AND c."classeTrafic" IS NULL AND c.actif
      JOIN baremes_intervention b ON b."familleRevetement" = m.fam AND b."etatDepart" = m.etat AND b."typeIntervention" = c."traitementCode" AND b.actif
     WHERE m.fam IS NOT NULL
     ORDER BY m.code`, version);
}

/** Classement glouton refait ici, en BigInt, depuis les seuls nombres de l'oracle SQL. */
function gloutonOracle(lignes: { code: string; risque: string; attendu: string; cout: string }[], budget: bigint) {
  const micro = (s: string) => BigInt(Math.round(Number(s) * 10000));
  const e = lignes.map((l) => ({ code: l.code, r: micro(l.risque), a: micro(l.attendu), c: BigInt(l.cout) }));
  e.sort((x, y) => {
    const g = x.a * y.c, d = y.a * x.c;
    if (g !== d) return g > d ? -1 : 1;
    if (x.r !== y.r) return x.r > y.r ? -1 : 1;
    if (x.c !== y.c) return x.c < y.c ? -1 : 1;
    return x.code < y.code ? -1 : x.code > y.code ? 1 : 0;
  });
  let reste = budget;
  const retenues: string[] = [];
  for (const l of e) if (l.c <= reste) { reste -= l.c; retenues.push(l.code); }
  return { ordre: e.map((l) => l.code), retenues, reste };
}

const proche = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const lignesDe = (res: { lignes: { troncon: { code: string }; decision: string; motifExclusion: { code: string } | null }[] }) => res.lignes;
const parCode = <T extends { troncon: { code: string } }>(ls: T[], code: string) => ls.find((l) => l.troncon.code === code);

async function main() {
  // ---------- Schema : la migration s'applique au clone, deux fois
  console.log("\nMigration");
  const texteMigration = readFileSync(MIGRATION, "utf8");
  await sqlMulti(texteMigration);
  let rejeu: string | null = null;
  try { await sqlMulti(texteMigration); } catch (e) { rejeu = String((e as Error).message); }
  verifier("la migration s'applique au clone, puis une seconde fois sans erreur (idempotente)", rejeu === null, rejeu);
  const tables = await lire<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name IN ('parametres_programmation','scenarios_programmation','fiches_intervention','fiches_intervention_statuts')`);
  verifier("les quatre tables du moteur existent", tables[0].n === 4, tables);

  // ---------- Parametres d'amorcage
  console.log("\nParametres d'amorcage");
  const amorcage = await lire<{ version: string; source: string; approuveeLe: Date | null; approuveeParId: string | null; valeurs: unknown; motif: string }>(`SELECT * FROM parametres_programmation WHERE version = $1`, VERSION_AMORCAGE);
  verifier("la version d'amorcage est semee une seule fois", amorcage.length === 1, amorcage.length);
  verifier("elle est PROVISOIRE : source amorcage_provisoire, ni date ni approbateur d'approbation", amorcage[0].source === "amorcage_provisoire" && amorcage[0].approuveeLe === null && amorcage[0].approuveeParId === null, amorcage[0]);
  verifier("son motif dit « PROVISOIRE, non approuve » et « SANS SOURCE »", /PROVISOIRE, non approuve/.test(amorcage[0].motif) && /SANS SOURCE/.test(amorcage[0].motif), amorcage[0].motif);
  verifier("les valeurs semees en base sont celles du code (VALEURS_AMORCAGE_PROVISOIRES)", JSON.stringify(sortKeys(amorcage[0].valeurs)) === JSON.stringify(sortKeys(VALEURS_AMORCAGE_PROVISOIRES)), amorcage[0].valeurs);
  verifier("modifier une valeur d'une version est REFUSE par la base (immuable)",
    /immuable/.test((await echec(() => sql(`UPDATE parametres_programmation SET valeurs = jsonb_set(valeurs, '{facteursMinimum}', '1') WHERE version = $1`, VERSION_AMORCAGE))) ?? ""));
  verifier("supprimer une version est REFUSE par la base", /DELETE refuse/.test((await echec(() => sql(`DELETE FROM parametres_programmation WHERE version = $1`, VERSION_AMORCAGE))) ?? ""));
  verifier("une approbation sans approbateur est REFUSEE (contrainte pp_approbation_signee)",
    /pp_approbation_signee/.test((await echec(() => sql(`UPDATE parametres_programmation SET "approuveeLe" = now() WHERE version = $1`, VERSION_AMORCAGE))) ?? ""));

  // ---------- Fixtures
  await sql(`INSERT INTO regions (nom) VALUES ('Region PRG1'), ('Region PRG2')`);
  for (const [id, email, role] of [[U_ADMIN, "admin@essai.invalid", "ADMIN"], [U_GEST, "gest@essai.invalid", "GESTIONNAIRE"]] as const) {
    await sql(`INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt") VALUES ($1, $2, 'Essai', 'x', $3::"Role", now())`, id, email, role);
  }
  await troncon("PRG-A", { etat: "MAUVAIS", jma: 2500, longueurKm: 4 });
  await troncon("PRG-B", { etat: "CRITIQUE", jma: 600, longueurKm: 1, region: "Region PRG2", lat: 9.62 });
  await troncon("PRG-C", { etat: "MOYEN", jma: 100, longueurKm: 10, rev: "TERRE", lat: 9.64 });
  await troncon("PRG-D", { etat: "NON_EVALUE", jma: 2000, longueurKm: 3, lat: 9.66 });
  await troncon("PRG-E", { etat: "MAUVAIS", rev: "NON_RENSEIGNE", jma: 3000, longueurKm: 3, lat: 9.68 });
  await troncon("PRG-F", { etat: "MAUVAIS", jma: null, longueurKm: 3, lat: 9.70 });
  await troncon("PRG-G", { etat: "BON", jma: 800, longueurKm: 3, lat: 9.72 });
  await troncon("PRG-H", { etat: "MAUVAIS", jma: 1200, longueurKm: 0, lat: 9.74 });
  await troncon("PRG-X1", { etat: "MAUVAIS", jma: 2500, longueurKm: 4, lat: 9.76, supprime: true });
  await troncon("PRG-X2", { etat: "MAUVAIS", jma: 2500, longueurKm: 4, lat: 9.78, src: "voirie_locale:essai" });
  await troncon("PRG-X3", { etat: "MAUVAIS", jma: 2500, longueurKm: 4, lat: 9.80, statut: "REJETE" });
  for (const [code, n] of [["PRG-A", 2], ["PRG-C", 1], ["PRG-D", 1], ["PRG-E", 1], ["PRG-H", 1]] as const) await pointNoir(code, n);
  await pointNoir("PRG-B", 1, true); // supprime : ne compte pas

  // ---------- Parametres via le service
  console.log("\nParametres : versions, approbation, audit");
  const valeursOk = { ...VALEURS_AMORCAGE_PROVISOIRES, facteursMinimum: 2 };
  const creee = await moteur.creerParametres(prisma, { version: "essai-min2", valeurs: valeursOk, motif: "essai : deux facteurs suffisent" }, ctxGest);
  verifier("une version creee est PROVISOIRE (pas d'approbation) et saisie par la session", creee.provisoire === true && creee.etiquette === "PROVISOIRE, non approuvé" && creee.creeParId === U_GEST && creee.source === "saisie", creee);
  verifier("creer une version est audite (CREATE ParametresProgrammation)", (await compter(`SELECT count(*)::int AS n FROM audit_logs WHERE "entityType" = 'ParametresProgrammation' AND action = 'CREATE' AND "entityId" = $1`, creee.id)) === 1);
  verifier("recreer la meme version : VERSION_EXISTANTE", codeRefus(await echec(() => moteur.creerParametres(prisma, { version: "essai-min2", valeurs: valeursOk }, ctxGest))) === "VERSION_EXISTANTE");
  verifier("des valeurs invalides sont refusees avec toutes leurs erreurs (422)", /traficPlafondJma.*horizonAnnees|horizonAnnees.*traficPlafondJma/.test((await echec(() => moteur.creerParametres(prisma, { version: "essai-invalide", valeurs: { ...VALEURS_AMORCAGE_PROVISOIRES, traficPlafondJma: 0, horizonAnnees: 0 } }, ctxGest))) ?? ""));
  verifier("une version n'est jamais ecrite avec une valeur invalide", (await compter(`SELECT count(*)::int AS n FROM parametres_programmation WHERE version = 'essai-invalide'`)) === 0);
  verifier("deux versions provisoires, aucune approuvee : sans parametresId le moteur ne choisit pas (PARAMETRES_A_PRECISER)",
    codeRefus(await echec(() => moteur.simuler(prisma, { annee: 2027, intitule: "Essai ambigu", budgetGnf: 1_000_000_000n }, ctxGest))) === "PARAMETRES_A_PRECISER"
    && (await compter(`SELECT count(*)::int AS n FROM scenarios_programmation`)) === 0);
  const appr = await moteur.approuverParametres(prisma, creee.id, ctxAdmin);
  verifier("approuver pose la date et l'approbateur, et audite VALIDATE", appr.provisoire === false && appr.approuveeParId === U_ADMIN && (await compter(`SELECT count(*)::int AS n FROM audit_logs WHERE "entityType" = 'ParametresProgrammation' AND action = 'VALIDATE' AND "entityId" = $1`, creee.id)) === 1, appr);
  const parDefaut = await moteur.simuler(prisma, { annee: 2027, intitule: "Essai defaut approuve", budgetGnf: 1_000_000_000n }, ctxGest);
  verifier("sans parametresId, la version APPROUVEE est utilisee, et le scenario cite sa version",
    parDefaut.scenario.parametresVersion === "essai-min2" && parDefaut.resultat.parametres.approuveeLe !== null && parDefaut.resultat.parametres.etiquette === "paramètres approuvés", parDefaut.resultat.parametres);
  verifier("meme avec des parametres approuves, le scenario reste PROVISOIRE tant que le bareme, le catalogue et les matrices ne le sont pas",
    parDefaut.resultat.provisoire === true && parDefaut.resultat.motifsProvisoire.every((m: string) => !/paramètres de programmation non approuvés/.test(m)) && parDefaut.resultat.motifsProvisoire.length >= 1, parDefaut.resultat.motifsProvisoire);  verifier("approuver deux fois : DEJA_APPROUVEE", codeRefus(await echec(() => moteur.approuverParametres(prisma, creee.id, ctxAdmin))) === "DEJA_APPROUVEE");
  const desappr = await moteur.desapprouverParametres(prisma, creee.id, "essai : retrait", ctxAdmin);
  verifier("desapprouver rend la version PROVISOIRE, et l'audit garde le motif", desappr.provisoire === true && (await compter(`SELECT count(*)::int AS n FROM audit_logs WHERE "entityType" = 'ParametresProgrammation' AND action = 'UPDATE' AND "entityId" = $1 AND after->>'motif' = 'essai : retrait'`, creee.id)) === 1, desappr);

  // ---------- Simulation : comparaison a l'oracle SQL
  console.log("\nSimulation (budget 7 Md GNF, parametres d'amorcage)");
  // Plusieurs versions existent maintenant : le banc nomme celle qu'il veut, comme le fera un utilisateur.
  const idAmorcage = (await lire<{ id: string }>(`SELECT id FROM parametres_programmation WHERE version = $1`, VERSION_AMORCAGE))[0].id;
  const simul = (d: Record<string, unknown>, ctx = ctxGest) => moteur.simuler(prisma, { parametresId: idAmorcage, ...d }, ctx);
  const BUDGET = 7_000_000_000n;
  const sim = await simul({ annee: 2027, intitule: "Essai PAE 2027", budgetGnf: BUDGET }, ctxGest);
  const res = sim.resultat;
  const ls = lignesDe(res);
  verifier("exactement les 8 tronçons candidats (supprime, voirie locale et rejete exclus)", res.totaux.candidats === 8 && !ls.some((l: { troncon: { code: string } }) => /^PRG-X/.test(l.troncon.code)), res.totaux);
  const oracle = await oracleSql(VERSION_AMORCAGE);
  verifier("l'oracle SQL chiffre 4 tronçons (A, B, C, H) : trafic connu, état évalué, famille de coût et condition", oracle.map((o) => o.code).join() === "PRG-A,PRG-B,PRG-C,PRG-H", oracle.map((o) => o.code));
  for (const o of oracle) {
    const l = parCode(ls, o.code) as { risque: { ok: boolean; score: number }; risqueAttendu: { score: number }; cout: { ok: boolean; montantGnf: string }; traitement: { ok: boolean; traitement: { code: string } } };
    verifier(`${o.code} : risque du moteur = oracle SQL (${o.risque}) a 1e-4 pres`, l.risque.ok && proche(l.risque.score, Number(o.risque), 0.0001), { moteur: l.risque, oracle: o.risque });
    verifier(`${o.code} : risque attendu du moteur = oracle SQL (${o.attendu}) a 1e-4 pres`, proche(l.risqueAttendu.score, Number(o.attendu), 0.0001), { moteur: l.risqueAttendu, oracle: o.attendu });
    verifier(`${o.code} : cout du moteur = oracle SQL, au franc pres (${o.cout})`, l.cout.ok && l.cout.montantGnf === o.cout, { moteur: l.cout, oracle: o.cout });
    verifier(`${o.code} : traitement du moteur = condition en base (${o.traitement})`, l.traitement.ok && l.traitement.traitement.code === o.traitement);
  }
  const g = gloutonOracle(oracle, BUDGET);
  verifier(`le classement du moteur est celui de l'oracle : ${g.ordre.join(" > ")}`, JSON.stringify(ls.filter((l: { rangPriorite: number | null }) => l.rangPriorite !== null).map((l: { troncon: { code: string } }) => l.troncon.code)) === JSON.stringify(g.ordre), ls.map((l: { troncon: { code: string } }) => l.troncon.code));
  const retenuesMoteur = ls.filter((l: { decision: string }) => l.decision === "RETENUE").map((l: { troncon: { code: string } }) => l.troncon.code);
  verifier(`les lignes retenues sont celles de l'oracle glouton : ${g.retenues.join(", ")}`, JSON.stringify(retenuesMoteur) === JSON.stringify(g.retenues), retenuesMoteur);
  verifier("le reste de l'enveloppe est celui de l'oracle", res.totaux.resteGnf === g.reste.toString(), res.totaux);
  verifier("PRG-A est ecarte pour budget alors que PRG-B, de rang inferieur, est retenu (le glouton saute)", parCode(ls, "PRG-A")?.motifExclusion?.code === "BUDGET_INSUFFISANT" && parCode(ls, "PRG-B")?.decision === "RETENUE");
  const sommeSql = await lire<{ s: string }>(`SELECT coalesce(sum((l->'cout'->>'montantGnf')::bigint), 0)::text AS s FROM scenarios_programmation s, jsonb_array_elements(s."resultatCanonique"::jsonb->'lignes') l WHERE s.id = $1 AND l->>'decision' = 'RETENUE'`, sim.scenario.id);
  verifier("SQL : la somme des lignes retenues du texte stocke = montantEngageGnf, <= budget", sommeSql[0].s === sim.scenario.montantEngageGnf && BigInt(sommeSql[0].s) <= BUDGET, { sommeSql, sim: sim.scenario.montantEngageGnf });

  // ---------- Les refus motives
  console.log("\nRefus motives (le moteur ne devine pas)");
  const motif = (c: string) => parCode(ls, c)?.motifExclusion;
  verifier("PRG-D (etat NON_EVALUE) : RISQUE_NON_CALCULABLE / ETAT_NON_EVALUE", motif("PRG-D")?.code === "RISQUE_NON_CALCULABLE" && /ETAT_NON_EVALUE/.test(motif("PRG-D")?.detail ?? ""), motif("PRG-D"));
  verifier("PRG-E (revetement non renseigne) : AUCUN_TRAITEMENT / FAMILLE_COUT_ABSENTE", motif("PRG-E")?.code === "AUCUN_TRAITEMENT" && /FAMILLE_COUT_ABSENTE/.test(motif("PRG-E")?.detail ?? ""), motif("PRG-E"));
  verifier("PRG-F (pas de comptage de trafic : 2 facteurs) : FACTEURS_INSUFFISANTS", motif("PRG-F")?.code === "RISQUE_NON_CALCULABLE" && /FACTEURS_INSUFFISANTS/.test(motif("PRG-F")?.detail ?? ""), motif("PRG-F"));
  verifier("PRG-G (etat BON) : AUCUN_TRAITEMENT / AUCUNE_CONDITION", motif("PRG-G")?.code === "AUCUN_TRAITEMENT" && /AUCUNE_CONDITION/.test(motif("PRG-G")?.detail ?? ""), motif("PRG-G"));
  const h = parCode(ls, "PRG-H") as { troncon: { longueurM: number; longueurOrigine: string } };
  const lenGeo = await lire<{ m: string }>(`SELECT round(ST_Length(geom::geography))::text AS m FROM troncons WHERE code = 'PRG-H'`);
  verifier("PRG-H (longueurKm = 0) : longueur lue sur la geometrie, origine GEOMETRIE, egale a ST_Length", h.troncon.longueurOrigine === "GEOMETRIE" && String(h.troncon.longueurM) === lenGeo[0].m, { h, lenGeo });
  verifier("un scenario qui chiffre une longueur calculee le dit parmi ses motifs de provisoire", res.motifsProvisoire.some((m: string) => /longueur calculée sur la géométrie/.test(m)), res.motifsProvisoire);

  // ---------- Etiquette
  console.log("\nEtiquette PROVISOIRE");
  verifier("le scenario est provisoire et le dit : « PROVISOIRE, non approuvé »", res.provisoire === true && res.etiquette === "PROVISOIRE, non approuvé" && res.parametres.etiquette === "PROVISOIRE, non approuvé");
  verifier("chaque ligne porte l'etiquette", ls.every((l: { etiquette: string }) => l.etiquette === "PROVISOIRE, non approuvé"));
  verifier("le texte stocke en base porte aussi l'etiquette, sur le scenario et sur chaque ligne (SQL)",
    (await compter(`SELECT count(*)::int AS n FROM scenarios_programmation s, jsonb_array_elements(s."resultatCanonique"::jsonb->'lignes') l WHERE s.id = $1 AND l->>'etiquette' = 'PROVISOIRE, non approuvé'`, sim.scenario.id)) === ls.length
    && (await compter(`SELECT count(*)::int AS n FROM scenarios_programmation WHERE id = $1 AND "resultatCanonique"::jsonb->>'etiquette' = 'PROVISOIRE, non approuvé' AND provisoire`, sim.scenario.id)) === 1);
  verifier("le scenario cite la version des parametres utilisee (prog-provisoire-1) en colonne, en entrees et en resultat", sim.scenario.parametresVersion === VERSION_AMORCAGE && (await compter(`SELECT count(*)::int AS n FROM scenarios_programmation WHERE id = $1 AND "parametresVersion" = $2 AND "entreesCanoniques"::jsonb->'parametres'->>'version' = $2 AND "resultatCanonique"::jsonb->'parametres'->>'version' = $2`, sim.scenario.id, VERSION_AMORCAGE)) === 1);
  verifier("simuler est audite (CREATE ScenarioProgrammation, empreinte du resultat)", (await compter(`SELECT count(*)::int AS n FROM audit_logs WHERE "entityType" = 'ScenarioProgrammation' AND action = 'CREATE' AND "entityId" = $1 AND after->>'empreinteResultat' = $2`, sim.scenario.id, sim.scenario.empreinteResultat)) === 1);

  // ---------- Reproductibilite
  console.log("\nReproductibilite (A22)");
  const rj = await moteur.rejouer(prisma, sim.scenario.id);
  verifier("le rejeu depuis les seules entrees stockees redonne le resultat octet pour octet", rj.identique === true && rj.entreesIntegres === true && rj.empreinteRecalculee === sim.scenario.empreinteResultat, rj);
  const sim2 = await simul({ annee: 2027, intitule: "Essai PAE 2027 bis", budgetGnf: BUDGET }, ctxGest);
  verifier("relancer la meme simulation sur la meme base : memes entrees (empreinte) et meme resultat (empreinte)", sim2.scenario.empreinteEntrees === sim.scenario.empreinteEntrees && sim2.scenario.empreinteResultat === sim.scenario.empreinteResultat, { a: sim.scenario.empreinteEntrees, b: sim2.scenario.empreinteEntrees });
  verifier("l'empreinte stockee est le SHA-256 du texte, recalcule par la BASE (resultat et entrees)", (await compter(`SELECT count(*)::int AS n FROM scenarios_programmation WHERE id = $1 AND "empreinteResultat" = encode(sha256(convert_to("resultatCanonique", 'UTF8')), 'hex') AND "empreinteEntrees" = encode(sha256(convert_to("entreesCanoniques", 'UTF8')), 'hex')`, sim.scenario.id)) === 1);
  verifier("modifier le resultat d'un scenario est REFUSE par la base", /fige/.test((await echec(() => sql(`UPDATE scenarios_programmation SET "resultatCanonique" = '{}' WHERE id = $1`, sim.scenario.id))) ?? ""));
  verifier("supprimer physiquement un scenario est REFUSE par la base", /DELETE refuse/.test((await echec(() => sql(`DELETE FROM scenarios_programmation WHERE id = $1`, sim.scenario.id))) ?? ""));
  const insererScenarioTexte = (entrees: string, resultat: string, hashResultat: string) => sql(
    `INSERT INTO scenarios_programmation (id, annee, intitule, "parametresId", "parametresVersion", "budgetGnf", "entreesCanoniques", "empreinteEntrees", "resultatCanonique", "empreinteResultat", "nbRetenues", "nbEcartees", "montantEngageGnf", provisoire, "creeParId")
     SELECT 'x-bad', 2027, 'bad', id, $1, 1, $3::text, encode(sha256(convert_to($3::text,'UTF8')),'hex'), $4::text, COALESCE($5::text, encode(sha256(convert_to($4::text,'UTF8')),'hex')), 0, 0, 0, true, $2 FROM parametres_programmation WHERE version = $1`,
    VERSION_AMORCAGE, U_GEST, entrees, resultat, hashResultat);
  const entreesOk = `{"annee":2027,"budgetGnf":"1","parametres":{"version":"${VERSION_AMORCAGE}"}}`;
  const resultatOk = `{"annee":2027,"parametres":{"version":"${VERSION_AMORCAGE}"},"provisoire":true,"totaux":{"engageGnf":"0","retenues":0,"ecartees":0}}`;
  verifier("un resultat dont l'empreinte ne correspond pas au texte ne s'insere pas (CHECK sp_empreinte_resultat_exacte)", /sp_empreinte_resultat_exacte/.test((await echec(() => insererScenarioTexte(entreesOk, resultatOk, "0".repeat(64)))) ?? ""));
  verifier("un resultat dont une cle manque (NULL ne doit pas passer) ou dont le total contredit la colonne est refuse (CHECK sp_coherence_resultat)", /sp_coherence_resultat/.test((await echec(() => insererScenarioTexte(entreesOk, '{"annee":2027}', null as unknown as string))) ?? "")
    && /sp_coherence_resultat/.test((await echec(() => insererScenarioTexte(entreesOk, resultatOk.replace('"engageGnf":"0"', '"engageGnf":"1"').replace('"retenues":0', '"retenues":3'), null as unknown as string))) ?? ""));
  verifier("le meme texte, coherent et correctement scelle, s'insere (le test ci-dessus echoue donc bien pour la bonne raison)", (await echec(() => insererScenarioTexte(entreesOk, resultatOk, null as unknown as string))) === null
    && (await compter(`SELECT count(*)::int AS n FROM scenarios_programmation WHERE id = 'x-bad'`)) === 1);
  verifier("la meme simulation, rejouee depuis le texte de l'AUTRE scenario, donne la meme empreinte de resultat", (await moteur.rejouer(prisma, sim2.scenario.id)).empreinteRecalculee === sim.scenario.empreinteResultat);

  // ---------- Budget et barèmes
  console.log("\nContrainte budgetaire et refus de cout");
  const grand = await simul({ annee: 2027, intitule: "Essai large", budgetGnf: 100_000_000_000n }, ctxGest);
  verifier("budget de 100 Md : les quatre tronçons chiffrables sont retenus, 4 ecartes pour les raisons ci-dessus", grand.resultat.totaux.retenues === 4 && grand.resultat.totaux.ecartees === 4, grand.resultat.totaux);
  const nul = await simul({ annee: 2027, intitule: "Essai nul", budgetGnf: 0n }, ctxGest);
  verifier("budget nul : rien de retenu, rien d'engage, tout ecarte", nul.resultat.totaux.retenues === 0 && nul.resultat.totaux.engageGnf === "0", nul.resultat.totaux);
  const region1 = String((await lire<{ id: number }>(`SELECT id FROM regions WHERE nom = 'Region PRG1'`))[0].id);
  const plaf = await simul({ annee: 2027, intitule: "Essai plafond", budgetGnf: 100_000_000_000n, plafondsRegionauxGnf: { [region1]: 5_000_000_000n } }, ctxGest);
  verifier("plafond regional de 5 Md sur la region 1 : l'engage de la region (C + H = environ 3,2 Md) tient sous le plafond, A (4,4 Md) est ecartee PLAFOND_REGIONAL",
    BigInt((plaf.resultat.totaux.engageParRegionGnf as Record<string, string>)[region1]) <= 5_000_000_000n && parCode(plaf.resultat.lignes, "PRG-A")?.motifExclusion?.code === "PLAFOND_REGIONAL" && parCode(plaf.resultat.lignes, "PRG-B")?.decision === "RETENUE", plaf.resultat.totaux);
  await sql(`UPDATE baremes_intervention SET actif = false`);
  const sansBareme = await simul({ annee: 2027, intitule: "Essai sans bareme", budgetGnf: 100_000_000_000n }, ctxGest);
  await sql(`UPDATE baremes_intervention SET actif = true`);
  verifier("sans AUCUN bareme actif : le moteur de cout REFUSE, plus rien n'est chiffre ni retenu (D-07)",
    sansBareme.resultat.totaux.retenues === 0 && sansBareme.resultat.totaux.engageGnf === "0"
    && sansBareme.resultat.lignes.filter((l: { motifExclusion: { code: string } | null }) => l.motifExclusion?.code === "COUT_NON_ESTIMABLE").length === 4, sansBareme.resultat.totaux);
  verifier("le refus de cout cite le code du moteur (AUCUNE_LIGNE_DE_BAREME)", /AUCUNE_LIGNE_DE_BAREME/.test(JSON.stringify(parCode(sansBareme.resultat.lignes, "PRG-A")?.motifExclusion)));
  await sql(`UPDATE points_noirs SET "deletedAt" = now()`);
  const sansRegistre = await simul({ annee: 2027, intitule: "Essai sans registre", budgetGnf: 100_000_000_000n }, ctxGest);
  await sql(`UPDATE points_noirs SET "deletedAt" = NULL WHERE description = 'pn essai' AND id NOT IN (SELECT id FROM points_noirs WHERE "tronconId" = (SELECT id FROM troncons WHERE code = 'PRG-B'))`);
  verifier("sans registre de points noirs (la realite de la base aujourd'hui) : 2 facteurs sur 3 requis, le moteur REFUSE tout le risque",
    sansRegistre.resultat.totaux.retenues === 0 && sansRegistre.resultat.totaux.ecartesParMotif.RISQUE_NON_CALCULABLE >= 7, sansRegistre.resultat.totaux);
  const min2 = await simul({ annee: 2027, intitule: "Essai min2", budgetGnf: 100_000_000_000n, parametresId: creee.id }, ctxGest);
  verifier("abaisser le minimum a 2 facteurs (version saisie) est un choix de parametre trace dans le scenario", min2.scenario.parametresVersion === "essai-min2" && min2.resultat.parametres.version === "essai-min2");
  verifier("des parametres inconnus sont refuses", codeRefus(await echec(() => simul({ annee: 2027, intitule: "x y z", budgetGnf: 1n, parametresId: "inexistant" }, ctxGest))) === "PARAMETRES_INTROUVABLES");

  // ---------- Fiches figees
  console.log("\nFiches d'intervention figees");
  verifier("figer une ligne ECARTEE est refuse (LIGNE_NON_RETENUE) et n'ecrit rien", codeRefus(await echec(() => moteur.figerFiches(prisma, sim.scenario.id, { tronconIds: ["t-PRG-A"] }, ctxGest))) === "LIGNE_NON_RETENUE" && (await compter(`SELECT count(*)::int AS n FROM fiches_intervention`)) === 0);
  const fig = await moteur.figerFiches(prisma, sim.scenario.id, { sourceFinancement: "FER (essai)" }, ctxGest);
  verifier("figer sans selection fige toutes les lignes retenues (3)", fig.fiches.length === 3 && fig.provisoire === true, fig);
  verifier("chaque fiche naît BROUILLON, par la GEOPORTAIL", (await compter(`SELECT count(*)::int AS n FROM fiches_intervention_courantes WHERE statut = 'BROUILLON' AND "rangStatut" = 1`)) === 3);
  verifier("l'empreinte de chaque fiche est le SHA-256 du texte, recalcule par la BASE", (await compter(`SELECT count(*)::int AS n FROM fiches_intervention WHERE "empreinteSha256" = encode(sha256(convert_to("contenuCanonique", 'UTF8')), 'hex')`)) === 3);
  const f0 = (await lire<{ id: string; tronconId: string; contenuCanonique: string; empreinteSha256: string; figeLe: Date }>(`SELECT * FROM fiches_intervention WHERE "tronconId" = 't-PRG-C'`))[0];
  const c0 = JSON.parse(f0.contenuCanonique);
  verifier("la fiche embarque la copie INTEGRALE des parametres, leur version et l'etiquette PROVISOIRE", JSON.stringify(sortKeys(c0.parametres.valeurs)) === JSON.stringify(sortKeys(VALEURS_AMORCAGE_PROVISOIRES)) && c0.parametres.version === VERSION_AMORCAGE && c0.etiquette === "PROVISOIRE, non approuvé");
  verifier("elle porte patrimoine, plage lineaire, traitement, quantites, cout + classe de precision, score, justification, financement",
    c0.patrimoine.code === "PRG-C" && c0.patrimoine.plage.finM === 10000 && c0.traitement.traitement.code === "entretien_periodique" && c0.quantites.longueurM === 10000
    && c0.cout.classePrecision === "RESEAU_30" && c0.cout.montantGnf === "800000000" && c0.score.risque.score === 24.375 && /^Retenue/.test(c0.justification) && c0.financement.source === "FER (essai)", c0);
  verifier("le contenu ne porte aucun horodatage ; l'instant du gel est une colonne posee par la base", !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(f0.contenuCanonique) && f0.figeLe instanceof Date);
  verifier("la fiche cite son scenario et l'empreinte de son resultat", c0.scenario.id === sim.scenario.id && c0.scenario.empreinteResultat === sim.scenario.empreinteResultat);
  verifier("modifier une fiche figee est REFUSE par la base (UPDATE)", /figee/.test((await echec(() => sql(`UPDATE fiches_intervention SET reference = 'FI-X' WHERE id = $1`, f0.id))) ?? ""));
  verifier("supprimer une fiche est REFUSE par la base (DELETE)", /figee/.test((await echec(() => sql(`DELETE FROM fiches_intervention WHERE id = $1`, f0.id))) ?? ""));
  const altere = f0.contenuCanonique.replace('"montantGnf":"800000000"', '"montantGnf":"800000001"');
  verifier("altérer UN chiffre du texte d'une fiche, garder son empreinte : l'insertion est refusee (CHECK fi_empreinte_exacte)", altere !== f0.contenuCanonique && /fi_empreinte_exacte/.test((await echec(() => sql(`INSERT INTO fiches_intervention (id, reference, "scenarioId", "tronconId", annee, "parametresVersion", "contenuCanonique", "empreinteSha256", "figeParId") VALUES ('f-bad', 'FI-BAD', $1, 't-PRG-C', 2027, $2, $3, $4, $5)`, sim.scenario.id, VERSION_AMORCAGE, altere, f0.empreinteSha256, U_GEST))) ?? ""));
  verifier("un texte de fiche sans schema, ou dont le troncon differe de la colonne, est refuse (CHECK fi_schema_connu / fi_coherence_contenu)",
    /fi_schema_connu/.test((await echec(() => insererFicheTexte("f-bad2", `{"annee":2027,"parametres":{"version":"${VERSION_AMORCAGE}"},"patrimoine":{"tronconId":"t-PRG-C"},"scenario":{"id":"${sim.scenario.id}"}}`, "t-PRG-C", sim.scenario.id))) ?? "")
    && /fi_coherence_contenu/.test((await echec(() => insererFicheTexte("f-bad3", `{"annee":2027,"parametres":{"version":"${VERSION_AMORCAGE}"},"patrimoine":{"tronconId":"t-PRG-A"},"schema":"fiche-intervention/1","scenario":{"id":"${sim.scenario.id}"}}`, "t-PRG-C", sim.scenario.id))) ?? ""));
  verifier("figer deux fois la meme ligne : FICHE_DEJA_FIGEE (409)", codeRefus(await echec(() => moteur.figerFiches(prisma, sim.scenario.id, { tronconIds: ["t-PRG-C"] }, ctxGest))) === "FICHE_DEJA_FIGEE");
  verifier("figer est audite (une trace CREATE FicheIntervention par fiche)", (await compter(`SELECT count(*)::int AS n FROM audit_logs WHERE "entityType" = 'FicheIntervention' AND action = 'CREATE'`)) === 3);
  const ver = await moteur.verifierFicheStockee(prisma, f0.id);
  verifier("la verification recalcule l'empreinte du texte stocke : ok", ver.verdict.ok === true && ver.empreinteStockee === f0.empreinteSha256, ver);
  const fig2 = await moteur.figerFiches(prisma, sim2.scenario.id, { tronconIds: ["t-PRG-C"], sourceFinancement: "FER (essai)" }, ctxGest);
  const c2 = JSON.parse((await lire<{ contenuCanonique: string }>(`SELECT "contenuCanonique" FROM fiches_intervention WHERE id = $1`, fig2.fiches[0].id))[0].contenuCanonique);
  const sansId = (c: Record<string, any>) => JSON.stringify(sortKeys({ ...c, scenario: { ...c.scenario, id: null } }));
  verifier("deux scenarios aux memes entrees donnent deux fiches IDENTIQUES au scenario pres : le gel est rejouable", sansId(c0) === sansId(c2));
  verifier("un scenario cite par une fiche ne se retire pas (SCENARIO_UTILISE)", codeRefus(await echec(() => moteur.supprimerScenario(prisma, sim.scenario.id, ctxGest))) === "SCENARIO_UTILISE");
  verifier("un scenario sans fiche se retire par suppression LOGIQUE, auditee, et disparait de la lecture", (await moteur.supprimerScenario(prisma, nul.scenario.id, ctxGest)).ok === true
    && (await compter(`SELECT count(*)::int AS n FROM scenarios_programmation WHERE id = $1 AND "deletedAt" IS NOT NULL`, nul.scenario.id)) === 1
    && codeRefus(await echec(() => moteur.lireScenarioComplet(prisma, nul.scenario.id))) === "INTROUVABLE"
    && (await compter(`SELECT count(*)::int AS n FROM audit_logs WHERE "entityType" = 'ScenarioProgrammation' AND action = 'DELETE' AND "entityId" = $1`, nul.scenario.id)) === 1);

  // ---------- Cycle de vie et frontiere DigitalRoad
  console.log("\nCycle de vie : la frontiere DigitalRoad");
  const fid = f0.id;
  verifier("BROUILLON vers PROPOSE : accepte, audite", (await moteur.changerStatutFiche(prisma, fid, "PROPOSE", null, ctxGest)).vers === "PROPOSE" && (await compter(`SELECT count(*)::int AS n FROM audit_logs WHERE "entityType" = 'FicheIntervention' AND action = 'UPDATE' AND "entityId" = $1`, fid)) === 1);
  verifier("PROPOSE vers APPROUVE (saut d'etape) : refuse (TRANSITION_INEXISTANTE)", codeRefus(await echec(() => moteur.changerStatutFiche(prisma, fid, "APPROUVE", null, ctxGest))) === "TRANSITION_INEXISTANTE");
  await moteur.changerStatutFiche(prisma, fid, "ARBITRE", null, ctxGest);
  await moteur.changerStatutFiche(prisma, fid, "APPROUVE", null, ctxGest);
  verifier("un recul avant transmission sans motif : refuse (RETOUR_NON_MOTIVE)", codeRefus(await echec(() => moteur.changerStatutFiche(prisma, fid, "ARBITRE", null, ctxGest))) === "RETOUR_NON_MOTIVE");
  for (const vers of ["TRANSMIS", "EN_EXECUTION", "ACHEVE", "EVALUE"]) {
    const m = await echec(() => moteur.changerStatutFiche(prisma, fid, vers, "tentative", ctxAdmin));
    verifier(`${vers} depuis le Geoportail : refuse, ce statut est recu (TRANSITION_INEXISTANTE ou ORIGINE_INTERDITE)`, ["TRANSITION_INEXISTANTE", "ORIGINE_INTERDITE"].includes(codeRefus(m) ?? ""), m);
  }
  verifier("APPROUVE vers TRANSMIS depuis le Geoportail : ORIGINE_INTERDITE (403), meme pour un ADMIN", codeRefus(await echec(() => moteur.changerStatutFiche(prisma, fid, "TRANSMIS", "tentative", ctxAdmin))) === "ORIGINE_INTERDITE");
  verifier("la base refuse elle aussi TRANSMIS avec l'origine GEOPORTAIL (contrainte fis_origine_selon_statut)", /fis_origine_selon_statut/.test((await echec(() => sql(`INSERT INTO fiches_intervention_statuts (id, "ficheId", rang, de, vers, origine, "auteurId", "versionFigee") VALUES ('s-bad1', $1, 5, 'APPROUVE', 'TRANSMIS', 'GEOPORTAIL', $2, repeat('a',64))`, fid, U_GEST))) ?? ""));
  verifier("la base refuse un statut recu sans le message qui le porte (fis_fait_identifie)", /fis_fait_identifie/.test((await echec(() => sql(`INSERT INTO fiches_intervention_statuts (id, "ficheId", rang, de, vers, origine, "versionFigee") VALUES ('s-bad2', $1, 5, 'APPROUVE', 'TRANSMIS', 'DIGITALROAD', repeat('a',64))`, fid))) ?? ""));
  verifier("la base refuse TRANSMIS sans l'empreinte de la version figee (fis_version_figee_a_la_transmission)", /fis_version_figee_a_la_transmission/.test((await echec(() => sql(`INSERT INTO fiches_intervention_statuts (id, "ficheId", rang, de, vers, origine, "messageDigitalRoadId") VALUES ('s-bad3', $1, 5, 'APPROUVE', 'TRANSMIS', 'DIGITALROAD', 'msg-1')`, fid))) ?? ""));
  verifier("la base refuse une chaine rompue (le « de » doit etre le statut precedent)", /chaine est rompue/.test((await echec(() => sql(`INSERT INTO fiches_intervention_statuts (id, "ficheId", rang, de, vers, origine, "auteurId") VALUES ('s-bad4', $1, 5, 'PROPOSE', 'ARBITRE', 'GEOPORTAIL', $2)`, fid, U_GEST))) ?? ""));
  verifier("modifier ou supprimer un statut est REFUSE (ajout seul)", /ajout seul/.test((await echec(() => sql(`UPDATE fiches_intervention_statuts SET motif = 'x' WHERE "ficheId" = $1`, fid))) ?? "") && /ajout seul/.test((await echec(() => sql(`DELETE FROM fiches_intervention_statuts WHERE "ficheId" = $1`, fid))) ?? ""));
  const hist = await moteur.lireFicheComplete(prisma, fid);
  verifier("l'historique de la fiche : BROUILLON, PROPOSE, ARBITRE, APPROUVE, tous GEOPORTAIL, courant APPROUVE", hist.historique.map((h: { vers: string }) => h.vers).join() === "BROUILLON,PROPOSE,ARBITRE,APPROUVE" && hist.historique.every((h: { origine: string }) => h.origine === "GEOPORTAIL") && hist.fiche.statut === "APPROUVE", hist.historique);

  // ---------- Non regression
  console.log("\nNon regression");
  verifier("la saisie manuelle des previsions (programmes_budgetaires) est intacte : 0 ligne ecrite par le moteur", (await compter(`SELECT count(*)::int AS n FROM programmes_budgetaires`)) === 0);
  verifier("aucun chantier, marche, ordre de travaux ni decompte n'a ete cree", (await compter(`SELECT (SELECT count(*) FROM chantiers) + (SELECT count(*) FROM marches) + (SELECT count(*) FROM ordres_travaux) + (SELECT count(*) FROM decomptes) AS n`)) === 0);
  verifier("la base `replay`, modele du clone, n'a recu aucune fixture (0 utilisateur, 0 troncon, 0 region)", await replayIntacte());

  conclure();
}

async function compter(q: string, ...a: unknown[]): Promise<number> {
  const r = await lire<{ n: number | bigint }>(q, ...a);
  return Number(r[0].n);
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}

async function replayIntacte(): Promise<boolean> {
  const c = new pg.Client({ connectionString: ORIGINE });
  await c.connect();
  try {
    const r = await c.query(`SELECT (SELECT count(*) FROM users)::int AS u, (SELECT count(*) FROM troncons)::int AS t, (SELECT count(*) FROM regions)::int AS r`);
    return r.rows[0].u === 0 && r.rows[0].t === 0 && r.rows[0].r === 0;
  } finally { await c.end(); }
}

function insererFicheTexte(id: string, texte: string, tronconId: string, scenarioId: string) {
  return sql(
    `INSERT INTO fiches_intervention (id, reference, "scenarioId", "tronconId", annee, "parametresVersion", "contenuCanonique", "empreinteSha256", "figeParId")
     VALUES ($1, $2, $3, $4, 2027, $5, $6::text, encode(sha256(convert_to($6::text,'UTF8')),'hex'), $7)`,
    id, `FI-${id}`, scenarioId, tronconId, VERSION_AMORCAGE, texte, U_GEST);
}

main().catch((e) => { console.error(e); process.exitCode = 2; }).finally(async () => { await prisma.$disconnect(); await supprimerClone(ORIGINE!, NOM_CLONE); });

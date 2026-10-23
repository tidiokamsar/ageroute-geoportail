// Banc d'integration de la programmation PLURIANNUELLE (PPE) minimale, de la lecture de la praticabilite (D-02) et du
// volet « interventions figees » de la Fiche 360 : voir tests-integration/README.md.
// Lancer (DATABASE_URL pointe sur `replay`) : npx tsx tests-integration/ppe.integration.mts
//
// Les services committent et les declencheurs font echouer des requetes : le banc travaille dans un CLONE jetable de
// `replay`, cree puis detruit par lui-meme (essai_ppe). La base `replay` n'est jamais ecrite. `replay` ne contient pas la
// migration 20261026300000 : le banc l'applique au clone (deux fois : elle est idempotente).
//
// L'ORACLE INDEPENDANT. Les nombres du moteur (risque, risque attendu, cout) sont recalcules par une REQUETE SQL qui ne
// partage aucun code avec le moteur TypeScript (arithmetique NUMERIC exacte, parametres lus dans la table). Le CHAINAGE
// pluriannuel est ensuite refait ici AUTREMENT que le noyau : le noyau trie puis balaie chaque annee ; l'oracle fait des
// SELECTIONS REPETEES du meilleur troncon restant qui tient dans l'enveloppe, par fractions exactes en BigInt, sans tri.
// Une CONTRE-EPREUVE falsifie un plan (un troncon retenu deux fois, une annee permutee) et exige que l'oracle le signale.
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
const NOM_CLONE = "essai_ppe";
await creerClone(ORIGINE!, NOM_CLONE);
const URL_CLONE = urlClone(ORIGINE!, NOM_CLONE);
process.env.DATABASE_URL = URL_CLONE;
console.log("Cible du banc : clone jetable " + NOM_CLONE);

const ICI = dirname(fileURLToPath(import.meta.url));
const R = new URL("../src/", pathToFileURL(process.argv[1]).href).href;
const imp = (p: string) => import(R + p + ".ts");
const { prisma } = await imp("lib/prisma");
const moteur = await imp("programmation/moteur.service");
const ppe = await imp("programmation/ppe.service");
const { voletProgrammation } = await imp("tableau-de-bord/fiche360.service");
const { VERSION_AMORCAGE } = await imp("programmation/parametres.noyau");

const require = createRequire(import.meta.url);
const pg = require("pg");

const MIGRATION = join(ICI, "../prisma/migrations/20261026300000_plans_pluriannuels/migration.sql");

async function sqlMulti(texte: string) {
  const c = new pg.Client({ connectionString: URL_CLONE });
  await c.connect();
  try { await c.query(texte); } finally { await c.end(); }
}
const sql = (q: string, ...a: unknown[]) => prisma.$executeRawUnsafe(q, ...a);
const lire = <T = Record<string, unknown>>(q: string, ...a: unknown[]) => prisma.$queryRawUnsafe<T[]>(q, ...a);
const compter = async (q: string, ...a: unknown[]) => Number((await lire<{ n: number | bigint }>(q, ...a))[0].n);

async function echec(f: () => Promise<unknown>): Promise<string | null> {
  try { await f(); return null; } catch (e) { return e instanceof moteur.RefusMoteur ? `${e.code}|${e.message}` : String((e as Error).message ?? e); }
}
const codeRefus = (m: string | null) => (m ? m.split("|")[0] : null);

const U_ADMIN = "00000000-0000-4000-8000-0000000000a1";
const U_GEST = "00000000-0000-4000-8000-0000000000a2";
const ctxGest = { userId: U_GEST, email: "gest@essai.invalid" };

async function troncon(code: string, o: { etat: string; rev?: string; jma?: number | null; longueurKm: number; region?: string; lat?: number; src?: string | null; statut?: string | null; supprime?: boolean }) {
  const wkt = `LINESTRING(-13.6 ${o.lat ?? 9.6}, -13.58 ${o.lat ?? 9.6})`;
  await sql(
    `INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, etat, "pkDebut", "pkFin", "traficMoyenJma", "sourceReference", "statutValidation", "deletedAt", geom, "updatedAt")
     VALUES ($1, $2, $3, 'RN', (SELECT id FROM regions WHERE nom = $4), $5, $6::"Revetement", $7::"EtatPatrimoine", 0, $5, $8, $9, $10::"StatutValidation", $11, ST_GeomFromText($12, 4326), now())`,
    `t-${code}`, code, `Troncon ${code}`, o.region ?? "Region PPE1", o.longueurKm, o.rev ?? "BITUME", o.etat, o.jma ?? null, o.src ?? null, o.statut ?? null, o.supprime ? new Date() : null, wkt);
}
async function pointNoir(code: string, n: number) {
  for (let i = 0; i < n; i++) {
    await sql(
      `INSERT INTO points_noirs (id, description, "regionId", "tronconId", gravite, "updatedAt")
       VALUES (gen_random_uuid()::text, 'pn essai', (SELECT "regionId" FROM troncons WHERE code = $1), (SELECT id FROM troncons WHERE code = $1), 'FORTE'::"Gravite", now())`, code);
  }
}

/** Oracle SQL : risque, risque attendu et cout, sans aucun code du moteur. Horizon 1 an. Tronçons PPE-% seulement. */
async function oracleSql(version: string) {
  return lire<{ code: string; risque: string; attendu: string; cout: string; len_m: string; traitement: string }>(`
    WITH p AS (SELECT valeurs AS v FROM parametres_programmation WHERE version = $1),
    t AS (
      SELECT tr.id, tr.code, tr.etat::text AS etat, tr."traficMoyenJma" AS jma,
             round(CASE WHEN tr."longueurKm" > 0 THEN tr."longueurKm" * 1000 ELSE ST_Length(tr.geom::geography) END)::bigint AS len_m,
             (SELECT count(*) FROM points_noirs x WHERE x."tronconId" = tr.id AND x."deletedAt" IS NULL)::numeric AS npn,
             CASE tr.revetement::text WHEN 'BITUME' THEN 'bitume' WHEN 'TERRE' THEN 'terre_laterite' WHEN 'LATERITE' THEN 'terre_laterite' WHEN 'PAVE' THEN 'pave' END AS fam
        FROM troncons tr
       WHERE tr.code LIKE 'PPE-%' AND tr."deletedAt" IS NULL AND (tr."statutValidation" IS NULL OR tr."statutValidation" = 'VALIDE')
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

type Item = { code: string; r: bigint; a: bigint; c: bigint };

/**
 * Chainage pluriannuel par SELECTIONS REPETEES du meilleur restant qui tient (aucun tri, aucun balayage) : a chaque pas, on
 * parcourt les restants et on garde celui qui domine tous les autres (rapport attendu / cout par produit croise, puis
 * risque courant, cout, code). Un troncon pris disparait des restants pour toutes les annees suivantes.
 */
function oracleChaine(lignes: { code: string; risque: string; attendu: string; cout: string }[], budgets: bigint[]) {
  const micro = (s: string) => BigInt(Math.round(Number(s) * 10000));
  let restants: Item[] = lignes.map((l) => ({ code: l.code, r: micro(l.risque), a: micro(l.attendu), c: BigInt(l.cout) }));
  const domine = (x: Item, y: Item): boolean => {
    const g = x.a * y.c, d = y.a * x.c;
    if (g !== d) return g > d;
    if (x.r !== y.r) return x.r > y.r;
    if (x.c !== y.c) return x.c < y.c;
    return x.code < y.code;
  };
  const annees: { retenus: string[]; engage: bigint; reste: bigint }[] = [];
  for (const budget of budgets) {
    let reste = budget;
    const pris: Item[] = [];
    for (;;) {
      let meilleur: Item | null = null;
      for (const x of restants) {
        if (x.c > reste) continue;
        if (meilleur === null || domine(x, meilleur)) meilleur = x;
      }
      if (meilleur === null) break;
      pris.push(meilleur);
      reste -= meilleur.c;
      restants = restants.filter((x) => x !== meilleur);
    }
    annees.push({ retenus: pris.map((x) => x.code), engage: budget - reste, reste });
  }
  return annees;
}

interface LigneRes { troncon: { code: string; id: string }; decision: string; cout: { montantGnf: string } | null; motifExclusion: { code: string } | null }
interface PlanRes { annees: { annee: number; enveloppeGnf: string; scenario: { lignes: LigneRes[]; totaux: { engageGnf: string; resteGnf: string } } }[] }

/** Differences entre l'oracle et un plan : liste vide = accord complet, annee par annee. */
function ecarts(attendu: ReturnType<typeof oracleChaine>, plan: PlanRes): string[] {
  const e: string[] = [];
  if (plan.annees.length !== attendu.length) e.push(`nombre d'annees : ${plan.annees.length} au lieu de ${attendu.length}`);
  const dejaVus = new Set<string>();
  plan.annees.forEach((a, i) => {
    const retenus = a.scenario.lignes.filter((l) => l.decision === "RETENUE").map((l) => l.troncon.code);
    if (JSON.stringify(retenus) !== JSON.stringify(attendu[i]?.retenus)) e.push(`annee ${a.annee} : retenus ${retenus.join()} au lieu de ${(attendu[i]?.retenus ?? []).join()}`);
    for (const c of retenus) { if (dejaVus.has(c)) e.push(`annee ${a.annee} : ${c} retenu une seconde fois`); dejaVus.add(c); }
    if (attendu[i] && a.scenario.totaux.engageGnf !== attendu[i].engage.toString()) e.push(`annee ${a.annee} : engage ${a.scenario.totaux.engageGnf} au lieu de ${attendu[i].engage}`);
    if (attendu[i] && a.scenario.totaux.resteGnf !== attendu[i].reste.toString()) e.push(`annee ${a.annee} : reste ${a.scenario.totaux.resteGnf} au lieu de ${attendu[i].reste}`);
  });
  return e;
}

const MD = 1_000_000_000n;

async function main() {
  // ---------- Schema
  console.log("\nMigration");
  const texte = readFileSync(MIGRATION, "utf8");
  verifier("avant la migration, la table n'existe pas dans le clone (donc pas dans replay)", (await compter(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'plans_pluriannuels'`)) === 0);
  await sqlMulti(texte);
  let rejeu: string | null = null;
  try { await sqlMulti(texte); } catch (e) { rejeu = String((e as Error).message); }
  verifier("la migration s'applique au clone, puis une seconde fois sans erreur (idempotente)", rejeu === null, rejeu);
  verifier("la table plans_pluriannuels existe, sans aucune ligne semee (aucune enveloppe inventee)", (await compter(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'plans_pluriannuels'`)) === 1 && (await compter(`SELECT count(*)::int AS n FROM plans_pluriannuels`)) === 0);

  // ---------- Fixtures
  await sql(`INSERT INTO regions (nom) VALUES ('Region PPE1'), ('Region PPE2'), ('Region PPE3')`);
  for (const [id, email, role] of [[U_ADMIN, "admin@essai.invalid", "ADMIN"], [U_GEST, "gest@essai.invalid", "GESTIONNAIRE"]] as const) {
    await sql(`INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt") VALUES ($1, $2, 'Essai', 'x', $3::"Role", now())`, id, email, role);
  }
  // Dix troncons chiffrables, de couts et de risques varies (longueurs multiples de 100 m : le cout est un entier exact).
  await troncon("PPE-01", { etat: "MAUVAIS", jma: 2500, longueurKm: 2, lat: 9.60 });
  await troncon("PPE-02", { etat: "CRITIQUE", jma: 600, longueurKm: 0.6, region: "Region PPE2", lat: 9.61 });
  await troncon("PPE-03", { etat: "MOYEN", jma: 100, longueurKm: 8, rev: "TERRE", lat: 9.62 });
  await troncon("PPE-04", { etat: "MAUVAIS", jma: 300, longueurKm: 3, rev: "TERRE", lat: 9.63 });
  await troncon("PPE-05", { etat: "CRITIQUE", jma: 1500, longueurKm: 2, rev: "TERRE", region: "Region PPE2", lat: 9.64 });
  await troncon("PPE-06", { etat: "MOYEN", jma: 4000, longueurKm: 5, lat: 9.65 });
  await troncon("PPE-07", { etat: "MAUVAIS", jma: 900, longueurKm: 1.5, rev: "PAVE", lat: 9.66 });
  await troncon("PPE-08", { etat: "CRITIQUE", jma: 2200, longueurKm: 1, rev: "PAVE", region: "Region PPE2", lat: 9.67 });
  await troncon("PPE-09", { etat: "MOYEN", jma: 50, longueurKm: 2, rev: "PAVE", lat: 9.68 });
  await troncon("PPE-10", { etat: "MAUVAIS", jma: 1200, longueurKm: 0.5, lat: 9.69 });
  // Troncons que le moteur ECARTE (avec motif) ou ne lit pas.
  await troncon("PPE-D", { etat: "NON_EVALUE", jma: 2000, longueurKm: 3, lat: 9.70 });
  await troncon("PPE-F", { etat: "MAUVAIS", jma: null, longueurKm: 3, lat: 9.71 });
  await troncon("PPE-X1", { etat: "MAUVAIS", jma: 2500, longueurKm: 4, lat: 9.72, supprime: true });
  await troncon("PPE-X2", { etat: "MAUVAIS", jma: 2500, longueurKm: 4, lat: 9.73, src: "voirie_locale:essai" });
  await troncon("PPE-X3", { etat: "MAUVAIS", jma: 2500, longueurKm: 4, lat: 9.74, statut: "REJETE" });
  // Une region sans aucun facteur exploitable : seul l'etat est renseigne (le cas du reseau reel aujourd'hui).
  await troncon("PPE-S1", { etat: "MAUVAIS", jma: null, longueurKm: 2, region: "Region PPE3", lat: 9.75 });
  await troncon("PPE-S2", { etat: "CRITIQUE", jma: null, longueurKm: 1, region: "Region PPE3", lat: 9.76 });
  // Le registre des points noirs est non vide : la facette securite est LUE (0 point noir = aucun enregistre).
  await pointNoir("PPE-01", 2); await pointNoir("PPE-02", 1); await pointNoir("PPE-05", 3); await pointNoir("PPE-06", 1); await pointNoir("PPE-08", 1);
  const regionId = (await lire<{ id: number }>(`SELECT id FROM regions WHERE nom = 'Region PPE3'`))[0].id;

  // ---------- Plan [4 Md, 6 Md, 3 Md] contre l'oracle independant
  console.log("\nPlan pluriannuel de trois annees, contre l'oracle independant");
  const BUDGETS = [4n * MD, 6n * MD, 3n * MD];
  const demande = { anneeDebut: 2027, intitule: "PPE 2027-2029 essai", enveloppes: BUDGETS.map((b) => ({ budgetGnf: b })) };
  const sim = await ppe.simulerPlan(prisma, demande, ctxGest);
  const res = sim.resultat as PlanRes & { synthese: any; etiquette: string; provisoire: boolean; parametres: any; limites: string[]; motifsProvisoire: string[] };
  const oracle = await oracleSql(VERSION_AMORCAGE);
  verifier("l'oracle SQL chiffre les 10 troncons PPE-01 a PPE-10 (trafic connu, etat evalue, famille de cout et condition)", oracle.map((o) => o.code).join() === "PPE-01,PPE-02,PPE-03,PPE-04,PPE-05,PPE-06,PPE-07,PPE-08,PPE-09,PPE-10", oracle.map((o) => o.code));
  const attendu = oracleChaine(oracle, BUDGETS);
  verifier(`l'oracle (selections repetees) retient quelque chose chaque annee et laisse des troncons de cote : le jeu n'est pas trivial (${attendu.map((a) => a.retenus.length).join("+")})`,
    attendu.every((a) => a.retenus.length > 0) && attendu.flatMap((a) => a.retenus).length < 10, attendu);
  const diff = ecarts(attendu, res);
  verifier("le plan du moteur est celui de l'oracle, annee par annee : memes retenus (et memes rangs), meme engage, meme reste", diff.length === 0, diff);
  for (const o of oracle) {
    const ligne = res.annees.flatMap((a) => a.scenario.lignes).find((l) => l.troncon.code === o.code && l.decision === "RETENUE");
    if (ligne) verifier(`${o.code} : cout du plan = oracle SQL au franc pres (${o.cout})`, ligne.cout?.montantGnf === o.cout, { plan: ligne.cout, oracle: o.cout });
  }
  const dejaDeux = res.annees.flatMap((a) => a.scenario.lignes.filter((l) => l.decision === "RETENUE").map((l) => l.troncon.id));
  verifier("aucun troncon n'est retenu deux fois sur l'horizon", new Set(dejaDeux).size === dejaDeux.length, dejaDeux);
  verifier("un troncon ecarte pour budget une annee et retenu plus tard existe (le chainage sert a quelque chose)",
    res.annees.slice(1).some((a) => a.scenario.lignes.some((l) => l.decision === "RETENUE" && res.annees[0].scenario.lignes.find((x) => x.troncon.id === l.troncon.id)?.motifExclusion?.code === "BUDGET_INSUFFISANT")), res.synthese.parAnnee);
  verifier("l'engage de chaque annee ne depasse jamais son enveloppe saisie", res.annees.every((a) => BigInt(a.scenario.totaux.engageGnf) <= BigInt(a.enveloppeGnf)));
  verifier("les enveloppes du plan sont celles saisies, rien d'autre (4, 6 et 3 Md GNF, aucun report du reste)", res.annees.map((a) => a.enveloppeGnf).join() === BUDGETS.join() && res.synthese.enveloppeTotaleGnf === (13n * MD).toString(), res.synthese);
  const attenduEcartes = new Map(res.annees[0].scenario.lignes.filter((l) => l.decision === "ECARTEE").map((l) => [l.troncon.code, l.motifExclusion?.code]));
  verifier("PPE-D (etat NON_EVALUE) et PPE-F (pas de trafic) sont ecartes AVANT classement avec leur motif, chaque annee", res.annees.every((a) =>
    a.scenario.lignes.find((l) => l.troncon.code === "PPE-D")?.motifExclusion?.code === "RISQUE_NON_CALCULABLE" && a.scenario.lignes.find((l) => l.troncon.code === "PPE-F")?.motifExclusion?.code === "RISQUE_NON_CALCULABLE"), [...attenduEcartes]);
  verifier("le supprime, la voirie locale et le rejete (PPE-X*) ne sont jamais candidats", !res.annees.some((a) => a.scenario.lignes.some((l) => /^PPE-X/.test(l.troncon.code))));

  // ---------- Contre-epreuve de l'oracle
  console.log("\nContre-epreuve : l'oracle detecte un plan faux");
  const faux1 = structuredClone(res) as PlanRes;
  const premier = faux1.annees[0].scenario.lignes.find((l) => l.decision === "RETENUE")!;
  faux1.annees[1].scenario.lignes.unshift({ ...structuredClone(premier) });
  verifier("un troncon retenu en annee 1 et reretenu en annee 2 est signale", ecarts(attendu, faux1).some((x) => /retenu une seconde fois/.test(x)), ecarts(attendu, faux1));
  const faux2 = structuredClone(res) as PlanRes;
  [faux2.annees[0], faux2.annees[1]] = [faux2.annees[1], faux2.annees[0]];
  verifier("deux annees permutees sont signalees", ecarts(attendu, faux2).length > 0);
  const faux3 = structuredClone(res) as PlanRes;
  faux3.annees[2].scenario.totaux.engageGnf = (BigInt(faux3.annees[2].scenario.totaux.engageGnf) + 1n).toString();
  verifier("un engage decale d'un franc est signale", ecarts(attendu, faux3).some((x) => /engage/.test(x)));
  verifier("le plan authentique n'est pas signale (l'oracle ne crie pas au loup)", ecarts(attendu, res).length === 0);

  // ---------- Etiquette PROVISOIRE
  console.log("\nEtiquette PROVISOIRE et justification");
  verifier("le plan est PROVISOIRE et le dit : « PROVISOIRE, non approuvé »", res.provisoire === true && res.etiquette === "PROVISOIRE, non approuvé" && res.parametres.etiquette === "PROVISOIRE, non approuvé");
  verifier("chaque ligne de chaque annee porte l'etiquette (SQL sur le texte stocke)",
    (await compter(`SELECT count(*)::int AS n FROM plans_pluriannuels p, jsonb_array_elements(p."resultatCanonique"::jsonb->'annees') a, jsonb_array_elements(a->'scenario'->'lignes') l WHERE p.id = $1 AND l->>'etiquette' = 'PROVISOIRE, non approuvé'`, sim.plan.id))
    === res.annees.reduce((n, a) => n + a.scenario.lignes.length, 0));
  verifier("chaque ligne porte une justification non vide (SQL)", (await compter(`SELECT count(*)::int AS n FROM plans_pluriannuels p, jsonb_array_elements(p."resultatCanonique"::jsonb->'annees') a, jsonb_array_elements(a->'scenario'->'lignes') l WHERE p.id = $1 AND length(l->>'justification') > 20`, sim.plan.id)) === res.annees.reduce((n, a) => n + a.scenario.lignes.length, 0));
  verifier("le plan cite la version des parametres en colonne, en entrees et en resultat", sim.plan.parametresVersion === VERSION_AMORCAGE && (await compter(`SELECT count(*)::int AS n FROM plans_pluriannuels WHERE id = $1 AND "parametresVersion" = $2 AND "entreesCanoniques"::jsonb->'parametres'->>'version' = $2 AND "resultatCanonique"::jsonb->'parametres'->>'version' = $2`, sim.plan.id, VERSION_AMORCAGE)) === 1);
  verifier("le plan dit sa methode (gloutonne, sans PLNE) et ses limites", res.limites.some((l: string) => /gloutonne/.test(l) && /PLNE/.test(l)) && res.limites.some((l: string) => /ne reporte aucun reste/.test(l)));
  verifier("SQL : la somme des lignes retenues du texte stocke = montantEngageGnf, <= enveloppe totale", (await lire<{ s: string }>(`SELECT coalesce(sum((l->'cout'->>'montantGnf')::bigint),0)::text AS s FROM plans_pluriannuels p, jsonb_array_elements(p."resultatCanonique"::jsonb->'annees') a, jsonb_array_elements(a->'scenario'->'lignes') l WHERE p.id = $1 AND l->>'decision' = 'RETENUE'`, sim.plan.id))[0].s === sim.plan.montantEngageGnf && BigInt(sim.plan.montantEngageGnf) <= 13n * MD);
  verifier("SQL : aucun troncon n'est retenu deux fois sur l'horizon", (await compter(`SELECT (count(*) - count(DISTINCT l->'troncon'->>'id'))::int AS n FROM plans_pluriannuels p, jsonb_array_elements(p."resultatCanonique"::jsonb->'annees') a, jsonb_array_elements(a->'scenario'->'lignes') l WHERE p.id = $1 AND l->>'decision' = 'RETENUE'`, sim.plan.id)) === 0);
  verifier("simuler un plan est audite (CREATE PlanPluriannuel, enveloppes saisies, empreinte, auteur de la session)",
    (await compter(`SELECT count(*)::int AS n FROM audit_logs WHERE "entityType" = 'PlanPluriannuel' AND action = 'CREATE' AND "entityId" = $1 AND "userId" = $2 AND after->>'empreinteResultat' = $3 AND after->'enveloppesGnf' = '["4000000000","6000000000","3000000000"]'::jsonb`, sim.plan.id, U_GEST, sim.plan.empreinteResultat)) === 1);

  // ---------- Reproductibilite
  console.log("\nReproductibilite");
  const sim2 = await ppe.simulerPlan(prisma, demande, ctxGest);
  verifier("deux calculs successifs avec les memes entrees donnent la meme empreinte de resultat et d'entrees (octet pour octet)", sim2.plan.empreinteResultat === sim.plan.empreinteResultat && sim2.plan.empreinteEntrees === sim.plan.empreinteEntrees && sim2.plan.id !== sim.plan.id);
  const textes = await lire<{ r1: string; r2: string }>(`SELECT a."resultatCanonique" AS r1, b."resultatCanonique" AS r2 FROM plans_pluriannuels a, plans_pluriannuels b WHERE a.id = $1 AND b.id = $2`, sim.plan.id, sim2.plan.id);
  verifier("les deux textes canoniques sont identiques, caractere pour caractere", textes[0].r1 === textes[0].r2);
  const rj = await ppe.rejouerPlan(prisma, sim.plan.id);
  verifier("le rejeu depuis les seules entrees stockees est identique, octet pour octet, et les entrees sont integres", rj.identique === true && rj.entreesIntegres === true && rj.empreinteRecalculee === sim.plan.empreinteResultat, rj);
  verifier("l'empreinte stockee est le SHA-256 du texte stocke, recalcule par la base", (await compter(`SELECT count(*)::int AS n FROM plans_pluriannuels WHERE id = $1 AND "empreinteResultat" = encode(sha256(convert_to("resultatCanonique",'UTF8')),'hex') AND "empreinteEntrees" = encode(sha256(convert_to("entreesCanoniques",'UTF8')),'hex')`, sim.plan.id)) === 1);

  // ---------- Tous les troncons ecartes faute de facteurs
  console.log("\nSeul l'etat est renseigne (cas du reseau reel) : le plan le dit");
  const sansFacteurs = await ppe.simulerPlan(prisma, { anneeDebut: 2027, intitule: "PPE region sans facteurs", enveloppes: [{ budgetGnf: 5n * MD }, { budgetGnf: 5n * MD }], regionId }, ctxGest);
  const sf = sansFacteurs.resultat;
  verifier("aucun troncon retenu, 2 non retenus, motif RISQUE_NON_CALCULABLE pour les 2", sf.synthese.retenus === 0 && sf.synthese.nonRetenus === 2 && sf.synthese.nonRetenusParMotif.RISQUE_NON_CALCULABLE === 2, sf.synthese);
  verifier("chaque ligne dit FACTEURS_INSUFFISANTS avec le nombre de facteurs disponibles et le minimum", sf.annees.every((a: any) => a.scenario.lignes.every((l: any) => l.risque.ok === false && l.risque.code === "FACTEURS_INSUFFISANTS" && /[12] facteur\(s\) disponible\(s\) sur 5 ponderes, minimum 3/.test(l.risque.motif))), sf.annees[0].scenario.lignes[0]);
  verifier("le plan reste ecrit, scelle et PROVISOIRE (un plan vide n'est pas un plan absent)", sansFacteurs.plan.nbRetenus === 0 && sansFacteurs.plan.nbNonRetenus === 2 && sansFacteurs.plan.provisoire === true);

  // ---------- Plafond de candidats, bornes
  console.log("\nBornes");
  verifier("un plan d'une seule annee est refuse (c'est un PAE)", codeRefus(await echec(() => ppe.simulerPlan(prisma, { anneeDebut: 2027, intitule: "PPE une annee", enveloppes: [{ budgetGnf: MD }] }, ctxGest))) === "ENTREES_INVALIDES");
  verifier("un plan de six annees est refuse", codeRefus(await echec(() => ppe.simulerPlan(prisma, { anneeDebut: 2027, intitule: "PPE six annees", enveloppes: Array.from({ length: 6 }, () => ({ budgetGnf: MD })) }, ctxGest))) === "ENTREES_INVALIDES");
  verifier("un plan refuse n'ecrit rien (aucune ligne de plus, aucun audit de plus)", (await compter(`SELECT count(*)::int AS n FROM plans_pluriannuels`)) === 3 && (await compter(`SELECT count(*)::int AS n FROM audit_logs WHERE "entityType" = 'PlanPluriannuel'`)) === 3);
  const plan5 = await ppe.simulerPlan(prisma, { anneeDebut: 2027, intitule: "PPE cinq annees", enveloppes: [MD, 0n, 2n * MD, MD, 5n * MD].map((b) => ({ budgetGnf: b })) }, ctxGest);
  verifier("cinq annees (borne haute) sont acceptees, une enveloppe de 0 retient zero ligne cette annee-la", plan5.resultat.annees.length === 5 && plan5.resultat.annees[1].scenario.totaux.retenues === 0, plan5.resultat.synthese.parAnnee);
  const a5 = ecarts(oracleChaine(oracle, [MD, 0n, 2n * MD, MD, 5n * MD]), plan5.resultat);
  verifier("le plan de cinq annees, avec une enveloppe nulle, est aussi celui de l'oracle", a5.length === 0, a5);

  // ---------- Immutabilite et coherence en base
  console.log("\nImmutabilite et coherence (declencheur, CHECK)");
  const idP = sim.plan.id;
  verifier("modifier le resultat d'un plan fige est REFUSE par la base (declencheur)", /plan est fige/.test((await echec(() => sql(`UPDATE plans_pluriannuels SET "resultatCanonique" = "resultatCanonique" || ' ' WHERE id = $1`, idP))) ?? ""));
  verifier("modifier l'intitule, le montant ou le compteur est REFUSE aussi", (await Promise.all([
    echec(() => sql(`UPDATE plans_pluriannuels SET intitule = 'autre' WHERE id = $1`, idP)),
    echec(() => sql(`UPDATE plans_pluriannuels SET "montantEngageGnf" = 0 WHERE id = $1`, idP)),
    echec(() => sql(`UPDATE plans_pluriannuels SET "nbRetenus" = 99 WHERE id = $1`, idP)),
  ])).every((m) => /plan est fige/.test(m ?? "")));
  verifier("un DELETE physique est REFUSE", /DELETE refuse/.test((await echec(() => sql(`DELETE FROM plans_pluriannuels WHERE id = $1`, idP))) ?? ""));
  const sup = await ppe.supprimerPlan(prisma, sim2.plan.id, ctxGest);
  verifier("la suppression LOGIQUE passe (deletedAt pose), la ligne reste, l'audit DELETE est ecrit", sup.ok === true && (await compter(`SELECT count(*)::int AS n FROM plans_pluriannuels WHERE id = $1 AND "deletedAt" IS NOT NULL`, sim2.plan.id)) === 1 && (await compter(`SELECT count(*)::int AS n FROM audit_logs WHERE "entityType" = 'PlanPluriannuel' AND action = 'DELETE' AND "entityId" = $1`, sim2.plan.id)) === 1);
  verifier("un plan supprime n'est plus lisible (INTROUVABLE) et ne se supprime pas deux fois", codeRefus(await echec(() => ppe.lirePlanComplet(prisma, sim2.plan.id))) === "INTROUVABLE" && codeRefus(await echec(() => ppe.supprimerPlan(prisma, sim2.plan.id, ctxGest))) === "INTROUVABLE");
  verifier("lever la suppression logique (deletedAt a NULL) est REFUSE", /plan est fige/.test((await echec(() => sql(`UPDATE plans_pluriannuels SET "deletedAt" = NULL WHERE id = $1`, sim2.plan.id))) ?? ""));

  const idParams = (await lire<{ id: string }>(`SELECT id FROM parametres_programmation WHERE version = $1`, VERSION_AMORCAGE))[0].id;
  const entreesOk = (n: number) => `{"anneeDebut":2027,"nbAnnees":${n},"enveloppes":[${Array.from({ length: n }, () => "{}").join(",")}],"parametres":{"version":"prog-provisoire-1"}}`;
  const resultatOk = (o: { env?: string; eng?: string; ret?: number; non?: number; prov?: boolean; n?: number } = {}) =>
    `{"anneeDebut":2027,"nbAnnees":${o.n ?? 2},"parametres":{"version":"prog-provisoire-1"},"provisoire":${o.prov ?? true},"synthese":{"enveloppeTotaleGnf":"${o.env ?? "100"}","engageTotalGnf":"${o.eng ?? "0"}","retenus":${o.ret ?? 0},"nonRetenus":${o.non ?? 0}}}`;
  const insererBrut = (o: { id: string; n?: number; env?: bigint; eng?: bigint; ent?: string; res?: string; empE?: string; empR?: string; ret?: number; nonRet?: number; prov?: boolean; version?: string }) => {
    const n = o.n ?? 2;
    const ent = o.ent ?? entreesOk(n);
    const res = o.res ?? resultatOk({ n });
    return sql(
      `INSERT INTO plans_pluriannuels (id, intitule, "anneeDebut", "nbAnnees", "parametresId", "parametresVersion", "enveloppeTotaleGnf", "entreesCanoniques", "empreinteEntrees", "resultatCanonique", "empreinteResultat", "nbRetenus", "nbNonRetenus", "montantEngageGnf", provisoire, "creeParId")
       VALUES ($1, 'brut', 2027, $2, $3, $4, $5, $6, COALESCE($7, encode(sha256(convert_to($6::text,'UTF8')),'hex')), $8, COALESCE($9, encode(sha256(convert_to($8::text,'UTF8')),'hex')), $10, $11, $12, $13, $14)`,
      o.id, n, idParams, o.version ?? VERSION_AMORCAGE, o.env ?? 100n, ent, o.empE ?? null, res, o.empR ?? null, o.ret ?? 0, o.nonRet ?? 0, o.eng ?? 0n, o.prov ?? true, U_GEST);
  };
  verifier("controle : une ligne coherente s'insere (les refus qui suivent tiennent a UNE incoherence)", (await echec(() => insererBrut({ id: "brut-ok" }))) === null);
  verifier("CHECK ppe_horizon_borne : un plan d'une annee est refuse par la base", /ppe_horizon_borne/.test((await echec(() => insererBrut({ id: "brut-1", n: 1 }))) ?? ""));
  verifier("CHECK ppe_horizon_borne : six annees refusees par la base", /ppe_horizon_borne/.test((await echec(() => insererBrut({ id: "brut-6", n: 6 }))) ?? ""));
  verifier("CHECK ppe_empreinte_resultat_exacte : une empreinte qui n'est pas celle du texte est refusee", /ppe_empreinte_resultat_exacte/.test((await echec(() => insererBrut({ id: "brut-e", empR: "a".repeat(64) }))) ?? ""));
  verifier("CHECK ppe_empreinte_entrees_exacte : idem pour les entrees", /ppe_empreinte_entrees_exacte/.test((await echec(() => insererBrut({ id: "brut-ee", empE: "b".repeat(64) }))) ?? ""));
  verifier("CHECK ppe_engage_borne : un montant engage superieur a l'enveloppe est refuse", /ppe_engage_borne/.test((await echec(() => insererBrut({ id: "brut-g", eng: 101n, res: resultatOk({ eng: "101" }) }))) ?? ""));
  verifier("CHECK ppe_coherence_resultat : un compteur qui contredit le texte est refuse", /ppe_coherence_resultat/.test((await echec(() => insererBrut({ id: "brut-c", ret: 4 }))) ?? ""));
  verifier("CHECK ppe_coherence_resultat : une etiquette provisoire qui contredit le texte est refusee", /ppe_coherence_resultat/.test((await echec(() => insererBrut({ id: "brut-p", prov: false }))) ?? ""));
  verifier("CHECK ppe_coherence_entrees : une version de parametres qui contredit le texte est refusee", /ppe_coherence_entrees/.test((await echec(() => insererBrut({ id: "brut-v", version: "autre-version" }))) ?? ""));
  verifier("CHECK ppe_coherence_entrees : un nombre d'enveloppes different du nombre d'annees est refuse", /ppe_coherence_entrees/.test((await echec(() => insererBrut({ id: "brut-n", n: 3, ent: entreesOk(2) }))) ?? ""));
  verifier("une cle manquante dans le texte est refusee (un CHECK qui vaut NULL ne passe pas)", /ppe_coherence_resultat/.test((await echec(() => insererBrut({ id: "brut-m", res: '{"anneeDebut":2027}' }))) ?? ""));

  // ---------- D-02 praticabilite
  console.log("\nPraticabilite (D-02)");
  const st0 = await ppe.statutPraticabilite(prisma);
  verifier("4 niveaux declares, aucun approuve : « non branchée : aucune valeur approuvée (D-02) »", st0.branchee === false && st0.valeursDeclarees === 4 && st0.valeursApprouvees === 0 && st0.libelle === "non branchée : aucune valeur approuvée (D-02)", st0);
  const premierRetenu = res.annees[0].scenario.lignes.find((l) => l.decision === "RETENUE")!.troncon;
  await sql(`INSERT INTO portions (id, "tronconId", "debutM", "finM", praticabilite, "statutValidation", origine, "creeParId", "updatedAt") VALUES ('pt-p4', $1, 0, 100, 'P4', 'VALIDE'::"StatutValidation", 'SAISIE_TERRAIN', $2, now())`, premierRetenu.id, U_ADMIN);
  const al0 = await ppe.alertesPraticabilite(prisma, [premierRetenu.id]);
  verifier("une portion validee portant P4 NON approuve ne produit aucune alerte : la valeur n'est pas lue", al0.statut.branchee === false && al0.alertes.length === 0, al0);
  await sql(`UPDATE referentiel_praticabilites SET "approuveeLe" = now(), "approuveeParId" = $1 WHERE code IN ('P1', 'P4')`, U_ADMIN);
  const st1 = await ppe.statutPraticabilite(prisma);
  verifier("deux niveaux approuves (P1, P4) : branchee en lecture, effet « signal seulement »", st1.branchee === true && st1.valeursApprouvees === 2 && /Signal seulement/.test(st1.effet), st1);
  const al1 = await ppe.alertesPraticabilite(prisma, ppe.tronconsRetenusDe(res));
  verifier("P4 approuve et non franchissable : une alerte sur le troncon retenu concerne, avec sa portion", al1.alertes.length === 1 && al1.alertes[0].tronconId === premierRetenu.id && al1.alertes[0].niveau === "P4" && al1.alertes[0].finM === 100, al1);
  await sql(`INSERT INTO portions (id, "tronconId", "debutM", "finM", praticabilite, "statutValidation", origine, "creeParId", "updatedAt") VALUES ('pt-p4-prop', $1, 100, 200, 'P4', 'A_VALIDER'::"StatutValidation", 'SAISIE_TERRAIN', $2, now())`, premierRetenu.id, U_ADMIN);
  await sql(`INSERT INTO portions (id, "tronconId", "debutM", "finM", praticabilite, "statutValidation", origine, "remplaceeLe", "creeParId", "updatedAt") VALUES ('pt-p4-old', $1, 200, 300, 'P4', 'VALIDE'::"StatutValidation", 'SAISIE_TERRAIN', now(), $2, now())`, premierRetenu.id, U_ADMIN);
  const al2 = await ppe.alertesPraticabilite(prisma, ppe.tronconsRetenusDe(res));
  verifier("une proposition (A_VALIDER) ou une portion remplacee ne produit pas d'alerte : seule la portion courante validee compte", al2.alertes.length === 1, al2);
  const avantBrancher = res.annees.map((a) => a.scenario.lignes.map((l) => `${l.troncon.code}:${l.decision}`).join());
  const sim3 = await ppe.simulerPlan(prisma, demande, ctxGest);
  verifier("branchee, la praticabilite ne change NI un rang NI une exclusion : le plan recalcule a les memes retenus et la meme empreinte de resultat", sim3.plan.empreinteResultat === sim.plan.empreinteResultat && JSON.stringify(sim3.resultat.annees.map((a: any) => a.scenario.lignes.map((l: any) => `${l.troncon.code}:${l.decision}`).join())) === JSON.stringify(avantBrancher));

  // ---------- Interventions figees dans la Fiche 360
  console.log("\nFiche 360 : interventions figees");
  const annuel = await moteur.simuler(prisma, { annee: 2027, intitule: "PAE 2027 essai", budgetGnf: 4n * MD }, ctxGest);
  const retenuesAnnuel = annuel.resultat.lignes.filter((l: any) => l.decision === "RETENUE");
  const t0 = retenuesAnnuel[0].troncon;
  const v0 = await voletProgrammation(prisma, t0.id);
  verifier("avant tout gel : le volet est disponible, total zero, liste vide (aucune fiche inventee)", v0.interventionsFigees.disponible === true && v0.interventionsFigees.total === 0 && v0.interventionsFigees.fiches.length === 0, v0.interventionsFigees);
  const gel = await moteur.figerFiches(prisma, annuel.scenario.id, { sourceFinancement: null }, ctxGest);
  verifier("le gel cree une fiche par ligne retenue", gel.fiches.length === retenuesAnnuel.length && gel.fiches.length > 0, gel);
  const liste = await (await imp("programmation/moteur.depot")).listerFiches(prisma, { annee: 2027, limite: 50, decalage: 0 });
  verifier("la liste des fiches figees (ecran) porte le CODE du troncon, joint pour la lecture, et le statut courant", liste.total === gel.fiches.length
    && liste.lignes.every((l: any) => typeof l.tronconCode === "string" && l.tronconCode.startsWith("PPE-") && l.statut === "BROUILLON")
    && liste.lignes.some((l: any) => l.tronconId === t0.id && l.tronconCode === t0.code), liste.lignes.map((l: any) => [l.tronconCode, l.statut]));
  const v1 = await voletProgrammation(prisma, t0.id);
  const f1 = v1.interventionsFigees.fiches[0];
  verifier("le volet liste la fiche figee du troncon : reference, empreinte SHA-256, statut BROUILLON, etiquette PROVISOIRE, montant en chaine", v1.interventionsFigees.disponible === true && v1.interventionsFigees.total === 1
    && f1.reference === gel.fiches.find((x: any) => x.tronconId === t0.id).reference && f1.empreinteSha256 === gel.fiches.find((x: any) => x.tronconId === t0.id).empreinteSha256
    && f1.statut === "BROUILLON" && f1.etiquette === "PROVISOIRE, non approuvé" && f1.provisoire === true && typeof f1.montantGnf === "string" && f1.montantGnf === retenuesAnnuel[0].cout.montantGnf, f1);
  verifier("le traitement affiche est celui de la ligne retenue", f1.traitement === retenuesAnnuel[0].traitement.traitement.code, { volet: f1.traitement, ligne: retenuesAnnuel[0].traitement.traitement.code });
  const fiche360Verif = await lire<{ n: number }>(`SELECT count(*)::int AS n FROM fiches_intervention f WHERE f.id = $1 AND f."empreinteSha256" = encode(sha256(convert_to(f."contenuCanonique",'UTF8')),'hex')`, f1.id);
  verifier("l'empreinte affichee est le SHA-256 du texte stocke, recalcule par la base", fiche360Verif[0].n === 1);
  await moteur.changerStatutFiche(prisma, f1.id, "PROPOSE", "relue en essai", ctxGest);
  const v2 = await voletProgrammation(prisma, t0.id);
  const f2 = v2.interventionsFigees.fiches[0];
  verifier("apres PROPOSE : statut courant PROPOSE, historique en ajout seul BROUILLON puis PROPOSE (origine GEOPORTAIL, motif conserve)", f2.statut === "PROPOSE" && f2.rangStatut === 2
    && f2.historique.map((h: any) => `${h.rang}:${h.vers}:${h.origine}`).join() === "1:BROUILLON:GEOPORTAIL,2:PROPOSE:GEOPORTAIL" && f2.historique[1].motif === "relue en essai", f2);
  await moteur.changerStatutFiche(prisma, f1.id, "ARBITRE", "arbitree en essai", ctxGest);
  await moteur.changerStatutFiche(prisma, f1.id, "APPROUVE", "approuvee en essai", ctxGest);
  verifier("TRANSMIS ne se saisit pas depuis le Geoportail (origine DigitalRoad exigee) : refus ORIGINE_INTERDITE, l'historique du volet ne bouge pas",
    codeRefus(await echec(() => moteur.changerStatutFiche(prisma, f1.id, "TRANSMIS", "tentative", ctxGest))) === "ORIGINE_INTERDITE"
    && (await voletProgrammation(prisma, t0.id)).interventionsFigees.fiches[0].historique.length === 4
    && (await voletProgrammation(prisma, t0.id)).interventionsFigees.fiches[0].statut === "APPROUVE");
  const sansFiche = res.annees[0].scenario.lignes.find((l) => l.troncon.code === "PPE-D")!.troncon;
  verifier("un troncon sans fiche figee n'en montre aucune", (await voletProgrammation(prisma, sansFiche.id)).interventionsFigees.fiches.length === 0);

  // ---------- Non regression
  console.log("\nNon regression");
  verifier("aucun chantier, marche, ordre de travaux ni decompte n'a ete cree par un plan", (await compter(`SELECT (SELECT count(*) FROM chantiers) + (SELECT count(*) FROM marches) + (SELECT count(*) FROM ordres_travaux) + (SELECT count(*) FROM decomptes) AS n`)) === 0);
  verifier("un plan ne cree aucune fiche d'intervention (seules celles du gel annuel existent)", (await compter(`SELECT count(*)::int AS n FROM fiches_intervention`)) === gel.fiches.length);
  verifier("la base `replay`, modele du clone, n'a recu ni fixture ni table de plans", await replayIntacte());

  conclure();
}

async function replayIntacte(): Promise<boolean> {
  const c = new pg.Client({ connectionString: ORIGINE });
  await c.connect();
  try {
    const r = await c.query(`SELECT (SELECT count(*) FROM users)::int AS u, (SELECT count(*) FROM troncons)::int AS t, (SELECT count(*) FROM regions)::int AS r,
                                    (SELECT count(*) FROM information_schema.tables WHERE table_name = 'plans_pluriannuels')::int AS p,
                                    (SELECT count(*) FROM referentiel_praticabilites WHERE "approuveeLe" IS NOT NULL)::int AS a`);
    return r.rows[0].u === 0 && r.rows[0].t === 0 && r.rows[0].r === 0 && r.rows[0].p === 0 && r.rows[0].a === 0;
  } finally { await c.end(); }
}

main().catch((e) => { console.error(e); process.exitCode = 2; }).finally(async () => { await prisma.$disconnect(); await supprimerClone(ORIGINE!, NOM_CLONE); });

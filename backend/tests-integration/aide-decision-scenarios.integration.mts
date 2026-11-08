// Banc d'integration du SIMULATEUR BUDGETAIRE (AD-LOT-4) : voir tests-integration/README.md.
// Lancer (DATABASE_URL pointe sur `replay`) : npx tsx tests-integration/aide-decision-scenarios.integration.mts
//
// Les services committent et les declencheurs font echouer des requetes : le banc travaille dans un CLONE jetable de
// `replay`, cree puis detruit par lui-meme (essai_ad_l4_scenarios). La base `replay` n'est jamais ecrite.
// `replay` ne contient pas toujours la migration 20261023100000 : le banc l'applique au clone (elle est idempotente).
//
// CE QUE LE BANC PROUVE QUE LES TESTS EN MEMOIRE NE PROUVENT PAS
//   - le scenario du simulateur est ACCEPTE par les CHECK de la base (empreintes recalculees par PostgreSQL, budget, annee,
//     version des parametres, totaux) et se rejoue octet pour octet ; un scenario HERITE se rejoue toujours identique ;
//   - AUCUNE ECRITURE dans programmes_budgetaires, chantiers, marches, decomptes, baremes_intervention (et les autres tables
//     du patrimoine) : un declencheur « fil de declenchement » leve une exception a la moindre ecriture pendant que le banc
//     simule, enregistre, compare, exporte, rejoue et supprime ; une contre-epreuve prouve qu'il fonctionne ;
//   - l'oracle : risque, risque attendu, cout et classement sont recalcules par une REQUETE SQL qui ne partage aucun code avec
//     le moteur TypeScript ; le bilan (consomme, besoin, deficit) et les contraintes sont refaits ici en BigInt depuis ces seuls nombres ;
//   - un bareme perime est ecarte COUT_PERIME, une version plus recente valide est preferee, la version des baremes suit la base.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { evaluerCible } from "./lib/garde.ts";
import { creerClone, supprimerClone, urlClone } from "./lib/clone.ts";
import { verifier, conclure } from "./lib/verdict.ts";

const ORIGINE = process.env.DATABASE_URL;
const cible = evaluerCible(ORIGINE);
if (!cible.ok || cible.base !== "replay") {
  console.error("Banc d'integration refuse : DATABASE_URL doit etre une base locale nommee replay (le clone est cree par le banc).");
  process.exit(3);
}
const NOM_CLONE = "essai_ad_l4_scenarios";
await creerClone(ORIGINE!, NOM_CLONE);
const URL_CLONE = urlClone(ORIGINE!, NOM_CLONE);
process.env.DATABASE_URL = URL_CLONE;
console.log("Cible du banc : clone jetable " + NOM_CLONE);

const ICI = dirname(fileURLToPath(import.meta.url));
const R = new URL("../src/", pathToFileURL(process.argv[1]).href).href;
const imp = (p: string) => import(R + p + ".ts");
const { prisma } = await imp("lib/prisma");
const moteur = await imp("programmation/moteur.service");
const sim = await imp("programmation/comparaison.service");
const dep = await imp("programmation/comparaison.depot");
const territoire = await imp("territoire/territoire.lecture");
const { VERSION_AMORCAGE } = await imp("programmation/parametres.noyau");

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
const compter = async (q: string, ...a: unknown[]) => Number((await lire<{ n: number }>(q, ...a))[0].n);
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

async function echec(f: () => Promise<unknown>): Promise<string | null> {
  try { await f(); return null; } catch (e) { return e instanceof moteur.RefusMoteur ? `${e.code}|${e.message}` : String((e as Error).message ?? e); }
}
const codeRefus = (m: string | null) => (m ? m.split("|")[0] : null);

const U_ADMIN = "00000000-0000-4000-8000-0000000000a1";
const U_GEST = "00000000-0000-4000-8000-0000000000a2";
const ctxAdmin = { userId: U_ADMIN, email: "admin@essai.invalid", role: "ADMIN" };
const ctxGest = { userId: U_GEST, email: "gest@essai.invalid", role: "GESTIONNAIRE" };

async function troncon(code: string, o: { etat: string; rev?: string; jma?: number | null; longueurKm: number; region?: string; lat?: number; src?: string | null; statut?: string | null; supprime?: boolean }) {
  const lat = o.lat ?? 9.6;
  const wkt = `LINESTRING(-13.6 ${lat}, -13.58 ${lat})`;
  await sql(
    `INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, etat, "pkDebut", "pkFin", "traficMoyenJma", "sourceReference", "statutValidation", "deletedAt", geom, "updatedAt")
     VALUES ($1, $2, $3, 'RN', (SELECT id FROM regions WHERE nom = $4), $5, $6::"Revetement", $7::"EtatPatrimoine", 0, $5, $8, $9, $10::"StatutValidation", $11, ST_GeomFromText($12, 4326), now())`,
    `t-${code}`, code, `Troncon ${code}`, o.region ?? "Region L4A", o.longueurKm, o.rev ?? "BITUME", o.etat, o.jma ?? null, o.src ?? null, o.statut ?? null, o.supprime ? new Date() : null, wkt);
}
async function pointNoir(tronconCode: string, n: number) {
  for (let i = 0; i < n; i++) {
    await sql(
      `INSERT INTO points_noirs (id, description, "regionId", "tronconId", gravite, "deletedAt", "updatedAt")
       VALUES (gen_random_uuid()::text, 'pn essai', (SELECT "regionId" FROM troncons WHERE code = $1), (SELECT id FROM troncons WHERE code = $1), 'FORTE'::"Gravite", NULL, now())`, tronconCode);
  }
}


/**
 * REGISTRE EXPLOITE (revue, item 5) : depuis que le simulateur applique la regle des points noirs de la liste priorisee (`resoudreSecurite`), un troncon
 * sans point noir n'a « zero point noir » QUE si le registre de sa region compte au moins 5 points confirmes ; sinon le facteur securite est ABSENT
 * (jamais 0). L'oracle SQL ci-dessous compte les points noirs rattaches au troncon : pour qu'un zero soit bien une donnee, chaque region du jeu recoit
 * donc 5 points « de registre » (rattaches a la region, a aucun troncon). Le comportement des regions au registre trop petit est eprouve par le banc
 * `aide-decision-priorites` (equivalence liste / simulateur).
 */
async function registreDeRegion(nomRegion: string, n: number) {
  for (let i = 0; i < n; i++) {
    await sql(
      `INSERT INTO points_noirs (id, description, "regionId", "tronconId", gravite, "deletedAt", "updatedAt")
       VALUES (gen_random_uuid()::text, 'pn essai', (SELECT id FROM regions WHERE nom = $1), NULL, 'FORTE'::"Gravite", NULL, now())`, nomRegion);
  }
}

/** Oracle SQL : risque, risque attendu et cout, sans aucun code du moteur. Parametres lus dans la table. Horizon 1 an. */
async function oracleSql(version: string) {
  return lire<{ code: string; region: number; risque: string; attendu: string; cout: string; len_m: string }>(`
    WITH p AS (SELECT valeurs AS v FROM parametres_programmation WHERE version = $1),
    t AS (
      SELECT tr.id, tr.code, tr."regionId" AS region, tr.etat::text AS etat, tr."traficMoyenJma" AS jma,
             round(CASE WHEN tr."longueurKm" > 0 THEN tr."longueurKm" * 1000 ELSE ST_Length(tr.geom::geography) END)::bigint AS len_m,
             (SELECT count(*) FROM points_noirs x WHERE x."tronconId" = tr.id AND x."deletedAt" IS NULL)::numeric AS npn,
             CASE tr.revetement::text WHEN 'BITUME' THEN 'bitume' WHEN 'TERRE' THEN 'terre_laterite' WHEN 'LATERITE' THEN 'terre_laterite' WHEN 'PAVE' THEN 'pave' END AS fam
        FROM troncons tr
       WHERE tr.code LIKE 'L4-%' AND tr."deletedAt" IS NULL AND (tr."statutValidation" IS NULL OR tr."statutValidation" = 'VALIDE')
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
    SELECT m.code, m.region, m.risque::text AS risque,
           round(CASE WHEN m.suivant IS NULL THEN m.risque ELSE m.risque + m.ph::numeric * (m.risque_suivant - m.risque) END, 4)::text AS attendu,
           (b."coutKmGnf" * m.len_m / 1000)::text AS cout, m.len_m::text AS len_m
      FROM m
      JOIN conditions_traitement c ON c."familleRevetement" = m.fam AND c."etatDepart" = m.etat AND c."classeTrafic" IS NULL AND c.actif
      JOIN baremes_intervention b ON b."familleRevetement" = m.fam AND b."etatDepart" = m.etat AND b."typeIntervention" = c."traitementCode" AND b.actif
     WHERE m.fam IS NOT NULL
     ORDER BY m.code`, version);
}

type Ligne = { code: string; region: number; risque: string; attendu: string; cout: string };
function trier(lignes: Ligne[]) {
  const micro = (s: string) => BigInt(Math.round(Number(s) * 10000));
  const e = lignes.map((l) => ({ code: l.code, region: l.region, r: micro(l.risque), a: micro(l.attendu), c: BigInt(l.cout) }));
  e.sort((x, y) => {
    const g = x.a * y.c, d = y.a * x.c;
    if (g !== d) return g > d ? -1 : 1;
    if (x.r !== y.r) return x.r > y.r ? -1 : 1;
    if (x.c !== y.c) return x.c < y.c ? -1 : 1;
    return x.code < y.code ? -1 : x.code > y.code ? 1 : 0;
  });
  return e;
}
/** Glouton du ratio refait en BigInt depuis l'oracle. */
function gloutonOracle(lignes: Ligne[], budget: bigint) {
  const e = trier(lignes);
  let reste = budget;
  const retenues: string[] = [];
  for (const l of e) if (l.c <= reste) { reste -= l.c; retenues.push(l.code); }
  return { ordre: e.map((l) => l.code), retenues, reste, engage: budget - reste };
}

// ---------- fil de declenchement : aucune ecriture dans les tables du patrimoine pendant le simulateur
const TABLES_INTERDITES = ["programmes_budgetaires", "chantiers", "marches", "decomptes", "baremes_intervention", "catalogue_traitements", "conditions_traitement", "matrices_degradation", "troncons", "points_noirs", "parametres_programmation", "regions"];
async function armer() {
  await sqlMulti(`CREATE OR REPLACE FUNCTION ad_l4_fil() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'ad_l4_fil : ecriture interdite dans % (%)', TG_TABLE_NAME, TG_OP; END $f$;`);
  for (const t of TABLES_INTERDITES) {
    await sqlMulti(`DROP TRIGGER IF EXISTS ad_l4_fil ON "${t}"; CREATE TRIGGER ad_l4_fil BEFORE INSERT OR UPDATE OR DELETE ON "${t}" FOR EACH STATEMENT EXECUTE FUNCTION ad_l4_fil();
                    DROP TRIGGER IF EXISTS ad_l4_fil_tr ON "${t}"; CREATE TRIGGER ad_l4_fil_tr BEFORE TRUNCATE ON "${t}" FOR EACH STATEMENT EXECUTE FUNCTION ad_l4_fil();`);
  }
}
async function desarmer() {
  for (const t of TABLES_INTERDITES) await sqlMulti(`DROP TRIGGER IF EXISTS ad_l4_fil ON "${t}"; DROP TRIGGER IF EXISTS ad_l4_fil_tr ON "${t}";`);
}
/** Empreinte d'une table (lignes serialisees, ordre fixe) : prouve qu'elle n'a pas change. */
async function empreinteTable(t: string) {
  const r = await lire<{ n: number; h: string }>(`SELECT count(*)::int AS n, md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY to_jsonb(x)::text), '')) AS h FROM "${t}" x`);
  return `${r[0].n}:${r[0].h}`;
}

const parCode = <T extends { troncon: { code: string } }>(ls: T[], code: string) => ls.find((l) => l.troncon.code === code);
const codes = (ls: { troncon: { code: string } }[]) => ls.map((l) => l.troncon.code);

async function main() {
  // ---------- Schema et fixtures
  console.log("\nSchema et fixtures");
  const texteMigration = readFileSync(MIGRATION, "utf8");
  await sqlMulti(texteMigration);
  const manquantes = await lire<{ t: string }>(`SELECT t FROM unnest($1::text[]) t WHERE to_regclass('public.' || t) IS NULL`, TABLES_INTERDITES);
  verifier("les tables du patrimoine surveillees existent toutes dans le clone", manquantes.length === 0, manquantes);

  await sql(`INSERT INTO regions (nom) VALUES ('Region L4A'), ('Region L4B')`);
  for (const [id, email, role] of [[U_ADMIN, "admin-l4@essai.invalid", "ADMIN"], [U_GEST, "gest-l4@essai.invalid", "GESTIONNAIRE"]] as const) {
    await sql(`INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt") VALUES ($1, $2, 'Essai L4', 'x', $3::"Role", now())`, id, email, role);
  }
  const regA = Number((await lire<{ id: number }>(`SELECT id FROM regions WHERE nom = 'Region L4A'`))[0].id);
  const regB = Number((await lire<{ id: number }>(`SELECT id FROM regions WHERE nom = 'Region L4B'`))[0].id);
  await troncon("L4-A", { etat: "MAUVAIS", jma: 2500, longueurKm: 4 });
  await troncon("L4-B", { etat: "CRITIQUE", jma: 600, longueurKm: 1, region: "Region L4B", lat: 9.62 });
  await troncon("L4-C", { etat: "MOYEN", jma: 100, longueurKm: 10, rev: "TERRE", lat: 9.64 });
  await troncon("L4-D", { etat: "NON_EVALUE", jma: 2000, longueurKm: 3, lat: 9.66 });
  await troncon("L4-E", { etat: "MAUVAIS", jma: 1200, longueurKm: 2, region: "Region L4B", lat: 9.68 });
  await troncon("L4-X1", { etat: "MAUVAIS", jma: 2500, longueurKm: 4, lat: 9.76, supprime: true });
  await troncon("L4-X2", { etat: "MAUVAIS", jma: 2500, longueurKm: 4, lat: 9.78, src: "voirie_locale:essai" });
  await troncon("L4-X3", { etat: "MAUVAIS", jma: 2500, longueurKm: 4, lat: 9.80, statut: "REJETE" });
  for (const [code, n] of [["L4-A", 2], ["L4-C", 1], ["L4-D", 1], ["L4-E", 1]] as const) await pointNoir(code, n);
  for (const nom of ["Region L4A", "Region L4B"]) await registreDeRegion(nom, 5);

  const idAmorcage = (await lire<{ id: string }>(`SELECT id FROM parametres_programmation WHERE version = $1`, VERSION_AMORCAGE))[0].id;
  const periode = { debut: "2027-01-01", fin: "2027-12-31" };
  const base = { annee: 2027, periode, parametresId: idAmorcage, logique: "ratio_cout_impact" as const };
  const oracle = (await oracleSql(VERSION_AMORCAGE)) as Ligne[];
  verifier("l'oracle SQL chiffre les 4 tronçons evaluables (A, B, C, E) ; D (etat NON_EVALUE) n'a pas de risque", oracle.map((o) => o.code).join() === "L4-A,L4-B,L4-C,L4-E", oracle.map((o) => o.code));
  const couts = Object.fromEntries(oracle.map((o) => [o.code, BigInt(o.cout)])) as Record<string, bigint>;
  const besoin = Object.values(couts).reduce((a, b) => a + b, 0n);
  const idDe = (code: string) => `t-${code}`;

  await armer();
  const avantTables = Object.fromEntries(await Promise.all(TABLES_INTERDITES.map(async (t) => [t, await empreinteTable(t)])));
  verifier("contre-epreuve du fil de declenchement : une ecriture dans chantiers est refusee par la base", /ad_l4_fil/.test((await echec(() => sql(`INSERT INTO chantiers (id) VALUES ('x')`))) ?? ""));
  verifier("contre-epreuve : une modification de baremes_intervention est refusee par la base", /ad_l4_fil/.test((await echec(() => sql(`UPDATE baremes_intervention SET commentaire = 'x'`))) ?? ""));
  verifier("contre-epreuve : un TRUNCATE est refuse aussi", /ad_l4_fil/.test((await echec(() => sql(`TRUNCATE marches CASCADE`))) ?? ""));

  // ---------- Simuler sans enregistrer : oracle SQL
  console.log("\nSimulation sans enregistrement (oracle SQL)");
  const BUDGET = 7_000_000_000n;
  const nbScenarios0 = await compter(`SELECT count(*)::int AS n FROM scenarios_programmation`);
  const nbAudit0 = await compter(`SELECT count(*)::int AS n FROM audit_logs`);
  const s1 = await sim.simulerSansEnregistrer(prisma, { ...base, budgetGnf: BUDGET });
  const res = s1.resultat;
  verifier("5 candidats exactement (le supprime, la voirie locale et le rejete sont hors perimetre)", res.totaux.candidats === 5 && !codes(res.lignes).some((c: string) => /^L4-X/.test(c)), res.totaux);
  verifier("rien n'est ecrit : ni scenario, ni audit (simuler est une lecture)", (await compter(`SELECT count(*)::int AS n FROM scenarios_programmation`)) === nbScenarios0 && (await compter(`SELECT count(*)::int AS n FROM audit_logs`)) === nbAudit0 && s1.enregistre === false);
  for (const o of oracle) {
    const l = parCode(res.lignes, o.code) as { risque: { score: number }; risqueAttendu: { score: number }; cout: { montantGnf: string } };
    verifier(`${o.code} : risque, risque attendu et cout du moteur = oracle SQL`,
      Math.abs(l.risque.score - Number(o.risque)) <= 0.0001 && Math.abs(l.risqueAttendu.score - Number(o.attendu)) <= 0.0001 && l.cout.montantGnf === o.cout, { moteur: l, oracle: o });
  }
  const g = gloutonOracle(oracle, BUDGET);
  verifier(`ordre d'arbitrage (ratio) = oracle : ${g.ordre.join(" > ")}`, JSON.stringify(res.lignes.filter((l: { simulation: { ordreArbitrage: number | null } }) => l.simulation.ordreArbitrage !== null).map((l: { troncon: { code: string } }) => l.troncon.code)) === JSON.stringify(g.ordre));
  verifier(`lignes retenues = glouton oracle : ${g.retenues.join(", ")}`, JSON.stringify(res.lignes.filter((l: { decision: string }) => l.decision === "RETENUE").map((l: { troncon: { code: string } }) => l.troncon.code).sort()) === JSON.stringify([...g.retenues].sort()));
  const bilan = res.simulation.bilan;
  verifier("consomme = somme des couts oracle des retenues ; reste = enveloppe - consomme", bilan.consommeGnf === g.engage.toString() && bilan.resteGnf === g.reste.toString(), bilan);
  verifier("besoin = somme des couts oracle des 4 chiffrables ; deficit = besoin - enveloppe (positif)", bilan.besoinTotalGnf === besoin.toString() && bilan.deficitGnf === (besoin > BUDGET ? besoin - BUDGET : 0n).toString() && besoin > BUDGET, { bilan, besoin: besoin.toString() });
  verifier("L4-D est ecarte RISQUE_NON_CALCULABLE : son cout n'est pas valorise, le deficit est dit minorant", parCode(res.lignes, "L4-D")?.motifExclusion?.code === "RISQUE_NON_CALCULABLE" && bilan.deficitMinorant === true && bilan.nbCoutsNonFiables === 1, bilan);
  verifier("la priorite technique (risque courant) et l'ordre d'arbitrage sont deux champs distincts sur chaque ligne chiffree",
    res.lignes.filter((l: { rangPriorite: number | null }) => l.rangPriorite !== null).every((l: { simulation: { prioriteTechnique: { rang: number | null; source: string }; ordreArbitrage: number } }) => l.simulation.prioriteTechnique.rang !== null && l.simulation.prioriteTechnique.source === "moteur_v2_risque_courant" && l.simulation.ordreArbitrage >= 1));
  verifier("le resultat porte la mention, la periode, la devise et la version des baremes lue en base", /SIMULATION NON ENGAGEANTE/.test(res.simulation.mention) && res.simulation.periode.debut === "2027-01-01" && res.simulation.devise === "GNF" && res.simulation.baremes.empreinte.length === 64);

  // ---------- Exactitude de l'enveloppe
  console.log("\nEnveloppe exacte, un franc de moins, enveloppe nulle");
  const exact = (await sim.simulerSansEnregistrer(prisma, { ...base, budgetGnf: besoin })).resultat;
  verifier("enveloppe = besoin : les 4 chiffrables sont retenues, reste 0, deficit 0, solde 0", exact.totaux.retenues === 4 && exact.totaux.resteGnf === "0" && exact.simulation.bilan.deficitGnf === "0" && exact.simulation.bilan.soldeGnf === "0", exact.simulation.bilan);
  const moins = (await sim.simulerSansEnregistrer(prisma, { ...base, budgetGnf: besoin - 1n })).resultat;
  const gMoins = gloutonOracle(oracle, besoin - 1n);
  verifier("un franc de moins : deficit de 1 GNF, solde -1, retenues = glouton oracle, jamais au-dela de l'enveloppe",
    moins.simulation.bilan.deficitGnf === "1" && moins.simulation.bilan.soldeGnf === "-1" && JSON.stringify(moins.lignes.filter((l: { decision: string }) => l.decision === "RETENUE").map((l: { troncon: { code: string } }) => l.troncon.code).sort()) === JSON.stringify([...gMoins.retenues].sort()) && BigInt(moins.totaux.engageGnf) <= besoin - 1n, moins.simulation.bilan);
  const zero = (await sim.simulerSansEnregistrer(prisma, { ...base, budgetGnf: 0n })).resultat;
  verifier("enveloppe nulle : rien n'est retenu, deficit = besoin, avertissement ENVELOPPE_NULLE", zero.totaux.retenues === 0 && zero.simulation.bilan.deficitGnf === besoin.toString() && zero.simulation.avertissements.some((a: { code: string }) => a.code === "ENVELOPPE_NULLE"));

  // ---------- Contraintes sur la base
  console.log("\nContraintes : obligatoires, groupes non divisibles, plafonds, equilibre");
  const plusCher = Object.entries(couts).sort((a, b) => (a[1] === b[1] ? 0 : a[1] > b[1] ? -1 : 1))[0];
  const ob = (await sim.simulerSansEnregistrer(prisma, { ...base, budgetGnf: plusCher[1] - 1n, obligatoires: [idDe(plusCher[0])] })).resultat;
  verifier(`obligatoire hors enveloppe (${plusCher[0]}, enveloppe = cout - 1) : non retenue, OBLIGATOIRE_NON_FINANCEE, cout non ajuste, enveloppe respectee`,
    parCode(ob.lignes, plusCher[0])?.decision === "ECARTEE" && ob.simulation.contraintes.insatisfaisables.some((c: { code: string }) => c.code === "OBLIGATOIRE_NON_FINANCEE") && (parCode(ob.lignes, plusCher[0]) as { cout: { montantGnf: string } }).cout.montantGnf === plusCher[1].toString() && BigInt(ob.totaux.engageGnf) <= plusCher[1] - 1n, ob.simulation.contraintes);
  const obOk = (await sim.simulerSansEnregistrer(prisma, { ...base, budgetGnf: plusCher[1], obligatoires: [idDe(plusCher[0])] })).resultat;
  verifier("obligatoire dont le cout egale l'enveloppe : retenue en premier (phase OBLIGATOIRE), plus rien ne tient", parCode(obOk.lignes, plusCher[0])?.simulation.phase === "OBLIGATOIRE" && obOk.totaux.retenues === 1 && obOk.totaux.resteGnf === "0");
  const nd = (await sim.simulerSansEnregistrer(prisma, { ...base, budgetGnf: couts["L4-C"] + couts["L4-E"] - 1n, groupesNonDivisibles: [[idDe("L4-C"), idDe("L4-E")]] })).resultat;
  verifier("groupe non divisible [C, E] pour 1 franc de moins que leur somme : ecartes ENSEMBLE (aucun financement partiel)", ["L4-C", "L4-E"].every((c) => parCode(nd.lignes, c)?.decision === "ECARTEE") && nd.simulation.contraintes.groupesNonDivisibles[0].retenu === false, nd.simulation.contraintes.groupesNonDivisibles);
  const ndOk = (await sim.simulerSansEnregistrer(prisma, { ...base, budgetGnf: couts["L4-C"] + couts["L4-E"], groupesNonDivisibles: [[idDe("L4-C"), idDe("L4-E")]] })).resultat;
  verifier("le meme groupe pour exactement leur somme : retenu entier, cout du groupe = somme", ["L4-C", "L4-E"].every((c) => parCode(ndOk.lignes, c)?.decision === "RETENUE") && ndOk.simulation.contraintes.groupesNonDivisibles[0].coutGnf === (couts["L4-C"] + couts["L4-E"]).toString());
  const plaf = (await sim.simulerSansEnregistrer(prisma, { ...base, budgetGnf: besoin, plafondsRegionauxGnf: { [String(regA)]: couts["L4-C"] } })).resultat;
  verifier("plafond de la region A = cout de C : A (plus cher, region A) est ecartee PLAFOND_REGIONAL, les troncons de la region B ne sont pas touches",
    parCode(plaf.lignes, "L4-A")?.motifExclusion?.code === "PLAFOND_REGIONAL" && parCode(plaf.lignes, "L4-C")?.decision === "RETENUE" && parCode(plaf.lignes, "L4-B")?.decision === "RETENUE" && parCode(plaf.lignes, "L4-E")?.decision === "RETENUE");
  const eq = (await sim.simulerSansEnregistrer(prisma, { ...base, budgetGnf: besoin, logique: "equilibre_territorial", equilibre: { partMinimaleParRegionPct: 30 } })).resultat;
  const depenseRegion = (regionId: number) => oracle.filter((o) => o.region === regionId && eq.lignes.some((l: { troncon: { code: string }; decision: string }) => l.troncon.code === o.code && l.decision === "RETENUE")).reduce((a, o) => a + BigInt(o.cout), 0n);
  verifier("equilibre territorial : la depense par region du resultat = somme des couts oracle des retenues de la region",
    eq.simulation.contraintes.equilibre.every((q: { regionId: number; depenseGnf: string }) => q.depenseGnf === depenseRegion(q.regionId).toString()), eq.simulation.contraintes.equilibre);
  verifier("equilibre : planchers = floor(enveloppe x 30 / 100), tous atteints avec une enveloppe egale au besoin", eq.simulation.contraintes.equilibre.every((q: { plancherGnf: string; atteint: boolean }) => q.plancherGnf === ((besoin * 30n) / 100n).toString() && q.atteint === true) && eq.simulation.contraintes.insatisfaisables.length === 0);
  const urg = (await sim.simulerSansEnregistrer(prisma, { ...base, budgetGnf: besoin, logique: "urgence" })).resultat;
  verifier("urgence : le tronçon CRITIQUE (L4-B) est examine en premier", urg.lignes[0].troncon.code === "L4-B" && urg.lignes[0].simulation.ordreArbitrage === 1);
  const sel = await sim.simulerSansEnregistrer(prisma, { ...base, budgetGnf: besoin, selection: [idDe("L4-A"), idDe("L4-C")] });
  verifier("selection de 2 interventions : seuls ces 2 candidats sont examines", sel.resultat.totaux.candidats === 2 && codes(sel.resultat.lignes).sort().join() === "L4-A,L4-C");
  verifier("selection hors perimetre : SELECTION_INVALIDE (422), sans reveler l'existence", codeRefus(await echec(() => sim.simulerSansEnregistrer(prisma, { ...base, budgetGnf: besoin, regionId: regA, selection: [idDe("L4-B")] }))) === "SELECTION_INVALIDE");
  const regionB = (await sim.simulerSansEnregistrer(prisma, { ...base, budgetGnf: besoin, regionId: regB })).resultat;
  verifier("perimetre region B : 2 candidats (B et E)", regionB.totaux.candidats === 2 && codes(regionB.lignes).sort().join() === "L4-B,L4-E");

  // ---------- Enregistrement : les CHECK de la base acceptent le scenario du simulateur
  console.log("\nEnregistrement, empreintes, rejeu, immutabilite");
  const e1 = await sim.enregistrer(prisma, { ...base, budgetGnf: BUDGET, intitule: "Essai L4 ratio 7 Md", obligatoires: [idDe("L4-C")] }, ctxGest);
  const id1 = e1.scenario.id as string;
  verifier("le scenario est enregistre (les CHECK de coherence budget, annee, version, totaux et empreintes l'acceptent)", typeof id1 === "string" && e1.scenario.nbRetenues === e1.resultat.totaux.retenues, e1.scenario);
  const ligneDb = (await lire<{ ok: boolean; ok2: boolean; logique: string; baremes: string; auteur: string; engage: string }>(
    `SELECT "empreinteEntrees" = encode(sha256(convert_to("entreesCanoniques", 'UTF8')), 'hex') AS ok, "empreinteResultat" = encode(sha256(convert_to("resultatCanonique", 'UTF8')), 'hex') AS ok2,
            "entreesCanoniques"::jsonb #>> '{simulation,logique}' AS logique, "entreesCanoniques"::jsonb #>> '{simulation,baremes,empreinte}' AS baremes, "creeParId" AS auteur, "montantEngageGnf"::text AS engage
       FROM scenarios_programmation WHERE id = $1`, id1))[0];
  verifier("les empreintes stockees sont celles que PostgreSQL recalcule sur les textes", ligneDb.ok === true && ligneDb.ok2 === true, ligneDb);
  verifier("l'auteur est celui de la session, le montant engage = celui du resultat, la logique et la version des baremes sont dans les entrees scellees", ligneDb.auteur === U_GEST && ligneDb.engage === e1.resultat.totaux.engageGnf && ligneDb.logique === "ratio_cout_impact" && ligneDb.baremes === e1.resultat.simulation.baremes.empreinte, ligneDb);
  const liste = (await lire<{ id: string; version: number; code: string; cout: string; type: string; approuve: boolean }>(
    `SELECT b.id::text AS id, b.version, b."typeIntervention" AS type, b."coutKmGnf"::text AS cout, b.code, (b."approuveLe" IS NOT NULL) AS approuve FROM baremes_intervention b WHERE b.actif ORDER BY b.id`));
  const stockees = e1.resultat.simulation.baremes.liste as { id: number; version: number; coutKmGnf: string; typeIntervention: string; approuveLe: string | null }[];
  verifier("la version des baremes enregistree = les lignes actives de la table (id, version, cout, type, approbation)",
    stockees.length === liste.length && liste.every((b) => { const r = stockees.find((x) => String(x.id) === b.id); return !!r && r.version === b.version && r.coutKmGnf === b.cout && r.typeIntervention === b.type && (r.approuveLe !== null) === b.approuve; }), { stockees: stockees.length, base: liste.length });
  verifier("l'obligatoire C est retenue en phase OBLIGATOIRE", parCode(e1.resultat.lignes, "L4-C")?.simulation.phase === "OBLIGATOIRE" && e1.resultat.simulation.contraintes.obligatoires.retenues.includes(idDe("L4-C")));
  const rejeu = await moteur.rejouer(prisma, id1);
  verifier("rejeu du scenario du simulateur : identique octet pour octet, entrees integres", rejeu.identique === true && rejeu.entreesIntegres === true && rejeu.empreinteStockee === rejeu.empreinteRecalculee, rejeu);
  const herite = await moteur.simuler(prisma, { annee: 2027, intitule: "Essai L4 herite", budgetGnf: BUDGET, parametresId: idAmorcage }, ctxGest);
  const rejeuHerite = await moteur.rejouer(prisma, herite.scenario.id);
  verifier("un scenario HERITE (service historique, sans bloc simulation) est accepte par la base et se rejoue identique", rejeuHerite.identique === true && herite.resultat.simulation === undefined && !/"simulation"/.test((await lire<{ t: string }>(`SELECT "entreesCanoniques" AS t FROM scenarios_programmation WHERE id = $1`, herite.scenario.id))[0].t));
  verifier("un scenario scelle ne se modifie pas : UPDATE des entrees refuse", /fige|immuable|refuse/i.test((await echec(() => sql(`UPDATE scenarios_programmation SET "entreesCanoniques" = "entreesCanoniques" || ' ' WHERE id = $1`, id1))) ?? ""));
  verifier("ni ne se supprime physiquement : DELETE refuse", /DELETE refuse/.test((await echec(() => sql(`DELETE FROM scenarios_programmation WHERE id = $1`, id1))) ?? ""));
  verifier("l'enregistrement est audite (CREATE ScenarioProgrammation, origine simulateur, deficit, version des baremes)",
    (await compter(`SELECT count(*)::int AS n FROM audit_logs WHERE "entityType" = 'ScenarioProgrammation' AND action = 'CREATE' AND "entityId" = $1 AND after->>'origine' = 'simulateur' AND after->>'deficitGnf' IS NOT NULL AND after->>'baremesEmpreinte' = $2 AND "userId" = $3`, id1, e1.resultat.simulation.baremes.empreinte, U_GEST)) === 1);

  // ---------- Liste, territoire, comparaison, export
  console.log("\nListe, territoire, comparaison, export");
  const e2 = await sim.enregistrer(prisma, { ...base, budgetGnf: besoin, logique: "urgence", intitule: "Essai L4 urgence 50% region A", regionId: regA }, ctxAdmin);
  const e3 = await sim.enregistrer(prisma, { ...base, budgetGnf: BUDGET, logique: "criticite", intitule: "Essai L4 criticite" }, ctxGest);
  const l = await dep.listerResumes(prisma, { limite: 50, decalage: 0 });
  const r2 = l.lignes.find((x: { id: string }) => x.id === e2.scenario.id);
  verifier("la liste lit la logique, la periode et le deficit dans les textes scelles", r2?.logique === "urgence" && r2.periodeDebut === "2027-01-01" && r2.periodeFin === "2027-12-31" && r2.deficitGnf === e2.resultat.simulation.bilan.deficitGnf && r2.auteurNom === "Essai L4", r2);
  verifier("un scenario herite apparait avec logique, periode et deficit nuls (pas inventes)", (() => { const h = l.lignes.find((x: { id: string }) => x.id === herite.scenario.id); return h?.logique === null && h.periodeDebut === null && h.deficitGnf === null; })());
  const surRegion = await dep.listerResumes(prisma, { limite: 50, decalage: 0, regions: [regA] });
  verifier("le filtre territorial de la liste : un compte de la region A ne voit que les scenarios de la region A", surRegion.lignes.length === 1 && surRegion.lignes[0].id === e2.scenario.id && surRegion.total === 1, surRegion.lignes.map((x: { intitule: string }) => x.intitule));
  verifier("regionsScenario (garde 404) : region du perimetre pour le scenario regional, null pour un calcul national", JSON.stringify(await territoire.regionsScenario(e2.scenario.id)) === JSON.stringify([regA]) && JSON.stringify(await territoire.regionsScenario(e3.scenario.id)) === JSON.stringify([null]) && (await territoire.regionsScenario("00000000-0000-4000-8000-000000000000")).length === 0);
  const q = await dep.listerResumes(prisma, { limite: 50, decalage: 0, q: "50%" });
  verifier("recherche par nom : le « % » est cherche litteralement (pas un joker)", q.lignes.length === 1 && q.lignes[0].id === e2.scenario.id, q.lignes.map((x: { intitule: string }) => x.intitule));
  verifier("filtre par logique", (await dep.listerResumes(prisma, { limite: 50, decalage: 0, logique: "criticite" })).lignes.map((x: { id: string }) => x.id).join() === e3.scenario.id);

  const cmp = await sim.comparer(prisma, [id1, e3.scenario.id], null);
  verifier("comparaison de 2 scenarios de meme periode : enveloppe, consomme, reste, deficit lus dans les resultats scelles",
    cmp.scenarios[0].consommeGnf === e1.resultat.totaux.engageGnf && cmp.scenarios[1].deficitGnf === e3.resultat.simulation.bilan.deficitGnf && cmp.scenarios[0].enveloppeGnf === BUDGET.toString() && cmp.hypotheses.find((h: { champ: string }) => h.champ === "logique").identiques === false);
  const autrePeriode = await sim.enregistrer(prisma, { ...base, periode: { debut: "2027-01-01", fin: "2028-12-31" }, budgetGnf: BUDGET, intitule: "Essai L4 deux ans" }, ctxGest);
  verifier("periodes differentes : comparaison refusee (PERIODES_INCOMPATIBLES, 422)", codeRefus(await echec(() => sim.comparer(prisma, [id1, autrePeriode.scenario.id], null))) === "PERIODES_INCOMPATIBLES");
  verifier("scenario hors perimetre regional dans une comparaison : INTROUVABLE (meme refus qu'un identifiant inconnu)", codeRefus(await echec(() => sim.comparer(prisma, [e2.scenario.id, id1], [regA]))) === "INTROUVABLE" && codeRefus(await echec(() => sim.comparer(prisma, [e2.scenario.id, "00000000-0000-4000-8000-000000000000"], [regA]))) === "INTROUVABLE");
  verifier("scenario herite dans une comparaison : SCENARIO_SANS_SIMULATION", codeRefus(await echec(() => sim.comparer(prisma, [id1, herite.scenario.id], null))) === "SCENARIO_SANS_SIMULATION");

  const auditAvantExport = await compter(`SELECT count(*)::int AS n FROM audit_logs WHERE "entityType" = 'ExportScenario'`);
  const csv = await sim.exporter(prisma, id1, "csv", ctxGest, null, new Date("2026-10-27T08:00:00Z"));
  const json = await sim.exporter(prisma, id1, "json", ctxGest, [regA], new Date("2026-10-27T08:00:00Z"));
  verifier("export CSV : BOM, mention en tete, date de generation, nom de fichier", csv.corps.startsWith("﻿SIMULATION NON ENGAGEANTE : ne constitue ni une autorisation de dépense ni un ordre de travaux.\n") && /Généré le;2026-10-27T08:00:00.000Z/.test(csv.corps) && /\.csv$/.test(csv.nom), csv.nom);
  const jj = JSON.parse(json.corps);
  verifier("export JSON : mention, perimetre territorial applique, une ligne par candidat, versions", jj.mention.startsWith("SIMULATION NON ENGAGEANTE") && JSON.stringify(jj.perimetre.territoireApplique) === JSON.stringify([regA]) && jj.lignes.length === e1.resultat.totaux.candidats && jj.versions.baremes.empreinte === e1.resultat.simulation.baremes.empreinte);
  verifier("chaque export est journalise (CREATE ExportScenario : format, nombre de lignes, territoire)", (await compter(`SELECT count(*)::int AS n FROM audit_logs WHERE "entityType" = 'ExportScenario'`)) === auditAvantExport + 2
    && (await compter(`SELECT count(*)::int AS n FROM audit_logs WHERE "entityType" = 'ExportScenario' AND "entityId" = $1 AND after->>'format' = 'json' AND (after->>'nbLignes')::int = $2 AND after->'territoire' = to_jsonb($3::int[])`, id1, jj.lignes.length, [regA])) === 1);
  verifier("exporter un scenario herite est refuse", codeRefus(await echec(() => sim.exporter(prisma, herite.scenario.id, "csv", ctxGest, null, new Date()))) === "SCENARIO_SANS_SIMULATION");

  // ---------- Suppression logique
  const supp = await moteur.supprimerScenario(prisma, autrePeriode.scenario.id, ctxGest);
  verifier("suppression logique : le scenario disparait des lectures, la ligne reste en base, l'action est auditee",
    supp.ok === true && (await compter(`SELECT count(*)::int AS n FROM scenarios_programmation WHERE id = $1 AND "deletedAt" IS NOT NULL`, autrePeriode.scenario.id)) === 1
    && (await dep.listerResumes(prisma, { limite: 50, decalage: 0 })).lignes.every((x: { id: string }) => x.id !== autrePeriode.scenario.id)
    && (await compter(`SELECT count(*)::int AS n FROM audit_logs WHERE "entityType" = 'ScenarioProgrammation' AND action = 'DELETE' AND "entityId" = $1`, autrePeriode.scenario.id)) === 1);

  // ---------- Aucune ecriture dans le patrimoine
  console.log("\nAucune ecriture dans les donnees officielles");
  const apresTables = Object.fromEntries(await Promise.all(TABLES_INTERDITES.map(async (t) => [t, await empreinteTable(t)])));
  for (const t of ["programmes_budgetaires", "chantiers", "marches", "decomptes", "baremes_intervention"]) {
    verifier(`${t} : empreinte identique avant et apres (simuler, enregistrer, comparer, exporter, rejouer, supprimer)`, avantTables[t] === apresTables[t], { avant: avantTables[t], apres: apresTables[t] });
  }
  verifier("toutes les tables surveillees sont inchangees, et le fil de declenchement n'a jamais ete franchi", TABLES_INTERDITES.every((t) => avantTables[t] === apresTables[t]));

  // ---------- Couts perimes et version des baremes
  console.log("\nCouts perimes, version des baremes");
  await desarmer();
  await sql(`UPDATE baremes_intervention SET "validA" = DATE '2026-12-31' WHERE "familleRevetement" = 'bitume' AND "etatDepart" = 'MAUVAIS' AND "typeIntervention" = 'rehabilitation'`);
  await armer();
  const per = (await sim.simulerSansEnregistrer(prisma, { ...base, budgetGnf: besoin })).resultat;
  verifier("un bareme dont la fenetre finit avant la periode : A et E (bitume MAUVAIS) sont ecartes COUT_PERIME, non valorises", ["L4-A", "L4-E"].every((c) => parCode(per.lignes, c)?.motifExclusion?.code === "COUT_PERIME" && parCode(per.lignes, c)?.simulation.coutFiable === false), per.totaux.ecartesParMotif);
  verifier("le besoin ne compte pas ces couts perimes ; le deficit est dit minorant ; l'avertissement COUT_PERIME est en evidence",
    per.simulation.bilan.besoinTotalGnf === (couts["L4-B"] + couts["L4-C"]).toString() && per.simulation.bilan.deficitMinorant === true && per.simulation.avertissements.some((a: { code: string; niveau: string; nb: number }) => a.code === "COUT_PERIME" && a.niveau === "ALERTE" && a.nb === 2), per.simulation.bilan);
  const perimeEnreg = await sim.enregistrer(prisma, { ...base, budgetGnf: besoin, intitule: "Essai L4 cout perime" }, ctxGest);
  verifier("un scenario avec couts perimes est accepte par la base et se rejoue identique", (await moteur.rejouer(prisma, perimeEnreg.scenario.id)).identique === true);
  await desarmer();
  await sql(`INSERT INTO baremes_intervention ("familleRevetement", "etatDepart", "typeIntervention", "coutKmGnf", code, source, version, "anneeReference", "updatedAt")
             VALUES ('bitume', 'MAUVAIS', 'rehabilitation', 1500000000, 'L4-V2', 'essai', 2, 2027, now())`);
  await armer();
  const v2 = (await sim.simulerSansEnregistrer(prisma, { ...base, budgetGnf: besoin * 2n })).resultat;
  const coutA2 = (1_500_000_000n * BigInt(oracle.find((o) => o.code === "L4-A")!.len_m)) / 1000n;
  verifier("une version 2 valide pour la periode est preferee a la version 1 perimee : A est chiffree au tarif de la version 2",
    parCode(v2.lignes, "L4-A")?.cout?.montantGnf === coutA2.toString() && parCode(v2.lignes, "L4-A")?.simulation.coutSource?.version === 2 && parCode(v2.lignes, "L4-A")?.motifExclusion === null, parCode(v2.lignes, "L4-A")?.cout);
  verifier("la version des baremes change avec la liste (nouvelle empreinte, ligne v2 presente)", v2.simulation.baremes.empreinte !== e1.resultat.simulation.baremes.empreinte && v2.simulation.baremes.liste.some((b: { code: string; version: number }) => b.code === "L4-V2" && b.version === 2));
  verifier("le scenario enregistre AVANT le changement de bareme se rejoue toujours identique (ses entrees sont scellees avec leurs baremes)", (await moteur.rejouer(prisma, id1)).identique === true);
  verifier("designer un bareme inexistant : BAREMES_INTROUVABLES", codeRefus(await echec(() => sim.simulerSansEnregistrer(prisma, { ...base, budgetGnf: BUDGET, baremeIds: [999999] }))) === "BAREMES_INTROUVABLES");
  const idV1 = Number((await lire<{ id: number }>(`SELECT id FROM baremes_intervention WHERE "familleRevetement" = 'bitume' AND "etatDepart" = 'MAUVAIS' AND "typeIntervention" = 'rehabilitation' AND version = 1`))[0].id);
  const designe = (await sim.simulerSansEnregistrer(prisma, { ...base, budgetGnf: besoin, baremeIds: [idV1] })).resultat;
  verifier("designer explicitement la version 1 (perimee) : le simulateur la prend et la declare perimee, il ne la remplace pas en silence", parCode(designe.lignes, "L4-A")?.motifExclusion?.code === "COUT_PERIME");
  const baremesEcran = await sim.baremesPourPeriode(prisma, periode);
  verifier("la liste des baremes de l'ecran porte statut (PROVISOIRE tant que non approuve) et couverture de la periode", baremesEcran.every((b: { statut: string }) => b.statut === "PROVISOIRE") && baremesEcran.some((b: { couvrePeriode: boolean }) => b.couvrePeriode === false) === false, baremesEcran.length);

  await desarmer();
  await sql(`DELETE FROM baremes_intervention WHERE code = 'L4-V2'`);
  await sql(`UPDATE baremes_intervention SET "validA" = NULL WHERE "familleRevetement" = 'bitume' AND "etatDepart" = 'MAUVAIS' AND "typeIntervention" = 'rehabilitation'`);
}

try {
  await main();
} catch (e) {
  console.error("Le banc s'est arrete sur une erreur :", e);
  verifier("le banc va jusqu'au bout sans erreur imprevue", false, String((e as Error).message ?? e));
} finally {
  await prisma.$disconnect();
  await supprimerClone(ORIGINE!, NOM_CLONE);
  console.log("Clone " + NOM_CLONE + " detruit.");
}
conclure();

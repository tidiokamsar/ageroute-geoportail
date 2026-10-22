// Banc d'integration de la COLLECTE EN ROULAGE : voir tests-integration/README.md.
// Lancer (DATABASE_URL pointe sur `replay`) : npx tsx tests-integration/roulage.integration.mts
//
// CE QUE CE BANC FAIT
//
// 1. Il rejoue, avec le VRAI noyau de l'appareil (frontend/src/roulage/), une session de 2 h a 1 Hz sur un
//    reseau de test de 17 troncons (85 km), avec des leurres paralleles a 40 m, une route transversale, un
//    troncon ABSENT du referentiel, des arrets, et quatre incidents injectes : appel entrant, veille avec
//    tampon, redemarrage du processus (journal tronque puis rejoue), pause de l'agent.
// 2. Il envoie la charge produite a `appliquer` (le service de synchronisation), contre PostGIS reel.
// 3. Il verifie : zero doublon au rejeu, taux de rattachement MESURE, marqueurs et evenements lineaires
//    aux bonnes abscisses contre un ORACLE SQL independant (la verite du simulateur projetee par
//    ST_LineLocatePoint, sans bruit GNSS, sans passer par le code du service).
//
// CE QUE CE BANC NE PROUVE PAS : c'est une SIMULATION. Le bruit GNSS est blanc et gaussien, pas celui d'un
// recepteur reel ; aucun telephone, aucun service de premier plan, aucune veille, aucun appel reel. Les
// resultats chiffres ici (erreurs en metres, taux de rattachement) ne sont pas des mesures sur appareil.
//
// Le banc travaille dans un CLONE jetable de `replay` (essai_roulage), cree puis detruit par lui-meme. Si le
// clone n'a pas encore la migration 20261024100000, il l'y applique (replay ne la porte pas tant qu'elle n'y
// a pas ete rejouee).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { evaluerCible } from "./lib/garde.ts";
import { creerClone, supprimerClone, urlClone } from "./lib/clone.ts";
import { verifier, conclure } from "./lib/verdict.ts";

const ORIGINE = process.env.DATABASE_URL;
const cible = evaluerCible(ORIGINE);
if (!cible.ok || cible.base !== "replay") {
  console.error("Banc d'integration refuse : DATABASE_URL doit etre une base locale nommee replay (le clone est cree par le banc).");
  process.exit(3);
}
const NOM_CLONE = "essai_roulage";
await creerClone(ORIGINE!, NOM_CLONE);
process.env.DATABASE_URL = urlClone(ORIGINE!, NOM_CLONE);
console.log(`Cible du banc : clone jetable ${NOM_CLONE}`);

const BASE = pathToFileURL(process.argv[1]).href;
const SRC = new URL("../src/", BASE).href;
const NOYAU = new URL("../../frontend/src/roulage/", BASE).href;
const MIGRATION = new URL("../prisma/migrations/20261024100000_sessions_roulage/migration.sql", BASE);
const imp = (p: string) => import(SRC + p + ".ts");
const { prisma } = await imp("lib/prisma");
const noyau = await import(NOYAU + "index.ts");
const simulation = await import(NOYAU + "simulation.ts");
const { payloadSessionRoulage } = await imp("roulage/contrat");
const { pasAdaptatifM } = await imp("roulage/session.service");
const { appliquer } = await imp("field/sync.service");
const { analyserTraceDetaillee } = await imp("geo/trace.service");

const { SessionRoulage, JournalMemoire, horlogeSimulee, construirePayload, operationPourSynchronisation, deplacer } = noyau;
const { simuler, abscissesChemin, positionSurChemin } = simulation;

// ------------------------------------------------------------------ utilitaires

const uid = (famille: number, n: number) => `${String(famille).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const USER = "u-roulage";
const USER_REG = "u-roulage-regional";
const T0 = 1_790_000_000_000;
const DUREE_S = 7200;
const pct = (x: number) => `${(x * 100).toFixed(2)} %`;
const sql = (q: string, ...a: unknown[]) => prisma.$executeRawUnsafe(q, ...a);

/** Applique la migration au clone si elle n'y est pas (instructions simples separees par `;` en fin de ligne). */
async function migrationSiAbsente() {
  const [{ existe }] = await prisma.$queryRawUnsafe(`SELECT to_regclass('sessions_roulage') IS NOT NULL AS existe`) as { existe: boolean }[];
  if (existe) return "deja presente dans replay";
  const texte = readFileSync(MIGRATION, "utf8").split(/\r?\n/).filter((l) => !l.trimStart().startsWith("--")).join("\n");
  const instructions = texte.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
  for (const i of instructions) await sql(i);
  return `appliquee au clone (${instructions.length} instructions)`;
}

// ------------------------------------------------------------------ reseau de test

const CAPS = [90, 90, 78, 62, 90, 118, 100, 90, 72, 90, 108, 90, 90, 84, 95, 100, 90]; // degres, 90 = est
const LEG_M = 5000;
const HORS_REFERENTIEL = 7; // le troncon de rang 7 n'est pas dans la base : 5 km hors referentiel
const O = { lat: 9.5, lon: -13.7 };
const sommets = [O as { lat: number; lon: number }];
for (const cap of CAPS) {
  const r = (cap * Math.PI) / 180;
  sommets.push(deplacer(sommets[sommets.length - 1], LEG_M * Math.sin(r), LEG_M * Math.cos(r)));
}
const cumul: number[] = abscissesChemin(sommets);
const idTroncon = (k: number) => (k === HORS_REFERENTIEL ? null : `t-rlg-${String(k).padStart(2, "0")}`);
const rangDe = (sM: number) => { let k = 0; while (k < CAPS.length - 1 && cumul[k + 1] <= sM) k += 1; return k; };
const LEURRES = [2, 5, 9];

// ------------------------------------------------------------------ simulation du vehicule

const vitesseBase = (t: number) => (t >= 900 && t % 900 < 40 ? 0 : 42 + 12 * Math.sin(t / 500)); // km/h, arret de 40 s toutes les 15 min
const sim0 = simuler({ chemin: sommets, departMs: T0, dureeS: DUREE_S, vitesseKmH: vitesseBase, graine: 20261024, sigmaM: 4, precisionAnnonceeM: 8 });
const tAtteint = (verite: { sM: number }[], sM: number) => verite.findIndex((p) => p.sM >= sM);
// Un passage au pas (1 m/s) dans le rang 9, pour produire un evenement de moins de 10 m.
const tRampe = tAtteint(sim0.verite, 46_000) - 5;
const vitesse = (t: number) => (t >= tRampe && t < tRampe + 40 ? 3.6 : vitesseBase(t));
const sim = simuler({ chemin: sommets, departMs: T0, dureeS: DUREE_S, vitesseKmH: vitesse, graine: 20261024, sigmaM: 4, precisionAnnonceeM: 8 });
const verite = sim.verite;
const tAt = (sM: number) => tAtteint(verite, sM);

function veriteA(tMs: number) {
  const i = Math.min(Math.max(Math.floor((tMs - T0) / 1000), 0), verite.length - 2);
  const f = (tMs - verite[i].tMs) / 1000;
  const sM = verite[i].sM + f * (verite[i + 1].sM - verite[i].sM);
  const p = positionSurChemin(sommets, cumul, sM);
  return { sM, lat: p.lat, lon: p.lon, rang: rangDe(sM) };
}

// ------------------------------------------------------------------ plan des gestes de l'agent

interface Evt { cle: string; debutS: number; finS: number; offsetMs: number; code: string; qualif: Record<string, unknown> | null; abandon?: boolean }
const EVTS: Evt[] = [
  { cle: "E5", debutS: tAt(11_000), finS: tAt(13_000), offsetMs: 0, code: "ETAT_CHAUSSEE", qualif: { etat: "MAUVAIS" } }, // zone a leurre parallele
  { cle: "E1", debutS: tAt(16_500), finS: tAt(18_200), offsetMs: 300, code: "ETAT_CHAUSSEE", qualif: { etat: "MAUVAIS" } },
  { cle: "E6", debutS: tAt(21_500), finS: tAt(22_500), offsetMs: 0, code: "PRATICABILITE", qualif: null, abandon: true },
  { cle: "E2", debutS: tAt(28_500), finS: tAt(32_000), offsetMs: 0, code: "ETAT_CHAUSSEE", qualif: { etat: "MAUVAIS", largeurM: 6 } }, // deux troncons
  { cle: "E3", debutS: tAt(34_000), finS: tAt(41_000), offsetMs: 500, code: "ETAT_CHAUSSEE", qualif: { etat: "MAUVAIS" } }, // a cheval sur 5 km hors referentiel
  { cle: "E7", debutS: tRampe + 5, finS: tRampe + 14, offsetMs: 0, code: "ETAT_CHAUSSEE", qualif: { etat: "MAUVAIS" } }, // ~9 m : trop court
  { cle: "E8", debutS: tAt(56_500), finS: tAt(58_500), offsetMs: 0, code: "ETAT_CHAUSSEE", qualif: { etat: "MAUVAIS" } }, // recouvre une portion validee
];
const MARQ_S = [1000, 3500, 6200, 8800, 11_500, 12_500, 15_200, 19_300, 23_500, 26_000, 27_800, 33_000, 36_000, 38_000, 39_500, 42_500, 44_500, 47_500, 49_000, 52_000, 54_000, 56_000, 59_500, 61_500, 63_500, 65_500, 67_000, 69_000];
const AGES_MS = [0, 400, 900];
const MARQUEURS = MARQ_S.map((s, i) => ({ cle: `M${i}`, t: tAt(s), ageMs: AGES_MS[i % 3], cibleS: s }));

// Incidents places dans le premier creneau libre (aucun marqueur ni evenement a moins de 30 s).
const occupes: [number, number][] = [
  ...EVTS.map((e): [number, number] => [e.debutS - 30, e.finS + 30]),
  ...MARQUEURS.map((m): [number, number] => [m.t - 30, m.t + 30]),
  [tRampe - 30, tRampe + 70],
];
function creneau(depuis: number, duree: number): number {
  for (let t = depuis; t < DUREE_S - duree - 60; t += 5) if (!occupes.some(([a, b]) => t < b && t + duree > a)) { occupes.push([t - 30, t + duree + 30]); return t; }
  throw new Error("aucun creneau libre pour un incident");
}
const APPEL = { debut: creneau(1400, 45), duree: 45 };
const VEILLE = { debut: creneau(2900, 60), duree: 60 };
const REDEMARRAGE = { instant: creneau(4400, 30), trouS: 20, entreesPerdues: 3, redonnees: 5 };
const PAUSE = { debut: creneau(5200, 90), duree: 90 };

console.log(`Plan : appel ${APPEL.debut}-${APPEL.debut + APPEL.duree} s, veille ${VEILLE.debut}-${VEILLE.debut + VEILLE.duree} s, redemarrage a ${REDEMARRAGE.instant} s (trou ${REDEMARRAGE.trouS} s), pause ${PAUSE.debut}-${PAUSE.debut + PAUSE.duree} s`);

// ------------------------------------------------------------------ roulage cote appareil (le vrai noyau)

interface MarqueurPose { cle: string; id: string; tMs: number; cibleS: number }
interface EvtPose { cle: string; id: string; debutMs: number; finMs: number; abandon: boolean }

function roulerSurAppareil() {
  let compteur = 0;
  const genererId = () => uid(77, (compteur += 1));
  let horloge = horlogeSimulee(T0);
  const journal1 = new JournalMemoire();
  let journalCourant = journal1;
  const demarrage = SessionRoulage.demarrer({ horloge, genererId, journal: journal1.sink });
  if (!demarrage.ok) throw new Error("demarrage refuse");
  let session = demarrage.session;
  const echantillons = sim.echantillons;
  const marquesPoses: MarqueurPose[] = [];
  const evtsPoses: EvtPose[] = [];
  const ouverts = new Map<string, { id: string; debutMs: number }>();
  const tampon: number[] = [];
  const rejetsPlugin = { doublonsRedonnes: 0 };
  let restartFait = false;

  const livrer = (t: number, differe = false) => {
    const r = session.ajouterEchantillon(echantillons[t], { differe });
    if (!r.accepte && !(differe && (r.motif === "HORODATAGE_DOUBLON" || r.motif === "HORODATAGE_RECULE"))) throw new Error(`echantillon ${t} refuse : ${r.motif}`);
    if (!r.accepte) rejetsPlugin.doublonsRedonnes += 1;
  };

  for (let t = 0; t <= DUREE_S; t += 1) {
    horloge.fixer(T0 + t * 1000);

    if (t === APPEL.debut) session.signalerSysteme({ type: "APPEL_ENTRANT" });
    if (t >= APPEL.debut && t < APPEL.debut + APPEL.duree) continue; // le recepteur ne livre rien pendant l'appel
    if (t === APPEL.debut + APPEL.duree) session.signalerSysteme({ type: "APPEL_TERMINE" });

    if (t === VEILLE.debut) session.signalerSysteme({ type: "VEILLE_DEBUT" });
    if (t >= VEILLE.debut && t < VEILLE.debut + VEILLE.duree) { tampon.push(t); continue; }
    if (t === VEILLE.debut + VEILLE.duree) {
      session.signalerSysteme({ type: "VEILLE_FIN" });
      for (const u of tampon) livrer(u, true); // le recepteur livre d'un coup ce qu'il a garde pendant la veille
      tampon.length = 0;
    }

    if (t === PAUSE.debut) { const r = session.mettreEnPause(); if (!r.ok) throw new Error(`pause refusee : ${r.refus}`); }
    if (t >= PAUSE.debut && t < PAUSE.debut + PAUSE.duree) continue;
    if (t === PAUSE.debut + PAUSE.duree) { const r = session.reprendre(); if (!r.ok) throw new Error(`reprise refusee : ${r.refus}`); }

    // Apres le redemarrage, le processus ne revient que REDEMARRAGE.trouS secondes plus tard.
    if (restartFait && t < REDEMARRAGE.instant + REDEMARRAGE.trouS) continue;

    livrer(t);

    for (const e of EVTS) {
      if (t === e.debutS) {
        horloge.fixer(T0 + t * 1000 + e.offsetMs);
        const id = uid(88, EVTS.indexOf(e) + 1);
        const d = session.debutEvenement(e.code, { id, qualification: e.qualif });
        if (!d.ok) throw new Error(`debut ${e.cle} refuse : ${d.refus}`);
        ouverts.set(e.cle, { id, debutMs: T0 + t * 1000 + e.offsetMs });
        horloge.fixer(T0 + t * 1000);
      }
      if (t === e.finS) {
        const o = ouverts.get(e.cle)!;
        horloge.fixer(T0 + t * 1000 + e.offsetMs);
        if (e.abandon) {
          const a = session.abandonnerEvenement(o.id);
          if (!a.ok) throw new Error(`abandon ${e.cle} refuse : ${a.refus}`);
        } else {
          const f = session.finEvenement(o.id);
          if (!f.ok) throw new Error(`fin ${e.cle} refusee : ${f.refus}`);
        }
        evtsPoses.push({ cle: e.cle, id: o.id, debutMs: o.debutMs, finMs: T0 + t * 1000 + e.offsetMs, abandon: !!e.abandon });
        horloge.fixer(T0 + t * 1000);
      }
    }
    for (const m of MARQUEURS) {
      if (t === m.t) {
        horloge.fixer(T0 + t * 1000 + m.ageMs);
        const id = uid(99, MARQUEURS.indexOf(m) + 1);
        const r = session.poserMarqueur("NID_DE_POULE", { id });
        if (!r.ok) throw new Error(`marqueur ${m.cle} refuse : ${r.refus}`);
        marquesPoses.push({ cle: m.cle, id, tMs: T0 + t * 1000 + m.ageMs, cibleS: m.cibleS });
        horloge.fixer(T0 + t * 1000);
      }
    }

    // REDEMARRAGE : le processus meurt. Les dernieres entrees du journal n'avaient pas ete ecrites.
    if (t === REDEMARRAGE.instant && !restartFait) {
      restartFait = true;
      const ecrites = journal1.tronque(journal1.entrees.length - REDEMARRAGE.entreesPerdues);
      horloge = horlogeSimulee(T0 + (t + REDEMARRAGE.trouS) * 1000);
      const journal2 = new JournalMemoire();
      journalCourant = journal2;
      const rj = SessionRoulage.rejouer(ecrites, { horloge, genererId, journal: journal2.sink });
      if (!rj.ok) throw new Error(`rejeu impossible : ${rj.raison}`);
      session = rj.session;
      session.reprendreApresRedemarrage();
      // Le plugin natif redonne ses derniers echantillons : ceux deja ecrits sont refuses, ceux perdus sont recuperes.
      for (let u = t - REDEMARRAGE.redonnees + 1; u <= t; u += 1) livrer(u, true);
    }
  }
  const arret = session.arreter();
  if (!arret.ok) throw new Error(`arret refuse : ${arret.refus}`);
  const p = construirePayload(session.etat, { missionId: null });
  if (!p.ok) throw new Error(`charge refusee : ${p.refus}`);
  return { payload: p.payload, session, marquesPoses, evtsPoses, journaux: [journal1, journalCourant], rejetsPlugin, resume: session.resume() };
}

// ------------------------------------------------------------------ oracle SQL

/** Abscisse d'une position VRAIE (sans bruit) sur un troncon : fraction x longueur geodesique, calculee par PostGIS. */
async function oracle(tronconId: string, lat: number, lon: number): Promise<number> {
  const r = await prisma.$queryRaw<{ a: number }[]>`
    SELECT ST_LineLocatePoint(t."geom", ST_SetSRID(ST_MakePoint(${String(lon)}::float8, ${String(lat)}::float8), 4326)) * ST_Length(t."geom"::geography) AS "a"
      FROM "troncons" t WHERE t."id" = ${tronconId}`;
  return Number(r[0].a);
}
const longueurTroncon = async (id: string) => Number((await prisma.$queryRaw<{ l: number }[]>`SELECT ST_Length("geom"::geography) AS "l" FROM "troncons" WHERE "id" = ${id}`)[0].l);
const compte = async (table: string, where = "TRUE") => Number((await prisma.$queryRawUnsafe(`SELECT count(*) AS n FROM "${table}" WHERE ${where}`) as { n: bigint }[])[0].n);

async function etatBase() {
  return {
    sessions: await compte("sessions_roulage"), marqueurs: await compte("marqueurs_roulage"), evenements: await compte("evenements_roulage"),
    liens: await compte("evenements_roulage_portions"), portionsRoulage: await compte("portions", `"source" LIKE 'roulage:%'`),
    portions: await compte("portions"),
    operations: await compte("operations_sync"), auditSession: await compte("audit_logs", `"entityType" = 'SessionRoulage'`),
    auditPortion: await compte("audit_logs", `"entityType" = 'Portion'`),
  };
}

// ------------------------------------------------------------------ banc

async function main() {
  const migration = await migrationSiAbsente();
  const tables = Number((await prisma.$queryRawUnsafe(`SELECT count(*) AS n FROM information_schema.tables WHERE table_name IN ('sessions_roulage','marqueurs_roulage','evenements_roulage','evenements_roulage_portions')`) as { n: bigint }[])[0].n);
  verifier(`migration 20261024100000 : ${migration}, 4 tables presentes`, tables === 4);

  // ---------- fixtures
  await sql(`INSERT INTO regions (nom) VALUES ('Region roulage'), ('Autre region roulage')`);
  const regionId = (nom: string) => prisma.$queryRawUnsafe(`SELECT id FROM regions WHERE nom = $1`, nom).then((r: { id: number }[]) => r[0].id);
  const R1 = await regionId("Region roulage");
  const R2 = await regionId("Autre region roulage");
  for (const [id, mail] of [[USER, "agent@x.invalid"], [USER_REG, "regional@x.invalid"]]) {
    await sql(`INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt") VALUES ($1, $2, 'Agent', 'x', 'INSPECTEUR', now())`, id, mail);
  }
  await sql(`INSERT INTO appareils (id, "userId", plateforme, "updatedAt") VALUES ($1, $2, 'android', now()), ($3, $4, 'android', now())`, uid(1, 1), USER, uid(1, 2), USER_REG);
  await sql(`INSERT INTO perimetres_comptes ("userId", "regionId", "accordeParId") VALUES ($1, $2, $3)`, USER_REG, R2, USER);
  await sql(`INSERT INTO referentiel_etats_chaussee (code, libelle, ordre, actif, critique, "updatedAt") VALUES ('MAUVAIS', 'Mauvais', 3, true, false, now())`);
  const wktLigne = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => `LINESTRING(${a.lon} ${a.lat}, ${b.lon} ${b.lat})`;
  const insererTroncon = (id: string, code: string, wkt: string, longueurKm: number) =>
    sql(`INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt")
         VALUES ($1, $2, $3, 'RN', $4, $5, 'BITUME', 0, $5, ST_GeomFromText($6, 4326), now())`, id, code, `Troncon ${code}`, R1, longueurKm, wkt);
  for (let k = 0; k < CAPS.length; k += 1) {
    const id = idTroncon(k);
    if (id) await insererTroncon(id, `RLG-${k}`, wktLigne(sommets[k], sommets[k + 1]), LEG_M / 1000);
  }
  for (const k of LEURRES) {
    // Leurre parallele a 40 m au nord, sur toute la longueur du troncon.
    await insererTroncon(`t-rlg-d${k}`, `RLG-D${k}`, wktLigne(deplacer(sommets[k], 0, 40), deplacer(sommets[k + 1], 0, 40)), LEG_M / 1000);
  }
  // Route transversale de 1 km au milieu du troncon 4.
  const milieu = { lat: (sommets[4].lat + sommets[5].lat) / 2, lon: (sommets[4].lon + sommets[5].lon) / 2 };
  await insererTroncon("t-rlg-x4", "RLG-X4", wktLigne(deplacer(milieu, 0, -500), deplacer(milieu, 0, 500)), 1);
  // Une portion deja VALIDEE sur le troncon 11 : l'evenement E8 doit la respecter.
  await sql(`INSERT INTO portions (id, "tronconId", "debutM", "finM", "statutValidation", origine, "creeParId", "updatedAt")
             VALUES ('p-validee-11', $1, 1500, 3000, 'VALIDE', 'SAISIE_TERRAIN', $2, now())`, idTroncon(11), USER);
  const avant = await etatBase();

  // ---------- 1. roulage cote appareil
  const t0 = performance.now();
  const appareil = roulerSurAppareil();
  const msAppareil = performance.now() - t0;
  const p = appareil.payload;
  console.log(`Noyau de l'appareil : ${p.points.length} points acceptes, ${appareil.resume.rejetsTotal} rejetes (dont ${appareil.rejetsPlugin.doublonsRedonnes} redonnes apres redemarrage), ${p.trous.length} trous, ${p.interruptions.length} interruptions, ${p.pauses.length} pause, ${appareil.resume.segments} segments, ${msAppareil.toFixed(0)} ms`);

  const temps: number[] = p.points.map((x: number[]) => x[0]);
  verifier("appareil : charge de roulage produite, points strictement croissants, 0 doublon d'horodatage", new Set(temps).size === temps.length && temps.every((t: number, i: number) => i === 0 || t > temps[i - 1]));
  const attendus = DUREE_S + 1 - APPEL.duree - PAUSE.duree - (REDEMARRAGE.trouS - 1);
  verifier(`appareil : 2 h a 1 Hz (7 201 echantillons) moins les secondes de l'appel, de la pause et du trou de redemarrage = ${attendus} points, ni perdu ni duplique`, p.points.length === attendus, { points: p.points.length, attendus });
  verifier("appareil : appel (trou), veille avec tampon (aucun trou), redemarrage (interruption REDEMARRAGE), pause : tous traces dans la charge",
    p.interruptions.some((i: { cause: string }) => i.cause === "APPEL") && p.interruptions.some((i: { cause: string }) => i.cause === "VEILLE")
    && p.interruptions.some((i: { cause: string }) => i.cause === "REDEMARRAGE") && p.pauses.length === 1,
    p.interruptions.map((i: { cause: string }) => i.cause));
  const trouVeille = p.trous.filter((x: { debutMs: number }) => x.debutMs >= T0 + VEILLE.debut * 1000 - 2000 && x.debutMs <= T0 + (VEILLE.debut + VEILLE.duree) * 1000);
  verifier("appareil : la veille avec tampon ne laisse AUCUN trou dans la trace", trouVeille.length === 0, trouVeille);
  verifier("appareil : le journal perd 3 entrees au redemarrage ET aucun echantillon n'est perdu (le plugin les redonne)",
    appareil.rejetsPlugin.doublonsRedonnes === REDEMARRAGE.redonnees - REDEMARRAGE.entreesPerdues,
    { redonnesRefuses: appareil.rejetsPlugin.doublonsRedonnes });
  verifier("appareil : 28 marqueurs poses, 7 evenements lineaires (dont 1 abandonne)", p.marqueurs.length === 28 && p.evenements.length === 7 && p.evenements.filter((e: { statut: string }) => e.statut === "ABANDONNE").length === 1);

  const contrat = payloadSessionRoulage.safeParse(p);
  verifier("contrat : la charge du NOYAU DE L'APPAREIL passe le schema zod du SERVEUR", contrat.success, contrat.success ? "" : contrat.error.issues.slice(0, 3));

  // ---------- 2. envoi par le protocole de synchronisation
  const op = operationPourSynchronisation(p);
  const ctxAgent = { appareilId: uid(1, 1), userId: USER };
  const tPush = performance.now();
  const r1 = await appliquer(op, ctxAgent);
  const msPush = performance.now() - tPush;
  console.log(`appliquer : ${r1.statut}${r1.motif ? " " + r1.motif : ""} en ${(msPush / 1000).toFixed(1)} s (analyse + ecriture)`);
  verifier("envoi : SYNCHRONISE, entityId = identifiant de session", r1.statut === "SYNCHRONISE" && r1.entityId === p.sessionId, r1);
  if (r1.statut !== "SYNCHRONISE") { conclure(); return; }

  const apres = await etatBase();
  // Duree de l'analyse seule (lecture, aucune ecriture), pour savoir ce que la transaction tient reellement.
  const { preparerSessionRoulage } = await imp("roulage/session.service");
  const tPrep = performance.now();
  await preparerSessionRoulage(p, { ...ctxAgent, operationId: op.operationId, entityId: p.sessionId });
  const msPrep = performance.now() - tPrep;
  console.log(`Analyse seule (lecture, avant la transaction) : ${(msPrep / 1000).toFixed(1)} s ; ecriture dans la transaction : environ ${Math.max(0, (msPush - msPrep) / 1000).toFixed(1)} s`);
  verifier("ecriture : 1 session, 28 marqueurs, 7 evenements, portions et liens coherents",
    apres.sessions - avant.sessions === 1 && apres.marqueurs - avant.marqueurs === 28 && apres.evenements - avant.evenements === 7
    && apres.liens - avant.liens === apres.portionsRoulage - avant.portionsRoulage, { avant, apres });

  const [s] = await prisma.$queryRawUnsafe(
    `SELECT "nbPoints", "tauxRattachement", "provenanceParametres", jsonb_array_length(points) AS n, ST_NumGeometries(geom) AS segs, ST_IsValid(geom) AS valide,
            "analyse" -> 'indicateurs' AS ind, "analyse" -> 'parametres' AS par, (points -> 0) AS premier, (points -> -1) AS dernier FROM sessions_roulage WHERE id = $1`, p.sessionId) as Record<string, any>[];
  verifier("stockage : la trace brute est conservee point pour point (nbPoints = jsonb = charge), geometrie valide, une ligne par segment",
    s.nbPoints === p.points.length && Number(s.n) === p.points.length && s.valide === true && Number(s.segs) === appareil.resume.segments
    && JSON.stringify(s.premier) === JSON.stringify(p.points[0]) && JSON.stringify(s.dernier) === JSON.stringify(p.points.at(-1)),
    { nbPoints: s.nbPoints, n: s.n, segs: s.segs, segsAttendus: appareil.resume.segments });
  verifier("stockage : les seuils provisoires de l'appareil sont conserves avec la trace", s.provenanceParametres === "PROVISOIRE_NON_CALIBRE");
  console.log(`Analyse serveur : ${JSON.stringify(s.ind)} ; pas ${JSON.stringify(s.par.pasMinM)}`);

  // ---------- 3. ZERO DOUBLON AU REJEU
  const resultatsRejeu: string[] = [];
  for (let i = 0; i < 5; i += 1) resultatsRejeu.push((await appliquer(op, ctxAgent)).statut);
  const apresRejeu = await etatBase();
  verifier("REJEU x5 de la meme operation : REJOUEE a chaque fois", resultatsRejeu.every((x) => x === "REJOUEE"), resultatsRejeu);
  verifier("REJEU : 0 doublon, aucune table ne change (sessions, marqueurs, evenements, liens, portions, operations_sync, audit)",
    JSON.stringify(apresRejeu) === JSON.stringify(apres), { apres, apresRejeu });
  const autreCle = await appliquer({ ...op, operationId: uid(5, 1) }, ctxAgent);
  verifier("meme session sous une NOUVELLE cle d'operation : REJETE SESSION_DEJA_ENREGISTREE", autreCle.statut === "REJETE" && autreCle.motif === "SESSION_DEJA_ENREGISTREE", autreCle);
  const apresAutreCle = await etatBase();
  verifier("... et rien n'est reecrit (seule la trace de rejet est ajoutee a operations_sync)",
    JSON.stringify({ ...apresAutreCle, operations: 0 }) === JSON.stringify({ ...apres, operations: 0 }) && apresAutreCle.operations === apres.operations + 1);
  const autreCompte = await appliquer(op, { appareilId: uid(1, 2), userId: USER_REG });
  verifier("une cle connue ne devient pas un oracle : un autre compte qui la rejoue est refuse", autreCompte.statut === "REJETE" && autreCompte.motif === "OPERATION_NON_AUTORISEE", autreCompte);

  // ---------- 4. TAUX DE RATTACHEMENT mesure, et exactitude vis-a-vis de la verite du simulateur
  const tauxStocke = Number(s.tauxRattachement);
  const segments = new Map<number, { lat: number; lon: number; tMs: number; precisionM: number | null }[]>();
  for (const [tMs, lat, lon, precisionM, , seg] of p.points as number[][]) {
    const l = segments.get(seg) ?? []; l.push({ lat, lon, tMs, precisionM }); segments.set(seg, l);
  }
  const bilan = async (options: Record<string, unknown>) => {
    const b = { surReseau: 0, bonTroncon: 0, horsReseau: 0, horsReseauRejetes: 0, leurre: 0, leurreBons: 0, total: 0 };
    for (const pts of segments.values()) {
      if (pts.length < 2) continue;
      const d = await analyserTraceDetaillee(prisma, { points: pts }, { pasMinM: pasAdaptatifM(pts), ...options });
      d.retenus.forEach((q: { tMs: number }, i: number) => {
        const v = veriteA(q.tMs);
        const attendu = idTroncon(v.rang);
        const obtenu = d.apparies[i].tronconId;
        b.total += 1;
        if (attendu === null) { b.horsReseau += 1; if (obtenu === null) b.horsReseauRejetes += 1; return; }
        b.surReseau += 1;
        if (obtenu === attendu) b.bonTroncon += 1;
        if (LEURRES.includes(v.rang)) { b.leurre += 1; if (obtenu === attendu) b.leurreBons += 1; }
      });
    }
    return b;
  };
  const sansGraphe = await bilan({});
  const avecGraphe = await bilan({ toleranceFusionM: 2 });
  const fmt = (b: typeof sansGraphe) => `${b.bonTroncon}/${b.surReseau} sur le bon troncon (${pct(b.bonTroncon / b.surReseau)}), leurre ${b.leurreBons}/${b.leurre}, hors referentiel ${b.horsReseauRejetes}/${b.horsReseau} laisses sans troncon`;
  console.log(`Rattachement vs verite du simulateur, SANS graphe : ${fmt(sansGraphe)}`);
  console.log(`Rattachement vs verite du simulateur, AVEC graphe (tolerance 2 m) : ${fmt(avecGraphe)}`);
  console.log(`Taux de rattachement stocke (points retenus rattaches / retenus) : ${pct(tauxStocke)} ; sur reseau, la part hors referentiel est de ${pct(sansGraphe.horsReseau / sansGraphe.total)} des points retenus`);
  verifier("taux de rattachement MESURE et stocke (entre 0 et 1) ; il est coherent avec la part hors referentiel de la simulation",
    tauxStocke > 0 && tauxStocke <= 1 && Math.abs(tauxStocke - (1 - sansGraphe.horsReseau / sansGraphe.total)) < 0.05, { tauxStocke });
  verifier(`rattachement SIMULE : >= 97 % des points sur reseau sur le bon troncon, sans graphe (${pct(sansGraphe.bonTroncon / sansGraphe.surReseau)})`, sansGraphe.bonTroncon / sansGraphe.surReseau >= 0.97);
  verifier(`rattachement SIMULE : >= 97 % avec le graphe (${pct(avecGraphe.bonTroncon / avecGraphe.surReseau)})`, avecGraphe.bonTroncon / avecGraphe.surReseau >= 0.97);
  verifier(`zone a leurre parallele (40 m) : jamais le leurre (${sansGraphe.leurreBons}/${sansGraphe.leurre} sur le bon troncon)`, sansGraphe.leurreBons / sansGraphe.leurre >= 0.97);
  verifier("le troncon absent du referentiel n'est pas rattache de force : >= 90 % de ses points restent sans troncon", sansGraphe.horsReseauRejetes / sansGraphe.horsReseau >= 0.9);

  // ---------- 5. MARQUEURS contre l'oracle
  const lignesM = await prisma.$queryRawUnsafe(`SELECT id, statut, motif, "tronconId", "abscisseM", "distanceM", "positionPerimee" FROM marqueurs_roulage WHERE "sessionId" = $1`, p.sessionId) as Record<string, any>[];
  const parIdM = new Map(lignesM.map((l) => [l.id, l]));
  let nOk = 0; let nHors = 0; let nHorsOk = 0; let erreurMax = 0; let erreurNaiveMax = 0; let mauvaisTroncon = 0;
  const erreurs: number[] = [];
  for (const m of appareil.marquesPoses as MarqueurPose[]) {
    const v = veriteA(m.tMs);
    const attendu = idTroncon(v.rang);
    const l = parIdM.get(m.id)!;
    if (attendu === null) {
      nHors += 1;
      if (l.statut === "NON_RATTACHE") nHorsOk += 1;
      continue;
    }
    if (l.statut !== "RATTACHE" || l.tronconId !== attendu) { mauvaisTroncon += 1; continue; }
    const oracleM = await oracle(attendu, v.lat, v.lon);
    const e = Math.abs(Number(l.abscisseM) - oracleM);
    erreurs.push(e);
    erreurMax = Math.max(erreurMax, e);
    nOk += 1;
    // Ce qu'aurait donne le dernier fix pris tel quel, perime de `ageMs` : la vitesse x l'age, hors bruit.
    const age = MARQUEURS.find((x) => x.cle === m.cle)!.ageMs;
    erreurNaiveMax = Math.max(erreurNaiveMax, (verite[Math.floor((m.tMs - T0) / 1000)]?.vitesseMs ?? 0) * (age / 1000));
  }
  erreurs.sort((a, b) => a - b);
  const mediane = erreurs[Math.floor(erreurs.length / 2)];
  console.log(`Marqueurs : ${nOk} rattaches au bon troncon, erreur d'abscisse vs oracle SQL : mediane ${mediane.toFixed(1)} m, max ${erreurMax.toFixed(1)} m (decalage d'un fix perime de 0,9 s a 45 km/h : ${erreurNaiveMax.toFixed(1)} m) ; ${nHorsOk}/${nHors} marqueurs hors referentiel laisses NON_RATTACHE`);
  verifier("marqueurs : tous ceux poses sur le reseau sont rattaches au BON troncon", mauvaisTroncon === 0 && nOk === 28 - nHors, { mauvaisTroncon, nOk, nHors });
  verifier(`marqueurs SIMULES : erreur d'abscisse < 30 m contre l'oracle SQL (max ${erreurMax.toFixed(1)} m)`, erreurMax < 30);
  verifier("marqueurs : ceux poses sur le troncon absent du referentiel sont NON_RATTACHE, jamais colles au voisin", nHors === 3 && nHorsOk === nHors);
  verifier("marqueurs : la latence logicielle de pose est enregistree et sous le budget de 200 ms (mesure de bureau, pas un telephone)", p.marqueurs.every((m: { latenceLogicielleMs: number }) => m.latenceLogicielleMs < 200));

  // ---------- 6. EVENEMENTS LINEAIRES contre l'oracle
  const lignesE = await prisma.$queryRawUnsafe(`SELECT id, code, "statutRattachement", motif, troncons FROM evenements_roulage WHERE "sessionId" = $1`, p.sessionId) as Record<string, any>[];
  const parIdE = new Map(lignesE.map((l) => [l.id, l]));
  const portionsDe = async (idEvt: string) => prisma.$queryRawUnsafe(
    `SELECT l.rang, l."tronconId", l."debutM", l."finM", l.sens, p."statutValidation", p.origine, p.source, p."clientOperationId", p."creeParId", p.etat, p."largeurM", p."observeeLe", p."remplaceeLe", ST_NumPoints(p.geom) AS npts
       FROM evenements_roulage_portions l JOIN portions p ON p.id = l."portionId" WHERE l."sessionId" = $1 AND l."evenementId" = $2 ORDER BY l.rang`, p.sessionId, idEvt) as Promise<Record<string, any>[]>;
  const evt = (cle: string) => appareil.evtsPoses.find((e: EvtPose) => e.cle === cle) as EvtPose;
  const TOL_EXTREME = 30; const TOL_INTERNE = 150;
  const mesures: string[] = [];

  // E1 : un seul troncon (rang 3), sens croissant
  {
    const e = evt("E1"); const a = veriteA(e.debutMs); const b = veriteA(e.finMs);
    const [pp, ...reste] = await portionsDe(e.id);
    const ed = Math.abs(pp.debutM - await oracle(idTroncon(a.rang)!, a.lat, a.lon)); const ef = Math.abs(pp.finM - await oracle(idTroncon(b.rang)!, b.lat, b.lon));
    mesures.push(`E1 debut ${ed.toFixed(1)} m, fin ${ef.toFixed(1)} m`);
    verifier(`E1 (1 troncon, rang ${a.rang}) : 1 portion sur le bon troncon, sens croissant, abscisses a ${TOL_EXTREME} m de l'oracle (debut ${ed.toFixed(1)} m, fin ${ef.toFixed(1)} m)`,
      reste.length === 0 && pp.tronconId === idTroncon(3) && a.rang === 3 && b.rang === 3 && pp.sens === "CROISSANT" && ed < TOL_EXTREME && ef < TOL_EXTREME);
    verifier("E1 : la portion est une PROPOSITION A_VALIDER de saisie terrain, citant la session, auteur = l'agent, etat et date du constat portes",
      pp.statutValidation === "A_VALIDER" && pp.origine === "SAISIE_TERRAIN" && pp.source === `roulage:${p.sessionId}` && pp.creeParId === USER && pp.etat === "MAUVAIS"
      && pp.clientOperationId === `${op.operationId}:${e.id}:0` && new Date(pp.observeeLe).getTime() === e.debutMs && pp.remplaceeLe === null && Number(pp.npts) >= 2);
  }
  // E5 : zone a leurre, doit etre sur le troncon 2 et jamais sur son leurre
  {
    const e = evt("E5"); const a = veriteA(e.debutMs); const b = veriteA(e.finMs);
    const ps = await portionsDe(e.id);
    verifier("E5 (zone a leurre parallele a 40 m) : la portion est sur le troncon 2, jamais sur son leurre", a.rang === 2 && b.rang === 2 && ps.length === 1 && ps[0].tronconId === idTroncon(2));
    const ed = Math.abs(ps[0].debutM - await oracle(idTroncon(2)!, a.lat, a.lon)); const ef = Math.abs(ps[0].finM - await oracle(idTroncon(2)!, b.lat, b.lon));
    mesures.push(`E5 debut ${ed.toFixed(1)} m, fin ${ef.toFixed(1)} m`);
    verifier(`E5 : abscisses a ${TOL_EXTREME} m de l'oracle (debut ${ed.toFixed(1)} m, fin ${ef.toFixed(1)} m)`, ed < TOL_EXTREME && ef < TOL_EXTREME);
  }
  // E2 : deux troncons
  {
    const e = evt("E2"); const a = veriteA(e.debutMs); const b = veriteA(e.finMs);
    const ps = await portionsDe(e.id);
    verifier("E2 (a cheval sur deux troncons) : 2 portions, rang 5 puis rang 6, toutes deux croissantes",
      a.rang === 5 && b.rang === 6 && ps.length === 2 && ps[0].tronconId === idTroncon(5) && ps[1].tronconId === idTroncon(6) && ps.every((x) => x.sens === "CROISSANT"));
    const l5 = await longueurTroncon(idTroncon(5)!);
    const e1 = Math.abs(ps[0].debutM - await oracle(idTroncon(5)!, a.lat, a.lon)); const e2 = Math.abs(ps[1].finM - await oracle(idTroncon(6)!, b.lat, b.lon));
    const i1 = Math.abs(ps[0].finM - l5); const i2 = Math.abs(ps[1].debutM - 0);
    mesures.push(`E2 debut ${e1.toFixed(1)} m, fin ${e2.toFixed(1)} m, jonction ${i1.toFixed(1)} / ${i2.toFixed(1)} m`);
    verifier(`E2 : debut et fin a ${TOL_EXTREME} m de l'oracle (${e1.toFixed(1)} m, ${e2.toFixed(1)} m)`, e1 < TOL_EXTREME && e2 < TOL_EXTREME);
    verifier(`E2 : la jonction des deux portions est a moins de ${TOL_INTERNE} m des extremites des troncons (${i1.toFixed(1)} m, ${i2.toFixed(1)} m)`, i1 < TOL_INTERNE && i2 < TOL_INTERNE);
  }
  // E3 : a cheval sur 5 km hors referentiel
  {
    const e = evt("E3"); const a = veriteA(e.debutMs); const b = veriteA(e.finMs);
    const ps = await portionsDe(e.id);
    verifier("E3 (a cheval sur 5 km hors referentiel) : 2 portions seulement, rang 6 puis rang 8 ; le troncon absent n'est pas invente",
      a.rang === 6 && b.rang === 8 && ps.length === 2 && ps[0].tronconId === idTroncon(6) && ps[1].tronconId === idTroncon(8));
    const l6 = await longueurTroncon(idTroncon(6)!);
    const e1 = Math.abs(ps[0].debutM - await oracle(idTroncon(6)!, a.lat, a.lon)); const e2 = Math.abs(ps[1].finM - await oracle(idTroncon(8)!, b.lat, b.lon));
    const i1 = Math.abs(ps[0].finM - l6); const i2 = Math.abs(ps[1].debutM);
    mesures.push(`E3 debut ${e1.toFixed(1)} m, fin ${e2.toFixed(1)} m, bords ${i1.toFixed(1)} / ${i2.toFixed(1)} m`);
    verifier(`E3 : debut et fin a ${TOL_EXTREME} m de l'oracle (${e1.toFixed(1)} m, ${e2.toFixed(1)} m)`, e1 < TOL_EXTREME && e2 < TOL_EXTREME);
    verifier(`E3 : les bords cote hors referentiel sont a moins de ${TOL_INTERNE} m des extremites des troncons (${i1.toFixed(1)} m, ${i2.toFixed(1)} m)`, i1 < TOL_INTERNE && i2 < TOL_INTERNE);
  }
  // E6 abandonne, E7 trop court, E8 recouvre une validee
  {
    const e6 = parIdE.get(evt("E6").id)!;
    verifier("E6 (abandonne par l'agent) : conserve, statut ABANDONNE, AUCUNE portion", e6.statutRattachement === "ABANDONNE" && (await portionsDe(evt("E6").id)).length === 0);
    const e7 = parIdE.get(evt("E7").id)!;
    verifier("E7 (~9 m au pas) : portion REFUSEE par le service de portions (TROP_COURTE), evenement conserve", e7.statutRattachement === "PORTIONS_REFUSEES" && e7.motif === "TROP_COURTE" && (await portionsDe(evt("E7").id)).length === 0, e7);
    const e8 = parIdE.get(evt("E8").id)!;
    verifier("E8 (sur une portion deja VALIDEE) : REFUSEE (CHEVAUCHE_UNE_VALIDEE), la validee est intacte", e8.statutRattachement === "PORTIONS_REFUSEES" && e8.motif === "CHEVAUCHE_UNE_VALIDEE"
      && (await compte("portions", `id = 'p-validee-11' AND "debutM" = 1500 AND "finM" = 3000 AND "remplaceeLe" IS NULL AND "deletedAt" IS NULL`)) === 1, e8);
  }
  console.log(`Evenements, erreurs d'abscisse vs oracle SQL : ${mesures.join(" ; ")}`);

  // ---------- 7. audit, operation, aucune suppression
  const portionsCreees = apres.portionsRoulage - avant.portionsRoulage;
  verifier(`audit : 1 ligne SessionRoulage + ${portionsCreees} lignes Portion (une par portion creee), toutes dans la transaction`,
    apres.auditSession - avant.auditSession === 1 && apres.auditPortion - avant.auditPortion === portionsCreees && portionsCreees === 6, { portionsCreees });
  const [aud] = await prisma.$queryRawUnsafe(`SELECT "userId", action, "after" FROM audit_logs WHERE "entityType" = 'SessionRoulage' AND "entityId" = $1`, p.sessionId) as Record<string, any>[];
  const apresAudit = JSON.stringify(aud?.after ?? null);
  verifier("audit : l'auteur est l'agent et la trace brute n'y figure pas (seulement son effectif)", aud?.userId === USER && aud?.action === "CREATE" && !apresAudit.includes('"points"') && apresAudit.includes(`"nbPoints":${p.points.length}`));
  const [opSync] = await prisma.$queryRawUnsafe(`SELECT statut, payload FROM operations_sync WHERE "operationId" = $1`, op.operationId) as Record<string, any>[];
  verifier("operations_sync : SYNCHRONISE, charge reduite a un resume (l'effectif des points, pas la trace)", opSync.statut === "SYNCHRONISE" && opSync.payload.redacted === true && opSync.payload.points === p.points.length);
  verifier("aucune suppression physique : rien n'a ete efface (portions, troncons) et `deletedAt` reste nul sur la session", (await compte("sessions_roulage", `"deletedAt" IS NOT NULL`)) === 0 && (await compte("portions")) >= avant.portions);

  // ---------- 8. contrats refuses sans rien ecrire
  const avantRefus = await etatBase();
  const avecIri = await appliquer({ ...op, operationId: uid(6, 1), entityId: uid(6, 1), payload: { ...p, sessionId: uid(6, 1), iri: [{ debutM: 0, finM: 100, iriMParKm: 2.1 }] } }, ctxAgent);
  verifier("une charge qui porte un IRI est REFUSEE (PAYLOAD_INVALIDE), definitivement", avecIri.statut === "REJETE" && avecIri.motif === "PAYLOAD_INVALIDE" && avecIri.reessayerDansMs === undefined, avecIri);
  const incoherent = await appliquer({ ...op, operationId: uid(6, 2), entityId: uid(6, 3), payload: { ...p, sessionId: uid(6, 2) } }, ctxAgent);
  verifier("entityId different de la session de la charge : ENTITE_INCOHERENTE", incoherent.statut === "REJETE" && incoherent.motif === "ENTITE_INCOHERENTE", incoherent);
  const missionAutrui = await appliquer({ ...op, operationId: uid(6, 4), entityId: uid(6, 4), payload: { ...p, sessionId: uid(6, 4), missionId: uid(6, 99) } }, ctxAgent);
  verifier("mission inconnue de l'agent : MISSION_NON_AUTORISEE", missionAutrui.statut === "REJETE" && missionAutrui.motif === "MISSION_NON_AUTORISEE", missionAutrui);
  const apresRefus = await etatBase();
  verifier("ces trois refus n'ont ecrit ni session, ni marqueur, ni evenement, ni portion (3 traces de rejet seulement)",
    JSON.stringify({ ...apresRefus, operations: 0 }) === JSON.stringify({ ...avantRefus, operations: 0 }) && apresRefus.operations === avantRefus.operations + 3);

  // ---------- 9. territoire (A10) : un compte regional d'une autre region
  const SID = uid(7, 1);
  const regional = await appliquer({ ...op, operationId: SID, entityId: SID, payload: { ...p, sessionId: SID } }, { appareilId: uid(1, 2), userId: USER_REG });
  verifier("territoire : un compte regional d'une AUTRE region voit sa session enregistree", regional.statut === "SYNCHRONISE", regional);
  const portionsRegional = await compte("portions", `"source" = 'roulage:${SID}'`);
  const refusRegional = await prisma.$queryRawUnsafe(`SELECT count(*) AS n FROM evenements_roulage WHERE "sessionId" = $1 AND "statutRattachement" = 'PORTIONS_REFUSEES' AND motif = 'HORS_PERIMETRE'`, SID) as { n: bigint }[];
  verifier("territoire : ... mais AUCUNE portion n'est creee hors de son perimetre (les 6 evenements rattaches sont HORS_PERIMETRE)", portionsRegional === 0 && Number(refusRegional[0].n) === 6, { portionsRegional, refus: Number(refusRegional[0].n) });
  verifier("territoire : ses marqueurs restent enregistres (ce ne sont pas des ecritures patrimoniales)", (await compte("marqueurs_roulage", `"sessionId" = '${SID}'`)) === 28);

  console.log(`Temps : appareil ${msAppareil.toFixed(0)} ms pour 7 200 s simulees ; appliquer ${(msPush / 1000).toFixed(1)} s (analyse HMM + ecriture) pour ${p.points.length} points`);
  conclure();
}

try {
  await main();
} catch (e) {
  console.error(e);
  process.exitCode = 2;
} finally {
  await prisma.$disconnect();
  await supprimerClone(ORIGINE!, NOM_CLONE);
  console.log(`clone ${NOM_CLONE} supprime`);
}

// Banc de PERFORMANCE des scenarios d'acceptation A15 et A20 : voir tests-integration/perf/README.md.
//
//   DATABASE_URL=postgresql://utilisateur:motdepasse@127.0.0.1:5434/replay \
//     npx tsx tests-integration/perf/perf.integration.ts [--nombre 20000] [--iterations 200] [--sortie fichier.json]
//
// Cree le clone `essai_perf` depuis `replay`, y charge un reseau synthetique deterministe, mesure
// (avant correctifs), applique les migrations de performance du depot (plage 20261023200000 a
// 20261023299999), mesure de nouveau (apres), compare aux seuils du cahier, puis supprime le clone.
// `--sans-correctifs` saute l'etape migrations : le verdict porte alors sur l'etat d'origine, ce qui
// sert de contre-epreuve (le banc doit echouer si un seuil est depasse).
import "../lib/garde";
import { spawn, execSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";
import { supprimerClone } from "../lib/clone";
import { verifier, conclure } from "../lib/verdict";
import { preparerClone } from "./lib/preparation";
import { genererPoints } from "./lib/points-gps";
import { GRAINE_DEFAUT } from "./lib/reseau-synthetique";
import { resumer } from "./lib/stats";
import {
  mesurerCarte, mesurerDeviation, mesurerRattachement, mesurerRecherche, mesurerTrace, mesurerConstructionGraphe, ouvrirContexte, fermerContexte, premiersAppels,
  ecarterJournalHttp, PARAMETRES_DEVIATION, type Contexte, type OctetsCarte, type Options, type ResultatMesure,
} from "./lib/mesures";
import { capturerPlans } from "./lib/plans";

const arg = (nom: string, defaut?: string) => { const i = process.argv.indexOf(`--${nom}`); return i >= 0 ? process.argv[i + 1] : defaut; };
const drapeau = (nom: string) => process.argv.includes(`--${nom}`);

const NOMBRE = Number(arg("nombre", "20000"));
const ITERATIONS = Number(arg("iterations", "200"));
const ECHAUFFEMENT = Number(arg("echauffement", "20"));
const NOM_CLONE = arg("nom", "essai_perf")!;
const GRAINE = Number(arg("graine", String(GRAINE_DEFAUT)));
const NB_FROID = Number(arg("froid", "8"));
const SORTIE = arg("sortie");
const SANS_CORRECTIFS = drapeau("sans-correctifs");
const GARDER = drapeau("garder");
/** Mise au point : saute la phase d'origine (migrations de performance appliquees d'emblee). Le verdict ne vaut alors que pour l'etat apres correctifs. */
const SANS_AVANT = drapeau("sans-avant");
const MODE_ENFANT = drapeau("froid-enfant");
/** Mise au point : ne mesure que ces familles (rattachement, recherche, trace, graphe, deviation, carte), separees par des virgules. Sans l'option, tout est mesure. */
const FAMILLES = arg("familles")?.split(",").map((s) => s.trim());
const veut = (famille: string) => FAMILLES === undefined || FAMILLES.includes(famille);

const DOSSIER_BANC = path.resolve(__dirname);
const DOSSIER_MIGRATIONS = path.resolve(__dirname, "../../prisma/migrations");
const PLAGE = { debut: "20261023200000", fin: "20261023299999" };

/** Profils reseau pour la duree de transfert theorique (voir le document de mesures pour les sources). */
const PROFILS_3G = {
  "optimiste (Lighthouse mobileSlow4G, ex 'Fast 3G') : 1,6 Mbit/s, RTT 150 ms": { kbps: 1600, rttMs: 150 },
  "pessimiste (Chrome DevTools '3G') : 400 kbit/s, RTT 400 ms": { kbps: 400, rttMs: 400 },
} as const;
const RTT_AVANT_DONNEES = 3; // TCP + TLS 1.3 + requete/premier octet
export const transfert3GMs = (octets: number, p: { kbps: number; rttMs: number }) => RTT_AVANT_DONNEES * p.rttMs + (octets * 8) / p.kbps;

interface Phase {
  libelle: "avant" | "apres";
  chargeCpuPct: number | null;
  mesures: ResultatMesure[];
  octetsCarte: OctetsCarte[];
  geoportail: { octetsGzip: number; octetsBruts: number; troncons: number };
  froid: { connexionMs: number; appels: Record<string, number> }[];
  plans: Record<string, string>;
  migrationsAppliquees: string[];
}

function chargeCpu(): number | null {
  try {
    const s = execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average"', { encoding: "utf8", timeout: 20_000 }).trim();
    const v = Number(s);
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}

function environnement() {
  let docker: string | null = null;
  try { docker = execSync('docker info --format "CPUs={{.NCPU}} Memoire={{.MemTotal}} Serveur={{.ServerVersion}} OS={{.OperatingSystem}}"', { encoding: "utf8", timeout: 20_000 }).trim(); } catch { /* docker absent */ }
  const cpus = os.cpus();
  return {
    date: new Date().toISOString(),
    systeme: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: `${cpus[0]?.model ?? "?"} x${cpus.length}`,
    memoireGo: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
    node: process.version,
    docker,
  };
}

async function reglagesBase(url: string) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const noms = ["shared_buffers", "work_mem", "max_parallel_workers_per_gather", "jit", "effective_cache_size", "random_page_cost", "max_connections"];
    const r: Record<string, string> = {};
    for (const n of noms) r[n] = (await c.query<{ s: string }>(`SELECT current_setting($1) AS s`, [n])).rows[0].s;
    r.version = (await c.query<{ v: string }>("SELECT version() AS v")).rows[0].v;
    r.postgis = (await c.query<{ v: string }>("SELECT postgis_lib_version() AS v")).rows[0].v;
    return r;
  } finally { await c.end(); }
}

function migrationsPerf(): { nom: string; sql: string }[] {
  return readdirSync(DOSSIER_MIGRATIONS)
    .filter((d) => d >= PLAGE.debut && d <= `${PLAGE.fin}_zzz`)
    .sort()
    .map((d) => ({ nom: d, sql: readFileSync(path.join(DOSSIER_MIGRATIONS, d, "migration.sql"), "utf8") }));
}

async function appliquerMigrations(url: string): Promise<string[]> {
  const liste = migrationsPerf();
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    for (const m of liste) {
      console.log(`  migration ${m.nom}`);
      await c.query(m.sql);
    }
    await c.query("VACUUM (ANALYZE) troncons");
  } finally { await c.end(); }
  return liste.map((m) => m.nom);
}

/** Lance NB_FROID processus neufs : chacun mesure la premiere requete de chaque famille. */
async function mesurerFroid(urlClone: string, nombre: number): Promise<Phase["froid"]> {
  const sorties: Phase["froid"] = [];
  for (let k = 0; k < NB_FROID; k += 1) {
    const sortie = await new Promise<string>((ok, ko) => {
      const e = spawn(process.execPath, ["--import", "tsx", path.join(DOSSIER_BANC, "perf.integration.ts"), "--froid-enfant", "--nombre", String(nombre), "--graine", String(GRAINE)], {
        env: { ...process.env, DATABASE_URL: urlClone }, cwd: path.resolve(DOSSIER_BANC, "../.."),
      });
      let o = "", er = "";
      e.stdout.on("data", (d: Buffer) => { o += d.toString(); });
      e.stderr.on("data", (d: Buffer) => { er += d.toString(); });
      e.on("close", (code) => (code === 0 ? ok(o) : ko(new Error(`enfant froid code ${code}: ${er.slice(0, 500)}`))));
    });
    const ligne = sortie.split("\n").find((l) => l.startsWith("FROID "));
    if (!ligne) throw new Error(`sortie froid illisible : ${sortie.slice(0, 300)}`);
    sorties.push(JSON.parse(ligne.slice(6)));
  }
  return sorties;
}

async function executerPhase(libelle: Phase["libelle"], urlClone: string, ctxArgs: { reseau: Contexte["reseau"]; points: Contexte["points"]; options: Options }): Promise<Phase> {
  console.log(`\n===== PHASE ${libelle.toUpperCase()} =====`);
  const cpu = chargeCpu();
  console.log(`charge CPU de la machine au demarrage de la phase : ${cpu ?? "inconnue"} %`);
  const froid = await mesurerFroid(urlClone, ctxArgs.reseau.nombre);
  const c = await ouvrirContexte({ urlClone, ...ctxArgs, graine: GRAINE });
  try {
    ecarterJournalHttp(true);
    console.log("\n-- rattachement (A15)");
    const rat = veut("rattachement") ? await mesurerRattachement(c) : [];
    console.log("\n-- recherche (A20)");
    const rec = veut("recherche") ? await mesurerRecherche(c) : [];
    console.log("\n-- graphe et deviation (A20)");
    const tra = veut("trace") ? await mesurerTrace(c) : [];
    const cg = veut("graphe") ? await mesurerConstructionGraphe(c) : [];
    const dev = veut("deviation") ? await mesurerDeviation(c) : [];
    console.log("\n-- carte publique et geoportail");
    const car = veut("carte") ? await mesurerCarte(c) : { mesures: [], octets: [], geoportail: { octetsGzip: 0, octetsBruts: 0, troncons: 0 } };
    ecarterJournalHttp(false);
    console.log("\n-- plans d'execution");
    const plans = await capturerPlans(c, urlClone);
    return {
      libelle, chargeCpuPct: cpu, mesures: [...rat, ...rec, ...tra, ...cg, ...dev, ...car.mesures], octetsCarte: car.octets,
      geoportail: car.geoportail, froid, plans, migrationsAppliquees: [],
    };
  } finally {
    ecarterJournalHttp(false);
    await fermerContexte(c);
  }
}

function tableau(phase: Phase) {
  for (const m of phase.mesures) {
    const seuil = m.seuilP95Ms === null ? "" : (m.resume.p95Ms < m.seuilP95Ms ? "  ok" : "  DEPASSE");
    console.log(`${phase.libelle}  ${m.id.padEnd(60)} p50=${String(m.resume.p50Ms).padStart(8)} p95=${String(m.resume.p95Ms).padStart(8)} p99=${String(m.resume.p99Ms).padStart(8)}${seuil}`);
  }
}

function appliquerVerdict(phase: Phase) {
  const par = (id: string) => phase.mesures.find((m) => m.id === id);
  console.log(`\n===== VERDICT (etat ${phase.libelle === "apres" ? "apres correctifs" : "d'origine"}) =====`);
  // 1) Tout scenario qui porte un seuil du cahier : p95 strictement inferieur au seuil, n >= 200.
  for (const m of phase.mesures.filter((x) => x.seuilP95Ms !== null)) {
    verifier(`${m.id} : p95 ${m.resume.p95Ms} ms < ${m.seuilP95Ms} ms (n=${m.resume.n})`, m.resume.p95Ms < (m.seuilP95Ms as number) && m.resume.n >= 200, m.resume);
  }
  // 2) Aucune requete HTTP en erreur serveur ou d'authentification : un chiffre sur une 401 ne prouve rien.
  for (const m of phase.mesures.filter((x) => x.niveau === "http")) {
    const notes = (m.extra.notes ?? {}) as Record<string, number>;
    const mauvais = Object.keys(notes).filter((k) => /HTTP (4(?!22)|5)/.test(k) && !/^HTTP 422/.test(k));
    verifier(`${m.id} : aucune reponse 4xx/5xx inattendue`, mauvais.length === 0, notes);
  }
  // 3) Carte publique : necessaire, non suffisant. Le transfert seul, sous le profil OPTIMISTE, doit tenir dans 3 s.
  const z7 = phase.octetsCarte.find((o) => o.zoom === 7);
  if (z7) {
    const opt = Object.values(PROFILS_3G)[0];
    const ms = transfert3GMs(z7.octetsGzip, opt);
    verifier(`carte publique zoom 7 : transfert seul sous le profil 3G optimiste ${Math.round(ms)} ms < 3000 ms (${z7.octetsGzip} octets gzip) -- condition necessaire, le rendu n'est pas mesure ici`, ms < 3000, { ms });
  }
  // 4) La deviation doit aboutir a une reponse exploitable pour la plupart des coupures : sinon la vitesse ne dit rien.
  for (const id of ["deviation.calcul.service"]) {
    const m = par(id);
    if (m) {
      const notes = (m.extra.notes ?? {}) as Record<string, number>;
      const tropLarge = notes["refus EMPRISE_TROP_LARGE"] ?? 0;
      verifier(`${id} : moins de 5 % de refus EMPRISE_TROP_LARGE sur ${m.resume.n} coupures (${tropLarge} refus)`, tropLarge / m.resume.n < 0.05, notes);
    }
  }
}

async function enfantFroid() {
  const { genererReseau } = await import("./lib/reseau-synthetique");
  const reseau = genererReseau({ nombre: NOMBRE, graine: GRAINE });
  const points = genererPoints(reseau, { graine: GRAINE + 2, parGroupe: ITERATIONS + ECHAUFFEMENT + 30 });
  const options: Options = { iterations: ITERATIONS, echauffement: ECHAUFFEMENT, parGroupe: ITERATIONS + ECHAUFFEMENT + 30, grandeEchelle: NOMBRE > 100_000 };
  const c = await ouvrirContexte({ urlClone: process.env.DATABASE_URL!, reseau, points, options, graine: GRAINE });
  try {
    ecarterJournalHttp(true);
    const r = await premiersAppels(c);
    ecarterJournalHttp(false);
    console.log(`FROID ${JSON.stringify(r)}`);
  } finally { ecarterJournalHttp(false); await fermerContexte(c); }
}

async function main() {
  // Le poste est partage : priorite au-dessus de la normale pour le processus du banc (cela ne protege
  // ni PostgreSQL, qui tourne dans la machine virtuelle de Docker, ni les autres processus ; la charge
  // de la machine est mesuree et rapportee scenario par scenario).
  try { os.setPriority(0, os.constants.priority.PRIORITY_ABOVE_NORMAL); } catch { /* droits insuffisants : sans effet */ }
  if (MODE_ENFANT) { await enfantFroid(); return; }
  const urlReplay = process.env.DATABASE_URL!;
  const env = environnement();
  console.log(`Banc de performance A15/A20 : ${NOMBRE} troncons, ${ITERATIONS} iterations (+${ECHAUFFEMENT} d'echauffement), graine ${GRAINE}`);
  console.log(JSON.stringify(env));

  const prep = await preparerClone({ urlReplay, nom: NOM_CLONE, nombre: NOMBRE, graine: GRAINE });
  console.log(`clone ${NOM_CLONE} charge : ${prep.chargement.troncons} troncons (${prep.reseau.nombreClasse} classes, ${prep.reseau.nombreVoirie} voirie), ${prep.chargement.ouvrages} ouvrages, empreinte ${prep.empreinte}`);
  console.log(JSON.stringify(prep.description));
  const reglages = await reglagesBase(prep.url);

  const parGroupe = ITERATIONS + ECHAUFFEMENT + 30;
  const points = genererPoints(prep.reseau, { graine: GRAINE + 2, parGroupe });
  const options: Options = { iterations: ITERATIONS, echauffement: ECHAUFFEMENT, parGroupe, grandeEchelle: NOMBRE > 100_000 };

  const phases: Phase[] = [];
  let echec: unknown = null;
  try {
    if (!SANS_AVANT) phases.push(await executerPhase("avant", prep.url, { reseau: prep.reseau, points, options }));
    if (!SANS_CORRECTIFS) {
      console.log("\n===== MIGRATIONS DE PERFORMANCE =====");
      const noms = await appliquerMigrations(prep.url);
      if (noms.length === 0) console.log("  aucune migration dans la plage 20261023200000-20261023299999");
      const apres = await executerPhase("apres", prep.url, { reseau: prep.reseau, points, options });
      apres.migrationsAppliquees = noms;
      phases.push(apres);
    }
  } catch (e) {
    echec = e;
  } finally {
    if (!GARDER) await supprimerClone(urlReplay, NOM_CLONE).then(() => console.log(`\nclone ${NOM_CLONE} supprime`));
  }
  if (echec) throw echec;

  for (const p of phases) tableau(p);
  const finale = phases[phases.length - 1];
  appliquerVerdict(finale);

  // Transferts 3G theoriques, pour le rapport (pas un verdict).
  const transferts = finale.octetsCarte.map((o) => ({
    zoom: o.zoom, octetsGzip: o.octetsGzip,
    ...Object.fromEntries(Object.entries(PROFILS_3G).map(([n, p]) => [n, Math.round(transfert3GMs(o.octetsGzip, p))])),
  }));
  const froidResume = (ph: Phase) => {
    const noms = ph.froid.length ? Object.keys(ph.froid[0].appels) : [];
    return Object.fromEntries([["connexionMs", resumer(ph.froid.map((f) => f.connexionMs))], ...noms.map((n) => [n, resumer(ph.froid.map((f) => f.appels[n]))])]);
  };
  const resultat = {
    meta: { ...env, reglagesBase: reglages, nombre: NOMBRE, iterations: ITERATIONS, echauffement: ECHAUFFEMENT, graine: GRAINE, empreinte: prep.empreinte, description: prep.description, chargement: prep.chargement, parametresDeviation: PARAMETRES_DEVIATION, profils3G: PROFILS_3G, rttAvantDonnees: RTT_AVANT_DONNEES },
    phases: phases.map((p) => ({ ...p, froidResume: froidResume(p) })),
    transferts3GMs: transferts,
  };
  if (SORTIE) {
    mkdirSync(path.dirname(path.resolve(SORTIE)), { recursive: true });
    writeFileSync(path.resolve(SORTIE), JSON.stringify(resultat, null, 2));
    console.log(`resultats ecrits : ${SORTIE}`);
  }
  conclure();
}

main().catch((e) => { console.error(e); process.exitCode = 2; });

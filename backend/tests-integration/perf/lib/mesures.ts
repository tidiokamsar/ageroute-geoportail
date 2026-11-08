/**
 * Les mesures elles-memes. Chaque scenario est une fonction asynchrone appelee N fois apres un
 * echauffement ; `stats.ts` en tire p50/p95/p99. Deux niveaux sont distingues :
 *
 *   service : appel direct de la fonction du depot (apparier, contexteTerrain, calculerDeviation,
 *             chargerGraphe, carteGeoHandler, requete Prisma de la recherche). Sans HTTP, sans JSON
 *             de reponse, sans compression, sans authentification.
 *   http    : requete sur la vraie application Express (voir serveur.ts), authentifiee par un jeton
 *             JWT d'un compte GESTIONNAIRE (donc avec lecture de `modulesAutorises`), avec gzip.
 *
 * Les modules de `src/` sont importes DYNAMIQUEMENT : `lib/prisma` lit DATABASE_URL a l'import, et le
 * banc ne doit viser que le clone.
 */
import { randomBytes } from "node:crypto";
import { Alea } from "./prng";
import { empriseMission, genererTrace, type GroupePoints, type PointGps } from "./points-gps";
import { distanceApprocheeM, type ReseauSynthetique, type TronconSynthetique } from "./reseau-synthetique";
import { chrono, mesurer, resumer, type Resume } from "./stats";
import { ecarterJournalHttp, jsonDe, octetsNonCompresses, demarrerServeur, type Serveur } from "./serveur";
import { EMAIL_BANC, ID_UTILISATEUR_BANC } from "./charger";
import { EchantillonneurCharge } from "./charge";

export type Famille = "rattachement" | "recherche" | "deviation" | "graphe" | "carte";

export interface ResultatMesure {
  id: string;
  famille: Famille;
  niveau: "service" | "http";
  description: string;
  resume: Resume;
  /** Seuil du cahier applique a ce scenario (p95, ms), ou null quand le cahier n'en fixe pas. */
  seuilP95Ms: number | null;
  extra: Record<string, unknown>;
}

export interface Options {
  iterations: number;
  echauffement: number;
  /** Nombre de points GPS par groupe : doit couvrir echauffement + iterations. */
  parGroupe: number;
  grandeEchelle: boolean;
}

export interface Contexte {
  reseau: ReseauSynthetique;
  points: PointGps[];
  options: Options;
  serveur: Serveur;
  jeton: string;
  mod: Modules;
  graine: number;
}

export async function chargerModules() {
  const prisma = (await import("../../../src/lib/prisma")).prisma;
  const { contexteTerrain } = await import("../../../src/field/contexte");
  const { sourcesPrisma } = await import("../../../src/field/contexte.prisma");
  const { apparier } = await import("../../../src/geo/appariement");
  const { calculerDeviation, RefusDeviationHttp } = await import("../../../src/geo/deviation.service");
  const { chargerGraphe, EmpriseTropLarge } = await import("../../../src/geo/graphe.depot");
  const { carteGeoHandler } = await import("../../../src/modules/public/public.controller");
  const { createApp } = await import("../../../src/app");
  const { signAccessToken } = await import("../../../src/utils/jwt");
  return { prisma, contexteTerrain, sourcesPrisma, apparier, calculerDeviation, RefusDeviationHttp, chargerGraphe, EmpriseTropLarge, carteGeoHandler, createApp, signAccessToken };
}
export type Modules = Awaited<ReturnType<typeof chargerModules>>;

/** Secrets JWT ALEATOIRES propres au processus du banc : rien de fixe, rien dans le depot. */
export function poserEnvironnement(urlClone: string): void {
  process.env.DATABASE_URL = urlClone;
  process.env.JWT_ACCESS_SECRET = randomBytes(32).toString("hex");
  process.env.JWT_REFRESH_SECRET = randomBytes(32).toString("hex");
  process.env.NODE_ENV = "test";
  // Le banc dure plus de 15 minutes (duree de vie par defaut du jeton) : un jeton expire donnerait des 401 mesurees comme des succes rapides.
  process.env.JWT_ACCESS_EXPIRES_IN = "12h";
}

export async function ouvrirContexte(args: { urlClone: string; reseau: ReseauSynthetique; points: PointGps[]; options: Options; graine: number }): Promise<Contexte> {
  poserEnvironnement(args.urlClone);
  const mod = await chargerModules();
  const serveur = await demarrerServeur(mod.createApp());
  const jeton = mod.signAccessToken({ sub: ID_UTILISATEUR_BANC, role: "GESTIONNAIRE", email: EMAIL_BANC });
  return { reseau: args.reseau, points: args.points, options: args.options, serveur, jeton, mod, graine: args.graine };
}

export async function fermerContexte(c: Contexte): Promise<void> {
  await c.serveur.fermer();
  await c.mod.prisma.$disconnect();
}

// ---------------------------------------------------------------------------------------------

let compteurIp = 0;
/** IP source distincte par requete : le limiteur de /api/public (60 par minute et par IP) ne mesure pas ici. */
const ipUnique = () => { compteurIp += 1; return `10.${(compteurIp >> 16) & 255}.${(compteurIp >> 8) & 255}.${compteurIp & 255}`; };

const indexPoint = (c: Contexte, i: number) => (i < 0 ? -1 - i : c.options.echauffement + i);
const pointsDe = (c: Contexte, g: GroupePoints) => c.points.filter((p) => p.groupe === g);

type Compte = Map<string, number>;
const incr = (m: Compte, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const obj = (m: Compte) => Object.fromEntries([...m.entries()].sort());

async function lancer(
  c: Contexte, id: string, famille: Famille, niveau: "service" | "http", description: string, seuilP95Ms: number | null,
  f: (i: number, notes: Compte) => Promise<unknown>,
  opts: { iterations?: number; echauffement?: number } = {},
): Promise<ResultatMesure> {
  const notes: Compte = new Map();
  const it = opts.iterations ?? c.options.iterations;
  const ec = opts.echauffement ?? c.options.echauffement;

  const ech = new EchantillonneurCharge();
  ech.demarrer();
  const { resume } = await mesurer((i) => f(i, i >= 0 ? notes : new Map()), { echauffement: ec, iterations: it }); // notes de l'echauffement ecartees
  const charge = ech.arreter();
  const r: ResultatMesure = { id, famille, niveau, description, resume, seuilP95Ms, extra: { notes: obj(notes), chargeMachine: charge } };
  console.log(`  ${id.padEnd(58)} n=${String(resume.n).padStart(3)}  p50=${String(resume.p50Ms).padStart(8)}  p95=${String(resume.p95Ms).padStart(8)}  p99=${String(resume.p99Ms).padStart(8)} ms  cpu=${charge.moyennePct}%${seuilP95Ms ? `   (seuil p95 ${seuilP95Ms})` : ""}`);
  return r;
}

const SEUIL_RATTACHEMENT_MS = 300; // A15
const SEUIL_RECHERCHE_MS = 300; // A20
const SEUIL_DEVIATION_MS = 2000; // A20

// ------------------------------------------------------------------------- rattachement (A15)

export async function mesurerRattachement(c: Contexte): Promise<ResultatMesure[]> {
  const sortie: ResultatMesure[] = [];
  const { apparier, contexteTerrain, sourcesPrisma } = c.mod;

  const defs: { g: GroupePoints; reseau: "reference" | "tout"; complet: boolean }[] = [
    { g: "classe-5m", reseau: "reference", complet: true },
    { g: "classe-15m", reseau: "reference", complet: true },
    { g: "hors-route", reseau: "reference", complet: true },
    { g: "urbain-5m", reseau: "tout", complet: false },
    { g: "urbain-15m", reseau: "tout", complet: false },
  ];
  for (const d of defs) {
    const pts = pointsDe(c, d.g);
    const tag = `${d.g}.${d.reseau}`;
    const pos = (i: number) => { const p = pts[indexPoint(c, i)]; return { lat: p.lat, lon: p.lon, precisionM: p.precisionM }; };

    sortie.push(await lancer(c, `rattachement.apparier.${tag}.service`, "rattachement", "service",
      `apparier() seul, points ${d.g}, reseau ${d.reseau}, sans emprise`, SEUIL_RATTACHEMENT_MS,
      async (i, n) => { const a = await apparier(pos(i), { reseau: d.reseau }); incr(n, a ? "apparie" : "non-apparie"); }));

    if (d.complet) {
      sortie.push(await lancer(c, `rattachement.terrain.${tag}.service`, "rattachement", "service",
        `contexteTerrain() complet (rattachement + longueur + portions + actifs), points ${d.g}`, SEUIL_RATTACHEMENT_MS,
        async (i, n) => { const r = await contexteTerrain(pos(i), sourcesPrisma, { appariement: { reseau: d.reseau } }); incr(n, r.troncon ? "apparie" : "non-apparie"); }));
    }

    sortie.push(await lancer(c, `rattachement.terrain.${tag}.http`, "rattachement", "http",
      `GET /api/v2/field/current-context, points ${d.g}${d.reseau === "tout" ? ", reseau=tout" : ""} (chemin du terrain)`, SEUIL_RATTACHEMENT_MS,
      async (i, n) => {
        const p = pos(i);
        const q = `lat=${p.lat}&lon=${p.lon}&precisionM=${p.precisionM}${d.reseau === "tout" ? "&reseau=tout" : ""}`;
        const r = await c.serveur.requete({ methode: "GET", chemin: `/api/v2/field/current-context?${q}`, jeton: c.jeton });
        incr(n, `HTTP ${r.statut}`);
      }));
  }

  // Avec emprise de mission (ce que le mode terrain hors ligne PEUT fournir ; la page actuelle n'en envoie pas).
  for (const e of [
    { g: "classe-5m" as const, reseau: "reference" as const, demi: 5 },
    { g: "urbain-5m" as const, reseau: "tout" as const, demi: 2 },
  ]) {
    const pts = pointsDe(c, e.g);
    sortie.push(await lancer(c, `rattachement.apparier.${e.g}.${e.reseau}.emprise${e.demi * 2}km.service`, "rattachement", "service",
      `apparier() avec emprise de mission ${e.demi * 2} km x ${e.demi * 2} km, reseau ${e.reseau}`, SEUIL_RATTACHEMENT_MS,
      async (i, n) => {
        const p = pts[indexPoint(c, i)];
        const a = await apparier({ lat: p.lat, lon: p.lon, precisionM: p.precisionM }, { reseau: e.reseau, emprise: empriseMission(p, e.demi) });
        incr(n, a ? "apparie" : "non-apparie");
      }));
  }

  // POST /api/v2/geo/match (apparier seul, avec authentification et controle de module).
  {
    const pts = pointsDe(c, "classe-5m");
    sortie.push(await lancer(c, "rattachement.match.classe-5m.reference.http", "rattachement", "http",
      "POST /api/v2/geo/match, points classe-5m", SEUIL_RATTACHEMENT_MS,
      async (i, n) => {
        const p = pts[indexPoint(c, i)];
        const r = await c.serveur.requete({ methode: "POST", chemin: "/api/v2/geo/match", corps: { lat: p.lat, lon: p.lon, precisionM: p.precisionM }, jeton: c.jeton });
        incr(n, `HTTP ${r.statut}`);
      }));
  }

  // Concurrence : 10 agents simultanes sur le chemin du terrain (latence de CHAQUE requete).
  {
    const pts = pointsDe(c, "classe-5m");
    const par = 10, chacun = Math.ceil((c.options.iterations * 2) / par);
    const lat: number[] = [];
    const statuts: Compte = new Map();
    const t0 = process.hrtime.bigint();
    await Promise.all(Array.from({ length: par }, async (_, w) => {
      for (let k = 0; k < chacun; k += 1) {
        const p = pts[(w * chacun + k) % pts.length];
        const { ms, valeur } = await chrono(() => c.serveur.requete({ methode: "GET", chemin: `/api/v2/field/current-context?lat=${p.lat}&lon=${p.lon}&precisionM=${p.precisionM}`, jeton: c.jeton }));
        lat.push(ms); incr(statuts, `HTTP ${valeur.statut}`);
      }
    }));
    const dureeS = Number(process.hrtime.bigint() - t0) / 1e9;
    const resume = resumer(lat);
    sortie.push({
      id: "rattachement.terrain.classe-5m.reference.http.concurrence10", famille: "rattachement", niveau: "http",
      description: `GET current-context, ${par} clients simultanes, ${par * chacun} requetes`, resume, seuilP95Ms: SEUIL_RATTACHEMENT_MS,
      extra: { notes: obj(statuts), debitReqParS: Math.round((lat.length / dureeS) * 10) / 10, clients: par },
    });
    console.log(`  ${"rattachement.terrain...concurrence10".padEnd(58)} n=${resume.n}  p50=${resume.p50Ms}  p95=${resume.p95Ms}  p99=${resume.p99Ms} ms  (${Math.round(lat.length / dureeS)} req/s)`);
  }
  return sortie;
}

// ------------------------------------------------------------------------------ recherche (A20)

interface Requete { classe: string; q: string }

export function genererRequetesRecherche(reseau: ReseauSynthetique, graine: number, parClasse: number): Requete[] {
  const a = new Alea(graine);
  const t = reseau.troncons;
  const sortie: Requete[] = [];
  const motsFrequents = ["rue", "avenue", "route", "voie", "boulevard", "impasse"];
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  const motInconnu = (n: number) => { let s = "zq"; for (let i = 0; i < n; i += 1) s += alphabet[a.entier(0, 25)]; return s; };
  for (let k = 0; k < parClasse; k += 1) {
    const x = t[a.entier(0, t.length - 1)];
    sortie.push({ classe: "code-exact", q: x.code });
    const y = t[a.entier(0, t.length - 1)];
    const mots = y.nom.split(" ").filter((m) => m.length >= 4);
    sortie.push({ classe: "mot-de-nom", q: (mots.length ? a.choisir(mots) : y.nom).toLowerCase() });
    sortie.push({ classe: "mot-frequent", q: a.choisir(motsFrequents) });
    sortie.push({ classe: "absent", q: motInconnu(5 + (k % 4)) });
    sortie.push({ classe: "court-absent-2car", q: `${alphabet[a.entier(0, 25)]}q` });
  }
  return sortie;
}

export async function mesurerRecherche(c: Contexte): Promise<ResultatMesure[]> {
  const sortie: ResultatMesure[] = [];
  const total = c.options.iterations + c.options.echauffement;
  const reqs = genererRequetesRecherche(c.reseau, c.graine + 3, total);
  const classes = [...new Set(reqs.map((r) => r.classe))];
  for (const cl of classes) {
    const liste = reqs.filter((r) => r.classe === cl);
    const sel = (i: number) => liste[indexPoint(c, i) % liste.length].q;
    sortie.push(await lancer(c, `recherche.${cl}.http`, "recherche", "http",
      `GET /api/search?q=... (classe de requete ${cl}), 5 types d entites${cl.startsWith("court") ? " -- INFORMATIF : motif de 2 caracteres sans resultat, hors de portee d un index trigramme" : ""}`, cl.startsWith("court") ? null : SEUIL_RECHERCHE_MS,
      async (i, n) => {
        const r = await c.serveur.requete({ methode: "GET", chemin: `/api/search?q=${encodeURIComponent(sel(i))}`, jeton: c.jeton });
        incr(n, `HTTP ${r.statut}`);
      }));
  }
  // Niveau service : la requete Prisma de la route sur les troncons, seule (equivalent exact du where/take de la route).
  for (const cl of ["absent", "mot-de-nom"]) {
    const liste = reqs.filter((r) => r.classe === cl);
    const sel = (i: number) => liste[indexPoint(c, i) % liste.length].q;
    sortie.push(await lancer(c, `recherche.${cl}.service`, "recherche", "service",
      `prisma.troncon.findMany (code ou nom contient, insensible a la casse, take 5), classe ${cl}`, SEUIL_RECHERCHE_MS,
      async (i, n) => {
        const contains = { contains: sel(i), mode: "insensitive" as const };
        const r = await c.mod.prisma.troncon.findMany({ where: { deletedAt: null, OR: [{ code: contains }, { nom: contains }] }, select: { id: true, code: true, nom: true }, take: 5 });
        incr(n, r.length > 0 ? "avec-resultat" : "sans-resultat");
      }));
  }
  return sortie;
}

// ----------------------------------------------------------------------- trace (7.3, informatif)

/** Analyse d'une trace de 3 km (60 points, un tous les 50 m, bruit 5 m) : le cahier ne fixe aucun seuil. */
export async function mesurerTrace(c: Contexte): Promise<ResultatMesure[]> {
  const sortie: ResultatMesure[] = [];
  const { prisma } = c.mod;
  const { analyserTrace } = await import("../../../src/geo/trace.service");
  const total = c.options.iterations + c.options.echauffement;
  const tronconsLongs = choisirCoupures(c.reseau, c.graine + 5, total);
  const trace = (i: number) => genererTrace(tronconsLongs[indexPoint(c, i) % tronconsLongs.length].t, { graine: c.graine + 6 + indexPoint(c, i), pasM: 50, sigmaM: 5, longueurM: 3_000 });
  const echTrace = Math.min(c.options.echauffement, 10);
  for (const [id, opts, desc] of [
    ["trace.analyse.reference.service", {}, "analyserTrace() 60 points, reseau classe, sans graphe"],
    ["trace.analyse.reference-graphe.service", { toleranceFusionM: 5 }, "analyserTrace() 60 points, reseau classe, avec graphe (tolerance 5 m, emprise de la trace + 2 km)"],
  ] as const) {
    sortie.push(await lancer(c, id, "rattachement", "service", `${desc} (informatif)`, null,
      async (i, n) => {
        try {
          const r = await analyserTrace(prisma, { points: trace(i) }, { reseau: "reference", ...opts });
          incr(n, r.indicateurs.tauxRattachement >= 0.8 ? "taux>=80%" : "taux<80%");
        } catch (e) {
          incr(n, `refus ${(e as { code?: string }).code ?? (e as Error).name}`);
        }
      }, { echauffement: echTrace }));
  }
  return sortie;
}

// ------------------------------------------------- construction du graphe, avant et apres l'index

/**
 * Chronometre la construction du graphe seule (sans SQL), d'ORIGINE puis INDEXEE, sur les MEMES entrees :
 * les troncons de 12 emprises de 50 km, lus une fois. Informatif (n = 12, pas de seuil) : c'est la preuve
 * rejouable de la correction de `construireGraphe`, dont l'equivalence est testee par
 * `src/geo/graphe.noyau.equivalence.test.ts`.
 */
export async function mesurerConstructionGraphe(c: Contexte, nombre = 12): Promise<ResultatMesure[]> {
  const { prisma } = c.mod;
  const { construireGraphe } = await import("../../../src/geo/graphe.noyau");
  const { construireGrapheReference } = await import("../../../src/geo/graphe.noyau.reference");
  const coupures = choisirCoupures(c.reseau, c.graine + 4, nombre);
  const entrees: { id: string; longueurM: number; coordonnees: [number, number][] }[][] = [];
  for (const k of coupures) {
    const lignes = await prisma.$queryRaw<{ id: string; longueurM: number; geojson: string }[]>`
      SELECT t."id", ST_Length(t."geom"::geography) AS "longueurM", ST_AsGeoJSON(t."geom") AS "geojson"
        FROM "troncons" t
       WHERE t."deletedAt" IS NULL AND t."geom" IS NOT NULL
         AND t."geom" && (SELECT ST_Envelope(ST_Buffer(geom::geography, ${PARAMETRES_DEVIATION.distanceMaxM / 2}::double precision)::geometry) FROM troncons WHERE id = ${k.t.id})
       LIMIT 20000`;
    entrees.push(lignes.map((l) => ({ id: l.id, longueurM: Number(l.longueurM), coordonnees: (JSON.parse(l.geojson) as { coordinates: [number, number][] }).coordinates })));
  }
  const tol = PARAMETRES_DEVIATION.toleranceFusionM;
  const indexee: number[] = [], origine: number[] = [], tailles: number[] = [];
  for (const e of entrees) {
    tailles.push(e.length);
    indexee.push((await chrono(async () => construireGraphe(e, tol))).ms);
    origine.push((await chrono(async () => construireGrapheReference(e, tol))).ms);
  }
  const med = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
  const sortie: ResultatMesure[] = [];
  for (const [id, mesures, desc] of [
    ["graphe.construction.indexee.service", indexee, "construireGraphe() actuel (index spatial des extremites)"],
    ["graphe.construction.origine.service", origine, "construction d'ORIGINE (commit 2943e22), memes entrees"],
  ] as const) {
    const resume = resumer(mesures);
    sortie.push({ id, famille: "graphe", niveau: "service", description: `${desc}, ${entrees.length} emprises de 50 km (informatif)`, resume, seuilP95Ms: null, extra: { tronconsParEmpriseMedian: med(tailles), tronconsParEmpriseMax: Math.max(...tailles) } });
    console.log(`  ${id.padEnd(58)} n=${String(resume.n).padStart(3)}  p50=${String(resume.p50Ms).padStart(8)}  p95=${String(resume.p95Ms).padStart(8)}  max=${String(resume.maxMs).padStart(8)} ms  (troncons: med ${med(tailles)}, max ${Math.max(...tailles)})`);
  }
  return sortie;
}

// ----------------------------------------------------------------------- graphe et deviation (A20)

export function choisirCoupures(reseau: ReseauSynthetique, graine: number, nombre: number): { t: TronconSynthetique; debutM: number; finM: number }[] {
  const a = new Alea(graine);
  const candidats = reseau.troncons.filter((t) => t.categorie === "CLASSE").map((t) => ({ t, L: t.coordonnees.reduce((s, c, i) => (i ? s + distanceApprocheeM(t.coordonnees[i - 1], c) : 0), 0) })).filter((x) => x.L >= 3_000);
  const sortie: { t: TronconSynthetique; debutM: number; finM: number }[] = [];
  for (let k = 0; k < nombre; k += 1) {
    const { t, L } = candidats[a.entier(0, candidats.length - 1)];
    const milieu = (L * 0.97) / 2; // 3 % de marge : longueur planaire ici, geodesique dans le graphe
    sortie.push({ t, debutM: Math.round(milieu - 250), finM: Math.round(milieu + 250) });
  }
  return sortie;
}

export const PARAMETRES_DEVIATION = { distanceMaxM: 50_000, toleranceFusionM: 5 } as const;

export async function mesurerDeviation(c: Contexte): Promise<ResultatMesure[]> {
  const sortie: ResultatMesure[] = [];
  const { calculerDeviation, chargerGraphe, RefusDeviationHttp, EmpriseTropLarge, prisma } = c.mod;
  const total = c.options.iterations + c.options.echauffement;
  const coupures = choisirCoupures(c.reseau, c.graine + 4, total);
  const cp = (i: number) => coupures[indexPoint(c, i) % coupures.length];
  const echDev = Math.min(c.options.echauffement, 10);

  // Chargement du graphe seul : emprise = buffer de distanceMax/2 autour du troncon, comme le service.
  const emprises: { ouest: number; sud: number; est: number; nord: number }[] = [];
  for (const k of coupures) {
    const [r] = await prisma.$queryRaw<{ o: number; s: number; e: number; n: number }[]>`
      SELECT ST_XMin(b) AS o, ST_YMin(b) AS s, ST_XMax(b) AS e, ST_YMax(b) AS n
        FROM (SELECT ST_Envelope(ST_Buffer(geom::geography, ${PARAMETRES_DEVIATION.distanceMaxM / 2}::double precision)::geometry) AS b FROM troncons WHERE id = ${k.t.id}) x`;
    emprises.push({ ouest: r.o, sud: r.s, est: r.e, nord: r.n });
  }
  const em = (i: number) => emprises[indexPoint(c, i) % emprises.length];
  const nbTr: number[] = [];
  const noeuds: number[] = [];

  sortie.push(await lancer(c, "graphe.requete-sql.service", "graphe", "service",
    "requete SQL de chargement du graphe seule (troncons de l'emprise, ST_AsGeoJSON), sans construction", null,
    async (i, n) => {
      const e = em(i);
      const lignes = await prisma.$queryRaw<{ id: string; longueurM: number; geojson: string }[]>`
        SELECT t."id", ST_Length(t."geom"::geography) AS "longueurM", ST_AsGeoJSON(t."geom") AS "geojson"
          FROM "troncons" t
         WHERE t."deletedAt" IS NULL AND t."geom" IS NOT NULL
           AND t."geom" && ST_MakeEnvelope(${e.ouest}, ${e.sud}, ${e.est}, ${e.nord}, 4326)
         LIMIT 20001`;
      if (i >= 0) nbTr.push(lignes.length);
      incr(n, lignes.length > 20_000 ? "plafond-atteint" : "sous-plafond");
    }, { echauffement: echDev }));

  sortie.push(await lancer(c, "graphe.chargement.service", "graphe", "service",
    "chargerGraphe() complet : requete + JSON.parse + construction du graphe (tolerance 5 m), emprise distanceMax/2 = 25 km", null,
    async (i, n) => {
      try {
        const r = await chargerGraphe(prisma, em(i), PARAMETRES_DEVIATION.toleranceFusionM);
        if (i >= 0) noeuds.push(r.graphe.nbNoeuds);
        incr(n, "charge");
      } catch (e) {
        if (e instanceof EmpriseTropLarge) incr(n, "EMPRISE_TROP_LARGE"); else throw e;
      }
    }, { echauffement: echDev }));
  sortie[sortie.length - 1].extra.noeudsMedian = noeuds.length ? [...noeuds].sort((a, b) => a - b)[Math.floor(noeuds.length / 2)] : null;
  sortie[sortie.length - 2].extra.tronconsChargesMedian = nbTr.length ? [...nbTr].sort((a, b) => a - b)[Math.floor(nbTr.length / 2)] : null;
  sortie[sortie.length - 2].extra.tronconsChargesMax = nbTr.length ? Math.max(...nbTr) : null;

  sortie.push(await lancer(c, "deviation.calcul.service", "deviation", "service",
    "calculerDeviation() : coupure de 500 m au milieu d'un troncon classe, distanceMax 50 km, tolerance 5 m (charge + Dijkstra + geometrie)", SEUIL_DEVIATION_MS,
    async (i, n) => {
      const k = cp(i);
      try {
        const r = await calculerDeviation(prisma, { tronconId: k.t.id, debutM: k.debutM, finM: k.finM, ...PARAMETRES_DEVIATION });
        void r;
        incr(n, "deviation-trouvee");
      } catch (e) {
        if (e instanceof RefusDeviationHttp) incr(n, `refus ${e.code}`);
        else if (e instanceof EmpriseTropLarge) incr(n, "refus EMPRISE_TROP_LARGE");
        else throw e;
      }
    }, { echauffement: echDev }));

  sortie.push(await lancer(c, "deviation.calcul.http", "deviation", "http",
    "POST /api/v2/geo/deviation, memes parametres (authentification + module geoportail + JSON + gzip)", SEUIL_DEVIATION_MS,
    async (i, n) => {
      const k = cp(i);
      const r = await c.serveur.requete({ methode: "POST", chemin: "/api/v2/geo/deviation", corps: { tronconId: k.t.id, debutM: k.debutM, finM: k.finM, ...PARAMETRES_DEVIATION }, jeton: c.jeton });
      let code = `HTTP ${r.statut}`;
      if (r.statut !== 200) { const j = jsonDe(r) as { code?: string }; code += ` ${j.code ?? ""}`; }
      incr(n, code.trim());
    }, { echauffement: echDev }));

  // Detour admissible plus long (100 km) : INFORMATIF, sans seuil. Le cahier ne dit pas quelle borne de
  // detour le « < 2 s » suppose ; la borne de 50 km ci-dessus est celle du verdict, celle-ci montre ce
  // que coute le double (emprise 4 fois plus grande).
  sortie.push(await lancer(c, "deviation.calcul-100km.service", "deviation", "service",
    "calculerDeviation(), meme coupure, distanceMax 100 km (informatif)", null,
    async (i, n) => {
      const k = cp(i);
      try {
        await calculerDeviation(prisma, { tronconId: k.t.id, debutM: k.debutM, finM: k.finM, distanceMaxM: 100_000, toleranceFusionM: PARAMETRES_DEVIATION.toleranceFusionM });
        incr(n, "deviation-trouvee");
      } catch (e) {
        if (e instanceof RefusDeviationHttp) incr(n, `refus ${e.code}`);
        else if (e instanceof EmpriseTropLarge) incr(n, "refus EMPRISE_TROP_LARGE");
        else throw e;
      }
    }, { echauffement: 2, iterations: Math.min(c.options.iterations, 20) }));
  return sortie;
}

// --------------------------------------------------------------------------- carte publique (A20)

export interface OctetsCarte { zoom: number; octetsGzip: number; octetsBruts: number; troncons: number }

export async function mesurerCarte(c: Contexte): Promise<{ mesures: ResultatMesure[]; octets: OctetsCarte[]; geoportail: { octetsGzip: number; octetsBruts: number; troncons: number } }> {
  const mesures: ResultatMesure[] = [];
  const octets: OctetsCarte[] = [];
  const echCarte = Math.min(c.options.echauffement, 10);
  for (const zoom of [7, 11, 14, 16]) {
    mesures.push(await lancer(c, `carte-publique.zoom${zoom}.http`, "carte", "http",
      `GET /api/public/carte/geo?zoom=${zoom} (temps serveur + JSON + gzip, sans rendu)`, null,
      async (_i, n) => {
        const r = await c.serveur.requete({ methode: "GET", chemin: `/api/public/carte/geo?zoom=${zoom}`, ip: ipUnique() });
        incr(n, `HTTP ${r.statut} ${r.encodage ?? "non-compresse"}`);
      }, { echauffement: echCarte }));
    const r = await c.serveur.requete({ methode: "GET", chemin: `/api/public/carte/geo?zoom=${zoom}`, ip: ipUnique() });
    const j = jsonDe(r) as { troncons: unknown[] };
    octets.push({ zoom, octetsGzip: r.octets, octetsBruts: octetsNonCompresses(r), troncons: j.troncons.length });
  }
  mesures[0].extra.octets = octets[0];
  mesures[1].extra.octets = octets[1];
  mesures[2].extra.octets = octets[2];
  mesures[3].extra.octets = octets[3];

  const handler = c.mod.carteGeoHandler;
  mesures.push(await lancer(c, "carte-publique.zoom7.service", "carte", "service",
    "carteGeoHandler (zoom 7) : 5 requetes SQL + assemblage, sans serialisation ni compression", null,
    async (_i, n) => {
      let corps: unknown = null;
      await new Promise<void>((ok, ko) => {
        const res = { json: (x: unknown) => { corps = x; ok(); } } as never;
        void handler({ query: { zoom: "7" } } as never, res, (e?: unknown) => (e ? ko(e) : ok()));
      });
      incr(n, corps ? "ok" : "vide");
    }, { echauffement: echCarte }));

  // Couche principale du geoportail connecte : tous les troncons classes, geometrie non simplifiee.
  let geo = { octetsGzip: 0, octetsBruts: 0, troncons: 0 };
  mesures.push(await lancer(c, "geoportail.troncons-geo.http", "carte", "http",
    "GET /api/troncons/geo (couche reseau du geoportail connecte, non simplifiee)", null,
    async (_i, n) => {
      const r = await c.serveur.requete({ methode: "GET", chemin: "/api/troncons/geo", jeton: c.jeton });
      incr(n, `HTTP ${r.statut} ${r.encodage ?? "non-compresse"}`);
    }, { echauffement: echCarte }));
  {
    const r = await c.serveur.requete({ methode: "GET", chemin: "/api/troncons/geo", jeton: c.jeton });
    geo = { octetsGzip: r.octets, octetsBruts: octetsNonCompresses(r), troncons: (jsonDe(r) as unknown[]).length };
    mesures[mesures.length - 1].extra.octets = geo;
  }
  return { mesures, octets, geoportail: geo };
}

// ------------------------------------------------------------------------------- froid (1er appel)

export interface PremiersAppels { connexionMs: number; appels: Record<string, number> }

/** Executee dans un processus NEUF : la premiere requete de chaque famille, et le temps de connexion. */
export async function premiersAppels(c: Contexte): Promise<PremiersAppels> {
  const t0 = process.hrtime.bigint();
  await c.mod.prisma.$connect();
  const connexionMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const appels: Record<string, number> = {};
  const p = pointsDe(c, "classe-5m")[0];
  const q = genererRequetesRecherche(c.reseau, c.graine + 3, 3).find((r) => r.classe === "code-exact")!;
  const k = choisirCoupures(c.reseau, c.graine + 4, 1)[0];
  const horloge = async (nom: string, f: () => Promise<unknown>) => { appels[nom] = (await chrono(f)).ms; };
  await horloge("rattachement.terrain.http", () => c.serveur.requete({ methode: "GET", chemin: `/api/v2/field/current-context?lat=${p.lat}&lon=${p.lon}&precisionM=5`, jeton: c.jeton }));
  await horloge("rattachement.terrain.http.2e-appel", () => c.serveur.requete({ methode: "GET", chemin: `/api/v2/field/current-context?lat=${p.lat}&lon=${p.lon}&precisionM=5`, jeton: c.jeton }));
  await horloge("recherche.code-exact.http", () => c.serveur.requete({ methode: "GET", chemin: `/api/search?q=${encodeURIComponent(q.q)}`, jeton: c.jeton }));
  await horloge("carte-publique.zoom7.http", () => c.serveur.requete({ methode: "GET", chemin: "/api/public/carte/geo?zoom=7", ip: ipUnique() }));
  await horloge("deviation.http", () => c.serveur.requete({ methode: "POST", chemin: "/api/v2/geo/deviation", corps: { tronconId: k.t.id, debutM: k.debutM, finM: k.finM, ...PARAMETRES_DEVIATION }, jeton: c.jeton }));
  return { connexionMs, appels };
}

export { ecarterJournalHttp };

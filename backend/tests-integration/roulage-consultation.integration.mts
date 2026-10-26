// Banc d'integration de la CONSULTATION des releves en roulage. Voir tests-integration/README.md et
// docs/roulage/CONSULTATION.md. Lancer (DATABASE_URL pointe sur `replay`, jamais ecrite : le banc travaille dans
// le clone `essai_roulage_consultation`, cree puis detruit par lui) :
//   npx tsx tests-integration/roulage-consultation.integration.mts
//
// LE DEFAUT QUE CE BANC DEFEND : un releve en roulage envoye au serveur etait enregistre mais ne se relisait nulle
// part. Le banc fait donc le chemin entier :
//   1. des releves sont ECRITS par le vrai service de synchronisation (`field/sync.service.appliquer`, donc
//      `preparerSessionRoulage` puis `ecrireSessionRoulage`, avec analyse HMM, portions, audit), pour plusieurs agents ;
//   2. ils sont RELUS par l'application entiere (`createApp()`), avec de vrais comptes (jetons signes par des secrets
//      aleatoires, role et modules lus en base, perimetre lu en base), contre PostGIS.
//
// CE QUE LE BANC PROUVE
//   - un releve envoye par l'agent A est visible de A et de l'ADMIN (et d'un GESTIONNAIRE national), pas de l'agent B ;
//   - un GESTIONNAIRE regional voit ses propres releves et ceux dont un troncon traverse est dans sa region, pas les autres ;
//     un releve sans troncon rattache n'est vu que de son auteur et d'un compte national ; un releve supprime logiquement
//     est invisible de tous, ADMIN compris ;
//   - 404 IDENTIQUE (meme corps) pour inexistant, hors perimetre, supprime et identifiant mal forme ;
//   - le GeoJSON rendu a la bonne longueur (oracle : `ST_Length` de la geometrie stockee) et autant de sommets que de
//     points ; marqueurs, evenements et portions sont rendus, comparables aux lignes SQL ecrites ;
//   - pagination par curseur : pas de doublon ni de saut, y compris quand deux releves ont le meme instant de debut ;
//   - une trace de 25 000 points : geometrie simplifiee (et dit), points bruts bornes a 20 000 (et dit) ;
//   - les lectures n'ecrivent rien (audit_logs et tables de roulage inchangees) ; aucun e-mail dans les reponses ;
//   - entrees hostiles : jamais de 500.
//
// CE QUE LE BANC NE PROUVE PAS : les releves sont des traces SYNTHETIQUES (une droite parcourue a vitesse constante,
// sans bruit GNSS, hors la trace de 25 000 points) ; aucun telephone ; les chiffres de temps sont ceux d'un poste de
// developpement, pas ceux d'un serveur de production.
import { randomUUID } from "node:crypto";
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure, proche } from "./lib/verdict.ts";

// server.ts pose ce correctif au demarrage (les montants BigInt sortent en chaine) ; createApp() ne le porte pas.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function () { return this.toString(); };

const banc = await ouvrirBancClone(process.env.BANC_CLONE ?? "essai_roulage_consultation", { migrations: ["20261024100000_sessions_roulage"] });
// Le plafond de debit de /api/v2 compterait les centaines d'appels du banc : il est desactive (0), comme le permet l'env.
process.env.RATE_LIMIT_V2_MAX = "0";
const { prisma } = await banc.imp("lib/prisma");
const { createApp } = await banc.imp("app");
const { signAccessToken } = await banc.imp("utils/jwt");
const { appliquer } = await banc.imp("field/sync.service");
const { decoderCurseur } = await banc.imp("roulage/consultation.noyau");
const request = (await import("supertest")).default;
const app = createApp();

const sql = async <T = Record<string, unknown>>(texte: string, ...params: unknown[]): Promise<T[]> => prisma.$queryRawUnsafe(texte, ...params);
const compter = async (texte: string, ...params: unknown[]): Promise<number> => Number((await sql<{ n: bigint }>(texte, ...params))[0].n);
const jeton = (u: { id: string; role: string; email: string }) => signAccessToken({ sub: u.id, role: u.role, email: u.email });
type Rep = { status: number; body: any; headers: Record<string, string> }; // eslint-disable-line @typescript-eslint/no-explicit-any
const get = (token: string, url: string): Promise<Rep> => request(app).get(url).set("Authorization", `Bearer ${token}`) as unknown as Promise<Rep>;

// ------------------------------------------------------------------ fabrique de releves (chemin d'ecriture REEL)

const uid = (famille: number, n: number) => `${String(famille).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LAT = 9.64;
const LON0 = -13.6;
const M_PAR_DEG_LON = 111_319.49 * Math.cos((LAT * Math.PI) / 180);
const lonA = (sM: number) => LON0 + sM / M_PAR_DEG_LON;
const JOUR = 86_400_000;
const T_BASE = Date.UTC(2026, 9, 10, 8, 0, 0); // 10 octobre 2026, 08:00 UTC
const PARAMETRES = {
  intervalleAttenduMs: 1000, precisionMaxM: 50, refuserSansPrecision: false, vitesseMaxKmH: 200, trouMs: 5000, coupureSegmentMs: 30000,
  fixFigeEchantillons: 10, vitesseMouvementMs: 1, reancrageApresRejets: 5, deriveHorlogeMs: 2000, ageFixMaxMarqueurMs: 2000,
  budgetLatenceLogicielleMs: 200, dureeMinEvenementMs: 1000, couvertureMinEvenement: 0.8, distanceMinEvenementM: 10,
};

interface Position { lat: number; lon: number }
interface Plan {
  id: string;
  debutMs: number;
  nPoints: number;
  /** Position de la trace a la seconde i. */
  position: (i: number) => Position;
  /** Marqueurs : seconde de pose. */
  marqueurs?: number[];
  /** Evenements : [seconde de debut, seconde de fin, code d'etat | null]. */
  evenements?: [number, number, string | null][];
}

function charge(plan: Plan) {
  const repere = (i: number) => { const p = plan.position(i); return { tMs: plan.debutMs + i * 1000, lat: p.lat, lon: p.lon, precisionM: 5, ageFixMs: 0, positionPerimee: false }; };
  const points = Array.from({ length: plan.nPoints }, (_, i) => { const p = plan.position(i); return [plan.debutMs + i * 1000, p.lat, p.lon, 5, 10, 0]; });
  return {
    versionContrat: 1, sessionId: plan.id, missionId: null, debutMs: plan.debutMs, finMs: plan.debutMs + (plan.nPoints - 1) * 1000,
    provenanceParametres: "PROVISOIRE_NON_CALIBRE", parametres: PARAMETRES, points,
    marqueurs: (plan.marqueurs ?? []).map((s, k) => ({ id: uid(0xa1, plan.nPoints * 10 + k + Number(plan.id.slice(-4))), code: "NID_DE_POULE", note: k === 0 ? "premier marqueur" : null, repere: repere(s), latenceLogicielleMs: 30 })),
    evenements: (plan.evenements ?? []).map(([d, f, etat], k) => ({
      id: uid(0xb2, plan.nPoints * 10 + k + Number(plan.id.slice(-4))), code: "ETAT_CHAUSSEE", note: null, statut: "CLOS",
      qualification: etat ? { etat } : null, debut: repere(d), fin: repere(f), couvertureGnss: 1, distanceDirecteM: null, avertissements: [], motifAbandon: null,
    })),
    trous: [], interruptions: [], pauses: [], compteurs: { rejets: {}, sansPrecision: 0, alertes: 0 },
  };
}

/** Sur la droite des troncons, a vitesse constante de 10 m/s, en partant de l'abscisse `departM`. */
const surLaRoute = (departM: number) => (i: number): Position => ({ lat: LAT, lon: lonA(departM + 10 * i) });
/** Loin du reseau : aucun troncon a portee, aucun rattachement. */
const horsReseau = (i: number): Position => ({ lat: 9.9, lon: lonA(10 * i) });

/** PRNG deterministe (mulberry32) : la trace bruitee du banc est la meme a chaque lancement. */
function prng(graine: number) { let a = graine; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const alea = prng(20261026);
const M_PAR_DEG_LAT = 110_574;
/** 25 000 points sur un tour de cercle de 3 km de rayon, avec un bruit de 3 m : la simplification a quelque chose a faire. */
const cercleBruite = (i: number): Position => {
  const a = (2 * Math.PI * i) / 25_000;
  return {
    lat: 9.95 + (3000 * Math.sin(a) + (alea() - 0.5) * 6) / M_PAR_DEG_LAT,
    lon: -13.5 + (3000 * Math.cos(a) + (alea() - 0.5) * 6) / (111_319.49 * Math.cos((9.95 * Math.PI) / 180)),
  };
};

// ------------------------------------------------------------------ geometrie

const rad = (d: number) => (d * Math.PI) / 180;

async function main() {
  const nom = (n: string) => `${n}@roulage-consultation.invalid`;

  // ---------- fixtures : regions, comptes, appareils, referentiel, deux troncons contigus (R1 puis R2)
  await sql(`INSERT INTO regions (nom) VALUES ('Region consultation 1'), ('Region consultation 2')`);
  const regionId = async (n: string) => Number((await sql<{ id: number }>(`SELECT id FROM regions WHERE nom = $1`, n))[0].id);
  const [R1, R2] = [await regionId("Region consultation 1"), await regionId("Region consultation 2")];
  const MODULES = ["inspections", "geoportail"];
  const mkUser = (email: string, role: string, modulesAutorises: string[], nomComplet = email) =>
    prisma.user.create({ data: { email: nom(email), nomComplet, passwordHash: "x", role, modulesAutorises } });
  const admin = await mkUser("admin", "ADMIN", []);
  const agentA = await mkUser("agent-a", "INSPECTEUR", MODULES, "Agent Alpha");
  const agentB = await mkUser("agent-b", "INSPECTEUR", MODULES, "Agent Bravo");
  const lecteur = await mkUser("lecteur", "LECTEUR", MODULES, "Lecteur Lima");
  const gestNat = await mkUser("gest-national", "GESTIONNAIRE", MODULES, "Gestionnaire National");
  const gestR1 = await mkUser("gest-r1", "GESTIONNAIRE", MODULES, "Gestionnaire Region 1");
  const gestR2 = await mkUser("gest-r2", "GESTIONNAIRE", MODULES, "Gestionnaire Region 2");
  const sansModule = await mkUser("sans-module", "INSPECTEUR", ["geoportail"]);
  await sql(`INSERT INTO perimetres_comptes ("userId", "regionId", "accordeParId") VALUES ($1, $3, $5), ($2, $4, $5)`, gestR1.id, gestR2.id, R1, R2, admin.id);
  const T = { admin: jeton(admin), a: jeton(agentA), b: jeton(agentB), lect: jeton(lecteur), nat: jeton(gestNat), r1: jeton(gestR1), r2: jeton(gestR2), sans: jeton(sansModule) };
  const appareil: Record<string, string> = {};
  let nApp = 0;
  for (const u of [agentA, agentB, gestR1]) {
    appareil[u.id] = uid(0xc3, (nApp += 1));
    await sql(`INSERT INTO appareils (id, "userId", plateforme, "updatedAt") VALUES ($1, $2, 'android', now())`, appareil[u.id], u.id);
  }
  await sql(`INSERT INTO referentiel_etats_chaussee (code, libelle, ordre, actif, critique, "updatedAt") VALUES ('MAUVAIS', 'Mauvais', 3, true, false, now())`);

  const wkt = (s0: number, s1: number) => `LINESTRING(${lonA(s0)} ${LAT}, ${lonA(s1)} ${LAT})`;
  const mkTroncon = (id: string, code: string, rid: number, s0: number, s1: number) =>
    sql(`INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt")
         VALUES ($1, $2, $3, 'RN', $4, 1.5, 'BITUME', 0, 1.5, ST_GeomFromText($5, 4326), now())`, id, code, `Route ${code}`, rid, wkt(s0, s1));
  await mkTroncon("t-cons-1", "CONS-1", R1, 0, 1500);
  await mkTroncon("t-cons-2", "CONS-2", R2, 1500, 3000);

  // ---------- les releves, ecrits par le chemin d'ecriture reel
  const j = (n: number, h = 0) => T_BASE + n * JOUR + h * 3_600_000;
  const plans: Record<string, { agent: typeof agentA; plan: Plan }> = {
    // Traverse T1 (R1) puis T2 (R2) : deux marqueurs, un evenement sur T1, un evenement a cheval sur T1 et T2.
    A1: { agent: agentA, plan: { id: uid(1, 1), debutMs: j(1), nPoints: 281, position: surLaRoute(200), marqueurs: [40, 230], evenements: [[20, 70, "MAUVAIS"], [110, 160, "MAUVAIS"]] } },
    // T2 seulement (R2).
    A2: { agent: agentA, plan: { id: uid(1, 2), debutMs: j(2), nPoints: 71, position: surLaRoute(2100), marqueurs: [30], evenements: [[10, 60, "MAUVAIS"]] } },
    // T1 seulement (R1), autre agent.
    B1: { agent: agentB, plan: { id: uid(1, 3), debutMs: j(3), nPoints: 61, position: surLaRoute(800), evenements: [[15, 45, "MAUVAIS"]] } },
    // Hors reseau : un marqueur et un evenement NON_RATTACHES.
    C1: { agent: agentA, plan: { id: uid(1, 4), debutMs: j(4), nPoints: 90, position: horsReseau, marqueurs: [20], evenements: [[20, 60, null]] } },
    // Deux releves au MEME instant (departage par l'identifiant), puis deux autres.
    P1: { agent: agentA, plan: { id: uid(1, 5), debutMs: j(5), nPoints: 30, position: horsReseau } },
    P2: { agent: agentA, plan: { id: uid(1, 6), debutMs: j(5), nPoints: 30, position: horsReseau } },
    P3: { agent: agentA, plan: { id: uid(1, 7), debutMs: j(6), nPoints: 30, position: horsReseau } },
    P4: { agent: agentA, plan: { id: uid(1, 8), debutMs: j(7), nPoints: 30, position: horsReseau } },
    // Releve d'un GESTIONNAIRE regional, sans troncon : il n'est vu que de lui et d'un compte national.
    G1: { agent: gestR1, plan: { id: uid(1, 9), debutMs: j(8), nPoints: 30, position: horsReseau } },
    // Releve de B avec une portion sur T2, qui sera supprime logiquement.
    D1: { agent: agentB, plan: { id: uid(1, 10), debutMs: j(9), nPoints: 41, position: surLaRoute(2600), evenements: [[15, 35, "MAUVAIS"]] } },
    // Trace de 25 000 points (plafond de reponse : 20 000 ; sommets d'affichage : 5 000).
    GROS: { agent: agentA, plan: { id: uid(1, 11), debutMs: j(10), nPoints: 25_000, position: cercleBruite } },
  };
  const id = (k: string) => plans[k].plan.id;
  const compterLiens = (k: string) => compter(`SELECT count(*) n FROM evenements_roulage_portions WHERE "sessionId" = $1`, id(k));

  for (const [cle, { agent, plan }] of Object.entries(plans)) {
    const p = charge(plan);
    const t0 = performance.now();
    const r = await appliquer(
      { operationId: plan.id, entityType: "SessionRoulage", entityId: plan.id, operation: "CREATE", baseVersion: null, payload: p },
      { appareilId: appareil[agent.id], userId: agent.id },
    );
    const ms = performance.now() - t0;
    verifier(`ecriture ${cle} : ${p.points.length} points, ${p.marqueurs.length} marqueurs, ${p.evenements.length} evenements, envoyes par le vrai service de synchronisation (${(ms / 1000).toFixed(1)} s)`, r.statut === "SYNCHRONISE", r);
    if (r.statut !== "SYNCHRONISE") { conclure(); return; }
  }
  await sql(`UPDATE sessions_roulage SET "deletedAt" = now() WHERE id = $1`, id("D1"));

  const liensA1 = await compterLiens("A1");
  verifier("fabrique : A1 a bien produit ses portions (evenement sur T1 + evenement a cheval sur T1 et T2 = 3 liens), B1 1, A2 1, D1 1, C1 aucun",
    liensA1 === 3 && (await compterLiens("B1")) === 1 && (await compterLiens("A2")) === 1 && (await compterLiens("D1")) === 1 && (await compterLiens("C1")) === 0,
    { A1: liensA1, B1: await compterLiens("B1"), A2: await compterLiens("A2"), D1: await compterLiens("D1"), C1: await compterLiens("C1") });

  const tous = Object.keys(plans).filter((k) => k !== "D1").map(id); // 10 visibles d'un compte national
  const ordre = async (ids: string[]) => (await sql<{ id: string }>(`SELECT id FROM sessions_roulage WHERE id = ANY($1) ORDER BY "debutA" DESC, id ASC`, ids)).map((l) => l.id);
  const idsListe = (r: Rep) => (r.body.items as { id: string }[]).map((i) => i.id);
  const trier = (a: string[]) => [...a].sort();
  const memes = (a: string[], b: string[]) => JSON.stringify(trier(a)) === JSON.stringify(trier(b));

  // ================================================================ 1. VISIBILITE
  console.log("\n== 1. Qui voit quoi ==");
  const attendusA = ["A1", "A2", "C1", "P1", "P2", "P3", "P4", "GROS"].map(id);
  const lA = await get(T.a, "/api/v2/roulage/sessions?limite=100");
  verifier("le releve envoye par l'agent A est VISIBLE de A : sa liste contient exactement ses 8 releves (pas ceux de B ni de G), total = 8",
    lA.status === 200 && memes(idsListe(lA), attendusA) && lA.body.total === 8, [lA.status, idsListe(lA).length, lA.body.total]);
  const lAdmin = await get(T.admin, "/api/v2/roulage/sessions?limite=100");
  verifier("... et de l'ADMIN : 10 releves (tous, sauf le supprime D1)", lAdmin.status === 200 && memes(idsListe(lAdmin), tous) && lAdmin.body.total === 10, [lAdmin.status, lAdmin.body.total]);
  const lNat = await get(T.nat, "/api/v2/roulage/sessions?limite=100");
  verifier("... et d'un GESTIONNAIRE national (sans perimetre) : les 10", lNat.status === 200 && memes(idsListe(lNat), tous), [lNat.status, lNat.body.total]);
  const lB = await get(T.b, "/api/v2/roulage/sessions?limite=100");
  verifier("... mais PAS de l'agent B : il ne voit que B1 (D1, supprime, n'apparait pas), total = 1", lB.status === 200 && memes(idsListe(lB), [id("B1")]) && lB.body.total === 1, [lB.status, idsListe(lB).length, lB.body.total]);
  const lLect = await get(T.lect, "/api/v2/roulage/sessions?limite=100");
  verifier("un LECTEUR n'ayant rien envoye ne voit rien (liste vide, total 0), 200 et non une erreur", lLect.status === 200 && lLect.body.items.length === 0 && lLect.body.total === 0, lLect.body);

  // Oracle SQL independant : releves dont au moins une portion est sur un troncon de la region, plus les siens.
  const oracleRegion = async (region: number, userId: string) => (await sql<{ id: string }>(
    `SELECT s.id FROM sessions_roulage s WHERE s."deletedAt" IS NULL AND (s."userId" = $2 OR EXISTS (
       SELECT 1 FROM evenements_roulage_portions p JOIN troncons t ON t.id = p."tronconId" WHERE p."sessionId" = s.id AND t."regionId" = $1))`, region, userId)).map((l) => l.id);
  const lR1 = await get(T.r1, "/api/v2/roulage/sessions?limite=100");
  const lR2 = await get(T.r2, "/api/v2/roulage/sessions?limite=100");
  const orR1 = await oracleRegion(R1, gestR1.id);
  const orR2 = await oracleRegion(R2, gestR2.id);
  verifier("GESTIONNAIRE de la region 1 : A1 et B1 (portions sur T1) plus son propre G1 (sans troncon) ; ni A2 (region 2 seule), ni C1, ni D1 supprime",
    lR1.status === 200 && memes(idsListe(lR1), ["A1", "B1", "G1"].map(id)) && lR1.body.total === 3, [lR1.status, lR1.body.total]);
  verifier("GESTIONNAIRE de la region 2 : A1 (portion sur T2) et A2 ; ni B1, ni G1 (sans troncon), ni D1 (portion sur T2 mais supprime)",
    lR2.status === 200 && memes(idsListe(lR2), ["A1", "A2"].map(id)) && lR2.body.total === 2, [lR2.status, lR2.body.total]);
  verifier("... et c'est ce que dit un ORACLE SQL ecrit a part (portions -> troncons.regionId, plus les siens)",
    memes(idsListe(lR1), orR1) && memes(idsListe(lR2), orR2), { orR1: orR1.length, orR2: orR2.length });
  const sansTroncon = ["C1", "P1", "P2", "P3", "P4", "GROS", "G1"].map(id);
  verifier("un releve SANS troncon rattache (C1, P*, GROS, G1) n'est vu d'aucun GESTIONNAIRE regional qui n'en est pas l'auteur",
    sansTroncon.filter((i) => i !== id("G1")).every((i) => !idsListe(lR1).includes(i) && !idsListe(lR2).includes(i)) && !idsListe(lR2).includes(id("G1")));
  verifier("le total d'une liste n'est pas un oracle : il ne compte que ce que le compte voit", lA.body.total === 8 && lB.body.total === 1 && lR1.body.total === 3);

  const sansMod = await get(T.sans, "/api/v2/roulage/sessions");
  const sansModDetail = await get(T.sans, `/api/v2/roulage/sessions/${id("A1")}`);
  verifier("sans le module `inspections` : 403 en liste comme en detail", sansMod.status === 403 && sansModDetail.status === 403, [sansMod.status, sansModDetail.status]);
  const anonyme = await request(app).get("/api/v2/roulage/sessions");
  const anonymeDetail = await request(app).get(`/api/v2/roulage/sessions/${id("A1")}`);
  verifier("sans jeton : 401 en liste comme en detail", anonyme.status === 401 && anonymeDetail.status === 401, [anonyme.status, anonymeDetail.status]);

  // ================================================================ 2. DETAIL ET 404
  console.log("\n== 2. Detail et oracle ferme ==");
  const dA = await get(T.a, `/api/v2/roulage/sessions/${id("A1")}`);
  const dAdmin = await get(T.admin, `/api/v2/roulage/sessions/${id("A1")}`);
  const dNat = await get(T.nat, `/api/v2/roulage/sessions/${id("A1")}`);
  const dR1 = await get(T.r1, `/api/v2/roulage/sessions/${id("A1")}`);
  const dR2 = await get(T.r2, `/api/v2/roulage/sessions/${id("A1")}`);
  verifier("detail de A1 : 200 pour le proprietaire, l'ADMIN, le national et les deux gestionnaires regionaux (A1 traverse R1 et R2)",
    [dA, dAdmin, dNat, dR1, dR2].every((r) => r.status === 200 && r.body.id === id("A1")), [dA, dAdmin, dNat, dR1, dR2].map((r) => r.status));
  const d404 = await get(T.b, `/api/v2/roulage/sessions/${id("A1")}`);
  const dAbsent = await get(T.admin, `/api/v2/roulage/sessions/${randomUUID()}`);
  const dSupprime = await get(T.admin, `/api/v2/roulage/sessions/${id("D1")}`);
  const dSupprimeProprio = await get(T.b, `/api/v2/roulage/sessions/${id("D1")}`);
  const dHorsRegion = await get(T.r1, `/api/v2/roulage/sessions/${id("A2")}`);
  const dSansTroncon = await get(T.r1, `/api/v2/roulage/sessions/${id("C1")}`);
  const dMalForme = await get(T.admin, "/api/v2/roulage/sessions/pas-un-identifiant");
  const dInjection = await get(T.admin, `/api/v2/roulage/sessions/${encodeURIComponent("' OR 1=1 --")}`);
  const dParamsHostiles = await get(T.b, `/api/v2/roulage/sessions/${id("A1")}?avecPoints=zzz&limite=999`);
  const dAbsentHostile = await get(T.admin, `/api/v2/roulage/sessions/${randomUUID()}?avecPoints=zzz`);
  const quatreCentQuatre = [d404, dAbsent, dSupprime, dSupprimeProprio, dHorsRegion, dSansTroncon, dMalForme, dInjection, dParamsHostiles, dAbsentHostile];
  verifier("ORACLE FERME : releve d'un autre agent, inexistant, supprime (meme pour l'ADMIN et son auteur), hors region, sans troncon, id mal forme, injection, parametres hostiles = 404 au MEME CORPS",
    quatreCentQuatre.every((r) => r.status === 404 && JSON.stringify(r.body) === JSON.stringify(dAbsent.body)) && dAbsent.body.code === "RELEVE_INTROUVABLE",
    quatreCentQuatre.map((r) => r.status));
  const dBad = await get(T.a, `/api/v2/roulage/sessions/${id("A1")}?avecPoints=zzz`);
  verifier("un parametre invalide sur un releve VISIBLE est un 400 (pas un 404)", dBad.status === 400 && dBad.body.code === "PARAMETRE_INVALIDE", [dBad.status, dBad.body]);

  // ================================================================ 3. CONTENU DU DETAIL contre la base
  console.log("\n== 3. Contenu du detail ==");
  const d = dA.body;
  const [ligne] = await sql<Record<string, any>>( // eslint-disable-line @typescript-eslint/no-explicit-any
    `SELECT "nbPoints", "tauxRattachement", "provenanceParametres", ST_NPoints(geom) AS "sommets", ST_Length(geom::geography) AS "longueur",
            ST_AsText(geom) AS wkt, "createdAt", "analyse", compteurs, parametres, to_char("debutA", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS debut, to_char("finA", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS fin
       FROM sessions_roulage WHERE id = $1`, id("A1"));
  verifier("resume : debutA, finA et duree (280 s) lus de la base ; nbPoints 281 ; agent = {id, nom} sans e-mail",
    d.debutA === ligne.debut && d.finA === ligne.fin && d.dureeS === 280 && d.nbPoints === 281 && Number(ligne.nbPoints) === 281
    && JSON.stringify(d.agent) === JSON.stringify({ id: agentA.id, nom: "Agent Alpha" }), { debutA: d.debutA, base: ligne.debut, agent: d.agent });
  verifier("resume : tauxRattachement = valeur stockee (entre 0 et 1), missionId nul", d.tauxRattachement === Number(ligne.tauxRattachement) && d.tauxRattachement > 0 && d.tauxRattachement <= 1 && d.missionId === null, d.tauxRattachement);
  const indicateur = Number(ligne.analyse.indicateurs.distanceParcourueM);
  verifier(`resume : longueurM = distance parcourue de l'analyse serveur, LUE telle qu'ecrite (${d.longueurM} m), et plausible : a moins de 1 % de ST_Length(geom::geography) (${Number(ligne.longueur).toFixed(1)} m, oracle SQL)`,
    d.longueurM === indicateur && Math.abs(d.longueurM - Number(ligne.longueur)) / Number(ligne.longueur) < 0.01, { api: d.longueurM, indicateur, sql: Number(ligne.longueur) });
  verifier(`resume : 2 marqueurs, 2 evenements, 2 troncons traverses (T1 et T2) ; longueur ~ 2 800 m (${d.longueurM} m)`,
    d.nbMarqueurs === 2 && d.nbEvenements === 2 && d.nbTronconsTraverses === 2 && proche(d.longueurM, 2800, 30), { nbMarqueurs: d.nbMarqueurs, nbEvenements: d.nbEvenements, trav: d.nbTronconsTraverses });

  // GeoJSON : bonne longueur (la geometrie RENDUE, relue par PostGIS, a la longueur de la geometrie STOCKEE) et bon nombre de sommets.
  const rendu = JSON.stringify(d.geometrie);
  const [relu] = await sql<{ longueur: number; n: number }>(`SELECT ST_Length(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography) AS longueur, ST_NPoints(ST_GeomFromGeoJSON($1)) AS n`, rendu);
  verifier(`GeoJSON : MultiLineString, ${relu.n} sommets = ${ligne.sommets} de la base, simplifiee = false`, d.geometrie.type === "MultiLineString" && Number(relu.n) === Number(ligne.sommets) && d.simplifiee === false, { n: relu.n, base: ligne.sommets });
  const ecartLongueur = Math.abs(Number(relu.longueur) - Number(ligne.longueur)) / Number(ligne.longueur);
  verifier(`GeoJSON : la geometrie rendue a la BONNE LONGUEUR (${Number(relu.longueur).toFixed(2)} m contre ${Number(ligne.longueur).toFixed(2)} m stockes ; ecart relatif ${(ecartLongueur * 100).toFixed(4)} %, arrondi a 6 decimales)`, ecartLongueur < 0.0005);
  verifier("GeoJSON : premiere et derniere coordonnees = premier et dernier point de la trace (lon, lat)",
    proche(d.geometrie.coordinates[0][0][0], lonA(200), 1e-6) && proche(d.geometrie.coordinates[0][0][1], LAT, 1e-6)
    && proche(d.geometrie.coordinates[0].at(-1)[0], lonA(200 + 10 * 280), 1e-6), d.geometrie.coordinates[0][0]);

  // Marqueurs, evenements, portions : comparables aux lignes SQL.
  const mSql = await sql<Record<string, any>>(`SELECT m.id, m.statut, m."tronconId", m."abscisseM", m."positionTraceLat", m."positionTraceLon", t.code AS "tronconCode" FROM marqueurs_roulage m LEFT JOIN troncons t ON t.id = m."tronconId" WHERE m."sessionId" = $1 ORDER BY m."poseA"`, id("A1")); // eslint-disable-line @typescript-eslint/no-explicit-any
  verifier("marqueurs : 2, dans l'ordre de pose, RATTACHES, aux troncons CONS-1 puis CONS-2, abscisse et position identiques a la base, code et note rendus",
    d.marqueurs.length === 2 && mSql.length === 2
    && d.marqueurs.every((m: any, k: number) => m.id === mSql[k].id && m.statut === "RATTACHE" && m.tronconId === mSql[k].tronconId && m.tronconCode === mSql[k].tronconCode && m.abscisseM === Number(mSql[k].abscisseM) // eslint-disable-line @typescript-eslint/no-explicit-any
      && m.lat === Number(mSql[k].positionTraceLat) && m.lon === Number(mSql[k].positionTraceLon) && m.sourcePosition === "TRACE" && m.code === "NID_DE_POULE" && m.positionPerimee === false)
    && d.marqueurs[0].tronconCode === "CONS-1" && d.marqueurs[1].tronconCode === "CONS-2" && d.marqueurs[0].note === "premier marqueur",
    d.marqueurs.map((m: any) => [m.id, m.statut, m.tronconCode, m.abscisseM])); // eslint-disable-line @typescript-eslint/no-explicit-any
  const pSql = await sql<Record<string, any>>( // eslint-disable-line @typescript-eslint/no-explicit-any
    `SELECT l."evenementId", l.rang, l."portionId", l."tronconId", l."debutM", l."finM", l.sens, t.code, t.nom FROM evenements_roulage_portions l JOIN troncons t ON t.id = l."tronconId" WHERE l."sessionId" = $1 ORDER BY l."evenementId", l.rang`, id("A1"));
  const portionsRendues = d.evenements.flatMap((e: any) => e.portions.map((p: any) => ({ ...p, evenementId: e.id }))); // eslint-disable-line @typescript-eslint/no-explicit-any
  verifier("evenements : 2 evenements (etat MAUVAIS), statut PORTIONS_CREEES ; 3 portions rendues, identiques aux lignes SQL (troncon, code, nom, bornes, sens, rang)",
    d.evenements.length === 2 && d.evenements.every((e: any) => e.statutRattachement === "PORTIONS_CREEES" && e.statutAppareil === "CLOS" && e.qualification?.etat === "MAUVAIS" && e.code === "ETAT_CHAUSSEE") // eslint-disable-line @typescript-eslint/no-explicit-any
    && portionsRendues.length === 3 && pSql.length === 3
    && memes(portionsRendues.map((p: any) => `${p.evenementId}/${p.rang}/${p.portionId}/${p.tronconId}/${p.tronconCode}/${p.tronconNom}/${p.debutM}/${p.finM}/${p.sens}`), // eslint-disable-line @typescript-eslint/no-explicit-any
      pSql.map((p) => `${p.evenementId}/${p.rang}/${p.portionId}/${p.tronconId}/${p.code}/${p.nom}/${Number(p.debutM)}/${Number(p.finM)}/${p.sens}`)),
    { rendues: portionsRendues.length, sql: pSql.length });
  const evtCheval = d.evenements.find((e: any) => e.portions.length === 2); // eslint-disable-line @typescript-eslint/no-explicit-any
  verifier("l'evenement a cheval sur T1 et T2 a 2 portions, rang 0 sur CONS-1 puis rang 1 sur CONS-2, croissantes ; les evenements sont rendus par ordre chronologique",
    !!evtCheval && evtCheval.portions[0].rang === 0 && evtCheval.portions[0].tronconCode === "CONS-1" && evtCheval.portions[1].rang === 1 && evtCheval.portions[1].tronconCode === "CONS-2"
    && evtCheval.portions.every((p: any) => p.sens === "CROISSANT") && d.evenements[0].debutA < d.evenements[1].debutA, evtCheval?.portions); // eslint-disable-line @typescript-eslint/no-explicit-any
  verifier("analyse : compteurs, trous, interruptions, pauses = colonnes de la base TELLES QUELLES ; analyse serveur et seuils de l'appareil rendus ; provenance PROVISOIRE_NON_CALIBRE",
    JSON.stringify(d.analyse.compteurs) === JSON.stringify(ligne.compteurs) && JSON.stringify(d.analyse.serveur) === JSON.stringify(ligne.analyse)
    && Array.isArray(d.analyse.trous) && Array.isArray(d.analyse.interruptions) && Array.isArray(d.analyse.pauses)
    && d.parametres.provenance === "PROVISOIRE_NON_CALIBRE" && d.parametres.versionContrat === 1 && JSON.stringify(d.parametres.seuils) === JSON.stringify(ligne.parametres));
  verifier("trace : nbPoints 281, pointsDisponibles vrai, aucun point brut par defaut", d.trace.nbPoints === 281 && d.trace.pointsDisponibles === true && d.trace.points === undefined && d.trace.tronque === undefined, d.trace);

  const dPts = await get(T.a, `/api/v2/roulage/sessions/${id("A1")}?avecPoints=1`);
  const [pb] = await sql<{ premier: unknown; dernier: unknown }>(`SELECT points -> 0 AS premier, points -> -1 AS dernier FROM sessions_roulage WHERE id = $1`, id("A1"));
  verifier("?avecPoints=1 : les 281 points bruts, premier et dernier identiques a la base, tronque = false",
    dPts.status === 200 && dPts.body.trace.points.length === 281 && dPts.body.trace.tronque === false
    && JSON.stringify(dPts.body.trace.points[0]) === JSON.stringify(pb.premier) && JSON.stringify(dPts.body.trace.points.at(-1)) === JSON.stringify(pb.dernier));

  // Un releve hors reseau : marqueur et evenement NON_RATTACHES rendus avec leur motif, sans portion.
  const dC1 = await get(T.a, `/api/v2/roulage/sessions/${id("C1")}`);
  verifier("releve hors reseau (C1) : marqueur NON_RATTACHE avec son motif, evenement NON_RATTACHE sans portion, 0 troncon traverse, taux de rattachement rendu",
    dC1.status === 200 && dC1.body.marqueurs[0].statut === "NON_RATTACHE" && !!dC1.body.marqueurs[0].motif && dC1.body.marqueurs[0].tronconCode === null
    && dC1.body.evenements[0].statutRattachement === "NON_RATTACHE" && dC1.body.evenements[0].portions.length === 0 && dC1.body.nbTronconsTraverses === 0
    && dC1.body.tauxRattachement !== undefined, { marqueur: dC1.body.marqueurs[0], evenement: dC1.body.evenements[0], taux: dC1.body.tauxRattachement });

  // ================================================================ 4. TRACE DE 25 000 POINTS
  console.log("\n== 4. Grosse trace ==");
  const tGros0 = performance.now();
  const gros = await get(T.a, `/api/v2/roulage/sessions/${id("GROS")}`);
  const msGros = performance.now() - tGros0;
  const sommetsGros = gros.body.geometrie?.coordinates?.reduce((n: number, l: unknown[]) => n + l.length, 0) ?? 0;
  const [brut] = await sql<{ n: number }>(`SELECT ST_NPoints(geom) AS n FROM sessions_roulage WHERE id = $1`, id("GROS"));
  // Ecart MAXIMAL d'un sommet de la trace stockee a la ligne simplifiee (en degres) : la distance de Hausdorff de PostGIS ne compare que des sommets.
  const [ecart] = await sql<{ h: number }>(`SELECT max(ST_Distance(dp.geom, ST_SetSRID(ST_GeomFromGeoJSON($2), 4326))) AS h FROM sessions_roulage s, LATERAL ST_DumpPoints(s.geom) dp WHERE s.id = $1`, id("GROS"), JSON.stringify(gros.body.geometrie));
  verifier(`grosse trace (${Number(brut.n)} sommets stockes) : geometrie SIMPLIFIEE pour l'affichage et le dit (simplifiee = true), ${sommetsGros} sommets <= 5 000 (${msGros.toFixed(0)} ms)`,
    gros.status === 200 && gros.body.simplifiee === true && sommetsGros > 2 && sommetsGros <= 5000 && Number(brut.n) === 25_000, { simplifiee: gros.body.simplifiee, sommetsGros, brut: brut.n });
  verifier(`... et la simplification reste fidele : ecart maximal d'un sommet stocke a la ligne simplifiee ${(Number(ecart.h) * 111_000).toFixed(1)} m (tolerance maximale essayee : 142 m)`, Number(ecart.h) <= 0.00128 + 2e-6);
  verifier("... la trace brute n'est pas touchee : 25 000 points toujours en base, nbPoints rendu 25 000", gros.body.nbPoints === 25_000 && (await compter(`SELECT jsonb_array_length(points) n FROM sessions_roulage WHERE id = $1`, id("GROS"))) === 25_000);
  const tPts0 = performance.now();
  const grosPts = await get(T.a, `/api/v2/roulage/sessions/${id("GROS")}?avecPoints=1`);
  const msPts = performance.now() - tPts0;
  const [premier] = await sql<{ p: unknown }>(`SELECT points -> 0 AS p FROM sessions_roulage WHERE id = $1`, id("GROS"));
  verifier(`?avecPoints=1 sur 25 000 points : 20 000 rendus (les premiers), tronque = true, nbPoints = 25 000 (${msPts.toFixed(0)} ms)`,
    grosPts.status === 200 && grosPts.body.trace.points.length === 20_000 && grosPts.body.trace.tronque === true && grosPts.body.trace.nbPoints === 25_000
    && JSON.stringify(grosPts.body.trace.points[0]) === JSON.stringify(premier.p), { n: grosPts.body.trace.points?.length, tronque: grosPts.body.trace.tronque });

  // ================================================================ 5. PAGINATION
  console.log("\n== 5. Pagination par curseur ==");
  const ordreA = await ordre(attendusA);
  const doublon = ordreA.findIndex((x, i) => i + 1 < ordreA.length && [id("P1"), id("P2")].includes(x) && [id("P1"), id("P2")].includes(ordreA[i + 1]));
  verifier("jeu d'essai : P1 et P2 ont le MEME instant de debut (le departage par l'identifiant est eprouve)",
    (await compter(`SELECT count(DISTINCT "debutA") n FROM sessions_roulage WHERE id IN ($1, $2)`, id("P1"), id("P2"))) === 1 && doublon >= 0);
  const parcourir = async (token: string, limite: number, extra = "") => {
    const pages: Rep[] = [];
    let curseur: string | null = null;
    for (let garde = 0; garde < 50; garde += 1) {
      const r: Rep = await get(token, `/api/v2/roulage/sessions?limite=${limite}${extra}${curseur ? `&curseur=${encodeURIComponent(curseur)}` : ""}`);
      pages.push(r);
      if (r.status !== 200 || r.body.suivant === null) break;
      curseur = r.body.suivant;
    }
    return pages;
  };
  // Limite choisie pour que la frontiere de page COUPE la paire de releves au meme instant.
  const limiteCoupe = doublon + 1;
  for (const limite of [limiteCoupe, 1, 3, 100]) {
    const pages = await parcourir(T.a, limite);
    const vus = pages.flatMap(idsListe);
    verifier(`pagination A, limite=${limite}${limite === limiteCoupe ? " (la frontiere coupe la paire au meme instant)" : ""} : ${pages.length} page(s), aucun doublon, aucun saut, ordre = ORDER BY debutA DESC, id ASC de la base, total constant`,
      pages.every((p) => p.status === 200) && vus.length === ordreA.length && new Set(vus).size === vus.length && JSON.stringify(vus) === JSON.stringify(ordreA)
      && pages.every((p) => p.body.total === 8) && pages.slice(0, -1).every((p) => p.body.items.length === limite) && pages.at(-1)!.body.suivant === null,
      { pages: pages.map((p) => p.body.items?.length), vus: vus.length });
  }
  const p1 = await get(T.a, "/api/v2/roulage/sessions?limite=2");
  const dec = decoderCurseur(p1.body.suivant);
  verifier("le curseur est opaque (base64url), strictement relu : il designe la derniere ligne rendue (debutA et id)", dec.ok && dec.curseur.id === p1.body.items[1].id && dec.curseur.debutA === p1.body.items[1].debutA && !/[=+/]/.test(p1.body.suivant), dec);
  const pagesNat = await parcourir(T.nat, 4);
  const ordreTous = await ordre(tous);
  verifier("pagination du compte national (10 releves, pages de 4) : liste complete, sans doublon, dans l'ordre de la base", JSON.stringify(pagesNat.flatMap(idsListe)) === JSON.stringify(ordreTous) && pagesNat.length === 3, pagesNat.length);
  const pagesR1 = await parcourir(T.r1, 1);
  verifier("pagination d'un GESTIONNAIRE regional (limite=1) : exactement ses 3 releves, jamais celui d'un autre", JSON.stringify(pagesR1.flatMap(idsListe)) === JSON.stringify(await ordre(["A1", "B1", "G1"].map(id))), pagesR1.length);
  // Un releve envoye pendant qu'on feuillette s'insere AU DEBUT : la page suivante ne bouge pas.
  const page1 = await get(T.a, "/api/v2/roulage/sessions?limite=3");
  const nouveau = charge({ id: uid(1, 12), debutMs: j(20), nPoints: 30, position: horsReseau });
  await appliquer({ operationId: uid(1, 12), entityType: "SessionRoulage", entityId: uid(1, 12), operation: "CREATE", baseVersion: null, payload: nouveau }, { appareilId: appareil[agentA.id], userId: agentA.id });
  const page2 = await get(T.a, `/api/v2/roulage/sessions?limite=3&curseur=${encodeURIComponent(page1.body.suivant)}`);
  verifier("un releve plus recent envoye entre deux pages ne decale pas la page suivante (curseur, pas OFFSET) : la page 2 est celle qui aurait suivi la page 1, total = 9",
    JSON.stringify(idsListe(page2)) === JSON.stringify(ordreA.slice(3, 6)) && page2.body.total === 9, { page2: idsListe(page2).length, total: page2.body.total });
  const apresNouveau = await get(T.a, "/api/v2/roulage/sessions?limite=1");
  verifier("... et ce releve est le premier de la liste de A (le plus recent d'abord)", apresNouveau.body.items[0].id === uid(1, 12));

  // ================================================================ 6. FILTRES
  console.log("\n== 6. Filtres ==");
  const fUser = await get(T.admin, `/api/v2/roulage/sessions?limite=100&userId=${agentB.id}`);
  verifier("filtre userId (ADMIN) : seulement les releves de B visibles (B1 ; D1 supprime), total 1", fUser.status === 200 && memes(idsListe(fUser), [id("B1")]) && fUser.body.total === 1, [fUser.status, fUser.body.total]);
  const fUserAutre = await get(T.b, `/api/v2/roulage/sessions?limite=100&userId=${agentA.id}`);
  verifier("filtre userId = un AUTRE agent, demande par B : liste vide et total 0 (le filtre ne contourne pas la visibilite)", fUserAutre.status === 200 && fUserAutre.body.items.length === 0 && fUserAutre.body.total === 0, fUserAutre.body.total);
  const jour = new Date(j(1)).toISOString().slice(0, 10);
  const fJour = await get(T.admin, `/api/v2/roulage/sessions?limite=100&depuis=${jour}&jusqua=${jour}`);
  verifier(`filtre depuis = jusqua = ${jour} (date seule : la journee entiere) : seulement A1, total 1`, fJour.status === 200 && memes(idsListe(fJour), [id("A1")]) && fJour.body.total === 1, [fJour.status, idsListe(fJour).length]);
  const fPlage = await get(T.admin, `/api/v2/roulage/sessions?limite=100&depuis=${new Date(j(5)).toISOString()}&jusqua=${new Date(j(6)).toISOString()}`);
  verifier("borne basse INCLUSIVE et borne haute INCLUSIVE a la milliseconde : P1, P2 (debut = depuis) et P3 (debut = jusqua), total 3", fPlage.status === 200 && memes(idsListe(fPlage), ["P1", "P2", "P3"].map(id)) && fPlage.body.total === 3, [fPlage.status, idsListe(fPlage).length]);
  const fJusquaExclu = await get(T.admin, `/api/v2/roulage/sessions?limite=100&depuis=${new Date(j(5)).toISOString()}&jusqua=${new Date(j(6) - 1).toISOString()}`);
  verifier("... et une milliseconde de moins sur jusqua exclut P3", memes(idsListe(fJusquaExclu), ["P1", "P2"].map(id)));
  const fPage = await parcourir(T.admin, 2, `&depuis=${new Date(j(5)).toISOString()}&jusqua=${new Date(j(10)).toISOString()}`);
  verifier("filtres + curseur ensemble : P1, P2, P3, P4, G1, (D1 supprime), GROS en pages de 2, total constant, sans doublon", fPage.flatMap(idsListe).length === 6 && new Set(fPage.flatMap(idsListe)).size === 6 && fPage.every((p) => p.body.total === 6), fPage.map((p) => p.body.total));

  // ================================================================ 7. ENTREES HOSTILES
  console.log("\n== 7. Entrees hostiles ==");
  const avantBase = { sessions: await compter(`SELECT count(*) n FROM sessions_roulage`), users: await compter(`SELECT count(*) n FROM users`), audit: await compter(`SELECT count(*) n FROM audit_logs`) };
  const forge = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
  const hostiles: [string, string][] = [
    ["limite=0", "limite=0"], ["limite=101", "limite=101"], ["limite=abc", "limite=abc"], ["limite=1;DROP TABLE users", "limite=1%3BDROP%20TABLE%20users"],
    ["limite repetee", "limite=1&limite=2"], ["limite objet", "limite[a]=1"],
    ["depuis=2026-02-30", "depuis=2026-02-30"], ["jusqua=2026-13-01", "jusqua=2026-13-01"], ["depuis sans fuseau", "depuis=2026-10-25T10:00:00"], ["plage inversee", "depuis=2026-10-25&jusqua=2026-10-01"],
    ["curseur n'importe quoi", "curseur=n%27importe%20quoi"], ["curseur date impossible", `curseur=${forge({ d: "2026-02-30T00:00:00.000Z", i: uid(1, 1) })}`],
    ["curseur id injecte", `curseur=${forge({ d: "2026-10-10T00:00:00.000Z", i: "x' OR '1'='1" })}`], ["curseur geant", `curseur=${"A".repeat(5000)}`],
    ["userId injecte", "userId=x%27%3B%20DROP%20TABLE%20users%3B--"], ["userId vide", "userId="],
  ];
  const statuts: string[] = [];
  let tousHostiles400 = true;
  for (const [nomCas, q] of hostiles) {
    const r = await get(T.admin, `/api/v2/roulage/sessions?${q}`);
    statuts.push(`${nomCas}:${r.status}`);
    if (r.status !== 400 || typeof r.body.error !== "string" || !["PARAMETRE_INVALIDE", "CURSEUR_INVALIDE"].includes(r.body.code)) tousHostiles400 = false;
  }
  verifier(`${hostiles.length} entrees hostiles sur la liste : toutes 400 avec { error, code }, aucune 500`, tousHostiles400, statuts);
  const curseurPlausible = await get(T.admin, `/api/v2/roulage/sessions?curseur=${forge({ d: "2026-10-10T00:00:00.000Z", i: randomUUID() })}`);
  verifier("un curseur bien forme qui designe une ligne inexistante est accepte (200) : il repart de la position, il ne prouve rien", curseurPlausible.status === 200, curseurPlausible.status);
  const apresBase = { sessions: await compter(`SELECT count(*) n FROM sessions_roulage`), users: await compter(`SELECT count(*) n FROM users`), audit: await compter(`SELECT count(*) n FROM audit_logs`) };
  verifier("les entrees hostiles n'ont rien modifie (sessions, users, audit_logs : memes comptes)", JSON.stringify(avantBase) === JSON.stringify(apresBase), { avantBase, apresBase });

  // ================================================================ 8. LES LECTURES N'ECRIVENT RIEN
  console.log("\n== 8. Lectures sans effet ==");
  const empreinte = async () => (await sql<{ h: string }>(`SELECT md5(string_agg(x::text, '|' ORDER BY x::text)) AS h FROM (
      SELECT "id", "updatedAt", "deletedAt", "nbPoints" FROM sessions_roulage UNION ALL SELECT "sessionId", NULL, NULL, 0 FROM marqueurs_roulage
      UNION ALL SELECT "sessionId", NULL, NULL, 0 FROM evenements_roulage UNION ALL SELECT "sessionId", NULL, NULL, "rang" FROM evenements_roulage_portions) x`))[0].h;
  const auditAvant = await compter(`SELECT count(*) n FROM audit_logs`);
  const hAvant = await empreinte();
  const reponses: Rep[] = [];
  for (const t of [T.a, T.admin, T.r1, T.nat]) {
    reponses.push(await get(t, "/api/v2/roulage/sessions?limite=100"), await get(t, `/api/v2/roulage/sessions/${id("A1")}?avecPoints=1`));
  }
  verifier("apres 8 lectures (liste, detail avec points) : audit_logs inchange, tables de roulage inchangees (empreinte)", (await compter(`SELECT count(*) n FROM audit_logs`)) === auditAvant && (await empreinte()) === hAvant && reponses.every((r) => r.status === 200));
  const toutTexte = JSON.stringify([lA.body, lAdmin.body, dA.body, gros.body, lR1.body]);
  verifier("aucun e-mail, hash ou secret dans les reponses (liste, detail) : le nom de l'agent seulement", !/@|passwordHash|totp/i.test(toutTexte));
  verifier("les reponses portent Cache-Control: private, no-store", [lA, dA, gros].every((r) => r.headers["cache-control"] === "private, no-store"), lA.headers["cache-control"]);

  // ================================================================ 9. UN RELEVE SUPPRIME DISPARAIT
  console.log("\n== 9. Suppression logique ==");
  const avantSuppr = await get(T.a, `/api/v2/roulage/sessions/${id("A2")}`);
  const listeAvant = await get(T.r2, "/api/v2/roulage/sessions?limite=100");
  await sql(`UPDATE sessions_roulage SET "deletedAt" = now() WHERE id = $1`, id("A2"));
  const apresSuppr = await get(T.a, `/api/v2/roulage/sessions/${id("A2")}`);
  const apresSupprAdmin = await get(T.admin, `/api/v2/roulage/sessions/${id("A2")}`);
  const listeApres = await get(T.r2, "/api/v2/roulage/sessions?limite=100");
  const listeAdminApres = await get(T.admin, "/api/v2/roulage/sessions?limite=100");
  verifier("CONTRE-EPREUVE : le MEME releve A2, 200 avant sa suppression logique, puis 404 (meme corps) pour son auteur ET pour l'ADMIN ; il disparait des listes et des totaux",
    avantSuppr.status === 200 && apresSuppr.status === 404 && apresSupprAdmin.status === 404 && JSON.stringify(apresSuppr.body) === JSON.stringify(dAbsent.body)
    && listeAvant.body.total === 2 && listeApres.body.total === 1 && !idsListe(listeApres).includes(id("A2")) && !idsListe(listeAdminApres).includes(id("A2")) && listeAdminApres.body.total === 10,
    [avantSuppr.status, apresSuppr.status, listeAvant.body.total, listeApres.body.total, listeAdminApres.body.total]);

  // ================================================================ 10. PERIMETRE LU EN BASE A CHAQUE REQUETE
  console.log("\n== 10. Contre-epreuve du perimetre ==");
  const avantP = await get(T.r1, `/api/v2/roulage/sessions/${id("B1")}`);
  await sql(`DELETE FROM perimetres_comptes WHERE "userId" = $1`, gestR1.id);
  const apresP = await get(T.r1, "/api/v2/roulage/sessions?limite=100");
  await sql(`INSERT INTO perimetres_comptes ("userId", "regionId", "accordeParId") VALUES ($1, $2, $3)`, gestR1.id, R2, admin.id);
  const versR2 = await get(T.r1, `/api/v2/roulage/sessions/${id("B1")}`);
  verifier("CONTRE-EPREUVE : le meme compte, le meme jeton : B1 visible avec le perimetre R1 (200) ; sans perimetre le compte est national (voit tout) ; rattache a R2 il ne voit plus B1 (404). C'est la base qui decide",
    avantP.status === 200 && apresP.body.total === 10 && versR2.status === 404, [avantP.status, apresP.body.total, versR2.status]);
  await sql(`UPDATE users SET role = 'LECTEUR' WHERE id = $1`, gestNat.id);
  const retrograde = await get(T.nat, "/api/v2/roulage/sessions?limite=100");
  verifier("un GESTIONNAIRE national retrograde en LECTEUR (le jeton porte encore GESTIONNAIRE) ne voit plus que ses releves : le role est celui de la base", retrograde.status === 200 && retrograde.body.total === 0, retrograde.body.total);

  // ================================================================ EXEMPLES (facultatif)
  // BANC_EXEMPLES=<fichier> : ecrit quelques REPONSES REELLES de ce lancement (pour la documentation). Aucune verification.
  if (process.env.BANC_EXEMPLES) {
    const { writeFileSync } = await import("node:fs");
    const page = await get(T.a, "/api/v2/roulage/sessions?limite=2");
    const detailA1 = JSON.parse(JSON.stringify(dA.body));
    detailA1.geometrie.coordinates = detailA1.geometrie.coordinates.map((l: unknown[]) => [...l.slice(0, 2), `... (${l.length} sommets au total)`]);
    const grosCourt = JSON.parse(JSON.stringify(gros.body));
    grosCourt.geometrie.coordinates = grosCourt.geometrie.coordinates.map((l: unknown[]) => [...l.slice(0, 2), `... (${l.length} sommets au total)`]);
    const avecPts = JSON.parse(JSON.stringify(dPts.body.trace));
    avecPts.points = [...avecPts.points.slice(0, 2), `... (${dPts.body.trace.points.length} points au total)`];
    writeFileSync(process.env.BANC_EXEMPLES, JSON.stringify({
      liste: page.body,
      detailA1,
      grosTraceSansGeometrie: { ...grosCourt, marqueurs: "...", evenements: "..." },
      avecPoints: avecPts,
      http404: { statut: dAbsent.status, corps: dAbsent.body },
      http400: { statut: dBad.status, corps: dBad.body },
      http400Curseur: (await get(T.a, "/api/v2/roulage/sessions?curseur=n%27importe%20quoi")).body,
      http403: { statut: sansMod.status, corps: sansMod.body },
    }, null, 1));
  }

  // ================================================================ 11. COUT : pire cas
  console.log("\n== 11. Cout (poste de developpement, ordre de grandeur) ==");
  await sql(`INSERT INTO sessions_roulage (id, "clientOperationId", "userId", "appareilId", "debutA", "finA", "versionContrat", "provenanceParametres", parametres, "nbPoints", points, trous, interruptions, pauses, compteurs, "analyse", "tauxRattachement", geom, "updatedAt")
             SELECT gen_random_uuid()::text, 'copie-' || g, "userId", "appareilId", "debutA" - (g || ' seconds')::interval, "finA", "versionContrat", "provenanceParametres", parametres, "nbPoints", points, trous, interruptions, pauses, compteurs, "analyse", "tauxRattachement", geom, now()
               FROM sessions_roulage, generate_series(1, 100) g WHERE id = $1`, id("GROS"));
  const mesures: number[] = [];
  let derniere: Rep | undefined;
  for (let i = 0; i < 3; i += 1) { const t0 = performance.now(); derniere = await get(T.admin, "/api/v2/roulage/sessions?limite=100"); mesures.push(performance.now() - t0); }
  mesures.sort((a, b) => a - b);
  console.log(`  liste de 100 releves de 25 000 points (pire cas, ${derniere!.body.total} releves en base) : ${mesures.map((m) => m.toFixed(0)).join(" / ")} ms (3 appels), corps ${(JSON.stringify(derniere!.body).length / 1024).toFixed(1)} Ko`);
  verifier("pire cas (100 releves de 25 000 points a la page) : 200, 100 elements, suivant non nul, moins de 5 s", derniere!.status === 200 && derniere!.body.items.length === 100 && derniere!.body.suivant !== null && mesures[1] < 5_000, mesures);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 2; })
  .finally(async () => { conclure(); await prisma.$disconnect(); await banc.fermer(); });

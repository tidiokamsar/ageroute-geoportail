// Banc de CHARGE du module Projets de voirie et reseaux (revue de securite, M2 et M4). Lancer (DATABASE_URL pointe sur `replay`) :
//   npx tsx tests-integration/projets-voirie-charge.integration.mts
// Variables : PV_CHARGE_SOMMETS_AXE (defaut 100000), PV_CHARGE_LIGNES (defaut 20000), PV_CHARGE_SANS_VERIF=1 pour ne faire que MESURER
// (mesure « avant correctifs » : aucune verification, le code de sortie reste 0).
//
// Donnees 100 % synthetiques : un axe de 100 000 sommets (un par metre environ, 100 km) et un reseau de 20 000 lignes de 10 sommets
// a moins de 25 m de l'axe, soit le scenario de la revue (axe de 3,5 Mo, reseau de 4,7 Mo, tous deux autorises).
//
// CE QUE LE BANC AFFIRME (apres correctifs) : le depot du gros reseau reste sous le delai de depot ; l'analyse repond dans le delai
// d'analyse OU par l'erreur typee ANALYSE_TROP_LONGUE (jamais un 500, jamais une requete qui continue apres la reponse : plus aucune
// requete active sur la base) ; la carte sans emprise est plafonnee ; huit analyses simultanees ne font ni 500 ni blocage de
// l'authentification des autres comptes.
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure } from "./lib/verdict.ts";

const banc = await ouvrirBancClone("essai_pv_charge", { migrations: ["20261101200000_reseaux_physiques_logiques"] });
const { prisma } = await banc.imp("lib/prisma");
const { createApp } = await banc.imp("app");
const { signAccessToken } = await banc.imp("utils/jwt");
const request = (await import("supertest")).default;
const app = createApp();
const BASE = "/api/v2/projets-voirie";
const MESURE_SEULE = process.env.PV_CHARGE_SANS_VERIF === "1";
const N_AXE = Number(process.env.PV_CHARGE_SOMMETS_AXE ?? 100_000);
const N_LIGNES = Number(process.env.PV_CHARGE_LIGNES ?? 20_000);

const mesures: string[] = [];
const ms = (t: number) => Math.round(performance.now() - t);
function mesure(nom: string, duree: number, detail = "") {
  const l = `MESURE ${nom.padEnd(58)} ${String(duree).padStart(8)} ms ${detail}`;
  mesures.push(l);
  console.log(l);
}
const sql = <T = Record<string, unknown>>(texte: string, ...v: unknown[]) => prisma.$queryRawUnsafe(texte, ...v) as Promise<T[]>;

function alea(graine: number) {
  let s = graine >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
}

async function main() {
  const admin = await prisma.user.create({ data: { email: "admin@charge.invalid", nomComplet: "Admin charge", passwordHash: "x", role: "ADMIN", modulesAutorises: [] } });
  const lecteur = await prisma.user.create({ data: { email: "lecteur@charge.invalid", nomComplet: "Lecteur charge", passwordHash: "x", role: "LECTEUR", modulesAutorises: ["projets-voirie"] } });
  const autre = await prisma.user.create({ data: { email: "autre@charge.invalid", nomComplet: "Autre compte", passwordHash: "x", role: "LECTEUR", modulesAutorises: ["troncons"] } });
  const jeton = (u: { id: string; role: string; email: string }) => signAccessToken({ sub: u.id, role: u.role, email: u.email });
  const TA = jeton(admin), TL = jeton(lecteur), TX = jeton(autre);

  const cree = await request(app).post(BASE).set("Authorization", `Bearer ${TA}`).send({ code: "CHARGE-1", nom: "Projet de charge" });
  const PID: string = cree.body.projet.id;
  const conc = (await request(app).post(`${BASE}/concessionnaires`).set("Authorization", `Bearer ${TA}`).send({ nom: "Operateur de charge", typeReseau: "TELECOM" })).body.concessionnaire.id;

  // --- Jeux de donnees synthetiques ---
  const rnd = alea(7);
  const lon0 = -10.5, pas = 0.9 / N_AXE;
  const latAxe = (i: number) => Math.round((9.2 + 0.002 * Math.sin(i / 500)) * 1e7) / 1e7;
  const axe: [number, number][] = Array.from({ length: N_AXE }, (_, i) => [Math.round((lon0 + i * pas) * 1e7) / 1e7, latAxe(i)]);
  const fAxe = Buffer.from(JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "Axe dense" }, geometry: { type: "LineString", coordinates: axe } }] }));
  const lignes = Array.from({ length: N_LIGNES }, (_, k) => {
    const p = Math.floor(rnd() * (N_AXE - 40));
    const dy = (rnd() - 0.5) * 0.00045;
    const coords: [number, number][] = Array.from({ length: 10 }, (_, j) => [axe[p + j * 3][0], Math.round((latAxe(p + j * 3) + dy) * 1e7) / 1e7]);
    return { type: "Feature", properties: { name: `circuit ${k}`, brins: 12 }, geometry: { type: "LineString", coordinates: coords } };
  });
  const fReseau = Buffer.from(JSON.stringify({ type: "FeatureCollection", features: lignes }));
  console.log(`\n== Charge : axe de ${N_AXE} sommets (${(fAxe.length / 1e6).toFixed(1)} Mo), reseau de ${N_LIGNES} lignes (${(fReseau.length / 1e6).toFixed(1)} Mo) ==`);

  const depot = async (nom: string, fichier: Buffer, champs: Record<string, string>) => {
    const t = performance.now();
    const r = request(app).post(`${BASE}/${PID}/jeux`).set("Authorization", `Bearer ${TA}`);
    for (const [k, v] of Object.entries(champs)) r.field(k, v);
    const rep = await r.attach("fichier", fichier, { filename: nom });
    mesure(`depot ${nom}`, ms(t), `-> ${rep.status} ${rep.body.code ?? ""}`);
    return rep;
  };
  const autoriser = (jid: string) => request(app).post(`${BASE}/${PID}/jeux/${jid}/autoriser`).set("Authorization", `Bearer ${TA}`).send({ justification: "Jeu de charge, controle automatique" });

  if (process.env.PV_CHARGE_DEPOT_SEUL === "1") { const dd = await depot("reseau-20000.geojson", fReseau, { role: "RESEAU_TIERS", concessionnaireId: conc, classePrecision: "B" }); console.log(dd.status); return; }
  const dA = await depot("axe-dense.geojson", fAxe, { role: "AXES_TRAVAUX" });
  const dR = await depot("reseau-20000.geojson", fReseau, { role: "RESEAU_TIERS", concessionnaireId: conc, classePrecision: "B" });
  if (dA.status === 201) await autoriser(dA.body.jeu.id);
  if (dR.status === 201) await autoriser(dR.body.jeu.id);
  if (!MESURE_SEULE) {
    verifier("depot de l'axe dense : accepte (201) ou refuse par le plafond de sommets (422 TROP_DE_SOMMETS), jamais 500",
      dA.status === 201 || (dA.status === 422 && dA.body.code === "TROP_DE_SOMMETS"), [dA.status, dA.body.code]);
    verifier("depot du reseau de 20 000 lignes : 201 en moins de 60 s (delai de depot)", dR.status === 201 && Number(mesures.find((m) => m.includes("reseau-20000"))?.match(/(\d+) ms/)?.[1]) < 60_000, [dR.status, dR.body.code]);
  }

  // --- Analyse ---
  const pgActives = async () => Number((await sql<{ n: bigint }>(`SELECT count(*) n FROM pg_stat_activity WHERE datname = current_database() AND state = 'active' AND pid <> pg_backend_pid() AND query ILIKE '%projets_voirie_objets%'`))[0].n);
  const ta = performance.now();
  // Garde de la mesure « avant » : sans delai cote base, l'analyse peut durer des centaines de secondes ; on la coupe a 150 s.
  const garde = setTimeout(async () => {
    await sql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND query ILIKE '%projets_voirie_objets%'`).catch(() => undefined);
  }, 150_000);
  const an = await request(app).get(`${BASE}/${PID}/analyse`).set("Authorization", `Bearer ${TL}`);
  clearTimeout(garde);
  const dureeAnalyse = ms(ta);
  mesure("GET analyse (axe dense + reseau de 20 000 lignes)", dureeAnalyse, `-> ${an.status} ${an.body.code ?? ""}`);
  await new Promise((r) => setTimeout(r, 1500));
  const actives = await pgActives();
  mesure("requetes PostGIS encore actives apres la reponse", 0, `-> ${actives}`);
  if (!MESURE_SEULE) {
    verifier("analyse : 200 dans le delai (20 s) ou 504 ANALYSE_TROP_LONGUE ; jamais 500",
      (an.status === 200 && dureeAnalyse < 25_000) || (an.status === 504 && an.body.code === "ANALYSE_TROP_LONGUE" && dureeAnalyse < 25_000), [an.status, an.body.code, dureeAnalyse]);
    verifier("aucune requete PostGIS ne continue apres la reponse", actives === 0, actives);
    const court = Number(process.env.PROJETS_VOIRIE_DELAI_ANALYSE_MS ?? 20000);
    if (court <= 2000) {
      verifier(`delai d'analyse reduit a ${court} ms : la base coupe la requete, reponse 504 ANALYSE_TROP_LONGUE en moins de 6 s`, an.status === 504 && an.body.code === "ANALYSE_TROP_LONGUE" && dureeAnalyse < 6000, [an.status, an.body.code, dureeAnalyse]);
    }
  }

  // --- Carte ---
  const tc = performance.now();
  const carteSans = await request(app).get(`${BASE}/${PID}/carte`).set("Authorization", `Bearer ${TL}`);
  mesure("GET carte sans bbox", ms(tc), `-> ${carteSans.status} ${carteSans.body.code ?? ""} objets ${carteSans.body.jeux?.reduce((s: number, j: { nbFeatures: number }) => s + j.nbFeatures, 0) ?? "-"} taille ${(JSON.stringify(carteSans.body).length / 1e6).toFixed(1)} Mo`);
  const tb = performance.now();
  const carteBbox = await request(app).get(`${BASE}/${PID}/carte?bbox=-10.2,9.19,-10.19,9.21&zoom=16`).set("Authorization", `Bearer ${TL}`);
  mesure("GET carte bbox 1 km, zoom 16", ms(tb), `-> ${carteBbox.status} objets ${carteBbox.body.jeux?.reduce((s: number, j: { nbFeatures: number }) => s + j.nbFeatures, 0) ?? "-"}`);
  if (!MESURE_SEULE) {
    verifier("carte sans bbox : 200 plafonnee ou 504 CARTE_TROP_LONGUE, en moins de 15 s, jamais 500", (carteSans.status === 200 || carteSans.body.code === "CARTE_TROP_LONGUE") && ms(tc) < 15_000, [carteSans.status, carteSans.body.code]);
    verifier("carte avec bbox : 200", carteBbox.status === 200, carteBbox.status);
  }

  // --- Concurrence ---
  const tp = performance.now();
  const lancer = Array.from({ length: 8 }, () => request(app).get(`${BASE}/${PID}/analyse`).set("Authorization", `Bearer ${TL}`));
  const auth = (async () => { const t = performance.now(); const r = await request(app).get(`${BASE}`).set("Authorization", `Bearer ${TA}`); return { status: r.status, ms: ms(t) }; })();
  const reps = await Promise.all(lancer);
  const a = await auth;
  const codes = reps.map((r) => `${r.status}${r.body.code ? ":" + r.body.code : ""}`);
  mesure("8 analyses simultanees", ms(tp), codes.join(" "));
  mesure("liste des projets pendant ce temps (autre compte)", a.ms, `-> ${a.status}`);
  const t503 = (await request(app).get(`${BASE}`).set("Authorization", `Bearer ${TX}`)).status;
  if (!MESURE_SEULE) {
    verifier("huit analyses simultanees : aucune reponse 500", reps.every((r) => r.status !== 500), codes);
    verifier("la liste des projets reste servie pendant la charge (200 en moins de 10 s)", a.status === 200 && a.ms < 10_000, a);
    verifier("un compte sans la cle de module recoit 403 (pas 500, pas de blocage) pendant la charge", t503 === 403, t503);
  }
  console.log("\n" + mesures.join("\n"));
}

try {
  await main();
} catch (e) {
  console.error("ERREUR du banc :", e);
  process.exitCode = 1;
} finally {
  if (process.env.PV_GARDER_CLONE !== "1") await banc.fermer();
  await prisma.$disconnect();
}
if (process.env.PV_CHARGE_SANS_VERIF !== "1") conclure();

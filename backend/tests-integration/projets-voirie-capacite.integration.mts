// Banc de CAPACITE des trois calculs lourds du module Projets de voirie et reseaux (pilote local du 09/11/2026, defaut D4) :
// analyse 2D (`GET /:id/analyse`), comptage des reseaux (`GET /:id/reseau/comptage`) et analyse persistee (`POST /:id/analyses`).
// Lancer (DATABASE_URL pointe sur `replay`, qui porte toutes les migrations du depot) :
//   npx tsx tests-integration/projets-voirie-capacite.integration.mts
// Variables :
//   PV_CAPACITE_TAILLES   tailles du reseau en objets lineaires (defaut 1000,5000,20000,50000)
//   PV_CAPACITE_MESURE=1  MESURE seule : delai d'analyse porte a PV_CAPACITE_DELAI_MS (defaut 300 000 ms, borne haute du reglage),
//                         plafonds de volume portes a leur borne haute, aucune verification (code de sortie 0) : donne la duree REELLE
//                         de chaque calcul et de chacune de ses etapes (trace PV_TRACE du budget)
//   PV_GARDER_CLONE=1     conserve le clone `essai_pv_capacite` pour l'examiner en SQL
//
// DONNEES 100 % SYNTHETIQUES (jamais derivees d'un fichier reel) : 12 axes de 8 km (6 est-ouest, 6 nord-sud, legerement ondules, un sommet
// tous les 100 m) dans un carre d'environ 8 km, et un reseau de N lignes aleatoires (graine fixe) de 2 a 6 sommets, chacune une marche de
// 10 a 60 m par pas dans une direction tiree au hasard, departs uniformes dans le carre : environ 4 sommets par ligne, comme le jeu du pilote
// (50 000 lignes, 199 720 sommets). Les axes et une premiere ligne de reseau passent par l'API (depot, autorisation) ; les N - 1 autres
// lignes sont inserees en SQL dans le jeu de reseau autorise (le depot de 50 000 objets est deja mesure par le pilote : 94 s), d'ou un
// `nbObjets` du jeu qui reste a 1 : le comptage prealable du correctif lit les objets eux-memes, jamais ce compteur.
//
// CE QUE LE BANC AFFIRME (hors mesure seule), a chaque taille, avec les reglages PAR DEFAUT (delai de 20 s) :
//   - chacun des trois calculs repond 200, ou 422 ANALYSE_TROP_VOLUMINEUSE (comptage prealable au-dela du plafond) avec le volume et le
//     plafond dans la reponse, en moins de 5 s ; jamais 500, jamais 504 ;
//   - sous les plafonds par defaut (capacite.ts), les trois calculs repondent 200 ; au-dela, 422 ;
//   - un refus d'analyse persistee laisse une ligne ECHEC (meme regle que les autres refus de volume) et aucun dossier ;
//   - aucune requete PostGIS ne continue apres la reponse.
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure } from "./lib/verdict.ts";
import { avecTerritoireParDefaut } from "./lib/territoire-par-defaut.mts";

const MESURE_SEULE = process.env.PV_CAPACITE_MESURE === "1";
process.env.PROJETS_VOIRIE_ANALYSE_INTERVALLE_S = "0";
process.env.PV_TRACE = "1";
if (MESURE_SEULE) {
  process.env.PROJETS_VOIRIE_DELAI_ANALYSE_MS = process.env.PV_CAPACITE_DELAI_MS ?? "300000";
  // Borne haute des plafonds de volume (reglages du correctif ; sans effet sur le code d'avant, qui ne les lit pas).
  process.env.PROJETS_VOIRIE_ANALYSE_OBJETS_MAX ??= "200000";
  process.env.PROJETS_VOIRIE_ANALYSE_SOMMETS_MAX ??= "2000000";
}
const TAILLES = (process.env.PV_CAPACITE_TAILLES ?? "1000,5000,20000,50000").split(",").map((s) => Number(s.trim())).filter((n) => n > 0);

const banc = await ouvrirBancClone("essai_pv_capacite");
const { prisma } = await banc.imp("lib/prisma");
const { createApp } = await banc.imp("app");
const { signAccessToken } = await banc.imp("utils/jwt");
const capacite = await banc.imp("projets-voirie/capacite");
const request = (await import("supertest")).default;
const app = avecTerritoireParDefaut(createApp(), prisma);
const BASE = "/api/v2/projets-voirie";

// Trace des etapes du budget (bd.ts, PV_TRACE=1) : capturee pour le rapport.
const etapes: string[] = [];
const infoOrigine = console.info.bind(console);
console.info = (...a: unknown[]) => {
  const t = a.map(String).join(" ");
  if (t.startsWith("[projets-voirie]")) etapes.push(t.replace("[projets-voirie] ", ""));
  else infoOrigine(...a);
};
const sql = <T = Record<string, unknown>>(texte: string, ...v: unknown[]) => prisma.$queryRawUnsafe(texte, ...v) as Promise<T[]>;
const ms = (t: number) => Math.round(performance.now() - t);
const lignesRapport: string[] = [];

function alea(graine: number) {
  let s = graine >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
}

// Carre synthetique d'environ 8 km (coordonnees arbitraires a l'interieur de la Guinee, aucun lieu nomme).
const LON0 = -10.2, LAT0 = 9.1, COTE_M = 8000;
const M_LAT = 1 / 110_574;
const M_LON = 1 / (111_320 * Math.cos((LAT0 * Math.PI) / 180));
const pt = (xm: number, ym: number): [number, number] => [Math.round((LON0 + xm * M_LON) * 1e7) / 1e7, Math.round((LAT0 + ym * M_LAT) * 1e7) / 1e7];

function axesSynthetiques() {
  const features = [];
  for (let k = 0; k < 6; k++) {
    const c = 700 + k * 1300;
    const ew: [number, number][] = [], ns: [number, number][] = [];
    for (let i = 0; i <= 80; i++) {
      const s = i * 100;
      ew.push(pt(s, c + 15 * Math.sin(s / 700)));
      ns.push(pt(c + 15 * Math.sin(s / 900), s));
    }
    features.push({ type: "Feature", properties: { name: `Axe EO ${k + 1}` }, geometry: { type: "LineString", coordinates: ew } });
    features.push({ type: "Feature", properties: { name: `Axe NS ${k + 1}` }, geometry: { type: "LineString", coordinates: ns } });
  }
  return Buffer.from(JSON.stringify({ type: "FeatureCollection", features }));
}

function ligneAleatoire(rnd: () => number): [number, number][] {
  const n = 2 + Math.floor(rnd() * 5);
  let x = rnd() * COTE_M, y = rnd() * COTE_M;
  const c: [number, number][] = [pt(x, y)];
  for (let i = 1; i < n; i++) {
    const a = rnd() * 2 * Math.PI, l = 10 + rnd() * 50;
    const x0 = x, y0 = y;
    x += l * Math.cos(a); y += l * Math.sin(a);
    // PV_CAPACITE_PAS_M : sommets intermediaires tous les PAS metres (lignes denses, meme trace).
    const k = PAS_M > 0 ? Math.max(1, Math.ceil(l / PAS_M)) : 1;
    for (let j = 1; j <= k; j++) c.push(pt(x0 + ((x - x0) * j) / k, y0 + ((y - y0) * j) / k));
  }
  return c;
}
const PAS_M = Number(process.env.PV_CAPACITE_PAS_M ?? 0);

async function main() {
  const admin = await prisma.user.create({ data: { email: "admin@capacite.invalid", nomComplet: "Admin capacite", passwordHash: "x", role: "ADMIN", modulesAutorises: [] } });
  const TA = signAccessToken({ sub: admin.id, role: admin.role, email: admin.email });
  const conc = (await request(app).post(`${BASE}/concessionnaires`).set("Authorization", `Bearer ${TA}`).send({ nom: "Operateur de capacite", typeReseau: "TELECOM" })).body.concessionnaire.id as string;
  const fAxes = axesSynthetiques();
  const pgActives = async () => Number((await sql<{ n: bigint }>(`SELECT count(*) n FROM pg_stat_activity WHERE datname = current_database() AND state = 'active' AND pid <> pg_backend_pid() AND query ILIKE '%projets_voirie_objets%'`))[0].n);
  console.log(`\n== Capacite : ${TAILLES.join(", ")} lignes de reseau ; ${MESURE_SEULE ? `MESURE SEULE, delai ${process.env.PROJETS_VOIRIE_DELAI_ANALYSE_MS} ms` : "reglages par defaut"} ==`);

  for (const N of TAILLES) {
    const cree = await request(app).post(BASE).set("Authorization", `Bearer ${TA}`).send({ code: `CAPA-${N}`, nom: `Capacite ${N}`, largeurChausseeM: 7, largeurEmpriseM: 15 });
    const PID: string = cree.body.projet.id;
    const depot = async (nom: string, fichier: Buffer, champs: Record<string, string>) => {
      const r = request(app).post(`${BASE}/${PID}/jeux`).set("Authorization", `Bearer ${TA}`);
      for (const [k, v] of Object.entries(champs)) r.field(k, v);
      const rep = await r.attach("fichier", fichier, { filename: nom });
      if (rep.status !== 201) throw new Error(`depot ${nom} : ${rep.status} ${JSON.stringify(rep.body).slice(0, 300)}`);
      const a = await request(app).post(`${BASE}/${PID}/jeux/${rep.body.jeu.id}/autoriser`).set("Authorization", `Bearer ${TA}`).send({ justification: "Jeu synthetique du banc de capacite" });
      if (a.status !== 200) throw new Error(`autorisation ${nom} : ${a.status}`);
      return rep.body.jeu.id as string;
    };
    await depot("axes-capacite.geojson", fAxes, { role: "AXES_TRAVAUX" });
    const rnd = alea(N);
    const premiere = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "ligne 0" }, geometry: { type: "LineString", coordinates: ligneAleatoire(rnd) } }] };
    const jeuR = await depot("reseau-capacite.geojson", Buffer.from(JSON.stringify(premiere)), { role: "RESEAU_TIERS", concessionnaireId: conc, classePrecision: "B" });
    const ti = performance.now();
    for (let debut = 1; debut < N; debut += 5000) {
      const wkt: string[] = [];
      for (let i = debut; i < Math.min(N, debut + 5000); i++) wkt.push(`LINESTRING(${ligneAleatoire(rnd).map(([x, y]) => `${x} ${y}`).join(",")})`);
      await prisma.$executeRawUnsafe(
        `INSERT INTO "projets_voirie_objets" ("jeuId", "nom", "typeGeom", "geom", "longueurM", "attributs", "empreinte", "ordre")
         SELECT $1, 'ligne ' || (t.o + $3 - 1), 'LIGNE', g.g, ST_Length(g.g::geography), '{}'::jsonb, md5(ST_AsBinary(g.g)::text || t.o::text) || left(md5(t.o::text), 8), t.o + $3 - 1
           FROM unnest($2::text[]) WITH ORDINALITY AS t(w, o) CROSS JOIN LATERAL (SELECT ST_GeomFromText(t.w, 4326) AS g) g`,
        jeuR, wkt, debut);
    }
    await prisma.$executeRawUnsafe(`ANALYZE "projets_voirie_objets"`);
    const v = (await sql<{ n: number; s: number }>(`SELECT count(*)::int n, sum(ST_NPoints("geom"))::int s FROM "projets_voirie_objets" WHERE "jeuId" = $1`, jeuR))[0];
    const entete = `-- ${N} lignes de reseau (${v.n} objets, ${v.s} sommets ; insertion ${ms(ti)} ms) + 12 axes`;
    console.log(entete); lignesRapport.push(entete);
    // PV_CAPACITE_SANS_CALCUL=1 (avec PV_GARDER_CLONE=1) : donnees seules, pour examiner les requetes en SQL (EXPLAIN ANALYZE).
    if (process.env.PV_CAPACITE_SANS_CALCUL === "1") { console.log(`projet ${PID}`); continue; }

    const appels: [string, () => Promise<{ status: number; body: Record<string, unknown> }>][] = [
      ["analyse 2D", () => request(app).get(`${BASE}/${PID}/analyse`).set("Authorization", `Bearer ${TA}`)],
      ["comptage", () => request(app).get(`${BASE}/${PID}/reseau/comptage`).set("Authorization", `Bearer ${TA}`)],
      ["analyse persistee", () => request(app).post(`${BASE}/${PID}/analyses`).set("Authorization", `Bearer ${TA}`).send({})],
    ];
    for (const [nom, appel] of appels) {
      etapes.length = 0;
      const t = performance.now();
      const r = await appel();
      const d = ms(t);
      const extra = r.body.code === "ANALYSE_TROP_VOLUMINEUSE" ? ` ${JSON.stringify({ objets: r.body.objets, sommets: r.body.sommets, objetsMax: r.body.objetsMax, sommetsMax: r.body.sommetsMax })}` : "";
      const resume = nom === "analyse persistee" && r.status === 201 ? ` dossiers ${(r.body.resume as { totaux: { conflitsTrouves: number } }).totaux.conflitsTrouves}` : "";
      const l = `MESURE ${N} ${nom.padEnd(18)} ${String(d).padStart(7)} ms -> ${r.status} ${r.body.code ?? ""}${extra}${resume} | ${etapes.join(" ; ")}`;
      console.log(l); lignesRapport.push(l);
      await new Promise((res) => setTimeout(res, 1000));
      const actives = await pgActives();
      if (!MESURE_SEULE) {
        const refus = r.status === 422 && r.body.code === "ANALYSE_TROP_VOLUMINEUSE";
        verifier(`${N} objets, ${nom} : 200/201 ou 422 ANALYSE_TROP_VOLUMINEUSE, jamais 500 ni 504`, r.status === 200 || r.status === 201 || refus, [r.status, r.body.code, d]);
        if (refus) {
          verifier(`${N} objets, ${nom} : le refus porte le volume et les plafonds (objets, sommets, objetsMax, sommetsMax)`,
            [r.body.objets, r.body.sommets, r.body.objetsMax, r.body.sommetsMax].every((x) => typeof x === "number"), r.body);
          verifier(`${N} objets, ${nom} : refus immediat (moins de 5 s)`, d < 5000, d);
        }
        // Le comptage ne retient que les jeux de reseau ; les deux analyses, aussi les 12 axes (81 sommets chacun).
        const ax = nom === "comptage" ? 0 : 1;
        const sous = v.n + 12 * ax <= capacite.analyseObjetsMax() && v.s + 12 * 81 * ax <= capacite.analyseSommetsMax();
        verifier(`${N} objets, ${nom} : ${sous ? "sous les plafonds par defaut, calcule (200/201)" : "au-dela d'un plafond par defaut, refuse (422)"}`,
          sous ? r.status === 200 || r.status === 201 : refus, [r.status, r.body.code, d]);
        verifier(`${N} objets, ${nom} : aucune requete PostGIS active apres la reponse`, actives === 0, actives);
        if (nom === "analyse persistee" && refus) {
          const ech = await sql<{ statut: string; n: number }>(`SELECT a."statut"::text AS statut, (SELECT count(*)::int FROM "conflits_projet" c WHERE c."projetId" = a."projetId") AS n FROM "analyses_conflit_projet" a WHERE a."projetId" = $1 ORDER BY a."numero" DESC LIMIT 1`, PID);
          verifier(`${N} objets, analyse persistee refusee : une ligne ECHEC, aucun dossier`, ech[0]?.statut === "ECHEC" && ech[0]?.n === 0, ech);
        }
      }
    }
  }
  console.log("\n" + lignesRapport.join("\n"));
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
if (!MESURE_SEULE) conclure();

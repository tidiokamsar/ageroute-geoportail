// Banc de VOLUME des reseaux physiques et circuits logiques (lot B1) contre un vrai PostGIS : proposition d'associations, comptage, listes.
// Contrat : docs/projets-voirie/CONTRAT-RESEAUX.md, section 7. Voir tests-integration/README.md. Lancer (DATABASE_URL pointe sur `replay`) :
//   npx tsx tests-integration/reseau-physique-logique-volume.integration.mts
// Variables : RESEAUX_VOLUME (defaut 3000 circuits et 3000 infrastructures), RESEAUX_DELAI_MS (delai de la base pour la proposition, defaut celui du
// serveur : 20 000 ms), RESEAUX_ANALYZE=1 (ANALYZE des tables apres le chargement), RESEAUX_GARDER_CLONE=1 (conserve le clone pour EXPLAIN),
// PV_TRACE=1 (duree de chaque etape du serveur).
//
// DONNEES 100 % SYNTHETIQUES : N circuits logiques (lignes de 100 m espacees de 4 m) et N gaines decalees de 0,3 m ; chaque circuit n'a qu'une gaine
// a moins de la tolerance (2 m) : il y a donc exactement N propositions. Les durees sont celles d'un poste de developpement, charge par d'autres travaux.
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure } from "./lib/verdict.ts";

const NB = Number(process.env.RESEAUX_VOLUME ?? 3000);
if (process.env.RESEAUX_DELAI_MS) process.env.PROJETS_VOIRIE_DELAI_ANALYSE_MS = process.env.RESEAUX_DELAI_MS;
const banc = await ouvrirBancClone("essai_reseau_volume", { migrations: ["20261101200000_reseaux_physiques_logiques"] });
const { prisma } = await banc.imp("lib/prisma");
const { createApp } = await banc.imp("app");
const { signAccessToken } = await banc.imp("utils/jwt");
const request = (await import("supertest")).default;
process.env.PROJETS_VOIRIE_ASSOC_INTERVALLE_S = "0";
process.env.PROJETS_VOIRIE_ASSOC_CIRCUITS_MAX = "100000";
const app = createApp();
const BASE = "/api/v2/projets-voirie";
const O = { x: 380000, y: 1015000 };
const sql = <T = Record<string, unknown>>(texte: string, ...v: unknown[]) => prisma.$queryRawUnsafe(texte, ...v) as Promise<T[]>;

async function main() {
  const admin = await prisma.user.create({ data: { email: "admin@volume.invalid", nomComplet: "Admin volume", passwordHash: "x", role: "ADMIN", modulesAutorises: [] } });
  const t = signAccessToken({ sub: admin.id, role: "ADMIN", email: admin.email });
  const envoyer = (m: "post" | "get", chemin: string, corps?: unknown) => { const r = request(app)[m](`${BASE}${chemin}`).set("Authorization", `Bearer ${t}`); return corps === undefined ? r : r.send(corps as object); };
  const pid: string = (await envoyer("post", "", { code: "VOLUME-1", nom: "Volume" })).body.projet.id;
  const conc = async (nom: string, typeReseau: string) => (await envoyer("post", "/concessionnaires", { nom, typeReseau })).body.concessionnaire.id as string;
  const C1 = await conc("Operateur A synthetique", "TELECOM"), C2 = await conc("Operateur B synthetique", "TELECOM");
  const fc = async (prefixe: string, decalage: number) => (await sql<{ fc: unknown }>(`
    SELECT json_build_object('type', 'FeatureCollection', 'features', json_agg(json_build_object('type', 'Feature', 'properties', json_build_object('name', $4::text || i),
      'geometry', ST_AsGeoJSON(ST_Transform(ST_SetSRID(ST_MakeLine(ST_MakePoint($1::float8 + 0, $2::float8 + i * 4.0 + $5::float8), ST_MakePoint($1::float8 + 100, $2::float8 + i * 4.0 + $5::float8)), 32629), 4326), 9)::json))) AS fc
    FROM generate_series(0, $3::int - 1) i`, O.x, O.y, NB, prefixe, decalage))[0].fc;
  const deposer = async (corps: unknown, champs: Record<string, string>, nom: string): Promise<{ id: string; ms: number }> => {
    const t0 = performance.now();
    const r = request(app).post(`${BASE}/${pid}/jeux`).set("Authorization", `Bearer ${t}`);
    for (const [k, v] of Object.entries(champs)) r.field(k, v);
    const d = await r.attach("fichier", Buffer.from(JSON.stringify(corps)), { filename: nom });
    const id: string = d.body.jeu?.id;
    if (!id) throw new Error(`depot refuse : ${JSON.stringify(d.body)}`);
    await envoyer("post", `/${pid}/jeux/${id}/autoriser`, { justification: "Controle effectue avec le chef de projet" });
    return { id, ms: Math.round(performance.now() - t0) };
  };
  console.log(`\n== Reseaux physiques : banc de volume (${NB} circuits, ${NB} gaines) ==`);
  const dc = await deposer(await fc("Circuit ", 0), { role: "RESEAU_TIERS", concessionnaireId: C1, natureObjets: "CIRCUIT_LOGIQUE" }, "circuits.geojson");
  const di = await deposer(await fc("Gaine ", 0.3), { role: "RESEAU_TIERS", concessionnaireId: C2, natureObjets: "ACTIF_PHYSIQUE", classePrecision: "B" }, "gaines.geojson");
  console.log(`   (depot et autorisation : circuits ${dc.ms} ms, gaines ${di.ms} ms)`);
  if (process.env.RESEAUX_ANALYZE === "1") await sql(`ANALYZE projets_voirie_objets`);

  let t0 = performance.now();
  const pv = await envoyer("post", `/${pid}/reseau/associations/proposer`, {});
  const dureeProp = Math.round(performance.now() - t0);
  const delai = Number(process.env.PROJETS_VOIRIE_DELAI_ANALYSE_MS ?? 20_000);
  verifier(`VOLUME : ${NB} circuits x ${NB} gaines : ${NB} propositions (une par circuit, a 0,3 m) en ${dureeProp} ms`,
    pv.status === 201 && pv.body.bilan.creees === NB && pv.body.bilan.circuitsExamines === NB && pv.body.bilan.infrastructuresExaminees === NB && pv.body.bilan.tronque === false, [pv.status, pv.body.bilan ?? pv.body]);
  verifier(`VOLUME : la proposition tient dans le delai de la base (${delai} ms)`, dureeProp < delai + 5_000, dureeProp);
  const exacts = await sql<{ n: bigint }>(`SELECT count(*) n FROM reseau_relations r JOIN projets_voirie_objets s ON s.id = r."sourceObjetId" JOIN projets_voirie_objets c ON c.id = r."cibleObjetId"
    WHERE r."projetId" = $1 AND r.statut = 'PROPOSEE' AND substring(s.nom from 9) = substring(c.nom from 7)`, pid);
  verifier(`VOLUME : chaque circuit est propose pour LA gaine de meme rang (${NB} sur ${NB}, aucune gaine voisine)`, Number(exacts[0].n) === NB, Number(exacts[0].n));

  t0 = performance.now();
  const cv = await envoyer("get", `/${pid}/reseau/comptage`);
  const dureeComptage = Math.round(performance.now() - t0);
  verifier(`VOLUME : comptage de ${2 * NB} objets en ${dureeComptage} ms : ${NB} circuits, ${NB} infrastructures, ${NB} supports proposes et aucun valide`,
    cv.status === 200 && cv.body.circuitsLogiques.nombreDeclare === NB && cv.body.infrastructuresPhysiques.nombreDeclare === NB && cv.body.circuitsLogiques.supportPhysique.avecPropositionSeulement === NB
    && cv.body.circuitsLogiques.supportPhysique.avecSupportValide === 0 && cv.body.circuitsLogiques.sommeLongueursCircuitsM > 0, [cv.status, dureeComptage]);
  t0 = performance.now();
  const lv = await envoyer("get", `/${pid}/reseau/objets?limite=200`);
  const dureeListe = Math.round(performance.now() - t0);
  t0 = performance.now();
  const rv = await envoyer("get", `/${pid}/reseau/relations?limite=200&statut=PROPOSEE`);
  const dureeRel = Math.round(performance.now() - t0);
  verifier(`VOLUME : une page de 200 objets en ${dureeListe} ms, une page de 200 relations en ${dureeRel} ms`, lv.status === 200 && lv.body.objets.length === 200 && lv.body.curseurSuivant !== null
    && rv.status === 200 && rv.body.relations.length === 200 && rv.body.curseurSuivant !== null);
  t0 = performance.now();
  const pr2 = await envoyer("post", `/${pid}/reseau/associations/proposer`, {});
  const dureeRejeu = Math.round(performance.now() - t0);
  verifier(`VOLUME : rejeu de la proposition en ${dureeRejeu} ms : rien n'est reecrit (0 creee, ${NB} deja connues)`, pr2.status === 201 && pr2.body.bilan.creees === 0 && pr2.body.bilan.dejaConnues === NB, pr2.body.bilan ?? pr2.body);
  console.log(`   (durees mesurees : proposition ${dureeProp} ms, rejeu ${dureeRejeu} ms, comptage ${dureeComptage} ms, page d'objets ${dureeListe} ms, page de relations ${dureeRel} ms)`);
}

try {
  await main();
} catch (e) {
  console.error(e);
  verifier("le banc va jusqu'au bout (aucune exception)", false, String(e));
} finally {
  conclure();
  await prisma.$disconnect();
  if (process.env.RESEAUX_GARDER_CLONE === "1") console.log(`Clone conserve pour examen : ${banc.nomClone} (a supprimer a la main)`); else await banc.fermer();
}

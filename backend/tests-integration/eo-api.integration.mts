// Banc d'integration : API d'observation de la Terre (Lot 1, EO-API). Voir tests-integration/README.md. Lancer (DATABASE_URL pointe sur `replay`) :
//   npx tsx tests-integration/eo-api.integration.mts
//
// CE QUE LE BANC PROUVE, SUR L'APPLICATION REELLE (`createApp`), DES COMPTES REELS ET DES PERIMETRES REELS EN BASE, DANS UN CLONE POSTGIS JETABLE
// (il y applique les migrations 20261028* si `replay` ne les porte pas ; `replay` n'est jamais ecrite) :
//   - gardes : sans jeton, jeton forge, sans la cle de module, lecteur, inspecteur, gestionnaire national et regional, administrateur ;
//   - perimetre : un compte regional ne voit que sa region (liste, GeoJSON, synthese, detail) ; une proposition d'une autre region, non
//     rattachee ou inexistante repond le MEME 404, y compris avec un corps invalide ; les donnees synthetiques ne figurent dans aucune liste ;
//   - le workflow bout en bout : depot -> mise en attente -> non concluante -> retour -> verdict avec preuves ; journal ecrit ; verdict definitif ;
//   - mission de verification : region et emprise posees ; l'inspecteur n'ajoute des preuves que sur SA mission, avec SES observations ;
//   - sources : jamais « actives » ; verification et synchronisation du catalogue avec un adaptateur INJECTE (fixtures reelles d'EO-SOURCES, AUCUN
//     appel reseau : le `fetch` global est remplace par une fonction qui leve) ; deduplication ; produits sans nuages ecartes ; apercu indisponible = 404 ;
//   - entrees hostiles : 400, jamais 500, et aucune ligne ecrite ; un refus de PostGIS (trou hors de l'anneau) devient un 400 ;
//   - AUCUNE ecriture dans troncons, portions, ouvrages (empreintes avant/apres, avec un temoin) ; toute ecriture est auditee, aucune lecture ne l'est.
//
// CE QU'IL NE PROUVE PAS : la production (aucun appel reseau, aucun volume) ; le comportement du vrai catalogue (voir la verification reelle du rapport).
import { writeFileSync } from "node:fs";
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure } from "./lib/verdict.ts";

const MIGRATIONS = ["20261028100000_eo_produits_sources", "20261028110000_eo_propositions_workflow", "20261028120000_eo_qualite_methodes", "20261028130000_eo_gardes_journal"];
const banc = await ouvrirBancClone("essai_eo_api", { migrations: MIGRATIONS });
const { prisma } = await banc.imp("lib/prisma");
const { createApp } = await banc.imp("app");
const { signAccessToken } = await banc.imp("utils/jwt");
const auth = await banc.imp("middleware/auth.middleware");
const sourcesService = await banc.imp("teledetection/sources.service");
const sourcesIndex = await banc.imp("teledetection/sources/index");
const support = await banc.imp("teledetection/sources/essais.support");
const synth = await banc.imp("teledetection/sources/__fixtures__/synthetiques");
const registre = await banc.imp("tableau-de-bord/indicateurs.registre");
const veille = await banc.imp("exploitation/veille.service");
const request = (await import("supertest")).default;
const jwt = (await import("jsonwebtoken")).default;

const app = createApp();
const sql = async <T = Record<string, unknown>>(texte: string, ...p: unknown[]): Promise<T[]> => prisma.$queryRawUnsafe(texte, ...p);
const compter = async (texte: string, ...p: unknown[]) => Number((await sql<{ n: bigint | number }>(texte, ...p))[0].n);
const jeton = (u: { id: string; role: string; email: string }) => signAccessToken({ sub: u.id, role: u.role, email: u.email });
const BASE = "/api/v2/teledetection";
// Exemples de reponses pour docs/observation-terre/API.md : ecrits seulement si EO_API_EXEMPLES designe un fichier (hors depot).
const ex: Record<string, unknown> = {};

// Aucun appel reseau pendant le banc : tout `fetch` global qui partirait leverait.
const fetchReel = globalThis.fetch;
let appelsReseauInterdits = 0;
globalThis.fetch = (async () => { appelsReseauInterdits++; throw new Error("appel reseau interdit pendant le banc"); }) as typeof fetch;

async function main() {
  // ============================================================ jeu d'essai : comptes, regions, troncons
  const mk = (email: string, role: string, extra: Record<string, unknown> = {}) =>
    prisma.user.create({ data: { email, nomComplet: `Compte ${email.split("@")[0]}`, passwordHash: "x", role, modulesAutorises: ["teledetection"], ...extra } });
  const admin = await mk("eo-admin@api.invalid", "ADMIN", { modulesAutorises: [] });
  const gest = await mk("eo-gest@api.invalid", "GESTIONNAIRE");
  const gestR1 = await mk("eo-gest-r1@api.invalid", "GESTIONNAIRE");
  const lecteur = await mk("eo-lecteur@api.invalid", "LECTEUR");
  const inspecteur = await mk("eo-insp@api.invalid", "INSPECTEUR");
  const inspecteur2 = await mk("eo-insp2@api.invalid", "INSPECTEUR");
  const sansModule = await mk("eo-sans@api.invalid", "GESTIONNAIRE", { modulesAutorises: ["troncons"] });
  const desactive = await mk("eo-off@api.invalid", "GESTIONNAIRE", { actif: false });
  const T = Object.fromEntries(Object.entries({ admin, gest, gestR1, lecteur, inspecteur, inspecteur2, sansModule, desactive }).map(([k, u]) => [k, jeton(u as never)])) as Record<string, string>;

  await sql(`INSERT INTO regions (nom) VALUES ('Region API 1'), ('Region API 2')`);
  const R1 = Number((await sql<{ id: number }>(`SELECT id FROM regions WHERE nom = 'Region API 1'`))[0].id);
  const R2 = Number((await sql<{ id: number }>(`SELECT id FROM regions WHERE nom = 'Region API 2'`))[0].id);
  await sql(`INSERT INTO perimetres_comptes ("userId", "regionId", "accordeParId") VALUES ($1, $2, $3)`, gestR1.id, R1, admin.id);
  const troncon = async (code: string, regionId: number, a: [number, number], b: [number, number]) => {
    const t = await prisma.troncon.create({ data: { code, nom: `Troncon ${code}`, classe: "RN", regionId, longueurKm: 1.1, revetement: "BITUME", pkDebut: 0, pkFin: 1.1 } });
    await sql(`UPDATE troncons SET geom = ST_SetSRID(ST_MakeLine(ST_MakePoint($2, $3), ST_MakePoint($4, $5)), 4326) WHERE id = $1`, t.id, a[0], a[1], b[0], b[1]);
    return t;
  };
  const tA = await troncon("API-A", R1, [-13.60, 9.64], [-13.59, 9.64]);
  const tB = await troncon("API-B", R2, [-13.20, 9.90], [-13.19, 9.90]);

  const get = (chemin: string, t?: string) => { let r = request(app).get(`${BASE}${chemin}`); if (t) r = r.set("Authorization", `Bearer ${t}`); return r; };
  const post = (chemin: string, corps: unknown, t?: string) => { let r = request(app).post(`${BASE}${chemin}`); if (t) r = r.set("Authorization", `Bearer ${t}`); return r.send(corps as object); };
  const empreinteReferentiel = async () => (await sql<{ e: string }>(`
    SELECT md5((SELECT coalesce(string_agg(x::text, '|' ORDER BY x.id), '') FROM troncons x) || (SELECT coalesce(string_agg(x::text, '|' ORDER BY x.id), '') FROM portions x)
            || (SELECT coalesce(string_agg(x::text, '|' ORDER BY x.id), '') FROM ouvrages x)) AS e`))[0].e;
  const refAvant = await empreinteReferentiel();
  const auditAvantTout = await compter(`SELECT count(*) n FROM audit_logs`);

  // ============================================================ 1. Gardes
  const routesLecture = ["/synthese", "/propositions", "/propositions.geojson?bbox=-13.7,9.5,-13.4,9.8", "/produits", "/sources", "/precision", "/qualite-methodes"];
  const sansJeton = await Promise.all(routesLecture.map((c) => get(c)));
  verifier("sans jeton : 401 { error, code } sur chaque route de lecture", sansJeton.every((r) => r.status === 401 && r.body.code === "NON_AUTHENTIFIE" && typeof r.body.error === "string"), sansJeton.map((r) => r.status));
  const forge = jwt.sign({ sub: admin.id, role: "ADMIN", email: admin.email }, "un-autre-secret-un-autre-secret-123456");
  verifier("jeton forge (autre secret, role ADMIN) : 401", (await get("/sources", forge)).status === 401 && (await post("/propositions", {}, forge)).status === 401);
  const sm = await get("/sources", T.sansModule);
  verifier("compte sans la cle `teledetection` : 403 MODULE_NON_AUTORISE (lecture et ecriture)", sm.status === 403 && sm.body.code === "MODULE_NON_AUTORISE" && (await post("/produits", {}, T.sansModule)).body.code === "MODULE_NON_AUTORISE", sm.body);
  if (typeof auth._installerResolveurCompte === "function") {
    const off = await get("/sources", T.desactive);
    verifier("compte desactive : 401 COMPTE_INACTIF", off.status === 401 && off.body.code === "COMPTE_INACTIF", off.body);
  } else {
    console.log("NON APPLICABLE dans cette base : requireAuth ne relit pas le compte (garde COMPTE_INACTIF absente du worktree, presente dans l'arbre principal non commite).");
  }
  verifier("lecteur : lit (200) mais ne decide pas (403 ROLE_INSUFFISANT)",
    (await get("/propositions", T.lecteur)).status === 200 && (await post(`/propositions/${"0".repeat(8)}-0000-4000-8000-000000000000/transition`, {}, T.lecteur)).body.code === "ROLE_INSUFFISANT");

  // ============================================================ 2. Sources a l'amorce
  const src0 = await get("/sources", T.lecteur);
  verifier("amorce : quatre sources, aucune active, aucune verifiee, etats NON_CONFIGUREE / EN_ATTENTE_CONFIGURATION",
    src0.status === 200 && Array.isArray(src0.body) && src0.body.length === 4
    && src0.body.every((s: { active: boolean; derniereVerification: unknown; etat: string; requiertIdentifiants: boolean }) => !s.active && s.derniereVerification === null && s.etat === (s.requiertIdentifiants ? "EN_ATTENTE_CONFIGURATION" : "NON_CONFIGUREE")), src0.body);
  verifier("chaque source relie son adaptateur de catalogue (cdse-stac, earth-search, planetscope, spot)",
    ["SENTINEL2:cdse-stac", "LANDSAT89:earth-search", "PLANETSCOPE:planetscope", "SPOT:spot"].every((x) => { const [c, a] = x.split(":"); return src0.body.find((s: { code: string }) => s.code === c)?.adaptateur === a; }));
  const synth0 = await get("/synthese", T.gest);
  verifier("synthese a vide : taux nul (pas 0 %), echantillon insuffisant, 4 sources dont 0 active, derniere acquisition nulle",
    synth0.status === 200 && synth0.body.tauxConfirmation.valeur === null && synth0.body.tauxConfirmation.echantillonSuffisant === false && synth0.body.sources.total === 4 && synth0.body.sources.actives === 0 && synth0.body.derniereAcquisition === null, synth0.body);

  // ============================================================ 3. Depot par un traitement (produits, propositions)
  const emprise = { type: "Polygon", coordinates: [[[-13.7, 9.1], [-12.9, 9.1], [-12.9, 10.0], [-13.7, 10.0], [-13.7, 9.1]]] };
  const base = { palier: 0, source: "Sentinel-1 GRD", nature: "RADAR", resolutionM: 10, incertitude: "chatoiement radar", provenance: "scene-banc", licence: "relevee a la source", versionTraitement: "v0", emprise };
  const pRef = await post("/produits", { ...base, code: "API-REF", dateAcquisition: "2026-09-01" }, T.gest);
  const pNew = await post("/produits", { ...base, code: "API-NEW", dateAcquisition: "2026-10-02" }, T.gest);
  const pSyn = await post("/produits", { ...base, code: "API-SYN", dateAcquisition: "2026-10-03", synthetique: true }, T.admin);
  verifier("depot de trois produits (dont un synthetique) : 201", [pRef, pNew, pSyn].every((r) => r.status === 201), [pRef.body, pNew.body]);
  const limites = ["Resolution native 10 m : les nids-de-poule et les fissures fines ne sont pas detectables."];
  const lot = await post("/propositions", {
    produitId: pNew.body.id, produitReferenceId: pRef.body.id, methodeNom: "banc-sar", methodeVersion: "v1", toleranceRattachementM: 50,
    propositions: [
      { type: "INONDATION", geometrie: { type: "Point", coordinates: [-13.595, 9.6401] }, score: 0.7, confianceDetection: 0.87, priorite: { niveau: "HAUTE", regle: "banc-regle-1" }, imageCouvertureNuagesPct: 12, limites },
      { type: "INONDATION", geometrie: { type: "Point", coordinates: [-13.195, 9.9001] }, priorite: { niveau: "MOYENNE", regle: "banc-regle-1" }, limites },
      { type: "NOUVELLE_ROUTE", geometrie: { type: "LineString", coordinates: [[-13.0, 9.2], [-12.99, 9.21]] }, limites },
    ],
  }, T.gest);
  verifier("lot de 3 propositions : 201, 2 rattachees (tolerance 50 m), 1 non rattachee", lot.status === 201 && lot.body.deposees === 3 && lot.body.rattachees === 2 && lot.body.nonRattachees === 1, lot.body);
  const [idA, idB, idFar] = lot.body.ids as string[];
  const lotSyn = await post("/propositions", { produitId: pSyn.body.id, methodeNom: "banc-synth", methodeVersion: "v0", synthetique: true, toleranceRattachementM: 50, propositions: [{ type: "INONDATION", geometrie: { type: "Point", coordinates: [-13.595, 9.6402] }, limites }] }, T.admin);
  verifier("lot synthetique sur produit synthetique : 201 ; sur un produit REEL : 400 SYNTHETIQUE_INCOHERENT",
    lotSyn.status === 201 && (await post("/propositions", { produitId: pNew.body.id, methodeNom: "x", methodeVersion: "y", synthetique: true, propositions: [{ type: "INONDATION", geometrie: { type: "Point", coordinates: [-13.0, 9.2] }, limites }] }, T.admin)).body.code === "SYNTHETIQUE_INCOHERENT", lotSyn.body);
  const idSyn = lotSyn.body.ids[0] as string;
  const audLot = await sql<{ after: { ids: string[]; produitId: string } }>(`SELECT after FROM audit_logs WHERE "entityType" = 'PropositionTeledetection' AND after->>'operation' = 'DEPOT_LOT_IDENTIFIANTS' AND after->>'produitId' = $1`, pNew.body.id);
  verifier("le depot de lot audite les IDENTIFIANTS des propositions (limite constatee : un compteur seulement)", audLot.length === 1 && [...audLot[0].after.ids].sort().join() === [idA, idB, idFar].sort().join(), audLot);
  const rattachement = await sql<{ id: string; regionId: number | null; rattachementConfiance: string; centre: string | null }>(`SELECT id, "regionId", "rattachementConfiance", ST_AsText(centre) AS centre FROM propositions_teledetection WHERE id = ANY($1::text[])`, [idA, idB, idFar]);
  verifier("la region est posee depuis le troncon (R1 / R2 / nulle) et le centre est calcule par la base",
    rattachement.find((r) => r.id === idA)?.regionId === R1 && rattachement.find((r) => r.id === idB)?.regionId === R2 && rattachement.find((r) => r.id === idFar)?.regionId === null && rattachement.every((r) => r.centre?.startsWith("POINT")), rattachement);

  // ============================================================ 4. Listes, pagination, perimetre
  const liste = await get("/propositions", T.gest);
  ex["GET /propositions (extrait : 1 element sur 3)"] = { ...liste.body, items: liste.body.items?.slice(0, 1) };
  verifier("liste nationale : 3 propositions reelles (la synthetique n'y est jamais), total 3, forme du contrat",
    liste.status === 200 && liste.body.items.length === 3 && liste.body.total === 3 && liste.body.suivant === null && !liste.body.items.some((p: { id: string }) => p.id === idSyn), liste.body);
  const pA = liste.body.items.find((p: { id: string }) => p.id === idA);
  verifier("proposition A : priorite et sa regle, indice non calibre, qualite d'image, rattachement, troncon, region, centre, methode",
    pA?.priorite.niveau === "HAUTE" && pA.priorite.regle === "banc-regle-1" && pA.confianceDetection.valeur === 0.87 && pA.confianceDetection.calibree === false && /non calibre/.test(pA.confianceDetection.signification)
    && pA.qualiteImage.couvertureNuagesPct === 12 && ["HAUTE", "MOYENNE", "FAIBLE"].includes(pA.rattachement.confiance) && pA.troncon.code === "API-A" && pA.troncon.regionId === R1 && pA.rattachee === true
    && Math.abs(pA.centre.lat - 9.6401) < 1e-6 && pA.methode.nom === "banc-sar" && pA.methode.version === "v1" && pA.synthetique === false && pA.missionId === null && pA.dateReference?.startsWith("2026-09-01"), pA);
  // pagination par curseur stable
  const vus: string[] = [];
  let curseur: string | null = null;
  let pages = 0;
  do {
    const p = await get(`/propositions?limite=1${curseur ? `&curseur=${curseur}` : ""}`, T.gest);
    vus.push(...p.body.items.map((i: { id: string }) => i.id));
    curseur = p.body.suivant; pages++;
  } while (curseur && pages < 10);
  verifier("pagination par curseur : 3 pages d'un element, chaque proposition une fois, ordre stable (date puis id)", pages === 3 && new Set(vus).size === 3 && vus.join() === liste.body.items.map((i: { id: string }) => i.id).join(), { vus, pages });
  verifier("filtres reels : statut, type, priorite, rattachee, tronconId, q (code de troncon)",
    (await get("/propositions?statut[]=A_VERIFIER&type=INONDATION", T.gest)).body.total === 2
    && (await get("/propositions?priorite=HAUTE", T.gest)).body.items[0]?.id === idA
    && (await get("/propositions?rattachee=false", T.gest)).body.items[0]?.id === idFar
    && (await get(`/propositions?tronconId=${tB.id}`, T.gest)).body.items[0]?.id === idB
    && (await get("/propositions?q=API-A", T.gest)).body.total === 1
    && (await get("/propositions?statut=CONFIRMEE", T.gest)).body.total === 0);
  // perimetre regional
  const lr1 = await get("/propositions", T.gestR1);
  verifier("compte regional (R1) : ne voit que la proposition de sa region ; ni la region 2, ni la non rattachee ; total coherent",
    lr1.status === 200 && lr1.body.items.length === 1 && lr1.body.items[0].id === idA && lr1.body.total === 1, lr1.body);
  const hors = await get(`/propositions/${idB}`, T.gestR1);
  ex["GET /propositions/:id (404, hors perimetre ou inexistant)"] = hors.body;
  const horsNR = await get(`/propositions/${idFar}`, T.gestR1);
  const inexistant = await get(`/propositions/00000000-0000-4000-8000-0000000000ff`, T.gestR1);
  verifier("MEME 404 pour une proposition d'une autre region, une non rattachee et une inexistante (corps identiques)",
    hors.status === 404 && horsNR.status === 404 && inexistant.status === 404 && JSON.stringify(hors.body) === JSON.stringify(inexistant.body) && JSON.stringify(horsNR.body) === JSON.stringify(inexistant.body) && inexistant.body.code === "INTROUVABLE", [hors.body, horsNR.body, inexistant.body]);
  const corpsInvalide = { vers: "N_IMPORTE_QUOI" };
  const hInv = await post(`/propositions/${idB}/transition`, corpsInvalide, T.gestR1);
  const iInv = await post(`/propositions/00000000-0000-4000-8000-0000000000ff/transition`, corpsInvalide, T.gestR1);
  const mInv = await post(`/propositions/${idA}/transition`, corpsInvalide, T.gestR1);
  verifier("ORACLE FERME : corps invalide -> 404 identique hors perimetre et inexistant ; 400 seulement dans le perimetre",
    hInv.status === 404 && iInv.status === 404 && JSON.stringify(hInv.body) === JSON.stringify(iInv.body) && mInv.status === 400 && mInv.body.code === "ENTREE_INVALIDE", [hInv.body, iInv.body, mInv.body]);
  verifier("compte regional : region 2 demandee -> 403 HORS_PERIMETRE (liste et synthese) ; sa propre region -> 200",
    (await get(`/propositions?regionId=${R2}`, T.gestR1)).body.code === "HORS_PERIMETRE" && (await get(`/synthese?regionId=${R2}`, T.gestR1)).status === 403 && (await get(`/synthese?regionId=${R1}`, T.gestR1)).status === 200);
  const sR1 = await get("/synthese", T.gestR1);
  const sNat = await get("/synthese", T.gest);
  ex["GET /synthese"] = sNat.body;
  verifier("synthese : national = 3 a verifier dont 1 prioritaire (HAUTE), regional R1 = 1 ; le synthetique est exclu des deux",
    sNat.body.propositions.aVerifier === 3 && sNat.body.propositions.prioritaires === 1 && sR1.body.propositions.aVerifier === 1 && sR1.body.propositions.prioritaires === 1, [sNat.body.propositions, sR1.body.propositions]);
  verifier("derniere acquisition = produit REEL le plus recent (pas le synthetique, plus recent)", sNat.body.derniereAcquisition?.produitId === pNew.body.id && sNat.body.derniereAcquisition.resolutionM === 10, sNat.body.derniereAcquisition);

  // GeoJSON
  const geo = await get("/propositions.geojson?bbox=-13.7,9.1,-12.9,10.0", T.gest);
  verifier("GeoJSON national : 3 entites, tronque false, total 3, proprietes minimales, priorite haute en tete",
    geo.status === 200 && geo.body.type === "FeatureCollection" && geo.body.features.length === 3 && geo.body.tronque === false && geo.body.total === 3
    && geo.body.features[0].properties.id === idA && Object.keys(geo.body.features[0].properties).sort().join() === "id,priorite,rattachee,statut,type" && geo.body.features[0].geometry.type === "Point", geo.body);
  const geoCap = await get("/propositions.geojson?bbox=-13.7,9.1,-12.9,10.0&limite=2", T.gest);
  ex["GET /propositions.geojson?limite=2"] = geoCap.body;
  verifier("GeoJSON plafonne : tronque true et total 3 (jamais de troncature silencieuse) ; ordre priorite haute puis A_VERIFIER puis id",
    geoCap.body.tronque === true && geoCap.body.total === 3 && geoCap.body.features.length === 2 && geoCap.body.features[0].properties.id === idA && geoCap.body.features[1].properties.id === [idB, idFar].sort()[0], geoCap.body);
  // Les identifiants sont des UUID aleatoires : a priorite et statut egaux (B et le lointain), l'ordre est celui de l'id, donc le second element attendu se calcule, il ne se suppose pas (l'ancienne assertion fixe etait un test instable, un echec sur deux).
  const geoR1 = await get("/propositions.geojson?bbox=-13.7,9.1,-12.9,10.0", T.gestR1);
  verifier("GeoJSON regional : sa region seulement", geoR1.body.features.length === 1 && geoR1.body.features[0].properties.id === idA && geoR1.body.total === 1, geoR1.body);
  verifier("GeoJSON : emprise sans cote de plus de 10 degres, hors du globe ou absente -> 400",
    (await get("/propositions.geojson?bbox=-21,5,-10,12", T.gest)).status === 400 && (await get("/propositions.geojson?bbox=-200,5,-190,12", T.gest)).status === 400 && (await get("/propositions.geojson", T.gest)).status === 400);

  // Detail
  const det = await get(`/propositions/${idA}`, T.lecteur);
  ex["GET /propositions/:id (avant decision)"] = det.body;
  verifier("detail : produits avant/apres, limites, provenance, geometrie GeoJSON, historique vide, apercus par URL SERVEUR ou nulle",
    det.status === 200 && det.body.produitApres?.id === pNew.body.id && det.body.produitAvant?.id === pRef.body.id && det.body.limites[0] === limites[0] && det.body.geometrie?.type === "Point"
    && Array.isArray(det.body.historique) && det.body.historique.length === 0 && det.body.mission === null && det.body.terrain.observations.length === 0
    && det.body.apercus.apres.url === null && !JSON.stringify(det.body).match(/https?:\/\//) && typeof det.body.provenance === "object", det.body);
  verifier("detail d'une donnee synthetique : lisible par identifiant, avec son drapeau", (await get(`/propositions/${idSyn}`, T.admin)).body.synthetique === true);

  // ============================================================ 5. Workflow bout en bout
  const obsAgent = await prisma.observation.create({ data: { clientOperationId: "op-eo-api-1", agentId: inspecteur.id, type: "DEGRADATION", observeA: new Date(), description: "Chaussee submergee sur 40 m" } });
  const obsAutre = await prisma.observation.create({ data: { clientOperationId: "op-eo-api-2", agentId: gest.id, type: "DEGRADATION", observeA: new Date() } });
  const transition = (id: string, corps: unknown, t = T.gest) => post(`/propositions/${id}/transition`, corps, t);
  const refus1 = await transition(idA, { vers: "A_VERIFIER", motif: "x" });
  ex["POST /propositions/:id/transition (409 TRANSITION_INTERDITE)"] = refus1.body;
  verifier("A_VERIFIER vers A_VERIFIER : 409 TRANSITION_INTERDITE, rien d'ecrit", refus1.status === 409 && refus1.body.code === "TRANSITION_INTERDITE" && await compter(`SELECT count(*) n FROM propositions_teledetection_transitions WHERE "propositionId" = $1`, idA) === 0, refus1.body);
  const t1 = await transition(idA, { vers: "EN_ATTENTE", motif: "Equipe prevenue", motifAttente: "INFO_DEMANDEE", commentaire: "Voir l'equipe du pont" });
  ex["POST /propositions/:id/transition (200)"] = t1.body;
  const t2 = await transition(idA, { vers: "NON_CONCLUANTE", motif: "Image voilee" });
  const t3 = await transition(idA, { vers: "A_VERIFIER", motif: "Nouvelle image attendue" });
  verifier("trois transitions (attente avec motif, non concluante, retour a verifier) : 200 chacune", [t1, t2, t3].every((t) => t.status === 200), [t1.body, t2.body, t3.body]);
  const sansConstat = await transition(idA, { vers: "CONFIRMEE", motif: "Eau constatee" });
  verifier("un verdict sans constat est refuse (400 CONSTAT_REQUIS)", sansConstat.status === 400 && sansConstat.body.code === "CONSTAT_REQUIS", sansConstat.body);
  const preuveAutre = await transition(idA, { vers: "CONFIRMEE", motif: "Eau constatee", observationIds: ["00000000-0000-4000-8000-0000000000aa"] });
  verifier("une preuve inexistante est refusee (404 OBSERVATION_INEXISTANTE, sans identifiant dans le message), rien d'ecrit", preuveAutre.status === 404 && preuveAutre.body.code === "OBSERVATION_INEXISTANTE" && !JSON.stringify(preuveAutre.body).includes("0000000000aa"), preuveAutre.body);
  const t4 = await transition(idA, { vers: "CONFIRMEE", motif: "Eau constatee sur 40 m", observationIds: [obsAgent.id] });
  verifier("verdict CONFIRMEE avec preuve de terrain : 200, verdict renseigne", t4.status === 200 && t4.body.statut === "CONFIRMEE" && t4.body.verdict?.par === gest.id && t4.body.preuvesAjoutees === 1, t4.body);
  const apres = await transition(idA, { vers: "EN_ATTENTE", motif: "Revenir en arriere", motifAttente: "AUTRE" });
  ex["POST /propositions/:id/transition (409 VERDICT_DEFINITIF)"] = apres.body;
  verifier("un verdict est definitif : 409 VERDICT_DEFINITIF", apres.status === 409 && apres.body.code === "VERDICT_DEFINITIF", apres.body);
  const hist = await get(`/propositions/${idA}`, T.lecteur);
  ex["GET /propositions/:id (apres 4 transitions)"] = hist.body;
  verifier("historique du detail : 4 transitions dans l'ordre, auteur nomme, motif et commentaire ; preuve de terrain listee",
    hist.body.historique.map((h: { vers: string }) => h.vers).join() === "EN_ATTENTE,NON_CONCLUANTE,A_VERIFIER,CONFIRMEE" && hist.body.historique[0].auteur.nom === "Compte eo-gest" && hist.body.historique[0].commentaire === "Voir l'equipe du pont"
    && hist.body.historique[0].de === "A_VERIFIER" && hist.body.terrain.observations[0]?.id === obsAgent.id && /DEGRADATION/.test(hist.body.terrain.observations[0].resume) && hist.body.verdict?.statut === "CONFIRMEE", hist.body);
  verifier("journal en base : une ligne par transition ; audit VALIDATE pour le verdict",
    await compter(`SELECT count(*) n FROM propositions_teledetection_transitions WHERE "propositionId" = $1`, idA) === 4
    && await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'PropositionTeledetection' AND "entityId" = $1 AND action = 'VALIDATE'`, idA) === 1);
  const tB1 = await transition(idB, { vers: "INFIRMEE", motif: "Chaussee seche", constatRef: "mission:terrain-12" });
  verifier("verdict INFIRMEE avec une reference de constat : 200 ; audit REJECT", tB1.status === 200 && await compter(`SELECT count(*) n FROM audit_logs WHERE "entityId" = $1 AND action = 'REJECT'`, idB) === 1, tB1.body);
  const sApres = await get("/synthese", T.gest);
  verifier("synthese apres deux verdicts : 1 confirmee, 1 infirmee, taux 0,5 sur 2 verdicts, echantillon INSUFFISANT (n < 30)",
    sApres.body.propositions.confirmees === 1 && sApres.body.propositions.infirmees === 1 && sApres.body.tauxConfirmation.valeur === 0.5 && sApres.body.tauxConfirmation.jugees === 2 && sApres.body.tauxConfirmation.echantillonSuffisant === false, sApres.body.tauxConfirmation);
  const qm = await get("/qualite-methodes", T.lecteur);
  ex["GET /qualite-methodes"] = qm.body;
  const ligneQ = qm.body.lignes?.find((l: { methodeNom: string }) => l.methodeNom === "banc-sar");
  verifier("qualite-methodes : effectifs et echantillonSuffisant false ; le synthetique est exclu ; /precision conservee",
    qm.status === 200 && ligneQ?.jugees === 2 && ligneQ.confirmees === 1 && ligneQ.echantillonSuffisant === false && !qm.body.lignes.some((l: { methodeNom: string }) => l.methodeNom === "banc-synth") && qm.body.seuilEchantillon === 30
    && (await get("/precision", T.lecteur)).body.lignes.some((l: { methode: string }) => l.methode === "banc-sar v1"), qm.body);

  // ============================================================ 6. Mission de verification et preuves de l'inspecteur
  const idFarAffecte = idFar;
  const ver = await post(`/propositions/${idFarAffecte}/verification`, { commentaire: "A voir cette semaine", assigneId: inspecteur.id }, T.gest);
  ex["POST /propositions/:id/verification (201)"] = ver.body;
  const miss = ver.status === 201 ? (await sql<{ regionId: number | null; emprise: string | null; assigneId: string | null }>(`SELECT "regionId", ST_AsText(emprise) AS emprise, "assigneId" FROM missions WHERE id = $1`, ver.body.id))[0] : null;
  verifier("mission de verification d'une proposition NON rattachee : 201, region nulle (jamais inventee), emprise posee, agent assigne", ver.status === 201 && miss?.regionId === null && miss.emprise?.startsWith("POLYGON") === true && miss.assigneId === inspecteur.id, ver.body);
  verifier("une seule mission par proposition (409 MISSION_DEJA_DEPECHEE) ; l'audit garde le commentaire",
    (await post(`/propositions/${idFarAffecte}/verification`, {}, T.gest)).body.code === "MISSION_DEJA_DEPECHEE"
    && await compter(`SELECT count(*) n FROM audit_logs WHERE after->>'operation' = 'DEMANDE_VERIFICATION' AND after->>'commentaire' = 'A voir cette semaine'`) === 1);
  const insp = (corps: unknown, t = T.inspecteur) => post(`/propositions/${idFarAffecte}/preuves`, corps, t);
  verifier("inspecteur : ne decide pas (403), ne cree pas de mission (403)",
    (await transition(idFarAffecte, { vers: "EN_ATTENTE", motif: "x", motifAttente: "AUTRE" }, T.inspecteur)).body.code === "ROLE_INSUFFISANT" && (await post(`/propositions/${idFarAffecte}/verification`, {}, T.inspecteur)).body.code === "ROLE_INSUFFISANT");
  const pAutreAgent = await insp({ observationIds: [obsAgent.id] }, T.inspecteur2);
  verifier("inspecteur NON affecte a la mission : 403 MISSION_NON_AFFECTEE", pAutreAgent.status === 403 && pAutreAgent.body.code === "MISSION_NON_AFFECTEE", pAutreAgent.body);
  const pObsAutrui = await insp({ observationIds: [obsAutre.id] });
  verifier("inspecteur affecte, observation d'un AUTRE agent : 403 OBSERVATION_NON_AUTEUR", pObsAutrui.status === 403 && pObsAutrui.body.code === "OBSERVATION_NON_AUTEUR", pObsAutrui.body);
  const pOk = await insp({ observationIds: [obsAgent.id] });
  ex["POST /propositions/:id/preuves (201)"] = pOk.body;
  const pDouble = await insp({ observationIds: [obsAgent.id] });
  verifier("inspecteur affecte, SON observation : 201 (1 ajoutee) ; la meme redite est comptee a part (0 ajoutee, 1 deja citee)", pOk.status === 201 && pOk.body.ajoutees === 1 && pDouble.body.ajoutees === 0 && pDouble.body.dejaCitees === 1, [pOk.body, pDouble.body]);
  const detFar = await get(`/propositions/${idFarAffecte}`, T.gest);
  verifier("le detail montre la mission (agent nomme) et la preuve de terrain", detFar.body.mission?.statut === "BROUILLON" && detFar.body.mission.assigneNom === "Compte eo-insp" && detFar.body.terrain.observations[0]?.id === obsAgent.id, detFar.body);
  verifier("preuves sur une proposition jugee : 409 VERDICT_DEFINITIF", (await post(`/propositions/${idA}/preuves`, { observationIds: [obsAgent.id] }, T.gest)).body.code === "VERDICT_DEFINITIF");
  const verA = await post(`/propositions/${idA}/verification`, {}, T.gest);
  verifier("mission demandee sur une proposition deja jugee : refusee (409)", verA.status === 409, verA.body);

  // ============================================================ 6 bis. Perimetre regional : preuves, detail, agregats nationaux, curseurs (EO-FIX-BACK 1, 2, 3)
  await sql(`INSERT INTO propositions_teledetection (id, "produitId", type, methode, geom, "tronconId", "distanceTronconM", "creeParId", limites)
    VALUES ('00000000-0000-4000-8000-0000000000c1', $1, 'INONDATION', 'banc-perimetre v1', ST_SetSRID(ST_MakePoint(-13.595, 9.6401), 4326), $2, 10, $3, ARRAY['limite d essai'])`, pNew.body.id, tA.id, gest.id);
  const pR1 = "00000000-0000-4000-8000-0000000000c1";
  const obsR1 = await prisma.observation.create({ data: { clientOperationId: "op-eo-api-r1", agentId: inspecteur2.id, type: "DEGRADATION", observeA: new Date(), description: "OBSERVATION DE LA REGION 1", tronconId: tA.id } });
  const obsR2 = await prisma.observation.create({ data: { clientOperationId: "op-eo-api-r2", agentId: inspecteur2.id, type: "DEGRADATION", observeA: new Date(), description: "DESCRIPTION CONFIDENTIELLE REGION 2", tronconId: tB.id } });
  const obsSansRegion = await prisma.observation.create({ data: { clientOperationId: "op-eo-api-r0", agentId: inspecteur2.id, type: "DEGRADATION", observeA: new Date(), description: "DESCRIPTION CONFIDENTIELLE SANS REGION" } });
  const inexistante = "00000000-0000-4000-8000-0000000000dd";
  const citer = (id: string) => transition(pR1, { vers: "NON_CONCLUANTE", motif: "Terrain impraticable", observationIds: [id] }, T.gestR1);
  const refusPreuves = [await citer(obsR2.id), await citer(obsSansRegion.id), await citer(inexistante)];
  verifier("un gestionnaire de la region 1 ne cite NI l'observation d'un autre agent de la region 2, NI une observation sans region, NI une inexistante : la MEME reponse 404 sans identifiant",
    refusPreuves.every((r) => r.status === 404 && r.body.code === "OBSERVATION_INEXISTANTE" && JSON.stringify(r.body) === JSON.stringify(refusPreuves[0].body))
    && ![obsR2.id, obsSansRegion.id, inexistante].some((id) => JSON.stringify(refusPreuves[0].body).includes(id)), refusPreuves.map((r) => [r.status, r.body]));
  verifier("rien n'est ecrit par ces refus (statut A_VERIFIER, aucune preuve, aucune ligne de journal)",
    (await sql<{ statut: string }>(`SELECT statut FROM propositions_teledetection WHERE id = $1`, pR1))[0].statut === "A_VERIFIER"
    && await compter(`SELECT count(*) n FROM propositions_teledetection_preuves WHERE "propositionId" = $1`, pR1) === 0
    && await compter(`SELECT count(*) n FROM propositions_teledetection_transitions WHERE "propositionId" = $1`, pR1) === 0);
  const citeOk = await citer(obsR1.id);
  verifier("sa propre region : l'observation rattachee a un troncon de la region 1 est acceptee (200, 1 preuve)", citeOk.status === 200 && citeOk.body.preuvesAjoutees === 1, citeOk.body);
  const natPreuves = await post(`/propositions/${pR1}/preuves`, { observationIds: [obsR2.id, obsSansRegion.id] }, T.gest);
  verifier("un compte NATIONAL cite, lui, l'observation de la region 2 et celle sans region (201, 2 ajoutees)", natPreuves.status === 201 && natPreuves.body.ajoutees === 2, natPreuves.body);
  const detR1 = await get(`/propositions/${pR1}`, T.gestR1);
  const brutR1 = JSON.stringify(detR1.body);
  verifier("DETAIL lu par la region 1 : une seule observation (la sienne), deux MASQUEES et comptees ; ni auteur, ni type, ni description des autres",
    detR1.status === 200 && detR1.body.terrain.observations.length === 1 && detR1.body.terrain.observations[0].id === obsR1.id && detR1.body.terrain.observationsMasquees === 2
    && !brutR1.includes(obsR2.id) && !brutR1.includes(obsSansRegion.id) && !brutR1.includes("CONFIDENTIELLE"), detR1.body.terrain);
  const detNat = await get(`/propositions/${pR1}`, T.gest);
  verifier("le meme detail lu par un compte national : trois observations, aucune masquee", detNat.body.terrain.observations.length === 3 && detNat.body.terrain.observationsMasquees === 0, detNat.body.terrain);
  const agg = await Promise.all([get("/precision", T.gestR1), get("/qualite-methodes", T.gestR1), get("/precision", T.gest), get("/qualite-methodes", T.gest)]);
  verifier("/precision et /qualite-methodes : 403 HORS_PERIMETRE pour un compte regional (aucun agregat national), 200 pour un compte national ; la synthese reste lisible de la region",
    agg[0].status === 403 && agg[0].body.code === "HORS_PERIMETRE" && agg[1].status === 403 && agg[1].body.code === "HORS_PERIMETRE" && !JSON.stringify([agg[0].body, agg[1].body]).includes("lignes")
    && agg[2].status === 200 && agg[3].status === 200 && (await get("/synthese", T.gestR1)).status === 200, agg.map((r) => r.status));
  const cur = (d: string, id = pR1) => Buffer.from(JSON.stringify({ d, id })).toString("base64url");
  const curseursImpossibles = await Promise.all(["0000-01-01T00:00:00.000Z", "2026-02-31T00:00:00.000Z", "0001-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z", "1999-12-31T23:59:59.999Z"]
    .flatMap((d) => [get(`/propositions?curseur=${cur(d)}`, T.gest), get(`/produits?curseur=${cur(d)}`, T.gest)]));
  verifier("curseurs a date impossible (an 0, 31 fevrier, an 9999, avant 2000) sur /propositions et /produits : 400 ENTREE_INVALIDE, jamais 500", curseursImpossibles.every((r) => r.status === 400 && r.body.code === "ENTREE_INVALIDE"), curseursImpossibles.map((r) => r.status));

  // ============================================================ 7. Sources : verification de connectivite (adaptateur injecte)
  const cdse = support.charger("cdse-stac-s2-l2a.json");
  const installer = (...etapes: unknown[]) => {
    const s = support.fetchScenario(...etapes);
    sourcesService._installerSources({ adaptateurs: sourcesIndex.creerAdaptateurs({ fetch: s.fetch, sleep: async () => undefined }), fetchApercu: null, maintenant: null });
    return s;
  };
  const sc1 = installer(support.reponseJson(cdse.reponse));
  const v1 = await post("/sources/SENTINEL2/verifier", {}, T.admin);
  ex["POST /sources/:code/verifier (200)"] = v1.body;
  verifier("verifier SENTINEL2 (adaptateur injecte) : PRODUIT_DISPONIBLE, jamais TRAITEMENT_OPERATIONNEL, une requete anonyme, aucun jeton",
    v1.status === 200 && v1.body.source.etat === "PRODUIT_DISPONIBLE" && sc1.appels.length === 1 && sc1.appels[0].entetes.Authorization === undefined && !JSON.stringify(v1.body).match(/token|secret|password/i), v1.body);
  const s1 = (await get("/sources", T.lecteur)).body.find((s: { code: string }) => s.code === "SENTINEL2");
  verifier("la base garde l'etat, le message et la date du test ; AUCUNE source n'est « active »",
    s1.etat === "PRODUIT_DISPONIBLE" && s1.derniereVerification !== null && /\(\d+ ms\)/.test(s1.message) && (await get("/synthese", T.gest)).body.sources.actives === 0 && s1.active === false, s1);
  verifier("historique des etats en base (NON_CONFIGUREE vers PRODUIT_DISPONIBLE, auteur renseigne) et audit de la verification",
    await compter(`SELECT count(*) n FROM sources_observation_etats e JOIN sources_observation s ON s.id = e."sourceId" WHERE s.code = 'SENTINEL2' AND e.de = 'NON_CONFIGUREE' AND e.vers = 'PRODUIT_DISPONIBLE' AND e."auteurId" = $1`, admin.id) === 1
    && await compter(`SELECT count(*) n FROM audit_logs WHERE after->>'operation' = 'VERIFIER_CONNECTIVITE' AND "userId" = $1`, admin.id) === 1);
  installer(new Response("oups", { status: 503 }));
  const v2 = await post("/sources/SENTINEL2/verifier", {}, T.admin);
  ex["POST /sources/:code/verifier (503 SOURCE_INDISPONIBLE)"] = v2.body;
  const s2 = (await get("/sources", T.lecteur)).body.find((s: { code: string }) => s.code === "SENTINEL2");
  verifier("catalogue en panne : 503 SOURCE_INDISPONIBLE ET l'etat EN_ERREUR est enregistre (la source descend, honnetement)", v2.status === 503 && v2.body.code === "SOURCE_INDISPONIBLE" && s2.etat === "EN_ERREUR", [v2.body, s2]);
  installer(support.reponseJson(cdse.reponse));
  verifier("le catalogue revient : la source remonte a PRODUIT_DISPONIBLE", (await post("/sources/cdse-stac/verifier", {}, T.admin)).body.source.etat === "PRODUIT_DISPONIBLE");
  const scF = installer(support.reponseJson(cdse.reponse));
  const vf = await post("/sources/PLANETSCOPE/verifier", {}, T.admin);
  verifier("facade PlanetScope : EN_ATTENTE_CONFIGURATION, aucun appel reseau", vf.status === 200 && vf.body.source.etat === "EN_ATTENTE_CONFIGURATION" && scF.appels.length === 0, vf.body);
  verifier("verifier est reserve a l'ADMIN : GESTIONNAIRE 403 ; source inconnue 404", (await post("/sources/SENTINEL2/verifier", {}, T.gest)).body.code === "ROLE_INSUFFISANT" && (await post("/sources/INCONNUE/verifier", {}, T.admin)).status === 404);

  // ============================================================ 8. Synchronisation du catalogue
  const jours = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const demande = (extra: Record<string, unknown> = {}) => ({ bbox: [-14.39, 10.83, -14.19, 11.03], depuis: jours(-30), jusqua: jours(0), nuagesMax: 50, ...extra });
  const pagesCatalogue = () => [support.reponseJson(cdse.reponse), support.reponseJson(cdse.suite.reponse), support.reponseJson(synth.page([]))];
  installer(...pagesCatalogue());
  const sy1 = await post("/sources/SENTINEL2/synchroniser-catalogue", demande(), T.gest);
  ex["POST /sources/:code/synchroniser-catalogue (200)"] = sy1.body;
  verifier("synchronisation : 4 trouves, 4 nouveaux, 0 deja connu, rien d'ecarte, recherche complete", sy1.status === 200 && sy1.body.trouves === 4 && sy1.body.nouveaux === 4 && sy1.body.dejaConnus === 0 && Object.keys(sy1.body.ecartes).length === 0 && sy1.body.complet === true, sy1.body);
  const cat = await sql<{ n: bigint }>(`SELECT count(*) n FROM earth_observation_products WHERE fournisseur = 'CDSE' AND "sourceCode" = 'SENTINEL2' AND "cycleVie" = 'CATALOGUE' AND "empreinteSha256" IS NULL AND "stockageChemin" IS NULL AND NOT synthetique`);
  verifier("4 produits de catalogue en base : reference seulement (cycle CATALOGUE, aucune empreinte, aucun stockage), sans doublon", Number(cat[0].n) === 4);
  const derAcq = (await sql<{ d: Date }>(`SELECT "derniereAcquisitionLe" AS d FROM sources_observation WHERE code = 'SENTINEL2'`))[0].d;
  verifier("la derniere acquisition de la source est la date du produit reel le plus recent du catalogue", derAcq?.toISOString().startsWith("2026-10-25"), derAcq);
  installer(...pagesCatalogue());
  const sy2 = await post("/sources/SENTINEL2/synchroniser-catalogue", demande(), T.gest);
  ex["POST /sources/:code/synchroniser-catalogue (2e appel : dedupliquee)"] = { ...sy2.body, produits: "..." };
  verifier("deuxieme synchronisation : 0 nouveau, 4 deja connus, la base ne grossit pas (deduplication par identifiant fournisseur)",
    sy2.body.nouveaux === 0 && sy2.body.dejaConnus === 4 && Number((await sql<{ n: bigint }>(`SELECT count(*) n FROM earth_observation_products WHERE fournisseur = 'CDSE'`))[0].n) === 4, sy2.body);
  const bon = synth.itemCdseReel();
  installer(support.reponseJson(synth.page([bon, synth.sansNuages(synth.variante(bon, "S2C_MSIL2A_BANC_X1", "2026-10-20T00:00:00Z")), synth.empriseHorsGlobe(synth.variante(bon, "S2C_MSIL2A_BANC_X2", "2026-10-19T00:00:00Z"))])), support.reponseJson(synth.page([])));
  const sy3 = await post("/sources/SENTINEL2/synchroniser-catalogue", demande(), T.admin);
  ex["POST /sources/:code/synchroniser-catalogue (produits ecartes)"] = { ...sy3.body, produits: "..." };
  verifier("produits sans nuages (optique) ou sans emprise valide : ECARTES et comptes par raison, jamais enregistres",
    sy3.status === 200 && sy3.body.nouveaux === 0 && sy3.body.dejaConnus === 1 && sy3.body.ecartes.NUAGES_REQUIS === 1 && Object.keys(sy3.body.ecartes).some((k) => k.startsWith("PRODUIT_ECARTE_"))
    && sy3.body.trouves === sy3.body.nouveaux + sy3.body.dejaConnus + Object.values(sy3.body.ecartes as Record<string, number>).reduce((a, b) => a + b, 0)
    && await compter(`SELECT count(*) n FROM earth_observation_products WHERE "identifiantFournisseur" LIKE 'S2C_MSIL2A_BANC_%'`) === 0, sy3.body);
  verifier("l'audit de la synchronisation et de chaque produit cree existe", await compter(`SELECT count(*) n FROM audit_logs WHERE after->>'operation' = 'SYNCHRONISER_CATALOGUE'`) === 3 && await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'EarthObservationProduct' AND after->>'fournisseur' = 'CDSE'`) === 4);
  verifier("synchroniser : compte regional 403 HORS_PERIMETRE, lecteur 403, facade 409, fenetre trop longue 400, bbox trop grande 400, corridorId 400",
    (await post("/sources/SENTINEL2/synchroniser-catalogue", demande(), T.gestR1)).body.code === "HORS_PERIMETRE" && (await post("/sources/SENTINEL2/synchroniser-catalogue", demande(), T.lecteur)).body.code === "ROLE_INSUFFISANT"
    && (await post("/sources/PLANETSCOPE/synchroniser-catalogue", demande(), T.admin)).body.code === "SOURCE_NON_CONFIGUREE" && (await post("/sources/SENTINEL2/synchroniser-catalogue", demande({ depuis: jours(-200) }), T.admin)).status === 400
    && (await post("/sources/SENTINEL2/synchroniser-catalogue", demande({ bbox: [-16, 8, -10, 12] }), T.admin)).status === 400 && (await post("/sources/SENTINEL2/synchroniser-catalogue", demande({ bbox: undefined, corridorId: tA.id }), T.admin)).status === 400);

  // ============================================================ 9. Apercu
  const prodCat = (await sql<{ id: string; identifiantFournisseur: string }>(`SELECT id, "identifiantFournisseur" FROM earth_observation_products WHERE fournisseur = 'CDSE' ORDER BY "identifiantFournisseur" LIMIT 1`))[0];
  const itemCat = [...cdse.reponse.features, ...cdse.suite.reponse.features].find((f: { id: string }) => f.id === prodCat.identifiantFournisseur);
  installer(support.reponseJson(itemCat));
  sourcesService._installerSources({ fetchApercu: async () => new Response("", { status: 404, headers: { "content-type": "image/jpeg" } }) });
  const ap404 = await get(`/produits/${prodCat.id}/apercu`, T.lecteur);
  ex["GET /produits/:id/apercu (404)"] = ap404.body;
  verifier("vignette indisponible chez le fournisseur : 404 APERCU_INDISPONIBLE, aucune image de remplacement, aucune adresse dans la reponse", ap404.status === 404 && ap404.body.code === "APERCU_INDISPONIBLE" && !JSON.stringify(ap404.body).match(/https?:/), ap404.body);
  const octets = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  installer(support.reponseJson(itemCat));
  sourcesService._installerSources({ fetchApercu: async () => new Response(octets, { status: 200, headers: { "content-type": "image/png" } }) });
  const ap200 = await get(`/produits/${prodCat.id}/apercu`, T.lecteur);
  verifier("vignette lue COTE SERVEUR : 200 image/png, en-tetes prudents, octets identiques", ap200.status === 200 && ap200.headers["content-type"] === "image/png" && ap200.headers["cache-control"] === "private, max-age=300" && ap200.headers["x-content-type-options"] === "nosniff" && Buffer.from(ap200.body).equals(octets));
  verifier("produit saisi a la main (sans reference de catalogue), synthetique, inconnu : 404 APERCU_INDISPONIBLE",
    (await get(`/produits/${pNew.body.id}/apercu`, T.gest)).body.code === "APERCU_INDISPONIBLE" && (await get(`/produits/${pSyn.body.id}/apercu`, T.gest)).body.code === "APERCU_INDISPONIBLE"
    && (await get(`/produits/00000000-0000-4000-8000-0000000000ee/apercu`, T.gest)).status === 404);
  const prods = await get("/produits?source=SENTINEL2&nature=OPTIQUE", T.lecteur);
  ex["GET /produits?source=SENTINEL2&nature=OPTIQUE"] = { ...prods.body, items: prods.body.items?.slice(0, 1) };
  verifier("registre des produits : filtres source et nature, pagination, le synthetique n'y figure pas", prods.status === 200 && prods.body.total === 4 && prods.body.items.length === 4 && prods.body.items.every((p: { source: { code: string } }) => p.source.code === "SENTINEL2")
    && !(await get("/produits", T.lecteur)).body.items.some((p: { id: string }) => p.id === pSyn.body.id) && (await get("/produits?limite=2", T.lecteur)).body.suivant !== null);

  // ============================================================ 10. Entrees hostiles : 400, jamais 500, aucune ecriture
  const lignesAvant = {
    produits: await compter(`SELECT count(*) n FROM earth_observation_products`), props: await compter(`SELECT count(*) n FROM propositions_teledetection`),
    audit: await compter(`SELECT count(*) n FROM audit_logs`),
  };
  const unePoint = (geometrie: unknown, extra: Record<string, unknown> = {}) => ({ produitId: pNew.body.id, methodeNom: "banc-hostile", methodeVersion: "v0", propositions: [{ type: "INONDATION", geometrie, limites, ...extra }] });
  const hostiles: [string, Promise<{ status: number; body: { code?: string } }>][] = [
    ["coordinates en texte", post("/propositions", unePoint({ type: "Point", coordinates: "9.6,-13.6" }), T.admin)],
    ["coordinates absentes", post("/propositions", unePoint({ type: "Point" }), T.admin)],
    ["type de geometrie inconnu", post("/propositions", unePoint({ type: "Cercle", coordinates: [0, 0] }), T.admin)],
    ["polygone auto-intersecte", post("/propositions", unePoint({ type: "Polygon", coordinates: [[[-13.1, 9.2], [-13.0, 9.3], [-13.0, 9.2], [-13.1, 9.25], [-13.1, 9.2]]] }), T.admin)],
    ["longitude hors du globe", post("/propositions", unePoint({ type: "Point", coordinates: [200, 0] }), T.admin)],
    ["limites vides", post("/propositions", unePoint({ type: "Point", coordinates: [-13.0, 9.2] }, { limites: [] }), T.admin)],
    ["champ inconnu confianceCalibree", post("/propositions", unePoint({ type: "Point", coordinates: [-13.0, 9.2] }, { confianceCalibree: true }), T.admin)],
    ["emprise de produit hors du globe", post("/produits", { ...base, code: "API-H1", dateAcquisition: "2026-10-04", emprise: { type: "Polygon", coordinates: [[[0, 0], [200, 0], [200, 1], [0, 1], [0, 0]]] } }, T.admin)],
    ["produit date de l'an 2999", post("/produits", { ...base, code: "API-H2", dateAcquisition: "2999-01-01" }, T.admin)],
    ["produit sans licence", post("/produits", { ...base, code: "API-H3", dateAcquisition: "2026-10-04", licence: "" }, T.admin)],
    ["trou hors de l'anneau (refus de PostGIS)", post("/propositions", unePoint({ type: "Polygon", coordinates: [[[-13.1, 9.2], [-13.0, 9.2], [-13.0, 9.3], [-13.1, 9.3], [-13.1, 9.2]], [[-12.5, 9.5], [-12.4, 9.5], [-12.4, 9.6], [-12.5, 9.6], [-12.5, 9.5]]] }), T.admin)],
  ];
  const rh = await Promise.all(hostiles.map(async ([nom, p]) => [nom, await p] as const));
  verifier("entrees hostiles de depot : 400 { error, code } chacune, jamais 500", rh.every(([, r]) => r.status === 400 && typeof r.body.code === "string"), rh.map(([n, r]) => `${n}:${r.status}:${r.body.code}`));
  const trou0 = rh.find(([n]) => n.startsWith("trou"))![1];
  ex["POST /propositions (400, entree hostile)"] = rh.find(([n]) => n.startsWith("polygone"))![1].body;
  ex["POST /propositions (400, refus de PostGIS)"] = trou0.body;
  verifier("le refus de PostGIS (trou hors de l'anneau) est traduit en 400 ENTREE_INVALIDE, pas en 500", trou0.status === 400 && trou0.body.code === "ENTREE_INVALIDE", trou0.body);
  const lectures = await Promise.all([
    get("/propositions?statut[]=BIDON", T.gest), get("/propositions?statut=", T.gest), get("/propositions?limite=100000", T.gest), get("/propositions?depuis=2999-01-01", T.gest),
    get("/propositions?curseur=pas-un-curseur", T.gest), get("/propositions/pas-un-uuid", T.gest), get("/propositions/1'%20OR%20'1'='1", T.gest), get("/propositions?tronconId=x", T.gest),
    get("/propositions?%5B%5D=1", T.gest), get("/produits?bbox=0,0,1000,1000", T.gest), get("/synthese?regionId=abc", T.gest),
  ]);
  verifier("lectures hostiles : 400 ou 404 avec code, jamais 500, jamais un filtre ignore", lectures.every((r) => (r.status === 400 || r.status === 404) && typeof r.body.code === "string"), lectures.map((r) => r.status));
  const lignesApres = {
    produits: await compter(`SELECT count(*) n FROM earth_observation_products`), props: await compter(`SELECT count(*) n FROM propositions_teledetection`),
    audit: await compter(`SELECT count(*) n FROM audit_logs`),
  };
  verifier("aucune ligne ecrite par les entrees hostiles (produits, propositions, audit inchanges)", JSON.stringify(lignesApres) === JSON.stringify(lignesAvant), { lignesAvant, lignesApres });
  // Constats sur l'application (hors perimetre d'EO-API : middleware d'erreur global), rapportes sans faire echouer le banc.
  const json = (corps: string) => request(app).post(`${BASE}/propositions`).set("Authorization", `Bearer ${T.admin}`).set("Content-Type", "application/json").send(corps);
  const jMalForme = await json("{pas du json");
  const jTexte = await json('"texte"');
  const jGros = await json(JSON.stringify({ x: "a".repeat(5.5 * 1024 * 1024) }));
  console.log(`CONSTAT corps JSON mal forme : ${jMalForme.status} ${JSON.stringify(jMalForme.body)} | corps JSON scalaire : ${jTexte.status} | corps de 5,5 Mio : ${jGros.status} (attendu 400 et 413 ; le middleware d'erreur global ne traduit pas les erreurs de body-parser)`);

  // ============================================================ 11. Audit, lectures, referentiel, indicateurs
  const audAvantLectures = await compter(`SELECT count(*) n FROM audit_logs`);
  await Promise.all(routesLecture.map((c) => get(c, T.gest)));
  await get(`/propositions/${idA}`, T.gest);
  verifier("les LECTURES ne sont pas auditees (audit inchange apres une serie de GET)", await compter(`SELECT count(*) n FROM audit_logs`) === audAvantLectures);
  const types = (await sql<{ t: string; a: string }>(`SELECT DISTINCT "entityType" t, action::text a FROM audit_logs WHERE "createdAt" > now() - interval '1 hour' ORDER BY 1, 2`)).map((x) => `${x.t}:${x.a}`);
  verifier("toute ecriture est auditee (produits, propositions, transitions, preuves, mission, sources)",
    ["EarthObservationProduct:CREATE", "PropositionTeledetection:CREATE", "PropositionTeledetection:VALIDATE", "PropositionTeledetection:REJECT", "PropositionTeledetection:UPDATE", "PropositionTeledetectionPreuve:CREATE", "Mission:CREATE", "SourceObservation:UPDATE"].every((x) => types.includes(x)), types);
  verifier("le total des lignes d'audit a augmente (ecritures tracees)", await compter(`SELECT count(*) n FROM audit_logs`) > auditAvantTout);
  const refApres = await empreinteReferentiel();
  verifier("AUCUNE ecriture dans troncons, portions, ouvrages (empreinte identique avant et apres tout le banc)", refAvant === refApres, { refAvant, refApres });
  await sql(`UPDATE troncons SET nom = 'Troncon modifie (temoin)' WHERE id = $1`, tA.id);
  verifier("temoin : modifier un troncon change l'empreinte (la comparaison est capable de voir une ecriture)", (await empreinteReferentiel()) !== refAvant);

  const defInd = registre.REGISTRE.find((d: { code: string }) => d.code === "propositions_a_verifier");
  const portee = { regions: null, maintenant: new Date() };
  const calc = await defInd.calcul(prisma, portee);
  const ctrl = await defInd.controle(prisma, portee);
  const attendu = await compter(`SELECT count(*) n FROM propositions_teledetection WHERE statut IN ('A_VERIFIER', 'EN_ATTENTE', 'NON_CONCLUANTE') AND NOT synthetique`);
  verifier("indicateur propositions_a_verifier : calcul = controle = comptage a la main, hors synthetique (la proposition synthetique A_VERIFIER n y est pas ; 2 = idB et la proposition de la section 6 bis)", calc === ctrl && calc === attendu && attendu === 2, { calc, ctrl, attendu });
  const tv = await veille.tableauVeille(prisma, new Date());
  verifier("compteur « alertes satellite » de la veille = meme comptage, hors synthetique", tv.alertesSatelliteAVerifier === attendu, tv.alertesSatelliteAVerifier);

  verifier("aucun appel reseau reel pendant tout le banc", appelsReseauInterdits === 0, appelsReseauInterdits);
  if (process.env.EO_API_EXEMPLES) writeFileSync(process.env.EO_API_EXEMPLES, JSON.stringify(ex, null, 2));
}

main()
  .catch((e) => { console.error("ERREUR DU BANC", e); process.exitCode = 2; })
  .finally(async () => { globalThis.fetch = fetchReel; conclure(); await prisma.$disconnect(); await banc.fermer(); });

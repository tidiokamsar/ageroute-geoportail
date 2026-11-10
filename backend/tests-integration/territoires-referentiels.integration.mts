// Banc d'integration du lot T1 : TERRITOIRES HIERARCHIQUES, REFERENTIELS CONFIGURABLES, CONFIGURATION NATIONALE, contre un vrai PostGIS.
// Contrat : docs/projets-voirie/CONTRAT-TERRITOIRES.md. Lancer (DATABASE_URL pointe sur `replay`) :
//   npx tsx tests-integration/territoires-referentiels.integration.mts
//
// Tout passe par l'application reelle (`createApp`), des jetons signes par des secrets aleatoires, role, module et perimetre LUS EN BASE, dans le
// clone jetable `essai_territoires` (la migration 20261103100000 y est appliquee par le banc).
//
// SCENARIO « NOUVELLE VILLE SANS CODE » : un ADMIN cree une region, une prefecture et une commune par l'API (emprise approximative), un projet y est
// cree, un jeu synthetique en WGS 84 y est depose, l'analyse 2D et l'analyse de conflits fonctionnent, le CRS metrique retenu est celui des bandes
// configurees puis celui que le territoire impose, un compte d'une autre region recoit 404. Cas LINEAIRE : un corridor (niveau ZONE) qui couvre
// trois prefectures d'une meme region porte deux projets distincts de largeurs differentes et un axe de plus de 150 km.
//
// DONNEES 100 % SYNTHETIQUES : centres de ville approximatifs (domaine public), emprises rectangulaires grossieres, segments inventes en metres
// (lib/fixtures-conflits.mts) transformes par PostGIS. Aucun plan, aucun reseau, aucun nom d'operateur reel.
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure } from "./lib/verdict.ts";
import { AXES, R1_BASE, constructeurs } from "./lib/fixtures-conflits.mts";

const banc = await ouvrirBancClone("essai_territoires", { migrations: ["20261103100000_territoires_referentiels", "20261103400000_correctifs_sources_territoires"] });
const { prisma } = await banc.imp("lib/prisma");
const { createApp } = await banc.imp("app");
const { signAccessToken } = await banc.imp("utils/jwt");
const request = (await import("supertest")).default;

process.env.PROJETS_VOIRIE_ANALYSE_INTERVALLE_S = "0";
delete process.env.PROJETS_VOIRIE_CRS_SOURCE_AUTORISES;
const app = createApp();
const BASE = "/api/v2/projets-voirie";
const sql = <T = Record<string, unknown>>(texte: string, ...v: unknown[]) => prisma.$queryRawUnsafe(texte, ...v) as Promise<T[]>;
const compter = async (texte: string, ...v: unknown[]) => Number((await sql<{ n: bigint }>(texte, ...v))[0].n);

/** Constructeurs de fichiers autour d'un centre WGS 84, dans l'UTM `epsg` (coordonnees locales en metres). */
async function autour(lon: number, lat: number, epsg: number) {
  const o = (await sql<{ x: number; y: number }>(`SELECT ST_X(p) x, ST_Y(p) y FROM (SELECT ST_Transform(ST_SetSRID(ST_MakePoint($1, $2), 4326), $3::int) p) q`, lon, lat, epsg))[0];
  const wgs = async (pts: [number, number][]): Promise<[number, number][]> => {
    const wkt = `LINESTRING(${pts.map(([x, y]) => `${o.x + x} ${o.y + y}`).join(",")})`;
    const r = await sql<{ g: string }>(`SELECT ST_AsGeoJSON(ST_Transform(ST_SetSRID(ST_GeomFromText($1), $2::int), 4326), 9) AS g`, wkt, epsg);
    return JSON.parse(r[0].g).coordinates;
  };
  return constructeurs(wgs);
}
const rect = (w: number, s: number, e: number, n: number) => ({ type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const geojsonDegres = (lignes: { nom: string; coords: [number, number][] }[]) => Buffer.from(JSON.stringify({
  type: "FeatureCollection", features: lignes.map((l) => ({ type: "Feature", properties: { name: l.nom }, geometry: { type: "LineString", coordinates: l.coords } })),
}));

async function main() {
  // ================================================================ Fixtures
  const mk = (email: string, nomComplet: string, role: string, modules: string[] = ["projets-voirie"]) =>
    prisma.user.create({ data: { email, nomComplet, passwordHash: "x", role, modulesAutorises: modules } });
  const admin = await mk("admin@banc.invalid", "Admin banc", "ADMIN", []);
  const chef = await mk("chef@banc.invalid", "Gestionnaire national", "GESTIONNAIRE");
  const lecteur = await mk("lecteur@banc.invalid", "Lecteur national", "LECTEUR");
  const regK = await mk("regk@banc.invalid", "Gestionnaire region K", "GESTIONNAIRE");
  const regA = await mk("rega@banc.invalid", "Gestionnaire region A", "GESTIONNAIRE");
  const lectK = await mk("lectk@banc.invalid", "Lecteur region K", "LECTEUR");
  const RK = (await prisma.region.create({ data: { nom: "Region banc K" } })).id;
  const RA = (await prisma.region.create({ data: { nom: "Region banc A" } })).id;
  const RW = (await prisma.region.create({ data: { nom: "Region banc W" } })).id;
  await sql(`INSERT INTO perimetres_comptes ("userId","regionId","accordeParId") VALUES ($1,$2,$4),($3,$5,$4),($6,$2,$4)`, regK.id, RK, regA.id, admin.id, RA, lectK.id);
  const jeton = (u: { id: string; role: string; email: string }) => signAccessToken({ sub: u.id, role: u.role, email: u.email });
  const T = { admin: jeton(admin), chef: jeton(chef), lecteur: jeton(lecteur), regK: jeton(regK), regA: jeton(regA), lectK: jeton(lectK) };
  const get = (chemin: string, t = T.admin) => request(app).get(`${BASE}${chemin}`).set("Authorization", `Bearer ${t}`);
  // Decision de l'architecte (10/11/2026) : PUT /configuration/:cle exige une justification ; le banc en ajoute une aux reglages qui n'en portent pas
  // (le refus sans justification est prouve a part, section 12).
  const envoyer = (m: "post" | "patch" | "delete" | "put", chemin: string, corps?: unknown, t = T.admin) => {
    const r = request(app)[m](`${BASE}${chemin}`).set("Authorization", `Bearer ${t}`);
    const c = m === "put" && chemin.startsWith("/configuration/") && corps && typeof corps === "object" && !("justification" in corps) ? { ...corps, justification: "Reglage du banc d'integration" } : corps;
    return c === undefined ? r : r.send(c as object);
  };
  const depot = (pid: string, fichier: Buffer, champs: Record<string, string | undefined>, nom: string, t = T.chef) => {
    const r = request(app).post(`${BASE}/${pid}/jeux`).set("Authorization", `Bearer ${t}`);
    for (const [k, v] of Object.entries(champs)) if (v !== undefined) r.field(k, v);
    return r.attach("fichier", fichier, { filename: nom });
  };
  const JUSTIF = "Controle effectue avec le chef de projet";
  const autoriser = async (pid: string, jid: string, t = T.chef) => (await envoyer("post", `/${pid}/jeux/${jid}/autoriser`, { justification: JUSTIF }, t)).status;
  const troncons = await compter(`SELECT count(*) n FROM troncons`);

  console.log("\n== Territoires, referentiels et configuration : banc PostGIS ==");

  // ================================================================ 1. Donnees de la migration
  const nation = (await sql<{ id: string; code: string }>(`SELECT id, code FROM territoires_voirie WHERE niveau = 'NATION' AND "deletedAt" IS NULL`));
  verifier("1. la migration cree UNE nation", nation.length === 1, nation);
  const NATION = nation[0].id;
  const pilote = await sql<{ code: string; niveau: string; profondeur: number; emprise: boolean }>(`SELECT code, niveau::text, profondeur, emprise IS NOT NULL AS emprise FROM territoires_voirie WHERE code LIKE 'GN-%' ORDER BY profondeur`);
  verifier("1. chaine du pilote : region, prefecture, commune (profondeurs 1, 2, 3), seule la commune porte une emprise",
    JSON.stringify(pilote.map((p) => [p.niveau, p.profondeur, p.emprise])) === JSON.stringify([["REGION", 1, false], ["PREFECTURE", 2, false], ["COMMUNE", 3, true]]), pilote);
  verifier("1. la migration ne cree AUCUN autre territoire nomme (aucune ville de demonstration)", (await compter(`SELECT count(*) n FROM territoires_voirie WHERE code NOT LIKE 'GN%' AND code <> 'NON_RENSEIGNE' AND code NOT LIKE 'MIG-%'`)) === 0);
  const domaines = (await get("/referentiels", T.lecteur)).body.domaines as { domaine: string; nb: number }[];
  // Correctifs T1+S1 (M2) : les 9 codes du lot S1 (GNSS_RTK, TOPOGRAPHIE, GEORADAR, PLAN_CAO...) entrent au referentiel : 5 + 9 = 14 methodes.
  verifier("1. referentiels peuples par les migrations : 6 types de reseau, 1 categorie, 4 types de document, 14 methodes (T1 et S1), 3 statuts",
    JSON.stringify(domaines.map((d) => [d.domaine, d.nb])) === JSON.stringify([["TYPE_RESEAU", 6], ["CATEGORIE_PROJET", 1], ["TYPE_DOCUMENT", 4], ["METHODE_ACQUISITION", 14], ["STATUT_QUALITE", 3]]), domaines);
  const conf0 = (await get("/configuration", T.lecteur)).body.configuration as { cle: string; source: unknown; valeur: unknown }[];
  const bandes0 = conf0.find((c) => c.cle === "CRS_METRIQUE_BANDES")!;
  verifier("1. configuration : quatre cles ; bandes de CRS = regle historique (-12 => 32628, sinon 32629), source BASE",
    conf0.length === 4 && JSON.stringify(bandes0.valeur) === JSON.stringify({ bandes: [{ jusquaLongitude: -12, epsg: 32628 }], epsgDefaut: 32629 }) && bandes0.source === "BASE", conf0);

  // ================================================================ 2. NOUVELLE VILLE SANS CODE : creation par l'API
  const cK = (await envoyer("post", "/territoires", { code: "banc-reg-k", nom: "Region K (banc)", niveau: "REGION", parentId: NATION, regionId: RK }));
  verifier("2. ADMIN cree une region (201), code mis en majuscules, region effective = region du referentiel", cK.status === 201 && cK.body.territoire.code === "BANC-REG-K" && cK.body.territoire.regionEffectiveId === RK, cK.body);
  const REG_K = cK.body.territoire.id;
  const pK = await envoyer("post", "/territoires", { code: "BANC-PREF-K", nom: "Prefecture K (banc)", niveau: "PREFECTURE", parentId: REG_K });
  const PREF_K = pK.body.territoire.id;
  // Emprise APPROXIMATIVE : rectangle d'environ 11 km autour d'un centre de ville (synthetique).
  const comK = await envoyer("post", "/territoires", { code: "BANC-COM-K", nom: "Ville K (banc)", niveau: "COMMUNE", parentId: PREF_K, emprise: rect(-9.36, 10.33, -9.26, 10.43), source: "banc : emprise approximative" });
  const COM_K = comK.body.territoire.id;
  verifier("2. la commune herite de la region (region effective calculee par la base), chemin materialise de profondeur 3, aucun avertissement",
    comK.status === 201 && comK.body.territoire.regionEffectiveId === RK && comK.body.territoire.profondeur === 3 && comK.body.territoire.chemin.startsWith(`/${NATION}/${REG_K}/${PREF_K}/`) && comK.body.avertissements.length === 0, comK.body);
  verifier("2. la reponse porte l'emprise (GeoJSON) et sa boite englobante", comK.body.territoire.emprise?.type === "Polygon" && JSON.stringify(comK.body.territoire.bbox) === JSON.stringify([-9.36, 10.33, -9.26, 10.43]), comK.body.territoire.bbox);
  const quartier = await envoyer("post", "/territoires", { code: "BANC-QUA-HORS", nom: "Quartier hors emprise", niveau: "QUARTIER", parentId: COM_K, emprise: rect(-9.5, 10.5, -9.45, 10.55) });
  verifier("2. emprise d'un enfant hors de celle du parent : creee (201) avec l'avertissement EMPRISE_HORS_PARENT, jamais refusee",
    quartier.status === 201 && quartier.body.avertissements.some((a: { code: string }) => a.code === "EMPRISE_HORS_PARENT"), quartier.body);
  const horsPays = await envoyer("post", "/territoires", { code: "BANC-ZONE-LOIN", nom: "Zone loin", niveau: "ZONE", parentId: NATION, emprise: rect(2, 45, 3, 46) });
  verifier("2. emprise hors de l'emprise nationale : avertissement EMPRISE_HORS_EMPRISE_NATIONALE", horsPays.status === 201 && horsPays.body.avertissements.some((a: { code: string }) => a.code === "EMPRISE_HORS_EMPRISE_NATIONALE"), horsPays.body);
  verifier("2. aucune ligne de code n'a ete ajoutee : la ville existe par ses seules donnees (historique et audit de creation ecrits)",
    (await compter(`SELECT count(*) n FROM territoires_voirie_historique WHERE "territoireId" = $1 AND action = 'CREATION' AND "acteurId" = $2`, COM_K, admin.id)) === 1
    && (await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'TerritoireVoirie' AND "entityId" = $1 AND action = 'CREATE'`, COM_K)) === 1);
  const auditEmprise = (await sql<{ a: string }>(`SELECT after::text a FROM audit_logs WHERE "entityType" = 'TerritoireVoirie' AND "entityId" = $1`, COM_K))[0].a;
  verifier("2. l'audit et l'historique ne portent pas la geometrie (boite englobante et empreinte seulement)", !auditEmprise.includes("coordinates") && auditEmprise.includes("empriseMd5")
    && (await compter(`SELECT count(*) n FROM territoires_voirie_historique WHERE apres::text LIKE '%coordinates%'`)) === 0);

  // ================================================================ 3. Projet dans la nouvelle ville
  const prj = await envoyer("post", "", { code: "BANC-K-VOIRIE", nom: "Voirie de la ville K", territoireId: COM_K }, T.regK);
  const PK = prj.body.projet?.id;
  verifier("3. un compte de la region K cree le projet dans la commune (201) : region, commune et prefecture derivees du territoire",
    prj.status === 201 && prj.body.projet.regionId === RK && prj.body.projet.commune === "Ville K (banc)" && prj.body.projet.prefecture === "Prefecture K (banc)" && prj.body.projet.territoire?.code === "BANC-COM-K", prj.body);
  verifier("3. sans territoire : 400 TERRITOIRE_REQUIS", (await envoyer("post", "", { code: "BANC-SANS", nom: "x" }, T.chef)).body.code === "TERRITOIRE_REQUIS");
  // Correctifs T1+S1 (m3) : territoire d'une autre region, inconnu ou sans region (nation) : la MEME reponse (404 TERRITOIRE_INTROUVABLE), aucun oracle.
  const [horsK, inconnu, sansRegion] = await Promise.all([
    envoyer("post", "", { code: "BANC-A-K", nom: "x", territoireId: COM_K }, T.regA),
    envoyer("post", "", { code: "BANC-A-X", nom: "x", territoireId: "00000000-0000-4000-8000-0000000000aa" }, T.regA),
    envoyer("post", "", { code: "BANC-A-N", nom: "x", territoireId: NATION }, T.regA)]);
  verifier("3. m3 : un compte de la region A qui vise un territoire de la region K, inconnu ou sans region recoit la MEME reponse (404 TERRITOIRE_INTROUVABLE, meme corps) ; rien n'est cree",
    [horsK, inconnu, sansRegion].every((r) => r.status === 404 && JSON.stringify(r.body) === JSON.stringify(horsK.body)) && horsK.body.code === "TERRITOIRE_INTROUVABLE"
    && (await compter(`SELECT count(*) n FROM projets_voirie WHERE code LIKE 'BANC-A-%'`)) === 0, [horsK.body, inconnu.body, sansRegion.body]);
  verifier("3. region du corps incoherente avec celle du territoire : 400 TERRITOIRE_REGION_INCOHERENTE", (await envoyer("post", "", { code: "BANC-INC", nom: "x", territoireId: COM_K, regionId: RA }, T.chef)).body.code === "TERRITOIRE_REGION_INCOHERENTE");
  const avecCat = await envoyer("post", "", { code: "BANC-K-CAT", nom: "Projet a categorie", territoireId: COM_K, categorieCode: "VOIRIE_URBAINE" }, T.chef);
  verifier("3. categorie de projet : largeurs par defaut lues dans le referentiel (15 / 7)", avecCat.status === 201 && avecCat.body.projet.largeurEmpriseM === 15 && avecCat.body.projet.largeurChausseeM === 7 && avecCat.body.projet.categorieCode === "VOIRIE_URBAINE", avecCat.body);
  verifier("3. categorie inconnue : 400 CATEGORIE_INCONNUE", (await envoyer("post", "", { code: "BANC-K-CAT2", nom: "x", territoireId: COM_K, categorieCode: "INEXISTANTE" }, T.chef)).body.code === "CATEGORIE_INCONNUE");

  // ================================================================ 4. Depot synthetique WGS 84 dans l'emprise
  const fK = await autour(-9.31, 10.38, 32629);
  const conc = await envoyer("post", "/concessionnaires", { nom: "Operateur telecom synthetique", typeReseau: "TELECOM" }, T.chef);
  const CONC = conc.body.concessionnaire.id;
  const dAx = await depot(PK, await fK.kml(AXES), { role: "AXES_TRAVAUX" }, "axes.kml", T.regK);
  const JAX = dAx.body.jeu?.id;
  const dR = await depot(PK, await fK.geojson(R1_BASE), { role: "RESEAU_TIERS", concessionnaireId: CONC, classePrecision: "B", precisionHorizontaleM: "3.5" }, "reseau.geojson", T.regK);
  const JR = dR.body.jeu?.id;
  verifier("4. depots acceptes (201) ; la zone attendue de la plausibilite est l'emprise de la commune, aucun objet hors territoire",
    dAx.status === 201 && dR.status === 201 && dR.body.resume.crs.plausibilite.zoneAttendue.nom === "Ville K (banc)" && !dR.body.avertissements.some((a: { code: string }) => a.code === "ELEMENTS_HORS_TERRITOIRE"), dR.body.resume?.crs);
  verifier("4. autorisation des deux jeux", (await autoriser(PK, JAX, T.regK)) === 200 && (await autoriser(PK, JR, T.regK)) === 200);
  const horsTerr = await depot(PK, geojsonDegres([{ nom: "Hors territoire", coords: [[-9.6, 10.6], [-9.59, 10.6]] }]), { role: "AUTRE" }, "hors.geojson", T.regK);
  verifier("4. un objet en Guinee mais hors de l'emprise (approximative) du territoire est CONSERVE et signale (ELEMENTS_HORS_TERRITOIRE), jamais ecarte",
    horsTerr.status === 201 && horsTerr.body.jeu.nbObjets === 1 && horsTerr.body.avertissements.some((a: { code: string; nb: number }) => a.code === "ELEMENTS_HORS_TERRITOIRE" && a.nb === 1) && horsTerr.body.resume.crs.plausibilite.statut === "PARTIELLEMENT_HORS_ZONE", horsTerr.body.avertissements);

  // ================================================================ 5. Analyse 2D et conflits
  const an = await get(`/${PK}/analyse`, T.regK);
  verifier("5. analyse 2D (200) : CRS metrique retenu EPSG:32629 (longitude du centre >= -12, bandes par defaut), 2 croisements, longueur en chaussee > 0",
    an.status === 200 && an.body.regle.projection === "EPSG:32629" && an.body.conflits.total.croisements === 2 && an.body.conflits.total.chausseeM > 0, { s: an.status, p: an.body.regle?.projection, t: an.body.conflits?.total });
  const ac = await envoyer("post", `/${PK}/analyses`, {}, T.regK);
  verifier("5. analyse de conflits persistee (201) avec des conflits trouves", ac.status === 201 && ac.body.analyse.nbConflitsTrouves > 0, ac.body.analyse);

  // ================================================================ 6. Perimetre : 404 masque
  const masque = { error: "Projet introuvable", code: "PROJET_INTROUVABLE" };
  const pA = await get(`/${PK}`, T.regA);
  verifier("6. un compte d'une autre region recoit 404 (meme corps qu'un projet inconnu) sur le projet, l'analyse et la carte",
    pA.status === 404 && JSON.stringify(pA.body) === JSON.stringify(masque) && (await get(`/${PK}/analyse`, T.regA)).status === 404 && (await get(`/${PK}/carte`, T.regA)).status === 404);
  const tA = await get(`/territoires/${COM_K}`, T.regA);
  verifier("6. ... et sur le territoire (404 TERRITOIRE_INTROUVABLE, meme corps qu'un territoire inconnu)",
    tA.status === 404 && JSON.stringify(tA.body) === JSON.stringify((await get(`/territoires/00000000-0000-4000-8000-000000000000`, T.regA)).body));
  const listeA = ((await get("/territoires?limite=500", T.regA)).body.territoires as { id: string }[]).map((t) => t.id);
  const listeK = ((await get("/territoires?limite=500", T.regK)).body.territoires as { id: string; code: string }[]);
  verifier("6. listes filtrees par perimetre : la region A ne voit rien de K ; K voit sa region et sa commune, pas la nation ni le pilote",
    !listeA.includes(COM_K) && listeK.some((t) => t.id === COM_K) && !listeK.some((t) => t.id === NATION || t.code === "GN-COM-KISSIDOUGOU"), listeK.map((t) => t.code));
  verifier("6. un compte national voit tout (nation comprise), ADMIN aussi", ((await get("/territoires?limite=500", T.chef)).body.territoires as { id: string }[]).some((t) => t.id === NATION));
  verifier("6. la liste des projets de la region A ne contient aucun projet de K", ((await get("", T.regA)).body.projets as unknown[]).length === 0);

  // ================================================================ 7. CRS metrique : configuration par bandes, puis CRS impose par le territoire
  const pb = await envoyer("put", "/configuration/CRS_METRIQUE_BANDES", { valeur: { bandes: [{ jusquaLongitude: -9, epsg: 32628 }], epsgDefaut: 32629 }, justification: "banc : deplacement de la bande" });
  verifier("7. ADMIN modifie les bandes (version 2, historisee) ; l'analyse suivante retient EPSG:32628 (longitude < -9) sans redemarrage (cache invalide)",
    pb.status === 200 && pb.body.configuration.version === 2 && (await get(`/${PK}/analyse`, T.regK)).body.regle.projection === "EPSG:32628", pb.body);
  verifier("7. une bande hors liste blanche est refusee (400 CRS_NON_AUTORISE)", (await envoyer("put", "/configuration/CRS_METRIQUE_BANDES", { valeur: { bandes: [], epsgDefaut: 2154 } })).body.code === "CRS_NON_AUTORISE");
  verifier("7. un GESTIONNAIRE ne modifie pas la configuration (403)", (await envoyer("put", "/configuration/CRS_METRIQUE_BANDES", { valeur: { bandes: [], epsgDefaut: 32629 } }, T.chef)).status === 403);
  await envoyer("put", "/configuration/CRS_METRIQUE_BANDES", { valeur: { bandes: [{ jusquaLongitude: -12, epsg: 32628 }], epsgDefaut: 32629 } });
  verifier("7. bandes remises : EPSG:32629 de nouveau", (await get(`/${PK}/analyse`, T.regK)).body.regle.projection === "EPSG:32629");
  const imp = await envoyer("patch", `/territoires/${COM_K}`, { crsMetriqueEpsg: 32628 });
  verifier("7. CRS impose par le territoire (32628) : il l'emporte sur les bandes pour l'analyse 2D", imp.status === 200 && (await get(`/${PK}/analyse`, T.regK)).body.regle.projection === "EPSG:32628");
  verifier("7. CRS impose hors liste blanche ou geographique : 400 CRS_NON_AUTORISE", (await envoyer("patch", `/territoires/${COM_K}`, { crsMetriqueEpsg: 2154 })).body.code === "CRS_NON_AUTORISE");
  await envoyer("patch", `/territoires/${COM_K}`, { crsMetriqueEpsg: null });
  verifier("7. CRS impose retire : regle par bandes (32629)", (await get(`/${PK}/analyse`, T.regK)).body.regle.projection === "EPSG:32629");

  // ================================================================ 8. Une ville a l'ouest (bande 32628 par defaut)
  const regW = (await envoyer("post", "/territoires", { code: "BANC-REG-W", nom: "Region W (banc)", niveau: "REGION", parentId: NATION, regionId: RW })).body.territoire.id;
  const comW = (await envoyer("post", "/territoires", { code: "BANC-COM-W", nom: "Ville W (banc)", niveau: "COMMUNE", parentId: regW, emprise: rect(-13.75, 9.45, -13.55, 9.65) })).body.territoire;
  verifier("8. commune directement sous une region (niveau prefecture saute) : 201", comW.niveau === "COMMUNE" && comW.profondeur === 2);
  const PW = (await envoyer("post", "", { code: "BANC-W-VOIRIE", nom: "Voirie ville W", territoireId: comW.id }, T.chef)).body.projet.id;
  const fW = await autour(-13.65, 9.55, 32628);
  const jw1 = (await depot(PW, await fW.kml(AXES), { role: "AXES_TRAVAUX" }, "axes-w.kml")).body.jeu.id;
  const jw2 = (await depot(PW, await fW.geojson(R1_BASE), { role: "RESEAU_TIERS", concessionnaireId: CONC, classePrecision: "B" }, "reseau-w.geojson")).body.jeu.id;
  await autoriser(PW, jw1); await autoriser(PW, jw2);
  const anW = await get(`/${PW}/analyse`, T.chef);
  verifier("8. analyse a l'ouest : EPSG:32628 (bande longitude < -12), memes 2 croisements", anW.body.regle?.projection === "EPSG:32628" && anW.body.conflits?.total.croisements === 2, anW.body.regle);

  // ================================================================ 9. Referentiels : type de reseau configurable, valeur desactivee lisible
  const tr = await envoyer("post", "/referentiels/TYPE_RESEAU", { code: "fibre_banc", libelle: "Fibre optique (banc)", ordre: 15, parametres: { famille: "TELECOM", couleur: "#123456" } });
  verifier("9. ADMIN ajoute un type de reseau (201), code en majuscules, famille TELECOM", tr.status === 201 && tr.body.valeur.code === "FIBRE_BANC" && tr.body.valeur.systeme === false, tr.body);
  verifier("9. parametres invalides (famille inconnue) : 400 PARAMETRES_INVALIDES", (await envoyer("post", "/referentiels/TYPE_RESEAU", { code: "X_BANC", libelle: "x", parametres: { famille: "FIBRE" } })).body.code === "PARAMETRES_INVALIDES");
  verifier("9. code deja utilise : 409 CODE_DEJA_UTILISE ; GESTIONNAIRE : 403", (await envoyer("post", "/referentiels/TYPE_RESEAU", { code: "FIBRE_BANC", libelle: "x", parametres: { famille: "TELECOM" } })).body.code === "CODE_DEJA_UTILISE"
    && (await envoyer("post", "/referentiels/TYPE_RESEAU", { code: "Y_BANC", libelle: "x", parametres: { famille: "TELECOM" } }, T.chef)).status === 403);
  const conc2 = await envoyer("post", "/concessionnaires", { nom: "Operateur fibre synthetique", typeReseauCode: "FIBRE_BANC" }, T.chef);
  verifier("9. un concessionnaire cree avec le seul code : famille derivee (TELECOM)", conc2.status === 201 && conc2.body.concessionnaire.typeReseau === "TELECOM" && conc2.body.concessionnaire.typeReseauCode === "FIBRE_BANC", conc2.body);
  const dF = await depot(PK, await fK.geojson([{ nom: "Fibre banc", coords: [[30, 3], [90, 3]] }]), { role: "RESEAU_TIERS", concessionnaireId: conc2.body.concessionnaire.id }, "fibre.geojson", T.regK);
  verifier("9. le jeu herite du code et de la famille du concessionnaire", dF.status === 201 && dF.body.jeu.typeReseauCode === "FIBRE_BANC" && dF.body.jeu.typeReseau === "TELECOM", dF.body.jeu);
  const inc = await depot(PK, await fK.geojson([{ nom: "Incoherent", coords: [[30, 30], [90, 30]] }]), { role: "RESEAU_TIERS", concessionnaireId: CONC, typeReseau: "EAU_POTABLE", typeReseauCode: "FIBRE_BANC" }, "inc.geojson", T.regK);
  verifier("9. famille et code qui ne concordent pas : 400 TYPE_RESEAU_INCOHERENT", inc.body.code === "TYPE_RESEAU_INCOHERENT", inc.body);
  const des = await envoyer("patch", "/referentiels/TYPE_RESEAU/FIBRE_BANC", { actif: false });
  const actives = ((await get("/referentiels/TYPE_RESEAU", T.lecteur)).body.valeurs as { code: string }[]).map((v) => v.code);
  const toutes = ((await get("/referentiels/TYPE_RESEAU?tous=true", T.lecteur)).body.valeurs as { code: string }[]).map((v) => v.code);
  const jeuxK = (await get(`/${PK}/jeux`, T.regK)).body.jeux as { id: string; typeReseauCode: string | null }[];
  verifier("9. valeur desactivee (version 2) : absente des choix, presente avec ?tous=true, TOUJOURS lisible sur le jeu qui la porte",
    des.body.valeur?.version === 2 && !actives.includes("FIBRE_BANC") && toutes.includes("FIBRE_BANC") && jeuxK.find((j) => j.id === dF.body.jeu.id)?.typeReseauCode === "FIBRE_BANC", { actives, toutes });
  verifier("9. retirer une valeur portee : 409 VALEUR_UTILISEE (desactiver plutot)", (await envoyer("delete", "/referentiels/TYPE_RESEAU/FIBRE_BANC")).body.code === "VALEUR_UTILISEE");
  await envoyer("post", "/referentiels/STATUT_QUALITE", { code: "A_RETIRER", libelle: "Valeur retiree par le banc" });
  const ret = await envoyer("delete", "/referentiels/STATUT_QUALITE/A_RETIRER");
  verifier("9. retrait logique d'une valeur non portee (200), puis 404 VALEUR_INTROUVABLE ; la ligne reste en base", ret.status === 200 && (await get("/referentiels/STATUT_QUALITE/A_RETIRER")).status === 404
    && (await compter(`SELECT count(*) n FROM referentiels_voirie WHERE code = 'A_RETIRER' AND "deletedAt" IS NOT NULL`)) === 1);
  verifier("9. historique en ajout seul : creation, modification, retrait", (await compter(`SELECT count(*) n FROM referentiels_voirie_historique h JOIN referentiels_voirie r ON r.id = h."referentielId" WHERE r.code IN ('FIBRE_BANC','A_RETIRER') AND h."acteurId" = $1`, admin.id)) === 4);

  // ================================================================ 10. Corridor lineaire (ZONE) multi-prefectures, deux projets de largeurs differentes
  const prefs: string[] = [];
  for (const [i, s, n] of [[1, 10.0, 10.45], [2, 9.4, 10.0], [3, 8.85, 9.4]] as const) {
    prefs.push((await envoyer("post", "/territoires", { code: `BANC-PREF-K${i}`, nom: `Prefecture K${i} (banc)`, niveau: "PREFECTURE", parentId: REG_K, emprise: rect(-9.45, s, -8.55, n) })).body.territoire.id);
  }
  const cor = await envoyer("post", "/territoires", { code: "BANC-CORRIDOR-RN", nom: "Corridor routier lineaire (banc)", niveau: "ZONE", parentId: REG_K, emprise: rect(-9.5, 8.8, -8.5, 10.5), source: "banc : corridor synthetique de plus de 150 km" });
  const COR = cor.body.territoire.id;
  const couvre = (await sql<{ n: bigint }>(`SELECT count(*) n FROM territoires_voirie c, territoires_voirie p WHERE c.id = $1 AND p.id = ANY($2::text[]) AND ST_Covers(c.emprise, p.emprise)`, COR, prefs))[0].n;
  verifier("10. un corridor de niveau ZONE sous la region couvre les trois prefectures (ST_Covers), region effective K", cor.status === 201 && Number(couvre) === 3 && cor.body.territoire.regionEffectiveId === RK, { couvre, cor: cor.body.territoire });
  const c1 = await envoyer("post", "", { code: "BANC-COR-2X2", nom: "Route 2x2 voies (troncon principal)", territoireId: COR, largeurEmpriseM: 40, largeurChausseeM: 21 }, T.regK);
  const c2 = await envoyer("post", "", { code: "BANC-COR-DEV", nom: "Deviation dans le meme corridor", territoireId: COR, largeurEmpriseM: 30, largeurChausseeM: 14 }, T.regK);
  verifier("10. deux projets distincts dans le meme corridor, de largeurs differentes (40/21 et 30/14), sans commune ni prefecture inventees",
    c1.status === 201 && c2.status === 201 && c1.body.projet.largeurEmpriseM === 40 && c2.body.projet.largeurChausseeM === 14 && c1.body.projet.commune === null && c1.body.projet.prefecture === null, [c1.body, c2.body]);
  const PC = c1.body.projet.id;
  const axeLong: [number, number][] = [[-9.25, 10.4], [-9.05, 9.9], [-8.95, 9.4], [-8.75, 8.9]];
  const dLong = await depot(PC, geojsonDegres([{ nom: "Axe corridor", coords: axeLong }]), { role: "AXES_TRAVAUX" }, "axe-long.geojson", T.regK);
  const dRes = await depot(PC, geojsonDegres([{ nom: "Reseau qui croise", coords: [[-9.2, 9.9], [-8.9, 9.9]] }]), { role: "RESEAU_TIERS", concessionnaireId: CONC, classePrecision: "C" }, "res-long.geojson", T.regK);
  verifier("10. l'axe de plus de 150 km entre dans l'emprise du corridor (aucun objet hors territoire)", dLong.status === 201 && !dLong.body.avertissements.some((a: { code: string }) => a.code === "ELEMENTS_HORS_TERRITOIRE"), dLong.body.avertissements);
  await autoriser(PC, dLong.body.jeu.id, T.regK); await autoriser(PC, dRes.body.jeu.id, T.regK);
  const anC = await get(`/${PC}/analyse`, T.regK);
  verifier("10. analyse du projet lineaire : axe > 150 km, largeurs du projet (40 / 21), un croisement, EPSG:32629",
    anC.status === 200 && anC.body.axes.longueurM > 150_000 && anC.body.parametres.largeurEmpriseM === 40 && anC.body.conflits.total.croisements === 1 && anC.body.regle.projection === "EPSG:32629", { a: anC.body.axes, p: anC.body.parametres, c: anC.body.conflits?.total });
  const liste = (await get(`?territoireId=${COR}`, T.regK)).body.projets as { code: string }[];
  verifier("10. la liste filtree par le corridor rend ses deux projets et eux seuls", JSON.stringify(liste.map((p) => p.code).sort()) === JSON.stringify(["BANC-COR-2X2", "BANC-COR-DEV"]), liste.map((p) => p.code));
  const parRegion = ((await get(`?territoireId=${REG_K}&limite=100`, T.regK)).body.projets as unknown[]).length;
  verifier("10. le filtre par la region inclut ses descendants (commune et corridor) : 4 projets", parRegion === 4, parRegion);

  // ================================================================ 11. Comptes par territoire (agregats filtres par perimetre)
  const cpt = (await get(`/territoires/comptes?territoireId=${REG_K}`, T.regK)).body.comptes as { code: string; projets: number; jeux: Record<string, number>; conflits: Record<string, number> }[];
  const ligne = (code: string) => cpt.find((c) => c.code === code)!;
  verifier("11. comptes : region K = 4 projets (descendants compris), corridor = 2, commune = 2, jeux et conflits agreges",
    ligne("BANC-REG-K").projets === 4 && ligne("BANC-CORRIDOR-RN").projets === 2 && ligne("BANC-COM-K").projets === 2 && (ligne("BANC-COM-K").jeux.AUTORISE ?? 0) >= 2 && Object.values(ligne("BANC-COM-K").conflits).reduce((s, n) => s + n, 0) > 0, cpt);
  const cptLect = (await get(`/territoires/comptes?territoireId=${REG_K}`, T.lectK)).body.comptes as { code: string; jeux: Record<string, number> }[];
  verifier("11. un lecteur ne compte que les jeux AUTORISE (aucun jeu en controle)", Object.keys(cptLect.find((c) => c.code === "BANC-COM-K")!.jeux).every((s) => s === "AUTORISE") && (ligne("BANC-COM-K").jeux.CONTROLE ?? 0) > 0);
  verifier("11. comptes d'un territoire hors perimetre : 404", (await get(`/territoires/comptes?territoireId=${REG_K}`, T.regA)).status === 404);
  const cptA = (await get("/territoires/comptes", T.regA)).body.comptes as unknown[];
  verifier("11. la region A ne recoit aucun agregat de K", cptA.length === 0, cptA);

  // ================================================================ 12. Configuration : emprise nationale, liste blanche, protections, environnement prioritaire
  const em = await envoyer("put", "/configuration/EMPRISE_PLAUSIBILITE", { valeur: { nom: "Emprise de banc", bbox: [-11, 7.1, -7.5, 12.8] } });
  const hors = await depot(PW, await fW.geojson([{ nom: "A l'ouest", coords: [[10, 300], [60, 300]] }]), { role: "AUTRE" }, "ouest.geojson");
  verifier("12. emprise nationale reduite par l'ADMIN : un depot a l'ouest est refuse (422 HORS_GUINEE, message avec le nom configure)", em.status === 200 && hors.status === 422 && hors.body.code === "HORS_GUINEE" && /Emprise de banc/.test(hors.body.error), hors.body);
  await envoyer("put", "/configuration/EMPRISE_PLAUSIBILITE", { valeur: { nom: "Guinee", bbox: [-15.2, 7.1, -7.5, 12.8] } });
  const sansJustif = await request(app).put(`${BASE}/configuration/EMPRISE_PLAUSIBILITE`).set("Authorization", `Bearer ${T.admin}`).send({ valeur: { nom: "Guinee", bbox: [-15.2, 7.1, -7.5, 12.8] } });
  const justifCourte = await envoyer("put", "/configuration/EMPRISE_PLAUSIBILITE", { valeur: { nom: "Guinee", bbox: [-15.2, 7.1, -7.5, 12.8] }, justification: "court" });
  verifier("12. decision de l'architecte : PUT /configuration sans justification, ou de moins de 10 caracteres : 422 JUSTIFICATION_REQUISE, rien n'est ecrit",
    sansJustif.status === 422 && sansJustif.body.code === "JUSTIFICATION_REQUISE" && justifCourte.status === 422 && justifCourte.body.code === "JUSTIFICATION_REQUISE", [sansJustif.body, justifCourte.body]);
  verifier("12. valeur invalide : 400 VALEUR_INVALIDE avec details ; cle inconnue : 404", (await envoyer("put", "/configuration/EMPRISE_PLAUSIBILITE", { valeur: { nom: "x", bbox: [1, 1, 0, 0] } })).body.code === "VALEUR_INVALIDE"
    && (await envoyer("put", "/configuration/VILLES", { valeur: {} })).status === 404);
  verifier("12. liste blanche : un code inconnu de PostGIS est refuse (422 CRS_NON_DISPONIBLE) ; retirer un CRS des bandes est refuse (409)",
    (await envoyer("put", "/configuration/CRS_IMPORT_LISTE_BLANCHE", { valeur: { epsg: [4326, 32628, 32629, 99999] } })).body.code === "CRS_NON_DISPONIBLE"
    && (await envoyer("put", "/configuration/CRS_IMPORT_LISTE_BLANCHE", { valeur: { epsg: [4326, 32629] } })).status === 409);
  const lb = await envoyer("put", "/configuration/CRS_IMPORT_LISTE_BLANCHE", { valeur: { epsg: [4326, 32628, 32629, 32630] } });
  const opts = await get(`/${PK}/import/options`, T.regK);
  verifier("12. liste blanche elargie par l'ADMIN : les options d'import l'annoncent (source BASE), zone attendue = territoire du projet",
    lb.status === 200 && lb.body.configuration.source === "BASE" && (opts.body.crs.sourcesAutorises as { epsg: number }[]).map((s) => s.epsg).includes(32630) && opts.body.crs.zoneAttendue.nom === "Ville K (banc)", opts.body.crs);
  process.env.PROJETS_VOIRIE_CRS_SOURCE_AUTORISES = "4326,32629";
  const parEnv = (await get("/configuration/CRS_IMPORT_LISTE_BLANCHE", T.lecteur)).body.configuration;
  verifier("12. la variable d'environnement reste prioritaire (source ENV) sur la base", parEnv.source === "ENV" && JSON.stringify(parEnv.valeur.epsg) === "[4326,32629]" && JSON.stringify(parEnv.valeurBase.epsg) === "[4326,32628,32629,32630]", parEnv);
  delete process.env.PROJETS_VOIRIE_CRS_SOURCE_AUTORISES;
  delete process.env.PROJETS_VOIRIE_ANALYSE_INTERVALLE_S;
  await envoyer("put", "/configuration/PROTECTIONS", { valeur: { analyseIntervalleS: 3600 } });
  const a1 = await envoyer("post", `/${c2.body.projet.id}/analyses`, {}, T.regK);
  const a2 = await envoyer("post", `/${c2.body.projet.id}/analyses`, {}, T.regK);
  verifier("12. protection administree en base (cadence de 3 600 s, sans variable d'environnement) : la seconde analyse est refusee (429)", a1.status === 201 && a2.status === 429 && a2.body.code === "ANALYSE_TROP_FREQUENTE", [a1.status, a2.body]);
  process.env.PROJETS_VOIRIE_ANALYSE_INTERVALLE_S = "0";
  verifier("12. la variable d'environnement (0) reprend la main immediatement", (await envoyer("post", `/${c2.body.projet.id}/analyses`, {}, T.regK)).status === 201);
  await envoyer("put", "/configuration/PROTECTIONS", { valeur: {} });
  verifier("12. historique de configuration en ajout seul, avec l'acteur", (await compter(`SELECT count(*) n FROM configuration_voirie_historique WHERE "acteurId" = $1`, admin.id)) >= 7);

  // ================================================================ 13. Regles de la hierarchie par l'API et par la base
  verifier("13. commune sous une commune : 400 NIVEAU_INCOMPATIBLE", (await envoyer("post", "/territoires", { code: "BANC-COM-X", nom: "x", niveau: "COMMUNE", parentId: COM_K })).body.code === "NIVEAU_INCOMPATIBLE");
  verifier("13. seconde nation : 409 NATION_DEJA_DEFINIE ; territoire sans parent : 400 TERRITOIRE_PARENT_REQUIS",
    (await envoyer("post", "/territoires", { code: "BANC-NATION-2", nom: "x", niveau: "NATION" })).body.code === "NATION_DEJA_DEFINIE"
    && (await envoyer("post", "/territoires", { code: "BANC-SANS-PARENT", nom: "x", niveau: "ZONE" })).body.code === "TERRITOIRE_PARENT_REQUIS");
  const papillon = { type: "Polygon", coordinates: [[[-9.3, 10.3], [-9.2, 10.4], [-9.2, 10.3], [-9.3, 10.4], [-9.3, 10.3]]] };
  verifier("13. emprise auto-intersectee : 422 EMPRISE_INVALIDE (contrainte PostGIS), aucune ligne creee",
    (await envoyer("post", "/territoires", { code: "BANC-PAPILLON", nom: "x", niveau: "ZONE", parentId: NATION, emprise: papillon })).body.code === "EMPRISE_INVALIDE"
    && (await compter(`SELECT count(*) n FROM territoires_voirie WHERE code = 'BANC-PAPILLON'`)) === 0);
  verifier("13. parent, niveau et code ne se modifient pas par l'API (400)", (await envoyer("patch", `/territoires/${COM_K}`, { parentId: regW })).status === 400);
  verifier("13. retirer un territoire qui porte des enfants ou des projets : 409 TERRITOIRE_UTILISE", (await envoyer("delete", `/territoires/${COM_K}`)).body.code === "TERRITOIRE_UTILISE");
  const QUA = quartier.body.territoire.id;
  verifier("13. retrait logique d'une feuille (200), puis 404 ; la ligne reste en base", (await envoyer("delete", `/territoires/${QUA}`)).status === 200 && (await get(`/territoires/${QUA}`)).status === 404
    && (await compter(`SELECT count(*) n FROM territoires_voirie WHERE id = $1 AND "deletedAt" IS NOT NULL`, QUA)) === 1);
  await envoyer("patch", `/territoires/${prefs[2]}`, { actif: false });
  verifier("13. territoire inactif : lisible, mais aucun nouveau projet (400 TERRITOIRE_INTROUVABLE)", (await get(`/territoires/${prefs[2]}`)).status === 200
    && (await envoyer("post", "", { code: "BANC-INACTIF", nom: "x", territoireId: prefs[2] }, T.chef)).body.code === "TERRITOIRE_INTROUVABLE");
  verifier("13. deplacer un projet vers un territoire d'une autre region : 400 TERRITOIRE_REGION_INCOHERENTE", (await envoyer("patch", `/${PK}`, { territoireId: comW.id }, T.chef)).body.code === "TERRITOIRE_REGION_INCOHERENTE");
  const mv = await envoyer("patch", `/${PK}`, { territoireId: COR }, T.chef);
  verifier("13. deplacer un projet vers un territoire de la meme region (corridor) : 200, region inchangee ; m10 : commune et prefecture deviennent nulles (le corridor n'en a pas, rien n'est invente)",
    mv.status === 200 && mv.body.projet.regionId === RK && mv.body.projet.territoireId === COR && mv.body.projet.commune === null && mv.body.projet.prefecture === null, mv.body);
  await envoyer("patch", `/${PK}`, { territoireId: COM_K }, T.chef);
  const sqlstate = async (q: string, ...v: unknown[]) => { try { await sql(q, ...v); return "ok"; } catch (e) { return String((e as { meta?: { code?: string } }).meta?.code ?? (e as Error).message).slice(0, 80); } };
  const rDel = await sqlstate(`DELETE FROM territoires_voirie WHERE id = $1`, QUA);
  const rHist = await sqlstate(`UPDATE territoires_voirie_historique SET action = 'X'`);
  const rNiv = await sqlstate(`UPDATE territoires_voirie SET niveau = 'ZONE' WHERE id = $1`, COM_K);
  const rCode = await sqlstate(`UPDATE projets_voirie SET "categorieCode" = 'INCONNUE' WHERE id = $1`, PK);
  verifier("13. la base refuse : suppression physique, modification d'historique, changement de niveau, code de referentiel inconnu", [rDel, rHist, rNiv, rCode].every((r) => r !== "ok"), [rDel, rHist, rNiv, rCode]);
  await sql(`UPDATE territoires_voirie SET "regionId" = $1 WHERE id = $2`, RA, REG_K);
  const propage = await sql<{ code: string; r: number }>(`SELECT code, "regionEffectiveId" r FROM territoires_voirie WHERE chemin LIKE (SELECT chemin FROM territoires_voirie WHERE id = $1) || '%' ORDER BY chemin`, REG_K);
  verifier("13. changement de region : la base propage la region effective a tous les descendants sans region propre", propage.every((p) => p.r === RA), propage);
  await sql(`UPDATE territoires_voirie SET "regionId" = $1 WHERE id = $2`, RK, REG_K);

  // ================================================================ 13 bis. Correctifs T1+S1 (mineurs m1, m2, m4, m7, m9)
  // m1 : les comptes (agregat par projet puis cumul par chemin) egalent un oracle SQL ecrit a part (sous-requetes correlees, l'ancienne formulation).
  const cptNat = (await get("/territoires/comptes")).body.comptes as { territoireId: string; projets: number; jeux: Record<string, number> }[];
  const oracle = await sql<{ id: string; p: bigint; j: bigint }>(`SELECT t.id,
      (SELECT count(*) FROM projets_voirie p JOIN territoires_voirie s ON s.id = p."territoireId" WHERE p."deletedAt" IS NULL AND s.chemin LIKE t.chemin || '%') p,
      (SELECT count(*) FROM projets_voirie_jeux j JOIN projets_voirie p ON p.id = j."projetId" JOIN territoires_voirie s ON s.id = p."territoireId"
        WHERE p."deletedAt" IS NULL AND s.chemin LIKE t.chemin || '%' AND j.statut <> 'RETIRE') j
      FROM territoires_voirie t WHERE t."deletedAt" IS NULL`);
  const ecartsComptes = oracle.filter((o) => { const c = cptNat.find((x) => x.territoireId === o.id); return !c || c.projets !== Number(o.p) || Object.values(c.jeux).reduce((a, n) => a + n, 0) !== Number(o.j); });
  verifier("13 bis. m1 : comptes de chaque territoire (projets, jeux non retires) egaux a l'oracle SQL", cptNat.length === oracle.length && ecartsComptes.length === 0, ecartsComptes.slice(0, 5));
  process.env.PROJETS_VOIRIE_COMPTES_PAR_MINUTE = "1";
  const cad1 = await get("/territoires/comptes", T.chef), cad2 = await get("/territoires/comptes", T.chef);
  delete process.env.PROJETS_VOIRIE_COMPTES_PAR_MINUTE;
  verifier("13 bis. m1 : cadence par compte : au-dela, 429 COMPTES_TROP_FREQUENTS avec Retry-After", cad1.status === 200 && cad2.status === 429 && cad2.body.code === "COMPTES_TROP_FREQUENTS" && Number(cad2.headers["retry-after"]) > 0, cad2.body);
  // m2 : la liste ne rend que la boite englobante ; l'emprise complete est sur la fiche.
  const lst = (await get("/territoires?limite=500", T.lecteur)).body.territoires as { id: string; emprise?: unknown; bbox: number[] | null; aEmprise: boolean }[];
  const comKListe = lst.find((t) => t.id === COM_K);
  const comKFiche = (await get(`/territoires/${COM_K}`, T.lecteur)).body.territoire;
  verifier("13 bis. m2 : la liste des territoires ne porte aucune emprise complete (boite englobante et aEmprise seulement) ; la fiche porte l'emprise GeoJSON",
    lst.length > 0 && lst.every((t) => !("emprise" in t)) && !JSON.stringify(lst).includes("coordinates") && comKListe?.aEmprise === true && JSON.stringify(comKListe.bbox) === JSON.stringify([-9.36, 10.33, -9.26, 10.43])
    && comKFiche.emprise?.type === "Polygon", comKListe);
  // m4 : changer la region d'un territoire qui porte des projets d'une autre region est refuse ; un enfant ne porte pas une autre region que son parent.
  const chgRegion = await envoyer("patch", `/territoires/${REG_K}`, { regionId: RA });
  const chgCommune = await envoyer("patch", `/territoires/${COM_K}`, { regionId: RA });
  const enfantIncoherent = await envoyer("post", "/territoires", { code: "BANC-PREF-KA", nom: "Prefecture incoherente", niveau: "PREFECTURE", parentId: REG_K, regionId: RA });
  verifier("13 bis. m4 : region K (dont les descendants portent des projets de K) passee en A : 409 TERRITOIRE_REGION_PROJETS, rien n'est change ; une commune de K qui prendrait la region A, ou un enfant d'une autre region que son parent : 400 TERRITOIRE_REGION_INCOHERENTE",
    chgRegion.status === 409 && chgRegion.body.code === "TERRITOIRE_REGION_PROJETS" && chgRegion.body.projets >= 1 && chgCommune.status === 400 && chgCommune.body.code === "TERRITOIRE_REGION_INCOHERENTE"
    && (await sql<{ r: number | null }>(`SELECT "regionEffectiveId" r FROM territoires_voirie WHERE id = $1`, COM_K))[0].r === RK
    && (await sql<{ r: number | null }>(`SELECT "regionEffectiveId" r FROM territoires_voirie WHERE id = $1`, REG_K))[0].r === RK
    && enfantIncoherent.status === 400 && enfantIncoherent.body.code === "TERRITOIRE_REGION_INCOHERENTE", [chgRegion.body, chgCommune.body, enfantIncoherent.body]);
  // m7 : la famille d'un type de reseau porte par un jeu ne change plus.
  const famille = await envoyer("patch", "/referentiels/TYPE_RESEAU/FIBRE_BANC", { parametres: { famille: "ELECTRICITE" } });
  const couleur = await envoyer("patch", "/referentiels/TYPE_RESEAU/FIBRE_BANC", { parametres: { famille: "TELECOM", couleur: "#123456" } });
  verifier("13 bis. m7 : changer la famille d'un type de reseau porte par un jeu : 409 FAMILLE_FIGEE ; changer sa couleur (meme famille) reste possible",
    famille.status === 409 && famille.body.code === "FAMILLE_FIGEE" && couleur.status === 200, [famille.body, couleur.body]);
  // m9 : un CRS impose par un territoire reste dans la liste blanche.
  await envoyer("put", "/configuration/CRS_IMPORT_LISTE_BLANCHE", { valeur: { epsg: [4326, 32628, 32629, 32630] } });
  const impose30 = await envoyer("patch", `/territoires/${COM_K}`, { crsMetriqueEpsg: 32630 });
  const retraitImpose = await envoyer("put", "/configuration/CRS_IMPORT_LISTE_BLANCHE", { valeur: { epsg: [4326, 32628, 32629] } });
  await envoyer("patch", `/territoires/${COM_K}`, { crsMetriqueEpsg: null });
  const retraitLibre = await envoyer("put", "/configuration/CRS_IMPORT_LISTE_BLANCHE", { valeur: { epsg: [4326, 32628, 32629] } });
  verifier("13 bis. m9 : retirer de la liste blanche un CRS impose par un territoire : 409 CRS_NON_AUTORISE (le territoire est nomme) ; une fois l'imposition levee, il se retire",
    impose30.status === 200 && retraitImpose.status === 409 && retraitImpose.body.code === "CRS_NON_AUTORISE" && (retraitImpose.body.territoires as string[] | undefined)?.includes("BANC-COM-K") === true
    && retraitLibre.status === 200, [impose30.body, retraitImpose.body, retraitLibre.body]);

  // ================================================================ 14. Isolation
  verifier("14. aucune ecriture dans le referentiel officiel (troncons)", (await compter(`SELECT count(*) n FROM troncons`)) === troncons);
  verifier("14. aucune ligne d'audit ne porte de geometrie d'emprise", (await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" IN ('TerritoireVoirie','ReferentielVoirie','ConfigurationVoirie') AND (after::text LIKE '%coordinates%' OR before::text LIKE '%coordinates%')`)) === 0);
}

try {
  await main();
} catch (e) {
  verifier("execution du banc sans exception", false, String((e as Error).stack ?? e).slice(0, 600));
} finally {
  await prisma.$disconnect();
  await banc.fermer();
  conclure();
}

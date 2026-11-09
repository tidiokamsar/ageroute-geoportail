// Banc d'integration des SOURCES MULTIPLES, de la COMPARAISON ENTRE SOURCES et de la CONNECTIVITE DECLARATIVE (lot S1) contre un vrai PostGIS.
// Contrat : docs/projets-voirie/CONTRAT-SOURCES.md. Voir tests-integration/README.md. Lancer (DATABASE_URL pointe sur `replay`) :
//   npx tsx tests-integration/sources-comparaison.integration.mts
// Avec SOURCES_EXEMPLES=<fichier.json>, les reponses reelles servant d'exemples a docs/projets-voirie/API.md y sont ecrites.
//
// Tout passe par les routes reelles montees comme en production (`createApp`), des jetons signes par des secrets aleatoires, le role, le module et le
// perimetre LUS EN BASE, le SQL reel (PostGIS), les contraintes et declencheurs reels, dans le clone jetable `essai_sources_s1` (les migrations des
// conflits, des reseaux, du workflow, des jobs GDAL et du lot S1 y sont appliquees par le banc si `replay` ne les porte pas).
//
// DONNEES 100 % SYNTHETIQUES : segments inventes, construits en metres dans le repere UTM 29N puis transformes en WGS 84 par PostGIS. Aucun operateur,
// aucun plan, aucune ville reels.
//   Reseau telecom (concessionnaire synthetique) : source A (numerisation d'un plan, precision 1 m), source B (GNSS RTK, precision 1 m) : corridor 2 m.
//     Cable Concord : B decale de 0,5 m (CONCORDANCE) ; Cable Divergent : B decale de 3 m (DIVERGENCE, Hausdorff 3 m, 100 m hors corridor) ;
//     Cable Seul A (SANS_CORRESPONDANCE_A) ; Cable Seul B (SANS_CORRESPONDANCE_B).
//   Reseau d'eau : deux sources sans precision ni classe : RAPPROCHEMENT_INCERTAIN, aucune mesure.
//   Plan d'axes : version 1 tracee depuis un plan PDF (classe C, precision attribuee 2 m), version 2 livree en « DXF » par le bureau d'etudes (ici en
//     GeoJSON synthetique, precision 0,1 m) : corridor 3 m ; Axe Route 1 decale de 1,5 m (CONCORDANCE), Axe Route 2 decale de 5 m (DIVERGENCE).
//   Reseau electrique : connexions DECLAREES par une colonne du fichier (mapping connecteA), jamais deduites.
import { writeFileSync } from "node:fs";
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { avecTerritoireParDefaut } from "./lib/territoire-par-defaut.mts";
import { verifier, conclure, proche } from "./lib/verdict.ts";

const banc = await ouvrirBancClone("essai_sources_s1", {
  migrations: ["20261031100000_conflits_projets_voirie", "20261101200000_reseaux_physiques_logiques", "20261101300000_workflow_roles_recolement", "20261102200000_import_jobs_gdal", "20261103300000_multi_sources_comparaison",
    "20261103400000_correctifs_sources_territoires"],
});
const { prisma } = await banc.imp("lib/prisma");
const { createApp } = await banc.imp("app");
const { signAccessToken } = await banc.imp("utils/jwt");
const request = (await import("supertest")).default;

process.env.PROJETS_VOIRIE_ANALYSE_INTERVALLE_S = "0";
process.env.PROJETS_VOIRIE_COMPARAISON_INTERVALLE_S = "0";
// Lot T1 : territoire par defaut ajoute aux creations de projet du banc (voir lib/territoire-par-defaut.mts).
const app = avecTerritoireParDefaut(createApp(), prisma);
const BASE = "/api/v2/projets-voirie";
const O = { x: 380000, y: 1015000 };

const sql = <T = Record<string, unknown>>(texte: string, ...v: unknown[]) => prisma.$queryRawUnsafe(texte, ...v) as Promise<T[]>;
const compter = async (texte: string, ...v: unknown[]) => Number((await sql<{ n: bigint }>(texte, ...v))[0].n);

async function wgs(pts: [number, number][]): Promise<[number, number][]> {
  const wkt = pts.length === 1 ? `POINT(${O.x + pts[0][0]} ${O.y + pts[0][1]})` : `LINESTRING(${pts.map(([x, y]) => `${O.x + x} ${O.y + y}`).join(",")})`;
  const r = await sql<{ g: string }>(`SELECT ST_AsGeoJSON(ST_Transform(ST_SetSRID(ST_GeomFromText($1), 32629), 4326), 9) AS g`, wkt);
  return JSON.parse(r[0].g).coordinates;
}
type Entree = { nom: string; coords?: [number, number][]; pt?: [number, number]; props?: Record<string, unknown> };
async function geojson(entrees: Entree[]): Promise<Buffer> {
  const features = [];
  for (const e of entrees) {
    const geometry = e.pt ? { type: "Point", coordinates: await wgs([e.pt]) } : { type: "LineString", coordinates: await wgs(e.coords!) };
    features.push({ type: "Feature", properties: { name: e.nom, ...(e.props ?? {}) }, geometry });
  }
  return Buffer.from(JSON.stringify({ type: "FeatureCollection", features }));
}
const ligne = (nom: string, y: number, x0 = 0, x1 = 100): Entree => ({ nom, coords: [[x0, y], [x1, y]] });

async function essaiAnnule(f: (tx: typeof prisma) => Promise<unknown>): Promise<string> {
  const ANNULE = new Error("annule");
  try { await prisma.$transaction(async (tx: typeof prisma) => { await f(tx); throw ANNULE; }); return "ok"; } catch (e) {
    if (e === ANNULE) return "ok";
    const meta = (e as { meta?: { code?: string } }).meta;
    return meta?.code ?? String(e).slice(0, 160);
  }
}

const exemples: Record<string, unknown> = {};
const JUSTIF = "Controle effectue avec le chef de projet";

async function main() {
  // ================================================================ Fixtures
  const mk = (email: string, nomComplet: string, role: string, modules: string[] = ["projets-voirie"]) =>
    prisma.user.create({ data: { email, nomComplet, passwordHash: "x", role, modulesAutorises: modules } });
  const admin = await mk("admin@banc.invalid", "Mariama Admin", "ADMIN", []);
  const chef = await mk("chef@banc.invalid", "Sekou Gestionnaire", "GESTIONNAIRE");
  const lecteur = await mk("lecteur@banc.invalid", "Lecteur banc", "LECTEUR");
  const sansModule = await mk("sans@banc.invalid", "Sans module", "GESTIONNAIRE", ["troncons"]);
  const reg2 = await mk("reg2@banc.invalid", "Regional 2", "GESTIONNAIRE");
  const R1 = (await prisma.region.create({ data: { nom: "Region banc 1" } })).id;
  const R2 = (await prisma.region.create({ data: { nom: "Region banc 2" } })).id;
  await sql(`INSERT INTO perimetres_comptes ("userId", "regionId", "accordeParId") VALUES ($1, $2, $3)`, reg2.id, R2, admin.id);
  const jeton = (u: { id: string; role: string; email: string }) => signAccessToken({ sub: u.id, role: u.role, email: u.email });
  const T = { admin: jeton(admin), chef: jeton(chef), lecteur: jeton(lecteur), sans: jeton(sansModule), reg2: jeton(reg2) };

  const get = (chemin: string, t: string | null = T.chef) => { const r = request(app).get(`${BASE}${chemin}`); return t ? r.set("Authorization", `Bearer ${t}`) : r; };
  const envoyer = (methode: "post" | "patch" | "delete", chemin: string, corps?: unknown, t: string | null = T.chef) => {
    let r = request(app)[methode](`${BASE}${chemin}`);
    if (t) r = r.set("Authorization", `Bearer ${t}`);
    return corps === undefined ? r : r.send(corps as object);
  };
  function depot(projetId: string, fichier: Buffer, champs: Record<string, string | undefined>, nom: string, t = T.chef) {
    const r = request(app).post(`${BASE}/${projetId}/jeux`).set("Authorization", `Bearer ${t}`);
    for (const [k, v] of Object.entries(champs)) if (v !== undefined) r.field(k, v);
    return r.attach("fichier", fichier, { filename: nom });
  }
  async function deposer(pid: string, fichier: Buffer, champs: Record<string, string | undefined>, nom: string): Promise<{ id: string; corps: Record<string, unknown> }> {
    const d = await depot(pid, fichier, champs, nom);
    if (!d.body.jeu?.id) throw new Error(`depot refuse : ${JSON.stringify(d.body)}`);
    return { id: d.body.jeu.id, corps: d.body };
  }
  async function autoriser(pid: string, id: string): Promise<void> {
    const a = await envoyer("post", `/${pid}/jeux/${id}/autoriser`, { justification: JUSTIF });
    if (a.status !== 200) throw new Error(`autorisation refusee : ${JSON.stringify(a.body)}`);
  }
  const statut = async (id: string) => (await sql<{ s: string }>(`SELECT statut::text s FROM projets_voirie_jeux WHERE id = $1`, id))[0].s;

  console.log("\n== Sources multiples, comparaison et connectivite declarative : banc PostGIS ==");
  const PID: string = (await envoyer("post", "", { code: "SOURCES-1", nom: "Voirie de banc", regionId: R1 })).body.projet.id;
  const conc = async (nom: string, typeReseau: string): Promise<string> => (await envoyer("post", "/concessionnaires", { nom, typeReseau })).body.concessionnaire.id;
  const CT = await conc("Operateur Telecom Synthetique", "TELECOM");
  const CE = await conc("Societe des Eaux Synthetique", "EAU_POTABLE");
  const CL = await conc("Societe Electrique Synthetique", "ELECTRICITE");

  // Referentiel officiel (lecture seule) : un troncon synthetique, empreinte comparee a la fin.
  await sql(`INSERT INTO troncons ("id","code","nom","classe","regionId","longueurKm","revetement","pkDebut","pkFin","updatedAt","geom")
             VALUES (gen_random_uuid()::text, 'BANC-T-S1', 'Troncon du referentiel', 'RU', $1, 0.2, 'BITUME', 0, 0.2, now(), ST_Transform(ST_SetSRID(ST_GeomFromText($2), 32629), 4326))`,
    R1, `LINESTRING(${O.x} ${O.y + 10},${O.x + 200} ${O.y + 10})`);
  const empreinteTroncons = async () => (await sql<{ h: string }>(`SELECT md5(string_agg(t::text, '|' ORDER BY code)) h FROM troncons t`))[0].h;
  const etat = async (): Promise<Record<string, number>> => {
    const tables = await sql<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND left(table_name, 1) <> '_' ORDER BY 1`);
    const sortie: Record<string, number> = {};
    for (const t of tables) sortie[t.table_name] = await compter(`SELECT count(*) n FROM "${t.table_name}"`);
    return sortie;
  };
  const avantTout = await etat();
  const empreinteAvant = await empreinteTroncons();

  // ================================================================ 1. Source unique : etat normal, rien n'est calcule
  const JA = (await deposer(PID, await geojson([ligne("Cable Concord", 0), ligne("Cable Divergent", 50), ligne("Cable Seul A", 200)]),
    { role: "RESEAU_TIERS", concessionnaireId: CT, methodeAcquisition: "NUMERISATION_PLAN", precisionHorizontaleM: "1" }, "telecom-plan.geojson")).id;
  await autoriser(PID, JA);
  const s1 = await get(`/${PID}/sources`);
  verifier("1. source unique : un reseau, statut SOURCE_UNIQUE_COMPARAISON_INDISPONIBLE, aucune comparaison, la mention le dit sans erreur ni avertissement",
    s1.status === 200 && s1.body.reseaux.length === 1 && s1.body.reseaux[0].statut === "SOURCE_UNIQUE_COMPARAISON_INDISPONIBLE" && s1.body.reseaux[0].derniereComparaison === null
    && /état normal/.test(s1.body.reseaux[0].mention) && !("avertissements" in s1.body), s1.body);
  verifier("1. source unique : aucune comparaison n'existe en base", (await compter(`SELECT count(*) n FROM comparaisons_sources_projet`)) === 0);
  const meme = await envoyer("post", `/${PID}/comparaisons`, { jeuAId: JA, jeuBId: JA });
  verifier("1. comparer une source a elle-meme : 409 JEUX_NON_COMPARABLES (MEME_JEU), rien d'ecrit", meme.status === 409 && meme.body.motif === "MEME_JEU" && (await compter(`SELECT count(*) n FROM comparaisons_sources_projet`)) === 0, meme.body);
  exemples["sources_source_unique"] = s1.body;

  // ================================================================ 2. Seconde source : concordance, divergence, sans correspondance
  const dB = await deposer(PID, await geojson([ligne("Cable Concord B", 0.5), ligne("Cable Divergent B", 53), ligne("Cable Seul B", 400)]),
    { role: "RESEAU_TIERS", concessionnaireId: CT, methodeAcquisition: "GNSS_RTK", precisionHorizontaleM: "1" }, "telecom-gnss.geojson");
  const JB = dB.id;
  verifier("2. une autre methode d'acquisition est une SECONDE SOURCE : version 1, ne remplace pas la premiere", (dB.corps.jeu as { version: number }).version === 1 && dB.corps.remplace === null, [dB.corps.remplace]);
  await autoriser(PID, JB);
  verifier("2. les deux sources restent AUTORISE apres l'autorisation de la seconde (aucun remplacement)", (await statut(JA)) === "AUTORISE" && (await statut(JB)) === "AUTORISE");
  const s2 = await get(`/${PID}/sources`);
  verifier("2. le reseau est COMPARABLE avec ses deux sources (methodes NUMERISATION_PLAN et GNSS_RTK)", s2.body.reseaux[0].statut === "COMPARABLE" && s2.body.reseaux[0].nbSources === 2
    && s2.body.reseaux[0].sources.map((x: { methodeAcquisition: string }) => x.methodeAcquisition).sort().join(",") === "GNSS_RTK,NUMERISATION_PLAN", s2.body.reseaux[0]);
  const c1 = await envoyer("post", `/${PID}/comparaisons`, { jeuAId: JB, jeuBId: JA });
  exemples["comparaison_creee"] = c1.body;
  verifier("2. comparaison 201, mode SOURCES, A = la source deposee la premiere quel que soit l'ordre de la demande, version d'algorithme et regle par defaut enregistrees",
    c1.status === 201 && c1.body.comparaison.mode === "SOURCES" && c1.body.comparaison.jeuAId === JA && c1.body.comparaison.jeuBId === JB
    && c1.body.comparaison.versionAlgorithme === "S1-CORRIDOR-UTM-1" && c1.body.comparaison.regle.code === "S1-CORRIDOR-0.1" && c1.body.comparaison.regle.margeM === 1, c1.body);
  verifier("2. resume : 1 concordance, 1 divergence, 1 sans correspondance A, 1 sans correspondance B, aucun incertain ; corridor 2 m (max 1, 1 + 1)",
    c1.body.resume.totaux.CONCORDANCE === 1 && c1.body.resume.totaux.DIVERGENCE === 1 && c1.body.resume.totaux.SANS_CORRESPONDANCE_A === 1 && c1.body.resume.totaux.SANS_CORRESPONDANCE_B === 1
    && c1.body.resume.totaux.RAPPROCHEMENT_INCERTAIN === 0 && c1.body.resume.corridor.minM === 2 && c1.body.resume.corridor.maxM === 2, c1.body.resume);
  const CMP1: string = c1.body.comparaison.id;
  const o1 = await get(`/${PID}/comparaisons/${CMP1}/objets`);
  exemples["comparaison_objets"] = o1.body;
  const par = (nom: string) => o1.body.resultats.find((r: { objetA: { nom: string } | null; objetB: { nom: string } | null }) => (r.objetA?.nom ?? r.objetB?.nom) === nom);
  const concord = par("Cable Concord"), diverg = par("Cable Divergent");
  verifier("2. CONCORDANCE : B a 0,5 m, Hausdorff 0,5 m, rien hors du corridor de 2 m, precisions d'origine JEU",
    concord?.statut === "CONCORDANCE" && proche(concord.mesure.hausdorffM, 0.5, 0.02) && concord.mesure.longueurHorsCorridorM === 0 && concord.corridorM === 2
    && concord.objetA.originePrecision === "JEU" && concord.objetB.nom === "Cable Concord B", concord);
  verifier("2. DIVERGENCE : decalage de 3 m sur un corridor de 2 m : Hausdorff 3 m, 100 m hors corridor, part 1",
    diverg?.statut === "DIVERGENCE" && proche(diverg.mesure.hausdorffM, 3, 0.02) && proche(diverg.mesure.longueurHorsCorridorM, 100, 0.1) && diverg.mesure.partHorsCorridor === 1, diverg);
  verifier("2. SANS_CORRESPONDANCE_A et _B : aucune mesure, un seul objet chacun", par("Cable Seul A")?.statut === "SANS_CORRESPONDANCE_A" && par("Cable Seul A").mesure === null && par("Cable Seul A").objetB === null
    && par("Cable Seul B")?.statut === "SANS_CORRESPONDANCE_B" && par("Cable Seul B").objetA === null);
  verifier("2. aucune geometrie dans les reponses de la comparaison", !/coordinates|LINESTRING|"geometry"|"geom"/.test(JSON.stringify([c1.body, o1.body])));
  const geomAvant = await sql<{ h: string }>(`SELECT md5(string_agg(encode(ST_AsEWKB(geom), 'hex'), '|' ORDER BY id)) h FROM projets_voirie_objets`);

  // ================================================================ 3. Rejeu idempotent
  const c2 = await envoyer("post", `/${PID}/comparaisons`, { jeuAId: JA, jeuBId: JB });
  const inst = await sql<{ numero: number; i: unknown }>(`SELECT numero, instantane i FROM comparaisons_sources_projet WHERE projet_id_dummy IS NULL ORDER BY numero`.replace(" WHERE projet_id_dummy IS NULL", ` WHERE "projetId" = '${PID}'`));
  const cles = async (id: string) => (await sql<{ c: string }>(`SELECT string_agg(cle || ':' || statut::text || ':' || coalesce(mesure::text, '-'), '|' ORDER BY ordre) c FROM comparaisons_sources_resultats WHERE "comparaisonId" = $1`, id))[0].c;
  verifier("3. REJEU IDEMPOTENT : la seconde comparaison (numero 2) a le meme instantane, les memes cles, statuts et mesures que la premiere",
    c2.status === 201 && inst.length === 2 && JSON.stringify(inst[0].i) === JSON.stringify(inst[1].i) && (await cles(CMP1)) === (await cles(c2.body.comparaison.id)), inst.map((x) => x.numero));
  verifier("3. les geometries d'origine ne sont ni modifiees ni fusionnees (empreinte de tous les objets identique)",
    (await sql<{ h: string }>(`SELECT md5(string_agg(encode(ST_AsEWKB(geom), 'hex'), '|' ORDER BY id)) h FROM projets_voirie_objets`))[0].h === geomAvant[0].h);

  // ================================================================ 3 bis. Correctifs T1+S1 (M1) : CRS du territoire, comme l'analyse 2D
  const TID = (await sql<{ t: string }>(`SELECT "territoireId" t FROM projets_voirie WHERE id = $1`, PID))[0].t;
  const crsImpose = await envoyer("patch", `/territoires/${TID}`, { crsMetriqueEpsg: 32628 }, T.admin);
  const cT = await envoyer("post", `/${PID}/comparaisons`, { jeuAId: JA, jeuBId: JB });
  await envoyer("patch", `/territoires/${TID}`, { crsMetriqueEpsg: null }, T.admin);
  verifier("3 bis. M1 : sans CRS impose, la regle par bandes (32629 a cette longitude) est enregistree avec son origine ; un territoire qui impose 32628 : la comparaison calcule et persiste 32628 (origine TERRITOIRE), comme l'analyse 2D",
    c1.body.comparaison.epsg === 32629 && c1.body.resume.crs?.source === "BANDES" && crsImpose.status === 200 && cT.status === 201 && cT.body.comparaison.epsg === 32628
    && cT.body.resume.crs?.source === "TERRITOIRE" && cT.body.resume.crs?.crsImpose === 32628 && cT.body.resume.crs?.territoireId === TID
    && (await sql<{ e: number; s: string }>(`SELECT epsg e, resume->'crs'->>'source' s FROM comparaisons_sources_projet WHERE id = $1`, cT.body.comparaison.id))[0].s === "TERRITOIRE",
    [c1.body.resume.crs, crsImpose.body, cT.body.comparaison?.epsg, cT.body.resume?.crs]);

  // ================================================================ 4. Precision inconnue : rapprochement incertain, aucune mesure
  const JE1 = (await deposer(PID, await geojson([ligne("Conduite X", 100)]), { role: "RESEAU_TIERS", concessionnaireId: CE, methodeAcquisition: "TOPOGRAPHIE" }, "eau-topo.geojson")).id;
  await autoriser(PID, JE1);
  const JE2 = (await deposer(PID, await geojson([ligne("Conduite X bis", 100.3)]), { role: "RESEAU_TIERS", concessionnaireId: CE, methodeAcquisition: "GEORADAR" }, "eau-radar.geojson")).id;
  await autoriser(PID, JE2);
  const ce = await envoyer("post", `/${PID}/comparaisons`, { jeuAId: JE1, jeuBId: JE2 });
  const oe = await get(`/${PID}/comparaisons/${ce.body.comparaison.id}/objets`);
  verifier("4. precisions inconnues : RAPPROCHEMENT_INCERTAIN, corridor nul, AUCUNE mesure de divergence (rien n'est invente), origine INCONNUE",
    ce.status === 201 && ce.body.resume.totaux.RAPPROCHEMENT_INCERTAIN === 1 && ce.body.resume.corridor.couplesSansCorridor === 1 && oe.body.resultats.length === 1
    && oe.body.resultats[0].statut === "RAPPROCHEMENT_INCERTAIN" && oe.body.resultats[0].mesure === null && oe.body.resultats[0].corridorM === null
    && oe.body.resultats[0].objetA.originePrecision === "INCONNUE" && ce.body.resume.limites.some((l: string) => /précision déclarée manque/.test(l)), [ce.body.resume, oe.body.resultats]);
  const autreReseau = await envoyer("post", `/${PID}/comparaisons`, { jeuAId: JA, jeuBId: JE1 });
  verifier("4. deux reseaux differents ne se comparent pas : 409 RESEAU_DIFFERENT", autreReseau.status === 409 && autreReseau.body.motif === "RESEAU_DIFFERENT", autreReseau.body);

  // ================================================================ 5. Regle de rapprochement versionnee et approuvee
  const rg = await envoyer("post", `/${PID}/regles-rapprochement`, { famille: "TELECOM", code: "S1-TELECOM", margeM: 2.5, justification: "Marge elargie validee par la direction" });
  const rgId: string = rg.body.regle?.id;
  const apChef = await envoyer("post", `/${PID}/regles-rapprochement/${rgId}/approuver`, { justification: "Relue et approuvee" });
  const brouillon = await envoyer("post", `/${PID}/comparaisons`, { jeuAId: JA, jeuBId: JB });
  verifier("5. regle creee BROUILLON (version 1) ; un GESTIONNAIRE ne l'approuve pas (403) ; un brouillon n'est jamais applique (marge 1 m toujours)",
    rg.status === 201 && rg.body.regle.statut === "BROUILLON" && rg.body.regle.version === 1 && apChef.status === 403 && brouillon.body.comparaison?.regle.margeM === 1, [rg.body, apChef.status, brouillon.body.comparaison?.regle]);
  const rgAdmin = await envoyer("post", `/${PID}/regles-rapprochement`, { famille: "TELECOM", code: "S1-AUTO", margeM: 2, justification: "Regle de l'administrateur pour test" }, T.admin);
  const auto = await envoyer("post", `/${PID}/regles-rapprochement/${rgAdmin.body.regle.id}/approuver`, { justification: "Relue et approuvee" }, T.admin);
  const ap = await envoyer("post", `/${PID}/regles-rapprochement/${rgId}/approuver`, { justification: "Relue et approuvee par l'administrateur" }, T.admin);
  verifier("5. l'auteur n'approuve pas sa propre regle sans derogation (409 SEPARATION_DES_TACHES) ; l'ADMIN approuve celle du gestionnaire (200)",
    auto.status === 409 && auto.body.code === "SEPARATION_DES_TACHES" && ap.status === 200 && ap.body.regle.statut === "APPROUVEE", [auto.body, ap.body]);
  const imm = await essaiAnnule((tx) => tx.$executeRawUnsafe(`UPDATE regles_rapprochement_sources SET "margeM" = 9 WHERE id = $1`, rgId));
  verifier("5. BASE : une regle approuvee est immuable (23001)", imm === "23001", imm);
  const lr = await get(`/${PID}/regles-rapprochement`, T.lecteur);
  verifier("5. la regle effective TELECOM est la nouvelle (portee PROJET_FAMILLE), les autres familles gardent la regle par defaut",
    lr.status === 200 && lr.body.effectives.find((e: { famille: string }) => e.famille === "TELECOM").code === "S1-TELECOM" && lr.body.effectives.find((e: { famille: string }) => e.famille === "EAU_POTABLE").code === "S1-CORRIDOR-0.1", lr.body.effectives);
  const c3 = await envoyer("post", `/${PID}/comparaisons`, { jeuAId: JA, jeuBId: JB });
  verifier("5. la comparaison suivante applique et enregistre la regle approuvee : corridor 3,5 m, le cable decale de 3 m devient CONCORDANCE (2 concordances)",
    c3.body.comparaison.regle.code === "S1-TELECOM" && c3.body.comparaison.regle.version === 1 && c3.body.resume.corridor.maxM === 3.5 && c3.body.resume.totaux.CONCORDANCE === 2 && c3.body.resume.totaux.DIVERGENCE === 0, c3.body.resume);

  // ================================================================ 6. Lecteur et gestionnaire ; pagination ; cadence ; trace
  const lect = await get(`/${PID}/comparaisons`, T.lecteur);
  const lectPost = await envoyer("post", `/${PID}/comparaisons`, { jeuAId: JA, jeuBId: JB }, T.lecteur);
  verifier("6. un LECTEUR lit l'historique des comparaisons de jeux autorises (200) et ne lance rien (403)", lect.status === 200 && lect.body.comparaisons.length >= 4 && lectPost.status === 403, [lect.status, lectPost.status]);
  const vus: string[] = [];
  let curseur: string | null = null, pages = 0;
  do {
    const p = await get(`/${PID}/comparaisons/${CMP1}/objets?limite=1${curseur ? `&curseur=${curseur}` : ""}`, T.lecteur);
    vus.push(...p.body.resultats.map((r: { id: string }) => r.id)); curseur = p.body.curseurSuivant; pages++;
  } while (curseur && pages < 10);
  verifier("6. resultats pagines par curseur borne : 4 pages d'un resultat, aucun doublon ni saut", pages === 4 && new Set(vus).size === 4, [pages, vus.length]);
  const forge = await get(`/${PID}/comparaisons/${CMP1}/objets?curseur=${Buffer.from(JSON.stringify({ n: 99999999999 })).toString("base64url")}`);
  verifier("6. curseur forge (numero hors entier) : 400 CURSEUR_INVALIDE", forge.status === 400 && forge.body.code === "CURSEUR_INVALIDE");
  const traces = await sql<{ route: string }>(`SELECT after->>'route' AS route FROM audit_logs WHERE "entityType" = 'ConsultationJeuProjet' AND "userId" = $1`, lecteur.id);
  verifier("6. la consultation des resultats (noms d'objets de deux jeux confidentiels) est tracee pour le lecteur, route `sources`, une ligne par jeu",
    traces.filter((t) => t.route === "sources").length === 2, traces);
  process.env.PROJETS_VOIRIE_COMPARAISON_INTERVALLE_S = "60";
  const vite = await envoyer("post", `/${PID}/comparaisons`, { jeuAId: JA, jeuBId: JB });
  process.env.PROJETS_VOIRIE_COMPARAISON_INTERVALLE_S = "0";
  verifier("6. cadence : une comparaison moins de 60 s apres la precedente : 429 COMPARAISON_TROP_FREQUENTE avec Retry-After", vite.status === 429 && vite.body.code === "COMPARAISON_TROP_FREQUENTE" && Number(vite.headers["retry-after"]) > 0, vite.body);
  const horsPerimetre = await get(`/${PID}/comparaisons`, T.reg2);
  verifier("6. hors perimetre : 404 masque PROJET_INTROUVABLE ; sans cle de module : 403", horsPerimetre.status === 404 && horsPerimetre.body.code === "PROJET_INTROUVABLE" && (await get(`/${PID}/sources`, T.sans)).status === 403);

  // ================================================================ 7. Plan d'axes : version candidate (PDF classe C, puis le meme axe livre par le bureau d'etudes)
  const AX1 = (await deposer(PID, await geojson([ligne("Axe Route 1", -30, 0, 200), ligne("Axe Route 2", -80, 0, 200)]), { role: "AXES_TRAVAUX", methodeAcquisition: "NUMERISATION_PLAN", classePrecision: "C" }, "axes-depuis-pdf.geojson")).id;
  await autoriser(PID, AX1);
  const dAx2 = await deposer(PID, await geojson([ligne("Axe Route 1", -28.5, 0, 200), ligne("Axe Route 2", -75, 0, 200)]), { role: "AXES_TRAVAUX", methodeAcquisition: "PLAN_CAO", precisionHorizontaleM: "0.1" }, "axes-bureau-etudes.geojson");
  const AX2 = dAx2.id;
  verifier("7. un plan d'axes d'une autre methode n'est PAS une seconde source : c'est une version 2 en controle qui remplacera la version autorisee",
    (dAx2.corps.jeu as { version: number }).version === 2 && (dAx2.corps.remplace as { jeuId: string } | null)?.jeuId === AX1 && (await statut(AX2)) === "CONTROLE", dAx2.corps.remplace);
  const sAx = await get(`/${PID}/sources`), sAxL = await get(`/${PID}/sources`, T.lecteur);
  const grpAx = sAx.body.reseaux.find((r: { role: string }) => r.role === "AXES_TRAVAUX"), grpAxL = sAxL.body.reseaux.find((r: { role: string }) => r.role === "AXES_TRAVAUX");
  verifier("7. la vue des sources montre au gestionnaire la version candidate du plan d'axes ; au lecteur, ni le jeu en controle ni sa presence (aucune cle versionsCandidates)",
    grpAx?.statut === "SOURCE_UNIQUE_COMPARAISON_INDISPONIBLE" && grpAx.versionsCandidates?.[0]?.jeuId === AX2 && grpAxL && !("versionsCandidates" in grpAxL) && !JSON.stringify(sAxL.body).includes(AX2), [grpAx, grpAxL]);
  const cAx = await envoyer("post", `/${PID}/comparaisons`, { jeuAId: AX2, jeuBId: AX1 });
  exemples["comparaison_version_candidate_axes"] = cAx.body;
  const oAx = await get(`/${PID}/comparaisons/${cAx.body.comparaison?.id}/objets`);
  const ax = (n: string) => oAx.body.resultats?.find((r: { objetA: { nom: string } | null }) => r.objetA?.nom === n);
  verifier("7. comparaison VERSION_CANDIDATE d'un plan d'axes : A = la version autorisee, B = la candidate ; precision de la classe C attribuee par la regle (2 m, origine CLASSE), corridor 3 m",
    cAx.status === 201 && cAx.body.comparaison.mode === "VERSION_CANDIDATE" && cAx.body.comparaison.role === "AXES_TRAVAUX" && cAx.body.comparaison.jeuAId === AX1 && cAx.body.comparaison.jeuBId === AX2
    && ax("Axe Route 1")?.objetA.originePrecision === "CLASSE" && ax("Axe Route 1")?.objetA.precisionM === 2 && ax("Axe Route 1")?.objetB.originePrecision === "JEU" && ax("Axe Route 1")?.corridorM === 3, [cAx.body, oAx.body]);
  verifier("7. Axe Route 1 decale de 1,5 m : CONCORDANCE ; Axe Route 2 decale de 5 m : DIVERGENCE (Hausdorff 5 m, 200 m hors corridor)",
    ax("Axe Route 1")?.statut === "CONCORDANCE" && ax("Axe Route 2")?.statut === "DIVERGENCE" && proche(ax("Axe Route 2").mesure.hausdorffM, 5, 0.02) && proche(ax("Axe Route 2").mesure.longueurHorsCorridorM, 200, 0.2), oAx.body.resultats);
  const axLect = await get(`/${PID}/comparaisons/${cAx.body.comparaison.id}`, T.lecteur);
  const axLectListe = await get(`/${PID}/comparaisons`, T.lecteur);
  verifier("7. un LECTEUR ne voit pas une comparaison qui porte sur un jeu en controle : 404 COMPARAISON_INTROUVABLE et absente de sa liste",
    axLect.status === 404 && axLect.body.code === "COMPARAISON_INTROUVABLE" && !axLectListe.body.comparaisons.some((c: { id: string }) => c.id === cAx.body.comparaison.id), axLect.body);
  const nonLignee = await envoyer("post", `/${PID}/comparaisons`, { jeuAId: AX2, jeuBId: JA });
  verifier("7. un plan d'axes ne se compare pas a un reseau : 409 JEUX_NON_COMPARABLES (ROLE)", nonLignee.status === 409 && nonLignee.body.motif === "ROLE", nonLignee.body);

  // ================================================================ 8. Dossier DIVERGENCE_SOURCES : action humaine justifiee seulement
  verifier("8. aucun dossier DIVERGENCE_SOURCES n'existe tant que personne n'en ouvre (les comparaisons n'en creent aucun)", (await compter(`SELECT count(*) n FROM conflits_projet WHERE type = 'DIVERGENCE_SOURCES'`)) === 0);
  const resAx2 = ax("Axe Route 2"), resAx1 = ax("Axe Route 1");
  const dossierConc = await envoyer("post", `/${PID}/comparaisons/${cAx.body.comparaison.id}/dossiers-conflit`, { resultatId: resAx1.id, justification: "Verification demandee sur le terrain" });
  const dossierCourt = await envoyer("post", `/${PID}/comparaisons/${cAx.body.comparaison.id}/dossiers-conflit`, { resultatId: resAx2.id, justification: "court" });
  const dossierLect = await envoyer("post", `/${PID}/comparaisons/${cAx.body.comparaison.id}/dossiers-conflit`, { resultatId: resAx2.id, justification: "Verification demandee sur le terrain" }, T.lecteur);
  verifier("8. refus : resultat concordant (409 RESULTAT_NON_DIVERGENT), justification courte (422), lecteur (403) ; aucun dossier cree",
    dossierConc.status === 409 && dossierConc.body.code === "RESULTAT_NON_DIVERGENT" && dossierCourt.status === 422 && dossierLect.status === 403
    && (await compter(`SELECT count(*) n FROM conflits_projet WHERE type = 'DIVERGENCE_SOURCES'`)) === 0, [dossierConc.body, dossierCourt.body]);
  const dossier = await envoyer("post", `/${PID}/comparaisons/${cAx.body.comparaison.id}/dossiers-conflit`, { resultatId: resAx2.id, justification: "Ecart de 5 m entre le plan PDF et le dessin du bureau d'etudes" });
  exemples["dossier_divergence"] = dossier.body;
  const kid: string = dossier.body.conflit?.id;
  const ligneK = (await sql<{ type: string; statut: string; cmp: string; pa: string | null; ja: string | null; jr: string | null; are: boolean }>(
    `SELECT type::text, statut::text, "comparaisonId" cmp, "premiereAnalyseId" pa, "jeuAxesId" ja, "jeuReseauId" jr, "aReexaminer" are FROM conflits_projet WHERE id = $1`, kid))[0];
  verifier("8. dossier ouvert par une personne : 201, DIVERGENCE_SOURCES, A_INVESTIGUER, lie a sa comparaison, sans analyse, rattache au plan d'axes de reference (jeuAxesId)",
    dossier.status === 201 && ligneK?.type === "DIVERGENCE_SOURCES" && ligneK.statut === "A_INVESTIGUER" && ligneK.cmp === cAx.body.comparaison.id && ligneK.pa === null && ligneK.ja === AX1 && ligneK.jr === null, [dossier.body, ligneK]);
  const deux = await envoyer("post", `/${PID}/comparaisons/${cAx.body.comparaison.id}/dossiers-conflit`, { resultatId: resAx2.id, justification: "Verification demandee sur le terrain" });
  verifier("8. un second dossier pour le meme resultat : 409 DOSSIER_DEJA_OUVERT avec l'identifiant du premier", deux.status === 409 && deux.body.code === "DOSSIER_DEJA_OUVERT" && deux.body.conflitId === kid, deux.body);
  // Correctifs T1+S1, B1 : le jeu B (version candidate, en CONTROLE) entre dans la lisibilite du dossier.
  const kB = (await sql<{ b: string | null }>(`SELECT "jeuSourceBId" b FROM conflits_projet WHERE id = $1`, kid))[0].b;
  const [kLectCand, kListeLect, kChefCand] = await Promise.all([get(`/${PID}/conflits/${kid}`, T.lecteur), get(`/${PID}/conflits`, T.lecteur), get(`/${PID}/conflits/${kid}`)]);
  verifier("8. B1 : le dossier porte le jeu B de sa comparaison (jeuSourceBId) ; B en CONTROLE : le LECTEUR recoit 404 sur la fiche et ne le voit pas dans sa liste ni ses compteurs ; le gestionnaire lit la mesure",
    kB === AX2 && kLectCand.status === 404 && kLectCand.body.code === "CONFLIT_INTROUVABLE" && !JSON.stringify(kListeLect.body).includes(kid) && !JSON.stringify(kListeLect.body).includes(AX2)
    && Object.values(kListeLect.body.compteurs as Record<string, number>).every((n) => n === 0) && kChefCand.status === 200 && kChefCand.body.conflit.mesure?.jeuBId === AX2,
    [kB, kLectCand.status, kListeLect.body.total, kChefCand.body.conflit?.mesure]);
  const fauxB = await essaiAnnule((tx) => tx.$executeRawUnsafe(`UPDATE conflits_projet SET "jeuSourceBId" = $2 WHERE id = $1`, kid, AX1));
  verifier("8. B1, BASE : le jeu B d'un dossier est fige (23001)", fauxB === "23001", fauxB);
  const fiche = await get(`/${PID}/conflits/${kid}`);
  const hist = await sql<{ action: string; acteur: string | null; j: string | null }>(`SELECT action::text, "acteurId" acteur, justification j FROM conflits_projet_historique WHERE "conflitId" = $1`, kid);
  verifier("8. la fiche RC-3 du dossier se lit (200), sans analyse ; historique : une creation par la personne, avec sa justification",
    fiche.status === 200 && fiche.body.conflit.type === "DIVERGENCE_SOURCES" && fiche.body.conflit.comparaisonId === cAx.body.comparaison.id && fiche.body.analyses.premiere === null
    && hist.length === 1 && hist[0].action === "CREATION" && hist[0].acteur === chef.id && /Ecart de 5 m/.test(hist[0].j ?? ""), [fiche.status, fiche.body.conflit, hist]);
  const lienRes = (await sql<{ k: string }>(`SELECT "conflitId" k FROM comparaisons_sources_resultats WHERE id = $1`, resAx2.id))[0].k;
  const lienFige = await essaiAnnule((tx) => tx.$executeRawUnsafe(`UPDATE comparaisons_sources_resultats SET "conflitId" = NULL WHERE id = $1`, resAx2.id));
  verifier("8. le resultat porte le lien vers le dossier, ecrit une seule fois (le changer : 23001)", lienRes === kid && lienFige === "23001", lienFige);
  // Une analyse RC-3 (plan d'axes AX1 autorise, reseaux autorises) ne touche pas le dossier de divergence.
  const analyse = await envoyer("post", `/${PID}/analyses`, {});
  const apresAnalyse = (await sql<{ are: boolean; da: string | null; statut: string }>(`SELECT "aReexaminer" are, "derniereAnalyseId" da, statut::text FROM conflits_projet WHERE id = $1`, kid))[0];
  verifier("8. une analyse RC-3 ignore le dossier de divergence : ni NON_RETROUVE, ni analyse, ni statut change", analyse.status === 201 && apresAnalyse.are === false && apresAnalyse.da === null && apresAnalyse.statut === "A_INVESTIGUER", [analyse.status, analyse.body.code, apresAnalyse]);
  await autoriser(PID, AX2);
  const kLect = await get(`/${PID}/conflits/${kid}`, T.lecteur);
  verifier("8. apres autorisation de la version 2 (la version 1 passe REMPLACE), le dossier qui depend de la version 1 n'est plus montre au lecteur (404), comme tout dossier RC-3",
    (await statut(AX1)) === "REMPLACE" && kLect.status === 404, kLect.body);

  // ================================================================ 9. Jeu retire : donnees masquees a tous
  // B1 : un dossier ouvert depuis la comparaison SOURCES (A = JA, B = JB) avant le retrait de B.
  const dSrc = await envoyer("post", `/${PID}/comparaisons/${CMP1}/dossiers-conflit`, { resultatId: diverg.id, justification: "Ecart de 3 m entre le plan et le releve GNSS" });
  const kSrc: string = dSrc.body.conflit?.id;
  const kSrcLectAvant = await get(`/${PID}/conflits/${kSrc}`, T.lecteur);
  verifier("9. B1 : dossier ouvert depuis deux sources AUTORISE : le lecteur le lit, mesure comprise (nom de l'objet B)", dSrc.status === 201 && kSrcLectAvant.status === 200 && kSrcLectAvant.body.conflit.mesure?.nomB === "Cable Divergent B", [dSrc.body, kSrcLectAvant.body.conflit?.mesure]);
  const ret = await envoyer("delete", `/${PID}/jeux/${JB}`);
  const detChef = await get(`/${PID}/comparaisons/${CMP1}`);
  const objChef = await get(`/${PID}/comparaisons/${CMP1}/objets`, T.admin);
  const detLect = await get(`/${PID}/comparaisons/${CMP1}`, T.lecteur);
  verifier("9. jeu RETIRE : le lecteur ne voit plus la comparaison (404) ; un gestionnaire ou un ADMIN la voit, donnees des jeux masquees (empreinte, fichier) et resultats masques (liste vide)",
    ret.status === 200 && detLect.status === 404 && detChef.status === 200 && detChef.body.comparaison.donneesMasquees === true && !JSON.stringify(detChef.body).includes("telecom-gnss")
    && objChef.status === 200 && objChef.body.masque === true && objChef.body.resultats.length === 0, [detChef.body.comparaison?.jeux, objChef.body]);
  const [kSrcLect, kSrcAdmin, kSrcListeAdmin, kSrcCsv, kSrcListeLect] = await Promise.all([get(`/${PID}/conflits/${kSrc}`, T.lecteur), get(`/${PID}/conflits/${kSrc}`, T.admin),
    get(`/${PID}/conflits?limite=100`, T.admin), get(`/${PID}/conflits/export.csv`, T.admin), get(`/${PID}/conflits?limite=100`, T.lecteur)]);
  const cleSrc = (await sql<{ c: string }>(`SELECT cle c FROM conflits_projet WHERE id = $1`, kSrc))[0]?.c;
  const ligneCsv = (kSrcCsv.text ?? "").split(/\r?\n/).find((l: string) => cleSrc !== undefined && l.endsWith(cleSrc));
  const vueAdmin = (kSrcListeAdmin.body.conflits as { id: string }[]).find((c) => c.id === kSrc);
  verifier("9. B1 : jeu B RETIRE (A toujours AUTORISE) : 404 au lecteur et absent de sa liste ; l'ADMIN voit le dossier (archive) sans mesure, objet, geometrie ni nom de l'objet B, dans la fiche, la liste et l'export CSV",
    kSrcLect.status === 404 && !JSON.stringify(kSrcListeLect.body).includes(kSrc) && kSrcAdmin.status === 200 && kSrcAdmin.body.conflit.mesure === null && kSrcAdmin.body.conflit.geometrie === null
    && kSrcAdmin.body.conflit.objet === null && !JSON.stringify(kSrcAdmin.body).includes("Cable Divergent B") && !JSON.stringify(kSrcAdmin.body).includes(JB)
    && vueAdmin !== undefined && (vueAdmin as { mesure: unknown }).mesure === null && !JSON.stringify(kSrcListeAdmin.body).includes("Cable Divergent B")
    && kSrcCsv.status === 200 && ligneCsv !== undefined && !ligneCsv.includes("Operateur Telecom Synthetique") && ligneCsv.split(";")[12] === "", [kSrcLect.status, kSrcAdmin.body.conflit, vueAdmin, ligneCsv]);
  const relance = await envoyer("post", `/${PID}/comparaisons`, { jeuAId: JA, jeuBId: JB });
  verifier("9. un jeu retire ne se compare plus : 404 JEU_INTROUVABLE (meme reponse qu'un jeu inconnu)", relance.status === 404 && relance.body.code === "JEU_INTROUVABLE", relance.body);
  const listeLect = await get(`/${PID}/comparaisons`, T.lecteur);
  verifier("9. la liste du lecteur ne cite plus aucune comparaison du jeu retire (ni son identifiant)", listeLect.status === 200 && !JSON.stringify(listeLect.body).includes(JB));

  // ================================================================ 10. Connectivite declarative
  const elec = await geojson([
    { nom: "Poste P1", pt: [10, 300], props: { connecte_a: "Cable C1" } },
    { nom: "Cable C1", coords: [[10, 300], [90, 300]] },
    { nom: "Cable C2", coords: [[90, 300], [150, 300]], props: { connecte_a: "Inconnu" } },
  ]);
  const refusNature = await depot(PID, elec, { role: "RESEAU_TIERS", concessionnaireId: CL, mapping: JSON.stringify({ connecteA: "connecte_a" }) }, "elec-sans-nature.geojson");
  verifier("10. connexions declarees sur un jeu de nature inconnue : 422 CONNECTE_A_NATURE_REQUISE, aucun jeu cree", refusNature.status === 422 && refusNature.body.code === "CONNECTE_A_NATURE_REQUISE"
    && (await compter(`SELECT count(*) n FROM projets_voirie_jeux WHERE "concessionnaireId" = $1`, CL)) === 0, refusNature.body);
  const dL = await deposer(PID, elec, { role: "RESEAU_TIERS", concessionnaireId: CL, natureObjets: "ACTIF_PHYSIQUE", mapping: JSON.stringify({ connecteA: "connecte_a" }) }, "elec.geojson");
  const JL = dL.id;
  const rels = await sql<{ t: string; o: string; p: string; s: string }>(`SELECT "typeRelation"::text t, origine::text o, preuve::text p, statut::text s FROM reseau_relations r JOIN projets_voirie_objets os ON os.id = r."sourceObjetId" WHERE os."jeuId" = $1`, JL);
  verifier("10. import declaratif : une connexion CONNECTE_A creee (le poste vers le cable C1), VALIDEE, origine IMPORT_DECLARATIF, preuve CONFIRMEE_PAR_FOURNISSEUR ; le nom introuvable n'en cree aucune et est signale",
    rels.length === 1 && rels[0].t === "CONNECTE_A" && rels[0].o === "IMPORT_DECLARATIF" && rels[0].p === "CONFIRMEE_PAR_FOURNISSEUR" && rels[0].s === "VALIDEE"
    && (dL.corps.avertissements as { code: string; nb?: number }[]).some((a) => a.code === "CONNEXIONS_NON_RESOLUES" && a.nb === 1), [rels, dL.corps.avertissements]);
  await autoriser(PID, JL);
  const oidL = async (nom: string) => (await sql<{ id: string }>(`SELECT id::text FROM projets_voirie_objets WHERE "jeuId" = $1 AND nom = $2`, JL, nom))[0].id;
  const P1o = await oidL("Poste P1"), C1o = await oidL("Cable C1"), C2o = await oidL("Cable C2");
  const fP1 = await get(`/${PID}/reseau/objets/${P1o}`, T.lecteur), fC2 = await get(`/${PID}/reseau/objets/${C2o}`, T.lecteur);
  exemples["objet_connexions"] = fP1.body.connexions;
  verifier("10. etat de connexion : le poste est CONFIRMEE (1 confirmee), le cable C2 NON_FOURNIE ; jamais « continue »",
    fP1.body.connexions?.etat === "CONFIRMEE" && fP1.body.connexions.nbConfirmees === 1 && fC2.body.connexions?.etat === "NON_FOURNIE" && !/continu/i.test(JSON.stringify([fP1.body, fC2.body])), [fP1.body.connexions, fC2.body.connexions]);
  const man = await envoyer("post", `/${PID}/reseau/relations`, { type: "CONNECTE_A", sourceObjetId: C2o, cibleObjetId: C1o, preuve: "INCONNUE", justification: "Connexion visible sur la photo du releve" });
  const fC2b = await get(`/${PID}/reseau/objets/${C2o}`);
  verifier("10. saisie humaine justifiee : CONNECTE_A creee VALIDEE, preuve INCONNUE ; le cable C2 passe a l'etat INCONNUE (pas CONFIRMEE)",
    man.status === 201 && man.body.relation.typeRelation === "CONNECTE_A" && man.body.relation.preuve === "INCONNUE" && fC2b.body.connexions.etat === "INCONNUE", [man.body, fC2b.body.connexions]);
  const sansPreuve = await envoyer("post", `/${PID}/reseau/relations`, { type: "CONNECTE_A", sourceObjetId: C1o, cibleObjetId: C2o, justification: "Connexion visible sur la photo du releve" });
  const oJA = (await sql<{ id: string }>(`SELECT id::text FROM projets_voirie_objets WHERE "jeuId" = $1 ORDER BY id LIMIT 1`, JA))[0].id;
  const natureLogique = await envoyer("post", `/${PID}/reseau/relations`, { type: "CONNECTE_A", sourceObjetId: oJA, cibleObjetId: C1o, preuve: "INCONNUE", justification: "Connexion visible sur la photo du releve" });
  verifier("10. refus : CONNECTE_A sans preuve (400), entre un objet de nature inconnue et une infrastructure (422 NATURE_RELATION_INCOMPATIBLE)",
    sansPreuve.status === 400 && natureLogique.status === 422 && natureLogique.body.code === "NATURE_RELATION_INCOMPATIBLE", [sansPreuve.body, natureLogique.body]);
  const insRel = (type: string, preuve: string) => essaiAnnule((tx) => tx.$executeRawUnsafe(
    `INSERT INTO reseau_relations (id, "projetId", "typeRelation", "sourceObjetId", "cibleObjetId", statut, origine, preuve, "decideParId", "decideLe", "justificationDecision", "creeParId")
     VALUES (gen_random_uuid()::text, $1, $2::"TypeRelationReseau", $3::bigint, $4::bigint, 'VALIDEE', 'MANUELLE', ${preuve}, $5, now(), 'relation de banc pour la base', $5)`, PID, type, P1o, C2o, chef.id));
  verifier("10. BASE : CONNECTE_A sans preuve et PORTE_PAR avec preuve sont refuses (23514)", (await insRel("CONNECTE_A", "NULL")) === "23514" && (await insRel("PORTE_PAR", "'INCONNUE'")) === "23514");

  // ================================================================ 11. Plafond de volume (ligne ECHEC) et declencheurs
  process.env.PROJETS_VOIRIE_COMPARAISON_OBJETS_MAX = "100";
  const beaucoup = (dy: number) => Array.from({ length: 60 }, (_, i) => ligne(`Fibre ${i}`, 1000 + i * 20 + dy));
  const CV = await conc("Operateur Volume Synthetique", "TELECOM");
  const V1 = (await deposer(PID, await geojson(beaucoup(0)), { role: "RESEAU_TIERS", concessionnaireId: CV, methodeAcquisition: "GNSS_RTK" }, "volume-1.geojson")).id; await autoriser(PID, V1);
  const V2 = (await deposer(PID, await geojson(beaucoup(0.2)), { role: "RESEAU_TIERS", concessionnaireId: CV, methodeAcquisition: "GEORADAR" }, "volume-2.geojson")).id; await autoriser(PID, V2);
  const trop = await envoyer("post", `/${PID}/comparaisons`, { jeuAId: V1, jeuBId: V2 });
  delete process.env.PROJETS_VOIRIE_COMPARAISON_OBJETS_MAX;
  verifier("11. plafond : 120 objets lineaires pour 100 au plus : 422 COMPARAISON_TROP_VOLUMINEUSE, une ligne ECHEC immuable, aucun resultat",
    trop.status === 422 && trop.body.code === "COMPARAISON_TROP_VOLUMINEUSE" && (await compter(`SELECT count(*) n FROM comparaisons_sources_projet WHERE statut = 'ECHEC' AND "jeuAId" = $1`, V1)) === 1, trop.body);
  verifier("11. BASE : une comparaison ne se modifie ni ne se supprime ; un resultat ne se supprime pas ; TRUNCATE refuse (23001)",
    (await essaiAnnule((tx) => tx.$executeRawUnsafe(`UPDATE comparaisons_sources_projet SET duree = 0`))) === "23001"
    && (await essaiAnnule((tx) => tx.$executeRawUnsafe(`DELETE FROM comparaisons_sources_resultats`))) === "23001"
    && (await essaiAnnule((tx) => tx.$executeRawUnsafe(`UPDATE comparaisons_sources_resultats SET statut = 'CONCORDANCE'`))) === "23001"
    && (await essaiAnnule((tx) => tx.$executeRawUnsafe(`TRUNCATE comparaisons_sources_resultats`))) === "23001");

  // ================================================================ 12. Isolation et audit
  const apresTout = await etat();
  const diff = Object.keys(apresTout).filter((t) => apresTout[t] !== avantTout[t]);
  const permis = new Set(["audit_logs", "territoires_voirie", "territoires_voirie_historique", "projets_voirie", "projets_voirie_jeux", "projets_voirie_objets", "concessionnaires_reseau", "reseau_relations", "regles_rapprochement_sources",
    "comparaisons_sources_projet", "comparaisons_sources_resultats", "conflits_projet", "conflits_projet_historique", "analyses_conflit_projet"]);
  verifier("12. ISOLATION : seules les tables du module et l'audit changent ; le referentiel est intact", diff.every((t) => permis.has(t)) && (await empreinteTroncons()) === empreinteAvant, diff.filter((t) => !permis.has(t)));
  const audits = await sql<{ t: string; n: bigint }>(`SELECT "entityType" t, count(*) n FROM audit_logs WHERE "entityType" IN ('ComparaisonSources','RegleRapprochementSources') GROUP BY 1 ORDER BY 1`);
  const geomAudit = await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" IN ('ComparaisonSources','RegleRapprochementSources','ConflitProjet','ReseauRelation','JeuDonneesProjet') AND (after::text ~* '(coordinates|LINESTRING|POINT\\()' OR before::text ~* '(coordinates|LINESTRING|POINT\\()')`);
  const nbCmp = await compter(`SELECT count(*) n FROM comparaisons_sources_projet`);
  // Regles : deux creations (gestionnaire, administrateur) et une approbation ; l'auto-approbation refusee n'ecrit rien.
  verifier("12. AUDIT : une ligne par comparaison (terminee ou en echec) et par acte reussi sur une regle (2 creations, 1 approbation) ; aucune geometrie dans l'audit",
    Number(audits.find((a) => a.t === "ComparaisonSources")?.n) === nbCmp && Number(audits.find((a) => a.t === "RegleRapprochementSources")?.n) === 3 && geomAudit === 0,
    [audits.map((a) => [a.t, Number(a.n)]), nbCmp, geomAudit]);

  // ================================================================ 13. Projet supprime : 404 pour tous
  await envoyer("delete", `/${PID}`, undefined, T.admin);
  const apresSuppr = await Promise.all([get(`/${PID}/sources`, T.admin), get(`/${PID}/comparaisons`, T.admin), get(`/${PID}/comparaisons/${CMP1}`, T.admin), get(`/${PID}/regles-rapprochement`, T.admin),
    envoyer("post", `/${PID}/comparaisons`, { jeuAId: JE1, jeuBId: JE2 }, T.admin)]);
  verifier("13. projet supprime : 404 PROJET_INTROUVABLE sur les lectures et les ecritures, ADMIN compris", apresSuppr.every((r) => r.status === 404 && r.body.code === "PROJET_INTROUVABLE"), apresSuppr.map((r) => r.status));

  const sortie = process.env.SOURCES_EXEMPLES;
  if (sortie) writeFileSync(sortie, JSON.stringify(exemples, null, 2));
}

try {
  await main();
} catch (e) {
  console.error(e);
  verifier("le banc va jusqu'au bout (aucune exception)", false, String(e));
} finally {
  conclure();
  await prisma.$disconnect();
  await banc.fermer();
}

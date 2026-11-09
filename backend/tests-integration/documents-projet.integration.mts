// Banc d'integration des DOCUMENTS DU PROJET, de « CE QUE LES DOCUMENTS PERMETTENT » et des FORMATS D'INGENIERIE (lot D1) contre un vrai PostGIS.
// Contrat : docs/projets-voirie/CONTRAT-DOCUMENTS.md. Voir tests-integration/README.md. Lancer (DATABASE_URL pointe sur `replay`) :
//   npx tsx tests-integration/documents-projet.integration.mts
// Avec DOCUMENTS_EXEMPLES=<fichier.json>, des reponses reelles servant d'exemples a docs/projets-voirie/API.md y sont ecrites.
//
// Tout passe par les routes reelles (`createApp`), des jetons signes par des secrets aleatoires, le role, le module et le perimetre LUS EN BASE, le SQL
// reel (PostGIS), les contraintes et declencheurs reels, dans le clone jetable `essai_documents_d1` (la migration du lot D1 y est appliquee par le banc
// si `replay` ne la porte pas).
//
// DONNEES 100 % SYNTHETIQUES : axes et cables inventes en metres dans le repere UTM 29N (origine arbitraire), transformes par PostGIS ; DWG et PDF
// fabriques (une signature et des octets aleatoires) ; aucun plan, aucun operateur, aucune ville reels.
import { randomBytes, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { avecTerritoireParDefaut } from "./lib/territoire-par-defaut.mts";
import { verifier, conclure } from "./lib/verdict.ts";

const banc = await ouvrirBancClone("essai_documents_d1", { migrations: ["20261104100000_completude_documentaire"] });
const { prisma } = await banc.imp("lib/prisma");
const { createApp } = await banc.imp("app");
const { signAccessToken } = await banc.imp("utils/jwt");
const request = (await import("supertest")).default;

process.env.PROJETS_VOIRIE_ANALYSE_INTERVALLE_S = "0";
const app = avecTerritoireParDefaut(createApp(), prisma);
const BASE = "/api/v2/projets-voirie";
const E0 = 380000, N0 = 1015000;

const sql = <T = Record<string, unknown>>(texte: string, ...v: unknown[]) => prisma.$queryRawUnsafe(texte, ...v) as Promise<T[]>;
const compter = async (texte: string, ...v: unknown[]) => Number((await sql<{ n: bigint }>(texte, ...v))[0].n);

async function wgs(pts: [number, number][]): Promise<[number, number][]> {
  const wkt = `LINESTRING(${pts.map(([x, y]) => `${E0 + x} ${N0 + y}`).join(",")})`;
  const r = await sql<{ g: string }>(`SELECT ST_AsGeoJSON(ST_Transform(ST_SetSRID(ST_GeomFromText($1), 32629), 4326), 9) AS g`, wkt);
  return JSON.parse(r[0].g).coordinates;
}
async function geojson(lignes: { nom: string; pts: [number, number][] }[]): Promise<Buffer> {
  const features = [];
  for (const l of lignes) features.push({ type: "Feature", properties: { name: l.nom }, geometry: { type: "LineString", coordinates: await wgs(l.pts) } });
  return Buffer.from(JSON.stringify({ type: "FeatureCollection", features }));
}
// LandXML : « Nord Est » (norme) ; un axe ligne + arc + ligne, et deux bornes.
const ne = (e: number, n: number) => `${N0 + n} ${E0 + e}`;
const UNITES = `<Units><Metric linearUnit="meter" areaUnit="squareMeter" volumeUnit="cubicMeter"/></Units>`;
const landxml = (corps: string, entete = UNITES) => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">${entete}${corps}</LandXML>`);
const AXE_LANDXML = landxml(
  `<CoordinateSystem name="UTM 29 synthetique" epsgCode="32629"/>`
  + `<CgPoints><CgPoint name="B1" code="BORNE">${ne(10, 12)} 4.0</CgPoint><CgPoint name="B2" code="BORNE">${ne(90, 12)}</CgPoint></CgPoints>`
  + `<Alignments name="Axes"><Alignment name="Axe LandXML 1" length="0" staStart="0"><CoordGeom>`
  + `<Line><Start>${ne(0, 0)}</Start><End>${ne(100, 0)}</End></Line>`
  + `<Curve rot="ccw"><Start>${ne(100, 0)}</Start><Center>${ne(100, 50)}</Center><End>${ne(150, 50)}</End></Curve>`
  + `<Line><Start>${ne(150, 50)}</Start><End>${ne(150, 150)}</End></Line></CoordGeom><Profile name="PL"/></Alignment></Alignments>`
  + `<Surfaces><Surface name="TN"/></Surfaces>`,
);
const DWG = Buffer.concat([Buffer.from("AC1032"), randomBytes(4096)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(2048), Buffer.from("\n%%EOF\n")]);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

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
  const admin = await mk("admin@banc.invalid", "Admin banc", "ADMIN", []);
  const chef = await mk("chef@banc.invalid", "Gestionnaire banc", "GESTIONNAIRE");
  const chef2 = await mk("chef2@banc.invalid", "Second gestionnaire banc", "GESTIONNAIRE");
  const lecteur = await mk("lecteur@banc.invalid", "Lecteur banc", "LECTEUR");
  const sansModule = await mk("sans@banc.invalid", "Sans module", "GESTIONNAIRE", ["troncons"]);
  const reg2 = await mk("reg2@banc.invalid", "Regional 2", "GESTIONNAIRE");
  const R1 = (await prisma.region.create({ data: { nom: "Region banc D1 un" } })).id;
  const R2 = (await prisma.region.create({ data: { nom: "Region banc D1 deux" } })).id;
  await sql(`INSERT INTO perimetres_comptes ("userId", "regionId", "accordeParId") VALUES ($1, $2, $3)`, reg2.id, R2, admin.id);
  const jeton = (u: { id: string; role: string; email: string }) => signAccessToken({ sub: u.id, role: u.role, email: u.email });
  const T = { admin: jeton(admin), chef: jeton(chef), chef2: jeton(chef2), lecteur: jeton(lecteur), sans: jeton(sansModule), reg2: jeton(reg2) };

  const get = (chemin: string, t: string | null = T.chef) => { const r = request(app).get(`${BASE}${chemin}`); return t ? r.set("Authorization", `Bearer ${t}`) : r; };
  const envoyer = (methode: "post" | "patch" | "delete", chemin: string, corps?: unknown, t: string | null = T.chef) => {
    let r = request(app)[methode](`${BASE}${chemin}`);
    if (t) r = r.set("Authorization", `Bearer ${t}`);
    return corps === undefined ? r : r.send(corps as object);
  };
  const multipart = (chemin: string, champs: Record<string, string | undefined>, fichier?: { contenu: Buffer; nom: string }, t = T.chef) => {
    const r = request(app).post(`${BASE}${chemin}`).set("Authorization", `Bearer ${t}`);
    for (const [k, v] of Object.entries(champs)) if (v !== undefined) r.field(k, v);
    return fichier ? r.attach("fichier", fichier.contenu, { filename: fichier.nom }) : r;
  };
  async function deposerJeu(pid: string, contenu: Buffer, champs: Record<string, string | undefined>, nom: string): Promise<string> {
    const d = await multipart(`/${pid}/jeux`, champs, { contenu, nom });
    if (!d.body.jeu?.id) throw new Error(`depot refuse : ${JSON.stringify(d.body)}`);
    return d.body.jeu.id;
  }
  const autoriser = async (pid: string, id: string) => {
    const a = await envoyer("post", `/${pid}/jeux/${id}/autoriser`, { justification: JUSTIF });
    if (a.status !== 200) throw new Error(`autorisation refusee : ${JSON.stringify(a.body)}`);
  };
  const statutDoc = async (id: string) => (await sql<{ s: string }>(`SELECT statut::text s FROM documents_projet_voirie WHERE id = $1`, id))[0]?.s;
  const fonction = (c: { fonctions: { code: string; etat: string }[] }, f: string) => c.fonctions.find((x) => x.code === f)?.etat;

  console.log("\n== Documents du projet, completude et formats d'ingenierie : banc PostGIS ==");
  const PID: string = (await envoyer("post", "", { code: "DOCS-1", nom: "Voirie de banc D1", regionId: R1 })).body.projet.id;
  const PID_AUTRE: string = (await envoyer("post", "", { code: "DOCS-2", nom: "Autre projet de banc", regionId: R1 })).body.projet.id;
  const CT: string = (await envoyer("post", "/concessionnaires", { nom: "Operateur Telecom Synthetique D1", typeReseau: "TELECOM" })).body.concessionnaire.id;

  const empreinteTroncons = async () => (await sql<{ h: string | null }>(`SELECT md5(string_agg(t::text, '|' ORDER BY id)) h FROM troncons t`))[0].h;
  const etat = async (): Promise<Record<string, number>> => {
    const tables = await sql<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND left(table_name, 1) <> '_' ORDER BY 1`);
    const sortie: Record<string, number> = {};
    for (const t of tables) sortie[t.table_name] = await compter(`SELECT count(*) n FROM "${t.table_name}"`);
    return sortie;
  };
  const avantTout = await etat();
  const empreinteAvant = await empreinteTroncons();
  const origineAvant = await compter(`SELECT count(*) n FROM projets_voirie_fichiers_origine`);

  // ================================================================ 0. Schema : aucune colonne binaire, declencheurs presents
  const binaires = await compter(`SELECT count(*) n FROM information_schema.columns WHERE table_name IN ('documents_projet_voirie', 'documents_projet_voirie_historique') AND data_type = 'bytea'`);
  verifier("0. aucune colonne binaire dans les tables du lot (aucun fichier n'est stocke)", binaires === 0, binaires);
  const types = await get("/referentiels/TYPE_DOCUMENT");
  verifier("0. referentiel TYPE_DOCUMENT : roleJeu pose par la migration sur PLAN_AXES, RESEAU_CONCESSIONNAIRE, LIMITES_ROUTE (version 2 systeme)",
    types.status === 200 && ["PLAN_AXES:AXES_TRAVAUX", "RESEAU_CONCESSIONNAIRE:RESEAU_TIERS", "LIMITES_ROUTE:LIMITES_ROUTE"].every((x) => {
      const [c, r] = x.split(":");
      const v = types.body.valeurs.find((y: { code: string }) => y.code === c);
      return v?.parametres?.roleJeu === r && v.version === 2 && v.systeme === true;
    }), types.body.valeurs?.map((v: { code: string; parametres: unknown; version: number }) => [v.code, v.parametres, v.version]));

  // ================================================================ 1. Rien d'autorise : fonctions indisponibles, pieces manquantes
  const c0 = await get(`/${PID}/completude`);
  exemples["completude_vide"] = c0.body;
  verifier("1. completude d'un projet vide : toutes les fonctions indisponibles (export : NON_LIVREE), quatre pieces de condition, les deux types obligatoires",
    c0.status === 200 && ["ANALYSE_2D", "CONFLITS", "COMPARAISON_SOURCES", "RECOLEMENT"].every((f) => fonction(c0.body, f) === "INDISPONIBLE") && fonction(c0.body, "EXPORT_DOSSIER") === "NON_LIVREE"
    && c0.body.piecesManquantes.filter((p: { nature: string }) => p.nature === "CONDITION").map((p: { code: string }) => p.code).join() === "PLAN_AXES_AUTORISE,RESEAU_AUTORISE,SECONDE_SOURCE,DECISION_DEPLACEMENT"
    && c0.body.piecesManquantes.filter((p: { nature: string }) => p.nature === "TYPE_OBLIGATOIRE").map((p: { typeDocument: { code: string } }) => p.typeDocument.code).join() === "PLAN_AXES,RESEAU_CONCESSIONNAIRE", c0.body);
  const pieceAxes = c0.body.piecesManquantes.find((p: { code?: string }) => p.code === "PLAN_AXES_AUTORISE");
  verifier("1. la piece « plan d'axes » dit les fonctions qui l'exigent, qu'elle ne suffit pas seule (il manque aussi un reseau), et le type qui la fournit",
    JSON.stringify(pieceAxes?.fonctions) === '["ANALYSE_2D","CONFLITS"]' && pieceAxes?.suffiraitPour.length === 0 && pieceAxes?.typesDocument.some((t: { code: string }) => t.code === "PLAN_AXES"), pieceAxes);

  // ================================================================ 2. Document attendu, puis DWG recu (non exploitable)
  const a1 = await envoyer("post", `/${PID}/documents`, { typeCode: "PLAN_AXES", titre: "Plan des axes du bureau d'etudes" });
  exemples["document_attendu"] = a1.body;
  const DOC_ATTENDU = a1.body.document?.id;
  verifier("2. document sans piece : 201 ATTENDU, version 1, lignee = lui-meme, aucune piece", a1.status === 201 && a1.body.document.statut === "ATTENDU" && a1.body.document.version === 1
    && a1.body.document.ligneeId === DOC_ATTENDU && a1.body.document.piece.sha256 === null, a1.body);
  const h1 = await sql<{ action: string; acteurId: string; statutApres: string }>(`SELECT action, "acteurId", "statutApres"::text FROM documents_projet_voirie_historique WHERE "documentId" = $1`, DOC_ATTENDU);
  verifier("2. historique ecrit PAR LA BASE (declencheur) : une ligne CREATION, acteur = le compte", h1.length === 1 && h1[0].action === "CREATION" && h1[0].acteurId === chef.id && h1[0].statutApres === "ATTENDU", h1);

  const d1 = await multipart(`/${PID}/documents/${DOC_ATTENDU}/depot`, { reference: "Envoi du bureau d'etudes n. 17" }, { contenu: DWG, nom: "C:\\plans\\axes.dwg" });
  exemples["depot_dwg"] = d1.body;
  verifier("2. depot d'un DWG sur le document attendu : RECU, format DWG detecte par le contenu, empreinte exacte, nom sans chemin, non exploitable avec la marche a suivre DXF",
    d1.status === 200 && d1.body.document.statut === "RECU" && d1.body.document.piece.format === "DWG" && d1.body.document.piece.sha256 === sha(DWG)
    && d1.body.document.piece.tailleOctets === DWG.length && d1.body.document.piece.nomFichier === "axes.dwg" && d1.body.document.exploitable.possible === false
    && d1.body.avertissements.some((a: { code: string; message: string }) => a.code === "DWG_NON_EXPLOITABLE" && /DXF/.test(a.message)), d1.body);
  verifier("2. le fichier n'est conserve nulle part : aucune ligne de fichier d'origine, taille de la ligne du document sans commune mesure avec le fichier",
    (await compter(`SELECT count(*) n FROM projets_voirie_fichiers_origine`)) === origineAvant
    && (await compter(`SELECT pg_column_size(d.*)::bigint n FROM documents_projet_voirie d WHERE id = $1`, DOC_ATTENDU)) < 2000);
  const ea = await envoyer("post", `/${PID}/documents/${DOC_ATTENDU}/statut`, { statut: "EN_ANALYSE" });
  const ex = await envoyer("post", `/${PID}/documents/${DOC_ATTENDU}/statut`, { statut: "EXPLOITABLE" });
  verifier("2. un DWG s'examine (EN_ANALYSE) mais ne devient jamais EXPLOITABLE : 409 DOCUMENT_NON_EXPLOITABLE (aide DXF)", ea.status === 200 && ex.status === 409 && ex.body.code === "DOCUMENT_NON_EXPLOITABLE" && /DXF/.test(ex.body.aide), [ea.status, ex.body]);
  const directDwg = await essaiAnnule(async (tx) => { await tx.$executeRawUnsafe(`UPDATE documents_projet_voirie SET statut = 'EXPLOITABLE', "derniereActionParId" = $2 WHERE id = $1`, DOC_ATTENDU, admin.id); });
  verifier("2. la base refuse aussi un DWG EXPLOITABLE en SQL direct (contrainte, 23514)", directDwg === "23514", directDwg);
  const sautDirect = await essaiAnnule(async (tx) => { await tx.$executeRawUnsafe(`UPDATE documents_projet_voirie SET statut = 'VALIDE', "valideParId" = $2, "valideLe" = now(), "derniereJustification" = 'saut de la matrice en SQL', "derniereActionParId" = $2 WHERE id = $1`, DOC_ATTENDU, admin.id); });
  verifier("2. la base refuse une transition hors matrice en SQL direct (EN_ANALYSE vers VALIDE, 23514)", sautDirect === "23514", sautDirect);

  // ================================================================ 3. LandXML : inventaire, apercu (rien d'ecrit), depot en quarantaine
  const inv = await multipart(`/${PID}/import/inventaire`, {}, { contenu: AXE_LANDXML, nom: "axes.xml" });
  exemples["inventaire_landxml"] = inv.body;
  verifier("3. inventaire LandXML : format detecte par le contenu, couches alignements et cgpoints, CRS declare montre sans valoir confirmation, surfaces comptees",
    inv.status === 200 && inv.body.format === "LANDXML" && inv.body.couches.map((c: { id: string; nbObjets: number }) => `${c.id}:${c.nbObjets}`).join() === "alignements:1,cgpoints:2"
    && inv.body.crs.declareDansLeFichier === "EPSG:32629" && inv.body.crs.choixObligatoire === true && inv.body.avertissements.some((a: { code: string }) => a.code === "LANDXML_SURFACES_IGNOREES"), inv.body);
  const nbJeuxAvant = await compter(`SELECT count(*) n FROM projets_voirie_jeux`);
  const apSans = await multipart(`/${PID}/import/apercu`, {}, { contenu: AXE_LANDXML, nom: "axes.xml" });
  const ap = await multipart(`/${PID}/import/apercu`, { epsgSource: "32629" }, { contenu: AXE_LANDXML, nom: "axes.xml" });
  exemples["apercu_landxml"] = { ...ap.body, echantillon: { taille: ap.body.echantillon?.taille } };
  const longueurAxe = ap.body.resume?.longueurTotaleM;
  // Longueur attendue : 100 m + quart de cercle de 50 m (78,54 m) + 100 m = 278,54 m (au facteur d'echelle UTM pres, qui reste sous 0,1 %).
  verifier("3. apercu sans CRS : 422 CRS_REQUIS (jamais deduit, meme declare) ; avec EPSG:32629 : un axe et deux points, arc discretise (longueur 278,5 m a 0,3 % pres), rien d'ecrit",
    apSans.status === 422 && apSans.body.code === "CRS_REQUIS" && ap.status === 200 && ap.body.resume.parTypeGeom.LIGNE === 1 && ap.body.resume.parTypeGeom.POINT === 2
    && Math.abs(longueurAxe - 278.54) / 278.54 < 0.003 && ap.body.resume.import.landxml.nbArcs === 1 && (await compter(`SELECT count(*) n FROM projets_voirie_jeux`)) === nbJeuxAvant,
    { sans: apSans.body, resume: ap.body.resume });
  const spirale = landxml(`<Alignments><Alignment name="S"><CoordGeom><Line><Start>${ne(0, 0)}</Start><End>${ne(10, 0)}</End></Line><Spiral rot="cw" length="20"><Start>${ne(10, 0)}</Start><End>${ne(30, 1)}</End></Spiral></CoordGeom></Alignment></Alignments>`);
  const xxe = Buffer.from(`<?xml version="1.0"?><!DOCTYPE LandXML [<!ENTITY x SYSTEM "file:///etc/passwd">]><LandXML>${UNITES}<CgPoints><CgPoint name="&x;">1 2</CgPoint></CgPoints></LandXML>`);
  const pieds = landxml(`<Alignments><Alignment name="P"><CoordGeom><Line><Start>${ne(0, 0)}</Start><End>${ne(10, 0)}</End></Line></CoordGeom></Alignment></Alignments>`, `<Units><Imperial linearUnit="USSurveyFoot"/></Units>`);
  // Un depot a la fois (place de reception du socle : deux par compte).
  const refus = [];
  for (const [contenu, epsg, nom] of [[spirale, "32629", "spirale.xml"], [xxe, "32629", "xxe.xml"], [pieds, "32629", "pieds.xml"], [Buffer.from(AXE_LANDXML.toString("utf8").replace(/<CoordinateSystem[^>]*\/>/, "")), "4326", "axes.xml"], [AXE_LANDXML, "32628", "axes.xml"]] as const) {
    refus.push(await multipart(`/${PID}/jeux`, { role: "AXES_TRAVAUX", epsgSource: epsg }, { contenu, nom }));
  }
  verifier("3. LandXML refuses au depot : spirale 422 LANDXML_SPIRALE_NON_PRISE_EN_CHARGE, XXE 422 DTD_REFUSEE, pieds 422 LANDXML_UNITES_NON_SUPPORTEES, EPSG:4326 422 CRS_INCOMPATIBLE_FORMAT, CRS different du declare 422 CRS_CONFLIT ; aucun jeu cree",
    refus.map((r) => `${r.status}:${r.body.code}`).join() === "422:LANDXML_SPIRALE_NON_PRISE_EN_CHARGE,422:DTD_REFUSEE,422:LANDXML_UNITES_NON_SUPPORTEES,422:CRS_INCOMPATIBLE_FORMAT,422:CRS_CONFLIT"
    && (await compter(`SELECT count(*) n FROM projets_voirie_jeux`)) === nbJeuxAvant, refus.map((r) => [r.status, r.body.code]));
  const JAX = await deposerJeu(PID, AXE_LANDXML, { role: "AXES_TRAVAUX", epsgSource: "32629" }, "axes.xml");
  const jeuAx = (await sql<{ format: string; statut: string; nbObjets: number }>(`SELECT format::text, statut::text, "nbObjets" FROM projets_voirie_jeux WHERE id = $1`, JAX))[0];
  verifier("3. depot LandXML : jeu en quarantaine CONTROLE, format LANDXML, trois objets", jeuAx.format === "LANDXML" && jeuAx.statut === "CONTROLE" && jeuAx.nbObjets === 3, jeuAx);

  // ================================================================ 4. Nouvelle version liee au jeu, exploitabilite, separation des taches
  const v2 = await envoyer("post", `/${PID}/documents/${DOC_ATTENDU}/versions`, { jeuId: JAX });
  exemples["nouvelle_version"] = v2.body;
  const DOC_V2 = v2.body.document?.id;
  verifier("4. nouvelle version liee au jeu LandXML : version 2 RECU, la version 1 (DWG en analyse) passe REMPLACE tout de suite, avertissement JEU_NON_AUTORISE",
    v2.status === 201 && v2.body.document.version === 2 && v2.body.document.remplaceId === DOC_ATTENDU && v2.body.remplace.statut === "REMPLACE" && (await statutDoc(DOC_ATTENDU)) === "REMPLACE"
    && v2.body.document.jeu?.id === JAX && v2.body.document.piece.format === "LANDXML" && v2.body.avertissements.some((a: { code: string }) => a.code === "JEU_NON_AUTORISE"), v2.body);
  const surAncienne = await envoyer("post", `/${PID}/documents/${DOC_ATTENDU}/versions`, { reference: "autre" });
  verifier("4. une version sur une version remplacee : 409 VERSION_NON_COURANTE", surAncienne.status === 409 && surAncienne.body.code === "VERSION_NON_COURANTE", surAncienne.body);
  await envoyer("post", `/${PID}/documents/${DOC_V2}/statut`, { statut: "EN_ANALYSE" });
  const exNonAut = await envoyer("post", `/${PID}/documents/${DOC_V2}/statut`, { statut: "EXPLOITABLE" });
  verifier("4. EXPLOITABLE tant que le jeu lie est en quarantaine : 409 JEU_NON_AUTORISE", exNonAut.status === 409 && exNonAut.body.code === "JEU_NON_AUTORISE", exNonAut.body);
  await autoriser(PID, JAX);
  const exOk = await envoyer("post", `/${PID}/documents/${DOC_V2}/statut`, { statut: "EXPLOITABLE" });
  const valMoi = await envoyer("post", `/${PID}/documents/${DOC_V2}/statut`, { statut: "VALIDE", justification: "Je valide ma propre piece" });
  verifier("4. jeu autorise : EXPLOITABLE ; VALIDE par le deposant : 409 SEPARATION_DES_TACHES", exOk.status === 200 && valMoi.status === 409 && valMoi.body.code === "SEPARATION_DES_TACHES", [exOk.body, valMoi.body]);
  const valDirect = await essaiAnnule(async (tx) => { await tx.$executeRawUnsafe(`UPDATE documents_projet_voirie SET statut = 'VALIDE', "valideParId" = "deposeParId", "valideLe" = now(), "derniereJustification" = 'validation par le deposant', "derniereActionParId" = "deposeParId" WHERE id = $1`, DOC_V2); });
  verifier("4. la base refuse aussi la validation par le deposant en SQL direct (contrainte dpv_separation_validation, 23514)", valDirect === "23514", valDirect);
  const valSansJustif = await envoyer("post", `/${PID}/documents/${DOC_V2}/statut`, { statut: "VALIDE" }, T.chef2);
  const val = await envoyer("post", `/${PID}/documents/${DOC_V2}/statut`, { statut: "VALIDE", justification: "Axes conformes au plan signe" }, T.chef2);
  exemples["document_valide"] = val.body;
  verifier("4. VALIDE sans justification : 400 ; par une autre personne : 200, valideur et date poses", valSansJustif.status === 400 && valSansJustif.body.code === "JUSTIFICATION_INVALIDE"
    && val.status === 200 && val.body.document.statut === "VALIDE" && val.body.document.validePar?.id === chef2.id, [valSansJustif.body, val.body]);
  const auditVal = await sql<{ action: string; userId: string }>(`SELECT action::text, "userId" FROM audit_logs WHERE "entityType" = 'DocumentProjetVoirie' AND "entityId" = $1 ORDER BY "createdAt"`, DOC_V2);
  verifier("4. audit de la version 2 : CREATE, UPDATE x2, VALIDATE (par le second gestionnaire)", auditVal.map((a) => a.action).join() === "CREATE,UPDATE,UPDATE,VALIDATE" && auditVal[3].userId === chef2.id, auditVal);

  // ================================================================ 5. Reseau autorise : analyse 2D et conflits disponibles malgre les pieces manquantes
  const JR = await deposerJeu(PID, await geojson([{ nom: "Cable croisant", pts: [[50, -20], [50, 20]] }, { nom: "Cable longeant", pts: [[0, 3], [100, 3]] }]),
    { role: "RESEAU_TIERS", concessionnaireId: CT, methodeAcquisition: "NUMERISATION_PLAN", classePrecision: "B", precisionHorizontaleM: "1" }, "telecom.geojson");
  await autoriser(PID, JR);
  // Pieces encore manquantes, qui ne doivent RIEN bloquer : un reseau attendu (type obligatoire deja fourni), des limites de route attendues, un PDF incomplet.
  await envoyer("post", `/${PID}/documents`, { typeCode: "RESEAU_CONCESSIONNAIRE", titre: "Plan du second operateur, attendu", concessionnaireId: CT });
  await envoyer("post", `/${PID}/documents`, { typeCode: "LIMITES_ROUTE", titre: "Limites de route, attendues" });
  const pdf = await multipart(`/${PID}/documents`, { typeCode: "AUTRE", titre: "Note de calcul (PDF)", reference: "NC-2026-04" }, { contenu: PDF, nom: "note.pdf" });
  const DOC_PDF = pdf.body.document?.id;
  await envoyer("post", `/${PID}/documents/${DOC_PDF}/statut`, { statut: "EN_ANALYSE" });
  await envoyer("post", `/${PID}/documents/${DOC_PDF}/statut`, { statut: "INCOMPLET", justification: "Il manque les annexes de calcul" });
  const c5 = await get(`/${PID}/completude`);
  exemples["completude_axes_reseau"] = c5.body;
  verifier("5. axes et reseau autorises : ANALYSE_2D et CONFLITS DISPONIBLE malgre un reseau attendu, des limites attendues, un PDF incomplet, aucune decision ni seconde source",
    fonction(c5.body, "ANALYSE_2D") === "DISPONIBLE" && fonction(c5.body, "CONFLITS") === "DISPONIBLE" && fonction(c5.body, "COMPARAISON_SOURCES") === "INDISPONIBLE" && fonction(c5.body, "RECOLEMENT") === "INDISPONIBLE", c5.body.fonctions);
  const seconde = c5.body.piecesManquantes.find((p: { code?: string }) => p.code === "SECONDE_SOURCE");
  verifier("5. piece manquante « seconde source » du reseau telecom : suffirait pour COMPARAISON_SOURCES ; le document attendu de ce concessionnaire y est rattache (decideur)",
    seconde?.reseau?.concessionnaireId === CT && JSON.stringify(seconde?.suffiraitPour) === '["COMPARAISON_SOURCES"]' && seconde?.documents?.length === 1
    && !c5.body.piecesManquantes.some((p: { nature: string; typeDocument?: { code: string } }) => p.nature === "TYPE_OBLIGATOIRE" && p.typeDocument?.code === "PLAN_AXES"), seconde);
  const an = await get(`/${PID}/analyse`);
  const anP = await envoyer("post", `/${PID}/analyses`, {});
  verifier("5. la fonction annoncee DISPONIBLE fonctionne vraiment : analyse 2D 200 et analyse de conflits persistee 201 (sur l'axe LandXML et le reseau)",
    an.status === 200 && anP.status === 201 && (await compter(`SELECT count(*) n FROM conflits_projet WHERE "projetId" = $1`, PID)) > 0, [an.status, anP.status, anP.body]);

  // ================================================================ 6. Seconde source : comparaison disponible, analyse toujours disponible
  const JR2 = await deposerJeu(PID, await geojson([{ nom: "Cable croisant B", pts: [[50.5, -20], [50.5, 20]] }]),
    { role: "RESEAU_TIERS", concessionnaireId: CT, methodeAcquisition: "GNSS_RTK", precisionHorizontaleM: "1" }, "telecom-gnss.geojson");
  await autoriser(PID, JR2);
  const c6 = await get(`/${PID}/completude`);
  verifier("6. deux sources autorisees du meme reseau : COMPARAISON_SOURCES DISPONIBLE ; ANALYSE_2D et CONFLITS inchanges ; RECOLEMENT toujours indisponible",
    fonction(c6.body, "COMPARAISON_SOURCES") === "DISPONIBLE" && fonction(c6.body, "ANALYSE_2D") === "DISPONIBLE" && fonction(c6.body, "RECOLEMENT") === "INDISPONIBLE"
    && c6.body.reseaux.length === 1 && c6.body.reseaux[0].nbSources === 2, { fonctions: c6.body.fonctions, reseaux: c6.body.reseaux });

  // ================================================================ 7. Decision de deplacement approuvee : recolement disponible
  const conflit = (await sql<{ id: string }>(`SELECT id FROM conflits_projet WHERE "projetId" = $1 AND "jeuReseauId" = $2 ORDER BY id LIMIT 1`, PID, JR))[0]?.id;
  await envoyer("patch", `/${PID}/conflits/${conflit}`, { responsableId: chef2.id });
  await envoyer("post", `/${PID}/conflits/${conflit}/preuves`, { type: "REFERENCE_DOCUMENT", texte: "Courrier de l'operateur", reference: "Courrier 2026/017" });
  const stc = (corps: unknown) => envoyer("post", `/${PID}/conflits/${conflit}/statut`, corps);
  let etape = await stc({ vers: "CONFIRME", justification: "Passage du cable confirme par courrier" });
  if (etape.status !== 200) { await stc({ vers: "POTENTIEL", justification: "Verification demandee a l'operateur" }); etape = await stc({ vers: "CONFIRME", justification: "Passage du cable confirme par courrier" }); }
  const dec = await envoyer("post", `/${PID}/conflits/${conflit}/decisions`, { option: "DEPLACER_RESEAU", justification: "Deplacement du cable propose par l'entreprise", dateDebutPrevue: "2026-12-01", dateFinPrevue: "2026-12-20" });
  const c7a = await get(`/${PID}/completude`);
  await envoyer("post", `/${PID}/conflits/${conflit}/decisions/${dec.body.decision?.id}/approuver`, { motif: "Decision validee par la direction technique" }, T.chef2);
  const td = await stc({ vers: "TRAITEMENT_DECIDE", justification: "Deplacement decide, planning arrete" });
  const c7 = await get(`/${PID}/completude`);
  verifier("7. decision seulement proposee : RECOLEMENT indisponible ; approuvee et dossier TRAITEMENT_DECIDE : RECOLEMENT DISPONIBLE ; les autres fonctions ne bougent pas",
    fonction(c7a.body, "RECOLEMENT") === "INDISPONIBLE" && td.status === 200 && fonction(c7.body, "RECOLEMENT") === "DISPONIBLE"
    && fonction(c7.body, "ANALYSE_2D") === "DISPONIBLE" && fonction(c7.body, "COMPARAISON_SOURCES") === "DISPONIBLE", { etape: etape.body, dec: dec.body, td: td.body, f: c7.body.fonctions });

  // ================================================================ 8. Lecteur : VALIDE seulement, jeu lisible seulement s'il est autorise
  const lList = await get(`/${PID}/documents`, T.lecteur);
  const lFiche = await get(`/${PID}/documents/${DOC_PDF}`, T.lecteur);
  const lValide = await get(`/${PID}/documents/${DOC_V2}`, T.lecteur);
  const lComp = await get(`/${PID}/completude`, T.lecteur);
  verifier("8. lecteur : la liste ne porte que le document VALIDE ; un document INCOMPLET lui repond 404 ; la fiche VALIDE sans historique ni justification ; la completude sans aucun document en cours",
    lList.status === 200 && lList.body.documents.length === 1 && lList.body.documents[0].id === DOC_V2 && lFiche.status === 404 && lFiche.body.code === "DOCUMENT_INTROUVABLE"
    && lValide.status === 200 && !("historique" in lValide.body) && lValide.body.document.derniereAction.justification === null && lValide.body.document.jeu?.id === JAX
    && lComp.status === 200 && JSON.stringify(lComp.body).indexOf('"documents":[') === -1 && !lComp.body.piecesManquantes.some((p: { nature: string }) => p.nature === "DOCUMENT")
    && lComp.body.documents.total === 1, { liste: lList.body, fiche: lFiche.body, comp: lComp.body.documents });
  const gFiche = await get(`/${PID}/documents/${DOC_V2}`);
  verifier("8. decideur : fiche avec les deux versions et l'historique de la lignee ecrit par la base (CREATION, DEPOT, STATUT, REMPLACEMENT...)",
    gFiche.body.versions.length === 2 && gFiche.body.historique.map((h: { action: string }) => h.action).join() === "CREATION,DEPOT,STATUT,REMPLACEMENT,CREATION,STATUT,STATUT,STATUT", gFiche.body.historique?.map((h: { action: string }) => h.action));

  // ================================================================ 9. Versions : une VALIDE reste VALIDE pendant l'examen de la suivante
  const v3 = await multipart(`/${PID}/documents/${DOC_V2}/versions`, { reference: "Plan signe, indice B" }, { contenu: PDF, nom: "axes-indice-b.pdf" });
  const DOC_V3 = v3.body.document?.id;
  verifier("9. nouvelle version sur une version VALIDE : la VALIDE est conservee pendant l'examen (le dossier garde une piece valide)", v3.status === 201 && v3.body.remplace.statut === "VALIDE" && (await statutDoc(DOC_V2)) === "VALIDE", v3.body);
  await envoyer("post", `/${PID}/documents/${DOC_V3}/statut`, { statut: "EN_ANALYSE" });
  await envoyer("post", `/${PID}/documents/${DOC_V3}/statut`, { statut: "EXPLOITABLE" });
  const v3val = await envoyer("post", `/${PID}/documents/${DOC_V3}/statut`, { statut: "VALIDE", justification: "Indice B signe par le maitre d'ouvrage" }, T.chef2);
  verifier("9. la version 3 VALIDE : la version 2 passe REMPLACE dans la meme transaction (une seule VALIDE par lignee)", v3val.status === 200 && (await statutDoc(DOC_V2)) === "REMPLACE" && (await statutDoc(DOC_V3)) === "VALIDE", v3val.body);

  // ================================================================ 10. Declencheurs et contraintes en SQL direct
  const sansPlusRecente = await essaiAnnule(async (tx) => {
    await tx.$executeRawUnsafe(`SET CONSTRAINTS ALL IMMEDIATE`);
    await tx.$executeRawUnsafe(`UPDATE documents_projet_voirie SET statut = 'REMPLACE', "derniereActionParId" = $2 WHERE id = $1`, DOC_V3, admin.id);
  });
  const resultats = {
    supprimer: await essaiAnnule(async (tx) => { await tx.$executeRawUnsafe(`DELETE FROM documents_projet_voirie WHERE id = $1`, DOC_PDF); }),
    tronquer: await essaiAnnule(async (tx) => { await tx.$executeRawUnsafe(`TRUNCATE documents_projet_voirie CASCADE`); }),
    historiqueModifie: await essaiAnnule(async (tx) => { await tx.$executeRawUnsafe(`UPDATE documents_projet_voirie_historique SET justification = 'reecrit' WHERE "documentId" = $1`, DOC_PDF); }),
    historiqueSupprime: await essaiAnnule(async (tx) => { await tx.$executeRawUnsafe(`DELETE FROM documents_projet_voirie_historique WHERE "documentId" = $1`, DOC_PDF); }),
    pieceFigee: await essaiAnnule(async (tx) => { await tx.$executeRawUnsafe(`UPDATE documents_projet_voirie SET sha256 = $2, statut = 'EN_ANALYSE', "derniereActionParId" = $3 WHERE id = $1`, DOC_PDF, "0".repeat(64), admin.id); }),
    titreFige: await essaiAnnule(async (tx) => { await tx.$executeRawUnsafe(`UPDATE documents_projet_voirie SET titre = 'autre', statut = 'EN_ANALYSE', "derniereActionParId" = $2 WHERE id = $1`, DOC_PDF, admin.id); }),
    sansChangement: await essaiAnnule(async (tx) => { await tx.$executeRawUnsafe(`UPDATE documents_projet_voirie SET "derniereJustification" = 'rien' WHERE id = $1`, DOC_PDF); }),
    typeInconnu: await essaiAnnule(async (tx) => { await tx.$executeRawUnsafe(`INSERT INTO documents_projet_voirie (id, "projetId", "ligneeId", "typeCode", titre, statut, "creeParId", "derniereActionParId") VALUES ('dx1', $1, 'dx1', 'INCONNU_D1', 't', 'ATTENDU', $2, $2)`, PID, admin.id); }),
    naitValide: await essaiAnnule(async (tx) => { await tx.$executeRawUnsafe(`INSERT INTO documents_projet_voirie (id, "projetId", "ligneeId", "typeCode", titre, statut, reference, "deposeParId", "deposeLe", "valideParId", "valideLe", "derniereJustification", "creeParId", "derniereActionParId") VALUES ('dx2', $1, 'dx2', 'AUTRE', 't', 'VALIDE', 'r', $2, now(), $3, now(), 'valide des la naissance', $2, $2)`, PID, admin.id, chef2.id); }),
    jeuAutreProjet: await essaiAnnule(async (tx) => { await tx.$executeRawUnsafe(`INSERT INTO documents_projet_voirie (id, "projetId", "ligneeId", "typeCode", titre, statut, "jeuId", "deposeParId", "deposeLe", "creeParId", "derniereActionParId") VALUES ('dx3', $1, 'dx3', 'AUTRE', 't', 'RECU', $3, $2, now(), $2, $2)`, PID_AUTRE, admin.id, JAX); }),
    versionIncoherente: await essaiAnnule(async (tx) => { await tx.$executeRawUnsafe(`INSERT INTO documents_projet_voirie (id, "projetId", "ligneeId", version, "remplaceId", "typeCode", titre, statut, reference, "deposeParId", "deposeLe", "creeParId", "derniereActionParId") VALUES ('dx4', $1, $2, 7, $2, 'PLAN_AXES', 't', 'RECU', 'r', $3, now(), $3, $3)`, PID, DOC_ATTENDU, admin.id); }),
    remplaceSansPlusRecente: sansPlusRecente,
  };
  verifier("10. base : DELETE et TRUNCATE refuses (23001), historique en ajout seul (23001), piece et titre figes (23001), changement sans statut refuse (23001), type inconnu (23503), naissance VALIDE (23514), jeu d'un autre projet (23514), version incoherente (23514), REMPLACE sans version plus recente (23514)",
    resultats.supprimer === "23001" && resultats.tronquer === "23001" && resultats.historiqueModifie === "23001" && resultats.historiqueSupprime === "23001" && resultats.pieceFigee === "23001"
    && resultats.titreFige === "23001" && resultats.sansChangement === "23001" && resultats.typeInconnu === "23503" && resultats.naitValide === "23514" && resultats.jeuAutreProjet === "23514"
    && resultats.versionIncoherente === "23514" && resultats.remplaceSansPlusRecente === "23514", resultats);

  // ================================================================ 11. Formats a l'import : PDF et DWG, fichier non pris en charge comme document
  const impPdf = await multipart(`/${PID}/jeux`, { role: "AUTRE" }, { contenu: PDF, nom: "plan.geojson" });
  const impDwg = await multipart(`/${PID}/jeux`, { role: "AUTRE" }, { contenu: DWG, nom: "plan.dwg" });
  const docGeo = await multipart(`/${PID}/documents`, { typeCode: "AUTRE", titre: "Un GeoJSON" }, { contenu: Buffer.from('{"type":"FeatureCollection","features":[]}'), nom: "a.geojson" });
  verifier("11. import d'un PDF : 422 CONTENU_NON_RECONNU (renvoie aux documents) ; d'un DWG : 415 FORMAT_NON_SUPPORTE (marche a suivre DXF) ; un GeoJSON comme document : 415 FORMAT_DOCUMENT_NON_PRIS_EN_CHARGE",
    impPdf.status === 422 && impPdf.body.code === "CONTENU_NON_RECONNU" && /documents/.test(impPdf.body.error) && impDwg.status === 415 && impDwg.body.code === "FORMAT_NON_SUPPORTE" && /DXF/.test(impDwg.body.error)
    && docGeo.status === 415 && docGeo.body.code === "FORMAT_DOCUMENT_NON_PRIS_EN_CHARGE", [impPdf.body, impDwg.body, docGeo.body]);
  const deux = await multipart(`/${PID}/documents`, { typeCode: "AUTRE", titre: "Deux pieces", jeuId: JAX }, { contenu: PDF, nom: "x.pdf" });
  const jeuAutre = await envoyer("post", `/${PID_AUTRE}/documents`, { typeCode: "AUTRE", titre: "Jeu d'un autre projet", jeuId: JAX });
  const typeInactif = await envoyer("post", `/${PID}/documents`, { typeCode: "INCONNU_D1", titre: "Type inconnu" });
  verifier("11. fichier et jeu ensemble : 400 PIECE_EXCLUSIVE ; jeu d'un autre projet : 404 JEU_INTROUVABLE ; type inconnu : 400 TYPE_DOCUMENT_INCONNU",
    deux.status === 400 && deux.body.code === "PIECE_EXCLUSIVE" && jeuAutre.status === 404 && jeuAutre.body.code === "JEU_INTROUVABLE" && typeInactif.status === 400 && typeInactif.body.code === "TYPE_DOCUMENT_INCONNU", [deux.body, jeuAutre.body, typeInactif.body]);
  const retraitType = await envoyer("delete", "/referentiels/TYPE_DOCUMENT/PLAN_AXES", undefined, T.admin);
  verifier("11. retirer un type porte par des documents : 409 VALEUR_UTILISEE (usages comptes)", retraitType.status === 409 && retraitType.body.code === "VALEUR_UTILISEE" && retraitType.body.usages?.documents > 0, retraitType.body);
  const desactive = await envoyer("patch", "/referentiels/TYPE_DOCUMENT/AUTRE", { actif: false }, T.admin);
  const creerInactif = await envoyer("post", `/${PID}/documents`, { typeCode: "AUTRE", titre: "Type desactive" });
  const versionInactif = await multipart(`/${PID}/documents/${DOC_PDF}/versions`, { reference: "NC-2026-04 avec annexes" }, { contenu: PDF, nom: "note-complete.pdf" });
  const lueInactif = await get(`/${PID}/documents/${versionInactif.body.document?.id}`);
  await envoyer("patch", "/referentiels/TYPE_DOCUMENT/AUTRE", { actif: true }, T.admin);
  verifier("11. type desactive : plus propose a la creation (400 TYPE_DOCUMENT_INCONNU) ; une nouvelle version d'un document existant reste possible et la valeur reste lisible (type.actif = false)",
    desactive.status === 200 && creerInactif.status === 400 && creerInactif.body.code === "TYPE_DOCUMENT_INCONNU" && versionInactif.status === 201 && (await statutDoc(DOC_PDF)) === "REMPLACE"
    && lueInactif.body.document?.type?.actif === false, [desactive.status, creerInactif.body, versionInactif.body, lueInactif.body.document?.type]);

  // ================================================================ 12. Retrait, perimetre, projet supprime
  const retGest = await envoyer("delete", `/${PID}/documents/${DOC_V3}`, { justification: "Retrait demande par le chef de projet" });
  const retAdmin = await envoyer("delete", `/${PID}/documents/${DOC_V3}`, { justification: "Piece deposee dans le mauvais dossier" }, T.admin);
  const apresRetrait = await Promise.all([get(`/${PID}/documents/${DOC_V3}`, T.admin), get(`/${PID}/documents/${DOC_V3}`, T.lecteur)]);
  const fige = await essaiAnnule(async (tx) => { await tx.$executeRawUnsafe(`UPDATE documents_projet_voirie SET statut = 'REMPLACE', "derniereActionParId" = $2 WHERE id = $1`, DOC_V3, admin.id); });
  verifier("12. retrait d'une piece VALIDE : 403 ROLE_INSUFFISANT pour un gestionnaire, 200 pour l'ADMIN ; ensuite 404 pour tous, ligne figee en base (23001)",
    retGest.status === 403 && retGest.body.code === "ROLE_INSUFFISANT" && retAdmin.status === 200 && apresRetrait.every((r) => r.status === 404) && fige === "23001", [retGest.body, retAdmin.body, fige]);
  const hors = await Promise.all([get(`/${PID}/documents`, T.reg2), get(`/${PID}/completude`, T.reg2), get(`/${PID}/documents/${DOC_PDF}`, T.reg2),
    envoyer("post", `/${PID}/documents`, { typeCode: "AUTRE", titre: "x" }, T.reg2), get(`/${PID}/documents`, T.sans), get(`/${PID}/documents`, null)]);
  verifier("12. compte d'une autre region : le MEME 404 masque partout ; sans la cle du module 403 ; sans jeton 401",
    hors.slice(0, 4).every((r) => r.status === 404 && r.body.code === "PROJET_INTROUVABLE") && hors[4].status === 403 && hors[5].status === 401, hors.map((r) => r.status));

  // ================================================================ 13. Isolation et audit
  const apresTout = await etat();
  const MODULE = new Set(["projets_voirie", "projets_voirie_jeux", "projets_voirie_objets", "concessionnaires_reseau", "audit_logs", "documents_projet_voirie", "documents_projet_voirie_historique",
    "analyses_conflit_projet", "conflits_projet", "conflits_projet_historique", "conflits_projet_preuves", "conflits_projet_decisions", "users", "regions", "perimetres_comptes", "territoires_voirie", "territoires_voirie_historique",
    "projets_voirie_import_evenements", "referentiels_voirie", "referentiels_voirie_historique"]);
  const changees = Object.keys(apresTout).filter((t) => apresTout[t] !== avantTout[t]);
  verifier("13. isolation : seules les tables du module (et les comptes et regions du banc) changent ; troncons du referentiel identiques (md5)",
    changees.every((t) => MODULE.has(t)) && (await empreinteTroncons()) === empreinteAvant, changees.filter((t) => !MODULE.has(t)));
  const audits = await sql<{ after: string; before: string | null }>(`SELECT after::text AS after, before::text AS before FROM audit_logs WHERE "entityType" = 'DocumentProjetVoirie'`);
  verifier("13. audit des documents : une ligne par ecriture, jamais de contenu de fichier ni de geometrie (aucune coordonnee, aucun bloc encode, lignes courtes)",
    audits.length >= 15 && audits.every((a) => !/coordinates|contenu|base64/.test(a.after) && a.after.length < 3000), audits.length);
  const histoActeurs = await compter(`SELECT count(*) n FROM documents_projet_voirie_historique h LEFT JOIN users u ON u.id = h."acteurId" WHERE u.id IS NULL`);
  verifier("13. chaque ligne d'historique a un acteur reel ; autant de lignes que de gestes (creations, depots, statuts, remplacements, retraits)",
    histoActeurs === 0 && (await compter(`SELECT count(*) n FROM documents_projet_voirie_historique`)) === (await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'DocumentProjetVoirie'`)));

  // ================================================================ 14. Projet supprime : 404 pour tous
  await envoyer("delete", `/${PID}`, undefined, T.admin);
  const apresSuppr = await Promise.all([get(`/${PID}/documents`, T.admin), get(`/${PID}/completude`, T.admin), get(`/${PID}/documents/${DOC_PDF}`, T.admin),
    envoyer("post", `/${PID}/documents`, { typeCode: "AUTRE", titre: "Apres suppression" }, T.admin), envoyer("post", `/${PID}/documents/${DOC_PDF}/statut`, { statut: "EN_ANALYSE" }, T.admin)]);
  verifier("14. projet supprime : 404 PROJET_INTROUVABLE sur les lectures et les ecritures, ADMIN compris", apresSuppr.every((r) => r.status === 404 && r.body.code === "PROJET_INTROUVABLE"), apresSuppr.map((r) => [r.status, r.body.code]));

  const sortie = process.env.DOCUMENTS_EXEMPLES;
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

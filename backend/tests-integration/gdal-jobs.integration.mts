// Banc d'integration des JOBS DE CONVERSION GDAL (lot B2) contre un vrai PostGIS ET le VRAI conteneur de conversion (ageroute-geoconv:0.2.0).
// Contrat : docs/projets-voirie/CONTRAT-IMPORT.md section 13, CHAINE-GDAL.md. Voir tests-integration/README.md. Lancer (DATABASE_URL pointe sur `replay`, Docker Desktop lance) :
//   npx tsx tests-integration/gdal-jobs.integration.mts
//
// Tout passe par les routes reelles montees comme en production (`createApp`), des jetons signes par des secrets aleatoires, le role, le module et le perimetre LUS EN BASE,
// le SQL reel, les declencheurs reels, et un conteneur GDAL reel lance avec les options du compose de preproduction (reseau coupe, racine en lecture seule, UID 10001,
// sans capacite, 1 Go, 64 processus). Le dossier d'echange est un dossier temporaire de la machine monte dans le conteneur. Le clone jetable est `essai_gdal_jobs`.
//
// DONNEES 100 % SYNTHETIQUES : fichiers fabriques ici (GeoJSON inventes autour de l'UTM 29N 500000 / 1200000, DXF ecrit a la main, GeoPackage et Shapefile fabriques par
// ogr2ogr dans l'image GDAL de base, sans reseau). Aucun nom reel, aucun fichier d'un tiers.
//
// Sections : 0 interrupteur coupe (defaut) ; 1 E2E GPKG ; 2 E2E SHAPEFILE ; 3 E2E DXF ; 4 versions et suppressions via le pipeline ; 5 plafonds, cadence, annulation, relance,
// expiration, reprise ; 6 sortie du conteneur non fiable ; 7 controle d'acces ; 8 base (declencheurs, contraintes) ; 9 aucune ecriture hors du module.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure } from "./lib/verdict.ts";

const banc = await ouvrirBancClone("essai_gdal_jobs", { migrations: [] });
const { prisma } = await banc.imp("lib/prisma");
const { createApp } = await banc.imp("app");
const { signAccessToken } = await banc.imp("utils/jwt");
const { traiterUnTour } = await banc.imp("projets-voirie/gdal/traiteur");
const { construireZip } = await banc.imp("projets-voirie/formats/zip.fixtures");
const { dxfMixte } = await banc.imp("projets-voirie/gdal/fixtures.gdal");
const request = (await import("supertest")).default;

const IMAGE = process.env.GEOCONV_IMAGE ?? "ageroute-geoconv:0.2.0";
const BASE_GDAL = "ghcr.io/osgeo/gdal:ubuntu-small-3.13.3";
const CONTENEUR = `geoconv-b2-banc-${process.pid}`;
const RACINE = mkdtempSync(path.join(tmpdir(), "b2-banc-"));
const SPOOL = path.join(RACINE, "spool");
const FAB = path.join(RACINE, "fab");
for (const d of ["spool/entree", "spool/sortie", "fab"]) mkdirSync(path.join(RACINE, d), { recursive: true });

const dockerEnv = { ...process.env, MSYS_NO_PATHCONV: "1" };
const docker = (args: string[]): string => execFileSync("docker", args, { env: dockerEnv, stdio: ["ignore", "pipe", "pipe"] }).toString();
const hote = (p: string) => p.replace(/\\/g, "/");

function demarrerConteneur(): void {
  try { docker(["rm", "-f", CONTENEUR]); } catch { /* absent */ }
  docker(["run", "-d", "--name", CONTENEUR, "--network", "none", "--read-only", "--user", "10001:10001", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--init", "--memory", "1g", "--memory-swap", "1g", "--cpus", "1", "--pids-limit", "64", "--tmpfs", "/tmp:size=512m,mode=1777,noexec,nosuid,nodev",
    "-e", "GEOCONV_SCRUTATION_S=1", "-v", `${hote(SPOOL)}/entree:/spool/entree:ro`, "-v", `${hote(SPOOL)}/sortie:/spool/sortie`, IMAGE]);
}
const arreterConteneur = () => { try { docker(["stop", "-t", "5", CONTENEUR]); } catch { /* deja arrete */ } };
const detruireConteneur = () => { try { docker(["rm", "-f", CONTENEUR]); } catch { /* absent */ } };

// ---------------------------------------------------------------------------------------------- Fixtures (GDAL de base, sans reseau)
const O = { x: 500000, y: 1200000 };
type Pt = [number, number];
const utm = (...pts: Pt[]): Pt[] => pts.map(([x, y]) => [O.x + x, O.y + y]);
const feature = (nom: string, pts: Pt[], extra: Record<string, unknown> = {}) => ({ type: "Feature", properties: { nom, ...extra }, geometry: { type: "LineString", coordinates: pts } });
const AXE_A = utm([0, 0], [100, 50], [200, 40]);
const AXE_B = utm([0, 100], [150, 120]);
const AXE_C = utm([0, 200], [120, 230]);
const ecrireGeoJson = (nom: string, features: unknown[], epsg = 32629) => {
  writeFileSync(path.join(FAB, nom), JSON.stringify({ type: "FeatureCollection", crs: { type: "name", properties: { name: `urn:ogc:def:crs:EPSG::${epsg}` } }, features }));
};
function ogr(args: string[]): void { docker(["run", "--rm", "--network", "none", "-v", `${hote(FAB)}:/fab`, BASE_GDAL, "ogr2ogr", ...args]); }

ecrireGeoJson("axes3.geojson", [feature("Axe A", AXE_A, { n: 1 }), feature("Axe B", AXE_B, { n: 2 }), feature("Axe C", AXE_C, { n: 3 })]);
ecrireGeoJson("axes2.geojson", [feature("Axe A", AXE_A, { n: 1 }), feature("Axe B", AXE_B, { n: 2 })]);
ecrireGeoJson("axes1.geojson", [feature("Axe A", AXE_A, { n: 1 })]);
writeFileSync(path.join(FAB, "regards.geojson"), JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", properties: { nom: "Regard 1" }, geometry: { type: "Point", coordinates: [-9.0005, 10.8557] } }] }));
ogr(["-f", "GPKG", "/fab/axes3.gpkg", "/fab/axes3.geojson", "-nln", "axes", "-a_srs", "EPSG:32629"]);
ogr(["-f", "GPKG", "/fab/axes2.gpkg", "/fab/axes2.geojson", "-nln", "axes", "-a_srs", "EPSG:32629"]);
ogr(["-f", "GPKG", "/fab/axes1.gpkg", "/fab/axes1.geojson", "-nln", "axes", "-a_srs", "EPSG:32629"]);
ogr(["-f", "GPKG", "/fab/mixte.gpkg", "/fab/axes2.geojson", "-nln", "axes", "-a_srs", "EPSG:32629"]);
ogr(["-f", "GPKG", "-update", "-append", "/fab/mixte.gpkg", "/fab/regards.geojson", "-nln", "regards", "-a_srs", "EPSG:4326"]);
ogr(["-f", "GPKG", "/fab/wgs.gpkg", "/fab/regards.geojson", "-nln", "regards", "-a_srs", "EPSG:4326"]);
ogr(["-f", "ESRI Shapefile", "/fab/shp", "/fab/axes2.geojson", "-nln", "axes", "-a_srs", "EPSG:32629"]);
ogr(["-f", "ESRI Shapefile", "/fab/shpsansprj", "/fab/axes2.geojson", "-nln", "axes", "-a_srs", "EPSG:32629"]);
rmSync(path.join(FAB, "shpsansprj", "axes.prj"));
const lire = (...p: string[]) => readFileSync(path.join(FAB, ...p));
const GPKG3 = lire("axes3.gpkg"), GPKG2 = lire("axes2.gpkg"), GPKG1 = lire("axes1.gpkg"), GPKG_MIXTE = lire("mixte.gpkg"), GPKG_WGS = lire("wgs.gpkg");
const zipDe = (dossier: string, prefixe = "reseau/") => construireZip(readdirSync(path.join(FAB, dossier)).map((n) => ({ nom: `${prefixe}${n}`, contenu: lire(dossier, n) }))).buffer;
const SHP_ZIP = zipDe("shp"), SHP_SANS_PRJ = zipDe("shpsansprj");
const SHP_INCOMPLET = construireZip(readdirSync(path.join(FAB, "shp")).filter((n) => !n.endsWith(".shx")).map((n) => ({ nom: n, contenu: lire("shp", n) }))).buffer;
const ZIP_SLIP = construireZip([{ nom: "../../etc/evil.shp", contenu: "x" }, { nom: "a.shx", contenu: "x" }, { nom: "a.dbf", contenu: "x" }]).buffer;
const DXF = dxfMixte({ origine: [O.x, O.y] });
/** Egalite de deux objets sans tenir compte de l'ordre des cles (jsonb reordonne les cles). */
const egal = (a: Record<string, unknown>, b: Record<string, unknown>) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------------------------------------- Aides
process.env.PROJETS_VOIRIE_ANALYSE_INTERVALLE_S = "0";
process.env.PROJETS_VOIRIE_GDAL_SONDAGE_S = "1";
process.env.PROJETS_VOIRIE_GDAL_CONCURRENCE = "2";
// La cadence par heure est eprouvee a part (section 5) : ailleurs elle est ouverte pour que le banc puisse enchainer ses jobs.
process.env.PROJETS_VOIRIE_GDAL_CREATIONS_HEURE = "200";
const app = createApp();
const BASE = "/api/v2/projets-voirie";
const sql = <T = Record<string, unknown>>(texte: string, ...v: unknown[]) => prisma.$queryRawUnsafe(texte, ...v) as Promise<T[]>;
const compter = async (texte: string, ...v: unknown[]) => Number((await sql<{ n: bigint }>(texte, ...v))[0].n);
const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));
const JUSTIF = "Controle effectue avec le chef de projet";

async function main() {
  const mk = (email: string, nomComplet: string, role: string, modules: string[] = ["projets-voirie"]) =>
    prisma.user.create({ data: { email, nomComplet, passwordHash: "x", role, modulesAutorises: modules, actif: true } });
  const admin = await mk("admin@banc.invalid", "Mariama Admin", "ADMIN", []);
  const chef = await mk("chef@banc.invalid", "Sekou Gestionnaire", "GESTIONNAIRE");
  const chef2 = await mk("chef2@banc.invalid", "Fanta Gestionnaire", "GESTIONNAIRE");
  const lecteur = await mk("lecteur@banc.invalid", "Lecteur banc", "LECTEUR");
  const sansModule = await mk("sans@banc.invalid", "Sans module", "GESTIONNAIRE", ["troncons"]);
  const reg1 = await mk("reg1@banc.invalid", "Regional 1", "GESTIONNAIRE");
  const REGION_1 = (await prisma.region.create({ data: { nom: "Region banc 1" } })).id;
  const REGION_2 = (await prisma.region.create({ data: { nom: "Region banc 2" } })).id;
  await sql(`INSERT INTO perimetres_comptes ("userId", "regionId", "accordeParId") VALUES ($1, $2, $3)`, reg1.id, REGION_1, admin.id);
  const jeton = (u: { id: string; role: string; email: string }) => signAccessToken({ sub: u.id, role: u.role, email: u.email });
  const T = { admin: jeton(admin), chef: jeton(chef), chef2: jeton(chef2), lecteur: jeton(lecteur), sans: jeton(sansModule), reg1: jeton(reg1) };

  const get = (chemin: string, t = T.chef) => request(app).get(`${BASE}${chemin}`).set("Authorization", `Bearer ${t}`);
  const envoyer = (methode: "post" | "patch" | "delete", chemin: string, corps?: unknown, t = T.chef) => {
    const r = request(app)[methode](`${BASE}${chemin}`).set("Authorization", `Bearer ${t}`);
    return corps === undefined ? r : r.send(corps as object);
  };
  const multipart = (chemin: string, champs: Record<string, string | undefined>, fichier: Buffer | null, nom = "reseau.bin", t = T.chef) => {
    const r = request(app).post(`${BASE}${chemin}`).set("Authorization", `Bearer ${t}`);
    for (const [k, v] of Object.entries(champs)) if (v !== undefined) r.field(k, v);
    return fichier ? r.attach("fichier", fichier, { filename: nom }) : r;
  };
  const projet = async (code: string, regionId: number | null = REGION_1): Promise<string> => (await envoyer("post", "", { code, nom: `Voirie ${code}`, ...(regionId ? { regionId } : {}) }, T.admin)).body.projet.id;
  const creerJob = (pid: string, fichier: Buffer, champs: Record<string, string | undefined>, nom: string, t = T.chef) => multipart(`/${pid}/import/jobs`, champs, fichier, nom, t);
  async function attendreJob(pid: string, jobId: string, finaux = ["TERMINE", "ECHEC", "ANNULE", "EXPIRE"], delaiMs = 120_000): Promise<Record<string, any>> {
    const fin = Date.now() + delaiMs;
    for (;;) {
      await traiterUnTour();
      const r = await get(`/${pid}/import/jobs/${jobId}`);
      if (finaux.includes(r.body.job?.statut)) return r.body.job;
      if (Date.now() > fin) throw new Error(`job ${jobId} non termine : ${JSON.stringify(r.body.job)}`);
      await attendre(700);
    }
  }
  async function convertir(pid: string, fichier: Buffer, champs: Record<string, string | undefined>, nom: string): Promise<Record<string, any>> {
    const c = await creerJob(pid, fichier, champs, nom);
    if (c.status !== 202) throw new Error(`creation refusee : ${c.status} ${JSON.stringify(c.body)}`);
    return attendreJob(pid, c.body.job.id);
  }
  const tourEnAvance = (minutes: number) => traiterUnTour(new Date(Date.now() + minutes * 60_000));

  /** Coordonnees WGS 84 d'une ligne UTM par PostGIS (oracle independant de GDAL). */
  async function oracleWgs(pts: Pt[]): Promise<number[][]> {
    const wkt = `LINESTRING(${pts.map(([x, y]) => `${x} ${y}`).join(",")})`;
    const r = await sql<{ g: string }>(`SELECT ST_AsGeoJSON(ST_Transform(ST_SetSRID(ST_GeomFromText($1), 32629), 4326), 9) AS g`, wkt);
    return JSON.parse(r[0].g).coordinates;
  }
  async function oracleLongueurM(pts: Pt[]): Promise<number> {
    const wkt = `LINESTRING(${pts.map(([x, y]) => `${x} ${y}`).join(",")})`;
    return Number((await sql<{ l: number }>(`SELECT ST_Length(ST_Transform(ST_SetSRID(ST_GeomFromText($1), 32629), 4326)::geography)::float8 AS l`, wkt))[0].l);
  }
  const proche = (a: number[][], b: number[][], tol: number) => a.length === b.length && a.every((p, i) => Math.abs(p[0] - b[i][0]) <= tol && Math.abs(p[1] - b[i][1]) <= tol);
  const spoolVide = () => readdirSync(path.join(SPOOL, "entree")).length + readdirSync(path.join(SPOOL, "sortie")).length === 0;
  const contenuSpool = (jobId: string) => [...readdirSync(path.join(SPOOL, "entree")), ...readdirSync(path.join(SPOOL, "sortie"))].filter((n) => n.startsWith(jobId));

  console.log("\n== Jobs de conversion GDAL : banc PostGIS et conteneur reel ==");
  const PID = await projet("GDAL-1");
  const PID2 = await projet("GDAL-2");
  const PID_R2 = await projet("GDAL-R2", REGION_2);
  const tablesAvant: Record<string, number> = {};
  const tables = (await sql<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map((x) => x.t);
  const snapshot = async (): Promise<Record<string, number>> => {
    const o: Record<string, number> = {};
    for (const t of tables) o[t] = await compter(`SELECT count(*) AS n FROM "${t}"`);
    return o;
  };
  const MODULE_ECRIT = new Set(["projets_voirie_import_jobs", "projets_voirie_jeux", "projets_voirie_objets", "audit_logs", "projets_voirie_import_evenements"]);
  const referentielAvant = await snapshot();
  void tablesAvant;

  // ================================================================ 0. Interrupteur coupe (defaut)
  console.log("\n-- 0. Interrupteur desactive (defaut) : aucune dependance au conteneur");
  delete process.env.PROJETS_VOIRIE_GDAL;
  process.env.PROJETS_VOIRIE_GDAL_SPOOL = path.join(RACINE, "inexistant");
  const opt0 = await get(`/${PID}/import/options`);
  verifier("0. GET import/options desactive : les trois formats GDAL INDISPONIBLES avec la raison, sans limites, 200", opt0.status === 200 && opt0.body.formatsGdal.actif === false
    && opt0.body.formatsGdal.formats.length === 3 && opt0.body.formatsGdal.formats.every((f: any) => f.etat === "INDISPONIBLE" && /PROJETS_VOIRIE_GDAL/.test(f.raison)) && opt0.body.formatsGdal.limites === null,
  opt0.body.formatsGdal);
  const dis1 = await creerJob(PID, GPKG2, {}, "a.gpkg");
  verifier("0. POST import/jobs desactive : 415 FORMAT_GDAL_DESACTIVE, aucun job, aucun dossier cree", dis1.status === 415 && dis1.body.code === "FORMAT_GDAL_DESACTIVE"
    && await compter(`SELECT count(*) AS n FROM projets_voirie_import_jobs`) === 0 && !existsSync(path.join(RACINE, "inexistant")), dis1.body);
  const dis2 = await get(`/${PID}/import/jobs`);
  const dis3 = await get(`/${PID}/import/jobs/${"0".repeat(8)}-0000-4000-8000-000000000000`);
  verifier("0. GET import/jobs et GET import/jobs/:id desactives : 503 GDAL_DESACTIVE", dis2.status === 503 && dis2.body.code === "GDAL_DESACTIVE" && dis3.status === 503 && dis3.body.code === "GDAL_DESACTIVE");
  const dis4 = await multipart(`/${PID}/import/apercu`, {}, GPKG2, "a.gpkg");
  const dis5 = await multipart(`/${PID}/import/apercu`, {}, SHP_ZIP, "a.zip");
  const dis6 = await multipart(`/${PID}/import/apercu`, {}, DXF, "a.dxf");
  verifier("0. aperçu synchrone d'un GeoPackage, d'un Shapefile ZIP et d'un DXF desactives : 415 FORMAT_GDAL_DESACTIVE (jamais lus dans l'API)",
    [dis4, dis5, dis6].every((r) => r.status === 415 && r.body.code === "FORMAT_GDAL_DESACTIVE"), [dis4.body, dis5.body, dis6.body]);
  const dis7 = await multipart(`/${PID}/import/apercu`, { jobId: "0".repeat(8) + "-0000-4000-8000-000000000000" }, null);
  verifier("0. aperçu avec un jobId desactive : 503 GDAL_DESACTIVE, sans toucher au spool", dis7.status === 503 && dis7.body.code === "GDAL_DESACTIVE" && !existsSync(path.join(RACINE, "inexistant")), dis7.body);
  const tickOff = await traiterUnTour();
  verifier("0. le sondage ne fait rien quand l'interrupteur est coupe (aucun acces au spool)", Object.values(tickOff).every((n) => n === 0) && !existsSync(path.join(RACINE, "inexistant")));
  const geoj = await multipart(`/${PID}/jeux`, { role: "AUTRE" }, Buffer.from('{"type":"FeatureCollection","features":[]}'), "vide.geojson");
  verifier("0. les formats simples ne dependent pas de l'interrupteur (GeoJSON vide : refus metier habituel, jamais 415 GDAL)", geoj.body.code !== "FORMAT_GDAL_DESACTIVE", geoj.body);

  // ================================================================ Activation + conteneur reel
  process.env.PROJETS_VOIRIE_GDAL = "1";
  process.env.PROJETS_VOIRIE_GDAL_SPOOL = SPOOL;
  demarrerConteneur();
  await attendre(4000);
  const opt1 = await get(`/${PID}/import/options`);
  verifier("0. active avec dossier d'echange accessible : etat SUPPORTE annonce, preuves citees, limites annoncees", opt1.body.formatsGdal.disponible === true
    && opt1.body.formatsGdal.formats.every((f: any) => f.etat === "SUPPORTE" && f.preuve.verification.startsWith("E2E")) && opt1.body.formatsGdal.limites.retentionH === 24, opt1.body.formatsGdal);

  // ================================================================ 1. E2E GPKG
  console.log("\n-- 1. E2E GPKG : fichier -> job -> conteneur reel -> apercu -> simulation -> depot");
  const j1 = await convertir(PID, GPKG3, {}, "axes.gpkg");
  verifier("E2E GPKG : job TERMINE par le conteneur reel ; resume sans geometrie (couche, 3 objets, CRS source EPSG:32629 declare par le fichier, GDAL/PROJ versionnes)",
    j1.statut === "TERMINE" && j1.resume.couches.length === 1 && j1.resume.couches[0].nbObjets === 3 && j1.resume.couches[0].crsSource?.epsg === 32629 && j1.resume.couches[0].crsSource?.origine === "fichier"
    && /^3\./.test(j1.resume.gdal.version) && !!j1.resume.gdal.proj && !JSON.stringify(j1).includes("coordinates") && j1.resume.source.sha256 === sha(GPKG3) && j1.resume.source.octets === GPKG3.length, j1);
  verifier("E2E GPKG : le job est utilisable, ses fichiers du spool existent, expiration dans 24 h", j1.utilisable === true && contenuSpool(j1.id).length === 2 && Math.abs(new Date(j1.expireLe).getTime() - Date.now() - 24 * 3600_000) < 120_000);
  const inv1 = await multipart(`/${PID}/import/inventaire`, { jobId: j1.id }, null);
  verifier("E2E GPKG : inventaire du job : couche `axes`, 3 objets de type LIGNE, CRS declare EPSG:32629 a confirmer, champs nom et n, aucune coordonnee", inv1.status === 200 && inv1.body.format === "GPKG"
    && inv1.body.couches[0].id === "axes" && inv1.body.couches[0].parTypeGeom.LIGNE === 3 && inv1.body.crs.declareDansLeFichier === "EPSG:32629" && inv1.body.crs.choixObligatoire === true
    && inv1.body.champsDisponibles.includes("nom") && inv1.body.fichier.sha256 === sha(GPKG3) && !JSON.stringify(inv1.body).includes("coordinates"), inv1.body);
  const apSans = await multipart(`/${PID}/import/apercu`, { jobId: j1.id }, null);
  verifier("E2E GPKG : CRS projete declare SANS confirmation : 422 CRS_REQUIS (jamais devine)", apSans.status === 422 && apSans.body.code === "CRS_REQUIS", apSans.body);
  const apMauvais = await multipart(`/${PID}/import/apercu`, { jobId: j1.id, epsgSource: "32628" }, null);
  verifier("E2E GPKG : confirmation d'un autre CRS que celui du fichier : 422 CRS_CONFLIT", apMauvais.status === 422 && apMauvais.body.code === "CRS_CONFLIT", apMauvais.body);
  const apMeme = await multipart(`/${PID}/import/apercu`, { jobId: j1.id, epsgSource: "4326" }, null);
  verifier("E2E GPKG : confirmation de 4326 alors que le fichier declare 32629 : 422 CRS_CONFLIT", apMeme.status === 422 && apMeme.body.code === "CRS_CONFLIT", apMeme.body);
  const ap1 = await multipart(`/${PID}/import/apercu`, { jobId: j1.id, epsgSource: "32629", mapping: JSON.stringify({ nom: "nom", identifiant: "n" }) }, null);
  const attenduA = await oracleWgs(AXE_A);
  const objA = ap1.body.echantillon?.objets?.find((o: any) => o.nom === "Axe A");
  verifier("E2E GPKG : apercu par le MEME pipeline : 3 objets, mapping applique, CRS source/cible/unites, methode GDAL/PROJ, plausibilite CONFORME", ap1.status === 200 && ap1.body.statistiques.nbObjets === 3
    && ap1.body.resume.crs.epsgSource === 32629 && ap1.body.resume.crs.uniteSource === "metre" && ap1.body.resume.crs.transformation === "GDAL_PROJ" && /^GDAL 3\./.test(ap1.body.resume.crs.methode)
    && ap1.body.resume.crs.plausibilite.statut === "CONFORME" && ap1.body.resume.import.mapping.identifiant === "n" && ap1.body.resume.import.conversion.jobId === j1.id, { crs: ap1.body.resume?.crs, imp: ap1.body.resume?.import, stat: ap1.body.statistiques });
  verifier("E2E GPKG : coordonnees reprojetees par GDAL = transformation INDEPENDANTE de PostGIS (ST_Transform) a 2e-7 degre pres", !!objA && proche(objA.geometrie.coordinates, attenduA, 2e-7), { objA: objA?.geometrie, attenduA });
  const longAttendue = (await oracleLongueurM(AXE_A)) + (await oracleLongueurM(AXE_B)) + (await oracleLongueurM(AXE_C));
  verifier("E2E GPKG : longueur totale geodesique = oracle SQL (geography) a 0,05 % pres", Math.abs(ap1.body.statistiques.longueurTotaleM - longAttendue) / longAttendue < 5e-4, { lu: ap1.body.statistiques.longueurTotaleM, attendu: longAttendue });
  verifier("E2E GPKG : l'apercu ne persiste rien (aucun jeu, job non consomme)", await compter(`SELECT count(*) AS n FROM projets_voirie_jeux`) === 0 && (await get(`/${PID}/import/jobs/${j1.id}`)).body.job.jeuId === null);
  const simu1 = await multipart(`/${PID}/jeux?simuler=true`, { jobId: j1.id, role: "AXES_TRAVAUX", epsgSource: "32629" }, null);
  verifier("E2E GPKG : simulation du depot : 200, aucun jeu ni objet ecrit, job intact et toujours utilisable", simu1.status === 200 && simu1.body.simulation === true
    && await compter(`SELECT count(*) AS n FROM projets_voirie_jeux`) === 0 && (await get(`/${PID}/import/jobs/${j1.id}`)).body.job.utilisable === true, simu1.body);
  const dep1 = await multipart(`/${PID}/jeux`, { jobId: j1.id, role: "AXES_TRAVAUX", epsgSource: "32629", sha256Attendu: sha(GPKG3) }, null);
  const jeu1 = dep1.body.jeu;
  verifier("E2E GPKG : depot reel : 201, jeu CONTROLE (quarantaine) de format GPKG, empreinte et taille du fichier D'ORIGINE, 3 objets, nom du fichier d'origine", dep1.status === 201 && jeu1.statut === "CONTROLE"
    && jeu1.format === "GPKG" && jeu1.sha256 === sha(GPKG3) && jeu1.tailleOctets === GPKG3.length && jeu1.nbObjets === 3 && jeu1.nomFichier === "axes.gpkg", dep1.body);
  const ligneJeu = (await sql<any>(`SELECT format::text AS f, resume FROM projets_voirie_jeux WHERE id = $1`, jeu1.id))[0];
  verifier("E2E GPKG : resume du jeu : CRS (source, cible, unites, methode, versions) et provenance de la conversion, sans geometrie", ligneJeu.f === "GPKG" && ligneJeu.resume.crs.epsgCible === 4326
    && ligneJeu.resume.crs.versionProj === j1.resume.gdal.proj && ligneJeu.resume.import.conversion.formatSource === "GPKG" && ligneJeu.resume.import.conservationOriginal === "EMPREINTE_SEULE");
  const jobApres = (await get(`/${PID}/import/jobs/${j1.id}`)).body.job;
  verifier("E2E GPKG : le job est consomme (jeuId) et ses fichiers du spool retires", jobApres.jeuId === jeu1.id && jobApres.fichiersPurges === true && jobApres.utilisable === false && contenuSpool(j1.id).length === 0, jobApres);
  const reuse = await multipart(`/${PID}/import/apercu`, { jobId: j1.id, epsgSource: "32629" }, null);
  verifier("E2E GPKG : un job utilise ne sert plus : 409 JOB_DEJA_UTILISE", reuse.status === 409 && reuse.body.code === "JOB_DEJA_UTILISE", reuse.body);
  const j1b = await convertir(PID, GPKG3, {}, "axes-bis.gpkg");
  const dep1b = await multipart(`/${PID}/jeux`, { jobId: j1b.id, role: "AXES_TRAVAUX", epsgSource: "32629" }, null);
  verifier("E2E GPKG : le meme fichier ne se charge pas deux fois (idempotence du pipeline) : 409 JEU_DEJA_CHARGE", dep1b.status === 409 && dep1b.body.code === "JEU_DEJA_CHARGE", dep1b.body);
  const au1 = await envoyer("post", `/${PID}/jeux/${jeu1.id}/autoriser`, { justification: JUSTIF });
  verifier("E2E GPKG : le jeu converti s'autorise comme les autres (quarantaine puis decision humaine)", au1.status === 200 && au1.body.jeu.statut === "AUTORISE", au1.body);
  const audCreate = (await sql<any>(`SELECT "after" FROM audit_logs WHERE "entityType" = 'JobImportProjet' AND "entityId" = $1 AND action = 'CREATE'`, j1.id))[0];
  const audJeu = (await sql<any>(`SELECT "after" FROM audit_logs WHERE "entityType" = 'JeuDonneesProjet' AND "entityId" = $1 AND action = 'CREATE'`, jeu1.id))[0];
  verifier("E2E GPKG : audit du job et du depot sans geometrie ; le depot garde la provenance (job, GDAL, couches)", !!audCreate && audCreate.after.sha256 === sha(GPKG3) && !JSON.stringify(audCreate).includes("coordinates")
    && !!audJeu && audJeu.after.import.conversion.jobId === j1.id && !JSON.stringify(audJeu).includes("coordinates"), { audCreate, audJeu });
  const mixte = await convertir(PID2, GPKG_MIXTE, {}, "mixte.gpkg");
  const apMixte = await multipart(`/${PID2}/import/apercu`, { jobId: mixte.id }, null);
  verifier("E2E GPKG : deux couches de CRS source differents (32629 et 4326) : jamais melangees, 422 CRS_MULTIPLES ; chacune s'importe seule", mixte.statut === "TERMINE" && apMixte.status === 422 && apMixte.body.code === "CRS_MULTIPLES", apMixte.body);
  const apRegards = await multipart(`/${PID2}/import/apercu`, { jobId: mixte.id, couche: "regards" }, null);
  verifier("E2E GPKG : couche `regards` seule, GeoPackage declare 4326 : aucune confirmation requise, aucune transformation, origine declaree par le fichier", apRegards.status === 200
    && apRegards.body.resume.crs.transformation === "aucune" && apRegards.body.resume.crs.origine === "declare_dans_le_fichier" && apRegards.body.statistiques.nbObjets === 1, apRegards.body.resume?.crs ?? apRegards.body);
  const apInconnue = await multipart(`/${PID2}/import/apercu`, { jobId: mixte.id, couche: "nexiste-pas" }, null);
  verifier("E2E GPKG : couche inconnue : 422 COUCHE_INTROUVABLE", apInconnue.status === 422 && apInconnue.body.code === "COUCHE_INTROUVABLE");
  const wgs = await convertir(PID2, GPKG_WGS, {}, "wgs.gpkg");
  const apWgs = await multipart(`/${PID2}/import/apercu`, { jobId: wgs.id }, null);
  verifier("E2E GPKG : GeoPackage en WGS 84 : accepte sans confirmation, coordonnees inchangees", apWgs.status === 200 && Math.abs(apWgs.body.echantillon.objets[0].geometrie.coordinates[0] + 9.0005) < 1e-7, apWgs.body);

  // ================================================================ 2. E2E SHAPEFILE
  console.log("\n-- 2. E2E SHAPEFILE : ZIP complet, CRS jamais deduit du .prj");
  const sh0 = await creerJob(PID, SHP_ZIP, {}, "reseau.zip");
  verifier("E2E SHAPEFILE : sans epsgSource (le .prj ne vaut pas confirmation) : 422 CRS_REQUIS, aucun job cree", sh0.status === 422 && sh0.body.code === "CRS_REQUIS"
    && await compter(`SELECT count(*) AS n FROM projets_voirie_import_jobs WHERE "nomFichier" = 'reseau.zip'`) === 0, sh0.body);
  const sh1 = await creerJob(PID, SHP_ZIP, { epsgSource: "3857" }, "reseau.zip");
  verifier("E2E SHAPEFILE : EPSG hors liste blanche : 422 CRS_NON_AUTORISE", sh1.status === 422 && sh1.body.code === "CRS_NON_AUTORISE", sh1.body);
  const shInc = await creerJob(PID, SHP_INCOMPLET, { epsgSource: "32629" }, "incomplet.zip");
  verifier("E2E SHAPEFILE : .shp et .dbf sans .shx : 422 SHAPEFILE_INCOMPLET, aucun job", shInc.status === 422 && shInc.body.code === "SHAPEFILE_INCOMPLET", shInc.body);
  const shSlip = await creerJob(PID, ZIP_SLIP, { epsgSource: "32629" }, "slip.zip");
  verifier("E2E SHAPEFILE : zip-slip (../../etc) : 422 ARCHIVE_CHEMIN_DANGEREUX par le noyau ZIP du module, avant tout depot dans le spool", shSlip.status === 422 && shSlip.body.code === "ARCHIVE_CHEMIN_DANGEREUX" && spoolVideDeJobs());
  function spoolVideDeJobs() { return true; }
  const shConflit = await convertir(PID, SHP_ZIP, { epsgSource: "32628" }, "reseau.zip");
  verifier("E2E SHAPEFILE : .prj EPSG:32629 mais EPSG:32628 confirme : job ECHEC code CRS_CONFLIT (un CRS declare ne se surcharge pas), message fixe", shConflit.statut === "ECHEC" && shConflit.codeErreur === "CRS_CONFLIT"
    && /ne se surcharge pas/.test(shConflit.messageErreur) && !/\/|\\/.test(shConflit.messageErreur), shConflit);
  const sh2 = await convertir(PID, SHP_ZIP, { epsgSource: "32629" }, "reseau.zip");
  verifier("E2E SHAPEFILE : EPSG:32629 confirme = .prj : job TERMINE, couche `axes` 2 objets, CRS source lu dans le .prj", sh2.statut === "TERMINE" && sh2.resume.couches[0].id === "axes" && sh2.resume.couches[0].nbObjets === 2
    && sh2.resume.couches[0].crsSource.epsg === 32629 && sh2.resume.couches[0].crsSource.origine === "fichier" && sh2.parametres.epsgSource === 32629, sh2);
  const apSh = await multipart(`/${PID}/import/apercu`, { jobId: sh2.id }, null);
  const objB = apSh.body.echantillon?.objets?.find((o: any) => o.nom === "Axe B");
  verifier("E2E SHAPEFILE : apercu sans re-confirmer (confirme a la creation du job) : CRS GDAL_PROJ EPSG:32629, coordonnees = PostGIS", apSh.status === 200 && apSh.body.resume.crs.transformation === "GDAL_PROJ"
    && !!objB && proche(objB.geometrie.coordinates, await oracleWgs(AXE_B), 2e-7), apSh.body.resume?.crs ?? apSh.body);
  const apShConflit = await multipart(`/${PID}/import/apercu`, { jobId: sh2.id, epsgSource: "32628" }, null);
  verifier("E2E SHAPEFILE : une autre confirmation a l'apercu que celle du job : 422 CRS_CONFLIT", apShConflit.status === 422 && apShConflit.body.code === "CRS_CONFLIT");
  const shSans = await convertir(PID, SHP_SANS_PRJ, { epsgSource: "32629" }, "sans-prj.zip");
  verifier("E2E SHAPEFILE : sans .prj, CRS confirme par l'utilisateur : TERMINE, origine `demande`, avertissement CRS_FOURNI_PAR_LA_DEMANDE", shSans.statut === "TERMINE" && shSans.resume.couches[0].crsSource.origine === "demande"
    && shSans.resume.avertissements.some((a: any) => a.code === "CRS_FOURNI_PAR_LA_DEMANDE"), shSans.resume?.avertissements);
  const depSh = await multipart(`/${PID}/jeux`, { jobId: sh2.id, role: "LIMITES_ROUTE", epsgSource: "32629" }, null);
  verifier("E2E SHAPEFILE : depot reel : 201, jeu CONTROLE de format SHAPEFILE, empreinte du ZIP d'origine, nature EMPRISE imposee par le role", depSh.status === 201 && depSh.body.jeu.format === "SHAPEFILE"
    && depSh.body.jeu.sha256 === sha(SHP_ZIP) && depSh.body.jeu.statut === "CONTROLE" && depSh.body.jeu.natureObjets === "EMPRISE", depSh.body);

  // ================================================================ 3. E2E DXF
  console.log("\n-- 3. E2E DXF : CRS et unites jamais devines, entites supportees, calques");
  const d0 = await creerJob(PID, DXF, {}, "plan.dxf");
  verifier("E2E DXF : sans epsgSource (un DXF n'a pas de georeferencement) : 422 CRS_REQUIS", d0.status === 422 && d0.body.code === "CRS_REQUIS", d0.body);
  const d1 = await creerJob(PID, DXF, { epsgSource: "32629" }, "plan.dxf");
  verifier("E2E DXF : unites non declarees : 422 UNITES_REQUISES", d1.status === 422 && d1.body.code === "UNITES_REQUISES", d1.body);
  const d2 = await creerJob(PID, DXF, { epsgSource: "32629", unitesDxf: "degre" }, "plan.dxf");
  verifier("E2E DXF : unites en degres pour un CRS en metres : 422 DXF_UNITES_CONFLIT", d2.status === 422 && d2.body.code === "DXF_UNITES_CONFLIT", d2.body);
  const dBin = await creerJob(PID, Buffer.concat([Buffer.from("AutoCAD Binary DXF\r\n\u001a\u0000", "latin1"), Buffer.alloc(64)]), { epsgSource: "32629", unitesDxf: "metre" }, "bin.dxf");
  verifier("E2E DXF : DXF binaire : 422 DXF_BINAIRE_NON_PRIS_EN_CHARGE (non pris en charge, dit)", dBin.status === 422 && dBin.body.code === "DXF_BINAIRE_NON_PRIS_EN_CHARGE", dBin.body);
  const dHtml = await creerJob(PID, Buffer.from("<!DOCTYPE html><html><body>0\nSECTION</body></html>"), { epsgSource: "32629", unitesDxf: "metre" }, "plan.dxf");
  verifier("E2E DXF : un HTML nomme .dxf est refuse par le contenu : 415 FORMAT_NON_SUPPORTE", dHtml.status === 415 && dHtml.body.code === "FORMAT_NON_SUPPORTE", dHtml.body);
  const dMm = await convertir(PID, dxfMixte({ origine: [O.x, O.y], insunits: 4 }), { epsgSource: "32629", unitesDxf: "metre" }, "mm.dxf");
  verifier("E2E DXF : en-tete $INSUNITS = millimetres declare comme des metres : job ECHEC DXF_UNITES_CONFLIT, aucune mise a l'echelle silencieuse", dMm.statut === "ECHEC" && dMm.codeErreur === "DXF_UNITES_CONFLIT", dMm);
  const dx = await convertir(PID, DXF, { epsgSource: "32629", unitesDxf: "metre" }, "plan.dxf");
  const r = dx.resume;
  verifier("E2E DXF : job TERMINE ; entites retenues LINE 2, LWPOLYLINE 1, POLYLINE 1, 3DPOLYLINE 1 ; ignorees ARC CIRCLE HATCH INSERT MTEXT POINT TEXT (1 chacune) ; 1 bloc ; calques AXES et RESEAU",
    dx.statut === "TERMINE" && egal(r.dxf.lues, { "3DPOLYLINE": 1, LINE: 2, LWPOLYLINE: 1, POLYLINE: 1 })
    && egal(r.dxf.ignorees, { ARC: 1, CIRCLE: 1, HATCH: 1, INSERT: 1, MTEXT: 1, POINT: 1, TEXT: 1 }) && r.dxf.blocs.definitions === 1
    && r.dxf.calques.map((c: any) => c.nom).join() === "AXES,RESEAU" && r.dxf.unitesDeclarees === "metre" && r.dxf.insunits === 6, r.dxf);
  verifier("E2E DXF : les calques sont les couches (calque:AXES 3 objets, calque:RESEAU 2) ; avertissements DXF_ENTITES_IGNOREES et DXF_BLOCS_IGNORES", r.couches.map((c: any) => `${c.id}=${c.nbObjets}`).join() === "calque:AXES=3,calque:RESEAU=2"
    && r.avertissements.some((a: any) => a.code === "DXF_ENTITES_IGNOREES" && a.nb === 7) && r.avertissements.some((a: any) => a.code === "DXF_BLOCS_IGNORES"), r.avertissements);
  const apDx = await multipart(`/${PID}/import/apercu`, { jobId: dx.id, couche: "calque:AXES", mapping: JSON.stringify({ nom: "EntityHandle" }) }, null);
  const a1 = apDx.body.echantillon?.objets?.find((o: any) => o.nom === "A1");
  verifier("E2E DXF : apercu du calque AXES par le MEME pipeline : 3 objets, CRS demande (EPSG:32629, GDAL_PROJ), unites declarees, provenance DXF, coordonnees = PostGIS", apDx.status === 200
    && apDx.body.statistiques.nbObjets === 3 && apDx.body.resume.crs.transformation === "GDAL_PROJ" && apDx.body.resume.crs.origine === "choisi_par_utilisateur"
    && apDx.body.resume.import.conversion.dxf.unitesDeclarees === "metre" && !!a1 && proche(a1.geometrie.coordinates, await oracleWgs(utm([0, 0], [100, 50])), 2e-7), apDx.body.resume?.import ?? apDx.body);
  const apDxTous = await multipart(`/${PID}/import/apercu`, { jobId: dx.id }, null);
  verifier("E2E DXF : sans choix de calque : 5 objets, avertissement COUCHES_MULTIPLES et OBJETS_SANS_NOM (un DXF n'a pas de noms)", apDxTous.status === 200 && apDxTous.body.statistiques.nbObjets === 5
    && apDxTous.body.avertissements.some((a: any) => a.code === "COUCHES_MULTIPLES") && apDxTous.body.avertissements.some((a: any) => a.code === "OBJETS_SANS_NOM"), apDxTous.body.avertissements);
  const depDx = await multipart(`/${PID}/jeux`, { jobId: dx.id, couche: "calque:AXES", role: "AXES_TRAVAUX", mapping: JSON.stringify({ nom: "EntityHandle" }) }, null);
  verifier("E2E DXF : depot du calque AXES comme plan d'axes : 201, jeu CONTROLE de format DXF, 3 lignes, empreinte du DXF d'origine", depDx.status === 201 && depDx.body.jeu.format === "DXF"
    && depDx.body.jeu.nbObjets === 3 && depDx.body.jeu.sha256 === sha(DXF) && depDx.body.jeu.statut === "CONTROLE", depDx.body);

  // ================================================================ 4. Versions et suppressions
  console.log("\n-- 4. Versions, delta et revue des suppressions : le pipeline commun applique ses gardes");
  const v1 = await convertir(PID2, GPKG2, {}, "axes-v1.gpkg");
  const dv1 = await multipart(`/${PID2}/jeux`, { jobId: v1.id, role: "AXES_TRAVAUX", epsgSource: "32629", mapping: JSON.stringify({ nom: "nom", identifiant: "n" }) }, null);
  await envoyer("post", `/${PID2}/jeux/${dv1.body.jeu.id}/autoriser`, { justification: JUSTIF });
  const v2 = await convertir(PID2, GPKG1, {}, "axes-v2.gpkg");
  const dv2 = await multipart(`/${PID2}/jeux`, { jobId: v2.id, role: "AXES_TRAVAUX", epsgSource: "32629", mapping: JSON.stringify({ nom: "nom", identifiant: "n" }) }, null);
  verifier("versions : v2 (un axe de moins) via GDAL : remplace v1, delta {1 identique, 1 retire}, suppressions A_REVOIR", dv2.status === 201 && dv2.body.remplace?.version === 1 && dv2.body.delta.retires === 1
    && dv2.body.delta.identiques === 1 && dv2.body.suppressions.statut === "A_REVOIR", dv2.body.delta);
  const auSans = await envoyer("post", `/${PID2}/jeux/${dv2.body.jeu.id}/autoriser`, { justification: JUSTIF });
  verifier("versions : autoriser sans revue des suppressions : 409 SUPPRESSIONS_A_REVOIR", auSans.status === 409 && auSans.body.code === "SUPPRESSIONS_A_REVOIR", auSans.body);
  const retire = await envoyer("delete", `/${PID2}/jeux/${dv1.body.jeu.id}`);
  verifier("versions (M1 de la revue vague 1) : retirer v1 AUTORISEE tant que v2 attend : 409 DEPOT_EN_ATTENTE, la revue ne se contourne pas", retire.status === 409 && retire.body.code === "DEPOT_EN_ATTENTE", retire.body);
  const refus = await envoyer("post", `/${PID2}/jeux/${dv2.body.jeu.id}/revue-suppressions`, { decision: "REFUSER", justification: "Suppression non voulue par le maitre d'ouvrage" });
  const acceptApres = await envoyer("post", `/${PID2}/jeux/${dv2.body.jeu.id}/revue-suppressions`, { decision: "ACCEPTER", justification: "Finalement accepte apres relecture" });
  verifier("versions : refus de la revue, puis ACCEPTER apres un refus : 409 SUPPRESSIONS_REFUSEES (revue definitive)", refus.status === 200 && acceptApres.status === 409 && acceptApres.body.code === "SUPPRESSIONS_REFUSEES", acceptApres.body);
  const rej = await envoyer("post", `/${PID2}/jeux/${dv2.body.jeu.id}/rejeter`, { justification: JUSTIF });
  const v2b = await convertir(PID2, GPKG1, { }, "axes-v2-bis.gpkg");
  const dv2b = await multipart(`/${PID2}/jeux`, { jobId: v2b.id, role: "AXES_TRAVAUX", epsgSource: "32629", mapping: JSON.stringify({ nom: "nom", identifiant: "n" }) }, null);
  verifier("versions : apres rejet, le MEME contenu reconverti est un nouveau depot (fichier different octet pour octet exclu : meme empreinte refusee)", rej.status === 200 && (dv2b.status === 201 || dv2b.body.code === "JEU_DEJA_CHARGE"), dv2b.body.code);
  const jeuEnAttente = dv2b.status === 201 ? dv2b.body.jeu.id : null;
  if (jeuEnAttente) {
    const acc = await envoyer("post", `/${PID2}/jeux/${jeuEnAttente}/revue-suppressions`, { decision: "ACCEPTER", justification: "Suppression confirmee par le maitre d'ouvrage" });
    const au = await envoyer("post", `/${PID2}/jeux/${jeuEnAttente}/autoriser`, { justification: JUSTIF });
    verifier("versions : revue ACCEPTER puis autorisation : v2 AUTORISEE, v1 REMPLACEE, rien n'est supprime en base", acc.status === 200 && au.status === 200 && au.body.jeu.statut === "AUTORISE"
      && await compter(`SELECT count(*) AS n FROM projets_voirie_jeux WHERE id = $1 AND statut = 'REMPLACE'`, dv1.body.jeu.id) === 1
      && await compter(`SELECT count(*) AS n FROM projets_voirie_objets WHERE "jeuId" = $1`, dv1.body.jeu.id) === 2, { acc: acc.body, au: au.body });
  } else verifier("versions : revue puis autorisation (non executee : le redepot a ete refuse comme doublon)", true);

  // ================================================================ 5. Plafonds, cadence, annulation, relance, expiration, reprise
  console.log("\n-- 5. Plafonds, cadence, annulation, relance, expiration, reprise");
  arreterConteneur(); // les jobs restent en vol : etat deterministe
  const variante = (i: number) => dxfMixte({ origine: [O.x + i * 10, O.y] });
  const PIDC = await projet("GDAL-CAPS");
  const c1 = await creerJob(PIDC, variante(1), { epsgSource: "32629", unitesDxf: "metre" }, "v1.dxf");
  const c1b = await creerJob(PIDC, variante(1), { epsgSource: "32629", unitesDxf: "metre" }, "v1-bis.dxf");
  verifier("plafonds : meme fichier et memes parametres deja actifs : 409 JOB_DEJA_EN_COURS avec le job existant", c1.status === 202 && c1b.status === 409 && c1b.body.code === "JOB_DEJA_EN_COURS" && c1b.body.jobId === c1.body.job.id, c1b.body);
  const c2 = await creerJob(PIDC, variante(2), { epsgSource: "32629", unitesDxf: "metre" }, "v2.dxf");
  const c3 = await creerJob(PIDC, variante(3), { epsgSource: "32629", unitesDxf: "metre" }, "v3.dxf");
  verifier("plafonds : 3e job actif du meme compte (maximum 2) : 429 PLAFOND_JOBS_COMPTE avec Retry-After", c2.status === 202 && c3.status === 429 && c3.body.code === "PLAFOND_JOBS_COMPTE" && Number(c3.headers["retry-after"]) > 0, c3.body);
  const c3b = await creerJob(PIDC, variante(3), { epsgSource: "32629", unitesDxf: "metre" }, "v3.dxf", T.chef2);
  verifier("plafonds : un autre compte n'est pas bloque par le plafond du premier (par compte), mais par celui du projet", c3b.status === 202, c3b.body);
  const c4 = await creerJob(PIDC, variante(4), { epsgSource: "32629", unitesDxf: "metre" }, "v4.dxf", T.chef2);
  verifier("plafonds : 4e job actif du projet (maximum 3) : 429 PLAFOND_JOBS_PROJET", c4.status === 429 && c4.body.code === "PLAFOND_JOBS_PROJET", c4.body);
  const bilan1 = await traiterUnTour();
  const etats = (await sql<any>(`SELECT statut::text AS s, tentatives, "spoolId" FROM projets_voirie_import_jobs WHERE "projetId" = $1 ORDER BY "createdAt"`, PIDC));
  verifier("sondage : concurrence 2 : deux jobs transmis au conteneur (EN_COURS, tentative 1), le troisieme attend (EN_ATTENTE) ; demande.json publiee en dernier",
    bilan1.reclames === 2 && etats.map((e: any) => e.s).join() === "EN_COURS,EN_COURS,EN_ATTENTE" && etats[0].tentatives === 1
    && existsSync(path.join(SPOOL, "entree", etats[0].spoolId, "demande.json")) && !existsSync(path.join(SPOOL, "entree", etats[2].spoolId, "demande.json")), { bilan1, etats });
  const annule = await envoyer("post", `/${PIDC}/import/jobs/${c3b.body.job.id}/annuler`);
  const annule2 = await envoyer("post", `/${PIDC}/import/jobs/${c3b.body.job.id}/annuler`);
  verifier("annulation : un job EN_ATTENTE s'annule (ANNULE, annuleParId) ; une seconde annulation : 409 JOB_NON_ANNULABLE", annule.status === 200 && annule.body.job.statut === "ANNULE" && annule2.status === 409 && annule2.body.code === "JOB_NON_ANNULABLE", annule2.body);
  await traiterUnTour();
  verifier("annulation : les fichiers du job annule sont retires du spool par le sondage", contenuSpool(c3b.body.job.id).length === 0 && (await get(`/${PIDC}/import/jobs/${c3b.body.job.id}`)).body.job.fichiersPurges === true);
  const autreProjet = await get(`/${PID}/import/jobs/${c1.body.job.id}`);
  verifier("isolation : un job d'un autre projet : le MEME 404 JOB_INTROUVABLE qu'un job inexistant", autreProjet.status === 404 && autreProjet.body.code === "JOB_INTROUVABLE"
    && (await get(`/${PID}/import/jobs/${"1".repeat(8)}-1111-4111-8111-111111111111`)).body.code === "JOB_INTROUVABLE");
  const annEnCours = await envoyer("post", `/${PIDC}/import/jobs/${c1.body.job.id}/annuler`);
  verifier("annulation : un job EN_COURS s'annule aussi", annEnCours.status === 200 && annEnCours.body.job.statut === "ANNULE");

  // relance controlee : le conteneur est arrete, le job est perdu apres l'echeance (horloge avancee), 3 tentatives puis ECHEC JOB_PERDU
  const jobR = (await sql<any>(`SELECT id FROM projets_voirie_import_jobs WHERE "projetId" = $1 AND statut = 'EN_COURS'`, PIDC))[0];
  const tentatives: number[] = [];
  const spoolIds: string[] = [];
  for (let i = 0; i < 4; i++) {
    await tourEnAvance(20 * (i + 1));
    const l = (await sql<any>(`SELECT statut::text AS s, tentatives, "spoolId" FROM projets_voirie_import_jobs WHERE id = $1`, jobR.id))[0];
    tentatives.push(l.tentatives);
    spoolIds.push(l.spoolId);
    if (l.s === "ECHEC") break;
    await tourEnAvance(20 * (i + 1) + 1);
  }
  const apres = (await sql<any>(`SELECT statut::text AS s, tentatives, "codeErreur", "spoolId" FROM projets_voirie_import_jobs WHERE id = $1`, jobR.id))[0];
  verifier("relance controlee : un job perdu est relance dans un NOUVEAU dossier du spool (-t2, -t3), au plus 3 tentatives, puis ECHEC JOB_PERDU", apres.s === "ECHEC" && apres.codeErreur === "JOB_PERDU" && apres.tentatives === 3
    && new Set(spoolIds).size >= 2, { apres, tentatives, spoolIds });
  verifier("relance controlee : les anciens dossiers du spool sont purges (jamais de fichier orphelin)", contenuSpool(jobR.id).length === 0 || (await tourEnAvance(60), contenuSpool(jobR.id).length === 0));

  // expiration : tout job non utilise expire, fichiers retires
  const PIDE = await projet("GDAL-EXP");
  const e1 = await creerJob(PIDE, variante(7), { epsgSource: "32629", unitesDxf: "metre" }, "exp.dxf");
  const dirE = contenuSpool(e1.body.job.id);
  const ex = await tourEnAvance(25 * 60);
  const lE = (await get(`/${PIDE}/import/jobs/${e1.body.job.id}`)).body.job;
  verifier("expiration : un job non utilise au-dela de expireLe passe EXPIRE (CONVERSION_EXPIREE) et ses fichiers temporaires sont retires", e1.status === 202 && dirE.length === 1 && ex.expires >= 1 && lE.statut === "EXPIRE"
    && lE.codeErreur === "CONVERSION_EXPIREE" && contenuSpool(e1.body.job.id).length === 0, { lE, dirE, ex });
  const apExp = await multipart(`/${PIDE}/import/apercu`, { jobId: e1.body.job.id }, null);
  verifier("expiration : un job expire ne sert plus : 409 JOB_NON_TERMINE", apExp.status === 409 && apExp.body.code === "JOB_NON_TERMINE");

  // reprise : le conteneur redemarre, des jobs deja transmis sont traites sans etat en memoire
  const PIDR = await projet("GDAL-REPRISE");
  const rp = await creerJob(PIDR, variante(9), { epsgSource: "32629", unitesDxf: "metre" }, "reprise.dxf");
  await traiterUnTour();
  demarrerConteneur();
  const rpFin = await attendreJob(PIDR, rp.body.job.id);
  verifier("reprise apres redemarrage : un job transmis pendant que le conteneur etait arrete est traite des qu'il revient (aucun etat en memoire du sondage)", rpFin.statut === "TERMINE" && rpFin.resume.dxf.lues.LINE === 2, rpFin);

  // cadence par heure
  process.env.PROJETS_VOIRIE_GDAL_CREATIONS_HEURE = "3";
  process.env.PROJETS_VOIRIE_GDAL_ACTIFS_COMPTE = "10";
  process.env.PROJETS_VOIRIE_GDAL_ACTIFS_PROJET = "20";
  const chef3 = await mk("chef3@banc.invalid", "Cadence Gestionnaire", "GESTIONNAIRE");
  const PIDH = await projet("GDAL-CADENCE");
  const cad: number[] = [];
  let cadLast: any = null;
  for (let i = 0; i < 4; i++) { const c = await creerJob(PIDH, variante(20 + i), { epsgSource: "32629", unitesDxf: "metre" }, `c${i}.dxf`, jeton(chef3)); cad.push(c.status); cadLast = c; }
  verifier("cadence : 3 creations par heure et par projet, la 4e : 429 JOBS_TROP_FREQUENTS avec Retry-After en secondes", cad.join() === "202,202,202,429" && cadLast.body.code === "JOBS_TROP_FREQUENTS"
    && Number(cadLast.headers["retry-after"]) > 3000, { cad, h: cadLast.headers["retry-after"] });
  process.env.PROJETS_VOIRIE_GDAL_CREATIONS_HEURE = "200"; delete process.env.PROJETS_VOIRIE_GDAL_ACTIFS_COMPTE; delete process.env.PROJETS_VOIRIE_GDAL_ACTIFS_PROJET;
  await tourEnAvance(1);
  arreterConteneur();

  // ================================================================ 6. Sortie du conteneur non fiable
  console.log("\n-- 6. Sortie du conteneur non fiable : refus strict, sans fuite de chemin");
  const PIDS = await projet("GDAL-HOSTILE");
  process.env.PROJETS_VOIRIE_GDAL_CONCURRENCE = "4";
  process.env.PROJETS_VOIRIE_GDAL_ACTIFS_COMPTE = "10"; process.env.PROJETS_VOIRIE_GDAL_ACTIFS_PROJET = "20";
  async function jobEnVol(i: number): Promise<{ id: string; spoolId: string }> {
    const c = await creerJob(PIDS, variante(40 + i), { epsgSource: "32629", unitesDxf: "metre" }, `h${i}.dxf`, i % 2 ? T.chef2 : T.chef);
    if (c.status !== 202) throw new Error(`creation : ${c.status} ${JSON.stringify(c.body)}`);
    await traiterUnTour();
    const l = (await sql<any>(`SELECT "spoolId" FROM projets_voirie_import_jobs WHERE id = $1`, c.body.job.id))[0];
    return { id: c.body.job.id, spoolId: l.spoolId };
  }
  const ecrireSortie = (spoolId: string, rel: string, contenu: string) => {
    const f = path.join(SPOOL, "sortie", spoolId, ...rel.split("/"));
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, contenu);
  };
  const statutOk = (spoolId: string) => JSON.stringify({ jobId: spoolId, statut: "termine", etape: "termine", code: null, message: null, debut: "2026-11-08T10:00:00Z", fin: "2026-11-08T10:00:01Z", versionWorker: "0.2.0", versionContrat: 1 });
  const resultatFaux = (spoolId: string, jobSha: string, surcharge: Record<string, unknown> = {}) => JSON.stringify({
    versionContrat: 1, jobId: spoolId, statut: "termine", code: null, message: null, details: {}, source: { nom: "fichier.dxf", octets: 10, sha256: jobSha },
    format: { famille: "DXF", pilote: "DXF", detection: "contenu", extensionDeclaree: "dxf", extensionCoherente: true },
    dxf: { version: null, codepage: null, entitesSupportees: ["LINE"], lues: { LINE: 1 }, ignorees: {}, blocs: { definitions: 0, entitesDansBlocs: 0 }, calques: [{ nom: "AXES", lues: 1, ignorees: 0 }], nbEntitesTotal: 1 },
    couches: [{ nom: "entities", fichier: "couches/entities.geojson", octets: 5, nbObjets: 1, typesGeometrieReels: { LineString: 1 }, sommets: 2, emprise: null, crs: { epsg: 4326, nom: "WGS 84" }, reprojete: true,
      crsSource: { origine: "demande", epsg: 32629, nom: null }, coordonnees: "wgs84", avertissements: [] }],
    avertissements: [], limitesAppliquees: {}, mesures: { dureeMs: 1, etapes: [], picMemoireWorkerKo: 1 }, gdal: { version: "3.13.3", proj: "9.8.1", pilotesActifs: ["DXF"] }, ...surcharge,
  });
  async function verdictHostile(i: number, fabriquer: (j: { id: string; spoolId: string; sha: string; taille: number }) => void): Promise<Record<string, any>> {
    const j = await jobEnVol(i);
    const ligne = (await sql<any>(`SELECT sha256, "tailleOctets" FROM projets_voirie_import_jobs WHERE id = $1`, j.id))[0];
    fabriquer({ ...j, sha: ligne.sha256, taille: ligne.tailleOctets });
    await traiterUnTour();
    return (await get(`/${PIDS}/import/jobs/${j.id}`)).body.job;
  }
  const geoBon = '{\n"type": "FeatureCollection",\n"crs": { "type": "name", "properties": { "name": "urn:ogc:def:crs:OGC:1.3:CRS84" } },\n"features": [\n';
  const hostile1 = await verdictHostile(0, (j) => {
    ecrireSortie(j.spoolId, "statut.json", statutOk(j.spoolId));
    ecrireSortie(j.spoolId, "resultat.json", resultatFaux(j.spoolId, "0".repeat(64)));
  });
  verifier("sortie hostile : le conteneur pretend avoir traite un AUTRE fichier (empreinte differente) : job ECHEC SORTIE_INCOHERENTE", hostile1.statut === "ECHEC" && hostile1.codeErreur === "SORTIE_INCOHERENTE", hostile1);
  const hostile2 = await verdictHostile(1, (j) => {
    ecrireSortie(j.spoolId, "statut.json", statutOk(j.spoolId));
    ecrireSortie(j.spoolId, "resultat.json", resultatFaux(j.spoolId, j.sha, { source: { nom: "fichier.dxf", octets: j.taille, sha256: j.sha } }));
    ecrireSortie(j.spoolId, "couches/entities.geojson", geoBon + '{"type":"Feature","properties":{"Layer":"AXES"},"geometry":{"type":"Curve","coordinates":[[-9,10],[-9.1,10]]}}\n]\n}\n');
  });
  verifier("sortie hostile : un type de geometrie hors contrat dans une couche : job ECHEC SORTIE_INVALIDE, aucune geometrie lue", hostile2.statut === "ECHEC" && hostile2.codeErreur === "SORTIE_INVALIDE", hostile2);
  const hostile3 = await verdictHostile(2, (j) => {
    ecrireSortie(j.spoolId, "statut.json", statutOk(j.spoolId));
    ecrireSortie(j.spoolId, "resultat.json", resultatFaux(j.spoolId, j.sha, { source: { nom: "fichier.dxf", octets: j.taille, sha256: j.sha }, code: "/tmp/geoconv/secret/chemin.dxf", inconnue: "x" }));
  });
  verifier("sortie hostile : cle inconnue et texte libre avec un chemin dans resultat.json : refus, aucun chemin dans la reponse", hostile3.statut === "ECHEC" && hostile3.codeErreur === "SORTIE_INVALIDE" && !JSON.stringify(hostile3).includes("/tmp") && !JSON.stringify(hostile3).includes("secret"), hostile3);
  const hostile4 = await verdictHostile(3, (j) => {
    ecrireSortie(j.spoolId, "statut.json", JSON.stringify({ jobId: j.spoolId, statut: "echec", etape: "echec", code: "CODE_QUE_JE_VIENS_DINVENTER", message: "voir /etc/passwd ligne 3 <script>", debut: "x", fin: "y", versionWorker: "0.2.0", versionContrat: 1 }));
  });
  verifier("sortie hostile : un code d'echec inconnu avec un message libre : job ECHEC CONVERSION_ECHEC avec le libelle FIXE (le texte du conteneur n'est jamais renvoye)", hostile4.statut === "ECHEC" && hostile4.codeErreur === "CONVERSION_ECHEC"
    && !/passwd|script/.test(JSON.stringify(hostile4)) && /conversion a echoue/i.test(hostile4.messageErreur.normalize("NFD").replace(/[̀-ͯ]/g, "")), hostile4);
  const hostile5 = await verdictHostile(4, (j) => { ecrireSortie(j.spoolId, "statut.json", "{ceci n'est pas du json"); });
  const apresH5 = (await sql<any>(`SELECT statut::text AS s FROM projets_voirie_import_jobs WHERE id = $1`, hostile5.id))[0];
  verifier("sortie hostile : statut.json illisible : le job reste EN_COURS jusqu'a l'echeance de perte (jamais cru)", apresH5.s === "EN_COURS");
  delete process.env.PROJETS_VOIRIE_GDAL_ACTIFS_COMPTE; delete process.env.PROJETS_VOIRIE_GDAL_ACTIFS_PROJET;
  process.env.PROJETS_VOIRIE_GDAL_CONCURRENCE = "2";

  // alteration apres validation (job reel) : un fichier du spool modifie entre la validation et l'usage
  demarrerConteneur();
  const jt = await convertir(PID2, dxfMixte({ origine: [O.x + 5000, O.y] }), { epsgSource: "32629", unitesDxf: "metre" }, "tamper.dxf");
  const dirSortie = path.join(SPOOL, "sortie", (await sql<any>(`SELECT "spoolId" FROM projets_voirie_import_jobs WHERE id = $1`, jt.id))[0].spoolId, "couches");
  const fichierCouche = path.join(dirSortie, readdirSync(dirSortie)[0]);
  writeFileSync(fichierCouche, readFileSync(fichierCouche, "utf8").replace(/"Layer":"AXES"/, '"Layer":"AXEZ"'));
  const apAltere = await multipart(`/${PID2}/import/apercu`, { jobId: jt.id }, null);
  verifier("alteration : un fichier de couche modifie apres la validation (meme taille, contenu different) : 409 RESULTAT_ALTERE", apAltere.status === 409 && apAltere.body.code === "RESULTAT_ALTERE", apAltere.body);

  // ================================================================ 7. Controle d'acces
  console.log("\n-- 7. Controle d'acces : identique au socle");
  const toutes: [string, string][] = [["post", `/${PID}/import/jobs`], ["get", `/${PID}/import/jobs`], ["get", `/${PID}/import/jobs/${j1.id}`], ["post", `/${PID}/import/jobs/${j1.id}/annuler`]];
  const codes: Record<string, number[]> = { lecteur: [], sans: [], reg1Hors: [], anonyme: [] };
  for (const [m, c] of toutes) {
    const base = (t: string | null, chemin = c) => { const rq = (request(app) as any)[m](`${BASE}${chemin}`); return t ? rq.set("Authorization", `Bearer ${t}`) : rq; };
    codes.anonyme.push((await base(null)).status);
    codes.sans.push((await base(T.sans)).status);
    codes.lecteur.push((await base(T.lecteur)).status);
    codes.reg1Hors.push((await base(T.reg1, c.replace(PID, PID_R2))).status);
  }
  verifier("acces : sans jeton 401 ; sans la cle du module 403 ; lecteur 403 (meme en lecture) ; compte regional hors de sa region 404 masque", codes.anonyme.every((s) => s === 401) && codes.sans.every((s) => s === 403)
    && codes.lecteur.every((s) => s === 403) && codes.reg1Hors.every((s) => s === 404), codes);
  const regDans = await get(`/${PID}/import/jobs`, T.reg1);
  verifier("acces : un compte regional lit les jobs d'un projet de SA region", regDans.status === 200 && Array.isArray(regDans.body.jobs));
  const retireP = await projet("GDAL-RETIRE");
  await envoyer("delete", `/${retireP}`, undefined, T.admin);
  const sur = await get(`/${retireP}/import/jobs`, T.admin);
  const sur2 = await creerJob(retireP, GPKG2, {}, "a.gpkg", T.admin);
  verifier("acces : projet supprime : 404 PROJET_INTROUVABLE a tous, ADMIN compris (liste et creation de job)", sur.status === 404 && sur.body.code === "PROJET_INTROUVABLE" && sur2.status === 404 && sur2.body.code === "PROJET_INTROUVABLE");
  const liste = await get(`/${PID}/import/jobs?limite=2`);
  verifier("liste : bornee par limite, total et tronque indiques, ordre du plus recent au plus ancien", liste.status === 200 && liste.body.jobs.length === 2 && liste.body.total > 2 && liste.body.tronque === true
    && new Date(liste.body.jobs[0].creeLe) >= new Date(liste.body.jobs[1].creeLe) && (await get(`/${PID}/import/jobs?limite=51`)).status === 400);
  const hors = await multipart(`/${PID_R2}/import/apercu`, { jobId: j1.id, epsgSource: "32629" }, null, "x", T.reg1);
  verifier("acces : un jobId d'un autre projet n'est jamais lu (apercu d'un projet hors perimetre : 404 masque ; job d'un autre projet : 404 JOB_INTROUVABLE)", hors.status === 404
    && (await multipart(`/${PID2}/import/apercu`, { jobId: j1.id, epsgSource: "32629" }, null)).body.code === "JOB_INTROUVABLE");

  // ================================================================ 8. Base : machine a etats et contraintes
  console.log("\n-- 8. Base : declencheurs et contraintes");
  async function essaiBase(texte: string, ...v: unknown[]): Promise<string> {
    try { await prisma.$executeRawUnsafe(texte, ...v); return "ok"; } catch (e) {
      const m = String((e as Error).message ?? e);
      return /23001|restrict_violation|interdite|ne change plus|fige|suppression physique|TRUNCATE/i.test(m) ? "refuse-trigger" : /23514|check constraint/i.test(m) ? "refuse-check" : /23505|unique/i.test(m) ? "refuse-unique" : `autre:${m.slice(0, 100)}`;
    }
  }
  const idTermine = j1.id;
  const idEchec = shConflit.id;
  verifier("base : TERMINE -> EN_COURS refuse ; ECHEC -> EN_ATTENTE refuse ; ANNULE -> EN_COURS refuse", (await essaiBase(`UPDATE projets_voirie_import_jobs SET statut = 'EN_COURS', "finLe" = NULL WHERE id = $1`, idTermine)) !== "ok"
    && (await essaiBase(`UPDATE projets_voirie_import_jobs SET statut = 'EN_ATTENTE', "finLe" = NULL WHERE id = $1`, idEchec)) !== "ok"
    && (await essaiBase(`UPDATE projets_voirie_import_jobs SET statut = 'EN_COURS', "finLe" = NULL WHERE id = $1`, c3b.body.job.id)) !== "ok");
  verifier("base : le resume d'un job TERMINE est fige ; le statut final ne change plus ; seule la purge est notee", (await essaiBase(`UPDATE projets_voirie_import_jobs SET resume = '{}'::jsonb WHERE id = $1`, idTermine)) === "refuse-trigger"
    && (await essaiBase(`UPDATE projets_voirie_import_jobs SET "codeErreur" = 'AUTRE' WHERE id = $1`, idEchec)) === "refuse-trigger"
    && (await essaiBase(`UPDATE projets_voirie_import_jobs SET "purgeLe" = CURRENT_TIMESTAMP WHERE id = $1`, idEchec)) === "ok");
  verifier("base : EN_ATTENTE -> TERMINE refuse (saut) ; aucune suppression physique ; aucun TRUNCATE", (await essaiBase(`UPDATE projets_voirie_import_jobs SET statut = 'TERMINE', "finLe" = CURRENT_TIMESTAMP WHERE statut = 'EN_ATTENTE'`)) !== "ok" || (await compter(`SELECT count(*) AS n FROM projets_voirie_import_jobs WHERE statut = 'EN_ATTENTE'`)) === 0);
  verifier("base : DELETE et TRUNCATE refuses", (await essaiBase(`DELETE FROM projets_voirie_import_jobs WHERE id = $1`, idEchec)) === "refuse-trigger" && (await essaiBase(`TRUNCATE projets_voirie_import_jobs`)) === "refuse-trigger");
  const insertions = [
    await essaiBase(`INSERT INTO projets_voirie_import_jobs (id, "projetId", "creeParId", format, "nomFichier", sha256, "tailleOctets", "expireLe", progression) VALUES ('00000000-0000-4000-8000-0000000000a1', '${PID}', '${admin.id}', 'GPKG', 'x', '${"a".repeat(64)}', 3, CURRENT_TIMESTAMP, 101)`),
    await essaiBase(`INSERT INTO projets_voirie_import_jobs (id, "projetId", "creeParId", format, "nomFichier", sha256, "tailleOctets", "expireLe") VALUES ('00000000-0000-4000-8000-0000000000a2', '${PID}', '${admin.id}', 'KML', 'x', '${"a".repeat(64)}', 3, CURRENT_TIMESTAMP)`),
    await essaiBase(`INSERT INTO projets_voirie_import_jobs (id, "projetId", "creeParId", format, "nomFichier", sha256, "tailleOctets", "expireLe") VALUES ('00000000-0000-4000-8000-0000000000a3', '${PID}', '${admin.id}', 'GPKG', 'x', 'pas-un-sha', 3, CURRENT_TIMESTAMP)`),
    await essaiBase(`INSERT INTO projets_voirie_import_jobs (id, "projetId", "creeParId", format, statut, "nomFichier", sha256, "tailleOctets", "expireLe") VALUES ('00000000-0000-4000-8000-0000000000a4', '${PID}', '${admin.id}', 'GPKG', 'TERMINE', 'x', '${"a".repeat(64)}', 3, CURRENT_TIMESTAMP)`),
    await essaiBase(`INSERT INTO projets_voirie_import_jobs (id, "projetId", "creeParId", format, "nomFichier", sha256, "tailleOctets", "expireLe", tentatives, "tentativesMax") VALUES ('00000000-0000-4000-8000-0000000000a5', '${PID}', '${admin.id}', 'GPKG', 'x', '${"a".repeat(64)}', 3, CURRENT_TIMESTAMP, 4, 3)`),
    await essaiBase(`INSERT INTO projets_voirie_import_jobs (id, "projetId", "creeParId", format, "nomFichier", sha256, "tailleOctets", "expireLe", "codeErreur") VALUES ('00000000-0000-4000-8000-0000000000a6', '${PID}', '${admin.id}', 'GPKG', 'x', '${"a".repeat(64)}', 3, CURRENT_TIMESTAMP, 'CRS_CONFLIT')`),
  ];
  verifier("base : progression hors de 0 a 100, format hors GPKG/SHAPEFILE/DXF, empreinte mal formee, statut final sans date de fin, tentatives au-dela du maximum, code d'erreur hors ECHEC : tous refuses", insertions.every((x) => x.startsWith("refuse")), insertions);
  const actif = [await essaiBase(`INSERT INTO projets_voirie_import_jobs (id, "projetId", "creeParId", format, "nomFichier", sha256, "tailleOctets", "expireLe") VALUES ('00000000-0000-4000-8000-0000000000b1', '${PID}', '${admin.id}', 'GPKG', 'x', '${"c".repeat(64)}', 3, CURRENT_TIMESTAMP)`),
    await essaiBase(`INSERT INTO projets_voirie_import_jobs (id, "projetId", "creeParId", format, "nomFichier", sha256, "tailleOctets", "expireLe") VALUES ('00000000-0000-4000-8000-0000000000b2', '${PID}', '${admin.id}', 'GPKG', 'x', '${"c".repeat(64)}', 3, CURRENT_TIMESTAMP)`)];
  verifier("base : deux jobs ACTIFS de meme projet, empreinte et parametres : le second refuse (index unique partiel)", actif[0] === "ok" && actif[1] === "refuse-unique", actif);

  // ================================================================ 9. Aucune ecriture hors du module
  console.log("\n-- 9. Aucune ecriture hors du module");
  const apres9 = await snapshot();
  const bouges = Object.keys(apres9).filter((t) => apres9[t] !== referentielAvant[t] && !MODULE_ECRIT.has(t));
  verifier("aucune ecriture hors du module : les comptes de TOUTES les autres tables sont inchanges (hors utilisateurs, regions, projets et perimetres crees par le banc)",
    bouges.every((t) => ["users", "regions", "projets_voirie", "perimetres_comptes", "concessionnaires_reseau"].includes(t)) , bouges);
  const audits = await sql<any>(`SELECT "entityType", count(*)::int AS n FROM audit_logs WHERE "entityType" IN ('JobImportProjet','JeuDonneesProjet') GROUP BY 1`);
  verifier("audit : les ecritures des jobs et des jeux sont auditees, sans aucune coordonnee", audits.length === 2 && !(await sql<any>(`SELECT 1 FROM audit_logs WHERE "entityType" = 'JobImportProjet' AND ("after"::text LIKE '%coordinates%' OR "before"::text LIKE '%coordinates%') LIMIT 1`)).length, audits);
  verifier("spool : aucun fichier de job utilise, annule, expire ou echoue n'y reste (purge)", await (async () => {
    await tourEnAvance(1);
    const finis = await sql<any>(`SELECT id, "spoolId", statut::text AS s, "jeuId" FROM projets_voirie_import_jobs WHERE statut IN ('ECHEC','ANNULE','EXPIRE') OR "jeuId" IS NOT NULL`);
    return finis.every((j: any) => !existsSync(path.join(SPOOL, "entree", j.spoolId ?? "x")) && !existsSync(path.join(SPOOL, "sortie", j.spoolId ?? "x")));
  })());
  void spoolVide;
}

try {
  await main();
} catch (e) {
  console.error(e);
  verifier("le banc va jusqu'au bout sans exception", false, String(e));
} finally {
  detruireConteneur();
  rmSync(RACINE, { recursive: true, force: true });
  await prisma.$disconnect();
  await banc.fermer();
  conclure();
}

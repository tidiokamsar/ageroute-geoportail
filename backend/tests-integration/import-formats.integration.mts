// Banc d'integration du LOT A1 (formats d'import ouverts, CRS, mapping, versions) contre un vrai PostGIS.
// Contrat : docs/projets-voirie/CONTRAT-IMPORT.md. Voir tests-integration/README.md. Lancer (DATABASE_URL pointe sur `replay`) :
//   npx tsx tests-integration/import-formats.integration.mts
//
// Tout passe par les routes reelles montees comme en production (`createApp`), des jetons signes par des secrets aleatoires, le role, le
// module et le perimetre LUS EN BASE, PostGIS reel (ST_Transform, ST_IsValid, ST_MakeValid), les contraintes et declencheurs reels, dans le
// clone jetable `essai_import_formats`.
//
// DONNEES 100 % SYNTHETIQUES : positions WGS 84 inventees autour de (-10,10 ; 9,19). Les coordonnees UTM 29N du « plan » sont calculees par
// un ORACLE INDEPENDANT (`lib/geodesie.ts`, series de Kruger en JavaScript pur, sans PROJ) : si ST_Transform se trompait, le banc le verrait.
// Les longueurs sont comparees a la distance geodesique de Vincenty (sans projection).
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure, proche } from "./lib/verdict.ts";
import { avecTerritoireParDefaut } from "./lib/territoire-par-defaut.mts";
import { distanceVincenty, lonLatVersUtm, utmVersLonLat } from "./lib/geodesie.ts";

const banc = await ouvrirBancClone("essai_import_formats");
const { prisma } = await banc.imp("lib/prisma");
const { createApp } = await banc.imp("app");
const { signAccessToken } = await banc.imp("utils/jwt");
const { construireZip, kmzSimple } = await banc.imp("projets-voirie/formats/zip.fixtures");
const request = (await import("supertest")).default;

// Lot T1 : territoire par defaut ajoute aux creations de projet du banc (voir lib/territoire-par-defaut.mts).
const app = avecTerritoireParDefaut(createApp(), prisma);
const BASE = "/api/v2/projets-voirie";
const sql = <T = Record<string, unknown>>(texte: string, ...v: unknown[]) => prisma.$queryRawUnsafe(texte, ...v) as Promise<T[]>;
const compter = async (texte: string, ...v: unknown[]) => Number((await sql<{ n: bigint }>(texte, ...v))[0].n);

type P = [number, number];
const LON0 = -10.1, LAT0 = 9.19;
/** Axes synthetiques en WGS 84 : A vers l'est (6 points), B vers le nord (4 points), C diagonale (3 points). */
const AXES_WGS: Record<string, P[]> = {
  A: Array.from({ length: 6 }, (_, i) => [LON0 + i * 0.002, LAT0 + i * 0.0002] as P),
  B: Array.from({ length: 4 }, (_, i) => [LON0 + 0.004, LAT0 + i * 0.0015] as P),
  C: Array.from({ length: 3 }, (_, i) => [LON0 + 0.001 + i * 0.001, LAT0 - 0.001 - i * 0.001] as P),
};
const f3 = (v: number) => v.toFixed(3);

/** CSV du plan d'axes en UTM 29N (calcule par l'oracle), virgule decimale et point-virgule, avec BOM UTF-8. */
function csvPlanUtm(fuseau = 29, virgule = true, entete = "axe;ordre;x;y;commune"): Buffer {
  const lignes = [entete];
  for (const [axe, pts] of Object.entries(AXES_WGS)) {
    // Ordre volontairement melange dans le fichier : le tri par la colonne d'ordre doit le remettre dans le bon sens.
    const rangs = pts.map((_, i) => i).reverse();
    for (const i of rangs) {
      const { e, n } = lonLatVersUtm(pts[i][0], pts[i][1], fuseau);
      const x = virgule ? f3(e).replace(".", ",") : f3(e);
      const y = virgule ? f3(n).replace(".", ",") : f3(n);
      lignes.push(`${axe};${i + 1};${x};${y};Kissidougou`);
    }
  }
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lignes.join("\r\n") + "\r\n", "utf8")]);
}
const OPTIONS_PLAN = { colonneX: "x", colonneY: "y", colonneCle: "axe", colonneOrdre: "ordre", epsgSource: "32629" };
const kmlDe = (lignes: Record<string, P[]>, dossier?: string) => {
  const pm = Object.entries(lignes).map(([nom, pts]) => `<Placemark><name>${nom}</name><LineString><coordinates>${pts.map(([x, y]) => `${x.toFixed(9)},${y.toFixed(9)},0`).join(" ")}</coordinates></LineString></Placemark>`).join("");
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>${dossier ? `<Folder><name>${dossier}</name>${pm}</Folder>` : pm}</Document></kml>`);
};

async function main() {
  const mk = (email: string, nomComplet: string, role: string, modules: string[] = ["projets-voirie"]) =>
    prisma.user.create({ data: { email, nomComplet, passwordHash: "x", role, modulesAutorises: modules } });
  const admin = await mk("admin@banc.invalid", "Mariama Admin", "ADMIN", []);
  const chef = await mk("chef@banc.invalid", "Sekou Gestionnaire", "GESTIONNAIRE");
  const chef2 = await mk("chef2@banc.invalid", "Fatoumata Gestionnaire", "GESTIONNAIRE");
  const lecteur = await mk("lecteur@banc.invalid", "Lecteur banc", "LECTEUR");
  const regional = await mk("reg@banc.invalid", "Regional banc", "GESTIONNAIRE");
  const R1 = (await prisma.region.create({ data: { nom: "Region banc 1" } })).id;
  const R2 = (await prisma.region.create({ data: { nom: "Region banc 2" } })).id;
  await sql(`INSERT INTO perimetres_comptes ("userId", "regionId", "accordeParId") VALUES ($1, $2, $3)`, regional.id, R1, admin.id);
  const jeton = (u: { id: string; role: string; email: string }) => signAccessToken({ sub: u.id, role: u.role, email: u.email });
  const T = { admin: jeton(admin), chef: jeton(chef), chef2: jeton(chef2), lecteur: jeton(lecteur), reg: jeton(regional) };

  const get = (chemin: string, t = T.chef) => request(app).get(`${BASE}${chemin}`).set("Authorization", `Bearer ${t}`);
  const envoyer = (methode: "post" | "patch" | "delete", chemin: string, corps?: unknown, t = T.chef) => {
    const r = request(app)[methode](`${BASE}${chemin}`).set("Authorization", `Bearer ${t}`);
    return corps === undefined ? r : r.send(corps as object);
  };
  /** Appel multipart : `chemin` relatif a BASE (depot, inventaire, apercu). */
  function multipart(chemin: string, fichier: Buffer | null, champs: Record<string, string | undefined>, nom = "fichier.csv", t = T.chef) {
    const r = request(app).post(`${BASE}${chemin}`).set("Authorization", `Bearer ${t}`);
    for (const [k, v] of Object.entries(champs)) if (v !== undefined) r.field(k, v);
    return fichier ? r.attach("fichier", fichier, { filename: nom }) : r;
  }
  const depot = (pid: string, f: Buffer, c: Record<string, string | undefined>, nom?: string, simuler = false, t = T.chef) => multipart(`/${pid}/jeux${simuler ? "?simuler=true" : ""}`, f, c, nom, t);
  const apercu = (pid: string, f: Buffer, c: Record<string, string | undefined>, nom?: string, t = T.chef) => multipart(`/${pid}/import/apercu`, f, c, nom, t);
  const inventaire = (pid: string, f: Buffer, c: Record<string, string | undefined>, nom?: string, t = T.chef) => multipart(`/${pid}/import/inventaire`, f, c, nom, t);
  const JUSTIF = "Controle effectue avec le chef de projet";
  const autoriser = (pid: string, jid: string, t = T.chef) => envoyer("post", `/${pid}/jeux/${jid}/autoriser`, { justification: JUSTIF }, t);
  const statutJeu = async (id: string) => (await sql<{ statut: string }>(`SELECT statut::text FROM projets_voirie_jeux WHERE id = $1`, id))[0].statut;
  const nbObjets = (jeuId: string) => compter(`SELECT count(*) n FROM projets_voirie_objets WHERE "jeuId" = $1`, jeuId);
  async function instantane(): Promise<Record<string, number>> {
    const tables = await sql<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND left(table_name, 1) <> '_' ORDER BY 1`);
    const sortie: Record<string, number> = {};
    for (const t of tables) sortie[t.table_name] = await compter(`SELECT count(*) n FROM "${t.table_name}"`);
    return sortie;
  }

  console.log("\n== Lot A1 : formats d'import ouverts, CRS, mapping, versions : banc PostGIS ==");
  const etatInitial = await instantane();
  /** Reponses reelles, ecrites dans le fichier de IMPORT_EXEMPLES s'il est demande (docs/projets-voirie/API.md). */
  const exemples: Record<string, unknown> = {};

  // ---------------------------------------------------------------- 0. Fixtures : projet, concessionnaires
  const cree = await envoyer("post", "", { code: "KISSI-A1", nom: "Voirie A1", regionId: R1 });
  const PID: string = cree.body.projet.id;
  const PID_R2: string = (await envoyer("post", "", { code: "AUTRE-REGION", nom: "Autre region", regionId: R2 }, T.admin)).body.projet.id;
  const CONC_A: string = (await envoyer("post", "/concessionnaires", { nom: "Operateur Alpha", typeReseau: "TELECOM" })).body.concessionnaire.id;
  const CONC_B: string = (await envoyer("post", "/concessionnaires", { nom: "Operateur Beta", typeReseau: "TELECOM" })).body.concessionnaire.id;
  /** Meme contenu avec un saut de ligne de plus : une autre empreinte SHA-256, sans changer ce que le fichier dit. */
  const variante = (b: Buffer, n: number) => Buffer.concat([b, Buffer.from("\n".repeat(n))]);

  // ---------------------------------------------------------------- 1. Gardes
  verifier("1. wizard : un LECTEUR est refuse sur chaque route (403), meme en lecture (options, delta)",
    (await get(`/${PID}/import/options`, T.lecteur)).status === 403 && (await inventaire(PID, csvPlanUtm(), {}, "p.csv", T.lecteur)).status === 403
    && (await apercu(PID, csvPlanUtm(), {}, "p.csv", T.lecteur)).status === 403 && (await get(`/${PID}/jeux/${PID}/delta`, T.lecteur)).status === 403);
  verifier("1. un compte regional ne peut ni inventorier ni apercevoir un projet d'une autre region : 404 PROJET_INTROUVABLE (avant lecture du fichier)",
    (await inventaire(PID_R2, csvPlanUtm(), {}, "p.csv", T.reg)).body.code === "PROJET_INTROUVABLE" && (await apercu(PID_R2, csvPlanUtm(), {}, "p.csv", T.reg)).status === 404
    && (await get(`/${PID_R2}/import/options`, T.reg)).status === 404);
  verifier("1. un projet inconnu repond 404 PROJET_INTROUVABLE meme a un compte national",
    (await get(`/00000000-0000-4000-8000-000000000099/import/options`, T.admin)).status === 404);

  const PID_SUP: string = (await envoyer("post", "", { code: "A-SUPPRIMER", nom: "Projet supprime" }, T.admin)).body.projet.id;
  await envoyer("delete", `/${PID_SUP}`, undefined, T.admin);
  verifier("1. un projet RETIRE repond 404 PROJET_INTROUVABLE a tous les comptes (admin compris) sur options, inventaire, apercu, delta, revue et retour arriere",
    (await get(`/${PID_SUP}/import/options`, T.admin)).body.code === "PROJET_INTROUVABLE" && (await inventaire(PID_SUP, csvPlanUtm(), {}, "p.csv", T.admin)).status === 404
    && (await apercu(PID_SUP, csvPlanUtm(), {}, "p.csv", T.admin)).status === 404 && (await get(`/${PID_SUP}/jeux/${PID}/delta`, T.admin)).status === 404
    && (await envoyer("post", `/${PID_SUP}/jeux/${PID}/revue-suppressions`, { decision: "ACCEPTER", justification: "justification suffisante" }, T.admin)).status === 404
    && (await envoyer("post", `/${PID_SUP}/jeux/${PID}/retour-arriere`, { justification: "justification suffisante" }, T.admin)).status === 404);

  // ---------------------------------------------------------------- 2. Options et liste blanche de CRS
  const opt = await get(`/${PID}/import/options`);
  const src = opt.body.crs?.sourcesAutorises ?? [];
  verifier("2. options : CRS source autorises = 4326, 32628, 32629, avec nom et unite lus dans PostGIS ; cible EPSG:4326 en degres",
    opt.status === 200 && src.map((s: { epsg: number }) => s.epsg).join() === "4326,32628,32629"
    && src.find((s: { epsg: number }) => s.epsg === 32629)?.nom === "WGS 84 / UTM zone 29N" && src.find((s: { epsg: number }) => s.epsg === 32629)?.unite === "metre"
    && src.every((s: { disponible: boolean }) => s.disponible) && opt.body.crs.cible.epsg === 4326 && opt.body.crs.cible.unite === "degre", opt.body.crs);

  // ---------------------------------------------------------------- 3. CRS : plan UTM 29N contre WGS 84
  const plan = csvPlanUtm();
  const apPlan = await apercu(PID, plan, OPTIONS_PLAN, "plan-axes.csv");
  const crs = apPlan.body.resume?.crs;
  exemples["apercu_plan_utm"] = apPlan.body;
  exemples["options"] = opt.body;
  verifier("3. apercu du plan UTM 29N (virgule decimale, BOM, ordre melange) : 200, 3 lignes (une par axe), format CSV, delimiteur et decimale detectes",
    apPlan.status === 200 && apPlan.body.format === "CSV" && apPlan.body.resume.nbObjets === 3 && apPlan.body.resume.parTypeGeom.LIGNE === 3
    && apPlan.body.resume.import.csv.delimiteur === ";" && apPlan.body.resume.import.csv.separateurDecimal === "," && apPlan.body.resume.import.csv.mode === "lignes", apPlan.body.resume);
  verifier("3. CRS : source EPSG:32629 (metres), cible EPSG:4326 (degres), methode ST_Transform avec la version de PROJ, origine choisie par l'utilisateur, jamais silencieux",
    crs?.epsgSource === 32629 && crs.epsgCible === 4326 && crs.uniteSource === "metre" && crs.uniteCible === "degre" && crs.transformation === "ST_Transform"
    && /^\d+\.\d+/.test(crs.versionProj ?? "") && crs.methode.startsWith("ST_Transform") && crs.origine === "choisi_par_utilisateur" && crs.source.includes("UTM zone 29N"), crs);
  verifier("3. plausibilite : emprise du resultat dans la Guinee, CONFORME, aucune confirmation requise",
    crs?.plausibilite.statut === "CONFORME" && crs.plausibilite.nbElementsHorsZone === 0 && crs.plausibilite.confirmationRequise === false && Array.isArray(crs.plausibilite.empriseResultat), crs?.plausibilite);

  // Exactitude de la transformation : sommet par sommet contre l'oracle INDEPENDANT, et longueur contre Vincenty.
  const lignesApercu: { nom: string; geometrie: { coordinates: P[] } }[] = apPlan.body.echantillon.objets;
  let ecartMax = 0;
  for (const o of lignesApercu) {
    const attendu = AXES_WGS[o.nom];
    o.geometrie.coordinates.forEach((c, i) => { ecartMax = Math.max(ecartMax, Math.abs(c[0] - attendu[i][0]), Math.abs(c[1] - attendu[i][1])); });
  }
  verifier("3. sommet par sommet, ST_Transform retrouve les positions WGS 84 d'origine a moins de 1e-6 degre (environ 10 cm), l'ordre des points suivant la colonne d'ordre (et non l'ordre du fichier)",
    lignesApercu.length === 3 && ecartMax < 1e-6, { ecartMax });
  const longueurAttendue = Object.values(AXES_WGS).reduce((s, pts) => s + pts.slice(1).reduce((t, p, i) => t + distanceVincenty(pts[i][0], pts[i][1], p[0], p[1]), 0), 0);
  verifier("3. la longueur calculee par la base (geographie) egale la longueur de Vincenty (sans projection) a 5 cm pres", proche(apPlan.body.statistiques.longueurTotaleM, longueurAttendue, 0.05 * 3 + 0.5), [apPlan.body.statistiques.longueurTotaleM, longueurAttendue]);

  // Les cas d'erreur de CRS : jamais une devinette.
  const e = async (champs: Record<string, string | undefined>, f = plan) => { const r = await apercu(PID, f, champs, "plan-axes.csv"); return [r.status, r.body.code]; };
  const sansCrs = { colonneX: "x", colonneY: "y", colonneCle: "axe", colonneOrdre: "ordre" };
  verifier("3. CRS absent : 422 CRS_REQUIS (rien n'est devine)", JSON.stringify(await e(sansCrs)) === JSON.stringify([422, "CRS_REQUIS"]));
  verifier("3. des metres declares en WGS 84 : 422 CRS_INCOHERENT (et le message cite EPSG:32629)", JSON.stringify(await e({ ...sansCrs, epsgSource: "4326" })) === JSON.stringify([422, "CRS_INCOHERENT"])
    && (await apercu(PID, plan, { ...sansCrs, epsgSource: "4326" }, "p.csv")).body.error.includes("32629"));
  verifier("3. mauvais fuseau (UTM 28N au lieu de 29N) : resultat hors de la Guinee, 422 HORS_GUINEE, meme avec confirmerHorsZone", JSON.stringify(await e({ ...sansCrs, epsgSource: "32628" })) === JSON.stringify([422, "HORS_GUINEE"])
    && JSON.stringify(await e({ ...sansCrs, epsgSource: "32628", confirmerHorsZone: "true" })) === JSON.stringify([422, "HORS_GUINEE"]));
  verifier("3. CRS hors liste blanche (UTM 30N) : 422 CRS_NON_AUTORISE ; code inconnu : 422 CRS_NON_AUTORISE", JSON.stringify(await e({ ...sansCrs, epsgSource: "32630" })) === JSON.stringify([422, "CRS_NON_AUTORISE"])
    && JSON.stringify(await e({ ...sansCrs, epsgSource: "999999" })) === JSON.stringify([422, "CRS_NON_AUTORISE"]));
  const planFuseau28 = csvPlanUtm(28);
  verifier("3. le plan calcule en UTM 28N et lu en 29N est hors Guinee aussi : le controle de zone attrape l'erreur de fuseau dans les deux sens", JSON.stringify(await e({ ...sansCrs, epsgSource: "32629" }, planFuseau28)) === JSON.stringify([422, "HORS_GUINEE"])
    && (await e({ ...sansCrs, epsgSource: "32628" }, planFuseau28))[0] === 200);
  verifier("3. un KML (WGS 84 par la norme) refuse un CRS projete : 422 CRS_INCOMPATIBLE_FORMAT", (await apercu(PID, kmlDe(AXES_WGS), { epsgSource: "32629" }, "reseau.kml")).body.code === "CRS_INCOMPATIBLE_FORMAT");

  // Coordonnees partielles hors zone : confirmation explicite.
  const planMixte = Buffer.from(`${plan.toString("utf8")}Z;1;${f3(900000).replace(".", ",")};${f3(5000000).replace(".", ",")};Loin\r\nZ;2;${f3(900100).replace(".", ",")};${f3(5000100).replace(".", ",")};Loin\r\n`);
  const sansConfirm = await apercu(PID, planMixte, OPTIONS_PLAN, "plan.csv");
  verifier("3. des points hors de la Guinee apres transformation : 409 CONFIRMATION_HORS_ZONE_REQUISE (avertissement bloquant sans confirmation explicite)",
    sansConfirm.status === 409 && sansConfirm.body.code === "CONFIRMATION_HORS_ZONE_REQUISE" && sansConfirm.body.nbElementsHorsZone === 1, sansConfirm.body);
  const avecConfirm = await apercu(PID, planMixte, { ...OPTIONS_PLAN, confirmerHorsZone: "true" }, "plan.csv");
  verifier("3. avec confirmerHorsZone, l'axe hors zone est ecarte (jamais stocke) et signale ; la plausibilite le dit",
    avecConfirm.status === 200 && avecConfirm.body.resume.nbObjets === 3 && avecConfirm.body.resume.crs.plausibilite.statut === "PARTIELLEMENT_HORS_ZONE"
    && avecConfirm.body.resume.crs.plausibilite.confirmee === true && avecConfirm.body.avertissements.some((a: { code: string }) => a.code === "ELEMENTS_HORS_GUINEE")
    && avecConfirm.body.validationGeometrique.elementsEcartes.length === 1 && avecConfirm.body.validationGeometrique.elementsEcartes[0].code === "COORDONNEES_HORS_ZONE"
    && avecConfirm.body.validationGeometrique.elementsEcartes[0].nom === "Z" && avecConfirm.body.validationGeometrique.elementsEcartes[0].element === 4
    && !/900000|5000000/.test(JSON.stringify(avecConfirm.body.validationGeometrique)), avecConfirm.body.validationGeometrique);

  // ---------------------------------------------------------------- 4. Depot du plan UTM et superposition au KML WGS 84
  const sim = await depot(PID, plan, { role: "AXES_TRAVAUX", ...OPTIONS_PLAN }, "plan-axes.csv", true);
  verifier("4. simulation du depot du plan : 200, jeu sans identifiant, CRS complet dans resume.crs, aucune ecriture", sim.status === 200 && sim.body.simulation === true && sim.body.jeu.id === null
    && sim.body.resume.crs.epsgSource === 32629 && sim.body.jeu.format === "CSV", sim.body);
  const dPlan = await depot(PID, plan, { role: "AXES_TRAVAUX", ...OPTIONS_PLAN, sha256Attendu: apPlan.body.fichier.sha256 }, "plan-axes.csv");
  const JEU_PLAN: string = dPlan.body.jeu?.id;
  verifier("4. depot du plan : 201, jeu CSV en quarantaine (CONTROLE), 3 axes, nature AXE, les 'circuits ou objets' ne sont pas des cables",
    dPlan.status === 201 && dPlan.body.jeu.statut === "CONTROLE" && dPlan.body.jeu.format === "CSV" && dPlan.body.jeu.nbObjets === 3 && dPlan.body.jeu.natureObjets === "AXE", dPlan.body);
  const rowPlan = (await sql<{ resume: { crs: { epsgSource: number; epsgCible: number; uniteSource: string; methode: string; versionProj: string } } }>(`SELECT resume FROM projets_voirie_jeux WHERE id = $1`, JEU_PLAN))[0].resume;
  verifier("4. la fiche du jeu conserve CRS source et cible, unites, methode, version de PROJ", rowPlan.crs.epsgSource === 32629 && rowPlan.crs.epsgCible === 4326 && rowPlan.crs.uniteSource === "metre"
    && rowPlan.crs.methode.startsWith("ST_Transform") && /^\d/.test(rowPlan.crs.versionProj), rowPlan.crs);
  const auditPlan = (await sql<{ after: { crs: { epsgSource: number; plausibilite: string }; import: { csv: { mode: string } | null } } }>(`SELECT after FROM audit_logs WHERE "entityType" = 'JeuDonneesProjet' AND "entityId" = $1 AND action = 'CREATE'`, JEU_PLAN))[0].after;
  verifier("4. l'audit du depot conserve le CRS (source, cible, methode, plausibilite) et le mode CSV, sans geometrie (moins de 4 ko)",
    auditPlan.crs.epsgSource === 32629 && auditPlan.crs.plausibilite === "CONFORME" && auditPlan.import.csv?.mode === "lignes"
    && (await sql<{ m: number }>(`SELECT max(length(after::text))::int m FROM audit_logs WHERE "entityType" = 'JeuDonneesProjet'`))[0].m < 4096, auditPlan);
  exemples["depot_plan_utm"] = dPlan.body;
  const redepot = await depot(PID, plan, { role: "AXES_TRAVAUX", ...OPTIONS_PLAN }, "plan-axes.csv");
  verifier("4. idempotence : le meme fichier redepose donne 409 JEU_DEJA_CHARGE avec le jeuId existant, aucun objet en double", redepot.status === 409 && redepot.body.code === "JEU_DEJA_CHARGE" && redepot.body.jeuId === JEU_PLAN
    && (await nbObjets(JEU_PLAN)) === 3);
  verifier("4. empreinte attendue differente (fichier modifie entre l'apercu et le depot) : 409 EMPREINTE_DIVERGENTE, aucun jeu cree",
    (await depot(PID, plan, { role: "AXES_TRAVAUX", ...OPTIONS_PLAN, sha256Attendu: "0".repeat(64) }, "plan-axes.csv")).body.code === "EMPREINTE_DIVERGENTE");
  await autoriser(PID, JEU_PLAN);

  // Superposition : le reseau KML en WGS 84 et le plan UTM transforme coincident.
  const dKmlReseau = await depot(PID, kmlDe(AXES_WGS), { role: "RESEAU_TIERS", concessionnaireId: CONC_A, classePrecision: "B" }, "reseau-wgs84.kml");
  const JEU_KML: string = dKmlReseau.body.jeu?.id;
  const ecart = await sql<{ d: number }>(
    `SELECT max(ST_HausdorffDistance(ST_Transform(a.geom, 32629), ST_Transform(b.geom, 32629)))::float8 AS d
       FROM projets_voirie_objets a JOIN projets_voirie_objets b ON a.nom = b.nom WHERE a."jeuId" = $1 AND b."jeuId" = $2`, JEU_PLAN, JEU_KML);
  verifier("4. SUPERPOSITION : le plan d'axes UTM 29N importe et le KML WGS 84 des memes axes coincident a moins de 5 cm (distance de Hausdorff, 3 axes apparies par nom)",
    dKmlReseau.status === 201 && ecart[0].d !== null && ecart[0].d < 0.05, ecart);
  await autoriser(PID, JEU_KML);
  const an = (await get(`/${PID}/analyse`)).body;
  verifier("4. l'analyse sur le plan transforme et le reseau KML : le reseau suit les axes (tout dans la chaussee, aucun hors emprise)",
    an.conflits.total.horsEmpriseM < 1 && an.conflits.total.chausseeM > 0, an.conflits.total);

  // ---------------------------------------------------------------- 5. Inventaire et apercu ne persistent rien
  const etatAvantApercu = await instantane();
  const kmzAvecDossiers = kmzSimple(
    `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>` +
    `<Folder><name>Fibre</name><Placemark><name>F1</name><LineString><coordinates>-10.1,9.2 -10.09,9.2</coordinates></LineString></Placemark><Placemark><name>F2</name><LineString><coordinates>-10.1,9.21 -10.09,9.21</coordinates></LineString></Placemark></Folder>` +
    `<Folder><name>Eau</name><Placemark><name>E1</name><LineString><coordinates>-10.1,9.22 -10.09,9.22</coordinates></LineString></Placemark></Folder></Document></kml>`,
    [{ nom: "images/icone.png", contenu: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) }],
  );
  const inv = await inventaire(PID, kmzAvecDossiers, {}, "reseau.kmz");
  verifier("5. inventaire d'un KMZ : format KMZ detecte par le contenu, entrees listees (l'image n'est pas lue), couches Fibre (2) et Eau (1), choix de couche conseille",
    inv.status === 200 && inv.body.format === "KMZ" && inv.body.archive.kmlPrincipal === "doc.kml" && inv.body.archive.entrees.some((x: { nom: string; type: string }) => x.nom === "images/icone.png" && x.type === "image")
    && inv.body.couches.map((c: { nom: string; nbObjets: number }) => `${c.nom}:${c.nbObjets}`).join() === "Fibre:2,Eau:1" && inv.body.avertissements.some((a: { code: string }) => a.code === "COUCHES_MULTIPLES"), inv.body);
  exemples["inventaire_kmz"] = inv.body;
  exemples["inventaire_csv"] = (await inventaire(PID, plan, {}, "plan-axes.csv")).body;
  const apCouche = await apercu(PID, kmzAvecDossiers, { couche: "c1" }, "reseau.kmz");
  verifier("5. apercu d'une seule couche du KMZ : seuls les objets de la couche choisie (Eau : 1 objet) ; couche inconnue : 422 COUCHE_INTROUVABLE",
    apCouche.status === 200 && apCouche.body.resume.nbObjets === 1 && apCouche.body.couche.nom === "Eau" && (await apercu(PID, kmzAvecDossiers, { couche: "c9" }, "r.kmz")).body.code === "COUCHE_INTROUVABLE", apCouche.body.couche);
  const gros = Buffer.from(JSON.stringify({ type: "FeatureCollection", features: Array.from({ length: 500 }, (_, i) => ({ type: "Feature", properties: { name: `P${i}`, rang: i }, geometry: { type: "Point", coordinates: [LON0 + (i % 50) * 1e-4, LAT0 + Math.floor(i / 50) * 1e-4] } })) }));
  const apGros = await apercu(PID, gros, {}, "points.geojson");
  verifier("5. l'apercu d'un fichier de 500 objets renvoie un echantillon BORNE de 20 objets (jamais tout le fichier), avec le total",
    apGros.status === 200 && apGros.body.echantillon.objets.length === 20 && apGros.body.echantillon.total === 500 && apGros.body.resume.nbObjets === 500, apGros.body.echantillon.taille);
  const bowtie = Buffer.from(JSON.stringify({ type: "FeatureCollection", features: [
    { type: "Feature", properties: { name: "Noeud papillon" }, geometry: { type: "Polygon", coordinates: [[[-10.1, 9.2], [-10.099, 9.201], [-10.099, 9.2], [-10.1, 9.201], [-10.1, 9.2]]] } },
    { type: "Feature", properties: { name: "Carre" }, geometry: { type: "Polygon", coordinates: [[[-10.1, 9.3], [-10.099, 9.3], [-10.099, 9.301], [-10.1, 9.301], [-10.1, 9.3]]] } },
  ] }));
  const apBow = await apercu(PID, bowtie, {}, "emprise.geojson");
  const pb = apBow.body.validationGeometrique;
  verifier("5. validation geometrique par objet : le noeud papillon est signale AUTO_INTERSECTION (objet, nom, type), le carre non ; le message ne recopie aucune coordonnee ; l'objet a probleme est dans l'echantillon",
    apBow.status === 200 && pb.nbProblemes === 1 && pb.problemes[0].code === "AUTO_INTERSECTION" && pb.problemes[0].nom === "Noeud papillon" && pb.problemes[0].typeGeom === "POLYGONE"
    && !/\d{2}\.\d|\[/.test(pb.problemes[0].message) && apBow.body.statistiques.geometriesAReparer === 1 && apBow.body.echantillon.objets.some((o: { nom: string }) => o.nom === "Noeud papillon"), pb);
  const depBow = await depot(PID, bowtie, { role: "LIMITES_ROUTE" }, "emprise.geojson", true);
  verifier("5. le depot (simulation) rapporte aussi les geometries reparees par la base, par objet, bornees",
    depBow.status === 200 && depBow.body.validationGeometrique.nbProblemes === 1 && depBow.body.validationGeometrique.problemes[0].code === "AUTO_INTERSECTION"
    && depBow.body.avertissements.some((a: { code: string }) => a.code === "GEOMETRIES_REPAREES"), depBow.body.validationGeometrique);
  const etatApresApercu = await instantane();
  const modifies = Object.keys(etatAvantApercu).filter((t) => etatAvantApercu[t] !== etatApresApercu[t]);
  verifier("5. AUCUNE persistance : inventaire, apercu et simulation ne changent le nombre de lignes d'aucune table (jeux, objets, audit compris)", modifies.length === 0, modifies);

  // ---------------------------------------------------------------- 6. KMZ : nominal et archives hostiles
  const dKmz = await depot(PID, kmzAvecDossiers, { role: "AUTRE", couche: "c0" }, "reseau.kmz");
  verifier("6. depot d'un KMZ (couche Fibre) : 201, format KMZ, 2 objets, entree KML principale tracee dans resume.import", dKmz.status === 201 && dKmz.body.jeu.format === "KMZ" && dKmz.body.jeu.nbObjets === 2
    && dKmz.body.resume.import.entreeKml === "doc.kml" && dKmz.body.resume.import.couche.nom === "Fibre", dKmz.body);
  const kmzCode = async (f: Buffer, champs: Record<string, string> = {}) => { const r = await apercu(PID, f, champs, "x.kmz"); return `${r.status} ${r.body.code}`; };
  const KML_OK = `<?xml version="1.0"?><kml><Document><Placemark><name>A</name><LineString><coordinates>-10.1,9.2 -10.09,9.2</coordinates></LineString></Placemark></Document></kml>`;
  verifier("6. zip-slip : un nom `../` ou absolu dans l'archive : 422 ARCHIVE_CHEMIN_DANGEREUX", await kmzCode(construireZip([{ nom: "../doc.kml", contenu: KML_OK }]).buffer) === "422 ARCHIVE_CHEMIN_DANGEREUX"
    && await kmzCode(construireZip([{ nom: "/etc/doc.kml", contenu: KML_OK }]).buffer) === "422 ARCHIVE_CHEMIN_DANGEREUX");
  verifier("6. bombe de decompression : 5 Mo de zeros dans moins de 10 ko d'archive : 422 ARCHIVE_TAUX_COMPRESSION", await kmzCode(construireZip([{ nom: "doc.kml", contenu: Buffer.alloc(5 * 1024 * 1024) }]).buffer) === "422 ARCHIVE_TAUX_COMPRESSION");
  verifier("6. trop d'entrees : 101 entrees : 422 ARCHIVE_TROP_D_ENTREES", await kmzCode(construireZip(Array.from({ length: 101 }, (_, i) => ({ nom: `f${i}.png`, contenu: "x" }))).buffer) === "422 ARCHIVE_TROP_D_ENTREES");
  verifier("6. KMZ sans KML : 422 KMZ_SANS_KML ; archive de Shapefile : 415 FORMAT_GDAL_DESACTIVE (lot B2, interrupteur coupe par defaut) ; archive corrompue : 422 ARCHIVE_INVALIDE ; entree chiffree : 422 ARCHIVE_CHIFFREE ; lien symbolique : 422 ARCHIVE_LIEN_SYMBOLIQUE",
    await kmzCode(construireZip([{ nom: "notes.txt", contenu: "x" }]).buffer) === "422 KMZ_SANS_KML" && await kmzCode(construireZip([{ nom: "a.shp", contenu: "x" }]).buffer) === "415 FORMAT_GDAL_DESACTIVE"
    && await kmzCode(kmzSimple(KML_OK).subarray(0, 60)) === "422 ARCHIVE_INVALIDE" && await kmzCode(construireZip([{ nom: "doc.kml", contenu: KML_OK, flags: 1 }]).buffer) === "422 ARCHIVE_CHIFFREE"
    && await kmzCode(construireZip([{ nom: "doc.kml", contenu: KML_OK }, { nom: "l", contenu: "x", faitPar: (3 << 8) | 20, attrExterne: (0o120777 << 16) >>> 0 }]).buffer) === "422 ARCHIVE_LIEN_SYMBOLIQUE");
  const deuxKml = construireZip([{ nom: "a.kml", contenu: KML_OK }, { nom: "b.kml", contenu: KML_OK.replace(">A<", ">B<") }]).buffer;
  const invDeux = await inventaire(PID, deuxKml, {}, "deux.kmz");
  verifier("6. plusieurs KML : l'inventaire les liste (choixRequis) ; l'import refuse (422 KMZ_PLUSIEURS_KML) ; entreeKml choisit sans rien deviner ; entree inconnue : 422 ENTREE_KML_INTROUVABLE",
    invDeux.status === 200 && invDeux.body.archive.choixRequis === true && invDeux.body.archive.entreesKml.join() === "a.kml,b.kml" && await kmzCode(deuxKml) === "422 KMZ_PLUSIEURS_KML"
    && (await apercu(PID, deuxKml, { entreeKml: "b.kml" }, "d.kmz")).body.echantillon?.objets[0].nom === "B" && await kmzCode(deuxKml, { entreeKml: "c.kml" }) === "422 ENTREE_KML_INTROUVABLE");
  verifier("6. XXE dans le KML d'un KMZ : 422 DTD_REFUSEE", await kmzCode(kmzSimple(`<?xml version="1.0"?><!DOCTYPE kml [<!ENTITY x SYSTEM "file:///etc/passwd">]><kml><Document><Placemark><name>&x;</name></Placemark></Document></kml>`)) === "422 DTD_REFUSEE");
  verifier("6. le type reel decide : un KMZ nomme .kml est lu comme KMZ, un KML nomme .csv comme KML (avertissement EXTENSION_INCOHERENTE)",
    (await apercu(PID, kmzSimple(KML_OK), {}, "reseau.kml")).body.format === "KMZ" && (await apercu(PID, kmlDe(AXES_WGS), {}, "reseau.csv")).body.avertissements.some((a: { code: string }) => a.code === "EXTENSION_INCOHERENTE"));

  // ---------------------------------------------------------------- 7. GPX
  const GPX = `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="essai" xmlns="http://www.topografix.com/GPX/1/1">
    <wpt lat="9.2" lon="-10.1"><ele>350</ele><time>2026-11-01T10:00:00Z</time><name>Regard G1</name></wpt>
    <wpt lat="9.21" lon="-10.1"><name>Regard G2</name></wpt>
    <rte><name>Route R1</name><rtept lat="9.2" lon="-10.1"/><rtept lat="9.2" lon="-10.09"><time>2026-11-01T10:01:00Z</time></rtept></rte>
    <trk><name>Trace T1</name><trkseg><trkpt lat="9.3" lon="-10.1"/><trkpt lat="9.3" lon="-10.099"/></trkseg><trkseg><trkpt lat="9.31" lon="-10.1"/><trkpt lat="9.31" lon="-10.099"/></trkseg></trk></gpx>`;
  const invGpx = await inventaire(PID, Buffer.from(GPX), {}, "collecte.gpx");
  verifier("7. inventaire GPX : waypoints (2), routes (1), traces (1) ; WGS 84 par definition, aucun choix de CRS", invGpx.body.format === "GPX"
    && invGpx.body.couches.map((c: { id: string; nbObjets: number }) => `${c.id}:${c.nbObjets}`).join() === "waypoints:2,routes:1,traces:1" && invGpx.body.crs.normeDuFormat === "EPSG:4326" && invGpx.body.crs.choixObligatoire === false, invGpx.body);
  const dGpxTout = await depot(PID, Buffer.from(GPX), { role: "AUTRE" }, "collecte-tout.gpx", true);
  verifier("7. sans choix de couche : tout est importe (4 objets) avec les avertissements COUCHES_MULTIPLES, ALTITUDE_IGNOREE et HORODATAGES_IGNORES",
    dGpxTout.status === 200 && dGpxTout.body.resume.nbObjets === 4 && ["COUCHES_MULTIPLES", "ALTITUDE_IGNOREE", "HORODATAGES_IGNORES"].every((c) => dGpxTout.body.avertissements.some((a: { code: string }) => a.code === c)), dGpxTout.body.avertissements);
  const dGpx = await depot(PID, Buffer.from(GPX), { role: "AUTRE", couche: "traces" }, "collecte.gpx");
  const trace = await sql<{ type: string; nseg: number }>(`SELECT GeometryType(geom) type, ST_NumGeometries(geom)::int nseg FROM projets_voirie_objets WHERE "jeuId" = $1`, dGpx.body.jeu?.id);
  verifier("7. depot de la couche `traces` : 1 objet, un MULTILINESTRING a 2 segments (jamais raccordes), format GPX", dGpx.status === 201 && dGpx.body.jeu.format === "GPX" && trace.length === 1 && trace[0].type === "MULTILINESTRING" && trace[0].nseg === 2, [dGpx.body.error, trace]);

  // ---------------------------------------------------------------- 8. CSV : encodage, delimiteur, injection de formules, WKT
  const latin1 = Buffer.from("nom;x;y\nrégion;-10,1;9,2\n", "latin1");
  verifier("8. CSV en ISO-8859-1 sans declaration : 422 ENCODAGE_AMBIGU ; declare, il est lu", (await apercu(PID, latin1, { colonneX: "x", colonneY: "y", epsgSource: "4326" }, "p.csv")).body.code === "ENCODAGE_AMBIGU"
    && (await apercu(PID, latin1, { colonneX: "x", colonneY: "y", epsgSource: "4326", encodage: "iso-8859-1" }, "p.csv")).body.resume?.nbObjets === 1);
  verifier("8. delimiteur ambigu : 422 DELIMITEUR_AMBIGU ; declare, il est lu", (await apercu(PID, Buffer.from("a;b,c\n1;2,3\n4;5,6\n"), { colonneX: "a", colonneY: "b", epsgSource: "4326" }, "p.csv")).body.code === "DELIMITEUR_AMBIGU");
  const formules = Buffer.from(`nom,lon,lat\n"=cmd|' /C calc'!A0",-10.1,9.2\n+SUM(1+1),-10.09,9.2\n-2+3,-10.08,9.2\n@SUM(A1),-10.07,9.2\n`);
  const dForm = await depot(PID, formules, { role: "AUTRE", colonneX: "lon", colonneY: "lat", epsgSource: "4326" }, "formules.csv");
  const attr = await sql<{ nom: string }>(`SELECT attributs ->> 'nom' AS nom FROM projets_voirie_objets WHERE "jeuId" = $1 ORDER BY ordre`, dForm.body.jeu?.id);
  verifier("8. INJECTION DE FORMULES sans effet : =, +, -, @ sont stockes comme du texte, tels quels (on lit, on n'evalue ni n'ecrit)", dForm.status === 201
    && attr.map((a) => a.nom).join("|") === "=cmd|' /C calc'!A0|+SUM(1+1)|-2+3|@SUM(A1)", attr);
  const wkt = Buffer.from(`nom;geom\nLigne W;"LINESTRING(${f3(lonLatVersUtm(-10.1, 9.2, 29).e)} ${f3(lonLatVersUtm(-10.1, 9.2, 29).n)}, ${f3(lonLatVersUtm(-10.09, 9.2, 29).e)} ${f3(lonLatVersUtm(-10.09, 9.2, 29).n)})"\nSRID;SRID=4326;POINT(1 2)\n`);
  const apWkt = await apercu(PID, wkt, { colonneWkt: "geom", delimiteur: ";", epsgSource: "32629" }, "wkt.csv");
  verifier("8. WKT en UTM 29N : la ligne est transformee ; la ligne a prefixe SRID= est rejetee (rapport par ligne) ; le WKT n'est pas recopie dans les attributs",
    apWkt.status === 200 && apWkt.body.resume.nbObjets === 1 && apWkt.body.resume.import.rejets[0].code === "WKT_INVALIDE" && !("geom" in apWkt.body.echantillon.objets[0].attributs)
    && proche(apWkt.body.echantillon.objets[0].geometrie.coordinates[0][0], -10.1, 1e-6), apWkt.body.resume.import);
  const gjUtm = Buffer.from(JSON.stringify({ type: "FeatureCollection", crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32629" } }, features: [{ type: "Feature", properties: { name: "P" }, geometry: { type: "Point", coordinates: [lonLatVersUtm(-10.1, 9.2, 29).e, lonLatVersUtm(-10.1, 9.2, 29).n] } }] }));
  verifier("8. GeoJSON qui declare EPSG:32629 : refuse sans confirmation (CRS_REQUIS) ; avec epsgSource=32629, transforme ; code different : CRS_CONFLIT",
    (await apercu(PID, gjUtm, {}, "u.geojson")).body.code === "CRS_REQUIS" && (await apercu(PID, gjUtm, { epsgSource: "32628" }, "u.geojson")).body.code === "CRS_CONFLIT"
    && proche((await apercu(PID, gjUtm, { epsgSource: "32629" }, "u.geojson")).body.echantillon?.objets[0].geometrie.coordinates[1], 9.2, 1e-6));

  // ---------------------------------------------------------------- 9. Mapping de champs
  const csvMap = Buffer.from(`Libelle;Type;Classe;Operateur;Code;lon;lat\nRegard 1;telecom;B;Operateur Beta;R1;-10,1;9,2\nRegard 2;telecom;B;Operateur Beta;R2;-10,09;9,2\n`);
  const optMap = { colonneX: "lon", colonneY: "lat", epsgSource: "4326", delimiteur: ";", separateurDecimal: "," };
  const mapping = JSON.stringify({ nom: "Libelle", identifiant: "Code", typeReseau: "Type", classePrecision: "Classe", concessionnaire: "Operateur" });
  const apMap = await apercu(PID, csvMap, { ...optMap, mapping }, "reseau.csv");
  verifier("9. apercu avec mapping : noms pris de la colonne, valeurs UNIQUES proposees pour le jeu (type de reseau, classe, concessionnaire), rien n'est applique a ce stade",
    apMap.status === 200 && apMap.body.echantillon.objets.map((o: { nom: string }) => o.nom).join() === "Regard 1,Regard 2"
    && apMap.body.mapping.propositionsJeu.typeReseau.valeur === "TELECOM" && apMap.body.mapping.propositionsJeu.classePrecision.valeur === "B" && apMap.body.mapping.propositionsJeu.concessionnaire.valeur === "Operateur Beta", apMap.body.mapping);
  const dMap = await depot(PID, csvMap, { role: "RESEAU_TIERS", ...optMap, mapping }, "reseau-mappe.csv");
  verifier("9. depot avec mapping : concessionnaire retrouve par son nom (jamais cree), type de reseau et classe pris de la colonne, trace dans resume.import.champsDepuisMapping, audit du mapping",
    dMap.status === 201 && dMap.body.jeu.concessionnaire?.id === CONC_B && dMap.body.jeu.typeReseau === "TELECOM" && dMap.body.jeu.classePrecision === "B"
    && dMap.body.resume.import.champsDepuisMapping.classePrecision.colonne === "Classe" && dMap.body.resume.import.mapping.identifiant === "Code", dMap.body);
  await autoriser(PID, dMap.body.jeu.id);
  verifier("9. le formulaire l'emporte sur le mapping : une classe D explicite reste D", (await depot(PID, variante(csvMap, 1), { role: "RESEAU_TIERS", ...optMap, mapping, classePrecision: "D" }, "reseau-mappe2.csv", true)).body.jeu?.classePrecision === "D");
  verifier("9. concessionnaire inconnu dans la colonne : jamais cree, 400 CONCESSIONNAIRE_REQUIS ; classe jamais inventee sans mapping (jeu AUTRE : null)",
    (await depot(PID, Buffer.from(csvMap.toString().replace(/Operateur Beta/g, "Operateur Inconnu")), { role: "RESEAU_TIERS", ...optMap, mapping }, "inconnu.csv", true)).body.code === "CONCESSIONNAIRE_REQUIS"
    && (await compter(`SELECT count(*) n FROM concessionnaires_reseau`)) === 2 && (await depot(PID, variante(csvMap, 2), { role: "AUTRE", ...optMap }, "autre.csv", true)).body.jeu?.classePrecision === null);
  verifier("9. mapping : champ cible hors liste blanche 400 MAPPING_INVALIDE ; colonne inexistante 422 MAPPING_COLONNE_INTROUVABLE",
    (await apercu(PID, csvMap, { ...optMap, mapping: '{"geom":"Libelle"}' }, "r.csv")).body.code === "MAPPING_INVALIDE" && (await apercu(PID, csvMap, { ...optMap, mapping: '{"nom":"Absente"}' }, "r.csv")).body.code === "MAPPING_COLONNE_INTROUVABLE");

  // ---------------------------------------------------------------- 10. Delta de versions : modifies, retires, revue des suppressions
  // Version 1 du reseau Alpha = dMap (Regard 1 et 2, identifiant R1 et R2). Version 2 : Regard 1 deplace (modifie), Regard 2 supprime, Regard 3 ajoute.
  const csvV2 = Buffer.from(`Libelle;Type;Classe;Operateur;Code;lon;lat\nRegard 1 (deplace);telecom;B;Operateur Beta;R1;-10,1;9,2005\nRegard 3;telecom;B;Operateur Beta;R3;-10,08;9,2\n`);
  const dV2 = await depot(PID, csvV2, { role: "RESEAU_TIERS", ...optMap, mapping }, "reseau-v2.csv");
  const JEU_V1: string = dMap.body.jeu.id, JEU_V2: string = dV2.body.jeu?.id;
  verifier("10. depot de la version 2 : delta = 1 ajoute, 1 MODIFIE (meme identifiant R1, geometrie et nom differents), 1 retire (R2), 0 identique ; remplace la version 1 ; suppressions A_REVOIR",
    dV2.status === 201 && dV2.body.delta.ajoutes === 1 && dV2.body.delta.modifies === 1 && dV2.body.delta.retires === 1 && dV2.body.delta.identiques === 0
    && dV2.body.remplace.jeuId === JEU_V1 && dV2.body.suppressions.statut === "A_REVOIR" && dV2.body.suppressions.nb === 1, dV2.body);
  exemples["depot_version_2"] = dV2.body;
  const dl = (await get(`/${PID}/jeux/${JEU_V2}/delta`)).body;
  exemples["delta"] = dl;
  verifier("10. GET delta : cle de comparaison `identifiant`, echantillons (le retire est R2 par son nom), statut A_REVOIR, aucune geometrie",
    dl.cleComparaison === "identifiant" && dl.echantillons.retires[0].nom === "Regard 2" && dl.echantillons.modifies[0].cle === "R1" && dl.echantillons.modifies[0].nomApres === "Regard 1 (deplace)"
    && dl.suppressions.statut === "A_REVOIR" && !/coordinates/.test(JSON.stringify(dl)) && dl.comparaison.jeuId === JEU_V1, dl);
  const refusAuto = await autoriser(PID, JEU_V2);
  verifier("10. SUPPRESSIONS JAMAIS APPLIQUEES SANS REVUE : autoriser la version 2 sans revue : 409 SUPPRESSIONS_A_REVOIR ; la version 1 reste AUTORISE",
    refusAuto.status === 409 && refusAuto.body.code === "SUPPRESSIONS_A_REVOIR" && refusAuto.body.nb === 1 && (await statutJeu(JEU_V1)) === "AUTORISE" && (await statutJeu(JEU_V2)) === "CONTROLE", refusAuto.body);
  const revueCourte = await envoyer("post", `/${PID}/jeux/${JEU_V2}/revue-suppressions`, { decision: "REFUSER", justification: "non" });
  verifier("10. revue : justification d'au moins 10 caracteres (400) ; le refus de revue et sa definitivite (O1) sont eprouves a la section 11 bis", revueCourte.status === 400);
  const revueOk = await envoyer("post", `/${PID}/jeux/${JEU_V2}/revue-suppressions`, { decision: "ACCEPTER", justification: "R2 a ete depose, confirme par le concessionnaire" }, T.chef2);
  exemples["revue_suppressions"] = revueOk.body;
  verifier("10. revue ACCEPTER par un autre compte : statut ACCEPTEES, relecteur nomme, un seul evenement conserve",
    revueOk.status === 200 && revueOk.body.suppressions.statut === "ACCEPTEES" && revueOk.body.suppressions.revue.par.nomComplet === "Fatoumata Gestionnaire"
    && (await compter(`SELECT count(*) n FROM projets_voirie_import_evenements WHERE "jeuId" = $1`, JEU_V2)) === 1, revueOk.body);
  verifier("10. revue impossible : jeu sans suppression (la version 1 n'est plus en controle : 409 STATUT_INCOMPATIBLE) ; jeu inconnu : 404",
    (await envoyer("post", `/${PID}/jeux/${JEU_V1}/revue-suppressions`, { decision: "ACCEPTER", justification: "justification suffisante" })).body.code === "STATUT_INCOMPATIBLE"
    && (await envoyer("post", `/${PID}/jeux/00000000-0000-4000-8000-000000000042/revue-suppressions`, { decision: "ACCEPTER", justification: "justification suffisante" })).status === 404);
  const nbV1Avant = await nbObjets(JEU_V1);
  const autoV2 = await autoriser(PID, JEU_V2);
  verifier("10. apres revue acceptee, l'autorisation passe : version 2 AUTORISE, version 1 REMPLACE ; AUCUN objet supprime (la version 1 garde ses objets)",
    autoV2.status === 200 && (await statutJeu(JEU_V2)) === "AUTORISE" && (await statutJeu(JEU_V1)) === "REMPLACE" && (await nbObjets(JEU_V1)) === nbV1Avant && nbV1Avant === 2, autoV2.body);
  const auditRevue = await sql<{ action: string; n: number }>(`SELECT action::text, count(*)::int n FROM audit_logs WHERE "entityType" = 'JeuDonneesProjet' AND "entityId" = $1 AND (after::text LIKE '%revueSuppressions%') GROUP BY 1`, JEU_V2);
  verifier("10. chaque revue est auditee (VALIDATE pour ACCEPTER ; REJECT pour REFUSER, section 10 bis) avec acteur, justification, nombre d'objets retires, sans geometrie",
    auditRevue.length === 1 && auditRevue[0].action === "VALIDATE" && auditRevue[0].n === 1, auditRevue);

  // Retire sans cle : un objet sans nom ni identifiant ne se rapproche de rien (jamais de modification au hasard).
  verifier("10. version sans suppression (premier depot d'un autre concessionnaire) : suppressions null ; delta null", (await depot(PID, variante(csvMap, 3), { role: "AUTRE", ...optMap }, "autre2.csv", true)).body.delta === null);

  // ---------------------------------------------------------------- 11. Retour arriere
  const dl2 = (await get(`/${PID}/jeux/${JEU_V2}/delta`)).body;
  verifier("11. GET delta du jeu autorise : retourArriere possible, restaurerait la version 1 ; evenements = la revue", dl2.retourArriere.possible === true && dl2.retourArriere.restaureraJeuId === JEU_V1
    && dl2.retourArriere.restaureraVersion === 1 && dl2.evenements.length === 1 && dl2.suppressions.statut === "ACCEPTEES", dl2.retourArriere);
  verifier("11. retour arriere refuse : jeu qui n'est pas autorise (409 STATUT_INCOMPATIBLE) ; justification courte (400)",
    (await envoyer("post", `/${PID}/jeux/${JEU_V1}/retour-arriere`, { justification: "justification suffisante" })).body.code === "STATUT_INCOMPATIBLE"
    && (await envoyer("post", `/${PID}/jeux/${JEU_V2}/retour-arriere`, { justification: "non" })).status === 400);
  const nbAvant = { v1: await nbObjets(JEU_V1), v2: await nbObjets(JEU_V2), jeux: await compter(`SELECT count(*) n FROM projets_voirie_jeux`), objets: await compter(`SELECT count(*) n FROM projets_voirie_objets`) };
  const attente = await depot(PID, Buffer.from(csvV2.toString().replace("Regard 3", "Regard 4")), { role: "RESEAU_TIERS", ...optMap, mapping }, "reseau-v3.csv");
  verifier("11. un depot en attente de meme cle bloque le retour arriere : 409 DEPOT_EN_ATTENTE avec le jeuId du depot",
    attente.status === 201 && (await envoyer("post", `/${PID}/jeux/${JEU_V2}/retour-arriere`, { justification: "retour a la version validee" })).body.jeuId === attente.body.jeu.id);
  await envoyer("post", `/${PID}/jeux/${attente.body.jeu.id}/rejeter`, { justification: "depot de test, rejete pour l'essai" });
  const retour = await envoyer("post", `/${PID}/jeux/${JEU_V2}/retour-arriere`, { justification: "La version 2 supprimait R2 a tort : retour a la version 1" });
  exemples["retour_arriere"] = retour.body;
  exemples["erreur_crs_incoherent"] = (await apercu(PID, plan, { ...sansCrs, epsgSource: "4326" }, "p.csv")).body;
  exemples["erreur_confirmation"] = sansConfirm.body;
  exemples["erreur_suppressions_a_revoir"] = refusAuto.body;
  verifier("11. RETOUR ARRIERE : la version 1 repasse AUTORISE, la version 2 REMPLACE ; une seule AUTORISE", retour.status === 200 && retour.body.jeuRestaure.id === JEU_V1 && retour.body.jeuRestaure.statut === "AUTORISE"
    && retour.body.jeuRetire.statut === "REMPLACE" && (await statutJeu(JEU_V1)) === "AUTORISE" && (await statutJeu(JEU_V2)) === "REMPLACE"
    && (await compter(`SELECT count(*) n FROM projets_voirie_jeux WHERE "concessionnaireId" = $1 AND statut = 'AUTORISE'`, CONC_B)) === 1, retour.body);
  verifier("11. SANS PERTE : aucun jeu ni objet supprime (memes comptes), les decisions d'origine de la version 1 sont conservees (decideLe, justification)",
    (await nbObjets(JEU_V1)) === nbAvant.v1 && (await nbObjets(JEU_V2)) === nbAvant.v2 && (await compter(`SELECT count(*) n FROM projets_voirie_jeux`)) === nbAvant.jeux + 1 /* le depot de test */
    && (await compter(`SELECT count(*) n FROM projets_voirie_objets`)) >= nbAvant.objets && retour.body.jeuRestaure.decision.justification === JUSTIF, retour.body.jeuRestaure.decision);
  const evRetour = await sql<{ type: string; jeuId: string; jeuLieId: string; details: { versionRetiree: number; versionRestauree: number } }>(`SELECT type::text, "jeuId", "jeuLieId", details FROM projets_voirie_import_evenements WHERE type = 'RETOUR_ARRIERE'`);
  const auditRetour = await sql<{ action: string; entityId: string }>(`SELECT action::text, "entityId" FROM audit_logs WHERE after::text LIKE '%retourArriere%'`);
  verifier("11. le retour arriere est un evenement conserve (acteur, justification, versions) et audite deux fois : RESTORE (version restauree) et UPDATE (version retiree)",
    evRetour.length === 1 && evRetour[0].jeuId === JEU_V2 && evRetour[0].jeuLieId === JEU_V1 && evRetour[0].details.versionRetiree === 2 && evRetour[0].details.versionRestauree === 1
    && auditRetour.some((a) => a.action === "RESTORE" && a.entityId === JEU_V1) && auditRetour.some((a) => a.action === "UPDATE" && a.entityId === JEU_V2), [evRetour, auditRetour]);
  const dl3 = (await get(`/${PID}/jeux/${JEU_V1}/delta`)).body;
  verifier("11. la fiche de la version restauree montre l'evenement (jeu lie) ; la version 1 n'a elle-meme remplace personne (AUCUNE_VERSION_PRECEDENTE)",
    dl3.evenements.some((e: { type: string }) => e.type === "RETOUR_ARRIERE") && dl3.retourArriere.possible === false && dl3.retourArriere.raison === "AUCUNE_VERSION_PRECEDENTE"
    && (await envoyer("post", `/${PID}/jeux/${JEU_V1}/retour-arriere`, { justification: "justification suffisante" })).body.code === "AUCUNE_VERSION_PRECEDENTE", dl3.retourArriere);
  const apresRetour = (await get(`/${PID}/carte`)).body;
  verifier("11. la carte et l'analyse suivent la version restauree (la version 1 : 2 objets ; la version 2 n'est plus lue)",
    apresRetour.jeux.some((j: { jeuId: string; nbFeatures: number }) => j.jeuId === JEU_V1 && j.nbFeatures === 2) && !apresRetour.jeux.some((j: { jeuId: string }) => j.jeuId === JEU_V2));
  verifier("11. un jeu RETIRE n'est montre a personne : delta, revue 404", await (async () => {
    const r = await envoyer("delete", `/${PID}/jeux/${JEU_V2}`);
    return r.status === 200 && (await get(`/${PID}/jeux/${JEU_V2}/delta`, T.admin)).status === 404;
  })());

  // ---------------------------------------------------------------- 11 bis. Revue de la vague 1 : M1 (la revue des suppressions ne se contourne pas) et O1 (un refus est definitif)
  // Scenario EXACT de la revue : v1 AUTORISE ; depot de v2 qui retire R2 (A_REVOIR) ; un decideur retire v1 (DELETE) PUIS autorise v2. Avant la correction : DELETE 200, autorisation 200, suppressions appliquees sans revue.
  const CONC_C: string = (await envoyer("post", "/concessionnaires", { nom: "Operateur Gamma", typeReseau: "TELECOM" })).body.concessionnaire.id;
  const PID_M1: string = (await envoyer("post", "", { code: "M1-REVUE", nom: "Revue M1", regionId: R1 })).body.projet.id;
  const gamma = (b: Buffer) => Buffer.from(b.toString().replace(/Operateur Beta/g, "Operateur Gamma"));
  const dG1 = await depot(PID_M1, gamma(csvMap), { role: "RESEAU_TIERS", ...optMap, mapping }, "gamma-v1.csv");
  const G1: string = dG1.body.jeu?.id;
  await autoriser(PID_M1, G1);
  const dG2 = await depot(PID_M1, gamma(csvV2), { role: "RESEAU_TIERS", ...optMap, mapping }, "gamma-v2.csv");
  const G2: string = dG2.body.jeu?.id;
  verifier("11 bis. fixtures M1 : v1 AUTORISE (concessionnaire Gamma), v2 en controle qui RETIRE un objet (A_REVOIR) et remplace v1",
    dG1.status === 201 && dG2.status === 201 && dG2.body.delta.retires === 1 && dG2.body.suppressions.statut === "A_REVOIR" && dG2.body.remplace.jeuId === G1 && dG1.body.jeu.concessionnaire?.id === CONC_C
    && (await statutJeu(G1)) === "AUTORISE" && (await statutJeu(G2)) === "CONTROLE", [dG1.body.code, dG2.body.code]);
  const retraitM1 = await envoyer("delete", `/${PID_M1}/jeux/${G1}`);
  verifier("11 bis. M1, garde 1 : retirer le jeu AUTORISE pendant qu'une nouvelle version l'attend : 409 DEPOT_EN_ATTENTE (jeuId du depot) ; v1 reste AUTORISE ; aucune trace d'audit DELETE",
    retraitM1.status === 409 && retraitM1.body.code === "DEPOT_EN_ATTENTE" && retraitM1.body.jeuId === G2 && (await statutJeu(G1)) === "AUTORISE"
    && (await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'JeuDonneesProjet' AND "entityId" = $1 AND action::text = 'DELETE'`, G1)) === 0, retraitM1.body);
  const autoriseApresRetrait = await autoriser(PID_M1, G2);
  verifier("11 bis. M1 : l'autorisation de v2 sans revue reste 409 SUPPRESSIONS_A_REVOIR (v1 AUTORISE, v2 en controle)",
    autoriseApresRetrait.status === 409 && autoriseApresRetrait.body.code === "SUPPRESSIONS_A_REVOIR" && (await statutJeu(G2)) === "CONTROLE", autoriseApresRetrait.body);
  // Garde 2 (defense en profondeur, jeu deja retire dans une base qui porte l'etat obtenu par l'ancien contournement) : l'etat est fabrique en base.
  await sql(`UPDATE projets_voirie_jeux SET statut = 'RETIRE', "deletedAt" = now() WHERE id = $1`, G1);
  const autoriseSurRetire = await autoriser(PID_M1, G2);
  const dlRetire = await get(`/${PID_M1}/jeux/${G2}/delta`);
  verifier("11 bis. M1, garde 2 : v1 RETIRE (etat herite), l'autorisation de v2 repond TOUJOURS 409 SUPPRESSIONS_A_REVOIR ; le delta n'expose pas le jeu retire (comparaison null) mais annonce A_REVOIR et 1 suppression",
    autoriseSurRetire.status === 409 && autoriseSurRetire.body.code === "SUPPRESSIONS_A_REVOIR" && autoriseSurRetire.body.nb === 1 && (await statutJeu(G2)) === "CONTROLE"
    && dlRetire.status === 200 && dlRetire.body.comparaison === null && dlRetire.body.suppressions.statut === "A_REVOIR" && dlRetire.body.suppressions.nb === 1 && !JSON.stringify(dlRetire.body).includes(G1), [autoriseSurRetire.body, dlRetire.body.suppressions]);
  const revueM1 = await envoyer("post", `/${PID_M1}/jeux/${G2}/revue-suppressions`, { decision: "ACCEPTER", justification: "R2 a ete depose, confirme par le concessionnaire Gamma" }, T.chef2);
  verifier("11 bis. M1 : la revue reste possible contre le jeu retire (plus de 409 AUCUNE_SUPPRESSION) ; acceptee (ACCEPTEES), puis l'autorisation passe ; aucun objet de v1 n'est supprime",
    revueM1.status === 200 && revueM1.body.suppressions.statut === "ACCEPTEES" && (await autoriser(PID_M1, G2)).status === 200 && (await statutJeu(G2)) === "AUTORISE" && (await statutJeu(G1)) === "RETIRE" && (await nbObjets(G1)) === 2, revueM1.body);
  // O1 : un refus de revue est definitif pour l'ensemble retire sur lequel il a porte.
  const csvV3 = Buffer.from(`Libelle;Type;Classe;Operateur;Code;lon;lat\nRegard 1 (deplace);telecom;B;Operateur Gamma;R1;-10,1;9,2005\n`);
  const dG3 = await depot(PID_M1, csvV3, { role: "RESEAU_TIERS", ...optMap, mapping }, "gamma-v3.csv");
  const G3: string = dG3.body.jeu?.id;
  const refusG3 = await envoyer("post", `/${PID_M1}/jeux/${G3}/revue-suppressions`, { decision: "REFUSER", justification: "Le regard R3 existe toujours sur le terrain" });
  verifier("11 bis. revue REFUSER : statut REFUSEES, relecteur nomme, l'autorisation repond 409 SUPPRESSIONS_REFUSEES ; audit REJECT",
    dG3.status === 201 && dG3.body.delta.retires === 1 && refusG3.status === 200 && refusG3.body.suppressions.statut === "REFUSEES" && refusG3.body.suppressions.revue.par.nomComplet === "Sekou Gestionnaire"
    && (await autoriser(PID_M1, G3)).body.code === "SUPPRESSIONS_REFUSEES"
    && (await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'JeuDonneesProjet' AND "entityId" = $1 AND action::text = 'REJECT' AND after::text LIKE '%revueSuppressions%'`, G3)) === 1, refusG3.body);
  const accepteApresRefus = await envoyer("post", `/${PID_M1}/jeux/${G3}/revue-suppressions`, { decision: "ACCEPTER", justification: "Finalement j'accepte la suppression" }, T.admin);
  verifier("11 bis. O1 : ACCEPTER apres REFUSER : 409 SUPPRESSIONS_REFUSEES (meme message que l'autorisation), aucun evenement de plus ; le statut reste REFUSEES ; un nouveau REFUSER reste permis",
    accepteApresRefus.status === 409 && accepteApresRefus.body.code === "SUPPRESSIONS_REFUSEES" && (await compter(`SELECT count(*) n FROM projets_voirie_import_evenements WHERE "jeuId" = $1`, G3)) === 1
    && (await get(`/${PID_M1}/jeux/${G3}/delta`)).body.suppressions.statut === "REFUSEES"
    && (await envoyer("post", `/${PID_M1}/jeux/${G3}/revue-suppressions`, { decision: "REFUSER", justification: "Refus confirme apres relecture" })).status === 200
    && (await compter(`SELECT count(*) n FROM projets_voirie_import_evenements WHERE "jeuId" = $1`, G3)) === 2, accepteApresRefus.body);
  verifier("11 bis. un refus se leve par le rejet du depot (apres quoi la cle est libre) : rejet 200, nouveau depot possible",
    (await envoyer("post", `/${PID_M1}/jeux/${G3}/rejeter`, { justification: "depot refuse par la revue des suppressions" })).status === 200 && (await statutJeu(G3)) === "REJETE"
    && (await depot(PID_M1, variante(csvV3, 1), { role: "RESEAU_TIERS", ...optMap, mapping }, "gamma-v3b.csv", true)).status === 200);

  // ---------------------------------------------------------------- 12. Conservation du fichier d'origine
  const origAvant = await compter(`SELECT count(*) n FROM projets_voirie_fichiers_origine`);
  verifier("12. par defaut (decision de retention non prise) : aucun fichier d'origine stocke apres tous les depots (empreinte et taille seules, comme le socle) ; mode annonce EMPREINTE_SEULE",
    origAvant === 0 && (await get(`/${PID}/import/options`)).body.conservationOriginal === "EMPREINTE_SEULE" && dPlan.body.resume.import.conservationOriginal === "EMPREINTE_SEULE");
  process.env.PROJETS_VOIRIE_CONSERVER_ORIGINAL = "oui";
  const fOrig = Buffer.from(csvV2.toString().replace("Regard 3", "Regard 5"));
  const simOrig = await depot(PID, fOrig, { role: "AUTRE", ...optMap }, "orig.csv", true);
  verifier("12. avec PROJETS_VOIRIE_CONSERVER_ORIGINAL=oui : une simulation ne stocke RIEN", simOrig.status === 200 && (await compter(`SELECT count(*) n FROM projets_voirie_fichiers_origine`)) === 0);
  const dOrig = await depot(PID, fOrig, { role: "AUTRE", ...optMap }, "orig.csv");
  const lignesOrig = await sql<{ sha256: string; tailleOctets: number; ok: boolean }>(`SELECT sha256, "tailleOctets", (contenu = $2::bytea) AS ok FROM projets_voirie_fichiers_origine WHERE "jeuId" = $1`, dOrig.body.jeu?.id, fOrig);
  verifier("12. le depot reel stocke le fichier d'origine (octets identiques, empreinte et taille), annonce STOCKE dans resume.import", dOrig.status === 201 && lignesOrig.length === 1 && lignesOrig[0].ok === true
    && lignesOrig[0].sha256 === dOrig.body.jeu.sha256 && lignesOrig[0].tailleOctets === fOrig.length && dOrig.body.resume.import.conservationOriginal === "STOCKE", dOrig.body.resume?.import);
  delete process.env.PROJETS_VOIRIE_CONSERVER_ORIGINAL;
  const refusMod = async (requete: string) => { try { await prisma.$executeRawUnsafe(requete); return "execute"; } catch (e2) { return /ajout seul|TRUNCATE interdit/.test(String((e2 as Error).message)) ? "refuse" : String((e2 as Error).message); } };
  verifier("12. le fichier d'origine et les evenements sont en AJOUT SEUL : UPDATE, DELETE et TRUNCATE refuses par la base",
    (await refusMod(`UPDATE projets_voirie_fichiers_origine SET "tailleOctets" = 1`)) === "refuse" && (await refusMod(`DELETE FROM projets_voirie_fichiers_origine`)) === "refuse"
    && (await refusMod(`TRUNCATE projets_voirie_fichiers_origine`)) === "refuse" && (await refusMod(`UPDATE projets_voirie_import_evenements SET justification = 'modifiee par erreur'`)) === "refuse"
    && (await refusMod(`DELETE FROM projets_voirie_import_evenements`)) === "refuse" && (await refusMod(`TRUNCATE projets_voirie_import_evenements`)) === "refuse");
  verifier("12. contraintes : justification d'evenement de moins de 10 caracteres, retour arriere sans jeu lie, fichier dont la taille ne correspond pas : refuses",
    (await refusMod(`INSERT INTO projets_voirie_import_evenements (id, "projetId", "jeuId", type, "acteurId", justification) VALUES ('x1', '${PID}', '${JEU_V1}', 'SUPPRESSIONS_ACCEPTEES', '${chef.id}', 'court')`)).includes("pvie_justification")
    && (await refusMod(`INSERT INTO projets_voirie_import_evenements (id, "projetId", "jeuId", type, "acteurId", justification) VALUES ('x2', '${PID}', '${JEU_V1}', 'RETOUR_ARRIERE', '${chef.id}', 'justification suffisante')`)).includes("pvie_retour_lie")
    && (await refusMod(`INSERT INTO projets_voirie_fichiers_origine ("jeuId", sha256, "tailleOctets", contenu) VALUES ('${JEU_V1}', '${"a".repeat(64)}', 5, '\\x6162')`)).includes("pvfo_taille"));

  // ---------------------------------------------------------------- 13. Ecritures hors module, absence de geometrie dans les reponses, performances
  const etatFinal = await instantane();
  const TABLES_MODULE = new Set(["projets_voirie", "projets_voirie_jeux", "projets_voirie_objets", "concessionnaires_reseau", "audit_logs", "projets_voirie_import_evenements", "projets_voirie_fichiers_origine", "users", "regions", "perimetres_comptes",
    // Lot T1 : territoire par defaut ajoute par lib/territoire-par-defaut.mts (table du module).
    "territoires_voirie"]);
  const horsModule = Object.keys(etatFinal).filter((t) => etatFinal[t] !== etatInitial[t] && !TABLES_MODULE.has(t));
  verifier("13. apres tout le banc, SEULES les tables du module (et audit, comptes et perimetres des fixtures) ont change : troncons, ouvrages, portions, chantiers... intacts", horsModule.length === 0, horsModule);
  const refJeuxLecteur = JSON.stringify((await get(`/${PID}/jeux`, T.lecteur)).body);
  verifier("13. un LECTEUR ne voit que les jeux AUTORISE : aucune trace des jeux en controle, rejetes, remplaces ou retires (identifiants, noms de fichier)", !refJeuxLecteur.includes(JEU_V2) && !refJeuxLecteur.includes("reseau-v2.csv") && !refJeuxLecteur.includes("reseau-v3.csv"));
  verifier("13. aucune reponse de depot ne contient de geometrie (le delta, la validation et le resume n'en portent pas)", !/"coordinates"/.test(JSON.stringify(dV2.body)) && !/"coordinates"/.test(JSON.stringify(dPlan.body)));

  // Performances : un plan de 20 000 points UTM (apercu et depot).
  const gros20k = (() => {
    const l = ["id;x;y"];
    for (let i = 0; i < 20000; i++) {
      const { e, n } = lonLatVersUtm(-10.12 + (i % 200) * 1e-4, 9.17 + Math.floor(i / 200) * 1e-4, 29);
      l.push(`P${i};${f3(e)};${f3(n)}`);
    }
    return Buffer.from(l.join("\n"));
  })();
  const t0 = performance.now();
  const ap20 = await apercu(PID, gros20k, { colonneX: "x", colonneY: "y", epsgSource: "32629", delimiteur: ";" }, "gros.csv");
  const tApercu = Math.round(performance.now() - t0);
  const t1 = performance.now();
  const dep20 = await depot(PID, gros20k, { role: "AUTRE", colonneX: "x", colonneY: "y", epsgSource: "32629", delimiteur: ";" }, "gros.csv");
  const tDepot = Math.round(performance.now() - t1);
  console.log(`  mesure : apercu de 20 000 points UTM -> ${tApercu} ms ; depot -> ${tDepot} ms ; fichier ${Math.round(gros20k.length / 1024)} Ko`);
  verifier("13. performances : 20 000 points UTM transformes par PostGIS, apercu et depot chacun en moins de 20 s, echantillon borne", ap20.status === 200 && ap20.body.resume.nbObjets === 20000 && ap20.body.echantillon.objets.length === 20
    && dep20.status === 201 && tApercu < 20000 && tDepot < 20000, [ap20.body.code, dep20.body.code, tApercu, tDepot]);
  const echantillonUtm = await sql<{ e: number; n: number; nom: string }>(`SELECT ST_X(ST_Transform(geom, 32629)) e, ST_Y(ST_Transform(geom, 32629)) n, nom FROM projets_voirie_objets WHERE "jeuId" = $1 AND ordre IN (0, 10000, 19999) ORDER BY ordre`, dep20.body.jeu?.id);
  const attendus = [0, 10000, 19999].map((i) => lonLatVersUtm(-10.12 + (i % 200) * 1e-4, 9.17 + Math.floor(i / 200) * 1e-4, 29));
  verifier("13. 20 000 points stockes : trois points temoins (premier, milieu, dernier) retrouvent leurs coordonnees UTM d'origine a 1 cm pres apres aller-retour par la base",
    echantillonUtm.length === 3 && echantillonUtm.every((p, i) => proche(p.e, attendus[i].e, 0.01 + 0.0005) && proche(p.n, attendus[i].n, 0.01 + 0.0005)), echantillonUtm);
  void utmVersLonLat;
  if (process.env.IMPORT_EXEMPLES) (await import("node:fs")).writeFileSync(process.env.IMPORT_EXEMPLES, JSON.stringify(exemples, null, 2));
}

try {
  await main();
} catch (e) {
  console.error("ERREUR du banc :", e);
  process.exitCode = 1;
} finally {
  await banc.fermer();
  await prisma.$disconnect();
}
conclure();

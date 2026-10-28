// Banc d'integration du module PROJETS DE VOIRIE ET RESEAUX contre un vrai PostGIS (contrat : docs/projets-voirie/CONTRAT.md, v2).
// Voir tests-integration/README.md. Lancer (DATABASE_URL pointe sur `replay`) :
//   npx tsx tests-integration/projets-voirie.integration.mts
// Avec PV_EXEMPLES=<fichier.json>, les reponses reelles servant d'exemples a docs/projets-voirie/API.md y sont ecrites.
//
// Tout passe par les routes reelles montees comme en production (`createApp`), des jetons signes par des secrets aleatoires, le role,
// le module et le perimetre LUS EN BASE, le SQL reel (PostGIS : ST_MakeValid, ST_UnaryUnion, ST_Buffer, ST_Intersection), les
// contraintes et declencheurs reels, dans le clone jetable `essai_projets_voirie`.
//
// DONNEES 100 % SYNTHETIQUES : le plan et les reseaux sont des segments inventes, construits en metres dans le repere UTM 29N puis
// transformes en WGS 84 par PostGIS. Le CAS DE RESULTAT CONNU du contrat (section 7) :
//   axe A  : (0,0)-(200,0)       axe B : (200,0)-(200,150)   (carrefour en (200,0))
//   chaussee 7 m (demi 3,5), emprise 15 m (demi 7,5)
//   reseau 1 (classe B) : L2 a 2 m (60 m) ; L6 a 6 m (60 m) ; L9 a 9 m (60 m) ; L2 repete deux fois (meme tracé, sens inverse compris) ;
//                          P perpendiculaire (40 m, coupe l'axe A une fois) ; K a 5 m du carrefour (10 m, coupe l'axe B une fois)
//   reseau 2 (classe inconnue) : W a 2 m de l'axe, de l'autre cote (60 m)
//   attendu, tracés fusionnes : chaussee R1 = 60 + 7 (P) + 7 (K contre l'axe B) = 74 ; emprise R1 = 60 + 60 + 15 + 10 = 145 ; 2 croisements ;
//   longueur fusionnee R1 = 60 + 60 + 60 + 40 + 10 = 230 ; somme des objets = 350 ; R2 : chaussee 60, emprise 60, proximite a verifier.
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure, proche } from "./lib/verdict.ts";

const banc = await ouvrirBancClone("essai_projets_voirie");
const { prisma } = await banc.imp("lib/prisma");
const { createApp } = await banc.imp("app");
const { signAccessToken } = await banc.imp("utils/jwt");
const request = (await import("supertest")).default;

const app = createApp();
const BASE = "/api/v2/projets-voirie";
const O = { x: 380000, y: 1015000 };

/** Requetes SQL a parametres. */
const sql = <T = Record<string, unknown>>(texte: string, ...v: unknown[]) => prisma.$queryRawUnsafe(texte, ...v) as Promise<T[]>;
const compter = async (texte: string, ...v: unknown[]) => Number((await sql<{ n: bigint }>(texte, ...v))[0].n);

/** Convertit des points (x, y) en metres, repere local, en coordonnees WGS 84 [lon, lat] par PostGIS. */
async function wgs(pts: [number, number][]): Promise<[number, number][]> {
  const wkt = `LINESTRING(${pts.map(([x, y]) => `${O.x + x} ${O.y + y}`).join(",")})`;
  const r = await sql<{ g: string }>(`SELECT ST_AsGeoJSON(ST_Transform(ST_SetSRID(ST_GeomFromText($1), 32629), 4326), 9) AS g`, wkt);
  return JSON.parse(r[0].g).coordinates;
}

type Ligne = { nom: string; coords: [number, number][]; props?: Record<string, unknown> };
async function geojson(lignes: Ligne[]): Promise<Buffer> {
  const features = [];
  for (const l of lignes) features.push({ type: "Feature", properties: { name: l.nom, ...(l.props ?? {}) }, geometry: { type: "LineString", coordinates: await wgs(l.coords) } });
  return Buffer.from(JSON.stringify({ type: "FeatureCollection", features }));
}
async function kml(lignes: Ligne[]): Promise<Buffer> {
  let corps = "";
  for (const l of lignes) {
    const c = (await wgs(l.coords)).map(([lo, la]) => `${lo},${la},0`).join(" ");
    corps += `<Placemark><name>${l.nom}</name><LineString><coordinates>${c}</coordinates></LineString></Placemark>`;
  }
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>${corps}</Document></kml>`);
}

const AXES: Ligne[] = [
  { nom: "Axe A", coords: [[0, 0], [200, 0]] },
  { nom: "Axe B", coords: [[200, 0], [200, 150]] },
];
const R1_BASE: Ligne[] = [
  { nom: "Fibre-Marqueur L2", coords: [[20, 2], [80, 2]], props: { circuit: "C1", brins: 12 } },
  { nom: "Fibre-Marqueur L6", coords: [[20, 6], [80, 6]], props: { circuit: "C2" } },
  { nom: "Fibre-Marqueur L9", coords: [[20, 9], [80, 9]], props: { circuit: "C3" } },
  { nom: "Fibre-Marqueur L2 bis", coords: [[20, 2], [80, 2]], props: { circuit: "C4" } },
  { nom: "Fibre-Marqueur L2 ter", coords: [[80, 2], [20, 2]], props: { circuit: "C5" } },
  { nom: "Fibre-Marqueur P", coords: [[150, -20], [150, 20]], props: { circuit: "C6" } },
  { nom: "Fibre-Marqueur K", coords: [[195, 5], [205, 5]], props: { circuit: "C7" } },
];
const R2: Ligne[] = [{ nom: "Eau-Marqueur W", coords: [[20, -2], [80, -2]] }];

async function main() {
  // ---------------------------------------------------------------- Fixtures
  const mk = (email: string, nomComplet: string, role: string, modules: string[] = ["projets-voirie"]) =>
    prisma.user.create({ data: { email, nomComplet, passwordHash: "x", role, modulesAutorises: modules } });
  const admin = await mk("admin@banc.invalid", "Mariama Admin", "ADMIN", []);
  const chef = await mk("chef@banc.invalid", "Sekou Gestionnaire", "GESTIONNAIRE");
  const lecteur = await mk("lecteur@banc.invalid", "Lecteur banc", "LECTEUR");
  const sansModule = await mk("sans@banc.invalid", "Sans module", "GESTIONNAIRE", ["troncons"]);
  const regional1 = await mk("reg1@banc.invalid", "Regional 1", "GESTIONNAIRE");
  const R1 = (await prisma.region.create({ data: { nom: "Region banc 1" } })).id;
  const R2id = (await prisma.region.create({ data: { nom: "Region banc 2" } })).id;
  await sql(`INSERT INTO perimetres_comptes ("userId", "regionId", "accordeParId") VALUES ($1, $2, $3)`, regional1.id, R1, admin.id);
  const jeton = (u: { id: string; role: string; email: string }) => signAccessToken({ sub: u.id, role: u.role, email: u.email });
  const T = { admin: jeton(admin), chef: jeton(chef), lecteur: jeton(lecteur), sans: jeton(sansModule), reg1: jeton(regional1) };

  /** Etat de toutes les tables de `public` (nombre de lignes) : la preuve que rien n'a bouge ailleurs que dans le module. */
  async function instantane(): Promise<Record<string, number>> {
    const tables = await sql<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND left(table_name, 1) <> '_' ORDER BY 1`);
    const sortie: Record<string, number> = {};
    for (const t of tables) sortie[t.table_name] = await compter(`SELECT count(*) n FROM "${t.table_name}"`);
    return sortie;
  }
  const etatInitial = await instantane();
  /** Reponses reelles, ecrites dans le fichier de PV_EXEMPLES s'il est demande (docs/projets-voirie/API.md). */
  const exemples: Record<string, unknown> = {};

  const get = (chemin: string, t = T.chef) => request(app).get(`${BASE}${chemin}`).set("Authorization", `Bearer ${t}`);
  const envoyer = (methode: "post" | "patch" | "delete", chemin: string, corps?: unknown, t = T.chef) => {
    const r = request(app)[methode](`${BASE}${chemin}`).set("Authorization", `Bearer ${t}`);
    return corps === undefined ? r : r.send(corps as object);
  };
  function depot(projetId: string, fichier: Buffer, champs: Record<string, string | undefined>, nom = "fichier.kml", simuler = false, t = T.chef) {
    const r = request(app).post(`${BASE}/${projetId}/jeux${simuler ? "?simuler=true" : ""}`).set("Authorization", `Bearer ${t}`);
    for (const [k, v] of Object.entries(champs)) if (v !== undefined) r.field(k, v);
    return r.attach("fichier", fichier, { filename: nom });
  }
  const JUSTIF = "Controle effectue avec le chef de projet";
  const autoriser = (pid: string, jid: string, t = T.chef) => envoyer("post", `/${pid}/jeux/${jid}/autoriser`, { justification: JUSTIF }, t);

  console.log("\n== Projets de voirie et reseaux : banc PostGIS ==");

  // ---------------------------------------------------------------- 1. Gardes d'acces
  const anonyme = await request(app).get(BASE);
  verifier("1. sans jeton : 401", anonyme.status === 401, anonyme.status);
  const refusModule = await get("", T.sans);
  verifier("1. sans la cle de module `projets-voirie` : 403 sur la liste", refusModule.status === 403, refusModule.status);
  verifier("1. avec la cle de module, un LECTEUR lit la liste (200)", (await get("", T.lecteur)).status === 200);
  verifier("1. un LECTEUR ne peut pas creer un projet (403)", (await envoyer("post", "", { code: "X-1", nom: "X" }, T.lecteur)).status === 403);

  // ---------------------------------------------------------------- 2. Projets
  const cree = await envoyer("post", "", { code: "kissi-voirie-2026", nom: "Voirie de Kissidougou", commune: "Kissidougou", prefecture: "Kissidougou", regionId: R1 });
  const PID: string = cree.body.projet?.id;
  verifier("2. creation : 201, code mis en majuscules, largeurs par defaut 15 / 7, theoriques", cree.status === 201 && cree.body.projet.code === "KISSI-VOIRIE-2026"
    && cree.body.projet.largeurEmpriseM === 15 && cree.body.projet.largeurChausseeM === 7 && cree.body.projet.statutParametres === "THEORIQUE", cree.body);
  verifier("2. code deja utilise : 409 CODE_DEJA_UTILISE (casse ignoree)", (await envoyer("post", "", { code: "Kissi-Voirie-2026", nom: "Autre" })).body.code === "CODE_DEJA_UTILISE");
  verifier("2. entrees hostiles : code invalide, largeur incoherente, champ inconnu : 400, jamais 500",
    (await envoyer("post", "", { code: "a b", nom: "x" })).status === 400
    && (await envoyer("post", "", { code: "OK-1", nom: "x", largeurChausseeM: 20, largeurEmpriseM: 10 })).body.code === "LARGEURS_INCOHERENTES"
    && (await envoyer("post", "", { code: "OK-2", nom: "x", admin: true })).status === 400);
  const regionInconnue = await envoyer("post", "", { code: "OK-3", nom: "x", regionId: 99999 });
  verifier("2. region inconnue : 400 REGION_INCONNUE", regionInconnue.status === 400 && regionInconnue.body.code === "REGION_INCONNUE", regionInconnue.body);

  const modif = await envoyer("patch", `/${PID}`, { largeurChausseeM: 8 });
  verifier("2. modifier une largeur remet les parametres a THEORIQUE", modif.status === 200 && modif.body.projet.largeurChausseeM === 8 && modif.body.projet.statutParametres === "THEORIQUE");
  verifier("2. valider les parametres est reserve a ADMIN : GESTIONNAIRE 403, ADMIN 200",
    (await envoyer("patch", `/${PID}`, { statutParametres: "VALIDE" })).status === 403
    && (await envoyer("patch", `/${PID}`, { statutParametres: "VALIDE" }, T.admin)).body.projet?.statutParametres === "VALIDE");
  const retheorique = await envoyer("patch", `/${PID}`, { largeurChausseeM: 7 });
  verifier("2. ... et toute nouvelle modification de largeur le remet a THEORIQUE", retheorique.body.projet?.statutParametres === "THEORIQUE" && retheorique.body.projet?.largeurChausseeM === 7);

  // ---------------------------------------------------------------- 3. Concessionnaires
  const orange = await envoyer("post", "/concessionnaires", { nom: "Operateur Telecom Synthetique", typeReseau: "TELECOM", contact: "contact@exemple.invalid" });
  const seeg = await envoyer("post", "/concessionnaires", { nom: "Societe des Eaux Synthetique", typeReseau: "EAU_POTABLE" });
  verifier("3. concessionnaires crees (201)", orange.status === 201 && seeg.status === 201, [orange.body, seeg.body]);
  verifier("3. nom deja connu, casse ignoree : 409 CONCESSIONNAIRE_DEJA_CONNU", (await envoyer("post", "/concessionnaires", { nom: "operateur telecom synthetique", typeReseau: "TELECOM" })).body.code === "CONCESSIONNAIRE_DEJA_CONNU");
  const listeConc = (await get("/concessionnaires")).body.concessionnaires;
  verifier("3. liste des concessionnaires (2) triee par nom", listeConc.length === 2 && listeConc[0].nom < listeConc[1].nom);
  const CONC1: string = orange.body.concessionnaire.id;
  const CONC2: string = seeg.body.concessionnaire.id;

  // ---------------------------------------------------------------- 4. Depot du plan d'axes : simulation, quarantaine, idempotence
  const fAxes = await kml(AXES);
  const avant = { jeux: await compter(`SELECT count(*) n FROM projets_voirie_jeux`), objets: await compter(`SELECT count(*) n FROM projets_voirie_objets`), audit: await compter(`SELECT count(*) n FROM audit_logs`) };
  const sim = await depot(PID, fAxes, { role: "AXES_TRAVAUX" }, "axes.kml", true);
  verifier("4. simulation : 200, simulation=true, jeu sans identifiant, 2 objets, CRS explicite, delta nul",
    sim.status === 200 && sim.body.simulation === true && sim.body.jeu.id === null && sim.body.resume.nbObjets === 2 && sim.body.resume.crs.cible === "EPSG:4326"
    && sim.body.resume.crs.methode === "aucune transformation" && sim.body.delta === null && sim.body.jeu.statut === "CONTROLE", sim.body);
  const apresSim = { jeux: await compter(`SELECT count(*) n FROM projets_voirie_jeux`), objets: await compter(`SELECT count(*) n FROM projets_voirie_objets`), audit: await compter(`SELECT count(*) n FROM audit_logs`) };
  verifier("4. la simulation n'ecrit RIEN : ni jeu, ni objet, ni audit", JSON.stringify(avant) === JSON.stringify(apresSim), { avant, apresSim });

  const dAxes = await depot(PID, fAxes, { role: "AXES_TRAVAUX", dateDonnees: "2026-10-20", origineFichier: "plan fourni par l'entreprise d'execution (essai)", methode: "plan CAO (essai)" }, "axes.kml");
  const JEU_AXES: string = dAxes.body.jeu?.id;
  verifier("4. depot reel : 201, jeu en CONTROLE (quarantaine), version 1, confidentialite RESTREINT_PROJET, nature AXE, 2 objets, longueur fusionnee ~ 350 m",
    dAxes.status === 201 && dAxes.body.simulation === false && dAxes.body.jeu.statut === "CONTROLE" && dAxes.body.jeu.nonAutorise === true && dAxes.body.jeu.version === 1
    && dAxes.body.jeu.confidentialite === "RESTREINT_PROJET" && dAxes.body.jeu.natureObjets === "AXE" && dAxes.body.resume.nbObjets === 2
    && proche(dAxes.body.resume.longueurTraceFusionneM, 350, 1.5) && dAxes.body.jeu.classePrecision === null && dAxes.body.jeu.precisionHorizontaleM === null, dAxes.body);
  verifier("4. aucune precision inventee : classe, precisions horizontale et verticale restent nulles", dAxes.body.jeu.precisionVerticaleM === null && dAxes.body.jeu.classePrecision === null);
  exemples["simulation_axes"] = sim.body;
  exemples["depot_axes"] = dAxes.body;
  const doublon = await depot(PID, fAxes, { role: "AXES_TRAVAUX" }, "axes-copie.kml");
  verifier("4. meme fichier : 409 JEU_DEJA_CHARGE avec le jeuId existant, aucun objet en double",
    doublon.status === 409 && doublon.body.code === "JEU_DEJA_CHARGE" && doublon.body.jeuId === JEU_AXES && (await compter(`SELECT count(*) n FROM projets_voirie_objets WHERE "jeuId" = $1`, JEU_AXES)) === 2, doublon.body);
  exemples["erreur_jeu_deja_charge"] = doublon.body;
  const doublonSim = await depot(PID, fAxes, { role: "AXES_TRAVAUX" }, "axes-copie.kml", true);
  verifier("4. ... y compris en simulation (le conflit est annonce avant la confirmation)", doublonSim.status === 409 && doublonSim.body.code === "JEU_DEJA_CHARGE");

  const analyseVide = (await get(`/${PID}/analyse`)).body;
  verifier("4. un jeu en CONTROLE n'entre pas dans l'analyse : aucun axe, totaux a zero, limite explicite, limites obligatoires presentes",
    analyseVide.axes.nb === 0 && analyseVide.conflits.total.empriseM === 0 && analyseVide.limites.some((l: string) => /Aucun axe/.test(l))
    && analyseVide.limites.includes("Conflit vertical non évalué : profondeur et altitude absentes."), analyseVide.limites);
  const carteDefaut = (await get(`/${PID}/carte`)).body;
  verifier("4. la carte par defaut ne montre que les jeux AUTORISE (aucun encore)", carteDefaut.jeux.length === 0);
  const carteInclus = (await get(`/${PID}/carte?inclureNonAutorises=true`)).body;
  verifier("4. inclureNonAutorises=true : le jeu en controle apparait, marque nonAutorise", carteInclus.jeux.length === 1 && carteInclus.jeux[0].nonAutorise === true && carteInclus.jeux[0].features.length === 2);

  // Autorisation
  verifier("4. autoriser sans justification suffisante : 400 JUSTIFICATION_INVALIDE",
    (await envoyer("post", `/${PID}/jeux/${JEU_AXES}/autoriser`, { justification: "ok" })).body.code === "JUSTIFICATION_INVALIDE"
    && (await envoyer("post", `/${PID}/jeux/${JEU_AXES}/autoriser`, {})).status === 400);
  verifier("4. un LECTEUR ne peut ni autoriser ni rejeter (403)", (await autoriser(PID, JEU_AXES, T.lecteur)).status === 403
    && (await envoyer("post", `/${PID}/jeux/${JEU_AXES}/rejeter`, { justification: JUSTIF }, T.lecteur)).status === 403);
  const auto = await autoriser(PID, JEU_AXES);
  exemples["autorisation"] = auto.body;
  verifier("4. autorisation : 200, statut AUTORISE, decision (qui, quand, pourquoi) enregistree",
    auto.status === 200 && auto.body.jeu.statut === "AUTORISE" && auto.body.jeu.decision?.par?.nomComplet === "Sekou Gestionnaire" && auto.body.jeu.decision?.justification === JUSTIF, auto.body);
  const auditAuto = (await sql<{ after: Record<string, unknown> }>(`SELECT after FROM audit_logs WHERE "entityType" = 'JeuDonneesProjet' AND "entityId" = $1 AND action = 'VALIDATE'`, JEU_AXES))[0];
  verifier("4. l'audit note que l'auteur du depot est aussi celui qui autorise (memePersonne) sans avoir bloque", auditAuto?.after?.memePersonne === true, auditAuto);
  verifier("4. un jeu deja autorise ne peut plus etre autorise ni rejete : 409 STATUT_INCOMPATIBLE", (await autoriser(PID, JEU_AXES)).body.code === "STATUT_INCOMPATIBLE");
  const dejaAxes = await depot(PID, fAxes, { role: "AXES_TRAVAUX" }, "axes.kml");
  verifier("4. le meme fichier reste 409 JEU_DEJA_CHARGE une fois AUTORISE", dejaAxes.body.code === "JEU_DEJA_CHARGE");

  // ---------------------------------------------------------------- 5. Reseaux : refus de saisie, depot, quarantaine
  const fR1 = await geojson(R1_BASE);
  verifier("5. RESEAU_TIERS sans concessionnaire : 400 CONCESSIONNAIRE_REQUIS ; concessionnaire inconnu : 404 ; role AUTRE avec concessionnaire : 400",
    (await depot(PID, fR1, { role: "RESEAU_TIERS" }, "r1.geojson")).body.code === "CONCESSIONNAIRE_REQUIS"
    && (await depot(PID, fR1, { role: "RESEAU_TIERS", concessionnaireId: "inexistant" }, "r1.geojson")).body.code === "CONCESSIONNAIRE_INTROUVABLE"
    && (await depot(PID, fR1, { role: "AUTRE", concessionnaireId: CONC1 }, "r1.geojson")).status === 400);
  verifier("5. nature incompatible avec le role : 400 NATURE_INCOMPATIBLE (AXE pour un reseau, CIRCUIT_LOGIQUE pour des axes)",
    (await depot(PID, fR1, { role: "RESEAU_TIERS", concessionnaireId: CONC1, natureObjets: "AXE" }, "r1.geojson")).body.code === "NATURE_INCOMPATIBLE"
    && (await depot(PID, await kml([{ nom: "Autre axe", coords: [[0, 300], [100, 300]] }]), { role: "AXES_TRAVAUX", natureObjets: "CIRCUIT_LOGIQUE" })).body.code === "NATURE_INCOMPATIBLE");

  const simR1 = await depot(PID, fR1, { role: "RESEAU_TIERS", concessionnaireId: CONC1, classePrecision: "B" }, "r1.geojson", true);
  verifier("5. simulation du reseau 1 : 7 « circuits ou objets du fichier », trace double signale, longueur fusionnee ~ 230 m < somme ~ 350 m",
    simR1.status === 200 && simR1.body.resume.nbObjets === 7 && simR1.body.resume.libelleNbObjets === "circuits ou objets du fichier"
    && simR1.body.avertissements.some((a: { code: string; nb: number }) => a.code === "TRACES_DOUBLES" && a.nb === 2)
    && proche(simR1.body.resume.longueurTraceFusionneM, 230, 1.2) && proche(simR1.body.resume.longueurTotaleM, 350, 1.8), simR1.body.resume);
  const dR1 = await depot(PID, fR1, { role: "RESEAU_TIERS", concessionnaireId: CONC1, classePrecision: "B", precisionHorizontaleM: "3.5", dateDonnees: "2026-10-24", origineFichier: "recu de l'operateur (essai)", natureObjets: "CIRCUIT_LOGIQUE" }, "r1.geojson");
  const JEU_R1: string = dR1.body.jeu?.id;
  verifier("5. depot du reseau 1 : CONTROLE, confidentialite CONFIDENTIEL_CONCESSIONNAIRE par defaut, classe B, type TELECOM herite, nature CIRCUIT_LOGIQUE",
    dR1.status === 201 && dR1.body.jeu.statut === "CONTROLE" && dR1.body.jeu.confidentialite === "CONFIDENTIEL_CONCESSIONNAIRE" && dR1.body.jeu.classePrecision === "B"
    && dR1.body.jeu.typeReseau === "TELECOM" && dR1.body.jeu.natureObjets === "CIRCUIT_LOGIQUE" && dR1.body.jeu.precisionHorizontaleM === 3.5, dR1.body.jeu);
  const dR1sans = await depot(PID, await geojson([{ nom: "Sans origine", coords: [[0, 400], [50, 400]] }]), { role: "RESEAU_TIERS", concessionnaireId: CONC2 }, "sans-origine.geojson", true);
  verifier("5. origineFichier est facultatif : jamais bloquant, ni avertissement bloquant, en simulation comme en depot", dR1sans.status === 200 && dR1sans.body.avertissements.every((a: { code: string }) => !/ORIGINE|CONVENTION/.test(a.code)));
  const autoR1 = await autoriser(PID, JEU_R1);
  verifier("5. reseau 1 autorise", autoR1.status === 200 && autoR1.body.jeu.statut === "AUTORISE");

  const fR2 = await kml(R2);
  const dR2 = await depot(PID, fR2, { role: "RESEAU_TIERS", concessionnaireId: CONC2 }, "r2.kml");
  const JEU_R2: string = dR2.body.jeu?.id;
  verifier("5. reseau 2 (classe inconnue) en CONTROLE : classe nulle, nature INCONNUE par defaut", dR2.status === 201 && dR2.body.jeu.classePrecision === null && dR2.body.jeu.natureObjets === "INCONNUE" && dR2.body.jeu.statut === "CONTROLE");

  // Avant autorisation du reseau 2 : l'analyse officielle ne le compte pas ; avec inclureNonAutorises, si.
  const officielle = (await get(`/${PID}/analyse`)).body;
  const tol = (a: number, b: number) => proche(a, b, Math.max(0.6, b * 0.01));
  verifier("5. analyse officielle (reseau 2 encore en controle) : seul le reseau 1 compte - chaussee ~ 74, emprise ~ 145, 2 croisements",
    tol(officielle.conflits.total.chausseeM, 74) && tol(officielle.conflits.total.empriseM, 145) && officielle.conflits.total.croisements === 2
    && officielle.reseaux.parConcessionnaire.length === 1 && officielle.inclureNonAutorises === false, officielle.conflits.total);
  const avecNon = (await get(`/${PID}/analyse?inclureNonAutorises=true`)).body;
  verifier("5. inclureNonAutorises=true : le reseau 2 s'ajoute (chaussee ~ 134, emprise ~ 205), marque nonAutorise, et l'hypothese le dit",
    tol(avecNon.conflits.total.chausseeM, 134) && tol(avecNon.conflits.total.empriseM, 205)
    && avecNon.conflits.parConcessionnaire.some((c: { nonAutorise: boolean }) => c.nonAutorise === true)
    && avecNon.hypotheses.some((h: string) => /INCLUS/.test(h)), avecNon.conflits.total);
  await autoriser(PID, JEU_R2);

  // ---------------------------------------------------------------- 6. Analyse : CAS DE RESULTAT CONNU
  const an = (await get(`/${PID}/analyse`)).body;
  const c = an.conflits;
  verifier("6. total : chaussee ~ 134 m, emprise ~ 205 m, hors chaussee ~ 71 m, 2 croisements", tol(c.total.chausseeM, 134) && tol(c.total.empriseM, 205) && tol(c.total.empriseHorsChausseeM, 71) && c.total.croisements === 2, c.total);
  const r1 = c.parConcessionnaire.find((x: { nom: string }) => x.nom === "Operateur Telecom Synthetique");
  const r2 = c.parConcessionnaire.find((x: { nom: string }) => x.nom === "Societe des Eaux Synthetique");
  verifier("6. concessionnaire 1 : un trace a 2 m est en chaussee, a 6 m en emprise seule, a 9 m hors emprise : chaussee ~ 74, emprise ~ 145, hors emprise ~ 85, classe B = conflit potentiel",
    tol(r1.chausseeM, 74) && tol(r1.empriseM, 145) && tol(r1.horsEmpriseM, 85) && r1.croisements === 2 && r1.qualification === "CONFLIT_POTENTIEL" && r1.classePrecision === "B", r1);
  verifier("6. concessionnaire 2 : classe inconnue => PROXIMITE A VERIFIER, jamais un conflit ; chaussee ~ 60, emprise ~ 60",
    tol(r2.chausseeM, 60) && tol(r2.empriseM, 60) && r2.qualification === "PROXIMITE_A_VERIFIER" && r2.classePrecision === null, r2);
  verifier("6. repartition par qualification : conflit potentiel (74 / 145 / 2) et proximite a verifier (60 / 60 / 0)",
    tol(c.total.parQualification.CONFLIT_POTENTIEL.chausseeM, 74) && tol(c.total.parQualification.CONFLIT_POTENTIEL.empriseM, 145) && c.total.parQualification.CONFLIT_POTENTIEL.croisements === 2
    && tol(c.total.parQualification.PROXIMITE_A_VERIFIER.chausseeM, 60) && c.total.parQualification.PROXIMITE_A_VERIFIER.croisements === 0, c.total.parQualification);
  verifier("6. longueurs des reseaux : trace fusionne R1 ~ 230 m (deux circuits superposes comptes une fois), somme ~ 350 m, 7 circuits ou objets",
    tol(an.reseaux.parConcessionnaire.find((x: { nom: string }) => x.nom.startsWith("Operateur")).longueurTraceFusionneM, 230)
    && tol(an.reseaux.parConcessionnaire.find((x: { nom: string }) => x.nom.startsWith("Operateur")).longueurSommeM, 350)
    && an.reseaux.parConcessionnaire.find((x: { nom: string }) => x.nom.startsWith("Operateur")).nbObjets === 7);
  const parType = Object.fromEntries(an.reseaux.parType.map((t: { typeReseau: string; longueurTraceFusionneM: number }) => [t.typeReseau, t.longueurTraceFusionneM]));
  verifier("6. longueurs par type de reseau : TELECOM ~ 230 m, EAU_POTABLE ~ 60 m", tol(parType.TELECOM, 230) && tol(parType.EAU_POTABLE, 60), parType);
  const axeA = c.parAxe.find((a: { axe: string }) => a.axe === "Axe A");
  const axeB = c.parAxe.find((a: { axe: string }) => a.axe === "Axe B");
  verifier("6. par axe : A = chaussee 60+7+60, B = chaussee 7 ; le carrefour (K) apparait dans la ligne des DEUX axes mais une seule fois dans le total",
    tol(axeA.chausseeM, 127) && tol(axeB.chausseeM, 7) && tol(axeA.empriseM, 60 + 15 + 10 + 60 + 60) && tol(axeB.empriseM, 10) && axeA.croisements === 1 && axeB.croisements === 1
    && axeA.empriseM + axeB.empriseM > c.total.empriseM, { axeA, axeB });
  verifier("6. par axe : la liste des objets de l'axe A porte les circuits touches, avec leur qualification", axeA.objets.length >= 5 && axeA.objets.every((o: { qualification: string }) => ["CONFLIT_POTENTIEL", "PROXIMITE_A_VERIFIER"].includes(o.qualification))
    && axeA.concessionnaires.length === 2 && axeA.objetsTronques === false);
  verifier("6. la longueur d'un axe est celle du tracé (A ~ 200 m, B ~ 150 m), 2 axes, 350 m au total", tol(axeA.longueurM, 200) && tol(axeB.longueurM, 150) && an.axes.nb === 2 && tol(an.axes.longueurM, 350));
  verifier("6. axes touches : 2 ; objets touches : au moins 7", c.total.axesTouches === 2 && c.total.objetsTouches >= 7, c.total.objetsTouches);
  verifier("6. les croisements sont 2 points (Point WGS 84) avec axe et qualification",
    c.croisements.features.length === 2 && c.croisements.nbTotal === 2 && c.croisements.features.every((f: { geometry: { type: string }; properties: { axe: string; statut: string } }) => f.geometry.type === "Point" && f.properties.axe && f.properties.statut === "A_VERIFIER"));
  verifier("6. zones : chaussee, emprise (hors chaussee) et hors emprise sont des MultiLineString disjointes non vides",
    c.zones.chaussee?.type === "MultiLineString" && c.zones.emprise?.type === "MultiLineString" && c.zones.hors?.type === "MultiLineString" && c.zones.tronque === false);
  verifier("6. chaque resultat porte statut A_VERIFIER, regle RC-2D-0.1 (largeurs, projection), version d'algorithme",
    an.statut === "A_VERIFIER" && an.regle.version === "RC-2D-0.1" && an.regle.chausseeM === 7 && an.regle.empriseM === 15 && an.regle.projection === "EPSG:32629" && typeof an.versionAlgorithme === "string"
    && c.parAxe.every((a: { statut: string }) => a.statut === "A_VERIFIER") && c.parConcessionnaire.every((x: { statut: string }) => x.statut === "A_VERIFIER") && c.total.statut === "A_VERIFIER");
  verifier("6. les trois limites obligatoires figurent toujours ; le texte cite les largeurs theoriques et les classes presentes",
    ["Conflit vertical non évalué : profondeur et altitude absentes.", "Aucun conflit détecté ne prouve l'absence de réseau.", "Résultat indicatif : aucune décision de déplacement n'en découle."].every((l) => an.limites.includes(l))
    && an.hypotheses.some((h: string) => /THÉORIQUES/.test(h)) && an.hypotheses.some((h: string) => /Classes de précision/.test(h) && /B \(1 jeu\)/.test(h) && /inconnue \(1 jeu\)/.test(h)));
  verifier("6. aucun texte ne presente N lignes comme N cables : « circuits ou objets du fichier »", JSON.stringify(an).includes("circuits ou objets du fichier") && an.hypotheses.some((h: string) => /jamais un nombre de câbles/.test(h)));
  verifier("6. aucun champ ni route de decision, d'ordre ou de deplacement dans la reponse", !/ordre_?travaux|deplacement_?ordonne|"decision"/i.test(JSON.stringify(an)));

  // Confrontation a l'ORACLE PLAN du noyau (analyse.noyau.ts), ecrit sans tampon polygonal ni PostGIS : memes segments en metres.
  const oracle = await banc.imp("projets-voirie/analyse.noyau");
  const axesPlan = AXES.map((l: Ligne) => l.coords);
  const uniques = R1_BASE.filter((l: Ligne) => !/L2 (bis|ter)$/.test(l.nom)).map((l: Ligne) => l.coords);
  const attendu = {
    chaussee: uniques.reduce((s: number, l: [number, number][]) => s + oracle.longueurDansBande(l, axesPlan, 3.5), 0),
    emprise: uniques.reduce((s: number, l: [number, number][]) => s + oracle.longueurDansBande(l, axesPlan, 7.5), 0),
    croisements: oracle.croisements(uniques, axesPlan).length,
    fusionne: oracle.longueurPhysique(R1_BASE.map((l: Ligne) => l.coords)),
  };
  verifier("6. PostGIS = oracle plan du noyau (ecrit autrement, sans tampon) pour le reseau 1 : chaussee, emprise, croisements et longueur fusionnee",
    proche(r1.chausseeM, attendu.chaussee, 0.5 + attendu.chaussee * 0.005) && proche(r1.empriseM, attendu.emprise, 0.5 + attendu.emprise * 0.005)
    && r1.croisements === attendu.croisements && proche(an.reseaux.parConcessionnaire.find((x: { nom: string }) => x.nom.startsWith("Operateur")).longueurTraceFusionneM, attendu.fusionne, 0.5 + attendu.fusionne * 0.005), attendu);
  verifier("6. ... et l'oracle retrouve les valeurs du contrat a la main (74 / 145 / 2 / 230)", proche(attendu.chaussee, 74, 1e-6) && proche(attendu.emprise, 145, 1e-6) && attendu.croisements === 2 && proche(attendu.fusionne, 230, 1e-6), attendu);

  const surcharge = (await get(`/${PID}/analyse?largeurChausseeM=1&largeurEmpriseM=3`)).body;
  verifier("6. largeurs surchargees sans les enregistrer : chaussee 1 m (demi 0,5) et emprise 3 m (demi 1,5) : seuls les traces a 2 m sortent de la chaussee ; surcharge=true",
    surcharge.parametres.surcharge === true && surcharge.parametres.largeurChausseeM === 1 && surcharge.conflits.total.chausseeM < 20 && surcharge.conflits.total.empriseM < 30
    && (await get(`/${PID}`)).body.projet.largeurChausseeM === 7, surcharge.conflits.total);
  verifier("6. largeurs incoherentes dans la requete : 400", (await get(`/${PID}/analyse?largeurChausseeM=20&largeurEmpriseM=10`)).status === 400 && (await get(`/${PID}/analyse?largeurChausseeM=abc`)).status === 400);

  // ---------------------------------------------------------------- 7. Versions : quarantaine, delta, remplacement, rejet
  const R1_V2 = [...R1_BASE.filter((l) => !l.nom.endsWith("L9")), { nom: "Fibre-Marqueur NOUVEAU", coords: [[100, 30], [140, 30]] as [number, number][], props: { circuit: "C8" } }];
  const fR1v2 = await geojson(R1_V2);
  const simV2 = await depot(PID, fR1v2, { role: "RESEAU_TIERS", concessionnaireId: CONC1, classePrecision: "B" }, "r1-v2.geojson", true);
  verifier("7. simulation d'une nouvelle version : delta = 1 ajoute, 1 retire, 6 identiques ; remplace le jeu autorise (version 1) ; version 2",
    simV2.status === 200 && simV2.body.delta?.ajoutes === 1 && simV2.body.delta?.retires === 1 && simV2.body.delta?.identiques === 6
    && simV2.body.remplace?.jeuId === JEU_R1 && simV2.body.remplace?.version === 1 && simV2.body.jeu.version === 2, simV2.body);
  exemples["simulation_nouvelle_version"] = simV2.body;
  const dV2 = await depot(PID, fR1v2, { role: "RESEAU_TIERS", concessionnaireId: CONC1, classePrecision: "B" }, "r1-v2.geojson");
  const JEU_V2: string = dV2.body.jeu?.id;
  verifier("7. depot de la version 2 : CONTROLE, remplaceId = version 1, l'ancienne reste AUTORISE (jamais de suppression automatique)",
    dV2.status === 201 && dV2.body.jeu.statut === "CONTROLE" && dV2.body.jeu.remplaceId === JEU_R1
    && (await sql<{ statut: string }>(`SELECT statut::text FROM projets_voirie_jeux WHERE id = $1`, JEU_R1))[0].statut === "AUTORISE"
    && (await compter(`SELECT count(*) n FROM projets_voirie_objets WHERE "jeuId" = $1`, JEU_R1)) === 7);
  const anApres = (await get(`/${PID}/analyse`)).body;
  verifier("7. tant que la version 2 n'est pas autorisee, l'analyse reste celle de la version 1 (chaussee ~ 134, emprise ~ 205)", tol(anApres.conflits.total.empriseM, 205) && tol(anApres.conflits.total.chausseeM, 134));
  const whatIf = (await get(`/${PID}/analyse?inclureNonAutorises=true`)).body;
  verifier("7. avec inclureNonAutorises, la version 2 REMPLACE la version 1 pour ce calcul (jamais les deux : pas de double compte) ; L9, hors emprise, retiree n'y change rien",
    whatIf.reseaux.parConcessionnaire.filter((x: { nom: string }) => x.nom.startsWith("Operateur")).length === 1 && whatIf.jeux.filter((j: { role: string; concessionnaire: { nom: string } | null }) => j.role === "RESEAU_TIERS" && j.concessionnaire?.nom.startsWith("Operateur")).length === 1
    && tol(whatIf.conflits.total.empriseM, 205));
  const attente = await depot(PID, await geojson([{ nom: "Encore une version", coords: [[100, 60], [140, 60]] }]), { role: "RESEAU_TIERS", concessionnaireId: CONC1 }, "r1-v3.geojson");
  verifier("7. un second depot pendant l'attente : 409 DEPOT_EN_ATTENTE avec le jeuId en attente", attente.status === 409 && attente.body.code === "DEPOT_EN_ATTENTE" && attente.body.jeuId === JEU_V2, attente.body);
  exemples["erreur_depot_en_attente"] = attente.body;
  const rejet = await envoyer("post", `/${PID}/jeux/${JEU_V2}/rejeter`, { justification: "Fichier incomplet, a refaire" });
  verifier("7. rejet : REJETE, justification et auteur enregistres, l'ancienne version reste AUTORISE",
    rejet.status === 200 && rejet.body.jeu.statut === "REJETE" && rejet.body.jeu.decision.justification === "Fichier incomplet, a refaire"
    && (await sql<{ statut: string }>(`SELECT statut::text FROM projets_voirie_jeux WHERE id = $1`, JEU_R1))[0].statut === "AUTORISE"
    && (await sql<{ n: bigint }>(`SELECT count(*) n FROM audit_logs WHERE action = 'REJECT' AND "entityId" = $1`, JEU_V2))[0].n === 1n);
  const dV3 = await depot(PID, fR1v2, { role: "RESEAU_TIERS", concessionnaireId: CONC1, classePrecision: "B" }, "r1-v2-bis.geojson");
  const JEU_V3: string = dV3.body.jeu?.id;
  verifier("7. un fichier rejete peut etre redepose : nouvelle version 3 (la numerotation ne revient pas en arriere), remplace toujours la version 1",
    dV3.status === 201 && dV3.body.jeu.version === 3 && dV3.body.jeu.remplaceId === JEU_R1, dV3.body.jeu);
  await autoriser(PID, JEU_V3);
  const statutsR1 = await sql<{ id: string; statut: string; version: number }>(`SELECT id, statut::text, version FROM projets_voirie_jeux WHERE "concessionnaireId" = $1 ORDER BY version`, CONC1);
  verifier("7. autoriser la version 3 passe la version 1 en REMPLACE ; la version 2 reste REJETE ; une seule AUTORISE ; les objets de la version 1 restent en base",
    statutsR1.map((s) => `${s.version}:${s.statut}`).join() === "1:REMPLACE,2:REJETE,3:AUTORISE" && (await compter(`SELECT count(*) n FROM projets_voirie_objets WHERE "jeuId" = $1`, JEU_R1)) === 7, statutsR1);
  const anV3 = (await get(`/${PID}/analyse`)).body;
  const r1v3 = anV3.conflits.parConcessionnaire.find((x: { nom: string }) => x.nom.startsWith("Operateur"));
  verifier("7. l'analyse suit la version 3 : emprise R1 inchangee ~ 145 (le nouveau trace est a 30 m : hors emprise) ; hors emprise ~ 85 - 60 + 40 = 65",
    tol(r1v3.empriseM, 145) && tol(r1v3.horsEmpriseM, 65), r1v3);
  const retour = await depot(PID, fR1, { role: "RESEAU_TIERS", concessionnaireId: CONC1, classePrecision: "B" }, "r1.geojson", true);
  verifier("7. retour a une version anterieure : le fichier de la version 1 (REMPLACE) peut etre redepose (version 4), delta contre la version 3",
    retour.status === 200 && retour.body.jeu.version === 4 && retour.body.delta?.ajoutes === 1 && retour.body.delta?.retires === 1, retour.body);

  // ---------------------------------------------------------------- 8. Reparation, role AUTRE, limites de route
  const bowtie = Buffer.from(JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "Emprise noeud papillon" }, geometry: { type: "Polygon", coordinates: [
    await wgs([[0, 0], [100, 100], [100, 0], [0, 100], [0, 0]]),
  ] } }] }));
  const simBow = await depot(PID, bowtie, { role: "LIMITES_ROUTE" }, "limites.geojson", true);
  verifier("8. un polygone en noeud papillon est REPARE par PostGIS et signale (GEOMETRIES_REPAREES), nature EMPRISE, RESTREINT_PROJET",
    simBow.status === 200 && simBow.body.avertissements.some((a: { code: string; nb: number }) => a.code === "GEOMETRIES_REPAREES" && a.nb === 1) && simBow.body.jeu.natureObjets === "EMPRISE" && simBow.body.jeu.confidentialite === "RESTREINT_PROJET", simBow.body.avertissements);
  const dBow = await depot(PID, bowtie, { role: "LIMITES_ROUTE" }, "limites.geojson");
  const valide = await sql<{ ok: boolean }>(`SELECT bool_and(ST_IsValid(geom)) ok FROM projets_voirie_objets WHERE "jeuId" = $1`, dBow.body.jeu.id);
  verifier("8. la geometrie conservee est valide (contrainte de la base)", valide[0].ok === true);
  await autoriser(PID, dBow.body.jeu.id);
  verifier("8. limites de route autorisees : l'analyse dit qu'elles ne servent pas encore au calcul", (await get(`/${PID}/analyse`)).body.limites.some((l: string) => /limites de route/.test(l)));
  const autre1 = await depot(PID, await geojson([{ nom: "Libre 1", coords: [[0, 500], [10, 500]] }]), { role: "AUTRE" }, "libre1.geojson");
  const autre2 = await depot(PID, await geojson([{ nom: "Libre 2", coords: [[0, 600], [10, 600]] }]), { role: "AUTRE" }, "libre2.geojson");
  verifier("8. le role AUTRE admet plusieurs fichiers en attente (pas de remplacement)", autre1.status === 201 && autre2.status === 201 && autre1.body.jeu.version === 1 && autre2.body.jeu.version === 1);

  // ---------------------------------------------------------------- 9. Carte
  const carte = (await get(`/${PID}/carte`)).body;
  exemples["carte"] = { ...carte, jeux: carte.jeux.map((j: { features: unknown[] }) => ({ ...j, features: j.features.slice(0, 1) })) };
  verifier("9. carte : couches des jeux AUTORISE seulement (axes, reseau 1 v3, reseau 2, limites), FeatureCollection avec attributs d'origine",
    carte.jeux.length === 4 && carte.jeux.every((j: { type: string; nonAutorise: boolean }) => j.type === "FeatureCollection" && j.nonAutorise === false)
    && carte.jeux.find((j: { role: string; concessionnaire: { nom: string } | null }) => j.concessionnaire?.nom.startsWith("Operateur")).features.some((f: { properties: { attributs: { circuit?: string } } }) => f.properties.attributs.circuit === "C1"), carte.jeux.map((j: { role: string }) => j.role));
  const coin1 = (await wgs([[300, 300], [301, 301]]));
  const carteVide = (await get(`/${PID}/carte?bbox=${coin1[0][0]},${coin1[0][1]},${coin1[1][0]},${coin1[1][1]}`)).body;
  verifier("9. le filtre d'emprise (bbox) ne rend que les objets de la fenetre (aucun ici)", carteVide.jeux.every((j: { features: unknown[] }) => j.features.length === 0));
  const carteZ = (await get(`/${PID}/carte?zoom=8`)).body;
  const carteZ18 = (await get(`/${PID}/carte?zoom=18`)).body;
  verifier("9. le zoom simplifie sans perdre d'objet (meme nombre d'objets a z8 et z18)", carteZ.jeux.reduce((s: number, j: { features: unknown[] }) => s + j.features.length, 0) === carteZ18.jeux.reduce((s: number, j: { features: unknown[] }) => s + j.features.length, 0));
  verifier("9. parametres de carte hostiles : bbox inverse, zoom hors plage, jeux vide, parametre inconnu : 400",
    (await get(`/${PID}/carte?bbox=1,2,0,1`)).status === 400 && (await get(`/${PID}/carte?zoom=99`)).status === 400 && (await get(`/${PID}/carte?jeux=%20,%20`)).status === 400 && (await get(`/${PID}/carte?x=1`)).status === 400);
  const filtreJeu = (await get(`/${PID}/carte?jeux=${JEU_AXES}`)).body;
  verifier("9. ?jeux= limite aux jeux demandes", filtreJeu.jeux.length === 1 && filtreJeu.jeux[0].jeuId === JEU_AXES);

  // ---------------------------------------------------------------- 10. Refus de fichiers : aucun jeu, aucun 500
  const nbJeux = await compter(`SELECT count(*) n FROM projets_voirie_jeux`);
  const refus = async (contenu: Buffer, nom: string, attendu: number, code: string, nomTest: string) => {
    const r = await depot(PID, contenu, { role: "AUTRE" }, nom);
    exemples[`erreur_${code}`] ??= r.body;
    verifier(`10. ${nomTest} : ${attendu} ${code}`, r.status === attendu && r.body.code === code, [r.status, r.body]);
  };
  await refus(Buffer.from("<!DOCTYPE html><html><body>pas un plan</body></html>"), "plan.kml", 422, "CONTENU_NON_RECONNU", "page HTML deguisee en KML");
  await refus(Buffer.from("%PDF-1.7\n1 0 obj"), "plan.geojson", 422, "CONTENU_NON_RECONNU", "PDF deguise en GeoJSON");
  await refus(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 3, 0, 0, 0]), "x.kml", 422, "CONTENU_NON_RECONNU", "executable");
  await refus(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]), "reseau.kmz", 415, "FORMAT_NON_SUPPORTE", "archive KMZ");
  await refus(Buffer.from([0x00, 0x00, 0x27, 0x0a, 0, 0, 0, 0]), "troncons.shp", 415, "FORMAT_NON_SUPPORTE", "Shapefile");
  await refus(Buffer.from(`<?xml version="1.0"?><!DOCTYPE kml [<!ENTITY x SYSTEM "file:///etc/passwd">]><kml><Document><Placemark><name>&x;</name></Placemark></Document></kml>`), "xxe.kml", 422, "DTD_REFUSEE", "KML avec entite externe (XXE)");
  await refus(Buffer.from(JSON.stringify({ type: "Point", coordinates: [2.35, 48.85] })), "paris.geojson", 422, "HORS_GUINEE", "point hors de la Guinee");
  await refus(Buffer.from(JSON.stringify({ type: "Point", coordinates: [9.2, -10.1] })), "inverse.geojson", 422, "HORS_GUINEE", "latitude et longitude inversees");
  await refus(Buffer.from(JSON.stringify({ type: "FeatureCollection", features: [] })), "vide.geojson", 422, "FICHIER_VIDE", "FeatureCollection vide");
  await refus(Buffer.from(JSON.stringify({ type: "FeatureCollection", crs: { type: "name", properties: { name: "EPSG:32629" } }, features: [] })), "utm.geojson", 422, "CRS_NON_SUPPORTE", "CRS projete declare");
  await refus(Buffer.from("[".repeat(5000) + "]".repeat(5000)), "bombe.json", 415, "FORMAT_NON_SUPPORTE", "tableaux imbriques (pas un objet GeoJSON)");
  await refus(Buffer.from(`{"type":"Feature","properties":{"a":${"[".repeat(5000)}${"]".repeat(5000)}},"geometry":{"type":"Point","coordinates":[-10.1,9.2]}}`), "bombe2.json", 422, "JSON_TROP_PROFOND", "JSON trop imbrique");
  await refus(Buffer.concat([Buffer.from('{"type":"Point","coordinates":[-10.1,9.2],"x":"'), Buffer.from([0]), Buffer.from('"}')]), "nul.geojson", 422, "CONTENU_NON_RECONNU", "octet NUL");
  const gros = await depot(PID, Buffer.alloc(26 * 1024 * 1024, 32), { role: "AUTRE" }, "gros.kml");
  verifier("10. fichier de plus de 25 Mo : 413 FICHIER_TROP_GROS", gros.status === 413 && gros.body.code === "FICHIER_TROP_GROS", [gros.status, gros.body]);
  const sansFichier = await request(app).post(`${BASE}/${PID}/jeux`).set("Authorization", `Bearer ${T.chef}`).field("role", "AUTRE");
  verifier("10. sans fichier : 400 FICHIER_MANQUANT ; role invalide : 400 CHAMPS_INVALIDES",
    sansFichier.body.code === "FICHIER_MANQUANT" && (await depot(PID, fR2, { role: "PAS_UN_ROLE" }, "r.kml")).body.code === "CHAMPS_INVALIDES");
  verifier("10. aucun de ces refus n'a laisse de jeu", (await compter(`SELECT count(*) n FROM projets_voirie_jeux`)) === nbJeux);

  // ---------------------------------------------------------------- 11. Retrait logique, immuabilite, contraintes de la base
  const nbObjetsAvant = await compter(`SELECT count(*) n FROM projets_voirie_objets`);
  const retrait = await envoyer("delete", `/${PID}/jeux/${autre2.body.jeu.id}`);
  verifier("11. retrait logique d'un jeu : RETIRE, deletedAt renseigne, objets conserves, absent de la liste, audite",
    retrait.status === 200 && retrait.body.jeu.statut === "RETIRE"
    && (await compter(`SELECT count(*) n FROM projets_voirie_objets`)) === nbObjetsAvant
    && !(await get(`/${PID}/jeux`)).body.jeux.some((j: { id: string }) => j.id === autre2.body.jeu.id)
    && (await sql<{ n: bigint }>(`SELECT count(*) n FROM audit_logs WHERE action = 'DELETE' AND "entityId" = $1`, autre2.body.jeu.id))[0].n === 1n);
  verifier("11. retirer deux fois : 409 STATUT_INCOMPATIBLE", (await envoyer("delete", `/${PID}/jeux/${autre2.body.jeu.id}`)).body.code === "STATUT_INCOMPATIBLE");
  const physique = async (requete: string) => { try { await sql(requete); return "accepte"; } catch (e) { return (e as Error).message; } };
  verifier("11. la base refuse toute suppression physique (projets, jeux, objets, concessionnaires)",
    (await Promise.all([`DELETE FROM projets_voirie_objets`, `DELETE FROM projets_voirie_jeux`, `DELETE FROM projets_voirie`, `DELETE FROM concessionnaires_reseau`].map(physique))).every((m) => /suppression physique interdite/.test(m)));
  verifier("11. la base refuse de modifier un objet (immuable)", /un objet ne se modifie pas/.test(await physique(`UPDATE projets_voirie_objets SET nom = 'x'`)));
  verifier("11. la base refuse un objet hors Guinee, vide, ou de type incoherent",
    /pvo_en_guinee/.test(await physique(`INSERT INTO projets_voirie_objets ("jeuId", "typeGeom", geom, "longueurM", empreinte, ordre) VALUES ('${JEU_AXES}', 'POINT', ST_SetSRID(ST_MakePoint(2.3, 48.8), 4326), NULL, '${"a".repeat(40)}', 9)`))
    && /pvo_type_coherent/.test(await physique(`INSERT INTO projets_voirie_objets ("jeuId", "typeGeom", geom, "longueurM", empreinte, ordre) VALUES ('${JEU_AXES}', 'POINT', ST_SetSRID(ST_GeomFromText('LINESTRING(-10 9, -10.1 9)'), 4326), NULL, '${"a".repeat(40)}', 9)`)));
  const refusJeux = [
    await physique(`INSERT INTO projets_voirie_jeux (id, "projetId", role, "nomFichier", format, sha256, "tailleOctets", "nbObjets", "creeParId") VALUES ('x1', '${PID}', 'RESEAU_TIERS', 'f', 'KML', '${"b".repeat(64)}', 1, 1, '${chef.id}')`),
    await physique(`INSERT INTO projets_voirie_jeux (id, "projetId", role, "nomFichier", format, sha256, "tailleOctets", "nbObjets", statut, "natureObjets", "creeParId") VALUES ('x2', '${PID}', 'AUTRE', 'f', 'KML', '${"c".repeat(64)}', 1, 1, 'REJETE', 'INCONNUE', '${chef.id}')`),
    await physique(`INSERT INTO projets_voirie_jeux (id, "projetId", role, "concessionnaireId", "typeReseau", "nomFichier", format, sha256, "tailleOctets", "nbObjets", statut, "decideParId", "decideLe", "justificationDecision", "creeParId", "natureObjets") VALUES ('x3', '${PID}', 'RESEAU_TIERS', '${CONC1}', 'TELECOM', 'f', 'KML', '${"d".repeat(64)}', 1, 1, 'AUTORISE', '${chef.id}', now(), 'une justification', '${chef.id}', 'INCONNUE')`),
  ];
  verifier("11. la base refuse un jeu RESEAU_TIERS sans concessionnaire, un jeu REJETE sans justification et deux AUTORISE de meme cle",
    /pvj_concessionnaire_coherent/.test(refusJeux[0]) && /pvj_decision_coherente/.test(refusJeux[1]) && /already exists/.test(refusJeux[2]), refusJeux);

  // ---------------------------------------------------------------- 12. Territoire
  const projR2 = await envoyer("post", "", { code: "AUTRE-REGION", nom: "Projet d'une autre region", regionId: R2id });
  const projSans = await envoyer("post", "", { code: "SANS-REGION", nom: "Projet sans region" });
  const creeReg = await envoyer("post", "", { code: "MA-REGION", nom: "Dans ma region", regionId: R1 }, T.reg1);
  const horsRegion = await envoyer("post", "", { code: "HORS-MA-REGION", nom: "x", regionId: R2id }, T.reg1);
  const sansRegion = await envoyer("post", "", { code: "NI-OUI-NI-NON", nom: "x" }, T.reg1);
  verifier("12. un compte regional cree dans sa region (201), pas dans une autre (403), pas sans region (403)", creeReg.status === 201 && horsRegion.status === 403 && sansRegion.status === 403, [creeReg.status, horsRegion.status, sansRegion.status]);
  const lecAutre = await get(`/${projR2.body.projet.id}`, T.reg1);
  const lecSans = await get(`/${projSans.body.projet.id}`, T.reg1);
  const lecInconnu = await get(`/identifiant-inconnu`, T.reg1);
  exemples["erreur_projet_introuvable"] = lecInconnu.body;
  verifier("12. hors perimetre, projet sans region et projet inconnu : la MEME reponse 404 PROJET_INTROUVABLE",
    [lecAutre, lecSans, lecInconnu].every((r) => r.status === 404 && r.body.code === "PROJET_INTROUVABLE") && JSON.stringify(lecAutre.body) === JSON.stringify(lecInconnu.body), [lecAutre.body, lecSans.body, lecInconnu.body]);
  verifier("12. ... sur toutes les routes du projet (jeux, carte, analyse, export, depot, autorisation) pour un compte regional hors perimetre",
    (await Promise.all([get(`/${projR2.body.projet.id}/jeux`, T.reg1), get(`/${projR2.body.projet.id}/carte`, T.reg1), get(`/${projR2.body.projet.id}/analyse`, T.reg1), get(`/${projR2.body.projet.id}/analyse/export.csv`, T.reg1),
      envoyer("post", `/${projR2.body.projet.id}/jeux/x/autoriser`, { justification: JUSTIF }, T.reg1), depot(projR2.body.projet.id, fR2, { role: "AUTRE" }, "r.kml", false, T.reg1)])).every((r) => r.status === 404));
  const listeReg = (await get("", T.reg1)).body.projets;
  verifier("12. la liste d'un compte regional ne contient que les projets de sa region (Kissidougou et le sien, pas celui de l'autre region ni celui sans region) ; un compte national voit tout",
    listeReg.length === 2 && listeReg.map((p: { code: string }) => p.code).sort().join() === "KISSI-VOIRIE-2026,MA-REGION" && (await get("", T.chef)).body.projets.length === 4);
  verifier("12. le projet de Kissidougou est dans la region 1 : le compte regional de la region 1 le voit", (await get(`/${PID}`, T.reg1)).status === 200);

  // ---------------------------------------------------------------- 13. Export CSV
  const avantAudit = await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'ExportProjetVoirie'`);
  const csv = await get(`/${PID}/analyse/export.csv`);
  const lignes = csv.text.replace(/^﻿/, "").trim().split(/\r?\n/);
  verifier("13. export CSV : 200, text/csv, attachment, BOM UTF-8, en-tete, un couple axe x objet par ligne (>= 8)",
    csv.status === 200 && /text\/csv/.test(csv.headers["content-type"]) && /attachment; filename="analyse-kissi-voirie-2026-/.test(csv.headers["content-disposition"]) && csv.text.startsWith("﻿")
    && lignes[0].startsWith("axe;concessionnaire;typeReseau;fichier;versionJeu;statutJeu;classePrecision;qualification") && lignes.length >= 9, lignes.slice(0, 3));
  verifier("13. le CSV ne porte AUCUNE geometrie (ni coordonnees, ni WKT, ni GeoJSON)", !/LINESTRING|POINT\(|coordinates|\[-?\d+\.\d{4,}/.test(csv.text));
  verifier("13. chaque ligne du CSV porte statut A_VERIFIER, la regle RC-2D-0.1 et la qualification", lignes.slice(1).every((l) => l.includes(";A_VERIFIER;RC-2D-0.1;EPSG:32629;") && /(CONFLIT_POTENTIEL|PROXIMITE_A_VERIFIER)/.test(l)));
  verifier("13. l'export est audite (ExportProjetVoirie) AVANT la remise, sans geometrie", (await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'ExportProjetVoirie'`)) === avantAudit + 1
    && (await sql<{ after: { geometries: boolean; nbLignes: number } }>(`SELECT after FROM audit_logs WHERE "entityType" = 'ExportProjetVoirie' ORDER BY "createdAt" DESC LIMIT 1`))[0].after.geometries === false);
  verifier("13. l'export est reserve a ADMIN et GESTIONNAIRE : un LECTEUR (module accorde) recoit 403", (await get(`/${PID}/analyse/export.csv`, T.lecteur)).status === 403);
  verifier("13. aucune route n'exporte les geometries d'un jeu en fichier : pas de /export.geojson ni /export.kml ni /geometries", (await Promise.all(
    [`/${PID}/jeux/${JEU_AXES}/export.geojson`, `/${PID}/jeux/${JEU_AXES}/export.kml`, `/${PID}/jeux/${JEU_AXES}/geometries`, `/${PID}/export.geojson`, `/${PID}/export.kml`].map((p) => get(p)))).every((r) => r.status === 404));

  // ---------------------------------------------------------------- 14. Jamais dans l'API publique ni dans les tuiles
  const publics = await Promise.all(["/api/public/carte/geo", "/api/public/voirie-locale/geo", "/api/public/info-route", "/api/public/info-route/bulletin"].map((p) => request(app).get(p)));
  const lon = (await sql<{ x: number; y: number }>(`SELECT floor((-10.1 + 180) / 360 * 4096)::int AS x, floor((1 - ln(tan(radians(9.18)) + 1 / cos(radians(9.18))) / pi()) / 2 * 4096)::int AS y`))[0];
  const tuile = await request(app).get(`/api/public/tuiles/12/${lon.x}/${lon.y}.mvt`);
  verifier("14. aucune route publique (carte, voirie locale, info-route) ni tuile vectorielle ne porte le moindre objet des jeux (marqueur absent)",
    [...publics, tuile].every((r) => !/Marqueur|Operateur Telecom Synthetique|Societe des Eaux Synthetique/.test(Buffer.isBuffer(r.body) ? r.body.toString("latin1") : r.text ?? JSON.stringify(r.body))), publics.map((r) => r.status));

  // ---------------------------------------------------------------- 15. Retrait du projet et audit
  const retraitProjet = await envoyer("delete", `/${projSans.body.projet.id}`, undefined, T.chef);
  verifier("15. DELETE d'un projet : GESTIONNAIRE 403, ADMIN 200 (retrait logique), le projet disparait de la liste et reste en base",
    retraitProjet.status === 403 && (await envoyer("delete", `/${projSans.body.projet.id}`, undefined, T.admin)).status === 200
    && (await get(`/${projSans.body.projet.id}`, T.chef)).status === 404 && (await compter(`SELECT count(*) n FROM projets_voirie WHERE id = $1 AND "deletedAt" IS NOT NULL`, projSans.body.projet.id)) === 1);
  verifier("15. un projet retire garde son code (archive) : reutilisation refusee", (await envoyer("post", "", { code: "SANS-REGION", nom: "y" })).body.code === "CODE_DEJA_UTILISE");
  const audits = await sql<{ entite: string; action: string; n: number }>(`SELECT "entityType" entite, action::text, count(*)::int n FROM audit_logs WHERE "entityType" IN ('ProjetVoirie','JeuDonneesProjet','ConcessionnaireReseau','ExportProjetVoirie') GROUP BY 1, 2`);
  const a = (e: string, ac: string) => Number(audits.find((x) => x.entite === e && x.action === ac)?.n ?? 0);
  verifier("15. chaque ecriture est auditee : projets (creations, mises a jour, retrait), jeux (depots, autorisations, rejet, retrait), concessionnaires, export",
    a("ProjetVoirie", "CREATE") === 4 && a("ProjetVoirie", "UPDATE") >= 3 && a("ProjetVoirie", "DELETE") === 1 && a("JeuDonneesProjet", "CREATE") === 8 && a("JeuDonneesProjet", "VALIDATE") === 5
    && a("JeuDonneesProjet", "REJECT") === 1 && a("JeuDonneesProjet", "DELETE") === 1 && a("ConcessionnaireReseau", "CREATE") === 2 && a("ExportProjetVoirie", "CREATE") === 1, audits);
  verifier("15. l'audit des jeux ne contient aucune geometrie (taille des valeurs apres < 4 ko)", (await sql<{ m: number }>(`SELECT max(length(after::text))::int m FROM audit_logs WHERE "entityType" = 'JeuDonneesProjet'`))[0].m < 4096);

  // ---------------------------------------------------------------- 16. Aucune ecriture dans le referentiel officiel
  const etatFinal = await instantane();
  const bouges = Object.keys(etatFinal).filter((t) => etatInitial[t] !== etatFinal[t]).sort();
  const autorises = new Set(["audit_logs", "projets_voirie", "projets_voirie_jeux", "projets_voirie_objets", "concessionnaires_reseau"]);
  verifier("16. apres tout le banc (depots, autorisations, retraits, exports, lectures), SEULES les tables du module et audit_logs ont change : troncons, ouvrages, portions, chantiers, defauts... intacts",
    bouges.every((t) => autorises.has(t)) && bouges.includes("projets_voirie_objets"), bouges);
  verifier("16. ... et le referentiel est bien present dans l'instantane (le test n'est pas vide)", ["troncons", "ouvrages", "portions", "chantiers", "defauts", "users", "regions"].every((t) => t in etatFinal));

  exemples["analyse"] = an;
  exemples["fiche_projet"] = (await get(`/${PID}`)).body;
  exemples["liste_projets"] = (await get("")).body;
  exemples["csv"] = lignes.slice(0, 4).join("\n");
  if (process.env.PV_EXEMPLES) (await import("node:fs")).writeFileSync(process.env.PV_EXEMPLES, JSON.stringify(exemples, null, 2));

  const histo = await request(app).get(`/api/audit?entityType=JeuDonneesProjet&entityId=${JEU_AXES}`).set("Authorization", `Bearer ${T.chef}`);
  verifier("15. l'historique d'un jeu est lisible par un compte qui a le module (MODULE_PAR_ENTITE) et refuse a celui qui ne l'a pas",
    histo.status === 200 && (await request(app).get(`/api/audit?entityType=JeuDonneesProjet&entityId=${JEU_AXES}`).set("Authorization", `Bearer ${T.sans}`)).status === 403, histo.status);
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

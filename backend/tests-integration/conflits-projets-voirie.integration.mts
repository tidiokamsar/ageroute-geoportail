// Banc d'integration des DOSSIERS DE CONFLIT des projets de voirie (lot RC-3) contre un vrai PostGIS.
// Contrat : docs/projets-voirie/CONTRAT-CONFLITS.md. Voir tests-integration/README.md. Lancer (DATABASE_URL pointe sur `replay`) :
//   npx tsx tests-integration/conflits-projets-voirie.integration.mts
// Avec CONFLITS_EXEMPLES=<fichier.json>, les reponses reelles servant d'exemples a docs/projets-voirie/API.md y sont ecrites.
//
// Tout passe par les routes reelles montees comme en production (`createApp`), des jetons signes par des secrets aleatoires, le role, le module
// et le perimetre LUS EN BASE, le SQL reel (PostGIS), les contraintes et declencheurs reels, dans le clone jetable `essai_conflits_pv` (la migration
// 20261031100000 y est appliquee par le banc si `replay` ne la porte pas).
//
// DONNEES 100 % SYNTHETIQUES (voir lib/fixtures-conflits.mts) : segments inventes, construits en metres dans le repere UTM 29N.
// Scenarios du cahier couverts : AT-05 (reseau croisant l'axe => proposition), AT-06 (reseau approximatif => a investiguer), AT-07 (vertical non
// evalue), AT-08 (infirmation conservee), AT-09 (decision de deplacement, responsable, planning, separation des taches), AT-13 (nouvelle analyse apres
// modification d'un axe), AT-14 (aucune donnee sur une zone => couverture insuffisante, jamais « absence de reseau »).
import { writeFileSync } from "node:fs";
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure, proche } from "./lib/verdict.ts";
import { AXES, R1_BASE, R2, R3, O, constructeurs, type Ligne } from "./lib/fixtures-conflits.mts";

// Lot B1 : l analyse persistee et les dossiers lisent les descripteurs d objets (migration 20261101200000).
const banc = await ouvrirBancClone("essai_conflits_pv", { migrations: ["20261031100000_conflits_projets_voirie", "20261101200000_reseaux_physiques_logiques", "20261103300000_multi_sources_comparaison"] });
const { prisma } = await banc.imp("lib/prisma");
const { createApp } = await banc.imp("app");
const { signAccessToken } = await banc.imp("utils/jwt");
const depotConflits = await banc.imp("projets-voirie/conflits/conflits.depot");
const request = (await import("supertest")).default;
const pg = (await import("pg")).default;

// Revue RC-3, m8 : le delai minimal entre deux analyses d un projet (defaut 60 s) est desactive pour ce banc, qui en enchaine plusieurs ; la section 14 le remet.
process.env.PROJETS_VOIRIE_ANALYSE_INTERVALLE_S = "0";
const app = createApp();
const BASE = "/api/v2/projets-voirie";

const sql = <T = Record<string, unknown>>(texte: string, ...v: unknown[]) => prisma.$queryRawUnsafe(texte, ...v) as Promise<T[]>;
const compter = async (texte: string, ...v: unknown[]) => Number((await sql<{ n: bigint }>(texte, ...v))[0].n);

async function wgs(pts: [number, number][]): Promise<[number, number][]> {
  const wkt = `LINESTRING(${pts.map(([x, y]) => `${O.x + x} ${O.y + y}`).join(",")})`;
  const r = await sql<{ g: string }>(`SELECT ST_AsGeoJSON(ST_Transform(ST_SetSRID(ST_GeomFromText($1), 32629), 4326), 9) AS g`, wkt);
  return JSON.parse(r[0].g).coordinates;
}
const { geojson, kml } = constructeurs(wgs);

/** Code SQLSTATE d'une erreur de requete brute Prisma (23001 : declencheur de refus, 23514 : contrainte CHECK). */
async function sqlstate(f: () => Promise<unknown>): Promise<string> {
  try { await f(); return "aucune erreur"; } catch (e) {
    const meta = (e as { meta?: { code?: string } }).meta;
    const m = String((e as Error).message ?? "").match(/\b(2\d{4})\b/);
    return meta?.code ?? m?.[1] ?? String(e).slice(0, 120);
  }
}
/** Execute dans une transaction qui est TOUJOURS annulee ; rend le SQLSTATE de l'erreur, ou « ok ». */
async function essaiAnnule(f: (tx: typeof prisma) => Promise<unknown>): Promise<string> {
  const ANNULE = new Error("annule");
  try { await prisma.$transaction(async (tx: typeof prisma) => { await f(tx); throw ANNULE; }); return "ok"; } catch (e) {
    if (e === ANNULE) return "ok";
    const meta = (e as { meta?: { code?: string } }).meta;
    return meta?.code ?? String(e).slice(0, 120);
  }
}

const exemples: Record<string, unknown> = {};

async function main() {
  // ================================================================ Fixtures
  const mk = (email: string, nomComplet: string, role: string, modules: string[] = ["projets-voirie"]) =>
    prisma.user.create({ data: { email, nomComplet, passwordHash: "x", role, modulesAutorises: modules } });
  const admin = await mk("admin@banc.invalid", "Mariama Admin", "ADMIN", []);
  const chef = await mk("chef@banc.invalid", "Sekou Gestionnaire", "GESTIONNAIRE");
  const chef2 = await mk("chef2@banc.invalid", "Fanta Gestionnaire", "GESTIONNAIRE");
  const lecteur = await mk("lecteur@banc.invalid", "Lecteur banc", "LECTEUR");
  const sansModule = await mk("sans@banc.invalid", "Sans module", "GESTIONNAIRE", ["troncons"]);
  const reg1 = await mk("reg1@banc.invalid", "Regional 1", "GESTIONNAIRE");
  const reg2 = await mk("reg2@banc.invalid", "Regional 2", "GESTIONNAIRE");
  const R1 = (await prisma.region.create({ data: { nom: "Region banc 1" } })).id;
  const R2id = (await prisma.region.create({ data: { nom: "Region banc 2" } })).id;
  await sql(`INSERT INTO perimetres_comptes ("userId", "regionId", "accordeParId") VALUES ($1, $2, $3), ($4, $5, $3)`, reg1.id, R1, admin.id, reg2.id, R2id);
  const jeton = (u: { id: string; role: string; email: string }) => signAccessToken({ sub: u.id, role: u.role, email: u.email });
  const T = { admin: jeton(admin), chef: jeton(chef), chef2: jeton(chef2), lecteur: jeton(lecteur), sans: jeton(sansModule), reg1: jeton(reg1), reg2: jeton(reg2) };

  const get = (chemin: string, t = T.chef) => request(app).get(`${BASE}${chemin}`).set("Authorization", `Bearer ${t}`);
  const envoyer = (methode: "post" | "patch" | "delete", chemin: string, corps?: unknown, t = T.chef) => {
    const r = request(app)[methode](`${BASE}${chemin}`).set("Authorization", `Bearer ${t}`);
    return corps === undefined ? r : r.send(corps as object);
  };
  function depot(projetId: string, fichier: Buffer, champs: Record<string, string | undefined>, nom = "fichier.kml", t = T.chef) {
    const r = request(app).post(`${BASE}/${projetId}/jeux`).set("Authorization", `Bearer ${t}`);
    for (const [k, v] of Object.entries(champs)) if (v !== undefined) r.field(k, v);
    return r.attach("fichier", fichier, { filename: nom });
  }
  const JUSTIF = "Controle effectue avec le chef de projet";
  /** Depose puis autorise un jeu ; rend son identifiant. */
  async function deposerEtAutoriser(pid: string, fichier: Buffer, champs: Record<string, string | undefined>, nom: string, t = T.chef): Promise<string> {
    const d = await depot(pid, fichier, champs, nom, t);
    const id: string = d.body.jeu?.id;
    if (!id) throw new Error(`depot refuse : ${JSON.stringify(d.body)}`);
    const a = await envoyer("post", `/${pid}/jeux/${id}/autoriser`, { justification: JUSTIF }, t);
    if (a.status !== 200) throw new Error(`autorisation refusee : ${JSON.stringify(a.body)}`);
    return id;
  }

  console.log("\n== Dossiers de conflit : banc PostGIS ==");

  const PID: string = (await envoyer("post", "", { code: "CONFLITS-1", nom: "Voirie de banc", commune: "Banc", regionId: R1 })).body.projet.id;
  const PID_SANS_REGION: string = (await envoyer("post", "", { code: "CONFLITS-SANS-REGION", nom: "Sans region" }, T.admin)).body.projet.id;
  const conc = async (nom: string, typeReseau: string): Promise<string> => (await envoyer("post", "/concessionnaires", { nom, typeReseau })).body.concessionnaire.id;
  const CONC1 = await conc("Operateur Telecom Synthetique", "TELECOM");
  const CONC2 = await conc("Societe des Eaux Synthetique", "EAU_POTABLE");
  const CONC3 = await conc("Societe du Gaz Synthetique", "GAZ_HYDROCARBURES");

  const fAxes = await kml(AXES);
  const JEU_AXES = await deposerEtAutoriser(PID, fAxes, { role: "AXES_TRAVAUX" }, "axes.kml");
  const JEU_R1 = await deposerEtAutoriser(PID, await geojson(R1_BASE), { role: "RESEAU_TIERS", concessionnaireId: CONC1, classePrecision: "B", precisionHorizontaleM: "3.5" }, "r1.geojson");
  const JEU_R2 = await deposerEtAutoriser(PID, await kml(R2), { role: "RESEAU_TIERS", concessionnaireId: CONC2 }, "r2.kml");
  await deposerEtAutoriser(PID, await kml(R3), { role: "RESEAU_TIERS", concessionnaireId: CONC3, classePrecision: "A" }, "r3.kml");
  await deposerEtAutoriser(PID_SANS_REGION, await kml(AXES), { role: "AXES_TRAVAUX" }, "axes.kml", T.admin);

  // Referentiel officiel : deux troncons synthetiques, l'un parallele a l'axe A (a 5 m), l'autre loin. Ils ne doivent JAMAIS etre ecrits.
  const wktLigne = (pts: [number, number][]) => `LINESTRING(${pts.map(([x, y]) => `${O.x + x} ${O.y + y}`).join(",")})`;
  const troncons: [string, string, [number, number][]][] = [
    ["BANC-T-PROCHE", "Troncon proche de l'axe A", [[0, 5], [200, 5]]], ["BANC-T-LOIN", "Troncon loin de tout axe", [[0, 600], [200, 600]]],
  ];
  for (const [code, nom, pts] of troncons) {
    await sql(`INSERT INTO troncons ("id","code","nom","classe","regionId","longueurKm","revetement","pkDebut","pkFin","updatedAt","geom")
               VALUES (gen_random_uuid()::text, $1, $2, 'RU', $3, 0.2, 'BITUME', 0, 0.2, now(), ST_Transform(ST_SetSRID(ST_GeomFromText($4), 32629), 4326))`, code, nom, R1, wktLigne(pts));
  }

  const etat = async (): Promise<Record<string, number>> => {
    const tables = await sql<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND left(table_name, 1) <> '_' ORDER BY 1`);
    const sortie: Record<string, number> = {};
    for (const t of tables) sortie[t.table_name] = await compter(`SELECT count(*) n FROM "${t.table_name}"`);
    return sortie;
  };
  const avantTout = await etat();
  const empreinteTroncons = async () => (await sql<{ h: string }>(`SELECT md5(string_agg(t::text, '|' ORDER BY code)) h FROM troncons t`))[0].h;
  const empreinteAvant = await empreinteTroncons();
  const comptesInterdits = ["ordres_travaux", "chantiers", "ouvrages", "troncons"];

  const trouver = async (pid: string, axe: string, type: string, nom: string): Promise<string> => {
    const r = await sql<{ id: string }>(`SELECT c.id FROM conflits_projet c JOIN projets_voirie_objets o ON o.id = c."objetId" WHERE c."projetId" = $1 AND c.axe = $2 AND c.type = $3::"TypeConflit" AND o.nom = $4 ORDER BY c.id`, pid, axe, type, nom);
    return r[0]?.id ?? "";
  };
  const statutDe = async (id: string) => (await sql<{ statut: string; are: boolean; motif: string | null }>(`SELECT statut::text, "aReexaminer" AS are, "motifReexamen"::text AS motif FROM conflits_projet WHERE id = $1`, id))[0];
  const analyser = (pid = PID, t = T.chef) => envoyer("post", `/${pid}/analyses`, {}, t);
  const L = (m: string) => `Fibre-Marqueur ${m}`;

  // ================================================================ 1. Gardes d'acces
  const UUID0 = "00000000-0000-4000-8000-0000000000aa";
  const routes: [string, string, unknown?][] = [
    ["get", `/${PID}/regles`], ["post", `/${PID}/regles`, {}], ["post", `/${PID}/regles/${UUID0}/approuver`, {}],
    ["post", `/${PID}/analyses`, {}], ["get", `/${PID}/analyses`], ["get", `/${PID}/analyses/${UUID0}`], ["get", `/${PID}/analyses/${UUID0}/comparaison?avec=${UUID0}`],
    ["get", `/${PID}/conflits`], ["get", `/${PID}/conflits/export.csv`], ["get", `/${PID}/conflits/${UUID0}`], ["patch", `/${PID}/conflits/${UUID0}`, {}],
    ["post", `/${PID}/conflits/${UUID0}/statut`, {}], ["post", `/${PID}/conflits/${UUID0}/preuves`, {}], ["post", `/${PID}/conflits/${UUID0}/decisions`, {}],
    ["post", `/${PID}/conflits/${UUID0}/decisions/${UUID0}/approuver`, {}], ["post", `/${PID}/conflits/${UUID0}/decisions/${UUID0}/refuser`, {}],
  ];
  verifier("1. les 16 routes des dossiers de conflit existent", routes.length === 16);
  const appeler = async (m: string, c: string, corps: unknown, t: string | null) => {
    let r = request(app)[m as "get"](`${BASE}${c}`);
    if (t) r = r.set("Authorization", `Bearer ${t}`);
    return corps !== undefined ? r.send(corps as object) : r;
  };
  const statuts = async (t: string | null) => { const s: number[] = []; for (const [m, c, corps] of routes) s.push((await appeler(m, c, corps, t)).status); return s; };
  verifier("1. sans jeton : 401 sur les 16 routes", (await statuts(null)).every((s) => s === 401));
  verifier("1. sans la cle de module `projets-voirie` : 403 sur les 16 routes", (await statuts(T.sans)).every((s) => s === 403));
  const sLecteur = await statuts(T.lecteur);
  const ECRITURES_IDX = routes.map(([m, c], i) => (m !== "get" || c.endsWith("export.csv") ? i : -1)).filter((i) => i >= 0);
  verifier("1. un LECTEUR avec la cle lit (liste 200, fiche inconnue 404, jamais 403) et ne peut ecrire aucune des 10 routes d'ecriture ni exporter (403)",
    ECRITURES_IDX.length === 10 && ECRITURES_IDX.every((i) => sLecteur[i] === 403) && routes.every((_, i) => ECRITURES_IDX.includes(i) || sLecteur[i] !== 403), sLecteur);
  verifier("1. GESTIONNAIRE : l'approbation d'une regle est reservee a l'ADMIN (403)", (await envoyer("post", `/${PID}/regles/${UUID0}/approuver`, {}, T.chef)).status === 403);

  // Hors perimetre : 404 identique, meme avec un corps invalide ; projet sans region invisible d'un compte regional.
  const refs: { statut: number; corps: string }[] = [];
  for (const [i, [m, c, corps]] of routes.entries()) {
    if (i === 2) continue; // approbation d'une regle : garde de role (ADMIN) avant la garde de projet, comme DELETE d'un projet dans le socle
    const x = await appeler(m, c, corps, T.reg2);
    refs.push({ statut: x.status, corps: JSON.stringify(x.body) });
  }
  verifier("1. compte regional hors perimetre : MEME 404 PROJET_INTROUVABLE sur les routes du projet, y compris avec un corps invalide",
    refs.length === 15 && refs.every((x) => x.statut === 404 && x.corps === JSON.stringify({ error: "Projet introuvable", code: "PROJET_INTROUVABLE" })), refs.filter((x) => x.statut !== 404));
  verifier("1. projet sans region : 404 pour un compte regional, 200 pour un compte national",
    (await get(`/${PID_SANS_REGION}/conflits`, T.reg1)).status === 404 && (await get(`/${PID_SANS_REGION}/conflits`, T.chef)).status === 200);
  verifier("1. compte regional dans son perimetre : lit (200)", (await get(`/${PID}/regles`, T.reg1)).status === 200);

  // Identifiants.
  const idInvalides = await Promise.all([
    get(`/${PID}/conflits/pas-un-uuid`), get(`/${PID}/conflits/%00`), get(`/${PID}/analyses/xyz`), get(`/${PID}/analyses/${UUID0}/comparaison?avec=xyz`),
    envoyer("post", `/${PID}/regles/xyz/approuver`, {}, T.admin), envoyer("post", `/${PID}/conflits/${UUID0}/decisions/xyz/approuver`, {}), get(`/${PID}/analyses/${UUID0}/comparaison`),
  ]);
  verifier("1. identifiant de conflit, d'analyse, de regle ou de decision qui n'est pas un UUID : 400 IDENTIFIANT_INVALIDE, jamais 500 (%00 compris)",
    idInvalides.every((r) => r.status === 400 && r.body.code === "IDENTIFIANT_INVALIDE"), idInvalides.map((r) => [r.status, r.body.code]));
  const inconnus = [(await get(`/${PID}/conflits/${UUID0}`)).body.code, (await get(`/${PID}/analyses/${UUID0}`)).body.code, (await envoyer("post", `/${PID}/regles/${UUID0}/approuver`, { justification: JUSTIF }, T.admin)).body.code,
    (await envoyer("post", `/${PID}/conflits/${UUID0}/statut`, { vers: "POTENTIEL", justification: JUSTIF })).body.code];
  verifier("1. conflit, analyse, regle inconnus : 404 CONFLIT_INTROUVABLE / ANALYSE_INTROUVABLE / REGLE_INTROUVABLE", JSON.stringify(inconnus) === JSON.stringify(["CONFLIT_INTROUVABLE", "ANALYSE_INTROUVABLE", "REGLE_INTROUVABLE", "CONFLIT_INTROUVABLE"]), inconnus);

  // ================================================================ 2. Regles
  const regles0 = await get(`/${PID}/regles`);
  exemples["regles_initiales"] = regles0.body;
  const defaut = regles0.body.regles?.find((r: { code: string }) => r.code === "RC-2D-0.1");
  verifier("2. la regle par defaut RC-2D-0.1 existe (migration) : version 0, APPROUVEE, tolerance 0, generale, sans auteur (systeme)",
    regles0.status === 200 && defaut?.version === 0 && defaut.statut === "APPROUVEE" && defaut.toleranceProximiteM === 0 && defaut.portee === "GENERALE" && defaut.systeme === true && defaut.creePar === null, defaut);
  verifier("2. regles effectives : les six familles de reseau retombent sur la regle par defaut", regles0.body.effectives.length === 6 && regles0.body.effectives.every((e: { portee: string; code: string }) => e.portee === "DEFAUT" && e.code === "RC-2D-0.1"), regles0.body.effectives);
  verifier("2. la regle par defaut ne s'approuve pas : 409 REGLE_IMMUABLE", (await envoyer("post", `/${PID}/regles/${defaut.id}/approuver`, { justification: JUSTIF }, T.admin)).body.code === "REGLE_IMMUABLE");

  // ================================================================ 3. Analyse 1 : cas de resultat connu
  const a1 = await analyser();
  exemples["analyse_creee"] = a1.body;
  verifier("3. POST analyses : 201, analyse TERMINEE numero 1, version de l'algorithme, largeurs utilisees 15 / 7, declenchee par le compte",
    a1.status === 201 && a1.body.analyse.numero === 1 && a1.body.analyse.statut === "TERMINEE" && a1.body.analyse.versionAlgorithme === "RC3-2D-UTM-1"
    && a1.body.analyse.largeurEmpriseM === 15 && a1.body.analyse.largeurChausseeM === 7 && a1.body.analyse.declenchePar.nomComplet === "Sekou Gestionnaire", a1.body);
  const A1: string = a1.body.analyse.id;
  const r1 = a1.body.resume;
  verifier("3. resume : 14 conflits (6 chaussee, 4 emprise, 1 proximite, 2 traversees, 1 couverture), tous nouveaux, 12 potentiels et 2 a investiguer",
    r1.totaux.conflitsTrouves === 14 && r1.parType.INTERSECTION_CHAUSSEE === 6 && r1.parType.INTERSECTION_EMPRISE === 4 && r1.parType.PROXIMITE === 1 && r1.parType.TRAVERSEE === 2
    && r1.parType.COUVERTURE_INSUFFISANTE === 1 && r1.nouveaux === 14 && r1.retrouves === 0 && r1.parStatut.POTENTIEL === 12 && r1.parStatut.A_INVESTIGUER === 2, r1);
  verifier("3. reproductibilite : l'analyse enregistre les versions et empreintes des 4 jeux (axes + 3 reseaux), les regles appliquees (defaut, version 0) et l'algorithme",
    a1.body.analyse.jeux.length === 4 && a1.body.analyse.jeux.every((j: { sha256: string; version: number; statut: string }) => /^[0-9a-f]{64}$/.test(j.sha256) && j.version === 1 && j.statut === "AUTORISE")
    && a1.body.analyse.regles.length === 3 && a1.body.analyse.regles.every((x: { code: string; version: number; portee: string }) => x.code === "RC-2D-0.1" && x.version === 0 && x.portee === "DEFAUT"), a1.body.analyse);
  verifier("3. les limites obligatoires accompagnent l'analyse (vertical non evalue, absence de conflit n'est pas absence de reseau, aucune decision de deplacement)",
    r1.limites.includes("Conflit vertical non évalué : profondeur et altitude absentes.") && r1.limites.includes("Aucun conflit détecté ne prouve l'absence de réseau.")
    && r1.limites.includes("Résultat indicatif : aucune décision de déplacement n'en découle."), r1.limites);

  // AT-05 : un reseau qui croise l'axe devient une proposition (conflit POTENTIEL), mesuree.
  const trav = await get(`/${PID}/conflits?type=TRAVERSEE`);
  exemples["conflits_liste_traversees"] = trav.body;
  verifier("3. AT-05 : deux croisements (axe A et axe B) => deux conflits TRAVERSEE au statut POTENTIEL (reseau de classe B), un croisement chacun, distance 0",
    trav.body.total === 2 && trav.body.conflits.length === 2 && trav.body.conflits.every((c: { statut: string; mesure: { nbCroisements: number; distanceMinM: number } }) => c.statut === "POTENTIEL" && c.mesure.nbCroisements === 1 && c.mesure.distanceMinM === 0)
    && new Set(trav.body.conflits.map((c: { axe: string }) => c.axe)).size === 2, trav.body.conflits);
  const idTravA = trav.body.conflits.find((c: { axe: string }) => c.axe === "Axe A").id as string;
  const ficheTrav = await get(`/${PID}/conflits/${idTravA}`);
  verifier("3. AT-05 : la fiche rend la geometrie du croisement (un point), la mesure, la regle, les sources et les avertissements",
    ficheTrav.status === 200 && ficheTrav.body.conflit.geometrie?.type === "Point" && ficheTrav.body.regle?.code === "RC-2D-0.1" && ficheTrav.body.sources.length === 2
    && ficheTrav.body.avertissements.length === 3 && ficheTrav.body.largeurs.chausseeM === 7, ficheTrav.body.conflit);

  // AT-06 : un reseau approximatif (classe inconnue) est A INVESTIGUER, jamais un conflit potentiel.
  const idW = await trouver(PID, "Axe A", "INTERSECTION_CHAUSSEE", "Eau-Marqueur W");
  const ficheW = await get(`/${PID}/conflits/${idW}`);
  verifier("3. AT-06 : le reseau de classe inconnue (a 2 m de l'axe, en chaussee) est A_INVESTIGUER, classe nulle, jamais POTENTIEL ; le motif est PRECISION_INCONNUE",
    ficheW.body.conflit.statut === "A_INVESTIGUER" && ficheW.body.conflit.classePrecision === null && ficheW.body.historique[0].action === "CREATION"
    && JSON.stringify(ficheW.body.historique[0].donnees.motifs) === JSON.stringify(["PRECISION_INCONNUE"]), ficheW.body);
  const idL2 = await trouver(PID, "Axe A", "INTERSECTION_CHAUSSEE", L("L2"));
  const ficheL2 = await get(`/${PID}/conflits/${idL2}`);
  exemples["conflit_fiche"] = ficheL2.body;
  verifier("3. AT-06 : le meme trace de classe B est POTENTIEL, 60 m en chaussee, premiere et derniere analyse = 1, aucun responsable, aucun risque invente",
    ficheL2.body.conflit.statut === "POTENTIEL" && ficheL2.body.conflit.classePrecision === "B" && proche(ficheL2.body.conflit.mesure.longueurChausseeM, 60, 0.7) && ficheL2.body.conflit.risque === null
    && ficheL2.body.conflit.responsable === null && ficheL2.body.analyses.premiere.numero === 1 && ficheL2.body.analyses.derniere.numero === 1, ficheL2.body.conflit);

  // AT-07 : vertical non evalue.
  verifier("3. AT-07 : aucun conflit n'a son vertical evalue (14 sur 14 `verticalEvalue = false`), la fiche le dit, aucun statut humain n'est produit par le calcul",
    (await compter(`SELECT count(*) n FROM conflits_projet WHERE "projetId" = $1 AND "verticalEvalue" = false`, PID)) === 14 && ficheL2.body.avertissements.includes("Conflit vertical non évalué : profondeur et altitude absentes.")
    && ficheL2.body.historique[0].donnees.notes.includes("VERTICAL_NON_EVALUE")
    && (await compter(`SELECT count(*) n FROM conflits_projet WHERE "projetId" = $1 AND statut NOT IN ('A_INVESTIGUER','POTENTIEL')`, PID)) === 0);
  const patchVertical = await envoyer("patch", `/${PID}/conflits/${idL2}`, { verticalEvalue: true });
  verifier("3. AT-07 : aucun champ ne permet de declarer le vertical evalue (PATCH refuse : 400 CHAMPS_INVALIDES)", patchVertical.status === 400 && patchVertical.body.code === "CHAMPS_INVALIDES");

  // AT-14 : couverture insuffisante.
  const couverture = await get(`/${PID}/conflits?type=COUVERTURE_INSUFFISANTE`);
  const cB = couverture.body.conflits[0];
  verifier("3. AT-14 : l'axe B, qu'aucun jeu de reseau n'englobe, est COUVERTURE_INSUFFISANTE (A_INVESTIGUER) ; l'axe A, englobe par le jeu 3, ne l'est pas",
    couverture.body.total === 1 && cB.axe === "Axe B" && cB.statut === "A_INVESTIGUER" && cB.concessionnaire === null && cB.jeuReseauId === null && proche(cB.mesure.longueurPieceM, 150, 1), couverture.body);
  const ficheCouv = await get(`/${PID}/conflits/${cB.id}`);
  verifier("3. AT-14 : la geometrie du dossier de couverture est l'axe (LineString), le motif COUVERTURE_INSUFFISANTE, et le dossier ne dit JAMAIS « absence de reseau » : il porte l'avertissement inverse",
    ficheCouv.body.conflit.geometrie?.type === "LineString" && JSON.stringify(ficheCouv.body.historique[0].donnees.motifs) === JSON.stringify(["COUVERTURE_INSUFFISANTE"])
    && ficheCouv.body.avertissements.includes("L'absence de conflit détecté ne prouve pas l'absence de réseau."));
  const P2: string = (await envoyer("post", "", { code: "CONFLITS-AXES-SEULS", nom: "Axes sans reseau", regionId: R1 })).body.projet.id;
  await deposerEtAutoriser(P2, fAxes, { role: "AXES_TRAVAUX" }, "axes.kml");
  const aSeuls = await analyser(P2);
  verifier("3. AT-14 : un projet sans AUCUN reseau charge : tous ses axes sont COUVERTURE_INSUFFISANTE (2 dossiers A_INVESTIGUER), limite explicite, aucune « absence de reseau » deduite",
    aSeuls.status === 201 && aSeuls.body.resume.parType.COUVERTURE_INSUFFISANTE === 2 && aSeuls.body.resume.totaux.conflitsTrouves === 2 && aSeuls.body.resume.parStatut.A_INVESTIGUER === 2
    && aSeuls.body.resume.limites.some((l: string) => /Aucun réseau de concessionnaire autorisé/.test(l) && /ne prouve pas l'absence de réseau/.test(l)), aSeuls.body.resume);
  const P0: string = (await envoyer("post", "", { code: "CONFLITS-VIDE", nom: "Projet vide", regionId: R1 })).body.projet.id;
  const aVide = await analyser(P0);
  verifier("3. un projet sans aucun jeu : analyse TERMINEE a zero conflit et limite « aucun plan d'axes », jamais une erreur",
    aVide.status === 201 && aVide.body.resume.totaux.conflitsTrouves === 0 && aVide.body.resume.limites.some((l: string) => /Aucun plan d'axes autorisé/.test(l)), aVide.body);

  // Coherence avec l'analyse indicative du socle : memes objets, memes axes, memes longueurs.
  const socle = (await get(`/${PID}/analyse`)).body;
  let ecartMax = 0;
  let objetsVerifies = 0;
  for (const axe of socle.conflits.parAxe as { axe: string; objets: { nom: string; chausseeM: number; empriseM: number; croisements: number }[] }[]) {
    for (const o of axe.objets) {
      const somme = async (type: string) => Number((await sql<{ l: number | null }>(`SELECT sum((c.mesure->>'longueurPieceM')::float8) l FROM conflits_projet c JOIN projets_voirie_objets x ON x.id = c."objetId" WHERE c."projetId" = $1 AND c.axe = $2 AND x.nom = $3 AND c.type = $4::"TypeConflit"`, PID, axe.axe, o.nom, type))[0].l ?? 0);
      const cr = await compter(`SELECT count(*) n FROM conflits_projet c JOIN projets_voirie_objets x ON x.id = c."objetId" WHERE c."projetId" = $1 AND c.axe = $2 AND x.nom = $3 AND c.type = 'TRAVERSEE'`, PID, axe.axe, o.nom);
      const chaussee = await somme("INTERSECTION_CHAUSSEE"), emprise = chaussee + await somme("INTERSECTION_EMPRISE");
      ecartMax = Math.max(ecartMax, Math.abs(chaussee - o.chausseeM), Math.abs(emprise - o.empriseM));
      if (cr !== o.croisements) ecartMax = Math.max(ecartMax, 99);
      objetsVerifies += 1;
    }
  }
  verifier(`3. la mesure des conflits est celle de l'analyse indicative du socle pour le meme axe et le meme objet (${objetsVerifies} couples axe x objet, ecart maximal ${ecartMax.toFixed(3)} m, croisements egaux)`, objetsVerifies >= 8 && ecartMax <= 0.02, { objetsVerifies, ecartMax });

  // Referentiel en lecture seule : troncons proches.
  verifier("3. superposition avec le referentiel (lecture seule) : le troncon a 5 m de l'axe est cite (code et nom), le troncon a 600 m ne l'est pas",
    ficheL2.body.tronconsProches.some((t: { code: string; nom: string }) => t.code === "BANC-T-PROCHE" && t.nom.length > 0) && !ficheL2.body.tronconsProches.some((t: { code: string }) => t.code === "BANC-T-LOIN"), ficheL2.body.tronconsProches);

  // ================================================================ 4. Rejeu idempotent et comparaison
  const histoAvant = await compter(`SELECT count(*) n FROM conflits_projet_historique h JOIN conflits_projet c ON c.id = h."conflitId" WHERE c."projetId" = $1`, PID);
  const conflitsAvant = await sql<{ id: string; cle: string; statut: string }>(`SELECT id, cle, statut::text FROM conflits_projet WHERE "projetId" = $1 ORDER BY cle`, PID);
  const a2 = await analyser();
  const A2: string = a2.body.analyse?.id;
  const r2 = a2.body.resume;
  verifier("4. REJEU IDEMPOTENT : meme entrees => 14 conflits retrouves, 14 identiques, 0 nouveau, 0 modifie, 0 disparu, 0 a reexaminer", a2.status === 201 && a2.body.analyse.numero === 2
    && r2.nouveaux === 0 && r2.retrouves === 14 && r2.identiques === 14 && r2.modifies === 0 && r2.disparus === 0 && r2.marquesAReexaminer === 0, r2);
  const conflitsApres = await sql<{ id: string; cle: string; statut: string; d: string; p: string }>(`SELECT id, cle, statut::text, "derniereAnalyseId" d, "premiereAnalyseId" p FROM conflits_projet WHERE "projetId" = $1 ORDER BY cle`, PID);
  verifier("4. memes lignes, memes identifiants, memes cles ; derniere analyse = 2, premiere analyse = 1 ; aucune ligne d'historique ajoutee (aucun bruit)",
    JSON.stringify(conflitsAvant.map((c) => [c.id, c.cle, c.statut])) === JSON.stringify(conflitsApres.map((c) => [c.id, c.cle, c.statut])) && conflitsApres.every((c) => c.d === A2 && c.p === A1)
    && (await compter(`SELECT count(*) n FROM conflits_projet_historique h JOIN conflits_projet c ON c.id = h."conflitId" WHERE c."projetId" = $1`, PID)) === histoAvant);
  const inst = await sql<{ a: string; b: string }>(`SELECT (SELECT instantane::text FROM analyses_conflit_projet WHERE id = $1) a, (SELECT instantane::text FROM analyses_conflit_projet WHERE id = $2) b`, A1, A2);
  verifier("4. reproductibilite : les deux analyses portent le meme instantane (memes cles, memes empreintes de mesure)", inst[0].a === inst[0].b && Object.keys(JSON.parse(inst[0].a)).length === 14);
  const cmp12 = await get(`/${PID}/analyses/${A2}/comparaison?avec=${A1}`);
  exemples["comparaison_identique"] = { ...cmp12.body, identiques: { nb: cmp12.body.identiques?.nb, cles: cmp12.body.identiques?.cles?.slice(0, 2) } };
  verifier("4. comparaison A2 contre A1 : aucun apparu, aucun disparu, aucun modifie, 14 identiques ; reference et comparee nommees",
    cmp12.status === 200 && cmp12.body.apparus.nb === 0 && cmp12.body.disparus.nb === 0 && cmp12.body.modifies.nb === 0 && cmp12.body.identiques.nb === 14
    && cmp12.body.reference.id === A1 && cmp12.body.comparee.id === A2 && cmp12.body.identiques.cles.length === 14, { ...cmp12.body, identiques: undefined });
  const lAn = await get(`/${PID}/analyses`);
  exemples["analyses_liste"] = { ...lAn.body, analyses: lAn.body.analyses.map((a: Record<string, unknown>) => ({ ...a, jeux: "[...]", regles: "[...]" })) };
  verifier("4. historique des analyses : 2 analyses, la plus recente d'abord ; detail d'une analyse rend versions, regles et resume",
    lAn.body.analyses.length === 2 && lAn.body.analyses[0].numero === 2 && lAn.body.analyses[0].nbConflitsTrouves === 14 && (await get(`/${PID}/analyses/${A1}`)).body.analyse.jeux.length === 4);
  const pag = await get(`/${PID}/analyses?limite=1`);
  verifier("4. pagination des analyses : limite 1, curseur suivant, puis la premiere ; curseur invalide : 400", pag.body.analyses.length === 1 && !!pag.body.curseurSuivant
    && (await get(`/${PID}/analyses?limite=1&curseur=${encodeURIComponent(pag.body.curseurSuivant)}`)).body.analyses[0].numero === 1 && (await get(`/${PID}/analyses?curseur=zzz`)).body.code === "CURSEUR_INVALIDE");
  verifier("4. une analyse d'un autre projet : 404 ANALYSE_INTROUVABLE", (await get(`/${P2}/analyses/${A1}`)).status === 404 && (await get(`/${PID}/analyses/${A2}/comparaison?avec=${aSeuls.body.analyse.id}`)).body.code === "ANALYSE_INTROUVABLE");

  // ================================================================ 5. Liste filtrable, compteurs, pagination, export, trace de consultation
  const comptesSql = async (where: string) => compter(`SELECT count(*) n FROM conflits_projet c WHERE c."projetId" = $1 AND ${where}`, PID);
  const liste = (q: string, t = T.chef) => get(`/${PID}/conflits${q}`, t);
  const lAll = await liste("?limite=200");
  exemples["conflits_liste"] = { ...lAll.body, conflits: lAll.body.conflits.slice(0, 2) };
  verifier("5. liste : 14 conflits, compteurs par statut dont la somme est le total (12 POTENTIEL, 2 A_INVESTIGUER, 0 pour les autres)",
    lAll.body.conflits.length === 14 && lAll.body.total === 14 && lAll.body.compteurs.POTENTIEL === 12 && lAll.body.compteurs.A_INVESTIGUER === 2 && lAll.body.compteurs.CONFIRME === 0 && lAll.body.compteurs.CLOTURE === 0, lAll.body.compteurs);
  verifier("5. chaque ligne porte des champs sans geometrie : boite englobante (bbox), responsable, echeance, motif, jeu, objet",
    lAll.body.conflits.every((c: { bbox: number[]; geometrie?: unknown; objet: unknown }) => c.bbox.length === 4 && c.geometrie === undefined && "objet" in c) && !JSON.stringify(lAll.body).includes("coordinates"));
  const p1 = await liste("?limite=5");
  const p2 = await liste(`?limite=5&curseur=${encodeURIComponent(p1.body.curseurSuivant)}`);
  const p3 = await liste(`?limite=5&curseur=${encodeURIComponent(p2.body.curseurSuivant)}`);
  const idsPages = [...p1.body.conflits, ...p2.body.conflits, ...p3.body.conflits].map((c: { id: string }) => c.id);
  verifier("5. pagination par curseur : 5 + 5 + 4 conflits, sans doublon ni saut, dernier curseur nul ; curseur invalide : 400 CURSEUR_INVALIDE",
    p1.body.conflits.length === 5 && p2.body.conflits.length === 5 && p3.body.conflits.length === 4 && new Set(idsPages).size === 14 && p3.body.curseurSuivant === null
    && (await liste("?curseur=zzz")).body.code === "CURSEUR_INVALIDE");
  const filtres: [string, string][] = [
    ["statut=A_INVESTIGUER", `c.statut = 'A_INVESTIGUER'`], ["statut=POTENTIEL,A_INVESTIGUER", `c.statut IN ('POTENTIEL','A_INVESTIGUER')`], ["type=TRAVERSEE", `c.type = 'TRAVERSEE'`],
    ["type=INTERSECTION_CHAUSSEE,PROXIMITE", `c.type IN ('INTERSECTION_CHAUSSEE','PROXIMITE')`], ["axe=axe%20b", `lower(c.axe) = 'axe b'`],
    [`concessionnaireId=${CONC1}`, `c."concessionnaireId" = '${CONC1}'`], [`concessionnaireId=${CONC2}`, `c."concessionnaireId" = '${CONC2}'`],
    ["aReexaminer=false", `c."aReexaminer" = false`], ["aReexaminer=true", `c."aReexaminer" = true`], ["echeanceDepassee=true", `false`],
    ["q=fibre-marqueur%20l2", `EXISTS (SELECT 1 FROM projets_voirie_objets o WHERE o.id = c."objetId" AND o.nom ILIKE '%fibre-marqueur l2%')`],
    ["q=eaux", `EXISTS (SELECT 1 FROM concessionnaires_reseau k WHERE k.id = c."concessionnaireId" AND k.nom ILIKE '%eaux%')`],
  ];
  const ecarts: string[] = [];
  for (const [q, oracle] of filtres) {
    const api = (await liste(`?limite=200&${q}`)).body.total as number;
    const n = await comptesSql(oracle);
    if (api !== n) ecarts.push(`${q}: api ${api}, sql ${n}`);
  }
  verifier(`5. chaque filtre (statut, type, axe, concessionnaire, a reexaminer, echeance depassee, q : ${filtres.length} filtres) donne le compte exact d'un oracle SQL ecrit a part`, ecarts.length === 0, ecarts);
  const hostiles = await Promise.all([liste("?statut=FOO"), liste("?type=ZZZ"), liste("?limite=0"), liste("?limite=201"), liste("?concessionnaireId=xyz"), liste("?aReexaminer=peut-etre"), liste("?inconnu=1"), liste("?q=%00")]);
  verifier("5. filtres invalides ou inconnus : 400, jamais 500", hostiles.every((r) => r.status === 400), hostiles.map((r) => r.status));

  // Trace des consultations (comme le socle) : une ligne par compte, par jeu sensible et par fenetre, sans geometrie.
  await liste("?limite=200", T.lecteur);
  await get(`/${PID}/conflits/${idL2}`, T.lecteur);
  await get(`/${PID}/conflits/${idTravA}`, T.lecteur);
  const trace = await sql<{ entityId: string; after: { route: string; confidentialite: string } }>(`SELECT "entityId", after FROM audit_logs WHERE "entityType" = 'ConsultationJeuProjet' AND "userId" = $1 ORDER BY "createdAt"`, lecteur.id);
  verifier("5. la consultation des conflits d'un reseau confidentiel est TRACEE : une seule ligne par jeu (2 reseaux ont des conflits) pour le lecteur malgre trois lectures, route « conflits », sans geometrie",
    trace.length === 2 && new Set(trace.map((t) => t.entityId)).size === 2 && trace.every((t) => t.after.route === "conflits" && t.after.confidentialite === "CONFIDENTIEL_CONCESSIONNAIRE")
    && trace.some((t) => t.entityId === JEU_R1) && trace.some((t) => t.entityId === JEU_R2) && !JSON.stringify(trace).includes("coordinates"), trace);

  // Export CSV.
  const exp0 = await get(`/${PID}/conflits/export.csv`);
  verifier("5. export CSV (GESTIONNAIRE) : text/csv, BOM, separateur ;, un conflit par ligne (14), aucune geometrie, en-tete du contrat, nom de fichier du projet",
    exp0.status === 200 && /text\/csv/.test(exp0.headers["content-type"]) && exp0.text.startsWith("﻿axe;type;statut;") && exp0.text.trim().split(/\r?\n/).length === 15
    && exp0.headers["x-lignes-exportees"] === "14" && /conflits-conflits-1-\d{4}-\d{2}-\d{2}\.csv/.test(exp0.headers["content-disposition"]) && !/LINESTRING|POINT\(|coordinates|0102000020/.test(exp0.text), exp0.text.slice(0, 200));
  exemples["export_csv"] = exp0.text.split(/\r?\n/).slice(0, 3).join("\n");
  verifier("5. l'export est AUDITE (ExportConflitsProjetVoirie, sans geometrie) ; un lecteur ne peut pas exporter (403) ; un filtre invalide : 400",
    (await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'ExportConflitsProjetVoirie' AND "entityId" = $1 AND "userId" = $2`, PID, chef.id)) === 1
    && (await get(`/${PID}/conflits/export.csv`, T.lecteur)).status === 403 && (await get(`/${PID}/conflits/export.csv?statut=FOO`)).status === 400);

  // ================================================================ 6. Machine a etats, AT-08 (infirmation conservee)
  const st = (id: string, corps: unknown, t = T.chef) => envoyer("post", `/${PID}/conflits/${id}/statut`, corps, t);
  const court = await st(idW, { vers: "INFIRME", justification: "court" });
  verifier("6. justification de moins de 10 caracteres : 422 JUSTIFICATION_REQUISE", court.status === 422 && court.body.code === "JUSTIFICATION_REQUISE");
  const interdite = await st(idW, { vers: "CLOTURE", justification: JUSTIF });
  exemples["erreur_transition_interdite"] = interdite.body;
  verifier("6. transition absente du tableau (A_INVESTIGUER vers CLOTURE) : 409 TRANSITION_INTERDITE", interdite.status === 409 && interdite.body.code === "TRANSITION_INTERDITE");
  verifier("6. statut inconnu ou champ en trop : 400", (await st(idW, { vers: "ANNULE", justification: JUSTIF })).status === 400 && (await st(idW, { vers: "INFIRME", justification: JUSTIF, auteur: "x" })).status === 400);
  verifier("6. un LECTEUR ne change aucun statut (403), le conflit ne bouge pas", (await st(idW, { vers: "INFIRME", justification: JUSTIF }, T.lecteur)).status === 403 && (await statutDe(idW)).statut === "A_INVESTIGUER");

  const infirme = await st(idW, { vers: "INFIRME", justification: "Trace controle sur le terrain : il s'agit d'un fourreau vide" });
  exemples["statut_infirme"] = infirme.body;
  verifier("6. AT-08 : A_INVESTIGUER vers INFIRME par un GESTIONNAIRE avec justification : 200, statut INFIRME", infirme.status === 200 && infirme.body.conflit.statut === "INFIRME", infirme.body);
  const ficheInf = await get(`/${PID}/conflits/${idW}`);
  const hStat = ficheInf.body.historique.find((h: { action: string }) => h.action === "STATUT");
  verifier("6. AT-08 : l'infirmation est CONSERVEE avec son auteur, sa date, sa justification, l'ancien et le nouveau statut ; la proposition initiale reste consultable (ligne CREATION et mesure)",
    hStat?.acteur?.nomComplet === "Sekou Gestionnaire" && !!hStat.createdAt && /fourreau vide/.test(hStat.justification) && hStat.ancienStatut === "A_INVESTIGUER" && hStat.nouveauStatut === "INFIRME"
    && ficheInf.body.historique[0].action === "CREATION" && ficheInf.body.historique[0].nouveauStatut === "A_INVESTIGUER" && ficheInf.body.conflit.mesure.longueurChausseeM > 59, ficheInf.body.historique);
  verifier("6. un conflit infirme reste liste (pas de suppression) et offre la reouverture (vers A_INVESTIGUER)",
    (await liste("?statut=INFIRME")).body.total === 1 && ficheInf.body.transitionsPossibles.some((t: { vers: string }) => t.vers === "A_INVESTIGUER"));

  // Reouverture d'un conflit infirme, puis retour a POTENTIEL (L6 en emprise).
  const idL6e = await trouver(PID, "Axe A", "INTERSECTION_EMPRISE", L("L6"));
  await st(idL6e, { vers: "INFIRME", justification: "Essai d'infirmation puis de reouverture" });
  const reouv = await st(idL6e, { vers: "A_INVESTIGUER", justification: "Reouverture : nouvelle information de l'operateur" });
  const retour = await st(idL6e, { vers: "POTENTIEL", justification: "Precision confirmee par l'operateur, classe B" });
  verifier("6. reouverture (INFIRME vers A_INVESTIGUER) puis A_INVESTIGUER vers POTENTIEL : 200, 3 transitions historisees", reouv.body.conflit?.statut === "A_INVESTIGUER" && retour.body.conflit?.statut === "POTENTIEL"
    && (await compter(`SELECT count(*) n FROM conflits_projet_historique WHERE "conflitId" = $1 AND action = 'STATUT'`, idL6e)) === 3);

  // Preuve requise pour CONFIRME ; decision requise pour TRAITEMENT_DECIDE ; roles.
  const sansPreuve = await st(idL2, { vers: "CONFIRME", justification: JUSTIF });
  verifier("6. POTENTIEL vers CONFIRME sans preuve : 409 PREUVE_REQUISE", sansPreuve.status === 409 && sansPreuve.body.code === "PREUVE_REQUISE", sansPreuve.body);
  const preuveInvalide = await envoyer("post", `/${PID}/conflits/${idL2}/preuves`, { type: "PHOTO", texte: "x" });
  const preuve = await envoyer("post", `/${PID}/conflits/${idL2}/preuves`, { type: "REFERENCE_DOCUMENT", texte: "Courrier de l'operateur confirmant le passage du cable", reference: "Courrier 2026/045" });
  exemples["preuve"] = preuve.body;
  verifier("6. preuve : type inconnu 400 ; une preuve valide 201 avec son auteur, ligne PREUVE dans l'historique ; un lecteur ne peut pas (403)",
    preuveInvalide.status === 400 && preuve.status === 201 && preuve.body.preuve.auteur.nomComplet === "Sekou Gestionnaire" && preuve.body.preuve.reference === "Courrier 2026/045"
    && (await envoyer("post", `/${PID}/conflits/${idL2}/preuves`, { type: "NOTE", texte: "x" }, T.lecteur)).status === 403
    && (await compter(`SELECT count(*) n FROM conflits_projet_historique WHERE "conflitId" = $1 AND action = 'PREUVE'`, idL2)) === 1);
  const confirme = await st(idL2, { vers: "CONFIRME", justification: "Passage du cable confirme par courrier de l'operateur" });
  verifier("6. avec une preuve, POTENTIEL vers CONFIRME : 200", confirme.status === 200 && confirme.body.conflit.statut === "CONFIRME", confirme.body);
  const sansDecision = await st(idL2, { vers: "TRAITEMENT_DECIDE", justification: JUSTIF });
  verifier("6. CONFIRME vers TRAITEMENT_DECIDE sans decision approuvee : 409 DECISION_REQUISE", sansDecision.status === 409 && sansDecision.body.code === "DECISION_REQUISE");
  const roleKo = await st(idL2, { vers: "INFIRME", justification: JUSTIF });
  verifier("6. CONFIRME vers INFIRME est reserve a l'ADMIN : GESTIONNAIRE 403 ROLE_INSUFFISANT", roleKo.status === 403 && roleKo.body.code === "ROLE_INSUFFISANT", roleKo.body);

  // ================================================================ 7. AT-09 : decision de deplacement, responsable, planning, separation des taches
  const idP = await trouver(PID, "Axe A", "INTERSECTION_CHAUSSEE", L("P"));
  const patch = await envoyer("patch", `/${PID}/conflits/${idP}`, { responsableId: chef2.id, echeance: "2099-01-31", risque: "ELEVE", actionProposee: "Verifier la profondeur avec l'operateur avant tout travaux" });
  exemples["patch_attribution"] = patch.body;
  const ficheP0 = (await get(`/${PID}/conflits/${idP}`)).body;
  verifier("7. attribution (responsable, echeance, risque, action proposee) : 200, historisee (ATTRIBUTION avec les valeurs avant et apres, auteur)",
    patch.status === 200 && patch.body.modifie === true && patch.body.conflit.responsable.nomComplet === "Fanta Gestionnaire" && patch.body.conflit.echeance === "2099-01-31" && patch.body.conflit.risque === "ELEVE"
    && ficheP0.historique.some((h: { action: string; donnees: { responsableId?: { avant: unknown; apres: string } } }) => h.action === "ATTRIBUTION" && h.donnees.responsableId?.apres === chef2.id && h.donnees.responsableId.avant === null), ficheP0.historique);
  verifier("7. PATCH sans changement : 200, modifie=false ; responsable inconnu : 400 RESPONSABLE_INCONNU ; champ interdit (statut, aReexaminer vrai) ou corps vide : 400",
    (await envoyer("patch", `/${PID}/conflits/${idP}`, { risque: "ELEVE" })).body.modifie === false && (await envoyer("patch", `/${PID}/conflits/${idP}`, { responsableId: UUID0 })).body.code === "RESPONSABLE_INCONNU"
    && (await envoyer("patch", `/${PID}/conflits/${idP}`, { statut: "CLOTURE" })).status === 400 && (await envoyer("patch", `/${PID}/conflits/${idP}`, { aReexaminer: true })).status === 400 && (await envoyer("patch", `/${PID}/conflits/${idP}`, {})).status === 400);
  verifier("7. un lecteur ne modifie pas un dossier (403)", (await envoyer("patch", `/${PID}/conflits/${idP}`, { risque: "FAIBLE" }, T.lecteur)).status === 403);
  const propoTot = await envoyer("post", `/${PID}/conflits/${idP}/decisions`, { option: "PROTEGER", justification: JUSTIF });
  verifier("7. une decision ne se propose que pour un conflit CONFIRME : 409 STATUT_INCOMPATIBLE", propoTot.status === 409 && propoTot.body.code === "STATUT_INCOMPATIBLE");
  await envoyer("post", `/${PID}/conflits/${idP}/preuves`, { type: "RELEVE_TERRAIN", texte: "Releve de terrain : cable visible dans le caniveau", reference: "Releve R-12" });
  verifier("7. P : POTENTIEL vers CONFIRME", (await st(idP, { vers: "CONFIRME", justification: "Cable constate sur le terrain (releve R-12)" })).body.conflit?.statut === "CONFIRME");

  const sansPlanning = await envoyer("post", `/${PID}/conflits/${idP}/decisions`, { option: "DEPLACER_RESEAU", justification: "Deplacement du cable propose par l'entreprise" });
  verifier("7. AT-09 : DEPLACER_RESEAU sans planning : 422 PLANNING_REQUIS", sansPlanning.status === 422 && sansPlanning.body.code === "PLANNING_REQUIS", sansPlanning.body);
  const sansResp = await envoyer("post", `/${PID}/conflits/${idL2}/decisions`, { option: "DEPLACER_RESEAU", justification: "Deplacement propose, responsable a designer", dateDebutPrevue: "2026-12-01", dateFinPrevue: "2026-12-10" });
  verifier("7. AT-09 : DEPLACER_RESEAU sur un dossier sans responsable : 422 RESPONSABLE_REQUIS", sansResp.status === 422 && sansResp.body.code === "RESPONSABLE_REQUIS", sansResp.body);
  const invalides = await Promise.all([
    envoyer("post", `/${PID}/conflits/${idP}/decisions`, { option: "ORDONNER", justification: JUSTIF }),
    envoyer("post", `/${PID}/conflits/${idP}/decisions`, { option: "PROTEGER", justification: JUSTIF, coutEstime: 100 }),
    envoyer("post", `/${PID}/conflits/${idP}/decisions`, { option: "PROTEGER", justification: JUSTIF, coutEstime: -5, deviseCout: "GNF" }),
    envoyer("post", `/${PID}/conflits/${idP}/decisions`, { option: "PROTEGER", justification: JUSTIF, deviseCout: "guinee" }),
    envoyer("post", `/${PID}/conflits/${idP}/decisions`, { option: "PROTEGER", justification: JUSTIF, ordre: "deplacer" }),
    envoyer("post", `/${PID}/conflits/${idP}/decisions`, { option: "PROTEGER", justification: "court" }),
    envoyer("post", `/${PID}/conflits/${idP}/decisions`, { option: "PROTEGER", justification: JUSTIF, dateDebutPrevue: "2026-12-10", dateFinPrevue: "2026-12-01" }),
  ]);
  verifier("7. propositions invalides : option inconnue, cout sans devise, cout negatif, devise mal formee, champ en trop : 400 ; justification courte ou dates inversees : 422",
    invalides.slice(0, 5).every((r) => r.status === 400) && invalides[5].status === 422 && invalides[6].status === 422, invalides.map((r) => [r.status, r.body.code]));

  const propose = await envoyer("post", `/${PID}/conflits/${idP}/decisions`, {
    option: "DEPLACER_RESEAU", justification: "Deplacement du cable propose : la chaussee prevue le recouvre sur 7 m", contraintes: "Coupure de service a coordonner avec l'operateur",
    coutEstime: 12500000.5, deviseCout: "GNF", dateDebutPrevue: "2026-12-01", dateFinPrevue: "2026-12-20",
  });
  exemples["decision_proposee"] = propose.body;
  const D1: string = propose.body.decision?.id;
  verifier("7. AT-09 : decision de deplacement PROPOSEE avec responsable (sur le dossier), planning, cout ESTIME ; cout REEL distinct et vide (jamais calcule)",
    propose.status === 201 && propose.body.decision.statut === "PROPOSEE" && propose.body.decision.proposePar.nomComplet === "Sekou Gestionnaire" && propose.body.decision.coutEstime === 12500000.5
    && propose.body.decision.coutReel === null && propose.body.decision.deviseCout === "GNF" && propose.body.decision.dateDebutPrevue === "2026-12-01" && propose.body.decision.dateFinPrevue === "2026-12-20", propose.body);
  verifier("7. la decision proposee ne change PAS le statut du conflit (reste CONFIRME) : aucun ordre, aucune decision automatique", (await statutDe(idP)).statut === "CONFIRME");

  const meme = await envoyer("post", `/${PID}/conflits/${idP}/decisions/${D1}/approuver`, { motif: "Approbation de ma propre proposition" });
  exemples["erreur_separation_des_taches"] = meme.body;
  verifier("7. AT-09 separation des taches : le proposant ne peut pas approuver sa decision de deplacement : 409 SEPARATION_DES_TACHES", meme.status === 409 && meme.body.code === "SEPARATION_DES_TACHES", meme.body);
  const memeDero = await envoyer("post", `/${PID}/conflits/${idP}/decisions/${D1}/approuver`, { motif: "Approbation de ma propre proposition", derogation: "Je suis seul disponible aujourd'hui" });
  verifier("7. ... meme avec une derogation, un GESTIONNAIRE ne deroge pas pour un deplacement de reseau (seul un ADMIN) : 409", memeDero.status === 409 && memeDero.body.code === "SEPARATION_DES_TACHES");
  verifier("7. approuver sans motif suffisant : 422 ; un lecteur ne tranche pas (403) ; decision inconnue : 404 DECISION_INTROUVABLE",
    (await envoyer("post", `/${PID}/conflits/${idP}/decisions/${D1}/approuver`, { motif: "ok" }, T.chef2)).status === 422
    && (await envoyer("post", `/${PID}/conflits/${idP}/decisions/${D1}/approuver`, { motif: JUSTIF }, T.lecteur)).status === 403
    && (await envoyer("post", `/${PID}/conflits/${idP}/decisions/${UUID0}/approuver`, { motif: JUSTIF }, T.chef2)).body.code === "DECISION_INTROUVABLE");
  const approuve = await envoyer("post", `/${PID}/conflits/${idP}/decisions/${D1}/approuver`, { motif: "Decision validee : le deplacement est la seule option viable" }, T.chef2);
  exemples["decision_approuvee"] = approuve.body;
  verifier("7. AT-09 : une autre personne approuve : 200, APPROUVEE, approbateur et date enregistres, aucune derogation", approuve.status === 200 && approuve.body.decision.statut === "APPROUVEE"
    && approuve.body.decision.approuvePar.nomComplet === "Fanta Gestionnaire" && !!approuve.body.decision.approuveLe && approuve.body.decision.derogationSeparation === null, approuve.body);
  verifier("7. une decision approuvee ne se retranche plus : 409 DECISION_DEJA_TRANCHEE (approuver ou refuser)",
    (await envoyer("post", `/${PID}/conflits/${idP}/decisions/${D1}/approuver`, { motif: JUSTIF }, T.chef2)).body.code === "DECISION_DEJA_TRANCHEE" && (await envoyer("post", `/${PID}/conflits/${idP}/decisions/${D1}/refuser`, { motif: JUSTIF }, T.chef2)).body.code === "DECISION_DEJA_TRANCHEE");

  // Derogation d'un ADMIN (au moins deux comptes habilites) pour sa propre proposition ; refus d'une proposition.
  const nbHab = await depotConflits.compterComptesHabilites(prisma, R1);
  verifier("7. comptes habilites a decider sur le projet de la region 1 : ADMIN, deux GESTIONNAIRES nationaux et le regional 1 = 4 (oracle : le lecteur, le compte sans cle et le regional 2 sont exclus)", nbHab === 4, nbHab);
  const d2 = (await envoyer("post", `/${PID}/conflits/${idP}/decisions`, { option: "PROTEGER", justification: "Protection mecanique du cable pendant les travaux" }, T.admin)).body.decision.id as string;
  const own = await envoyer("post", `/${PID}/conflits/${idP}/decisions/${d2}/approuver`, { motif: "Ma propre decision" }, T.admin);
  const ownDero = await envoyer("post", `/${PID}/conflits/${idP}/decisions/${d2}/approuver`, { motif: "Ma propre decision", derogation: "Le deuxieme administrateur est en mission" }, T.admin);
  verifier("7. un ADMIN qui approuve sa propre decision : 409 sans derogation ; avec une derogation motivee : 200, derogation ENREGISTREE sur la decision, dans l'historique et dans l'audit",
    own.body.code === "SEPARATION_DES_TACHES" && ownDero.status === 200 && ownDero.body.decision.derogationSeparation === "Le deuxieme administrateur est en mission"
    && (await compter(`SELECT count(*) n FROM conflits_projet_historique WHERE "conflitId" = $1 AND action = 'DECISION_APPROUVEE' AND donnees->>'derogationSeparation' IS NOT NULL`, idP)) === 1
    && (await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'ConflitProjet' AND "entityId" = $1 AND after->>'derogationSeparation' IS NOT NULL AND after->>'memePersonne' = 'true'`, idP)) === 1, ownDero.body);
  const d3 = (await envoyer("post", `/${PID}/conflits/${idP}/decisions`, { option: "A_ETUDIER", justification: "Etude complementaire proposee par l'entreprise" })).body.decision.id as string;
  const refus = await envoyer("post", `/${PID}/conflits/${idP}/decisions/${d3}/refuser`, { motif: "Etude inutile : la position est deja connue" }, T.chef2);
  verifier("7. refus d'une proposition : 200, REFUSEE, motif et auteur enregistres, ligne DECISION_REFUSEE ; une decision refusee ne s'approuve plus (409)",
    refus.status === 200 && refus.body.decision.statut === "REFUSEE" && refus.body.decision.approuvePar.nomComplet === "Fanta Gestionnaire"
    && (await envoyer("post", `/${PID}/conflits/${idP}/decisions/${d3}/approuver`, { motif: JUSTIF }, T.chef2)).body.code === "DECISION_DEJA_TRANCHEE"
    && (await compter(`SELECT count(*) n FROM conflits_projet_historique WHERE "conflitId" = $1 AND action = 'DECISION_REFUSEE'`, idP)) === 1);

  // Traitement decide puis cloture : recolement, separation.
  const traitement = await st(idP, { vers: "TRAITEMENT_DECIDE", justification: "Decision de deplacement approuvee, planning arrete" });
  verifier("7. CONFIRME vers TRAITEMENT_DECIDE avec une decision approuvee : 200", traitement.status === 200 && traitement.body.conflit.statut === "TRAITEMENT_DECIDE", traitement.body);
  const sansMention = await st(idP, { vers: "CLOTURE", justification: "Travaux de deplacement termines et constates" }, T.admin);
  verifier("7. AT-09 : cloture d'un dossier a deplacement de reseau sans mention du recolement : 422 MENTION_RECOLEMENT_REQUISE", sansMention.status === 422 && sansMention.body.code === "MENTION_RECOLEMENT_REQUISE", sansMention.body);
  verifier("7. la cloture est reservee a l'ADMIN : GESTIONNAIRE 403", (await st(idP, { vers: "CLOTURE", justification: "Travaux termines et constates", recolementAValider: true })).status === 403);
  const clos = await st(idP, { vers: "CLOTURE", justification: "Travaux de deplacement termines et constates sur place", recolementAValider: true }, T.admin);
  exemples["statut_cloture"] = clos.body;
  const histoClos = (await get(`/${PID}/conflits/${idP}`)).body.historique.filter((h: { nouveauStatut: string }) => h.nouveauStatut === "CLOTURE")[0];
  verifier("7. AT-09 : cloture par l'ADMIN avec la mention du recolement (« reste a valider », non gere dans ce lot) : 200, CLOTURE, acteur identifie, motif et mention dans l'historique",
    clos.status === 200 && clos.body.conflit.statut === "CLOTURE" && histoClos.acteur.nomComplet === "Mariama Admin" && histoClos.donnees.recolementAValider === true && /deplacement termines/.test(histoClos.justification), histoClos);
  verifier("7. un conflit clos n'a plus aucune transition possible", (await get(`/${PID}/conflits/${idP}`, T.admin)).body.transitionsPossibles.length === 0 && (await st(idP, { vers: "A_INVESTIGUER", justification: JUSTIF }, T.admin)).body.code === "TRANSITION_INTERDITE");

  // Separation a la cloture : la personne qui a place le dossier en TRAITEMENT_DECIDE ne le cloture pas sans derogation.
  const idK = await trouver(PID, "Axe B", "INTERSECTION_CHAUSSEE", L("K"));
  await envoyer("post", `/${PID}/conflits/${idK}/preuves`, { type: "NOTE", texte: "Cable vu lors de la reunion de chantier" });
  await st(idK, { vers: "CONFIRME", justification: "Cable vu lors de la reunion de chantier du 05/11" }, T.admin);
  const dk = (await envoyer("post", `/${PID}/conflits/${idK}/decisions`, { option: "SANS_INTERVENTION", justification: "Le cable est protege par un fourreau beton" }, T.chef)).body.decision.id as string;
  await envoyer("post", `/${PID}/conflits/${idK}/decisions/${dk}/approuver`, { motif: "Fourreau beton constate : aucune intervention" }, T.chef2);
  await st(idK, { vers: "TRAITEMENT_DECIDE", justification: "Aucune intervention : decision approuvee" }, T.admin);
  const memeClot = await st(idK, { vers: "CLOTURE", justification: "Dossier clos, aucune intervention necessaire" }, T.admin);
  verifier("7. cloture par la personne qui a place le dossier en traitement decide : 409 SEPARATION_DES_TACHES", memeClot.status === 409 && memeClot.body.code === "SEPARATION_DES_TACHES", memeClot.body);
  const memeClotDero = await st(idK, { vers: "CLOTURE", justification: "Dossier clos, aucune intervention necessaire", derogation: "Aucun autre administrateur n'est disponible" }, T.admin);
  verifier("7. ... sauf derogation motivee d'un ADMIN, tracee dans l'historique", memeClotDero.status === 200 && (await compter(`SELECT count(*) n FROM conflits_projet_historique WHERE "conflitId" = $1 AND action = 'STATUT' AND donnees->>'derogationSeparation' IS NOT NULL`, idK)) === 1);

  // Un seul compte habilite : la base compte les comptes actifs du perimetre.
  await sql(`UPDATE users SET actif = false WHERE id = ANY($1::text[])`, [chef.id, chef2.id, reg1.id]);
  const seul = await depotConflits.compterComptesHabilites(prisma, R1);
  await sql(`UPDATE users SET actif = true WHERE id = ANY($1::text[])`, [chef.id, chef2.id, reg1.id]);
  const sansRegion = await depotConflits.compterComptesHabilites(prisma, null);
  verifier("7. comptes habilites : 1 seul (l'ADMIN) quand les autres sont inactifs ; pour un projet sans region, seuls les comptes nationaux comptent (ADMIN, deux GESTIONNAIRES = 3)",
    seul === 1 && sansRegion === 3 && (await depotConflits.compterComptesHabilites(prisma, R1)) === 4, { seul, sansRegion });

  // ================================================================ 8. Regles versionnees et approuvees
  const reglePost = (corps: unknown, t = T.chef) => envoyer("post", `/${PID}/regles`, corps, t);
  const rBad = await Promise.all([reglePost({ code: "X", toleranceProximiteM: 1, justification: JUSTIF }), reglePost({ code: "TOL-TELECOM", toleranceProximiteM: -1, justification: JUSTIF }), reglePost({ code: "TOL-TELECOM", toleranceProximiteM: 5000, justification: JUSTIF }),
    reglePost({ code: "TOL-TELECOM", toleranceProximiteM: 1, famille: "GAZ_PLUS", justification: JUSTIF }), reglePost({ code: "TOL-TELECOM", toleranceProximiteM: 1, statut: "APPROUVEE", justification: JUSTIF })]);
  verifier("8. creation de regle invalide (code, tolerance negative ou demesuree, famille inconnue, statut impose) : 400", rBad.every((r) => r.status === 400), rBad.map((r) => r.status));
  verifier("8. creation sans justification suffisante : 422 JUSTIFICATION_REQUISE", (await reglePost({ code: "TOL-TELECOM", toleranceProximiteM: 1, justification: "court" })).status === 422);
  const rc1 = await reglePost({ famille: "TELECOM", code: "TOL-TELECOM", toleranceProximiteM: 2, margeIncertitude: 1.5, justification: "Tolerance proposee par la direction technique" });
  exemples["regle_creee"] = rc1.body;
  const RG1: string = rc1.body.regle?.id;
  verifier("8. creation d'une regle : 201, BROUILLON, version 1, rattachee au projet, auteur enregistre, jamais appliquee tant qu'elle n'est pas approuvee",
    rc1.status === 201 && rc1.body.regle.statut === "BROUILLON" && rc1.body.regle.version === 1 && rc1.body.regle.portee === "PROJET" && rc1.body.regle.creePar.nomComplet === "Sekou Gestionnaire" && rc1.body.regle.approuvePar === null, rc1.body);
  const rc2 = await reglePost({ famille: "TELECOM", code: "TOL-TELECOM", toleranceProximiteM: 3, margeIncertitude: 1, justification: "Nouvelle version plus large de la tolerance" });
  verifier("8. une regle versionnee : meme (projet, famille, code) => version 2 ; un autre code repart a 1", rc2.body.regle.version === 2 && (await reglePost({ famille: "TELECOM", code: "AUTRE-CODE", toleranceProximiteM: 1, justification: JUSTIF })).body.regle.version === 1);
  const eff0 = (await get(`/${PID}/regles`)).body.effectives.find((e: { famille: string }) => e.famille === "TELECOM");
  verifier("8. un brouillon n'est pas applique : la regle effective TELECOM reste la regle par defaut", eff0.code === "RC-2D-0.1" && eff0.portee === "DEFAUT", eff0);
  const appro = await envoyer("post", `/${PID}/regles/${RG1}/approuver`, { justification: "Approuvee apres relecture de la direction technique" }, T.admin);
  exemples["regle_approuvee"] = appro.body;
  verifier("8. l'ADMIN approuve la regle d'un autre : 200, APPROUVEE, approbateur, date et justification enregistres", appro.status === 200 && appro.body.regle.statut === "APPROUVEE" && appro.body.regle.approuvePar.nomComplet === "Mariama Admin" && !!appro.body.regle.approuveLe, appro.body);
  verifier("8. une regle approuvee est IMMUABLE : approuver a nouveau 409 REGLE_IMMUABLE ; justification courte 422", (await envoyer("post", `/${PID}/regles/${RG1}/approuver`, { justification: JUSTIF }, T.admin)).body.code === "REGLE_IMMUABLE"
    && (await envoyer("post", `/${PID}/regles/${rc2.body.regle.id}/approuver`, { justification: "ok" }, T.admin)).status === 422);
  const ra = await reglePost({ famille: "EAU_POTABLE", code: "TOL-EAU", toleranceProximiteM: 1, margeIncertitude: 1, justification: "Tolerance eau proposee par l'administrateur" }, T.admin);
  const sepRegle = await envoyer("post", `/${PID}/regles/${ra.body.regle.id}/approuver`, { justification: "Approbation de ma propre regle" }, T.admin);
  const sepRegleDero = await envoyer("post", `/${PID}/regles/${ra.body.regle.id}/approuver`, { justification: "Approbation de ma propre regle", derogation: "Un seul administrateur disponible ce jour" }, T.admin);
  verifier("8. l'auteur d'une regle ne l'approuve pas sans derogation motivee (409 SEPARATION_DES_TACHES) ; avec derogation : 200, tracee dans la regle et dans l'audit",
    sepRegle.body.code === "SEPARATION_DES_TACHES" && sepRegleDero.status === 200 && sepRegleDero.body.regle.derogationApprobation === "Un seul administrateur disponible ce jour"
    && (await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'RegleConflit' AND "entityId" = $1 AND action = 'VALIDATE' AND after->>'memePersonne' = 'true'`, ra.body.regle.id)) === 1);
  const effApres = (await get(`/${PID}/regles`)).body.effectives as { famille: string; code: string; version: number; portee: string }[];
  const effT = effApres.find((e) => e.famille === "TELECOM")!;
  verifier("8. regles effectives : TELECOM => TOL-TELECOM v1 (portee PROJET_FAMILLE), EAU_POTABLE => TOL-EAU, les autres familles => defaut",
    effT.code === "TOL-TELECOM" && effT.version === 1 && effT.portee === "PROJET_FAMILLE" && effApres.find((e) => e.famille === "EAU_POTABLE")!.code === "TOL-EAU" && effApres.find((e) => e.famille === "GAZ_HYDROCARBURES")!.portee === "DEFAUT");

  const statutsHumains = [idW, idL2, idP, idK];
  const lireStatuts = () => sql<{ id: string; statut: string }>(`SELECT id, statut::text FROM conflits_projet WHERE "projetId" = $1 AND id = ANY($2::text[]) ORDER BY id`, PID, statutsHumains);
  const avantRegle = await lireStatuts();
  const a3 = await analyser();
  const A3: string = a3.body.analyse?.id;
  const r3 = a3.body.resume;
  const idL13 = await trouver(PID, "Axe A", "PROXIMITE", L("L13"));
  const regleT = a3.body.analyse?.regles?.find((x: { famille: string }) => x.famille === "TELECOM");
  verifier("8. apres approbation, la PROCHAINE analyse applique la regle versionnee : bande de proximite 7,5 + 2 + 3,5 x 1,5 = 14,75 m => le reseau a 13 m devient un dossier PROXIMITE (nouveau, POTENTIEL), la version de la regle est enregistree",
    a3.status === 201 && r3.nouveaux === 1 && !!idL13 && (await statutDe(idL13)).statut === "POTENTIEL" && regleT?.code === "TOL-TELECOM" && regleT.version === 1 && regleT.toleranceProximiteM === 2 && regleT.margeIncertitude === 1.5, a3.body.analyse?.regles);
  verifier("8. l'analyse 1 n'a pas change : elle porte toujours la regle par defaut (reproductibilite des analyses passees)", (await get(`/${PID}/analyses/${A1}`)).body.analyse.regles.every((x: { code: string }) => x.code === "RC-2D-0.1"));
  const apresRegle = await lireStatuts();
  verifier("8. un verdict humain n'est jamais ecrase : les statuts INFIRME, CONFIRME et CLOTURE (x2) sont inchanges apres deux analyses supplementaires",
    JSON.stringify(avantRegle) === JSON.stringify(apresRegle) && apresRegle.map((x) => x.statut).sort().join() === "CLOTURE,CLOTURE,CONFIRME,INFIRME", apresRegle);

  // ================================================================ 9. AT-13 : modification d'un axe, nouvelle analyse, conflits touches identifiables, anciens conserves
  const AXES_V2: Ligne[] = [{ nom: "Axe A", coords: [[0, 4], [200, 4]] }, { nom: "Axe B", coords: [[200, 0], [200, 150]] }];
  const nAvant = await compter(`SELECT count(*) n FROM conflits_projet WHERE "projetId" = $1`, PID);
  const idsAvant = (await sql<{ id: string }>(`SELECT id FROM conflits_projet WHERE "projetId" = $1`, PID)).map((x) => x.id);
  const idL9 = await trouver(PID, "Axe A", "PROXIMITE", L("L9"));
  const JEU_AXES_V2 = await deposerEtAutoriser(PID, await kml(AXES_V2), { role: "AXES_TRAVAUX" }, "axes-v2.kml");
  const a4 = await analyser();
  const A4: string = a4.body.analyse?.id;
  const r4 = a4.body.resume;
  exemples["analyse_apres_modification_axe"] = { numero: a4.body.analyse?.numero, resume: { ...r4, limites: undefined } };
  const nApres = await compter(`SELECT count(*) n FROM conflits_projet WHERE "projetId" = $1`, PID);
  verifier("9. AT-13 : apres modification de l'axe A (decale de 4 m), une NOUVELLE analyse est versionnee (numero 4), de nouveaux conflits apparaissent, d'anciens ne sont plus retrouves, d'autres changent de mesure ou de donnees",
    a4.status === 201 && a4.body.analyse.numero === 4 && r4.nouveaux >= 3 && r4.disparus >= 3 && r4.modifies >= 1, r4);
  verifier("9. AT-13 : les anciens conflits sont TOUS conserves (aucune suppression, aucune fermeture) : tous les anciens identifiants existent encore, le total = anciens + nouveaux",
    (await compter(`SELECT count(*) n FROM conflits_projet WHERE id = ANY($1::text[])`, idsAvant)) === idsAvant.length && nApres === nAvant + r4.nouveaux, { nAvant, nApres, nouveaux: r4.nouveaux });
  const fL6 = await statutDe(idL6e), fL9 = await statutDe(idL9), fW = await statutDe(idW), fL2 = await statutDe(idL2), fP = await statutDe(idP), fL13 = await statutDe(idL13);
  verifier("9. AT-13 : un conflit qui n'est plus retrouve (L6 en emprise, L9 en proximite) reste en base, aReexaminer = true, motif NON_RETROUVE, statut inchange",
    fL6.are && fL6.motif === "NON_RETROUVE" && fL6.statut === "POTENTIEL" && fL9.are && fL9.motif === "NON_RETROUVE" && fL9.statut === "POTENTIEL", { fL6, fL9 });
  verifier("9. AT-13 : un verdict HUMAIN non retrouve est conserve tel quel (W INFIRME) et un verdict retrouve aussi (P CLOTURE, L2 CONFIRME) : seul le drapeau a reexaminer change",
    fW.statut === "INFIRME" && fW.are && fW.motif === "NON_RETROUVE" && fP.statut === "CLOTURE" && fL2.statut === "CONFIRME" && fL2.are, { fW, fP, fL2 });
  verifier("9. AT-13 : un conflit retrouve a mesure inchangee (L2 en chaussee) mais sur un NOUVEAU plan d'axes est marque NOUVELLE_VERSION_DONNEES ; un conflit retrouve a mesure modifiee (L13 en proximite, distance 13 m puis 9 m) est marque MESURE_MODIFIEE",
    fL2.motif === "NOUVELLE_VERSION_DONNEES" && fL13.motif === "MESURE_MODIFIEE" && fL13.are, { fL2, fL13 });
  const nouvChaussee = await trouver(PID, "Axe A", "INTERSECTION_CHAUSSEE", L("L6")), nouvEmprise = await trouver(PID, "Axe A", "INTERSECTION_EMPRISE", L("L9"));
  verifier("9. AT-13 : les nouveaux conflits sont crees (L6 devient chaussee, L9 devient emprise), premiere analyse = 4", !!nouvChaussee && !!nouvEmprise && (await sql<{ p: string }>(`SELECT "premiereAnalyseId" p FROM conflits_projet WHERE id = $1`, nouvChaussee))[0].p === A4);
  const cmp43 = await get(`/${PID}/analyses/${A4}/comparaison?avec=${A3}`);
  exemples["comparaison_apres_modification"] = {
    reference: cmp43.body.reference, comparee: cmp43.body.comparee, identiques: { nb: cmp43.body.identiques?.nb },
    apparus: { nb: cmp43.body.apparus?.nb, cles: cmp43.body.apparus?.cles?.slice(0, 1), conflits: cmp43.body.apparus?.conflits?.slice(0, 2), detailsTronques: false },
    disparus: { nb: cmp43.body.disparus?.nb, cles: cmp43.body.disparus?.cles?.slice(0, 1), conflits: cmp43.body.disparus?.conflits?.slice(0, 2), detailsTronques: false },
    modifies: { nb: cmp43.body.modifies?.nb, cles: cmp43.body.modifies?.cles?.slice(0, 1), conflits: cmp43.body.modifies?.conflits?.slice(0, 2), detailsTronques: false },
  };
  verifier("9. AT-13 : la comparaison A4 contre A3 rend apparus, disparus, modifies et identiques, et IDENTIFIE les conflits touches (type, axe, statut)",
    cmp43.status === 200 && cmp43.body.apparus.nb === r4.nouveaux && cmp43.body.disparus.nb === r4.disparus && cmp43.body.modifies.nb === r4.modifies && cmp43.body.apparus.nb + cmp43.body.modifies.nb + cmp43.body.identiques.nb === r4.totaux.conflitsTrouves
    && cmp43.body.disparus.conflits.some((c: { id: string }) => c.id === idL6e) && cmp43.body.apparus.conflits.some((c: { id: string }) => c.id === nouvChaussee) && cmp43.body.disparus.conflits.every((c: { type: string; axe: string; statut: string }) => !!c.type && !!c.axe && !!c.statut), { ...cmp43.body, identiques: undefined });
  const anAxes = (await get(`/${PID}/analyses/${A4}`)).body.analyse.jeux.find((j: { role: string }) => j.role === "AXES_TRAVAUX");
  const an3Axes = (await get(`/${PID}/analyses/${A3}`)).body.analyse.jeux.find((j: { role: string }) => j.role === "AXES_TRAVAUX");
  verifier("9. AT-13 : les analyses sont reproductibles et immuables : A3 garde l'empreinte de l'ancien plan d'axes, A4 celle du nouveau (versions 1 et 2)", anAxes.jeuId === JEU_AXES_V2 && an3Axes.jeuId === JEU_AXES && anAxes.sha256 !== an3Axes.sha256 && anAxes.version === 2 && an3Axes.version === 1);

  // Acquittement d'un re-examen par une personne.
  const sansJ = await envoyer("patch", `/${PID}/conflits/${idL13}`, { aReexaminer: false });
  const ackKo = await envoyer("patch", `/${PID}/conflits/${idL13}`, { aReexaminer: false, justification: "court" });
  const ack = await envoyer("patch", `/${PID}/conflits/${idL13}`, { aReexaminer: false, justification: "Mesure revue : le nouveau trace est plus proche, dossier conserve" });
  verifier("9. acquitter un re-examen exige une justification (422) ; acquitte, le drapeau tombe et la trace (REEXAMEN, acteur, motif d'origine) est ajoutee",
    sansJ.status === 422 && ackKo.status === 422 && ack.status === 200 && (await statutDe(idL13)).are === false
    && (await compter(`SELECT count(*) n FROM conflits_projet_historique WHERE "conflitId" = $1 AND action = 'REEXAMEN' AND "acteurId" IS NOT NULL AND donnees->>'motifAvant' = 'MESURE_MODIFIEE'`, idL13)) === 1, [sansJ.status, ackKo.status, ack.status]);
  const ficheL6 = await get(`/${PID}/conflits/${idL6e}`);
  verifier("9. la fiche d'un conflit non retrouve dit pourquoi (motif NON_RETROUVE) et garde son historique (CREATION de l'analyse 1, 3 transitions humaines, REEXAMEN de l'analyse 4)",
    ficheL6.body.conflit.aReexaminer === true && ficheL6.body.conflit.motifReexamen === "NON_RETROUVE" && ficheL6.body.historique.some((h: { action: string; analyseNumero: number }) => h.action === "REEXAMEN" && h.analyseNumero === 4)
    && ficheL6.body.historique.filter((h: { action: string }) => h.action === "STATUT").length === 3 && ficheL6.body.analyses.derniere.numero === 3);

  // Retour au plan d'origine : les conflits reapparaissent.
  const JEU_AXES_V3 = await deposerEtAutoriser(PID, fAxes, { role: "AXES_TRAVAUX" }, "axes.kml");
  const a5 = await analyser();
  const r5 = a5.body.resume;
  const fL6b = await statutDe(idL6e);
  verifier("9. retour au plan d'origine (meme empreinte, redepose apres remplacement) : les conflits non retrouves REAPPARAISSENT, le drapeau tombe, une ligne RETROUVE est ajoutee, le statut n'a pas bouge",
    a5.status === 201 && r5.reapparus >= 3 && fL6b.are === false && fL6b.statut === "POTENTIEL" && (await compter(`SELECT count(*) n FROM conflits_projet_historique WHERE "conflitId" = $1 AND action = 'RETROUVE'`, idL6e)) === 1
    && (await statutDe(idW)).statut === "INFIRME" && (await statutDe(idW)).are === false && JEU_AXES_V3 !== JEU_AXES, { r5: { ...r5, limites: undefined }, fL6b });

  // ================================================================ 10. Declencheurs : append-only, regle immuable, un recalcul ne change jamais un verdict
  const histId = (await sql<{ id: string }>(`SELECT id FROM conflits_projet_historique LIMIT 1`))[0].id;
  verifier("10. historique : UPDATE et DELETE refuses par la base (23001)", await sqlstate(() => sql(`UPDATE conflits_projet_historique SET justification = 'x' WHERE id = $1`, histId)) === "23001" && await sqlstate(() => sql(`DELETE FROM conflits_projet_historique WHERE id = $1`, histId)) === "23001");
  const preuveId = (await sql<{ id: string }>(`SELECT id FROM conflits_projet_preuves LIMIT 1`))[0].id;
  verifier("10. preuves : UPDATE et DELETE refuses (23001)", await sqlstate(() => sql(`UPDATE conflits_projet_preuves SET texte = 'x' WHERE id = $1`, preuveId)) === "23001" && await sqlstate(() => sql(`DELETE FROM conflits_projet_preuves WHERE id = $1`, preuveId)) === "23001");
  verifier("10. analyses : UPDATE et DELETE refuses (23001)", await sqlstate(() => sql(`UPDATE analyses_conflit_projet SET duree = 0 WHERE id = $1`, A1)) === "23001" && await sqlstate(() => sql(`DELETE FROM analyses_conflit_projet WHERE id = $1`, A1)) === "23001");
  verifier("10. conflits : DELETE refuse (suppression logique uniquement), cle et type immuables (23001)", await sqlstate(() => sql(`DELETE FROM conflits_projet WHERE id = $1`, idW)) === "23001"
    && await sqlstate(() => sql(`UPDATE conflits_projet SET cle = repeat('a', 64) WHERE id = $1`, idW)) === "23001" && await sqlstate(() => sql(`UPDATE conflits_projet SET type = 'PROXIMITE' WHERE id = $1`, idW)) === "23001");
  const recalcul = (maj: string) => essaiAnnule(async (tx) => { await tx.$queryRawUnsafe(`SELECT set_config('bdri.conflit_recalcul','oui',true)`); await tx.$queryRawUnsafe(maj); });
  verifier("10. UN RECALCUL NE CHANGE JAMAIS UN VERDICT : quand la transaction pose bdri.conflit_recalcul, la base refuse de modifier statut, responsable, echeance, risque et action proposee (23001) ; elle laisse passer la derniere analyse ; sans ce reglage (chemin humain), le statut est modifiable",
    await recalcul(`UPDATE conflits_projet SET statut = 'A_INVESTIGUER' WHERE id = '${idW}'`) === "23001"
    && await recalcul(`UPDATE conflits_projet SET "responsableId" = NULL WHERE id = '${idP}'`) === "23001"
    && await recalcul(`UPDATE conflits_projet SET echeance = NULL WHERE id = '${idP}'`) === "23001"
    && await recalcul(`UPDATE conflits_projet SET risque = 'FAIBLE' WHERE id = '${idP}'`) === "23001"
    && await recalcul(`UPDATE conflits_projet SET "actionProposee" = 'x' WHERE id = '${idP}'`) === "23001"
    && await recalcul(`UPDATE conflits_projet SET "derniereAnalyseId" = "derniereAnalyseId" WHERE id = '${idW}'`) === "ok"
    && await essaiAnnule(async (tx) => { await tx.$queryRawUnsafe(`UPDATE conflits_projet SET statut = 'A_INVESTIGUER' WHERE id = '${idW}'`); }) === "ok");
  verifier("10. regle : une regle approuvee est immuable (modifier la tolerance, la repasser en brouillon, la supprimer : 23001) ; seul le retrait APPROUVEE vers RETIREE est possible, sans autre changement ; la regle par defaut aussi",
    await sqlstate(() => sql(`UPDATE regles_conflit_projet SET "toleranceProximiteM" = 9 WHERE id = $1`, RG1)) === "23001"
    && await sqlstate(() => sql(`UPDATE regles_conflit_projet SET statut = 'BROUILLON', "approuveParId" = NULL, "approuveLe" = NULL WHERE id = $1`, RG1)) === "23001"
    && await sqlstate(() => sql(`DELETE FROM regles_conflit_projet WHERE id = $1`, RG1)) === "23001" && await sqlstate(() => sql(`UPDATE regles_conflit_projet SET "toleranceProximiteM" = 9 WHERE id = $1`, defaut.id)) === "23001"
    && await essaiAnnule(async (tx) => { await tx.$queryRawUnsafe(`UPDATE regles_conflit_projet SET statut = 'RETIREE' WHERE id = '${RG1}'`); }) === "ok"
    && await essaiAnnule(async (tx) => { await tx.$queryRawUnsafe(`UPDATE regles_conflit_projet SET statut = 'RETIREE', code = 'AUTRE' WHERE id = '${RG1}'`); }) === "23001"
    && await sqlstate(() => sql(`UPDATE regles_conflit_projet SET justification = 'une autre justification assez longue' WHERE id = $1`, rc2.body.regle.id)) === "23001");
  const dx = (await envoyer("post", `/${PID}/conflits/${idL2}/decisions`, { option: "PROTEGER", justification: "Protection mecanique proposee pour l'essai de la base" })).body.decision.id as string;
  const dApprouvee = (await sql<{ id: string }>(`SELECT id FROM conflits_projet_decisions WHERE statut = 'APPROUVEE' LIMIT 1`))[0].id;
  verifier("10. decision : une decision tranchee ne change plus et ne se supprime pas (23001) ; trancher sa propre proposition SANS derogation est refuse par la contrainte de la base (23514) ; DEPLACER_RESEAU sans planning aussi (23514)",
    await sqlstate(() => sql(`UPDATE conflits_projet_decisions SET "motifDecision" = 'autre motif assez long' WHERE id = $1`, dApprouvee)) === "23001"
    && await sqlstate(() => sql(`DELETE FROM conflits_projet_decisions WHERE id = $1`, dApprouvee)) === "23001"
    && await essaiAnnule(async (tx) => { await tx.$queryRawUnsafe(`UPDATE conflits_projet_decisions SET statut = 'APPROUVEE', "approuveParId" = "proposeParId", "approuveLe" = now(), "motifDecision" = 'motif assez long pour la contrainte' WHERE id = '${dx}'`); }) === "23514"
    && await essaiAnnule(async (tx) => { await tx.$queryRawUnsafe(`UPDATE conflits_projet_decisions SET option = 'A_ETUDIER' WHERE id = '${dx}'`); }) === "23001"
    && await essaiAnnule(async (tx) => { await tx.$queryRawUnsafe(`INSERT INTO conflits_projet_decisions (id, "conflitId", option, justification, "proposeParId") VALUES (gen_random_uuid()::text, '${idP}', 'DEPLACER_RESEAU', 'justification assez longue', '${chef.id}')`); }) === "23514");
  verifier("10. historique de statut sans justification suffisante, ou sans acteur ni analyse : refuse par les contraintes (23514)",
    await essaiAnnule(async (tx) => { await tx.$queryRawUnsafe(`INSERT INTO conflits_projet_historique (id, "conflitId", action, "ancienStatut", "nouveauStatut", justification, "acteurId") VALUES (gen_random_uuid()::text, '${idW}', 'STATUT', 'INFIRME', 'A_INVESTIGUER', 'court', '${chef.id}')`); }) === "23514"
    && await essaiAnnule(async (tx) => { await tx.$queryRawUnsafe(`INSERT INTO conflits_projet_historique (id, "conflitId", action) VALUES (gen_random_uuid()::text, '${idW}', 'PREUVE')`); }) === "23514");

  // ================================================================ 11. Verrou du projet, delai de la base, plafond de conflits (ECHEC)
  const client = new pg.Client({ connectionString: banc.urlClone });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`pv-conflits-analyse|${PID}`]);
    const occupe = await analyser();
    exemples["erreur_projet_occupe"] = occupe.body;
    const analysesPendant = await compter(`SELECT count(*) n FROM analyses_conflit_projet WHERE "projetId" = $1`, PID);
    verifier("11. une seule analyse a la fois par projet : verrou tenu par une autre operation => 503 PROJET_OCCUPE, rien d'ecrit", occupe.status === 503 && occupe.body.code === "PROJET_OCCUPE" && analysesPendant === 5, { corps: occupe.body, analysesPendant });
    const autreProjet = await analyser(P2);
    await client.query("ROLLBACK");
    verifier("11. le verrou est propre au projet : un autre projet s'analyse pendant ce temps (201)", autreProjet.status === 201);
    verifier("11. verrou libere : l'analyse reussit a nouveau (201)", (await analyser()).status === 201);
  } finally { await client.query("ROLLBACK").catch(() => undefined); }

  const analysesAvantLock = await compter(`SELECT count(*) n FROM analyses_conflit_projet WHERE "projetId" = $1`, PID);
  const conflitsAvantLock = await compter(`SELECT count(*) n FROM conflits_projet WHERE "projetId" = $1`, PID);
  process.env.PROJETS_VOIRIE_DELAI_ANALYSE_MS = "1000";
  await client.query("BEGIN");
  await client.query(`LOCK TABLE projets_voirie_objets IN ACCESS EXCLUSIVE MODE`);
  const t0 = Date.now();
  const lent = await analyser();
  const dureeLent = Date.now() - t0;
  const actives = await sql<{ n: bigint }>(`SELECT count(*) n FROM pg_stat_activity WHERE datname = current_database() AND state = 'active' AND query ILIKE '%projets_voirie_objets%' AND pid <> pg_backend_pid() AND query NOT ILIKE '%pg_stat_activity%'`);
  await client.query("ROLLBACK");
  delete process.env.PROJETS_VOIRIE_DELAI_ANALYSE_MS;
  exemples["erreur_analyse_trop_longue"] = lent.body;
  verifier(`11. delai cote BASE (statement_timeout 1 s, table verrouillee par une autre session) : 504 ANALYSE_TROP_LONGUE en ${dureeLent} ms, jamais un 500, plus aucune requete active ensuite`,
    lent.status === 504 && lent.body.code === "ANALYSE_TROP_LONGUE" && dureeLent < 6000 && Number(actives[0].n) === 0, { statut: lent.status, corps: lent.body, dureeLent, actives: actives[0].n });
  const echec = await sql<{ statut: string; resume: { erreur: { code: string } } }>(`SELECT statut::text, resume FROM analyses_conflit_projet WHERE "projetId" = $1 ORDER BY numero DESC LIMIT 1`, PID);
  verifier("11. l'analyse en echec laisse une trace ECHEC (numero suivant, code de l'erreur) et ne modifie AUCUN conflit",
    echec[0].statut === "ECHEC" && echec[0].resume.erreur.code === "ANALYSE_TROP_LONGUE" && (await compter(`SELECT count(*) n FROM analyses_conflit_projet WHERE "projetId" = $1`, PID)) === analysesAvantLock + 1
    && (await compter(`SELECT count(*) n FROM conflits_projet WHERE "projetId" = $1`, PID)) === conflitsAvantLock);
  const idEchec = (await sql<{ id: string }>(`SELECT id FROM analyses_conflit_projet WHERE statut = 'ECHEC' AND "projetId" = $1`, PID))[0].id;
  verifier("11. une analyse en echec n'est pas comparable (409 ANALYSE_NON_COMPARABLE) et l'analyse suivante est normale",
    (await get(`/${PID}/analyses/${idEchec}/comparaison?avec=${A1}`)).body.code === "ANALYSE_NON_COMPARABLE" && (await analyser()).status === 201);
  await client.end();

  // Plafond de conflits : 40 reseaux qui croisent l'axe, plafond abaisse a 100.
  const P3: string = (await envoyer("post", "", { code: "CONFLITS-DENSE", nom: "Reseau dense", regionId: R1 })).body.projet.id;
  await deposerEtAutoriser(P3, await kml([{ nom: "Axe unique", coords: [[0, 0], [200, 0]] }]), { role: "AXES_TRAVAUX" }, "axe.kml");
  const dense: Ligne[] = Array.from({ length: 40 }, (_, i) => ({ nom: `Dense-${String(i).padStart(2, "0")}`, coords: [[5 + i * 4.5, -15], [5 + i * 4.5, 15]] as [number, number][] }));
  await deposerEtAutoriser(P3, await geojson(dense), { role: "RESEAU_TIERS", concessionnaireId: CONC1, classePrecision: "C" }, "dense.geojson");
  process.env.PROJETS_VOIRIE_CONFLITS_MAX = "100";
  const trop = await analyser(P3);
  delete process.env.PROJETS_VOIRIE_CONFLITS_MAX;
  verifier("11. plafond de conflits par analyse (abaisse a 100 pour l'essai) : 422 ANALYSE_TROP_VOLUMINEUSE, trace ECHEC, aucun conflit ecrit",
    trop.status === 422 && trop.body.code === "ANALYSE_TROP_VOLUMINEUSE" && trop.body.conflitsMax === 100 && (await compter(`SELECT count(*) n FROM conflits_projet WHERE "projetId" = $1`, P3)) === 0
    && (await sql<{ statut: string }>(`SELECT statut::text FROM analyses_conflit_projet WHERE "projetId" = $1`, P3))[0].statut === "ECHEC", trop.body);
  const t1 = Date.now();
  const dense1 = await analyser(P3);
  const dureeDense = Date.now() - t1;
  verifier(`11. le meme projet sous le plafond par defaut : 201, ${dense1.body.resume?.totaux?.conflitsTrouves} conflits (40 reseaux : chaussee, emprise, traversee) en ${dureeDense} ms ; chaque reseau de classe C est POTENTIEL`,
    dense1.status === 201 && dense1.body.resume.totaux.conflitsTrouves >= 120 && dense1.body.resume.parType.TRAVERSEE === 40 && dense1.body.resume.parStatut.POTENTIEL === dense1.body.resume.totaux.conflitsTrouves - 1, dense1.body.resume);
  const denseListe = await get(`/${P3}/conflits?limite=200`);
  verifier("11. la liste d'un projet dense : compteurs coherents (somme des compteurs = total = nombre de conflits)", denseListe.body.total === dense1.body.resume.totaux.conflitsTrouves
    && Object.values(denseListe.body.compteurs as Record<string, number>).reduce((a, b) => a + b, 0) === denseListe.body.total);

  // ================================================================ 12. Visibilite : jeu remplace ou retire
  const R1_V2: Ligne[] = [...R1_BASE, { nom: "Fibre-Marqueur Loin", coords: [[100, 200], [160, 200]] }];
  const JEU_R1_V2 = await deposerEtAutoriser(PID, await geojson(R1_V2), { role: "RESEAU_TIERS", concessionnaireId: CONC1, classePrecision: "B", precisionHorizontaleM: "3.5" }, "r1-v2.geojson");
  const statutR1 = (await sql<{ statut: string }>(`SELECT statut::text FROM projets_voirie_jeux WHERE id = $1`, JEU_R1))[0].statut;
  // REVUE RC-3, M1. Regle : un jeu RETIRE n'est montre a personne ; un jeu non AUTORISE (ici REMPLACE) n'est montre qu'a ADMIN et GESTIONNAIRE.
  // Un compte qui ne decide pas ne voit pas un dossier dont un jeu n'est pas AUTORISE (liste, total, compteurs, fiche, comparaison, analyses) ;
  // un compte qui decide voit le dossier (archive), sans les donnees tirees d'un jeu RETIRE.
  const nbCaches = async () => compter(`SELECT count(*) n FROM conflits_projet c LEFT JOIN projets_voirie_jeux jr ON jr.id = c."jeuReseauId" LEFT JOIN projets_voirie_jeux ja ON ja.id = c."jeuAxesId"
    WHERE c."projetId" = $1 AND NOT (coalesce(jr.statut::text, 'AUTORISE') = 'AUTORISE' AND coalesce(ja.statut::text, 'AUTORISE') = 'AUTORISE')`, PID);
  const nbTous = await compter(`SELECT count(*) n FROM conflits_projet WHERE "projetId" = $1`, PID);
  const cachesRemplace = await nbCaches();
  const fLecteur = await get(`/${PID}/conflits/${idL2}`, T.lecteur);
  const vChef = (await get(`/${PID}/conflits/${idL2}`, T.chef)).body;
  verifier("12. M1 : le jeu de reseau a ete REMPLACE. Un lecteur recoit 404 CONFLIT_INTROUVABLE sur la fiche d'un dossier de ce jeu (aucune mesure, aucun objet, aucun troncon voisin) ; un GESTIONNAIRE voit tout, geometrie et source comprises (comme pour les jeux du socle)",
    statutR1 === "REMPLACE" && cachesRemplace > 0 && fLecteur.status === 404 && fLecteur.body.code === "CONFLIT_INTROUVABLE" && !JSON.stringify(fLecteur.body).includes("Marqueur")
    && vChef.conflit.geometrie?.type === "LineString" && vChef.conflit.geometrieMasquee === false && vChef.sources.some((s: { jeuId: string }) => s.jeuId === JEU_R1), { statutR1, cachesRemplace, statut: fLecteur.status });
  const listeLecteur = (await get(`/${PID}/conflits?limite=200`, T.lecteur)).body;
  const listeChef = (await get(`/${PID}/conflits?limite=200`, T.chef)).body;
  const somme = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);
  verifier(`12. M1 : dans la liste, un lecteur ne recoit AUCUN dossier du jeu remplace : liste, total et compteurs excluent ${cachesRemplace} dossiers (oracle SQL), la somme des compteurs est le total ; le GESTIONNAIRE a les ${nbTous} dossiers`,
    listeLecteur.total === nbTous - cachesRemplace && listeLecteur.conflits.length === nbTous - cachesRemplace && somme(listeLecteur.compteurs) === listeLecteur.total
    && listeLecteur.conflits.every((c: { concessionnaire: { id: string } | null; bbox: unknown; mesure: unknown }) => c.concessionnaire?.id !== CONC1 && c.bbox !== null && c.mesure !== null)
    && listeChef.total === nbTous && somme(listeChef.compteurs) === nbTous && listeChef.conflits.some((c: { concessionnaire: { id: string } | null }) => c.concessionnaire?.id === CONC1),
    { lecteur: [listeLecteur.total, somme(listeLecteur.compteurs)], attendu: nbTous - cachesRemplace, chef: listeChef.total });
  const sondeLecteur = [`concessionnaireId=${CONC1}`, "q=fibre-marqueur", "statut=CONFIRME"].map((q) => get(`/${PID}/conflits?limite=200&${q}`, T.lecteur));
  const sondes = await Promise.all(sondeLecteur);
  verifier("12. M1 : un lecteur ne peut pas sonder un dossier masque par un filtre (concessionnaire du jeu remplace, nom d'objet, statut d'un dossier masque : 0 resultat) ; le total reste celui des seuls dossiers visibles",
    sondes[0].body.total === 0 && sondes[1].body.total === 0 && sondes[2].body.total === (await compter(`SELECT count(*) n FROM conflits_projet c LEFT JOIN projets_voirie_jeux jr ON jr.id = c."jeuReseauId" LEFT JOIN projets_voirie_jeux ja ON ja.id = c."jeuAxesId" WHERE c."projetId" = $1 AND c.statut = 'CONFIRME' AND coalesce(jr.statut::text, 'AUTORISE') = 'AUTORISE' AND coalesce(ja.statut::text, 'AUTORISE') = 'AUTORISE'`, PID)), sondes.map((s) => s.body.total));

  const jeuxAnalyse = async (aid: string, t: string) => ((await get(`/${PID}/analyses/${aid}`, t)).body.analyse.jeux as { jeuId: string }[]).map((j) => j.jeuId).sort();
  const statutsJeux = new Map((await sql<{ id: string; statut: string }>(`SELECT id, statut::text FROM projets_voirie_jeux WHERE "projetId" = $1`, PID)).map((j) => [j.id, j.statut]));
  const idsA3 = (await sql<{ jeux: { jeuId: string }[] }>(`SELECT jeux FROM analyses_conflit_projet WHERE id = $1`, A3))[0].jeux.map((j) => j.jeuId).sort();
  const lectA3 = await jeuxAnalyse(A3, T.lecteur), chefA3 = await jeuxAnalyse(A3, T.chef);
  verifier("12. M1 : les jeux d'une analyse sont filtres selon leur statut COURANT : un lecteur ne recoit que les jeux AUTORISES (jeuId, empreinte, nom de fichier d'un jeu remplace ne fuient plus), un GESTIONNAIRE tous sauf les RETIRES ; meme filtre dans la liste des analyses",
    idsA3.length === 4 && idsA3.some((id) => statutsJeux.get(id) === "REMPLACE") && JSON.stringify(lectA3) === JSON.stringify(idsA3.filter((id) => statutsJeux.get(id) === "AUTORISE"))
    && JSON.stringify(chefA3) === JSON.stringify(idsA3.filter((id) => statutsJeux.get(id) !== "RETIRE")) && lectA3.length < chefA3.length
    && JSON.stringify(((await get(`/${PID}/analyses?limite=100`, T.lecteur)).body.analyses as { numero: number; jeux: { jeuId: string }[] }[]).find((a) => a.numero === 3)?.jeux.map((j) => j.jeuId).sort()) === JSON.stringify(lectA3),
    { idsA3: idsA3.map((id) => [id.slice(0, 4), statutsJeux.get(id)]), lectA3: lectA3.length, chefA3: chefA3.length });
  const cmpL = (await get(`/${PID}/analyses/${A4}/comparaison?avec=${A3}`, T.lecteur)).body, cmpC = (await get(`/${PID}/analyses/${A4}/comparaison?avec=${A3}`, T.chef)).body;
  const clesCachees = new Set((await sql<{ cle: string }>(`SELECT c.cle FROM conflits_projet c LEFT JOIN projets_voirie_jeux jr ON jr.id = c."jeuReseauId" WHERE c."projetId" = $1 AND coalesce(jr.statut::text, 'AUTORISE') <> 'AUTORISE'`, PID)).map((x) => x.cle));
  const clesDe = (c: { apparus: { cles: string[] }; disparus: { cles: string[] }; modifies: { cles: string[] }; identiques: { cles: string[] } }) => [...c.apparus.cles, ...c.disparus.cles, ...c.modifies.cles, ...c.identiques.cles];
  verifier("12. M1 : la comparaison de deux analyses ne liste, pour un lecteur, AUCUN dossier masque (cles, identifiants, type, axe, statut) et ses comptes ne les incluent pas ; le GESTIONNAIRE les voit",
    clesDe(cmpC).some((k) => clesCachees.has(k)) && !clesDe(cmpL).some((k) => clesCachees.has(k))
    && cmpL.apparus.nb + cmpL.disparus.nb + cmpL.modifies.nb + cmpL.identiques.nb === clesDe(cmpL).length && cmpL.apparus.nb + cmpL.disparus.nb + cmpL.modifies.nb + cmpL.identiques.nb < cmpC.apparus.nb + cmpC.disparus.nb + cmpC.modifies.nb + cmpC.identiques.nb
    && !JSON.stringify([cmpL.apparus.conflits, cmpL.disparus.conflits, cmpL.modifies.conflits]).includes(idL2) && clesDe(cmpL).length === cmpL.apparus.cles.length + cmpL.disparus.cles.length + cmpL.modifies.cles.length + cmpL.identiques.cles.length,
    { lecteur: clesDe(cmpL).length, chef: clesDe(cmpC).length, cachees: clesCachees.size });

  const retirer = await envoyer("delete", `/${PID}/jeux/${JEU_R2}`);
  const vAdmin = (await get(`/${PID}/conflits/${idW}`, T.admin)).body;
  const fLecteurW = await get(`/${PID}/conflits/${idW}`, T.lecteur);
  const histW = vAdmin.historique as { action: string; donnees: Record<string, unknown> }[];
  verifier("12. le jeu de reseau a ete RETIRE : meme un ADMIN ne recoit plus rien de ce jeu (dossier conserve : statut, historique des personnes ; geometrie, boite, jeu, source, objet, mesure, troncons voisins, type de reseau, concessionnaire, classe, regle masques ; lignes de calcul de l'historique sans details) ; un lecteur recoit 404",
    retirer.status === 200 && vAdmin.conflit.statut === "INFIRME" && vAdmin.conflit.geometrie === null && vAdmin.conflit.geometrieMasquee === true && vAdmin.conflit.bbox === null && vAdmin.conflit.jeuReseauId === null
    && !vAdmin.sources.some((s: { jeuId: string }) => s.jeuId === JEU_R2) && vAdmin.conflit.objet === null && vAdmin.conflit.mesure === null && vAdmin.conflit.concessionnaire === null && vAdmin.conflit.typeReseau === null
    && vAdmin.conflit.classePrecision === null && vAdmin.regle === null && vAdmin.tronconsProches.length === 0
    && histW.filter((h) => h.action === "CREATION").every((h) => JSON.stringify(h.donnees) === JSON.stringify({ masquees: true })) && histW.some((h) => h.action === "STATUT" && /fourreau vide/.test(String((h as unknown as { justification: string }).justification)))
    && fLecteurW.status === 404, { conflit: vAdmin.conflit, regle: vAdmin.regle });
  const listeAdminRetire = (await get(`/${PID}/conflits?limite=200`, T.admin)).body;
  const ligneW = listeAdminRetire.conflits.find((c: { id: string }) => c.id === idW);
  const sondeRetire = await Promise.all([get(`/${PID}/conflits?q=eau-marqueur`, T.admin), get(`/${PID}/conflits?q=eaux`, T.admin), get(`/${PID}/conflits?concessionnaireId=${CONC2}`, T.admin)]);
  verifier("12. un dossier d'un jeu RETIRE reste dans la liste de l'ADMIN (archive des decisions) mais sans objet, mesure ni concessionnaire ; l'ADMIN ne peut pas le retrouver par le nom de l'objet, le nom du concessionnaire ni le filtre concessionnaire (aucun sondage du contenu d'un jeu retire)",
    !!ligneW && ligneW.objet === null && ligneW.mesure === null && ligneW.concessionnaire === null && ligneW.geometrieMasquee === true
    && sondeRetire.every((s) => !s.body.conflits.some((c: { id: string }) => c.id === idW)), sondeRetire.map((s) => s.body.total));
  const csvAdmin = (await get(`/${PID}/conflits/export.csv`, T.admin)).text.split(/\r?\n/);
  const colonnes = csvAdmin[0].replace(/^﻿/, "").split(";");
  const cleW = (await sql<{ cle: string }>(`SELECT cle FROM conflits_projet WHERE id = $1`, idW))[0].cle;
  const ligneCsvW = csvAdmin.find((l) => l.endsWith(`;${cleW}`));
  const cellulesW = (ligneCsvW ?? "").split(";");
  verifier("12. l'export CSV ne porte pas non plus le concessionnaire, le type de reseau, la classe ni les longueurs d'un jeu RETIRE",
    !!ligneCsvW && cellulesW[colonnes.indexOf("concessionnaire")] === "" && cellulesW[colonnes.indexOf("typeReseau")] === "" && cellulesW[colonnes.indexOf("classePrecision")] === ""
    && cellulesW[colonnes.indexOf("longueurChausseeM")] === "0" && !ligneCsvW?.includes("Societe des Eaux"), ligneCsvW);
  const a6 = await analyser();
  const flagL2 = await statutDe(idL2);
  const jeuDeL2 = (await sql<{ j: string }>(`SELECT "jeuReseauId" j FROM conflits_projet WHERE id = $1`, idL2))[0].j;
  verifier("12. l'analyse suivante repointe les dossiers retrouves sur la NOUVELLE version du jeu (jeuReseauId), les marque NOUVELLE_VERSION_DONNEES, et le lecteur revoit la geometrie ; les dossiers du jeu retire ne sont plus retrouves (NON_RETROUVE)",
    a6.status === 201 && jeuDeL2 === JEU_R1_V2 && flagL2.statut === "CONFIRME" && flagL2.are && (await get(`/${PID}/conflits/${idL2}`, T.lecteur)).body.conflit.geometrie?.type === "LineString"
    && (await statutDe(idW)).motif === "NON_RETROUVE" && a6.body.analyse.jeux.length === 3, { jeuDeL2, flagL2, jeux: a6.body.analyse?.jeux?.length });

  // ================================================================ 13. Isolation du referentiel, audit sans geometrie, ecritures auditees
  const apresTout = await etat();
  const modifiees = Object.keys(apresTout).filter((t) => apresTout[t] !== avantTout[t]);
  const AUTORISEES = new Set(["projets_voirie", "projets_voirie_jeux", "projets_voirie_objets", "regles_conflit_projet", "analyses_conflit_projet", "conflits_projet", "conflits_projet_historique", "conflits_projet_preuves", "conflits_projet_decisions", "audit_logs"]);
  verifier("13. ISOLATION : seules les tables du module et audit_logs ont change (comptes de TOUTES les tables avant et apres) ; troncons, ouvrages, chantiers et ordres de travaux intacts",
    modifiees.every((t) => AUTORISEES.has(t)) && comptesInterdits.every((t) => apresTout[t] === avantTout[t]), modifiees.filter((t) => !AUTORISEES.has(t)));
  verifier("13. ISOLATION : les lignes de `troncons` sont strictement inchangees (empreinte md5 avant et apres toutes les analyses) ; le referentiel n'est lu que pour tronconsProches", (await empreinteTroncons()) === empreinteAvant);
  verifier("13. aucune table d'ordre de deplacement n'existe dans le schema public",
    (await compter(`SELECT count(*) n FROM information_schema.tables WHERE table_schema = 'public' AND (table_name ILIKE '%deplacement%' OR table_name ILIKE '%ordre_deplac%')`)) === 0);
  const geoAudit = await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" IN ('ConflitProjet','AnalyseConflitProjet','RegleConflit','ExportConflitsProjetVoirie','ConsultationJeuProjet') AND (coalesce(after::text,'') || coalesce(before::text,'')) ~* '(coordinates|LINESTRING|POINT\\(|0102000020|"type": ?"Point")'`);
  verifier("13. aucune ligne d'audit des dossiers de conflit ne porte de geometrie (coordonnees, WKT, WKB)", geoAudit === 0, geoAudit);
  const auditConflit = await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'ConflitProjet'`);
  const histHumain = await compter(`SELECT count(*) n FROM conflits_projet_historique WHERE "acteurId" IS NOT NULL`);
  verifier(`13. toute ecriture humaine est auditee : ${histHumain} lignes d'historique d'un acteur, ${auditConflit} lignes d'audit ConflitProjet (une par ecriture) ; une ligne AnalyseConflitProjet par analyse ; une ligne RegleConflit par creation ou approbation`,
    auditConflit === histHumain && (await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'AnalyseConflitProjet'`)) === (await compter(`SELECT count(*) n FROM analyses_conflit_projet`))
    && (await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'RegleConflit'`)) === (await compter(`SELECT count(*) n FROM regles_conflit_projet WHERE "creeParId" IS NOT NULL`)) + (await compter(`SELECT count(*) n FROM regles_conflit_projet WHERE statut = 'APPROUVEE' AND "creeParId" IS NOT NULL`)), { auditConflit, histHumain });
  verifier("13. aucun verdict humain ne vient du calcul : chaque statut humain a une ligne d'historique STATUT d'un acteur identifie",
    (await compter(`SELECT count(*) n FROM conflits_projet c WHERE c.statut IN ('CONFIRME','INFIRME','TRAITEMENT_DECIDE','CLOTURE') AND NOT EXISTS (SELECT 1 FROM conflits_projet_historique h WHERE h."conflitId" = c.id AND h.action = 'STATUT' AND h."nouveauStatut" = c.statut AND h."acteurId" IS NOT NULL)`)) === 0);

  // ================================================================ 14. Revue independante RC-3 : corrections (M2, m1, m3, m4, m5, m6, m7, m8, m11, responsable)
  const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const stP = (pid: string, id: string, corps: unknown, t = T.chef) => envoyer("post", `/${pid}/conflits/${id}/statut`, corps, t);
  const patchP = (pid: string, id: string, corps: unknown, t = T.chef) => envoyer("patch", `/${pid}/conflits/${id}`, corps, t);
  const histoN = async (id: string) => compter(`SELECT count(*) n FROM conflits_projet_historique WHERE "conflitId" = $1`, id);

  // ---- Projet de la revue : memes fixtures que le projet principal (14 conflits), axes, reseau 1 (classe B) et reseau 3 (classe A).
  const P4: string = (await envoyer("post", "", { code: "CONFLITS-REVUE", nom: "Projet de la revue RC-3", regionId: R1 })).body.projet.id;
  await deposerEtAutoriser(P4, await kml(AXES), { role: "AXES_TRAVAUX" }, "axes.kml");
  await deposerEtAutoriser(P4, await geojson(R1_BASE), { role: "RESEAU_TIERS", concessionnaireId: CONC1, classePrecision: "B", precisionHorizontaleM: "3.5" }, "r1.geojson");
  await deposerEtAutoriser(P4, await kml(R3), { role: "RESEAU_TIERS", concessionnaireId: CONC3, classePrecision: "A" }, "r3.kml");
  const a41 = await analyser(P4);
  const inst41 = await sql<{ id: string; u: string; t: string }>(`SELECT id, "updatedAt"::text u, "tronconsProches"::text t FROM conflits_projet WHERE "projetId" = $1 ORDER BY id`, P4);
  await dormir(1100);
  const a42 = await analyser(P4);
  const inst42 = await sql<{ id: string; u: string; t: string }>(`SELECT id, "updatedAt"::text u, "tronconsProches"::text t FROM conflits_projet WHERE "projetId" = $1 ORDER BY id`, P4);
  verifier(`14. m11 : un recalcul qui ne change rien ne touche pas \`updatedAt\` : ${inst41.length} dossiers retrouves a l'identique, aucun \`updatedAt\` ne bouge (avant la correction : tous etaient reecrits)`,
    a41.status === 201 && a42.status === 201 && a42.body.resume.identiques === 13 && inst41.length === 13 && JSON.stringify(inst41.map((x) => [x.id, x.u])) === JSON.stringify(inst42.map((x) => [x.id, x.u])), { a42: a42.body.resume });

  // ---- Responsable : compte actif ET detenteur de la cle du module (observation de la revue)
  const inactif = await mk("inactif@banc.invalid", "Compte inactif", "GESTIONNAIRE");
  await sql(`UPDATE users SET actif = false WHERE id = $1`, inactif.id);
  const idRes = await trouver(P4, "Axe A", "INTERSECTION_EMPRISE", L("L6"));
  const rNon = await patchP(P4, idRes, { responsableId: sansModule.id });
  const rIna = await patchP(P4, idRes, { responsableId: inactif.id });
  const rInc = await patchP(P4, idRes, { responsableId: UUID0 });
  verifier("14. responsable : un compte sans la cle `projets-voirie` ou inactif est refuse (422 RESPONSABLE_NON_HABILITE) ; un compte inconnu reste 400 RESPONSABLE_INCONNU ; rien n'est ecrit",
    rNon.status === 422 && rNon.body.code === "RESPONSABLE_NON_HABILITE" && rIna.status === 422 && rIna.body.code === "RESPONSABLE_NON_HABILITE" && rInc.status === 400 && rInc.body.code === "RESPONSABLE_INCONNU"
    && (await sql<{ r: string | null }>(`SELECT "responsableId" r FROM conflits_projet WHERE id = $1`, idRes))[0].r === null, [rNon.body, rIna.body]);
  const rOk1 = await patchP(P4, idRes, { responsableId: admin.id });
  const rOk2 = await patchP(P4, idRes, { responsableId: lecteur.id });
  verifier("14. responsable : un ADMIN (sans liste de modules, aucune restriction) et un compte actif qui a la cle sont acceptes", rOk1.status === 200 && rOk1.body.conflit.responsable.id === admin.id && rOk2.status === 200 && rOk2.body.conflit.responsable.id === lecteur.id);

  // ---- m3 : une approbation anterieure au dernier passage a CONFIRME est perimee
  const id3 = await trouver(P4, "Axe A", "INTERSECTION_CHAUSSEE", L("L2 bis"));
  await envoyer("post", `/${P4}/conflits/${id3}/preuves`, { type: "NOTE", texte: "Cable vu sur le terrain, passage confirme" });
  await stP(P4, id3, { vers: "CONFIRME", justification: "Passage du cable confirme sur le terrain" });
  const dd1 = (await envoyer("post", `/${P4}/conflits/${id3}/decisions`, { option: "PROTEGER", justification: "Protection mecanique proposee pour ce cable" })).body.decision?.id as string;
  await envoyer("post", `/${P4}/conflits/${id3}/decisions/${dd1}/approuver`, { motif: "Protection mecanique approuvee par un autre responsable" }, T.chef2);
  await stP(P4, id3, { vers: "INFIRME", justification: "Finalement un fourreau vide, dossier infirme par l'administrateur" }, T.admin);
  await stP(P4, id3, { vers: "A_INVESTIGUER", justification: "Reouverture : l'operateur nous recontacte" });
  await stP(P4, id3, { vers: "POTENTIEL", justification: "Precision confirmee par l'operateur, classe B" });
  const reConf = await stP(P4, id3, { vers: "CONFIRME", justification: "Passage du cable reconfirme apres releve" });
  const fiche3 = (await get(`/${P4}/conflits/${id3}`, T.admin)).body;
  const vers3 = (fiche3.transitionsPossibles as { vers: string; bloquee: string | null }[]).find((t) => t.vers === "TRAITEMENT_DECIDE");
  const perimee = await stP(P4, id3, { vers: "TRAITEMENT_DECIDE", justification: "Traitement decide sur l'ancienne approbation" });
  verifier("14. m3 : l'approbation d'une confirmation ANTERIEURE ne vaut plus : apres INFIRME puis reouverture jusqu'a CONFIRME, le passage a TRAITEMENT_DECIDE est refuse (409 DECISION_REQUISE) et la fiche annonce la transition bloquee ; la decision ancienne reste APPROUVEE (aucune ligne n'est modifiee)",
    reConf.status === 200 && perimee.status === 409 && perimee.body.code === "DECISION_REQUISE" && vers3?.bloquee === "DECISION_REQUISE" && (await statutDe(id3)).statut === "CONFIRME"
    && (await sql<{ s: string }>(`SELECT statut::text s FROM conflits_projet_decisions WHERE id = $1`, dd1))[0].s === "APPROUVEE", { perimee: perimee.body, vers3 });
  const dd2 = (await envoyer("post", `/${P4}/conflits/${id3}/decisions`, { option: "A_ETUDIER", justification: "Etude complementaire apres la reouverture" })).body.decision?.id as string;
  await envoyer("post", `/${P4}/conflits/${id3}/decisions/${dd2}/approuver`, { motif: "Etude complementaire approuvee apres la reouverture" }, T.chef2);
  const vigueur = await stP(P4, id3, { vers: "TRAITEMENT_DECIDE", justification: "Traitement decide sur la nouvelle approbation" });
  verifier("14. m3 : une decision approuvee DEPUIS la derniere confirmation autorise TRAITEMENT_DECIDE (200) ; deux decisions APPROUVEE coexistent, seule la recente compte",
    vigueur.status === 200 && vigueur.body.conflit.statut === "TRAITEMENT_DECIDE" && (await compter(`SELECT count(*) n FROM conflits_projet_decisions WHERE "conflitId" = $1 AND statut = 'APPROUVEE'`, id3)) === 2);

  // ---- m4 : responsable d'un deplacement de reseau, dossier clos
  const id4 = await trouver(P4, "Axe A", "INTERSECTION_CHAUSSEE", L("P"));
  await patchP(P4, id4, { responsableId: chef2.id });
  await envoyer("post", `/${P4}/conflits/${id4}/preuves`, { type: "RELEVE_TERRAIN", texte: "Cable visible dans le caniveau", reference: "Releve R-77" });
  await stP(P4, id4, { vers: "CONFIRME", justification: "Cable constate sur le terrain (releve R-77)" });
  const dep = await envoyer("post", `/${P4}/conflits/${id4}/decisions`, { option: "DEPLACER_RESEAU", justification: "Deplacement propose : la chaussee prevue recouvre le cable", dateDebutPrevue: "2026-12-01", dateFinPrevue: "2026-12-20" });
  const idDep: string = dep.body.decision?.id;
  const effaceP = await patchP(P4, id4, { responsableId: null });
  const autreP = await patchP(P4, id4, { responsableId: chef.id });
  verifier("14. m4 : une decision de deplacement de reseau PROPOSEE interdit d'effacer le responsable (422 RESPONSABLE_REQUIS, rien n'est ecrit) ; en designer un autre reste possible",
    dep.status === 201 && effaceP.status === 422 && effaceP.body.code === "RESPONSABLE_REQUIS" && autreP.status === 200 && autreP.body.conflit.responsable.id === chef.id, [effaceP.body, autreP.body]);
  await envoyer("post", `/${P4}/conflits/${id4}/decisions/${idDep}/approuver`, { motif: "Deplacement valide : seule option viable" }, T.chef2);
  const histoAvantPatch = await histoN(id4);
  const effaceA = await patchP(P4, id4, { responsableId: null });
  verifier("14. m4 : meme refus quand le deplacement est APPROUVE (AT-09 ne se controlait qu'a la proposition)", effaceA.status === 422 && effaceA.body.code === "RESPONSABLE_REQUIS" && (await histoN(id4)) === histoAvantPatch);
  await stP(P4, id4, { vers: "TRAITEMENT_DECIDE", justification: "Deplacement approuve, planning arrete" });
  const clos4 = await stP(P4, id4, { vers: "CLOTURE", justification: "Travaux de deplacement termines et constates", recolementAValider: true }, T.admin);
  const histoClos4 = await histoN(id4);
  const patchClos = await Promise.all([patchP(P4, id4, { risque: "FAIBLE" }), patchP(P4, id4, { responsableId: null }, T.admin), patchP(P4, id4, { echeance: "2099-01-01" }), patchP(P4, id4, { actionProposee: "Nouvelle action" })]);
  const ackClos = await patchP(P4, id4, { aReexaminer: false, justification: "Aucun re-examen en attente sur ce dossier clos" });
  verifier("14. m4 : un dossier CLOTURE ne se modifie plus par l'API : responsable, echeance, risque et action proposee sont refuses (409 STATUT_INCOMPATIBLE, ADMIN compris), l'acquittement d'un re-examen reste possible ; rien n'est ecrit",
    clos4.status === 200 && patchClos.every((r) => r.status === 409 && r.body.code === "STATUT_INCOMPATIBLE") && ackClos.status === 200 && ackClos.body.modifie === false && (await histoN(id4)) === histoClos4
    && (await sql<{ r: string | null }>(`SELECT "responsableId" r FROM conflits_projet WHERE id = $1`, id4))[0].r === chef.id, patchClos.map((r) => [r.status, r.body.code]));

  // ---- m5 : TRUNCATE refuse, sortie de CLOTURE refusee par la base
  const TABLES_FERMEES = ["regles_conflit_projet", "analyses_conflit_projet", "conflits_projet", "conflits_projet_historique", "conflits_projet_preuves", "conflits_projet_decisions"];
  const avantTruncate = await Promise.all(TABLES_FERMEES.map((t) => compter(`SELECT count(*) n FROM "${t}"`)));
  const tronque = (t: string, cascade = false) => essaiAnnule(async (tx) => { await tx.$executeRawUnsafe(`TRUNCATE "${t}"${cascade ? " CASCADE" : ""}`); });
  const feuilles = TABLES_FERMEES.filter((t) => t !== "analyses_conflit_projet" && t !== "conflits_projet");
  const codesTruncate = await Promise.all(feuilles.map((t) => tronque(t)));
  const codesCascade = await Promise.all(TABLES_FERMEES.map((t) => tronque(t, true)));
  const plainRefs = await Promise.all([tronque("analyses_conflit_projet"), tronque("conflits_projet")]);
  const cascade = await tronque("projets_voirie", true);
  const apresTruncate = await Promise.all(TABLES_FERMEES.map((t) => compter(`SELECT count(*) n FROM "${t}"`)));
  verifier("14. m5 : TRUNCATE est refuse (23001) sur les six tables des dossiers de conflit (directement sur les quatre qu aucune cle etrangere ne protege, par CASCADE sur les six - la base refuse deja le TRUNCATE simple des deux tables referencees - et par CASCADE depuis la table des projets) ; aucune ligne n'est perdue",
    codesTruncate.every((c) => c === "23001") && codesCascade.every((c) => c === "23001") && plainRefs.every((c) => c !== "ok") && cascade === "23001" && JSON.stringify(avantTruncate) === JSON.stringify(apresTruncate) && avantTruncate.every((n) => n > 0), { codesTruncate, codesCascade, plainRefs, cascade });
  verifier("14. m5 : un dossier CLOTURE ne change plus de statut, meme hors recalcul et hors API (23001) ; une ecriture qui ne change pas le statut passe",
    await sqlstate(() => sql(`UPDATE conflits_projet SET statut = 'A_INVESTIGUER' WHERE id = $1`, id4)) === "23001" && await sqlstate(() => sql(`UPDATE conflits_projet SET statut = 'INFIRME' WHERE id = $1`, id4)) === "23001"
    && await essaiAnnule(async (tx) => { await tx.$queryRawUnsafe(`UPDATE conflits_projet SET statut = 'CLOTURE', "aReexaminer" = false WHERE id = '${id4}'`); }) === "ok");

  // ---- m11 (suite) : un changement de mesure met `updatedAt` a jour, un dossier non retrouve ou a mesure inchangee non ; tronconsProches reecrit seulement s'il differe
  await deposerEtAutoriser(P4, await kml([{ nom: "Axe A", coords: [[0, 4], [200, 4]] }, { nom: "Axe B", coords: [[200, 0], [200, 150]] }]), { role: "AXES_TRAVAUX" }, "axes-v2.kml");
  const avant43 = await sql<{ id: string; u: string }>(`SELECT id, "updatedAt"::text u FROM conflits_projet WHERE "projetId" = $1`, P4);
  await dormir(1100);
  const a43 = await analyser(P4);
  const inst43 = await sql<{ id: string; u: string; motif: string | null; are: boolean }>(`SELECT id, "updatedAt"::text u, "motifReexamen"::text motif, "aReexaminer" are FROM conflits_projet WHERE "projetId" = $1`, P4);
  const avantParId = new Map(avant43.map((x) => [x.id, x.u] as const));
  const modifies = inst43.filter((x) => x.motif === "MESURE_MODIFIEE"), nonRetrouves = inst43.filter((x) => x.motif === "NON_RETROUVE"), versionDonnees = inst43.filter((x) => x.motif === "NOUVELLE_VERSION_DONNEES");
  verifier(`14. m11 : apres modification d'un axe, \`updatedAt\` change pour les ${modifies.length} dossiers dont la mesure change et pas pour les ${nonRetrouves.length} non retrouves ni les ${versionDonnees.length} retrouves a mesure inchangee`,
    a43.status === 201 && modifies.length >= 1 && nonRetrouves.length >= 1 && versionDonnees.length >= 1
    && modifies.every((x) => x.u !== avantParId.get(x.id)) && nonRetrouves.every((x) => x.u === avantParId.get(x.id)) && versionDonnees.every((x) => x.u === avantParId.get(x.id)), { modifies: modifies.length, nonRetrouves: nonRetrouves.length, versionDonnees: versionDonnees.length });
  const idsP4 = inst43.map((x) => x.id);
  const frais = await prisma.$transaction((tx: typeof prisma) => depotConflits.majTronconsProches(tx, idsP4, 7.5));
  const xminClos = async () => (await sql<{ x: string }>(`SELECT xmin::text x FROM conflits_projet WHERE id = $1`, id4))[0].x;
  const x0 = await xminClos();
  await prisma.$transaction((tx: typeof prisma) => depotConflits.majTronconsProches(tx, [id4], 7.5));
  const idProche = await trouver(P4, "Axe A", "INTERSECTION_CHAUSSEE", L("L2"));
  const troncons0 = await sql<{ t: string }>(`SELECT "tronconsProches"::text t FROM conflits_projet WHERE id = $1`, idProche);
  await sql(`UPDATE conflits_projet SET "tronconsProches" = '[]'::jsonb WHERE id = $1`, idProche);
  const reecrits = await prisma.$transaction((tx: typeof prisma) => depotConflits.majTronconsProches(tx, idsP4, 7.5));
  const restaure = await sql<{ t: string }>(`SELECT "tronconsProches"::text t FROM conflits_projet WHERE id = $1`, idProche);
  verifier("14. m11 : `tronconsProches` n'est reecrit que s'il differe de la valeur calculee : 0 ligne reecrite quand tout est a jour (le dossier CLOTURE n'est pas touche, meme identifiant de version de ligne) ; une seule ligne quand une seule a ete alteree, et elle retrouve sa valeur",
    Number(frais) === 0 && (await xminClos()) === x0 && troncons0[0].t.includes("BANC-T-PROCHE") && Number(reecrits) === 1 && restaure[0].t === troncons0[0].t, { frais, reecrits });

  // ---- M2 : le nombre de conflits d'une analyse vient du resume, identique au nombre de cles de l'instantane (qui n'est plus lu pour la liste)
  const lAnP4 = (await get(`/${P4}/analyses?limite=100`, T.lecteur)).body.analyses as { id: string; nbConflitsTrouves: number; resume: { totaux?: { conflitsTrouves: number } }; instantane?: unknown }[];
  const clesInst = await sql<{ id: string; n: bigint }>(`SELECT id, (SELECT count(*) FROM jsonb_object_keys(instantane)) n FROM analyses_conflit_projet WHERE "projetId" = $1 AND statut = 'TERMINEE'`, P4);
  verifier("14. M2 : `nbConflitsTrouves` = `resume.totaux.conflitsTrouves` = nombre de cles de l'instantane (sur les analyses terminees), et l'instantane n'est jamais rendu par la liste ni par le detail",
    lAnP4.length === 3 && lAnP4.every((a) => a.nbConflitsTrouves === a.resume.totaux?.conflitsTrouves && a.nbConflitsTrouves === Number(clesInst.find((c) => c.id === a.id)?.n)) && lAnP4.every((a) => !("instantane" in a))
    && !JSON.stringify((await get(`/${P4}/analyses/${lAnP4[0].id}`, T.chef)).body).includes("instantane"), lAnP4.map((a) => [a.nbConflitsTrouves, a.resume.totaux?.conflitsTrouves]));
  const lAnEchec = (await get(`/${PID}/analyses?limite=100`)).body.analyses as { statut: string; nbConflitsTrouves: number }[];
  verifier("14. M2 : une analyse en ECHEC (sans instantane ni totaux) a zero conflit trouve", lAnEchec.filter((a) => a.statut === "ECHEC").length >= 1 && lAnEchec.filter((a) => a.statut === "ECHEC").every((a) => a.nbConflitsTrouves === 0));

  // ---- m6 : couverture insuffisante : le plan d'axes porte le masquage et la trace
  const AXES_CONF = { role: "AXES_TRAVAUX", confidentialite: "CONFIDENTIEL_CONCESSIONNAIRE" };
  const P5: string = (await envoyer("post", "", { code: "CONFLITS-COUVERTURE", nom: "Couverture de la revue", regionId: R1 })).body.projet.id;
  const JEU5 = await deposerEtAutoriser(P5, await kml(AXES), AXES_CONF, "axes.kml");
  const a5a = await analyser(P5);
  const couv5 = await sql<{ id: string; ja: string | null; jr: string | null; axe: string }>(`SELECT id, "jeuAxesId" ja, "jeuReseauId" jr, axe FROM conflits_projet WHERE "projetId" = $1 ORDER BY axe`, P5);
  verifier("14. m6 : les dossiers de couverture insuffisante memorisent le plan d'axes dont ils portent la geometrie (jeuAxesId), jamais un jeu de reseau", a5a.status === 201 && couv5.length === 2 && couv5.every((c) => c.ja === JEU5 && c.jr === null), couv5);
  const traces5 = async () => compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'ConsultationJeuProjet' AND "entityId" = $1 AND "userId" = $2`, JEU5, lecteur.id);
  const avantTrace = await traces5();
  const l5 = await get(`/${P5}/conflits`, T.lecteur);
  const f5 = await get(`/${P5}/conflits/${couv5[0].id}`, T.lecteur);
  verifier("14. m6 : la consultation d'un dossier de couverture (liste et fiche) est TRACEE comme celle d'un reseau (ConsultationJeuProjet sur le plan d'axes, route conflits, une ligne par fenetre) ; la fiche rend l'axe",
    avantTrace === 0 && l5.body.total === 2 && f5.status === 200 && f5.body.conflit.geometrie?.type === "LineString" && (await traces5()) === 1
    && (await sql<{ r: string }>(`SELECT after->>'route' r FROM audit_logs WHERE "entityType" = 'ConsultationJeuProjet' AND "entityId" = $1 AND "userId" = $2`, JEU5, lecteur.id))[0].r === "conflits", { avantTrace });
  const JEU5_V2 = await deposerEtAutoriser(P5, await kml([{ nom: "Axe A", coords: [[0, 4], [200, 4]] }, { nom: "Axe B", coords: [[200, 0], [200, 150]] }]), AXES_CONF, "axes-v2.kml");
  const statutJeu5 = (await sql<{ s: string }>(`SELECT statut::text s FROM projets_voirie_jeux WHERE id = $1`, JEU5))[0].s;
  const l5r = await get(`/${P5}/conflits`, T.lecteur), l5c = await get(`/${P5}/conflits`, T.chef), f5r = await get(`/${P5}/conflits/${couv5[1].id}`, T.lecteur), f5c = await get(`/${P5}/conflits/${couv5[1].id}`, T.chef);
  verifier("14. m6 : le plan d'axes a ete REMPLACE : un lecteur ne voit plus les dossiers de couverture (liste vide, fiche 404, geometrie jamais servie) ; un GESTIONNAIRE les voit avec l'axe",
    statutJeu5 === "REMPLACE" && l5r.body.total === 0 && l5r.body.conflits.length === 0 && f5r.status === 404 && l5c.body.total === 2 && f5c.body.conflit.geometrie?.type === "LineString" && f5c.body.conflit.geometrieMasquee === false,
    { statutJeu5, lecteur: l5r.body.total, fiche: f5r.status });
  const a5b = await analyser(P5);
  const reperes = await sql<{ id: string }>(`SELECT id FROM conflits_projet WHERE "projetId" = $1 AND "jeuAxesId" = $2`, P5, JEU5_V2);
  const l5b = await get(`/${P5}/conflits`, T.lecteur);
  verifier("14. m6 : l'analyse suivante repointe les dossiers retrouves sur le nouveau plan d'axes ; le lecteur les revoit, avec la geometrie",
    a5b.status === 201 && reperes.length >= 1 && l5b.body.total === reperes.length && l5b.body.conflits.every((c: { geometrieMasquee: boolean; bbox: unknown }) => c.geometrieMasquee === false && c.bbox !== null), { reperes: reperes.length, total: l5b.body.total });
  const retire5 = await envoyer("delete", `/${P5}/jeux/${JEU5_V2}`);
  const idRetire = reperes[0]?.id ?? UUID0;
  const f5a = (await get(`/${P5}/conflits/${idRetire}`, T.admin)), f5l = await get(`/${P5}/conflits/${idRetire}`, T.lecteur), l5a = (await get(`/${P5}/conflits`, T.admin)).body;
  verifier("14. m6 : le plan d'axes a ete RETIRE : meme un ADMIN ne recoit plus l'axe (geometrie, boite, mesure masquees, dossier conserve) ; un lecteur recoit 404",
    retire5.status === 200 && f5a.status === 200 && f5a.body.conflit.geometrie === null && f5a.body.conflit.geometrieMasquee === true && f5a.body.conflit.bbox === null && f5a.body.conflit.mesure === null
    && f5l.status === 404 && l5a.total >= 2 && l5a.conflits.filter((c: { geometrieMasquee: boolean }) => c.geometrieMasquee).length === reperes.length, { statut: f5a.status });

  // ---- m7 : curseurs forges, vraies routes et vraie base
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
  const forges = [
    ["conflits", `/${PID}/conflits?curseur=${b64({ t: "+275760-09-13T00:00:00.000Z", i: "123e4567-e89b-42d3-a456-426614174000" })}`],
    ["conflits", `/${PID}/conflits?curseur=${b64({ t: "2026-11-06T10:15:30.123Z", i: String.fromCharCode(0) })}`],
    ["conflits", `/${PID}/conflits?curseur=${b64({ t: "9999-01-01T00:00:00.000Z", i: "123e4567-e89b-42d3-a456-426614174000" })}`],
    ["analyses", `/${PID}/analyses?curseur=${b64({ n: 2147483648 })}`], ["analyses", `/${PID}/analyses?curseur=${b64({ n: 1e300 })}`],
  ] as const;
  const repForges = await Promise.all(forges.map(([, c]) => get(c, T.lecteur)));
  verifier("14. m7 : un curseur forge (annee hors intervalle PostgreSQL, identifiant avec octet NUL, numero superieur a la colonne integer) donne 400 CURSEUR_INVALIDE, jamais 500", repForges.every((r) => r.status === 400 && r.body.code === "CURSEUR_INVALIDE"), repForges.map((r) => [r.status, r.body.code]));
  const pageUn = await get(`/${PID}/conflits?limite=3`, T.chef);
  verifier("14. m7 : le curseur produit par le serveur reste accepte (page suivante, aucune regression)", pageUn.body.curseurSuivant && (await get(`/${PID}/conflits?limite=3&curseur=${encodeURIComponent(pageUn.body.curseurSuivant)}`, T.chef)).status === 200);

  // ---- m8 : cadence minimale des analyses par projet (reglage par defaut : une par minute) ; une analyse en ECHEC ne compte pas
  delete process.env.PROJETS_VOIRIE_ANALYSE_INTERVALLE_S;
  const P6: string = (await envoyer("post", "", { code: "CONFLITS-CADENCE", nom: "Cadence de la revue", regionId: R1 })).body.projet.id;
  await deposerEtAutoriser(P6, await kml([{ nom: "Axe unique", coords: [[0, 0], [200, 0]] }]), { role: "AXES_TRAVAUX" }, "axe.kml");
  await deposerEtAutoriser(P6, await geojson(dense), { role: "RESEAU_TIERS", concessionnaireId: CONC1, classePrecision: "C" }, "dense.geojson");
  process.env.PROJETS_VOIRIE_CONFLITS_MAX = "100";
  const echec6 = await analyser(P6);
  delete process.env.PROJETS_VOIRIE_CONFLITS_MAX;
  const ok6 = await analyser(P6);
  verifier("14. m8 : une analyse en ECHEC ne compte pas dans la cadence : apres un 422 ANALYSE_TROP_VOLUMINEUSE (trace ECHEC), la nouvelle analyse passe tout de suite (201)", echec6.status === 422 && ok6.status === 201, [echec6.status, ok6.status]);
  const nAvant6 = await compter(`SELECT count(*) n FROM analyses_conflit_projet WHERE "projetId" = $1`, P6);
  const histoAvant6 = await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'AnalyseConflitProjet'`);
  const trop6 = await analyser(P6);
  exemples["erreur_analyse_trop_frequente"] = trop6.body;
  verifier("14. m8 : une deuxieme analyse TERMINEE du meme projet dans la minute : 429 ANALYSE_TROP_FREQUENTE, delai restant dans le corps et dans Retry-After (1 a 60 s), rien n'est ecrit (ni analyse, ni audit)",
    trop6.status === 429 && trop6.body.code === "ANALYSE_TROP_FREQUENTE" && Number.isInteger(trop6.body.retryAfterS) && trop6.body.retryAfterS >= 1 && trop6.body.retryAfterS <= 60 && trop6.headers["retry-after"] === String(trop6.body.retryAfterS)
    && (await compter(`SELECT count(*) n FROM analyses_conflit_projet WHERE "projetId" = $1`, P6)) === nAvant6 && (await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'AnalyseConflitProjet'`)) === histoAvant6, trop6.body);
  verifier("14. m8 : la cadence est PAR PROJET (une analyse d'un autre projet passe) ; un lecteur n'a toujours pas le droit de lancer une analyse (403, avant toute cadence)",
    (await analyser((await envoyer("post", "", { code: "CONFLITS-AUTRE", nom: "Autre projet", regionId: R1 })).body.projet.id, T.chef)).status === 201 && (await analyser(P6, T.lecteur)).status === 403);
  process.env.PROJETS_VOIRIE_ANALYSE_INTERVALLE_S = "1";
  await dormir(1200);
  const apresDelai = await analyser(P6);
  process.env.PROJETS_VOIRIE_ANALYSE_INTERVALLE_S = "0";
  verifier("14. m8 : le delai ecoule (reglage a 1 s pour l'essai), l'analyse passe a nouveau (201)", apresDelai.status === 201, apresDelai.body);

  // Export : meme limiteur que les analyses (3 simultanes), puis delai cote base.
  const limiteurs = await banc.imp("projets-voirie/limiteurs");
  const liberer: (() => void)[] = [];
  const tenus = [0, 1, 2].map(() => limiteurs.limiteurAnalyses.executer(() => new Promise<void>((res) => { liberer.push(res); })));
  await dormir(150);
  const exportAttend = Promise.resolve(get(`/${PID}/conflits/export.csv`, T.chef));
  await dormir(500);
  const etatPendant = { ...limiteurs.limiteurAnalyses.etat };
  liberer[0]();
  const repExport = await exportAttend;
  liberer.forEach((f) => f());
  await Promise.all(tenus);
  verifier("14. m8 : l'export CSV passe par le limiteur des analyses : avec trois analyses en cours, il ATTEND une place (3 actifs, 1 en attente) puis aboutit (200) quand une est liberee",
    etatPendant.actifs === 3 && etatPendant.enAttente === 1 && repExport.status === 200 && repExport.headers["content-type"].includes("text/csv"), etatPendant);
  const nExport0 = await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'ExportConflitsProjetVoirie'`);
  process.env.PROJETS_VOIRIE_DELAI_ANALYSE_MS = "1000";
  const client2 = new pg.Client({ connectionString: banc.urlClone });
  await client2.connect();
  await client2.query("BEGIN");
  await client2.query(`LOCK TABLE conflits_projet IN ACCESS EXCLUSIVE MODE`);
  const debutExport = Date.now();
  const exportLent = Promise.resolve(get(`/${PID}/conflits/export.csv`, T.chef));
  const garde = setTimeout(() => { client2.query("ROLLBACK").catch(() => undefined); }, 4000);
  const repLent = await exportLent;
  clearTimeout(garde);
  const dureeExport = Date.now() - debutExport;
  await client2.query("ROLLBACK").catch(() => undefined);
  await client2.end();
  delete process.env.PROJETS_VOIRIE_DELAI_ANALYSE_MS;
  verifier(`14. m8 : l'export est borne cote BASE (statement_timeout 1 s, table verrouillee par une autre session) : 504 EXPORT_TROP_LONG en ${dureeExport} ms, jamais un 500, jamais une attente sans fin`,
    repLent.status === 504 && repLent.body.code === "EXPORT_TROP_LONG" && dureeExport < 3500, { statut: repLent.status, corps: repLent.body, dureeExport });
  verifier("14. m8 : un export interrompu n'est pas audite comme remis (aucune ligne ExportConflitsProjetVoirie pour la tentative echouee)", repLent.status === 504 && (await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'ExportConflitsProjetVoirie'`)) === nExport0);

  // ---- m1 : projet retire ou inconnu : 404 PROJET_INTROUVABLE pour tous les comptes, lectures et ecritures
  const idP2 = (await sql<{ id: string }>(`SELECT id FROM conflits_projet WHERE "projetId" = $1 ORDER BY id LIMIT 1`, P2))[0].id;
  const idA2 = (await sql<{ id: string }>(`SELECT id FROM analyses_conflit_projet WHERE "projetId" = $1 ORDER BY numero LIMIT 1`, P2))[0].id;
  const idsLect = (chemin: string, t: string) => get(chemin, t);
  const ecritures = (pid: string, cid: string, t: string) => [
    patchP(pid, cid, { risque: "FAIBLE" }, t), stP(pid, cid, { vers: "POTENTIEL", justification: "Controle effectue avec le chef" }, t), envoyer("post", `/${pid}/conflits/${cid}/preuves`, { type: "NOTE", texte: "x" }, t),
    envoyer("post", `/${pid}/conflits/${cid}/decisions`, { option: "PROTEGER", justification: "Protection mecanique du cable" }, t), envoyer("post", `/${pid}/conflits/${cid}/decisions/${UUID0}/approuver`, { motif: JUSTIF }, t),
    envoyer("post", `/${pid}/regles`, { code: "TOL-FANTOME", toleranceProximiteM: 1, justification: "Tolerance pour un projet retire" }, t), envoyer("post", `/${pid}/analyses`, {}, t),
  ];
  const lectures = (pid: string, t: string) => [get(`/${pid}/regles`, t), get(`/${pid}/analyses`, t), get(`/${pid}/analyses/${idA2}`, t), get(`/${pid}/analyses/${idA2}/comparaison?avec=${idA2}`, t), get(`/${pid}/conflits`, t), get(`/${pid}/conflits/${idP2}`, t), get(`/${pid}/conflits/export.csv`, t)];
  const avantRetrait = await Promise.all(lectures(P2, T.chef));
  const histoP2 = await compter(`SELECT count(*) n FROM conflits_projet_historique h JOIN conflits_projet c ON c.id = h."conflitId" WHERE c."projetId" = $1`, P2);
  const suppr = await envoyer("delete", `/${P2}`, undefined, T.admin);
  const nationaux = [...(await Promise.all(lectures(P2, T.chef))), ...(await Promise.all(lectures(P2, T.admin))), ...(await Promise.all(ecritures(P2, idP2, T.chef))), ...(await Promise.all(ecritures(P2, idP2, T.admin)))];
  verifier(`14. m1 : le projet a ete retire (suppression logique) : ${nationaux.length} appels de comptes NATIONAUX (7 lectures et 7 ecritures, GESTIONNAIRE et ADMIN) donnent tous 404 PROJET_INTROUVABLE (avant la correction : 200 en lecture, ecritures acceptees), rien n'est ecrit`,
    avantRetrait.filter((r) => r.status === 200).length === 7 && suppr.status === 200 && nationaux.every((r) => r.status === 404 && r.body.code === "PROJET_INTROUVABLE")
    && (await compter(`SELECT count(*) n FROM conflits_projet_historique h JOIN conflits_projet c ON c.id = h."conflitId" WHERE c."projetId" = $1`, P2)) === histoP2, nationaux.map((r) => [r.status, r.body.code]));
  const inconnu = "00000000-0000-4000-8000-0000000000bb";
  const repInconnus = [...(await Promise.all(lectures(inconnu, T.chef))), ...(await Promise.all(ecritures(inconnu, idP2, T.admin)))];
  verifier("14. m1 : un projet inconnu repond 404 PROJET_INTROUVABLE a un compte national (la liste ne rend plus 200 avec zero dossier), et un compte regional recoit la meme reponse pour le projet retire",
    repInconnus.every((r) => r.status === 404 && r.body.code === "PROJET_INTROUVABLE") && (await Promise.all(lectures(P2, T.reg1))).every((r) => r.status === 404 && r.body.code === "PROJET_INTROUVABLE"), repInconnus.map((r) => [r.status, r.body.code]));

  // ---- Constat (observation de la revue) : jokers LIKE dans les filtres `axe` (egalite insensible) et `q` (contient). Mesure sur la base reelle, documentee en 9.33.
  const totalP4 = (q: string) => get(`/${P4}/conflits?${q}`, T.chef).then((r) => r.body.total as number);
  const [sansFiltre, qPourcent, qSouligne, axeSouligne, axeEgal, qJokerNom, qNomExact, qAntislash] = await Promise.all([
    totalP4("limite=1"), totalP4("q=%25"), totalP4("q=_"), totalP4("axe=Axe_A"), totalP4("axe=axe%20a"), totalP4("q=Fibre_Marqueur"), totalP4("q=fibre-marqueur"), totalP4("q=%5C%25")]);
  verifier("14. constat LIKE : Prisma n'echappe ni le pourcent, ni le souligne, ni l'antislash dans `contains` et `equals` insensibles (ILIKE) : `q=%` et `q=_` rendent tous les dossiers, `axe=Axe_A` egale `axe=axe a`, `q=Fibre_Marqueur` egale `q=fibre-marqueur`, `q=\\%` ne rend rien ; aucune injection (valeurs liees), mais le filtre `axe` n'est pas une egalite stricte",
    sansFiltre > 0 && qPourcent === sansFiltre && qSouligne === sansFiltre && axeSouligne === axeEgal && axeEgal > 0 && qJokerNom === qNomExact && qNomExact > 0 && qAntislash === 0,
    { sansFiltre, qPourcent, qSouligne, axeSouligne, axeEgal, qJokerNom, qNomExact, qAntislash });

  if (process.env.CONFLITS_EXEMPLES) writeFileSync(process.env.CONFLITS_EXEMPLES, JSON.stringify(exemples, null, 2));
}

try {
  await main();
} catch (e) {
  verifier(`erreur inattendue du banc : ${(e as Error).message}`, false, (e as Error).stack?.split("\n").slice(0, 4));
} finally {
  await prisma.$disconnect();
  await banc.fermer();
  conclure();
}

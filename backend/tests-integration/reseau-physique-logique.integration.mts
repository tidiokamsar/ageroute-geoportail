// Banc d'integration des RESEAUX PHYSIQUES ET CIRCUITS LOGIQUES des projets de voirie (lot B1) contre un vrai PostGIS.
// Contrat : docs/projets-voirie/CONTRAT-RESEAUX.md. Voir tests-integration/README.md. Lancer (DATABASE_URL pointe sur `replay`) :
//   npx tsx tests-integration/reseau-physique-logique.integration.mts
// Avec RESEAUX_EXEMPLES=<fichier.json>, les reponses reelles servant d'exemples a docs/projets-voirie/API.md y sont ecrites.
//
// Tout passe par les routes reelles montees comme en production (`createApp`), des jetons signes par des secrets aleatoires, le role, le module et le
// perimetre LUS EN BASE, le SQL reel (PostGIS), les contraintes et declencheurs reels, dans le clone jetable `essai_reseau_pl` (la migration
// 20261101200000 y est appliquee par le banc si `replay` ne la porte pas). La migration 20261031100000 (conflits) doit etre dans `replay`.
//
// DONNEES 100 % SYNTHETIQUES (voir lib/fixtures-conflits.mts) : segments inventes, construits en metres dans le repere UTM 29N.
//   KIS-LOGIC-01 : trois circuits sur le meme trace (L2, L2 bis, L2 ter a l'envers) et des infrastructures physiques distinctes.
import { writeFileSync } from "node:fs";
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure, proche } from "./lib/verdict.ts";
import { AXES, R1_BASE, O, constructeurs } from "./lib/fixtures-conflits.mts";

const banc = await ouvrirBancClone("essai_reseau_pl", { migrations: ["20261101200000_reseaux_physiques_logiques"] });
const { prisma } = await banc.imp("lib/prisma");
const { createApp } = await banc.imp("app");
const { signAccessToken } = await banc.imp("utils/jwt");
const noyau = await banc.imp("projets-voirie/reseaux/comptage.noyau");
const request = (await import("supertest")).default;

// Les delais minimaux entre deux executions sont desactives pour ce banc, qui en enchaine plusieurs ; la section 8 les remet.
process.env.PROJETS_VOIRIE_ANALYSE_INTERVALLE_S = "0";
process.env.PROJETS_VOIRIE_ASSOC_INTERVALLE_S = "0";
const app = createApp();
const BASE = "/api/v2/projets-voirie";

const sql = <T = Record<string, unknown>>(texte: string, ...v: unknown[]) => prisma.$queryRawUnsafe(texte, ...v) as Promise<T[]>;
const compter = async (texte: string, ...v: unknown[]) => Number((await sql<{ n: bigint }>(texte, ...v))[0].n);

async function wgs(pts: [number, number][]): Promise<[number, number][]> {
  const wkt = `LINESTRING(${pts.map(([x, y]) => `${O.x + x} ${O.y + y}`).join(",")})`;
  const r = await sql<{ g: string }>(`SELECT ST_AsGeoJSON(ST_Transform(ST_SetSRID(ST_GeomFromText($1), 32629), 4326), 9) AS g`, wkt);
  return JSON.parse(r[0].g).coordinates;
}
async function wgsPoint([x, y]: [number, number]): Promise<[number, number]> {
  const r = await sql<{ g: string }>(`SELECT ST_AsGeoJSON(ST_Transform(ST_SetSRID(ST_MakePoint($1, $2), 32629), 4326), 9) AS g`, O.x + x, O.y + y);
  return JSON.parse(r[0].g).coordinates;
}
const { geojson, kml } = constructeurs(wgs);

type Entree = { nom: string; coords?: [number, number][]; pt?: [number, number] };
/** FeatureCollection de lignes et de points (coordonnees locales en metres). */
async function geojsonMixte(entrees: Entree[]): Promise<Buffer> {
  const features = [];
  for (const e of entrees) {
    const geometry = e.pt ? { type: "Point", coordinates: await wgsPoint(e.pt) } : { type: "LineString", coordinates: await wgs(e.coords!) };
    features.push({ type: "Feature", properties: { name: e.nom }, geometry });
  }
  return Buffer.from(JSON.stringify({ type: "FeatureCollection", features }));
}

/** Resultat d'une requete brute annulee : SQLSTATE de l'erreur, ou « ok ». */
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

  const get = (chemin: string, t: string | null = T.chef) => { const r = request(app).get(`${BASE}${chemin}`); return t ? r.set("Authorization", `Bearer ${t}`) : r; };
  const envoyer = (methode: "post" | "patch" | "delete" | "put", chemin: string, corps?: unknown, t: string | null = T.chef) => {
    let r = request(app)[methode](`${BASE}${chemin}`);
    if (t) r = r.set("Authorization", `Bearer ${t}`);
    return corps === undefined ? r : r.send(corps as object);
  };
  function depot(projetId: string, fichier: Buffer, champs: Record<string, string | undefined>, nom = "fichier.geojson", t = T.chef) {
    const r = request(app).post(`${BASE}/${projetId}/jeux`).set("Authorization", `Bearer ${t}`);
    for (const [k, v] of Object.entries(champs)) if (v !== undefined) r.field(k, v);
    return r.attach("fichier", fichier, { filename: nom });
  }
  async function deposerEtAutoriser(pid: string, fichier: Buffer, champs: Record<string, string | undefined>, nom: string, t = T.chef): Promise<string> {
    const d = await depot(pid, fichier, champs, nom, t);
    const id: string = d.body.jeu?.id;
    if (!id) throw new Error(`depot refuse : ${JSON.stringify(d.body)}`);
    const a = await envoyer("post", `/${pid}/jeux/${id}/autoriser`, { justification: JUSTIF }, t);
    if (a.status !== 200) throw new Error(`autorisation refusee : ${JSON.stringify(a.body)}`);
    return id;
  }

  console.log("\n== Reseaux physiques et circuits logiques : banc PostGIS ==");

  const PID: string = (await envoyer("post", "", { code: "RESEAUX-1", nom: "Voirie de banc", commune: "Banc", regionId: R1 })).body.projet.id;
  const PID_AUTRE: string = (await envoyer("post", "", { code: "RESEAUX-AUTRE", nom: "Autre projet", regionId: R1 }, T.admin)).body.projet.id;
  const conc = async (nom: string, typeReseau: string): Promise<string> => (await envoyer("post", "/concessionnaires", { nom, typeReseau })).body.concessionnaire.id;
  const CONC1 = await conc("Operateur Telecom Synthetique", "TELECOM");
  const CONC2 = await conc("Societe des Eaux Synthetique", "EAU_POTABLE");
  const CONC3 = await conc("Operateur Fibre Synthetique", "TELECOM");

  const INFRA: Entree[] = [
    { nom: "Gaine G1", coords: [[20, 2.5], [80, 2.5]] }, // porte L2, L2 bis, L2 ter (a 0,5 m)
    { nom: "Gaine G2", coords: [[20, 6.2], [80, 6.2]] }, // porte L6 (a 0,2 m)
    { nom: "Gaine Loin", coords: [[20, 40], [80, 40]] }, // loin de tout circuit
    { nom: "Chambre C1", pt: [50, 2.5] },
  ];
  const EQUIP: Entree[] = [{ nom: "Vanne V1", pt: [50, 2.7] }];

  const JEU_AXES = await deposerEtAutoriser(PID, await kml(AXES), { role: "AXES_TRAVAUX" }, "axes.kml");
  const JEU_CIRC = await deposerEtAutoriser(PID, await geojson(R1_BASE), { role: "RESEAU_TIERS", concessionnaireId: CONC1, natureObjets: "CIRCUIT_LOGIQUE" }, "circuits.geojson");
  const JEU_INFRA = await deposerEtAutoriser(PID, await geojsonMixte(INFRA), { role: "RESEAU_TIERS", concessionnaireId: CONC3, natureObjets: "ACTIF_PHYSIQUE", classePrecision: "B" }, "infra.geojson");
  const JEU_EQUIP = await deposerEtAutoriser(PID, await geojsonMixte(EQUIP), { role: "RESEAU_TIERS", concessionnaireId: CONC2, natureObjets: "EQUIPEMENT" }, "equipements.geojson");
  // Projet a part, avec son propre jeu : un objet d'un autre projet ne se qualifie ni ne se relie depuis celui-ci.
  const JEU_AUTRE = await deposerEtAutoriser(PID_AUTRE, await geojsonMixte([{ nom: "Autre circuit", coords: [[20, 2], [80, 2]] }]), { role: "RESEAU_TIERS", concessionnaireId: CONC1, natureObjets: "CIRCUIT_LOGIQUE" }, "autre.geojson", T.admin);

  const oid = async (jeu: string, nom: string): Promise<string> => (await sql<{ id: string }>(`SELECT id::text FROM projets_voirie_objets WHERE "jeuId" = $1 AND nom = $2 ORDER BY id LIMIT 1`, jeu, nom))[0].id;
  const L = (m: string) => `Fibre-Marqueur ${m}`;
  const O_L2 = await oid(JEU_CIRC, L("L2")), O_L2B = await oid(JEU_CIRC, L("L2 bis")), O_L2T = await oid(JEU_CIRC, L("L2 ter")), O_L6 = await oid(JEU_CIRC, L("L6"));
  const O_L9 = await oid(JEU_CIRC, L("L9")), O_L13 = await oid(JEU_CIRC, L("L13"));
  const O_G1 = await oid(JEU_INFRA, "Gaine G1"), O_G2 = await oid(JEU_INFRA, "Gaine G2"), O_GL = await oid(JEU_INFRA, "Gaine Loin"), O_C1 = await oid(JEU_INFRA, "Chambre C1");
  const O_V1 = await oid(JEU_EQUIP, "Vanne V1");
  const O_AXE = (await sql<{ id: string }>(`SELECT id::text FROM projets_voirie_objets WHERE "jeuId" = $1 ORDER BY id LIMIT 1`, JEU_AXES))[0].id;
  const O_AUTRE = await oid(JEU_AUTRE, "Autre circuit");

  const etat = async (): Promise<Record<string, number>> => {
    const tables = await sql<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND left(table_name, 1) <> '_' ORDER BY 1`);
    const sortie: Record<string, number> = {};
    for (const t of tables) sortie[t.table_name] = await compter(`SELECT count(*) n FROM "${t.table_name}"`);
    return sortie;
  };
  const wktTr = (pts: [number, number][]) => `LINESTRING(${pts.map(([x, y]) => `${O.x + x} ${O.y + y}`).join(",")})`;
  await sql(`INSERT INTO troncons ("id","code","nom","classe","regionId","longueurKm","revetement","pkDebut","pkFin","updatedAt","geom")
             VALUES (gen_random_uuid()::text, 'BANC-T-RESEAU', 'Troncon du referentiel', 'RU', $1, 0.2, 'BITUME', 0, 0.2, now(), ST_Transform(ST_SetSRID(ST_GeomFromText($2), 32629), 4326))`, R1, wktTr([[0, 5], [200, 5]]));
  const empreinteTroncons = async () => (await sql<{ h: string }>(`SELECT md5(string_agg(t::text, '|' ORDER BY code)) h FROM troncons t`))[0].h;
  const avantTout = await etat();
  const empreinteAvant = await empreinteTroncons();

  const D = (id: string) => `/${PID}/reseau/objets/${id}`;
  const descripteur = (extra: Record<string, unknown> = {}) => ({ justification: JUSTIF, ...extra });
  const auditLignes = async (entityType: string) => sql<{ action: string; entityId: string; before: unknown; after: unknown }>(`SELECT action::text, "entityId", "before", "after" FROM audit_logs WHERE "entityType" = $1 ORDER BY "createdAt", id`, entityType);

  // ================================================================ 1. Comptage par nature : KIS-LOGIC-01
  const c0 = await get(`/${PID}/reseau/comptage`);
  exemples["comptage_initial"] = c0.body;
  const b0 = c0.body;
  verifier("1. comptage 200 : quatre blocs de nature, jamais un total qui les melange", c0.status === 200
    && ["infrastructuresPhysiques", "circuitsLogiques", "equipements", "natureInconnue"].every((k) => k in b0) && !("total" in b0) && !("nombreObjets" in b0) && !("longueurTotaleM" in b0), Object.keys(b0));
  verifier("1. KIS-LOGIC-01 : huit circuits logiques declares dont trois a la meme trace, quatre infrastructures declarees (trois lignes, une chambre), un equipement",
    b0.circuitsLogiques.nombreDeclare === 8 && b0.infrastructuresPhysiques.nombreDeclare === 4 && b0.infrastructuresPhysiques.nombreLineaires === 3 && b0.equipements.nombreDeclare === 1
    && b0.natureInconnue.nombreObjets === 0, b0);
  verifier("1. KIS-LOGIC-01 : trois circuits superposes ne sont PAS trois cables : la somme des longueurs de circuits (6 x 60 + 40 + 10 = 410 m) depasse la trace fusionnee (4 x 60 + 40 + 10 = 290 m)",
    proche(b0.circuitsLogiques.sommeLongueursCircuitsM, 410, 0.6) && proche(b0.circuitsLogiques.longueurTraceFusionneM, 290, 0.5)
    && b0.circuitsLogiques.longueurTraceFusionneM < b0.circuitsLogiques.sommeLongueursCircuitsM, b0.circuitsLogiques);
  verifier("1. les trois circuits de meme trace (dont un parcouru a l'envers) sont reconnus comme un groupe de trace identique, sans devenir des infrastructures", b0.circuitsLogiques.tracesPartagees.groupes === 1
    && b0.circuitsLogiques.tracesPartagees.circuitsConcernes === 3 && b0.infrastructuresPhysiques.nombreDeclare === 4, b0.circuitsLogiques.tracesPartagees);
  verifier("1. la longueur de trace fusionnee des infrastructures (3 gaines de 60 m) n'additionne PAS celle des circuits ; chaque grandeur a son libelle",
    proche(b0.infrastructuresPhysiques.longueurTraceFusionneM, 180, 0.4) && b0.infrastructuresPhysiques.longueurTraceFusionneM !== b0.infrastructuresPhysiques.longueurTraceFusionneM + b0.circuitsLogiques.longueurTraceFusionneM
    && /trace fusionnée/.test(b0.libelles.longueurTraceFusionneM) && /somme des longueurs de circuits/.test(b0.libelles.sommeLongueursCircuitsM) && /infrastructures physiques déclarées/.test(b0.libelles.nombreInfrastructuresDeclarees));
  verifier("1. les avertissements disent que les circuits ne sont pas des cables et que leur support physique est inconnu",
    b0.avertissements.some((a: string) => /n'est pas un nombre de câbles physiques/.test(a)) && b0.avertissements.some((a: string) => /ne sont pas 8 câbles physiques/.test(a))
    && b0.avertissements.some((a: string) => /8 circuit\(s\) logique\(s\) sans support physique validé/.test(a)) && b0.circuitsLogiques.supportPhysique.sansSupportConnu === 8, b0.avertissements);

  // Accord entre le noyau pur (geometrie plane) et PostGIS (geographie), sur les memes fixtures.
  const objetsPlan = [
    ...R1_BASE.map((l, i) => ({ id: `c${i}`, nature: "CIRCUIT_LOGIQUE", typeObjet: null, typeGeom: "LIGNE", ligne: l.coords })),
    ...INFRA.map((e, i) => ({ id: `i${i}`, nature: "ACTIF_PHYSIQUE", typeObjet: null, typeGeom: e.pt ? "POINT" : "LIGNE", ligne: e.coords })),
    ...EQUIP.map((e, i) => ({ id: `e${i}`, nature: "EQUIPEMENT", typeObjet: null, typeGeom: "POINT" })),
  ];
  const oracle = noyau.comptabiliser(objetsPlan);
  verifier("1. ORACLE : le noyau pur (plan) et PostGIS (geographie) s'accordent sur les nombres exacts et, a 0,1 % pres, sur les longueurs",
    oracle.circuitsLogiques.nombreDeclare === b0.circuitsLogiques.nombreDeclare && oracle.infrastructuresPhysiques.nombreDeclare === b0.infrastructuresPhysiques.nombreDeclare
    && oracle.circuitsLogiques.tracesPartagees.groupes === b0.circuitsLogiques.tracesPartagees.groupes
    && proche(oracle.circuitsLogiques.longueurTraceFusionneM, b0.circuitsLogiques.longueurTraceFusionneM, oracle.circuitsLogiques.longueurTraceFusionneM * 0.001)
    && proche(oracle.circuitsLogiques.sommeLongueursCircuitsM, b0.circuitsLogiques.sommeLongueursCircuitsM, oracle.circuitsLogiques.sommeLongueursCircuitsM * 0.001)
    && proche(oracle.infrastructuresPhysiques.longueurTraceFusionneM, b0.infrastructuresPhysiques.longueurTraceFusionneM, 0.2), { oracle: oracle.circuitsLogiques, bd: b0.circuitsLogiques });

  verifier("1. qualite : classe declaree ou « inconnue » (jamais deduite), aucune donnee verticale, aucune evaluation 3D",
    b0.qualite.parClasse.B === 4 && b0.qualite.parClasse.inconnue === 9 && b0.qualite.objets === 13 && b0.qualite.donneesVerticales.objetsAvecProfondeurOuAltitude === 0
    && b0.qualite.donneesVerticales.sansProfondeur === 13 && b0.qualite.donneesVerticales.evaluables === 0 && /aucune conclusion 3D/i.test(b0.qualite.donneesVerticales.mention), b0.qualite);
  verifier("1. sans descripteur, la repartition par type est « INCONNU » partout (rien n'est devine a partir du nom du fichier)",
    JSON.stringify(b0.circuitsLogiques.parType) === JSON.stringify({ INCONNU: 8 }) && JSON.stringify(b0.infrastructuresPhysiques.parType) === JSON.stringify({ INCONNU: 4 }), [b0.circuitsLogiques.parType, b0.infrastructuresPhysiques.parType]);
  verifier("1. les limites du comptage disent : objets declares, proposition n'est pas support valide, vertical non evalue, connectivite non evaluee",
    b0.limites.length === 4 && /connectivité/.test(b0.limites[3]) && /Conflit vertical non évalué/.test(b0.limites[2]), b0.limites);

  // ================================================================ 2. Descripteurs : nature, qualite, vertical
  const fiche0 = await get(D(O_L13));
  exemples["objet_fiche_sans_descripteur"] = fiche0.body;
  verifier("2. un objet SANS descripteur herite de son jeu : nature du jeu (origine JEU), classe inconnue, precisions nulles, source et confidentialite du jeu",
    fiche0.status === 200 && fiche0.body.objet.nature === "CIRCUIT_LOGIQUE" && fiche0.body.objet.origineNature === "JEU" && fiche0.body.objet.qualite.classePrecision === null
    && fiche0.body.objet.qualite.origineClasse === "INCONNUE" && fiche0.body.objet.qualite.precisionHorizontaleM === null && fiche0.body.objet.descripteur === null
    && fiche0.body.objet.source.jeuId === JEU_CIRC && fiche0.body.objet.source.version === 1 && fiche0.body.objet.source.confidentialite === "CONFIDENTIEL_CONCESSIONNAIRE", fiche0.body.objet);
  verifier("2. sans profondeur ni altitude : etat vertical ABSENTE, evaluable faux, AUCUNE conclusion 3D",
    fiche0.body.objet.vertical.etat === "ABSENTE" && fiche0.body.objet.vertical.evaluable === false && fiche0.body.objet.vertical.conclusion3D === null && fiche0.body.objet.vertical.profondeurM === null
    && /aucune conclusion 3D/.test(fiche0.body.objet.vertical.motifs[0]), fiche0.body.objet.vertical);
  verifier("2. la fiche ne rend AUCUNE geometrie (ni coordonnees, ni objet geometry)", !/"coordinates"|"geometry"|"geometrie"|LINESTRING/i.test(JSON.stringify(fiche0.body)));

  // Premier descripteur : classe A, profondeur et reference.
  const p1 = await envoyer("put", `${D(O_L6)}/descripteur`, descripteur({ classePrecision: "A", precisionHorizontaleM: 0.1, methodeCollecte: "GNSS RTK", dateConstat: "2026-10-01", niveauConfiance: "ELEVE", statutQualite: "OBSERVE", profondeurM: 1.2, referenceVerticale: "terrain naturel" }));
  exemples["descripteur_cree"] = p1.body;
  verifier("2. PUT descripteur : 201 a la creation ; qualite declaree rendue (classe A origine OBJET, precision 0,1 m, methode, date) ; nature heritee du jeu",
    p1.status === 201 && p1.body.objet.qualite.classePrecision === "A" && p1.body.objet.qualite.origineClasse === "OBJET" && p1.body.objet.qualite.precisionHorizontaleM === 0.1
    && p1.body.objet.qualite.methodeCollecte === "GNSS RTK" && p1.body.objet.qualite.dateConstat === "2026-10-01" && p1.body.objet.qualite.niveauConfiance === "ELEVE" && p1.body.objet.nature === "CIRCUIT_LOGIQUE"
    && p1.body.objet.origineNature === "JEU" && p1.body.objet.descripteur.declarePar === "Sekou Gestionnaire", p1.body);
  verifier("2. profondeur et reference fournies : etat FOURNIE, mais evaluable reste FAUX et aucune conclusion 3D n'est produite (l'evaluation verticale n'existe pas encore)",
    p1.body.objet.vertical.etat === "FOURNIE" && p1.body.objet.vertical.profondeurM === 1.2 && p1.body.objet.vertical.evaluable === false && p1.body.objet.vertical.conclusion3D === null, p1.body.objet.vertical);
  const p2 = await envoyer("put", `${D(O_L6)}/descripteur`, descripteur({ classePrecision: "B" }));
  verifier("2. PUT remplace (200) : une valeur omise devient INCONNUE (profondeur nulle), jamais heritee ni conservee ; une seule ligne en base ; etat vertical ABSENTE",
    p2.status === 200 && p2.body.objet.vertical.profondeurM === null && p2.body.objet.vertical.etat === "ABSENTE" && p2.body.objet.qualite.precisionHorizontaleM === null
    && p2.body.objet.qualite.methodeCollecte === null && (await compter(`SELECT count(*) n FROM reseau_objets_descripteurs WHERE "objetId" = $1::bigint`, O_L6)) === 1, p2.body.objet);
  const p3 = await envoyer("put", `${D(O_L6)}/descripteur`, descripteur({ classePrecision: "A" }));
  verifier("2. troisieme PUT (classe A, sans profondeur) : toujours une seule ligne ; statut de qualite INCONNU par defaut ; justification conservee",
    p3.status === 200 && p3.body.objet.qualite.statutQualite === "INCONNU" && p3.body.objet.descripteur.justification === JUSTIF && p3.body.objet.descripteur.modifiePar === "Sekou Gestionnaire", p3.body.objet);
  const aud = await auditLignes("ReseauObjetDescripteur");
  verifier("2. audit : une ligne par ecriture (CREATE puis deux UPDATE), l'ancien etat dans `before`, aucune geometrie ni coordonnee",
    aud.length === 3 && aud[0].action === "CREATE" && aud[1].action === "UPDATE" && aud[2].action === "UPDATE" && (aud[1].before as { classePrecision: string }).classePrecision === "A" && (aud[1].after as { classePrecision: string }).classePrecision === "B"
    && !/coordinates|geom\b|LINESTRING/i.test(JSON.stringify(aud)), aud);

  // Refus de coherence (service) et de la base (declencheurs, defense en profondeur).
  const refus: [string, number, string, unknown][] = [
    ["reference verticale sans profondeur ni altitude", 422, "REFERENCE_VERTICALE_SANS_VALEUR", await envoyer("put", `${D(O_L13)}/descripteur`, descripteur({ referenceVerticale: "terrain naturel" }))],
    ["objet d'un plan d'axes", 422, "ROLE_NON_QUALIFIABLE", await envoyer("put", `${D(O_AXE)}/descripteur`, descripteur({ classePrecision: "A" }))],
    ["nature CIRCUIT_LOGIQUE sur un point (la chambre)", 422, "NATURE_INCOMPATIBLE_GEOMETRIE", await envoyer("put", `${D(O_C1)}/descripteur`, descripteur({ nature: "CIRCUIT_LOGIQUE" }))],
    ["nature EQUIPEMENT sur une ligne", 422, "NATURE_INCOMPATIBLE_GEOMETRIE", await envoyer("put", `${D(O_L2)}/descripteur`, descripteur({ nature: "EQUIPEMENT" }))],
    ["type VANNE pour un circuit logique", 422, "TYPE_OBJET_INCONNU_POUR_NATURE", await envoyer("put", `${D(O_L2)}/descripteur`, descripteur({ typeObjet: "VANNE" }))],
    ["objet d'un autre projet", 404, "OBJET_INTROUVABLE", await envoyer("put", `${D(O_AUTRE)}/descripteur`, descripteur({ classePrecision: "A" }))],
    ["objet inconnu", 404, "OBJET_INTROUVABLE", await envoyer("put", `${D("999999999")}/descripteur`, descripteur({ classePrecision: "A" }))],
  ];
  for (const [nom, statut, code, r] of refus) verifier(`2. refus : ${nom} -> ${statut} ${code}`, r.status === statut && r.body.code === code, [r.status, r.body]);
  verifier("2. precision qui s'arrondit a zero (0,004 m) : 400, jamais une erreur de la base", (await envoyer("put", `${D(O_L13)}/descripteur`, descripteur({ precisionHorizontaleM: 0.004 }))).status === 400);
  verifier("2. un LECTEUR ne peut pas qualifier un objet (403) ; un compte regional hors perimetre : 404 masque ; sans jeton 401",
    (await envoyer("put", `${D(O_L13)}/descripteur`, descripteur(), T.lecteur)).status === 403 && (await envoyer("put", `${D(O_L13)}/descripteur`, descripteur(), T.reg2)).status === 404
    && (await envoyer("put", `${D(O_L13)}/descripteur`, descripteur(), null)).status === 401);
  const apresRefus = await compter(`SELECT count(*) n FROM reseau_objets_descripteurs`);
  verifier("2. aucun refus n'a laisse de descripteur (une seule ligne : L6) ni de ligne d'audit en plus", apresRefus === 1 && (await auditLignes("ReseauObjetDescripteur")).length === 3);

  const insDesc = (id: string, colonnes = "", valeurs = "") => sql(`INSERT INTO reseau_objets_descripteurs ("objetId","jeuId","justification","declareParId"${colonnes}) VALUES (${id}::bigint,'x','descripteur de banc pour la base',$1${valeurs})`, chef.id);
  verifier("2. BASE : un descripteur sur un objet d'un plan d'axes est refuse (23514), meme en SQL direct", (await essaiAnnule(() => insDesc(O_AXE))) === "23514");
  verifier("2. BASE : une nature AXE (ou EMPRISE, ou INCONNUE) ne se declare pas (23514)", (await essaiAnnule(() => insDesc(O_L13, `,"nature"`, `,'AXE'::"NatureObjetReseau"`))) === "23514"
    && (await essaiAnnule(() => insDesc(O_L13, `,"nature"`, `,'INCONNUE'::"NatureObjetReseau"`))) === "23514");
  verifier("2. BASE : un equipement lineaire et un circuit ponctuel sont refuses (23514)", (await essaiAnnule(() => insDesc(O_L13, `,"nature"`, `,'EQUIPEMENT'::"NatureObjetReseau"`))) === "23514"
    && (await essaiAnnule(() => insDesc(O_C1, `,"nature"`, `,'CIRCUIT_LOGIQUE'::"NatureObjetReseau"`))) === "23514");
  verifier("2. BASE : precision nulle, profondeur negative, reference sans valeur, justification courte sont refusees (23514)",
    (await essaiAnnule(() => insDesc(O_L13, `,"precisionHorizontaleM"`, `,0`))) === "23514" && (await essaiAnnule(() => insDesc(O_L13, `,"profondeurM"`, `,-1`))) === "23514"
    && (await essaiAnnule(() => insDesc(O_L13, `,"referenceVerticale"`, `,'terrain'`))) === "23514"
    && (await essaiAnnule((tx) => tx.$queryRawUnsafe(`INSERT INTO reseau_objets_descripteurs ("objetId","jeuId","justification","declareParId") VALUES ($1::bigint,'x','court',$2)`, O_L13, chef.id))) === "23514");
  verifier("2. BASE : DELETE et TRUNCATE d'un descripteur sont refuses (23001), le changement d'objet aussi",
    (await essaiAnnule((tx) => tx.$executeRawUnsafe(`DELETE FROM reseau_objets_descripteurs`))) === "23001" && (await essaiAnnule((tx) => tx.$executeRawUnsafe(`TRUNCATE reseau_objets_descripteurs`))) === "23001"
    && (await essaiAnnule((tx) => tx.$executeRawUnsafe(`UPDATE reseau_objets_descripteurs SET "objetId" = "objetId" + 1`))) === "23001");
  verifier("2. BASE : le jeu de l'objet est celui de l'objet (rempli par la base), jamais celui que l'appelant croit",
    (await sql<{ jeuId: string }>(`SELECT "jeuId" FROM reseau_objets_descripteurs WHERE "objetId" = $1::bigint`, O_L6))[0].jeuId === JEU_CIRC);

  // ================================================================ 3. Propositions d'association (superposition geometrique)
  const avantProp = await etat();
  const pr1 = await envoyer("post", `/${PID}/reseau/associations/proposer`, { jeuId: JEU_CIRC });
  exemples["proposition"] = pr1.body;
  verifier("3. POST proposer : 201, statut PROPOSITIONS_A_VALIDER, parametres PROVISOIRES enregistres (tolerances par classe, methode maximum)",
    pr1.status === 201 && pr1.body.statut === "PROPOSITIONS_A_VALIDER" && pr1.body.parametres.statut === "PROVISOIRE_A_VALIDER" && pr1.body.parametres.methodeTolerance === "maximum"
    && pr1.body.parametres.tolerancesParClasseM.B === 1 && pr1.body.parametres.couvertureMin === 0.9, pr1.body.parametres);
  verifier("3. bilan : 8 circuits et 3 infrastructures lineaires examines, 4 propositions creees (L2, L2 bis, L2 ter -> G1 ; L6 -> G2), aucune deja connue",
    pr1.body.bilan.circuitsExamines === 8 && pr1.body.bilan.infrastructuresExaminees === 3 && pr1.body.bilan.creees === 4 && pr1.body.bilan.dejaConnues === 0 && pr1.body.bilan.tronque === false, pr1.body.bilan);
  const rels = (await get(`/${PID}/reseau/relations?limite=50`)).body.relations as { id: string; statut: string; origine: string; typeRelation: string; source: { objetId: string }; cible: { objetId: string }; proposition: Record<string, unknown> }[];
  const couple = (r: { source: { objetId: string }; cible: { objetId: string } }) => `${r.source.objetId}>${r.cible.objetId}`;
  verifier("3. les quatre relations sont PROPOSEE, AUTOMATIQUE, PORTE_PAR, aux bons couples ; aucune n'est appliquee silencieusement",
    rels.length === 4 && rels.every((r) => r.statut === "PROPOSEE" && r.origine === "AUTOMATIQUE" && r.typeRelation === "PORTE_PAR")
    && JSON.stringify(rels.map(couple).sort()) === JSON.stringify([`${O_L2}>${O_G1}`, `${O_L2B}>${O_G1}`, `${O_L2T}>${O_G1}`, `${O_L6}>${O_G2}`].sort()), rels.map(couple));
  verifier("3. chaque proposition porte sa methode : tolerance = MAXIMUM des classes (circuit de classe inconnue 2 m, gaine de classe B 1 m -> 2 m ; L6 de classe A 0,5 m -> 1 m), couverture 1, seuil, version, EPSG:32629",
    rels.every((r) => r.proposition.methode === "SUPERPOSITION_TOLERANCE" && r.proposition.toleranceM === (r.source.objetId === O_L6 ? 1 : 2) && r.proposition.couverture === 1 && r.proposition.couvertureMin === 0.9 && r.proposition.methodeTolerance === "maximum"
    && r.proposition.projection === "EPSG:32629" && r.proposition.statutParametres === "PROVISOIRE_A_VALIDER" && !/coordinates|LINESTRING/i.test(JSON.stringify(r.proposition))), rels.map((r) => r.proposition.toleranceM));
  const dNon = [O_L9, O_L13].map(async (o) => (await get(`/${PID}/reseau/relations?objetId=${o}`)).body.relations.length);
  verifier("3. un circuit trop eloigne (L9 a 2,8 m de G2, L13) n'est PAS propose : la tolerance est le seuil", (await Promise.all(dNon)).every((n) => n === 0));
  verifier("3. L6 est de classe A (declaree) : tolerance 1 m = maximum des composantes (0,5 et 1), jamais leur somme (1,5)", rels.find((r) => r.source.objetId === O_L6)!.proposition.toleranceM === 1
    && (rels.find((r) => r.source.objetId === O_L6)!.proposition.composantes as { classeCircuitM: number }).classeCircuitM === 0.5
    && (rels.find((r) => r.source.objetId === O_L6)!.proposition.composantes as { classeInfraM: number }).classeInfraM === 1);
  const comptageProp = (await get(`/${PID}/reseau/comptage`)).body.circuitsLogiques.supportPhysique;
  verifier("3. une PROPOSITION n'est pas un support valide : 4 circuits avec proposition seule, 4 sans support connu, 0 valide", comptageProp.avecSupportValide === 0 && comptageProp.avecPropositionSeulement === 4 && comptageProp.sansSupportConnu === 4, comptageProp);
  const audP = await auditLignes("AssociationsReseau");
  verifier("3. audit : une ligne AssociationsReseau (parametres, bilan, identifiants crees), sans geometrie", audP.length === 1 && (audP[0].after as { bilan: { creees: number } }).bilan.creees === 4 && !/coordinates|LINESTRING/i.test(JSON.stringify(audP[0].after)));
  const apresProp = await etat();
  const diffProp = Object.keys(apresProp).filter((t) => apresProp[t] !== avantProp[t]);
  verifier("3. la proposition n'ecrit que reseau_relations et audit_logs", JSON.stringify(diffProp.sort()) === JSON.stringify(["audit_logs", "reseau_relations"]), diffProp);

  // Validation, refus, et proposition refusee jamais reproposee.
  const rL2 = rels.find((r) => r.source.objetId === O_L2)!;
  const rL2B = rels.find((r) => r.source.objetId === O_L2B)!;
  const rL2T = rels.find((r) => r.source.objetId === O_L2T)!;
  const rL6 = rels.find((r) => r.source.objetId === O_L6)!;
  verifier("3. valider exige une justification de 10 caracteres : 400 sans, 400 trop courte", (await envoyer("post", `/${PID}/reseau/relations/${rL2.id}/valider`, {})).status === 400
    && (await envoyer("post", `/${PID}/reseau/relations/${rL2.id}/valider`, { justification: "court" })).status === 400);
  const v1 = await envoyer("post", `/${PID}/reseau/relations/${rL2.id}/valider`, { justification: "Releve contradictoire avec le concessionnaire" });
  exemples["relation_validee"] = v1.body;
  verifier("3. valider : 200, VALIDEE, auteur et justification conserves, actions offertes = revoquer", v1.status === 200 && v1.body.relation.statut === "VALIDEE" && v1.body.relation.decision.par === "Sekou Gestionnaire"
    && v1.body.relation.decision.justification === "Releve contradictoire avec le concessionnaire" && JSON.stringify(v1.body.relation.actionsPossibles) === JSON.stringify(["revoquer"]), v1.body);
  const rf = await envoyer("post", `/${PID}/reseau/relations/${rL2B.id}/refuser`, { justification: "Autre cable dans la meme gaine, a verifier" });
  verifier("3. refuser : 200, REFUSEE ; une validee ne se refuse pas (409 TRANSITION_INTERDITE)", rf.status === 200 && rf.body.relation.statut === "REFUSEE"
    && (await envoyer("post", `/${PID}/reseau/relations/${rL2.id}/refuser`, { justification: JUSTIF })).body.code === "TRANSITION_INTERDITE");
  const supports1 = (await get(`/${PID}/reseau/comptage`)).body.circuitsLogiques.supportPhysique;
  verifier("3. le comptage suit : 1 support valide (L2), 2 propositions seules (L2 ter, L6), 5 sans support connu (dont L2 bis refusee)", supports1.avecSupportValide === 1 && supports1.avecPropositionSeulement === 2 && supports1.sansSupportConnu === 5, supports1);
  const pr2 = await envoyer("post", `/${PID}/reseau/associations/proposer`, { jeuId: JEU_CIRC });
  const relsApres = (await get(`/${PID}/reseau/relations?limite=50`)).body.relations as { id: string; statut: string }[];
  verifier("3. NOUVELLE proposition : les 4 couples sont deja connus (aucune creation), la proposition REFUSEE n'est pas reproposee, la validee reste validee, aucun doublon",
    pr2.status === 201 && pr2.body.bilan.creees === 0 && pr2.body.bilan.dejaConnues === 4 && relsApres.length === 4 && relsApres.find((r) => r.id === rL2B.id)!.statut === "REFUSEE"
    && relsApres.find((r) => r.id === rL2.id)!.statut === "VALIDEE" && (await compter(`SELECT count(*) n FROM reseau_relations WHERE "typeRelation" = 'PORTE_PAR'`)) === 4, [pr2.body.bilan, relsApres]);
  const rv = await envoyer("post", `/${PID}/reseau/relations/${rL2.id}/revoquer`, { justification: "Trace modifie apres les travaux de 2026" });
  verifier("3. revoquer une validee : REVOQUEE ; la revoquer encore : 409 ; la valider de nouveau (une personne reconsidere) : VALIDEE",
    rv.status === 200 && rv.body.relation.statut === "REVOQUEE" && (await envoyer("post", `/${PID}/reseau/relations/${rL2.id}/revoquer`, { justification: JUSTIF })).status === 409
    && (await envoyer("post", `/${PID}/reseau/relations/${rL2.id}/valider`, { justification: "Confirme apres reexamen sur le terrain" })).body.relation.statut === "VALIDEE");
  const audR = await auditLignes("ReseauRelation");
  verifier("3. audit : valider, refuser, revoquer, valider = 4 lignes (VALIDATE, REJECT, UPDATE, VALIDATE) avec l'ancien statut, sans geometrie",
    audR.length === 4 && JSON.stringify(audR.map((a) => a.action)) === JSON.stringify(["VALIDATE", "REJECT", "UPDATE", "VALIDATE"]) && (audR[2].before as { statut: string }).statut === "VALIDEE" && !/coordinates|LINESTRING/i.test(JSON.stringify(audR)), audR.map((a) => a.action));
  verifier("3. lecteur : ne decide pas (403 sur valider, refuser, revoquer, proposer)",
    (await Promise.all(["valider", "refuser", "revoquer"].map((a) => envoyer("post", `/${PID}/reseau/relations/${rL6.id}/${a}`, { justification: JUSTIF }, T.lecteur)))).every((r) => r.status === 403)
    && (await envoyer("post", `/${PID}/reseau/associations/proposer`, {}, T.lecteur)).status === 403);
  void rL2T;

  // ================================================================ 4. Relations manuelles et coherence
  const m1 = await envoyer("post", `/${PID}/reseau/relations`, { type: "CONTENU_DANS", sourceObjetId: O_V1, cibleObjetId: O_C1, justification: "Vanne visible dans la chambre au releve" });
  exemples["relation_manuelle"] = m1.body;
  verifier("4. relation MANUELLE equipement -> chambre (CONTENU_DANS) : 201, deja VALIDEE (decision humaine), origine MANUELLE, auteur et justification",
    m1.status === 201 && m1.body.relation.statut === "VALIDEE" && m1.body.relation.origine === "MANUELLE" && m1.body.relation.typeRelation === "CONTENU_DANS" && m1.body.relation.decision.par === "Sekou Gestionnaire"
    && m1.body.relation.source.nature === "EQUIPEMENT" && m1.body.relation.cible.nature === "ACTIF_PHYSIQUE", m1.body);
  const dup = await envoyer("post", `/${PID}/reseau/relations`, { type: "CONTENU_DANS", sourceObjetId: O_V1, cibleObjetId: O_C1, justification: "Vanne visible dans la chambre au releve" });
  verifier("4. DOUBLON : le meme couple est refuse (409 RELATION_DEJA_CONNUE avec l'identifiant et le statut), une seule ligne", dup.status === 409 && dup.body.code === "RELATION_DEJA_CONNUE" && dup.body.relationId === m1.body.relation.id && dup.body.statut === "VALIDEE");
  const dupRefusee = await envoyer("post", `/${PID}/reseau/relations`, { type: "PORTE_PAR", sourceObjetId: O_L2B, cibleObjetId: O_G1, justification: "Je pense que la gaine porte ce circuit" });
  verifier("4. une proposition REFUSEE ne se contourne pas par une declaration manuelle du meme couple : 409 RELATION_DEJA_CONNUE (statut REFUSEE)", dupRefusee.status === 409 && dupRefusee.body.statut === "REFUSEE");
  const incoh: [string, string, string, string, number, string][] = [
    ["infrastructure -> circuit (sens inverse)", "PORTE_PAR", O_G1, O_L2, 422, "NATURE_RELATION_INCOMPATIBLE"],
    ["circuit -> chambre (geometrie)", "PORTE_PAR", O_L9, O_C1, 422, "GEOMETRIE_RELATION_INCOMPATIBLE"],
    ["equipement -> gaine lineaire", "CONTENU_DANS", O_V1, O_G1, 422, "GEOMETRIE_RELATION_INCOMPATIBLE"],
    ["objet relie a lui-meme", "PORTE_PAR", O_L9, O_L9, 422, "RELATION_SUR_SOI"],
    ["objet d'un plan d'axes", "PORTE_PAR", O_AXE, O_G1, 422, "NATURE_RELATION_INCOMPATIBLE"],
    ["objet d'un autre projet", "PORTE_PAR", O_AUTRE, O_G1, 404, "OBJET_INTROUVABLE"],
    ["objet inconnu", "PORTE_PAR", O_L9, "999999999", 404, "OBJET_INTROUVABLE"],
  ];
  for (const [nom, type, s, c, statut, code] of incoh) {
    const r = await envoyer("post", `/${PID}/reseau/relations`, { type, sourceObjetId: s, cibleObjetId: c, justification: "Relation de test pour le banc" });
    verifier(`4. refus : ${nom} -> ${statut} ${code}`, r.status === statut && r.body.code === code, [r.status, r.body]);
  }
  verifier("4. BASE : une relation incoherente est refusee meme en SQL direct (natures : 23514, projets differents : 23514, sur soi : 23514, doublon : 23505)",
    (await essaiAnnule((tx) => tx.$executeRawUnsafe(`INSERT INTO reseau_relations (id,"projetId","typeRelation","sourceObjetId","cibleObjetId","origine","creeParId") VALUES (gen_random_uuid()::text,$1,'PORTE_PAR',$2::bigint,$3::bigint,'AUTOMATIQUE',$4)`, PID, O_G1, O_L2, chef.id))) === "23514"
    && (await essaiAnnule((tx) => tx.$executeRawUnsafe(`INSERT INTO reseau_relations (id,"projetId","typeRelation","sourceObjetId","cibleObjetId","origine","creeParId") VALUES (gen_random_uuid()::text,$1,'PORTE_PAR',$2::bigint,$3::bigint,'AUTOMATIQUE',$4)`, PID, O_AUTRE, O_G1, chef.id))) === "23514"
    && (await essaiAnnule((tx) => tx.$executeRawUnsafe(`INSERT INTO reseau_relations (id,"projetId","typeRelation","sourceObjetId","cibleObjetId","origine","creeParId") VALUES (gen_random_uuid()::text,$1,'PORTE_PAR',$2::bigint,$2::bigint,'AUTOMATIQUE',$3)`, PID, O_L9, chef.id))) === "23514"
    && (await essaiAnnule((tx) => tx.$executeRawUnsafe(`INSERT INTO reseau_relations (id,"projetId","typeRelation","sourceObjetId","cibleObjetId","origine","creeParId") VALUES (gen_random_uuid()::text,$1,'PORTE_PAR',$2::bigint,$3::bigint,'AUTOMATIQUE',$4)`, PID, O_L2, O_G1, chef.id))) === "23505", "voir sqlstate");
  const ins = (statut: string, origine: string, s: string, c: string) => essaiAnnule((tx) => tx.$executeRawUnsafe(`INSERT INTO reseau_relations (id,"projetId","typeRelation","sourceObjetId","cibleObjetId","statut","origine","creeParId") VALUES (gen_random_uuid()::text,$1,'PORTE_PAR',$2::bigint,$3::bigint,'${statut}','${origine}',$4)`, PID, s, c, chef.id));
  const sqlstateRel = {
    manuelleProposee: await ins("PROPOSEE", "MANUELLE", O_L9, O_G1),
    decisionSansJustification: await essaiAnnule((tx) => tx.$executeRawUnsafe(`UPDATE reseau_relations SET statut = 'VALIDEE' WHERE id = $1`, rL6.id)),
    suppression: await essaiAnnule((tx) => tx.$executeRawUnsafe(`DELETE FROM reseau_relations`)),
    troncature: await essaiAnnule((tx) => tx.$executeRawUnsafe(`TRUNCATE reseau_relations`)),
    extremite: await essaiAnnule((tx) => tx.$executeRawUnsafe(`UPDATE reseau_relations SET "cibleObjetId" = $1::bigint WHERE id = $2`, O_G1, rL6.id)),
  };
  verifier("4. BASE : une relation MANUELLE encore « proposee » est refusee (23514)", sqlstateRel.manuelleProposee === "23514", sqlstateRel);
  verifier("4. BASE : une decision (statut VALIDEE) sans auteur ni justification est refusee (23514)", sqlstateRel.decisionSansJustification === "23514", sqlstateRel);
  verifier("4. BASE : DELETE et TRUNCATE d'une relation sont refuses (23001)", sqlstateRel.suppression === "23001" && sqlstateRel.troncature === "23001", sqlstateRel);
  verifier("4. BASE : le changement d'extremite d'une relation est refuse (23001)", sqlstateRel.extremite === "23001", sqlstateRel);

  // La nature d'un objet qui porte une relation active ne change pas.
  const chg = await envoyer("put", `${D(O_L2)}/descripteur`, descripteur({ nature: "ACTIF_PHYSIQUE" }));
  verifier("4. la nature d'un circuit qui porte une relation validee ne change pas (409 RELATIONS_ACTIVES) ; la base le refuse aussi (23514)",
    chg.status === 409 && chg.body.code === "RELATIONS_ACTIVES" && (await essaiAnnule(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO reseau_objets_descripteurs ("objetId","jeuId","nature","justification","declareParId") VALUES ($1::bigint,'x','CIRCUIT_LOGIQUE','descripteur explicite du circuit',$2)`, O_L2, chef.id);
      await tx.$executeRawUnsafe(`UPDATE reseau_objets_descripteurs SET nature = NULL, "typeObjet" = NULL WHERE "objetId" = $1::bigint`, O_L2); // meme nature effective : permis
      await tx.$executeRawUnsafe(`UPDATE reseau_objets_descripteurs SET nature = 'ACTIF_PHYSIQUE' WHERE "objetId" = $1::bigint`, O_L2); // change : refuse
    })) === "23514", chg.body);
  const typeOk = await envoyer("put", `${D(O_G1)}/descripteur`, descripteur({ nature: "ACTIF_PHYSIQUE", typeObjet: "GAINE", classePrecision: "B", methodeCollecte: "plan de recolement", statutQualite: "IMPORTE_NON_VERIFIE" }));
  verifier("4. type d'objet controle par nature : GAINE pour une infrastructure physique (201) ; repartition par type du comptage", typeOk.status === 201 && typeOk.body.objet.typeObjet === "GAINE");
  const c1 = (await get(`/${PID}/reseau/comptage`)).body;
  verifier("4. comptage apres descripteur : GAINE compte comme type de l'infrastructure, les autres restent INCONNU ; le support valide est toujours 1 (L2) + aucun melange",
    c1.infrastructuresPhysiques.parType.GAINE === 1 && c1.infrastructuresPhysiques.parType.INCONNU === 3 && c1.circuitsLogiques.supportPhysique.avecSupportValide === 1, c1.infrastructuresPhysiques.parType);

  // ================================================================ 5. Lecture, pagination, filtres
  const liste = await get(`/${PID}/reseau/objets?limite=200`);
  exemples["objets_liste"] = liste.body;
  verifier("5. liste des objets : 13 objets des reseaux (8 circuits + 4 infrastructures + 1 equipement), aucun objet du plan d'axes, aucune geometrie",
    liste.status === 200 && liste.body.objets.length === 13 && liste.body.curseurSuivant === null && !liste.body.objets.some((o: { id: string }) => o.id === O_AXE) && !/"coordinates"|"geometry"|"geometrie"/i.test(JSON.stringify(liste.body)), liste.body.objets.length);
  const vus: string[] = [];
  let curseur: string | null = null;
  let pages = 0;
  do {
    const r = await get(`/${PID}/reseau/objets?limite=3${curseur ? `&curseur=${curseur}` : ""}`);
    vus.push(...r.body.objets.map((o: { id: string }) => o.id));
    curseur = r.body.curseurSuivant;
    pages += 1;
  } while (curseur && pages < 20);
  const attendus = (await sql<{ id: string }>(`SELECT o.id::text AS id FROM projets_voirie_objets o JOIN projets_voirie_jeux j ON j.id = o."jeuId" WHERE j."projetId" = $1 AND j.role IN ('RESEAU_TIERS','AUTRE') ORDER BY o.id`, PID)).map((x) => x.id);
  verifier("5. pagination par curseur (3 par page) : 5 pages, chaque objet une fois, dans l'ordre, sans doublon ni saut", pages === 5 && JSON.stringify(vus) === JSON.stringify(attendus), { pages, vus, attendus });
  verifier("5. curseur forge : 400 CURSEUR_INVALIDE", (await get(`/${PID}/reseau/objets?curseur=zzz`)).body.code === "CURSEUR_INVALIDE"
    && (await get(`/${PID}/reseau/objets?curseur=${Buffer.from(JSON.stringify({ i: "1; DROP TABLE x" })).toString("base64url")}`)).body.code === "CURSEUR_INVALIDE"
    && (await get(`/${PID}/reseau/relations?curseur=zzz`)).body.code === "CURSEUR_INVALIDE");
  const fN = async (q: string) => (await get(`/${PID}/reseau/objets?limite=200&${q}`)).body.objets as { id: string; nature: string; nom: string }[];
  verifier("5. filtres : nature effective (8 circuits, 4 infrastructures, 1 equipement, 0 inconnue), type GAINE, nom, jeu",
    (await fN("nature=CIRCUIT_LOGIQUE")).length === 8 && (await fN("nature=ACTIF_PHYSIQUE")).length === 4 && (await fN("nature=EQUIPEMENT")).length === 1 && (await fN("nature=INCONNUE")).length === 0
    && (await fN("typeObjet=GAINE")).length === 1 && (await fN("q=gaine")).length === 3 && (await fN(`jeuId=${JEU_EQUIP}`)).length === 1 && (await fN("q=%25")).length === 0, "filtres");
  const ficheL2 = await get(D(O_L2));
  exemples["objet_fiche_avec_relations"] = ficheL2.body;
  verifier("5. fiche d'un circuit : sa relation validee vers G1 (role SOURCE), les circuits superposes (2 autres a la trace identique), sans que ce soient des cables distincts",
    ficheL2.body.relations.length === 1 && ficheL2.body.relations[0].role === "SOURCE" && ficheL2.body.relations[0].statut === "VALIDEE" && ficheL2.body.relations[0].cible.objetId === O_G1
    && ficheL2.body.tracePartagee.nbAutresObjets === 2 && /ne sont pas|restent séparés/.test(ficheL2.body.tracePartagee.libelle), ficheL2.body);
  const ficheG1 = await get(D(O_G1));
  verifier("5. fiche de l'infrastructure : la relation vue de la CIBLE (role CIBLE), une gaine a un type et une classe declares",
    ficheG1.body.relations.some((r: { role: string; source: { objetId: string } }) => r.role === "CIBLE" && r.source.objetId === O_L2) && ficheG1.body.objet.typeObjet === "GAINE" && ficheG1.body.objet.qualite.classePrecision === "B");
  // Un descripteur de classe A sur une infrastructure : qualite effective par objet, le jeu garde la classe B.
  const relF = (await get(`/${PID}/reseau/relations?type=CONTENU_DANS`)).body;
  verifier("5. liste des relations filtree par type : une seule CONTENU_DANS", relF.relations.length === 1);

  // ================================================================ 6. Lisibilite : lecteur, quarantaine, jeu retire, projet supprime
  const lectObjets = await get(`/${PID}/reseau/objets?limite=200`, T.lecteur);
  verifier("6. un LECTEUR lit les objets des jeux AUTORISE (13)", lectObjets.status === 200 && lectObjets.body.objets.length === 13);
  const contenu2 = await geojsonMixte([{ nom: "Vanne V1", pt: [50, 2.7] }, { nom: "Vanne V2", pt: [60, 2.7] }]);
  const dep2 = await depot(PID, contenu2, { role: "RESEAU_TIERS", concessionnaireId: CONC2, natureObjets: "EQUIPEMENT" }, "equipements-v2.geojson");
  const JEU_EQUIP_V2: string = dep2.body.jeu.id;
  verifier("6. nouvelle version du jeu d'equipements : deposee en CONTROLE (quarantaine), l'ancienne reste AUTORISE", dep2.status === 201 && dep2.body.jeu.statut === "CONTROLE" && dep2.body.jeu.version === 2);
  const O_V2 = await oid(JEU_EQUIP_V2, "Vanne V2");
  const lectQ = await get(`/${PID}/reseau/objets?limite=200`, T.lecteur);
  const chefQ = await get(`/${PID}/reseau/objets?limite=200`, T.chef);
  verifier("6. QUARANTAINE : le lecteur ne voit AUCUN objet du jeu en controle (13), le gestionnaire en voit 15 (13 + 2 de la version en controle)", lectQ.body.objets.length === 13 && chefQ.body.objets.length === 15
    && !lectQ.body.objets.some((o: { jeuId: string }) => o.jeuId === JEU_EQUIP_V2), [lectQ.body.objets.length, chefQ.body.objets.length]);
  verifier("6. fiche d'un objet en quarantaine : 404 OBJET_INTROUVABLE pour le lecteur (comme un identifiant inconnu), 200 pour le gestionnaire",
    (await get(D(O_V2), T.lecteur)).status === 404 && (await get(D(O_V2), T.lecteur)).body.code === "OBJET_INTROUVABLE" && (await get(D(O_V2), T.chef)).status === 200);
  verifier("6. filtre par jeu en quarantaine : 404 JEU_INTROUVABLE pour le lecteur, 200 pour le gestionnaire", (await get(`/${PID}/reseau/objets?jeuId=${JEU_EQUIP_V2}`, T.lecteur)).body.code === "JEU_INTROUVABLE"
    && (await get(`/${PID}/reseau/objets?jeuId=${JEU_EQUIP_V2}`, T.chef)).status === 200);
  verifier("6. comptage : le lecteur ne peut pas demander la quarantaine (403 QUARANTAINE_RESERVEE) ; par defaut seuls les jeux autorises sont comptes (1 equipement)",
    (await get(`/${PID}/reseau/comptage?inclureNonAutorises=true`, T.lecteur)).body.code === "QUARANTAINE_RESERVEE" && (await get(`/${PID}/reseau/comptage`, T.chef)).body.equipements.nombreDeclare === 1);
  const cq = await get(`/${PID}/reseau/comptage?inclureNonAutorises=true`, T.chef);
  verifier("6. quarantaine incluse : la version en controle REMPLACE l'ancienne pour ce comptage (2 equipements, jamais 3 : le meme reseau n'est pas compte deux fois)",
    cq.body.equipements.nombreDeclare === 2 && cq.body.jeux.filter((j: { concessionnaire: { id: string } | null }) => j.concessionnaire?.id === CONC2).length === 1, cq.body.equipements);
  verifier("6. qualifier un objet d'un jeu en controle est permis (cycle de controle) ; un jeu REMPLACE ou REJETE ne se qualifie plus",
    (await envoyer("put", `${D(O_V2)}/descripteur`, descripteur({ typeObjet: "VANNE" }))).status === 201);
  // Trace des consultations.
  const trace = await sql<{ n: bigint }>(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'ConsultationJeuProjet' AND (after->>'route') = 'reseau'`);
  verifier("6. la lecture des objets de jeux confidentiels est TRACEE (ConsultationJeuProjet, route `reseau`), sans geometrie ni contenu",
    Number(trace[0].n) > 0 && !/coordinates|LINESTRING|Gaine|Fibre/i.test(JSON.stringify(await sql(`SELECT after FROM audit_logs WHERE "entityType" = 'ConsultationJeuProjet' AND (after->>'route') = 'reseau'`))));

  // Autorisation de la version 2 : le jeu REMPLACE n'est plus qualifiable, mais reste lisible aux gestionnaires.
  await envoyer("post", `/${PID}/jeux/${JEU_EQUIP_V2}/autoriser`, { justification: JUSTIF });
  const repl = await envoyer("put", `${D(O_V1)}/descripteur`, descripteur({ typeObjet: "VANNE" }));
  verifier("6. objet d'un jeu REMPLACE : qualification refusee (409 JEU_NON_QUALIFIABLE), mais lisible par un gestionnaire (archive) et masque au lecteur",
    repl.status === 409 && repl.body.code === "JEU_NON_QUALIFIABLE" && (await get(D(O_V1), T.chef)).status === 200 && (await get(D(O_V1), T.lecteur)).status === 404);
  const relSurRemplace = await envoyer("post", `/${PID}/reseau/relations`, { type: "CONTENU_DANS", sourceObjetId: O_V1, cibleObjetId: O_C1, justification: JUSTIF });
  verifier("6. relation depuis un objet d'un jeu REMPLACE : refusee (409 JEU_NON_QUALIFIABLE)", relSurRemplace.status === 409 && relSurRemplace.body.code === "JEU_NON_QUALIFIABLE", relSurRemplace.body);

  // Jeu retire : montre a personne.
  const avantRetrait = (await get(`/${PID}/reseau/relations?limite=50`)).body.relations.length;
  await envoyer("delete", `/${PID}/jeux/${JEU_INFRA}`);
  const apresRetraitChef = await get(`/${PID}/reseau/objets?limite=200`);
  const apresRetraitAdmin = await get(`/${PID}/reseau/objets?limite=200`, T.admin);
  verifier("6. JEU RETIRE : ses objets ne sont montres a personne (gestionnaire, administrateur ni lecteur)",
    apresRetraitChef.body.objets.every((o: { jeuId: string }) => o.jeuId !== JEU_INFRA) && apresRetraitAdmin.body.objets.every((o: { jeuId: string }) => o.jeuId !== JEU_INFRA)
    && (await get(`/${PID}/reseau/objets?limite=200`, T.lecteur)).body.objets.every((o: { jeuId: string }) => o.jeuId !== JEU_INFRA), apresRetraitChef.body.objets.length);
  verifier("6. JEU RETIRE : la fiche d'un de ses objets est 404 pour tous, le filtre par jeu 404, aucune des 5 relations dont un bout est retire n'est listee (RETIRE masque a tous)",
    (await get(D(O_G1), T.admin)).status === 404 && (await get(D(O_G1), T.chef)).status === 404 && (await get(`/${PID}/reseau/objets?jeuId=${JEU_INFRA}`, T.admin)).status === 404
    && (await get(`/${PID}/reseau/relations?limite=50`, T.admin)).body.relations.length === 0 && avantRetrait === 5, [avantRetrait, (await get(`/${PID}/reseau/relations?limite=50`, T.admin)).body.relations.length]);
  verifier("6. JEU RETIRE : une relation dont un bout est retire ne se valide, ne se revoque ni ne se lit (404 RELATION_INTROUVABLE, meme pour l'administrateur)",
    (await envoyer("post", `/${PID}/reseau/relations/${rL2.id}/revoquer`, { justification: JUSTIF }, T.admin)).body.code === "RELATION_INTROUVABLE");
  const cr = (await get(`/${PID}/reseau/comptage`, T.admin)).body;
  verifier("6. JEU RETIRE : le comptage ne le compte plus (0 infrastructure) ; les circuits restent 8 sans support (la cible est retiree)",
    cr.infrastructuresPhysiques.nombreDeclare === 0 && cr.circuitsLogiques.nombreDeclare === 8 && cr.circuitsLogiques.supportPhysique.avecSupportValide === 0 && cr.circuitsLogiques.supportPhysique.sansSupportConnu === 8, cr.circuitsLogiques.supportPhysique);
  verifier("6. JEU RETIRE : les descripteurs et relations restent en base (archive, suppression logique), seule la lecture les masque",
    (await compter(`SELECT count(*) n FROM reseau_relations WHERE "projetId" = $1`, PID)) === 5 && (await compter(`SELECT count(*) n FROM reseau_objets_descripteurs`)) >= 3);

  // Routes de lecture : meme controle territorial et de module que le socle.
  const lectures = [`/${PID}/reseau/objets`, `/${PID}/reseau/objets/${O_L2}`, `/${PID}/reseau/relations`, `/${PID}/reseau/comptage`];
  verifier("6. hors perimetre (compte regional d'une autre region) : MEME 404 PROJET_INTROUVABLE sur les lectures et ecritures, meme avec un corps invalide",
    (await Promise.all([...lectures.map((c) => get(c, T.reg2)), envoyer("put", `${D(O_L2)}/descripteur`, { zz: 1 }, T.reg2), envoyer("post", `/${PID}/reseau/relations`, { zz: 1 }, T.reg2), envoyer("post", `/${PID}/reseau/associations/proposer`, { zz: 1 }, T.reg2),
      envoyer("post", `/${PID}/reseau/relations/${rL2.id}/valider`, { zz: 1 }, T.reg2)])).every((r) => r.status === 404 && r.body.code === "PROJET_INTROUVABLE"));
  verifier("6. sans la cle de module : 403 ; sans jeton : 401", (await Promise.all(lectures.map((c) => get(c, T.sans)))).every((r) => r.status === 403) && (await Promise.all(lectures.map((c) => get(c, null)))).every((r) => r.status === 401));
  verifier("6. compte regional dans son perimetre : lit (200)", (await get(`/${PID}/reseau/comptage`, T.reg1)).status === 200);

  // ================================================================ 7. Extension minimale RC-3, analyse 2D et carte
  // Le jeu d'infrastructures a ete retire : on le redepose (nouvelle version en controle, puis autorisee), avec les memes tracees, pour la suite.
  const redep = await depot(PID, await geojsonMixte(INFRA), { role: "RESEAU_TIERS", concessionnaireId: CONC3, natureObjets: "ACTIF_PHYSIQUE", classePrecision: "B" }, "infra-v2.geojson");
  const JEU_INFRA2: string = redep.body.jeu?.id;
  await envoyer("post", `/${PID}/jeux/${JEU_INFRA2}/autoriser`, { justification: JUSTIF });
  const O_G1b = await oid(JEU_INFRA2, "Gaine G1"), O_G2b = await oid(JEU_INFRA2, "Gaine G2");
  verifier("7. jeu d'infrastructures redepose et autorise (version 2 apres retrait de la version 1)", redep.status === 201 && redep.body.jeu.version === 2);
  // Relations sur la nouvelle version : L2 -> G1 validee (manuelle), L2 bis -> G1 reste sans support valide.
  const rman = await envoyer("post", `/${PID}/reseau/relations`, { type: "PORTE_PAR", sourceObjetId: O_L2, cibleObjetId: O_G1b, justification: "Gaine de la nouvelle version, meme trace" });
  verifier("7. une relation manuelle sur la nouvelle version est possible (201) alors que celle de la version retiree reste archivee", rman.status === 201);

  const a1 = await envoyer("post", `/${PID}/analyses`, {});
  verifier("7. analyse persistee 1 : 201 TERMINEE", a1.status === 201 && a1.body.analyse.statut === "TERMINEE", a1.body);
  const dossier = async (axe: string, type: string, nom: string, pid = PID): Promise<string> =>
    (await sql<{ id: string }>(`SELECT c.id FROM conflits_projet c JOIN projets_voirie_objets o ON o.id = c."objetId" WHERE c."projetId" = $1 AND c.axe = $2 AND c.type = $3::"TypeConflit" AND o.nom = $4 ORDER BY c.id`, pid, axe, type, nom))[0]?.id ?? "";
  const dL2 = await dossier("Axe A", "INTERSECTION_CHAUSSEE", L("L2")), dL2b = await dossier("Axe A", "INTERSECTION_CHAUSSEE", L("L2 bis")), dL6 = await dossier("Axe A", "INTERSECTION_EMPRISE", L("L6"));
  const dG1 = await dossier("Axe A", "INTERSECTION_CHAUSSEE", "Gaine G1"), dG2 = await dossier("Axe A", "INTERSECTION_EMPRISE", "Gaine G2");
  const fL2 = await get(`/${PID}/conflits/${dL2}`), fL2b = await get(`/${PID}/conflits/${dL2b}`), fG1 = await get(`/${PID}/conflits/${dG1}`), fL6 = await get(`/${PID}/conflits/${dL6}`);
  exemples["conflit_cible_circuit"] = fL2.body.conflit;
  exemples["conflit_cible_infrastructure"] = fG1.body.conflit;
  verifier("7. dossier d'une INFRASTRUCTURE PHYSIQUE (gaine G1 en chaussee) : cible INFRASTRUCTURE_PHYSIQUE ; le conflit n'est pas celui d'un circuit",
    !!dG1 && fG1.body.conflit.cible.qualification === "INFRASTRUCTURE_PHYSIQUE" && fG1.body.conflit.cible.nature === "ACTIF_PHYSIQUE" && fG1.body.conflit.cible.supportPhysique === null, fG1.body.conflit.cible);
  verifier("7. dossier d'un circuit PORTE par une infrastructure VALIDEE (L2) : cible CIRCUIT_LOGIQUE_SUR_INFRASTRUCTURE_VALIDEE, 1 support valide ; trois circuits superposes (2 autres a la meme trace)",
    fL2.body.conflit.cible.qualification === "CIRCUIT_LOGIQUE_SUR_INFRASTRUCTURE_VALIDEE" && fL2.body.conflit.cible.supportPhysique.valides === 1 && fL2.body.conflit.cible.tracePartagee === 2, fL2.body.conflit.cible);
  verifier("7. dossier d'un SIMPLE circuit logique (L2 bis, relation refusee sur l'ancienne version, aucune sur la nouvelle) : CIRCUIT_LOGIQUE_SANS_SUPPORT_VALIDE, support inconnu",
    fL2b.body.conflit.cible.qualification === "CIRCUIT_LOGIQUE_SANS_SUPPORT_VALIDE" && fL2b.body.conflit.cible.supportPhysique.valides === 0 && /simple circuit logique/.test(fL2b.body.conflit.cible.libelle), fL2b.body.conflit.cible);
  const liste7 = await get(`/${PID}/conflits?limite=200`);
  verifier("7. liste des dossiers : chaque dossier de reseau porte `cible` ; les couvertures n'en portent pas (null)", liste7.body.conflits.filter((c: { objet: unknown }) => c.objet).every((c: { cible: { qualification: string } | null }) => c.cible && c.cible.qualification)
    && liste7.body.conflits.filter((c: { objet: unknown }) => !c.objet).every((c: { cible: unknown }) => c.cible === null), liste7.body.conflits.length);
  verifier("7. la classification de RC-3 est INCHANGEE : un circuit de classe inconnue est A_INVESTIGUER (PRECISION_INCONNUE) comme avant, la gaine de classe B est POTENTIEL",
    fL2.body.conflit.statut === "A_INVESTIGUER" && JSON.stringify(fL2.body.historique[0].donnees.motifs) === JSON.stringify(["PRECISION_INCONNUE"]) && fG1.body.conflit.statut === "POTENTIEL" && fG1.body.conflit.classePrecision === "B");
  verifier("7. EXTENSION : L6 porte un descripteur de classe A (declaree par une personne) : son dossier est POTENTIEL, classe A, alors que le jeu est de classe inconnue (la classe de l'objet l'emporte)",
    fL6.body.conflit.statut === "POTENTIEL" && fL6.body.conflit.classePrecision === "A", fL6.body.conflit);
  const csv = await request(app).get(`${BASE}/${PID}/conflits/export.csv`).set("Authorization", `Bearer ${T.chef}`);
  const entete = csv.text.replace(/^﻿/, "").split("\r\n")[0].split(";");
  verifier("7. export CSV des dossiers : colonnes natureCible et qualificationCible ajoutees AVANT `cle` (qui reste la derniere), sans geometrie", csv.status === 200 && entete.slice(-3).join(";") === "natureCible;qualificationCible;cle" && /CIRCUIT_LOGIQUE_SANS_SUPPORT_VALIDE/.test(csv.text)
    && /INFRASTRUCTURE_PHYSIQUE/.test(csv.text) && !/coordinates|LINESTRING/i.test(csv.text), entete);

  // Rejeu : une classe modifiee fait marquer le dossier a reexaminer, sans toucher le statut.
  const pc = await envoyer("put", `${D(O_L2)}/descripteur`, descripteur({ classePrecision: "B" }));
  const a2 = await envoyer("post", `/${PID}/analyses`, {});
  const fL2r = await get(`/${PID}/conflits/${dL2}`);
  verifier("7. REJEU : la classe de L2 passe de inconnue a B (declaree) : dossier retrouve, marque a reexaminer (NOUVELLE_VERSION_DONNEES), classe B, statut INCHANGE (A_INVESTIGUER : un calcul ne change aucun statut), historique ajoute",
    pc.status === 201 && a2.status === 201 && fL2r.body.conflit.aReexaminer === true && fL2r.body.conflit.motifReexamen === "NOUVELLE_VERSION_DONNEES" && fL2r.body.conflit.classePrecision === "B"
    && fL2r.body.conflit.statut === "A_INVESTIGUER" && fL2r.body.historique.some((h: { action: string }) => h.action === "REEXAMEN"), fL2r.body.conflit);
  void dG2;

  // Analyse 2D du socle : nature et classe par objet, totaux par nature a la granularite du jeu.
  const an = await get(`/${PID}/analyse`);
  exemples["analyse_2d"] = { natures: an.body.natures, parNature: an.body.reseaux.parNature, conflitsParNature: an.body.conflits.total.parNature, objetsAxeA: an.body.conflits.parAxe.find((a: { axe: string }) => a.axe === "Axe A")?.objets?.slice(0, 4) };
  const objetsA = an.body.conflits.parAxe.find((a: { axe: string }) => a.axe === "Axe A").objets as { nom: string; nature: string; origineNature: string; classePrecision: string | null; qualification: string }[];
  const eL6 = objetsA.find((o) => o.nom === L("L6"))!, eL2 = objetsA.find((o) => o.nom === L("L2"))!, eG1 = objetsA.find((o) => o.nom === "Gaine G1")!;
  verifier("7. ANALYSE 2D : chaque objet liste porte sa nature et sa classe EFFECTIVES (L6 : circuit, classe A de l'objet, conflit potentiel ; L2 : classe B ; gaine : infrastructure physique, classe B du jeu)",
    eL6.nature === "CIRCUIT_LOGIQUE" && eL6.classePrecision === "A" && eL6.qualification === "CONFLIT_POTENTIEL" && eL2.classePrecision === "B" && eG1.nature === "ACTIF_PHYSIQUE" && eG1.origineNature === "JEU" && eG1.classePrecision === "B", [eL6, eL2, eG1]);
  const pn = an.body.reseaux.parNature as { nature: string; nbJeux: number; nbObjets: number; longueurTraceFusionneM: number }[];
  verifier("7. ANALYSE 2D : `reseaux.parNature` separe circuits, infrastructures et equipements (jamais melanges) ; `parType` garde sa semantique du socle (somme par type de reseau, natures melangees : ecart consigne)",
    pn.length === 3 && pn.find((p) => p.nature === "CIRCUIT_LOGIQUE")!.nbObjets === 8 && pn.find((p) => p.nature === "ACTIF_PHYSIQUE")!.nbObjets === 4 && pn.find((p) => p.nature === "EQUIPEMENT")!.nbObjets === 2
    && an.body.reseaux.parType.find((t: { typeReseau: string }) => t.typeReseau === "TELECOM").nbObjets === 12 && an.body.natures.granularite === "JEU", pn);
  verifier("7. ANALYSE 2D : `conflits.total.parNature` : un total par nature declaree, jamais une somme qui les melange", Object.keys(an.body.conflits.total.parNature).sort().join(",") === "ACTIF_PHYSIQUE,CIRCUIT_LOGIQUE,EQUIPEMENT"
    && an.body.conflits.total.parNature.CIRCUIT_LOGIQUE.chausseeM > 0 && an.body.conflits.total.parNature.ACTIF_PHYSIQUE.chausseeM > 0, an.body.conflits.total.parNature);
  const carte = await get(`/${PID}/carte`);
  const features = (carte.body.jeux as { jeuId: string; features: { properties: { nom: string; nature: string; origineNature: string; classePrecision: string | null; origineClasse: string } }[] }[]).flatMap((j) => j.features);
  const fc6 = features.find((f) => f.properties.nom === L("L6"))!.properties, fc13 = features.find((f) => f.properties.nom === L("L13"))!.properties;
  verifier("7. CARTE : chaque feature porte nature et classe EFFECTIVES (L6 : classe A de l'objet ; L13 : nature du jeu, classe inconnue), pour styler circuits et infrastructures",
    carte.status === 200 && fc6.nature === "CIRCUIT_LOGIQUE" && fc6.classePrecision === "A" && fc6.origineClasse === "OBJET" && fc13.nature === "CIRCUIT_LOGIQUE" && fc13.origineNature === "JEU" && fc13.classePrecision === null && fc13.origineClasse === "INCONNUE", [fc6, fc13]);

  // ================================================================ 8. Gardes de volume, cadence, concurrence
  const projetReseau = async (code: string): Promise<string> => {
    const id: string = (await envoyer("post", "", { code, nom: code, regionId: R1 }, T.admin)).body.projet.id;
    await deposerEtAutoriser(id, await geojsonMixte([{ nom: "Circuit c", coords: [[20, 2], [80, 2]] }]), { role: "RESEAU_TIERS", concessionnaireId: CONC1, natureObjets: "CIRCUIT_LOGIQUE" }, "c.geojson", T.admin);
    await deposerEtAutoriser(id, await geojsonMixte([{ nom: "Gaine c", coords: [[20, 2.2], [80, 2.2]] }]), { role: "RESEAU_TIERS", concessionnaireId: CONC3, natureObjets: "ACTIF_PHYSIQUE" }, "g.geojson", T.admin);
    return id;
  };
  const PID_CAD = await projetReseau("RESEAUX-CAD");
  process.env.PROJETS_VOIRIE_ASSOC_INTERVALLE_S = "30";
  const c1r = await envoyer("post", `/${PID_CAD}/reseau/associations/proposer`, {});
  const c2r = await envoyer("post", `/${PID_CAD}/reseau/associations/proposer`, {});
  verifier("8. cadence : une execution toutes les 30 s par projet (429 ASSOCIATION_TROP_FREQUENTE avec Retry-After et retryAfterS) ; la premiere passe",
    c1r.status === 201 && c2r.status === 429 && c2r.body.code === "ASSOCIATION_TROP_FREQUENTE" && Number(c2r.headers["retry-after"]) >= 1 && c2r.body.retryAfterS >= 1, [c1r.status, c2r.status, c2r.body]);
  verifier("8. cadence : un lecteur reste refuse en 403 avant toute cadence", (await envoyer("post", `/${PID_CAD}/reseau/associations/proposer`, {}, T.lecteur)).status === 403);
  process.env.PROJETS_VOIRIE_ASSOC_INTERVALLE_S = "0";
  // Concurrence : deux demandes simultanees sur un projet a cadence : le verrou du projet les serialise, la seconde voit la ligne d'audit de la premiere.
  const PID_CONC = await projetReseau("RESEAUX-CONC");
  process.env.PROJETS_VOIRIE_ASSOC_INTERVALLE_S = "600";
  const simul = await Promise.all([envoyer("post", `/${PID_CONC}/reseau/associations/proposer`, {}), envoyer("post", `/${PID_CONC}/reseau/associations/proposer`, {})]);
  const codes = simul.map((r) => r.status).sort();
  verifier("8. CONCURRENCE : deux propositions simultanees sur un meme projet : une seule passe (201), l'autre est refusee par la cadence (429) ; une seule relation, une seule ligne d'audit",
    JSON.stringify(codes) === JSON.stringify([201, 429]) && (await compter(`SELECT count(*) n FROM reseau_relations WHERE "projetId" = $1`, PID_CONC)) === 1
    && (await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'AssociationsReseau' AND "entityId" = $1`, PID_CONC)) === 1, simul.map((r) => [r.status, r.body.code]));
  process.env.PROJETS_VOIRIE_ASSOC_INTERVALLE_S = "0";

  // Plafond de circuits par execution.
  const PID_VOL: string = (await envoyer("post", "", { code: "RESEAUX-VOL", nom: "Volume", regionId: R1 }, T.admin)).body.projet.id;
  const NB_PLAFOND = 120;
  const jsonCirc = (await sql<{ fc: unknown }>(`
    SELECT json_build_object('type', 'FeatureCollection', 'features', json_agg(json_build_object('type', 'Feature', 'properties', json_build_object('name', 'Circuit ' || i),
      'geometry', ST_AsGeoJSON(ST_Transform(ST_SetSRID(ST_MakeLine(ST_MakePoint($1::float8 + 0, $2::float8 + i * 4.0), ST_MakePoint($1::float8 + 100, $2::float8 + i * 4.0)), 32629), 4326), 9)::json))) AS fc
    FROM generate_series(0, $3::int - 1) i`, O.x, O.y, NB_PLAFOND))[0].fc;
  await deposerEtAutoriser(PID_VOL, Buffer.from(JSON.stringify(jsonCirc)), { role: "RESEAU_TIERS", concessionnaireId: CONC1, natureObjets: "CIRCUIT_LOGIQUE" }, "vol.geojson", T.admin);
  process.env.PROJETS_VOIRIE_ASSOC_CIRCUITS_MAX = "100";
  const trop = await envoyer("post", `/${PID_VOL}/reseau/associations/proposer`, {}, T.admin);
  verifier("8. PLAFOND : 120 circuits pour un maximum de 100 par execution : 422 TROP_DE_CIRCUITS (avec le maximum), rien n'est ecrit", trop.status === 422 && trop.body.code === "TROP_DE_CIRCUITS" && trop.body.maximum === 100
    && (await compter(`SELECT count(*) n FROM reseau_relations WHERE "projetId" = $1`, PID_VOL)) === 0, trop.body);
  delete process.env.PROJETS_VOIRIE_ASSOC_CIRCUITS_MAX;
  const sansInfra = await envoyer("post", `/${PID_VOL}/reseau/associations/proposer`, {}, T.admin);
  verifier("8. aucun candidat (circuits sans infrastructure declaree) : 201, 0 proposition, avertissement « le support reste inconnu », jamais une erreur",
    sansInfra.status === 201 && sansInfra.body.bilan.creees === 0 && sansInfra.body.avertissements.some((a: string) => /support des circuits reste inconnu/.test(a)), sansInfra.body);

  // Classe E : exclue de l'association automatique (pas de faux trace) ; tolerances par classe configurables par requete.
  const PID_E: string = (await envoyer("post", "", { code: "RESEAUX-E", nom: "Classe E", regionId: R1 }, T.admin)).body.projet.id;
  const JEU_E_C = await deposerEtAutoriser(PID_E, await geojsonMixte([{ nom: "Circuit E", coords: [[20, 2], [80, 2]] }, { nom: "Circuit D", coords: [[20, 10], [80, 10]] }]), { role: "RESEAU_TIERS", concessionnaireId: CONC1, natureObjets: "CIRCUIT_LOGIQUE" }, "ce.geojson", T.admin);
  await deposerEtAutoriser(PID_E, await geojsonMixte([{ nom: "Gaine E", coords: [[20, 2.1], [80, 2.1]] }, { nom: "Gaine D", coords: [[20, 13], [80, 13]] }]), { role: "RESEAU_TIERS", concessionnaireId: CONC3, natureObjets: "ACTIF_PHYSIQUE" }, "ge.geojson", T.admin);
  const oE = await oid(JEU_E_C, "Circuit E"), oD = await oid(JEU_E_C, "Circuit D");
  await envoyer("put", `/${PID_E}/reseau/objets/${oE}/descripteur`, descripteur({ classePrecision: "E" }), T.admin);
  await envoyer("put", `/${PID_E}/reseau/objets/${oD}/descripteur`, descripteur({ classePrecision: "D" }), T.admin);
  const pe1 = await envoyer("post", `/${PID_E}/reseau/associations/proposer`, {}, T.admin);
  verifier("8. CLASSE E : le circuit de classe E (a 0,1 m de sa gaine) n'est JAMAIS propose (exclu, compte dans le bilan) ; le circuit de classe D, a 3 m de sa gaine, l'est avec la tolerance par defaut de D (5 m)",
    pe1.body.bilan.classeEExclus.circuits === 1 && pe1.body.bilan.circuitsExamines === 1 && pe1.body.bilan.creees === 1, pe1.body.bilan);
  const pe2 = await envoyer("post", `/${PID_E}/reseau/associations/proposer`, { tolerances: { D: 2.5 } }, T.admin);
  verifier("8. tolerances configurables par requete : avec D = 2,5 m (le maximum avec l'infrastructure de classe inconnue, 2 m), le circuit D (a 3 m) n'est plus candidat", pe2.body.bilan.propositionsCalculees === 0 && pe2.body.parametres.tolerancesParClasseM.D === 2.5, pe2.body.bilan);

  // ================================================================ 9. Projet supprime
  const PID_SUP: string = (await envoyer("post", "", { code: "RESEAUX-SUP", nom: "A supprimer", regionId: R1 }, T.admin)).body.projet.id;
  await envoyer("delete", `/${PID_SUP}`, undefined, T.admin);
  const supp = await Promise.all([
    get(`/${PID_SUP}/reseau/objets`, T.admin), get(`/${PID_SUP}/reseau/relations`, T.admin), get(`/${PID_SUP}/reseau/comptage`, T.admin),
    envoyer("post", `/${PID_SUP}/reseau/associations/proposer`, {}, T.admin), envoyer("post", `/${PID_SUP}/reseau/relations`, { type: "PORTE_PAR", sourceObjetId: "1", cibleObjetId: "2", justification: JUSTIF }, T.admin),
  ]);
  verifier("9. PROJET SUPPRIME : 404 PROJET_INTROUVABLE pour tous, administrateur national compris, sur lectures et ecritures", supp.every((r) => r.status === 404 && r.body.code === "PROJET_INTROUVABLE"), supp.map((r) => [r.status, r.body.code]));

  // ================================================================ 10. Isolation
  const apresTout = await etat();
  const diff = Object.keys(apresTout).filter((t) => apresTout[t] !== avantTout[t]);
  const permis = new Set(["audit_logs", "reseau_objets_descripteurs", "reseau_relations", "projets_voirie", "projets_voirie_jeux", "projets_voirie_objets", "concessionnaires_reseau", "analyses_conflit_projet",
    "conflits_projet", "conflits_projet_historique", "regles_conflit_projet", "users", "regions", "perimetres_comptes"]);
  verifier("10. ISOLATION : seules les tables du module, ses journaux et l'audit changent (aucune ecriture dans le referentiel : troncons, ouvrages, chantiers, ordres...)", diff.every((t) => permis.has(t)), diff.filter((t) => !permis.has(t)));
  verifier("10. ISOLATION : le referentiel officiel est INTACT (empreinte des troncons identique avant et apres)", (await empreinteTroncons()) === empreinteAvant);
  verifier("10. aucune route ne cree d'ordre ni de deplacement : aucun ordre de travaux, chantier ni observation cree", ["ordres_travaux", "chantiers", "ouvrages", "troncons"].every((t) => apresTout[t] === avantTout[t]), ["ordres_travaux", "chantiers"].map((t) => [t, apresTout[t], avantTout[t]]));
  const auditsB1 = await sql<{ t: string; n: bigint }>(`SELECT "entityType" t, count(*) n FROM audit_logs WHERE "entityType" IN ('ReseauObjetDescripteur','ReseauRelation','AssociationsReseau') GROUP BY 1`);
  verifier("10. AUDIT : aucune ligne d'audit du lot ne porte de geometrie ni de coordonnees", (await sql<{ n: bigint }>(`SELECT count(*) n FROM audit_logs WHERE "entityType" IN ('ReseauObjetDescripteur','ReseauRelation','AssociationsReseau') AND (after::text ~* '(coordinates|LINESTRING|POINT\\()' OR before::text ~* '(coordinates|LINESTRING|POINT\\()')`))[0].n === 0n && auditsB1.length === 3, auditsB1);

  const sortie = process.env.RESEAUX_EXEMPLES;
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

// Banc d'integration du WORKFLOW CONCESSIONNAIRE, DES REFERENTS ET DU RECOLEMENT des projets de voirie (lot B3) contre un vrai PostGIS.
// Contrat : docs/projets-voirie/CONTRAT-WORKFLOW.md. Voir tests-integration/README.md. Lancer (DATABASE_URL pointe sur `replay`) :
//   npx tsx tests-integration/workflow-roles.integration.mts
//
// Tout passe par les routes reelles montees comme en production (`createApp`), des jetons signes par des secrets aleatoires, le role, le module, le
// perimetre et les rattachements LUS EN BASE, le SQL reel, les contraintes et declencheurs reels, dans le clone jetable `essai_workflow_pv` (la migration
// 20261101300000 y est appliquee par le banc si `replay` ne la porte pas).
//
// DONNEES 100 % SYNTHETIQUES (voir lib/fixtures-conflits.mts) : segments inventes, construits en metres dans le repere UTM 29N. Aucun nom reel.
//
// Sections : 1 rattachements des referents ; 2 confinement du referent (socle ferme, projets, audit) ; 3 demandes de donnees (envoi enregistre hors application) ;
// 4 taches et separation des taches ; 5 preuves referencees ; 6 recolements (as-built) et validation par un tiers ; 7 cloture d'un conflit (RC-3) appuyee sur
// le recolement ; 8 vues restreintes (jeux, conflits) ; 9 isolation inter-projets et inter-concessionnaires ; 10 observateur, auditeur, agent de terrain,
// utilisateur sans droits, projet retire ; 11 cadence, plafonds, pagination ; 12 base (declencheurs, contraintes) ; 13 aucune ecriture hors du module.
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure } from "./lib/verdict.ts";
import { AXES, R1_BASE, R2 as RESEAU_2, O, constructeurs } from "./lib/fixtures-conflits.mts";

const banc = await ouvrirBancClone("essai_workflow_pv", { migrations: ["20261101300000_workflow_roles_recolement"] });
const { prisma } = await banc.imp("lib/prisma");
const { createApp } = await banc.imp("app");
const { signAccessToken } = await banc.imp("utils/jwt");
const request = (await import("supertest")).default;

// Le delai minimal entre deux analyses d'un projet et la cadence de creation du workflow sont ouverts pour ce banc, qui en enchaine beaucoup ; la section 11
// les remet a leurs valeurs pour les eprouver.
process.env.PROJETS_VOIRIE_ANALYSE_INTERVALLE_S = "0";
process.env.PROJETS_VOIRIE_WORKFLOW_CREATIONS_PAR_MINUTE = "600";
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

/** SQLSTATE d'une erreur de requete brute dans une transaction TOUJOURS annulee ; « ok » si elle passe. */
async function essaiAnnule(f: (tx: typeof prisma) => Promise<unknown>): Promise<string> {
  const ANNULE = new Error("annule");
  try { await prisma.$transaction(async (tx: typeof prisma) => { await f(tx); throw ANNULE; }); return "ok"; } catch (e) {
    if (e === ANNULE) return "ok";
    const meta = (e as { meta?: { code?: string } }).meta;
    const m = String((e as Error).message ?? "").match(/\b(2\d{4})\b/);
    return meta?.code ?? m?.[1] ?? String(e).slice(0, 120);
  }
}

const JUSTIF = "Controle effectue avec le chef de projet";
const UUID0 = "00000000-0000-4000-8000-0000000000aa";
const TABLES_WORKFLOW = ["referents_concessionnaire", "demandes_concessionnaire", "taches_projet_voirie", "recolements_projet_voirie", "preuves_workflow_projet", "workflow_projet_historique"];

async function main() {
  // ================================================================ Fixtures
  const mk = (email: string, nomComplet: string, role: string, modules: string[] = ["projets-voirie"], actif = true) =>
    prisma.user.create({ data: { email, nomComplet, passwordHash: "x", role, modulesAutorises: modules, actif } });
  const admin = await mk("admin@banc.invalid", "Mariama Admin", "ADMIN", []);
  const admin2 = await mk("admin2@banc.invalid", "Ibrahima Admin", "ADMIN", []);
  const chef = await mk("chef@banc.invalid", "Sekou Gestionnaire", "GESTIONNAIRE");
  const chef2 = await mk("chef2@banc.invalid", "Fanta Gestionnaire", "GESTIONNAIRE");
  const agent = await mk("agent@banc.invalid", "Moussa Agent", "INSPECTEUR");
  const agent2 = await mk("agent2@banc.invalid", "Aissatou Agent", "INSPECTEUR");
  const lecteur = await mk("lecteur@banc.invalid", "Lecteur banc", "LECTEUR");
  const refA = await mk("refa@banc.invalid", "Referent A", "LECTEUR");
  const refA2 = await mk("refa2@banc.invalid", "Referent A deux", "LECTEUR");
  const refB = await mk("refb@banc.invalid", "Referent B", "LECTEUR");
  const refAP2 = await mk("refap2@banc.invalid", "Referent A projet deux", "LECTEUR");
  const sansModule = await mk("sans@banc.invalid", "Sans module", "GESTIONNAIRE", ["troncons"]);
  const lecteurSansCle = await mk("lecteursans@banc.invalid", "Lecteur sans cle", "LECTEUR", ["troncons"]);
  const inactif = await mk("inactif@banc.invalid", "Inactif", "LECTEUR", ["projets-voirie"], false);
  const reg2 = await mk("reg2@banc.invalid", "Regional 2", "GESTIONNAIRE");
  const REGION_1 = (await prisma.region.create({ data: { nom: "Region banc 1" } })).id;
  const REGION_2 = (await prisma.region.create({ data: { nom: "Region banc 2" } })).id;
  await sql(`INSERT INTO perimetres_comptes ("userId", "regionId", "accordeParId") VALUES ($1, $2, $3)`, reg2.id, REGION_2, admin.id);
  const jeton = (u: { id: string; role: string; email: string }) => signAccessToken({ sub: u.id, role: u.role, email: u.email });
  const T = {
    admin: jeton(admin), admin2: jeton(admin2), chef: jeton(chef), chef2: jeton(chef2), agent: jeton(agent), agent2: jeton(agent2), lecteur: jeton(lecteur),
    refA: jeton(refA), refA2: jeton(refA2), refB: jeton(refB), refAP2: jeton(refAP2), sans: jeton(sansModule), lecteurSansCle: jeton(lecteurSansCle), reg2: jeton(reg2), inactif: jeton(inactif),
  };

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
  async function deposer(pid: string, fichier: Buffer, champs: Record<string, string | undefined>, nom: string, autoriser = true): Promise<string> {
    const d = await depot(pid, fichier, champs, nom);
    const id: string = d.body.jeu?.id;
    if (!id) throw new Error(`depot refuse : ${JSON.stringify(d.body)}`);
    if (autoriser) {
      const a = await envoyer("post", `/${pid}/jeux/${id}/autoriser`, { justification: JUSTIF });
      if (a.status !== 200) throw new Error(`autorisation refusee : ${JSON.stringify(a.body)}`);
    }
    return id;
  }
  const W = (pid: string) => `/${pid}/workflow`;
  const projet = async (code: string, regionId: number | null = REGION_1): Promise<string> => (await envoyer("post", "", { code, nom: `Voirie ${code}`, ...(regionId ? { regionId } : {}) }, T.admin)).body.projet.id;
  const conc = async (nom: string, typeReseau: string): Promise<string> => (await envoyer("post", "/concessionnaires", { nom, typeReseau })).body.concessionnaire.id;

  console.log("\n== Workflow concessionnaire, referents et recolement : banc PostGIS ==");

  const PID = await projet("WF-1");
  const PID2 = await projet("WF-2");
  const PID_SANS_REGION = await projet("WF-SANS-REGION", null);
  const CA = await conc("Operateur Telecom Banc", "TELECOM");
  const CB = await conc("Societe des Eaux Banc", "EAU_POTABLE");
  await deposer(PID, await kml(AXES), { role: "AXES_TRAVAUX" }, "axes.kml");
  const JEU_A = await deposer(PID, await geojson(R1_BASE), { role: "RESEAU_TIERS", concessionnaireId: CA, classePrecision: "B", precisionHorizontaleM: "3.5" }, "a.geojson");
  const JEU_B = await deposer(PID, await kml(RESEAU_2), { role: "RESEAU_TIERS", concessionnaireId: CB }, "b.kml");
  // Nouvelle version du jeu de A en quarantaine (CONTROLE) : lisible des decideurs seulement.
  const JEU_A2 = await deposer(PID, await geojson(R1_BASE.slice(0, 4)), { role: "RESEAU_TIERS", concessionnaireId: CA, classePrecision: "B", precisionHorizontaleM: "3.5" }, "a2.geojson", false);

  const analyse = await envoyer("post", `/${PID}/analyses`, {});
  const trouver = async (axe: string, type: string, nom: string): Promise<string> => {
    const r = await sql<{ id: string }>(`SELECT c.id FROM conflits_projet c JOIN projets_voirie_objets o ON o.id = c."objetId" WHERE c."projetId" = $1 AND c.axe = $2 AND c.type = $3::"TypeConflit" AND o.nom = $4 ORDER BY c.id`, PID, axe, type, nom);
    return r[0]?.id ?? "";
  };
  const st = (cid: string, corps: unknown, t = T.chef) => envoyer("post", `/${PID}/conflits/${cid}/statut`, corps, t);
  const K_P = await trouver("Axe A", "INTERSECTION_CHAUSSEE", "Fibre-Marqueur P");
  const K_L2 = await trouver("Axe A", "INTERSECTION_CHAUSSEE", "Fibre-Marqueur L2");
  const K_L6 = await trouver("Axe A", "INTERSECTION_EMPRISE", "Fibre-Marqueur L6");
  // Un dossier de A qui restera POTENTIEL (signal interne du systeme) pendant tout le banc.
  const K_X = await trouver("Axe A", "INTERSECTION_CHAUSSEE", "Fibre-Marqueur L2 bis");
  const K_K = await trouver("Axe B", "INTERSECTION_CHAUSSEE", "Fibre-Marqueur K");
  const K_W = await trouver("Axe A", "INTERSECTION_CHAUSSEE", "Eau-Marqueur W");
  verifier("0. fixtures : analyse persistee et dossiers de conflit de A (P, L2, L6, K) et de B (W) trouves", analyse.status === 201 && [K_P, K_L2, K_L6, K_X, K_K, K_W].every((x) => x.length > 0), { analyse: analyse.status, K_P, K_L2, K_L6, K_X, K_K, K_W });

  /** Amene un dossier a TRAITEMENT_DECIDE avec une decision DEPLACER_RESEAU approuvee (proposee par chef, approuvee par chef2). */
  async function deplacementDecide(cid: string): Promise<void> {
    await envoyer("patch", `/${PID}/conflits/${cid}`, { responsableId: chef2.id });
    await envoyer("post", `/${PID}/conflits/${cid}/preuves`, { type: "REFERENCE_DOCUMENT", texte: "Courrier de l'operateur", reference: "Courrier 2026/010" });
    const c = await st(cid, { vers: "CONFIRME", justification: "Passage du cable confirme par courrier" });
    if (c.status !== 200) throw new Error(`CONFIRME refuse : ${JSON.stringify(c.body)}`);
    const d = await envoyer("post", `/${PID}/conflits/${cid}/decisions`, { option: "DEPLACER_RESEAU", justification: "Deplacement du cable propose par l'entreprise", dateDebutPrevue: "2026-12-01", dateFinPrevue: "2026-12-20" });
    const a = await envoyer("post", `/${PID}/conflits/${cid}/decisions/${d.body.decision.id}/approuver`, { motif: "Decision validee par la direction technique" }, T.chef2);
    if (a.status !== 200) throw new Error(`approbation refusee : ${JSON.stringify(a.body)}`);
    const t = await st(cid, { vers: "TRAITEMENT_DECIDE", justification: "Deplacement decide, planning arrete" });
    if (t.status !== 200) throw new Error(`TRAITEMENT_DECIDE refuse : ${JSON.stringify(t.body)}`);
  }
  await deplacementDecide(K_P);
  await deplacementDecide(K_L2);
  await deplacementDecide(K_K);
  // W (concessionnaire B) : seulement confirme. L2 bis (concessionnaire A) reste POTENTIEL : un signal interne.
  await envoyer("patch", `/${PID}/conflits/${K_W}`, { responsableId: chef2.id });
  await st(K_W, { vers: "POTENTIEL", justification: "Classe inconnue : verification demandee" });
  await envoyer("post", `/${PID}/conflits/${K_W}/preuves`, { type: "NOTE", texte: "Cable d'eau vu en tranchee" });
  await st(K_W, { vers: "CONFIRME", justification: "Cable d'eau confirme sur place" });
  const statutConflit = async (id: string) => (await sql<{ statut: string }>(`SELECT statut::text FROM conflits_projet WHERE id = $1`, id))[0].statut;
  verifier("0. fixtures : P, L2 et K en TRAITEMENT_DECIDE (deplacement decide), W confirme, L2 bis et L6 POTENTIEL",
    (await Promise.all([K_P, K_L2, K_K].map(statutConflit))).every((s) => s === "TRAITEMENT_DECIDE") && (await statutConflit(K_W)) === "CONFIRME" && (await statutConflit(K_X)) === "POTENTIEL" && (await statutConflit(K_L6)) === "POTENTIEL");

  // Empreintes de ce que le workflow ne doit JAMAIS toucher.
  const empreinte = async (table: string, tri = "id") => (await sql<{ h: string | null }>(`SELECT md5(string_agg(t::text, '|' ORDER BY ${tri})) h FROM "${table}" t`))[0].h;
  const etat = async (): Promise<Record<string, number>> => {
    const tables = await sql<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND left(table_name, 1) <> '_' ORDER BY 1`);
    const sortie: Record<string, number> = {};
    for (const t of tables) sortie[t.table_name] = await compter(`SELECT count(*) n FROM "${t.table_name}"`);
    return sortie;
  };
  const changees = (a: Record<string, number>, b: Record<string, number>) => Object.keys(b).filter((k) => a[k] !== b[k]).sort();
  const avantTout = await etat();

  // ================================================================ 1. Rattachements des referents (attribut de compte)
  const rat = (pid: string, userId: string, concId: string, motif = "Referent designe par la direction technique", t = T.admin) => envoyer("post", `${W(pid)}/referents`, { userId, concessionnaireId: concId, motif }, t);
  verifier("1. poser un rattachement est reserve a l'ADMIN : GESTIONNAIRE, INSPECTEUR et LECTEUR sont refuses (403 ACTION_NON_AUTORISEE)",
    (await Promise.all([T.chef, T.agent, T.lecteur].map((t) => rat(PID, refA.id, CA, undefined, t)))).every((r) => r.status === 403 && r.body.code === "ACTION_NON_AUTORISEE"));
  const inconnu = await rat(PID, UUID0, CA);
  const pasLecteur = await rat(PID, chef2.id, CA);
  const unAdmin = await rat(PID, admin2.id, CA);
  const inactifR = await rat(PID, inactif.id, CA);
  const sansCle = await rat(PID, lecteurSansCle.id, CA);
  const concInconnu = await rat(PID, refA.id, UUID0);
  const motifCourt = await rat(PID, refA.id, CA, "court");
  verifier("1. compte inconnu : 400 COMPTE_INCONNU ; GESTIONNAIRE, ADMIN ou compte inactif : 422 COMPTE_NON_ELIGIBLE (un referent est un LECTEUR actif) ; sans la cle de module : 422 COMPTE_SANS_MODULE ; concessionnaire inconnu : 404 ; motif court : 422",
    inconnu.status === 400 && inconnu.body.code === "COMPTE_INCONNU" && [pasLecteur, unAdmin, inactifR].every((r) => r.status === 422 && r.body.code === "COMPTE_NON_ELIGIBLE")
    && sansCle.status === 422 && sansCle.body.code === "COMPTE_SANS_MODULE" && concInconnu.status === 404 && concInconnu.body.code === "CONCESSIONNAIRE_INTROUVABLE" && motifCourt.status === 422 && motifCourt.body.code === "JUSTIFICATION_REQUISE",
    [inconnu.body, pasLecteur.body, sansCle.body]);
  verifier("1. aucun rattachement n'a ete ecrit par ces refus", (await compter(`SELECT count(*) n FROM referents_concessionnaire`)) === 0);
  const rA = await rat(PID, refA.id, CA);
  verifier("1. l'ADMIN rattache refA au concessionnaire A du projet 1 : 201, rattachement actif, auteur et motif enregistres", rA.status === 201 && rA.body.rattachement.actif === true
    && rA.body.rattachement.compte.nomComplet === "Referent A" && rA.body.rattachement.concessionnaire.id === CA && rA.body.rattachement.creePar.nomComplet === "Mariama Admin" && /direction technique/.test(rA.body.rattachement.motif), rA.body);
  const doublon = await rat(PID, refA.id, CA);
  verifier("1. un second rattachement actif identique : 409 RATTACHEMENT_DEJA_ACTIF ; la base le refuse aussi (index unique partiel, 23505)",
    doublon.status === 409 && doublon.body.code === "RATTACHEMENT_DEJA_ACTIF"
    && (await essaiAnnule(async (tx) => { await tx.$queryRawUnsafe(`INSERT INTO referents_concessionnaire (id, "userId", "concessionnaireId", "projetId", "creeParId", motif) VALUES (gen_random_uuid()::text, '${refA.id}', '${CA}', '${PID}', '${admin.id}', 'motif assez long pour la base')`); })) === "23505");
  const rA2 = await rat(PID, refA2.id, CA);
  const rB = await rat(PID, refB.id, CB);
  const rAP2 = await rat(PID2, refAP2.id, CA);
  verifier("1. refA2 (A, projet 1), refB (B, projet 1) et refAP2 (A, projet 2) rattaches", [rA2, rB, rAP2].every((r) => r.status === 201));
  const liste = await get(`${W(PID)}/referents`);
  verifier("1. un decideur liste les rattachements du projet (noms, concessionnaires, actifs) ; un referent, un lecteur et un agent n'y ont pas acces (403)",
    liste.status === 200 && liste.body.rattachements.length === 3 && liste.body.rattachements.every((x: { actif: boolean; compte: { nomComplet: string } }) => x.actif && x.compte.nomComplet.length > 0)
    && (await Promise.all([T.refA, T.lecteur, T.agent].map((t) => get(`${W(PID)}/referents`, t)))).every((r) => r.status === 403));
  verifier("1. le rattachement est audite (entite ReferentConcessionnaire, action CREATE, sans geometrie)",
    (await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'ReferentConcessionnaire' AND action = 'CREATE' AND "userId" = $1`, admin.id)) === 4);

  // Revocation : le compte redevient un lecteur ordinaire.
  const revoc = await envoyer("post", `${W(PID)}/referents/${rA2.body.rattachement.id}/revoquer`, { motif: "Le referent a change de poste" }, T.admin);
  verifier("1. revocation par l'ADMIN : 200, rattachement inactif avec motif et auteur, et un avertissement : la cle de module reste (le compte redevient un lecteur ordinaire)",
    revoc.status === 200 && revoc.body.rattachement.actif === false && revoc.body.rattachement.revocation.par.nomComplet === "Mariama Admin" && revoc.body.avertissements.length === 1 && /cl[ée] de module/.test(revoc.body.avertissements[0]), revoc.body);
  verifier("1. une seconde revocation : 409 RATTACHEMENT_DEJA_REVOQUE ; un GESTIONNAIRE ne revoque pas (403) ; un rattachement inconnu ou d'un autre projet : 404 RATTACHEMENT_INTROUVABLE ; motif court : 422",
    (await envoyer("post", `${W(PID)}/referents/${rA2.body.rattachement.id}/revoquer`, { motif: "Deuxieme revocation" }, T.admin)).body.code === "RATTACHEMENT_DEJA_REVOQUE"
    && (await envoyer("post", `${W(PID)}/referents/${rA.body.rattachement.id}/revoquer`, { motif: "Je ne suis pas administrateur" }, T.chef)).status === 403
    && (await envoyer("post", `${W(PID)}/referents/${UUID0}/revoquer`, { motif: "Rattachement inconnu du projet" }, T.admin)).body.code === "RATTACHEMENT_INTROUVABLE"
    && (await envoyer("post", `${W(PID2)}/referents/${rA.body.rattachement.id}/revoquer`, { motif: "Mauvais projet dans l'URL" }, T.admin)).body.code === "RATTACHEMENT_INTROUVABLE"
    && (await envoyer("post", `${W(PID)}/referents/${rA.body.rattachement.id}/revoquer`, { motif: "court" }, T.admin)).status === 422);
  const profilRevoque = await get(`/workflow/mon-profil`, T.refA2);
  verifier("1. apres la revocation, refA2 n'est plus referent : profil LECTEUR sans droit de workflow (403 ACTION_NON_AUTORISEE) ; le socle lui est de nouveau ouvert en lecture",
    profilRevoque.status === 200 && profilRevoque.body.referent === false && profilRevoque.body.profil === "LECTEUR" && profilRevoque.body.droits.length === 0
    && (await get(`${W(PID)}/demandes`, T.refA2)).status === 403 && (await get(`/${PID}/jeux`, T.refA2)).status === 200);
  const rA2bis = await rat(PID, refA2.id, CA, "Referent de nouveau designe apres son retour");
  verifier("1. un nouveau rattachement du meme compte est possible apres la revocation ; l'ancien reste en base (2 lignes dont 1 revoquee)",
    rA2bis.status === 201 && (await compter(`SELECT count(*) n FROM referents_concessionnaire WHERE "userId" = $1`, refA2.id)) === 2 && (await compter(`SELECT count(*) n FROM referents_concessionnaire WHERE "userId" = $1 AND "revoqueLe" IS NULL`, refA2.id)) === 1);

  // ================================================================ 2. Confinement du referent
  const SOCLE: [string, string, unknown?][] = [
    ["get", ``], ["get", `/concessionnaires`], ["get", `/${PID}`], ["get", `/${PID}/jeux`], ["get", `/${PID}/carte`], ["get", `/${PID}/analyse`], ["get", `/${PID}/regles`], ["get", `/${PID}/analyses`],
    ["get", `/${PID}/conflits`], ["get", `/${PID}/conflits/${K_P}`], ["get", `/${PID}/conflits/export.csv`], ["post", `/${PID}/analyses`, {}], ["post", `/${PID}/conflits/${K_P}/statut`, { vers: "INFIRME", justification: JUSTIF }],
    ["post", `/${PID}/conflits/${K_P}/preuves`, { type: "NOTE", texte: "intrusion" }], ["patch", `/${PID}`, { nom: "intrusion" }], ["post", ``, { code: "INTRUSION", nom: "intrusion" }], ["delete", `/${PID}`],
  ];
  const avantSocle = await etat();
  const refus403 = async (t: string) => {
    const rs: { statut: number; code: string }[] = [];
    for (const [m, c, corps] of SOCLE) { const r = await (corps === undefined ? envoyer(m as "post", c, undefined, t) : envoyer(m as "post", c, corps, t)); rs.push({ statut: r.status, code: r.body?.code }); }
    return rs;
  };
  const sRefA = await refus403(T.refA);
  verifier(`2. un referent n'ouvre AUCUNE des ${SOCLE.length} routes du socle et des dossiers de conflit (carte, analyses, conflits, projets, ecritures) : 403 COMPTE_REFERENT_RESTREINT`, sRefA.every((r) => r.statut === 403 && r.code === "COMPTE_REFERENT_RESTREINT"), sRefA.filter((r) => r.statut !== 403));
  verifier("2. ... y compris le referent d'un autre concessionnaire et celui d'un autre projet", (await refus403(T.refB)).every((r) => r.statut === 403) && (await refus403(T.refAP2)).every((r) => r.statut === 403));
  verifier("2. ces refus n'ont rien ecrit ni rien lu d'utile (aucune table n'a change)", changees(avantSocle, await etat()).length === 0);
  const audRef = await request(app).get(`/api/audit?entityType=DemandeConcessionnaire&entityId=x`).set("Authorization", `Bearer ${T.refA}`);
  const audConflit = await request(app).get(`/api/audit?entityType=ConflitProjet&entityId=${K_P}`).set("Authorization", `Bearer ${T.refA}`);
  const audAuditeur = await request(app).get(`/api/audit?entityType=ConflitProjet&entityId=${K_P}`).set("Authorization", `Bearer ${T.lecteur}`);
  verifier("2. l'historique d'audit des entites du module est ferme au referent (403 COMPTE_REFERENT_RESTREINT) et ouvert a l'auditeur (LECTEUR sans rattachement) : c'est sa voie de lecture",
    audRef.status === 403 && audRef.body.code === "COMPTE_REFERENT_RESTREINT" && audConflit.status === 403 && audAuditeur.status === 200 && audAuditeur.body.data.length > 0);

  const profA = await get(`/workflow/mon-profil`, T.refA);
  exemplesMonProfil = profA.body;
  verifier("2. mon-profil du referent : referent, un seul rattachement (projet 1, concessionnaire A), droits = lire le workflow, executer ses taches, ajouter des preuves ; matrice, correspondance du cahier (7 roles) et mention « provisoire »",
    profA.status === 200 && profA.body.referent === true && profA.body.profil === "REFERENT" && profA.body.rattachements.length === 1 && profA.body.rattachements[0].projet.id === PID && profA.body.rattachements[0].concessionnaire.id === CA
    && JSON.stringify([...profA.body.droits].sort()) === JSON.stringify(["preuve.ajouter", "tache.executer", "workflow.lire"]) && profA.body.provisoire === true && profA.body.correspondanceCahier.length === 7 && profA.body.matrice["recolement.valider"].join() === "ADMIN", profA.body);
  const profChef = await get(`/workflow/mon-profil`, T.chef);
  const profAdmin = await get(`/workflow/mon-profil`, T.admin);
  verifier("2. mon-profil d'un gestionnaire et de l'ADMIN : pas referent, droits de la matrice (le gestionnaire ne valide pas un recolement ni ne gere les referents)",
    profChef.body.referent === false && profChef.body.droits.includes("demande.ecrire") && !profChef.body.droits.includes("recolement.valider") && !profChef.body.droits.includes("referent.gerer") && profAdmin.body.droits.length === 9);

  const corpsInconnu = { error: "Projet introuvable", code: "PROJET_INTROUVABLE" };
  const autresProjets = await Promise.all([PID2, PID_SANS_REGION, UUID0].map(async (p) => {
    const lecture = await get(`${W(p)}/demandes`, T.refA);
    const ecriture = await envoyer("post", `${W(p)}/demandes/${UUID0}/preuves`, { champInvalide: true }, T.refA);
    return [lecture, ecriture].map((r) => ({ statut: r.status, corps: JSON.stringify(r.body) }));
  }));
  verifier("2. un projet ou le referent n'est pas rattache, un projet sans region et un projet inconnu : la MEME 404 PROJET_INTROUVABLE, en lecture comme en ecriture, meme avec un corps invalide",
    autresProjets.flat().every((x) => x.statut === 404 && x.corps === JSON.stringify(corpsInconnu)), autresProjets);
  const horsPerimetre = await Promise.all([get(`${W(PID)}/demandes`, T.reg2), envoyer("post", `${W(PID)}/demandes`, { champInvalide: true }, T.reg2)]);
  verifier("2. un compte regional hors perimetre : la meme 404 (controle territorial du socle conserve) ; un compte national lit", horsPerimetre.every((r) => r.status === 404 && JSON.stringify(r.body) === JSON.stringify(corpsInconnu)) && (await get(`${W(PID)}/demandes`)).status === 200);

  // ================================================================ 3. Demandes de donnees (l'envoi se fait HORS application)
  const dem = (pid: string, concId: string, objet: string, extra: object = {}, t = T.chef) => envoyer("post", `${W(pid)}/demandes`, { concessionnaireId: concId, objet, ...extra }, t);
  const statutD = (pid: string, id: string, corps: unknown, t = T.chef) => envoyer("post", `${W(pid)}/demandes/${id}/statut`, corps, t);
  const D1r = await dem(PID, CA, "Plans des reseaux telecom de la voirie", { description: "Tracés et profondeurs", echeance: "2026-12-15" });
  const D1: string = D1r.body.demande?.id;
  exemplesDemande = D1r.body;
  verifier("3. creation d'une demande (gestionnaire) : 201, BROUILLON, concessionnaire A, echeance, createur ; un lecteur, un agent, un referent ne creent pas (403)",
    D1r.status === 201 && D1r.body.demande.statut === "BROUILLON" && D1r.body.demande.concessionnaire.id === CA && D1r.body.demande.echeance === "2026-12-15" && D1r.body.demande.creePar.nomComplet === "Sekou Gestionnaire"
    && (await Promise.all([T.lecteur, T.agent, T.refA].map((t) => dem(PID, CA, "x", {}, t)))).every((r) => r.status === 403), D1r.body);
  verifier("3. concessionnaire inconnu : 404 ; objet vide : 400 ; echeance impossible : 400 ; champ inconnu (creeParId) : 400",
    (await dem(PID, UUID0, "x")).status === 404 && (await dem(PID, CA, "  ")).status === 400 && (await dem(PID, CA, "x", { echeance: "2026-02-30" })).status === 400 && (await dem(PID, CA, "x", { creeParId: admin.id })).status === 400);
  const listeRefA0 = await get(`${W(PID)}/demandes`, T.refA);
  verifier("3. un BROUILLON est interne : le referent A ne le voit ni dans la liste (0) ni par son identifiant (404 DEMANDE_INTROUVABLE), pas plus que le referent B ou un observateur (403)",
    listeRefA0.status === 200 && listeRefA0.body.demandes.length === 0 && (await get(`${W(PID)}/demandes/${D1}`, T.refA)).body.code === "DEMANDE_INTROUVABLE" && (await get(`${W(PID)}/demandes/${D1}`, T.refB)).status === 404
    && (await get(`${W(PID)}/demandes`, T.lecteur)).status === 403);

  const sansCanal = await statutD(PID, D1, { vers: "ENVOYEE", dateEnvoi: "2026-11-05" });
  const futur = await statutD(PID, D1, { vers: "ENVOYEE", canalEnvoi: "courriel", dateEnvoi: "2099-12-31" });
  const trop = await statutD(PID, D1, { vers: "RECUE", dateReception: "2026-11-05" });
  verifier("3. envoi sans canal : 400 ; date d'envoi dans le futur : 422 DATE_INVALIDE ; reception d'un brouillon : 409 TRANSITION_INTERDITE",
    sansCanal.status === 400 && futur.status === 422 && futur.body.code === "DATE_INVALIDE" && trop.status === 409 && trop.body.code === "TRANSITION_INTERDITE");
  const sortiesAvant = await etat();
  const envoi = await statutD(PID, D1, { vers: "ENVOYEE", canalEnvoi: "courriel", dateEnvoi: "2026-11-05", referenceEnvoi: "Courrier AGEROUTE 2026/118", interlocuteur: "Service des reseaux" });
  exemplesDemandeEnvoyee = envoi.body;
  verifier("3. l'ENREGISTREMENT de l'envoi (fait hors application) : 200, ENVOYEE, canal, date, reference, interlocuteur et PERSONNE qui l'a enregistre",
    envoi.status === 200 && envoi.body.demande.statut === "ENVOYEE" && envoi.body.demande.envoi.canal === "courriel" && envoi.body.demande.envoi.dateEnvoi === "2026-11-05" && envoi.body.demande.envoi.reference === "Courrier AGEROUTE 2026/118"
    && envoi.body.demande.envoi.enregistrePar.nomComplet === "Sekou Gestionnaire", envoi.body);
  verifier("3. aucun message n'est emis : aucune table d'integration ou de file de sortie n'a change, seules la demande, son historique et l'audit",
    JSON.stringify(changees(sortiesAvant, await etat())) === JSON.stringify(["audit_logs", "workflow_projet_historique"]), changees(sortiesAvant, await etat()));
  const fRef = await get(`${W(PID)}/demandes/${D1}`, T.refA);
  const fChef = await get(`${W(PID)}/demandes/${D1}`, T.chef);
  verifier("3. envoyee, la demande devient visible du referent A (liste 1, detail 200) mais pas du referent B (liste 0, detail 404) ; le referent ne voit ni le createur, ni la personne qui a enregistre l'envoi, ni l'historique",
    (await get(`${W(PID)}/demandes`, T.refA)).body.demandes.length === 1 && fRef.status === 200 && fRef.body.demande.envoi.dateEnvoi === "2026-11-05" && fRef.body.demande.creePar === null && fRef.body.demande.envoi.enregistrePar === null
    && fRef.body.historique === undefined && (await get(`${W(PID)}/demandes`, T.refB)).body.demandes.length === 0 && (await get(`${W(PID)}/demandes/${D1}`, T.refB)).status === 404, fRef.body);
  verifier("3. un decideur voit l'historique (CREATION puis STATUT, avec le profil de l'acteur) et les transitions possibles (RECUE, CLOTUREE, ANNULEE)",
    fChef.body.historique.length === 2 && fChef.body.historique[0].action === "CREATION" && fChef.body.historique[1].action === "STATUT" && fChef.body.historique[1].acteurProfil === "GESTIONNAIRE"
    && JSON.stringify([...fChef.body.transitionsPossibles].sort()) === JSON.stringify(["ANNULEE", "CLOTUREE", "RECUE"]), fChef.body);
  verifier("3. ENVOYEE vers ENVOYEE ou vers un autre etat absent du graphe : 409 TRANSITION_INTERDITE ; un referent ne change pas le statut d'une demande (403)",
    (await statutD(PID, D1, { vers: "ENVOYEE", canalEnvoi: "x", dateEnvoi: "2026-11-05" })).body.code === "TRANSITION_INTERDITE" && (await statutD(PID, D1, { vers: "CLOTUREE", justification: JUSTIF }, T.refA)).status === 403);

  // Reception : lien facultatif vers un jeu recu ; la reception ne modifie aucun jeu.
  const jeuxAvant = await empreinte("projets_voirie_jeux");
  const objetsAvant = await compter(`SELECT count(*) n FROM projets_voirie_objets`);
  const liensKo = await Promise.all([
    statutD(PID, D1, { vers: "RECUE", dateReception: "2026-11-06", jeuRecuId: JEU_B }),
    statutD(PID, D1, { vers: "RECUE", dateReception: "2026-11-06", jeuRecuId: UUID0 }),
    statutD(PID, D1, { vers: "RECUE", dateReception: "2026-11-04" }),
  ]);
  verifier("3. reception : un jeu d'un AUTRE concessionnaire : 422 LIEN_INVALIDE ; un jeu inconnu : 404 JEU_INTROUVABLE ; une date avant l'envoi : 422 DATE_INVALIDE",
    liensKo[0].status === 422 && liensKo[0].body.code === "LIEN_INVALIDE" && liensKo[1].status === 404 && liensKo[1].body.code === "JEU_INTROUVABLE" && liensKo[2].status === 422 && liensKo[2].body.code === "DATE_INVALIDE", liensKo.map((r) => r.body));
  const recue = await statutD(PID, D1, { vers: "RECUE", dateReception: "2026-11-06", jeuRecuId: JEU_A, note: "Plans recus par courriel" });
  verifier("3. reception avec le jeu autorise de A : 200, RECUE, jeu lie (version et statut), personne qui l'a enregistree", recue.status === 200 && recue.body.demande.statut === "RECUE" && recue.body.demande.reception.jeu.id === JEU_A
    && recue.body.demande.reception.jeu.statut === "AUTORISE" && recue.body.demande.reception.enregistrePar.nomComplet === "Sekou Gestionnaire", recue.body);
  verifier("3. LA RECEPTION NE MODIFIE PAS LE JEU NI LE REFERENTIEL : l'empreinte de la table des jeux et le nombre d'objets sont identiques",
    (await empreinte("projets_voirie_jeux")) === jeuxAvant && (await compter(`SELECT count(*) n FROM projets_voirie_objets`)) === objetsAvant);
  const lieA2 = await envoyer("patch", `${W(PID)}/demandes/${D1}`, { jeuRecuId: JEU_A2 });
  const vueChefA2 = (await get(`${W(PID)}/demandes/${D1}`, T.chef)).body.demande;
  const vueRefA2 = (await get(`${W(PID)}/demandes/${D1}`, T.refA)).body.demande;
  verifier("3. lier ensuite un jeu en CONTROLE (quarantaine) : un decideur le voit ; le referent ne voit pas le jeu (jeu nul, jeuMasque) ; le jeu reste en CONTROLE",
    lieA2.status === 200 && vueChefA2.reception.jeu.id === JEU_A2 && vueRefA2.reception.jeu === null && vueRefA2.reception.jeuMasque === true && (await sql<{ statut: string }>(`SELECT statut::text FROM projets_voirie_jeux WHERE id = $1`, JEU_A2))[0].statut === "CONTROLE");
  await envoyer("delete", `/${PID}/jeux/${JEU_A2}`);
  const vueChefRetire = (await get(`${W(PID)}/demandes/${D1}`, T.chef)).body.demande;
  verifier("3. un jeu RETIRE n'est montre a personne : meme le gestionnaire voit jeu nul et jeuMasque", vueChefRetire.reception.jeu === null && vueChefRetire.reception.jeuMasque === true);
  await envoyer("patch", `${W(PID)}/demandes/${D1}`, { jeuRecuId: JEU_A });
  const modifRecue = await envoyer("patch", `${W(PID)}/demandes/${D1}`, { objet: "Autre objet" });
  verifier("3. une demande recue ne change plus que son lien de jeu : modifier l'objet : 409 STATUT_INCOMPATIBLE ; un jeu inconnu du projet dans le lien : 404", modifRecue.status === 409 && modifRecue.body.code === "STATUT_INCOMPATIBLE"
    && (await envoyer("patch", `${W(PID)}/demandes/${D1}`, { jeuRecuId: UUID0 })).status === 404);
  const clotCourt = await statutD(PID, D1, { vers: "CLOTUREE", justification: "court" });
  const clot = await statutD(PID, D1, { vers: "CLOTUREE", justification: "Plans recus et exploites par le bureau d'etudes" });
  verifier("3. cloture : motif de 10 caracteres (422 sinon) ; 200, CLOTUREE ; le referent voit le type et la date de fin mais ni l'auteur ni le motif", clotCourt.status === 422 && clot.status === 200 && clot.body.demande.fin.type === "CLOTUREE"
    && clot.body.demande.fin.motif !== null && (await get(`${W(PID)}/demandes/${D1}`, T.refA)).body.demande.fin.motif === null && (await get(`${W(PID)}/demandes/${D1}`, T.refA)).body.demande.fin.par === null);
  verifier("3. une demande close ne change plus : statut 409 STATUT_INCOMPATIBLE, modification 409, base : declencheur (23001) ; la ligne reste (suppression : 23001)",
    (await statutD(PID, D1, { vers: "ANNULEE", justification: JUSTIF })).body.code === "STATUT_INCOMPATIBLE" && (await envoyer("patch", `${W(PID)}/demandes/${D1}`, { echeance: "2027-01-01" })).status === 409
    && (await essaiAnnule(async (tx) => { await tx.$queryRawUnsafe(`UPDATE demandes_concessionnaire SET objet = 'modifie' WHERE id = '${D1}'`); })) === "23001"
    && (await essaiAnnule(async (tx) => { await tx.$queryRawUnsafe(`DELETE FROM demandes_concessionnaire WHERE id = '${D1}'`); })) === "23001");

  // Annulation d'un brouillon (jamais vu du referent), annulation apres envoi (vue du referent), demande a B.
  const D2: string = (await dem(PID, CA, "Demande abandonnee avant envoi")).body.demande.id;
  const annule = await statutD(PID, D2, { vers: "ANNULEE", justification: "Doublon avec une demande deja envoyee" });
  verifier("3. annulation d'un brouillon : 200 ; jamais visible du referent (jamais envoyee)", annule.status === 200 && annule.body.demande.statut === "ANNULEE" && (await get(`${W(PID)}/demandes/${D2}`, T.refA)).status === 404);
  const D3: string = (await dem(PID, CA, "Demande annulee apres envoi")).body.demande.id;
  await statutD(PID, D3, { vers: "ENVOYEE", canalEnvoi: "courrier", dateEnvoi: "2026-11-04" });
  await statutD(PID, D3, { vers: "ANNULEE", justification: "Le concessionnaire a fourni les plans par ailleurs" });
  const D3ref = await get(`${W(PID)}/demandes/${D3}`, T.refA);
  verifier("3. annulation apres envoi : le referent voit la demande annulee (elle lui avait ete envoyee)", D3ref.status === 200 && D3ref.body.demande.statut === "ANNULEE");
  const D4: string = (await dem(PID, CB, "Plans du reseau d'eau")).body.demande.id;
  await statutD(PID, D4, { vers: "ENVOYEE", canalEnvoi: "courriel", dateEnvoi: "2026-11-05" });
  const D5: string = (await dem(PID, CA, "Complement de donnees : profondeurs des cables")).body.demande.id;
  await statutD(PID, D5, { vers: "ENVOYEE", canalEnvoi: "remise en main propre", dateEnvoi: "2026-11-06", interlocuteur: "Chef de service" });
  const lA = (await get(`${W(PID)}/demandes?limite=100`, T.refA)).body.demandes.map((d: { id: string }) => d.id).sort();
  const lB = (await get(`${W(PID)}/demandes`, T.refB)).body.demandes.map((d: { id: string }) => d.id);
  verifier("3. ISOLATION INTER-CONCESSIONNAIRES : le referent A voit D1, D3, D5 (a A, envoyees) ; le referent B voit D4 seulement ; aucun ne voit l'autre", JSON.stringify(lA) === JSON.stringify([D1, D3, D5].sort()) && JSON.stringify(lB) === JSON.stringify([D4]));
  const filtre = await get(`${W(PID)}/demandes?statut=ENVOYEE&concessionnaireId=${CA}`);
  const compt = (await get(`${W(PID)}/demandes`)).body.compteurs;
  verifier("3. liste d'un decideur : filtres statut et concessionnaire, compteurs par statut (BROUILLON 0, ENVOYEE 2, CLOTUREE 1, ANNULEE 2)", filtre.status === 200 && filtre.body.demandes.length === 1 && filtre.body.demandes[0].id === D5
    && compt.BROUILLON === 0 && compt.ENVOYEE === 2 && compt.CLOTUREE === 1 && compt.ANNULEE === 2 && compt.RECUE === 0, compt);
  const refCompt = (await get(`${W(PID)}/demandes`, T.refB)).body.compteurs;
  verifier("3. les compteurs du referent ne comptent que ce qu'il voit (B : 1 envoyee, rien d'autre)", refCompt.ENVOYEE === 1 && refCompt.CLOTUREE === 0 && refCompt.ANNULEE === 0 && refCompt.BROUILLON === 0);

  // ================================================================ 4. Taches et separation des taches
  const tache = (corps: object, t = T.chef, pid = PID) => envoyer("post", `${W(pid)}/taches`, { responsableId: agent.id, ...corps }, t);
  const statutT = (id: string, corps: unknown, t = T.chef, pid = PID) => envoyer("post", `${W(pid)}/taches/${id}/statut`, corps, t);
  const T1r = await tache({ titre: "Relever la position du cable apres terrassement", priorite: "HAUTE", echeance: "2026-12-05" });
  const T1: string = T1r.body.tache?.id;
  verifier("4. creation d'une tache (gestionnaire) responsable : l'agent de terrain : 201, A_FAIRE, priorite HAUTE, non partagee ; un lecteur, un agent, un referent ne creent pas (403)",
    T1r.status === 201 && T1r.body.tache.statut === "A_FAIRE" && T1r.body.tache.priorite === "HAUTE" && T1r.body.tache.partagee === false && T1r.body.tache.responsable.nomComplet === "Moussa Agent"
    && (await Promise.all([T.lecteur, T.agent, T.refA].map((t) => tache({ titre: "x" }, t)))).every((r) => r.status === 403), T1r.body);
  const respKo = await Promise.all([
    tache({ titre: "x", responsableId: lecteur.id }), tache({ titre: "x", responsableId: refA.id }), tache({ titre: "x", responsableId: sansModule.id }), tache({ titre: "x", responsableId: inactif.id }), tache({ titre: "x", responsableId: UUID0 }),
  ]);
  verifier("4. responsable : un LECTEUR non rattache, un referent (tache sans concessionnaire), un compte sans la cle ou inactif : 422 RESPONSABLE_NON_HABILITE ; un compte inconnu : 400 RESPONSABLE_INCONNU",
    respKo.slice(0, 4).every((r) => r.status === 422 && r.body.code === "RESPONSABLE_NON_HABILITE") && respKo[4].status === 400 && respKo[4].body.code === "RESPONSABLE_INCONNU", respKo.map((r) => r.body.code));
  const lienKo = await Promise.all([
    tache({ titre: "x", demandeId: D5, concessionnaireId: CB }), tache({ titre: "x", demandeId: D5, conflitId: K_P }), tache({ titre: "x", partagee: true }), tache({ titre: "x", demandeId: UUID0 }), tache({ titre: "x", conflitId: UUID0 }),
    tache({ titre: "x", demandeId: D5, responsableId: refA.id }), tache({ titre: "x", demandeId: D4, responsableId: refA.id, partagee: true }),
  ]);
  verifier("4. liens : concessionnaire different de celui de la demande : 422 CONCESSIONNAIRE_INCOHERENT ; demande ET conflit : 422 LIEN_INVALIDE ; partager sans concessionnaire : 422 ; demande ou conflit inconnus : 404 ; un referent responsable d'une tache non partagee, ou d'un autre concessionnaire : 422",
    lienKo[0].body.code === "CONCESSIONNAIRE_INCOHERENT" && lienKo[1].body.code === "LIEN_INVALIDE" && lienKo[2].body.code === "CONCESSIONNAIRE_INCOHERENT" && lienKo[3].body.code === "DEMANDE_INTROUVABLE" && lienKo[4].body.code === "CONFLIT_INTROUVABLE"
    && lienKo[5].status === 422 && lienKo[6].status === 422 && lienKo[6].body.code === "RESPONSABLE_NON_HABILITE", lienKo.map((r) => [r.status, r.body.code]));
  const TAr = await tache({ titre: "Fournir les profondeurs des cables", demandeId: D5, responsableId: refA.id, partagee: true });
  const TA: string = TAr.body.tache?.id;
  const TAnp = await tache({ titre: "Analyser la reponse (interne)", demandeId: D5, responsableId: chef2.id });
  const TC = await tache({ titre: "Verifier le cable d'eau en tranchee", conflitId: K_W, responsableId: agent.id });
  verifier("4. une tache liee a une demande ou a un conflit prend le concessionnaire du lien (A, B) mais n'est PARTAGEE que si on le demande : TA partagee avec refA ; l'autre non",
    TAr.status === 201 && TAr.body.tache.concessionnaire.id === CA && TAr.body.tache.partagee === true && TAnp.body.tache.concessionnaire.id === CA && TAnp.body.tache.partagee === false && TC.status === 201 && TC.body.tache.concessionnaire.id === CB && TC.body.tache.conflitId === K_W, [TAr.body, TC.body]);
  const tRefA = (await get(`${W(PID)}/taches`, T.refA)).body.taches.map((t: { id: string }) => t.id);
  const tRefB = (await get(`${W(PID)}/taches`, T.refB)).body.taches;
  verifier("4. ISOLATION : le referent A ne voit que la tache partagee de son concessionnaire (TA) ; le referent B rien ; la tache non partagee de A et la tache de B liee a un conflit restent internes",
    JSON.stringify(tRefA) === JSON.stringify([TA]) && tRefB.length === 0 && (await get(`${W(PID)}/taches/${TAnp.body.tache.id}`, T.refA)).body.code === "TACHE_INTROUVABLE" && (await get(`${W(PID)}/taches/${TA}`, T.refB)).body.code === "TACHE_INTROUVABLE");
  const tAgent = (await get(`${W(PID)}/taches`, T.agent)).body.taches.map((t: { id: string }) => t.id).sort();
  verifier("4. l'agent de terrain (qui n'a pas `workflow.lire`) ne lit que SES taches (T1 et TC) ; celles d'un autre agent ou de l'equipe : 404 ; il n'a pas acces aux demandes (403)",
    JSON.stringify(tAgent) === JSON.stringify([T1, TC.body.tache.id].sort()) && (await get(`${W(PID)}/taches/${T1}`, T.agent2)).body.code === "TACHE_INTROUVABLE" && (await get(`${W(PID)}/taches`, T.agent2)).body.taches.length === 0
    && (await get(`${W(PID)}/demandes`, T.agent)).status === 403 && (await get(`${W(PID)}/taches/${T1}`, T.agent)).status === 200);

  // Transitions : le responsable avance sa tache ; annuler et valider exigent le droit de gestion.
  const demarre = await statutT(T1, { vers: "EN_COURS" }, T.agent);
  const termineSans = await statutT(T1, { vers: "TERMINEE" }, T.agent);
  const annulAgent = await statutT(T1, { vers: "ANNULEE", justification: "Je n'ai pas le droit d'annuler" }, T.agent);
  const termineAutre = await statutT(T1, { vers: "TERMINEE", justification: "Releve fait par quelqu'un d'autre" }, T.agent2);
  verifier("4. l'agent responsable demarre sa tache sans justification (200) ; terminer sans justification : 422 ; annuler : 403 ; un autre agent : 404 (tache invisible)",
    demarre.status === 200 && demarre.body.tache.statut === "EN_COURS" && termineSans.status === 422 && termineSans.body.code === "JUSTIFICATION_REQUISE" && annulAgent.status === 403 && termineAutre.status === 404, [demarre.body, annulAgent.body]);
  const termine = await statutT(T1, { vers: "TERMINEE", justification: "Position relevee, ecart de 40 cm avec le plan" }, T.agent);
  verifier("4. terminer (sans validation requise) : 200, TERMINEE, date de fin ; la tache ne change plus (409 STATUT_INCOMPATIBLE, declencheur 23001)",
    termine.status === 200 && termine.body.tache.statut === "TERMINEE" && termine.body.tache.termineLe !== null && (await statutT(T1, { vers: "EN_COURS" })).body.code === "STATUT_INCOMPATIBLE" && (await envoyer("patch", `${W(PID)}/taches/${T1}`, { priorite: "BASSE" })).status === 409
    && (await essaiAnnule(async (tx) => { await tx.$queryRawUnsafe(`UPDATE taches_projet_voirie SET titre = 'modifie' WHERE id = '${T1}'`); })) === "23001");

  // Validation requise : A_VALIDER puis separation des taches.
  const TV1: string = (await tache({ titre: "Controler le reseau deplace", validationRequise: true, responsableId: agent2.id })).body.tache.id;
  await statutT(TV1, { vers: "EN_COURS" }, T.agent2);
  verifier("4. avec validation requise : terminer directement : 409 TRANSITION_INTERDITE ; passer a A_VALIDER avec un compte rendu (justification de 10 caracteres) : 200", (await statutT(TV1, { vers: "TERMINEE", justification: JUSTIF }, T.agent2)).body.code === "TRANSITION_INTERDITE"
    && (await statutT(TV1, { vers: "A_VALIDER", justification: "court" }, T.agent2)).status === 422 && (await statutT(TV1, { vers: "A_VALIDER", justification: "Controle realise, reseau conforme au plan" }, T.agent2)).body.tache?.statut === "A_VALIDER");
  verifier("4. valider exige le droit de gestion : le responsable (agent) ne se valide pas lui-meme (403) ; un gestionnaire tiers valide : 200, TERMINEE",
    (await statutT(TV1, { vers: "TERMINEE", justification: "Je valide mon propre travail" }, T.agent2)).status === 403
    && (await statutT(TV1, { vers: "TERMINEE", justification: "Controle valide par le chef de projet" }, T.chef)).body.tache?.statut === "TERMINEE"
    && (await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'TacheProjetVoirie' AND "entityId" = $1 AND action = 'VALIDATE'`, TV1)) === 1);
  const TV3: string = (await tache({ titre: "Controler l'ouvrage associe", validationRequise: true, responsableId: chef2.id })).body.tache.id;
  await statutT(TV3, { vers: "EN_COURS" }, T.chef2);
  await statutT(TV3, { vers: "A_VALIDER", justification: "Controle de l'ouvrage termine, conforme" }, T.chef2);
  const memeValide = await statutT(TV3, { vers: "TERMINEE", justification: "Je valide mon propre controle" }, T.chef2);
  const memeDero = await statutT(TV3, { vers: "TERMINEE", justification: "Je valide mon propre controle", derogation: "Je suis le seul disponible aujourd'hui" }, T.chef2);
  verifier("4. SEPARATION DES TACHES : le responsable qui a soumis sa tache ne la valide pas (409 SEPARATION_DES_TACHES), meme avec une derogation, tant qu'il n'est pas ADMIN", memeValide.status === 409 && memeValide.body.code === "SEPARATION_DES_TACHES" && memeDero.status === 409);
  const TV4: string = (await tache({ titre: "Verifier le planning des travaux", validationRequise: true, responsableId: admin.id }, T.admin)).body.tache.id;
  await statutT(TV4, { vers: "EN_COURS" }, T.admin);
  await statutT(TV4, { vers: "A_VALIDER", justification: "Planning verifie et confirme" }, T.admin);
  const adminSans = await statutT(TV4, { vers: "TERMINEE", justification: "Planning valide" }, T.admin);
  const adminDero = await statutT(TV4, { vers: "TERMINEE", justification: "Planning valide", derogation: "Aucun autre administrateur disponible ce jour" }, T.admin);
  verifier("4. un ADMIN qui est a la fois responsable et valideur : 409 sans derogation ; avec une derogation motivee : 200, derogation ENREGISTREE dans l'historique et l'audit",
    adminSans.status === 409 && adminDero.status === 200 && (await compter(`SELECT count(*) n FROM workflow_projet_historique WHERE "objetId" = $1 AND donnees->>'derogationSeparation' IS NOT NULL`, TV4)) === 1
    && (await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'TacheProjetVoirie' AND "entityId" = $1 AND after->>'derogationSeparation' IS NOT NULL`, TV4)) === 1);
  // Reaffectation, annulation, tache du referent.
  const T3: string = (await tache({ titre: "Preparer le planning des coupures" })).body.tache.id;
  const reaff0 = await envoyer("patch", `${W(PID)}/taches/${T3}`, { responsableId: agent2.id });
  const reaff = await envoyer("patch", `${W(PID)}/taches/${T3}`, { responsableId: agent2.id, justification: "L'agent 1 est affecte a un autre chantier" });
  const histoT3 = (await get(`${W(PID)}/taches/${T3}`)).body.historique;
  verifier("4. reaffectation : justification exigee (422) ; 200 ; historique MODIFICATION avec l'avant et l'apres du responsable, l'auteur et son profil",
    reaff0.status === 422 && reaff.status === 200 && reaff.body.tache.responsable.nomComplet === "Aissatou Agent" && histoT3.some((h: { action: string; donnees: { avant?: { responsableId: string }; apres?: { responsableId: string } }; acteurProfil: string }) => h.action === "MODIFICATION"
      && h.donnees.avant?.responsableId === agent.id && h.donnees.apres?.responsableId === agent2.id && h.acteurProfil === "GESTIONNAIRE"), histoT3);
  verifier("4. annulation par un gestionnaire avec motif : 200, ANNULEE ; sans motif : 422", (await statutT(T3, { vers: "ANNULEE" })).status === 422 && (await statutT(T3, { vers: "ANNULEE", justification: "Planning reporte a l'annee prochaine" })).body.tache?.statut === "ANNULEE");
  const demRef = await statutT(TA, { vers: "EN_COURS" }, T.refA);
  verifier("4. le referent responsable de sa tache partagee la demarre (200) ; annuler (403), modifier (403), valider (403) lui sont refuses ; le referent B ne peut rien sur elle (404)",
    demRef.status === 200 && (await statutT(TA, { vers: "ANNULEE", justification: JUSTIF }, T.refA)).status === 403 && (await envoyer("patch", `${W(PID)}/taches/${TA}`, { priorite: "BASSE" }, T.refA)).status === 403
    && (await statutT(TA, { vers: "EN_COURS" }, T.refB)).body.code === "TACHE_INTROUVABLE" && (await statutT(TA, { vers: "TERMINEE", justification: JUSTIF }, T.refA2)).status === 403);

  // ================================================================ 5. Preuves referencees (aucun fichier)
  const preuve = (pid: string, cible: string, id: string, corps: object, t = T.chef) => envoyer("post", `${W(pid)}/${cible}/${id}/preuves`, corps, t);
  const SHA = "ab".repeat(32);
  const pRef = await preuve(PID, "demandes", D5, { type: "REPONSE_CONCESSIONNAIRE", texte: "Plan des profondeurs transmis par le concessionnaire", reference: "Courrier OPT 2026/77", nomFichier: "profondeurs.pdf", sha256: SHA.toUpperCase(), tailleOctets: 482113, partagee: false }, T.refA);
  exemplesPreuve = pRef.body;
  verifier("5. le referent A ajoute sa reponse a une demande envoyee de son concessionnaire : 201 ; la preuve est TOUJOURS partagee (meme si partagee: false est envoye) ; l'empreinte est rangee en minuscules ; reference, nom et taille enregistres",
    pRef.status === 201 && pRef.body.preuve.partagee === true && pRef.body.preuve.sha256 === SHA && pRef.body.preuve.reference === "Courrier OPT 2026/77" && pRef.body.preuve.tailleOctets === 482113 && pRef.body.preuve.auteurProfil === "REFERENT", pRef.body);
  const pInterne = await preuve(PID, "demandes", D5, { type: "NOTE", texte: "Note interne : les profondeurs semblent douteuses" });
  const fD5ref = (await get(`${W(PID)}/demandes/${D5}`, T.refA)).body;
  const fD5chef = (await get(`${W(PID)}/demandes/${D5}`, T.chef)).body;
  verifier("5. une note d'un decideur est interne par defaut (partagee: false) : le referent ne voit que la preuve partagee (1), le decideur les deux (2)", pInterne.status === 201 && pInterne.body.preuve.partagee === false && fD5ref.preuves.length === 1 && fD5chef.preuves.length === 2 && fD5ref.preuves[0].auteur.nomComplet === "Referent A");
  verifier("5. le referent A ne peut ajouter ni a la demande de B, ni a un brouillon (404 : elles n'existent pas pour lui), ni un type d'AGEROUTE (COURRIER : 403) ; le referent B ne peut rien ajouter a la demande de A (404) ; un lecteur, un agent : 403",
    (await preuve(PID, "demandes", D4, { type: "NOTE", texte: "intrusion" }, T.refA)).body.code === "DEMANDE_INTROUVABLE" && (await preuve(PID, "demandes", D2, { type: "NOTE", texte: "intrusion" }, T.refA)).status === 404
    && (await preuve(PID, "demandes", D5, { type: "COURRIER", texte: "courrier" }, T.refA)).status === 403 && (await preuve(PID, "demandes", D5, { type: "NOTE", texte: "intrusion" }, T.refB)).body.code === "DEMANDE_INTROUVABLE"
    && (await preuve(PID, "demandes", D5, { type: "NOTE", texte: "x" }, T.lecteur)).status === 403 && (await preuve(PID, "demandes", D5, { type: "NOTE", texte: "x" }, T.agent)).status === 403);
  const pTerm = await preuve(PID, "demandes", D1, { type: "NOTE", texte: "apres cloture" });
  verifier("5. aucune preuve sur un objet terminal (demande close : 409 STATUT_INCOMPATIBLE ; tache terminee : 409)", pTerm.status === 409 && pTerm.body.code === "STATUT_INCOMPATIBLE" && (await preuve(PID, "taches", T1, { type: "NOTE", texte: "apres fin" }, T.agent)).status === 409);
  const TAgent: string = (await tache({ titre: "Releve de terrain complementaire", responsableId: agent.id })).body.tache.id;
  const pAgent = await preuve(PID, "taches", TAgent, { type: "RELEVE_TERRAIN", texte: "Cable releve a 1,2 m de profondeur", reference: "Releve R-31", partagee: true }, T.agent);
  verifier("5. l'agent de terrain ajoute un releve a SA tache : 201, jamais partagee ; pas un courrier (403) ; pas a la tache d'un autre (404) ; il relit sa preuve interne",
    pAgent.status === 201 && pAgent.body.preuve.partagee === false && (await preuve(PID, "taches", TAgent, { type: "COURRIER", texte: "x" }, T.agent)).status === 403 && (await preuve(PID, "taches", TAgent, { type: "NOTE", texte: "x" }, T.agent2)).body.code === "TACHE_INTROUVABLE"
    && (await get(`${W(PID)}/taches/${TAgent}`, T.agent)).body.preuves.length === 1);
  const invalides = await Promise.all([
    preuve(PID, "demandes", D5, { type: "NOTE", texte: "t", reference: "javascript:alert(1)" }), preuve(PID, "demandes", D5, { type: "NOTE", texte: "t", reference: "  JavaScript:x" }), preuve(PID, "demandes", D5, { type: "NOTE", texte: "t", reference: "file:///etc/passwd" }),
    preuve(PID, "demandes", D5, { type: "NOTE", texte: "t", sha256: "pas-un-hash" }), preuve(PID, "demandes", D5, { type: "NOTE", texte: "a\u0000b" }), preuve(PID, "demandes", D5, { type: "NOTE", texte: "t", tailleOctets: -4 }),
    preuve(PID, "demandes", D5, { type: "NOTE", texte: "t", fichier: "AAAA" }),
  ]);
  verifier("5. references executables (javascript:, file:), empreinte invalide, octet NUL, taille negative, champ de fichier : refuses (400 REFERENCE_INVALIDE, CHAMPS_INVALIDES, PARAMETRES_INVALIDES), rien n'est ecrit",
    invalides.slice(0, 3).every((r) => r.status === 400 && r.body.code === "REFERENCE_INVALIDE") && invalides.slice(3).every((r) => r.status === 400), invalides.map((r) => [r.status, r.body.code]));
  const colPreuves = await sql<{ column_name: string; data_type: string }>(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'preuves_workflow_projet' ORDER BY ordinal_position`);
  verifier("5. AUCUN FICHIER STOCKE : la table des preuves ne porte que des references (texte, reference, nom, empreinte, taille declaree), aucune colonne binaire", colPreuves.every((c) => !["bytea", "oid"].includes(c.data_type))
    && JSON.stringify(colPreuves.map((c) => c.column_name)) === JSON.stringify(["id", "projetId", "objetType", "objetId", "type", "texte", "reference", "nomFichier", "sha256", "tailleOctets", "partagee", "auteurId", "auteurProfil", "createdAt"]), colPreuves.map((c) => c.column_name));
  verifier("5. preuves en AJOUT SEUL : modification et suppression refusees par la base (23001) ; une empreinte invalide refusee par la base (23514)",
    (await essaiAnnule(async (tx) => { await tx.$queryRawUnsafe(`UPDATE preuves_workflow_projet SET texte = 'modifie'`); })) === "23001" && (await essaiAnnule(async (tx) => { await tx.$queryRawUnsafe(`DELETE FROM preuves_workflow_projet`); })) === "23001"
    && (await essaiAnnule(async (tx) => { await tx.$queryRawUnsafe(`INSERT INTO preuves_workflow_projet (id, "projetId", "objetType", "objetId", type, texte, sha256, "auteurId", "auteurProfil") VALUES (gen_random_uuid()::text, '${PID}', 'DEMANDE', '${D5}', 'NOTE', 'x', 'zz', '${chef.id}', 'GESTIONNAIRE')`); })) === "23514");
  // Plafond par objet (reglage borne : 10 au minimum).
  process.env.PROJETS_VOIRIE_WORKFLOW_PREUVES_MAX = "10";
  const D6: string = (await dem(PID, CA, "Demande pour le plafond des preuves")).body.demande.id;
  let dernier = 0;
  for (let i = 0; i < 10; i += 1) dernier = (await preuve(PID, "demandes", D6, { type: "NOTE", texte: `note ${i + 1}` })).status;
  const onzieme = await preuve(PID, "demandes", D6, { type: "NOTE", texte: "onzieme" });
  verifier("5. plafond de preuves par element (PROJETS_VOIRIE_WORKFLOW_PREUVES_MAX=10) : 10 acceptees, la onzieme : 422 QUOTA_ATTEINT", dernier === 201 && onzieme.status === 422 && onzieme.body.code === "QUOTA_ATTEINT");
  delete process.env.PROJETS_VOIRIE_WORKFLOW_PREUVES_MAX;
  verifier("5. chaque preuve ecrit une ligne PREUVE dans l'historique et une ligne d'audit sur l'objet (CREATE) avec l'empreinte, sans geometrie",
    (await compter(`SELECT count(*) n FROM workflow_projet_historique WHERE "objetId" = $1 AND action = 'PREUVE'`, D5)) === 2 && (await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'DemandeConcessionnaire' AND "entityId" = $1 AND after->>'sha256' = $2`, D5, SHA)) === 1);

  // ================================================================ 6. Recolements (as-built) et validation par un tiers
  const reco = (corps: object, t = T.chef) => envoyer("post", `${W(PID)}/recolements`, corps, t);
  const statutR = (id: string, corps: unknown, t = T.chef) => envoyer("post", `${W(PID)}/recolements/${id}/statut`, corps, t);
  const elig = await Promise.all([reco({ conflitId: K_X, objet: "Recolement L2 bis" }), reco({ conflitId: K_W, objet: "Recolement W" }), reco({ conflitId: UUID0, objet: "x" }), reco({ objet: "sans lien" }), reco({ conflitId: K_P, jeuId: JEU_B, objet: "x" }), reco({ jeuId: JEU_A2, objet: "jeu retire" }), reco({ jeuId: UUID0, objet: "x" })]);
  verifier("6. eligibilite : un conflit POTENTIEL ou seulement confirme : 422 CONFLIT_NON_ELIGIBLE ; inconnu : 404 ; ni conflit ni jeu : 422 LIEN_INVALIDE ; conflit de A et jeu de B : 422 CONCESSIONNAIRE_INCOHERENT ; jeu retire : 422 ; jeu inconnu : 404",
    elig[0].body.code === "CONFLIT_NON_ELIGIBLE" && elig[1].body.code === "CONFLIT_NON_ELIGIBLE" && elig[2].body.code === "CONFLIT_INTROUVABLE" && elig[3].body.code === "LIEN_INVALIDE" && elig[4].body.code === "CONCESSIONNAIRE_INCOHERENT"
    && elig[5].body.code === "LIEN_INVALIDE" && elig[6].body.code === "JEU_INTROUVABLE", elig.map((r) => [r.status, r.body.code]));
  const R1r = await reco({ conflitId: K_P, objet: "Recolement du cable deplace (axe A, point P)", dateRecolement: "2026-11-06" });
  const R1: string = R1r.body.recolement?.id;
  exemplesRecolement = R1r.body;
  verifier("6. recolement lie a un conflit dont le deplacement est decide : 201, BROUILLON, revision 1, concessionnaire de A (deduit du conflit), conflit lie (statut TRAITEMENT_DECIDE) ; un lecteur, un agent, un referent ne creent pas (403)",
    R1r.status === 201 && R1r.body.recolement.statut === "BROUILLON" && R1r.body.recolement.revision === 1 && R1r.body.recolement.concessionnaire.id === CA && R1r.body.recolement.conflit.statut === "TRAITEMENT_DECIDE"
    && (await Promise.all([T.lecteur, T.agent, T.refA].map((t) => reco({ conflitId: K_P, objet: "x" }, t)))).every((r) => r.status === 403), R1r.body);
  const encours = await reco({ conflitId: K_P, objet: "Doublon" });
  verifier("6. un seul recolement en cours (brouillon ou soumis) par conflit : 409 RECOLEMENT_EN_COURS avec l'identifiant existant ; la base le refuse aussi (index unique partiel, 23505)", encours.status === 409 && encours.body.code === "RECOLEMENT_EN_COURS" && encours.body.recolementId === R1
    && (await essaiAnnule(async (tx) => { await tx.$queryRawUnsafe(`INSERT INTO recolements_projet_voirie (id, "projetId", "conflitId", objet, "creeParId") VALUES (gen_random_uuid()::text, '${PID}', '${K_P}', 'doublon', '${chef.id}')`); })) === "23505");
  verifier("6. un BROUILLON est interne : le referent A ne le voit pas (liste vide, detail 404)", (await get(`${W(PID)}/recolements`, T.refA)).body.recolements.length === 0 && (await get(`${W(PID)}/recolements/${R1}`, T.refA)).body.code === "RECOLEMENT_INTROUVABLE");
  // Historisation avant/apres.
  const m0 = await envoyer("patch", `${W(PID)}/recolements/${R1}`, { constat: "Le cable est desormais a 4 m au nord de l'axe." });
  const m1 = await envoyer("patch", `${W(PID)}/recolements/${R1}`, { constat: "Le cable est desormais a 4 m au nord de l'axe.", ecarts: "Aucun ecart avec le plan decide", justification: "Constat du releve de terrain du 06/11" });
  const m2 = await envoyer("patch", `${W(PID)}/recolements/${R1}`, { constat: "Le cable est desormais a 4,2 m au nord de l'axe (mesure contradictoire).", justification: "Mesure contradictoire avec l'operateur" }, T.chef2);
  const m3 = await envoyer("patch", `${W(PID)}/recolements/${R1}`, { dateRecolement: "2099-12-31", justification: "Date impossible dans le futur" });
  const histoR1 = (await get(`${W(PID)}/recolements/${R1}`)).body.historique as { action: string; justification: string | null; acteur: { nomComplet: string }; acteurProfil: string; donnees: { avant?: Record<string, unknown>; apres?: Record<string, unknown>; revisionApres?: number } }[];
  const mods = histoR1.filter((h) => h.action === "MODIFICATION");
  verifier("6. modifier exige une justification (422 sans) ; chaque modification ecrit l'AVANT et l'APRES des champs changes, l'auteur, son profil, la date et la justification ; la revision augmente (1, 2, 3) ; une date future : 422",
    m0.status === 422 && m0.body.code === "JUSTIFICATION_REQUISE" && m1.status === 200 && m1.body.recolement.revision === 2 && m2.body.recolement.revision === 3 && m3.status === 422 && mods.length === 2
    && mods[0].donnees.avant?.constat === null && mods[0].donnees.avant?.ecarts === null && mods[0].donnees.apres?.ecarts === "Aucun ecart avec le plan decide" && /releve de terrain/.test(mods[0].justification ?? "") && mods[0].acteur.nomComplet === "Sekou Gestionnaire"
    && mods[1].donnees.avant?.constat === "Le cable est desormais a 4 m au nord de l'axe." && /4,2 m/.test(String(mods[1].donnees.apres?.constat)) && mods[1].acteur.nomComplet === "Fanta Gestionnaire" && mods[1].donnees.revisionApres === 3 && histoR1.length === 3, histoR1);
  const RJ = (await reco({ jeuId: JEU_A, objet: "Recolement du plan as-built de A" })).body.recolement.id as string;
  verifier("6. soumettre exige un constat (422 CHAMPS_INCOMPLETS) ; un recolement se lie aussi a un jeu seul (concessionnaire du jeu)", (await statutR(RJ, { vers: "SOUMIS", justification: "Pret pour validation" })).body.code === "CHAMPS_INCOMPLETS"
    && (await sql<{ c: string }>(`SELECT "concessionnaireId" c FROM recolements_projet_voirie WHERE id = $1`, RJ))[0].c === CA);
  const soumis = await statutR(R1, { vers: "SOUMIS", justification: "Recolement pret, preuves a joindre" }, T.chef2);
  verifier("6. soumission par chef2 (autre que le createur) : 200, SOUMIS, soumissionnaire enregistre ; modifier un recolement soumis : 409 STATUT_INCOMPATIBLE", soumis.status === 200 && soumis.body.recolement.statut === "SOUMIS" && soumis.body.recolement.soumission.par.nomComplet === "Fanta Gestionnaire"
    && (await envoyer("patch", `${W(PID)}/recolements/${R1}`, { objet: "x", justification: JUSTIF })).body.code === "STATUT_INCOMPATIBLE");
  const rRef = await get(`${W(PID)}/recolements/${R1}`, T.refA);
  verifier("6. soumis, le recolement est visible du referent A (liste 1, detail 200 sans createur ni historique) et pas du referent B (404) ; le conflit lie est montre (type, axe, statut), pas sa geometrie",
    (await get(`${W(PID)}/recolements`, T.refA)).body.recolements.length === 1 && rRef.status === 200 && rRef.body.recolement.creePar === null && rRef.body.historique === undefined && rRef.body.recolement.conflit.statut === "TRAITEMENT_DECIDE"
    && !/coordinates|geometr|geom/i.test(JSON.stringify(rRef.body)) && (await get(`${W(PID)}/recolements/${R1}`, T.refB)).status === 404 && (await get(`${W(PID)}/recolements`, T.refB)).body.recolements.length === 0);
  // Validation par un tiers.
  const valChef = await statutR(R1, { vers: "VALIDE", justification: "Recolement conforme au constat" }, T.chef2);
  verifier("6. validation : un GESTIONNAIRE n'y est pas habilite par defaut (matrice prudente : ADMIN seul) : 403 ACTION_NON_AUTORISEE ; un referent, un agent, un lecteur : 403", valChef.status === 403 && valChef.body.code === "ACTION_NON_AUTORISEE"
    && (await Promise.all([T.refA, T.agent, T.lecteur].map((t) => statutR(R1, { vers: "VALIDE", justification: JUSTIF }, t)))).every((r) => r.status === 403));
  const sansPreuve = await statutR(R1, { vers: "VALIDE", justification: "Recolement conforme au constat" }, T.admin);
  await preuve(PID, "recolements", R1, { type: "NOTE", texte: "Note de l'ingenieur : mesure contradictoire faite" });
  const noteSeule = await statutR(R1, { vers: "VALIDE", justification: "Recolement conforme au constat" }, T.admin);
  verifier("6. sans preuve, ou avec une simple NOTE : 409 PREUVE_REQUISE", sansPreuve.body.code === "PREUVE_REQUISE" && noteSeule.status === 409 && noteSeule.body.code === "PREUVE_REQUISE");
  const pPlan = await preuve(PID, "recolements", R1, { type: "PLAN_RECOLEMENT", texte: "Plan de recolement transmis par l'operateur", reference: "Plan OPT-REC-014", sha256: "cd".repeat(32) }, T.refA);
  verifier("6. le referent A joint son plan de recolement (preuve partagee) au recolement soumis : 201", pPlan.status === 201 && pPlan.body.preuve.partagee === true && pPlan.body.preuve.type === "PLAN_RECOLEMENT");
  const refConflit = await sql<{ h: string }>(`SELECT md5(c::text) h FROM conflits_projet c WHERE id = $1`, K_P);
  const jeuxAv = await empreinte("projets_voirie_jeux"), tronAv = await empreinte("troncons"), objAv = await empreinte("projets_voirie_objets");
  const avantValidation = await etat();
  const valide = await statutR(R1, { vers: "VALIDE", justification: "Recolement conforme au constat, plan joint et verifie" }, T.admin);
  exemplesRecolementValide = valide.body;
  verifier("6. VALIDATION PAR UN TIERS : l'ADMIN (ni le createur, ni le soumissionnaire, ni l'auteur d'une modification) valide avec une preuve : 200, VALIDE, valideur et motif enregistres ; audit VALIDATE",
    valide.status === 200 && valide.body.recolement.statut === "VALIDE" && valide.body.recolement.decision.par.nomComplet === "Mariama Admin" && /plan joint/.test(valide.body.recolement.decision.motif)
    && (await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'RecolementProjetVoirie' AND "entityId" = $1 AND action = 'VALIDATE'`, R1)) === 1, valide.body);
  verifier("6. VALIDER NE MODIFIE NI LE CONFLIT, NI LES JEUX, NI LES OBJETS, NI LE REFERENTIEL : empreintes identiques ; seules la table des recolements, l'historique et l'audit changent",
    (await sql<{ h: string }>(`SELECT md5(c::text) h FROM conflits_projet c WHERE id = $1`, K_P))[0].h === refConflit[0].h && (await empreinte("projets_voirie_jeux")) === jeuxAv && (await empreinte("troncons")) === tronAv && (await empreinte("projets_voirie_objets")) === objAv
    && JSON.stringify(changees(avantValidation, await etat())) === JSON.stringify(["audit_logs", "workflow_projet_historique"]), changees(avantValidation, await etat()));
  verifier("6. un recolement valide ne change plus : modifier, retirer, rouvrir : 409 STATUT_INCOMPATIBLE ; ajouter une preuve : 409 ; base : declencheur (23001)",
    (await envoyer("patch", `${W(PID)}/recolements/${R1}`, { objet: "x", justification: JUSTIF })).body.code === "STATUT_INCOMPATIBLE" && (await statutR(R1, { vers: "BROUILLON", justification: JUSTIF })).body.code === "STATUT_INCOMPATIBLE"
    && (await preuve(PID, "recolements", R1, { type: "NOTE", texte: "apres validation" })).status === 409 && (await essaiAnnule(async (tx) => { await tx.$queryRawUnsafe(`UPDATE recolements_projet_voirie SET objet = 'x' WHERE id = '${R1}'`); })) === "23001");
  // Separation des taches : l'ADMIN createur et soumissionnaire ne valide pas son propre recolement sans derogation.
  const R2: string = (await reco({ conflitId: K_L2, objet: "Recolement du cable deplace (axe A, circuit L2)", constat: "Cable deplace de 5 m, conforme." }, T.admin)).body.recolement.id;
  await statutR(R2, { vers: "SOUMIS", justification: "Recolement du circuit L2 pret" }, T.admin);
  await preuve(PID, "recolements", R2, { type: "REFERENCE_DOCUMENT", texte: "Rapport de recolement du bureau de controle", reference: "Rapport BC-2026-33" }, T.admin);
  const meme = await statutR(R2, { vers: "VALIDE", justification: "Je valide mon propre recolement" }, T.admin);
  const memeCourt = await statutR(R2, { vers: "VALIDE", justification: "Je valide mon propre recolement", derogation: "court" }, T.admin);
  verifier("6. SEPARATION DES TACHES : l'ADMIN qui a cree ET soumis le recolement ne le valide pas (409 SEPARATION_DES_TACHES) ; une derogation trop courte ne suffit pas ; un GESTIONNAIRE ne deroge pas",
    meme.status === 409 && meme.body.code === "SEPARATION_DES_TACHES" && memeCourt.status === 409 && (await statutR(R2, { vers: "VALIDE", justification: JUSTIF, derogation: "Aucun autre valideur n'est disponible ce mois" }, T.chef)).status === 403);
  const direct = await sql<{ id: string }>(`SELECT id FROM recolements_projet_voirie WHERE id = $1 AND statut = 'SOUMIS'`, R2);
  verifier("6. ... et la BASE le refuse aussi : valider par le createur ou le soumissionnaire sans derogation viole la contrainte (23514), avec une derogation motivee elle passe",
    direct.length === 1 && (await essaiAnnule(async (tx) => { await tx.$queryRawUnsafe(`UPDATE recolements_projet_voirie SET statut = 'VALIDE', "decideParId" = "creeParId", "decideLe" = now(), "motifDecision" = 'motif assez long pour la base' WHERE id = '${R2}'`); })) === "23514"
    && (await essaiAnnule(async (tx) => { await tx.$queryRawUnsafe(`UPDATE recolements_projet_voirie SET statut = 'VALIDE', "decideParId" = "creeParId", "decideLe" = now(), "motifDecision" = 'motif assez long pour la base', "derogationSeparation" = 'derogation assez longue' WHERE id = '${R2}'`); })) === "ok");
  const dero = await statutR(R2, { vers: "VALIDE", justification: "Recolement valide par derogation motivee", derogation: "Aucun autre valideur n'est disponible ce mois" }, T.admin);
  verifier("6. avec une derogation motivee d'un ADMIN : 200, VALIDE, derogation enregistree sur le recolement, dans l'historique et dans l'audit (memePersonne)", dero.status === 200 && dero.body.recolement.decision.derogationSeparation === "Aucun autre valideur n'est disponible ce mois"
    && (await compter(`SELECT count(*) n FROM workflow_projet_historique WHERE "objetId" = $1 AND action = 'STATUT' AND donnees->>'derogationSeparation' IS NOT NULL`, R2)) === 1
    && (await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'RecolementProjetVoirie' AND "entityId" = $1 AND after->>'derogationSeparation' IS NOT NULL AND after->>'memePersonne' = 'true'`, R2)) === 1, dero.body);
  // Matrice configurable : la validation ouverte aux gestionnaires.
  const RJcreateur = RJ;
  await envoyer("patch", `${W(PID)}/recolements/${RJcreateur}`, { constat: "Le plan as-built de A est conforme au deplacement decide.", justification: "Constat apres lecture du plan as-built" });
  await statutR(RJcreateur, { vers: "SOUMIS", justification: "Plan as-built pret pour validation" });
  await preuve(PID, "recolements", RJcreateur, { type: "PLAN_RECOLEMENT", texte: "Plan as-built de A, version finale", reference: "Plan OPT-AB-03" }, T.refA);
  process.env.PROJETS_VOIRIE_WORKFLOW_MATRICE = JSON.stringify({ "recolement.valider": ["GESTIONNAIRE"] });
  const parCreateur = await statutR(RJcreateur, { vers: "VALIDE", justification: "Validation par le createur du recolement" }, T.chef);
  const parTiers = await statutR(RJcreateur, { vers: "VALIDE", justification: "Plan as-built conforme, valide par le tiers" }, T.chef2);
  delete process.env.PROJETS_VOIRIE_WORKFLOW_MATRICE;
  verifier("6. CONFIGURATION : avec PROJETS_VOIRIE_WORKFLOW_MATRICE ouvrant la validation aux gestionnaires, un tiers (chef2) valide (200) mais le createur reste refuse par la separation des taches (409) ; sans la variable, la matrice par defaut revient",
    parCreateur.status === 409 && parCreateur.body.code === "SEPARATION_DES_TACHES" && parTiers.status === 200 && parTiers.body.recolement.statut === "VALIDE" && (await statutR(R2, { vers: "VALIDE", justification: JUSTIF }, T.chef2)).status !== 200);
  // Rejet, reouverture, nouvelle soumission.
  const RB = (await envoyer("post", `${W(PID)}/recolements`, { jeuId: JEU_B, objet: "Recolement du plan as-built de B", constat: "Reseau d'eau conforme (premiere version)." })).body.recolement.id as string;
  await statutR(RB, { vers: "SOUMIS", justification: "Premiere soumission du plan de B" });
  const rejet = await statutR(RB, { vers: "REJETE", justification: "Le plan joint est illisible, a refaire" }, T.admin);
  const vueRejetB = (await get(`${W(PID)}/recolements/${RB}`, T.refB)).body.recolement;
  verifier("6. rejet par l'ADMIN avec motif : 200, REJETE ; le referent B voit le recolement rejete (sans le motif interne ni le nom du valideur) ; le referent A ne le voit pas",
    rejet.status === 200 && rejet.body.recolement.statut === "REJETE" && vueRejetB.statut === "REJETE" && vueRejetB.decision.motif === null && vueRejetB.decision.par === null && (await get(`${W(PID)}/recolements/${RB}`, T.refA)).status === 404);
  const rouvre = await statutR(RB, { vers: "BROUILLON", justification: "Reouverture : le concessionnaire fournit un nouveau plan" });
  verifier("6. reouverture (REJETE vers BROUILLON) : 200, decision effacee de la ligne (conservee dans l'historique), recolement de nouveau modifiable et de nouveau INTERNE (le referent B ne le voit plus)", rouvre.status === 200 && rouvre.body.recolement.decision === null
    && (await envoyer("patch", `${W(PID)}/recolements/${RB}`, { constat: "Reseau d'eau conforme (deuxieme version, plan lisible).", justification: "Nouveau constat apres plan lisible" })).status === 200
    && (await compter(`SELECT count(*) n FROM workflow_projet_historique WHERE "objetId" = $1 AND action = 'STATUT'`, RB)) === 3
    && (await get(`${W(PID)}/recolements/${RB}`, T.refB)).status === 404);
  verifier("6. un seul recolement en cours par jeu : 409 RECOLEMENT_EN_COURS ; apres validation d'un autre recolement du meme jeu la place est libre", (await reco({ jeuId: JEU_B, objet: "Doublon sur le jeu de B" })).body.code === "RECOLEMENT_EN_COURS"
    && (await reco({ jeuId: JEU_A, objet: "Nouveau recolement du jeu de A apres validation du precedent" })).status === 201);

  // ================================================================ 7. Cloture d'un conflit (RC-3) appuyee sur le recolement
  const ADMINC = T.admin;
  const clo = (cid: string, corps: object, t = ADMINC) => st(cid, { vers: "CLOTURE", justification: "Travaux de deplacement termines et constates sur place", ...corps }, t);
  const sansRien = await clo(K_P, {});
  verifier("7. comportement de RC-3 inchange : cloture d'un dossier a deplacement decide sans mention ni recolement : 422 MENTION_RECOLEMENT_REQUISE", sansRien.status === 422 && sansRien.body.code === "MENTION_RECOLEMENT_REQUISE");
  const reco2 = await Promise.all([
    st(K_P, { vers: "INFIRME", justification: JUSTIF, recolementId: R1 }, ADMINC), clo(K_P, { recolementId: UUID0 }), clo(K_P, { recolementId: R2 }), clo(K_P, { recolementId: "pas-un-uuid" }),
  ]);
  verifier("7. recolementId : hors cloture : 422 ; recolement inconnu : 404 RECOLEMENT_INTROUVABLE ; recolement d'un AUTRE dossier : 404 ; pas un UUID : 400", reco2[0].status === 422 && reco2[1].body.code === "RECOLEMENT_INTROUVABLE" && reco2[2].body.code === "RECOLEMENT_INTROUVABLE" && reco2[3].status === 400, reco2.map((r) => [r.status, r.body.code]));
  const R2bis: string = (await reco({ conflitId: K_L2, objet: "Deuxieme recolement du circuit L2" })).body.recolement?.id;
  const nonValide = await clo(K_L2, { recolementId: R2bis });
  verifier("7. un recolement NON VALIDE designe : 409 RECOLEMENT_NON_VALIDE (le dossier n'est pas clos)", R2bis !== undefined && nonValide.status === 409 && nonValide.body.code === "RECOLEMENT_NON_VALIDE" && (await statutConflit(K_L2)) === "TRAITEMENT_DECIDE");
  const clos = await clo(K_P, { recolementId: R1 });
  const histoClos = (await get(`/${PID}/conflits/${K_P}`, T.admin)).body.historique.filter((h: { nouveauStatut: string }) => h.nouveauStatut === "CLOTURE")[0];
  verifier("7. cloture avec un RECOLEMENT VALIDE du dossier : 200, CLOTURE ; la mention « a valider » n'est plus necessaire ; l'historique de la cloture porte recolementId ; l'audit aussi",
    clos.status === 200 && clos.body.conflit.statut === "CLOTURE" && histoClos.donnees.recolementId === R1 && histoClos.donnees.recolementAValider === undefined
    && (await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'ConflitProjet' AND "entityId" = $1 AND after->>'recolementId' = $2`, K_P, R1)) === 1, histoClos);
  const mentionSeule = await clo(K_K, { recolementAValider: true });
  verifier("7. la mention seule reste valable (RC-3, reglage « obligatoire » desactive par defaut) : cloture de K avec recolementAValider : 200", mentionSeule.status === 200 && mentionSeule.body.conflit.statut === "CLOTURE");
  // Reglage « recolement obligatoire » : un dossier a deplacement decide SANS recolement valide ne se clot plus avec la seule mention.
  await deplacementDecide(K_L6);
  process.env.PROJETS_VOIRIE_RECOLEMENT_OBLIGATOIRE = "1";
  const oblig = await clo(K_L6, { recolementAValider: true });
  const obligAuto = await clo(K_L2, { recolementAValider: true });
  delete process.env.PROJETS_VOIRIE_RECOLEMENT_OBLIGATOIRE;
  const histoL2 = (await get(`/${PID}/conflits/${K_L2}`, T.admin)).body.historique.filter((h: { nouveauStatut: string }) => h.nouveauStatut === "CLOTURE")[0];
  verifier("7. reglage PROJETS_VOIRIE_RECOLEMENT_OBLIGATOIRE=1 : sans recolement valide la mention ne suffit plus (L6 : 409 RECOLEMENT_NON_VALIDE, dossier non clos) ; avec un recolement valide au dossier (L2 : R2, valide par derogation), il est retenu SANS recolementId et cite dans l'historique",
    oblig.status === 409 && oblig.body.code === "RECOLEMENT_NON_VALIDE" && (await statutConflit(K_L6)) === "TRAITEMENT_DECIDE" && obligAuto.status === 200 && histoL2?.donnees?.recolementId === R2 && histoL2.donnees.recolementAValider === undefined, { oblig: oblig.body, obligAuto: obligAuto.body, histoL2 });
  verifier("7. un recolement peut etre fait apres la cloture (dossier clos avec la mention : K est CLOTURE) : 201",
    (await reco({ conflitId: K_K, objet: "Recolement apres cloture avec mention" })).status === 201);

  // ================================================================ 8. Vues restreintes (jeux, conflits)
  const jeuxRefA = await get(`${W(PID)}/jeux`, T.refA);
  const jeuxRefB = await get(`${W(PID)}/jeux`, T.refB);
  const cles = jeuxRefA.body.jeux[0] ? Object.keys(jeuxRefA.body.jeux[0]).sort() : [];
  verifier("8. jeux : le referent A ne voit que le jeu AUTORISE de A ; B que le sien ; ni le jeu en controle ou retire de A, ni l'axe, ni le jeu de l'autre ; metadonnees seules (pas d'empreinte, de resume, d'auteur, de geometrie)",
    jeuxRefA.status === 200 && jeuxRefA.body.jeux.length === 1 && jeuxRefA.body.jeux[0].id === JEU_A && jeuxRefB.body.jeux.length === 1 && jeuxRefB.body.jeux[0].id === JEU_B
    && !cles.some((k) => ["sha256", "resume", "creePar", "avertissements", "remplaceId", "confidentialite", "geom", "geometrie"].includes(k)), cles);
  const JEU_A3 = await deposer(PID, await geojson(R1_BASE.slice(0, 3)), { role: "RESEAU_TIERS", concessionnaireId: CA, classePrecision: "B", precisionHorizontaleM: "3.5" }, "a3.geojson", false);
  const jeuxChef = (await get(`${W(PID)}/jeux`, T.chef)).body.jeux.map((j: { id: string }) => j.id);
  const jeuxRefAbis = (await get(`${W(PID)}/jeux`, T.refA)).body.jeux.map((j: { id: string }) => j.id);
  verifier("8. un nouveau depot de A en quarantaine (CONTROLE) : visible du gestionnaire (4 jeux : axes, A, B, A3 ; jamais le retire), invisible du referent A (reste [A])", jeuxChef.includes(JEU_A3) && jeuxChef.includes(JEU_A) && jeuxChef.includes(JEU_B) && !jeuxChef.includes(JEU_A2) && jeuxChef.length === 4 && JSON.stringify(jeuxRefAbis) === JSON.stringify([JEU_A]));
  const cvA = await get(`${W(PID)}/conflits?limite=100`, T.refA);
  const cvB = await get(`${W(PID)}/conflits?limite=100`, T.refB);
  const idsA = cvA.body.conflits.map((c: { id: string }) => c.id).sort();
  exemplesConflitsVue = cvA.body;
  verifier("8. dossiers : le referent A ne voit que les dossiers de A CONFIRMES par une personne (P, L2, K clos ; L6 en traitement) : ni L2 bis (POTENTIEL), ni les autres propositions du systeme, ni W (a B) ; B ne voit que W",
    JSON.stringify(idsA) === JSON.stringify([K_P, K_L2, K_K, K_L6].sort()) && JSON.stringify(cvB.body.conflits.map((c: { id: string }) => c.id)) === JSON.stringify([K_W]), { a: cvA.body.conflits.map((c: { type: string; statut: string }) => [c.type, c.statut]), b: cvB.body.conflits.length });
  const texteA = JSON.stringify(cvA.body);
  verifier("8. la vue concessionnaire ne porte NI geometrie, NI mesure, NI emprise, NI responsable, NI risque, NI echeance, NI cout ; elle donne la decision retenue (option et dates prevues)",
    !/coordinates|geometr|"geom"|mesure|bbox|responsable|risque|echeance|coutEstime|coutReel|justification|jeuReseauId/i.test(texteA) && cvA.body.conflits.every((c: { decisionRetenue: { option: string; dateDebutPrevue: string } | null }) => c.decisionRetenue?.option === "DEPLACER_RESEAU" && c.decisionRetenue.dateDebutPrevue === "2026-12-01"), texteA.slice(0, 300));
  let pages = 0, vus = new Set<string>(), curseur: string | undefined;
  do {
    const p = await get(`${W(PID)}/conflits?limite=7${curseur ? `&curseur=${curseur}` : ""}`, T.chef);
    pages += 1; for (const c of p.body.conflits) vus.add(c.id); curseur = p.body.curseurSuivant ?? undefined;
  } while (curseur && pages < 50);
  const totalConflits = await compter(`SELECT count(*) n FROM conflits_projet WHERE "projetId" = $1`, PID);
  verifier(`8. un decideur voit tous les dossiers (${totalConflits}), pagines par curseur (limite 7), sans doublon ni oubli ; un compte qui n'a pas workflow.lire (lecteur) : 403`, vus.size === totalConflits && pages === Math.ceil(totalConflits / 7) && (await get(`${W(PID)}/conflits`, T.lecteur)).status === 403, { pages, vus: vus.size, totalConflits });
  verifier("8. un compte qui lit le workflow par configuration mais ne decide pas n'a AUCUNE vue de dossiers (liste vide) : les dossiers se lisent par les routes des conflits et leurs regles", await (async () => {
    process.env.PROJETS_VOIRIE_WORKFLOW_MATRICE = JSON.stringify({ "workflow.lire": ["LECTEUR"] });
    const r = await get(`${W(PID)}/conflits`, T.lecteur);
    delete process.env.PROJETS_VOIRIE_WORKFLOW_MATRICE;
    return r.status === 200 && r.body.conflits.length === 0;
  })());

  // ================================================================ 9. Isolation inter-projets
  const DP2: string = (await dem(PID2, CA, "Plans des reseaux de la voirie du projet 2")).body.demande.id;
  await statutD(PID2, DP2, { vers: "ENVOYEE", canalEnvoi: "courriel", dateEnvoi: "2026-11-06" });
  verifier("9. INTER-PROJETS : refAP2 (A, projet 2) voit la demande du projet 2 seulement ; refA (A, projet 1) n'a aucun acces au projet 2 (404), ni refAP2 au projet 1 (404)",
    (await get(`${W(PID2)}/demandes`, T.refAP2)).body.demandes.map((d: { id: string }) => d.id).join() === DP2 && (await get(`${W(PID2)}/demandes`, T.refA)).status === 404 && (await get(`${W(PID)}/demandes`, T.refAP2)).status === 404
    && (await get(`${W(PID)}/demandes/${D5}`, T.refAP2)).status === 404);
  const croise = await Promise.all([
    get(`${W(PID2)}/demandes/${D5}`), get(`${W(PID2)}/taches/${TA}`), get(`${W(PID2)}/recolements/${R1}`), statutD(PID2, D5, { vers: "CLOTUREE", justification: JUSTIF }), envoyer("patch", `${W(PID2)}/taches/${TA}`, { priorite: "BASSE" }),
    preuve(PID2, "demandes", D5, { type: "NOTE", texte: "x" }), preuve(PID2, "taches", TA, { type: "NOTE", texte: "x" }), preuve(PID2, "recolements", R1, { type: "NOTE", texte: "x" }), statutT(TA, { vers: "TERMINEE", justification: JUSTIF }, T.chef, PID2),
    envoyer("post", `${W(PID2)}/recolements/${R1}/statut`, { vers: "BROUILLON", justification: JUSTIF }),
  ]);
  verifier("9. un objet d'un projet lu ou ecrit par l'URL d'un AUTRE projet (meme par un national) : 404 DEMANDE / TACHE / RECOLEMENT_INTROUVABLE, rien n'est modifie", croise.every((r) => r.status === 404) && (await sql<{ statut: string }>(`SELECT statut::text FROM demandes_concessionnaire WHERE id = $1`, D5))[0].statut === "ENVOYEE", croise.map((r) => [r.status, r.body.code]));
  const toutes404 = await Promise.all([
    get(`${W(PID)}/demandes/${D5}`, T.refB), get(`${W(PID)}/taches/${TA}`, T.refB), get(`${W(PID)}/recolements/${R1}`, T.refB), preuve(PID, "demandes", D5, { type: "NOTE", texte: "x" }, T.refB), preuve(PID, "taches", TA, { type: "NOTE", texte: "x" }, T.refB),
    preuve(PID, "recolements", R1, { type: "NOTE", texte: "x" }, T.refB), statutT(TA, { vers: "EN_COURS" }, T.refB),
  ]);
  const toutes200 = await Promise.all([get(`${W(PID)}/demandes/${D5}`, T.refA), get(`${W(PID)}/taches/${TA}`, T.refA), get(`${W(PID)}/recolements/${R1}`, T.refA)]);
  verifier("9. INTER-CONCESSIONNAIRES : le referent B ne lit ni n'ecrit AUCUN element de A (demande, tache, recolement, preuves, statut) : 404 partout ; le referent A, lui, les lit (200)", toutes404.every((r) => r.status === 404) && toutes200.every((r) => r.status === 200), toutes404.map((r) => [r.status, r.body.code]));
  verifier("9. deux referents du meme concessionnaire (refA et refA2) voient les memes elements ; refA2 ne voit pas ce qui est a B", (await get(`${W(PID)}/demandes`, T.refA2)).body.demandes.length === 3 && (await get(`${W(PID)}/demandes/${D4}`, T.refA2)).status === 404);

  // ================================================================ 10. Observateur, auditeur, agent de terrain, utilisateur sans droits, projet retire
  const routesWf: [string, string, unknown?][] = [
    ["get", `${W(PID)}/demandes`], ["get", `${W(PID)}/demandes/${D5}`], ["post", `${W(PID)}/demandes`, { concessionnaireId: CA, objet: "x" }], ["get", `${W(PID)}/taches`], ["get", `${W(PID)}/taches/${TA}`],
    ["post", `${W(PID)}/taches`, { titre: "x", responsableId: agent.id }], ["get", `${W(PID)}/recolements`], ["post", `${W(PID)}/recolements`, { jeuId: JEU_A, objet: "x" }], ["get", `${W(PID)}/jeux`], ["get", `${W(PID)}/conflits`],
    ["post", `${W(PID)}/demandes/${D5}/preuves`, { type: "NOTE", texte: "x" }], ["post", `${W(PID)}/referents`, { userId: refA.id, concessionnaireId: CA, motif: "motif suffisant" }], ["get", `${W(PID)}/referents`],
  ];
  const avantObs = await etat();
  const sObs: number[] = [];
  for (const [m, c, corps] of routesWf) sObs.push((await (corps === undefined ? envoyer(m as "post", c, undefined, T.lecteur) : envoyer(m as "post", c, corps, T.lecteur))).status);
  verifier(`10. OBSERVATEUR / AUDITEUR (LECTEUR avec la cle, sans rattachement) : 403 sur les ${routesWf.length} routes du workflow par defaut ; il lit toujours le socle (jeux autorises) et le journal d'audit`, sObs.every((s) => s === 403) && (await get(`/${PID}/jeux`, T.lecteur)).status === 200
    && audAuditeur.status === 200 && changees(avantObs, await etat()).length === 0, sObs);
  const sSans: number[] = [];
  for (const [m, c, corps] of routesWf) sSans.push((await (corps === undefined ? envoyer(m as "post", c, undefined, T.sans) : envoyer(m as "post", c, corps, T.sans))).status);
  const sSansCle: number[] = [];
  for (const [m, c, corps] of routesWf) sSansCle.push((await (corps === undefined ? envoyer(m as "post", c, undefined, T.lecteurSansCle) : envoyer(m as "post", c, corps, T.lecteurSansCle))).status);
  const sInactif = (await get(`${W(PID)}/demandes`, T.inactif)).status;
  const sJeton = (await request(app).get(`${BASE}${W(PID)}/demandes`)).status;
  verifier("10. UTILISATEUR SANS DROITS : sans la cle de module (meme GESTIONNAIRE) 403 partout ; compte inactif 401 ; sans jeton 401 ; mon-profil refuse aussi sans la cle", sSans.every((s) => s === 403) && sSansCle.every((s) => s === 403) && sInactif === 401 && sJeton === 401 && (await get(`/workflow/mon-profil`, T.sans)).status === 403);
  const agentWf = await Promise.all(routesWf.map(([m, c, corps]) => (corps === undefined ? envoyer(m as "post", c, undefined, T.agent) : envoyer(m as "post", c, corps, T.agent))));
  verifier("10. AGENT DE TERRAIN : seules ses taches (liste, detail) et la preuve a sa tache sont ouvertes ; demandes, recolements, jeux, dossiers, creations, rattachements : 403",
    agentWf.map((r) => r.status).join() === [403, 403, 403, 200, 404, 403, 403, 403, 403, 403, 403, 403, 403].join(), agentWf.map((r) => r.status));
  // Lecture ouverte aux observateurs par configuration.
  process.env.PROJETS_VOIRIE_WORKFLOW_MATRICE = JSON.stringify({ "workflow.lire": ["LECTEUR", "INSPECTEUR"] });
  const obs = await Promise.all([get(`${W(PID)}/demandes`, T.lecteur), get(`${W(PID)}/taches?limite=100`, T.lecteur), get(`${W(PID)}/taches/${TC.body.tache.id}`, T.lecteur), get(`${W(PID)}/demandes/${D5}`, T.lecteur), get(`${W(PID)}/recolements`, T.lecteur),
    get(`${W(PID)}/jeux`, T.lecteur), envoyer("post", `${W(PID)}/demandes`, { concessionnaireId: CA, objet: "x" }, T.lecteur), get(`${W(PID)}/demandes/${D1}`, T.lecteur)]);
  delete process.env.PROJETS_VOIRIE_WORKFLOW_MATRICE;
  const tachesObs = obs[1].body.taches as { id: string; conflitId: string | null }[];
  verifier("10. CONFIGURATION d'une lecture ouverte aux observateurs : vue de projet seulement : demandes ENVOYEES (3 : D1, D3, D5 ; pas de brouillon), taches non liees a un conflit (la tache de conflit TC : 404 ; aucune en liste), recolements non lies a un conflit ; jamais d'historique ; jeux AUTORISES ; toujours aucune ecriture (403)",
    obs[0].status === 200 && obs[0].body.demandes.length === 4 && obs[0].body.demandes.every((d: { statut: string }) => d.statut !== "BROUILLON") && obs[7].status === 200, obs.map((r) => r.status));
  verifier("10. ... precisement : TC liee a un conflit introuvable pour l'observateur, aucune tache de la liste n'est liee a un conflit, pas d'historique, jeux autorises seuls, ecriture refusee",
    obs[2].status === 404 && tachesObs.length > 0 && tachesObs.every((t) => t.conflitId === null) && !tachesObs.some((t) => t.id === TC.body.tache.id) && obs[3].status === 200 && obs[3].body.historique === undefined && obs[3].body.demande.creePar === null && obs[5].body.jeux.every((j: { statut: string }) => j.statut === "AUTORISE") && obs[6].status === 403
    && obs[4].body.recolements.every((r: { conflit: unknown }) => r.conflit === null), { taches: tachesObs.length, recolements: obs[4].body.recolements.length });
  // Projet retire.
  const PID_R = await projet("WF-RETIRE");
  const DR: string = (await dem(PID_R, CA, "Demande d'un projet qui sera retire")).body.demande.id;
  const TRr: string = (await tache({ titre: "Tache d'un projet qui sera retire" }, T.chef, PID_R)).body.tache.id;
  const rR = await rat(PID_R, refAP2.id, CA, "Rattachement d'un projet qui sera retire");
  await statutD(PID_R, DR, { vers: "ENVOYEE", canalEnvoi: "courriel", dateEnvoi: "2026-11-06" });
  const retire = await envoyer("delete", `/${PID_R}`, undefined, T.admin);
  const lignesAvantRetire = await etat();
  const routesRetire: [string, string, unknown?][] = [
    ["get", `${W(PID_R)}/demandes`], ["get", `${W(PID_R)}/demandes/${DR}`], ["post", `${W(PID_R)}/demandes`, { concessionnaireId: CA, objet: "apres retrait" }], ["patch", `${W(PID_R)}/demandes/${DR}`, { objet: "apres retrait" }],
    ["post", `${W(PID_R)}/demandes/${DR}/statut`, { vers: "ANNULEE", justification: JUSTIF }], ["post", `${W(PID_R)}/demandes/${DR}/preuves`, { type: "NOTE", texte: "apres retrait" }], ["get", `${W(PID_R)}/taches`], ["get", `${W(PID_R)}/taches/${TRr}`],
    ["post", `${W(PID_R)}/taches`, { titre: "apres retrait", responsableId: agent.id }], ["post", `${W(PID_R)}/taches/${TRr}/statut`, { vers: "EN_COURS" }], ["get", `${W(PID_R)}/recolements`], ["post", `${W(PID_R)}/recolements`, { jeuId: UUID0, objet: "x" }],
    ["get", `${W(PID_R)}/jeux`], ["get", `${W(PID_R)}/conflits`], ["get", `${W(PID_R)}/referents`], ["post", `${W(PID_R)}/referents`, { userId: refA.id, concessionnaireId: CA, motif: "apres le retrait du projet" }],
    ["post", `${W(PID_R)}/referents/${rR.body.rattachement.id}/revoquer`, { motif: "apres le retrait du projet" }],
  ];
  const sRetire: { qui: string; i: number; statut: number; code: string }[] = [];
  for (const [qui, t] of [["admin", T.admin], ["chef", T.chef], ["referent", T.refAP2], ["agent", T.agent]] as const) {
    for (const [i, [m, c, corps]] of routesRetire.entries()) {
      const r = await (corps === undefined ? envoyer(m as "post", c, undefined, t) : envoyer(m as "post", c, corps, t));
      sRetire.push({ qui, i, statut: r.status, code: r.body?.code });
    }
  }
  const attendus404 = sRetire.filter((x) => x.qui !== "agent");
  // Un refus de droit (403 ACTION_NON_AUTORISEE) precede legitimement la 404 du projet : le gestionnaire sur les deux routes d'administration des rattachements, le referent sur ce qu'il n'ecrit pas.
  const ok404 = (x: { qui: string; i: number; statut: number; code: string }) => (x.statut === 404 && x.code === "PROJET_INTROUVABLE") || (x.statut === 403 && x.code === "ACTION_NON_AUTORISEE" && (x.qui === "referent" || (x.qui === "chef" && x.i >= 15)));
  verifier(`10. PROJET RETIRE : les ${routesRetire.length} routes (lecture et ecriture) repondent 404 PROJET_INTROUVABLE a l'ADMIN (toutes), au gestionnaire et au referent rattache (hors le refus de droit qui precede) ; rien n'est ecrit`, retire.status === 200
    && attendus404.every(ok404) && sRetire.filter((x) => x.qui === "admin").every((x) => x.statut === 404 && x.code === "PROJET_INTROUVABLE") && changees(lignesAvantRetire, await etat()).length === 0, attendus404.filter((x) => !ok404(x)));
  const profRetire = await get(`/workflow/mon-profil`, T.refAP2);
  verifier("10. mon-profil du referent n'affiche plus le projet retire (seul PID2 reste)", profRetire.body.rattachements.length === 1 && profRetire.body.rattachements[0].projet.id === PID2);

  // ================================================================ 11. Cadence, plafonds, pagination
  const PID_C = await projet("WF-CADENCE");
  process.env.PROJETS_VOIRIE_WORKFLOW_CREATIONS_PAR_MINUTE = "3";
  const crees: number[] = [];
  for (let i = 0; i < 3; i += 1) crees.push((await dem(PID_C, CA, `Demande de cadence ${i + 1}`)).status);
  const quatrieme = await dem(PID_C, CA, "Demande de cadence 4");
  const autreCompte = await dem(PID_C, CA, "Demande de cadence d'un autre compte", {}, T.chef2);
  const PID_C2 = await projet("WF-CADENCE-2");
  const autreProjet = await dem(PID_C2, CA, "Demande de cadence sur un autre projet");
  const preuveCadence = await preuve(PID_C, "demandes", (await get(`${W(PID_C)}/demandes`)).body.demandes[0].id, { type: "NOTE", texte: "preuve sous cadence" });
  verifier("11. CADENCE (3 creations par minute, par compte et par projet) : trois demandes passent, la quatrieme est refusee 429 CADENCE_CREATION avec Retry-After ; un autre compte et un autre projet ne sont pas gênes ; une preuve compte aussi",
    crees.every((s) => s === 201) && quatrieme.status === 429 && quatrieme.body.code === "CADENCE_CREATION" && Number(quatrieme.headers["retry-after"]) >= 1 && quatrieme.body.retryAfterS >= 1 && autreCompte.status === 201 && autreProjet.status === 201 && preuveCadence.status === 429, [quatrieme.body, preuveCadence.body]);
  verifier("11. une creation refusee par la cadence n'ecrit rien (3 demandes de chef sur ce projet) ; une valeur invalide du reglage redonne le defaut (30)", (await compter(`SELECT count(*) n FROM demandes_concessionnaire WHERE "projetId" = $1 AND "creeParId" = $2`, PID_C, chef.id)) === 3
    && await (async () => { process.env.PROJETS_VOIRIE_WORKFLOW_CREATIONS_PAR_MINUTE = "abc"; const r = await dem(PID_C, CA, "Demande avec reglage invalide"); return r.status === 201; })());
  process.env.PROJETS_VOIRIE_WORKFLOW_CREATIONS_PAR_MINUTE = "600";
  const PID_Q = await projet("WF-QUOTA");
  process.env.PROJETS_VOIRIE_WORKFLOW_TACHES_MAX = "100";
  const t0 = Date.now();
  const statutsCreation: number[] = [];
  for (let i = 0; i < 100; i += 1) statutsCreation.push((await tache({ titre: `Tache de volume ${i + 1}`, priorite: i % 2 === 0 ? "BASSE" : "HAUTE" }, T.chef, PID_Q)).status);
  const dureeCreation = Date.now() - t0;
  const depasse = await tache({ titre: "Tache 101" }, T.chef, PID_Q);
  delete process.env.PROJETS_VOIRIE_WORKFLOW_TACHES_MAX;
  verifier(`11. PLAFOND de taches par projet (reglage a 100, borne minimale) : 100 creations (${dureeCreation} ms), la 101e : 422 QUOTA_ATTEINT`, statutsCreation.every((s) => s === 201) && depasse.status === 422 && depasse.body.code === "QUOTA_ATTEINT", depasse.body);
  const ids = new Set<string>(); let p = 0, cur: string | undefined; const dur: number[] = [];
  do {
    const t1 = Date.now();
    const r = await get(`${W(PID_Q)}/taches?limite=40${cur ? `&curseur=${cur}` : ""}`);
    dur.push(Date.now() - t1);
    p += 1; for (const t of r.body.taches) ids.add(t.id); cur = r.body.curseurSuivant ?? undefined;
  } while (cur && p < 10);
  const compteurs = (await get(`${W(PID_Q)}/taches`)).body.compteurs;
  verifier(`11. pagination par curseur (40 par page) : 3 pages, 100 taches sans doublon ni oubli, compteurs exacts (A_FAIRE 100) ; page la plus lente ${Math.max(...dur)} ms`, p === 3 && ids.size === 100 && compteurs.A_FAIRE === 100 && Math.max(...dur) < 5000, { p, n: ids.size, compteurs, dur });
  verifier("11. filtres : priorite des taches non filtrable (400) ; statut inconnu : 400 ; curseur forge : 400 CURSEUR_INVALIDE", (await get(`${W(PID_Q)}/taches?priorite=HAUTE`)).status === 400 && (await get(`${W(PID_Q)}/taches?statut=INCONNU`)).status === 400
    && (await get(`${W(PID_Q)}/taches?curseur=zzz`)).body.code === "CURSEUR_INVALIDE");

  // ---------------------------------------------------------------- 11 bis. Revue de la vague 1, m6 : le verrou du workflow n'est pas independant de celui du projet
  // Une ecriture du workflow insere dans une table fille de `projets_voirie` : la cle etrangere prend FOR KEY SHARE sur la ligne du projet, que le verrou FOR UPDATE
  // d'un depot, d'une autorisation ou d'une ecriture du lot B1 contredit. L'ecriture ATTEND puis repond 503 PROJET_OCCUPE ; le client reessaie.
  const PID_L = await projet("WF-VERROU");
  process.env.PROJETS_VOIRIE_VERROU_MS = "500";
  let relacher!: () => void;
  const fin = new Promise<void>((r) => { relacher = r; });
  const tient = prisma.$transaction(async (tx: typeof prisma) => { await tx.$queryRawUnsafe(`SELECT "id" FROM "projets_voirie" WHERE "id" = $1 FOR UPDATE`, PID_L); await fin; }, { timeout: 30_000, maxWait: 10_000 });
  await new Promise((r) => setTimeout(r, 400));
  const t0v = Date.now();
  const bloquee = await dem(PID_L, CA, "Demande pendant un verrou long du projet");
  const dureeAttente = Date.now() - t0v;
  relacher();
  await tient;
  delete process.env.PROJETS_VOIRIE_VERROU_MS;
  const reessai = await dem(PID_L, CA, "Demande apres la fin du verrou long");
  verifier(`11 bis. m6 : une ecriture du workflow pendant un verrou FOR UPDATE du projet (depot, autorisation, ecriture B1) ATTEND le delai de verrou (${dureeAttente} ms pour 500) puis repond 503 PROJET_OCCUPE, sans rien ecrire ; le reessai du client passe (201)`,
    bloquee.status === 503 && bloquee.body.code === "PROJET_OCCUPE" && dureeAttente >= 400 && reessai.status === 201
    && (await compter(`SELECT count(*) n FROM demandes_concessionnaire WHERE "projetId" = $1`, PID_L)) === 1, [bloquee.status, bloquee.body, reessai.status]);

  // ================================================================ 12. Base : declencheurs et contraintes
  const SIX = TABLES_WORKFLOW;
  const trunc = await Promise.all(SIX.map((t) => essaiAnnule(async (tx) => { await tx.$queryRawUnsafe(`TRUNCATE "${t}" CASCADE`); })));
  const supp = await Promise.all(SIX.map((t) => essaiAnnule(async (tx) => { await tx.$queryRawUnsafe(`DELETE FROM "${t}"`); })));
  verifier("12. TRUNCATE et DELETE refuses (23001) sur les six tables : suppression logique uniquement", trunc.every((c) => c === "23001") && supp.every((c) => c === "23001"), { trunc, supp });
  verifier("12. l'historique est en AJOUT SEUL : modification et suppression refusees (23001)", (await essaiAnnule(async (tx) => { await tx.$queryRawUnsafe(`UPDATE workflow_projet_historique SET justification = 'x'`); })) === "23001"
    && (await essaiAnnule(async (tx) => { await tx.$queryRawUnsafe(`DELETE FROM workflow_projet_historique`); })) === "23001");
  const rattRevoque = rA2.body.rattachement.id as string;
  verifier("12. rattachement : identite immuable, revoque ne change plus (23001) ; revocation sans motif refusee (23514)", (await essaiAnnule(async (tx) => { await tx.$queryRawUnsafe(`UPDATE referents_concessionnaire SET "userId" = '${agent.id}' WHERE id = '${rA.body.rattachement.id}'`); })) === "23001"
    && (await essaiAnnule(async (tx) => { await tx.$queryRawUnsafe(`UPDATE referents_concessionnaire SET "motifRevocation" = 'autre motif long assez' WHERE id = '${rattRevoque}'`); })) === "23001"
    && (await essaiAnnule(async (tx) => { await tx.$queryRawUnsafe(`UPDATE referents_concessionnaire SET "revoqueLe" = now(), "revoqueParId" = '${admin.id}' WHERE id = '${rA.body.rattachement.id}'`); })) === "23514");
  const ins = (corps: string) => async (tx: typeof prisma) => { await tx.$queryRawUnsafe(corps); };
  const idU = chef.id;
  verifier("12. contraintes des demandes : envoyee sans canal ni date (23514), close sans motif (23514), jeu recu sur une demande non recue (23514), reception avant l'envoi (23514)",
    (await essaiAnnule(ins(`INSERT INTO demandes_concessionnaire (id, "projetId", "concessionnaireId", objet, statut, "creeParId") VALUES (gen_random_uuid()::text, '${PID}', '${CA}', 'x', 'ENVOYEE', '${idU}')`))) === "23514"
    && (await essaiAnnule(ins(`INSERT INTO demandes_concessionnaire (id, "projetId", "concessionnaireId", objet, statut, "creeParId", "canalEnvoi", "dateEnvoi", "envoyeParId", "envoyeLe") VALUES (gen_random_uuid()::text, '${PID}', '${CA}', 'x', 'CLOTUREE', '${idU}', 'c', '2026-11-01', '${idU}', now())`))) === "23514"
    && (await essaiAnnule(ins(`INSERT INTO demandes_concessionnaire (id, "projetId", "concessionnaireId", objet, "creeParId", "jeuRecuId") VALUES (gen_random_uuid()::text, '${PID}', '${CA}', 'x', '${idU}', '${JEU_A}')`))) === "23514"
    && (await essaiAnnule(ins(`INSERT INTO demandes_concessionnaire (id, "projetId", "concessionnaireId", objet, statut, "creeParId", "canalEnvoi", "dateEnvoi", "envoyeParId", "envoyeLe", "dateReception", "recueParId", "recueLe") VALUES (gen_random_uuid()::text, '${PID}', '${CA}', 'x', 'RECUE', '${idU}', 'c', '2026-11-05', '${idU}', now(), '2026-11-01', '${idU}', now())`))) === "23514");
  verifier("12. contraintes des taches : liee a un conflit ET a une demande (23514), A_VALIDER sans validation requise (23514), partagee sans concessionnaire (23514), terminee sans date (23514) ; identite immuable (23001)",
    (await essaiAnnule(ins(`INSERT INTO taches_projet_voirie (id, "projetId", titre, "conflitId", "demandeId", "responsableId", "creeParId") VALUES (gen_random_uuid()::text, '${PID}', 'x', '${K_P}', '${D5}', '${idU}', '${idU}')`))) === "23514"
    && (await essaiAnnule(ins(`INSERT INTO taches_projet_voirie (id, "projetId", titre, statut, "responsableId", "creeParId") VALUES (gen_random_uuid()::text, '${PID}', 'x', 'A_VALIDER', '${idU}', '${idU}')`))) === "23514"
    && (await essaiAnnule(ins(`INSERT INTO taches_projet_voirie (id, "projetId", titre, partagee, "responsableId", "creeParId") VALUES (gen_random_uuid()::text, '${PID}', 'x', true, '${idU}', '${idU}')`))) === "23514"
    && (await essaiAnnule(ins(`INSERT INTO taches_projet_voirie (id, "projetId", titre, statut, "responsableId", "creeParId") VALUES (gen_random_uuid()::text, '${PID}', 'x', 'TERMINEE', '${idU}', '${idU}')`))) === "23514"
    && (await essaiAnnule(async (tx) => { await tx.$queryRawUnsafe(`UPDATE taches_projet_voirie SET "projetId" = '${PID2}' WHERE id = '${TA}'`); })) === "23001"
    && (await essaiAnnule(async (tx) => { await tx.$queryRawUnsafe(`UPDATE taches_projet_voirie SET "concessionnaireId" = '${CB}' WHERE id = '${TA}'`); })) === "23001");
  verifier("12. contraintes des recolements : sans conflit ni jeu (23514), valide sans decideur (23514) ; liens et concessionnaire immuables (23001) ; index uniques partiels presents",
    (await essaiAnnule(ins(`INSERT INTO recolements_projet_voirie (id, "projetId", objet, "creeParId") VALUES (gen_random_uuid()::text, '${PID}', 'x', '${idU}')`))) === "23514"
    && (await essaiAnnule(ins(`INSERT INTO recolements_projet_voirie (id, "projetId", "jeuId", objet, statut, "creeParId", "soumisParId", "soumisLe") VALUES (gen_random_uuid()::text, '${PID}', '${JEU_A}', 'x', 'VALIDE', '${idU}', '${idU}', now())`))) === "23514"
    && (await essaiAnnule(async (tx) => { await tx.$queryRawUnsafe(`UPDATE recolements_projet_voirie SET "jeuId" = '${JEU_A}' WHERE id = '${RB}'`); })) === "23001"
    && (await compter(`SELECT count(*) n FROM pg_indexes WHERE indexname IN ('recolements_projet_voirie_conflit_actif_key', 'recolements_projet_voirie_jeu_actif_key', 'referents_concessionnaire_actif_key') AND indexdef LIKE '%WHERE%'`)) === 3);
  verifier("12. contraintes de l'historique : transition sans changement de statut (23514), profil inconnu (23514)", (await essaiAnnule(ins(`INSERT INTO workflow_projet_historique (id, "projetId", "objetType", "objetId", action, "ancienStatut", "nouveauStatut", "acteurId", "acteurProfil") VALUES (gen_random_uuid()::text, '${PID}', 'TACHE', '${TA}', 'STATUT', 'A_FAIRE', 'A_FAIRE', '${idU}', 'GESTIONNAIRE')`))) === "23514"
    && (await essaiAnnule(ins(`INSERT INTO workflow_projet_historique (id, "projetId", "objetType", "objetId", action, "acteurId", "acteurProfil") VALUES (gen_random_uuid()::text, '${PID}', 'TACHE', '${TA}', 'CREATION', '${idU}', 'SUPER_ROOT')`))) === "23514");
  const fk = await compter(`SELECT count(*) n FROM information_schema.table_constraints WHERE constraint_type = 'FOREIGN KEY' AND table_name = ANY($1::text[])`, SIX);
  verifier(`12. les cles etrangeres sont dans la base (${fk} sur les six tables) : un rattachement a un compte, un projet ou un concessionnaire inconnu est refuse (23503)`, fk === 29 && (await essaiAnnule(ins(`INSERT INTO referents_concessionnaire (id, "userId", "concessionnaireId", "projetId", "creeParId", motif) VALUES (gen_random_uuid()::text, 'inconnu', '${CA}', '${PID}', '${admin.id}', 'motif assez long pour la base')`))) === "23503");

  // ================================================================ 13. Aucune ecriture hors du module
  const apresTout = await etat();
  const autorisees = new Set([...SIX, "audit_logs", "projets_voirie", "projets_voirie_jeux", "projets_voirie_objets", "conflits_projet", "conflits_projet_historique", "conflits_projet_preuves", "conflits_projet_decisions", "analyses_conflit_projet", "concessionnaires_reseau"]);
  const horsModule = changees(avantTout, apresTout).filter((t) => !autorisees.has(t));
  verifier("13. DEPUIS le debut du workflow, aucune table du referentiel officiel ni aucune autre table que celles du module (et audit_logs) n'a change : troncons, ouvrages, chantiers, ordres de travaux, programmation, outbox... inchanges", horsModule.length === 0, horsModule);
  const auditGeom = await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" IN ('ReferentConcessionnaire', 'DemandeConcessionnaire', 'TacheProjetVoirie', 'RecolementProjetVoirie') AND (coalesce(before::text, '') || coalesce(after::text, '')) ~* 'coordinates|geom|LINESTRING'`);
  const auditTypes = (await sql<{ t: string }>(`SELECT DISTINCT "entityType" t FROM audit_logs WHERE "entityType" IN ('ReferentConcessionnaire', 'DemandeConcessionnaire', 'TacheProjetVoirie', 'RecolementProjetVoirie') ORDER BY 1`)).map((x) => x.t);
  verifier("13. l'audit des quatre types d'entite du workflow existe (ReferentConcessionnaire, DemandeConcessionnaire, TacheProjetVoirie, RecolementProjetVoirie) et ne contient aucune geometrie", auditTypes.length === 4 && auditGeom === 0, { auditTypes, auditGeom });
  const auditSecret = await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" IN ('ReferentConcessionnaire', 'DemandeConcessionnaire', 'TacheProjetVoirie', 'RecolementProjetVoirie') AND (coalesce(before::text, '') || coalesce(after::text, '')) ~* 'interlocuteur|passwordHash|totp'`);
  verifier("13. l'audit ne reprend ni l'interlocuteur (donnee personnelle) ni aucun secret", auditSecret === 0);
  const cloneEtat = await sql<{ n: bigint }>(`SELECT count(*) n FROM troncons`);
  verifier("13. le referentiel de troncons du banc est reste vide d'ecriture du workflow (aucun troncon cree)", Number(cloneEtat[0].n) === avantTout["troncons"]);
}

let exemplesMonProfil: unknown, exemplesDemande: unknown, exemplesDemandeEnvoyee: unknown, exemplesPreuve: unknown, exemplesRecolement: unknown, exemplesRecolementValide: unknown, exemplesConflitsVue: unknown;
try {
  await main();
  if (process.env.WORKFLOW_EXEMPLES) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(process.env.WORKFLOW_EXEMPLES, JSON.stringify({ monProfil: exemplesMonProfil, demande: exemplesDemande, demandeEnvoyee: exemplesDemandeEnvoyee, preuve: exemplesPreuve, recolement: exemplesRecolement, recolementValide: exemplesRecolementValide, conflitsVue: exemplesConflitsVue }, null, 1));
  }
} catch (e) {
  console.error("ECHEC DU BANC :", e);
  verifier("le banc va jusqu'au bout sans exception", false, String(e));
} finally {
  conclure();
  await prisma.$disconnect();
  await banc.fermer();
}

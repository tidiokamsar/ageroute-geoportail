// Banc d'integration du CONTROLE D'ACCES cote serveur (chantier C1, decision 3 de l'architecte). Voir
// tests-integration/README.md et docs/securite/CONTROLE-ACCES.md. Lancer (DATABASE_URL pointe sur `replay`) :
//   npx tsx tests-integration/controle-acces.integration.mts
//
// CE QUE LE BANC FAIT PASSER PAR LE CODE REEL : l'application ENTIERE (`createApp()` : routeurs v1 et v2, limiteurs,
// gestionnaire d'erreurs), des jetons signes par des secrets aleatoires tires a chaque lancement, les modules et le
// perimetre territorial LUS EN BASE a chaque requete, l'audit transactionnel, contre un clone PostGIS jetable. Rien
// n'est simule cote serveur. Chaque verification relit la BASE (ligne inchangee, ligne absente, trace d'audit absente),
// jamais la seule reponse HTTP.
//
// CE QUE LE BANC PROUVE (un utilisateur d'une region A, role limite, face a une ressource d'une region B) :
//   F1 ordres de travaux : lecture (liste, fiche, statistiques) et ecriture (creation, modification, assignation,
//      statut, photos, archivage) ;
//   F2 missions : liste, fiche, changement de statut, creation ;
//   F3 programmation manuelle (lignes budgetaires, region = celle du troncon) : liste, totaux, creation, modification,
//      suppression logique ;
//   F4 observations et defauts : liste et fiche (le responsable n'etait filtre par aucune region) ;
//   F5 un INSPECTEUR n'ecrit sur un ordre de travaux que s'il en est l'assigne ou le createur (meme regle que le
//      statut, et que les inspections : P1-05) ;
//   non-regression : le MEME compte dans son perimetre lit et ecrit toujours ; un compte national et l'ADMIN aussi.
// Et, SANS les modifier (VOULU ou decision en attente, voir le document), ce que le serveur laisse aujourd'hui lire :
//   les lectures v1 du patrimoine sans module (CONSTAT), la valeur des modules refuses sur les routes qui en ont un.
//
// NON COUVERT (dit honnetement) : le moteur de programmation (scenarios, fiches, plans pluriannuels), la main
// courante, les patrouilles, la veille, la teledetection (voir le document : decisions attendues) ; le televersement
// multipart d'une photo d'OT (seul le retrait est eprouve, la garde est la meme).
import { createHash, randomUUID } from "node:crypto";
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure } from "./lib/verdict.ts";

// server.ts pose ce correctif au demarrage (les montants BigInt sortent en chaine) ; createApp() ne le porte pas.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function () { return this.toString(); };

const banc = await ouvrirBancClone(process.env.BANC_CLONE ?? "essai_controle_acces");
// Le plafond de debit de /api/v2 compterait les centaines d'appels du banc : il est desactive (0), comme le permet l'env.
process.env.RATE_LIMIT_V2_MAX = "0";
const { prisma } = await banc.imp("lib/prisma");
const { createApp } = await banc.imp("app");
const { signAccessToken } = await banc.imp("utils/jwt");
const request = (await import("supertest")).default;
const app = createApp();

const sql = async <T = Record<string, unknown>>(texte: string, ...params: unknown[]): Promise<T[]> => prisma.$queryRawUnsafe(texte, ...params);
const compter = async (texte: string, ...params: unknown[]): Promise<number> => Number((await sql<{ n: bigint }>(texte, ...params))[0].n);
const jeton = (u: { id: string; role: string; email: string }) => signAccessToken({ sub: u.id, role: u.role, email: u.email });

type Verbe = "get" | "post" | "put" | "patch" | "delete";
const appeler = (verbe: Verbe, url: string, token: string, corps?: unknown) => {
  const r = request(app)[verbe](url).set("Authorization", `Bearer ${token}`);
  return corps === undefined ? r : r.send(corps as object);
};
type Rep = { status: number; body: any };
const refus403 = (r: Rep, code?: string) => r.status === 403 && (code === undefined || r.body.code === code);
const ok2xx = (r: Rep) => r.status >= 200 && r.status < 300;

async function main() {
  // ---------------------------------------------------------------- Fixtures : regions, comptes, perimetres
  await sql(`INSERT INTO regions (nom) VALUES ('Region acces 1'), ('Region acces 2')`);
  const regionId = async (nom: string) => Number((await sql<{ id: number }>(`SELECT id FROM regions WHERE nom = $1`, nom))[0].id);
  const [R1, R2] = [await regionId("Region acces 1"), await regionId("Region acces 2")];

  const MODULES_RESP = ["troncons", "ouvrages", "points-noirs", "postes", "chantiers", "inspections", "geoportail", "ordres-travaux", "dashboard", "programmation"];
  const mkUser = (email: string, role: string, modulesAutorises: string[]) =>
    prisma.user.create({ data: { email, nomComplet: email, passwordHash: "x", role, modulesAutorises } });
  const admin = await mkUser("admin@acces.invalid", "ADMIN", []);
  const gestNat = await mkUser("gestnat@acces.invalid", "GESTIONNAIRE", MODULES_RESP);   // aucun rattachement = national
  const gestR1 = await mkUser("gestr1@acces.invalid", "GESTIONNAIRE", MODULES_RESP);     // R1 seulement
  const inspR1 = await mkUser("inspr1@acces.invalid", "INSPECTEUR", MODULES_RESP);       // R1 seulement
  const lectSans = await mkUser("lectsans@acces.invalid", "LECTEUR", []);                // aucun module
  const lectGeo = await mkUser("lectgeo@acces.invalid", "LECTEUR", ["geoportail"]);      // la carte seulement
  const T = {
    admin: jeton(admin), nat: jeton(gestNat), r1: jeton(gestR1), insp: jeton(inspR1), sans: jeton(lectSans), geo: jeton(lectGeo),
  };
  await sql(`INSERT INTO perimetres_comptes ("userId", "regionId", "accordeParId") VALUES ($1, $3, $4), ($2, $3, $4)`, gestR1.id, inspR1.id, R1, admin.id);

  // ---------------------------------------------------------------- Fixtures : une ressource par region
  const mkTroncon = (code: string, rid: number) =>
    prisma.troncon.create({ data: { code, nom: `Troncon ${code}`, classe: "RR", regionId: rid, longueurKm: 3, revetement: "BITUME", pkDebut: 0, pkFin: 3 } });
  const T1 = await mkTroncon("ACC-T1", R1);
  const T2 = await mkTroncon("ACC-T2", R2);

  const mkOt = (numero: string, rid: number | null, extra: Record<string, unknown> = {}) =>
    prisma.ordreTravaux.create({ data: { numero, titre: `OT ${numero}`, typeIntervention: "AUTRE", regionId: rid, creeParId: gestNat.id, ...extra } });
  const ot1 = await mkOt("OT-ACC-1", R1);
  const ot1b = await mkOt("OT-ACC-1B", R1, { assigneAId: inspR1.id, statut: "ASSIGNE" });
  const ot1c = await mkOt("OT-ACC-1C", R1, { creeParId: inspR1.id });
  const ot2 = await mkOt("OT-ACC-2", R2);
  const otX = await mkOt("OT-ACC-X", null);
  const photo1 = await prisma.otPhoto.create({ data: { otId: ot1.id, fileName: "acces-1.jpg" } });
  const photo2 = await prisma.otPhoto.create({ data: { otId: ot2.id, fileName: "acces-2.jpg" } });

  const mkMission = (code: string, rid: number | null) =>
    prisma.mission.create({ data: { code, intitule: `Mission ${code}`, type: "INSPECTION", createurId: gestNat.id, regionId: rid } });
  const m1 = await mkMission("MIS-ACC-1", R1);
  const m2 = await mkMission("MIS-ACC-2", R2);
  const mX = await mkMission("MIS-ACC-X", null);

  const mkProg = (intitule: string, tronconId: string | null, montant: bigint) =>
    prisma.programmeBudgetaire.create({ data: { annee: 2027, intitule, montantPrevuGnf: montant, tronconId, createdById: gestNat.id } });
  const p1 = await mkProg("Prevision acces R1", T1.id, 1000n);
  const p2 = await mkProg("Prevision acces R2", T2.id, 20n);
  const pX = await mkProg("Prevision acces sans troncon", null, 300000n);

  const catalogue = await prisma.catalogueDefaut.create({ data: { code: "ACC-CAT", libelle: "Defaut acces", famille: "CHAUSSEE", unite: "UNITE" } });
  const mkObs = (cle: string, tronconId: string) =>
    prisma.observation.create({ data: { clientOperationId: `acces-${cle}-${randomUUID()}`, agentId: gestNat.id, type: "DEGRADATION", tronconId, observeA: new Date() } });
  const o1 = await mkObs("o1", T1.id);
  const o2 = await mkObs("o2", T2.id);
  const mkDef = (obsId: string, tronconId: string) =>
    prisma.defaut.create({ data: { catalogueId: catalogue.id, observationId: obsId, tronconId, constateA: new Date(), constateParId: gestNat.id } });
  const d1 = await mkDef(o1.id, T1.id);
  const d2 = await mkDef(o2.id, T2.id);

  const ligneOt = async (id: string) => (await sql<{ titre: string; regionId: number | null; statut: string; deletedAt: Date | null; assigneAId: string | null; entreprise: string | null }>(
    `SELECT titre, "regionId", statut::text AS statut, "deletedAt", "assigneAId", entreprise FROM ordres_travaux WHERE id = $1`, id))[0];
  const audits = (id: string) => compter(`SELECT count(*) n FROM audit_logs WHERE "entityId" = $1`, id);
  const ids = (r: Rep, cle = "data") => (r.body[cle] ?? r.body ?? []).map((x: { id: string }) => x.id) as string[];

  // ================================================================ F1. Ordres de travaux
  console.log("\n== F1. Ordres de travaux ==");
  const lr1 = await appeler("get", "/api/ordres-travaux?pageSize=100", T.r1);
  const idsR1 = ids(lr1);
  verifier("F1 lecture : le compte regional (R1) ne voit dans la liste QUE les OT de sa region (ni R2, ni sans region)",
    lr1.status === 200 && idsR1.includes(ot1.id) && idsR1.includes(ot1b.id) && !idsR1.includes(ot2.id) && !idsR1.includes(otX.id), idsR1.length);
  verifier("F1 lecture : le total de la liste suit le perimetre (3 OT de R1)", lr1.body.total === 3, lr1.body.total);
  const lnat = await appeler("get", "/api/ordres-travaux?pageSize=100", T.nat);
  const ladm = await appeler("get", "/api/ordres-travaux?pageSize=100", T.admin);
  verifier("F1 non-regression : le compte national et l'ADMIN voient les 5 OT", lnat.body.total === 5 && ladm.body.total === 5, [lnat.body.total, ladm.body.total]);

  const g2 = await appeler("get", `/api/ordres-travaux/${ot2.id}`, T.r1);
  const gX = await appeler("get", `/api/ordres-travaux/${otX.id}`, T.r1);
  const g1 = await appeler("get", `/api/ordres-travaux/${ot1.id}`, T.r1);
  const gInconnu = await appeler("get", `/api/ordres-travaux/${randomUUID()}`, T.r1);
  verifier("F1 lecture : la fiche d'un OT de R2 (et d'un OT sans region) est un 404 pour le compte regional, identique a un OT inconnu ; celle de R1 : 200",
    g2.status === 404 && gX.status === 404 && gInconnu.status === 404 && g1.status === 200 && g2.body.error === gInconnu.body.error, [g2.status, gX.status, g1.status, g2.body, gInconnu.body]);
  const gNat2 = await appeler("get", `/api/ordres-travaux/${ot2.id}`, T.nat);
  verifier("F1 non-regression : le compte national lit l'OT de R2", gNat2.status === 200, gNat2.status);

  const st = await appeler("get", "/api/ordres-travaux/stats", T.r1);
  const stNat = await appeler("get", "/api/ordres-travaux/stats", T.nat);
  const regions = (r: Rep) => (r.body.backlogParRegion ?? []).map((x: { region: string }) => x.region);
  verifier("F1 lecture : les statistiques du compte regional ne portent que sa region (ouverts = 3, pas de ligne R2 ni 'Non renseignee')",
    st.status === 200 && st.body.ouverts === 3 && !regions(st).includes("Region acces 2") && !regions(st).includes("Non renseignée"), st.body);
  verifier("F1 non-regression : les statistiques du compte national portent les 5 OT", stNat.body.ouverts === 5, stNat.body.ouverts);

  // Ecritures refusees : ligne inchangee, aucune trace d'audit, 404 identique a l'OT inconnu.
  const avant2 = await ligneOt(ot2.id); const aud2 = await audits(ot2.id);
  const put2 = await appeler("put", `/api/ordres-travaux/${ot2.id}`, T.r1, { titre: "Titre pirate", entreprise: "Pirate SA" });
  const asg2 = await appeler("post", `/api/ordres-travaux/${ot2.id}/assigner`, T.r1, { assigneAId: gestR1.id });
  const sta2 = await appeler("post", `/api/ordres-travaux/${ot2.id}/statut`, T.r1, { statut: "ANNULE" });
  const rph2 = await appeler("delete", `/api/ordres-travaux/${ot2.id}/photos/${photo2.id}`, T.r1);
  const cnv2 = await appeler("post", `/api/ordres-travaux/${ot2.id}/convertir-chantier`, T.r1);
  const del2 = await appeler("delete", `/api/ordres-travaux/${ot2.id}`, T.r1);
  const apres2 = await ligneOt(ot2.id);
  verifier("F1 ecriture : modifier, assigner, changer le statut, retirer une photo, convertir ou archiver un OT de R2 est refuse au compte regional (404 ou 403)",
    [put2, asg2, sta2, rph2, cnv2, del2].every((r) => r.status === 404 || r.status === 403), [put2.status, asg2.status, sta2.status, rph2.status, cnv2.status, del2.status]);
  verifier("F1 ecriture : l'OT de R2 est INCHANGE en base (titre, entreprise, statut, assigne, non archive, photo non retiree) et SANS trace d'audit",
    JSON.stringify(avant2) === JSON.stringify(apres2) && (await prisma.otPhoto.findUnique({ where: { id: photo2.id } }))?.deletedAt === null && await audits(ot2.id) === aud2,
    { avant2, apres2 });
  verifier("F1 ecriture : la modification d'un OT de R2 repond le MEME 404 qu'un OT inconnu (l'existence n'est pas revelee)",
    put2.status === 404 && (await appeler("put", `/api/ordres-travaux/${randomUUID()}`, T.r1, { titre: "Titre pirate" })).body.error === put2.body.error, put2.body);

  const putX = await appeler("put", `/api/ordres-travaux/${otX.id}`, T.r1, { titre: "Titre pirate" });
  verifier("F1 ecriture : un OT SANS region est refuse au compte regional (region inconnue)", putX.status === 404 || putX.status === 403, putX.status);

  const putDans = await appeler("put", `/api/ordres-travaux/${ot1.id}`, T.r1, { titre: "Titre legitime" });
  verifier("F1 non-regression : le MEME compte modifie un OT de sa region (200) ; la trace d'audit est ecrite",
    putDans.status === 200 && (await ligneOt(ot1.id)).titre === "Titre legitime" && await audits(ot1.id) >= 1, [putDans.status, putDans.body]);
  const putVers = await appeler("put", `/api/ordres-travaux/${ot1.id}`, T.r1, { regionId: R2 });
  verifier("F1 ecriture : deplacer un OT de R1 vers R2 est refuse (403 HORS_PERIMETRE, la region d'apres compte) et l'OT reste en R1",
    refus403(putVers, "HORS_PERIMETRE") && (await ligneOt(ot1.id)).regionId === R1, [putVers.status, putVers.body]);
  const asgDans = await appeler("post", `/api/ordres-travaux/${ot1.id}/assigner`, T.r1, { assigneAId: inspR1.id });
  verifier("F1 non-regression : assigner un OT de sa region reste possible (200)", asgDans.status === 200, [asgDans.status, asgDans.body]);

  const avantCreation = await compter(`SELECT count(*) n FROM ordres_travaux`);
  const cR2 = await appeler("post", "/api/ordres-travaux", T.r1, { titre: "Creation hors zone", typeIntervention: "AUTRE", regionId: R2 });
  const cTr2 = await appeler("post", "/api/ordres-travaux", T.r1, { titre: "Creation via troncon hors zone", typeIntervention: "AUTRE", tronconId: T2.id });
  const cSans = await appeler("post", "/api/ordres-travaux", T.r1, { titre: "Creation sans region", typeIntervention: "AUTRE" });
  verifier("F1 ecriture : creer un OT en R2 (region explicite ou heritee du troncon) ou sans region exploitable est refuse au compte regional (403) et n'ecrit RIEN",
    refus403(cR2, "HORS_PERIMETRE") && refus403(cTr2, "HORS_PERIMETRE") && refus403(cSans, "REGION_INCONNUE") && await compter(`SELECT count(*) n FROM ordres_travaux`) === avantCreation,
    [cR2.status, cTr2.status, cSans.status]);
  const cR1 = await appeler("post", "/api/ordres-travaux", T.r1, { titre: "Creation legitime", typeIntervention: "AUTRE", regionId: R1 });
  const cTr1 = await appeler("post", "/api/ordres-travaux", T.r1, { titre: "Creation legitime via troncon", typeIntervention: "AUTRE", tronconId: T1.id });
  verifier("F1 non-regression : creer un OT en R1 (region explicite ou heritee du troncon) reste possible (201)", cR1.status === 201 && cTr1.status === 201, [cR1.status, cTr1.status, cR1.body]);
  const cNat = await appeler("post", "/api/ordres-travaux", T.nat, { titre: "Creation nationale", typeIntervention: "AUTRE", regionId: R2 });
  const cNatSans = await appeler("post", "/api/ordres-travaux", T.nat, { titre: "Creation nationale sans region", typeIntervention: "AUTRE" });
  verifier("F1 non-regression : le compte national cree en R2 et sans region comme avant (201)", cNat.status === 201 && cNatSans.status === 201, [cNat.status, cNatSans.status]);
  const putNat = await appeler("put", `/api/ordres-travaux/${ot2.id}`, T.nat, { titre: "Titre national" });
  verifier("F1 non-regression : le compte national modifie l'OT de R2 (200)", putNat.status === 200, putNat.status);

  // ================================================================ F5. INSPECTEUR et ordres de travaux
  console.log("\n== F5. INSPECTEUR : un ordre de travaux qui n'est ni le sien ni assigne a lui ==");
  const avant1 = await ligneOt(ot1.id);
  // ot1 vient d'etre assigne a inspR1 par le test precedent : on prend ot1c (cree par lui) et un OT qui n'est pas le sien.
  const autre = await mkOt("OT-ACC-AUTRE", R1, { assigneAId: gestR1.id, statut: "ASSIGNE" });
  const putAutre = await appeler("put", `/api/ordres-travaux/${autre.id}`, T.insp, { coutReelGnf: 1, entreprise: "Entreprise pirate" });
  const photoAutre = await prisma.otPhoto.create({ data: { otId: autre.id, fileName: "acces-autre.jpg" } });
  const phAutre = await appeler("delete", `/api/ordres-travaux/${autre.id}/photos/${photoAutre.id}`, T.insp);
  const stAutre = await appeler("post", `/api/ordres-travaux/${autre.id}/statut`, T.insp, { statut: "EN_COURS" });
  const apresAutre = await ligneOt(autre.id);
  verifier("F5 ecriture : un INSPECTEUR ne peut ni modifier ni changer le statut ni retirer une photo d'un OT qui n'est ni le sien ni assigne a lui (404, comme un OT inconnu), et l'OT reste intact",
    putAutre.status === 404 && stAutre.status === 404 && phAutre.status === 404 && (await prisma.otPhoto.findUnique({ where: { id: photoAutre.id } }))?.deletedAt === null && apresAutre.entreprise === null && apresAutre.statut === "ASSIGNE", [putAutre.status, stAutre.status, phAutre.status, apresAutre]);
  // D9, point 5 : indiscernable d'un identifiant inconnu, statut ET corps, y compris avec un corps invalide.
  const inconnuOt = randomUUID();
  const memeReponse = async (verbe: Verbe, chemin: (id: string) => string, corps?: unknown) => {
    const a = await appeler(verbe, chemin(autre.id), T.insp, corps), b = await appeler(verbe, chemin(inconnuOt), T.insp, corps);
    return a.status === b.status && JSON.stringify(a.body) === JSON.stringify(b.body) ? null : [verbe, chemin("x"), a.status, a.body, b.status, b.body];
  };
  const ecarts = (await Promise.all([
    memeReponse("put", (id) => `/api/ordres-travaux/${id}`, { statut: 123 }),
    memeReponse("put", (id) => `/api/ordres-travaux/${id}`, { coutReelGnf: 1 }),
    memeReponse("post", (id) => `/api/ordres-travaux/${id}/statut`, {}),
    memeReponse("post", (id) => `/api/ordres-travaux/${id}/statut`, { statut: "TERMINE" }),
    memeReponse("delete", (id) => `/api/ordres-travaux/${id}/photos/${randomUUID()}`),
  ])).filter((x) => x !== null);
  verifier("D9 point 5 : pour un INSPECTEUR, l'OT d'autrui et l'OT inconnu rendent le MEME statut et le MEME corps sur PUT, statut (corps vide, valide, transition interdite) et retrait de photo", ecarts.length === 0, ecarts);
  // D9, point 5 (oracle d'existence) : un compte REGIONAL ne distingue pas l'OT d'une autre region (ou sans region) d'un identifiant inconnu.
  const reg = [] as unknown[];
  for (const [verbe, chemin, corps] of [
    ["post", (id: string) => `/api/ordres-travaux/${id}/statut`, {}], ["post", (id: string) => `/api/ordres-travaux/${id}/assigner`, {}],
    ["put", (id: string) => `/api/ordres-travaux/${id}`, { statut: 123 }], ["post", (id: string) => `/api/ordres-travaux/${id}/convertir-chantier`, undefined],
    ["delete", (id: string) => `/api/ordres-travaux/${id}/photos/${randomUUID()}`, undefined], ["get", (id: string) => `/api/ordres-travaux/${id}`, undefined],
  ] as Array<[Verbe, (id: string) => string, unknown]>) {
    const hors = await appeler(verbe, chemin(ot2.id), T.r1, corps), sans = await appeler(verbe, chemin(otX.id), T.r1, corps), inconnu = await appeler(verbe, chemin(randomUUID()), T.r1, corps);
    if (hors.status !== inconnu.status || JSON.stringify(hors.body) !== JSON.stringify(inconnu.body) || JSON.stringify(sans.body) !== JSON.stringify(inconnu.body)) reg.push([verbe, chemin("x"), hors.status, hors.body, sans.body, inconnu.status, inconnu.body]);
  }
  verifier("D9 point 5 : compte REGIONAL : OT d'une autre region, OT sans region et OT inconnu rendent le MEME statut et le MEME corps (404) sur statut, assigner, modification, conversion, photo et lecture, corps invalide compris", reg.length === 0, reg);
  const putSien = await appeler("put", `/api/ordres-travaux/${ot1b.id}`, T.insp, { description: "Constat de l'inspecteur" });
  const putCree = await appeler("put", `/api/ordres-travaux/${ot1c.id}`, T.insp, { description: "Brouillon complete" });
  verifier("F5 non-regression : l'INSPECTEUR modifie l'OT qui lui est assigne et celui qu'il a cree (200)", putSien.status === 200 && putCree.status === 200, [putSien.status, putCree.status]);
  const putResp = await appeler("put", `/api/ordres-travaux/${autre.id}`, T.r1, { description: "Complement du responsable" });
  verifier("F5 non-regression : le GESTIONNAIRE de la region modifie n'importe quel OT de sa region (200)", putResp.status === 200, putResp.status);
  void avant1;

  // ================================================================ F2. Missions
  console.log("\n== F2. Missions ==");
  const mr1 = await appeler("get", "/api/v2/missions?limite=100", T.r1);
  const idsM = (mr1.body as { id: string }[]).map((m) => m.id);
  verifier("F2 lecture : la liste des missions du compte regional ne contient que R1 (ni R2, ni sans region)",
    mr1.status === 200 && idsM.includes(m1.id) && !idsM.includes(m2.id) && !idsM.includes(mX.id), idsM.length);
  const mnat = await appeler("get", "/api/v2/missions?limite=100", T.nat);
  verifier("F2 non-regression : le compte national voit les 3 missions", mnat.status === 200 && (mnat.body as unknown[]).length === 3, (mnat.body as unknown[]).length);
  const mg2 = await appeler("get", `/api/v2/missions/${m2.id}`, T.r1);
  const mgX = await appeler("get", `/api/v2/missions/${mX.id}`, T.r1);
  const mg1 = await appeler("get", `/api/v2/missions/${m1.id}`, T.r1);
  const mgInc = await appeler("get", `/api/v2/missions/${randomUUID()}`, T.r1);
  verifier("F2 lecture : la fiche d'une mission de R2 ou sans region est un 404 identique a une mission inconnue pour le compte regional ; celle de R1 : 200",
    mg2.status === 404 && mgX.status === 404 && mgInc.status === 404 && mg1.status === 200 && mg2.body.message === mgInc.body.message, [mg2.status, mgX.status, mg1.status]);
  const ligneM = async (id: string) => (await sql<{ statut: string; debutReel: Date | null }>(`SELECT statut::text AS statut, "debutReel" FROM missions WHERE id = $1`, id))[0];
  const avantM2 = await ligneM(m2.id); const audM2 = await audits(m2.id);
  const ms2 = await appeler("post", `/api/v2/missions/${m2.id}/statut`, T.r1, { statut: "PLANIFIEE" });
  verifier("F2 ecriture : changer le statut d'une mission de R2 est refuse au compte regional (404) ; la mission est inchangee et SANS trace d'audit",
    ms2.status === 404 && JSON.stringify(await ligneM(m2.id)) === JSON.stringify(avantM2) && await audits(m2.id) === audM2, [ms2.status, ms2.body]);
  const ms1 = await appeler("post", `/api/v2/missions/${m1.id}/statut`, T.r1, { statut: "PLANIFIEE" });
  verifier("F2 non-regression : le MEME compte fait avancer une mission de sa region (200, trace d'audit)", ms1.status === 200 && (await ligneM(m1.id)).statut === "PLANIFIEE" && await audits(m1.id) >= 1, [ms1.status, ms1.body]);
  const avantMC = await compter(`SELECT count(*) n FROM missions`);
  const mc2 = await appeler("post", "/api/v2/missions", T.r1, { code: "MIS-ACC-HZ", intitule: "Mission hors zone", type: "INSPECTION", regionId: R2 });
  const mcX = await appeler("post", "/api/v2/missions", T.r1, { code: "MIS-ACC-SR", intitule: "Mission sans region", type: "INSPECTION" });
  verifier("F2 ecriture : creer une mission en R2, ou sans region, est refuse au compte regional (403) et n'ecrit RIEN",
    refus403(mc2, "HORS_PERIMETRE") && refus403(mcX, "REGION_INCONNUE") && await compter(`SELECT count(*) n FROM missions`) === avantMC, [mc2.status, mcX.status]);
  const mc1 = await appeler("post", "/api/v2/missions", T.r1, { code: "MIS-ACC-OK", intitule: "Mission legitime", type: "INSPECTION", regionId: R1 });
  const mcNat = await appeler("post", "/api/v2/missions", T.nat, { code: "MIS-ACC-NAT", intitule: "Mission nationale", type: "INSPECTION" });
  verifier("F2 non-regression : creation en R1 par le compte regional (201) ; sans region par le compte national (201)", mc1.status === 201 && mcNat.status === 201, [mc1.status, mcNat.status]);

  // ================================================================ F3. Programmation manuelle
  console.log("\n== F3. Programmation manuelle ==");
  const pl = await appeler("get", "/api/v2/programmation?pageSize=100", T.r1);
  const idsP = ids(pl);
  verifier("F3 lecture : la liste des previsions du compte regional ne contient que celles dont le troncon est en R1 (ni R2, ni sans troncon)",
    pl.status === 200 && idsP.includes(p1.id) && !idsP.includes(p2.id) && !idsP.includes(pX.id), idsP.length);
  verifier("F3 lecture : le total de la liste suit le perimetre", pl.body.total === 1, pl.body.total);
  const plNat = await appeler("get", "/api/v2/programmation?pageSize=100", T.nat);
  verifier("F3 non-regression : le compte national voit les 3 previsions", plNat.body.total === 3, plNat.body.total);
  const pt = await appeler("get", "/api/v2/programmation/totaux", T.r1);
  const ptNat = await appeler("get", "/api/v2/programmation/totaux", T.nat);
  const sommeAn = (r: Rep) => (r.body.parAnnee ?? []).reduce((s: bigint, a: { montantGnf: string }) => s + BigInt(a.montantGnf), 0n);
  verifier("F3 lecture : les totaux du compte regional ne somment que sa region (1000 GNF), ceux du national les trois lignes (1000 + 20 + 300000 = 301020)",
    pt.status === 200 && sommeAn(pt) === 1000n && sommeAn(ptNat) === 301020n, [String(sommeAn(pt)), String(sommeAn(ptNat))]);

  const ligneP = async (id: string) => (await sql<{ intitule: string; montantPrevuGnf: string; deletedAt: Date | null; statut: string }>(
    `SELECT intitule, "montantPrevuGnf"::text AS "montantPrevuGnf", "deletedAt", statut FROM programmes_budgetaires WHERE id = $1::uuid`, id))[0];
  const avantP2 = await ligneP(p2.id); const audP2 = await audits(p2.id);
  const pp2 = await appeler("patch", `/api/v2/programmation/${p2.id}`, T.r1, { montantPrevuGnf: "999999999", statut: "RETENU" });
  const ps2 = await appeler("post", `/api/v2/programmation/${p2.id}/supprimer`, T.r1);
  const ppX = await appeler("patch", `/api/v2/programmation/${pX.id}`, T.r1, { montantPrevuGnf: "1" });
  verifier("F3 ecriture : modifier ou supprimer une prevision de R2 (ou sans troncon) est refuse au compte regional (404) ; la ligne est inchangee et SANS trace d'audit",
    pp2.status === 404 && ps2.status === 404 && ppX.status === 404 && JSON.stringify(await ligneP(p2.id)) === JSON.stringify(avantP2) && await audits(p2.id) === audP2, [pp2.status, ps2.status, ppX.status]);
  const pp1 = await appeler("patch", `/api/v2/programmation/${p1.id}`, T.r1, { montantPrevuGnf: "1500" });
  verifier("F3 non-regression : le MEME compte modifie une prevision de sa region (200)", pp1.status === 200 && (await ligneP(p1.id)).montantPrevuGnf === "1500", [pp1.status, pp1.body]);
  const ppVers = await appeler("patch", `/api/v2/programmation/${p1.id}`, T.r1, { tronconId: T2.id });
  verifier("F3 ecriture : rattacher une prevision de R1 a un troncon de R2 est refuse (403 HORS_PERIMETRE)", refus403(ppVers, "HORS_PERIMETRE"), [ppVers.status, ppVers.body]);
  const avantPC = await compter(`SELECT count(*) n FROM programmes_budgetaires`);
  const pc2 = await appeler("post", "/api/v2/programmation", T.r1, { annee: 2027, intitule: "Prevision hors zone", montantPrevuGnf: "10", tronconId: T2.id });
  const pcX = await appeler("post", "/api/v2/programmation", T.r1, { annee: 2027, intitule: "Prevision sans troncon", montantPrevuGnf: "10" });
  verifier("F3 ecriture : creer une prevision sur un troncon de R2, ou sans troncon, est refuse au compte regional (403) et n'ecrit RIEN",
    refus403(pc2, "HORS_PERIMETRE") && refus403(pcX, "REGION_INCONNUE") && await compter(`SELECT count(*) n FROM programmes_budgetaires`) === avantPC, [pc2.status, pcX.status]);
  const pc1 = await appeler("post", "/api/v2/programmation", T.r1, { annee: 2027, intitule: "Prevision legitime", montantPrevuGnf: "10", tronconId: T1.id });
  const pcNat = await appeler("post", "/api/v2/programmation", T.nat, { annee: 2027, intitule: "Prevision nationale", montantPrevuGnf: "10" });
  verifier("F3 non-regression : creation sur un troncon de R1 par le compte regional (201) ; sans troncon par le compte national (201)", pc1.status === 201 && pcNat.status === 201, [pc1.status, pcNat.status]);
  const psNat = await appeler("post", `/api/v2/programmation/${p2.id}/supprimer`, T.nat);
  verifier("F3 non-regression : le compte national supprime (logiquement) la prevision de R2 (200)", psNat.status === 200 && (await ligneP(p2.id)).deletedAt !== null, psNat.status);

  // ================================================================ F4. Observations et defauts
  console.log("\n== F4. Observations et defauts ==");
  const ol = await appeler("get", "/api/v2/observations?limite=100", T.r1);
  const idsO = (ol.body.observations ?? []).map((o: { id: string }) => o.id);
  verifier("F4 lecture : le GESTIONNAIRE regional (R1) ne voit dans la liste des observations que celles de R1", ol.status === 200 && idsO.includes(o1.id) && !idsO.includes(o2.id), idsO.length);
  const olNat = await appeler("get", "/api/v2/observations?limite=100", T.nat);
  verifier("F4 non-regression : le GESTIONNAIRE national voit les deux", olNat.body.observations.length === 2, olNat.body.observations?.length);
  const og2 = await appeler("get", `/api/v2/observations/${o2.id}`, T.r1);
  const og1 = await appeler("get", `/api/v2/observations/${o1.id}`, T.r1);
  const ogInc = await appeler("get", `/api/v2/observations/${randomUUID()}`, T.r1);
  verifier("F4 lecture : la fiche d'une observation de R2 est un 404 identique a une observation inconnue ; celle de R1 : 200",
    og2.status === 404 && ogInc.status === 404 && og1.status === 200 && og2.body.message === ogInc.body.message, [og2.status, og1.status]);
  const dl = await appeler("get", "/api/v2/defauts?limite=100", T.r1);
  const idsD = (dl.body.defauts ?? []).map((d: { id: string }) => d.id);
  verifier("F4 lecture : le GESTIONNAIRE regional ne voit dans la liste des defauts que ceux de R1", dl.status === 200 && idsD.includes(d1.id) && !idsD.includes(d2.id), idsD.length);
  const dlNat = await appeler("get", "/api/v2/defauts?limite=100", T.nat);
  verifier("F4 non-regression : le GESTIONNAIRE national voit les deux defauts", dlNat.body.defauts.length === 2, dlNat.body.defauts?.length);
  const dg2 = await appeler("get", `/api/v2/defauts/${d2.id}`, T.r1);
  const dg1 = await appeler("get", `/api/v2/defauts/${d1.id}`, T.r1);
  verifier("F4 lecture : la fiche d'un defaut de R2 est un 404 pour le compte regional ; celle de R1 : 200", dg2.status === 404 && dg1.status === 200, [dg2.status, dg1.status]);

  // La redescente de synchronisation est une AUTRE route de lecture des memes lignes : meme perimetre.
  const pullO = await appeler("post", "/api/v2/sync/pull", T.r1, { entityType: "Observation" });
  const pullD = await appeler("post", "/api/v2/sync/pull", T.r1, { entityType: "Defaut" });
  const pullONat = await appeler("post", "/api/v2/sync/pull", T.nat, { entityType: "Observation" });
  const pullDNat = await appeler("post", "/api/v2/sync/pull", T.nat, { entityType: "Defaut" });
  const idsPullO = (pullO.body.observations ?? []).map((o: { id: string }) => o.id);
  const idsPullD = (pullD.body.defauts ?? []).map((d: { id: string }) => d.id);
  verifier("F4 lecture : la redescente (POST /v2/sync/pull) du GESTIONNAIRE regional ne rend que les observations et les defauts de R1",
    pullO.status === 200 && idsPullO.includes(o1.id) && !idsPullO.includes(o2.id) && pullD.status === 200 && idsPullD.includes(d1.id) && !idsPullD.includes(d2.id), [idsPullO.length, idsPullD.length]);
  verifier("F4 non-regression : la redescente du GESTIONNAIRE national rend les deux observations et les deux defauts",
    pullONat.body.observations?.length === 2 && pullDNat.body.defauts?.length === 2, [pullONat.body.observations?.length, pullDNat.body.defauts?.length]);

  // ================================================================ F6. Moteur de programmation (scenarios, fiches figees, plans)
  console.log("\n== F6. Moteur de programmation ==");
  const param = (await sql<{ id: string; version: string }>(`SELECT id, version FROM parametres_programmation ORDER BY "createdAt" LIMIT 1`))[0];
  const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
  const mkScenario = async (intitule: string, rid: number | null) => {
    const id = randomUUID();
    const entrees = JSON.stringify({ annee: 2027, budgetGnf: "1000", parametres: { version: param.version } });
    const resultat = JSON.stringify({ annee: 2027, parametres: { version: param.version }, totaux: { engageGnf: 0, retenues: 0, ecartees: 0 }, provisoire: true, lignes: [] });
    await prisma.$executeRawUnsafe(
      `INSERT INTO scenarios_programmation (id, annee, intitule, "parametresId", "parametresVersion", "budgetGnf", perimetre, "entreesCanoniques", "empreinteEntrees",
         "resultatCanonique", "empreinteResultat", "nbRetenues", "nbEcartees", "montantEngageGnf", provisoire, "creeParId")
       VALUES ($1, 2027, $2, $3, $4, 1000, $5::jsonb, $6, $7, $8, $9, 0, 0, 0, true, $10)`,
      id, intitule, param.id, param.version, JSON.stringify({ classe: null, regionId: rid }), entrees, sha(entrees), resultat, sha(resultat), admin.id);
    return id;
  };
  const mkFiche = async (scenarioId: string, tronconId: string, reference: string) => {
    const id = randomUUID();
    const contenu = JSON.stringify({ schema: "fiche-intervention/1", annee: 2027, parametres: { version: param.version }, scenario: { id: scenarioId }, patrimoine: { tronconId } });
    await prisma.$executeRawUnsafe(
      `INSERT INTO fiches_intervention (id, reference, "scenarioId", "tronconId", annee, "parametresVersion", "contenuCanonique", "empreinteSha256", "figeParId")
       VALUES ($1, $2, $3, $4, 2027, $5, $6, $7, $8)`, id, reference, scenarioId, tronconId, param.version, contenu, sha(contenu), admin.id);
    await prisma.$executeRawUnsafe(
      `INSERT INTO fiches_intervention_statuts ("ficheId", rang, de, vers, origine, "auteurId") VALUES ($1, 1, NULL, 'BROUILLON', 'GEOPORTAIL', $2)`, id, admin.id);
    return id;
  };
  const mkPlan = async (intitule: string, rid: number | null) => {
    const id = randomUUID();
    const entrees = JSON.stringify({ anneeDebut: 2027, nbAnnees: 2, enveloppes: [{ budgetGnf: "100" }, { budgetGnf: "100" }], parametres: { version: param.version } });
    const resultat = JSON.stringify({ anneeDebut: 2027, nbAnnees: 2, parametres: { version: param.version }, synthese: { enveloppeTotaleGnf: 200, engageTotalGnf: 0, retenus: 0, nonRetenus: 0 }, provisoire: true });
    await prisma.$executeRawUnsafe(
      `INSERT INTO plans_pluriannuels (id, intitule, "anneeDebut", "nbAnnees", "parametresId", "parametresVersion", "enveloppeTotaleGnf", perimetre, "entreesCanoniques", "empreinteEntrees",
         "resultatCanonique", "empreinteResultat", "nbRetenus", "nbNonRetenus", "montantEngageGnf", provisoire, "creeParId")
       VALUES ($1, $2, 2027, 2, $3, $4, 200, $5::jsonb, $6, $7, $8, $9, 0, 0, 0, true, $10)`,
      id, intitule, param.id, param.version, JSON.stringify({ classe: null, regionId: rid }), entrees, sha(entrees), resultat, sha(resultat), admin.id);
    return id;
  };
  const S1 = await mkScenario("Scenario acces R1", R1);
  const S2 = await mkScenario("Scenario acces R2", R2);
  const SN = await mkScenario("Scenario acces national", null);
  const F1id = await mkFiche(S1, T1.id, "FI-ACC-1");
  const F2id = await mkFiche(S2, T2.id, "FI-ACC-2");
  const PL1 = await mkPlan("Plan acces R1", R1);
  const PL2 = await mkPlan("Plan acces R2", R2);
  const PLN = await mkPlan("Plan acces national", null);

  const sl = await appeler("get", "/api/v2/programmation/moteur/simulations?pageSize=100", T.r1);
  const idsS = ids(sl);
  verifier("F6 lecture : la liste des scenarios du compte regional ne contient que celui de R1 (ni R2, ni le calcul national)",
    sl.status === 200 && idsS.includes(S1) && !idsS.includes(S2) && !idsS.includes(SN) && sl.body.total === 1, [sl.status, sl.body.total]);
  const slNat = await appeler("get", "/api/v2/programmation/moteur/simulations?pageSize=100", T.nat);
  verifier("F6 non-regression : le compte national voit les trois scenarios", slNat.body.total === 3, slNat.body.total);
  const sg2 = await appeler("get", `/api/v2/programmation/moteur/simulations/${S2}`, T.r1);
  const sgN = await appeler("get", `/api/v2/programmation/moteur/simulations/${SN}`, T.r1);
  const sg1 = await appeler("get", `/api/v2/programmation/moteur/simulations/${S1}`, T.r1);
  const sgInc = await appeler("get", `/api/v2/programmation/moteur/simulations/${randomUUID()}`, T.r1);
  verifier("F6 lecture : le detail d'un scenario de R2 ou national est un 404 identique a un scenario inconnu pour le compte regional ; celui de R1 : 200",
    sg2.status === 404 && sgN.status === 404 && sgInc.status === 404 && sg1.status === 200 && JSON.stringify(sg2.body) === JSON.stringify(sgInc.body), [sg2.status, sgN.status, sg1.status, sg2.body, sgInc.body]);
  const sr2 = await appeler("post", `/api/v2/programmation/moteur/simulations/${S2}/rejouer`, T.r1);
  const ss2 = await appeler("post", `/api/v2/programmation/moteur/simulations/${S2}/supprimer`, T.r1);
  const sf2 = await appeler("post", `/api/v2/programmation/moteur/simulations/${S2}/fiches`, T.r1, {});
  verifier("F6 ecriture : rejouer, supprimer ou figer les fiches d'un scenario de R2 est un 404 pour le compte regional ; le scenario n'est pas supprime",
    sr2.status === 404 && ss2.status === 404 && sf2.status === 404 && await compter(`SELECT count(*) n FROM scenarios_programmation WHERE id = $1 AND "deletedAt" IS NULL`, S2) === 1, [sr2.status, ss2.status, sf2.status]);
  const ss2nat = await appeler("post", `/api/v2/programmation/moteur/simulations/${SN}/supprimer`, T.nat);
  verifier("F6 non-regression : le compte national supprime (logiquement) un calcul national (200)", ss2nat.status === 200, [ss2nat.status, ss2nat.body]);
  const cn = await appeler("post", "/api/v2/programmation/moteur/simulations", T.r1, { annee: 2027, intitule: "Calcul national", budgetGnf: "1000" });
  const c2 = await appeler("post", "/api/v2/programmation/moteur/simulations", T.r1, { annee: 2027, intitule: "Calcul R2", budgetGnf: "1000", regionId: R2 });
  verifier("F6 ecriture : un compte regional ne lance ni un calcul NATIONAL (sans region) ni un calcul sur R2 : 403, rien n'est enregistre",
    refus403(cn, "REGION_INCONNUE") && refus403(c2, "HORS_PERIMETRE") && await compter(`SELECT count(*) n FROM scenarios_programmation WHERE intitule IN ('Calcul national','Calcul R2')`) === 0, [cn.status, c2.status]);
  const c1 = await appeler("post", "/api/v2/programmation/moteur/simulations", T.r1, { annee: 2027, intitule: "Calcul R1", budgetGnf: "1000", regionId: R1 });
  const cNatSim = await appeler("post", "/api/v2/programmation/moteur/simulations", T.nat, { annee: 2027, intitule: "Calcul national autorise", budgetGnf: "1000" });
  verifier("F6 non-regression : le compte regional calcule sur SA region (201), le compte national calcule sans region (201)",
    c1.status === 201 && cNatSim.status === 201, [c1.status, cNatSim.status, c1.body?.code]);

  const fl = await appeler("get", "/api/v2/programmation/moteur/fiches?pageSize=100", T.r1);
  const idsF = ids(fl);
  verifier("F6 lecture : la liste des fiches figees du compte regional ne contient que celle du troncon de R1", fl.status === 200 && idsF.includes(F1id) && !idsF.includes(F2id) && fl.body.total === 1, [fl.status, fl.body.total]);
  const flNat = await appeler("get", "/api/v2/programmation/moteur/fiches?pageSize=100", T.nat);
  verifier("F6 non-regression : le compte national voit les deux fiches", flNat.body.total === 2, flNat.body.total);
  const fg2 = await appeler("get", `/api/v2/programmation/moteur/fiches/${F2id}`, T.r1);
  const fv2 = await appeler("get", `/api/v2/programmation/moteur/fiches/${F2id}/verification`, T.r1);
  const fg1 = await appeler("get", `/api/v2/programmation/moteur/fiches/${F1id}`, T.r1);
  const fgInc = await appeler("get", `/api/v2/programmation/moteur/fiches/${randomUUID()}`, T.r1);
  verifier("F6 lecture : le detail et la verification d'une fiche de R2 sont un 404 identique a une fiche inconnue ; celle de R1 : 200",
    fg2.status === 404 && fv2.status === 404 && fgInc.status === 404 && fg1.status === 200 && JSON.stringify(fg2.body) === JSON.stringify(fgInc.body), [fg2.status, fv2.status, fg1.status]);
  const fs2 = await appeler("post", `/api/v2/programmation/moteur/fiches/${F2id}/statut`, T.r1, { vers: "PROPOSE" });
  const rangs2 = await compter(`SELECT count(*) n FROM fiches_intervention_statuts WHERE "ficheId" = $1`, F2id);
  verifier("F6 ecriture : faire avancer la fiche d'un troncon de R2 est un 404 pour le compte regional ; la chaine de statuts de la fiche est inchangee (1 entree) et sans audit",
    fs2.status === 404 && rangs2 === 1 && await audits(F2id) === 0, [fs2.status, rangs2]);
  const fs1 = await appeler("post", `/api/v2/programmation/moteur/fiches/${F1id}/statut`, T.r1, { vers: "PROPOSE" });
  verifier("F6 non-regression : le MEME compte fait avancer la fiche de sa region (201) ; la chaine compte 2 entrees", fs1.status === 201 && await compter(`SELECT count(*) n FROM fiches_intervention_statuts WHERE "ficheId" = $1`, F1id) === 2, [fs1.status, fs1.body]);

  const plPpe = await appeler("get", "/api/v2/programmation/moteur/ppe/simulations?pageSize=100", T.r1);
  const idsPl = ids(plPpe);
  verifier("F6 lecture : la liste des plans pluriannuels du compte regional ne contient que celui de R1", plPpe.status === 200 && idsPl.includes(PL1) && !idsPl.includes(PL2) && !idsPl.includes(PLN) && plPpe.body.total === 1, [plPpe.status, plPpe.body.total]);
  const plNatPpe = await appeler("get", "/api/v2/programmation/moteur/ppe/simulations?pageSize=100", T.nat);
  verifier("F6 non-regression : le compte national voit les trois plans", plNatPpe.body.total === 3, plNatPpe.body.total);
  const pg2 = await appeler("get", `/api/v2/programmation/moteur/ppe/simulations/${PL2}`, T.r1);
  const pg1 = await appeler("get", `/api/v2/programmation/moteur/ppe/simulations/${PL1}`, T.r1);
  const pgInc = await appeler("get", `/api/v2/programmation/moteur/ppe/simulations/${randomUUID()}`, T.r1);
  const ps2b = await appeler("post", `/api/v2/programmation/moteur/ppe/simulations/${PL2}/supprimer`, T.r1);
  verifier("F6 lecture et ecriture : le detail d'un plan de R2 et sa suppression sont un 404 identique a un plan inconnu pour le compte regional (plan non supprime) ; celui de R1 : 200",
    pg2.status === 404 && pgInc.status === 404 && pg1.status === 200 && JSON.stringify(pg2.body) === JSON.stringify(pgInc.body) && ps2b.status === 404
    && await compter(`SELECT count(*) n FROM plans_pluriannuels WHERE id = $1 AND "deletedAt" IS NULL`, PL2) === 1, [pg2.status, pg1.status, ps2b.status]);
  const pcPpeN = await appeler("post", "/api/v2/programmation/moteur/ppe/simulations", T.r1, { anneeDebut: 2027, intitule: "Plan national", enveloppes: [{ budgetGnf: "100" }, { budgetGnf: "100" }] });
  const pcPpe2 = await appeler("post", "/api/v2/programmation/moteur/ppe/simulations", T.r1, { anneeDebut: 2027, intitule: "Plan R2", enveloppes: [{ budgetGnf: "100" }, { budgetGnf: "100" }], regionId: R2 });
  verifier("F6 ecriture : un compte regional ne lance ni un plan NATIONAL ni un plan sur R2 : 403, rien n'est enregistre",
    refus403(pcPpeN, "REGION_INCONNUE") && refus403(pcPpe2, "HORS_PERIMETRE") && await compter(`SELECT count(*) n FROM plans_pluriannuels WHERE intitule IN ('Plan national','Plan R2')`) === 0, [pcPpeN.status, pcPpe2.status]);

  // ================================================================ M. Modules : ce qui est deja garde, ce qui est ouvert A DESSEIN
  console.log("\n== M. Modules ==");
  const motOt = await appeler("get", "/api/ordres-travaux", T.sans);
  const motProg = await appeler("get", "/api/v2/programmation", T.sans);
  const motMis = await appeler("get", "/api/v2/missions", T.sans);
  const motObs = await appeler("get", "/api/v2/observations", T.sans);
  verifier("M garde existante : un compte SANS module est refuse (403) sur les OT, la programmation, les missions et les observations",
    [motOt, motProg, motMis, motObs].every((r) => r.status === 403), [motOt.status, motProg.status, motMis.status, motObs.status]);
  const motGeoOt = await appeler("get", "/api/ordres-travaux", T.geo);
  verifier("M garde existante : un compte qui n'a que `geoportail` est refuse sur les OT (403)", motGeoOt.status === 403, motGeoOt.status);

  await prisma.chantier.create({ data: { intitule: "Chantier acces", entreprise: "Entreprise Confidentielle", bailleur: "Bailleur X", montantGnf: 123456789n, regionId: R2, numContrat: "CT-ACC-1" } });
  const chL = await appeler("get", "/api/chantiers?pageSize=50", T.geo);
  const chG = await appeler("get", "/api/chantiers/geo", T.geo);
  const chRow = (chL.body.data ?? []).find((c: { intitule: string }) => c.intitule === "Chantier acces");
  verifier("CONSTAT (VOULU a ce jour, decision D-C1-1 en attente) : un compte qui n'a que `geoportail` lit la LISTE v1 des chantiers avec entreprise, bailleur, montant et numero de contrat (lecture v1 ouverte, la fiche de troncon et la carte s'en servent)",
    chL.status === 200 && chRow?.entreprise === "Entreprise Confidentielle" && chRow?.montantGnf !== null && chRow?.numContrat === "CT-ACC-1", chRow);
  verifier("CONSTAT (idem) : la route /chantiers/geo de la carte porte les memes champs financiers", chG.status === 200, chG.status);
  const chId = await appeler("get", `/api/chantiers/${chRow?.id ?? randomUUID()}`, T.geo);
  verifier("CONSTAT : la FICHE d'un chantier (GET /chantiers/:id) exige elle le role GESTIONNAIRE et le module `chantiers` : un LECTEUR n'y a pas acces (403)", chId.status === 403, chId.status);
  const trL = await appeler("get", "/api/troncons?pageSize=50", T.sans);
  verifier("CONSTAT (VOULU, commentaire de troncons.routes.ts) : un compte sans AUCUN module lit la liste v1 des troncons (referentiel : selecteurs, carte)", trL.status === 200, trL.status);

  // Ce qui est ouvert FAUTE DE DECISION (documents, exploitation, role des comptes de lecture sur la collecte de terrain) : le banc le
  // CONSIGNE pour que la decision, quand elle viendra, se traduise par un changement de test et non par une surprise.
  const docL = await appeler("get", "/api/documents?pageSize=5", T.sans);
  const mcL = await appeler("get", "/api/v2/exploitation/main-courante/evenements", T.sans);
  const tdL = await appeler("get", "/api/v2/teledetection/produits", T.sans);
  verifier("CONSTAT (decisions D-C1-3 et D-C1-4 en attente) : un compte SANS AUCUN module et a role LECTEUR lit la liste des documents, la main courante et les produits de teledetection (200)",
    docL.status === 200 && mcL.status === 200 && tdL.status === 200, [docL.status, mcL.status, tdL.status]);
  const lectInsp = await mkUser("lectinsp@acces.invalid", "LECTEUR", ["inspections"]);
  const dev = await appeler("post", "/api/v2/devices", jeton(lectInsp), { plateforme: "android", nom: "Telephone d'un LECTEUR" });
  verifier("CONSTAT (decision D-C1-6 en attente) : un compte de role LECTEUR qui a le module `inspections` enregistre un appareil de collecte (201) : aucune route de collecte v2 ne controle le role, seulement le module et la portee par agent",
    dev.status === 201, [dev.status, dev.body]);

  // D-C1-9 (corrige, 25/10/2026) : la garde de role ADMIN/GESTIONNAIRE ne s'applique plus qu'aux deux routes d'archivage en masse ;
  // l'INSPECTEUR saisit (POST), relit et modifie SA PROPRE inspection (GET, PUT), et le LECTEUR reste exclu des fiches.
  const iDate = new Date().toISOString();
  const insPost = await appeler("post", "/api/inspections", T.insp, { tronconId: T1.id, dateInspection: iDate, etatObserve: "BON" });
  const insPropre = insPost.body?.id as string | undefined;
  const insGetPropre = insPropre ? await appeler("get", `/api/inspections/${insPropre}`, T.insp) : { status: 0, body: null };
  const insPutPropre = insPropre ? await appeler("put", `/api/inspections/${insPropre}`, T.insp, { recommandations: "Reprise de l'enrobe" }) : { status: 0, body: null };
  verifier("D-C1-9 corrige : un INSPECTEUR cree (201), relit (200) et modifie (200) SA PROPRE inspection",
    insPost.status === 201 && insGetPropre.status === 200 && insPutPropre.status === 200, [insPost.status, insPost.body, insGetPropre.status, insPutPropre.status]);
  const autreInsp = await mkUser("inspautre@acces.invalid", "INSPECTEUR", MODULES_RESP);
  const insGetAutrui = insPropre ? await appeler("get", `/api/inspections/${insPropre}`, jeton(autreInsp)) : { status: 0, body: null };
  const insGetInconnu = await appeler("get", `/api/inspections/${randomUUID()}`, jeton(autreInsp));
  const insPutAutrui = insPropre ? await appeler("put", `/api/inspections/${insPropre}`, jeton(autreInsp), { recommandations: "pirate" }) : { status: 0, body: null };
  verifier("D-C1-9 : l'inspection d'AUTRUI n'est ni lisible (404, comme une inspection inconnue : meme corps) ni modifiable (403, contrat historique conserve : l'existence se devine par PUT, voir SESSION-HORS-LIGNE-SERVEUR.md), et reste intacte",
    insGetAutrui.status === 404 && insGetInconnu.status === 404 && JSON.stringify(insGetAutrui.body) === JSON.stringify(insGetInconnu.body) && insPutAutrui.status === 403
    && (await sql<{ recommandations: string | null }>(`SELECT recommandations FROM inspections WHERE id = $1`, insPropre))[0]?.recommandations === "Reprise de l'enrobe",
    [insGetAutrui.status, insGetInconnu.status, insPutAutrui.status]);
  const insBulk = insPropre ? await appeler("post", "/api/inspections/bulk-archive", T.insp, { ids: [insPropre] }) : { status: 0, body: null };
  const insLecteur = await appeler("get", `/api/inspections/${insPropre ?? randomUUID()}`, T.sans);
  verifier("D-C1-9 : l'archivage en masse reste reserve a ADMIN/GESTIONNAIRE (INSPECTEUR : 403, l'inspection n'est pas archivee) et un LECTEUR n'ouvre pas la fiche (403)",
    insBulk.status === 403 && insLecteur.status === 403 && (await sql<{ deletedAt: Date | null }>(`SELECT "deletedAt" FROM inspections WHERE id = $1`, insPropre))[0]?.deletedAt === null, [insBulk.status, insLecteur.status]);

  // ================================================================ L. Le compte est relu en base a chaque requete
  console.log("\n== L. Le compte est relu en base (requireAuth) : le jeton n'est qu'une identite ==");
  const limite = await mkUser("limite@acces.invalid", "GESTIONNAIRE", MODULES_RESP);
  const tLim = jeton(limite);
  const base = await appeler("get", "/api/ordres-travaux?pageSize=1", tLim);
  await sql(`UPDATE users SET actif = false WHERE id = $1`, limite.id);
  const inactif = await appeler("get", "/api/ordres-travaux?pageSize=1", tLim);
  const inactifEcriture = await appeler("put", `/api/ordres-travaux/${ot1b.id}`, tLim, { description: "ecriture par un compte desactive" });
  await sql(`UPDATE users SET actif = true, "lockedUntil" = now() + interval '1 hour' WHERE id = $1`, limite.id);
  const verrouille = await appeler("get", "/api/ordres-travaux?pageSize=1", tLim);
  await sql(`UPDATE users SET "lockedUntil" = NULL, role = 'LECTEUR' WHERE id = $1`, limite.id);
  const retrograde = await appeler("put", `/api/ordres-travaux/${ot1b.id}`, tLim, { description: "ecriture apres retrogradation" });
  await sql(`UPDATE users SET role = 'GESTIONNAIRE' WHERE id = $1`, limite.id);
  const retabli = await appeler("get", "/api/ordres-travaux?pageSize=1", tLim);
  await sql(`UPDATE users SET "modulesAutorises" = '{}' WHERE id = $1`, limite.id);
  const sansModule = await appeler("get", "/api/ordres-travaux?pageSize=1", tLim);
  verifier("un compte DESACTIVE est refuse IMMEDIATEMENT avec un jeton encore valide : 401 COMPTE_INACTIF en lecture comme en ecriture (le meme jeton avait obtenu 200 avant la desactivation)",
    base.status === 200 && inactif.status === 401 && inactif.body.code === "COMPTE_INACTIF"
    && inactifEcriture.status === 401 && inactifEcriture.body.code === "COMPTE_INACTIF",
    [base.status, inactif.status, inactif.body.code, inactifEcriture.status, inactifEcriture.body.code]);
  verifier("un compte VERROUILLE (lockedUntil dans le futur) est refuse de meme : 401 COMPTE_INACTIF (un seul code pour desactive, verrouille et supprime)",
    verrouille.status === 401 && verrouille.body.code === "COMPTE_INACTIF", [verrouille.status, verrouille.body]);
  verifier("un compte RETROGRADE de GESTIONNAIRE a LECTEUR est refuse en ECRITURE (403, pas COMPTE_INACTIF) avec le jeton qui porte encore GESTIONNAIRE : le role vient de la base, pas du jeton",
    retrograde.status === 403 && retrograde.body.code !== "COMPTE_INACTIF", [retrograde.status, retrograde.body]);
  verifier("CONTRE-EPREUVE : le compte redevenu actif, deverrouille et GESTIONNAIRE reprend l'acces avec le MEME jeton (200) : le refus venait bien de la base, pas du jeton",
    retabli.status === 200, retabli.status);
  verifier("CONTRASTE : les modules, eux aussi, sont relus en base a chaque requete : le meme jeton est refuse (403) des que les modules sont retires",
    sansModule.status === 403, sansModule.status);

  // ================================================================ C. Contre-epreuve : le perimetre en base decide
  console.log("\n== C. Contre-epreuve ==");
  const avantCE = await appeler("get", `/api/ordres-travaux/${ot2.id}`, T.r1);
  await sql(`DELETE FROM perimetres_comptes WHERE "userId" = $1`, gestR1.id);
  const apresCE = await appeler("get", `/api/ordres-travaux/${ot2.id}`, T.r1);
  verifier("CONTRE-EPREUVE : le MEME compte, le MEME jeton, la MEME requete : 404 avec son perimetre, 200 des qu'il n'a plus de ligne. C'est bien le perimetre en base qui decide",
    avantCE.status === 404 && apresCE.status === 200, [avantCE.status, apresCE.status]);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 2; })
  .finally(async () => { conclure(); await prisma.$disconnect(); await banc.fermer(); });

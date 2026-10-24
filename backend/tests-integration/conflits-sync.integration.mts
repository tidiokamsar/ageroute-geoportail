// Banc d'integration des CONFLITS DE SYNCHRONISATION cote serveur (scenario d'acceptation A8, partie
// interface : lister les conflits, voir les deux versions, trancher ou demander une verification).
// Voir tests-integration/README.md. Lancer (DATABASE_URL pointe sur `replay`) :
//   npx tsx tests-integration/conflits-sync.integration.mts
//
// CE QUE LE BANC FAIT PASSER PAR LE CODE REEL : les routes /api/v2/sync (push, resolve, conflits,
// conflits/:id/verification) montees comme en production (apiV2Router + errorHandler), des jetons signes,
// l'autorisation lue en base, le controle territorial, l'audit transactionnel, contre un clone PostGIS
// jetable auquel la migration 20261026100000 est appliquee. RIEN n'est simule cote serveur.
//
// CE QU'IL NE PROUVE PAS : l'ecran. La page « Conflits de synchronisation » est eprouvee a part, sous jsdom,
// contre un serveur simule (frontend/src/pages/ConflitsSyncPage.test.tsx). Ici on prouve que ce que la
// page affiche et demande existe, et se comporte, cote serveur.
import { randomUUID } from "node:crypto";
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure } from "./lib/verdict.ts";

const banc = await ouvrirBancClone("essai_conflits_sync", { migrations: ["20261026100000_conflit_sync_verification"] });
const { prisma } = await banc.imp("lib/prisma");
const { apiV2Router } = await banc.imp("api-v2/index");
const { errorHandler } = await banc.imp("middleware/error.middleware");
const { signAccessToken } = await banc.imp("utils/jwt");
const express = (await import("express")).default;
const request = (await import("supertest")).default;

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use("/api/v2", apiV2Router);
app.use(errorHandler);

type Op = {
  operationId: string; entityType: string; entityId: string;
  operation: "CREATE" | "UPDATE" | "DELETE"; baseVersion: number | null; payload: Record<string, unknown>;
};
type Resultat = { operationId: string; statut: string; entityId?: string; version?: number; motif?: string; conflitId?: string };
type Conflit = {
  id: string; operationId: string; entityType: string; entityId: string; operation: string | null; motif: string | null;
  agent: { id: string; nomComplet: string | null } | null; appareil: { id: string; nom: string } | null;
  payloadLocal: Record<string, unknown>; payloadServeur: Record<string, unknown>;
  resolutionsPossibles: { SERVEUR: true; LOCAL: boolean; motifLocalImpossible: string | null };
  verificationDemandee: { le: string; parId: string | null; motif: string | null } | null;
};

const jeton = (u: { id: string; role: string; email: string }) => signAccessToken({ sub: u.id, role: u.role, email: u.email });
const compter = async (sql: string): Promise<number> => Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(sql))[0].n);

const push = (token: string, appareilId: string, operations: Op[]) =>
  request(app).post("/api/v2/sync/push").set("Authorization", `Bearer ${token}`).send({ appareilId, operations });
const resoudre = (token: string, conflitId: string, resolution: "LOCAL" | "SERVEUR") =>
  request(app).post("/api/v2/sync/resolve").set("Authorization", `Bearer ${token}`).send({ conflitId, resolution });
const lister = (token: string | null, requete = "") => {
  const r = request(app).get(`/api/v2/sync/conflits${requete}`);
  return token ? r.set("Authorization", `Bearer ${token}`) : r;
};
const verification = (token: string, conflitId: string, corps: unknown) =>
  request(app).post(`/api/v2/sync/conflits/${conflitId}/verification`).set("Authorization", `Bearer ${token}`).send(corps as object);
const resultat = (r: { body: { resultats?: Resultat[] } }): Resultat => (r.body.resultats ?? [])[0] ?? { operationId: "", statut: "AUCUN" };
const conflitsDe = (r: { body: { conflits?: Conflit[] } }): Conflit[] => r.body.conflits ?? [];

async function main() {
  // ---------------------------------------------------------------- Fixtures
  await prisma.$executeRawUnsafe(`INSERT INTO regions (nom) VALUES ('Region conflits 1'), ('Region conflits 2')`);
  const [r1, r2] = (await prisma.$queryRawUnsafe<{ id: number }[]>(`SELECT id FROM regions WHERE nom IN ('Region conflits 1','Region conflits 2') ORDER BY nom`)).map((r) => r.id);
  const mkUser = (email: string, role: string) => prisma.user.create({
    data: { email, nomComplet: `Nom de ${email}`, passwordHash: "x", role, modulesAutorises: ["inspections"] },
  });
  const agent = await mkUser("agent@conflits.invalid", "INSPECTEUR");
  const chef = await mkUser("chef@conflits.invalid", "GESTIONNAIRE");       // arbitre de la region 1
  const chef2 = await mkUser("chef2@conflits.invalid", "GESTIONNAIRE");     // arbitre de la region 2 : ne voit pas la region 1
  const admin = await mkUser("admin@conflits.invalid", "ADMIN");            // national
  await prisma.$executeRawUnsafe(
    `INSERT INTO perimetres_comptes ("userId", "regionId", "accordeParId") VALUES ($1, $2, $5), ($3, $2, $5), ($4, $6, $5)`,
    agent.id, r1, chef.id, chef2.id, admin.id, r2);
  const tAgent = jeton(agent), tChef = jeton(chef), tChef2 = jeton(chef2), tAdmin = jeton(admin);

  const tronconId = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt")
     VALUES ($1, 'BANC-CONFLITS-1', 'Banc conflits', 'RN', $2, 2.2, 'BITUME', 0, 2.2,
             ST_SetSRID(ST_MakeLine(ST_MakePoint(-13.60, 9.64), ST_MakePoint(-13.58, 9.64)), 4326), now())`, tronconId, r1);
  const mission = await prisma.mission.create({
    data: { code: "BANC-CONFLITS-M1", intitule: "Mission banc", type: "SURVEILLANCE", createurId: chef.id, assigneId: agent.id, regionId: r1 },
  });
  await prisma.catalogueDefaut.create({
    data: { code: "NID_BANC", libelle: "Nid de poule (banc)", famille: "CHAUSSEE", unite: "UNITE", mesuresRequises: ["NOMBRE"], graviteMax: 4 },
  });
  const appareil = (userId: string, nom: string) => prisma.appareil.create({ data: { userId, nom, plateforme: "android" } });
  const devA = await appareil(agent.id, "tel A"), devB = await appareil(agent.id, "tel B");

  const nouvelleObs = (i: number, description: string): Op => ({
    operationId: randomUUID(), entityType: "Observation", entityId: randomUUID(), operation: "CREATE", baseVersion: null,
    payload: {
      type: "DEGRADATION", gravite: "MOYENNE", description, missionId: mission.id, tronconId,
      lat: 9.64 + i * 1e-5, lon: -13.595, precisionM: 5, observeA: new Date(Date.UTC(2026, 9, 20, 8, i % 60)).toISOString(),
    },
  });
  const majObs = (cible: Op, description: string, base: number): Op => ({
    operationId: randomUUID(), entityType: "Observation", entityId: cible.entityId, operation: "UPDATE", baseVersion: base, payload: { description },
  });
  const supprObs = (cible: Op, base: number): Op => ({
    operationId: randomUUID(), entityType: "Observation", entityId: cible.entityId, operation: "DELETE", baseVersion: base, payload: {},
  });
  const nouveauDefaut = (i: number, id = randomUUID()): Op => ({
    operationId: randomUUID(), entityType: "Defaut", entityId: id, operation: "CREATE", baseVersion: null,
    payload: { catalogueCode: "NID_BANC", lat: 9.65 + i * 1e-5, lon: -13.59, precisionM: 4, tronconId, mesures: { nombre: 3 }, gravite: 2 },
  });
  const obsDe = (id: string) => prisma.observation.findUnique({ where: { id } });
  const conflitEnBase = (id: string) => prisma.conflitSync.findUnique({ where: { id } });

  // ---------------------------------------------------------------- Mise en place : quatre conflits ouverts
  // U : deux appareils modifient la meme observation depuis la version 1 (conflit de MODIFICATION).
  const oU = nouvelleObs(1, "initiale U");
  await push(tAgent, devA.id, [oU]);
  await push(tAgent, devA.id, [majObs(oU, "U serveur (appareil A)", 1)]);
  const opU = majObs(oU, "U telephone (appareil B)", 1);
  const cU = resultat(await push(tAgent, devB.id, [opU]));
  // C : deux appareils creent le meme objet (conflit de CREATION).
  const oC = nouvelleObs(2, "creation C serveur");
  const oCb: Op = { ...nouvelleObs(3, "creation C telephone"), entityId: oC.entityId };
  await push(tAgent, devA.id, [oC]);
  const cC = resultat(await push(tAgent, devB.id, [oCb]));
  // D : deux creations du meme defaut (conflit de DEFAUT).
  const dA = nouveauDefaut(1);
  await push(tAgent, devA.id, [dA]);
  const cD = resultat(await push(tAgent, devB.id, [nouveauDefaut(2, dA.entityId)]));
  // S : une suppression partie de la version 1 alors que l'observation a change (conflit de SUPPRESSION).
  const oS = nouvelleObs(4, "initiale S");
  await push(tAgent, devA.id, [oS]);
  await push(tAgent, devA.id, [majObs(oS, "S serveur (appareil A)", 1)]);
  const cS = resultat(await push(tAgent, devB.id, [supprObs(oS, 1)]));
  verifier("mise en place : les quatre conflits (modification, creation, defaut, suppression) sont rendus CONFLIT par le serveur",
    [cU, cC, cD, cS].every((c) => c.statut === "CONFLIT" && !!c.conflitId), [cU, cC, cD, cS]);

  // ============================================================== LISTE
  console.log("\n== Liste des conflits ouverts ==");
  verifier("L1 sans jeton : 401", (await lister(null)).status === 401);
  const lAgent = await lister(tAgent);
  verifier("L1 un agent n'a pas acces a la liste : 403 (l'arbitrage est reserve aux responsables)", lAgent.status === 403, lAgent.status);
  const lChef = await lister(tChef);
  const liste = conflitsDe(lChef);
  const parId = (id: string | undefined) => liste.find((c) => c.id === id);
  verifier("L2 un gestionnaire de la region voit les 4 conflits ouverts, sans troncature", lChef.status === 200 && liste.length === 4 && lChef.body.total === 4 && lChef.body.tronque === false, lChef.body.total);

  const u = parId(cU.conflitId);
  verifier("L3 LES DEUX VERSIONS cote a cote : la version du telephone (B) ET celle du serveur (A, version 2)",
    u?.payloadLocal.description === "U telephone (appareil B)" && u?.payloadServeur.description === "U serveur (appareil A)" && u?.payloadServeur.version === 2, u);
  verifier("L3 le conflit dit de quoi il s'agit : operation, motif, agent, appareil du telephone",
    u?.operation === "UPDATE" && u.motif === "VERSION_PERIMEE" && u.agent?.nomComplet === `Nom de ${agent.email}` && u.appareil?.nom === "tel B", u);
  verifier("L3 la version du telephone ne contient QUE ce que le telephone a envoye (pas de champ ajoute par le serveur)",
    Object.keys(u?.payloadLocal ?? {}).join(",") === "description", u?.payloadLocal);

  const c = parId(cC.conflitId), d = parId(cD.conflitId), s = parId(cS.conflitId);
  verifier("L4 ce que l'arbitrage permet est dit AVANT le clic : LOCAL permis pour une modification et une suppression",
    u?.resolutionsPossibles.LOCAL === true && s?.resolutionsPossibles.LOCAL === true && u.resolutionsPossibles.motifLocalImpossible === null, [u?.resolutionsPossibles, s?.resolutionsPossibles]);
  verifier("L4 ... LOCAL refuse pour une creation et pour un defaut, avec la raison",
    c?.resolutionsPossibles.LOCAL === false && !!c.resolutionsPossibles.motifLocalImpossible
    && d?.resolutionsPossibles.LOCAL === false && !!d.resolutionsPossibles.motifLocalImpossible, [c?.resolutionsPossibles, d?.resolutionsPossibles]);
  const r409c = await resoudre(tChef, cC.conflitId!, "LOCAL");
  const r409d = await resoudre(tChef, cD.conflitId!, "LOCAL");
  verifier("L4 la liste ne ment pas : la route reelle refuse bien LOCAL sur la creation et sur le defaut (409 NOUVEL_IDENTIFIANT_REQUIS)",
    r409c.status === 409 && r409c.body.motif === "NOUVEL_IDENTIFIANT_REQUIS" && r409d.status === 409 && r409d.body.motif === "NOUVEL_IDENTIFIANT_REQUIS", [r409c.body, r409d.body]);
  verifier("L4 ... et ces refus laissent les conflits OUVERTS", (await conflitEnBase(cC.conflitId!))?.resolution === null && (await conflitEnBase(cD.conflitId!))?.resolution === null);

  const lChef2 = await lister(tChef2);
  verifier("L5 cloisonnement : un gestionnaire d'une AUTRE region ne voit aucun de ces conflits", lChef2.status === 200 && conflitsDe(lChef2).length === 0 && lChef2.body.total === 0, lChef2.body);
  verifier("L5 un administrateur (national) voit les 4", conflitsDe(await lister(tAdmin)).length === 4);
  const lLimite = await lister(tChef, "?limite=2");
  verifier("L6 la limite est respectee et la troncature DITE : 2 rendus, total 4, tronque", conflitsDe(lLimite).length === 2 && lLimite.body.total === 4 && lLimite.body.tronque === true, lLimite.body);
  verifier("L6 une limite invalide est refusee (400), pas ignoree", (await lister(tChef, "?limite=0")).status === 400 && (await lister(tChef, "?limite=abc")).status === 400);
  verifier("L7 les conflits sont rendus du plus ancien au plus recent (ordre d'arrivee)",
    liste.map((x) => x.id).join() === [cU, cC, cD, cS].map((x) => x.conflitId).join(), liste.map((x) => x.entityType));
  verifier("L7 consulter ne modifie rien : toujours 4 conflits ouverts et aucune ligne d'audit de resolution",
    await compter(`SELECT count(*) n FROM conflits_sync WHERE resolution IS NULL`) === 4
    && await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType"='ConflitSync'`) === 0);

  // ============================================================== DEMANDE DE VERIFICATION
  console.log("\n== Demande de verification (le conflit n'est PAS tranche) ==");
  const avantD = await conflitEnBase(cD.conflitId!);
  verifier("V1 un agent ne demande pas de verification : 403", (await verification(tAgent, cD.conflitId!, { motif: "a voir" })).status === 403);
  verifier("V1 un motif est exige (absent, trop court) : 400", (await verification(tChef, cD.conflitId!, {})).status === 400 && (await verification(tChef, cD.conflitId!, { motif: "ok" })).status === 400);
  verifier("V1 une cle inconnue est refusee, pas ignoree en silence : 400", (await verification(tChef, cD.conflitId!, { motif: "verifier avec l'agent", resolution: "SERVEUR" })).status === 400);
  verifier("V1 un identifiant invalide : 400 ; un conflit inconnu : 404",
    (await verification(tChef, "pas-un-uuid", { motif: "verifier avec l'agent" })).status === 400 && (await verification(tChef, randomUUID(), { motif: "verifier avec l'agent" })).status === 404);
  const hors = await verification(tChef2, cD.conflitId!, { motif: "verifier avec l'agent" });
  verifier("V2 un gestionnaire d'une autre region ne le peut pas : 403 HORS_PERIMETRE", hors.status === 403 && hors.body.code === "HORS_PERIMETRE", hors.body);
  verifier("V2 ... et rien n'a ete ecrit par ces refus", (await conflitEnBase(cD.conflitId!)) !== null
    && await compter(`SELECT count(*) n FROM conflits_sync WHERE "verificationDemandeeA" IS NOT NULL`) === 0
    && await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType"='ConflitSync'`) === 0);

  const demande = await verification(tChef, cD.conflitId!, { motif: "Les deux relevés semblent plausibles : appeler l'agent" });
  verifier("V3 le gestionnaire demande une verification : 201, resolution TOUJOURS nulle", demande.status === 201 && demande.body.resolution === null && demande.body.verificationDemandee === true, demande.body);
  const apresD = await conflitEnBase(cD.conflitId!);
  const colonnes = (await prisma.$queryRawUnsafe<{ a: Date | null; par: string | null; motif: string | null }[]>(
    `SELECT "verificationDemandeeA" a, "verificationDemandeeParId" par, "verificationMotif" motif FROM conflits_sync WHERE id='${cD.conflitId}'`))[0];
  verifier("V3 elle est consignee : qui (le gestionnaire), quand, pourquoi", colonnes.a !== null && colonnes.par === chef.id && colonnes.motif === "Les deux relevés semblent plausibles : appeler l'agent", colonnes);
  verifier("V3 LES DEUX VERSIONS SONT INTACTES et le conflit reste OUVERT",
    apresD?.resolution === null && JSON.stringify(apresD.payloadLocal) === JSON.stringify(avantD!.payloadLocal) && JSON.stringify(apresD.payloadServeur) === JSON.stringify(avantD!.payloadServeur));
  verifier("V3 l'operation du telephone reste en CONFLIT (rien n'est decide)", (await prisma.operationSync.findUnique({ where: { operationId: cD.operationId } }))?.statut === "CONFLIT");
  verifier("V3 elle est AUDITEE (ConflitSync, auteur, motif)",
    await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType"='ConflitSync' AND "entityId"='${cD.conflitId}' AND "userId"='${chef.id}' AND after->>'verificationDemandee'='true' AND after->>'motif' LIKE 'Les deux%'`) === 1);
  const secondeDemande = await verification(tChef, cD.conflitId!, { motif: "encore une fois" });
  verifier("V4 une seconde demande sur le meme conflit est refusee (409) et n'ajoute aucune ligne d'audit",
    secondeDemande.status === 409 && await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType"='ConflitSync' AND "entityId"='${cD.conflitId}'`) === 1, secondeDemande.body);
  const dApres = conflitsDe(await lister(tChef)).find((x) => x.id === cD.conflitId);
  verifier("V5 la liste montre la demande (qui, motif) et garde le conflit ouvert", dApres?.verificationDemandee?.parId === chef.id && dApres.verificationDemandee.motif?.startsWith("Les deux") === true, dApres?.verificationDemandee);
  const rejeu = resultat(await push(tAgent, devB.id, [{ ...nouveauDefaut(2, dA.entityId), operationId: cD.operationId }]));
  verifier("V6 le telephone qui renvoie l'operation apprend toujours CONFLIT, avec le MEME conflit (pas un succes)", rejeu.statut === "CONFLIT" && rejeu.conflitId === cD.conflitId, rejeu);

  // Deux demandes simultanees sur le meme conflit : une seule ecriture.
  const [x1, x2] = await Promise.all([
    verification(tChef, cC.conflitId!, { motif: "demande simultanee 1" }),
    verification(tAdmin, cC.conflitId!, { motif: "demande simultanee 2" }),
  ]);
  verifier("V7 deux demandes simultanees : une seule reussit (201), l'autre est refusee (409), UNE ligne d'audit",
    [x1.status, x2.status].sort().join() === "201,409"
    && await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType"='ConflitSync' AND "entityId"='${cC.conflitId}'`) === 1, [x1.status, x2.status]);

  // ============================================================== ARBITRAGE PAR LES ROUTES EXISTANTES
  console.log("\n== Arbitrage (routes existantes) depuis la liste ==");
  const totalAvant = await compter(`SELECT count(*) n FROM conflits_sync`);
  const obsAvant = await compter(`SELECT count(*) n FROM observations`);
  const avantU = await conflitEnBase(cU.conflitId!);
  const rSrv = await resoudre(tChef, cU.conflitId!, "SERVEUR");
  verifier("A1 garder la version du serveur : 200, observation inchangee (version 2, texte du serveur)", rSrv.status === 200 && (await obsDe(oU.entityId))?.description === "U serveur (appareil A)" && (await obsDe(oU.entityId))?.version === 2, rSrv.body);
  const apresU = await conflitEnBase(cU.conflitId!);
  verifier("A1 LES DEUX VERSIONS RESTENT CONSERVEES apres arbitrage (la version du telephone n'est pas effacee)",
    apresU?.resolution === "SERVEUR" && apresU.resoluParId === chef.id && JSON.stringify(apresU.payloadLocal) === JSON.stringify(avantU!.payloadLocal) && apresU.payloadLocal.description === "U telephone (appareil B)");
  verifier("A1 le conflit tranche sort de la liste des conflits ouverts", !conflitsDe(await lister(tChef)).some((x) => x.id === cU.conflitId));
  const rejeuU = resultat(await push(tAgent, devB.id, [{ ...opU }]));
  verifier("A1 le telephone qui renvoie l'operation apprend REJETE / CONFLIT_RESOLU_VERSION_SERVEUR (de quoi marquer sa file, pas la perdre)", rejeuU.statut === "REJETE" && rejeuU.motif === "CONFLIT_RESOLU_VERSION_SERVEUR", rejeuU);
  verifier("A1 demander une verification sur un conflit deja tranche : 409", (await verification(tChef, cU.conflitId!, { motif: "trop tard pour verifier" })).status === 409);

  const rLoc = await resoudre(tChef, cS.conflitId!, "LOCAL");
  const supprimee = await obsDe(oS.entityId);
  verifier("A2 retenir la version du telephone (suppression) : 200, suppression LOGIQUE (ligne conservee, deletedAt pose, version 3)", rLoc.status === 200 && supprimee !== null && supprimee.deletedAt !== null && supprimee.version === 3, rLoc.body);
  verifier("A2 l'ecriture de la version du telephone est auditee (une ligne DELETE Observation, au nom de l'arbitre)",
    await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType"='Observation' AND "entityId"='${oS.entityId}' AND action='DELETE' AND "userId"='${chef.id}'`) === 1);

  // Un conflit de modification ou une verification a ete demandee, puis tranche en LOCAL.
  const oV = nouvelleObs(5, "initiale V");
  await push(tAgent, devA.id, [oV]);
  await push(tAgent, devA.id, [majObs(oV, "V serveur", 1)]);
  const cV = resultat(await push(tAgent, devB.id, [majObs(oV, "V telephone", 1)]));
  await verification(tChef, cV.conflitId!, { motif: "verifier avant de retenir le telephone" });
  const rVLocal = await resoudre(tChef, cV.conflitId!, "LOCAL");
  verifier("A3 apres une demande de verification, le conflit se tranche encore : LOCAL applique la version du telephone (version 3)",
    rVLocal.status === 200 && (await obsDe(oV.entityId))?.description === "V telephone" && (await obsDe(oV.entityId))?.version === 3, rVLocal.body);
  verifier("A3 la demande de verification reste consignee apres la resolution",
    (await prisma.$queryRawUnsafe<{ par: string | null }[]>(`SELECT "verificationDemandeeParId" par FROM conflits_sync WHERE id='${cV.conflitId}'`))[0].par === chef.id);

  verifier("A4 il reste exactement les 2 conflits non tranches (creation, defaut), et la liste le dit",
    conflitsDe(await lister(tChef)).map((x) => x.entityType).sort().join() === "Defaut,Observation");
  verifier("A5 JAMAIS DE SUPPRESSION PHYSIQUE : autant de conflits qu'avant (+1 cree en A3), pas une observation de moins",
    await compter(`SELECT count(*) n FROM conflits_sync`) === totalAvant + 1 && await compter(`SELECT count(*) n FROM observations`) >= obsAvant + 1);

  conclure();
}

main()
  .catch((e) => { console.error(e); process.exitCode = 2; })
  .finally(async () => { await prisma.$disconnect(); await banc.fermer(); });

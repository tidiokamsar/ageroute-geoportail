// Banc d'integration de la synchronisation terrain (scenarios d'acceptation A7 et A8).
// Voir tests-integration/README.md. Lancer (DATABASE_URL pointe sur `replay`) :
//   npx tsx tests-integration/sync.integration.mts
//
// CE QUE LE BANC FAIT PASSER PAR LE CODE REEL : les routes /api/v2/sync et /api/v2/devices montees
// comme en production (apiV2Router + errorHandler), des jetons signes, l'autorisation lue en base,
// le controle territorial, l'audit transactionnel, contre un clone PostGIS jetable. RIEN n'est
// simule cote serveur. Les verifications comparent la base a un MODELE TENU PAR LE BANC (les
// operations que le banc a emises), jamais aux reponses du serveur seules.
//
// CE QU'IL NE PROUVE PAS : un telephone. La file locale, la perte de reseau reelle, le stockage du
// navigateur sont hors de portee (voir docs/scenarios/SCENARIOS-PARTIELS.md). Ici, une « coupure »
// est un lot partiel, une reponse « perdue » est un lot renvoye a l'identique.
import { randomUUID } from "node:crypto";
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure } from "./lib/verdict.ts";

const banc = await ouvrirBancClone("essai_sync");
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
type Resultat = { operationId: string; statut: string; entityId?: string; version?: number; motif?: string; conflitId?: string; reessayerDansMs?: number };

const jeton = (u: { id: string; role: string; email: string }) => signAccessToken({ sub: u.id, role: u.role, email: u.email });
const compter = async (sql: string): Promise<number> => Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(sql))[0].n);

async function push(token: string, appareilId: string, operations: Op[]) {
  return request(app).post("/api/v2/sync/push").set("Authorization", `Bearer ${token}`).send({ appareilId, operations });
}
async function resoudre(token: string, conflitId: string, resolution: "LOCAL" | "SERVEUR") {
  return request(app).post("/api/v2/sync/resolve").set("Authorization", `Bearer ${token}`).send({ conflitId, resolution });
}
const resultats = (r: { body: { resultats?: Resultat[] } }): Resultat[] => r.body.resultats ?? [];
const statuts = (r: { body: { resultats?: Resultat[] } }) => resultats(r).map((x) => x.statut);
const tous = (r: { body: { resultats?: Resultat[] } }, statut: string) => resultats(r).length > 0 && resultats(r).every((x) => x.statut === statut);

async function main() {
  // ---------------------------------------------------------------- Fixtures
  await prisma.$executeRawUnsafe(`INSERT INTO regions (nom) VALUES ('Region banc sync')`);
  const regionId = (await prisma.$queryRawUnsafe<{ id: number }[]>(`SELECT id FROM regions WHERE nom='Region banc sync'`))[0].id;
  const mkUser = (email: string, role: string) => prisma.user.create({
    data: { email, nomComplet: email, passwordHash: "x", role, modulesAutorises: ["inspections"] },
  });
  const agent = await mkUser("agent@banc.invalid", "INSPECTEUR");      // agent regional, comme sur le terrain
  const autre = await mkUser("autre@banc.invalid", "INSPECTEUR");      // un autre agent regional
  const chef = await mkUser("chef@banc.invalid", "GESTIONNAIRE");      // arbitre
  await prisma.$executeRawUnsafe(`INSERT INTO perimetres_comptes ("userId", "regionId", "accordeParId") VALUES ($1, $2, $4), ($3, $2, $4), ($4, $2, $4)`, agent.id, regionId, autre.id, chef.id);
  const tAgent = jeton(agent), tAutre = jeton(autre), tChef = jeton(chef);

  const tronconId = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt")
     VALUES ($1, 'BANC-SYNC-1', 'Banc sync', 'RN', $2, 2.2, 'BITUME', 0, 2.2,
             ST_SetSRID(ST_MakeLine(ST_MakePoint(-13.60, 9.64), ST_MakePoint(-13.58, 9.64)), 4326), now())`, tronconId, regionId);
  const mission = await prisma.mission.create({
    data: { code: "BANC-SYNC-M1", intitule: "Mission banc", type: "SURVEILLANCE", createurId: chef.id, assigneId: agent.id, regionId },
  });
  await prisma.catalogueDefaut.create({
    data: { code: "NID_BANC", libelle: "Nid de poule (banc)", famille: "CHAUSSEE", unite: "UNITE", mesuresRequises: ["NOMBRE"], graviteMax: 4 },
  });
  const appareil = (userId: string, nom: string) => prisma.appareil.create({ data: { userId, nom, plateforme: "android" } });
  const devA = await appareil(agent.id, "tel A"), devB = await appareil(agent.id, "tel B"), devC = await appareil(agent.id, "tel C");
  const devAutre = await appareil(autre.id, "tel autre");

  const nouvelleObs = (i: number, extra: Record<string, unknown> = {}): Op => ({
    operationId: randomUUID(), entityType: "Observation", entityId: randomUUID(), operation: "CREATE", baseVersion: null,
    payload: {
      type: "DEGRADATION", gravite: "MOYENNE", description: `obs ${i}`, missionId: mission.id, tronconId,
      lat: 9.64 + i * 1e-5, lon: -13.595, precisionM: 5, observeA: new Date(Date.UTC(2026, 9, 20, 8, i % 60)).toISOString(), ...extra,
    },
  });
  const majObs = (cible: Op, desc: string, base: number): Op => ({
    operationId: randomUUID(), entityType: "Observation", entityId: cible.entityId, operation: "UPDATE", baseVersion: base, payload: { description: desc },
  });
  const supprObs = (cible: Op, base: number): Op => ({
    operationId: randomUUID(), entityType: "Observation", entityId: cible.entityId, operation: "DELETE", baseVersion: base, payload: {},
  });
  const nouveauDefaut = (i: number): Op => {
    const id = randomUUID();
    return { operationId: id, entityType: "Defaut", entityId: id, operation: "CREATE", baseVersion: null,
      payload: { catalogueCode: "NID_BANC", lat: 9.65 + i * 1e-5, lon: -13.59, precisionM: 4, tronconId, mesures: { nombre: 3 }, gravite: 2 } };
  };
  const obsDe = (id: string) => prisma.observation.findUnique({ where: { id } });

  // ============================================================== A7
  console.log("\n== A7 : hors ligne, 50 observations, 0 doublon, 0 perte ==");

  // --- A7.1 Une file de 50 observations, remontee en un lot.
  const file1 = Array.from({ length: 50 }, (_, i) => nouvelleObs(i));
  const r1 = await push(tAgent, devA.id, file1);
  verifier("A7.1 le lot de 50 est accepte : 50 SYNCHRONISE, aucun rejet ni conflit", r1.status === 200 && r1.body.synchronisees === 50 && r1.body.rejetees === 0 && r1.body.conflits === 0, r1.body);
  const idsFile1 = file1.map((o) => `'${o.operationId}'`).join(",");
  verifier("A7.1 la base porte 50 observations, 50 cles d'idempotence distinctes, 50 operations SYNCHRONISE",
    await compter(`SELECT count(*) n FROM observations WHERE "clientOperationId" IN (${idsFile1})`) === 50
    && await compter(`SELECT count(DISTINCT "clientOperationId") n FROM observations WHERE "clientOperationId" IN (${idsFile1})`) === 50
    && await compter(`SELECT count(*) n FROM operations_sync WHERE "operationId" IN (${idsFile1}) AND statut='SYNCHRONISE'`) === 50);
  verifier("A7.1 toute ecriture est auditee : 50 CREATE Observation pour cet agent",
    await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType"='Observation' AND action='CREATE' AND "userId"='${agent.id}'`) === 50);
  verifier("A7.1 l'agent est celui du jeton et le statut est PROPOSEE pour les 50 (rien n'est officiel)",
    await compter(`SELECT count(*) n FROM observations WHERE "clientOperationId" IN (${idsFile1}) AND "agentId"='${agent.id}' AND statut='PROPOSEE'`) === 50);

  // --- A7.2 Le meme lot rejoue trois fois (reponse perdue, puis encore).
  const rejeux = [await push(tAgent, devA.id, file1), await push(tAgent, devB.id, file1), await push(tAgent, devA.id, [...file1].reverse())];
  verifier("A7.2 trois rejeux (dont un depuis un AUTRE appareil du meme agent, un en ordre inverse) : 150 REJOUEE, 0 ecriture",
    rejeux.every((r) => r.body.rejouees === 50 && r.body.synchronisees === 0), rejeux.map((r) => r.body.rejouees));
  verifier("A7.2 apres les rejeux : toujours 50 observations, 50 operations, 50 audits (0 doublon)",
    await compter(`SELECT count(*) n FROM observations WHERE "clientOperationId" IN (${idsFile1})`) === 50
    && await compter(`SELECT count(*) n FROM operations_sync WHERE "operationId" IN (${idsFile1})`) === 50
    && await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType"='Observation' AND action='CREATE' AND "userId"='${agent.id}'`) === 50);

  // --- A7.3 Coupures : lot tronque, reponse perdue, reprise.
  const file2 = Array.from({ length: 50 }, (_, i) => nouvelleObs(100 + i));
  await push(tAgent, devA.id, file2.slice(0, 20));          // la connexion tombe apres 20 operations
  const rPerdue = await push(tAgent, devA.id, file2.slice(0, 35)); // 20 deja passees, reponse perdue, on renvoie 35
  verifier("A7.3 un lot renvoye apres coupure : 20 REJOUEE + 15 SYNCHRONISE", rPerdue.body.rejouees === 20 && rPerdue.body.synchronisees === 15, rPerdue.body);
  const rReprise = await push(tAgent, devB.id, file2);        // reprise complete depuis un autre appareil
  verifier("A7.3 la reprise complete : 35 REJOUEE + 15 SYNCHRONISE", rReprise.body.rejouees === 35 && rReprise.body.synchronisees === 15, rReprise.body);
  const idsFile2 = file2.map((o) => `'${o.operationId}'`).join(",");
  verifier("A7.3 apres coupures et reprises : exactement 50 observations pour la file 2 (0 doublon, 0 perte)",
    await compter(`SELECT count(*) n FROM observations WHERE "clientOperationId" IN (${idsFile2})`) === 50
    && await compter(`SELECT count(DISTINCT id) n FROM observations WHERE "clientOperationId" IN (${idsFile2})`) === 50);

  // --- A7.4 Ordre inverse : les modifications arrivent AVANT les creations qu'elles modifient.
  const creations = Array.from({ length: 25 }, (_, i) => nouvelleObs(200 + i));
  const modifs = creations.map((c, i) => majObs(c, `modifiee hors ligne ${i}`, 1));
  const rInverse = await push(tAgent, devA.id, [...modifs, ...creations]);
  verifier("A7.4 ordre inverse, 1re passe : 25 modifications refusees (entite pas encore la), 25 creations acceptees",
    rInverse.body.rejetees === 25 && rInverse.body.synchronisees === 25
    && resultats(rInverse).filter((x) => x.statut === "REJETE").every((x) => x.motif === "ENTITE_INTROUVABLE" && typeof x.reessayerDansMs === "number"), rInverse.body);
  const rRetry = await push(tAgent, devA.id, modifs);         // le telephone retente avec les MEMES operationId
  verifier("A7.4 le telephone retente les 25 modifications (memes operationId) : elles sont APPLIQUEES, pas rendues comme deja traitees",
    tous(rRetry, "SYNCHRONISE"), { statuts: statuts(rRetry).slice(0, 3), motifs: resultats(rRetry).slice(0, 2) });
  const appliquees = await compter(`SELECT count(*) n FROM observations WHERE "clientOperationId" IN (${creations.map((c) => `'${c.operationId}'`).join(",")}) AND version = 2 AND description LIKE 'modifiee hors ligne %'`);
  verifier("A7.4 0 perte : les 25 observations portent la modification hors ligne (version 2)", appliquees === 25, appliquees);
  verifier("A7.4 0 doublon : toujours 25 observations pour ces 25 creations",
    await compter(`SELECT count(*) n FROM observations WHERE "clientOperationId" IN (${creations.map((c) => `'${c.operationId}'`).join(",")})`) === 25);

  // --- A7.5 Une operation invalide ne perd ni ne bloque les autres.
  const file3 = Array.from({ length: 50 }, (_, i) => nouvelleObs(300 + i));
  file3[24] = nouvelleObs(324, { gravite: "CRITIQUE" });       // valeur hors enumeration
  const r3 = await push(tAgent, devA.id, file3);
  verifier("A7.5 une operation invalide sur 50 : 49 SYNCHRONISE, 1 REJETE, et 50 reponses (une par operation)",
    r3.body.synchronisees === 49 && r3.body.rejetees === 1 && resultats(r3).length === 50
    && new Set(resultats(r3).map((x) => x.operationId)).size === 50, r3.body);
  verifier("A7.5 le rejet est trace (REJETE + motif), sans le contenu brut", (await prisma.operationSync.findUnique({ where: { operationId: file3[24].operationId } }))?.derniereErreur === "PAYLOAD_INVALIDE:Observation");

  // --- A7.6 Concurrence : le meme lot arrive quatre fois en meme temps.
  const file4 = Array.from({ length: 20 }, (_, i) => nouvelleObs(400 + i));
  const simultanes = await Promise.all([
    push(tAgent, devA.id, file4), push(tAgent, devA.id, file4), push(tAgent, devB.id, file4), push(tAgent, devB.id, [...file4].reverse()),
  ]);
  const idsFile4 = file4.map((o) => `'${o.operationId}'`).join(",");
  verifier("A7.6 quatre envois simultanes du meme lot : 0 doublon en base (20 observations, 20 operations)",
    await compter(`SELECT count(*) n FROM observations WHERE "clientOperationId" IN (${idsFile4})`) === 20
    && await compter(`SELECT count(*) n FROM operations_sync WHERE "operationId" IN (${idsFile4})`) === 20
    && await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType"='Observation' AND action='CREATE' AND "entityId" IN (SELECT id FROM observations WHERE "clientOperationId" IN (${idsFile4}))`) === 20);
  verifier("A7.6 aucun envoi simultane ne repond par une erreur serveur (pas de 500 : la course est absorbee)",
    simultanes.every((r) => r.status === 200), simultanes.map((r) => r.status));
  const synchro = simultanes.reduce((n, r) => n + (r.body.synchronisees ?? 0), 0);
  verifier("A7.6 chaque operation est SYNCHRONISE une seule fois sur l'ensemble des reponses (20 au total)", synchro === 20, synchro);

  // --- A7.7 Atomicite : coupure au milieu de la transaction (la trace ne peut pas s'ecrire).
  const opPiegee = nouvelleObs(500);
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION banc_coupure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW."operationId" = '${opPiegee.operationId}' THEN RAISE EXCEPTION 'coupure simulee'; END IF; RETURN NEW; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER banc_coupure BEFORE INSERT ON operations_sync FOR EACH ROW EXECUTE FUNCTION banc_coupure()`);
  const rCoupee = await push(tAgent, devA.id, [opPiegee]);
  verifier("A7.7 la transaction coupee avant la trace n'ecrit RIEN : ni observation, ni operation, ni audit",
    rCoupee.status >= 500
    && await compter(`SELECT count(*) n FROM observations WHERE "clientOperationId"='${opPiegee.operationId}'`) === 0
    && await compter(`SELECT count(*) n FROM operations_sync WHERE "operationId"='${opPiegee.operationId}'`) === 0
    && await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType"='Observation' AND "entityId"='${opPiegee.entityId}'`) === 0, rCoupee.status);
  await prisma.$executeRawUnsafe(`DROP TRIGGER banc_coupure ON operations_sync`);
  const rApres = await push(tAgent, devA.id, [opPiegee]);
  verifier("A7.7 la reprise apres la coupure aboutit : 1 SYNCHRONISE, 1 observation", tous(rApres, "SYNCHRONISE")
    && await compter(`SELECT count(*) n FROM observations WHERE "clientOperationId"='${opPiegee.operationId}'`) === 1, rApres.body);

  // --- A7.8 Defauts hors ligne : memes garanties, plus la geometrie PostGIS.
  const defauts = Array.from({ length: 20 }, (_, i) => nouveauDefaut(i));
  const rd1 = await push(tAgent, devA.id, defauts);
  const rd2 = await push(tAgent, devB.id, defauts);
  verifier("A7.8 20 defauts hors ligne : 20 SYNCHRONISE puis 20 REJOUEE au rejeu", rd1.body.synchronisees === 20 && rd2.body.rejouees === 20, [rd1.body, rd2.body]);
  const idsD = defauts.map((d) => `'${d.operationId}'`).join(",");
  // La cle de l'observation-conteneur d'un defaut DERIVE de celle du defaut (`<cle>-observation`) :
  // un rejeu retombe sur la meme collision d'unicite, pas sur un conteneur de plus.
  const idsConteneurs = defauts.map((d) => `'${d.operationId}-observation'`).join(",");
  verifier("A7.8 en base : 20 defauts, 20 observations-conteneurs, 20 quantites, 20 points PostGIS non nuls",
    await compter(`SELECT count(*) n FROM defauts WHERE "clientOperationId" IN (${idsD})`) === 20
    && await compter(`SELECT count(*) n FROM observations WHERE "clientOperationId" IN (${idsConteneurs})`) === 20
    && await compter(`SELECT count(*) n FROM defauts WHERE "clientOperationId" IN (${idsD}) AND quantite = 3`) === 20
    && await compter(`SELECT count(*) n FROM defauts WHERE "clientOperationId" IN (${idsD}) AND geom IS NOT NULL`) === 20);
  // Oracle independant : la geometrie lue en base est exactement le point emis par le banc.
  const ecarts = await prisma.$queryRawUnsafe<{ id: string; lat: number; lon: number }[]>(`SELECT "clientOperationId" id, ST_Y(geom) lat, ST_X(geom) lon FROM defauts WHERE "clientOperationId" IN (${idsD})`);
  const attendu = new Map(defauts.map((d) => [d.operationId, d.payload as { lat: number; lon: number }]));
  verifier("A7.8 chaque point PostGIS est le point emis (ecart < 1e-9 degre)", ecarts.length === 20 && ecarts.every((e) => Math.abs(e.lat - attendu.get(e.id)!.lat) < 1e-9 && Math.abs(e.lon - attendu.get(e.id)!.lon) < 1e-9));

  // --- A7.8b Portions hors ligne : le troisieme type de la file locale.
  const portions: Op[] = Array.from({ length: 5 }, (_, i) => {
    const id = randomUUID();
    return { operationId: id, entityType: "Portion", entityId: id, operation: "CREATE", baseVersion: null,
      payload: { tronconId, debutM: i * 400, finM: i * 400 + 400, revetement: "BITUME", observeeLe: "2026-10-20T08:00:00.000Z", valideDu: null, confiance: "MEDIUM" } };
  });
  const idsP = portions.map((p) => `'${p.operationId}'`).join(",");
  // Le vocabulaire « BITUME » n'est pas encore au referentiel (la base est vide) : la reference est INCONNUE.
  const rpInconnu = await push(tAgent, devA.id, portions);
  verifier("A7.8b une reference inconnue (revetement absent du referentiel) est un REFUS tracable et retentable, pas une erreur serveur qui perd le lot",
    rpInconnu.status === 200 && rpInconnu.body.rejetees === 5 && resultats(rpInconnu).every((x) => x.motif === "REFERENCE_INCONNUE:revetement" && typeof x.reessayerDansMs === "number")
    && await compter(`SELECT count(*) n FROM portions WHERE "clientOperationId" IN (${idsP})`) === 0, rpInconnu.body);
  await prisma.$executeRawUnsafe(`INSERT INTO referentiel_revetements (code, libelle, ordre, bitumineux, "updatedAt") VALUES ('BITUME', 'Bitume', 1, true, now())`);
  const rp1 = await push(tAgent, devA.id, portions);          // le telephone renvoie les MEMES operations, le referentiel a evolue
  const rp2 = await push(tAgent, devB.id, portions);
  verifier("A7.8b 5 portions hors ligne apres ajout du vocabulaire : les memes operations sont APPLIQUEES (5 SYNCHRONISE), puis 5 REJOUEE, 5 lignes, toutes A_VALIDER (le terrain propose, il ne valide pas)",
    rp1.body.synchronisees === 5 && rp2.body.rejouees === 5
    && await compter(`SELECT count(*) n FROM portions WHERE "clientOperationId" IN (${idsP}) AND "statutValidation"::text = 'A_VALIDER'`) === 5, [rp1.body, rp2.body]);
  const inversee = { ...portions[0], operationId: randomUUID(), entityId: randomUUID(), payload: { ...portions[0].payload, debutM: 500, finM: 100 } };
  const ri1 = await push(tAgent, devA.id, [inversee]);
  const ri2 = await push(tAgent, devA.id, [inversee]);
  verifier("A7.8b une portion aux bornes inversees est REJETEE (definitif) et, renvoyee, reste REJETEE : jamais rendue comme un succes",
    resultats(ri1)[0]?.statut === "REJETE" && resultats(ri2)[0]?.statut === "REJETE" && resultats(ri2)[0]?.motif === resultats(ri1)[0]?.motif
    && await compter(`SELECT count(*) n FROM portions WHERE "clientOperationId" = '${inversee.operationId}'`) === 0, [ri1.body, ri2.body]);

  // --- A7.9 Une cle connue n'est pas un oracle : un autre compte ne rejoue pas mon operation.
  const rVol = await push(tAutre, devAutre.id, [file1[0]]);
  verifier("A7.9 un autre agent qui renvoie une de mes cles est REJETE (OPERATION_NON_AUTORISEE), sans rien apprendre",
    resultats(rVol)[0]?.motif === "OPERATION_NON_AUTORISEE" && resultats(rVol)[0]?.entityId === undefined, rVol.body);

  // --- A7.10 Bilan : le modele du banc contre la base, de bout en bout.
  const attenduCreations = [...file1, ...file2, ...creations, ...file3.filter((_, i) => i !== 24), ...file4, opPiegee];
  const enBase = new Set((await prisma.$queryRawUnsafe<{ k: string }[]>(`SELECT "clientOperationId" k FROM observations WHERE "agentId"='${agent.id}'`)).map((x) => x.k));
  const manquantes = attenduCreations.filter((o) => !enBase.has(o.operationId)).length;
  const inattendues = [...enBase].filter((k) => ![...attenduCreations.map((o) => o.operationId), ...defauts.map((d) => `${d.operationId}-observation`)].includes(k)).length;
  verifier(`A7.10 bilan : ${attenduCreations.length} observations emises (hors le rejet voulu), 0 manquante, 0 en trop dans la base`, manquantes === 0 && inattendues === 0, { manquantes, inattendues });
  const doublonsId = await compter(`SELECT count(*) n FROM (SELECT "clientOperationId" FROM observations GROUP BY 1 HAVING count(*) > 1) d`);
  verifier("A7.10 bilan : aucune cle d'idempotence portee par deux lignes (observations)", doublonsId === 0, doublonsId);

  // ============================================================== A8
  console.log("\n== A8 : conflit signale, deux versions conservees ==");

  // --- A8.1 Deux appareils, meme objet, versions successives.
  const o1 = nouvelleObs(600, { description: "version initiale" });
  await push(tAgent, devA.id, [o1]);
  const uA = majObs(o1, "modifie par l'appareil A", 1);
  const uB = majObs(o1, "modifie par l'appareil B (hors ligne)", 1);
  const rA = await push(tAgent, devA.id, [uA]);
  verifier("A8.1 l'appareil A modifie depuis la version 1 : SYNCHRONISE, version 2", resultats(rA)[0]?.statut === "SYNCHRONISE" && resultats(rA)[0]?.version === 2, rA.body);
  const rB = await push(tAgent, devB.id, [uB]);
  const cB = resultats(rB)[0];
  verifier("A8.1 l'appareil B, parti de la version 1, recoit un CONFLIT (VERSION_PERIMEE) avec l'identifiant du conflit", cB?.statut === "CONFLIT" && cB.motif === "VERSION_PERIMEE" && !!cB.conflitId, rB.body);
  const apresB = await obsDe(o1.entityId);
  verifier("A8.1 aucune ecrasement : l'observation garde la version 2 de A, intacte", apresB?.description === "modifie par l'appareil A" && apresB?.version === 2, apresB);
  const conflit1 = await prisma.conflitSync.findUnique({ where: { id: cB!.conflitId! } });
  const local1 = conflit1?.payloadLocal as { description?: string }, serveur1 = conflit1?.payloadServeur as { description?: string; version?: number };
  verifier("A8.1 DEUX VERSIONS CONSERVEES : le conflit porte la version locale de B ET l'etat du serveur (A, version 2)",
    local1?.description === "modifie par l'appareil B (hors ligne)" && serveur1?.description === "modifie par l'appareil A" && serveur1?.version === 2, conflit1);
  verifier("A8.1 l'operation de B est tracee CONFLIT, le conflit est non resolu", (await prisma.operationSync.findUnique({ where: { operationId: uB.operationId } }))?.statut === "CONFLIT" && conflit1?.resolution === null);
  const st = await request(app).get(`/api/v2/sync/status?appareilId=${devB.id}`).set("Authorization", `Bearer ${tAgent}`);
  verifier("A8.1 /status de l'appareil B compte 1 conflit non resolu, a part des echecs", st.body.conflitsNonResolus === 1 && st.body.operations?.CONFLIT === 1, st.body);
  const rB2 = await push(tAgent, devB.id, [uB]);
  verifier("A8.1 le renvoi de l'operation en conflit REND LE CONFLIT (meme conflitId), il ne se fait pas passer pour un succes",
    resultats(rB2)[0]?.statut === "CONFLIT" && resultats(rB2)[0]?.conflitId === cB!.conflitId, rB2.body);
  verifier("A8.1 ... et ne cree pas un second conflit", await compter(`SELECT count(*) n FROM conflits_sync WHERE "operationId"='${uB.operationId}'`) === 1);

  // --- A8.2 Resolution : on garde la version du serveur.
  const rr1 = await resoudre(tAgent, cB!.conflitId!, "SERVEUR");
  const c1 = await prisma.conflitSync.findUnique({ where: { id: cB!.conflitId! } });
  verifier("A8.2 resolution SERVEUR : conflit tranche (qui, quand), observation inchangee",
    rr1.status === 200 && c1?.resolution === "SERVEUR" && c1.resoluParId === agent.id && !!c1.resoluA && (await obsDe(o1.entityId))?.version === 2, rr1.body);
  const opB = await prisma.operationSync.findUnique({ where: { operationId: uB.operationId } });
  verifier("A8.2 l'operation de B passe REJETE / CONFLIT_RESOLU_VERSION_SERVEUR", opB?.statut === "REJETE" && opB.derniereErreur === "CONFLIT_RESOLU_VERSION_SERVEUR", opB);
  const rB3 = await push(tAgent, devB.id, [uB]);
  verifier("A8.2 le telephone qui renvoie l'operation tranchee apprend REJETE (version serveur retenue), pas REJOUEE", resultats(rB3)[0]?.statut === "REJETE" && resultats(rB3)[0]?.motif === "CONFLIT_RESOLU_VERSION_SERVEUR", rB3.body);
  verifier("A8.2 une seconde resolution du meme conflit est refusee (409)", (await resoudre(tAgent, cB!.conflitId!, "LOCAL")).status === 409);
  verifier("A8.2 la resolution est auditee (ConflitSync, auteur, choix)",
    await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType"='ConflitSync' AND "entityId"='${cB!.conflitId}' AND "userId"='${agent.id}'`) === 1);

  // --- A8.3 Resolution : on prend la version locale.
  const o2 = nouvelleObs(601, { description: "initiale 2" });
  await push(tAgent, devA.id, [o2]);
  await push(tAgent, devA.id, [majObs(o2, "A2", 1)]);
  const uB2 = majObs(o2, "B2 locale", 1);
  const cB2 = resultats(await push(tAgent, devB.id, [uB2]))[0];
  const rr2 = await resoudre(tAgent, cB2.conflitId!, "LOCAL");
  const apresLocal = await obsDe(o2.entityId);
  verifier("A8.3 resolution LOCAL : la version de B est appliquee, la version passe a 3", rr2.status === 200 && apresLocal?.description === "B2 locale" && apresLocal.version === 3, apresLocal);
  verifier("A8.3 l'operation de B passe SYNCHRONISE", (await prisma.operationSync.findUnique({ where: { operationId: uB2.operationId } }))?.statut === "SYNCHRONISE");
  const cLocal = await prisma.conflitSync.findUnique({ where: { id: cB2.conflitId! } });
  verifier("A8.3 la version ecrasee reste conservee dans le conflit apres resolution (payloadServeur = A2, version 2)",
    (cLocal?.payloadServeur as { description?: string })?.description === "A2" && (cLocal?.payloadServeur as { version?: number })?.version === 2);
  const auditObs = await prisma.$queryRawUnsafe<{ avant: string; apres: string }[]>(
    `SELECT "before"->>'description' avant, "after"->>'description' apres FROM audit_logs WHERE "entityType"='Observation' AND action='UPDATE' AND "entityId"='${o2.entityId}' ORDER BY "createdAt" DESC LIMIT 1`);
  verifier("A8.3 l'ecriture de la version locale est auditee avec avant (A2) et apres (B2 locale)", auditObs[0]?.avant === "A2" && auditObs[0]?.apres === "B2 locale", auditObs);

  // --- A8.4 Trois appareils : deux conflits sur le meme objet.
  const o3 = nouvelleObs(602, { description: "initiale 3" });
  await push(tAgent, devA.id, [o3]);
  await push(tAgent, devA.id, [majObs(o3, "A3", 1)]);
  const cB3 = resultats(await push(tAgent, devB.id, [majObs(o3, "B3", 1)]))[0];
  const cC3 = resultats(await push(tAgent, devC.id, [majObs(o3, "C3", 1)]))[0];
  verifier("A8.4 B et C, tous deux partis de la version 1, ont chacun leur conflit (2 conflits distincts)", cB3.statut === "CONFLIT" && cC3.statut === "CONFLIT" && cB3.conflitId !== cC3.conflitId);
  verifier("A8.4 on tranche B en LOCAL : version 3 = B3", (await resoudre(tAgent, cB3.conflitId!, "LOCAL")).status === 200 && (await obsDe(o3.entityId))?.description === "B3");
  const rrC = await resoudre(tAgent, cC3.conflitId!, "LOCAL");
  verifier("A8.4 trancher C en LOCAL est REFUSE (409 : l'observation a change depuis) et C reste non tranche, sans rien ecraser",
    rrC.status === 409 && (await prisma.conflitSync.findUnique({ where: { id: cC3.conflitId! } }))?.resolution === null && (await obsDe(o3.entityId))?.description === "B3", rrC.body);
  verifier("A8.4 C peut etre tranche en SERVEUR, et B3 demeure", (await resoudre(tAgent, cC3.conflitId!, "SERVEUR")).status === 200 && (await obsDe(o3.entityId))?.version === 3);

  // --- A8.5 Deux arbitres en meme temps.
  const o4 = nouvelleObs(603, { description: "initiale 4" });
  await push(tAgent, devA.id, [o4]);
  await push(tAgent, devA.id, [majObs(o4, "A4", 1)]);
  const cB4 = resultats(await push(tAgent, devB.id, [majObs(o4, "B4", 1)]))[0];
  const [x1, x2] = await Promise.all([resoudre(tAgent, cB4.conflitId!, "LOCAL"), resoudre(tChef, cB4.conflitId!, "SERVEUR")]);
  const final4 = await prisma.conflitSync.findUnique({ where: { id: cB4.conflitId! } });
  const obs4 = await obsDe(o4.entityId);
  const gagnant = [x1.status, x2.status].sort().join(",");
  verifier("A8.5 deux arbitrages simultanes : un seul reussit (200) et l'autre est refuse (409)", gagnant === "200,409", [x1.status, x2.status]);
  verifier("A8.5 l'etat final est coherent avec le gagnant (LOCAL => B4 v3 ; SERVEUR => A4 v2), jamais un melange",
    (final4?.resolution === "LOCAL" && obs4?.description === "B4" && obs4.version === 3) || (final4?.resolution === "SERVEUR" && obs4?.description === "A4" && obs4.version === 2), { final4: final4?.resolution, obs4 });

  // --- A8.6 Modification contre suppression, dans les deux sens.
  const o5 = nouvelleObs(604, { description: "initiale 5" });
  await push(tAgent, devA.id, [o5]);
  await push(tAgent, devA.id, [supprObs(o5, 1)]);                       // A supprime (suppression logique, version 2)
  const rMS = resultats(await push(tAgent, devB.id, [majObs(o5, "B5 modifie une observation supprimee", 1)]))[0];
  verifier("A8.6 modifier une observation supprimee entre-temps est un CONFLIT signale (version perimee), pas un refus muet",
    rMS?.statut === "CONFLIT" && rMS.motif === "VERSION_PERIMEE" && !!rMS.conflitId, rMS);
  const cMS = await prisma.conflitSync.findUnique({ where: { id: rMS.conflitId! } });
  verifier("A8.6 les deux versions sont conservees : la modification locale ET l'etat supprime du serveur",
    (cMS?.payloadLocal as { description?: string })?.description === "B5 modifie une observation supprimee" && !!(cMS?.payloadServeur as { deletedAt?: string })?.deletedAt, cMS);
  verifier("A8.6 la suppression est logique : la ligne existe toujours, avec deletedAt", await compter(`SELECT count(*) n FROM observations WHERE id='${o5.entityId}' AND "deletedAt" IS NOT NULL`) === 1);
  verifier("A8.6 on ne peut pas ressusciter une observation supprimee : LOCAL refuse (409), SERVEUR accepte",
    (await resoudre(tAgent, rMS.conflitId!, "LOCAL")).status === 409 && (await resoudre(tAgent, rMS.conflitId!, "SERVEUR")).status === 200);

  const o6 = nouvelleObs(605, { description: "initiale 6" });
  await push(tAgent, devA.id, [o6]);
  await push(tAgent, devA.id, [majObs(o6, "A6", 1)]);
  const rSM = resultats(await push(tAgent, devB.id, [supprObs(o6, 1)]))[0];
  verifier("A8.6 supprimer une observation modifiee entre-temps est un CONFLIT, l'observation reste vivante", rSM?.statut === "CONFLIT" && (await obsDe(o6.entityId))?.deletedAt === null);
  verifier("A8.6 resolution LOCAL de la suppression : suppression logique, version 3, ligne conservee", (await resoudre(tAgent, rSM.conflitId!, "LOCAL")).status === 200
    && !!(await obsDe(o6.entityId))?.deletedAt && (await obsDe(o6.entityId))?.version === 3);

  // --- A8.7 Deux appareils creent le meme objet.
  const o7 = nouvelleObs(606, { description: "creation A" });
  const o7b: Op = { ...nouvelleObs(607, { description: "creation B" }), entityId: o7.entityId };
  await push(tAgent, devA.id, [o7]);
  const rCC = resultats(await push(tAgent, devB.id, [o7b]))[0];
  verifier("A8.7 deux creations du meme objet sous deux cles : la seconde est un CONFLIT (DEJA_EXISTANTE), une seule ligne en base",
    rCC?.statut === "CONFLIT" && rCC.motif === "DEJA_EXISTANTE" && await compter(`SELECT count(*) n FROM observations WHERE id='${o7.entityId}'`) === 1, rCC);
  verifier("A8.7 un conflit de creation ne peut pas etre tranche en LOCAL (il remplacerait l'existant) : 409 NOUVEL_IDENTIFIANT_REQUIS",
    (await resoudre(tAgent, rCC.conflitId!, "LOCAL")).body.motif === "NOUVEL_IDENTIFIANT_REQUIS");

  // --- A8.8 Defaut : jamais d'ecrasement automatique, arbitrage reserve.
  const d1 = nouveauDefaut(900);
  await push(tAgent, devA.id, [d1]);
  const d1b: Op = { ...nouveauDefaut(901), entityId: d1.entityId };
  const rDC = resultats(await push(tAgent, devB.id, [d1b]))[0];
  verifier("A8.8 deux creations du meme defaut sous deux cles : CONFLIT, un seul defaut en base",
    rDC?.statut === "CONFLIT" && await compter(`SELECT count(*) n FROM defauts WHERE id='${d1.entityId}'`) === 1, rDC);
  verifier("A8.8 l'agent ne tranche pas un conflit de defaut (403) ; le gestionnaire le peut en SERVEUR, pas en LOCAL (409)",
    (await resoudre(tAgent, rDC.conflitId!, "SERVEUR")).status === 403
    && (await resoudre(tChef, rDC.conflitId!, "LOCAL")).status === 409
    && (await resoudre(tChef, rDC.conflitId!, "SERVEUR")).status === 200);

  // --- A8.9 Cloisonnement : un autre agent ne voit ni ne tranche mon conflit.
  const o9 = nouvelleObs(608);
  await push(tAgent, devA.id, [o9]);
  await push(tAgent, devA.id, [majObs(o9, "A9", 1)]);
  const c9 = resultats(await push(tAgent, devB.id, [majObs(o9, "B9", 1)]))[0];
  verifier("A8.9 un autre agent ne peut pas trancher mon conflit (404)", (await resoudre(tAutre, c9.conflitId!, "SERVEUR")).status === 404);
  const st9 = await request(app).get(`/api/v2/sync/status?appareilId=${devB.id}`).set("Authorization", `Bearer ${tAutre}`);
  verifier("A8.9 ... ni lire l'etat de mon appareil (404)", st9.status === 404);

  // --- A8.10 Jamais de suppression physique : le nombre de lignes ne baisse pas.
  const lignes = await compter(`SELECT count(*) n FROM observations`);
  const supprimeesLogiquement = await compter(`SELECT count(*) n FROM observations WHERE "deletedAt" IS NOT NULL`);
  verifier("A8.10 aucune ligne physiquement supprimee : toutes les observations emises sont presentes (suppressions logiques comprises)",
    lignes >= 50 + 50 + 25 + 49 + 20 + 1 && supprimeesLogiquement >= 2, { lignes, supprimeesLogiquement });
  // Les observations-conteneurs des defauts (creees dans la transaction du defaut) sont couvertes par l'audit
  // du DEFAUT, pas par un CREATE Observation : on les met de cote, et on le dit.
  verifier("A8.10 le journal d'audit n'a perdu aucune observation du terrain : autant de CREATE que d'observations hors conteneurs de defaut",
    await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType"='Observation' AND action='CREATE'`)
    === (await compter(`SELECT count(*) n FROM observations o WHERE NOT EXISTS (SELECT 1 FROM defauts d WHERE d."observationId" = o.id)`)));
  verifier("A8.10 chaque defaut du terrain a son audit CREATE Defaut",
    await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType"='Defaut' AND action='CREATE'`) === (await compter(`SELECT count(*) n FROM defauts`)));

  conclure();
}

main()
  .catch((e) => { console.error(e); process.exitCode = 2; })
  .finally(async () => { await prisma.$disconnect(); await banc.fermer(); });

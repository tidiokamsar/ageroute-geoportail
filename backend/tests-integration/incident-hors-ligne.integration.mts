// Banc d'integration : LA MOITIE SERVEUR de « incident saisi hors ligne -> main courante immuable » (A24).
// Voir tests-integration/README.md et docs/scenarios/A23-A24.md. Lancer (DATABASE_URL pointe sur `replay`) :
//   npx tsx tests-integration/incident-hors-ligne.integration.mts
//
// CE QUE LE BANC FAIT : il rejoue, contre les routes reelles de la main courante et un clone PostGIS jetable, ce
// qu'un appareil enverrait en rentrant dans la couverture reseau : un incident declare plusieurs heures plus tot
// (`horodatageClient`), renvoye apres une reponse perdue, renvoye en rafale depuis deux appareils, suivi de ses
// changements de statut hors ligne. Il verifie que :
//   - l'HEURE FAISANT FOI est celle du serveur (`enregistreLe`), l'heure de l'appareil est conservee A COTE, et un
//     corps qui tente d'imposer `enregistreLe` est sans effet ;
//   - le rejeu d'une meme cle (`clientOperationId`) ne cree jamais un second incident, en sequence comme en rafale ;
//     et chaque envoi perdant d'une rafale recoit « deja recu » (200), pas une erreur serveur : avant la correction
//     du 26/10/2026 (src/exploitation/cle-operation.ts), 10 envois sur 12 recevaient une erreur 500 ;
//   - la chaine d'un incident se relit dans l'ordre de reception, avec son statut courant ;
//   - la base refuse toute modification et tout effacement (ajout seul).
//
// CE QU'IL NE PROUVE PAS, ET QUI MANQUE : LA FILE LOCALE DE L'APPAREIL. Aucune file hors ligne ne stocke un incident
// sur le telephone (voir docs/scenarios/A23-A24.md : elle exige une extension de `offlineDb.ts` et de
// `offlineSync.ts`, partages avec la file des observations). Le « hors ligne » est ici une date client ancienne et un
// envoi rejoue ; ni coupure reseau reelle, ni stockage du navigateur, ni appareil.
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure } from "./lib/verdict.ts";

const banc = await ouvrirBancClone("essai_incident");
const { prisma } = await banc.imp("lib/prisma");
const { errorHandler } = await banc.imp("middleware/error.middleware");
const { signAccessToken } = await banc.imp("utils/jwt");
const { exploitationV2Router } = await banc.imp("api-v2/exploitation.routes");
// Comme src/server.ts : les colonnes BigInt (rang des entrees) se serialisent en texte.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (this: bigint) { return this.toString(); };
const express = (await import("express")).default;
const request = (await import("supertest")).default;

const app = express();
app.use(express.json());
app.use("/api/v2/exploitation", exploitationV2Router);
app.use(errorHandler);

const sql = async <T = Record<string, unknown>>(texte: string, ...p: unknown[]): Promise<T[]> => prisma.$queryRawUnsafe(texte, ...p);
const compter = async (texte: string, ...p: unknown[]) => Number((await sql<{ n: bigint }>(texte, ...p))[0].n);
const horsLigne = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const cle = (s: string) => `banc-incident-${s}-${Date.now()}`;

async function main() {
  const agent = await prisma.user.create({ data: { email: "agent@incident.invalid", nomComplet: "Agent terrain banc", passwordHash: "x", role: "INSPECTEUR" } });
  const auth = { Authorization: `Bearer ${signAccessToken({ sub: agent.id, role: agent.role, email: agent.email })}` };
  const post = (url: string, corps: unknown) => request(app).post(url).set(auth).send(corps as object);
  const declaration = (extra: Record<string, unknown> = {}) => ({
    typeCode: "COUPURE", sourceCode: "PATROUILLE", texte: "Arbre en travers de la RN1 (saisi hors ligne)", point: [-13.6, 9.64], ...extra,
  });

  // ---------------------------------------------------------------- 1. Heure serveur contre heure appareil
  const k1 = cle("heure");
  const t3h = horsLigne(3);
  const r1 = await post("/api/v2/exploitation/main-courante", declaration({ clientOperationId: k1, horodatageClient: t3h, enregistreLe: "2020-01-01T00:00:00Z" }));
  verifier("un incident declare il y a 3 h par l'appareil est accepte (201)", r1.status === 201, r1.body);
  const ligne1 = (await sql<{ enregistreLe: Date; horodatageClient: Date; ecartS: number }>(
    `SELECT "enregistreLe", "horodatageClient", EXTRACT(EPOCH FROM (now() - "enregistreLe")) AS "ecartS" FROM main_courante WHERE "clientOperationId" = $1`, k1))[0];
  verifier("l'heure qui fait foi (enregistreLe) est celle du SERVEUR : a moins de 60 s de l'horloge de la base, pas celle envoyee par le corps",
    Math.abs(ligne1.ecartS) < 60 && ligne1.enregistreLe.getFullYear() >= 2026, ligne1);
  verifier("l'heure de l'appareil est conservee a part (horodatageClient = 3 h avant), et elle ne remplace pas l'heure serveur",
    Math.abs(new Date(ligne1.horodatageClient).getTime() - new Date(t3h).getTime()) < 1000 && new Date(ligne1.enregistreLe).getTime() - new Date(ligne1.horodatageClient).getTime() > 2.9 * 3_600_000, ligne1);

  // ---------------------------------------------------------------- 2. Rejeu apres reponse perdue
  const evenementId = r1.body.evenementId as string;
  const rejeux = [];
  for (let i = 0; i < 5; i++) rejeux.push(await post("/api/v2/exploitation/main-courante", declaration({ clientOperationId: k1, horodatageClient: t3h })));
  verifier("5 rejeux de la meme cle (reponse perdue cote appareil) : 5 reponses 200, meme incident, aucune creation",
    rejeux.every((r) => r.status === 200 && r.body.dejaRecue === true && r.body.evenementId === evenementId)
    && await compter(`SELECT count(*) n FROM main_courante WHERE "clientOperationId" = $1`, k1) === 1, rejeux.map((r) => r.status));
  verifier("un seul incident, une seule trace d'audit de creation malgre les rejeux",
    await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'EntreeMainCourante' AND "entityId" = $1 AND action = 'CREATE'`, r1.body.entree.id) === 1);

  // ---------------------------------------------------------------- 3. Rafale depuis deux appareils
  const k2 = cle("rafale");
  const rafale = await Promise.all(Array.from({ length: 12 }, () => post("/api/v2/exploitation/main-courante", declaration({ clientOperationId: k2, horodatageClient: horsLigne(1) }))));
  const statuts = rafale.map((r) => r.status).sort();
  console.log("rafale de 12 envois simultanes de la meme cle, statuts :", statuts.join(","));
  verifier("rafale de 12 envois simultanes de la meme cle : UN SEUL incident en base, jamais de doublon",
    await compter(`SELECT count(*) n FROM main_courante WHERE "clientOperationId" = $1`, k2) === 1, statuts);
  verifier("rafale : exactement UN envoi cree (201), les 11 autres sont reconnus comme des rejeux (200) : aucune erreur serveur",
    statuts.filter((x) => x === 201).length === 1 && statuts.filter((x) => x === 200).length === 11, statuts);
  const gagnant = rafale.find((r) => r.status === 201)!.body.entree.id;
  verifier("rafale : les 11 rejeux designent l'incident du gagnant, pas un autre", rafale.filter((r) => r.status === 200).every((r) => r.body.dejaRecue === true && r.body.entree.id === gagnant));

  // ---------------------------------------------------------------- 4. Chaine hors ligne : declaration, prise en compte, cloture
  const k3 = cle("chaine");
  const d = await post("/api/v2/exploitation/main-courante", declaration({ clientOperationId: k3, horodatageClient: horsLigne(3) }));
  const ev = d.body.evenementId as string;
  const e1 = await post(`/api/v2/exploitation/main-courante/${ev}/entrees`, { nature: "STATUT", statut: "PRIS_EN_COMPTE", texte: "Vu sur place", clientOperationId: cle("e1"), horodatageClient: horsLigne(2) });
  const e2 = await post(`/api/v2/exploitation/main-courante/${ev}/entrees`, { nature: "STATUT", statut: "CLOS", texte: "Arbre degage", clientOperationId: cle("e2"), horodatageClient: horsLigne(1) });
  verifier("declaration, prise en compte et cloture saisies hors ligne, renvoyees dans l'ordre : 201, 201, 201", d.status === 201 && e1.status === 201 && e2.status === 201, [d.body, e1.body, e2.body]);
  const rejoueE1 = await post(`/api/v2/exploitation/main-courante/${ev}/entrees`, { nature: "STATUT", statut: "PRIS_EN_COMPTE", texte: "Vu sur place", clientOperationId: e1.body.entree.clientOperationId, horodatageClient: horsLigne(2) });
  verifier("le rejeu d'une entree de la chaine (meme cle) est reconnu : 200, aucune entree de plus", rejoueE1.status === 200 && await compter(`SELECT count(*) n FROM main_courante WHERE "evenementId" = $1`, ev) === 3, rejoueE1.body);
  const chaine = await request(app).get(`/api/v2/exploitation/main-courante/${ev}`).set(auth);
  const natures = (chaine.body.entrees ?? chaine.body.chaine ?? []).map((x: { nature: string; statut: string | null }) => `${x.nature}:${x.statut ?? "-"}`);
  verifier("la chaine se relit dans l'ordre de RECEPTION, et le statut courant est CLOS",
    chaine.status === 200 && natures.join(",") === "DECLARATION:OUVERT,STATUT:PRIS_EN_COMPTE,STATUT:CLOS" && (chaine.body.statutCourant ?? chaine.body.statut) === "CLOS", chaine.body);
  const horloges = await sql<{ rang: string; ordreServeur: boolean; ordreClient: boolean }>(
    `SELECT rang::text, "enregistreLe" >= lag("enregistreLe") OVER (ORDER BY rang) AS "ordreServeur", "horodatageClient" >= lag("horodatageClient") OVER (ORDER BY rang) AS "ordreClient" FROM main_courante WHERE "evenementId" = $1 ORDER BY rang`, ev);
  verifier("heure serveur croissante dans l'ordre de reception ; heures d'appareil conservees telles quelles (3 h, 2 h, 1 h avant)",
    horloges.slice(1).every((h) => h.ordreServeur === true && h.ordreClient === true), horloges);

  // ---------------------------------------------------------------- 5. Immuabilite en base
  const refusUpdate = await sql(`UPDATE main_courante SET texte = 'reecrit' WHERE "evenementId" = $1`, ev).then(() => "accepte", (e: Error) => e.message);
  const refusDelete = await sql(`DELETE FROM main_courante WHERE "evenementId" = $1`, ev).then(() => "accepte", (e: Error) => e.message);
  const refusHeure = await sql(`UPDATE main_courante SET "enregistreLe" = now() - interval '5 days' WHERE "evenementId" = $1`, ev).then(() => "accepte", (e: Error) => e.message);
  verifier("la base refuse UPDATE, DELETE et la retro-datation de l'heure serveur d'une entree (ajout seul)",
    refusUpdate !== "accepte" && refusDelete !== "accepte" && refusHeure !== "accepte"
    && (await sql<{ texte: string }>(`SELECT texte FROM main_courante WHERE "evenementId" = $1 AND nature = 'DECLARATION'`, ev))[0].texte.startsWith("Arbre en travers"), [refusUpdate, refusDelete, refusHeure]);
  verifier("aucune route ne permet de modifier ou d'effacer une entree (PUT, PATCH, DELETE : 404)",
    (await request(app).put(`/api/v2/exploitation/main-courante/${ev}`).set(auth).send({ texte: "x" })).status === 404
    && (await request(app).delete(`/api/v2/exploitation/main-courante/${ev}`).set(auth)).status === 404
    && (await request(app).patch(`/api/v2/exploitation/main-courante/${ev}`).set(auth).send({ texte: "x" })).status === 404);

  // ---------------------------------------------------------------- 6. Contre-epreuve : sans cle, le rejeu cree un doublon
  const sansCle = [await post("/api/v2/exploitation/main-courante", declaration()), await post("/api/v2/exploitation/main-courante", declaration())];
  verifier("CONTRE-EPREUVE : SANS clientOperationId, deux envois identiques creent deux incidents (c'est la cle d'idempotence qui protege, pas le texte) : l'appareil doit donc toujours en envoyer une",
    sansCle.every((r) => r.status === 201) && sansCle[0].body.evenementId !== sansCle[1].body.evenementId);
  verifier("une date d'appareil dans le futur n'avance pas l'heure serveur (enregistreLe reste l'heure de la base)",
    await (async () => {
      const k = cle("futur");
      const r = await post("/api/v2/exploitation/main-courante", declaration({ clientOperationId: k, horodatageClient: new Date(Date.now() + 10 * 86_400_000).toISOString() }));
      const l = (await sql<{ ecartS: number }>(`SELECT EXTRACT(EPOCH FROM (now() - "enregistreLe")) AS "ecartS" FROM main_courante WHERE "clientOperationId" = $1`, k))[0];
      return (r.status === 201 || r.status === 400) && (r.status === 400 || Math.abs(l.ecartS) < 60);
    })());
}

main()
  .catch((e) => { console.error(e); process.exitCode = 2; })
  .finally(async () => { conclure(); await prisma.$disconnect(); await banc.fermer(); });

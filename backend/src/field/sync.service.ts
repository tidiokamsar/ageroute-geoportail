import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { appliquerPortionSync, refusDefinitif } from "./portions.sync";
import { deriveGeomFromTroncon, deriveGeomFromTronconAbscisse, setPointGeom } from "../lib/geo";
import { logAuditTransactionnelle } from "../utils/audit";
import { preparerDefautSync, type PreparationDefautSync } from "./defauts.sync";
import { preparerPayloadObservationSync } from "./observation-sync-payload";
import { ecrireEmprise } from "./defauts.emprise";
import { decider, delaiAvantReessai, type Decision, type OperationEntrante } from "./sync";

/**
 * Application des operations remontees du terrain.
 *
 * La DECISION vit dans `sync.ts` et se teste sans base. Ce fichier-ci ne fait que
 * l'executer : lire l'etat, appeler `decider`, ecrire ce qu'elle dit. La separation
 * n'est pas cosmetique — c'est elle qui rend les six cas de la section 15 verifiables.
 *
 * TYPES ET OPERATIONS PRIS EN CHARGE
 *
 * Observation garde son cycle actuel. Defaut accepte CREATE hors ligne : sa validation
 * et ses transitions d'etat passent par les routes metier dediees. Le payload de
 * creation est valide et projete par `defauts.sync.ts`; aucun statut ni auteur fourni
 * par le telephone n'est applique.
 */

/** Types que `push` sait appliquer. La liste grandira avec les services. */
export const TYPES_ACCEPTES = new Set(["Observation", "Defaut", "Portion"]);

/** Operations actuellement prises en charge par type, exposees aux clients terrain. */
export const OPERATIONS_ACCEPTEES: Record<string, readonly string[]> = {
  Observation: ["CREATE", "UPDATE", "DELETE"],
  Defaut: ["CREATE"],
  // CREATE seul, comme Defaut. Le decoupage, la fusion et la requalification passent par
  // les routes metier : ce sont des arbitrages sur l'etat du reseau, et les faire arriver
  // d'une file hors ligne demanderait de resoudre les conflits de bornes a l'aveugle.
  Portion: ["CREATE"],
};

export interface ResultatOperation {
  operationId: string;
  statut: "SYNCHRONISE" | "REJOUEE" | "CONFLIT" | "REJETE";
  entityId?: string;
  version?: number;
  motif?: string;
  /** Present sur un conflit : la ligne a arbitrer. */
  conflitId?: string;
  /** Present sur un rejet temporaire : quand reessayer. */
  reessayerDansMs?: number;
}

/** Version courante, tombstone compris : un CREATE ne doit pas reutiliser un id archive. */
async function versionEntite(entityType: string, entityId: string): Promise<number | null> {
  if (entityType === "Observation") {
    const observation = await prisma.observation.findUnique({ where: { id: entityId }, select: { version: true } });
    return observation?.version ?? null;
  }
  /**
   * PORTION N'A PAS DE COLONNE `version`, ET C'EST TRAITE EXPLICITEMENT.
   *
   * Sans ce branchement, une operation Portion tombait dans la requete `defaut` ci-dessous
   * et rendait `null` parce qu'aucun defaut ne porte cet identifiant. La reponse etait
   * juste PAR ACCIDENT, et fausse dans un cas : si un defaut portait le meme identifiant
   * client — les deux sont generes par l'appareil — `decider` aurait lu la version d'une
   * autre entite et traite le CREATE comme un rejeu.
   *
   * Une portion ne se concurrence pas par version : son idempotence vient de
   * `clientOperationId`, unique en base, et ses transitions passent par les routes metier.
   */
  if (entityType === "Portion") return null;

  const defaut = await prisma.defaut.findUnique({ where: { id: entityId }, select: { version: true } });
  return defaut?.version ?? null;
}

/**
 * Un refus enregistre peut-il etre reevalue quand le telephone renvoie la meme operation ?
 *
 * OUI pour ce qui peut changer sans que l'operation change : la modification d'une entite qui
 * n'existe pas ENCORE (elle a pu arriver avant sa creation, ordre inverse d'un lot ou de deux
 * appareils), et un refus de portion que `refusDefinitif` ne declare pas definitif.
 *
 * NON pour tout le reste : un payload invalide, une operation non supportee ou une mission non
 * autorisee ne changeront pas en reessayant. Les rendre tels quels evite une reevaluation inutile.
 *
 * POURQUOI CETTE DISTINCTION EXISTE : sans elle, toute operation refusee etait rendue
 * `REJOUEE` au second envoi, c'est-a-dire comme un SUCCES. Le telephone la retirait de sa file
 * et la saisie etait perdue pour de bon, sans erreur nulle part (banc `sync.integration.mts`, A7.4).
 */
export function rejetRetentable(entityType: string, motif: string | null): boolean {
  if (motif === "ENTITE_INTROUVABLE") return true;
  return entityType === "Portion" && motif !== null && !refusDefinitif(motif);
}

/**
 * Ce que l'on rend pour une operation DEJA enregistree, ou null si elle doit etre reevaluee.
 *
 * LE RESULTAT PRECEDENT EST RENDU FIDELEMENT. Un succes reste `REJOUEE`. Un conflit reste un
 * conflit, avec le meme identifiant : le renvoyer comme un succes ferait croire au telephone que
 * sa version a ete retenue alors qu'un responsable doit encore trancher. Un refus definitif reste
 * un refus, avec son motif.
 */
async function resultatPrecedent(
  operationId: string,
  trace: { entityId: string; entityType: string; statut: string; derniereErreur: string | null },
): Promise<ResultatOperation | null> {
  switch (trace.statut) {
    case "CONFLIT": {
      const conflit = await prisma.conflitSync.findFirst({ where: { operationId }, select: { id: true }, orderBy: { createdAt: "asc" } });
      return { operationId, statut: "CONFLIT", motif: trace.derniereErreur ?? undefined, conflitId: conflit?.id };
    }
    case "REJETE":
      if (rejetRetentable(trace.entityType, trace.derniereErreur)) return null;
      return { operationId, statut: "REJETE", motif: trace.derniereErreur ?? "REJET_ANTERIEUR" };
    default:
      return { operationId, statut: "REJOUEE", entityId: trace.entityId };
  }
}

/**
 * Applique une operation, en absorbant la course entre deux envois simultanes de la meme operation.
 *
 * Deux requetes qui portent la meme operation (reponse perdue puis renvoi, deux appareils du meme
 * agent) peuvent lire « pas encore traitee » toutes les deux. L'unicite en base, cle d'idempotence
 * ou identifiant de l'entite, empeche le doublon, mais la perdante echouait en erreur et FAISAIT
 * ECHOUER TOUT SON LOT. On reessaie donc UNE fois : la seconde lecture voit le travail de la
 * premiere et rend REJOUEE, ou CONFLIT si deux operations distinctes visaient la meme entite.
 */
export async function appliquer(
  op: OperationEntrante,
  contexte: { appareilId: string; userId: string },
): Promise<ResultatOperation> {
  try {
    return await appliquerUneFois(op, contexte);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return appliquerUneFois(op, contexte);
    }
    throw err;
  }
}

/**
 * Applique une operation, ou enregistre pourquoi elle ne l'a pas ete.
 *
 * TOUT SE JOUE DANS UNE SEULE TRANSACTION
 *
 * L'ecriture metier, la trace de l'operation et, le cas echeant, le conflit. Les
 * separer laisserait exister un etat ou l'entite est modifiee sans que l'operation
 * soit marquee traitee : le client reessaierait, et l'idempotence ne jouerait pas
 * puisque rien n'aurait ete enregistre. Le doublon reviendrait par la porte que ce
 * protocole est cense fermer.
 */
async function appliquerUneFois(
  op: OperationEntrante,
  contexte: { appareilId: string; userId: string },
): Promise<ResultatOperation> {
  if (!TYPES_ACCEPTES.has(op.entityType)) {
    return { operationId: op.operationId, statut: "REJETE", motif: `TYPE_NON_SUPPORTE:${op.entityType}` };
  }

  const dejaTraitee = await prisma.operationSync.findUnique({
    where: { operationId: op.operationId },
    select: { entityId: true, entityType: true, statut: true, userId: true, derniereErreur: true },
  });

  // Rejeu : on ne touche a rien et on rend ce qui avait ete decide la premiere fois.
  if (dejaTraitee) {
    // operationId est unique globalement, mais le resultat appartient au compte qui
    // l'a initialement soumis. Une cle connue ne doit pas devenir un oracle d'IDs.
    if (dejaTraitee.userId !== contexte.userId) {
      return { operationId: op.operationId, statut: "REJETE", motif: "OPERATION_NON_AUTORISEE" };
    }
    const precedent = await resultatPrecedent(op.operationId, dejaTraitee);
    if (precedent) return precedent;
    // Sinon : un refus TEMPORAIRE. L'operation est reevaluee ci-dessous, et sa ligne de trace
    // est mise a jour (voir `trace`) au lieu d'etre recreee.
  }

  if (!(OPERATIONS_ACCEPTEES[op.entityType] ?? []).includes(op.operation)) {
    const motif = `OPERATION_NON_SUPPORTEE:${op.entityType}:${op.operation}`;
    await prisma.operationSync.create({
      data: {
        operationId: op.operationId,
        appareilId: contexte.appareilId,
        userId: contexte.userId,
        entityType: op.entityType,
        entityId: op.entityId,
        operation: op.operation,
        payload: { redacted: true } as never,
        baseVersion: op.baseVersion ?? null,
        statut: "REJETE",
        derniereErreur: motif,
        traiteeA: new Date(),
      },
    });
    return { operationId: op.operationId, statut: "REJETE", motif };
  }

  if (op.entityType === "Observation") {
    const preparation = preparerPayloadObservationSync(op.operation, op.payload);
    if (!preparation.ok) {
      const motif = "PAYLOAD_INVALIDE:Observation";
      await prisma.operationSync.create({
        data: {
          operationId: op.operationId,
          appareilId: contexte.appareilId,
          userId: contexte.userId,
          entityType: op.entityType,
          entityId: op.entityId,
          operation: op.operation,
          payload: { redacted: true },
          baseVersion: op.baseVersion ?? null,
          statut: "REJETE",
          derniereErreur: motif,
          traiteeA: new Date(),
        },
      });
      return { operationId: op.operationId, statut: "REJETE", motif };
    }
    op = { ...op, payload: preparation.payload };
  }

  if (op.entityType === "Defaut" && op.operation === "CREATE") {
    // Le même identifiant peut avoir été traité par POST /defauts avant que le client
    // n'apprenne le résultat. Le retrouve via la clé métier et alimente aussi le journal
    // de sync, au lieu de produire un conflit avec l'objet qui vient d'être créé.
    const creeParLaMemeOperation = await prisma.defaut.findUnique({
      where: { clientOperationId: op.operationId },
      select: { id: true, version: true, constateParId: true },
    });
    if (creeParLaMemeOperation) {
      if (creeParLaMemeOperation.constateParId !== contexte.userId) {
        return { operationId: op.operationId, statut: "REJETE", motif: "OPERATION_NON_AUTORISEE" };
      }
      await prisma.operationSync.create({
        data: {
          operationId: op.operationId,
          appareilId: contexte.appareilId,
          userId: contexte.userId,
          entityType: op.entityType,
          entityId: creeParLaMemeOperation.id,
          operation: op.operation,
          payload: op.payload as never,
          baseVersion: op.baseVersion ?? null,
          statut: "SYNCHRONISE",
          traiteeA: new Date(),
        },
      });
      return {
        operationId: op.operationId,
        statut: "REJOUEE",
        entityId: creeParLaMemeOperation.id,
        version: creeParLaMemeOperation.version,
      };
    }
  }

  const versionActuelle = await versionEntite(op.entityType, op.entityId);
  const decision = decider(op, { versionActuelle });
  if (decision.action === "REJOUEE") {
    return { operationId: op.operationId, statut: "REJOUEE", entityId: decision.entityId };
  }

  const apresTransaction: { geometrieDefaut?: PreparationDefautSync } = {};
  const resultat = await prisma.$transaction(async (tx) => {
    /**
     * UPSERT, et non create : une operation refusee TEMPORAIREMENT (voir `rejetRetentable`) est
     * reevaluee quand le telephone la renvoie sous la MEME cle. Sa ligne existe deja ; la
     * recreer violerait l'unicite de `operationId`, et la laisser telle quelle ferait rendre
     * « deja traitee » a une operation qui n'a jamais ete appliquee.
     */
    const trace = async (
      statut: string,
      extra: Record<string, unknown> = {},
      payload: Record<string, unknown> = op.payload,
    ) => {
      const traiteeA = new Date();
      return tx.operationSync.upsert({
        where: { operationId: op.operationId },
        create: {
          operationId: op.operationId,
          appareilId: contexte.appareilId,
          userId: contexte.userId,
          entityType: op.entityType,
          entityId: op.entityId,
          operation: op.operation,
          payload: payload as never,
          baseVersion: op.baseVersion ?? null,
          statut: statut as never,
          traiteeA,
          ...extra,
        },
        update: {
          appareilId: contexte.appareilId,
          entityId: op.entityId,
          operation: op.operation,
          payload: payload as never,
          baseVersion: op.baseVersion ?? null,
          statut: statut as never,
          derniereErreur: (extra.derniereErreur as string | undefined) ?? null,
          traiteeA,
          tentatives: { increment: 1 },
        },
      });
    };

    if (decision.action === "REFUSER") {
      await trace("REJETE", { derniereErreur: decision.motif });
      return {
        operationId: op.operationId, statut: "REJETE" as const, motif: decision.motif,
        // Un refus definitif : reessayer ne changera rien tant que l'entite n'existe
        // pas. Le delai est donne pour que le client ne boucle pas a vide.
        reessayerDansMs: delaiAvantReessai(3),
      };
    }

    if (decision.action === "CONFLIT") {
      // Les DEUX versions sont conservees. C'est la regle de la section 15 pour la
      // donnee patrimoniale, et on l'applique a tout : departager par l'horloge d'un
      // telephone n'est jamais acceptable.
      const serveur = op.entityType === "Observation"
        ? await tx.observation.findUnique({ where: { id: op.entityId } })
        : await tx.defaut.findUnique({ where: { id: op.entityId } });
      const conflit = await tx.conflitSync.create({
        data: {
          operationId: op.operationId,
          entityType: op.entityType,
          entityId: op.entityId,
          payloadLocal: op.payload as never,
          payloadServeur: (serveur ?? {}) as never,
        },
      });
      await trace("CONFLIT", { derniereErreur: decision.motif });
      return { operationId: op.operationId, statut: "CONFLIT" as const, motif: decision.motif, conflitId: conflit.id };
    }

    if (decision.action === "CREER") {
      if (op.entityType === "Observation") {
        const missionId = op.payload.missionId;
        if (typeof missionId === "string") {
          const mission = await tx.mission.findFirst({
            where: {
              id: missionId,
              deletedAt: null,
              OR: [{ assigneId: contexte.userId }, { createurId: contexte.userId }],
            },
            select: { id: true },
          });
          if (!mission) {
            const motif = "MISSION_NON_AUTORISEE";
            await trace("REJETE", { derniereErreur: motif }, { redacted: true });
            return { operationId: op.operationId, statut: "REJETE" as const, motif };
          }
        }
        const observationPayload = { ...op.payload };
        if (typeof observationPayload.observeA === "string") {
          observationPayload.observeA = new Date(observationPayload.observeA);
        }
        const cree = await tx.observation.create({
          data: {
            ...observationPayload,
            id: op.entityId,
            clientOperationId: op.operationId,
            agentId: contexte.userId,
            statut: "PROPOSEE",
          } as never,
        });
        await trace("SYNCHRONISE");
        await logAuditTransactionnelle(tx, {
          userId: contexte.userId, action: "CREATE", entityType: "Observation",
          entityId: cree.id, after: cree,
        });
        return { operationId: op.operationId, statut: "SYNCHRONISE" as const, entityId: cree.id, version: cree.version };
      }

      if (op.entityType === "Portion") {
        // Delegue au MEME service que la route en ligne, dans CETTE transaction. Voir
        // `field/portions.sync.ts` pour pourquoi aucune regle n'est reimplementee ici.
        const r = await appliquerPortionSync(tx, op.payload, {
          userId: contexte.userId,
          operationId: op.operationId,
        });
        if (!r.ok) {
          // Un corps rejete peut contenir un champ imprevu : seul le motif est conserve.
          await trace("REJETE", { derniereErreur: r.motif }, { redacted: true });
          return {
            operationId: op.operationId,
            statut: "REJETE" as const,
            motif: r.motif,
            // Dit au telephone s'il doit renoncer ou reessayer. Sans cela, un refus
            // definitif revient a chaque retour de reseau et la file ne se vide jamais.
            ...(refusDefinitif(r.motif) ? {} : { reessayerDansMs: 60_000 }),
          };
        }
        await trace("SYNCHRONISE");
        // L'audit de la portion est pose par le depot, dans cette meme transaction : le
        // redoubler ici produirait deux lignes pour une seule ecriture.
        return { operationId: op.operationId, statut: "SYNCHRONISE" as const, entityId: r.portion.id };
      }

      const preparation = await preparerDefautSync(tx, {
        entityId: op.entityId,
        operationId: op.operationId,
        userId: contexte.userId,
        appareilId: contexte.appareilId,
      }, op.payload);
      if (!preparation.ok) {
        // Un corps rejeté peut contenir un champ imprévu avec des données sensibles.
        // Le motif suffit au diagnostic; conserver le payload brut transformerait
        // operation_sync en stockage durable de contenu non validé.
        await trace("REJETE", { derniereErreur: preparation.motif }, { redacted: true });
        return { operationId: op.operationId, statut: "REJETE" as const, motif: preparation.motif };
      }

      const cree = await tx.defaut.create({ data: preparation.preparation.data });
      const p = preparation.preparation;
      apresTransaction.geometrieDefaut = p;
      // Contour GPS (A5) : ecrit avec la quantite qu'il a fournie, dans la meme transaction.
      if (p.emprise) await ecrireEmprise(tx, cree.id, p.emprise.geojson, p.emprise.quantite);

      if (p.quantite !== null && p.methode !== null) {
        const statutQualite = p.methode === "SAISIE" || p.methode === "COMPTAGE" ? "OBSERVED" : "DERIVED";
        await tx.valeurQualite.upsert({
          where: {
            entityType_entityId_champ: {
              entityType: "Defaut", entityId: cree.id, champ: "quantite",
            },
          },
          create: {
            entityType: "Defaut", entityId: cree.id, champ: "quantite",
            statut: statutQualite, source: "saisie_defaut", methode: p.methode,
            observedAt: p.constateA, observedById: contexte.userId,
            confiance: statutQualite === "OBSERVED" ? "HIGH" : "MEDIUM",
            note: `Quantité ${p.quantite} ${p.unite}, obtenue par ${p.methode}.`,
          },
          update: {
            statut: statutQualite, source: "saisie_defaut", methode: p.methode,
            observedAt: p.constateA, observedById: contexte.userId,
            confiance: statutQualite === "OBSERVED" ? "HIGH" : "MEDIUM",
            note: `Quantité ${p.quantite} ${p.unite}, obtenue par ${p.methode}.`,
          },
        });
      }

      await trace("SYNCHRONISE");
      await logAuditTransactionnelle(tx, {
        userId: contexte.userId, action: "CREATE", entityType: "Defaut",
        entityId: cree.id,
        after: { code: cree.code, catalogue: p.codeCatalogue, quantite: cree.quantite },
      });
      return { operationId: op.operationId, statut: "SYNCHRONISE" as const, entityId: cree.id, version: cree.version };
    }

    // APPLIQUER. La version est posee explicitement et non incrementee a l'aveugle :
    // c'est `decider` qui l'a calculee a partir de l'etat lu, et deux operations
    // concurrentes ne peuvent donc pas aboutir au meme numero.
    const avant = await tx.observation.findUnique({ where: { id: op.entityId } });
    if (!avant || avant.deletedAt) {
      const motif = "ENTITE_INTROUVABLE";
      await trace("REJETE", { derniereErreur: motif });
      return { operationId: op.operationId, statut: "REJETE" as const, motif };
    }
    if (avant.agentId !== contexte.userId || !["BROUILLON", "PROPOSEE"].includes(avant.statut)) {
      const motif = "OPERATION_NON_AUTORISEE";
      await trace("REJETE", { derniereErreur: motif }, { redacted: true });
      return { operationId: op.operationId, statut: "REJETE" as const, motif };
    }

    const missionId = op.payload.missionId;
    if (typeof missionId === "string") {
      const mission = await tx.mission.findFirst({
        where: {
          id: missionId,
          deletedAt: null,
          OR: [{ assigneId: contexte.userId }, { createurId: contexte.userId }],
        },
        select: { id: true },
      });
      if (!mission) {
        const motif = "MISSION_NON_AUTORISEE";
        await trace("REJETE", { derniereErreur: motif }, { redacted: true });
        return { operationId: op.operationId, statut: "REJETE" as const, motif };
      }
    }

    const enregistrerConflit = async (serveur: unknown, motif: string) => {
      const conflit = await tx.conflitSync.create({
        data: {
          operationId: op.operationId,
          entityType: "Observation",
          entityId: op.entityId,
          payloadLocal: op.payload as never,
          payloadServeur: (serveur ?? {}) as never,
        },
      });
      await trace("CONFLIT", { derniereErreur: motif });
      return { operationId: op.operationId, statut: "CONFLIT" as const, motif, conflitId: conflit.id };
    };
    if (op.baseVersion == null || op.baseVersion !== avant.version) {
      return enregistrerConflit(avant, "VERSION_MODIFIEE");
    }

    const observee = { ...op.payload };
    if (typeof observee.observeA === "string") observee.observeA = new Date(observee.observeA);
    const donnees = op.operation === "DELETE"
      ? { deletedAt: new Date(), version: decision.versionSuivante }
      : { ...observee, version: decision.versionSuivante };
    const maj = await tx.observation.updateMany({
      where: {
        id: op.entityId,
        version: avant.version,
        agentId: contexte.userId,
        deletedAt: null,
        statut: { in: ["BROUILLON", "PROPOSEE"] },
      },
      data: donnees as never,
    });
    if (maj.count !== 1) {
      const courant = await tx.observation.findUnique({ where: { id: op.entityId } });
      if (!courant || courant.deletedAt || courant.agentId !== contexte.userId || !["BROUILLON", "PROPOSEE"].includes(courant.statut)) {
        const motif = "OPERATION_NON_AUTORISEE";
        await trace("REJETE", { derniereErreur: motif }, { redacted: true });
        return { operationId: op.operationId, statut: "REJETE" as const, motif };
      }
      return enregistrerConflit(courant, "VERSION_MODIFIEE");
    }
    const apres = await tx.observation.findUnique({ where: { id: op.entityId } });
    if (!apres) throw new Error("Observation absente après compare-et-échange.");
    await trace("SYNCHRONISE");
    await logAuditTransactionnelle(tx, {
      userId: contexte.userId, action: op.operation === "DELETE" ? "DELETE" : "UPDATE", entityType: "Observation",
      entityId: op.entityId, before: avant, after: apres,
    });
    return { operationId: op.operationId, statut: "SYNCHRONISE" as const, entityId: apres.id, version: apres.version };
  }, { timeout: 60_000 });

  const geometrieDefaut = apresTransaction.geometrieDefaut;
  const idDefautCree = resultat.statut === "SYNCHRONISE" ? resultat.entityId : undefined;
  if (geometrieDefaut && idDefautCree) {
    try {
      if (geometrieDefaut.lat !== null && geometrieDefaut.lon !== null) {
        await setPointGeom("defauts", idDefautCree, geometrieDefaut.lat, geometrieDefaut.lon);
      } else if (geometrieDefaut.tronconId && geometrieDefaut.abscisseM !== null) {
        await deriveGeomFromTronconAbscisse("defauts", idDefautCree, geometrieDefaut.tronconId, geometrieDefaut.abscisseM);
      } else if (geometrieDefaut.tronconId && geometrieDefaut.pk !== null) {
        await deriveGeomFromTroncon("defauts", idDefautCree, geometrieDefaut.tronconId, geometrieDefaut.pk);
      }
    } catch {
      // Le défaut et l'opération sync sont persistés. La géométrie pourra être rematchée.
    }
  }
  return resultat;
}

/**
 * Etat de synchronisation d'un appareil.
 *
 * Les conflits sont comptes A PART des echecs. Un conflit n'est pas une panne : il
 * attend une decision humaine, et le confondre avec une erreur technique ferait
 * croire a un agent que reessayer suffira.
 */
export async function statutAppareil(appareilId: string) {
  const [parStatut, operationsEnConflit, derniere] = await Promise.all([
    prisma.operationSync.groupBy({ by: ["statut"], where: { appareilId }, _count: { _all: true } }),
    prisma.operationSync.findMany({
      where: { appareilId, statut: "CONFLIT" },
      select: { operationId: true },
    }),
    prisma.operationSync.findFirst({
      where: { appareilId }, orderBy: { createdAt: "desc" }, select: { createdAt: true },
    }),
  ]);
  const conflits = operationsEnConflit.length === 0 ? 0 : await prisma.conflitSync.count({
    where: { resolution: null, operationId: { in: operationsEnConflit.map((operation) => operation.operationId) } },
  });

  return {
    appareilId,
    operations: Object.fromEntries(parStatut.map((p) => [p.statut, p._count._all])),
    conflitsNonResolus: conflits,
    derniereOperationA: derniere?.createdAt ?? null,
  };
}

/** Pour les tests : expose la decision sans rejouer la lecture. */
export type { Decision };

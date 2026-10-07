import { prisma } from "../lib/prisma";
import { logAudit } from "../utils/audit";
import { decider, delaiAvantReessai, type Decision, type OperationEntrante } from "./sync";

/**
 * Application des operations remontees du terrain.
 *
 * La DECISION vit dans `sync.ts` et se teste sans base. Ce fichier-ci ne fait que
 * l'executer : lire l'etat, appeler `decider`, ecrire ce qu'elle dit. La separation
 * n'est pas cosmetique — c'est elle qui rend les six cas de la section 15 verifiables.
 *
 * UN SEUL TYPE D'ENTITE POUR L'INSTANT
 *
 * `Observation`. Elle existe au schema, elle porte `version` et `clientOperationId`,
 * et c'est ce que produit une mission. Accepter d'autres types reviendrait a ecrire
 * des branches que rien n'exerce : elles seraient fausses le jour ou on s'en servirait,
 * et personne ne le saurait d'ici la. Le refus est explicite et nomme le type.
 */

/** Types que `push` sait appliquer. La liste grandira avec les services. */
export const TYPES_ACCEPTES = new Set(["Observation"]);

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

/** Etat courant d'une observation, ou null si elle n'existe pas. */
async function etatObservation(entityId: string): Promise<number | null> {
  const o = await prisma.observation.findFirst({
    where: { id: entityId, deletedAt: null },
    select: { version: true },
  });
  return o?.version ?? null;
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
export async function appliquer(
  op: OperationEntrante,
  contexte: { appareilId: string; userId: string },
): Promise<ResultatOperation> {
  if (!TYPES_ACCEPTES.has(op.entityType)) {
    return { operationId: op.operationId, statut: "REJETE", motif: `TYPE_NON_SUPPORTE:${op.entityType}` };
  }

  const dejaTraitee = await prisma.operationSync.findUnique({
    where: { operationId: op.operationId },
    select: { entityId: true, statut: true },
  });
  const versionActuelle = await etatObservation(op.entityId);

  const decision = decider(op, {
    dejaTraitee: dejaTraitee ? { entityId: dejaTraitee.entityId, statut: dejaTraitee.statut } : null,
    versionActuelle,
  });

  // Rejeu : on ne touche a rien et on rend ce qui avait ete decide la premiere fois.
  if (decision.action === "REJOUEE") {
    return { operationId: op.operationId, statut: "REJOUEE", entityId: decision.entityId };
  }

  return prisma.$transaction(async (tx) => {
    const trace = async (statut: string, extra: Record<string, unknown> = {}) =>
      tx.operationSync.create({
        data: {
          operationId: op.operationId,
          appareilId: contexte.appareilId,
          userId: contexte.userId,
          entityType: op.entityType,
          entityId: op.entityId,
          operation: op.operation,
          payload: op.payload as never,
          baseVersion: op.baseVersion ?? null,
          statut: statut as never,
          traiteeA: new Date(),
          ...extra,
        },
      });

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
      const serveur = await tx.observation.findUnique({ where: { id: op.entityId } });
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
      const cree = await tx.observation.create({
        data: { ...(op.payload as object), id: op.entityId, clientOperationId: op.operationId } as never,
      });
      await trace("SYNCHRONISE");
      await logAudit({
        userId: contexte.userId, action: "CREATE", entityType: "Observation",
        entityId: cree.id, after: cree,
      });
      return { operationId: op.operationId, statut: "SYNCHRONISE" as const, entityId: cree.id, version: cree.version };
    }

    // APPLIQUER. La version est posee explicitement et non incrementee a l'aveugle :
    // c'est `decider` qui l'a calculee a partir de l'etat lu, et deux operations
    // concurrentes ne peuvent donc pas aboutir au meme numero.
    const avant = await tx.observation.findUnique({ where: { id: op.entityId } });
    const apres = await tx.observation.update({
      where: { id: op.entityId },
      data: { ...(op.payload as object), version: decision.versionSuivante } as never,
    });
    await trace("SYNCHRONISE");
    await logAudit({
      userId: contexte.userId, action: "UPDATE", entityType: "Observation",
      entityId: op.entityId, before: avant, after: apres,
    });
    return { operationId: op.operationId, statut: "SYNCHRONISE" as const, entityId: apres.id, version: apres.version };
  }, { timeout: 60_000 });
}

/**
 * Etat de synchronisation d'un appareil.
 *
 * Les conflits sont comptes A PART des echecs. Un conflit n'est pas une panne : il
 * attend une decision humaine, et le confondre avec une erreur technique ferait
 * croire a un agent que reessayer suffira.
 */
export async function statutAppareil(appareilId: string) {
  const [parStatut, conflits, derniere] = await Promise.all([
    prisma.operationSync.groupBy({ by: ["statut"], where: { appareilId }, _count: { _all: true } }),
    prisma.conflitSync.count({ where: { resolution: null } }),
    prisma.operationSync.findFirst({
      where: { appareilId }, orderBy: { createdAt: "desc" }, select: { createdAt: true },
    }),
  ]);

  return {
    appareilId,
    operations: Object.fromEntries(parStatut.map((p) => [p.statut, p._count._all])),
    conflitsNonResolus: conflits,
    derniereOperationA: derniere?.createdAt ?? null,
  };
}

/** Pour les tests : expose la decision sans rejouer la lecture. */
export type { Decision };

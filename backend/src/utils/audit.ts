import { prisma } from "../lib/prisma";
import type { AuditAction } from "@prisma/client";

interface LogParams {
  userId: string | null;
  action: AuditAction;
  entityType: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  ipAddress?: string;
}

// P2-03 : l'echec d'audit ne doit jamais faire echouer la requete metier (regle
// d'origine conservee), mais il ne doit plus etre SILENCIEUX. Chaque echec est
// loggue avec son contexte (quelle action, quelle entite) et incremente un
// compteur consultable — un compteur qui monte signale des ecritures metier
// passees sans trace, et alimente la sonde /api/health.
let echecsAudit = 0;

export function echecsAuditDepuisDemarrage(): number {
  return echecsAudit;
}

/** Réservé aux tests : remet le compteur à zéro. */
export function _reinitialiserCompteurAudit(): void {
  echecsAudit = 0;
}

export async function logAudit(params: LogParams): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: params.userId,
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
        before: params.before as never,
        after: params.after as never,
        ipAddress: params.ipAddress,
      },
    });
  } catch (err) {
    echecsAudit++;
    console.error("Echec ecriture audit_log", {
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      userId: params.userId,
      raison: err instanceof Error ? err.message : String(err),
    });
  }
}

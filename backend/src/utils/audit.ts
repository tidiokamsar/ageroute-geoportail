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

// Echec silencieux volontaire : l'audit ne doit jamais faire planter la requete metier.
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
    console.error("Echec ecriture audit_log", err);
  }
}

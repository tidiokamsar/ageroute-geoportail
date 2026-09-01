import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/auth.middleware";

export const auditRouter = Router();

const querySchema = z.object({
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

// Historique des operations sur une entite (qui/quoi/quand), lu depuis audit_logs.
auditRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const q = querySchema.parse(req.query);
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 20;
    const where = { entityType: q.entityType, entityId: q.entityId };

    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: { user: { select: { nomComplet: true, email: true } } },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({
      data: rows.map((r) => ({
        id: r.id,
        action: r.action,
        auteur: r.user?.nomComplet ?? "Système",
        createdAt: r.createdAt,
        before: r.before,
        after: r.after,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (err) {
    next(err);
  }
});

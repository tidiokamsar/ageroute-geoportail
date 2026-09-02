import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { logAudit } from "../utils/audit";
import { ApiError } from "../middleware/error.middleware";

export interface ListParams {
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  where?: Record<string, unknown>;
  archived?: boolean;
}

export interface BulkResult {
  success: number;
  failed: { id: string; message: string }[];
}

export interface ListResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// Delegate Prisma assoupli en "any" : chaque modele (Troncon, Ouvrage, ...) a une signature
// d'arguments distincte (TronconFindManyArgs, OuvrageFindManyArgs, ...) incompatible avec une
// interface generique stricte. Les modules appelants restent types via leurs schemas Zod.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PrismaDelegate = any;

/**
 * Fabrique un service CRUD standard (pagination/tri/filtre serveur + soft delete + audit)
 * pour toute entite patrimoniale possedant les champs id/deletedAt/createdAt.
 */
export function createCrudService(model: PrismaDelegate, entityName: string, defaultInclude?: Record<string, unknown>) {
  async function list(params: ListParams = {}): Promise<ListResult<unknown>> {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, params.pageSize ?? 20));
    const sortBy = params.sortBy ?? "createdAt";
    const sortDir = params.sortDir ?? "desc";
    const where = { ...(params.where ?? {}), deletedAt: params.archived ? { not: null } : null };

    const [data, total] = await Promise.all([
      model.findMany({ where, include: defaultInclude, orderBy: { [sortBy]: sortDir }, skip: (page - 1) * pageSize, take: pageSize }),
      model.count({ where }),
    ]);

    return { data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
  }

  async function getById(id: string) {
    const item = await model.findFirst({ where: { id, deletedAt: null }, include: defaultInclude });
    if (!item) throw new ApiError(404, `${entityName} introuvable`);
    return item;
  }

  async function create(data: Record<string, unknown>, userId: string) {
    const created = await model.create({ data });
    await logAudit({ userId, action: "CREATE", entityType: entityName, entityId: created.id, after: created });
    return created;
  }

  async function update(id: string, data: Record<string, unknown>, userId: string) {
    // P2-01 : une entite archivee n'est plus modifiable — cohérent avec getById.
    // Avant, findUnique trouvait l'entité archivée et l'update passait : une donnée
    // retirée des listes opérationnelles restait modifiable par identifiant.
    const before = await model.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw new ApiError(404, `${entityName} introuvable`);
    const updated = await model.update({ where: { id }, data });
    await logAudit({ userId, action: "UPDATE", entityType: entityName, entityId: id, before, after: updated });
    return updated;
  }

  // Suppression logique uniquement : la donnee reste en base (deletedAt renseigne)
  async function remove(id: string, userId: string) {
    const before = await model.findUnique({ where: { id } });
    if (!before) throw new ApiError(404, `${entityName} introuvable`);
    const deleted = await model.update({ where: { id }, data: { deletedAt: new Date() } });
    await logAudit({ userId, action: "DELETE", entityType: entityName, entityId: id, before });
    return deleted;
  }

  async function restore(id: string, userId: string) {
    const restored = await model.update({ where: { id }, data: { deletedAt: null } });
    await logAudit({ userId, action: "RESTORE", entityType: entityName, entityId: id, after: restored });
    return restored;
  }

  // Actions groupees : chaque ligne est traitee independamment, un echec individuel
  // n'annule pas le reste du lot (rapport detaille retourne au client).
  async function bulkRemove(ids: string[], userId: string): Promise<BulkResult> {
    const result: BulkResult = { success: 0, failed: [] };
    for (const id of ids) {
      try {
        await remove(id, userId);
        result.success++;
      } catch (err) {
        result.failed.push({ id, message: err instanceof Error ? err.message : "Erreur inconnue" });
      }
    }
    return result;
  }

  async function bulkRestore(ids: string[], userId: string): Promise<BulkResult> {
    const result: BulkResult = { success: 0, failed: [] };
    for (const id of ids) {
      try {
        await restore(id, userId);
        result.success++;
      } catch (err) {
        result.failed.push({ id, message: err instanceof Error ? err.message : "Erreur inconnue" });
      }
    }
    return result;
  }

  return { list, getById, create, update, remove, restore, bulkRemove, bulkRestore };
}

const bulkIdsSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) });

type BulkCapableService = {
  bulkRemove: (ids: string[], userId: string) => Promise<BulkResult>;
  bulkRestore: (ids: string[], userId: string) => Promise<BulkResult>;
};

/**
 * Monte /bulk-archive et /bulk-restore sur un service issu de createCrudService.
 * A appeler dans le router du module : router.use(createBulkRouter(tronconsService)).
 */
export function createBulkRouter(service: BulkCapableService): Router {
  const router = Router();

  router.post("/bulk-archive", async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new ApiError(401, "Authentification requise");
      const { ids } = bulkIdsSchema.parse(req.body);
      res.json(await service.bulkRemove(ids, req.user.id));
    } catch (err) { next(err); }
  });

  router.post("/bulk-restore", async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new ApiError(401, "Authentification requise");
      const { ids } = bulkIdsSchema.parse(req.body);
      res.json(await service.bulkRestore(ids, req.user.id));
    } catch (err) { next(err); }
  });

  return router;
}

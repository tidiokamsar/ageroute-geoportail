import { randomUUID } from "crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { logAudit } from "../utils/audit";
import { prisma } from "./prisma";
import { construireSaisies } from "./provenance";
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
    /**
     * La creation trace sa provenance, comme la mise a jour.
     *
     * L'asymetrie constatee le 05/09/2026 : un troncon cree depuis l'application
     * n'avait AUCUNE ligne de qualite, alors qu'une simple modification en produisait.
     * C'est l'inverse de ce qu'il faut — a la creation, TOUS les champs de decision
     * recoivent leur premiere valeur, et aucune ne disait d'ou elle venait.
     *
     * UN SEUL TEMPS (correction du 05/09/2026)
     *
     * La version precedente ecrivait l'entite, puis sa provenance dans une SECONDE
     * transaction, en invoquant que « l'identifiant n'existe pas avant l'insertion ».
     * C'etait faux : rien n'oblige a laisser la base tirer l'identifiant. Toutes les
     * cles de ce schema sont des `@default(uuid())` ; en le tirant ici, la provenance
     * connait sa cible avant meme l'insertion et rejoint la meme transaction.
     *
     * L'argument etait faux, et sa consequence reelle : une coupure entre les deux
     * ecritures laissait une entite SANS provenance, sur le seul geste ou tous les
     * champs de decision recoivent leur premiere valeur. Rien ne le rejouait, rien ne
     * le signalait. `update` etait deja atomique : les deux chemins ne donnaient pas
     * la meme garantie sur le meme invariant.
     */
    const id = (data.id as string | undefined) ?? randomUUID();
    const [created] = await prisma.$transaction([
      model.create({ data: { ...data, id } }),
      ...construireSaisies(entityName, id, data, userId),
    ]);
    await logAudit({ userId, action: "CREATE", entityType: entityName, entityId: created.id, after: created });
    return created;
  }

  async function update(id: string, data: Record<string, unknown>, userId: string) {
    // P2-01 : une entite archivee n'est plus modifiable — cohérent avec getById.
    // Avant, findUnique trouvait l'entité archivée et l'update passait : une donnée
    // retirée des listes opérationnelles restait modifiable par identifiant.
    const before = await model.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw new ApiError(404, `${entityName} introuvable`);

    /**
     * La valeur et sa provenance changent ENSEMBLE, ou pas du tout.
     *
     * Avant cette transaction, une correction faite depuis l'interface laissait sa
     * ligne de `valeurs_qualite` intacte : la base continuait d'affirmer « absent de
     * la source » pour une valeur qu'un agent venait de taper. Constate le
     * 04/09/2026 sur « 2e Boulevard », et systemique — les scripts entretenaient la
     * tracabilite, l'application non.
     *
     * Ecrire les deux hors transaction aurait seulement deplace le probleme : un
     * echec entre les deux laisserait une valeur sans provenance, ou une provenance
     * sans valeur, et rien ne permettrait de savoir laquelle croire.
     */
    const [updated] = await prisma.$transaction([
      model.update({ where: { id }, data }),
      ...construireSaisies(entityName, id, data, userId),
    ]);

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

import type { Request, Response, NextFunction } from "express";
import { marchesService } from "./marches.service";
import { marcheCreateSchema, marcheUpdateSchema, bailleurCreateSchema, attachChantierSchema, avancementSchema } from "./marches.schema";
import { parseListQuery } from "../../lib/list-query";
import { ApiError } from "../../middleware/error.middleware";

export async function listHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const q = parseListQuery(req);
    const { statut, bailleurId } = req.query as { statut?: string; bailleurId?: string };
    res.json(await marchesService.list({
      page: q.page, pageSize: q.pageSize, sortBy: q.sortBy, sortDir: q.sortDir,
      search: q.search, archived: q.archived,
      statut, bailleurId: bailleurId ? Number(bailleurId) : undefined,
    }));
  } catch (err) { next(err); }
}

export async function getHandler(req: Request, res: Response, next: NextFunction) {
  try { res.json(await marchesService.getById(req.params.id)); } catch (err) { next(err); }
}

export async function createHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    res.status(201).json(await marchesService.create(marcheCreateSchema.parse(req.body), req.user.id));
  } catch (err) { next(err); }
}

export async function updateHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    res.json(await marchesService.update(req.params.id, marcheUpdateSchema.parse(req.body), req.user.id));
  } catch (err) { next(err); }
}

export async function deleteHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    await marchesService.remove(req.params.id, req.user.id);
    res.status(204).send();
  } catch (err) { next(err); }
}

export async function attachChantierHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    const { chantierId, tronconId } = attachChantierSchema.parse(req.body);
    res.status(201).json(await marchesService.attachChantier(req.params.id, chantierId, tronconId, req.user.id));
  } catch (err) { next(err); }
}

export async function detachChantierHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    await marchesService.detachChantier(req.params.id, req.params.chantierId, req.user.id);
    res.status(204).send();
  } catch (err) { next(err); }
}

export async function listAvancementsHandler(req: Request, res: Response, next: NextFunction) {
  try { res.json(await marchesService.listAvancements(req.params.id)); } catch (err) { next(err); }
}

export async function upsertAvancementHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    const data = avancementSchema.parse(req.body);
    res.status(201).json(await marchesService.upsertAvancement(req.params.id, data, req.user.id));
  } catch (err) { next(err); }
}

export async function listBailleursHandler(_req: Request, res: Response, next: NextFunction) {
  try { res.json(await marchesService.listBailleurs()); } catch (err) { next(err); }
}

export async function createBailleurHandler(req: Request, res: Response, next: NextFunction) {
  try { res.status(201).json(await marchesService.createBailleur(bailleurCreateSchema.parse(req.body))); } catch (err) { next(err); }
}

export async function updateBailleurHandler(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await marchesService.updateBailleur(Number(req.params.id), bailleurCreateSchema.partial().parse(req.body)));
  } catch (err) { next(err); }
}

export async function deleteBailleurHandler(req: Request, res: Response, next: NextFunction) {
  try {
    await marchesService.deleteBailleur(Number(req.params.id));
    res.status(204).send();
  } catch (err) { next(err); }
}

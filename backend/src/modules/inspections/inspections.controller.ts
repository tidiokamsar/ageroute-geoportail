import type { Request, Response, NextFunction } from "express";
import { inspectionsService } from "./inspections.service";
import { inspectionCreateSchema, inspectionUpdateSchema } from "./inspections.schema";
import { parseListQuery } from "../../lib/list-query";
import { ApiError } from "../../middleware/error.middleware";

export async function listHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const q = parseListQuery(req);
    res.json(await inspectionsService.list({
      page: q.page, pageSize: q.pageSize, sortBy: q.sortBy, sortDir: q.sortDir,
      tronconId: req.query.tronconId as string | undefined,
      ouvrageId: req.query.ouvrageId as string | undefined,
      archived: q.archived,
    }));
  } catch (err) { next(err); }
}
export async function getHandler(req: Request, res: Response, next: NextFunction) {
  try { res.json(await inspectionsService.getById(req.params.id)); } catch (err) { next(err); }
}
export async function createHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    const data = inspectionCreateSchema.parse(req.body);
    res.status(201).json(await inspectionsService.create({ ...data, inspecteurId: req.user.id }, req.user.id));
  } catch (err) { next(err); }
}
export async function updateHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    res.json(await inspectionsService.update(req.params.id, inspectionUpdateSchema.parse(req.body), req.user.id));
  } catch (err) { next(err); }
}
export async function deleteHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    await inspectionsService.remove(req.params.id, req.user.id);
    res.status(204).send();
  } catch (err) { next(err); }
}
export async function addPhotoHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) throw new ApiError(400, "Photo manquante");
    res.status(201).json(await inspectionsService.addPhoto(req.params.id, req.file.filename));
  } catch (err) { next(err); }
}
export async function removePhotoHandler(req: Request, res: Response, next: NextFunction) {
  try { res.json(await inspectionsService.removePhoto(req.params.id, req.params.filename)); } catch (err) { next(err); }
}

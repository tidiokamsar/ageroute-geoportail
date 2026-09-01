import type { Request, Response, NextFunction } from "express";
import { postesService } from "./postes.service";
import { posteCreateSchema, posteUpdateSchema } from "./postes.schema";
import { parseListQuery } from "../../lib/list-query";
import { ApiError } from "../../middleware/error.middleware";

export async function listHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const q = parseListQuery(req);
    res.json(await postesService.list({ page: q.page, pageSize: q.pageSize, sortBy: q.sortBy, sortDir: q.sortDir, search: q.search, region: q.region, type: q.type, archived: q.archived }));
  } catch (err) { next(err); }
}
export async function getHandler(req: Request, res: Response, next: NextFunction) {
  try { res.json(await postesService.getById(req.params.id)); } catch (err) { next(err); }
}
export async function listGeoHandler(_req: Request, res: Response, next: NextFunction) {
  try { res.json(await postesService.listGeo()); } catch (err) { next(err); }
}
export async function exportHandler(_req: Request, res: Response, next: NextFunction) {
  try {
    const buffer = await postesService.exportXlsx();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=postes.xlsx");
    res.send(buffer);
  } catch (err) { next(err); }
}
export async function importHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    if (!req.file) throw new ApiError(400, "Fichier manquant");
    res.json(await postesService.importXlsx(req.file.buffer, req.user.id));
  } catch (err) { next(err); }
}
export async function createHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    res.status(201).json(await postesService.create(posteCreateSchema.parse(req.body), req.user.id));
  } catch (err) { next(err); }
}
export async function updateHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    res.json(await postesService.update(req.params.id, posteUpdateSchema.parse(req.body), req.user.id));
  } catch (err) { next(err); }
}
export async function deleteHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    await postesService.remove(req.params.id, req.user.id);
    res.status(204).send();
  } catch (err) { next(err); }
}
export async function geolocateHandler(req: Request, res: Response, next: NextFunction) {
  try { res.json(await postesService.geolocateFromTroncon(req.params.id)); } catch (err) { next(err); }
}

import type { Request, Response, NextFunction } from "express";
import { pointsNoirsService } from "./points-noirs.service";
import { pointNoirCreateSchema, pointNoirUpdateSchema } from "./points-noirs.schema";
import { parseListQuery } from "../../lib/list-query";
import { ApiError } from "../../middleware/error.middleware";

export async function listHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const q = parseListQuery(req);
    res.json(await pointsNoirsService.list({ page: q.page, pageSize: q.pageSize, sortBy: q.sortBy, sortDir: q.sortDir, search: q.search, region: q.region, archived: q.archived }));
  } catch (err) { next(err); }
}
export async function getHandler(req: Request, res: Response, next: NextFunction) {
  try { res.json(await pointsNoirsService.getById(req.params.id)); } catch (err) { next(err); }
}
export async function listGeoHandler(_req: Request, res: Response, next: NextFunction) {
  try { res.json(await pointsNoirsService.listGeo()); } catch (err) { next(err); }
}
export async function exportHandler(_req: Request, res: Response, next: NextFunction) {
  try {
    const buffer = await pointsNoirsService.exportXlsx();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=points-noirs.xlsx");
    res.send(buffer);
  } catch (err) { next(err); }
}
export async function importHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    if (!req.file) throw new ApiError(400, "Fichier manquant");
    res.json(await pointsNoirsService.importXlsx(req.file.buffer, req.user.id));
  } catch (err) { next(err); }
}
export async function createHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    res.status(201).json(await pointsNoirsService.create(pointNoirCreateSchema.parse(req.body), req.user.id));
  } catch (err) { next(err); }
}
export async function updateHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    res.json(await pointsNoirsService.update(req.params.id, pointNoirUpdateSchema.parse(req.body), req.user.id));
  } catch (err) { next(err); }
}
export async function deleteHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    await pointsNoirsService.remove(req.params.id, req.user.id);
    res.status(204).send();
  } catch (err) { next(err); }
}
export async function geolocateHandler(req: Request, res: Response, next: NextFunction) {
  try { res.json(await pointsNoirsService.geolocateFromTroncon(req.params.id)); } catch (err) { next(err); }
}

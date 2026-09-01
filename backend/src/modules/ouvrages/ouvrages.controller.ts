import type { Request, Response, NextFunction } from "express";
import { ouvragesService } from "./ouvrages.service";
import { ouvrageCreateSchema, ouvrageUpdateSchema } from "./ouvrages.schema";
import { parseListQuery } from "../../lib/list-query";
import { ApiError } from "../../middleware/error.middleware";

export async function listHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const q = parseListQuery(req);
    res.json(await ouvragesService.list({ page: q.page, pageSize: q.pageSize, sortBy: q.sortBy, sortDir: q.sortDir, search: q.search, region: q.region, etat: q.etat, type: q.type, archived: q.archived }));
  } catch (err) { next(err); }
}
export async function getHandler(req: Request, res: Response, next: NextFunction) {
  try { res.json(await ouvragesService.getById(req.params.id)); } catch (err) { next(err); }
}
export async function listGeoHandler(_req: Request, res: Response, next: NextFunction) {
  try { res.json(await ouvragesService.listGeo()); } catch (err) { next(err); }
}
export async function exportHandler(_req: Request, res: Response, next: NextFunction) {
  try {
    const buffer = await ouvragesService.exportXlsx();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=ouvrages.xlsx");
    res.send(buffer);
  } catch (err) { next(err); }
}
export async function importHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    if (!req.file) throw new ApiError(400, "Fichier manquant");
    res.json(await ouvragesService.importXlsx(req.file.buffer, req.user.id));
  } catch (err) { next(err); }
}
export async function createHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    res.status(201).json(await ouvragesService.create(ouvrageCreateSchema.parse(req.body), req.user.id));
  } catch (err) { next(err); }
}
export async function updateHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    res.json(await ouvragesService.update(req.params.id, ouvrageUpdateSchema.parse(req.body), req.user.id));
  } catch (err) { next(err); }
}
export async function deleteHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    await ouvragesService.remove(req.params.id, req.user.id);
    res.status(204).send();
  } catch (err) { next(err); }
}
export async function geolocateHandler(req: Request, res: Response, next: NextFunction) {
  try { res.json(await ouvragesService.geolocateFromTroncon(req.params.id)); } catch (err) { next(err); }
}
export async function addPhotoHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) throw new ApiError(400, "Photo manquante");
    res.status(201).json(await ouvragesService.addPhoto(req.params.id, req.file.filename));
  } catch (err) { next(err); }
}
export async function removePhotoHandler(req: Request, res: Response, next: NextFunction) {
  try { res.json(await ouvragesService.removePhoto(req.params.id, req.params.filename)); } catch (err) { next(err); }
}

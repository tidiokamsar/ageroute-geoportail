import type { Request, Response, NextFunction } from "express";
import { chantiersService } from "./chantiers.service";
import { chantierCreateSchema, chantierUpdateSchema } from "./chantiers.schema";
import { parseListQuery } from "../../lib/list-query";
import { ApiError } from "../../middleware/error.middleware";

export async function listHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const q = parseListQuery(req);
    res.json(await chantiersService.list({ page: q.page, pageSize: q.pageSize, sortBy: q.sortBy, sortDir: q.sortDir, search: q.search, region: q.region, etat: q.etat, archived: q.archived }));
  } catch (err) { next(err); }
}
export async function getHandler(req: Request, res: Response, next: NextFunction) {
  try { res.json(await chantiersService.getById(req.params.id)); } catch (err) { next(err); }
}
export async function listGeoHandler(_req: Request, res: Response, next: NextFunction) {
  try { res.json(await chantiersService.listGeo()); } catch (err) { next(err); }
}
export async function listSansLocalisationHandler(_req: Request, res: Response, next: NextFunction) {
  try { res.json(await chantiersService.listSansLocalisation()); } catch (err) { next(err); }
}
export async function exportHandler(_req: Request, res: Response, next: NextFunction) {
  try {
    const buffer = await chantiersService.exportXlsx();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=chantiers.xlsx");
    res.send(buffer);
  } catch (err) { next(err); }
}
export async function importHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    if (!req.file) throw new ApiError(400, "Fichier manquant");
    res.json(await chantiersService.importXlsx(req.file.buffer, req.user.id));
  } catch (err) { next(err); }
}
export async function createHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    res.status(201).json(await chantiersService.create(chantierCreateSchema.parse(req.body), req.user.id));
  } catch (err) { next(err); }
}
export async function updateHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    res.json(await chantiersService.update(req.params.id, chantierUpdateSchema.parse(req.body), req.user.id));
  } catch (err) { next(err); }
}
export async function deleteHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    await chantiersService.remove(req.params.id, req.user.id);
    res.status(204).send();
  } catch (err) { next(err); }
}

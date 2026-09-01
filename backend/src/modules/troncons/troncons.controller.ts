import type { Request, Response, NextFunction } from "express";
import { tronconsService } from "./troncons.service";
import { tronconCreateSchema, tronconUpdateSchema, tronconGeomSchema } from "./troncons.schema";
import { parseListQuery } from "../../lib/list-query";
import { ApiError } from "../../middleware/error.middleware";

export async function listHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const q = parseListQuery(req);
    const result = await tronconsService.list({
      page: q.page, pageSize: q.pageSize, sortBy: q.sortBy, sortDir: q.sortDir,
      search: q.search, region: q.region, etat: q.etat, archived: q.archived, classe: q.type,
    });
    res.json(result);
  } catch (err) { next(err); }
}

export async function getHandler(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await tronconsService.getById(req.params.id));
  } catch (err) { next(err); }
}

export async function listGeoHandler(_req: Request, res: Response, next: NextFunction) {
  try { res.json(await tronconsService.listGeo()); } catch (err) { next(err); }
}

export async function ficheHandler(req: Request, res: Response, next: NextFunction) {
  try { res.json(await tronconsService.fiche(req.params.id)); } catch (err) { next(err); }
}

export async function itineraireHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { fromId, toId } = req.query;
    if (typeof fromId !== "string" || typeof toId !== "string") {
      throw new ApiError(400, "fromId et toId requis");
    }
    res.json(await tronconsService.itineraire(fromId, toId));
  } catch (err) { next(err); }
}

export async function exportHandler(_req: Request, res: Response, next: NextFunction) {
  try {
    const buffer = await tronconsService.exportXlsx();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=troncons.xlsx");
    res.send(buffer);
  } catch (err) { next(err); }
}

export async function importHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    if (!req.file) throw new ApiError(400, "Fichier manquant");
    res.json(await tronconsService.importXlsx(req.file.buffer, req.user.id));
  } catch (err) { next(err); }
}

export async function createHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    const data = tronconCreateSchema.parse(req.body);
    res.status(201).json(await tronconsService.createWithGeom(data, req.user.id));
  } catch (err) { next(err); }
}

export async function updateHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    const data = tronconUpdateSchema.parse(req.body);
    res.json(await tronconsService.updateWithGeom(req.params.id, data, req.user.id));
  } catch (err) { next(err); }
}

export async function updateGeomHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    const { geom } = tronconGeomSchema.parse(req.body);
    await tronconsService.updateGeomOnly(req.params.id, geom);
    res.json({ ok: true });
  } catch (err) { next(err); }
}

export async function deleteHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    await tronconsService.remove(req.params.id, req.user.id);
    res.status(204).send();
  } catch (err) { next(err); }
}

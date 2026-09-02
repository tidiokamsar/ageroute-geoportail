import type { Request, Response, NextFunction } from "express";
import { otService } from "./ot.service";
import { otCreateSchema, otUpdateSchema, otChangeStatutSchema, otAssignSchema } from "./ot.schema";
import { parseListQuery } from "../../lib/list-query";
import { ApiError } from "../../middleware/error.middleware";

export async function listHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const q = parseListQuery(req);
    const { priorite, assigneA, type, aTraiter } = req.query as Record<string, string>;
    res.json(await otService.list({
      page: q.page, pageSize: q.pageSize, statut: q.etat, priorite, region: q.region,
      assigneA, type, search: q.search,
      aTraiter: aTraiter === "1" || aTraiter === "true",
      userId: req.user?.id,
    }));
  } catch (err) { next(err); }
}

export async function getHandler(req: Request, res: Response, next: NextFunction) {
  try { res.json(await otService.getById(req.params.id)); } catch (err) { next(err); }
}

export async function createHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    res.status(201).json(await otService.create(otCreateSchema.parse(req.body), req.user.id, req.user.role));
  } catch (err) { next(err); }
}

export async function updateHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    res.json(await otService.update(req.params.id, otUpdateSchema.parse(req.body), req.user.id));
  } catch (err) { next(err); }
}

export async function assignHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    res.json(await otService.assigner(req.params.id, otAssignSchema.parse(req.body), req.user.id));
  } catch (err) { next(err); }
}

export async function changeStatutHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    const { statut, commentaire } = otChangeStatutSchema.parse(req.body);
    res.json(await otService.changeStatut(req.params.id, statut, commentaire, req.user.id, req.user.role));
  } catch (err) { next(err); }
}

export async function convertirHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    res.json(await otService.convertirChantier(req.params.id, req.user.id));
  } catch (err) { next(err); }
}

export async function addPhotoHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    if (!req.file) throw new ApiError(400, "Photo manquante");
    const { type, lat, lon } = req.body as { type?: string; lat?: string; lon?: string };
    res.status(201).json(await otService.addPhoto(
      req.params.id, req.file.filename, type ?? "AVANT",
      lat ? Number(lat) : undefined, lon ? Number(lon) : undefined, req.user.id,
    ));
  } catch (err) { next(err); }
}

export async function removePhotoHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    await otService.removePhoto(req.params.id, req.params.photoId, req.user.id);
    res.status(204).send();
  } catch (err) { next(err); }
}

export async function deleteHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    await otService.remove(req.params.id, req.user.id);
    res.status(204).send();
  } catch (err) { next(err); }
}

export async function statsHandler(_req: Request, res: Response, next: NextFunction) {
  try { res.json(await otService.stats()); } catch (err) { next(err); }
}

export async function assignablesHandler(_req: Request, res: Response, next: NextFunction) {
  try { res.json(await otService.assignables()); } catch (err) { next(err); }
}

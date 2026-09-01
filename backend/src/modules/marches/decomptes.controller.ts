import type { Request, Response, NextFunction } from "express";
import { decomptesService } from "./decomptes.service";
import { decompteCreateSchema, decompteUpdateSchema } from "./decomptes.schema";
import { ApiError } from "../../middleware/error.middleware";

export async function listHandler(req: Request, res: Response, next: NextFunction) {
  try { res.json(await decomptesService.list(req.params.id)); } catch (err) { next(err); }
}

export async function createHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    res.status(201).json(await decomptesService.create(req.params.id, decompteCreateSchema.parse(req.body), req.user.id));
  } catch (err) { next(err); }
}

export async function updateHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    res.json(await decomptesService.update(req.params.decompteId, decompteUpdateSchema.parse(req.body), req.user.id));
  } catch (err) { next(err); }
}

export async function deleteHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    await decomptesService.remove(req.params.decompteId, req.user.id);
    res.status(204).send();
  } catch (err) { next(err); }
}

export async function sumByBailleurHandler(_req: Request, res: Response, next: NextFunction) {
  try {
    const rows = await decomptesService.sumByBailleur();
    res.json(rows.map((r) => ({
      bailleurId: r.bailleurId,
      bailleur: r.bailleurNom,
      engage: r.engage.toString(),
      decaisse: r.decaisse.toString(),
      tauxDecaissementPct: r.engage > 0n ? parseFloat(((Number(r.decaisse) / Number(r.engage)) * 100).toFixed(1)) : 0,
    })));
  } catch (err) { next(err); }
}

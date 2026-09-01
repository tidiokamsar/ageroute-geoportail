import type { Request, Response, NextFunction } from "express";
import { documentsService } from "./documents.service";
import { documentCreateSchema } from "./documents.schema";
import { parseListQuery } from "../../lib/list-query";
import { ApiError } from "../../middleware/error.middleware";

export async function listHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const q = parseListQuery(req);
    const { type, annee, tronconId } = req.query;
    res.json(
      await documentsService.list({
        page: q.page,
        pageSize: q.pageSize,
        sortBy: q.sortBy,
        sortDir: q.sortDir,
        search: q.search,
        archived: q.archived,
        type: typeof type === "string" ? type : undefined,
        annee: annee ? Number(annee) : undefined,
        tronconId: typeof tronconId === "string" ? tronconId : undefined,
      })
    );
  } catch (err) { next(err); }
}

export async function getHandler(req: Request, res: Response, next: NextFunction) {
  try { res.json(await documentsService.getById(req.params.id)); } catch (err) { next(err); }
}

export async function createHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    if (!req.file) throw new ApiError(400, "Fichier manquant");
    const data = documentCreateSchema.parse(req.body);
    res.status(201).json(await documentsService.create(data, req.file, req.user.id));
  } catch (err) { next(err); }
}

export async function deleteHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    await documentsService.remove(req.params.id, req.user.id);
    res.status(204).send();
  } catch (err) { next(err); }
}

export async function downloadHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { absolutePath, fileName } = await documentsService.getDownloadInfo(req.params.id);
    res.download(absolutePath, fileName);
  } catch (err) { next(err); }
}

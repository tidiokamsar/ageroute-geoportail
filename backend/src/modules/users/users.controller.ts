import type { Request, Response, NextFunction } from "express";
import { usersService } from "./users.service";
import { userCreateSchema, userUpdateSchema, userResetPasswordSchema } from "./users.schema";
import { parseListQuery } from "../../lib/list-query";
import { ApiError } from "../../middleware/error.middleware";

export async function listHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const q = parseListQuery(req);
    res.json(await usersService.list({ page: q.page, pageSize: q.pageSize, sortBy: q.sortBy, sortDir: q.sortDir, search: q.search, role: q.role, actif: q.actif }));
  } catch (err) { next(err); }
}

export async function getHandler(req: Request, res: Response, next: NextFunction) {
  try { res.json(await usersService.getById(req.params.id)); } catch (err) { next(err); }
}

export async function createHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    res.status(201).json(await usersService.create(userCreateSchema.parse(req.body), req.user.id));
  } catch (err) { next(err); }
}

export async function updateHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    res.json(await usersService.update(req.params.id, userUpdateSchema.parse(req.body), req.user.id));
  } catch (err) { next(err); }
}

export async function resetPasswordHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    const { password } = userResetPasswordSchema.parse(req.body);
    await usersService.resetPassword(req.params.id, password, req.user.id);
    res.status(204).send();
  } catch (err) { next(err); }
}

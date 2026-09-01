import type { Request, Response, NextFunction } from "express";
import { loginSchema, refreshSchema, twoFaLoginVerifySchema, twoFaConfirmSchema, twoFaDisableSchema } from "./auth.schema";
import * as authService from "./auth.service";
import { ApiError } from "../../middleware/error.middleware";

export async function loginHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const input = loginSchema.parse(req.body);
    const result = await authService.login(input.email, input.password, req.ip);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function refreshHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const input = refreshSchema.parse(req.body);
    const result = await authService.refresh(input.refreshToken);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function logoutHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const input = refreshSchema.parse(req.body);
    await authService.logout(input.refreshToken);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function meHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    const { prisma } = await import("../../lib/prisma");
    const dbUser = await prisma.user.findUnique({ where: { id: req.user.id }, select: { totpEnabled: true, nomComplet: true, modulesAutorises: true } });
    res.json({ user: { ...req.user, totpEnabled: dbUser?.totpEnabled ?? false, nomComplet: dbUser?.nomComplet, modulesAutorises: dbUser?.modulesAutorises ?? [] } });
  } catch (err) {
    next(err);
  }
}

export async function twoFaLoginVerifyHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const input = twoFaLoginVerifySchema.parse(req.body);
    const result = await authService.verifyTwoFaLogin(input.challengeToken, input.code, req.ip);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function twoFaSetupHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    res.json(await authService.setupTwoFa(req.user.id));
  } catch (err) {
    next(err);
  }
}

export async function twoFaConfirmHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    const input = twoFaConfirmSchema.parse(req.body);
    await authService.confirmTwoFa(req.user.id, input.code);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function twoFaDisableHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    const input = twoFaDisableSchema.parse(req.body);
    await authService.disableTwoFa(req.user.id, input.password);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

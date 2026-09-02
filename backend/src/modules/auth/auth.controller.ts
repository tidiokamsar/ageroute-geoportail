import type { Request, Response, NextFunction } from "express";
import { loginSchema, refreshSchema, twoFaLoginVerifySchema, twoFaConfirmSchema, twoFaDisableSchema } from "./auth.schema";
import * as authService from "./auth.service";
import { ApiError } from "../../middleware/error.middleware";
import { poserCookieRefresh, effacerCookieRefresh, REFRESH_COOKIE } from "../../lib/session-cookie";

export async function loginHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const input = loginSchema.parse(req.body);
    const result = await authService.login(input.email, input.password, req.ip);
    // P3-B : le refresh part en cookie HttpOnly ; il reste AUSSI dans le body
    // pendant la transition (anciens clients localStorage — retrait a faire
    // lorsque tous les clients seront a jour, cf. rapport P3-B).
    if (!("requires2FA" in result)) poserCookieRefresh(res, result.refreshToken);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function refreshHandler(req: Request, res: Response, next: NextFunction) {
  try {
    refreshSchema.parse(req.body ?? {});
    // P3-B : cookie en priorite (nouveau transport), body en repli (anciens
    // clients). Sans aucun des deux, refus immediat.
    const depuisCookie = typeof req.cookies?.[REFRESH_COOKIE] === "string";
    const token = depuisCookie ? req.cookies[REFRESH_COOKIE] as string : req.body?.refreshToken;
    if (!token) throw new ApiError(401, "Jeton de rafraichissement manquant");

    const result = await authService.refresh(token, req.ip);
    poserCookieRefresh(res, result.refreshToken);
    if (depuisCookie) {
      // Flux cookie : le brut ne repasse JAMAIS par le JavaScript.
      res.json({ accessToken: result.accessToken });
    } else {
      // Flux body (transition) : reponse complete pour l'ancien client —
      // et cookie pose : sa session migre des maintenant.
      res.json(result);
    }
  } catch (err) {
    // Un refresh refuse invalide le eventuel cookie resident : ne pas le
    // laisser trainer apres une reutilisation detectee ou une expiration.
    effacerCookieRefresh(res);
    next(err);
  }
}

export async function logoutHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const token =
      (typeof req.cookies?.[REFRESH_COOKIE] === "string" ? req.cookies[REFRESH_COOKIE] as string : undefined) ??
      refreshSchema.parse(req.body ?? {}).refreshToken;
    if (token) await authService.logout(token);
    effacerCookieRefresh(res);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function logoutAllHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    await authService.logoutAll(req.user.id, req.ip);
    effacerCookieRefresh(res);
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
    // Meme regle que login : cookie pose, body complet pendant la transition.
    poserCookieRefresh(res, result.refreshToken);
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

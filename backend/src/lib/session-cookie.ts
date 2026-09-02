import type { Response } from "express";
import { env } from "../config/env";

// P3-B : transport du refresh token par cookie HttpOnly.
//
// Attributs et pourquoi :
//   HttpOnly     le JavaScript applicatif n'a plus acces au refresh token
//   Path=/api/auth  le cookie n'est meme pas transmis aux endpoints metier
//   SameSite=Strict  jamais envoye sur une requete cross-site : la prime au
//                CSRF sur /auth/* disparait avant meme la validation d'origine
//   Secure       uniquement hors development : en dev, le proxy Vite rend la
//                navigation same-origin en http://localhost, ou un cookie
//                Secure serait silencieusement ignore par le navigateur
//   Max-Age      aligne sur la duree de vie du token (7 j par defaut)
export const REFRESH_COOKIE = "bdri_rt";

function cookieMaxAgeSecondes(): number {
  const match = /^(\d+)([smhd])$/.exec(env.JWT_REFRESH_EXPIRES_IN);
  if (!match) return 7 * 24 * 3600;
  const n = Number(match[1]);
  const unite: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return n * (unite[match[2]] ?? 86400);
}

export function poserCookieRefresh(res: Response, rawRefreshToken: string): void {
  res.cookie(REFRESH_COOKIE, rawRefreshToken, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/api/auth",
    maxAge: cookieMaxAgeSecondes() * 1000,
  });
}

export function effacerCookieRefresh(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/api/auth",
  });
}

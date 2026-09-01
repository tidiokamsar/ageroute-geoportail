import jwt, { type SignOptions } from "jsonwebtoken";
import { env } from "../config/env";
import type { Role } from "@prisma/client";

export interface AccessTokenPayload {
  sub: string; // userId
  role: Role;
  email: string;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as SignOptions["expiresIn"],
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
}

export function signRefreshToken(userId: string): string {
  return jwt.sign({ sub: userId }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN as SignOptions["expiresIn"],
  });
}

export function verifyRefreshToken(token: string): { sub: string } {
  return jwt.verify(token, env.JWT_REFRESH_SECRET) as { sub: string };
}

// Jeton de "défi" 2FA : emis apres un mot de passe correct sur un compte avec 2FA active,
// avant l'emission des tokens d'acces reels. Signe avec JWT_REFRESH_SECRET (different de
// JWT_ACCESS_SECRET) et porte un claim `purpose` dedie : meme s'il fuitait, il ne peut ni
// passer requireAuth (mauvais secret) ni etre confondu avec un refresh token classique
// (verifyRefreshToken n'exige pas ce claim mais accepte un payload sans lui — le controleur
// dedie /2fa/login-verify est le seul a l'interpreter).
export interface TwoFaChallengePayload {
  sub: string;
  purpose: "2fa-challenge";
}

export function signTwoFaChallengeToken(userId: string): string {
  return jwt.sign({ sub: userId, purpose: "2fa-challenge" }, env.JWT_REFRESH_SECRET, { expiresIn: "5m" });
}

export function verifyTwoFaChallengeToken(token: string): TwoFaChallengePayload {
  const payload = jwt.verify(token, env.JWT_REFRESH_SECRET) as Partial<TwoFaChallengePayload>;
  if (payload.purpose !== "2fa-challenge" || !payload.sub) {
    throw new Error("Jeton de défi 2FA invalide");
  }
  return payload as TwoFaChallengePayload;
}

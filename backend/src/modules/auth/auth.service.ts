import { prisma } from "../../lib/prisma";
import { verifyPassword } from "../../utils/password";
import { signAccessToken, signRefreshToken, verifyRefreshToken, signTwoFaChallengeToken, verifyTwoFaChallengeToken } from "../../utils/jwt";
import { generateTotpSecret, buildOtpauthUrl, verifyTotpCode } from "../../utils/totp";
import { hashRefreshToken, newRefreshTokenId } from "../../utils/tokens";
import { ApiError } from "../../middleware/error.middleware";
import { logAudit } from "../../utils/audit";
import { env } from "../../config/env";

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

// Compteur d'echecs par challenge 2FA : un code TOTP a 6 chiffres, sans plafond
// il est bruteforcable pendant toute la validite du challenge (5 min). En memoire
// car un challenge est court-lived ; le rate-limit IP d'app.ts reste la premiere
// barriere, celui-ci empeche de concentrer les essais sur un meme challenge.
const TWO_FA_MAX_ATTEMPTS = 5;
const TWO_FA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const twoFaFailedAttempts = new Map<string, { count: number; expiresAt: number }>();

function isTwoFaChallengeExhausted(challengeToken: string): boolean {
  const entry = twoFaFailedAttempts.get(challengeToken);
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) {
    twoFaFailedAttempts.delete(challengeToken);
    return false;
  }
  return entry.count >= TWO_FA_MAX_ATTEMPTS;
}

function registerTwoFaFailure(challengeToken: string): void {
  const previous = twoFaFailedAttempts.get(challengeToken);
  twoFaFailedAttempts.set(challengeToken, {
    count: (previous?.count ?? 0) + 1,
    expiresAt: previous?.expiresAt ?? Date.now() + TWO_FA_CHALLENGE_TTL_MS,
  });
}

function refreshExpiryDate(): Date {
  // JWT_REFRESH_EXPIRES_IN type "7d" -> on stocke une echeance large par defaut (7j)
  const match = /^(\d+)([smhd])$/.exec(env.JWT_REFRESH_EXPIRES_IN);
  const amount = match ? Number(match[1]) : 7;
  const unit = match ? match[2] : "d";
  const ms = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 86_400_000;
  return new Date(Date.now() + amount * ms);
}

async function issueSession(user: { id: string; role: string; email: string; nomComplet: string; modulesAutorises?: string[] }, ipAddress?: string) {
  const accessToken = signAccessToken({ sub: user.id, role: user.role as never, email: user.email });
  const refreshToken = signRefreshToken(user.id);
  const tokenId = newRefreshTokenId();

  await prisma.$transaction([
    // P3-A : seule l'empreinte SHA-256 du token est stockee ; la famille prend
    // racine a cette ligne (id = familyId au login).
    prisma.refreshToken.create({
      data: {
        id: tokenId,
        tokenHash: hashRefreshToken(refreshToken),
        familyId: tokenId,
        userId: user.id,
        expiresAt: refreshExpiryDate(),
      },
    }),
    prisma.user.update({ where: { id: user.id }, data: { derniereConnexion: new Date(), failedLoginAttempts: 0, lockedUntil: null } }),
  ]);

  await logAudit({ userId: user.id, action: "LOGIN", entityType: "User", entityId: user.id, ipAddress });

  return {
    accessToken,
    refreshToken,
    user: { id: user.id, email: user.email, nomComplet: user.nomComplet, role: user.role, modulesAutorises: user.modulesAutorises ?? [] },
  };
}

export async function login(email: string, password: string, ipAddress?: string) {
  const user = await prisma.user.findUnique({ where: { email } });

  if (user?.lockedUntil && user.lockedUntil > new Date()) {
    const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
    throw new ApiError(423, `Compte temporairement verrouillé suite à plusieurs échecs. Réessayez dans ${minutes} min.`);
  }

  const passwordOk = user && user.actif && (await verifyPassword(user.passwordHash, password));
  if (!passwordOk) {
    if (user) {
      const attempts = user.failedLoginAttempts + 1;
      const locked = attempts >= MAX_FAILED_ATTEMPTS;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: locked ? 0 : attempts,
          lockedUntil: locked ? new Date(Date.now() + LOCKOUT_DURATION_MS) : null,
        },
      });
      // P3-A : un verrouillage coupe AUSSI les sessions refresh existantes —
      // l'agresseur ne conserve pas un acces acquis juste avant le verrou.
      if (locked) await revokeAllForUser(user.id, "ACCOUNT_LOCKED");
    }
    await logAudit({ userId: user?.id ?? null, action: "LOGIN_FAILED", entityType: "User", entityId: user?.id, ipAddress });
    throw new ApiError(401, "E-mail ou mot de passe incorrect");
  }

  if (user.totpEnabled) {
    return { requires2FA: true, challengeToken: signTwoFaChallengeToken(user.id) };
  }

  return issueSession(user, ipAddress);
}

export async function verifyTwoFaLogin(challengeToken: string, code: string, ipAddress?: string) {
  let payload: { sub: string };
  try {
    payload = verifyTwoFaChallengeToken(challengeToken);
  } catch {
    throw new ApiError(401, "Session de connexion expirée, veuillez vous reconnecter.");
  }

  if (isTwoFaChallengeExhausted(challengeToken)) {
    throw new ApiError(429, "Trop de tentatives, veuillez relancer la connexion.");
  }

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user || !user.actif || !user.totpEnabled || !user.totpSecret) {
    throw new ApiError(401, "Session invalide.");
  }

  if (!verifyTotpCode(user.totpSecret, code)) {
    registerTwoFaFailure(challengeToken);
    await logAudit({ userId: user.id, action: "LOGIN_FAILED", entityType: "User", entityId: user.id, ipAddress });
    throw new ApiError(401, "Code de vérification invalide.");
  }

  twoFaFailedAttempts.delete(challengeToken);
  return issueSession(user, ipAddress);
}

// P3-A : rejeu d'un token de la famille compromise — la reponse est identique a
// un token inconnu (401 sans detail), mais la famille entiere est revoquee et
// l'evenement journalise. Un token revoque qui se presente a nouveau est la
// signature d'un vol (le client legitime l'a remplace) : on ne peut pas faire
// la difference avec une course legitime (double-clic, retry), donc on refuse
// les deux — le frontend deduplique deja ses refresh concurrents.
async function revoquerFamilleCompromise(familyId: string, userId: string | null, tokenId?: string, ipAddress?: string) {
  await prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await logAudit({
    userId,
    action: "SECURITY_EVENT",
    entityType: "RefreshToken",
    entityId: tokenId ?? familyId,
    ipAddress,
    after: { evenement: "REFRESH_TOKEN_REUSE", familyId },
  });
}

/** Révoque TOUTES les sessions refresh d'un utilisateur (logout global,
 *  changement de mot de passe, verrouillage, desactivation). */
export async function revokeAllForUser(userId: string, motif: string, actorId?: string, ipAddress?: string) {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await logAudit({
    userId: actorId ?? userId,
    action: "SECURITY_EVENT",
    entityType: "RefreshToken",
    entityId: userId,
    ipAddress,
    after: { evenement: "REFRESH_TOKENS_REVOKED", userId, motif },
  });
}

export async function refresh(token: string, ipAddress?: string) {
  // Le token brut ne sert qu'ici : recherche par empreinte, verification
  // signature, puis rotation atomique. Il ne sera ni loggue, ni audite, ni stocke.
  let payload: { sub: string };
  try {
    payload = verifyRefreshToken(token);
  } catch {
    throw new ApiError(401, "Jeton de rafraichissement invalide ou expire");
  }

  const result = await prisma.$transaction(async (tx) => {
    const stored = await tx.refreshToken.findUnique({ where: { tokenHash: hashRefreshToken(token) } });
    if (!stored) throw new ApiError(401, "Jeton de rafraichissement invalide ou expire");

    // Rejeu d'un token deja revoque : famille compromise, revoquee et journalisee.
    if (stored.revokedAt) {
      await revoquerFamilleCompromise(stored.familyId, stored.userId, stored.id, ipAddress);
      throw new ApiError(401, "Jeton de rafraichissement invalide ou expire");
    }
    if (stored.expiresAt < new Date()) {
      throw new ApiError(401, "Jeton de rafraichissement invalide ou expire");
    }
    // Le token doit appartenir a l'utilisateur que sa signature declare.
    if (stored.userId !== payload.sub) {
      await revoquerFamilleCompromise(stored.familyId, stored.userId, stored.id, ipAddress);
      throw new ApiError(401, "Jeton de rafraichissement invalide ou expire");
    }

    const user = await tx.user.findUnique({ where: { id: stored.userId } });
    if (!user || !user.actif) {
      // Compte desactive : toutes ses sessions meurent, pas seulement celle-ci.
      await revoquerFamilleCompromise(stored.familyId, stored.userId, stored.id, ipAddress);
      throw new ApiError(401, "Jeton de rafraichissement invalide ou expire");
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      // Verrouillage temporaire (bruteforce login) : sessions refresh coupees
      // aussi — l'agresseur ne doit pas conserver un acces acquis juste avant.
      await revoquerFamilleCompromise(stored.familyId, stored.userId, stored.id, ipAddress);
      throw new ApiError(401, "Jeton de rafraichissement invalide ou expire");
    }

    // Rotation ATOMIQUE : la mise a jour conditionnelle (revokedAt IS NULL) est
    // le verrou. Deux requetes concurrentes sur le meme token : exactement une
    // obtient count=1 et le nouveau token ; l'autre obtient count=0, est
    // traitee comme reutilisation, et la famille entiere est revoquee.
    const newId = newRefreshTokenId();
    const newRaw = signRefreshToken(user.id);
    const claimed = await tx.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date(), replacedById: newId },
    });
    if (claimed.count === 0) {
      await revoquerFamilleCompromise(stored.familyId, stored.userId, stored.id, ipAddress);
      throw new ApiError(401, "Jeton de rafraichissement invalide ou expire");
    }

    await tx.refreshToken.create({
      data: {
        id: newId,
        tokenHash: hashRefreshToken(newRaw),
        familyId: stored.familyId,
        userId: user.id,
        expiresAt: refreshExpiryDate(),
      },
    });

    return { user, newRaw };
  });

  const accessToken = signAccessToken({ sub: result.user.id, role: result.user.role, email: result.user.email });
  return { accessToken, refreshToken: result.newRaw };
}

export async function logout(token: string): Promise<void> {
  // Politique documentee : logout = CE token uniquement. La famille et les
  // autres sessions (autres appareils) survivent — logoutAll pour tout couper.
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashRefreshToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function logoutAll(userId: string, ipAddress?: string) {
  await revokeAllForUser(userId, "LOGOUT_ALL", userId, ipAddress);
}

// ── 2FA : activation / désactivation par l'utilisateur authentifié ────────────

export async function setupTwoFa(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new ApiError(404, "Utilisateur introuvable");

  const secret = generateTotpSecret();
  await prisma.user.update({ where: { id: userId }, data: { totpSecret: secret, totpEnabled: false } });

  return { secret, otpauthUrl: buildOtpauthUrl(user.email, secret) };
}

export async function confirmTwoFa(userId: string, code: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.totpSecret) throw new ApiError(400, "Aucune configuration 2FA en attente. Relancez la configuration.");

  if (!verifyTotpCode(user.totpSecret, code)) {
    throw new ApiError(401, "Code invalide. Vérifiez l'heure de votre appareil et réessayez.");
  }

  await prisma.user.update({ where: { id: userId }, data: { totpEnabled: true } });
  await logAudit({ userId, action: "UPDATE", entityType: "User", entityId: userId, after: { totpEnabled: true } });
}

export async function disableTwoFa(userId: string, password: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !(await verifyPassword(user.passwordHash, password))) {
    throw new ApiError(401, "Mot de passe incorrect.");
  }
  await prisma.user.update({ where: { id: userId }, data: { totpEnabled: false, totpSecret: null } });
  await logAudit({ userId, action: "UPDATE", entityType: "User", entityId: userId, after: { totpEnabled: false } });
}

import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * L'audit des actes de securite : ce que ces tests defendent.
 *
 * QUATRE ACTES SONT DEVENUS ATOMIQUES, TROIS NE LE SONT PAS, ET C'EST VOULU
 *
 * Migres : la revocation d'une famille de jetons compromise, la revocation globale des
 * sessions d'un compte, l'activation et la DESACTIVATION du second facteur. Chacun change
 * la facon dont un compte se protege ; aucun ne doit pouvoir se produire sans trace.
 *
 * Non migres : LOGIN et les deux LOGIN_FAILED. Une panne d'`audit_logs` refuserait alors
 * TOUTE CONNEXION, y compris celle des administrateurs qui devraient venir la reparer.
 * Une trace de connexion perdue se constate et se rattrape ; un systeme ferme a cause de
 * son journal ne se repare pas de l'interieur.
 *
 * Ces tests fixent les deux cotes de cet arbitrage, pour qu'il ne se perde pas : ni une
 * migration bien intentionnee du LOGIN, ni un retour en arriere sur la desactivation du
 * second facteur.
 */

const h = vi.hoisted(() => ({
  /** Lots passes a `$transaction`, pour voir ce qui est atomique. */
  lots: [] as unknown[][],
  /** Appels fail-soft, qui ne passent par aucune transaction. */
  failSoft: [] as Record<string, unknown>[],
  utilisateur: null as Record<string, unknown> | null,
}));

vi.mock("../../utils/audit", () => ({
  logAudit: vi.fn(async (p: Record<string, unknown>) => {
    h.failSoft.push(p);
  }),
  construireAudit: vi.fn((p: Record<string, unknown>) => ({ __audit: p })),
  logAuditTransactionnelle: vi.fn(async () => {}),
}));

vi.mock("../../config/env", () => ({
  env: { JWT_REFRESH_EXPIRES_IN: "7d", JWT_ACCESS_EXPIRES_IN: "15m", NODE_ENV: "test" },
}));
vi.mock("../../utils/jwt", () => ({
  signAccessToken: vi.fn(() => "jeton"),
  signRefreshToken: vi.fn(() => ({ token: "refresh", tokenId: "fam-1" })),
  verifyRefreshToken: vi.fn(),
  hashRefreshToken: vi.fn(() => "empreinte"),
  refreshExpiryDate: vi.fn(() => new Date("2026-10-20T00:00:00.000Z")),
}));
vi.mock("../../utils/totp", () => ({
  generateTotpSecret: vi.fn(() => "secret"),
  buildOtpauthUrl: vi.fn(() => "otpauth://"),
  verifyTotpCode: vi.fn(() => true),
}));
vi.mock("../../utils/password", () => ({
  verifyPassword: vi.fn(async () => true),
  hashPassword: vi.fn(async () => "h"),
}));

vi.mock("../../lib/prisma", () => {
  const client: Record<string, unknown> = {
    user: {
      findUnique: vi.fn(async () => h.utilisateur),
      findFirst: vi.fn(async () => h.utilisateur),
      update: vi.fn(() => ({ __maj: "user" })),
    },
    refreshToken: {
      updateMany: vi.fn(() => ({ __maj: "refreshToken" })),
      create: vi.fn(() => ({ __maj: "refreshTokenCree" })),
      findFirst: vi.fn(async () => null),
    },
    // Verrou de ligne du compte (D9, point 1) : un element du lot, execute dans l'ordre comme les autres.
    $queryRaw: vi.fn(() => ({ __verrou: true })),
    $transaction: vi.fn(async (arg: unknown) => {
      if (typeof arg === "function") return (arg as (t: unknown) => Promise<unknown>)(client);
      h.lots.push(arg as unknown[]);
      return Promise.all(arg as Promise<unknown>[]);
    }),
  };
  return { prisma: client };
});

import { revokeAllForUser, confirmTwoFa, disableTwoFa, setupTwoFa } from "./auth.service";
import { prisma } from "../../lib/prisma";

/** Le lot contient-il a la fois une mutation et une trace ? */
function lotAtomique() {
  for (const lot of h.lots) {
    const maj = lot.find((o) => o && typeof o === "object" && "__maj" in (o as object));
    const audit = lot.find((o) => o && typeof o === "object" && "__audit" in (o as object));
    if (maj && audit) return (audit as { __audit: Record<string, unknown> }).__audit;
  }
  return null;
}

beforeEach(() => {
  h.lots = [];
  h.failSoft = [];
  h.utilisateur = { id: "u1", totpEnabled: true, totpSecret: "s", passwordHash: "h" };
  vi.clearAllMocks();
});

describe("Les actes de securite partent avec leur trace", () => {
  it("revoque toutes les sessions et trace le MOTIF dans la meme transaction", async () => {
    // Sans le motif, on ne distingue plus un changement de mot de passe d'un
    // verrouillage apres incident — et c'est precisement ce qu'un audit doit dire.
    await revokeAllForUser("u1", "PASSWORD_RESET", "admin-1", "10.0.0.1");

    const audit = lotAtomique();
    expect(audit).toMatchObject({ action: "SECURITY_EVENT", entityType: "RefreshToken", userId: "admin-1" });
    expect(audit?.after).toMatchObject({ evenement: "REFRESH_TOKENS_REVOKED", motif: "PASSWORD_RESET" });
    expect(audit?.ipAddress).toBe("10.0.0.1");
  });

  it("la revocation prend d'abord le verrou du compte (D9, point 1), dans le MEME lot que la coupure et la trace", async () => {
    await revokeAllForUser("u1", "LOGOUT_ALL", "u1");
    const lot = h.lots.find((l) => l.some((o) => o && typeof o === "object" && "__maj" in (o as object)));
    expect(lot).toBeDefined();
    expect((lot![0] as { __verrou?: boolean }).__verrou).toBe(true);
    expect(lot).toHaveLength(3);
  });

  it("DESACTIVE le second facteur dans une transaction qui porte sa trace", async () => {
    // Le geste le plus sensible : c'est par la qu'une reprise de compte commencerait.
    await disableTwoFa("u1", "motdepasse");
    expect(lotAtomique()).toMatchObject({
      action: "UPDATE", entityType: "User", entityId: "u1",
    });
    expect((lotAtomique()?.after as Record<string, unknown>).totpEnabled).toBe(false);
  });

  it("active le second facteur de la meme facon", async () => {
    await confirmTwoFa("u1", "123456");
    expect((lotAtomique()?.after as Record<string, unknown>).totpEnabled).toBe(true);
  });

  it("n'utilise AUCUN appel fail-soft sur ces trois actes", async () => {
    // Si quelqu'un revenait au helper historique, la trace redeviendrait perdable en
    // silence sur des actes de securite. Ce test l'empeche.
    await revokeAllForUser("u1", "ACCOUNT_DEACTIVATED", "admin-1");
    await disableTwoFa("u1", "motdepasse");
    expect(h.failSoft).toEqual([]);
  });
});

describe("La reconfiguration du second facteur ne peut pas le desactiver en silence", () => {
  it("REFUSE (409) setup quand la 2FA est deja active et ne reecrit PAS le secret", async () => {
    // Avant correction, setupTwoFa remplacait le secret et remettait totpEnabled a false :
    // un jeton d'acces vole retirait la 2FA sans mot de passe ni trace.
    h.utilisateur = { id: "u1", email: "a@b.gn", totpEnabled: true, totpSecret: "secret-actuel", passwordHash: "h" };

    await expect(setupTwoFa("u1")).rejects.toMatchObject({ status: 409 });

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(h.lots).toEqual([]);
  });

  it("autorise setup quand la 2FA n'est pas encore active", async () => {
    h.utilisateur = { id: "u1", email: "a@b.gn", totpEnabled: false, totpSecret: null, passwordHash: "h" };

    const res = await setupTwoFa("u1");

    expect(res.secret).toBe("secret");
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { totpSecret: "secret", totpEnabled: false },
    });
  });
});

describe("Les evenements de connexion restent tolerants, deliberement", () => {
  it("ne doit PAS etre migre : une panne de journal fermerait le systeme", () => {
    /**
     * Ce test ne verifie pas un comportement, il fixe une DECISION.
     *
     * LOGIN et les deux LOGIN_FAILED passent par `logAudit`, fail-soft. Les migrer
     * rendrait toute connexion impossible pendant une panne d'`audit_logs` — y compris
     * celle des administrateurs qui devraient la reparer. Pour LOGIN_FAILED il n'y a de
     * surcroit aucune ecriture metier a rejoindre : faire echouer la requete changerait
     * un 401 en 500 et apprendrait quelque chose a qui sonde les comptes.
     *
     * Le compromis est assume et visible : chaque echec incremente le compteur
     * qu'expose `/api/health`.
     *
     * Si ces trois appels disparaissent de `auth.service.ts`, ce test le signale et la
     * decision se rediscute au lieu de se perdre.
     */
    const source = readFileSync(join(__dirname, "auth.service.ts"), "utf8");
    const appels = source.match(/logAudit\(\{/g) ?? [];
    expect(appels.length, "LOGIN et les deux LOGIN_FAILED doivent rester fail-soft").toBe(3);
    expect(source).toContain('action: "LOGIN"');
    expect(source).toContain('action: "LOGIN_FAILED"');
  });
});

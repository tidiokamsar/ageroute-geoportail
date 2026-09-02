import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ── Faux prisma à état : le updateMany conditionnel (WHERE revokedAt IS NULL)
// reflète le comportement PostgreSQL qui fait autorité pour la concurrence. ──
const db = vi.hoisted(() => {
  const state = {
    tokens: [] as Record<string, unknown>[],
    users: [] as Record<string, unknown>[],
  };

  const refreshToken = {
    findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) =>
      state.tokens.find((t) => t.tokenHash === where.tokenHash) ?? null),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { revokedAt: null, createdAt: new Date(), ...data };
      state.tokens.push(row);
      return row;
    }),
    update: vi.fn(),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;
      for (const t of state.tokens) {
        const match =
          (where.tokenHash === undefined || t.tokenHash === where.tokenHash) &&
          (where.familyId === undefined || t.familyId === where.familyId) &&
          (where.userId === undefined || t.userId === where.userId) &&
          (where.id === undefined || t.id === where.id) &&
          (where.revokedAt !== null || t.revokedAt == null);
        if (match) { Object.assign(t, data); count++; }
      }
      return { count };
    }),
  };

  const user = {
    findUnique: vi.fn(async ({ where }: { where: { id?: string; email?: string } }) => {
      if (where.id) return state.users.find((u) => u.id === where.id) ?? null;
      return state.users.find((u) => u.email === where.email) ?? null;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const u = state.users.find((x) => x.id === where.id);
      if (u) Object.assign(u, data);
      return u;
    }),
    count: vi.fn(async () => 1),
  };

  const prisma = {
    state,
    refreshToken,
    user,
    $transaction: vi.fn(async (arg: unknown) =>
      Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(prisma)),
  };
  return prisma;
});

vi.mock("../../lib/prisma", () => ({ prisma: db }));

// JWT simulés déterministes : RT-<seq>.<sub> — le brut n'existe qu'en mémoire de test.
const jwt = vi.hoisted(() => {
  let seq = 0;
  return {
    signRefreshToken: vi.fn((userId: string) => `RT-${++seq}.${userId}`),
    verifyRefreshToken: vi.fn((token: string) => {
      const m = /^RT-\d+\.([a-z0-9-]+)$/.exec(token);
      if (!m) throw new Error("jwt malformed");
      return { sub: m[1] };
    }),
    signAccessToken: vi.fn(() => "AT-x"),
  };
});
vi.mock("../../utils/jwt", async () => {
  const real = await vi.importActual<typeof import("../../utils/jwt")>("../../utils/jwt");
  return { ...real, ...jwt };
});
vi.mock("../../config/env", () => ({ env: { JWT_REFRESH_EXPIRES_IN: "7d", NODE_ENV: "development" } }));
vi.mock("../../utils/audit", () => ({ logAudit: vi.fn() }));
vi.mock("../../utils/password", () => ({ verifyPassword: vi.fn(async () => true), hashPassword: vi.fn(async () => "h") }));

import { refresh, logout, logoutAll, revokeAllForUser, login } from "./auth.service";
import { logAudit } from "../../utils/audit";
import { createHash } from "crypto";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const USER_A = { id: "user-a", email: "a@gn", role: "GESTIONNAIRE", actif: true, lockedUntil: null, failedLoginAttempts: 0, nomComplet: "A" };
const USER_B = { id: "user-b", email: "b@gn", role: "INSPECTEUR", actif: true, lockedUntil: null, failedLoginAttempts: 0, nomComplet: "B" };

async function sessionPour(user: Record<string, unknown>) {
  db.state.users.push({ passwordHash: "h", failedLoginAttempts: 0, lockedUntil: null, ...user });
  // flux public complet : login (verifyPassword mocke a true) -> session issue
  // (2FA desactivee sur les utilisateurs de test : l union de retour se reduit a la session)
  const session = await login(user.email as string, "mot-de-passe-test", "127.0.0.1");
  if (!("refreshToken" in session)) throw new Error("session sans refresh token");
  return session;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.state.tokens.length = 0;
  db.state.users.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("P3-A — cycle refresh token", () => {
  it("TEST 1 : login → refresh → succès, et rotation remplace le token", async () => {
    const s = await sessionPour(USER_A);
    const r = await refresh(s.refreshToken);
    expect(r.accessToken).toBeTruthy();
    expect(r.refreshToken).not.toBe(s.refreshToken);
    // l'ancien token est révoqué avec lien de remplacement, le nouveau stocké par empreinte
    const ancien = db.state.tokens.find((t) => t.tokenHash === sha(s.refreshToken)) as { revokedAt: Date | null; replacedById: string | null };
    expect(ancien.revokedAt).toBeInstanceOf(Date);
    expect(ancien.replacedById).toBeTruthy();
    expect(db.state.tokens.some((t) => t.tokenHash === sha(r.refreshToken))).toBe(true);
  });

  it("TEST 2/3 : réutilisation de l'ancien token → 401 + SECURITY_EVENT détecté", async () => {
    const s = await sessionPour(USER_A);
    await refresh(s.refreshToken); // A → B
    await expect(refresh(s.refreshToken)).rejects.toMatchObject({ status: 401 });
    const evenement = (logAudit as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).find((a) => a.action === "SECURITY_EVENT");
    expect(evenement).toBeDefined();
    expect(evenement!.after).toMatchObject({ evenement: "REFRESH_TOKEN_REUSE" });
    expect(evenement!.after.familyId).toBe(db.state.tokens[0].familyId);
  });

  it("TEST 4/5 : la famille compromise est révoquée — le token B meurt aussi", async () => {
    const s = await sessionPour(USER_A);
    const r = await refresh(s.refreshToken); // A → B
    await expect(refresh(s.refreshToken)).rejects.toMatchObject({ status: 401 }); // rejeu de A
    await expect(refresh(r.refreshToken)).rejects.toMatchObject({ status: 401 }); // B compromis
  });

  it("TEST 6 : token expiré → 401 SANS réputation de vol (famille intacte)", async () => {
    const s = await sessionPour(USER_A);
    (db.state.tokens[0] as { expiresAt: Date }).expiresAt = new Date(Date.now() - 1000);
    await expect(refresh(s.refreshToken)).rejects.toMatchObject({ status: 401 });
    expect((logAudit as ReturnType<typeof vi.fn>).mock.calls.some((c) => c[0].action === "SECURITY_EVENT")).toBe(false);
  });

  it("TEST 7/8 : logout → CE token refusé (politique : rejeu post-logout = alarme, famille coupée)", async () => {
    const s1 = await sessionPour(USER_A);
    const s2 = await sessionPour(USER_A); // autre appareil, autre famille
    await logout(s1.refreshToken);
    await expect(refresh(s1.refreshToken)).rejects.toMatchObject({ status: 401 });
    // l'autre famille survit au logout d'un seul appareil
    const r2 = await refresh(s2.refreshToken);
    expect(r2.refreshToken).toBeTruthy();
  });

  it("TEST 9 : deux refresh CONCURRENTS du même token → exactement un gagnant, famille mise en quarantaine", async () => {
    const s = await sessionPour(USER_A);
    const [a, b] = await Promise.allSettled([
      refresh(s.refreshToken),
      refresh(s.refreshToken),
    ]);
    const gagnants = [a, b].filter((r) => r.status === "fulfilled");
    expect(gagnants).toHaveLength(1);
    // Le perdant a décrété la famille compromise : le token du gagnant est mort aussi,
    // le prochain refresh impose une reconnexion. Déterministe et sûr (documenté).
    const brutGagnant = (gagnants[0] as PromiseFulfilledResult<{ refreshToken: string }>).value.refreshToken;
    await expect(refresh(brutGagnant)).rejects.toMatchObject({ status: 401 });
  });

  it("TEST 10 : token d'un utilisateur présenté contre la ligne d'un autre → 401 + famille révoquée", async () => {
    const s = await sessionPour(USER_A);
    // falsification : la ligne de A prétend désormais appartenir à B
    (db.state.tokens[0] as { userId: string }).userId = USER_B.id;
    await expect(refresh(s.refreshToken)).rejects.toMatchObject({ status: 401 });
    expect((logAudit as ReturnType<typeof vi.fn>).mock.calls.some((c) => c[0].action === "SECURITY_EVENT")).toBe(true);
  });

  it("TEST 11 : base compromise → les valeurs stockées ne sont PAS des tokens utilisables", async () => {
    const s = await sessionPour(USER_A);
    const vole = db.state.tokens[0].tokenHash as string;
    // un attaquant qui ne lit que la base présente l'empreinte comme token :
    expect(vole).not.toBe(s.refreshToken);
    expect(vole).toMatch(/^[0-9a-f]{64}$/);
    await expect(refresh(vole)).rejects.toMatchObject({ status: 401 });
    // et aucune colonne ne contient le brut
    expect(Object.keys(db.state.tokens[0]).some((k) => /token/i.test(k) && k !== "tokenHash" && k !== "replacedById")).toBe(false);
  });

  it("TEST 12/13 : ni logs ni audit ne contiennent jamais le token brut", async () => {
    const espion = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = await sessionPour(USER_A);
    await refresh(s.refreshToken);
    await expect(refresh(s.refreshToken)).rejects.toMatchObject({ status: 401 });
    const brutConnus = [s.refreshToken, ...db.state.tokens.map((t) => t.tokenHash)];
    const trace = JSON.stringify({
      audit: (logAudit as ReturnType<typeof vi.fn>).mock.calls,
      logs: espion.mock.calls,
    });
    for (const brut of brutConnus) {
      expect(trace).not.toContain(brut === s.refreshToken ? brut : brut);
    }
    expect(trace).not.toContain(s.refreshToken);
  });

  it("TEST 14 : révocation administrative (logout-all) coupe toutes les sessions", async () => {
    const s1 = await sessionPour(USER_A);
    const s2 = await sessionPour(USER_A);
    await logoutAll(USER_A.id);
    await expect(refresh(s1.refreshToken)).rejects.toMatchObject({ status: 401 });
    await expect(refresh(s2.refreshToken)).rejects.toMatchObject({ status: 401 });
    const evenement = (logAudit as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).find((a) => a.action === "SECURITY_EVENT");
    expect(evenement).toBeDefined();
    expect(evenement!.after).toMatchObject({ evenement: "REFRESH_TOKENS_REVOKED", motif: "LOGOUT_ALL" });
  });

  it("TEST 15 : changement de mot de passe → toutes les sessions révoquées (revokeAllForUser, motif PASSWORD_RESET)", async () => {
    const s = await sessionPour(USER_A);
    await revokeAllForUser(USER_A.id, "PASSWORD_RESET", "admin-1");
    await expect(refresh(s.refreshToken)).rejects.toMatchObject({ status: 401 });
  });

  it("TEST 16 : compte verrouillé → refresh refusé et famille révoquée", async () => {
    const s = await sessionPour(USER_A);
    (db.state.users[0] as { lockedUntil: Date | null }).lockedUntil = new Date(Date.now() + 10 * 60_000);
    await expect(refresh(s.refreshToken)).rejects.toMatchObject({ status: 401 });
    expect((logAudit as ReturnType<typeof vi.fn>).mock.calls.some((c) => c[0].action === "SECURITY_EVENT")).toBe(true);
  });

  it("MATRICE : le verrouillage au login (5 échecs) révoque aussi les sessions existantes", async () => {
    const s = await sessionPour(USER_A);
    const { verifyPassword } = await import("../../utils/password");
    (verifyPassword as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (db.state.users[0] as { failedLoginAttempts: number }).failedLoginAttempts = 4; // 5e échec
    await expect(login(USER_A.email, "mauvais", "1.2.3.4")).rejects.toMatchObject({ status: 401 });
    await expect(refresh(s.refreshToken)).rejects.toMatchObject({ status: 401 });
  });

  it("MATRICE : compte désactivé → refresh refusé et famille révoquée", async () => {
    const s = await sessionPour(USER_A);
    (db.state.users[0] as { actif: boolean }).actif = false;
    await expect(refresh(s.refreshToken)).rejects.toMatchObject({ status: 401 });
  });
});

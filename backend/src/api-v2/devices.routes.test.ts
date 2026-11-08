import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const h = vi.hoisted(() => ({
  user: { id: "agent-1", role: "INSPECTEUR" },
  /** Appels de la transaction, dans l'ordre : le verrou du proprietaire doit venir AVANT la revocation. */
  ordre: [] as string[],
  /** Revocation la plus recente du compte (D9, point 6) ; `null` = aucune. */
  derniereRevocation: null as Date | null,
  fenetreDemandee: 0,
  fenetreUtilisateur: "",
  activeCount: 0,
  appareil: null as Record<string, unknown> | null,
  audits: [] as Record<string, unknown>[],
  auditFailure: false,
  forceRevokeConflict: false,
  isolationLevel: "",
}));

vi.mock("../config/env", () => ({ env: { JWT_ACCESS_EXPIRES_IN: "15m" } }));
vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { ...h.user };
    next();
  },
}));
vi.mock("../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
vi.mock("../utils/audit", () => ({
  logAuditTransactionnelle: vi.fn(async (
    tx: { auditLog: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> } },
    params: Record<string, unknown>,
  ) => tx.auditLog.create({ data: params })),
}));
vi.mock("../lib/prisma", () => ({
  prisma: {
    appareil: {
      findUnique: vi.fn(async () => h.appareil),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...h.appareil, ...data })),
    },
    $transaction: vi.fn(async (
      run: (tx: unknown) => Promise<unknown>,
      options?: { isolationLevel?: string },
    ) => {
      h.isolationLevel = options?.isolationLevel ?? "default";
      const ancienAppareil = h.appareil ? { ...h.appareil } : null;
      const ancienNombre = h.activeCount;
      const anciennesTraces = [...h.audits];
      const tx = {
        // Verrou de ligne du proprietaire (D9, point 1) : le texte SQL est conserve pour verifier le mode et l'ordre.
        $queryRaw: vi.fn(async (texte: TemplateStringsArray) => { h.ordre.push(`verrou:${texte.join("?").trim()}`); return []; }),
        appareil: {
          count: vi.fn(async () => h.activeCount),
          findFirst: vi.fn(async ({ where }: { where: { userId: string; revoqueA: { gt: Date } } }) => {
            h.fenetreDemandee = where.revoqueA.gt.getTime();
            h.fenetreUtilisateur = where.userId;
            return h.derniereRevocation && h.derniereRevocation > where.revoqueA.gt ? { revoqueA: h.derniereRevocation } : null;
          }),
          create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
            h.appareil = { id: "device-1", revoqueA: null, ...data };
            h.activeCount++;
            return h.appareil;
          }),
          updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            h.ordre.push("appareil.updateMany");
            if (h.forceRevokeConflict || !h.appareil || where.id !== h.appareil.id || h.appareil.revoqueA !== null) {
              return { count: 0 };
            }
            h.appareil = { ...h.appareil, ...data };
            h.activeCount--;
            return { count: 1 };
          }),
          findUnique: vi.fn(async () => h.appareil),
        },
        // Revocation du porteur (D4) : le detail est eprouve par securite/appareil-revoque.test.ts.
        refreshToken: { updateMany: vi.fn(async () => { h.ordre.push("refreshToken.updateMany"); return { count: 0 }; }) },
        auditLog: {
          create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
            if (h.auditFailure) throw new Error("audit unavailable");
            h.audits.push(data);
            return data;
          }),
        },
      };
      try {
        return await run(tx);
      } catch (error) {
        h.appareil = ancienAppareil;
        h.activeCount = ancienNombre;
        h.audits = anciennesTraces;
        throw error;
      }
    }),
  },
}));

import { devicesV2Router } from "./devices.routes";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/v2/devices", devicesV2Router);
  a.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ message: "internal error" });
  });
  return a;
}

beforeEach(() => {
  h.user = { id: "agent-1", role: "INSPECTEUR" };
  h.activeCount = 0;
  h.ordre = [];
  h.derniereRevocation = null;
  h.appareil = null;
  h.audits = [];
  h.auditFailure = false;
  h.forceRevokeConflict = false;
  h.isolationLevel = "";
  vi.clearAllMocks();
});

describe("POST /api/v2/devices", () => {
  const payload = { plateforme: "android", modele: "Field phone" };

  it("crée l'appareil et son audit dans une transaction sérialisable", async () => {
    const response = await request(app()).post("/api/v2/devices").send(payload);

    expect(response.status).toBe(201);
    expect(response.body.id).toBe("device-1");
    expect(h.audits).toEqual([expect.objectContaining({ action: "CREATE", entityType: "Appareil" })]);
    expect(h.isolationLevel).toBe("Serializable");
  });

  it("refuse le plafond sans créer d'appareil ni d'audit", async () => {
    h.activeCount = 10;
    const response = await request(app()).post("/api/v2/devices").send(payload);

    expect(response.status).toBe(409);
    expect(h.appareil).toBeNull();
    expect(h.audits).toHaveLength(0);
  });

  it("annule la création si l'audit échoue", async () => {
    h.auditFailure = true;
    const response = await request(app()).post("/api/v2/devices").send(payload);

    expect(response.status).toBe(500);
    expect(h.appareil).toBeNull();
    expect(h.activeCount).toBe(0);
  });

  describe("fenêtre résiduelle après une révocation (D9, point 6)", () => {
    it("refuse un appareil NEUF tant qu'un appareil du compte est révoqué depuis moins de la durée du jeton d'accès", async () => {
      h.derniereRevocation = new Date(Date.now() - 5 * 60_000);
      const response = await request(app()).post("/api/v2/devices").send(payload);

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("APPAREIL_REVOCATION_RECENTE");
      // 15 min de jeton, révoqué il y a 5 min : il reste environ 10 min.
      expect(response.body.reessayerDansMs).toBeGreaterThan(9 * 60_000);
      expect(response.body.reessayerDansMs).toBeLessThanOrEqual(10 * 60_000);
      expect(h.appareil).toBeNull();
      expect(h.audits).toHaveLength(0);
    });

    it("interroge bien les révocations de CE compte, dans la fenêtre de 15 minutes", async () => {
      const avant = Date.now();
      await request(app()).post("/api/v2/devices").send(payload);
      // La fenêtre se lit dans le filtre : revoqueA > maintenant - 15 min.
      expect(h.fenetreDemandee).toBeGreaterThan(avant - 15 * 60_000 - 5_000);
      expect(h.fenetreDemandee).toBeLessThan(Date.now() - 15 * 60_000 + 5_000);
      expect(h.fenetreUtilisateur).toBe("agent-1");
    });

    it("sans révocation récente : l'enregistrement d'un appareil neuf est inchangé (201)", async () => {
      expect((await request(app()).post("/api/v2/devices").send(payload)).status).toBe(201);
    });

    it("une révocation plus ancienne que la durée du jeton ne bloque plus", async () => {
      h.derniereRevocation = new Date(Date.now() - 16 * 60_000);
      expect((await request(app()).post("/api/v2/devices").send(payload)).status).toBe(201);
    });

    it("la re-déclaration d'un appareil ACTIF du compte n'est pas concernée", async () => {
      h.derniereRevocation = new Date(Date.now() - 60_000);
      h.appareil = { id: "00000000-0000-4000-8000-000000000001", userId: "agent-1", revoqueA: null, plateforme: "android" };
      const response = await request(app()).post("/api/v2/devices").send({ ...payload, appareilId: "00000000-0000-4000-8000-000000000001" });
      expect(response.status).toBe(200);
    });

    it("le refus passe avant le plafond d'appareils actifs (le code stable dit la vraie cause)", async () => {
      h.derniereRevocation = new Date(Date.now() - 60_000);
      h.activeCount = 10;
      expect((await request(app()).post("/api/v2/devices").send(payload)).body.code).toBe("APPAREIL_REVOCATION_RECENTE");
    });
  });
});

describe("POST /api/v2/devices/:id/revoke", () => {
  beforeEach(() => {
    h.appareil = { id: "device-1", userId: "agent-1", revoqueA: null, plateforme: "android" };
    h.activeCount = 1;
  });

  it("révoque l'appareil et journalise l'événement de sécurité", async () => {
    const response = await request(app()).post("/api/v2/devices/device-1/revoke");

    expect(response.status).toBe(200);
    expect(response.body.revoqueA).toBeTruthy();
    expect(h.audits).toEqual([expect.objectContaining({ action: "SECURITY_EVENT", entityType: "Appareil" })]);
  });

  it("refuse de révoquer l'appareil d'un autre compte : 404, la même réponse qu'un appareil inconnu (D9, point 7a)", async () => {
    h.appareil = { ...h.appareil, userId: "agent-2" };
    const response = await request(app()).post("/api/v2/devices/device-1/revoke");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ message: "Appareil introuvable" });
    expect(h.appareil.revoqueA).toBeNull();
    expect(h.audits).toHaveLength(0);
    expect(h.ordre).toEqual([]);
  });

  it("un ADMIN révoque l'appareil d'un autre compte (le 404 ne vaut que pour un non-ADMIN)", async () => {
    h.user = { id: "admin-1", role: "ADMIN" };
    h.appareil = { ...h.appareil, userId: "agent-2" };
    expect((await request(app()).post("/api/v2/devices/device-1/revoke")).status).toBe(200);
  });

  it("verrouille la ligne du PROPRIÉTAIRE (FOR UPDATE) AVANT de révoquer l'appareil et ses jetons (D9, point 1)", async () => {
    const response = await request(app()).post("/api/v2/devices/device-1/revoke");

    expect(response.status).toBe(200);
    expect(h.ordre[0]).toMatch(/^verrou:SELECT id FROM users WHERE id = \? FOR UPDATE$/);
    expect(h.ordre.slice(1)).toEqual(["appareil.updateMany", "refreshToken.updateMany"]);
  });

  it("rend un conflit si une révocation concurrente a déjà gagné", async () => {
    h.forceRevokeConflict = true;
    const response = await request(app()).post("/api/v2/devices/device-1/revoke");

    expect(response.status).toBe(409);
    expect(h.audits).toHaveLength(0);
  });

  it("annule la révocation si l'audit échoue", async () => {
    h.auditFailure = true;
    const response = await request(app()).post("/api/v2/devices/device-1/revoke");

    expect(response.status).toBe(500);
    expect(h.appareil?.revoqueA).toBeNull();
    expect(h.activeCount).toBe(1);
  });
});

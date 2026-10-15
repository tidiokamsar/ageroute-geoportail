import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const h = vi.hoisted(() => ({
  user: { id: "agent-1", role: "INSPECTEUR" },
  activeCount: 0,
  appareil: null as Record<string, unknown> | null,
  audits: [] as Record<string, unknown>[],
  auditFailure: false,
  forceRevokeConflict: false,
  isolationLevel: "",
}));

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
        appareil: {
          count: vi.fn(async () => h.activeCount),
          create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
            h.appareil = { id: "device-1", revoqueA: null, ...data };
            h.activeCount++;
            return h.appareil;
          }),
          updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            if (h.forceRevokeConflict || !h.appareil || where.id !== h.appareil.id || h.appareil.revoqueA !== null) {
              return { count: 0 };
            }
            h.appareil = { ...h.appareil, ...data };
            h.activeCount--;
            return { count: 1 };
          }),
          findUnique: vi.fn(async () => h.appareil),
        },
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

  it("refuse de révoquer l'appareil d'un autre compte", async () => {
    h.appareil = { ...h.appareil, userId: "agent-2" };
    const response = await request(app()).post("/api/v2/devices/device-1/revoke");

    expect(response.status).toBe(403);
    expect(h.appareil.revoqueA).toBeNull();
    expect(h.audits).toHaveLength(0);
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

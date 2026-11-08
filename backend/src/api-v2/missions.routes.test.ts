import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

// Controle territorial (A10) : compte NATIONAL ici, le sujet de ce fichier est ailleurs. Le controle lui-meme
// (lecture et ecriture par region) est eprouve par securite/controle-acces.test.ts et par le banc
// tests-integration/controle-acces.integration.mts.
vi.mock("../territoire/territoire.service", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  perimetreDe: async () => ({ national: true }),
}));

const h = vi.hoisted(() => ({
  user: { id: "gestionnaire-1", role: "GESTIONNAIRE" },
  mission: null as Record<string, unknown> | null,
  codeExiste: false,
  forceCasFailure: false,
  auditFailure: false,
  audits: [] as Record<string, unknown>[],
}));

vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { ...h.user };
    return next();
  },
}));
vi.mock("../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
vi.mock("../middleware/rbac.middleware", () => ({
  requireRole: (...roles: string[]) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const role = (req as unknown as { user: { role: string } }).user.role;
    if (!roles.includes(role)) return res.status(403).json({ message: "forbidden" });
    return next();
  },
}));
vi.mock("../utils/audit", () => ({
  logAuditTransactionnelle: vi.fn(async (
    tx: { auditLog: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> } },
    params: Record<string, unknown>,
  ) => tx.auditLog.create({ data: params })),
}));
vi.mock("../lib/prisma", () => ({
  prisma: {
    mission: {
      findMany: vi.fn(async () => h.mission ? [h.mission] : []),
      findUnique: vi.fn(async ({ where }: { where: { id?: string; code?: string } }) => {
        if (where.code) return h.codeExiste ? { id: "existing" } : null;
        return h.mission?.id === where.id ? h.mission : null;
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (!h.mission) return null;
        if (h.user.role === "ADMIN" || h.user.role === "GESTIONNAIRE") return h.mission;
        const conditions = where.OR as Array<Record<string, unknown>> | undefined;
        return conditions?.some((condition) =>
          (condition.assigneId !== undefined && h.mission?.assigneId === condition.assigneId)
          || (condition.createurId !== undefined && h.mission?.createurId === condition.createurId),
        ) ? h.mission : null;
      }),
    },
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => {
      const ancienneMission = h.mission ? { ...h.mission } : null;
      const anciennesTraces = [...h.audits];
      const tx = {
        mission: {
          create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
            h.mission = { id: "mission-1", statut: "BROUILLON", deletedAt: null, ...data };
            return h.mission;
          }),
          updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            if (h.forceCasFailure || !h.mission || h.mission.id !== where.id || h.mission.statut !== where.statut) {
              return { count: 0 };
            }
            h.mission = { ...h.mission, ...data };
            return { count: 1 };
          }),
          findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
            h.mission?.id === where.id ? h.mission : null),
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
        h.mission = ancienneMission;
        h.audits = anciennesTraces;
        throw error;
      }
    }),
  },
}));

import { missionsV2Router } from "./missions.routes";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/v2/missions", missionsV2Router);
  a.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ message: "internal error" });
  });
  return a;
}

beforeEach(() => {
  h.user = { id: "gestionnaire-1", role: "GESTIONNAIRE" };
  h.mission = null;
  h.codeExiste = false;
  h.forceCasFailure = false;
  h.auditFailure = false;
  h.audits = [];
  vi.clearAllMocks();
});

describe("POST /api/v2/missions", () => {
  const payload = { code: "MISSION-1", intitule: "Inspection RN1", type: "INSPECTION" };

  it("crée la mission et sa trace d'audit dans la même transaction", async () => {
    const response = await request(app()).post("/api/v2/missions").send(payload);

    expect(response.status).toBe(201);
    expect(response.body.id).toBe("mission-1");
    expect(h.audits).toEqual([expect.objectContaining({ action: "CREATE", entityType: "Mission" })]);
  });

  it("refuse un code déjà utilisé", async () => {
    h.codeExiste = true;
    const response = await request(app()).post("/api/v2/missions").send(payload);

    expect(response.status).toBe(409);
    expect(h.mission).toBeNull();
    expect(h.audits).toHaveLength(0);
  });

  it("annule la création si l'audit échoue", async () => {
    h.auditFailure = true;
    const response = await request(app()).post("/api/v2/missions").send(payload);

    expect(response.status).toBe(500);
    expect(h.mission).toBeNull();
  });
});

describe("POST /api/v2/missions/:id/statut", () => {
  beforeEach(() => {
    h.mission = {
      id: "mission-1", code: "MISSION-1", statut: "PLANIFIEE", deletedAt: null,
      assigneId: "agent-1", createurId: "gestionnaire-1", debutReel: null, finReelle: null,
    };
  });

  it("applique une transition autorisée et l'audite", async () => {
    const response = await request(app()).post("/api/v2/missions/mission-1/statut").send({ statut: "EN_COURS" });

    expect(response.status).toBe(200);
    expect(response.body.statut).toBe("EN_COURS");
    expect(response.body.debutReel).toBeTruthy();
    expect(h.audits).toEqual([expect.objectContaining({ action: "UPDATE", entityType: "Mission" })]);
  });

  it("ne perd pas une transition concurrente", async () => {
    h.forceCasFailure = true;
    const response = await request(app()).post("/api/v2/missions/mission-1/statut").send({ statut: "EN_COURS" });

    expect(response.status).toBe(409);
    expect(h.mission?.statut).toBe("PLANIFIEE");
    expect(h.audits).toHaveLength(0);
  });

  it("annule la transition si l'audit échoue", async () => {
    h.auditFailure = true;
    const response = await request(app()).post("/api/v2/missions/mission-1/statut").send({ statut: "EN_COURS" });

    expect(response.status).toBe(500);
    expect(h.mission?.statut).toBe("PLANIFIEE");
    expect(h.audits).toHaveLength(0);
  });

  it("ne donne pas accès aux missions hors périmètre", async () => {
    h.user = { id: "agent-2", role: "INSPECTEUR" };
    const response = await request(app()).post("/api/v2/missions/mission-1/statut").send({ statut: "EN_COURS" });

    expect(response.status).toBe(404);
    expect(h.mission?.statut).toBe("PLANIFIEE");
    expect(h.audits).toHaveLength(0);
  });
});

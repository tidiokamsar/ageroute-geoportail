import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const h = vi.hoisted(() => ({
  user: { id: "gestionnaire-1", role: "GESTIONNAIRE" },
  observation: {
    id: "obs-1", statut: "PROPOSEE", agentId: "agent-1", version: 3,
    deletedAt: null, clientOperationId: "op-1", missionId: null,
  } as Record<string, unknown> | null,
  count: 1,
  validations: [] as Record<string, unknown>[],
  audits: [] as Record<string, unknown>[],
  qualites: [] as Record<string, unknown>[],
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
vi.mock("../lib/prisma", () => ({
  prisma: {
    mission: { findMany: vi.fn(async () => []) },
    observation: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => h.observation),
    },
    validation: {
      findMany: vi.fn(async () => h.validations),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      observation: {
        updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (h.count === 1 && h.observation) {
            const updated = { ...data };
            updated.version = Number(h.observation.version) + 1;
            h.observation = { ...h.observation, ...updated };
          }
          return { count: h.count };
        }),
        findUnique: vi.fn(async () => h.observation),
      },
      validation: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          h.validations.push(data);
          return data;
        }),
      },
      auditLog: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { h.audits.push(data); return data; }),
      },
    })),
  },
}));
vi.mock("../lib/qualite", () => ({
  enregistrerQualite: vi.fn(async (data: Record<string, unknown>) => { h.qualites.push(data); }),
}));
vi.mock("../utils/audit", () => ({
  logAudit: vi.fn(async (data: Record<string, unknown>) => { h.audits.push(data); }),
  logAuditTransactionnelle: vi.fn(async (tx: { auditLog: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> } }, data: Record<string, unknown>) => tx.auditLog.create({ data })),
}));

import { observationsV2Router } from "./observations.routes";
import { errorHandler } from "../middleware/error.middleware";

const app = express();
app.use(express.json());
app.use("/api/v2/observations", observationsV2Router);
app.use(errorHandler);

beforeEach(() => {
  h.user = { id: "gestionnaire-1", role: "GESTIONNAIRE" };
  h.observation = {
    id: "obs-1", statut: "PROPOSEE", agentId: "agent-1", version: 3,
    deletedAt: null, clientOperationId: "op-1", missionId: null,
  };
  h.count = 1;
  h.validations = [];
  h.audits = [];
  h.qualites = [];
  vi.clearAllMocks();
});

describe("POST /api/v2/observations/:id/validate", () => {
  it("enregistre la décision dans l'historique commun et avance la version", async () => {
    const response = await request(app).post("/api/v2/observations/obs-1/validate").send({ decision: "VALIDEE" });

    expect(response.status).toBe(200);
    expect(response.body.statut).toBe("VALIDEE");
    expect(response.body.version).toBe(4);
    expect(h.validations).toEqual([expect.objectContaining({
      entityType: "Observation", entityId: "obs-1", statutAvant: "A_VALIDER",
      statutApres: "VALIDE", auteurId: "agent-1", source: "terrain",
    })]);
    expect(h.audits[0]).toMatchObject({ action: "VALIDATE", entityType: "Observation" });
  });

  it("refuse l'auto-validation", async () => {
    h.user = { id: "agent-1", role: "GESTIONNAIRE" };
    const response = await request(app).post("/api/v2/observations/obs-1/validate").send({ decision: "VALIDEE" });
    expect(response.status).toBe(403);
    expect(response.body.motif).toBe("AUTO_VALIDATION");
    expect(h.validations).toHaveLength(0);
  });

  it("exige un motif pour le rejet", async () => {
    const response = await request(app).post("/api/v2/observations/obs-1/validate").send({ decision: "REJETEE" });
    expect(response.status).toBe(409);
    expect(response.body.motif).toBe("COMMENTAIRE_REQUIS");
    expect(h.validations).toHaveLength(0);
  });

  it("refuse une décision si la version a changé depuis la lecture", async () => {
    h.count = 0;
    const response = await request(app).post("/api/v2/observations/obs-1/validate").send({ decision: "VALIDEE" });
    expect(response.status).toBe(409);
    expect(h.validations).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });
});

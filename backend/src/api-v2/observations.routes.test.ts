import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

// Controle territorial (A10) : compte NATIONAL ici, le sujet de ce fichier est ailleurs. Le
// controle lui-meme est eprouve par territoire/*.test.ts et api-v2/perimetres.routes.test.ts.
vi.mock("../territoire/territoire.service", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  perimetreDe: async () => ({ national: true }),
}));

const h = vi.hoisted(() => ({
  /** Delegations du domaine OBSERVATION presentes en base. */
  delegations: [] as Record<string, unknown>[],
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
    // Paragraphe 35 : « un validateur est designe pour chaque domaine ». La route de
    // validation lit ces designations ; un mock sans ce delegue fait rendre 500.
    delegationValidation: { findMany: vi.fn(async () => h.delegations) },
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
  h.delegations = [];
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
      statutApres: "VALIDE", auteurId: "agent-1",
      // `source` porte desormais l'AUTORITE en plus de l'origine : aucun validateur n'est
      // designe sur ce domaine, donc la decision repose sur la regle d'avant. Sans cette
      // mention, on ne saurait pas dans un an si elle reposait sur une designation ou sur
      // son absence (paragraphe 35).
      source: "terrain:DOMAINE_NON_DESIGNE",
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

describe("Observations — délégation de validation (§35)", () => {
  /**
   * Deuxième des sept domaines à consulter les délégations, après les défauts.
   *
   * La règle est un RESSERREMENT PAR DOMAINE, et les domaines sont indépendants :
   * désigner un validateur pour `DEFAUT` ne change rien aux observations, et
   * inversement. Ce test le fixe, parce que c'est le genre de nuance qu'une refonte
   * remplacerait par un drapeau global.
   */
  const delegation = (p: Record<string, unknown> = {}) => ({
    domaine: "OBSERVATION",
    validateurId: "gestionnaire-1",
    regionId: null,
    debutLe: new Date("2026-01-01T00:00:00.000Z"),
    finLe: null,
    revoqueeLe: null,
    ...p,
  });

  it("laisse valider tant que personne n'est désigné, et le dit dans l'historique", async () => {
    h.user = { id: "gestionnaire-1", role: "GESTIONNAIRE" };
    h.delegations = [];

    const r = await request(app).post("/api/v2/observations/obs-1/validate").send({ decision: "VALIDEE" });
    expect(r.status).toBe(200);
    expect(h.validations.at(-1)).toMatchObject({ source: "terrain:DOMAINE_NON_DESIGNE" });
  });

  it("RÉSERVE le domaine aux désignés dès qu'un seul l'est", async () => {
    h.user = { id: "gestionnaire-1", role: "GESTIONNAIRE" };
    h.delegations = [delegation({ validateurId: "quelqu-un-d-autre" })];

    const r = await request(app).post("/api/v2/observations/obs-1/validate").send({ decision: "VALIDEE" });
    expect(r.status).toBe(403);
    expect(r.body.motif).toBe("HORS_DELEGATION");
  });

  it("laisse passer le désigné, et l'inscrit dans l'historique", async () => {
    h.user = { id: "gestionnaire-1", role: "GESTIONNAIRE" };
    h.delegations = [delegation({ validateurId: "gestionnaire-1" })];

    const r = await request(app).post("/api/v2/observations/obs-1/validate").send({ decision: "VALIDEE" });
    expect(r.status).toBe(200);
    expect(h.validations.at(-1)).toMatchObject({ source: "terrain:DELEGATION_COUVRANTE" });
  });

  it("NOMME L'AUTO-VALIDATION avant la délégation", async () => {
    // La séparation des rôles n'est pas délégable : répondre « vous n'êtes pas désigné »
    // enverrait demander une délégation qui ne changerait rien.
    // L'auteur de l'observation EST le validateur : c'est le cas a defendre.
    h.user = { id: "agent-1", role: "GESTIONNAIRE" };
    h.delegations = [delegation({ validateurId: "autre" })];

    const r = await request(app).post("/api/v2/observations/obs-1/validate").send({ decision: "VALIDEE" });
    expect(r.status).toBe(403);
    expect(r.body.motif).toBe("AUTO_VALIDATION");
  });
});

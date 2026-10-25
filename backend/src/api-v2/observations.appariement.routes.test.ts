import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Rattacher une observation à un tronçon, SUR PROPOSITION. Ce que ces tests défendent :
 *   - le serveur propose, un responsable confirme : sans confirmation, rien n'est écrit ;
 *   - la confirmation reverifie le candidat : un autre tronçon que celui calculé est refusé (409) ;
 *   - une observation déjà tranchée n'est pas déplacée ; sans position GPS, 422 ;
 *   - réservé aux responsables ; écriture auditée avec l'avant et l'après, version incrémentée.
 */
const h = vi.hoisted(() => ({
  compte: { id: "chef-1", role: "GESTIONNAIRE" },
  observation: { id: "o1", lat: 9.64, lon: -13.6, precisionM: 7, statut: "PROPOSEE", version: 3, tronconId: null } as Record<string, unknown> | null,
  suggestion: { tronconId: "t1", code: "GN N0001", nom: "RN1", classe: "RN", distanceM: 12, abscisseM: 340, pk: 4.2, pkMotif: "CALCULE", confiance: 0.88, ambigu: false } as Record<string, unknown> | null,
  majCount: 1,
  majAppels: [] as Record<string, unknown>[],
  audits: [] as Record<string, unknown>[],
  apparier: vi.fn(),
}));

vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => { (req as unknown as { user: unknown }).user = { ...h.compte }; n(); },
}));
vi.mock("../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_q: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));
vi.mock("../territoire/territoire.v2", () => ({
  territoireObservation: (_q: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));
vi.mock("../geo/appariement", () => ({ apparier: h.apparier }));
vi.mock("../middleware/upload-photo.middleware", () => ({ uploadPhoto: (_q: express.Request, _s: express.Response, n: express.NextFunction) => n(), PHOTOS_UPLOAD_DIR: "uploads/photos" }));
vi.mock("../governance/validation", () => ({ validationPermise: () => ({ ok: true }), EXPLICATIONS: {} }));
vi.mock("../governance/delegation.service", () => ({ verdictDelegation: vi.fn(async () => ({ ok: true })) }));
vi.mock("../lib/qualite", () => ({ enregistrerQualite: vi.fn(async () => undefined) }));
vi.mock("../utils/audit", () => ({
  logAuditTransactionnelle: vi.fn(async (_tx: unknown, p: Record<string, unknown>) => { h.audits.push(p); }),
}));
vi.mock("../lib/prisma", () => ({
  prisma: {
    mission: { findMany: vi.fn(async () => []) },
    observation: { findFirst: vi.fn(async () => h.observation) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      observation: {
        updateMany: vi.fn(async (args: Record<string, unknown>) => { h.majAppels.push(args); return { count: h.majCount }; }),
        findUnique: vi.fn(async () => ({ id: "o1", tronconId: "t1", version: 4 })),
      },
    })),
  },
}));

import { observationsV2Router } from "./observations.routes";

const app = express();
app.use(express.json());
app.use("/api/v2/observations", observationsV2Router);

beforeEach(() => {
  h.compte = { id: "chef-1", role: "GESTIONNAIRE" };
  h.observation = { id: "o1", lat: 9.64, lon: -13.6, precisionM: 7, statut: "PROPOSEE", version: 3, tronconId: null };
  h.suggestion = { tronconId: "t1", code: "GN N0001", nom: "RN1", classe: "RN", distanceM: 12, abscisseM: 340, pk: 4.2, pkMotif: "CALCULE", confiance: 0.88, ambigu: false };
  h.majCount = 1; h.majAppels = []; h.audits = [];
  h.apparier.mockReset();
  h.apparier.mockImplementation(async () => h.suggestion);
});

const suggerer = () => request(app).post("/api/v2/observations/o1/appariement/suggestion").send({});
const confirmer = (tronconId = "t1") => request(app).post("/api/v2/observations/o1/appariement/confirmation").send({ tronconId });

describe("suggestion", () => {
  it("propose le tronçon sans rien écrire, avec distance, confiance et ambiguïté", async () => {
    const r = await suggerer();
    expect(r.status).toBe(200);
    expect(r.body.suggestion).toMatchObject({ tronconId: "t1", distanceM: 12, confiance: 0.88, ambigu: false });
    expect(h.majAppels).toHaveLength(0);
    expect(h.apparier).toHaveBeenCalledWith({ lat: 9.64, lon: -13.6, precisionM: 7 }, expect.objectContaining({ emprise: expect.stringContaining("POLYGON") }));
  });

  it("aucun candidat sûr : suggestion nulle avec son motif, jamais un tronçon forcé", async () => {
    h.suggestion = null;
    const r = await suggerer();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ suggestion: null, motif: "AUCUN_CANDIDAT_SUR" });
  });

  it("sans position GPS : 422 ; observation inconnue : 404 ; un agent simple : 403", async () => {
    h.observation = { ...h.observation, lat: null, lon: null };
    expect((await suggerer()).status).toBe(422);
    h.observation = null;
    expect((await suggerer()).status).toBe(404);
    h.compte = { id: "agent-1", role: "INSPECTEUR" };
    expect((await suggerer()).status).toBe(403);
  });
});

describe("confirmation", () => {
  it("rattache l'observation, incrémente la version et audite l'avant et l'après", async () => {
    const r = await confirmer();
    expect(r.status).toBe(200);
    expect(r.body.observation).toMatchObject({ tronconId: "t1", version: 4 });
    expect(h.majAppels[0]).toMatchObject({
      where: { id: "o1", deletedAt: null, statut: "PROPOSEE", version: 3 },
      data: { tronconId: "t1", pk: 4.2, confianceAppariement: 0.88, version: { increment: 1 } },
    });
    expect(h.audits[0]).toMatchObject({ userId: "chef-1", action: "UPDATE", entityType: "Observation", entityId: "o1", before: { tronconId: null, version: 3 } });
  });

  it("un autre tronçon que le candidat calculé : 409, rien n'est écrit", async () => {
    const r = await confirmer("t-autre");
    expect(r.status).toBe(409);
    expect(h.majAppels).toHaveLength(0);
  });

  it("plus aucun candidat au moment de confirmer : 409", async () => {
    h.suggestion = null;
    expect((await confirmer()).status).toBe(409);
    expect(h.majAppels).toHaveLength(0);
  });

  it("une observation déjà tranchée n'est pas déplacée : 409", async () => {
    h.observation = { ...h.observation, statut: "VALIDEE" };
    expect((await confirmer()).status).toBe(409);
    expect(h.majAppels).toHaveLength(0);
  });

  it("l'observation a changé entre-temps (version) : 409, sans audit", async () => {
    h.majCount = 0;
    expect((await confirmer()).status).toBe(409);
    expect(h.audits).toHaveLength(0);
  });

  it("corps invalide : 400 ; agent simple : 403", async () => {
    expect((await request(app).post("/api/v2/observations/o1/appariement/confirmation").send({ tronconId: "t1", pk: 9 })).status).toBeGreaterThanOrEqual(400);
    h.compte = { id: "agent-1", role: "INSPECTEUR" };
    expect((await confirmer()).status).toBe(403);
  });
});

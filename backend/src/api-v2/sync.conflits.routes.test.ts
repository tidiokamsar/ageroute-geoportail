import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Liste des conflits ouverts et demande de verification (scenario A8, partie interface).
 *
 * CE QUE CES TESTS DEFENDENT
 *
 * LES DEUX VERSIONS SONT RENDUES, TELLES QUELLES. Un responsable qui tranche doit voir ce que le
 * telephone a envoye ET ce que le serveur portait. Une liste qui ne montrerait que l'une des deux, ou une
 * fusion, lui ferait trancher a l'aveugle.
 *
 * LA LISTE EST UNE LECTURE. Elle ne modifie rien, et elle est reservee aux responsables, dans leur perimetre.
 *
 * UNE DEMANDE DE VERIFICATION NE TRANCHE PAS. Elle ne pose pas `resolution`, elle est auditee, et elle ne
 * passe qu'une fois. Le comportement contre une vraie base (concurrence, cloisonnement territorial reel)
 * est eprouve a part, par `tests-integration/conflits-sync.integration.mts`.
 */

const h = vi.hoisted(() => ({
  user: { id: "chef-1", role: "GESTIONNAIRE" },
  conflits: [] as Record<string, unknown>[],
  operations: [] as Record<string, unknown>[],
  verifications: [] as Record<string, unknown>[],
  horsPerimetre: new Set<string>(),
  conflitUnique: null as Record<string, unknown> | null,
  operationUnique: { operation: "UPDATE" } as Record<string, unknown> | null,
  revendications: 1,
  executes: [] as unknown[],
  audits: [] as Record<string, unknown>[],
  lectures: 0,
}));

vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { ...h.user };
    n();
  },
}));
vi.mock("../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_q: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));
vi.mock("../territoire/territoire.service", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  perimetreDe: async () => ({ national: false, regions: new Set([1]) }),
}));
vi.mock("../territoire/territoire.v2", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  verdictOperationSync: async (_p: unknown, op: { entityId: string }) =>
    h.horsPerimetre.has(op.entityId)
      ? { ok: false, code: "HORS_PERIMETRE", motif: "hors perimetre" }
      : { ok: true },
}));
vi.mock("../utils/audit", () => ({
  logAudit: vi.fn(),
  logAuditTransactionnelle: vi.fn(async (_tx: unknown, p: Record<string, unknown>) => { h.audits.push(p); }),
}));
vi.mock("../lib/prisma", () => ({
  prisma: {
    conflitSync: {
      findMany: vi.fn(async () => { h.lectures += 1; return h.conflits; }),
      findUnique: vi.fn(async () => h.conflitUnique),
    },
    operationSync: {
      findMany: vi.fn(async () => h.operations),
      findUnique: vi.fn(async () => h.operationUnique),
    },
    user: { findMany: vi.fn(async () => [{ id: "agent-1", nomComplet: "Mamadou Diallo" }]) },
    appareil: { findMany: vi.fn(async () => [{ id: "app-1", nom: "tel B", plateforme: "android" }]) },
    $queryRaw: vi.fn(async () => h.verifications),
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) =>
      run({ $executeRaw: vi.fn(async (...a: unknown[]) => { h.executes.push(a); return h.revendications; }) })),
  },
}));

import { syncV2Router } from "./sync.routes";

const app = express();
app.use(express.json());
app.use("/api/v2/sync", syncV2Router);
app.use((err: Error & { name: string }, _q: express.Request, res: express.Response, _n: express.NextFunction) => {
  res.status(err.name === "ZodError" ? 400 : 500).json({ message: err.message });
});

const UUID = "11111111-1111-4111-8111-111111111111";
const date = new Date("2026-10-22T10:00:00.000Z");

function conflit(over: Record<string, unknown> = {}) {
  return {
    id: UUID, operationId: "op-1", entityType: "Observation", entityId: "obs-1", resolution: null, createdAt: date,
    payloadLocal: { description: "version du telephone" },
    payloadServeur: { id: "obs-1", description: "version du serveur", version: 2 },
    ...over,
  };
}
const operation = (over: Record<string, unknown> = {}) => ({
  operationId: "op-1", operation: "UPDATE", userId: "agent-1", appareilId: "app-1", derniereErreur: "VERSION_PERIMEE", tentatives: 0, ...over,
});

beforeEach(() => {
  h.user = { id: "chef-1", role: "GESTIONNAIRE" };
  h.conflits = [conflit()];
  h.operations = [operation()];
  h.verifications = [{ id: UUID, verificationDemandeeA: null, verificationDemandeeParId: null, verificationMotif: null }];
  h.horsPerimetre = new Set();
  h.conflitUnique = conflit();
  h.operationUnique = { operation: "UPDATE" };
  h.revendications = 1;
  h.executes = [];
  h.audits = [];
  h.lectures = 0;
});

describe("GET /sync/conflits", () => {
  it("rend les DEUX versions telles quelles, avec l'agent, l'appareil et ce que l'arbitrage permet", async () => {
    const r = await request(app).get("/api/v2/sync/conflits");
    expect(r.status).toBe(200);
    const [c] = r.body.conflits;
    expect(c.payloadLocal).toEqual({ description: "version du telephone" });
    expect(c.payloadServeur).toEqual({ id: "obs-1", description: "version du serveur", version: 2 });
    expect(c).toMatchObject({
      operation: "UPDATE", motif: "VERSION_PERIMEE",
      agent: { id: "agent-1", nomComplet: "Mamadou Diallo" }, appareil: { nom: "tel B" },
      resolutionsPossibles: { SERVEUR: true, LOCAL: true, motifLocalImpossible: null },
      verificationDemandee: null,
    });
    expect(r.body).toMatchObject({ total: 1, tronque: false });
  });

  it("annonce que LOCAL est impossible pour une creation, avec la raison", async () => {
    h.operations = [operation({ operation: "CREATE", derniereErreur: "DEJA_EXISTANTE" })];
    const r = await request(app).get("/api/v2/sync/conflits");
    expect(r.body.conflits[0].resolutionsPossibles.LOCAL).toBe(false);
    expect(r.body.conflits[0].resolutionsPossibles.motifLocalImpossible).toMatch(/nouvel identifiant/);
  });

  it("montre une demande de verification deja posee", async () => {
    h.verifications = [{ id: UUID, verificationDemandeeA: date, verificationDemandeeParId: "chef-9", verificationMotif: "appeler l'agent" }];
    const r = await request(app).get("/api/v2/sync/conflits");
    expect(r.body.conflits[0].verificationDemandee).toEqual({ le: date.toISOString(), parId: "chef-9", motif: "appeler l'agent" });
  });

  it("est REFUSEE a un agent (403) et ne lit alors RIEN", async () => {
    h.user = { id: "agent-1", role: "INSPECTEUR" };
    const r = await request(app).get("/api/v2/sync/conflits");
    expect(r.status).toBe(403);
    expect(h.lectures).toBe(0);
  });

  it("ne rend pas un conflit hors du perimetre de l'arbitre", async () => {
    h.conflits = [conflit({ id: UUID, entityId: "obs-1" }), conflit({ id: "22222222-2222-4222-8222-222222222222", entityId: "obs-2", operationId: "op-2" })];
    h.operations = [operation(), operation({ operationId: "op-2" })];
    h.horsPerimetre = new Set(["obs-2"]);
    const r = await request(app).get("/api/v2/sync/conflits");
    expect(r.body.conflits.map((c: { entityId: string }) => c.entityId)).toEqual(["obs-1"]);
    expect(r.body.total).toBe(1);
  });

  it("refuse une limite invalide (400) au lieu de l'ignorer", async () => {
    expect((await request(app).get("/api/v2/sync/conflits?limite=0")).status).toBe(400);
    expect((await request(app).get("/api/v2/sync/conflits?limite=201")).status).toBe(400);
  });

  it("dit quand la liste est tronquee par la limite", async () => {
    h.conflits = [conflit(), conflit({ id: "22222222-2222-4222-8222-222222222222", operationId: "op-2" })];
    h.operations = [operation(), operation({ operationId: "op-2" })];
    const r = await request(app).get("/api/v2/sync/conflits?limite=1");
    expect(r.body.conflits).toHaveLength(1);
    expect(r.body).toMatchObject({ total: 2, tronque: true });
  });
});

describe("POST /sync/conflits/:id/verification", () => {
  const demander = (corps: unknown = { motif: "appeler l'agent pour trancher" }, id = UUID) =>
    request(app).post(`/api/v2/sync/conflits/${id}/verification`).send(corps as object);

  it("consigne la demande, l'audite, et NE TRANCHE PAS (resolution nulle)", async () => {
    const r = await demander();
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ conflitId: UUID, verificationDemandee: true, resolution: null });
    expect(h.executes).toHaveLength(1);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({ userId: "chef-1", action: "UPDATE", entityType: "ConflitSync", entityId: UUID });
    expect((h.audits[0].after as Record<string, unknown>).verificationDemandee).toBe(true);
  });

  it("exige un motif, et refuse une cle inconnue", async () => {
    expect((await demander({})).status).toBe(400);
    expect((await demander({ motif: "ok" })).status).toBe(400);
    expect((await demander({ motif: "appeler l'agent", resolution: "SERVEUR" })).status).toBe(400);
    expect(h.audits).toHaveLength(0);
  });

  it("est refusee a un agent (403), sans rien ecrire", async () => {
    h.user = { id: "agent-1", role: "INSPECTEUR" };
    expect((await demander()).status).toBe(403);
    expect(h.executes).toHaveLength(0);
  });

  it("404 sur un conflit inconnu, 409 sur un conflit deja tranche", async () => {
    h.conflitUnique = null;
    expect((await demander()).status).toBe(404);
    h.conflitUnique = conflit({ resolution: "SERVEUR" });
    expect((await demander()).status).toBe(409);
    expect(h.audits).toHaveLength(0);
  });

  it("403 hors du perimetre territorial", async () => {
    h.horsPerimetre = new Set(["obs-1"]);
    const r = await demander();
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("HORS_PERIMETRE");
    expect(h.executes).toHaveLength(0);
  });

  it("409 quand la revendication echoue (deja demandee, ou tranchee entre-temps) et SANS ligne d'audit", async () => {
    h.revendications = 0;
    expect((await demander()).status).toBe(409);
    expect(h.audits).toHaveLength(0);
  });
});

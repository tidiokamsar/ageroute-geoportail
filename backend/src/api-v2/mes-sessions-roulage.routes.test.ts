import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Relecture des sessions de roulage : ce que ces tests défendent.
 *   - un agent ne lit que SES sessions, en liste comme par identifiant ;
 *   - `tous=true` est réservé à l'administrateur ; `tous=false` n'est pas un « vrai » ;
 *   - une session supprimée logiquement n'est jamais rendue ;
 *   - les points bruts ne sortent pas ; la mission est résolue en code et intitulé.
 */
const h = vi.hoisted(() => ({
  user: { id: "agent-1", role: "INSPECTEUR" },
  requetes: [] as Record<string, unknown>[],
  session: null as Record<string, unknown> | null,
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
vi.mock("../lib/prisma", () => ({
  prisma: {
    sessionRoulage: {
      findMany: vi.fn(async (args: Record<string, unknown>) => { h.requetes.push(args); return [{ id: "s-1", userId: "agent-1", missionId: "m-1", nbPoints: 300 }]; }),
      findFirst: vi.fn(async (args: Record<string, unknown>) => { h.requetes.push(args); return h.session; }),
    },
    mission: { findMany: vi.fn(async () => [{ id: "m-1", code: "MIS-1", intitule: "RN1" }]) },
  },
}));

import { mesSessionsRoulageV2Router } from "./mes-sessions-roulage.routes";

const app = () => {
  const a = express();
  a.use(express.json());
  a.use("/api/v2/roulage/mes-sessions", mesSessionsRoulageV2Router);
  a.use((err: { name?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(err.name === "ZodError" ? 400 : 500).json({}));
  return a;
};

beforeEach(() => { h.user = { id: "agent-1", role: "INSPECTEUR" }; h.requetes.length = 0; h.session = null; });

describe("Liste des sessions", () => {
  it("rend les sessions de l'agent, sans supprimées, mission résolue", async () => {
    const r = await request(app()).get("/api/v2/roulage/mes-sessions");
    expect(r.status).toBe(200);
    expect(h.requetes[0].where).toEqual({ deletedAt: null, userId: "agent-1" });
    expect(r.body.sessions[0].mission).toEqual({ id: "m-1", code: "MIS-1", intitule: "RN1" });
    expect(h.requetes[0].select).not.toHaveProperty("points");
  });
  it("refuse tous=true à un non-administrateur", async () => {
    h.user = { id: "chef", role: "GESTIONNAIRE" };
    const r = await request(app()).get("/api/v2/roulage/mes-sessions?tous=true");
    expect(r.status).toBe(403);
    expect(h.requetes).toHaveLength(0);
  });
  it("l'administrateur obtient tout s'il le demande ; tous=false reste ses sessions", async () => {
    h.user = { id: "admin", role: "ADMIN" };
    await request(app()).get("/api/v2/roulage/mes-sessions?tous=true");
    expect(h.requetes[0].where).toEqual({ deletedAt: null });
    await request(app()).get("/api/v2/roulage/mes-sessions?tous=false");
    expect(h.requetes[1].where).toEqual({ deletedAt: null, userId: "admin" });
  });
  it("refuse une valeur de drapeau qui n'est ni true ni false", async () => {
    const r = await request(app()).get("/api/v2/roulage/mes-sessions?tous=oui");
    expect(r.status).toBe(400);
  });
});

describe("Détail d'une session", () => {
  it("l'accès direct d'un agent reste borné à ses sessions, sans points bruts", async () => {
    h.session = { id: "s-1", userId: "agent-1", missionId: null, analyse: {} };
    const r = await request(app()).get("/api/v2/roulage/mes-sessions/s-1");
    expect(r.status).toBe(200);
    expect(h.requetes[0].where).toEqual({ id: "s-1", deletedAt: null, userId: "agent-1" });
    expect(h.requetes[0].select).not.toHaveProperty("points");
    expect(r.body.mission).toBeNull();
  });
  it("404 quand la session n'est pas à lui (ou n'existe pas)", async () => {
    const r = await request(app()).get("/api/v2/roulage/mes-sessions/s-autre");
    expect(r.status).toBe(404);
  });
});

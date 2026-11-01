import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `GET /api/v2/troncons-recherche/chemin` : la route entre deux endroits. Ce que ces tests defendent :
 *   - la route est derriere l'authentification (un appel sans jeton ne calcule rien) ;
 *   - les parametres sont valides (degres, tolerance bornee, aucun parametre inconnu) ;
 *   - un refus du calcul (aucun chemin, ville hors referentiel) est un 4xx lisible avec son code, jamais un 500 ni un trajet invente.
 * Le calcul lui-meme est eprouve par le noyau (`geo/graphe.chemin.test.ts`) et par le banc PostGIS `chemin`.
 */
const h = vi.hoisted(() => ({
  appels: [] as unknown[][],
  comportement: "ok" as "ok" | "aucun_chemin" | "accrochage" | "emprise" | "panne",
}));

vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, res: express.Response, n: express.NextFunction) => {
    if (!req.headers.authorization?.startsWith("Bearer ")) { res.status(401).json({ error: "Authentification requise" }); return; }
    (req as unknown as { user: unknown }).user = { id: "u1", role: "LECTEUR" };
    n();
  },
}));
vi.mock("../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_q: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));
vi.mock("../lib/prisma", () => ({ prisma: { $queryRaw: vi.fn(async () => []) } }));
vi.mock("../geo/graphe.depot", () => ({
  EmpriseTropLarge: class EmpriseTropLarge extends Error { constructor(public readonly nombre: number) { super(`trop large : ${nombre}`); } },
}));
vi.mock("../geo/chemin.service", () => {
  class RefusChemin extends Error {
    constructor(public readonly code: string, message: string, public readonly http: 404 | 422 = 422) { super(message); }
  }
  return {
    RefusChemin,
    cheminEntrePoints: vi.fn(async (...a: unknown[]) => {
      h.appels.push(a);
      if (h.comportement === "aucun_chemin") throw new RefusChemin("AUCUN_CHEMIN", "Le referentiel est interrompu entre les deux endroits.");
      if (h.comportement === "accrochage") throw new RefusChemin("ACCROCHAGE_IMPOSSIBLE", "Aucun troncon pres de l'endroit de depart.", 404);
      if (h.comportement === "panne") throw new Error("connexion perdue");
      return { longueurM: 1000, troncons: [{ ordre: 1, id: "t1", code: "GN N0001" }], avertissements: [] };
    }),
  };
});

import { rechercheV2Router } from "./troncons-recherche.routes";

const app = express();
app.use(express.json(), rechercheV2Router);
// Un gestionnaire d'erreurs minimal, comme celui de l'application : une panne devient 500, sans detail.
app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Erreur interne" }); });

const JETON = { Authorization: "Bearer essai" };
const Q = { deLat: 11.1, deLon: -13.767, versLat: 10.9, versLon: -12.79 };

beforeEach(() => { h.appels = []; h.comportement = "ok"; });

describe("GET /chemin", () => {
  it("sans jeton : 401, aucun calcul", async () => {
    const r = await request(app).get("/chemin").query(Q);
    expect(r.status).toBe(401);
    expect(h.appels).toHaveLength(0);
  });

  it("rend la liste ordonnee des troncons, et transmet les deux positions et la tolerance", async () => {
    const r = await request(app).get("/chemin").set(JETON).query({ ...Q, tolerance: 20 });
    expect(r.status).toBe(200);
    expect(r.body.troncons[0]).toMatchObject({ ordre: 1, code: "GN N0001" });
    expect(h.appels[0].slice(1)).toEqual([{ lat: 11.1, lon: -13.767 }, { lat: 10.9, lon: -12.79 }, { toleranceFusionM: 20 }]);
  });

  it("refuse des parametres manquants, hors bornes ou inconnus : 400, aucun calcul", async () => {
    expect((await request(app).get("/chemin").set(JETON).query({ deLat: 11.1 })).status).toBe(400);
    expect((await request(app).get("/chemin").set(JETON).query({ ...Q, deLat: 95 })).status).toBe(400);
    expect((await request(app).get("/chemin").set(JETON).query({ ...Q, tolerance: 500 })).status).toBe(400);
    expect((await request(app).get("/chemin").set(JETON).query({ ...Q, extra: "x" })).status).toBe(400);
    expect(h.appels).toHaveLength(0);
  });

  it("aucun chemin continu : 422 avec son code, jamais un trajet invente", async () => {
    h.comportement = "aucun_chemin";
    const r = await request(app).get("/chemin").set(JETON).query(Q);
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: "AUCUN_CHEMIN" });
    expect(r.body.troncons).toBeUndefined();
  });

  it("une ville hors referentiel : 404 ACCROCHAGE_IMPOSSIBLE", async () => {
    h.comportement = "accrochage";
    const r = await request(app).get("/chemin").set(JETON).query(Q);
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("ACCROCHAGE_IMPOSSIBLE");
  });

  it("une panne reste une panne : 500 sans detail", async () => {
    h.comportement = "panne";
    const r = await request(app).get("/chemin").set(JETON).query(Q);
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain("connexion perdue");
  });
});

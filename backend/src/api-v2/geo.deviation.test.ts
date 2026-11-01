import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `POST /api/v2/geo/deviation` -- ce que ces tests defendent.
 *   - la tolerance de fusion et la borne de recherche sont EXIGEES, aucune n'est supposee ;
 *   - les refus du calcul sont rendus avec leur code (404, 400, 422), jamais un trajet approximatif.
 * Le calcul lui-meme est eprouve par `graphe.noyau.test.ts` et contre la base (suivi, T-22).
 */

vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: "u", role: "LECTEUR", modulesAutorises: [] }; n();
  },
}));
vi.mock("../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_q: express.Request, _r: express.Response, n: express.NextFunction) => n(),
}));
const h = vi.hoisted(() => ({ appels: [] as unknown[], reponse: null as unknown, erreur: null as unknown }));
vi.mock("../geo/deviation.service", async () => {
  class RefusDeviationHttp extends Error { constructor(public code: string, m: string, public http: number) { super(m); } }
  return {
    RefusDeviationHttp,
    calculerDeviation: async (_d: unknown, args: unknown) => { h.appels.push(args); if (h.erreur) throw h.erreur; return h.reponse; },
  };
});
vi.mock("../lib/prisma", () => ({ prisma: {} }));

import { geoV2Router } from "./geo.routes";
import { RefusDeviationHttp } from "../geo/deviation.service";

const app = express();
app.use(express.json());
app.use("/api/v2/geo", geoV2Router);
const corps = { tronconId: "t-1", debutM: 800, finM: 1200, distanceMaxM: 10_000, toleranceFusionM: 1 };

beforeEach(() => { h.appels.length = 0; h.reponse = { longueurM: 2900, allongementM: 2500, troncons: [] }; h.erreur = null; });

describe("POST /api/v2/geo/deviation", () => {
  it("transmet la coupure et les deux parametres exiges", async () => {
    const r = await request(app).post("/api/v2/geo/deviation").send(corps);
    expect(r.status).toBe(200);
    expect(h.appels[0]).toEqual(corps);
  });
  it.each([
    ["sans tolerance de fusion", { ...corps, toleranceFusionM: undefined }],
    ["sans borne de recherche", { ...corps, distanceMaxM: undefined }],
    ["tolerance demesuree", { ...corps, toleranceFusionM: 500 }],
    ["borne demesuree", { ...corps, distanceMaxM: 1_000_000 }],
  ])("refuse %s (400), sans calculer", async (_n, c) => {
    expect((await request(app).post("/api/v2/geo/deviation").send(c)).status).toBe(400);
    expect(h.appels).toHaveLength(0);
  });
  it("rend les refus du calcul avec leur code", async () => {
    h.erreur = new RefusDeviationHttp("AUCUNE_DEVIATION", "Aucun chemin", 422);
    const r = await request(app).post("/api/v2/geo/deviation").send(corps);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("AUCUNE_DEVIATION");
  });
});

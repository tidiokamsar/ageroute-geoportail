import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `/api/v2/troncons-recherche` — ce que ces tests défendent.
 *
 * TROUVABLE SANS LE NOM EXACT : un fragment de code, un fragment de nom, une région,
 * ou une position GPS. La position ORDONNE, elle ne rattache pas : le rattachement
 * fiable reste l'appariement avec score.
 *
 * RIEN N'EST INTERPOLÉ : les fragments passent en paramètres liés ($1…) ; le SQL ne
 * reçoit aucune chaîne construite par l'appelant. Un critère vide est REFUSÉ (pas de
 * « top 15 du réseau » gratuit).
 */
const h = vi.hoisted(() => ({
  compte: { id: "u1", role: "GESTIONNAIRE" },
  lignes: [
    { id: "t-1", code: "GN N0001", nom: "Conakry - Coyah", region: "Conakry", longueurKm: 42, distanceM: 3100 },
  ],
  sqlRecus: [] as string[],
}));

vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { ...h.compte };
    n();
  },
}));
vi.mock("../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_q: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));
vi.mock("../lib/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(async (fragments: TemplateStringsArray, ...valeurs: unknown[]) => {
      h.sqlRecus.push(String(fragments.join("?")));
      void valeurs;
      return h.lignes;
    }),
  },
}));

import { rechercheV2Router } from "./troncons-recherche.routes";

const app = express();
app.use(express.json(), rechercheV2Router);

beforeEach(() => { h.sqlRecus = []; });

describe("GET /api/v2/troncons-recherche", () => {
  it("cherche par fragment de code OU de nom, rend code, nom, région et distance", async () => {
    const r = await request(app).get("/").query({ q: "kindia" });
    expect(r.status).toBe(200);
    expect(r.body.data[0]).toMatchObject({ code: "GN N0001", nom: "Conakry - Coyah", distanceM: 3100 });
  });

  it("exige au moins un critère : ni q, ni region, ni GPS = refus", async () => {
    const r = await request(app).get("/");
    expect(r.status).toBe(400);
  });

  it("refuse lat sans lon (position incomplète)", async () => {
    const r = await request(app).get("/").query({ lat: 9.5 });
    expect(r.status).toBe(400);
  });

  it("borne la limite à 50", async () => {
    expect((await request(app).get("/").query({ q: "rn", limite: 51 })).status).toBe(400);
  });

  it("le fragment voyage en paramètre lié, jamais concaténé dans le SQL", async () => {
    await request(app).get("/").query({ q: "kindia'; DROP TABLE troncons; --" });
    expect(h.sqlRecus[0]).not.toContain("kindia");
  });
});

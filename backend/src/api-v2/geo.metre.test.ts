import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `POST /api/v2/geo/metre` -- ce que ces tests defendent.
 *   - seules les lignes et les surfaces sont mesurees ;
 *   - la geometrie part en parametre lie, jamais concatenee ;
 *   - une geometrie invalide est refusee avec sa raison, jamais reparee en silence ;
 *   - une geometrie illisible rend 400, pas 500.
 * Les valeurs elles-memes (fuseau, 10 000 m2, ecart < 1 %) sont eprouvees en base par
 * `metre_utm.test.sql`.
 */

vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: "u", role: "LECTEUR", modulesAutorises: [] }; n();
  },
}));
vi.mock("../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_q: express.Request, _r: express.Response, n: express.NextFunction) => n(),
}));
const h = vi.hoisted(() => ({ requetes: [] as unknown[][], valide: true, illisible: false }));
vi.mock("../lib/prisma", () => ({
  prisma: {
    $queryRaw: async (...a: unknown[]) => {
      h.requetes.push(a);
      const sql = (a[0] as string[]).join("?");
      if (sql.includes("ST_IsValid")) {
        if (h.illisible) throw new Error("invalid GeoJSON representation");
        return [{ valide: h.valide, raison: h.valide ? "Valid Geometry" : "Self-intersection[-13.6 9.6]" }];
      }
      return [{ epsg: 32628, longueurM: 400, surfaceM2: 10000, longueurGeodesiqueM: 399.85, surfaceGeodesiqueM2: 9992.5, ecartLongueur: 0.0004, ecartSurface: 0.00075 }];
    },
  },
}));

import { geoV2Router } from "./geo.routes";

const app = express();
app.use(express.json());
app.use("/api/v2/geo", geoV2Router);
app.use((err: Error, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: err.message }); });

const carre = { type: "Polygon", coordinates: [[[-13.6, 9.6], [-13.599, 9.6], [-13.599, 9.601], [-13.6, 9.601], [-13.6, 9.6]]] };

beforeEach(() => { h.requetes.length = 0; h.valide = true; h.illisible = false; });

describe("POST /api/v2/geo/metre", () => {
  it("mesure une surface dans son fuseau, geometrie en parametre lie", async () => {
    const r = await request(app).post("/api/v2/geo/metre").send({ geometrie: carre });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ epsg: 32628, surfaceM2: 10000, ecartSurface: 0.00075 });
    const [gabarit, ...valeurs] = h.requetes[1] as [string[], ...unknown[]];
    expect(gabarit.join("?")).toContain("metre_utm(");
    expect(valeurs).toEqual([JSON.stringify(carre)]);
  });
  it("refuse un point : un point n'a ni longueur ni surface", async () => {
    const r = await request(app).post("/api/v2/geo/metre").send({ geometrie: { type: "Point", coordinates: [-13.6, 9.6] } });
    expect(r.status).toBe(400);
    expect(h.requetes).toHaveLength(0);
  });
  it("refuse une geometrie invalide avec sa raison, sans la reparer", async () => {
    h.valide = false;
    const r = await request(app).post("/api/v2/geo/metre").send({ geometrie: carre });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("Self-intersection");
    expect(h.requetes).toHaveLength(1);
  });
  it("une geometrie illisible rend 400, pas 500", async () => {
    h.illisible = true;
    const r = await request(app).post("/api/v2/geo/metre").send({ geometrie: { type: "Polygon", coordinates: [[1]] } });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("illisible");
  });
});

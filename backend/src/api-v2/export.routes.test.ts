import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `/api/v2/export/selection` — ce que ces tests défendent.
 *
 * LA LISTE BLANCHE EST LE MUR. Le nom de table vient du client : aucune table hors
 * liste ne passe, même bien orthographiée — pas de contournement d'API par l'export.
 *
 * CE QUI EST COCHÉ EST CE QUI PART. L'export reçoit des identifiants, pas des
 * filtres : la sélection affichée est la sélection exportée.
 *
 * LE CSV S'OUVRE PROPREMENT en Excel francophone (point-virgule + BOM) ; le GeoJSON
 * porte la géométrie et TOUTES les autres colonnes en propriétés.
 */
const h = vi.hoisted(() => ({
  compte: { id: "u1", role: "GESTIONNAIRE" },
  lignesOuvrages: [
    { fid: "o1", props: JSON.stringify({ id: "o1", nom: "Pont de Kindia", etat: "MOYEN" }), geojson: JSON.stringify({ type: "Point", coordinates: [-13.6, 9.64] }) },
    { fid: "o2", props: JSON.stringify({ id: "o2", nom: "Dalot RN2", etat: "BON" }), geojson: null },
  ],
  requetes: [] as Array<{ sql: string; ids: string[] }>,
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
    $queryRawUnsafe: vi.fn(async (sql: string, ids: string[]) => {
      h.requetes.push({ sql, ids });
      if (sql.includes("ST_AsGeoJSON")) return h.lignesOuvrages;
      return [{ ligne: JSON.stringify({ id: "o1", nom: "Pont de Kindia", etat: "MOYEN" }) }, { ligne: JSON.stringify({ id: "o2", nom: "Dalot RN2", etat: "BON" }) }];
    }),
  },
}));

import { exportV2Router } from "./export.routes";

const app = express();
app.use(express.json(), exportV2Router);

beforeEach(() => { h.requetes = []; });

describe("POST /api/v2/export/selection", () => {
  it("exporte la sélection en CSV point-virgule BOM, avec exactement les ids demandés", async () => {
    const r = await request(app).post("/selection").send({ table: "ouvrages", format: "csv", ids: ["o1", "o2"] });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("text/csv");
    expect(r.text.startsWith("\uFEFF")).toBe(true);
    expect(r.text).toContain("Pont de Kindia");
    expect(h.requetes[0].ids).toEqual(["o1", "o2"]);
  });

  it("exporte en GeoJSON : géométrie WGS84, propriétés sans la colonne geom", async () => {
    const r = await request(app).post("/selection").send({ table: "ouvrages", format: "geojson", ids: ["o1", "o2"] });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("application/geo+json");
    expect(r.body.type).toBe("FeatureCollection");
    expect(r.body.features[0].geometry.coordinates).toEqual([-13.6, 9.64]);
    expect(r.body.features[0].properties.nom).toBe("Pont de Kindia");
    expect(r.body.features[1].geometry).toBeNull();
  });

  it("refuse une table hors liste blanche, même plausible", async () => {
    const r = await request(app).post("/selection").send({ table: "users", format: "csv", ids: ["u1"] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("TABLE_REFUSEE");
  });

  it("refuse le GeoJSON sur une table sans géométrie", async () => {
    const r = await request(app).post("/selection").send({ table: "marches", format: "geojson", ids: ["m1"] });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("SANS_GEOMETRIE");
  });

  it("refuse plus de 2000 identifiants et un corps inconnu", async () => {
    expect((await request(app).post("/selection").send({ table: "ouvrages", format: "csv", ids: Array(2001).fill("x") })).status).toBe(400);
    expect((await request(app).post("/selection").send({ table: "ouvrages", format: "pdf", ids: ["o1"] })).status).toBe(400);
    expect((await request(app).post("/selection").send({ table: "ouvrages", format: "csv", ids: [] })).status).toBe(400);
  });
});

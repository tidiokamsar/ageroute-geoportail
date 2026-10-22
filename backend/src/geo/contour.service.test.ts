import { beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { vi } from "vitest";

/**
 * Contour du pays : ce que ces tests defendent.
 *   - sans limite en base, la reponse est ABSENTE (null, puis 404) : aucun trace de repli invente ;
 *   - la source, la date et l'avertissement « pas une frontiere officielle » sont toujours restitues ;
 *   - la memoire ne garde qu'un resultat PLEIN (une base vide ne cache pas le contour une heure) ;
 *   - la requete prend la frontiere EXTERIEURE de l'union des regions (ST_Boundary de ST_Union), niveau 1.
 * Le trace reel est eprouve contre PostGIS par `tests-integration/contour.integration.ts`.
 */

vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: "u", role: "LECTEUR", modulesAutorises: [] }; n();
  },
}));
vi.mock("../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_q: express.Request, _r: express.Response, n: express.NextFunction) => n(),
}));
const h = vi.hoisted(() => ({ lignes: [] as unknown[], sql: [] as string[], appels: 0 }));
vi.mock("../lib/prisma", () => ({
  prisma: { $queryRaw: async (chaines: TemplateStringsArray) => { h.appels += 1; h.sql.push(chaines.join("?")); return h.lignes; } },
}));

import { contourPays, oublierContour, SIMPLIFICATION_DEG, type DepotContour } from "./contour.service";
import { geoV2Router } from "../api-v2/geo.routes";

const PLEIN = [{
  geojson: JSON.stringify({ type: "MultiLineString", coordinates: [[[-13.7, 9.5], [-13.6, 9.5]]] }),
  n: 8, valide_le: "2016-03-04", source: "OCHA COD-AB",
}];
const depot: DepotContour = { $queryRaw: async <T,>(c: TemplateStringsArray) => { h.appels += 1; h.sql.push(c.join("?")); return h.lignes as unknown as T; } };

beforeEach(() => { oublierContour(); h.lignes = []; h.sql.length = 0; h.appels = 0; });

describe("contourPays", () => {
  it("sans aucune limite en base : null, jamais un trace de repli", async () => {
    h.lignes = [{ geojson: null, n: 0, valide_le: null, source: null }];
    expect(await contourPays(depot)).toBeNull();
    h.lignes = [];
    oublierContour();
    expect(await contourPays(depot)).toBeNull();
  });

  it("restitue le trace avec sa source, sa date, sa simplification et l'avertissement", async () => {
    h.lignes = PLEIN;
    const c = await contourPays(depot);
    expect(c?.geometry).toMatchObject({ type: "MultiLineString" });
    expect(c?.properties).toMatchObject({ source: "OCHA COD-AB", valideLe: "2016-03-04", nombreRegions: 8, simplificationDeg: SIMPLIFICATION_DEG });
    expect(c?.properties.avertissement).toMatch(/pas une frontiere officielle/);
  });

  it("prend la frontiere EXTERIEURE de l'union des regions de niveau 1", async () => {
    h.lignes = PLEIN;
    await contourPays(depot);
    expect(h.sql[0]).toMatch(/ST_Boundary\(ST_Union\(geom\)\)/);
    expect(h.sql[0]).toMatch(/niveau = 1/);
  });

  it("garde un resultat plein en memoire une heure, puis recalcule", async () => {
    h.lignes = PLEIN;
    await contourPays(depot, 1_000);
    await contourPays(depot, 1_000 + 3_599_000);
    expect(h.appels).toBe(1);
    await contourPays(depot, 1_000 + 3_600_001);
    expect(h.appels).toBe(2);
  });

  it("ne garde PAS en memoire un resultat vide : les limites importees apparaissent aussitot", async () => {
    h.lignes = [{ geojson: null, n: 0, valide_le: null, source: null }];
    await contourPays(depot, 1_000);
    h.lignes = PLEIN;
    expect(await contourPays(depot, 2_000)).not.toBeNull();
  });
});

describe("GET /api/v2/geo/contour", () => {
  const app = express();
  app.use("/api/v2/geo", geoV2Router);

  it("200 avec le contour et un cache prive d'une heure", async () => {
    h.lignes = PLEIN;
    const r = await request(app).get("/api/v2/geo/contour");
    expect(r.status).toBe(200);
    expect(r.body.type).toBe("Feature");
    expect(r.headers["cache-control"]).toMatch(/private, max-age=3600/);
  });

  it("404 LIMITES_ABSENTES sans limite en base", async () => {
    h.lignes = [];
    const r = await request(app).get("/api/v2/geo/contour");
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("LIMITES_ABSENTES");
  });
});

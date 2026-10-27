import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { couchesAuZoom, empriseTuile, lireTuile } from "./tuiles.noyau";

/**
 * Tuiles vectorielles : ce que ces tests defendent.
 *   - z/x/y sont des entrees exterieures : entiers stricts, bornes du pavage, zoom borne ;
 *   - la voirie locale n'apparait qu'a partir du zoom 12 ;
 *   - la tuile part avec son type, son cache et son empreinte ; 304 sur empreinte connue ; 204 si vide ;
 *   - la requete passe par l'index geography (`::geography &&`) et le predicat du reseau classe ;
 *   - les parametres de tuile partent lies, jamais concatenes.
 * Le rendu reel de PostGIS est eprouve contre une base (TEST_EVIDENCE, 22/10/2026).
 */

const h = vi.hoisted(() => ({ mvt: Buffer.from([0x1a, 0x02, 0x08, 0x01]) as Buffer | null, appels: [] as unknown[][] }));
vi.mock("../lib/prisma", () => ({
  prisma: { $queryRaw: async (...a: unknown[]) => { h.appels.push(a); return [{ mvt: h.mvt }]; } },
}));

import { tuilesRouter } from "./tuiles.routes";

const app = express();
app.use("/t", tuilesRouter);

beforeEach(() => { h.mvt = Buffer.from([0x1a, 0x02, 0x08, 0x01]); h.appels.length = 0; });

describe("lireTuile", () => {
  it.each([
    [["10", "473", "484"], { z: 10, x: 473, y: 484 }],
    [["5", "0", "31"], { z: 5, x: 0, y: 31 }],
    [["4", "7", "7"], null],
    [["17", "0", "0"], null],
    [["10", "1024", "0"], null],
    [["10", "-1", "0"], null],
    [["10", "1.5", "0"], null],
    [["10", "1e2", "0"], null],
    [["10", "0x1", "0"], null],
  ])("%j -> %j", (a, attendu) => {
    expect(lireTuile(a[0], a[1], a[2])).toEqual(attendu);
  });
});

describe("Couches et emprises", () => {
  it("voirie locale a partir du zoom 12 seulement", () => {
    expect(couchesAuZoom(11).map((c) => c.nom)).toEqual(["reseau_classe"]);
    expect(couchesAuZoom(12).map((c) => c.nom)).toEqual(["reseau_classe", "voirie_locale"]);
  });
  it("la tuile z10 473/484 contient Conakry", () => {
    const e = empriseTuile({ z: 10, x: 473, y: 484 });
    expect(e.ouest).toBeLessThan(-13.68); expect(e.est).toBeGreaterThan(-13.68);
    expect(e.sud).toBeLessThan(9.6); expect(e.nord).toBeGreaterThan(9.6);
  });
});

describe("GET /:z/:x/:y.mvt", () => {
  it("rend la tuile avec son type, son cache et son empreinte ; parametres lies", async () => {
    const r = await request(app).get("/t/10/473/484.mvt");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("application/vnd.mapbox-vector-tile");
    expect(r.headers["cache-control"]).toContain("max-age=300");
    expect(r.headers.etag).toMatch(/^"[\w-]{27}"$/);
    const sql = (h.appels[0][0] as string[]).join("?");
    expect(sql).toContain("::geography && env.eg");
    expect(sql).toContain("ST_AsMVT(");
    // Le predicat du reseau classe arrive en fragment Prisma.raw (lib/reseau), parmi les valeurs.
    expect(JSON.stringify(h.appels[0].slice(1))).toContain("NOT (t.\\\"sourceReference\\\" LIKE 'voirie_locale:%'");
    expect(sql).not.toContain("473");
    expect(h.appels[0].slice(1)).toEqual(expect.arrayContaining([10, 473, 484]));
  });
  it("304 sur empreinte connue, 204 sur tuile vide", async () => {
    const etag = (await request(app).get("/t/10/473/484.mvt")).headers.etag;
    expect((await request(app).get("/t/10/473/484.mvt").set("If-None-Match", etag)).status).toBe(304);
    h.mvt = Buffer.alloc(0);
    expect((await request(app).get("/t/10/473/484.mvt")).status).toBe(204);
  });
  it("refuse une tuile hors pavage sans interroger la base", async () => {
    expect((await request(app).get("/t/10/2000/0.mvt")).status).toBe(400);
    expect((await request(app).get("/t/3/1/1.mvt")).status).toBe(400);
    expect(h.appels).toHaveLength(0);
  });
  it("decrit les couches et le gabarit", async () => {
    const r = await request(app).get("/t");
    expect(r.body).toMatchObject({ gabarit: "/api/public/tuiles/{z}/{x}/{y}.mvt", minzoom: 5, maxzoom: 16 });
    expect(r.body.couches.map((c: { id: string }) => c.id)).toEqual(["reseau_classe", "voirie_locale"]);
  });
});

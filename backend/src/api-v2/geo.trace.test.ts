import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `POST /api/v2/geo/trace` -- ce que ces tests defendent :
 *   - format et contenu sont EXIGES, les bornes de distance et de pas sont verifiees avant tout calcul ;
 *   - un refus de lecture rend 400 et un refus d'analyse 422, chacun avec son code ;
 *   - rien d'autre que l'analyse n'est appele : la route n'ecrit pas.
 * L'analyse elle-meme est eprouvee par `trace.service.test.ts`.
 */

vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: "u", role: "LECTEUR", modulesAutorises: [] }; n();
  },
}));
const h = vi.hoisted(() => ({ module: [] as string[], appels: [] as unknown[], reponse: null as unknown, erreur: null as unknown, refusLecture: null as unknown }));
vi.mock("../middleware/module-access.middleware", () => ({
  requireModuleAccess: (m: string) => (_q: express.Request, _r: express.Response, n: express.NextFunction) => { h.module.push(m); n(); },
}));
vi.mock("../geo/trace.service", async () => {
  class RefusTrace extends Error { constructor(public code: string, m: string, public http: number) { super(m); } }
  return {
    RefusTrace,
    lireTrace: (format: string, contenu: string) => { if (h.refusLecture) throw h.refusLecture; return { points: [{ lat: 1, lon: 1, tMs: null, precisionM: null }], ignores: 0, avertissements: [], format, contenu }; },
    analyserTrace: async (_d: unknown, lecture: unknown, opts: unknown) => { h.appels.push({ lecture, opts }); if (h.erreur) throw h.erreur; return h.reponse; },
  };
});
vi.mock("../lib/prisma", () => ({ prisma: {} }));
vi.mock("../geo/deviation.service", () => ({ RefusDeviationHttp: class extends Error {}, calculerDeviation: async () => ({}) }));

import { geoV2Router } from "./geo.routes";
import { RefusTrace } from "../geo/trace.service";

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use("/api/v2/geo", geoV2Router);
const corps = { format: "gpx", contenu: "<gpx></gpx>" };

beforeEach(() => { h.appels.length = 0; h.reponse = { passages: [], indicateurs: {} }; h.erreur = null; h.refusLecture = null; });

describe("POST /api/v2/geo/trace", () => {
  it("transmet la trace lue et les options a l'analyse", async () => {
    const r = await request(app).post("/api/v2/geo/trace").send({ ...corps, reseau: "tout", distanceMaxM: 40, pasMinM: 25 });
    expect(r.status).toBe(200);
    expect(h.appels[0]).toMatchObject({ opts: { reseau: "tout", distanceMaxM: 40, pasMinM: 25 } });
  });

  it("est protegee par le module inspections", async () => {
    await request(app).post("/api/v2/geo/trace").send(corps);
    expect(h.module).toContain("inspections");
  });

  it.each([
    ["sans format", { contenu: "x" }],
    ["format inconnu", { format: "kml", contenu: "x" }],
    ["sans contenu", { format: "gpx" }],
    ["contenu vide", { format: "gpx", contenu: "" }],
    ["distance demesuree", { ...corps, distanceMaxM: 5000 }],
    ["pas trop petit", { ...corps, pasMinM: 1 }],
    ["reseau inconnu", { ...corps, reseau: "autre" }],
  ])("refuse %s (400), sans analyser", async (_n, c) => {
    expect((await request(app).post("/api/v2/geo/trace").send(c)).status).toBe(400);
    expect(h.appels).toHaveLength(0);
  });

  it("rend un refus de lecture en 400 avec son code", async () => {
    h.refusLecture = new RefusTrace("FORMAT_ILLISIBLE", "pas un GPX", 400);
    const r = await request(app).post("/api/v2/geo/trace").send(corps);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("FORMAT_ILLISIBLE");
    expect(h.appels).toHaveLength(0);
  });

  it("rend un refus d'analyse en 422 avec son code", async () => {
    h.erreur = new RefusTrace("TROP_DE_POINTS", "trop de points", 422);
    const r = await request(app).post("/api/v2/geo/trace").send(corps);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("TROP_DE_POINTS");
  });

  it("accepte un fichier de plusieurs centaines de kilo-octets", async () => {
    const gros = "x".repeat(900_000);
    const r = await request(app).post("/api/v2/geo/trace").send({ format: "csv", contenu: gros });
    expect(r.status).toBe(200);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Le perimetre applique aux routes (A10, « 403 [...] hors zone ») : ce que ces tests defendent.
 *   - un compte restreint a la region 1 cree, modifie, retire dans la region 1, et nulle part ailleurs ;
 *   - la region d'un objet existant se lit en base, pas dans le corps ; un deplacement exige les deux ;
 *   - un defaut sans troncon ni mission (region inconnue) lui est refuse ; avec un troncon de sa region, non ;
 *   - un import en masse lui est refuse ; un objet introuvable laisse la route rendre son 404 ;
 *   - un compte sans perimetre n'est pas touche ;
 *   - la synchronisation hors ligne applique la meme regle.
 */

const h = vi.hoisted(() => ({
  userId: "u-restreint",
  perimetres: {} as Record<string, { regionId: number; debutLe: Date; finLe: Date | null; revoqueLe: Date | null }[]>,
  regions: {
    troncon: { "t-r1": 1, "t-r2": 2 } as Record<string, number>,
    ouvrage: { "o-r1": 1, "o-r2": 2 } as Record<string, number>,
    mission: { "m-r1": 1 } as Record<string, number | null>,
  },
  defauts: { "d-r2": { troncon: { regionId: 2 }, mission: null }, "d-inconnu": { troncon: null, mission: null } } as Record<string, unknown>,
  portions: { "p-r1": { troncon: { regionId: 1 } }, "p-r2": { troncon: { regionId: 2 } } } as Record<string, unknown>,
}));

vi.mock("../lib/prisma", () => {
  const parRegion = (table: Record<string, number | null>) => ({
    findUnique: async ({ where }: { where: { id: string } }) => (where.id in table ? { regionId: table[where.id] } : null),
  });
  return {
    prisma: {
      perimetreTerritorial: { findMany: async ({ where }: { where: { userId: string } }) => h.perimetres[where.userId] ?? [] },
      troncon: parRegion(h.regions.troncon),
      ouvrage: parRegion(h.regions.ouvrage),
      pointNoir: parRegion({}), poste: parRegion({}), chantier: parRegion({}),
      mission: parRegion(h.regions.mission),
      defaut: { findUnique: async ({ where }: { where: { id: string } }) => h.defauts[where.id] ?? null },
      observation: { findUnique: async () => null },
      portion: { findUnique: async ({ where }: { where: { id: string } }) => h.portions[where.id] ?? null },
    },
  };
});

import { aLaCreation, importNational, refusTerritorialSync, requireTerritoire, surLesObjets, surLObjet, surLObjetVersTroncon } from "./perimetre.service";

const app = express();
app.use(express.json());
app.use((req, _res, next) => { (req as unknown as { user: unknown }).user = { id: h.userId, role: "GESTIONNAIRE" }; next(); });
const ok = (_req: express.Request, res: express.Response) => res.status(200).json({ ecrit: true });
app.post("/ouvrages", requireTerritoire("OUVRAGE", aLaCreation("OUVRAGE")), ok);
app.put("/ouvrages/:id", requireTerritoire("OUVRAGE", surLObjet("OUVRAGE")), (req, res) => (req.params.id in h.regions.ouvrage ? ok(req, res) : res.status(404).end()));
app.post("/ouvrages/import", requireTerritoire("OUVRAGE", importNational), ok);
app.post("/defauts", requireTerritoire("DEFAUT", aLaCreation("DEFAUT")), ok);
app.post("/defauts/:id/confirmation", requireTerritoire("DEFAUT", surLObjetVersTroncon("DEFAUT")), ok);
app.post("/portions/fusion", requireTerritoire("PORTION", surLesObjets("PORTION", ["idA", "idB"])), ok);

const restreint = { regionId: 1, debutLe: new Date("2026-01-01"), finLe: null, revoqueLe: null };

beforeEach(() => {
  h.userId = "u-restreint";
  h.perimetres = { "u-restreint": [restreint] };
});

describe("Compte restreint a la region 1", () => {
  it("cree dans sa region, pas ailleurs ; le refus dit le motif et les regions autorisees", async () => {
    expect((await request(app).post("/ouvrages").send({ regionId: 1 })).status).toBe(200);
    const r = await request(app).post("/ouvrages").send({ regionId: 2 });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: "HORS_PERIMETRE", domaine: "OUVRAGE", regionsAutorisees: [1] });
  });
  it("la region d'un objet existant se lit en base : un corps qui affirme la region 1 ne suffit pas", async () => {
    expect((await request(app).put("/ouvrages/o-r1").send({ nom: "x" })).status).toBe(200);
    expect((await request(app).put("/ouvrages/o-r2").send({ regionId: 1 })).status).toBe(403);
  });
  it("deplacer un objet de sa region vers une autre est refuse", async () => {
    expect((await request(app).put("/ouvrages/o-r1").send({ regionId: 2 })).body.code).toBe("HORS_PERIMETRE");
  });
  it("objet introuvable : la route rend son 404", async () => {
    expect((await request(app).put("/ouvrages/o-absent").send({})).status).toBe(404);
  });
  it("un import en masse est refuse", async () => {
    expect((await request(app).post("/ouvrages/import").send({})).body.code).toBe("REGION_INCONNUE");
  });
  it("defaut : region du troncon, sinon de la mission ; sans l'un ni l'autre, refuse", async () => {
    expect((await request(app).post("/defauts").send({ tronconId: "t-r1" })).status).toBe(200);
    expect((await request(app).post("/defauts").send({ missionId: "m-r1", lat: 9.5, lon: -13.7 })).status).toBe(200);
    expect((await request(app).post("/defauts").send({ tronconId: "t-r2" })).status).toBe(403);
    expect((await request(app).post("/defauts").send({ lat: 9.5, lon: -13.7 })).body.code).toBe("REGION_INCONNUE");
  });
  it("rattacher un defaut a un troncon d'une autre region est refuse", async () => {
    h.defauts["d-r1"] = { troncon: { regionId: 1 }, mission: null };
    expect((await request(app).post("/defauts/d-r1/confirmation").send({ tronconId: "t-r1" })).status).toBe(200);
    expect((await request(app).post("/defauts/d-r1/confirmation").send({ tronconId: "t-r2" })).status).toBe(403);
    expect((await request(app).post("/defauts/d-inconnu/confirmation").send({ tronconId: "t-r1" })).body.code).toBe("REGION_INCONNUE");
  });
  it("fusion de deux portions : les deux regions sont exigees", async () => {
    expect((await request(app).post("/portions/fusion").send({ idA: "p-r1", idB: "p-r1" })).status).toBe(200);
    expect((await request(app).post("/portions/fusion").send({ idA: "p-r1", idB: "p-r2" })).status).toBe(403);
  });
});

describe("Compte sans perimetre (regle provisoire, D-11)", () => {
  it("ecrit partout, import et region inconnue compris", async () => {
    h.userId = "u-national";
    expect((await request(app).post("/ouvrages").send({ regionId: 2 })).status).toBe(200);
    expect((await request(app).post("/ouvrages/import").send({})).status).toBe(200);
    expect((await request(app).post("/defauts").send({ lat: 9.5, lon: -13.7 })).status).toBe(200);
  });
  it("un perimetre revoque ne restreint plus", async () => {
    h.perimetres["u-restreint"] = [{ ...restreint, revoqueLe: new Date("2026-02-01") }];
    expect((await request(app).post("/ouvrages").send({ regionId: 2 })).status).toBe(200);
  });
});

describe("Synchronisation hors ligne", () => {
  it("la meme regle : creation hors perimetre ou de region inconnue refusee, dans le perimetre permise", async () => {
    expect(await refusTerritorialSync("u-restreint", { entityType: "Defaut", entityId: "x", operation: "CREATE", payload: { tronconId: "t-r2" } })).toBe("HORS_PERIMETRE");
    expect(await refusTerritorialSync("u-restreint", { entityType: "Defaut", entityId: "x", operation: "CREATE", payload: { lat: 9.5 } })).toBe("REGION_INCONNUE");
    expect(await refusTerritorialSync("u-restreint", { entityType: "Portion", entityId: "x", operation: "CREATE", payload: { tronconId: "t-r1" } })).toBeNull();
  });
  it("modification : region actuelle lue en base ; deplacement vers un troncon d'une autre region refuse", async () => {
    expect(await refusTerritorialSync("u-restreint", { entityType: "Portion", entityId: "p-r2", operation: "UPDATE", payload: {} })).toBe("HORS_PERIMETRE");
    expect(await refusTerritorialSync("u-restreint", { entityType: "Portion", entityId: "p-r1", operation: "UPDATE", payload: { tronconId: "t-r2" } })).toBe("HORS_PERIMETRE");
    expect(await refusTerritorialSync("u-restreint", { entityType: "Portion", entityId: "p-r1", operation: "UPDATE", payload: {} })).toBeNull();
  });
  it("sans perimetre, ou type hors des huit domaines : rien n'est refuse", async () => {
    expect(await refusTerritorialSync("u-national", { entityType: "Defaut", entityId: "x", operation: "CREATE", payload: {} })).toBeNull();
    expect(await refusTerritorialSync("u-restreint", { entityType: "Mission", entityId: "x", operation: "CREATE", payload: {} })).toBeNull();
  });
});

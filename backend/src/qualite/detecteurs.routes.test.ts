import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `GET /api/v2/qualite/detecteurs` : ce que ces tests defendent.
 *   - meme politique de portee que /qualite/anomalies : region demandee, national reserve a ADMIN ;
 *   - `national=false` n'est PAS lu comme vrai (z.coerce.boolean() lirait la chaine « false » comme vraie) ;
 *   - un compte a perimetre regional ne lit que sa region ;
 *   - les seuils provisoires passent de la requete au service ; une famille inconnue est refusee ;
 *   - le service appele est la forme READ ONLY.
 */

const compte = { id: "u1", role: "GESTIONNAIRE" };

vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: compte.id, role: compte.role };
    n();
  },
}));
vi.mock("../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_q: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));
vi.mock("../middleware/rbac.middleware", () => ({
  requireRole: (...roles: string[]) =>
    (req: express.Request, res: express.Response, n: express.NextFunction) => {
      const u = (req as unknown as { user: { role: string } }).user;
      if (!roles.includes(u.role)) return res.status(403).json({ motif: "ROLE_INSUFFISANT" });
      return n();
    },
}));
vi.mock("../lib/prisma", () => ({ prisma: { marqueur: "prisma-factice" } }));

const h = vi.hoisted(() => ({
  appels: [] as { client: unknown; options: Record<string, unknown> }[],
  perimetre: { national: true } as { national: boolean; regions?: Set<number> },
}));

vi.mock("../territoire/territoire.service", () => ({
  perimetreDe: async () => h.perimetre,
}));

vi.mock("./detecteurs.service", async (original) => {
  const reel = await original<typeof import("./detecteurs.service")>();
  return {
    ...reel,
    lancerEnLectureSeule: async (client: unknown, options: Record<string, unknown>) => {
      h.appels.push({ client, options });
      return { genereLe: "2026-10-26T00:00:00.000Z", portee: options.portee, total: 0, parCode: [], parRegion: [], seuils: [], nonCouvert: [], avertissements: [] };
    },
  };
});

import { detecteursQualiteRouter } from "./detecteurs.routes";

function app() {
  const a = express();
  a.use("/api/v2/qualite/detecteurs", detecteursQualiteRouter);
  a.use((err: unknown, _q: express.Request, s: express.Response, _n: express.NextFunction) => {
    const nom = err instanceof Error ? err.name : "";
    s.status(nom === "ZodError" ? 400 : 500).json({ erreur: nom });
  });
  return a;
}
const URL = "/api/v2/qualite/detecteurs";

beforeEach(() => {
  compte.role = "GESTIONNAIRE";
  h.appels.length = 0;
  h.perimetre = { national: true };
});

describe("Portee", () => {
  it("refuse une requete sans portee", async () => {
    const r = await request(app()).get(URL);
    expect(r.status).toBe(400);
    expect(r.body.motif).toBe("PORTEE_REQUISE");
    expect(h.appels).toHaveLength(0);
  });
  it("accepte une region et appelle la forme READ ONLY avec le client de l'application", async () => {
    const r = await request(app()).get(`${URL}?regionId=7`);
    expect(r.status).toBe(200);
    expect(h.appels[0].options.portee).toEqual({ regionId: 7, reseau: "tout" });
    expect(h.appels[0].client).toEqual({ marqueur: "prisma-factice" });
    expect(r.body.national).toBe(false);
  });
  it("refuse le national a un GESTIONNAIRE", async () => {
    const r = await request(app()).get(`${URL}?national=true`);
    expect(r.status).toBe(403);
    expect(r.body.motif).toBe("NATIONAL_RESERVE_ADMIN");
    expect(h.appels).toHaveLength(0);
  });
  it("l'accepte d'un ADMIN, portee nulle", async () => {
    compte.role = "ADMIN";
    const r = await request(app()).get(`${URL}?national=true`);
    expect(r.status).toBe(200);
    expect(h.appels[0].options.portee).toEqual({ regionId: null, reseau: "tout" });
    expect(r.body.national).toBe(true);
  });
  it("national=false n'est pas du national : sans region, la portee est requise", async () => {
    compte.role = "ADMIN";
    const r = await request(app()).get(`${URL}?national=false`);
    expect(r.status).toBe(400);
    expect(r.body.motif).toBe("PORTEE_REQUISE");
  });
  it("refuse un LECTEUR", async () => {
    compte.role = "LECTEUR";
    const r = await request(app()).get(`${URL}?regionId=7`);
    expect(r.status).toBe(403);
    expect(h.appels).toHaveLength(0);
  });
  it("un compte a perimetre regional ne lit pas une autre region", async () => {
    h.perimetre = { national: false, regions: new Set([3]) };
    const refuse = await request(app()).get(`${URL}?regionId=7`);
    expect(refuse.status).toBe(403);
    expect(h.appels).toHaveLength(0);
    const accepte = await request(app()).get(`${URL}?regionId=3`);
    expect(accepte.status).toBe(200);
  });
});

describe("Parametres", () => {
  it("les seuils provisoires passent au service", async () => {
    await request(app()).get(`${URL}?regionId=7&PK_TROU_KM=2&LONGUEUR_ECART_RELATIF=0.2`);
    expect(h.appels[0].options.seuils).toEqual({ PK_TROU_KM: 2, LONGUEUR_ECART_RELATIF: 0.2 });
  });
  it("refuse un seuil negatif", async () => {
    const r = await request(app()).get(`${URL}?regionId=7&PK_TROU_KM=-1`);
    expect(r.status).toBe(400);
    expect(h.appels).toHaveLength(0);
  });
  it("les familles se limitent par liste, et une famille inconnue est refusee", async () => {
    await request(app()).get(`${URL}?regionId=7&familles=PK,ETAT`);
    expect(h.appels[0].options.familles).toEqual(["PK", "ETAT"]);
    const r = await request(app()).get(`${URL}?regionId=7&familles=PK,VITESSE`);
    expect(r.status).toBe(400);
    expect(r.body.motif).toBe("FAMILLE_INCONNUE");
  });
  it("le plafond de liste est borne", async () => {
    const r = await request(app()).get(`${URL}?regionId=7&plafond=999999`);
    expect(r.status).toBe(400);
    await request(app()).get(`${URL}?regionId=7&plafond=10`);
    expect(h.appels[0].options.plafondParCode).toBe(10);
  });
  it("le catalogue des codes accompagne la reponse", async () => {
    const r = await request(app()).get(`${URL}?regionId=7`);
    expect(Object.keys(r.body.catalogue)).toContain("PK_SENTINELLE_ZERO");
    expect(r.body.catalogue.PK_SENTINELLE_ZERO.correctionProposee).toBeTruthy();
  });
});

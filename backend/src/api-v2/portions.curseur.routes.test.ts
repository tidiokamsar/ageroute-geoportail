import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `GET /api/v2/portions/a-la-date`, `GET /api/v2/portions/chronologie`, et la date d'effet a la
 * creation : ce que ces tests defendent.
 *
 *   - les dates sont des JOURS (AAAA-MM-JJ), validees comme telles : une date inexistante ou une
 *     date FUTURE est refusee avant tout calcul, le curseur ne montre pas de previsions ;
 *   - « connu au » designe une journee ENTIERE : fin de journee, pas minuit ;
 *   - un perimetre mal forme est refuse ; les refus du service gardent leur code et leur statut ;
 *   - la date d'effet saisie a la creation arrive au service en jour UTC, et une date future est refusee.
 * Le calcul lui-meme est eprouve par `curseur.noyau.test.ts` et contre PostGIS (suivi, T-26).
 */

// Controle territorial (A10) : compte NATIONAL ici, le sujet de ce fichier est ailleurs. Le
// controle lui-meme est eprouve par territoire/*.test.ts et api-v2/perimetres.routes.test.ts.
vi.mock("../territoire/territoire.service", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  perimetreDe: async () => ({ national: true }),
}));

vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: "u-agent", role: "GESTIONNAIRE" }; n();
  },
}));
vi.mock("../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_q: express.Request, _r: express.Response, n: express.NextFunction) => n(),
}));

const h = vi.hoisted(() => ({
  appelsCurseur: [] as Record<string, unknown>[],
  appelsCreation: [] as Record<string, unknown>[],
  erreur: null as { code: string; message: string; http: number } | null,
}));

vi.mock("../reseau/curseur.service", () => {
  class RefusCurseur extends Error {
    constructor(public code: string, m: string, public http: number) { super(m); }
  }
  return {
    RefusCurseur,
    lirePortionsALaDate: async (_d: unknown, args: Record<string, unknown>) => {
      h.appelsCurseur.push(args);
      if (h.erreur) throw new RefusCurseur(h.erreur.code, h.erreur.message, h.erreur.http);
      return { portions: [], comptes: {}, tronque: false };
    },
    chronologie: async () => ({ total: 0, avecDateEffet: 0, sansDateEffet: 0, premiere: null, derniere: null, parMois: [] }),
  };
});
vi.mock("../reseau/portions.service", () => ({
  creerPortion: async (d: Record<string, unknown>) => { h.appelsCreation.push(d); return { refus: null, valeur: { id: "p-1", ...d } }; },
  decouperPortion: async () => ({ refus: null, valeur: [] }),
  fusionnerPortions: async () => ({ refus: null, valeur: {} }),
  requalifierPortion: async () => ({ refus: null, valeur: {} }),
}));
vi.mock("../reseau/portions.depot", () => ({
  depotPrisma: {},
  auteurDeLaPortion: async () => null,
  regionDuTronconDeLaPortion: async () => null,
  PortionIntrouvable: class extends Error {},
  DecisionConcurrente: class extends Error {},
}));
vi.mock("../governance/delegation.service", () => ({ verdictDelegation: async () => ({ permis: true, motif: "" }) }));
vi.mock("../lib/prisma", () => ({ prisma: {} }));

import { portionsV2Router } from "./portions.routes";

import { errorHandler } from "../middleware/error.middleware";

const app = express();
app.use(express.json());
app.use("/api/v2/portions", portionsV2Router);
// Le vrai gestionnaire : c'est lui qui transforme un ZodError en 400 dans l'application.
app.use(errorHandler);

const BBOX = "-13.9,9.4,-13.5,9.8";
const URL = "/api/v2/portions/a-la-date";

beforeEach(() => { h.appelsCurseur.length = 0; h.appelsCreation.length = 0; h.erreur = null; });

describe("GET /portions/a-la-date : parametres", () => {
  it("transmet le jour de terrain en minuit UTC, l'emprise en nombres, et refuse les propositions par defaut", async () => {
    const r = await request(app).get(URL).query({ date: "2026-03-15", bbox: BBOX });
    expect(r.status).toBe(200);
    const a = h.appelsCurseur[0] as { dateTerrain: Date; connuLe: Date | null; inclureAValider: boolean; emprise: unknown };
    expect(a.dateTerrain.toISOString()).toBe("2026-03-15T00:00:00.000Z");
    expect(a.connuLe).toBeNull();
    expect(a.inclureAValider).toBe(false);
    expect(a.emprise).toEqual({ ouest: -13.9, sud: 9.4, est: -13.5, nord: 9.8 });
  });

  it("« connu au » designe une JOURNEE ENTIERE : fin de journee, pas minuit", async () => {
    await request(app).get(URL).query({ date: "2026-03-15", connu: "2026-04-01", bbox: BBOX });
    const a = h.appelsCurseur[0] as { connuLe: Date };
    expect(a.connuLe.toISOString()).toBe("2026-04-01T23:59:59.999Z");
  });

  it("inclureAValider=true est transmis", async () => {
    await request(app).get(URL).query({ date: "2026-03-15", bbox: BBOX, inclureAValider: "true" });
    expect((h.appelsCurseur[0] as { inclureAValider: boolean }).inclureAValider).toBe(true);
  });

  it("accepte un troncon a la place d'une emprise", async () => {
    const id = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
    await request(app).get(URL).query({ date: "2026-03-15", tronconId: id });
    expect((h.appelsCurseur[0] as { tronconId: string; emprise?: unknown }).tronconId).toBe(id);
  });

  it.each([
    ["sans date", { bbox: BBOX }],
    ["date mal formee", { date: "15/03/2026", bbox: BBOX }],
    ["date inexistante", { date: "2026-02-30", bbox: BBOX }],
    ["connu mal forme", { date: "2026-03-15", connu: "hier", bbox: BBOX }],
    ["inclureAValider inconnu", { date: "2026-03-15", bbox: BBOX, inclureAValider: "peut-etre" }],
    ["troncon qui n'est pas un uuid", { date: "2026-03-15", tronconId: "t-1" }],
  ])("refuse %s (400), sans calculer", async (_n, q) => {
    expect((await request(app).get(URL).query(q)).status).toBe(400);
    expect(h.appelsCurseur).toHaveLength(0);
  });

  it.each([
    ["bbox a trois nombres", "1,2,3"],
    ["bbox non numerique", "a,b,c,d"],
  ])("refuse %s avec son code", async (_n, bbox) => {
    const r = await request(app).get(URL).query({ date: "2026-03-15", bbox });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("EMPRISE_INVALIDE");
    expect(h.appelsCurseur).toHaveLength(0);
  });

  it("REFUSE une date future : le curseur ne montre pas de previsions", async () => {
    const demain = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const r = await request(app).get(URL).query({ date: demain, bbox: BBOX });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("DATE_FUTURE");
    expect(h.appelsCurseur).toHaveLength(0);
  });

  it("REFUSE un « connu au » futur", async () => {
    const loin = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const r = await request(app).get(URL).query({ date: "2026-03-15", connu: loin, bbox: BBOX });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("DATE_FUTURE");
  });

  it("rend les refus du service avec leur statut et leur code", async () => {
    h.erreur = { code: "EMPRISE_TROP_LARGE", message: "trop large", http: 422 };
    const r = await request(app).get(URL).query({ date: "2026-03-15", bbox: BBOX });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: "EMPRISE_TROP_LARGE", error: "trop large" });
  });
});

describe("GET /portions/chronologie", () => {
  it("rend les bornes et les volumes", async () => {
    const r = await request(app).get("/api/v2/portions/chronologie");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 0, sansDateEffet: 0, premiere: null, parMois: [] });
  });
});

describe("POST /portions : la date d'effet", () => {
  const corps = { tronconId: "6f9619ff-8b86-4011-b42d-00c04fc964ff", debutM: 0, finM: 500, etat: "BON" };

  it("la transmet au service en jour UTC, meme si une heure est envoyee", async () => {
    const r = await request(app).post("/api/v2/portions").send({ ...corps, valideDu: "2026-03-15T18:30:00Z" });
    expect(r.status).toBe(201);
    expect((h.appelsCreation[0].valideDu as Date).toISOString()).toBe("2026-03-15T00:00:00.000Z");
  });

  it("une date absente reste ABSENTE : rien n'est invente", async () => {
    await request(app).post("/api/v2/portions").send(corps);
    expect(h.appelsCreation[0].valideDu ?? null).toBeNull();
  });

  it("REFUSE une date d'effet future, sans creer", async () => {
    const demain = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const r = await request(app).post("/api/v2/portions").send({ ...corps, valideDu: demain });
    expect(r.status).toBe(400);
    expect(h.appelsCreation).toHaveLength(0);
  });
});

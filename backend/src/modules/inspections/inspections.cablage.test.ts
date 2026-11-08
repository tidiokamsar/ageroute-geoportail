import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Cablage des gardes de role du routeur des inspections (defaut E2E-2, 25/10/2026).
 *
 * Les tests voisins simulent `requireRole` par un passe-plat : ils n'ont donc jamais vu qu'un `router.use(requireRole("ADMIN",
 * "GESTIONNAIRE"))` pose sans chemin refusait l'INSPECTEUR sur POST /, PUT /:id et les photos, routes qui annoncent pourtant ce
 * role. Ici le VRAI `requireRole` est utilise : seul le compte et la couche de donnees sont simules.
 */

const compte = { role: "INSPECTEUR" };
const etat = { sienne: true };

vi.mock("../../territoire/territoire.service", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  perimetreDe: async () => ({ national: true }),
}));
vi.mock("../../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: "u1", role: compte.role };
    next();
  },
}));
vi.mock("../../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_r: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));
vi.mock("../../middleware/upload-photo.middleware", () => ({
  uploadPhoto: (_r: express.Request, _s: express.Response, n: express.NextFunction) => n(),
  PHOTOS_UPLOAD_DIR: "/tmp",
}));
vi.mock("../../lib/prisma", () => ({
  // `findFirst` : le controleur ne rend a un INSPECTEUR que SES inspections (inspecteurId = lui).
  prisma: { inspection: { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => (etat.sienne ? { id: "srv-1" } : null)) } },
}));
vi.mock("./inspections.service", () => ({
  inspectionsService: {
    create: vi.fn(async (data: Record<string, unknown>) => ({ id: "srv-1", ...data })),
    list: vi.fn(async () => ({ items: [], total: 0 })),
    getById: vi.fn(async () => ({ id: "srv-1" })),
    update: vi.fn(async () => ({ id: "srv-1" })),
    bulkRemove: vi.fn(async () => ({ count: 0 })),
    bulkRestore: vi.fn(async () => ({ count: 0 })),
  },
}));

import { inspectionsRouter } from "./inspections.routes";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/inspections", inspectionsRouter);
  a.use((e: unknown, _q: express.Request, s: express.Response, _n: express.NextFunction) => s.status((e as { status?: number })?.status ?? 500).json({}));
  return a;
}

const corps = { tronconId: "11111111-1111-4111-8111-111111111111", dateInspection: "2026-09-02", etatObserve: "MAUVAIS" };

beforeEach(() => { compte.role = "INSPECTEUR"; etat.sienne = true; });

describe("Inspections : gardes de role reellement cablees", () => {
  it("un INSPECTEUR peut creer une inspection (la route annonce ce role)", async () => {
    const r = await request(app()).post("/api/inspections").send(corps);
    expect(r.status).toBe(201);
  });

  it("un INSPECTEUR peut relire une inspection par identifiant", async () => {
    const r = await request(app()).get("/api/inspections/srv-1");
    expect(r.status).toBe(200);
  });

  it("mais ne relit pas l'inspection d'un AUTRE inspecteur : 404 (le controleur filtre sur inspecteurId)", async () => {
    etat.sienne = false;
    const r = await request(app()).get("/api/inspections/srv-1");
    expect(r.status).toBe(404);
  });

  it("un INSPECTEUR ne peut PAS archiver en masse (reserve a ADMIN et GESTIONNAIRE)", async () => {
    const r = await request(app()).post("/api/inspections/bulk-archive").send({ ids: ["a"] });
    expect(r.status).toBe(403);
  });

  it("un INSPECTEUR ne peut PAS supprimer une inspection", async () => {
    const r = await request(app()).delete("/api/inspections/srv-1");
    expect(r.status).toBe(403);
  });

  it("un LECTEUR ne peut ni creer, ni relire par identifiant", async () => {
    compte.role = "LECTEUR";
    expect((await request(app()).post("/api/inspections").send(corps)).status).toBe(403);
    expect((await request(app()).get("/api/inspections/srv-1")).status).toBe(403);
  });

  it("un GESTIONNAIRE garde l'archivage en masse", async () => {
    compte.role = "GESTIONNAIRE";
    const r = await request(app()).post("/api/inspections/bulk-archive").send({ ids: ["a"] });
    expect(r.status).not.toBe(403);
  });
});

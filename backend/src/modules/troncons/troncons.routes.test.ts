import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Droits de lecture sur les troncons.
 *
 * Le routeur porte ce commentaire depuis l'origine : « La lecture (liste, fiche, geo,
 * export) reste ouverte a tout utilisateur authentifie ». Il etait faux pour deux
 * routes sur quatre.
 *
 * `/:id/fiche` et `/:id` avaient ete ajoutees APRES le `router.use(requireRole(...))`.
 * Or `use` s'applique a tout ce qui suit : un LECTEUR voyait la liste et la carte,
 * mais recevait 403 en ouvrant une fiche. Rien ne le signalait, parce qu'un ADMIN ne
 * rencontre jamais la regression.
 *
 * Ces tests fixent l'intention documentee, pour qu'un ajout ulterieur sous la mauvaise
 * ligne echoue au lieu de passer.
 */

const compte = { id: "u1", role: "LECTEUR" as string };

vi.mock("../../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: compte.id, role: compte.role };
    next();
  },
}));

vi.mock("../../middleware/rbac.middleware", () => ({
  requireRole: (...roles: string[]) =>
    (_req: express.Request, res: express.Response, next: express.NextFunction) =>
      roles.includes(compte.role) ? next() : res.status(403).json({ message: "Accès refusé" }),
}));

vi.mock("../../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../../middleware/upload.middleware", () => ({
  uploadExcel: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../../lib/crud-factory", () => ({
  createCrudService: () => ({}),
  createBulkRouter: () => express.Router(),
}));

const appele = { fiche: false, get: false, liste: false };

vi.mock("./troncons.controller", () => ({
  listHandler: (_r: express.Request, res: express.Response) => { appele.liste = true; res.json({ ok: "liste" }); },
  listGeoHandler: (_r: express.Request, res: express.Response) => res.json({ ok: "geo" }),
  itineraireHandler: (_r: express.Request, res: express.Response) => res.json({ ok: "itineraire" }),
  exportHandler: (_r: express.Request, res: express.Response) => res.json({ ok: "export" }),
  ficheHandler: (_r: express.Request, res: express.Response) => { appele.fiche = true; res.json({ ok: "fiche" }); },
  getHandler: (_r: express.Request, res: express.Response) => { appele.get = true; res.json({ ok: "get" }); },
  createHandler: (_r: express.Request, res: express.Response) => res.json({ ok: "create" }),
  updateHandler: (_r: express.Request, res: express.Response) => res.json({ ok: "update" }),
  deleteHandler: (_r: express.Request, res: express.Response) => res.json({ ok: "delete" }),
  updateGeomHandler: (_r: express.Request, res: express.Response) => res.json({ ok: "geom" }),
  importHandler: (_r: express.Request, res: express.Response) => res.json({ ok: "import" }),
}));

vi.mock("./troncons.service", () => ({ tronconsService: {} }));

import { tronconsRouter } from "./troncons.routes";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/troncons", tronconsRouter);
  return a;
}

beforeEach(() => {
  compte.role = "LECTEUR";
  appele.fiche = false; appele.get = false; appele.liste = false;
});

describe("Un LECTEUR peut lire, comme le routeur l'annonce", () => {
  it("ouvre la liste", async () => {
    expect((await request(app()).get("/api/troncons")).status).toBe(200);
  });

  it("ouvre la carte", async () => {
    expect((await request(app()).get("/api/troncons/geo")).status).toBe(200);
  });

  it("ouvre une FICHE — c'est ce qui etait casse", async () => {
    const r = await request(app()).get("/api/troncons/abc/fiche");
    expect(r.status).toBe(200);
    expect(appele.fiche).toBe(true);
  });

  it("ouvre un troncon par identifiant — casse aussi", async () => {
    const r = await request(app()).get("/api/troncons/abc");
    expect(r.status).toBe(200);
    expect(appele.get).toBe(true);
  });

  it("ne confond pas /geo avec un identifiant", async () => {
    // `/:id` place trop haut avalerait /geo, /export et /itineraire. L'ordre des
    // routes est aussi porteur de sens que les gardes.
    const r = await request(app()).get("/api/troncons/geo");
    expect(r.body).toEqual({ ok: "geo" });
    expect(appele.get).toBe(false);
  });
});

describe("Un LECTEUR ne peut rien ecrire", () => {
  it("refuse la creation", async () => {
    expect((await request(app()).post("/api/troncons").send({})).status).toBe(403);
  });

  it("refuse la modification", async () => {
    expect((await request(app()).put("/api/troncons/abc").send({})).status).toBe(403);
  });

  it("refuse la suppression", async () => {
    expect((await request(app()).delete("/api/troncons/abc")).status).toBe(403);
  });

  it("refuse l'import", async () => {
    expect((await request(app()).post("/api/troncons/import")).status).toBe(403);
  });
});

describe("Un GESTIONNAIRE ecrit", () => {
  it("cree", async () => {
    compte.role = "GESTIONNAIRE";
    expect((await request(app()).post("/api/troncons").send({})).status).toBe(200);
  });
});

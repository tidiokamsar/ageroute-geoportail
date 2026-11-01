import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `/api/v2/taches-internes` : ce qui se refuse AVANT d'atteindre la base.
 *
 * Le parcours complet (creation, preuves, cloture, abandon, rapprochement) est eprouve contre
 * PostGIS par `tests-integration/taches-internes.integration.mts`. Ces tests defendent les refus qui
 * ne doivent rien lire ni ecrire : la frontiere DigitalRoad, les roles, les formes invalides.
 */
const h = vi.hoisted(() => ({ compte: { id: "u1", role: "INSPECTEUR" as string }, requetes: 0 }));

vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => { (req as unknown as { user: unknown }).user = { ...h.compte }; n(); },
}));
vi.mock("../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_q: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));
vi.mock("../middleware/territoire.middleware", () => ({
  requireTerritoire: () => (_q: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));
vi.mock("../territoire/territoire.service", () => ({ regionDuTroncon: async () => 1, regionsFiche: async () => [1] }));
vi.mock("../territoire/territoire.v2", () => ({ regionDefaut: async () => 1 }));
vi.mock("../middleware/upload-photo.middleware", () => ({
  uploadPhoto: (_q: express.Request, _s: express.Response, n: express.NextFunction) => n(),
  PHOTOS_UPLOAD_DIR: "uploads/photos",
}));
vi.mock("../middleware/quota-photos.middleware", () => ({
  plafondPhotos: () => (_q: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));
vi.mock("../utils/audit", () => ({ logAuditTransactionnelle: vi.fn(async () => undefined) }));
vi.mock("../lib/prisma", () => {
  const compte = () => { h.requetes += 1; return []; };
  return { prisma: {
    $queryRaw: vi.fn(async () => compte()),
    $executeRaw: vi.fn(async () => { h.requetes += 1; return 0; }),
    $transaction: vi.fn(async () => { h.requetes += 1; throw new Error("la base ne doit pas etre atteinte"); }),
    tacheInterne: { findUnique: vi.fn(async () => { h.requetes += 1; return null; }), count: vi.fn(async () => 0) },
    referentielNatureTache: { findUnique: vi.fn(async () => { h.requetes += 1; return null; }) },
    troncon: { findFirst: vi.fn(async () => null) }, ouvrage: { findFirst: vi.fn(async () => null) }, defaut: { findFirst: vi.fn(async () => null) },
    user: { findUnique: vi.fn(async () => null) },
  } };
});

import { tachesInternesV2Router } from "./taches-internes.routes";
import { errorHandler } from "../middleware/error.middleware";

const app = express();
app.use(express.json());
app.use("/api/v2/taches-internes", tachesInternesV2Router);
app.use(errorHandler);

const corps = { nature: "CANTONNAGE", intitule: "Curage des fosses", tronconId: "t1" };
beforeEach(() => { h.compte.id = "u1"; h.compte.role = "INSPECTEUR"; h.requetes = 0; });

describe("frontiere DigitalRoad : refusee avant toute lecture", () => {
  for (const champ of ["montant", "montantEstime", "prix", "cout", "coût", "numeroMarche", "entrepriseId", "prestataire", "decompte", "paiement", "factureRef", "gnf", "bailleur"]) {
    it(`un champ « ${champ} » dans la creation est refuse (422) et explique la frontiere`, async () => {
      const r = await request(app).post("/api/v2/taches-internes").send({ ...corps, [champ]: 1 });
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({ motif: "CHAMP_CONTRACTUEL_REFUSE", champs: [champ] });
      expect(r.body.message).toContain("DigitalRoad");
      expect(h.requetes).toBe(0);
    });
  }

  it("une cloture qui porte un cout est refusee de meme, sans rien lire", async () => {
    const r = await request(app).post("/api/v2/taches-internes/t1/cloturer").send({ quantite: 3, unite: "m3", coutReel: 90000 });
    expect(r.status).toBe(422);
    expect(r.body.motif).toBe("CHAMP_CONTRACTUEL_REFUSE");
    expect(h.requetes).toBe(0);
  });

  it("la quantite constatee N'EST PAS un champ contractuel : elle passe ce premier controle", async () => {
    const r = await request(app).post("/api/v2/taches-internes/t1/cloturer").send({ quantite: 40, unite: "m3" });
    expect(r.body.motif).not.toBe("CHAMP_CONTRACTUEL_REFUSE");
  });
});

describe("roles", () => {
  it("un LECTEUR ne cree pas, ne demarre pas, ne cloture pas, n'abandonne pas (403)", async () => {
    h.compte.role = "LECTEUR";
    expect((await request(app).post("/api/v2/taches-internes").send(corps)).status).toBe(403);
    expect((await request(app).post("/api/v2/taches-internes/t1/demarrer").send({})).status).toBe(403);
    expect((await request(app).post("/api/v2/taches-internes/t1/cloturer").send({})).status).toBe(403);
    expect((await request(app).post("/api/v2/taches-internes/t1/abandonner").send({ motif: "x" })).status).toBe(403);
    expect(h.requetes).toBe(0);
  });

  it("le rapprochement est reserve aux gestionnaires", async () => {
    expect((await request(app).get("/api/v2/taches-internes/rapprochement")).status).toBe(403);
    h.compte.role = "GESTIONNAIRE";
    const r = await request(app).get("/api/v2/taches-internes/rapprochement");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ lectureSeule: true, tachesExaminees: 0, alertes: [], financier: { disponible: false } });
  });
});

describe("formes invalides : 400, rien n'est lu", () => {
  it("un champ inconnu est refuse par le contrat strict", async () => {
    expect((await request(app).post("/api/v2/taches-internes").send({ ...corps, couleur: "rouge" })).status).toBe(400);
  });
  it("un intitule trop court, une echeance mal formee, une latitude hors limites", async () => {
    expect((await request(app).post("/api/v2/taches-internes").send({ ...corps, intitule: "ab" })).status).toBe(400);
    expect((await request(app).post("/api/v2/taches-internes").send({ ...corps, echeanceLe: "demain" })).status).toBe(400);
    expect((await request(app).post("/api/v2/taches-internes").send({ ...corps, lat: 95, lon: 0 })).status).toBe(400);
    expect(h.requetes).toBe(0);
  });
  it("une cloture a quantite negative et un abandon sans corps conforme", async () => {
    expect((await request(app).post("/api/v2/taches-internes/t1/cloturer").send({ quantite: -1, unite: "m3" })).status).toBe(400);
    expect((await request(app).post("/api/v2/taches-internes/t1/abandonner").send({})).status).toBe(400);
    expect((await request(app).post("/api/v2/taches-internes/t1/abandonner").send({ motif: "   " })).status).toBe(422);
  });
  it("un rattachement manquant est refuse AVANT de lire le referentiel", async () => {
    const r = await request(app).post("/api/v2/taches-internes").send({ nature: "CANTONNAGE", intitule: "Sans lieu" });
    expect(r.status).toBe(422);
    expect(r.body.motif).toBe("RATTACHEMENT_REQUIS");
  });
});

describe("tache introuvable", () => {
  it("rend 404 sans rien reveler", async () => {
    const r = await request(app).get("/api/v2/taches-internes/inconnue");
    expect(r.status).toBe(404);
    expect((await request(app).post("/api/v2/taches-internes/inconnue/demarrer").send({})).status).toBe(404);
  });
});

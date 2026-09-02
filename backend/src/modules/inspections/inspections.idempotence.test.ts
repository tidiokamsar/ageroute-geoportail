import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Idempotence de la creation d'inspection (T7).
 *
 * LE DEFAUT
 *
 * La synchronisation hors-ligne creait l'inspection, envoyait les photos, et ne
 * retirait l'element de la file qu'apres le succes de TOUTES les photos. Une coupure
 * pendant l'envoi d'une photo laissait l'element complet en attente, et la
 * synchronisation suivante RECREAIT l'inspection. Un doublon par tentative, sur le
 * module cense produire la donnee du reseau.
 *
 * POURQUOI LE CORRECTIF CLIENT NE SUFFIT PAS
 *
 * Persister l'identifiant serveur des la creation supprime la cause la plus
 * frequente. Mais si la reponse HTTP se perd, le client conclut a un echec alors que
 * le serveur a enregistre. Il retentera. Seule une garantie SERVEUR ferme ce cas :
 * c'est ce que ces tests verifient.
 */

const etat = {
  existante: null as Record<string, unknown> | null,
  creations: 0,
};

vi.mock("../../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: "u1", role: "INSPECTEUR" };
    next();
  },
}));
vi.mock("../../middleware/rbac.middleware", () => ({
  requireRole: () => (_r: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));
vi.mock("../../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_r: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));
vi.mock("../../middleware/upload-photo.middleware", () => ({
  uploadPhoto: (_r: express.Request, _s: express.Response, n: express.NextFunction) => n(),
  PHOTOS_UPLOAD_DIR: "/tmp",
}));

vi.mock("../../lib/prisma", () => ({
  prisma: { inspection: { findUnique: vi.fn(async () => etat.existante) } },
}));

vi.mock("./inspections.service", () => ({
  inspectionsService: {
    create: vi.fn(async (data: Record<string, unknown>) => {
      etat.creations++;
      return { id: `srv-${etat.creations}`, ...data };
    }),
    list: vi.fn(async () => ({ items: [], total: 0 })),
    getById: vi.fn(async () => ({})),
  },
}));

import { inspectionsRouter } from "./inspections.routes";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/inspections", inspectionsRouter);
  return a;
}

const corps = (extra: Record<string, unknown> = {}) => ({
  tronconId: "11111111-1111-4111-8111-111111111111",
  dateInspection: "2026-09-02",
  etatObserve: "MAUVAIS",
  ...extra,
});

beforeEach(() => {
  etat.existante = null;
  etat.creations = 0;
});

describe("Création d'inspection — idempotence", () => {
  it("crée l'inspection au premier envoi", async () => {
    const r = await request(app())
      .post("/api/inspections")
      .send(corps({ clientInspectionId: "local-abc-123" }));

    expect(r.status).toBe(201);
    expect(etat.creations).toBe(1);
  });

  it("NE RECRÉE PAS l'inspection si le même identifiant client revient", async () => {
    // Le cas que le correctif client ne couvre pas : la reponse s'est perdue, le
    // client retente, le serveur a deja enregistre.
    etat.existante = { id: "srv-1", clientInspectionId: "local-abc-123" };
    const r = await request(app())
      .post("/api/inspections")
      .send(corps({ clientInspectionId: "local-abc-123" }));

    expect(r.status).toBe(200);
    expect(etat.creations).toBe(0);
    expect(r.body.id).toBe("srv-1");
  });

  it("distingue 200 de 201 pour que le client sache qu'il n'a rien créé", async () => {
    const premier = await request(app()).post("/api/inspections").send(corps({ clientInspectionId: "local-x1-0001" }));
    expect(premier.status).toBe(201);

    etat.existante = { id: "srv-1", clientInspectionId: "local-x1-0001" };
    const second = await request(app()).post("/api/inspections").send(corps({ clientInspectionId: "local-x1-0001" }));
    expect(second.status).toBe(200);
  });

  it("renvoie l'inspection existante, pour que le client reprenne aux photos", async () => {
    etat.existante = { id: "srv-42", clientInspectionId: "local-x1-0001", etatObserve: "BON" };
    const r = await request(app()).post("/api/inspections").send(corps({ clientInspectionId: "local-x1-0001" }));
    expect(r.body.id).toBe("srv-42");
  });

  it("crée normalement quand aucun identifiant client n'est fourni", async () => {
    // Compatibilite : les clients anciens n'en envoient pas.
    const r = await request(app()).post("/api/inspections").send(corps());
    expect(r.status).toBe(201);
    expect(etat.creations).toBe(1);
  });

  it("refuse un identifiant client trop court", async () => {
    const r = await request(app()).post("/api/inspections").send(corps({ clientInspectionId: "abc" }));
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(etat.creations).toBe(0);
  });

  it("deux identifiants différents donnent deux inspections", async () => {
    await request(app()).post("/api/inspections").send(corps({ clientInspectionId: "local-1111" }));
    await request(app()).post("/api/inspections").send(corps({ clientInspectionId: "local-2222" }));
    expect(etat.creations).toBe(2);
  });
});

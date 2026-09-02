import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Propositions de localisation : une proposition n'est jamais une localisation.
 *
 * La regle testee ici est celle du §18 : aucune position deduite d'un intitule
 * n'entre en base sans qu'un agent l'ait validee. Ces tests verifient qu'aucun chemin
 * ne permet de contourner cette validation, et qu'une validation vide est refusee.
 */

const compte = { id: "u1", role: "GESTIONNAIRE" as string };
const etat = {
  proposition: null as Record<string, unknown> | null,
  geomPosee: true,
  updates: [] as unknown[],
  audits: [] as unknown[],
};

vi.mock("../../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: compte.id, role: compte.role };
    next();
  },
}));
vi.mock("../../middleware/rbac.middleware", () => ({
  requireRole: (...roles: string[]) => (_req: express.Request, res: express.Response, next: express.NextFunction) =>
    roles.includes(compte.role) ? next() : res.status(403).json({ message: "Accès refusé" }),
}));
vi.mock("../../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../../lib/geo", () => ({
  deriveChantierGeom: vi.fn(async () => etat.geomPosee),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    propositionLocalisation: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => etat.proposition),
      update: vi.fn(async (a: unknown) => { etat.updates.push(a); return {}; }),
    },
    chantier: { update: vi.fn(async (a: unknown) => { etat.updates.push(a); return {}; }) },
    auditLog: { create: vi.fn(async (a: unknown) => { etat.audits.push(a); return {}; }) },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

import { propositionsRouter } from "./propositions.routes";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/propositions-localisation", propositionsRouter);
  return a;
}

const proposition = (p: Record<string, unknown> = {}) => ({
  id: "p1",
  chantierId: "c1",
  statut: "PROPOSED",
  methode: "INTITULE_ROUTE_PK",
  tronconId: null,
  pkDebut: null,
  pkFin: null,
  ...p,
});

beforeEach(() => {
  compte.role = "GESTIONNAIRE";
  etat.proposition = proposition();
  etat.geomPosee = true;
  etat.updates = [];
  etat.audits = [];
});

describe("Validation d'une proposition", () => {
  it("REFUSE de valider sans tronçon ni PK", async () => {
    // Le coeur du ticket : valider une proposition vide marquerait le chantier comme
    // localise sans qu'il le soit.
    const r = await request(app()).post("/api/propositions-localisation/p1/valider").send({});
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/tronçon et deux PK/);
    expect(etat.updates).toHaveLength(0);
  });

  it("refuse de valider si un seul PK est fourni", async () => {
    const r = await request(app())
      .post("/api/propositions-localisation/p1/valider")
      .send({ tronconId: "t1", pkDebut: 24 });
    expect(r.status).toBe(422);
    expect(etat.updates).toHaveLength(0);
  });

  it("pose la géométrie et marque le chantier PRECISE quand tout est fourni", async () => {
    const r = await request(app())
      .post("/api/propositions-localisation/p1/valider")
      .send({ tronconId: "t1", pkDebut: 24, pkFin: 66 });

    expect(r.status).toBe(200);
    expect(r.body.statut).toBe("VALIDATED");
    const majChantier = etat.updates.find(
      (u) => (u as { data?: { statutLocalisation?: string } }).data?.statutLocalisation
    ) as { data: { statutLocalisation: string } };
    expect(majChantier.data.statutLocalisation).toBe("PRECISE");
  });

  it("trace la validation dans le journal d'audit", async () => {
    // Une geometrie deduite d'un texte doit rester identifiable comme telle.
    await request(app())
      .post("/api/propositions-localisation/p1/valider")
      .send({ tronconId: "t1", pkDebut: 24, pkFin: 66 });

    expect(etat.audits).toHaveLength(1);
    const audit = etat.audits[0] as { data: { after: { methode: string } } };
    expect(audit.data.after.methode).toBe("INTITULE_ROUTE_PK");
  });

  it("laisse l'agent corriger ce que l'extraction a lu", async () => {
    etat.proposition = proposition({ tronconId: "t-lu", pkDebut: 24, pkFin: 66 });
    await request(app())
      .post("/api/propositions-localisation/p1/valider")
      .send({ tronconId: "t-corrige", pkDebut: 30, pkFin: 70 });

    const maj = etat.updates.find(
      (u) => (u as { data?: { tronconId?: string } }).data?.tronconId === "t-corrige"
    );
    expect(maj).toBeDefined();
  });

  it("n'écrit rien quand aucune emprise ne peut être dérivée", async () => {
    // PK hors de l'etendue du troncon, ou troncon sans geometrie.
    etat.geomPosee = false;
    const r = await request(app())
      .post("/api/propositions-localisation/p1/valider")
      .send({ tronconId: "t1", pkDebut: 900, pkFin: 999 });

    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/hors de son étendue/);
    expect(etat.updates).toHaveLength(0);
  });

  it("refuse de trancher deux fois", async () => {
    etat.proposition = proposition({ statut: "VALIDATED" });
    const r = await request(app())
      .post("/api/propositions-localisation/p1/valider")
      .send({ tronconId: "t1", pkDebut: 1, pkFin: 2 });
    expect(r.status).toBe(409);
  });

  it("répond 404 sur une proposition inexistante", async () => {
    etat.proposition = null;
    const r = await request(app())
      .post("/api/propositions-localisation/p1/valider")
      .send({ tronconId: "t1", pkDebut: 1, pkFin: 2 });
    expect(r.status).toBe(404);
  });

  it("interdit la validation à un lecteur", async () => {
    compte.role = "LECTEUR";
    const r = await request(app())
      .post("/api/propositions-localisation/p1/valider")
      .send({ tronconId: "t1", pkDebut: 1, pkFin: 2 });
    expect(r.status).toBe(403);
    expect(etat.updates).toHaveLength(0);
  });
});

describe("Rejet d'une proposition", () => {
  it("laisse le chantier sans localisation", async () => {
    const r = await request(app())
      .post("/api/propositions-localisation/p1/rejeter")
      .send({ motif: "PK illisibles" });

    expect(r.status).toBe(200);
    expect(r.body.statut).toBe("REJECTED");
    // Aucune mise a jour du chantier : il reste tel qu'il etait.
    const majChantier = etat.updates.find(
      (u) => (u as { data?: { statutLocalisation?: string } }).data?.statutLocalisation
    );
    expect(majChantier).toBeUndefined();
  });

  it("refuse de rejeter une proposition déjà tranchée", async () => {
    etat.proposition = proposition({ statut: "REJECTED" });
    const r = await request(app()).post("/api/propositions-localisation/p1/rejeter").send({});
    expect(r.status).toBe(409);
  });
});

describe("File d'attente", () => {
  it("refuse un statut inconnu plutôt que de rendre une liste vide", async () => {
    const r = await request(app()).get("/api/propositions-localisation?statut=NIMPORTEQUOI");
    expect(r.status).toBe(400);
  });

  it("rend les propositions en attente par défaut", async () => {
    const r = await request(app()).get("/api/propositions-localisation");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
  });
});

import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Controle territorial (A10) : compte NATIONAL ici, le sujet de ce fichier est ailleurs. Le controle lui-meme
// (lecture et ecriture par region) est eprouve par securite/controle-acces.test.ts et par le banc
// tests-integration/controle-acces.integration.mts.
vi.mock("../territoire/territoire.service", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  perimetreDe: async () => ({ national: true }),
}));

/**
 * `/api/v2/programmation` — ce que ces tests défendent.
 *
 * LA SAISIE EST UNE PROPOSITION SIGNÉE. Toute prévision naît PROPOSE avec source SAISIE
 * et l'auteur de la session : si un client pouvait poser RETENU tout seul, l'arbitrage
 * budgétaire — l'acte qu'un auditeur vient relire — n'existerait pas.
 *
 * LE MONTANT EST UNE CHAÎNE. Un montant GNF dépasse 2^53 ; accepter un nombre JSON
 * serait fausser silencieusement le budget. La route exige des chiffres et rend une
 * chaîne.
 *
 * RIEN NE SE SUPPRIME PHYSIQUEMENT. Une prévision retirée pose deletedAt ; elle
 * disparaît des listes mais reste dans l'audit — la programmation est une donnée
 * d'archive comme le reste du patrimoine.
 */
const h = vi.hoisted(() => {
  const base = {
    id: "p1", annee: 2027, intitule: "Rehabilitation RN1 section Conakry-Kindia",
    tronconId: null as string | null, bailleur: "AFD" as string | null,
    typeIntervention: "Rehabilitation" as string | null, montantPrevuGnf: 2_400_000_000n,
    priorite: null as number | null, statut: "PROPOSE", source: "SAISIE",
    commentaire: null as string | null, createdById: "u1",
    createdAt: new Date("2026-10-21T10:00:00Z"), updatedAt: new Date("2026-10-21T10:00:00Z"),
    deletedAt: null as Date | null,
  };
  return {
    compte: { id: "u1", role: "GESTIONNAIRE" },
    base,
    lignes: [] as Array<typeof base & { troncon?: { code: string } | null }>,
    creee: null as Record<string, unknown> | null,
    audite: [] as Array<{ action: string; entityId?: string; after?: unknown; before?: unknown }>,
    tronconConnu: { id: "t1", code: "RN1-001" },
  };
});

vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { ...h.compte };
    n();
  },
}));
vi.mock("../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_q: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));
vi.mock("../middleware/rbac.middleware", () => ({
  requireRole: () => (req: express.Request, res: express.Response, n: express.NextFunction) => {
    if (req.user?.role !== "ADMIN" && req.user?.role !== "GESTIONNAIRE") {
      res.status(403).json({ error: "Acces refuse pour votre role" });
      return;
    }
    n();
  },
}));
vi.mock("../lib/prisma", () => ({
  prisma: {
    programmeBudgetaire: {
      count: vi.fn(async () => h.lignes.length),
      findMany: vi.fn(async () => h.lignes),
      findFirst: vi.fn(async () => (h.lignes[0] ? { ...h.lignes[0] } : null)),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        h.creee = { ...h.base, ...data, id: "p2" };
        return h.creee;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const l = h.lignes.find((x) => x.id === where.id);
        if (!l) throw new Error("introuvable");
        Object.assign(l, data);
        return l;
      }),
    },
    troncon: { findUnique: vi.fn(async () => h.tronconConnu) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      programmeBudgetaire: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          h.creee = { ...h.base, ...data, id: "p2", troncon: { code: "RN1-001" } };
          return h.creee;
        }),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const l = h.lignes.find((x) => x.id === where.id);
          if (l) Object.assign(l, data);
          return l ?? { ...h.base, ...data };
        }),
      },
    })),
  },
}));
vi.mock("../utils/audit", () => ({
  logAuditTransactionnelle: vi.fn(async (_tx: unknown, p: { action: string; entityId?: string; after?: unknown; before?: unknown }) => {
    h.audite.push({ action: p.action, entityId: p.entityId, after: p.after, before: p.before });
  }),
}));

import { programmationV2Router } from "./programmation.routes";

const app = express();
app.use(express.json(), programmationV2Router);

beforeEach(() => {
  h.lignes = [{ ...h.base }];
  h.creee = null;
  h.audite = [];
});

describe("GET /api/v2/programmation", () => {
  it("rend les prévisions non supprimées, montant en chaîne", async () => {
    const r = await request(app).get("/");
    expect(r.status).toBe(200);
    expect(r.body.data[0].montantPrevuGnf).toBe("2400000000");
    expect(r.body.data[0].statut).toBe("PROPOSE");
  });
});

describe("POST /api/v2/programmation", () => {
  it("cree une prévision PROPOSE/SOURCE=SAISIE signée par la session, et l'audite", async () => {
    const r = await request(app).post("/").send({
      annee: 2027, intitule: "Renforcement RN2", montantPrevuGnf: "900000000", bailleur: "BAD",
    });
    expect(r.status).toBe(201);
    expect(r.body.statut).toBe("PROPOSE");
    expect(r.body.source).toBe("SAISIE");
    expect(r.body.montantPrevuGnf).toBe("900000000");
    expect(h.creee?.createdById).toBe("u1");
    expect(h.audite).toHaveLength(1);
    expect(h.audite[0].action).toBe("CREATE");
  });

  it("refuse un montant qui n'est pas une chaîne de chiffres (2^53 silencieux)", async () => {
    const r = await request(app).post("/").send({
      annee: 2027, intitule: "Renforcement RN2", montantPrevuGnf: 900000000,
    });
    expect(r.status).toBe(400);
    expect(h.creee).toBeNull();
  });

  it("refuse un intitulé trop court ou une année absente", async () => {
    expect((await request(app).post("/").send({ annee: 2027, intitule: "X", montantPrevuGnf: "1" })).status).toBe(400);
    expect((await request(app).post("/").send({ intitule: "Renforcement RN2", montantPrevuGnf: "1" })).status).toBe(400);
  });

  it("refuse un champ inconnu (source ne s'entre pas par la requête)", async () => {
    const r = await request(app).post("/").send({
      annee: 2027, intitule: "Renforcement RN2", montantPrevuGnf: "1", source: "MOTEUR",
    });
    expect(r.status).toBe(400);
  });
});

describe("PATCH /api/v2/programmation/:id", () => {
  it("révise montant et statut, avec before/after dans l'audit", async () => {
    const r = await request(app).patch("/p1").send({ montantPrevuGnf: "3100000000", statut: "RETENU" });
    expect(r.status).toBe(200);
    expect(r.body.montantPrevuGnf).toBe("3100000000");
    expect(r.body.statut).toBe("RETENU");
    expect(h.audite[0].action).toBe("UPDATE");
    expect((h.audite[0].before as { statut?: string } | undefined)?.statut).toBe("PROPOSE");
    expect((h.audite[0].after as { statut?: string } | undefined)?.statut).toBe("RETENU");
  });

  it("404 sur une prévision inconnue ou supprimée", async () => {
    h.lignes = [];
    const r = await request(app).patch("/p1").send({ statut: "RETENU" });
    expect(r.status).toBe(404);
  });
});

describe("POST /:id/supprimer", () => {
  it("pose deletedAt, n'efface aucune ligne, et l'audite", async () => {
    const r = await request(app).post("/p1/supprimer");
    expect(r.status).toBe(200);
    expect(h.lignes[0].deletedAt).toBeInstanceOf(Date);
    expect(h.audite[0].action).toBe("DELETE");
  });
});

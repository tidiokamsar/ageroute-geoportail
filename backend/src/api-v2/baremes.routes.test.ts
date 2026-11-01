import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `/api/v2/baremes` — ce que ces tests défendent.
 *
 * TOUTE MODIFICATION DÉSAPPROUVE. Version++ et approuveLe = null : sans ce reset, on
 * « approuverait » un prix que plus personne n'a lu depuis son édition.
 *
 * ON N'APPROUVE PAS UN PRIX ILLISIBLE. Le moteur de coût exige millésime et largeur ;
 * l'approbation les exige aussi, AVANT, avec un refus qui dit ce qui manque.
 */
const h = vi.hoisted(() => ({
  compte: { id: "u-admin", role: "ADMIN", email: "dt@ageroute.gov.gn" },
  ligne: {
    id: 3, familleRevetement: "bitume", etatDepart: "CRITIQUE", typeIntervention: "reconstruction",
    coutKmGnf: 3_500_000_000n, code: "BIT-CRIT-RECO", libelle: "Reconstruction bitume",
    source: "standard_initial", version: 1,
    approuveLe: null as Date | null, approuveParId: null as string | null,
    anneeReference: null as number | null, largeurChausseeM: null as string | null,
    commentaire: null as string | null,
    approuvePar: null as { email: string } | null,
  },
  audite: [] as Array<{ action: string; after?: unknown }>,
}));

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
  requireRole: (...roles: string[]) => (req: express.Request, res: express.Response, n: express.NextFunction) => {
    if (!roles.includes(req.user?.role ?? "")) {
      res.status(403).json({ error: "Acces refuse pour votre role" });
      return;
    }
    n();
  },
}));
vi.mock("../lib/prisma", () => ({
  prisma: {
    baremeIntervention: {
      findMany: vi.fn(async () => [{ ...h.ligne }]),
      findUnique: vi.fn(async () => ({ ...h.ligne })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(h.ligne, data, { approuvePar: data["approuveParId"] ? { email: h.compte.email } : null });
        return { ...h.ligne };
      }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      baremeIntervention: {
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(h.ligne, data, { approuvePar: data["approuveParId"] ? { email: h.compte.email } : null });
          return { ...h.ligne };
        }),
      },
    })),
  },
}));
vi.mock("../utils/audit", () => ({
  logAuditTransactionnelle: vi.fn(async (_tx: unknown, p: { action: string; after?: unknown }) => {
    h.audite.push({ action: p.action, after: p.after });
  }),
}));

import { baremesV2Router } from "./baremes.routes";

const app = express();
app.use(express.json(), baremesV2Router);

beforeEach(() => {
  h.ligne.approuveLe = null; h.ligne.approuveParId = null; h.ligne.approuvePar = null;
  h.ligne.anneeReference = null; h.ligne.largeurChausseeM = null; h.ligne.version = 1;
  h.audite = [];
});

describe("GET /api/v2/baremes", () => {
  it("rend les neuf lignes, coût en chaîne", async () => {
    const r = await request(app).get("/");
    expect(r.status).toBe(200);
    expect(r.body.data[0].coutKmGnf).toBe("3500000000");
    expect(r.body.data[0].familleRevetement).toBe("bitume");
  });
});

describe("PATCH /api/v2/baremes/:id", () => {
  it("pose millésime et largeur, passe à version 2 et DÉSAPPROUVE", async () => {
    const r = await request(app).patch("/3").send({ anneeReference: 2026, largeurChausseeM: 6.5 });
    expect(r.status).toBe(200);
    expect(r.body.version).toBe(2);
    expect(r.body.anneeReference).toBe(2026);
    expect(r.body.approuveLe).toBeNull();
    expect(h.audite[0].action).toBe("UPDATE");
    expect((h.audite[0].after as { version?: number } | undefined)?.version).toBe(2);
  });

  it("refuse un coût qui n'est pas une chaîne de chiffres", async () => {
    const r = await request(app).patch("/3").send({ coutKmGnf: 3500000000 });
    expect(r.status).toBe(400);
  });

  it("refuse un corps vide ou un champ inconnu", async () => {
    expect((await request(app).patch("/3").send({})).status).toBe(400);
    expect((await request(app).patch("/3").send({ familleRevetement: "pave" })).status).toBe(400);
  });
});

describe("POST /api/v2/baremes/:id/approuver", () => {
  it("refuse d'approuver un prix sans millésime ni largeur, en disant ce qui manque", async () => {
    const r = await request(app).post("/3/approuver");
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("PRIX_ILLISIBLE");
    expect(r.body.error).toContain("millésime");
    expect(r.body.error).toContain("largeur");
  });

  it("approuve une ligne lisible et l'audite comme VALIDATE", async () => {
    h.ligne.anneeReference = 2026; h.ligne.largeurChausseeM = "6.5";
    const r = await request(app).post("/3/approuver");
    expect(r.status).toBe(200);
    expect(r.body.approuveLe).not.toBeNull();
    expect(r.body.approuvePar).toBe("dt@ageroute.gov.gn");
    expect(h.audite[0].action).toBe("VALIDATE");
  });
});

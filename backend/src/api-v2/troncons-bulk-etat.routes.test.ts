import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `POST /api/v2/troncons-corridor/bulk-etat` — changer l'état d'un corridor en UNE
 * décision. Ce que ces tests défendent :
 *   - une seule transaction : tout passe ou rien ne passe ;
 *   - chaque tronçon modifié porte son AVANT dans l'audit, avec le motif exigé ;
 *   - un tronçon déjà dans l'état demandé n'est ni réécrit ni compté comme modifié ;
 *   - le motif court est refusé : un changement d'état de corridor est un ACTE, il se
 *     motive.
 */
const h = vi.hoisted(() => ({
  compte: { id: "u-gest", role: "GESTIONNAIRE", email: "dt@ageroute.gov.gn" },
  troncons: [
    { id: "t1", code: "GN N0001", etat: "MAUVAIS" },
    { id: "t2", code: "GN N0002", etat: "MAUVAIS" },
    // Déjà dans l'état cible du premier test (MOYEN) : il ne doit ni être réécrit ni
    // compter comme modifié — c'est ce cas que la troisième fixture éprouve.
    { id: "t3", code: "GN N0003", etat: "MOYEN" },
  ],
  updates: [] as Array<{ id: string; etat: string }>,
  audits: [] as Array<{ entityId: string; before?: unknown; after?: unknown }>,
}));

vi.mock("../middleware/rbac.middleware", () => ({
  requireRole: () => (req: express.Request, res: express.Response, n: express.NextFunction) => {
    // Le vrai requireRole s'exécute APRES requireAuth : l'utilisateur est déjà posé.
    // Le mock reproduit ce contrat et rejoue le refus de rôle.
    if (!req.user) { res.status(401).json({ error: "Authentification requise" }); return; }
    n();
  },
}));
vi.mock("../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_q: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));
vi.mock("../lib/prisma", () => ({
  prisma: {
    troncon: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        h.troncons.filter((t) => where.id.in.includes(t.id) && t.etat !== "SUPPRIME")),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { etat: string } }) => {
        const t = h.troncons.find((x) => x.id === where.id);
        if (t) { t.etat = data.etat; h.updates.push({ id: t.id, etat: data.etat }); }
        return t;
      }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      troncon: {
        // Copies détachées : comme le vrai Prisma, findMany ne rend pas des objets que
        // update muterait sous les pieds du before d'audit (leçon du mock picker).
        findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
          h.troncons.filter((t) => where.id.in.includes(t.id)).map((t) => ({ ...t }))),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: { etat: string } }) => {
          const t = h.troncons.find((x) => x.id === where.id);
          if (t) { t.etat = data.etat; h.updates.push({ id: t.id, etat: data.etat }); }
          return t;
        }),
      },
    })),
  },
}));
vi.mock("../utils/audit", () => ({
  logAuditTransactionnelle: vi.fn(async (_tx: unknown, p: { entityId: string; before?: unknown; after?: unknown }) => {
    h.audits.push({ entityId: p.entityId, before: p.before, after: p.after });
  }),
}));
vi.mock("@prisma/client", () => ({ AuditAction: { UPDATE: "UPDATE" } }));

import { bulkEtatV2Router } from "./troncons-bulk-etat.routes";

const app = express();
// La route est montée derrière requireAuth en production : le mock du RBAC exige un
// utilisateur, le test le pose ici (comme le ferait le middleware d'authentification).
app.use((req: express.Request, _res: express.Response, n: express.NextFunction) => {
  (req as unknown as { user: unknown }).user = { ...h.compte };
  n();
});
app.use(express.json(), bulkEtatV2Router);

beforeEach(() => {
  h.troncons.forEach((t) => { t.etat = t.id === "t3" ? "MOYEN" : "MAUVAIS"; });
  h.updates = [];
  h.audits = [];
});

describe("POST /api/v2/troncons-corridor/bulk-etat", () => {
  it("change l'état du corridor en une transaction, un audit par tronçon modifié", async () => {
    const r = await request(app).post("/bulk-etat").send({
      ids: ["t1", "t2", "t3"], etat: "MOYEN", motif: "Campagne de reconnaissance Coyah-Kindia octobre 2026",
    });
    expect(r.status).toBe(200);
    expect(r.body.modifie).toBe(2);      // t3 est déjà MOYEN : ni réécrit ni compté
    expect(r.body.inchanges).toBe(1);
    expect(r.body.introuvables).toEqual([]);
    expect(h.updates).toHaveLength(2);
    expect(h.audits).toHaveLength(2);
    expect(h.audits[0].before).toEqual({ etat: "MAUVAIS" });
    expect((h.audits[0].after as { motif?: string }).motif).toContain("Coyah-Kindia");
  });

  it("refuse un motif de moins de 5 caractères — un changement de corridor se motive", async () => {
    const r = await request(app).post("/bulk-etat").send({ ids: ["t1"], etat: "BON", motif: "ok" });
    expect(r.status).toBe(400);
    expect(h.updates).toHaveLength(0);
  });

  it("refuse un état hors référentiel et plus de 500 identifiants", async () => {
    expect((await request(app).post("/bulk-etat").send({ ids: ["t1"], etat: "PARFAIT", motif: "motif valide" })).status).toBe(400);
    expect((await request(app).post("/bulk-etat").send({ ids: Array(501).fill("t"), etat: "BON", motif: "motif valide" })).status).toBe(400);
  });

  it("rend les identifiants introuvables sans faire échouer la transaction", async () => {
    const r = await request(app).post("/bulk-etat").send({ ids: ["t1", "t-fantome"], etat: "CRITIQUE", motif: "Passage cyclone, constat régional" });
    expect(r.status).toBe(200);
    expect(r.body.introuvables).toEqual(["t-fantome"]);
    expect(r.body.modifie).toBe(1); // t1 seul (le fantôme ne compte pas)
  });

  it("un tronçon déjà dans l'état cible n'est ni réécrit ni audité", async () => {
    const r = await request(app).post("/bulk-etat").send({ ids: ["t3"], etat: "MOYEN", motif: "Confirmation de l'état connu" });
    expect(r.status).toBe(200);
    expect(r.body.modifie).toBe(0);
    expect(r.body.inchanges).toBe(1);
    expect(h.updates).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });
});

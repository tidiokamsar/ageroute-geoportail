import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `/api/v2/perimetres` (A10) : reserve a ADMIN ; un ADMIN reste national ; une region inconnue est
 * refusee ; le remplacement est audite ; le nombre de comptes encore nationaux par defaut est rendu.
 */

const compte = { id: "u-adm", role: "ADMIN" };
vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: compte.id, role: compte.role }; n();
  },
}));

const h = vi.hoisted(() => ({
  users: [] as { id: string; email: string; nomComplet: string; role: string; actif: boolean }[],
  perimetres: [] as { userId: string; regionId: number }[],
  regions: [3, 5] as number[],
  audits: [] as Record<string, unknown>[],
}));

vi.mock("../utils/audit", () => ({ logAuditTransactionnelle: vi.fn(async (_tx: unknown, p: Record<string, unknown>) => { h.audits.push(p); }) }));
vi.mock("../lib/prisma", () => {
  const prisma = {
    user: {
      findMany: async () => h.users.filter((u) => u.actif).map(({ actif: _a, ...u }) => u),
      findUnique: async ({ where }: { where: { id: string } }) => h.users.find((u) => u.id === where.id) ?? null,
    },
    region: { count: async ({ where }: { where: { id: { in: number[] } } }) => where.id.in.filter((r) => h.regions.includes(r)).length },
    $queryRaw: async (s: TemplateStringsArray, userId?: string) => s.join("?").includes("JOIN")
      ? h.perimetres.map((p) => ({ ...p, nom: `Region ${p.regionId}` }))
      : h.perimetres.filter((p) => p.userId === userId).map((p) => ({ regionId: p.regionId })),
    $executeRaw: async (s: TemplateStringsArray, userId: string, regionId?: number) => {
      if (s.join("?").startsWith("DELETE")) h.perimetres = h.perimetres.filter((p) => p.userId !== userId);
      else h.perimetres.push({ userId, regionId: regionId! });
      return 1;
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };
  return { prisma };
});

import { perimetresV2Router } from "./perimetres.routes";

const app = express();
app.use(express.json());
app.use("/p", perimetresV2Router);

beforeEach(() => {
  compte.role = "ADMIN";
  h.users = [
    { id: "u-adm", email: "a@x", nomComplet: "A", role: "ADMIN", actif: true },
    { id: "u-g", email: "g@x", nomComplet: "G", role: "GESTIONNAIRE", actif: true },
    { id: "u-i", email: "i@x", nomComplet: "I", role: "INSPECTEUR", actif: true },
  ];
  h.perimetres = []; h.audits = [];
});

describe("Perimetres territoriaux", () => {
  it("seul ADMIN y accede", async () => {
    compte.role = "GESTIONNAIRE";
    expect((await request(app).get("/p")).status).toBe(403);
    expect((await request(app).put("/p/u-g").send({ regionIds: [3] })).status).toBe(403);
  });
  it("rend chaque perimetre et le nombre de comptes encore nationaux par defaut (ADMIN exclu)", async () => {
    h.perimetres = [{ userId: "u-g", regionId: 3 }];
    const r = await request(app).get("/p");
    expect(r.status).toBe(200);
    expect(r.body.comptesNationauxParDefaut).toBe(1);
    expect(r.body.comptes.find((c: { id: string }) => c.id === "u-g")).toMatchObject({ perimetre: "REGIONAL", regions: [{ id: 3, nom: "Region 3" }] });
    expect(r.body.comptes.find((c: { id: string }) => c.id === "u-adm")).toMatchObject({ perimetre: "NATIONAL", nationalParDefaut: false });
  });
  it("remplace les regions d'un compte, audite avant / apres ; liste vide = national", async () => {
    h.perimetres = [{ userId: "u-g", regionId: 5 }];
    const r = await request(app).put("/p/u-g").send({ regionIds: [3, 3] });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ regionIds: [3], perimetre: "REGIONAL" });
    expect(h.perimetres).toEqual([{ userId: "u-g", regionId: 3 }]);
    expect(h.audits[0]).toMatchObject({ entityType: "PerimetreCompte", before: { regionIds: [5] }, after: { regionIds: [3] } });
    expect((await request(app).put("/p/u-g").send({ regionIds: [] })).body.perimetre).toBe("NATIONAL");
  });
  it("refuse de restreindre un ADMIN, une region inconnue, un compte inconnu", async () => {
    expect((await request(app).put("/p/u-adm").send({ regionIds: [3] })).body.code).toBe("ADMIN_NATIONAL");
    expect((await request(app).put("/p/u-g").send({ regionIds: [99] })).body.code).toBe("REGION_INCONNUE");
    expect((await request(app).put("/p/u-x").send({ regionIds: [3] })).status).toBe(404);
  });
});

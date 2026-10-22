import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `/api/v2/perimetres` -- ce que ces tests defendent.
 *   - ADMIN seulement, lecture comprise ;
 *   - personne ne s'attribue un territoire a soi-meme ; motif obligatoire ; terme apres le debut ;
 *   - une attribution en double est refusee ; une revocation se fait une fois et se conserve ;
 *   - chaque ecriture est auditee ; l'etat se lit (comptes sans perimetre).
 */

const compte = { id: "admin-1", role: "ADMIN" };
vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: compte.id, role: compte.role }; n();
  },
}));

type Ligne = Record<string, unknown>;
const h = vi.hoisted(() => ({ lignes: [] as Ligne[], audits: [] as Ligne[], users: [{ id: "admin-1" }, { id: "u-1" }, { id: "u-2" }] }));

vi.mock("../lib/prisma", () => {
  const perimetreTerritorial = {
    findMany: async () => h.lignes,
    findFirst: async ({ where }: { where: Ligne }) => h.lignes.find((l) => l.userId === where.userId && l.regionId === where.regionId && l.revoqueLe === null) ?? null,
    findUnique: async ({ where }: { where: { id: string } }) => h.lignes.find((l) => l.id === where.id) ?? null,
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => h.lignes.find((l) => l.id === where.id),
    create: async ({ data }: { data: Ligne }) => { const l = { id: `p-${h.lignes.length + 1}`, revoqueLe: null, createdAt: new Date(), ...data }; h.lignes.push(l); return l; },
    updateMany: async ({ where, data }: { where: Ligne; data: Ligne }) => {
      const l = h.lignes.find((x) => x.id === where.id && x.revoqueLe === null);
      if (!l) return { count: 0 };
      Object.assign(l, data); return { count: 1 };
    },
  };
  const tx = { perimetreTerritorial, auditLog: { create: async ({ data }: { data: Ligne }) => { h.audits.push(data); return data; } } };
  return {
    prisma: {
      ...tx,
      user: { findUnique: async ({ where }: { where: { id: string } }) => h.users.find((u) => u.id === where.id) ?? null, findMany: async () => h.users },
      region: { findUnique: async ({ where }: { where: { id: number } }) => (where.id <= 8 ? { id: where.id } : null) },
      $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    },
  };
});

import { perimetresV2Router } from "./perimetres.routes";

const app = express();
app.use(express.json());
app.use("/p", perimetresV2Router);
const attribution = { userId: "u-1", regionId: 3, motif: "Direction regionale de Kindia, note du ..." };

beforeEach(() => { h.lignes.length = 0; h.audits.length = 0; compte.role = "ADMIN"; compte.id = "admin-1"; });

describe("Perimetres", () => {
  it("un GESTIONNAIRE ne lit ni n'ecrit", async () => {
    compte.role = "GESTIONNAIRE";
    expect((await request(app).get("/p")).status).toBe(403);
    expect((await request(app).post("/p").send(attribution)).status).toBe(403);
  });
  it("attribue, audite, et l'etat se lit", async () => {
    const r = await request(app).post("/p").send(attribution);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ userId: "u-1", regionId: 3, attribueParId: "admin-1" });
    expect(h.audits).toEqual([expect.objectContaining({ action: "CREATE", entityType: "PerimetreTerritorial", userId: "admin-1" })]);
    const g = await request(app).get("/p");
    expect(g.body).toMatchObject({ comptesActifs: 3, comptesRestreints: 1, comptesSansPerimetre: 2 });
    expect(g.body.domaines).toHaveLength(8);
    expect(g.body.comptes).toHaveLength(3);
  });
  it("refuse soi-meme, sans motif, terme inverse, double, compte ou region inconnus", async () => {
    expect((await request(app).post("/p").send({ ...attribution, userId: "admin-1" })).body.code).toBe("SOI_MEME");
    expect((await request(app).post("/p").send({ ...attribution, motif: " " })).status).toBe(400);
    expect((await request(app).post("/p").send({ ...attribution, debutLe: "2026-10-22", finLe: "2026-10-01" })).body.code).toBe("PERIODE_INVERSEE");
    expect((await request(app).post("/p").send({ ...attribution, userId: "u-9" })).status).toBe(404);
    expect((await request(app).post("/p").send({ ...attribution, regionId: 99 })).status).toBe(404);
    await request(app).post("/p").send(attribution);
    expect((await request(app).post("/p").send(attribution)).body.code).toBe("DEJA_ATTRIBUEE");
  });
  it("revoque une fois, avec motif ; la ligne est conservee", async () => {
    const { body } = await request(app).post("/p").send(attribution);
    expect((await request(app).post(`/p/${body.id}/revocation`).send({})).status).toBe(400);
    const r = await request(app).post(`/p/${body.id}/revocation`).send({ motif: "mutation de l'agent" });
    expect(r.status).toBe(200);
    expect(r.body.revoqueLe).toBeTruthy();
    expect(h.lignes).toHaveLength(1);
    expect((await request(app).post(`/p/${body.id}/revocation`).send({ motif: "encore" })).body.code).toBe("DEJA_REVOQUEE");
    expect(h.audits.at(-1)).toMatchObject({ action: "UPDATE", entityType: "PerimetreTerritorial" });
    // Revoquee : une nouvelle attribution de la meme region redevient possible.
    expect((await request(app).post("/p").send(attribution)).status).toBe(201);
  });
});

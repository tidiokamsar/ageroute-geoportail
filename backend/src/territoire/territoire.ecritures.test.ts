import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Controle d'acces territorial (A10), du cote des ecritures :
 *   - la fabrique CRUD (troncons, ouvrages, points noirs, postes, chantiers, et leurs imports)
 *     controle la region d'apres a la creation, avant ET apres a la modification, celle de la
 *     fiche a l'archivage et a la restauration ; un refus n'ecrit rien ;
 *   - le garde `requireTerritoire` ne lit les regions que pour un compte regional, rend 403 hors
 *     perimetre ou region inconnue ;
 *   - la synchronisation rejette l'operation hors perimetre seule.
 */

type Ligne = Record<string, unknown>;
const h = vi.hoisted(() => ({
  comptes: {} as Record<string, string>,
  perimetres: {} as Record<string, number[]>,
  fiches: {} as Record<string, Ligne>,
  troncons: {} as Record<string, number>,
  ecritures: [] as string[],
}));

vi.mock("../utils/audit", () => ({
  logAuditTransactionnelle: vi.fn(async () => undefined),
  logAudit: vi.fn(), construireAudit: vi.fn(() => ({})),
}));
vi.mock("../lib/provenance", () => ({ construireSaisies: () => [] }));

vi.mock("../lib/prisma", () => {
  const modele = {
    findFirst: async ({ where }: { where: { id: string } }) => h.fiches[where.id] ?? null,
    findUnique: async ({ where }: { where: { id: string } }) => h.fiches[where.id] ?? null,
    create: async ({ data }: { data: Ligne }) => { h.ecritures.push(`create:${String(data.id)}`); return data; },
    update: async ({ where, data }: { where: { id: string }; data: Ligne }) => { h.ecritures.push(`update:${where.id}`); return { ...h.fiches[where.id], ...data }; },
  };
  const prisma = {
    modele,
    user: { findUnique: async ({ where }: { where: { id: string } }) => (h.comptes[where.id] ? { role: h.comptes[where.id] } : null) },
    troncon: { findUnique: async ({ where }: { where: { id: string } }) => (where.id in h.troncons ? { regionId: h.troncons[where.id] } : null) },
    mission: { findUnique: async () => null },
    observation: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === "obs-1" ? { tronconId: "t-r3", ouvrageId: null, chantierId: null, missionId: null } : null) },
    $queryRaw: async (_s: TemplateStringsArray, userId: string) => (h.perimetres[userId] ?? []).map((regionId) => ({ regionId })),
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };
  return { prisma };
});

import { createCrudService } from "../lib/crud-factory";
import { prisma } from "../lib/prisma";
import { requireTerritoire } from "../middleware/territoire.middleware";
import { perimetreDe } from "./territoire.service";
import { verdictOperationSync } from "./territoire.v2";

const service = createCrudService((prisma as unknown as { modele: unknown }).modele, "Poste", {
  delegueTransactionnel: (tx) => (tx as { modele: unknown }).modele, controleTerritorial: true,
});

beforeEach(() => {
  h.comptes = { "u-nat": "GESTIONNAIRE", "u-r3": "GESTIONNAIRE", "u-adm": "ADMIN" };
  h.perimetres = { "u-r3": [3] };
  h.fiches = { "f-r3": { id: "f-r3", regionId: 3 }, "f-r7": { id: "f-r7", regionId: 7 } };
  h.troncons = { "t-r3": 3, "t-r7": 7 };
  h.ecritures = [];
});

describe("Fabrique CRUD avec controleTerritorial", () => {
  it("compte national (aucun rattachement) : ecrit partout, comme avant", async () => {
    await service.create({ regionId: 7 }, "u-nat");
    await service.update("f-r7", { nom: "x" }, "u-nat");
    expect(h.ecritures).toHaveLength(2);
  });
  it("ADMIN : national meme rattache", async () => {
    h.perimetres["u-adm"] = [3];
    await service.create({ regionId: 7 }, "u-adm");
    expect(h.ecritures).toHaveLength(1);
  });
  it("compte regional : cree dans sa region, refuse ailleurs sans rien ecrire (403)", async () => {
    await service.create({ regionId: 3 }, "u-r3");
    await expect(service.create({ regionId: 7 }, "u-r3")).rejects.toMatchObject({ status: 403 });
    expect(h.ecritures).toHaveLength(1);
  });
  it("modification : la region d'avant ET celle d'apres comptent (pas de deplacement hors perimetre)", async () => {
    await service.update("f-r3", { nom: "x" }, "u-r3");
    await expect(service.update("f-r3", { regionId: 7 }, "u-r3")).rejects.toMatchObject({ status: 403 });
    await expect(service.update("f-r7", { regionId: 3 }, "u-r3")).rejects.toMatchObject({ status: 403 });
    expect(h.ecritures).toEqual(["update:f-r3"]);
  });
  it("archivage et restauration : region de la fiche ; l'archivage en masse rapporte le refus par ligne", async () => {
    const r = await service.bulkRemove(["f-r3", "f-r7"], "u-r3");
    expect(r.success).toBe(1);
    expect(r.failed).toEqual([{ id: "f-r7", message: expect.stringContaining("hors de votre perimetre") }]);
    await expect(service.restore("f-r7", "u-r3")).rejects.toMatchObject({ status: 403 });
  });
  it("compte introuvable : refuse plutot qu'accorde", async () => {
    await expect(service.create({ regionId: 3 }, "u-fantome")).rejects.toMatchObject({ status: 403 });
  });
});

describe("Garde requireTerritoire", () => {
  const lectures: string[] = [];
  const app = express();
  app.use(express.json());
  app.use((req, _r, n) => { (req as unknown as { user: unknown }).user = { id: String(req.headers["x-user"]), role: h.comptes[String(req.headers["x-user"])] }; n(); });
  app.post("/ecrire/:region", requireTerritoire(async (req) => { lectures.push(req.params.region); return [req.params.region === "inconnue" ? null : Number(req.params.region)]; }), (_q, res) => { res.json({ ok: true }); });

  it("national : passe sans lire les regions", async () => {
    lectures.length = 0;
    expect((await request(app).post("/ecrire/7").set("x-user", "u-nat")).status).toBe(200);
    expect(lectures).toEqual([]);
  });
  it("regional : 200 dans le perimetre, 403 hors perimetre ou region inconnue", async () => {
    expect((await request(app).post("/ecrire/3").set("x-user", "u-r3")).status).toBe(200);
    const hors = await request(app).post("/ecrire/7").set("x-user", "u-r3");
    expect(hors.status).toBe(403); expect(hors.body.code).toBe("HORS_PERIMETRE");
    expect((await request(app).post("/ecrire/inconnue").set("x-user", "u-r3")).body.code).toBe("REGION_INCONNUE");
  });
});

describe("Synchronisation terrain", () => {
  it("rejette seule l'operation hors perimetre ; un compte national passe tout", async () => {
    const r3 = await perimetreDe({ id: "u-r3", role: "GESTIONNAIRE" });
    expect(await verdictOperationSync(r3, { entityType: "Defaut", operation: "CREATE", entityId: "d1", payload: { tronconId: "t-r3" } })).toEqual({ ok: true });
    expect(await verdictOperationSync(r3, { entityType: "Portion", operation: "CREATE", entityId: "p1", payload: { tronconId: "t-r7" } })).toMatchObject({ ok: false, code: "HORS_PERIMETRE" });
    expect(await verdictOperationSync(r3, { entityType: "Defaut", operation: "CREATE", entityId: "d2", payload: {} })).toMatchObject({ ok: false, code: "REGION_INCONNUE" });
    // Modification d'observation : ses liens existants (troncon en region 3) et les nouveaux.
    expect(await verdictOperationSync(r3, { entityType: "Observation", operation: "UPDATE", entityId: "obs-1", payload: { note: "x" } })).toEqual({ ok: true });
    expect(await verdictOperationSync(r3, { entityType: "Observation", operation: "UPDATE", entityId: "obs-1", payload: { tronconId: "t-r7" } })).toMatchObject({ ok: false, code: "HORS_PERIMETRE" });
    const nat = await perimetreDe({ id: "u-nat", role: "GESTIONNAIRE" });
    expect(await verdictOperationSync(nat, { entityType: "Portion", operation: "CREATE", entityId: "p1", payload: { tronconId: "t-r7" } })).toEqual({ ok: true });
  });
});

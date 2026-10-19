import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `/api/v2/exploitation/veille` -- ce que ces tests defendent.
 *   - configurer (regles, astreintes, mode) : ADMIN et GESTIONNAIRE ; lire et evaluer : tous ;
 *   - une regle sans delai est refusee : aucun delai n'est suppose ;
 *   - deux regles actives pour le meme cas sont refusees ;
 *   - sans regle, l'evaluation n'inscrit rien et le dit ;
 *   - aucune route d'effacement.
 * L'evaluation reelle (vue, astreintes, idempotence) est eprouvee contre la base : voir le suivi.
 */

const compte = { id: "u-gest", role: "GESTIONNAIRE" };
vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: compte.id, role: compte.role }; n();
  },
}));

type Ligne = Record<string, unknown>;
const h = vi.hoisted(() => ({ regles: [] as Ligne[], astreintes: [] as Ligne[], modes: [] as Ligne[], audits: [] as Ligne[], requetes: 0 }));

vi.mock("../lib/prisma", () => {
  const regleEscalade = {
    findFirst: async ({ where }: { where: Ligne }) => h.regles.find((r) => r.typeCode === where.typeCode && r.mode === where.mode && r.niveau === where.niveau && r.actif) ?? null,
    findMany: async () => h.regles.filter((r) => r.actif),
    findUnique: async ({ where }: { where: { id: string } }) => h.regles.find((r) => r.id === where.id) ?? null,
    create: async ({ data }: { data: Ligne }) => { const r = { id: `r-${h.regles.length + 1}`, actif: true, ...data }; h.regles.push(r); return r; },
    update: async ({ where, data }: { where: { id: string }; data: Ligne }) => { const r = h.regles.find((x) => x.id === where.id)!; Object.assign(r, data); return r; },
  };
  const astreinte = {
    create: async ({ data }: { data: Ligne }) => { const a = { id: `a-${h.astreintes.length + 1}`, deletedAt: null, ...data }; h.astreintes.push(a); return a; },
    findMany: async () => [],
    findFirst: async ({ where }: { where: { id: string } }) => h.astreintes.find((a) => a.id === where.id && !a.deletedAt) ?? null,
    update: async ({ where, data }: { where: { id: string }; data: Ligne }) => { const a = h.astreintes.find((x) => x.id === where.id)!; Object.assign(a, data); return a; },
  };
  const modeVeille = {
    findFirst: async () => h.modes[h.modes.length - 1] ?? null,
    create: async ({ data }: { data: Ligne }) => { const m = { id: `m-${h.modes.length + 1}`, ...data }; h.modes.push(m); return m; },
  };
  const auditLog = { create: async ({ data }: { data: Ligne }) => { h.audits.push(data); return data; } };
  const tx = { regleEscalade, astreinte, modeVeille, auditLog, escalade: { findMany: async () => [] } };
  return {
    prisma: {
      ...tx,
      $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      $queryRaw: async () => { h.requetes += 1; return []; },
    },
  };
});

import { veilleV2Router } from "./veille.routes";

const app = express();
app.use(express.json());
app.use("/api/v2/exploitation/veille", veilleV2Router);
app.use((err: Error, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: err.message }); });
const base = "/api/v2/exploitation/veille";

beforeEach(() => { h.regles.length = 0; h.astreintes.length = 0; h.modes.length = 0; h.audits.length = 0; h.requetes = 0; compte.role = "GESTIONNAIRE"; });

describe("Droits", () => {
  it("un LECTEUR lit le mode et evalue, mais ne configure rien", async () => {
    compte.role = "LECTEUR";
    expect((await request(app).get(`${base}/mode`)).status).toBe(200);
    expect((await request(app).post(`${base}/escalades/evaluer`)).status).toBe(200);
    expect((await request(app).post(`${base}/regles`).send({ mode: "TOUS", niveau: 1, delaiMinutes: 30 })).status).toBe(403);
    expect((await request(app).post(`${base}/astreintes`).send({})).status).toBe(403);
    expect((await request(app).post(`${base}/mode`).send({ mode: "SAISON_PLUIES", motif: "x" })).status).toBe(403);
  });
  it("aucune route d'effacement", async () => {
    for (const p of ["/regles/r-1", "/astreintes/a-1", "/mode"]) expect((await request(app).delete(`${base}${p}`)).status).toBe(404);
  });
});

describe("Regles d'escalade", () => {
  it("refuse une regle sans delai, ou a delai hors bornes", async () => {
    expect((await request(app).post(`${base}/regles`).send({ mode: "TOUS", niveau: 1 })).status).toBe(400);
    const r = await request(app).post(`${base}/regles`).send({ mode: "TOUS", niveau: 1, delaiMinutes: 0 });
    expect(r.status).toBe(400); expect(r.body.code).toBe("DELAI_INVALIDE");
    expect(h.regles).toHaveLength(0);
  });
  it("cree, audite, refuse le doublon actif, desactive sans effacer", async () => {
    const r = await request(app).post(`${base}/regles`).send({ mode: "TOUS", niveau: 1, delaiMinutes: 30 });
    expect(r.status).toBe(201);
    const d = await request(app).post(`${base}/regles`).send({ mode: "TOUS", niveau: 1, delaiMinutes: 45 });
    expect(d.status).toBe(409); expect(d.body.code).toBe("REGLE_EXISTANTE");
    const x = await request(app).post(`${base}/regles/r-1/desactivation`);
    expect(x.status).toBe(200); expect(h.regles[0].actif).toBe(false);
    expect(h.regles).toHaveLength(1);
    expect(h.audits.map((a) => `${a.action}:${a.entityType}`)).toEqual(["CREATE:RegleEscalade", "UPDATE:RegleEscalade"]);
  });
});

describe("Evaluation sans regle", () => {
  it("n'inscrit rien, le dit, et ne lit meme pas les evenements", async () => {
    const r = await request(app).post(`${base}/escalades/evaluer`);
    expect(r.body).toMatchObject({ inscrites: [], sansRegle: true, mode: "NORMAL" });
    expect(h.requetes).toBe(0);
  });
});

describe("Mode et astreintes", () => {
  it("le mode non declare se dit non declare ; un mode se declare avec un motif", async () => {
    expect((await request(app).get(`${base}/mode`)).body).toMatchObject({ mode: "NORMAL", declare: false });
    expect((await request(app).post(`${base}/mode`).send({ mode: "SAISON_PLUIES" })).status).toBe(400);
    expect((await request(app).post(`${base}/mode`).send({ mode: "SAISON_PLUIES", motif: "Crues" })).status).toBe(201);
    expect((await request(app).get(`${base}/mode`)).body).toMatchObject({ mode: "SAISON_PLUIES", declare: true, motif: "Crues" });
  });
  it("refuse une astreinte a periode inversee ; retrait logique", async () => {
    const inv = await request(app).post(`${base}/astreintes`).send({ userId: "u-a", niveau: 1, debut: "2026-10-20", fin: "2026-10-19" });
    expect(inv.status).toBe(400); expect(inv.body.code).toBe("PERIODE_INVERSEE");
    expect((await request(app).post(`${base}/astreintes`).send({ userId: "u-a", niveau: 1, debut: "2026-10-19", fin: "2026-10-20" })).status).toBe(201);
    const ret = await request(app).post(`${base}/astreintes/a-1/retrait`);
    expect(ret.status).toBe(200);
    expect(h.astreintes[0].deletedAt).toBeInstanceOf(Date);
    expect((await request(app).post(`${base}/astreintes/a-1/retrait`)).status).toBe(404);
  });
});

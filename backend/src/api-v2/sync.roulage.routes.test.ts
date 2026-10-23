import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `POST /api/v2/sync/push` pour une SESSION DE ROULAGE, avec le VRAI service de synchronisation
 * (`field/sync.service`) et le VRAI routeur : seuls la base et le service d'analyse sont simules.
 *
 * Ce que ces tests defendent :
 *   - une session est acceptee par le mecanisme existant (aucun point d'entree parallele) ;
 *   - REJOUER la meme operation ne reecrit RIEN et rend REJOUEE : zero doublon ;
 *   - le meme identifiant de session sous une autre cle est refuse, sans rien ecrire ;
 *   - l'analyse precede la transaction, l'ecriture a lieu DANS la transaction ;
 *   - un refus de charge est definitif (pas de `reessayerDansMs`) et la charge n'est pas conservee ;
 *   - une ecriture qui echoue ne laisse aucune trace d'operation (la transaction est annulee).
 * Le SQL de l'ecriture, lui, est eprouve contre PostGIS par tests-integration/roulage.integration.mts.
 */

vi.mock("../territoire/territoire.service", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  perimetreDe: async () => ({ national: true }),
}));

const compte = { id: "agent-1", role: "INSPECTEUR" as string };
vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: compte.id, role: compte.role };
    n();
  },
}));
vi.mock("../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_q: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));

const h = vi.hoisted(() => ({
  operations: new Map<string, Record<string, unknown>>(),
  sessions: new Set<string>(),
  ordre: [] as string[],
  preparer: vi.fn(),
  ecrire: vi.fn(),
  echecEcriture: false,
}));

vi.mock("../utils/audit", () => ({ logAudit: vi.fn(), logAuditTransactionnelle: vi.fn() }));
vi.mock("../lib/geo", () => ({ setPointGeom: vi.fn(), deriveGeomFromTroncon: vi.fn(), deriveGeomFromTronconAbscisse: vi.fn() }));
vi.mock("../reseau/portions.depot", () => ({ depotDans: vi.fn() }));
vi.mock("../reseau/portions.service", () => ({ creerPortion: vi.fn() }));

vi.mock("../roulage/session.service", () => ({
  preparerSessionRoulage: (...a: unknown[]) => { h.ordre.push("preparer"); return h.preparer(...a); },
  ecrireSessionRoulage: (...a: unknown[]) => { h.ordre.push("ecrire"); return h.ecrire(...a); },
}));

vi.mock("../lib/prisma", () => {
  const prisma = {
    appareil: {
      findFirst: vi.fn(async () => ({ id: "app-1", userId: "agent-1" })),
      update: vi.fn(async () => ({})),
    },
    operationSync: {
      findUnique: vi.fn(async ({ where }: { where: { operationId: string } }) => h.operations.get(where.operationId) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { h.operations.set(data.operationId as string, data); return data; }),
      // Le service ecrit ses traces par upsert (une operation refusee TEMPORAIREMENT est reevaluee sous la
      // meme cle) : creation si la ligne manque, mise a jour sinon.
      upsert: vi.fn(async ({ where, create, update }: { where: { operationId: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const existante = h.operations.get(where.operationId);
        const ligne = existante ? { ...existante, ...update } : create;
        h.operations.set(where.operationId, ligne);
        return ligne;
      }),
    },
    $queryRaw: vi.fn(async (_s: TemplateStringsArray, id: string) => (h.sessions.has(id) ? [{ id }] : [])),
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => {
      h.ordre.push("transaction");
      const aEcrire: Record<string, unknown>[] = [];
      const tx = {
        $executeRaw: vi.fn(async () => 0),
        operationSync: {
          findUnique: vi.fn(async ({ where }: { where: { operationId: string } }) => h.operations.get(where.operationId) ?? null),
          create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { aEcrire.push(data); return data; }),
          // Meme semantique que le client : le premier envoi cree la ligne (aucune ligne n'existe dans ces tests).
          upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => { aEcrire.push(create); return create; }),
        },
      };
      const r = await run(tx);
      // Validation seulement si la transaction a reussi : une exception l'annule.
      for (const d of aEcrire) h.operations.set(d.operationId as string, d);
      return r;
    }),
  };
  return { prisma };
});

import { syncV2Router } from "./sync.routes";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const APPAREIL = uuid(900);
const sessionOp = (n: number, surcharge: Record<string, unknown> = {}) => ({
  operationId: uuid(n), entityType: "SessionRoulage", entityId: uuid(n), operation: "CREATE" as const, baseVersion: null,
  payload: { versionContrat: 1, sessionId: uuid(n), points: [] }, ...surcharge,
});

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/v2/sync", syncV2Router);
  a.use((e: Error, _q: express.Request, s: express.Response, _n: express.NextFunction) => {
    s.status(e.name === "ZodError" ? 400 : 500).json({ erreur: e.name, message: e.message });
  });
  return a;
}
const push = (operations: unknown[]) => request(app()).post("/api/v2/sync/push").send({ appareilId: APPAREIL, operations });

beforeEach(() => {
  compte.id = "agent-1";
  h.operations.clear();
  h.sessions.clear();
  h.ordre.length = 0;
  h.echecEcriture = false;
  h.preparer.mockReset();
  h.ecrire.mockReset();
  h.preparer.mockResolvedValue({ ok: true, plan: { payload: { points: new Array(120) } } });
  h.ecrire.mockImplementation(async (_tx: unknown, plan: unknown, ctx: { entityId: string }) => {
    if (h.echecEcriture) throw new Error("violation de contrainte simulee");
    h.sessions.add(ctx.entityId);
    void plan;
    return { sessionId: ctx.entityId, marqueurs: 3, marqueursRattaches: 2, evenements: 1, portionsCreees: 1, portionsRefusees: 0 };
  });
});

describe("POST /push avec une SessionRoulage", () => {
  it("est acceptee par le protocole existant ; l'analyse precede la transaction, l'ecriture est dans la transaction", async () => {
    const r = await push([sessionOp(1)]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 1, synchronisees: 1, rejouees: 0, conflits: 0, rejetees: 0 });
    expect(r.body.resultats[0]).toMatchObject({ statut: "SYNCHRONISE", entityId: uuid(1) });
    expect(h.ordre).toEqual(["preparer", "transaction", "ecrire"]);
    // Le contexte transmis a l'analyse et a l'ecriture est celui du compte authentifie, pas du corps.
    expect(h.preparer.mock.calls[0][1]).toEqual({ userId: "agent-1", appareilId: "app-1", operationId: uuid(1), entityId: uuid(1) });
    expect(h.ecrire.mock.calls[0][2]).toEqual({ userId: "agent-1", appareilId: "app-1", operationId: uuid(1), entityId: uuid(1) });
  });

  it("ne garde PAS la trace brute dans operations_sync : un resume seulement", async () => {
    await push([sessionOp(1)]);
    const trace = h.operations.get(uuid(1))!;
    expect(trace).toMatchObject({ statut: "SYNCHRONISE", entityType: "SessionRoulage" });
    expect(trace.payload).toEqual({ redacted: true, sessionId: uuid(1), points: 120, marqueurs: 3, evenements: 1 });
  });

  it("REJEU : la meme operation envoyee deux fois n'ecrit RIEN la seconde fois et rend REJOUEE (zero doublon)", async () => {
    await push([sessionOp(1)]);
    h.ordre.length = 0;
    const r = await push([sessionOp(1)]);
    expect(r.body).toMatchObject({ total: 1, synchronisees: 0, rejouees: 1, rejetees: 0 });
    expect(r.body.resultats[0]).toMatchObject({ statut: "REJOUEE", entityId: uuid(1) });
    expect(h.ordre).toEqual([]);
    expect(h.ecrire).toHaveBeenCalledTimes(1);
    expect(h.preparer).toHaveBeenCalledTimes(1);
  });

  it("une cle connue ne devient pas un oracle : un autre compte qui la rejoue est refuse", async () => {
    await push([sessionOp(1)]);
    h.operations.get(uuid(1))!.userId = "agent-2";
    const r = await push([sessionOp(1)]);
    expect(r.body.resultats[0]).toMatchObject({ statut: "REJETE", motif: "OPERATION_NON_AUTORISEE" });
  });

  it("meme identifiant de session sous une NOUVELLE cle d'operation : REJETE SESSION_DEJA_ENREGISTREE, rien n'est reecrit", async () => {
    await push([sessionOp(1)]);
    h.ordre.length = 0;
    const r = await push([sessionOp(2, { entityId: uuid(1) })]);
    expect(r.body.resultats[0]).toMatchObject({ statut: "REJETE", motif: "SESSION_DEJA_ENREGISTREE" });
    expect(r.body.resultats[0].reessayerDansMs).toBeUndefined();
    expect(h.ordre).toEqual([]);
    expect(h.ecrire).toHaveBeenCalledTimes(1);
    expect(h.operations.get(uuid(2))).toMatchObject({ statut: "REJETE", derniereErreur: "SESSION_DEJA_ENREGISTREE", payload: { redacted: true } });
  });

  it("un refus de charge est DEFINITIF (pas de reessayerDansMs), la charge n'est pas conservee, et rien n'est ecrit", async () => {
    h.preparer.mockResolvedValue({ ok: false, motif: "PAYLOAD_INVALIDE" });
    const r = await push([sessionOp(1)]);
    expect(r.body).toMatchObject({ synchronisees: 0, rejetees: 1 });
    expect(r.body.resultats[0]).toMatchObject({ statut: "REJETE", motif: "PAYLOAD_INVALIDE" });
    expect(r.body.resultats[0].reessayerDansMs).toBeUndefined();
    expect(h.ecrire).not.toHaveBeenCalled();
    expect(h.operations.get(uuid(1))).toMatchObject({ statut: "REJETE", derniereErreur: "PAYLOAD_INVALIDE", payload: { redacted: true } });
  });

  it("une mission non autorisee est un refus definitif aussi", async () => {
    h.preparer.mockResolvedValue({ ok: false, motif: "MISSION_NON_AUTORISEE" });
    const r = await push([sessionOp(1)]);
    expect(r.body.resultats[0]).toMatchObject({ statut: "REJETE", motif: "MISSION_NON_AUTORISEE" });
  });

  it("une ecriture qui echoue annule la transaction : aucune operation n'est enregistree, le client pourra rejouer", async () => {
    h.echecEcriture = true;
    const r = await push([sessionOp(1)]);
    expect(r.status).toBe(500);
    expect(h.operations.size).toBe(0);
    expect(h.sessions.size).toBe(0);
    // Le rejeu, une fois la panne passee, aboutit : l'idempotence n'a pas ete consommee par l'echec.
    h.echecEcriture = false;
    const r2 = await push([sessionOp(1)]);
    expect(r2.body.resultats[0]).toMatchObject({ statut: "SYNCHRONISE" });
  });

  it("seule la creation est acceptee : UPDATE et DELETE d'une session sont rejetes sans analyse", async () => {
    const r = await push([sessionOp(1, { operation: "UPDATE", baseVersion: 1 }), sessionOp(2, { operation: "DELETE", baseVersion: 1 })]);
    expect(r.body.resultats.map((x: { motif: string }) => x.motif)).toEqual([
      "OPERATION_NON_SUPPORTEE:SessionRoulage:UPDATE", "OPERATION_NON_SUPPORTEE:SessionRoulage:DELETE",
    ]);
    expect(h.preparer).not.toHaveBeenCalled();
  });

  it("un lot de deux sessions distinctes est traite en serie, chacune dans sa transaction", async () => {
    const r = await push([sessionOp(1), sessionOp(2)]);
    expect(r.body).toMatchObject({ total: 2, synchronisees: 2 });
    expect(h.ordre).toEqual(["preparer", "transaction", "ecrire", "preparer", "transaction", "ecrire"]);
  });

  it("un appareil revoque ou d'un autre compte n'ecrit rien", async () => {
    const { prisma } = await import("../lib/prisma");
    (prisma.appareil.findFirst as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const r = await push([sessionOp(1)]);
    expect(r.status).toBe(403);
    expect(h.preparer).not.toHaveBeenCalled();
  });
});

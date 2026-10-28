import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Revocation d'un appareil et codes stables `APPAREIL_REVOQUE` / `APPAREIL_INCONNU`
 * (chantier D4, defauts 2 et 3 de `docs/securite/SESSION-HORS-LIGNE.md` section 7).
 *
 * LES DEFAUTS QUE CES TESTS REPRODUISENT (ecrits avant le correctif, ils echouaient sur le code d'origine)
 *
 *  - Revoquer un appareil ne coupait que la ligne `appareils` : `Appareil` n'est lie a aucun
 *    `RefreshToken`, donc le porteur gardait sa session de rafraichissement et un telephone vole
 *    obtenait des jetons d'acces neufs sans limite. La revocation coupe maintenant TOUTES les familles
 *    de rafraichissement du proprietaire de l'appareil (pas de lien appareil-session dans le schema),
 *    dans la meme transaction que la trace SECURITY_EVENT.
 *  - `sync/push` rendait le meme 403 pour un appareil inconnu et pour un appareil revoque ; le client
 *    reagissait aux deux en s'enregistrant de nouveau, et un appareil revoque revenait donc sous une
 *    nouvelle identite. Les deux ont desormais un code distinct.
 *
 * La base est simulee (modele en memoire avec annulation de la transaction) ; la preuve contre une vraie
 * base est `tests-integration/session-appareil.integration.mts`.
 */

const h = vi.hoisted(() => ({
  user: { id: "agent-1", role: "INSPECTEUR" } as { id: string; role: string },
  appareils: {} as Record<string, Record<string, unknown>>,
  refresh: [] as Array<{ id: string; userId: string; familyId: string; revokedAt: Date | null }>,
  audits: [] as Array<Record<string, unknown>>,
  auditFailure: false,
  applique: [] as string[],
  modulePermis: true,
  traces: [] as Array<{ operationId: string; cause: string; tracer: boolean }>,
  /** Ordre des appels de la transaction de revocation (le verrou du proprietaire doit venir en premier). */
  ordre: [] as string[],
}));

vi.mock("../config/env", () => ({ env: { JWT_ACCESS_EXPIRES_IN: "15m" } }));
vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { ...h.user };
    next();
  },
}));
vi.mock("../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
vi.mock("../lib/access", () => ({
  modulesAutorisesDe: vi.fn(async () => (h.modulePermis ? null : new Set())),
  moduleAutorise: (modules: Set<string> | null, cle: string) => modules === null || modules.has(cle),
}));
vi.mock("../utils/audit", () => ({
  logAuditTransactionnelle: vi.fn(async (
    tx: { auditLog: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> } },
    params: Record<string, unknown>,
  ) => tx.auditLog.create({ data: params })),
}));
vi.mock("../territoire/territoire.service", () => ({ perimetreDe: async () => ({ national: true }) }));
vi.mock("../territoire/territoire.lecture", () => ({ et: (a: unknown) => a, filtreRegionDefaut: () => ({}), filtreRegionObservation: () => ({}), regionsVisibles: async () => null }));

vi.mock("../field/sync.service", async () => {
  // Le budget de traces est de la logique pure du service : on garde la vraie (le reste est simule).
  const reel = await vi.importActual<typeof import("../field/sync.service")>("../field/sync.service");
  return {
    TYPES_ACCEPTES: new Set(["Observation", "Defaut"]),
    OPERATIONS_ACCEPTEES: { Observation: ["CREATE", "UPDATE", "DELETE"], Defaut: ["CREATE"] },
    MOTIF_DROITS_MODIFIES: "DROITS_MODIFIES",
    creerBudgetTraces: reel.creerBudgetTraces,
    REFUS_DROITS_TRACES_MAX_PAR_LOT: reel.REFUS_DROITS_TRACES_MAX_PAR_LOT,
    estRefusDeDroits: (m?: string | null) => !!m && (m.startsWith("DROITS_MODIFIES") || m === "MISSION_NON_AUTORISEE"),
    appliquer: vi.fn(async (op: { operationId: string }) => {
      h.applique.push(op.operationId);
      return { operationId: op.operationId, statut: "SYNCHRONISE", entityId: "e1", version: 2 };
    }),
    refuserPourDroits: vi.fn(async (op: { operationId: string }, _ctx: unknown, cause: string, options?: { tracer?: boolean }) => {
      h.traces.push({ operationId: op.operationId, cause, tracer: options?.tracer !== false });
      return { operationId: op.operationId, statut: "REJETE", motif: "DROITS_MODIFIES", cause, definitif: true };
    }),
    statutAppareil: vi.fn(async (id: string) => ({ appareilId: id, operations: {}, conflitsNonResolus: 0, derniereOperationA: null })),
  };
});

vi.mock("../lib/prisma", () => {
  const prisma = {
    appareil: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => h.appareils[where.id] ?? null),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        h.appareils[where.id] = { ...h.appareils[where.id], ...data };
        return h.appareils[where.id];
      }),
    },
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => {
      const sauve = {
        appareils: structuredClone(h.appareils),
        refresh: structuredClone(h.refresh),
        audits: [...h.audits],
      };
      const tx = {
        $queryRaw: vi.fn(async (texte: TemplateStringsArray) => { h.ordre.push(`verrou:${texte.join("?").trim()}`); return []; }),
        appareil: {
          findFirst: vi.fn(async ({ where }: { where: { userId: string; revoqueA: { gt: Date } } }) => {
            const recent = Object.values(h.appareils).filter((a) => a.userId === where.userId && a.revoqueA && (a.revoqueA as Date) > where.revoqueA.gt);
            return recent.length ? { revoqueA: recent[0].revoqueA } : null;
          }),
          count: vi.fn(async ({ where }: { where: { userId: string } }) =>
            Object.values(h.appareils).filter((a) => a.userId === where.userId && a.revoqueA === null).length),
          create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
            const id = `device-${Object.keys(h.appareils).length + 1}`;
            h.appareils[id] = { id, revoqueA: null, ...data };
            return h.appareils[id];
          }),
          updateMany: vi.fn(async ({ where, data }: { where: { id: string; userId: string; revoqueA: null }; data: Record<string, unknown> }) => {
            h.ordre.push("appareil.updateMany");
            const a = h.appareils[where.id];
            if (!a || a.userId !== where.userId || a.revoqueA !== null) return { count: 0 };
            h.appareils[where.id] = { ...a, ...data };
            return { count: 1 };
          }),
          findUnique: vi.fn(async ({ where }: { where: { id: string } }) => h.appareils[where.id] ?? null),
        },
        refreshToken: {
          updateMany: vi.fn(async ({ where, data }: { where: { userId: string; revokedAt: null }; data: { revokedAt: Date } }) => {
            h.ordre.push("refreshToken.updateMany");
            let n = 0;
            for (const t of h.refresh) {
              if (t.userId === where.userId && t.revokedAt === null) { t.revokedAt = data.revokedAt; n++; }
            }
            return { count: n };
          }),
        },
        auditLog: {
          create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
            if (h.auditFailure) throw new Error("audit indisponible");
            h.audits.push(data);
            return data;
          }),
        },
      };
      try {
        return await run(tx);
      } catch (e) {
        h.appareils = sauve.appareils;
        h.refresh = sauve.refresh;
        h.audits = sauve.audits;
        throw e;
      }
    }),
  };
  return { prisma };
});

import { devicesV2Router } from "../api-v2/devices.routes";
import { syncV2Router } from "../api-v2/sync.routes";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const APP = uuid(9);
const op = (n: number) => ({
  operationId: uuid(n), entityType: "Observation", entityId: "e1", operation: "UPDATE" as const, baseVersion: 1, payload: { description: "x" },
});

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/v2/devices", devicesV2Router);
  a.use("/api/v2/sync", syncV2Router);
  a.use((e: Error, _q: express.Request, s: express.Response, _n: express.NextFunction) => {
    s.status(e.name === "ZodError" ? 400 : 500).json({ erreur: e.name });
  });
  return a;
}

const appareil = (id: string, userId: string, revoqueA: Date | null = null) => ({ id, userId, revoqueA, plateforme: "android", modele: "Telephone" });

beforeEach(() => {
  h.user = { id: "agent-1", role: "INSPECTEUR" };
  h.appareils = { [APP]: appareil(APP, "agent-1") };
  h.refresh = [
    { id: "t1", userId: "agent-1", familyId: "f1", revokedAt: null },
    { id: "t2", userId: "agent-1", familyId: "f2", revokedAt: null },
    { id: "t3", userId: "agent-2", familyId: "f3", revokedAt: null },
  ];
  h.audits = [];
  h.auditFailure = false;
  h.applique = [];
  h.modulePermis = true;
  h.traces = [];
  h.ordre = [];
  vi.clearAllMocks();
});

describe("revoquer un appareil coupe la session de rafraichissement de son porteur", () => {
  it("revoque TOUTES les familles du proprietaire (aucun lien appareil-session) et pas celles d'un autre", async () => {
    const r = await request(app()).post(`/api/v2/devices/${APP}/revoke`);
    expect(r.status).toBe(200);
    expect(h.refresh.filter((t) => t.userId === "agent-1").every((t) => t.revokedAt !== null)).toBe(true);
    expect(h.refresh.find((t) => t.userId === "agent-2")!.revokedAt).toBeNull();
  });

  it("dit CLAIREMENT la portee dans la reponse : toutes les sessions du proprietaire, avec leur nombre", async () => {
    const r = await request(app()).post(`/api/v2/devices/${APP}/revoke`);
    expect(r.body.rafraichissement).toEqual({
      revoque: true,
      portee: "TOUTES_LES_SESSIONS_DU_PROPRIETAIRE",
      sessions: 2,
    });
    expect(r.body.revoqueA).toBeTruthy();
  });

  it("une trace SECURITY_EVENT unique, qui porte l'appareil, le porteur et le nombre de sessions coupees", async () => {
    await request(app()).post(`/api/v2/devices/${APP}/revoke`);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      action: "SECURITY_EVENT", entityType: "Appareil", entityId: APP,
      after: { porteur: "agent-1", sessionsRefreshRevoquees: 2, evenement: "APPAREIL_REVOQUE" },
    });
  });

  it("transactionnel : si la trace echoue, ni l'appareil ni les sessions ne sont revoques", async () => {
    h.auditFailure = true;
    const r = await request(app()).post(`/api/v2/devices/${APP}/revoke`);
    expect(r.status).toBe(500);
    expect(h.appareils[APP].revoqueA).toBeNull();
    expect(h.refresh.every((t) => t.revokedAt === null)).toBe(true);
  });

  it("un ADMIN qui revoque l'appareil d'un agent coupe les sessions de L'AGENT, pas les siennes", async () => {
    h.user = { id: "admin-1", role: "ADMIN" };
    h.refresh.push({ id: "t9", userId: "admin-1", familyId: "f9", revokedAt: null });
    const r = await request(app()).post(`/api/v2/devices/${APP}/revoke`);
    expect(r.status).toBe(200);
    expect(h.refresh.filter((t) => t.userId === "agent-1").every((t) => t.revokedAt !== null)).toBe(true);
    expect(h.refresh.find((t) => t.userId === "admin-1")!.revokedAt).toBeNull();
  });

  it("une seconde revocation rend 409 APPAREIL_DEJA_REVOQUE, sans nouvelle trace", async () => {
    await request(app()).post(`/api/v2/devices/${APP}/revoke`);
    const r = await request(app()).post(`/api/v2/devices/${APP}/revoke`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("APPAREIL_DEJA_REVOQUE");
    expect(h.audits).toHaveLength(1);
  });

  it("l'appareil d'un autre compte rend 404, la MEME reponse qu'un appareil inconnu, et ne coupe rien (D9, point 7a)", async () => {
    h.appareils[APP] = appareil(APP, "agent-2");
    const autrui = await request(app()).post(`/api/v2/devices/${APP}/revoke`);
    const inconnu = await request(app()).post(`/api/v2/devices/${uuid(404)}/revoke`);
    expect(autrui.status).toBe(404);
    expect(inconnu.status).toBe(404);
    expect(autrui.body).toEqual(inconnu.body);
    expect(h.refresh.every((t) => t.revokedAt === null)).toBe(true);
    expect(h.ordre).toEqual([]);
  });

  it("verrouille le compte du PROPRIETAIRE (pas celui de l'ADMIN qui agit) avant toute coupure (D9, point 1)", async () => {
    h.user = { id: "admin-1", role: "ADMIN" };
    const r = await request(app()).post(`/api/v2/devices/${APP}/revoke`);
    expect(r.status).toBe(200);
    expect(h.ordre[0]).toMatch(/FOR UPDATE$/);
    expect(h.ordre.slice(1)).toEqual(["appareil.updateMany", "refreshToken.updateMany"]);
  });
});

describe("apres une revocation, le jeton d'acces deja emis n'enregistre plus d'appareil neuf (D9, point 6)", () => {
  it("403 APPAREIL_REVOCATION_RECENTE avec un delai de reessai, aucune ligne creee ; un autre compte n'est pas touche", async () => {
    h.appareils[APP] = appareil(APP, "agent-1", new Date(Date.now() - 60_000));
    const avant = Object.keys(h.appareils).length;
    const r = await request(app()).post("/api/v2/devices").send({ plateforme: "android", nom: "telephone du voleur" });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("APPAREIL_REVOCATION_RECENTE");
    expect(r.body.reessayerDansMs).toBeGreaterThan(13 * 60_000);
    expect(Object.keys(h.appareils)).toHaveLength(avant);
    h.user = { id: "agent-2", role: "INSPECTEUR" };
    expect((await request(app()).post("/api/v2/devices").send({ plateforme: "android" })).status).toBe(201);
  });

  it("au-dela de la duree du jeton d'acces (15 minutes), l'enregistrement redevient possible", async () => {
    h.appareils[APP] = appareil(APP, "agent-1", new Date(Date.now() - 16 * 60_000));
    expect((await request(app()).post("/api/v2/devices").send({ plateforme: "android" })).status).toBe(201);
  });
});

describe("un appareil revoque ne se re-enregistre pas sous le meme identifiant", () => {
  beforeEach(() => {
    h.appareils[APP] = appareil(APP, "agent-1", new Date("2026-10-20T10:00:00Z"));
  });

  it("POST /devices avec l'identifiant d'un appareil revoque : 403 APPAREIL_REVOQUE, rien n'est cree", async () => {
    const avant = Object.keys(h.appareils).length;
    const r = await request(app()).post("/api/v2/devices").send({ plateforme: "android", appareilId: APP });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("APPAREIL_REVOQUE");
    expect(Object.keys(h.appareils)).toHaveLength(avant);
    expect(h.appareils[APP].revoqueA).not.toBeNull();
  });

  it("identifiant inconnu : 403 APPAREIL_INCONNU, distinct", async () => {
    const r = await request(app()).post("/api/v2/devices").send({ plateforme: "android", appareilId: uuid(77) });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("APPAREIL_INCONNU");
  });

  it("identifiant d'un appareil d'un autre compte : APPAREIL_INCONNU (rien n'est revele sur autrui)", async () => {
    h.appareils[APP] = appareil(APP, "agent-2", new Date());
    const r = await request(app()).post("/api/v2/devices").send({ plateforme: "android", appareilId: APP });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("APPAREIL_INCONNU");
  });

  it("identifiant d'un appareil ACTIF du compte : 200, meme appareil, aucun doublon", async () => {
    h.appareils[APP] = appareil(APP, "agent-1");
    const avant = Object.keys(h.appareils).length;
    const r = await request(app()).post("/api/v2/devices").send({ plateforme: "android", appareilId: APP });
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(APP);
    expect(Object.keys(h.appareils)).toHaveLength(avant);
  });

  it("sans identifiant : l'enregistrement d'un NOUVEL appareil continue de marcher (201)", async () => {
    const r = await request(app()).post("/api/v2/devices").send({ plateforme: "android" });
    expect(r.status).toBe(201);
  });
});

describe("sync/push distingue appareil inconnu et appareil revoque", () => {
  const pousser = (appareilId = APP) => request(app()).post("/api/v2/sync/push").send({ appareilId, operations: [op(1)] });

  it("appareil REVOQUE du compte : 403 APPAREIL_REVOQUE, et rien n'est applique", async () => {
    h.appareils[APP] = appareil(APP, "agent-1", new Date());
    const r = await pousser();
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("APPAREIL_REVOQUE");
    expect(r.body.message).not.toMatch(/^Appareil inconnu, révoqué/);
    expect(h.applique).toHaveLength(0);
  });

  it("appareil INCONNU : 403 APPAREIL_INCONNU, avec le message historique que les clients deja deployes reconnaissent", async () => {
    const r = await pousser(uuid(55));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("APPAREIL_INCONNU");
    expect(r.body.message).toMatch(/^Appareil inconnu, révoqué/);
    expect(h.applique).toHaveLength(0);
  });

  it("appareil REVOQUE d'un AUTRE compte : APPAREIL_INCONNU, jamais APPAREIL_REVOQUE (pas d'oracle sur les appareils d'autrui)", async () => {
    h.appareils[APP] = appareil(APP, "agent-2", new Date());
    const r = await pousser();
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("APPAREIL_INCONNU");
  });

  it("appareil actif d'un autre compte : APPAREIL_INCONNU", async () => {
    h.appareils[APP] = appareil(APP, "agent-2");
    expect((await pousser()).body.code).toBe("APPAREIL_INCONNU");
  });

  it("GET /sync/status d'un appareil revoque : 403 APPAREIL_REVOQUE pour son porteur", async () => {
    h.appareils[APP] = appareil(APP, "agent-1", new Date());
    const r = await request(app()).get(`/api/v2/sync/status?appareilId=${APP}`);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("APPAREIL_REVOQUE");
  });

  it("GET /sync/status d'un appareil inconnu : 404 inchange", async () => {
    const r = await request(app()).get(`/api/v2/sync/status?appareilId=${uuid(66)}`);
    expect(r.status).toBe(404);
  });
});

describe("sync/push : module retire = refus de droits trace, pas un 403 muet", () => {
  it("chaque operation est REJETE DROITS_MODIFIES (cause MODULE_RETIRE), definitive, sans delai de reessai", async () => {
    h.modulePermis = false;
    const r = await request(app()).post("/api/v2/sync/push").send({ appareilId: APP, operations: [op(1), op(2)] });
    expect(r.status).toBe(200);
    expect(r.body.resultats).toEqual([
      { operationId: uuid(1), statut: "REJETE", motif: "DROITS_MODIFIES", cause: "MODULE_RETIRE", definitif: true },
      { operationId: uuid(2), statut: "REJETE", motif: "DROITS_MODIFIES", cause: "MODULE_RETIRE", definitif: true },
    ]);
    expect(r.body.rejetees).toBe(2);
    expect(r.body.refusDroits).toBe(2);
    expect(h.applique).toHaveLength(0);
    expect(h.traces.map((t) => t.cause)).toEqual(["MODULE_RETIRE", "MODULE_RETIRE"]);
  });

  it("au plus 20 refus sont TRACES par appel : les suivants sont rendus pareils, sans trace, et comptes dans refusNonTraces (D9, point 4)", async () => {
    h.modulePermis = false;
    const operations = Array.from({ length: 30 }, (_, i) => op(100 + i));
    const r = await request(app()).post("/api/v2/sync/push").send({ appareilId: APP, operations });
    expect(r.status).toBe(200);
    expect(r.body.refusDroits).toBe(30);
    expect(r.body.refusNonTraces).toBe(10);
    expect(h.traces.filter((t) => t.tracer)).toHaveLength(20);
    expect(h.traces.filter((t) => !t.tracer)).toHaveLength(10);
    // Meme motif, meme cause, meme caractere definitif pour tous : le client ne voit pas la difference.
    expect(new Set(r.body.resultats.map((x: Record<string, unknown>) => `${x.motif}|${x.cause}|${x.definitif}`))).toEqual(new Set(["DROITS_MODIFIES|MODULE_RETIRE|true"]));
  });

  it("un appel sous le plafond n'a aucun refus non trace", async () => {
    h.modulePermis = false;
    const r = await request(app()).post("/api/v2/sync/push").send({ appareilId: APP, operations: [op(1), op(2)] });
    expect(r.body.refusNonTraces).toBe(0);
    expect(h.traces.every((t) => t.tracer)).toBe(true);
  });

  it("un appareil revoque l'emporte sur le module retire (le client doit d'abord apprendre qu'il est revoque)", async () => {
    h.modulePermis = false;
    h.appareils[APP] = appareil(APP, "agent-1", new Date());
    const r = await request(app()).post("/api/v2/sync/push").send({ appareilId: APP, operations: [op(1)] });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("APPAREIL_REVOQUE");
    expect(h.traces).toHaveLength(0);
  });

  it("module present : le chemin normal est inchange, aucune trace de droits", async () => {
    const r = await request(app()).post("/api/v2/sync/push").send({ appareilId: APP, operations: [op(1)] });
    expect(r.status).toBe(200);
    expect(r.body.synchronisees).toBe(1);
    expect(r.body.refusDroits).toBe(0);
    expect(h.traces).toHaveLength(0);
  });
});

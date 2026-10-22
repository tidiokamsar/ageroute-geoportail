import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Controle territorial (A10) : compte NATIONAL ici, le sujet de ce fichier est ailleurs. Le
// controle lui-meme est eprouve par territoire/*.test.ts et api-v2/perimetres.routes.test.ts.
vi.mock("../territoire/territoire.service", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  perimetreDe: async () => ({ national: true }),
}));

/**
 * `/api/v2/sync` — la surface qui recoit le terrain.
 *
 * CE QUE CES TESTS DEFENDENT
 *
 * Trois proprietes que rien d'autre ne garantit, et dont la violation ne se verrait
 * qu'a la perte de donnees.
 *
 * UN APPAREIL REVOQUE N'ECRIT PAS. Revoquer un telephone perdu ne sert a rien s'il
 * peut encore vider sa file dans le referentiel national.
 *
 * LE LOT EST PLAFONNE. Chaque operation ouvre une transaction ; un lot de mille en
 * tiendrait une pendant des minutes et bloquerait les ecritures des autres. Le
 * 07/10, une requete dimensionnee sans y penser a occupe la base de production
 * dix-sept minutes.
 *
 * LES OPERATIONS SONT APPLIQUEES EN SERIE. Deux operations d'un meme lot peuvent
 * porter sur la meme entite : la seconde doit voir le resultat de la premiere, sans
 * quoi elle partirait d'une version perimee et entrerait en conflit avec son propre
 * predecesseur.
 */

const compte = { id: "u1", role: "INSPECTEUR" as string };

vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: compte.id, role: compte.role };
    n();
  },
}));
vi.mock("../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_q: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));

/**
 * `vi.mock` est remonte au-dessus des declarations du fichier : une fabrique qui
 * reference un `const` ordinaire echoue sur « Cannot access before initialization ».
 * `vi.hoisted` remonte l'etat partage avec elles.
 */
const h = vi.hoisted(() => ({
  appareilTrouve: true,
  appareilUserId: "u1",
  majAppareil: vi.fn(async () => ({})),
  applique: [] as string[],
  observations: [] as Array<Record<string, unknown>>,
  defauts: [] as Array<Record<string, unknown>>,
  missions: [] as Array<{ id: string }>,
  observationWhere: null as Record<string, unknown> | null,
  defautWhere: null as Record<string, unknown> | null,
  conflit: null as Record<string, unknown> | null,
  operationOwnerId: "u1",
  operation: "UPDATE",
  operationEntityType: "Observation",
  operationEntityId: "observation-1",
  observationCurrent: null as Record<string, unknown> | null,
  forceConflictClaimFailure: false,
  forceObservationCompareFailure: false,
  audits: [] as Array<Record<string, unknown>>,
  operationStatus: null as Record<string, unknown> | null,
  missionAccessible: true,
}));

vi.mock("../utils/audit", () => ({
  logAudit: vi.fn(),
  logAuditTransactionnelle: vi.fn(async (tx: { auditLog: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> } }, p: Record<string, unknown>) => tx.auditLog.create({ data: p })),
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    appareil: {
      findFirst: vi.fn(async () => (h.appareilTrouve ? { id: "a1", userId: h.appareilUserId } : null)),
      findUnique: vi.fn(async () => ({ id: "a1", userId: h.appareilUserId })),
      update: h.majAppareil,
    },
    mission: { findMany: vi.fn(async () => h.missions) },
    observation: { findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => { h.observationWhere = where; return h.observations; }) },
    defaut: { findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => { h.defautWhere = where; return h.defauts; }) },
    operationSync: {
      findUnique: vi.fn(async () => ({
        userId: h.operationOwnerId,
        operation: h.operation,
        entityType: h.operationEntityType,
        entityId: h.operationEntityId,
      })),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { h.operationStatus = data; return { count: 1 }; }),
    },
    conflitSync: { findUnique: vi.fn(async () => h.conflit) },
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => {
      const resolutionInitiale = h.conflit?.resolution;
      const observationInitiale = h.observationCurrent ? { ...h.observationCurrent } : null;
      const tx = {
        conflitSync: {
          updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
            if (h.forceConflictClaimFailure || !h.conflit || h.conflit.resolution) return { count: 0 };
            h.conflit.resolution = data.resolution;
            return { count: 1 };
          }),
        },
        observation: {
          findUnique: vi.fn(async () => h.observationCurrent),
          updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            if (h.forceObservationCompareFailure || !h.observationCurrent || where.version !== h.observationCurrent.version) return { count: 0 };
            const versionUpdate = data.version as { increment?: number } | undefined;
            h.observationCurrent = {
              ...h.observationCurrent,
              ...data,
              ...(versionUpdate?.increment ? { version: Number(h.observationCurrent.version) + versionUpdate.increment } : {}),
            };
            return { count: 1 };
          }),
        },
        mission: { findFirst: vi.fn(async () => h.missionAccessible ? { id: "m1" } : null) },
        operationSync: { updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { h.operationStatus = data; return { count: 1 }; }) },
        auditLog: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { h.audits.push(data); return data; }) },
      };
      try {
        return await run(tx);
      } catch (err) {
        if (h.conflit) h.conflit.resolution = resolutionInitiale;
        h.observationCurrent = observationInitiale;
        throw err;
      }
    }),
  },
}));

vi.mock("../field/sync.service", () => ({
  TYPES_ACCEPTES: new Set(["Observation", "Defaut"]),
  OPERATIONS_ACCEPTEES: { Observation: ["CREATE", "UPDATE", "DELETE"], Defaut: ["CREATE"] },
  appliquer: vi.fn(async (op: { operationId: string }) => {
    h.applique.push(op.operationId);
    return { operationId: op.operationId, statut: "SYNCHRONISE", entityId: "e1", version: 2 };
  }),
  statutAppareil: vi.fn(async (id: string) => ({
    appareilId: id, operations: { SYNCHRONISE: 3 }, conflitsNonResolus: 1, derniereOperationA: null,
  })),
}));

import { syncV2Router, LOT_MAX_OPERATIONS } from "./sync.routes";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const op = (n: number) => ({
  operationId: uuid(n), entityType: "Observation", entityId: "e1",
  operation: "UPDATE" as const, baseVersion: 1, payload: { description: "x" },
});

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/v2/sync", syncV2Router);
  a.use((e: Error & { name?: string }, _q: express.Request, s: express.Response, _n: express.NextFunction) => {
    s.status(e.name === "ZodError" ? 400 : 500).json({ erreur: e.name });
  });
  return a;
}

beforeEach(() => {
  compte.id = "u1";
  compte.role = "INSPECTEUR";
  h.applique.length = 0;
  h.appareilTrouve = true;
  h.appareilUserId = "u1";
  h.observations = [];
  h.defauts = [];
  h.missions = [];
  h.observationWhere = null;
  h.defautWhere = null;
  h.conflit = null;
  h.operationOwnerId = "u1";
  h.operation = "UPDATE";
  h.operationEntityType = "Observation";
  h.operationEntityId = "observation-1";
  h.observationCurrent = null;
  h.forceConflictClaimFailure = false;
  h.forceObservationCompareFailure = false;
  h.audits = [];
  h.operationStatus = null;
  h.missionAccessible = true;
  h.majAppareil.mockClear();
});

describe("POST /push", () => {
  it("applique les operations et compte les issues", async () => {
    const r = await request(app()).post("/api/v2/sync/push")
      .send({ appareilId: uuid(9), operations: [op(1), op(2)] });

    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    expect(r.body.synchronisees).toBe(2);
    // Conflits comptes a part des rejets : un conflit attend un humain, pas un
    // reessai, et les confondre ferait boucler un client a vide.
    expect(r.body).toHaveProperty("conflits", 0);
    expect(r.body).toHaveProperty("rejetees", 0);
  });

  it("REFUSE un appareil revoque ou inconnu", async () => {
    h.appareilTrouve = false;
    const r = await request(app()).post("/api/v2/sync/push")
      .send({ appareilId: uuid(9), operations: [op(1)] });

    expect(r.status).toBe(403);
    // Et surtout : rien n'a ete applique.
    expect(h.applique).toHaveLength(0);
  });

  it("refuse un appareil actif appartenant à un autre compte", async () => {
    h.appareilUserId = "u2";
    const r = await request(app()).post("/api/v2/sync/push")
      .send({ appareilId: uuid(9), operations: [op(1)] });
    expect(r.status).toBe(403);
    expect(h.applique).toHaveLength(0);
  });

  it("applique EN SERIE, dans l'ordre recu", async () => {
    await request(app()).post("/api/v2/sync/push")
      .send({ appareilId: uuid(9), operations: [op(1), op(2), op(3)] });
    expect(h.applique).toEqual([uuid(1), uuid(2), uuid(3)]);
  });

  it("PLAFONNE le lot", async () => {
    const trop = Array.from({ length: LOT_MAX_OPERATIONS + 1 }, (_, i) => op(i + 1));
    const r = await request(app()).post("/api/v2/sync/push").send({ appareilId: uuid(9), operations: trop });
    expect(r.status).toBe(400);
    expect(h.applique).toHaveLength(0);
  });

  it("refuse un lot vide", async () => {
    expect((await request(app()).post("/api/v2/sync/push")
      .send({ appareilId: uuid(9), operations: [] })).status).toBe(400);
  });

  it("exige un operationId en forme d'UUID", async () => {
    // La cle d'idempotence doit etre generee, pas bricolee : « 1 » ou « obs-derniere »
    // se repeterait d'un appareil a l'autre et deux agents s'annuleraient.
    const r = await request(app()).post("/api/v2/sync/push")
      .send({ appareilId: uuid(9), operations: [{ ...op(1), operationId: "pas-un-uuid" }] });
    expect(r.status).toBe(400);
  });

  it("note le passage de l'appareil", async () => {
    await request(app()).post("/api/v2/sync/push").send({ appareilId: uuid(9), operations: [op(1)] });
    expect(h.majAppareil).toHaveBeenCalledOnce();
  });
});

describe("POST /pull", () => {
  it("accepte une demande sans horodatage, qui vaut depuis l'origine", async () => {
    const r = await request(app()).post("/api/v2/sync/pull").send({});
    expect(r.status).toBe(200);
    expect(r.body.observations).toEqual([]);
    // `complet` dit au client s'il doit redemander, au lieu de le lui faire deviner
    // en comparant des longueurs.
    expect(r.body.complet).toBe(true);
  });

  it("permet au client de redescendre les défauts sans changer le pull Observation par défaut", async () => {
    const updatedAt = new Date("2026-10-08T10:00:00.000Z");
    h.defauts = [{ id: "d1", updatedAt, deletedAt: new Date("2026-10-08T10:00:00.000Z") }];

    const r = await request(app()).post("/api/v2/sync/pull").send({ entityType: "Defaut" });

    expect(r.status).toBe(200);
    expect(r.body.entityType).toBe("Defaut");
    expect(r.body.defauts).toHaveLength(1);
    expect(r.body.defauts[0].deletedAt).not.toBeNull();
    expect(r.body.complet).toBe(true);
  });

  it("limite le pull des défauts aux missions affectées ou aux relevés du compte", async () => {
    h.missions = [{ id: "mission-1" }];
    await request(app()).post("/api/v2/sync/pull").send({ entityType: "Defaut" });
    expect(h.defautWhere).toMatchObject({
      OR: [
        { constateParId: "u1" },
        { missionId: { in: ["mission-1"] } },
      ],
    });
  });

  it("ne renvoie rien pour une mission non affectée au compte terrain", async () => {
    const r = await request(app()).post("/api/v2/sync/pull")
      .send({ entityType: "Observation", missionId: "00000000-0000-4000-8000-000000000002" });
    expect(r.status).toBe(200);
    expect(r.body.observations).toEqual([]);
    expect(h.observationWhere).toBeNull();
  });

  it("refuse une limite au-dela du plafond", async () => {
    expect((await request(app()).post("/api/v2/sync/pull").send({ limite: 100000 })).status).toBe(400);
  });

  it("refuse un horodatage qui n'en est pas un", async () => {
    expect((await request(app()).post("/api/v2/sync/pull").send({ depuis: "hier" })).status).toBe(400);
  });
});

describe("POST /resolve", () => {
  it("ne connait que LOCAL et SERVEUR", async () => {
    // Pas de « fusion automatique » : elle produirait un troisieme etat que personne
    // n'a vu ni valide.
    const r = await request(app()).post("/api/v2/sync/resolve")
      .send({ conflitId: uuid(5), resolution: "FUSION" });
    expect(r.status).toBe(400);
  });

  it("rend 404 sur un conflit inconnu", async () => {
    const r = await request(app()).post("/api/v2/sync/resolve")
      .send({ conflitId: uuid(5), resolution: "LOCAL" });
    expect(r.status).toBe(404);
  });

  it("ne remplace pas un défaut existant par une création locale en conflit", async () => {
    compte.role = "GESTIONNAIRE";
    h.conflit = {
      id: uuid(5), operationId: uuid(6), entityType: "Defaut", entityId: "defaut-1", resolution: null,
    };
    h.operation = "CREATE";
    h.operationEntityType = "Defaut";
    h.operationEntityId = "defaut-1";

    const r = await request(app()).post("/api/v2/sync/resolve")
      .send({ conflitId: uuid(5), resolution: "LOCAL" });

    expect(r.status).toBe(409);
    expect(r.body.motif).toBe("NOUVEL_IDENTIFIANT_REQUIS");
  });

  it("refuse à un agent de trancher le conflit d'un autre compte", async () => {
    h.conflit = {
      id: uuid(5), operationId: uuid(6), entityType: "Observation", entityId: "observation-1", resolution: null,
    };
    h.operationOwnerId = "u2";
    const r = await request(app()).post("/api/v2/sync/resolve")
      .send({ conflitId: uuid(5), resolution: "SERVEUR" });
    expect(r.status).toBe(404);
  });

  it("n'applique pas un champ système fourni dans la version locale", async () => {
    h.conflit = {
      id: uuid(5), operationId: uuid(6), entityType: "Observation", entityId: "observation-1",
      resolution: null, payloadLocal: { statut: "VALIDEE", description: "Texte" }, payloadServeur: { version: 1 },
    };
    h.observationCurrent = { id: "observation-1", agentId: "u1", statut: "PROPOSEE", version: 1, deletedAt: null };

    const r = await request(app()).post("/api/v2/sync/resolve")
      .send({ conflitId: uuid(5), resolution: "LOCAL" });

    expect(r.status).toBe(409);
    expect(h.observationCurrent.statut).toBe("PROPOSEE");
    expect(h.audits).toHaveLength(0);
  });

  it("applique une version locale valide avec compare-et-échange et audit atomique", async () => {
    h.conflit = {
      id: uuid(5), operationId: uuid(6), entityType: "Observation", entityId: "observation-1",
      resolution: null, payloadLocal: { description: "Version retenue" }, payloadServeur: { version: 1 },
    };
    h.observationCurrent = { id: "observation-1", agentId: "u1", statut: "PROPOSEE", version: 1, deletedAt: null };

    const r = await request(app()).post("/api/v2/sync/resolve")
      .send({ conflitId: uuid(5), resolution: "LOCAL" });

    expect(r.status).toBe(200);
    expect(h.observationCurrent).toMatchObject({ description: "Version retenue", version: 2 });
    expect(h.conflit?.resolution).toBe("LOCAL");
    expect(h.operationStatus?.statut).toBe("SYNCHRONISE");
    expect(h.audits).toHaveLength(1);
  });

  it("répond 409 si un autre arbitre a déjà revendiqué le conflit", async () => {
    h.conflit = {
      id: uuid(5), operationId: uuid(6), entityType: "Observation", entityId: "observation-1",
      resolution: null, payloadLocal: { description: "Version locale" }, payloadServeur: { version: 1 },
    };
    h.forceConflictClaimFailure = true;

    const r = await request(app()).post("/api/v2/sync/resolve")
      .send({ conflitId: uuid(5), resolution: "SERVEUR" });

    expect(r.status).toBe(409);
    expect(h.operationStatus).toBeNull();
  });
});

describe("GET /status", () => {
  it("rend l'etat et les types reellement acceptes", async () => {
    const r = await request(app()).get(`/api/v2/sync/status?appareilId=${uuid(9)}`);
    expect(r.status).toBe(200);
    expect(r.body.conflitsNonResolus).toBe(1);
    // Annoncer les types supportes evite qu'un client decouvre au bout de 100
    // operations que son type n'est pas traite.
    expect(r.body.typesAcceptes).toEqual(["Observation", "Defaut"]);
    expect(r.body.operationsAcceptees.Defaut).toEqual(["CREATE"]);
  });

  it("ne révèle pas le statut d'un appareil appartenant à un autre compte", async () => {
    h.appareilUserId = "u2";
    const r = await request(app()).get(`/api/v2/sync/status?appareilId=${uuid(9)}`);
    expect(r.status).toBe(404);
  });

  it("exige l'identifiant d'appareil", async () => {
    expect((await request(app()).get("/api/v2/sync/status")).status).toBe(400);
  });
});

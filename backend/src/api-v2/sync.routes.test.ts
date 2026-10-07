import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

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
  majAppareil: vi.fn(async () => ({})),
  applique: [] as string[],
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    appareil: {
      findFirst: vi.fn(async () => (h.appareilTrouve ? { id: "a1", userId: "u1" } : null)),
      update: h.majAppareil,
    },
    observation: { findMany: vi.fn(async () => []) },
    conflitSync: { findUnique: vi.fn(async () => null) },
  },
}));

vi.mock("../field/sync.service", () => ({
  TYPES_ACCEPTES: new Set(["Observation"]),
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

beforeEach(() => { h.applique.length = 0; h.appareilTrouve = true; h.majAppareil.mockClear(); });

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
});

describe("GET /status", () => {
  it("rend l'etat et les types reellement acceptes", async () => {
    const r = await request(app()).get(`/api/v2/sync/status?appareilId=${uuid(9)}`);
    expect(r.status).toBe(200);
    expect(r.body.conflitsNonResolus).toBe(1);
    // Annoncer les types supportes evite qu'un client decouvre au bout de 100
    // operations que son type n'est pas traite.
    expect(r.body.typesAcceptes).toEqual(["Observation"]);
  });

  it("exige l'identifiant d'appareil", async () => {
    expect((await request(app()).get("/api/v2/sync/status")).status).toBe(400);
  });
});

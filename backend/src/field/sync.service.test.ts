import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  catalogue: {
    id: 2,
    code: "ORNIERAGE",
    unite: "METRE",
    mesuresRequises: ["LONGUEUR", "PROFONDEUR"],
    graviteMax: 4,
    actif: true,
  },
  operationExists: null as Record<string, unknown> | null,
  defautExists: null as Record<string, unknown> | null,
  observationRead: null as Record<string, unknown> | null,
  observationCurrent: null as Record<string, unknown> | null,
  observationCreated: null as Record<string, unknown> | null,
  observationUpdates: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
  missionAccessible: true,
  forceObservationCompareFailure: false,
  operationsTracees: [] as Array<Record<string, unknown>>,
  defautsCrees: [] as Array<Record<string, unknown>>,
  qualites: [] as Array<Record<string, unknown>>,
  setPointGeom: vi.fn(async () => {}),
  deriveGeomFromTroncon: vi.fn(async () => true),
  deriveGeomFromTronconAbscisse: vi.fn(async () => true),
  logAudit: vi.fn(async (_params?: Record<string, unknown>) => {}),
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    operationSync: {
      findUnique: vi.fn(async () => h.operationExists),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { h.operationsTracees.push(data); return data; }),
    },
    defaut: { findUnique: vi.fn(async () => h.defautExists) },
    observation: { findUnique: vi.fn(async () => h.observationRead) },
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run({
      operationSync: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { h.operationsTracees.push(data); return data; }),
      },
      catalogueDefaut: { findUnique: vi.fn(async () => h.catalogue) },
      troncon: { findFirst: vi.fn(async () => null) },
      mission: { findFirst: vi.fn(async () => h.missionAccessible ? ({ id: "m1" }) : null) },
      observation: {
        findFirst: vi.fn(async () => ({ id: "o1", missionId: null })),
        findUnique: vi.fn(async () => h.observationCurrent),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          h.observationCreated = { ...data, version: 1, deletedAt: null };
          h.observationCurrent = h.observationCreated;
          return h.observationCreated;
        }),
        updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          h.observationUpdates.push({ where, data });
          if (!h.observationCurrent || h.forceObservationCompareFailure) {
            if (h.forceObservationCompareFailure && h.observationCurrent) {
              h.observationCurrent = { ...h.observationCurrent, version: Number(h.observationCurrent.version) + 1 };
            }
            return { count: 0 };
          }
          if (where.version !== h.observationCurrent.version || where.agentId !== h.observationCurrent.agentId) return { count: 0 };
          h.observationCurrent = { ...h.observationCurrent, ...data };
          return { count: 1 };
        }),
      },
      conflitSync: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "conflict-1", ...data })),
      },
      defaut: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const cree = { ...data, version: 1, updatedAt: new Date("2026-10-08T10:00:00Z") };
          h.defautsCrees.push(cree);
          return cree;
        }),
      },
      valeurQualite: {
        upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => { h.qualites.push(create); return create; }),
      },
    })),
  },
}));

vi.mock("../lib/geo", () => ({
  setPointGeom: h.setPointGeom,
  deriveGeomFromTroncon: h.deriveGeomFromTroncon,
  deriveGeomFromTronconAbscisse: h.deriveGeomFromTronconAbscisse,
}));
vi.mock("../utils/audit", () => ({
  logAudit: h.logAudit,
  logAuditTransactionnelle: vi.fn(async (_tx: unknown, params: Record<string, unknown>) => { h.logAudit(params); }),
}));

import { appliquer } from "./sync.service";

const contexte = { appareilId: "device-1", userId: "agent-1" };
const operationId = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  h.operationExists = null;
  h.defautExists = null;
  h.observationRead = null;
  h.observationCurrent = null;
  h.observationCreated = null;
  h.observationUpdates = [];
  h.missionAccessible = true;
  h.forceObservationCompareFailure = false;
  h.operationsTracees = [];
  h.defautsCrees = [];
  h.qualites = [];
  vi.clearAllMocks();
});

describe("synchronisation des défauts", () => {
  it("crée un défaut proposé, mesure la quantité et conserve la provenance", async () => {
    const resultat = await appliquer({
      operationId,
      entityType: "Defaut",
      entityId: "defaut-1",
      operation: "CREATE",
      baseVersion: null,
      payload: {
        catalogueCode: "ORNIERAGE",
        lat: 9.5,
        lon: -13.7,
        mesures: { longueurM: 50, profondeurM: 0.04 },
        gravite: 2,
      },
    }, contexte);

    expect(resultat).toMatchObject({ statut: "SYNCHRONISE", entityId: "defaut-1", version: 1 });
    expect(h.defautsCrees[0]).toMatchObject({
      id: "defaut-1",
      clientOperationId: operationId,
      constateParId: "agent-1",
      statutValidation: "A_VALIDER",
      quantite: 50,
      methodeQuantite: "LONGUEUR",
    });
    expect(h.qualites[0]).toMatchObject({ entityType: "Defaut", champ: "quantite", statut: "DERIVED" });
    expect(h.operationsTracees[0]).toMatchObject({ entityType: "Defaut", statut: "SYNCHRONISE" });
    expect(h.setPointGeom).toHaveBeenCalledWith("defauts", "defaut-1", 9.5, -13.7);
  });

  it("refuse un payload qui tente de choisir l'auteur ou le statut officiel", async () => {
    const resultat = await appliquer({
      operationId,
      entityType: "Defaut",
      entityId: "defaut-1",
      operation: "CREATE",
      baseVersion: null,
      payload: {
        catalogueCode: "ORNIERAGE",
        lat: 9.5,
        lon: -13.7,
        constateParId: "autre-agent",
        statutValidation: "VALIDE",
      },
    }, contexte);

    expect(resultat.statut).toBe("REJETE");
    expect(resultat.motif).toContain("PAYLOAD_INVALIDE");
    expect(h.defautsCrees).toHaveLength(0);
    expect(h.operationsTracees[0]).toMatchObject({ statut: "REJETE" });
    expect(h.operationsTracees[0].payload).toEqual({ redacted: true });
  });

  it("ne révèle pas l'identifiant d'une opération connue d'un autre compte", async () => {
    h.operationExists = { entityId: "secret-defaut", statut: "SYNCHRONISE", userId: "agent-2" };
    const resultat = await appliquer({
      operationId,
      entityType: "Defaut",
      entityId: "defaut-1",
      operation: "CREATE",
      baseVersion: null,
      payload: {},
    }, contexte);

    expect(resultat).toMatchObject({ statut: "REJETE", motif: "OPERATION_NON_AUTORISEE" });
    expect(resultat).not.toHaveProperty("entityId");
  });

  it("ne révèle pas un défaut existant sous une clé d'idempotence d'un autre auteur", async () => {
    h.defautExists = { id: "secret-defaut", version: 1, constateParId: "agent-2" };
    const resultat = await appliquer({
      operationId,
      entityType: "Defaut",
      entityId: "defaut-1",
      operation: "CREATE",
      baseVersion: null,
      payload: { catalogueCode: "ORNIERAGE", lat: 9.5, lon: -13.7 },
    }, contexte);

    expect(resultat).toMatchObject({ statut: "REJETE", motif: "OPERATION_NON_AUTORISEE" });
    expect(resultat).not.toHaveProperty("entityId");
    expect(h.operationsTracees).toHaveLength(0);
  });

  it("rejette les mises à jour de défaut tant que les transitions métier dédiées ne sont pas synchronisables", async () => {
    const resultat = await appliquer({
      operationId,
      entityType: "Defaut",
      entityId: "defaut-1",
      operation: "UPDATE",
      baseVersion: 1,
      payload: { etat: "TRAITE" },
    }, contexte);

    expect(resultat).toMatchObject({ statut: "REJETE", motif: "OPERATION_NON_SUPPORTEE:Defaut:UPDATE" });
    expect(h.defautsCrees).toHaveLength(0);
  });
});

describe("synchronisation des observations", () => {
  it("attribue l'auteur au compte authentifié et crée une proposition", async () => {
    const resultat = await appliquer({
      operationId,
      entityType: "Observation",
      entityId: "observation-1",
      operation: "CREATE",
      baseVersion: null,
      payload: { type: "CHAUSSEE", observeA: "2026-10-08T10:00:00.000Z", description: "Fissure" },
    }, contexte);

    expect(resultat.statut).toBe("SYNCHRONISE");
    expect(h.observationCreated).toMatchObject({
      id: "observation-1",
      clientOperationId: operationId,
      agentId: "agent-1",
      statut: "PROPOSEE",
      type: "CHAUSSEE",
      observeA: new Date("2026-10-08T10:00:00.000Z"),
    });
    expect(h.observationCreated).not.toHaveProperty("validateurId");
  });

  it("rejette et masque les payloads qui essaient de choisir auteur ou validation", async () => {
    const resultat = await appliquer({
      operationId,
      entityType: "Observation",
      entityId: "observation-1",
      operation: "CREATE",
      baseVersion: null,
      payload: {
        type: "CHAUSSEE", observeA: "2026-10-08T10:00:00.000Z",
        statut: "VALIDEE", validateurId: "agent-1", agentId: "agent-2",
      },
    }, contexte);

    expect(resultat).toMatchObject({ statut: "REJETE", motif: "PAYLOAD_INVALIDE:Observation" });
    expect(h.observationCreated).toBeNull();
    expect(h.operationsTracees[0].payload).toEqual({ redacted: true });
  });

  it("rejette une création rattachée à une mission hors périmètre", async () => {
    h.missionAccessible = false;
    const resultat = await appliquer({
      operationId,
      entityType: "Observation",
      entityId: "observation-1",
      operation: "CREATE",
      baseVersion: null,
      payload: {
        type: "CHAUSSEE", observeA: "2026-10-08T10:00:00.000Z",
        missionId: "00000000-0000-4000-8000-000000000002",
      },
    }, contexte);

    expect(resultat).toMatchObject({ statut: "REJETE", motif: "MISSION_NON_AUTORISEE" });
    expect(h.observationCreated).toBeNull();
    expect(h.operationsTracees[0].payload).toEqual({ redacted: true });
  });

  it("applique une mise à jour de son auteur avec comparaison atomique de version", async () => {
    h.observationRead = { id: "observation-1", version: 3 };
    h.observationCurrent = {
      id: "observation-1", version: 3, agentId: "agent-1", statut: "PROPOSEE", deletedAt: null,
    };
    const resultat = await appliquer({
      operationId,
      entityType: "Observation",
      entityId: "observation-1",
      operation: "UPDATE",
      baseVersion: 3,
      payload: { description: "Description corrigée" },
    }, contexte);

    expect(resultat).toMatchObject({ statut: "SYNCHRONISE", version: 4 });
    expect(h.observationUpdates[0]).toMatchObject({
      where: { id: "observation-1", version: 3, agentId: "agent-1", deletedAt: null },
      data: { description: "Description corrigée", version: 4 },
    });
  });

  it("conserve un conflit si la version change entre lecture et mise à jour", async () => {
    h.observationRead = { id: "observation-1", version: 3 };
    h.observationCurrent = {
      id: "observation-1", version: 3, agentId: "agent-1", statut: "PROPOSEE", deletedAt: null,
    };
    h.forceObservationCompareFailure = true;
    const resultat = await appliquer({
      operationId,
      entityType: "Observation",
      entityId: "observation-1",
      operation: "UPDATE",
      baseVersion: 3,
      payload: { description: "Description concurrente" },
    }, contexte);

    expect(resultat).toMatchObject({ statut: "CONFLIT", motif: "VERSION_MODIFIEE", conflitId: "conflict-1" });
    expect(h.observationCurrent?.version).toBe(4);
    expect(h.operationsTracees[0]).toMatchObject({ statut: "CONFLIT" });
  });

  it("refuse les modifications d'une observation d'un autre auteur", async () => {
    h.observationRead = { id: "observation-1", version: 2 };
    h.observationCurrent = {
      id: "observation-1", version: 2, agentId: "agent-2", statut: "PROPOSEE", deletedAt: null,
    };
    const resultat = await appliquer({
      operationId,
      entityType: "Observation",
      entityId: "observation-1",
      operation: "UPDATE",
      baseVersion: 2,
      payload: { description: "Tenter une modification tierce" },
    }, contexte);

    expect(resultat).toMatchObject({ statut: "REJETE", motif: "OPERATION_NON_AUTORISEE" });
    expect(h.observationUpdates).toHaveLength(0);
  });
});

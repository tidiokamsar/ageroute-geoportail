import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `DROITS_MODIFIES` : un refus de DROITS au rejeu est trace durablement, avec un motif stable distinct
 * d'un refus de DONNEE (chantier D4, point 4 ; `docs/securite/SESSION-HORS-LIGNE.md` section 8).
 *
 * LE DEFAUT QUE CES TESTS REPRODUISENT
 *
 * Le perimetre territorial etait controle dans la route, AVANT `appliquer`, et une operation hors
 * perimetre etait « rejetee seule et non enregistree » : aucune ligne dans `operations_sync`, aucun
 * motif durable, donc rien a montrer a l'agent ni a l'administrateur, et un client qui ne savait pas si
 * le refus etait definitif. Le retrait d'un module repondait un 403 muet pour tout le lot.
 *
 * CE QUE LE CORRECTIF GARANTIT
 *
 *  1. Le refus est une LIGNE de `operations_sync` : REJETE, `derniereErreur = DROITS_MODIFIES:<cause>`,
 *     payload CAVIARDE (le contenu d'une operation refusee n'est pas conserve).
 *  2. L'IDEMPOTENCE PASSE AVANT LES DROITS : une operation deja appliquee puis rejouee apres un changement
 *     de perimetre rend son resultat precedent ; elle n'est pas ecrasee par un refus.
 *  3. Le refus est DEFINITIF POUR CES DROITS (`definitif: true`, pas de `reessayerDansMs`) mais RETENTABLE
 *     par un renvoi explicite : si les droits sont rendus, la meme operation est reevaluee et appliquee.
 */

const h = vi.hoisted(() => ({
  lignes: new Map<string, Record<string, unknown>>(),
  ecritures: [] as Array<{ type: "create" | "update"; data: Record<string, unknown> }>,
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    operationSync: {
      findUnique: vi.fn(async ({ where }: { where: { operationId: string } }) => h.lignes.get(where.operationId) ?? null),
      upsert: vi.fn(async ({ where, create, update }: { where: { operationId: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const existante = h.lignes.get(where.operationId);
        if (existante) {
          const tentatives = (update.tentatives as { increment: number } | undefined)?.increment ?? 0;
          h.lignes.set(where.operationId, { ...existante, ...update, tentatives: Number(existante.tentatives ?? 0) + tentatives });
          h.ecritures.push({ type: "update", data: update });
        } else {
          h.lignes.set(where.operationId, { ...create, tentatives: 0 });
          h.ecritures.push({ type: "create", data: create });
        }
        return h.lignes.get(where.operationId);
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        h.lignes.set(data.operationId as string, data);
        h.ecritures.push({ type: "create", data });
        return data;
      }),
    },
    conflitSync: { findFirst: vi.fn(async () => ({ id: "conflit-1" })) },
  },
}));
vi.mock("../lib/geo", () => ({ setPointGeom: vi.fn(), deriveGeomFromTroncon: vi.fn(), deriveGeomFromTronconAbscisse: vi.fn() }));
vi.mock("../utils/audit", () => ({ logAudit: vi.fn(), logAuditTransactionnelle: vi.fn() }));

import {
  appliquer, refuserPourDroits, rejetRetentable, estRefusDeDroits, creerBudgetTraces, REFUS_DROITS_TRACES_MAX_PAR_LOT,
} from "../field/sync.service";

const ctx = { appareilId: "app-1", userId: "u1" };
const op = (id = "00000000-0000-4000-8000-000000000001", extra: Record<string, unknown> = {}) => ({
  operationId: id, entityType: "Observation", entityId: "obs-1", operation: "UPDATE" as const, baseVersion: 1,
  payload: { description: "contenu sensible", pin: "123456" }, ...extra,
});

beforeEach(() => {
  h.lignes.clear();
  h.ecritures = [];
  vi.clearAllMocks();
});

describe("refuserPourDroits : la trace durable du refus", () => {
  it("ecrit une ligne REJETE DROITS_MODIFIES:<cause> et rend un refus definitif sans delai de reessai", async () => {
    const r = await refuserPourDroits(op(), ctx, "MODULE_RETIRE");
    expect(r).toEqual({
      operationId: op().operationId, statut: "REJETE", motif: "DROITS_MODIFIES", cause: "MODULE_RETIRE", definitif: true,
    });
    expect(r).not.toHaveProperty("reessayerDansMs");
    const ligne = h.lignes.get(op().operationId)!;
    expect(ligne).toMatchObject({
      statut: "REJETE", derniereErreur: "DROITS_MODIFIES:MODULE_RETIRE", userId: "u1", appareilId: "app-1",
      entityType: "Observation", entityId: "obs-1", operation: "UPDATE",
    });
  });

  it("ne conserve PAS le contenu de l'operation refusee (payload caviarde)", async () => {
    await refuserPourDroits(op(), ctx, "HORS_PERIMETRE");
    const ligne = h.lignes.get(op().operationId)!;
    expect(ligne.payload).toEqual({ redacted: true });
    expect(JSON.stringify(ligne)).not.toContain("contenu sensible");
    expect(JSON.stringify(ligne)).not.toContain("123456");
  });

  it("un renvoi du meme refus met la ligne a jour (tentatives), il n'en cree pas une seconde", async () => {
    await refuserPourDroits(op(), ctx, "HORS_PERIMETRE");
    await refuserPourDroits(op(), ctx, "HORS_PERIMETRE");
    expect(h.lignes.size).toBe(1);
    expect(h.lignes.get(op().operationId)!.tentatives).toBe(1);
    expect(h.ecritures.map((e) => e.type)).toEqual(["create", "update"]);
  });

  it("une operation DEJA APPLIQUEE n'est jamais ecrasee par un refus de droits : elle rend REJOUEE", async () => {
    h.lignes.set(op().operationId, { operationId: op().operationId, userId: "u1", entityId: "obs-1", entityType: "Observation", statut: "SYNCHRONISE", derniereErreur: null });
    const r = await refuserPourDroits(op(), ctx, "MODULE_RETIRE");
    expect(r).toMatchObject({ statut: "REJOUEE", entityId: "obs-1" });
    expect(h.ecritures).toHaveLength(0);
    expect(h.lignes.get(op().operationId)!.statut).toBe("SYNCHRONISE");
  });

  it("un CONFLIT en attente d'arbitrage reste un conflit", async () => {
    h.lignes.set(op().operationId, { operationId: op().operationId, userId: "u1", entityId: "obs-1", entityType: "Observation", statut: "CONFLIT", derniereErreur: "VERSION_MODIFIEE" });
    const r = await refuserPourDroits(op(), ctx, "MODULE_RETIRE");
    expect(r).toMatchObject({ statut: "CONFLIT", conflitId: "conflit-1" });
    expect(h.ecritures).toHaveLength(0);
  });

  it("l'operation d'un AUTRE compte n'est ni lue ni ecrasee : OPERATION_NON_AUTORISEE", async () => {
    h.lignes.set(op().operationId, { operationId: op().operationId, userId: "u2", entityId: "obs-1", entityType: "Observation", statut: "SYNCHRONISE", derniereErreur: null });
    const r = await refuserPourDroits(op(), ctx, "MODULE_RETIRE");
    expect(r).toMatchObject({ statut: "REJETE", motif: "OPERATION_NON_AUTORISEE" });
    expect(h.ecritures).toHaveLength(0);
  });
});

describe("appliquer avec un controle de droits", () => {
  const refus = (cause: string) => ({ controleDroits: vi.fn(async () => ({ cause })) });
  const permis = () => ({ controleDroits: vi.fn(async () => null) });

  it("un controle qui refuse produit la meme trace durable, avec la cause rendue par le controle", async () => {
    const options = refus("HORS_PERIMETRE");
    const r = await appliquer(op(), ctx, options);
    expect(r).toMatchObject({ statut: "REJETE", motif: "DROITS_MODIFIES", cause: "HORS_PERIMETRE", definitif: true });
    expect(h.lignes.get(op().operationId)!.derniereErreur).toBe("DROITS_MODIFIES:HORS_PERIMETRE");
    expect(h.lignes.get(op().operationId)!.payload).toEqual({ redacted: true });
  });

  it("L'IDEMPOTENCE PASSE AVANT LES DROITS : une operation deja appliquee n'est pas rejugee apres un changement de perimetre", async () => {
    h.lignes.set(op().operationId, { operationId: op().operationId, userId: "u1", entityId: "obs-1", entityType: "Observation", statut: "SYNCHRONISE", derniereErreur: null });
    const options = refus("HORS_PERIMETRE");
    const r = await appliquer(op(), ctx, options);
    expect(r).toMatchObject({ statut: "REJOUEE" });
    expect(options.controleDroits).not.toHaveBeenCalled();
    expect(h.ecritures).toHaveLength(0);
  });

  it("un refus de droits anterieur est REEVALUE au renvoi : si les droits sont rendus, l'operation poursuit son chemin normal", async () => {
    await appliquer(op(undefined, { entityType: "Portion", operation: "UPDATE", payload: {} }), ctx, refus("HORS_PERIMETRE"));
    expect(h.lignes.get(op().operationId)!.derniereErreur).toBe("DROITS_MODIFIES:HORS_PERIMETRE");

    // Droits rendus : le controle laisse passer ; l'operation (une modification de portion, non supportee par le
    // protocole) est alors jugee sur sa DONNEE, ce qui prouve qu'elle a bien poursuivi apres le controle.
    const suite = await appliquer(op(undefined, { entityType: "Portion", operation: "UPDATE", payload: {} }), ctx, permis());
    expect(suite).toMatchObject({ statut: "REJETE", motif: "OPERATION_NON_SUPPORTEE:Portion:UPDATE" });
  });

  it("sans controle fourni, le comportement d'avant est inchange (ni appel, ni trace de droits)", async () => {
    const r = await appliquer(op(undefined, { entityType: "Portion", operation: "UPDATE", payload: {} }), ctx);
    expect(r).toMatchObject({ motif: "OPERATION_NON_SUPPORTEE:Portion:UPDATE" });
  });
});

describe("refus de droits : ni type libre persiste, ni ecriture sans limite (D9, point 4)", () => {
  const html = "<script>alert(1)</script>".padEnd(64, "x").slice(0, 64);

  it("un type d'entite INCONNU rend TYPE_NON_SUPPORTE SANS aucune ecriture : le entityType libre n'atteint jamais operations_sync", async () => {
    const r = await refuserPourDroits(op(undefined, { entityType: html }), ctx, "MODULE_RETIRE");
    expect(r).toEqual({ operationId: op().operationId, statut: "REJETE", motif: `TYPE_NON_SUPPORTE:${html}` });
    expect(h.ecritures).toHaveLength(0);
    expect(h.lignes.size).toBe(0);
    expect(JSON.stringify([...h.lignes.values()])).not.toContain("<script>");
  });

  it("un refus de droits sur un type connu est trace comme avant, contenu caviarde (le caviardage reste verifie)", async () => {
    const r = await refuserPourDroits(op(), ctx, "MODULE_RETIRE", { tracer: true });
    expect(r).toMatchObject({ motif: "DROITS_MODIFIES", cause: "MODULE_RETIRE" });
    const ligne = h.lignes.get(op().operationId)!;
    expect(ligne.payload).toEqual({ redacted: true });
    expect(JSON.stringify(ligne)).not.toContain("contenu sensible");
  });

  it("tracer: false rend LE MEME refus (motif, cause, definitif) mais n'ecrit rien", async () => {
    const trace = await refuserPourDroits(op("00000000-0000-4000-8000-000000000001"), ctx, "MODULE_RETIRE");
    h.lignes.clear(); h.ecritures = [];
    const sans = await refuserPourDroits(op("00000000-0000-4000-8000-000000000002"), ctx, "MODULE_RETIRE", { tracer: false });
    expect({ ...sans, operationId: "x" }).toEqual({ ...trace, operationId: "x" });
    expect(h.ecritures).toHaveLength(0);
    expect(h.lignes.size).toBe(0);
  });

  it("tracer: false n'empeche pas l'idempotence : une operation deja appliquee rend toujours REJOUEE", async () => {
    h.lignes.set(op().operationId, { operationId: op().operationId, userId: "u1", entityId: "obs-1", entityType: "Observation", statut: "SYNCHRONISE", derniereErreur: null });
    const r = await refuserPourDroits(op(), ctx, "MODULE_RETIRE", { tracer: false });
    expect(r).toMatchObject({ statut: "REJOUEE" });
  });

  it("appliquer avec `tracerRefusDroits: false` : le refus du controle est rendu identique, sans ligne", async () => {
    const r = await appliquer(op(), ctx, { controleDroits: async () => ({ cause: "HORS_PERIMETRE" }), tracerRefusDroits: false });
    expect(r).toEqual({ operationId: op().operationId, statut: "REJETE", motif: "DROITS_MODIFIES", cause: "HORS_PERIMETRE", definitif: true });
    expect(h.ecritures).toHaveLength(0);
  });

  it("appliquer avec un type inconnu n'ecrit rien non plus (chemin du perimetre)", async () => {
    const r = await appliquer(op(undefined, { entityType: html }), ctx, { controleDroits: async () => ({ cause: "HORS_PERIMETRE" }) });
    expect(r).toMatchObject({ statut: "REJETE", motif: `TYPE_NON_SUPPORTE:${html}` });
    expect(h.ecritures).toHaveLength(0);
  });

  describe("creerBudgetTraces", () => {
    const refus = { statut: "REJETE", motif: "DROITS_MODIFIES" };

    it("le plafond par defaut est de 20 refus traces par appel (PROVISOIRE)", () => {
      expect(REFUS_DROITS_TRACES_MAX_PAR_LOT).toBe(20);
    });

    it("autorise a tracer jusqu'au plafond, puis compte les refus non traces", () => {
      const b = creerBudgetTraces(3);
      const tracees: boolean[] = [];
      for (let i = 0; i < 5; i++) {
        const tracer = b.peutTracer();
        tracees.push(tracer);
        b.compter(refus, tracer);
      }
      expect(tracees).toEqual([true, true, true, false, false]);
      expect(b.refusNonTraces).toBe(2);
    });

    it("seuls les refus DROITS_MODIFIES consomment le budget : un rejeu, un conflit ou un refus de donnee n'en consomment pas", () => {
      const b = creerBudgetTraces(1);
      b.compter({ statut: "REJOUEE" }, true);
      b.compter({ statut: "CONFLIT" }, true);
      b.compter({ statut: "REJETE", motif: "PAYLOAD_INVALIDE:Observation" }, true);
      b.compter({ statut: "REJETE", motif: "TYPE_NON_SUPPORTE:Z" }, true);
      expect(b.peutTracer()).toBe(true);
      b.compter(refus, true);
      expect(b.peutTracer()).toBe(false);
      expect(b.refusNonTraces).toBe(0);
    });
  });
});

describe("classification des motifs", () => {
  it("DROITS_MODIFIES (avec ou sans cause) est retentable par un renvoi explicite ; un refus de donnee ne l'est pas", () => {
    expect(rejetRetentable("Observation", "DROITS_MODIFIES")).toBe(true);
    expect(rejetRetentable("Observation", "DROITS_MODIFIES:HORS_PERIMETRE")).toBe(true);
    expect(rejetRetentable("Observation", "PAYLOAD_INVALIDE:Observation")).toBe(false);
    expect(rejetRetentable("Observation", "OPERATION_NON_AUTORISEE")).toBe(false);
  });

  it("estRefusDeDroits : DROITS_MODIFIES et MISSION_NON_AUTORISEE sont de la famille des droits, pas un refus de donnee", () => {
    expect(estRefusDeDroits("DROITS_MODIFIES")).toBe(true);
    expect(estRefusDeDroits("DROITS_MODIFIES:MODULE_RETIRE")).toBe(true);
    expect(estRefusDeDroits("MISSION_NON_AUTORISEE")).toBe(true);
    expect(estRefusDeDroits("PAYLOAD_INVALIDE:Observation")).toBe(false);
    expect(estRefusDeDroits("REFERENCE_INCONNUE:tronconId")).toBe(false);
    expect(estRefusDeDroits(null)).toBe(false);
  });
});

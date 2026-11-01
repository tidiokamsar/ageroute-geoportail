import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * La geolocalisation d'un actif depuis son troncon laisse une trace.
 *
 * LE DEFAUT : `deriveGeomFromTroncon` faisait un UPDATE SQL brut sans auteur ni avant/
 * apres. La position d'un ouvrage, d'un poste ou d'un point noir commande la carte ; elle
 * pouvait etre ecrasee sans qu'on sache par qui ni de quelle position on partait
 * (regle 3 d'AGENTS.md).
 *
 * CE QUI EST VERIFIE : avec le parametre `audit`, la lecture avant, l'ecriture, la lecture
 * apres et la trace partent dans UNE transaction ; sans lui, le comportement historique
 * (utilise par la synchronisation terrain) est inchange. Que PostgreSQL annule
 * reellement n'est pas verifie : `$transaction` est simule.
 */

const h = vi.hoisted(() => ({
  journal: [] as string[],
  audits: [] as Record<string, unknown>[],
  /** Positions successivement rendues par les lectures (avant, puis apres). */
  positions: [] as ({ lat: number; lon: number } | null)[],
  lignesAffectees: 1,
  panneAudit: false,
}));

vi.mock("./prisma", () => {
  const client = {
    $queryRawUnsafe: vi.fn(async () => {
      h.journal.push("lecture");
      const p = h.positions.shift();
      return p ? [p] : [];
    }),
    $executeRawUnsafe: vi.fn(async () => {
      h.journal.push("ecriture");
      return h.lignesAffectees;
    }),
    auditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (h.panneAudit) throw new Error("audit indisponible");
        h.journal.push("audit");
        h.audits.push(data);
        return data;
      }),
    },
  };
  return {
    prisma: {
      ...client,
      $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => {
        h.journal.push("transaction-ouverte");
        return fn(client);
      }),
    },
  };
});

import { deriveGeomFromTroncon } from "./geo";
import { prisma } from "./prisma";

beforeEach(() => {
  vi.clearAllMocks();
  h.journal = [];
  h.audits = [];
  h.positions = [null, { lat: 9.5, lon: -13.7 }];
  h.lignesAffectees = 1;
  h.panneAudit = false;
});

describe.each([
  ["ouvrages", "Ouvrage"],
  ["postes", "Poste"],
  ["points_noirs", "PointNoir"],
])("deriveGeomFromTroncon audite (%s)", (table, entityType) => {
  it("trace l'auteur, l'adresse, la position d'avant et celle d'apres", async () => {
    h.positions = [{ lat: 10, lon: -12 }, { lat: 9.5, lon: -13.7 }];

    const ok = await deriveGeomFromTroncon(table, "a1", "t1", 12.5, { userId: "u1", entityType, ipAddress: "10.0.0.9" });

    expect(ok).toBe(true);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      userId: "u1", action: "UPDATE", entityType, entityId: "a1", ipAddress: "10.0.0.9",
      before: { geom: { lat: 10, lon: -12 } },
      after: { geom: { lat: 9.5, lon: -13.7 }, tronconId: "t1", pk: 12.5 },
    });
  });

  it("distingue une position POSEE (aucune avant) d'une position remplacee", async () => {
    await deriveGeomFromTroncon(table, "a1", "t1", 1, { userId: "u1", entityType });
    expect(h.audits[0].before).toEqual({ geom: null });
  });

  it("lit, ecrit, relit puis audite dans UNE transaction", async () => {
    await deriveGeomFromTroncon(table, "a1", "t1", 1, { userId: "u1", entityType });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(h.journal).toEqual(["transaction-ouverte", "lecture", "ecriture", "lecture", "audit"]);
  });

  it("n'ecrit AUCUNE trace quand rien n'a ete modifie (troncon sans trace)", async () => {
    h.lignesAffectees = 0;
    const ok = await deriveGeomFromTroncon(table, "a1", "t1", 1, { userId: "u1", entityType });
    expect(ok).toBe(false);
    expect(h.audits).toHaveLength(0);
  });

  it("propage la panne d'audit : la geolocalisation echoue au lieu de passer sans trace", async () => {
    h.panneAudit = true;
    await expect(
      deriveGeomFromTroncon(table, "a1", "t1", 1, { userId: "u1", entityType })
    ).rejects.toThrow("audit indisponible");
  });
});

describe("Les autres appelants ne changent pas", () => {
  it("sans parametre d'audit : un simple UPDATE, ni transaction ni trace", async () => {
    const ok = await deriveGeomFromTroncon("defauts", "d1", "t1", 3);
    expect(ok).toBe(true);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(h.journal).toEqual(["ecriture"]);
    expect(h.audits).toHaveLength(0);
  });

  it("refuse toujours une table hors liste blanche", async () => {
    await expect(
      deriveGeomFromTroncon("users", "x", "t1", 1, { userId: "u1", entityType: "User" })
    ).rejects.toThrow(/Table non autorisee/);
  });
});

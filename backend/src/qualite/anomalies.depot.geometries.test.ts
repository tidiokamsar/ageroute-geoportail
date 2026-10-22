import { describe, expect, it, vi } from "vitest";

const etat = { lignes: [] as unknown[] };
vi.mock("../lib/prisma", () => ({
  prisma: { $queryRaw: vi.fn(async () => etat.lignes) },
}));

import { geometriesInvalides, PLAFOND_EXEMPLES } from "./anomalies.depot";

/**
 * Le compte des geometries invalides vient de la base (count(*) OVER ()), pas de la longueur de la
 * liste d'exemples. Avant le 22/10/2026, `nombre` valait lignes.length, donc jamais plus que le
 * plafond d'exemples : 25 geometries invalides s'annoncaient « 20 ». Le comportement reel est
 * eprouve contre PostGIS par le banc d'integration du suivi ; ce test garde la FORME du resultat.
 */

const ligne = (i: number, total: number) => ({ id: `t-${i}`, code: `C-${i}`, raison: "Too few points in geometry component", total: BigInt(total) });

describe("geometriesInvalides", () => {
  it("annonce le total de la base, pas le nombre d'exemples renvoyes", async () => {
    etat.lignes = Array.from({ length: PLAFOND_EXEMPLES }, (_, i) => ligne(i, 5000));
    const r = await geometriesInvalides({ regionId: null });
    expect(r.nombre).toBe(5000);
    expect(r.exemples).toHaveLength(PLAFOND_EXEMPLES);
  });

  it("rend zero quand aucune geometrie n'est invalide", async () => {
    etat.lignes = [];
    const r = await geometriesInvalides({ regionId: 3 });
    expect(r.nombre).toBe(0);
    expect(r.exemples).toEqual([]);
  });

  it("convertit le bigint de PostgreSQL en nombre (JSON ne sait pas le serialiser)", async () => {
    etat.lignes = [ligne(1, 1)];
    const r = await geometriesInvalides({ regionId: null });
    expect(typeof r.nombre).toBe("number");
    expect(r.exemples[0]).toMatchObject({ entityType: "Troncon", entityId: "t-1", famille: "GEOMETRIE_INVALIDE" });
    expect(r.exemples[0].explication).toContain("C-1 : Too few points");
  });
});

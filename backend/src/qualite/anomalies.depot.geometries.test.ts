import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Lignes que la base « rend », par table. Le mock reconnait la table au texte de la requete : une
 * requete qui change de table sans que ce test le sache le fait echouer au lieu de passer en silence.
 */
const etat = { parTable: {} as Record<string, unknown[]>, requetes: [] as string[] };
// Marqueur propre a la SELECT principale de chaque detecteur (la CTE des limites cite aussi limites_admin).
const REPERES: [string, string][] = [
  ["FROM portions pt", "FROM portions pt"],
  ["FROM earth_observation_products e", "FROM earth_observation_products e"],
  ["FROM chantiers c", "FROM chantiers c"],
  ["FROM ouvrages o", "FROM ouvrages o"],
  ["WITH RECURSIVE", "FROM limites_admin la"],
  ["FROM troncons t", "FROM troncons t"],
];

vi.mock("../lib/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      etat.requetes.push(sql);
      const repere = REPERES.find(([marqueur]) => sql.includes(marqueur));
      if (!repere) throw new Error(`requete d'une table inconnue : ${sql.slice(0, 80)}`);
      return etat.parTable[repere[1]] ?? [];
    }),
  },
}));

import { entrelacer, geometriesInvalides, PLAFOND_EXEMPLES } from "./anomalies.depot";

/**
 * Le compte des geometries invalides vient de la base (count(*) OVER ()), pas de la longueur de la
 * liste d'exemples. Avant le 22/10/2026, `nombre` valait lignes.length, donc jamais plus que le
 * plafond d'exemples : 25 geometries invalides s'annoncaient « 20 ». Le comportement reel est
 * eprouve contre PostGIS par les bancs d'integration (geometries-invalides, qualite-geometries) ;
 * ce test garde la FORME du resultat et l'agregation entre tables.
 */

const ligne = (i: number, total: number, raison = "Too few points in geometry component") => ({ id: `t-${i}`, libelle: `C-${i}`, raison, total: BigInt(total) });
const T = "FROM troncons t", C = "FROM chantiers c", P = "FROM portions pt", L = "FROM limites_admin la", E = "FROM earth_observation_products e", O = "FROM ouvrages o";

beforeEach(() => { etat.parTable = {}; etat.requetes = []; });

describe("geometriesInvalides", () => {
  it("annonce le total de la base, pas le nombre d'exemples renvoyes", async () => {
    etat.parTable[T] = Array.from({ length: PLAFOND_EXEMPLES }, (_, i) => ligne(i, 5000));
    const r = await geometriesInvalides({ regionId: null });
    expect(r.nombre).toBe(5000);
    expect(r.exemples).toHaveLength(PLAFOND_EXEMPLES);
  });

  it("rend zero quand aucune geometrie n'est invalide, et nomme quand meme chaque table examinee", async () => {
    const r = await geometriesInvalides({ regionId: 3 });
    expect(r.nombre).toBe(0);
    expect(r.exemples).toEqual([]);
    expect(r.parTypeEntite).toEqual([
      { entityType: "Troncon", nombre: 0 },
      { entityType: "Chantier", nombre: 0 },
      { entityType: "Portion", nombre: 0 },
      { entityType: "LimiteAdmin", nombre: 0 },
      { entityType: "EarthObservationProduct", nombre: 0 },
      { entityType: "Ouvrage", nombre: 0 },
    ]);
  });

  it("convertit le bigint de PostgreSQL en nombre (JSON ne sait pas le serialiser)", async () => {
    etat.parTable[T] = [ligne(1, 1)];
    const r = await geometriesInvalides({ regionId: null });
    expect(typeof r.nombre).toBe("number");
    expect(r.exemples[0]).toMatchObject({ entityType: "Troncon", entityId: "t-1", famille: "GEOMETRIE_INVALIDE" });
    expect(r.exemples[0].explication).toContain("C-1 : Too few points");
  });

  it("additionne les comptes EXACTS des six tables et les ventile par type d'entite", async () => {
    etat.parTable[T] = [ligne(1, 7)];
    etat.parTable[C] = [ligne(2, 3)];
    etat.parTable[P] = [ligne(3, 11)];
    etat.parTable[L] = [ligne(4, 2, "Self-intersection[1 1]")];
    etat.parTable[E] = [ligne(5, 1)];
    etat.parTable[O] = [ligne(6, 4)];
    const r = await geometriesInvalides({ regionId: null });
    expect(r.nombre).toBe(7 + 3 + 11 + 2 + 1 + 4);
    expect(r.parTypeEntite?.map((x) => x.nombre)).toEqual([7, 3, 11, 2, 1, 4]);
    expect(r.parTypeEntite?.reduce((s, x) => s + x.nombre, 0)).toBe(r.nombre);
    expect(r.surTotal).toBeNull();
  });

  it("montre un exemple de CHAQUE type avant d'en repeter un : 20 troncons ne masquent pas les limites", async () => {
    etat.parTable[T] = Array.from({ length: PLAFOND_EXEMPLES }, (_, i) => ligne(i, 500));
    etat.parTable[L] = [ligne(100, 1, "Self-intersection[1 1]")];
    etat.parTable[C] = [ligne(200, 1)];
    const r = await geometriesInvalides({ regionId: null });
    expect(r.exemples).toHaveLength(PLAFOND_EXEMPLES);
    // les trois premiers, que la route affiche, sont de trois types differents
    expect(r.exemples.slice(0, 3).map((e) => e.entityType)).toEqual(["Troncon", "Chantier", "LimiteAdmin"]);
  });

  it("interroge les six tables, une requete chacune, la region transmise a chaque requete", async () => {
    await geometriesInvalides({ regionId: 4 });
    expect(etat.requetes).toHaveLength(6);
    for (const sql of etat.requetes) {
      expect(sql).toMatch(/NOT ST_IsValid/);
      expect(sql).toMatch(/LIMIT/);
      expect(sql).toMatch(/count\(\*\) OVER \(\)/);
    }
  });

  it("ne controle ni les lignes supprimees logiquement ni les portions remplacees", async () => {
    await geometriesInvalides({ regionId: null });
    const sql = etat.requetes.join("\n");
    expect((sql.match(/"deletedAt" IS NULL/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(sql).toMatch(/"remplaceeLe" IS NULL/);
  });
});

describe("entrelacer", () => {
  it("prend un element de chaque liste a tour de role, jusqu'au plafond", () => {
    expect(entrelacer<number | string>([[1, 2, 3], ["a"], []], 10)).toEqual([1, "a", 2, 3]);
    expect(entrelacer<number | string>([[1, 2, 3], ["a", "b", "c"]], 4)).toEqual([1, "a", 2, "b"]);
    expect(entrelacer([], 5)).toEqual([]);
    expect(entrelacer([[1, 2]], 0)).toEqual([]);
  });
});

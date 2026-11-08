import { describe, expect, it, vi } from "vitest";
import {
  empriseSchema, ecrireEmprise, ecrireQuantiteEmprise, lireEmpriseStockee, mesurerEmprise,
  motifCoordonneesInvalides, sansEmprise, typeEmprise, POSITIONS_MAX,
} from "./defauts.emprise";

/**
 * Le module qui branche `metre_utm` sur la saisie du defaut. La base est remplacee par une memoire :
 * ces tests mesurent ce que le module REFUSE et ce qu'il envoie a PostGIS (geometrie en parametre
 * lie, jamais concatenee). Les VALEURS (10 000 m2, ecart < 1 %) sont eprouvees en base par
 * `tests-integration/metre-defaut.integration.mts`.
 */
const carre = { type: "Polygon" as const, coordinates: [[[-13.6, 9.6], [-13.599, 9.6], [-13.599, 9.601], [-13.6, 9.601], [-13.6, 9.6]]] };
const trait = { type: "LineString" as const, coordinates: [[-13.6, 9.6], [-13.59, 9.6]] };

function base(reponses: unknown[][]) {
  const requetes: unknown[][] = [];
  const queryRaw = vi.fn(async (...a: unknown[]) => { requetes.push(a); return reponses.shift() ?? []; });
  const executeRaw = vi.fn(async (...a: unknown[]) => { requetes.push(a); return 1; });
  return { db: { $queryRaw: queryRaw, $executeRaw: executeRaw } as never, requetes, queryRaw, executeRaw };
}
const sql = (a: unknown[]) => (a[0] as string[]).join("?");

describe("forme d'une emprise", () => {
  it("accepte les quatre types de lignes et de surfaces, rien d'autre", () => {
    for (const type of ["LineString", "MultiLineString", "Polygon", "MultiPolygon"]) expect(empriseSchema.safeParse({ type, coordinates: [[[0, 0]]] }).success).toBe(true);
    expect(empriseSchema.safeParse({ type: "Point", coordinates: [0, 0] }).success).toBe(false);
    expect(empriseSchema.safeParse({ type: "Polygon", coordinates: [], crs: "x" }).success).toBe(false);
  });

  it("une LineString est une ligne, un Polygon une surface", () => {
    expect(typeEmprise(trait)).toBe("ligne");
    expect(typeEmprise(carre)).toBe("surface");
    expect(typeEmprise({ type: "MultiLineString", coordinates: [[[0, 0], [1, 1]]] })).toBe("ligne");
    expect(typeEmprise({ type: "MultiPolygon", coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] })).toBe("surface");
  });

  it("refuse ce qui n'est pas en degres WGS 84 (un fichier en UTM n'est pas du 4326)", () => {
    expect(motifCoordonneesInvalides({ type: "LineString", coordinates: [[653632, 1061500], [653700, 1061500]] })).toMatch(/SRID 4326/);
    expect(motifCoordonneesInvalides({ type: "LineString", coordinates: [[-13.6, 91], [-13.5, 9.6]] })).toMatch(/SRID 4326/);
  });

  it("refuse une coordonnee non finie, une position mal formee et une liste vide", () => {
    expect(motifCoordonneesInvalides({ type: "LineString", coordinates: [[Number.NaN, 9], [1, 1]] })).toMatch(/non finie/);
    expect(motifCoordonneesInvalides({ type: "LineString", coordinates: ["a", "b"] })).not.toBeNull();
    expect(motifCoordonneesInvalides({ type: "Polygon", coordinates: [[]] })).not.toBeNull();
  });

  it("refuse un contour de plus de POSITIONS_MAX positions", () => {
    const enorme = { type: "LineString" as const, coordinates: Array.from({ length: POSITIONS_MAX + 1 }, (_, i) => [-13 - i * 1e-7, 9.6]) };
    expect(motifCoordonneesInvalides(enorme)).toMatch(/plus de/);
  });

  it("accepte un contour correct et une altitude en troisieme valeur", () => {
    expect(motifCoordonneesInvalides(carre)).toBeNull();
    expect(motifCoordonneesInvalides({ type: "LineString", coordinates: [[-13.6, 9.6, 12], [-13.59, 9.6, 14]] })).toBeNull();
  });

  it("sansEmprise laisse passer toutes les methodes que Prisma ecrit seul, et retire EMPRISE_UTM", () => {
    expect(sansEmprise("SAISIE")).toBe("SAISIE");
    expect(sansEmprise("COMPTAGE_COEFFICIENT")).toBe("COMPTAGE_COEFFICIENT");
    expect(sansEmprise("EMPRISE_UTM")).toBeNull();
  });
});

describe("mesurerEmprise", () => {
  it("n'interroge PAS la base pour un contour dont les coordonnees sont deja fausses", async () => {
    const { db, queryRaw } = base([]);
    const r = await mesurerEmprise(db, { type: "LineString", coordinates: [[653632, 1061500], [653700, 1061500]] });
    expect(r).toMatchObject({ ok: false, motif: "EMPRISE_ILLISIBLE" });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("refuse une geometrie invalide avec la raison de PostGIS, sans la reparer", async () => {
    const { db, requetes } = base([[{ valide: false, raison: "Self-intersection[-13.6 9.6]" }]]);
    const r = await mesurerEmprise(db, carre);
    expect(r).toEqual({ ok: false, motif: "EMPRISE_INVALIDE", raison: "Self-intersection[-13.6 9.6]" });
    expect(requetes).toHaveLength(1);                                       // la mesure n'est pas demandee
    expect(requetes.map(sql).join()).not.toMatch(/ST_MakeValid/i);
  });

  it("mesure une surface dans son fuseau et rend le perimetre sans l'utiliser comme surface", async () => {
    const { db, requetes } = base([
      [{ valide: true, raison: "Valid Geometry" }],
      [{ epsg: 32628, longueurM: 400, surfaceM2: 10000, ecartLongueur: 0.0004, ecartSurface: 0.0009 }],
    ]);
    const r = await mesurerEmprise(db, carre);
    expect(r).toEqual({ ok: true, epsg: 32628, ecartLongueur: 0.0004, ecartSurface: 0.0009, metre: { type: "surface", longueurM: 400, surfaceM2: 10000 } });
    expect(sql(requetes[1])).toContain("metre_utm(");
    expect(requetes[1].slice(1)).toEqual([JSON.stringify(carre)]);          // parametre lie, jamais concatene
  });

  it("une ligne n'a pas de surface : surfaceM2 est nul, meme si PostGIS rend 0", async () => {
    const { db } = base([
      [{ valide: true, raison: "Valid Geometry" }],
      [{ epsg: 32628, longueurM: 1000.123, surfaceM2: 0, ecartLongueur: 0.0003, ecartSurface: null }],
    ]);
    const r = await mesurerEmprise(db, trait);
    expect(r).toMatchObject({ ok: true, metre: { type: "ligne", longueurM: 1000.123, surfaceM2: null }, ecartSurface: null });
  });

  it("une geometrie que PostGIS ne sait pas lire est une erreur de l'appelant, pas du serveur", async () => {
    const db = { $queryRaw: vi.fn(async () => { throw new Error("invalid GeoJSON representation"); }), $executeRaw: vi.fn() } as never;
    expect(await mesurerEmprise(db, carre)).toMatchObject({ ok: false, motif: "EMPRISE_ILLISIBLE" });
  });

  it("une autre erreur (base indisponible) remonte, elle n'est pas rangee en « emprise illisible »", async () => {
    const db = { $queryRaw: vi.fn(async () => { throw new Error("connexion perdue"); }), $executeRaw: vi.fn() } as never;
    await expect(mesurerEmprise(db, carre)).rejects.toThrow("connexion perdue");
  });
});

describe("ecriture de l'emprise", () => {
  it("ecrit l'emprise avec la quantite en SQL parametre, l'emprise d'abord", async () => {
    const { db, requetes } = base([]);
    await ecrireEmprise(db, "defaut-1", carre, { valeur: 10000, unite: "METRE_CARRE", methode: "EMPRISE_UTM" });
    expect(requetes).toHaveLength(2);
    expect(sql(requetes[0])).toMatch(/SET "emprise" = ST_SetSRID\(ST_GeomFromGeoJSON\(\?\), 4326\)/);
    expect(requetes[0].slice(1)).toEqual([JSON.stringify(carre), "defaut-1"]);
    expect(sql(requetes[1])).toMatch(/"methodeQuantite" = \?::"MethodeQuantite"/);
    expect(requetes[1].slice(1)).toEqual([10000, "METRE_CARRE", "EMPRISE_UTM", "defaut-1"]);
  });

  it("sans quantite, n'ecrit que l'emprise", async () => {
    const { db, requetes } = base([]);
    await ecrireEmprise(db, "defaut-1", carre);
    expect(requetes).toHaveLength(1);
  });

  it("ecrireQuantiteEmprise ne touche pas a la geometrie", async () => {
    const { db, requetes } = base([]);
    await ecrireQuantiteEmprise(db, "defaut-1", { valeur: 5, unite: "METRE", methode: "EMPRISE_UTM" });
    expect(requetes).toHaveLength(1);
    expect(sql(requetes[0])).not.toContain("emprise");
  });
});

describe("emprise stockee", () => {
  it("relit le contour d'un defaut pour un recalcul", async () => {
    const { db } = base([[{ g: JSON.stringify(carre) }]]);
    expect(await lireEmpriseStockee(db, "defaut-1")).toEqual(carre);
  });
  it("rend null sans contour, ou pour une geometrie d'un autre type", async () => {
    expect(await lireEmpriseStockee(base([[]]).db, "d")).toBeNull();
    expect(await lireEmpriseStockee(base([[{ g: JSON.stringify({ type: "Point", coordinates: [0, 0] }) }]]).db, "d")).toBeNull();
    expect(await lireEmpriseStockee(base([[{ g: null }]]).db, "d")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  NIVEAUX, ancetresDuChemin, bboxContient, bboxContientPosition, construireChemin, estDansSousArbre, lireEmprise, parentAdmissible, rangNiveau, regionEffective, SOMMETS_EMPRISE_MAX,
} from "./hierarchie.noyau";

describe("niveaux et rangs", () => {
  it("sept niveaux, de la nation (0) a la zone (6), dans l'ordre du contrat", () => {
    expect(NIVEAUX).toEqual(["NATION", "REGION", "PREFECTURE", "COMMUNE", "QUARTIER", "SECTEUR", "ZONE"]);
    expect(rangNiveau("NATION")).toBe(0);
    expect(rangNiveau("ZONE")).toBe(6);
  });

  it("un parent est de rang strictement inferieur ; un niveau peut etre saute", () => {
    expect(parentAdmissible("COMMUNE", "PREFECTURE")).toEqual({ ok: true });
    expect(parentAdmissible("COMMUNE", "REGION")).toEqual({ ok: true });
    expect(parentAdmissible("ZONE", "NATION")).toEqual({ ok: true });
  });

  it("refuse un parent de meme rang ou de rang superieur, et un parent pour la nation", () => {
    expect(parentAdmissible("COMMUNE", "COMMUNE")).toMatchObject({ ok: false, code: "NIVEAU_INCOMPATIBLE" });
    expect(parentAdmissible("REGION", "COMMUNE")).toMatchObject({ ok: false, code: "NIVEAU_INCOMPATIBLE" });
    expect(parentAdmissible("NATION", "REGION")).toMatchObject({ ok: false, code: "NIVEAU_INCOMPATIBLE" });
  });

  it("tout niveau autre que la nation exige un parent ; la nation n'en a pas", () => {
    expect(parentAdmissible("REGION", null)).toMatchObject({ ok: false, code: "TERRITOIRE_PARENT_REQUIS" });
    expect(parentAdmissible("NATION", null)).toEqual({ ok: true });
  });
});

describe("chemin materialise et region effective", () => {
  it("construit le chemin de la nation puis de ses descendants, et en relit les ancetres", () => {
    const nation = construireChemin(null, "n");
    const region = construireChemin(nation, "r");
    const commune = construireChemin(region, "c");
    expect(nation).toBe("/n/");
    expect(commune).toBe("/n/r/c/");
    expect(ancetresDuChemin(commune)).toEqual(["n", "r"]);
    expect(ancetresDuChemin(nation)).toEqual([]);
  });

  it("un territoire est dans le sous-arbre de ses ancetres et de lui-meme, pas d'un frere", () => {
    expect(estDansSousArbre("/n/r/", "/n/r/c/")).toBe(true);
    expect(estDansSousArbre("/n/r/", "/n/r/")).toBe(true);
    expect(estDansSousArbre("/n/r/", "/n/s/c/")).toBe(false);
    // Un prefixe d'identifiant ne suffit pas : les separateurs comptent.
    expect(estDansSousArbre("/n/r/", "/n/r2/")).toBe(false);
  });

  it("la region effective est la region propre, sinon celle du parent", () => {
    expect(regionEffective(3, 7)).toBe(3);
    expect(regionEffective(null, 7)).toBe(7);
    expect(regionEffective(null, null)).toBeNull();
  });
});

describe("emprises GeoJSON", () => {
  const carre = (x: number, y: number, d: number) => [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]];

  it("lit un polygone ferme et calcule sa boite englobante", () => {
    const r = lireEmprise({ type: "Polygon", coordinates: carre(-10.2, 9.1, 0.1) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bbox.map((v) => Math.round(v * 10) / 10)).toEqual([-10.2, 9.1, -10.1, 9.2]);
      expect(r.sommets).toBe(5);
      expect(r.geojson.type).toBe("Polygon");
    }
  });

  it("lit un multipolygone et prend la boite englobante de l'ensemble", () => {
    const r = lireEmprise({ type: "MultiPolygon", coordinates: [carre(0, 0, 1), carre(5, 5, 1)] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bbox).toEqual([0, 0, 6, 6]);
  });

  it("refuse un type inconnu, un anneau non ferme, trop court, une position illisible ou hors WGS 84", () => {
    const code = (b: unknown) => { const r = lireEmprise(b); return r.ok ? "ok" : r.message; };
    expect(code({ type: "Point", coordinates: [0, 0] })).toMatch(/Polygon ou MultiPolygon/);
    expect(code({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] })).toMatch(/pas ferme/);
    expect(code({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [0, 0]]] })).toMatch(/quatre positions/);
    expect(code({ type: "Polygon", coordinates: [[[0, 0], ["a", 0], [1, 1], [0, 0]]] })).toMatch(/illisible/);
    expect(code({ type: "Polygon", coordinates: [[[0, 0], [200, 0], [1, 1], [0, 0]]] })).toMatch(/-180\/180/);
    expect(code({ type: "Polygon", coordinates: [] })).toMatch(/au moins un anneau/);
    expect(code(null)).toMatch(/objet GeoJSON/);
    expect(code("texte")).toMatch(/objet GeoJSON/);
  });

  it("refuse une emprise degeneree (largeur nulle)", () => {
    const r = lireEmprise({ type: "Polygon", coordinates: [[[1, 0], [1, 1], [1, 2], [1, 0]]] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/degeneree/);
  });

  it("plafonne le nombre de sommets", () => {
    const anneau: [number, number][] = [];
    for (let i = 0; i <= SOMMETS_EMPRISE_MAX; i += 1) anneau.push([Math.cos(i) * 0.01, Math.sin(i) * 0.01]);
    anneau.push(anneau[0]);
    const r = lireEmprise({ type: "Polygon", coordinates: [anneau] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/sommets/);
  });

  it("contenance par rectangle et position", () => {
    expect(bboxContient([0, 0, 10, 10], [1, 1, 9, 9])).toBe(true);
    expect(bboxContient([0, 0, 10, 10], [1, 1, 11, 9])).toBe(false);
    expect(bboxContientPosition([0, 0, 10, 10], 10, 10)).toBe(true);
    expect(bboxContientPosition([0, 0, 10, 10], 10.1, 5)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { bboxDePolygone, bboxValide, fractionCouverte, pointDansPolygone, polygoneDeBbox, polygonesSIntersectent, validerPolygone } from "./geometrie";

const carre = (o: number, s: number, e: number, n: number) => polygoneDeBbox([o, s, e, n]);

describe("bboxValide", () => {
  it("accepte une boite ordonnee dans le globe", () => {
    expect(bboxValide([-14.39, 10.83, -14.19, 11.03])).toBe(true);
  });
  it.each([
    [[1, 2, 3]], [[1, 2, 3, NaN]], [[5, 0, 1, 2]], [[0, 5, 1, 2]], [[-181, 0, 1, 2]], [[0, -91, 1, 2]], [[0, 0, 181, 2]], ["x"], [null],
  ])("refuse %j", (b) => {
    expect(bboxValide(b)).toBe(false);
  });
});

describe("validerPolygone", () => {
  it("accepte un polygone ferme et retire l'altitude", () => {
    const r = validerPolygone({ type: "Polygon", coordinates: [[[0, 0, 12], [1, 0, 12], [1, 1, 12], [0, 0, 12]]] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.polygone.coordinates[0][0]).toEqual([0, 0]);
  });
  it("accepte un MultiPolygon d'un seul polygone, et le rend en Polygon", () => {
    const r = validerPolygone({ type: "MultiPolygon", coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] });
    expect(r.ok && r.polygone.type).toBe("Polygon");
  });
  it.each([
    ["absente", undefined, /absente/],
    ["Point", { type: "Point", coordinates: [0, 0] }, /non pris en charge/],
    ["MultiPolygon de deux polygones", { type: "MultiPolygon", coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]], [[[5, 5], [6, 5], [6, 6], [5, 5]]]] }, /non pris en charge/],
    ["anneau court", { type: "Polygon", coordinates: [[[0, 0], [1, 0], [0, 0]]] }, /4 positions/],
    ["anneau ouvert", { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }, /non ferme/],
    ["hors du globe", { type: "Polygon", coordinates: [[[0, 0], [1, 95], [1, 1], [0, 0]]] }, /hors du globe/],
    ["position illisible", { type: "Polygon", coordinates: [[[0, 0], ["a", 0], [1, 1], [0, 0]]] }, /illisible/],
    ["aire nulle", { type: "Polygon", coordinates: [[[0, 0], [1, 1], [2, 2], [0, 0]]] }, /aire nulle/],
  ])("refuse : %s", (_nom, g, motif) => {
    const r = validerPolygone(g);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.raison).toMatch(motif);
  });
});

describe("intersection et couverture", () => {
  const zone = carre(0, 0, 2, 2);
  it("deux carres qui se recouvrent, se touchent, ou s'ignorent", () => {
    expect(polygonesSIntersectent(zone, carre(1, 1, 3, 3))).toBe(true);
    expect(polygonesSIntersectent(zone, carre(2, 0, 4, 2))).toBe(true); // arete commune
    expect(polygonesSIntersectent(zone, carre(5, 5, 6, 6))).toBe(false);
  });
  it("un polygone contenu dans l'autre se coupe sans que leurs aretes se croisent", () => {
    expect(polygonesSIntersectent(zone, carre(0.5, 0.5, 1, 1))).toBe(true);
    expect(polygonesSIntersectent(carre(0.5, 0.5, 1, 1), zone)).toBe(true);
  });
  it("detecte le croisement en croix (aucun sommet dans l'autre)", () => {
    expect(polygonesSIntersectent(carre(0, 1, 3, 1.5), carre(1, 0, 1.5, 3))).toBe(true);
  });
  it("point dans un polygone a trou : le trou est exclu", () => {
    const troue = { type: "Polygon" as const, coordinates: [carre(0, 0, 4, 4).coordinates[0], carre(1, 1, 3, 3).coordinates[0]] };
    expect(pointDansPolygone(0.5, 0.5, troue)).toBe(true);
    expect(pointDansPolygone(2, 2, troue)).toBe(false);
  });
  it("fractionCouverte : tout, la moitie, rien", () => {
    expect(fractionCouverte(zone, carre(-1, -1, 3, 3))).toBe(1);
    expect(fractionCouverte(zone, carre(1, -1, 3, 3))).toBeCloseTo(0.5, 1);
    expect(fractionCouverte(zone, carre(10, 10, 11, 11))).toBe(0);
  });
  it("une zone plus fine que la grille se teste par son centre", () => {
    // sliver : aucun point de la grille ne tombe a l'interieur
    const sliver = { type: "Polygon" as const, coordinates: [[[0, 0], [1, 1], [1, 1.0000001], [0, 0]]] };
    expect(fractionCouverte(sliver, carre(0, 0, 1, 1))).toBe(1);
    expect(fractionCouverte(sliver, carre(5, 5, 6, 6))).toBe(0);
  });
  it("bboxDePolygone", () => {
    expect(bboxDePolygone(carre(-3, 4, 5, 9))).toEqual([-3, 4, 5, 9]);
  });
});

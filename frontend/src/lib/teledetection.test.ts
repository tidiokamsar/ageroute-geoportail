import { describe, expect, it } from "vitest";
import { empriseRectangle, lireLot } from "./teledetection";

/**
 * Préparation des envois de télédétection : ce que ces tests défendent.
 *   - une emprise rectangulaire est un Polygon fermé, des bornes inversées sont refusées ;
 *   - un lot GeoJSON se lit en FeatureCollection, Feature ou géométrie seule ;
 *   - le type vient de l'entité, à défaut du type par défaut ; jamais deviné ;
 *   - une entité fautive est nommée par son rang ; le score est borné à [0, 1].
 */
describe("empriseRectangle", () => {
  it("rend un polygone fermé", () => {
    expect(empriseRectangle(-13.7, 9.5, -13.4, 9.8)).toEqual({ type: "Polygon", coordinates: [[[-13.7, 9.5], [-13.4, 9.5], [-13.4, 9.8], [-13.7, 9.8], [-13.7, 9.5]]] });
  });
  it.each([
    [[-13.4, 9.5, -13.7, 9.8], /droite/],
    [[-13.7, 9.8, -13.4, 9.5], /droite/],
    [[-190, 9.5, -13.4, 9.8], /hors du globe/],
    [[Number.NaN, 9.5, -13.4, 9.8], /nombres/],
  ])("%j refusé", (b, motif) => {
    expect(empriseRectangle(b[0], b[1], b[2], b[3])).toMatch(motif);
  });
});

describe("lireLot", () => {
  const point = (x: number, y: number, properties: Record<string, unknown> = {}) => ({ type: "Feature", geometry: { type: "Point", coordinates: [x, y] }, properties });
  it("lit une FeatureCollection, type et score par entité", () => {
    const r = lireLot(JSON.stringify({ type: "FeatureCollection", features: [point(-13.6, 9.6, { type: "INONDATION", score: 0.8 }), point(-13.5, 9.7)] }), "COUPURE_PROBABLE");
    expect(r.erreurs).toEqual([]);
    expect(r.propositions.map((p) => [p.type, p.score])).toEqual([["INONDATION", 0.8], ["COUPURE_PROBABLE", null]]);
  });
  it("lit une géométrie seule avec le type par défaut", () => {
    expect(lireLot(JSON.stringify({ type: "Point", coordinates: [-13.6, 9.6] }), "VEGETATION").propositions).toHaveLength(1);
  });
  it("ne devine aucun type et nomme le rang fautif", () => {
    const r = lireLot(JSON.stringify({ type: "FeatureCollection", features: [point(-13.6, 9.6), point(1, 1, { type: "GLISSEMENT" }), point(1, 1, { type: "INONDATION", score: 2 })] }), "");
    expect(r.propositions).toEqual([]);
    expect(r.erreurs).toEqual([expect.stringMatching(/^Entité 1 : type/), expect.stringMatching(/^Entité 2 : type/), expect.stringMatching(/^Entité 3 : score/)]);
  });
  it("refuse un texte illisible ou vide", () => {
    expect(lireLot("pas du json", "INONDATION").erreurs[0]).toMatch(/JSON/);
    expect(lireLot(JSON.stringify({ type: "FeatureCollection", features: [] }), "INONDATION").erreurs[0]).toMatch(/Aucune entité/);
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { epsgUtm, metreUtm, pointInterieur, versUtm, type GeometrieMetrable } from "./utm.noyau";
import { GEOMETRIES_REFERENCE } from "./geometries-reference";

/**
 * Metre UTM sans base (A5) : ce que ces tests defendent.
 *   - sur chaque geometrie de reference, la surface et la longueur de DEFINITION sont retrouvees
 *     au millionieme quand le fuseau est celui de definition ;
 *   - le resultat rejoint celui de PostGIS (`metre_utm`) au millionieme, fuseau compris, y
 *     compris a cheval sur 12 deg O ;
 *   - une geometrie mal formee est refusee avec sa raison, jamais reparee.
 */

const relatif = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

describe("Le noyau ne depend de rien", () => {
  it("n'a aucun import", () => {
    const src = readFileSync(join(__dirname, "utm.noyau.ts"), "utf8");
    expect([...src.matchAll(/^import .*?from\s+["']/gm)]).toHaveLength(0);
  });
});

describe("Projection", () => {
  it("le sommet d'origine du carre de reference retombe a moins d'un millimetre de sa definition", () => {
    // CARRE_100M_28N est defini a partir de (640 000 ; 1 060 000) en 28N.
    const [x, y] = versUtm(-13.7242540791, 9.5869102373, 32628);
    expect(Math.abs(x - 640000)).toBeLessThan(0.001);
    expect(Math.abs(y - 1060000)).toBeLessThan(0.001);
  });
  it("au meridien central, l'abscisse vaut exactement la fausse abscisse", () => {
    expect(versUtm(-9, 10.8554812216, 32629)[0]).toBeCloseTo(500000, 6);
  });
  it("fuseau : 28N a l'ouest de 12 deg O, 29N a partir de 12 deg O, sud en 327xx", () => {
    expect(epsgUtm(-13.7, 9.6)).toBe(32628);
    expect(epsgUtm(-12.0001, 9.6)).toBe(32628);
    expect(epsgUtm(-12, 9.6)).toBe(32629);
    expect(epsgUtm(-9.3, 10.4)).toBe(32629);
    expect(epsgUtm(-9.3, -1)).toBe(32729);
  });
});

describe.each(GEOMETRIES_REFERENCE.map((r) => [r.code, r] as const))("Geometrie de reference %s", (_code, ref) => {
  const m = metreUtm(ref.geometrie as unknown as GeometrieMetrable);
  if ("refus" in m) throw new Error(`refus inattendu : ${m.refus}`);

  it("meme fuseau que PostGIS", () => {
    expect(m.epsg).toBe(ref.postgis.epsg);
  });
  it("rejoint PostGIS au millionieme", () => {
    if (ref.postgis.surfaceM2 > 0) expect(relatif(m.surfaceM2, ref.postgis.surfaceM2)).toBeLessThan(1e-6);
    expect(relatif(m.longueurM, ref.postgis.longueurM)).toBeLessThan(1e-6);
  });
  it(ref.postgis.epsg === ref.epsgDefinition
    ? "retrouve la valeur de definition au millionieme"
    : "fuseau voisin de celui de definition : ecart borne a 1 % (A5), mesure", () => {
    const tolerance = ref.postgis.epsg === ref.epsgDefinition ? 1e-6 : 0.01;
    if (ref.surfaceDefinitionM2 > 0) expect(relatif(m.surfaceM2, ref.surfaceDefinitionM2)).toBeLessThan(tolerance);
    expect(relatif(m.longueurM, ref.longueurDefinitionM)).toBeLessThan(tolerance);
  });
});

describe("Point interieur", () => {
  it("tombe DANS une forme concave, la ou le centroide tomberait dehors", () => {
    const l = GEOMETRIES_REFERENCE.find((r) => r.code === "L_CONCAVE_28N")!.geometrie as unknown as GeometrieMetrable;
    const [x, y] = pointInterieur(l);
    // Le L occupe la bande basse sur toute sa largeur, et la colonne gauche au-dessus.
    const bas = y < 10.85094, gauche = x < -13.1695;
    expect(bas || gauche).toBe(true);
  });
});

describe("Refus", () => {
  it.each([
    [{ type: "LineString", coordinates: [] }, "GEOMETRIE_VIDE"],
    [{ type: "Polygon", coordinates: [[[-13, 9], [-13, 9.1], [-12.9, 9.1], [-12.9, 9]]] }, "ANNEAU_NON_FERME"],
    [{ type: "LineString", coordinates: [[-13, 9], [-13, 200]] }, "COORDONNEE_INVALIDE"],
    [{ type: "LineString", coordinates: [[-13, 9], [Number.NaN, 9]] }, "COORDONNEE_INVALIDE"],
  ])("%j -> %s", (g, attendu) => {
    expect(metreUtm(g as unknown as GeometrieMetrable)).toEqual({ refus: attendu });
  });
});

import { describe, expect, it } from "vitest";
import {
  aireRectangleEllipsoide, distanceVincenty, fuseauDeLongitude, lonLatVersUtm, longueurLigneGeodesique,
  meridienCentral, utmVersLonLat,
} from "./geodesie";

/**
 * L'oracle doit etre juste AVANT de juger. Il est confronte :
 *   - a des valeurs MESUREES sur PostGIS 3 / PROJ (`ST_Transform`, `ST_Distance(geography)`,
 *     `ST_Area(geography)`), relevees le 22/10/2026 sur la base de developpement ;
 *   - a un cas d'ecole publie : Flinders Peak - Buninyong (Vincenty, 1975), 54 972,271 m ;
 *   - a des proprietes qui ne dependent d'aucun outil : l'aller-retour, le meridien central.
 */
describe("projection UTM (series de Kruger)", () => {
  it("le meridien central est a 500 000 m d'est, et le nord y vaut k0 x l'arc de meridien", () => {
    expect(lonLatVersUtm(-15, 0, 28)).toEqual({ e: 500000, n: 0 });
    expect(lonLatVersUtm(-15, 9.6, 28).e).toBeCloseTo(500000, 6);
    // Arc de meridien de l'equateur a 9,6 deg : 1 061 480 m environ (+-30 m) ; x k0 donne le nord UTM.
    expect(lonLatVersUtm(-15, 9.6, 28).n).toBeGreaterThan(1_060_000);
    expect(lonLatVersUtm(-15, 9.6, 28).n).toBeLessThan(1_063_000);
  });

  it("concorde avec PROJ a moins d'un millimetre, aux deux fuseaux de la Guinee", () => {
    const a = lonLatVersUtm(-13.6, 9.6, 28);
    expect(Math.abs(a.e - 653632.1780118239)).toBeLessThan(1e-3);
    expect(Math.abs(a.n - 1061500.672692667)).toBeLessThan(1e-3);
    const b = lonLatVersUtm(-8.5, 10.2, 29);
    expect(Math.abs(b.e - 554764.5693976755)).toBeLessThan(1e-3);
    expect(Math.abs(b.n - 1127567.6452978435)).toBeLessThan(1e-3);
    // Pres de la limite des fuseaux (12 deg O), la ou la deformation est la plus forte.
    const c = lonLatVersUtm(-11.9, 9.0, 28);
    expect(Math.abs(c.e - 840892.6395444162)).toBeLessThan(1e-3);
    expect(Math.abs(c.n - 996295.876624731)).toBeLessThan(1e-3);
  });

  it("l'inverse retrouve la longitude et la latitude (aller-retour sous le micron)", () => {
    for (const [lon, lat, z] of [[-13.6, 9.6, 28], [-8.5, 10.2, 29], [-11.9, 9.0, 28], [-14.9, 12.6, 28], [-7.7, 7.3, 29]] as const) {
      const { e, n } = lonLatVersUtm(lon, lat, z);
      const r = utmVersLonLat(e, n, z);
      expect(Math.abs(r.lon - lon)).toBeLessThan(1e-9);
      expect(Math.abs(r.lat - lat)).toBeLessThan(1e-9);
    }
  });

  it("un carre de 100 m en coordonnees UTM revient en degres puis en metres a 100 m pres du micron", () => {
    const coins = [[653600, 1061500], [653700, 1061500], [653700, 1061600], [653600, 1061600]] as const;
    const ll = coins.map(([e, n]) => utmVersLonLat(e, n, 28));
    const back = ll.map((p) => lonLatVersUtm(p.lon, p.lat, 28));
    expect(Math.abs(back[1].e - back[0].e - 100)).toBeLessThan(1e-6);
    expect(Math.abs(back[2].n - back[1].n - 100)).toBeLessThan(1e-6);
  });

  it("les meridiens centraux de la Guinee : fuseau 28 a -15, fuseau 29 a -9, limite a -12", () => {
    expect(meridienCentral(28)).toBe(-15);
    expect(meridienCentral(29)).toBe(-9);
    expect(fuseauDeLongitude(-12.0001)).toBe(28);
    expect(fuseauDeLongitude(-12)).toBe(29);
    expect(fuseauDeLongitude(-13.6)).toBe(28);
    expect(fuseauDeLongitude(-8.5)).toBe(29);
  });
});

describe("Vincenty", () => {
  it("rend le cas d'ecole de Vincenty (Flinders Peak - Buninyong) : 54 972,271 m", () => {
    const dms = (d: number, m: number, s: number) => d + m / 60 + s / 3600;
    const d = distanceVincenty(dms(144, 25, 29.5244), -dms(37, 57, 3.7203), dms(143, 55, 35.3839), -dms(37, 39, 10.1561));
    expect(Math.abs(d - 54972.271)).toBeLessThan(0.001);
  });

  it("concorde avec la distance geodesique de PostGIS (geographiclib) a 1 mm pres", () => {
    const d = distanceVincenty(144.42486788888888, -37.951033416666664, 143.92649552777777, -37.65282113888889);
    expect(Math.abs(d - 54972.2711392)).toBeLessThan(0.001);
    const merid = distanceVincenty(-13.6, 9.6, -13.6, 9.7);
    expect(Math.abs(merid - 11060.54834327154)).toBeLessThan(0.01);
  });

  it("deux points identiques : zero ; la longueur d'une ligne est la somme de ses segments", () => {
    expect(distanceVincenty(-13.6, 9.6, -13.6, 9.6)).toBe(0);
    const l = longueurLigneGeodesique([[-13.6, 9.6], [-13.6, 9.65], [-13.6, 9.7]]);
    expect(Math.abs(l - distanceVincenty(-13.6, 9.6, -13.6, 9.7))).toBeLessThan(0.01);
  });
});

describe("aire d'un rectangle de graticule sur l'ellipsoide", () => {
  it("concorde avec ST_Area(geography) de PostGIS a 0,01 % pres pour un rectangle de 0,01 deg", () => {
    const a = aireRectangleEllipsoide(-13.6, -13.59, 9.6, 9.61);
    expect(Math.abs(a - 1214104.2271978855) / 1214104.2271978855).toBeLessThan(1e-4);
  });

  it("tend vers la sphere quand l'aplatissement disparait : un degre carre a l'equateur vaut ~12 308 km2", () => {
    const a = aireRectangleEllipsoide(0, 1, 0, 1);
    expect(a / 1e6).toBeGreaterThan(12_300);
    expect(a / 1e6).toBeLessThan(12_320);
  });
});

import { describe, expect, it } from "vitest";
import { cumuler, part, type CouvertureRegion } from "./couverture.reseau";

/**
 * Couverture a l'echelle du reseau : ce que ces tests defendent.
 *
 * LA FUSION DES RECOUVREMENTS EST EN SQL, ET ELLE A ETE EPROUVEE A PART
 *
 * Le cœur du calcul — fusionner les portions chevauchantes avant de sommer — vit dans la
 * requete, parce que la rappeler 261 387 fois en memoire est exclu. Elle a ete verifiee le
 * 14/10/2026 contre huit cas aux attendus calcules a la main, sur des intervalles litteraux
 * et sans toucher aux tables : disjoints (300 m), chevauchants (enveloppe 250 m), jointifs a
 * 3 cm donc fusionnes (200 m), separes de 1 m donc distincts (200 m), imbriques (300 m et non
 * 400), debordant le troncon (bornes a 500 m), commencant en negatif (bornes a 0), et sans
 * aucune portion (0). Les huit passent.
 *
 * Ce fichier couvre ce qui reste en TypeScript, et qui porte deux pieges.
 */

function region(p: Partial<CouvertureRegion>): CouvertureRegion {
  return {
    regionId: 1, region: "Test", troncons: 0, tronconsQualifies: 0,
    longueurTotaleM: 0, qualifieM: 0, part: null, ...p,
  };
}

describe("La part d'un perimetre vide n'est pas zero", () => {
  it("rend null quand il n'y a rien a diviser", () => {
    // Rendre 0 confondrait « rien n'est qualifie » avec « il n'y a rien a qualifier ». Le
    // premier est un constat sur le terrain, le second sur le filtre.
    expect(part(0, 0)).toBeNull();
    expect(part(0, -1)).toBeNull();
  });

  it("rend zero quand le perimetre existe mais que rien n'est qualifie", () => {
    // L'etat reel de la production au 14/10/2026 : 21 156,6 km, aucune portion.
    expect(part(0, 21156600)).toBe(0);
  });

  it("arrondit a quatre decimales, pas davantage", () => {
    expect(part(1, 3)).toBe(0.3333);
  });

  it("rend 1 pour un reseau entierement qualifie", () => {
    expect(part(1000, 1000)).toBe(1);
  });
});

describe("Le cumul des regions recalcule la part, il ne moyenne pas les parts", () => {
  it("ne donne pas le meme poids a Conakry et a Kankan", () => {
    // Conakry porte 79,8 km de reseau classe, Kankan 4 061,8 km. Moyenner les deux parts
    // donnerait 50 % alors que la couverture reelle est de 1,9 %.
    const lignes = [
      region({ regionId: 1, region: "Conakry", longueurTotaleM: 79800, qualifieM: 79800, part: 1 }),
      region({ regionId: 7, region: "Kankan", longueurTotaleM: 4061800, qualifieM: 0, part: 0 }),
    ];
    const total = cumuler(lignes);

    expect(total.longueurTotaleM).toBe(4141600);
    expect(total.qualifieM).toBe(79800);
    expect(total.part).toBe(0.0193);
    // La moyenne des parts aurait donne 0,5 : vingt-six fois trop.
    expect(total.part).not.toBe(0.5);
  });

  it("additionne les troncons et ceux qui sont qualifies", () => {
    const total = cumuler([
      region({ troncons: 265, tronconsQualifies: 3 }),
      region({ troncons: 315, tronconsQualifies: 0 }),
    ]);
    expect(total.troncons).toBe(580);
    expect(total.tronconsQualifies).toBe(3);
  });

  it("rend une part nulle pour un cumul de regions toutes vides", () => {
    expect(cumuler([region({}), region({})]).part).toBeNull();
  });

  it("rend un cumul coherent sur une liste vide, sans diviser par zero", () => {
    const total = cumuler([]);
    expect(total).toEqual({
      troncons: 0, tronconsQualifies: 0, longueurTotaleM: 0, qualifieM: 0, part: null,
    });
  });

  it("reproduit les totaux reels du reseau classe mesures le 14/10/2026", () => {
    // Les dix regions telles que la production les rend, couverture nulle partout.
    const reel = [
      ["Kankan", 265, 4061800], ["Labé", 315, 3275800], ["Nzérékoré", 271, 2662300],
      ["Boké", 168, 2494200], ["Kindia", 193, 2486200], ["Faranah", 172, 2408100],
      ["Mamou", 161, 1676600], ["Siguiri", 63, 1264500], ["Beyla", 38, 747300],
      ["Conakry", 45, 79800],
    ] as const;
    const total = cumuler(reel.map(([nom, n, m]) =>
      region({ region: nom, troncons: n, longueurTotaleM: m, qualifieM: 0, part: 0 })));

    expect(total.troncons).toBe(1691);
    expect(total.part).toBe(0);
    // 21 156,6 km : le chiffre publie par l'API publique. A 100 m pres, les arrondis
    // regionaux du relevé ne permettant pas mieux.
    expect(Math.abs(total.longueurTotaleM / 1000 - 21156.6)).toBeLessThan(0.2);
  });
});

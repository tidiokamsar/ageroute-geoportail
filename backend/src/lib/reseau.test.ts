import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Longueur du reseau : ce qui est SAISI ne doit jamais se confondre avec ce qui est
 * CALCULE.
 *
 * Le tableau de bord annoncait 7 933 km comme longueur du reseau national. C'etait la
 * somme des longueurs saisies, et le champ n'est renseigne que sur deux classes de
 * routes sur trois. Ces tests portent sur la seule chose qui compte : que les deux
 * valeurs restent separees, et que la couverture reelle soit dite.
 */

// Les chiffres reels de production au 01/09/2026, pour que les tests echouent si la
// separation metier / geometrique se perd.
const PRODUCTION = [
  { classe: "RN", troncons: 621n, avec_longueur: 621n, km_metier: 7840.12, km_geometrique: 7823.55 },
  { classe: "RR", troncons: 1029n, avec_longueur: 1n, km_metier: 56.0, km_geometrique: 13296.41 },
  { classe: "RU", troncons: 40n, avec_longueur: 40n, km_metier: 36.2, km_geometrique: 36.04 },
];

let lignes: unknown[] = PRODUCTION;

vi.mock("./prisma", () => ({
  prisma: { $queryRaw: vi.fn(async () => lignes) },
}));

import { longueurReseau } from "./reseau";

beforeEach(() => {
  lignes = PRODUCTION;
});

describe("Longueur du reseau", () => {
  it("ne confond pas la longueur saisie et la longueur calculée", async () => {
    const r = await longueurReseau();

    expect(r.metier.totalKm).toBeCloseTo(7932.32, 1);
    expect(r.geometrique.totalKm).toBeCloseTo(21156.0, 0);
    expect(r.metier.totalKm).not.toBe(r.geometrique.totalKm);
  });

  it("dit sur quelle part du réseau la longueur métier est connue", async () => {
    const r = await longueurReseau();

    expect(r.metier.tronconsTotal).toBe(1690);
    expect(r.metier.tronconsRenseignes).toBe(662);
    expect(r.metier.couverturePct).toBeCloseTo(39.17, 1);
  });

  it("expose la méthode de calcul, pas seulement le chiffre", async () => {
    const r = await longueurReseau();
    expect(r.geometrique.methode).toBe("ST_Length(geom::geography)");
  });

  it("montre que l'écart vient d'une seule classe", async () => {
    const r = await longueurReseau();
    const rr = r.parClasse.find((c) => c.classe === "RR")!;
    const rn = r.parClasse.find((c) => c.classe === "RN")!;

    // Les nationales concordent : rien a corriger de ce cote.
    expect(Math.abs(rn.kmMetier - rn.kmGeometrique) / rn.kmMetier).toBeLessThan(0.01);
    // Les regionales n'ont pratiquement aucune longueur saisie.
    expect(rr.tronconsAvecLongueurMetier).toBe(1);
    expect(rr.kmGeometrique).toBeGreaterThan(rr.kmMetier * 100);
  });

  it("ne divise pas par zéro sur une base vide", async () => {
    lignes = [];
    const r = await longueurReseau();

    expect(r.metier.totalKm).toBe(0);
    expect(r.geometrique.totalKm).toBe(0);
    expect(r.metier.couverturePct).toBe(0);
    expect(r.parClasse).toEqual([]);
  });

  it("convertit les bigint de PostgreSQL en nombres sérialisables", async () => {
    const r = await longueurReseau();
    for (const c of r.parClasse) {
      expect(typeof c.troncons).toBe("number");
      expect(typeof c.tronconsAvecLongueurMetier).toBe("number");
    }
    // Un bigint ferait echouer la serialisation de la reponse HTTP.
    expect(() => JSON.stringify(r)).not.toThrow();
  });

  it("supporte une classe sans aucune géométrie", async () => {
    lignes = [{ classe: "PISTE", troncons: 5n, avec_longueur: 0n, km_metier: 0, km_geometrique: null }];
    const r = await longueurReseau();

    expect(r.geometrique.totalKm).toBe(0);
    expect(r.parClasse[0].kmGeometrique).toBe(0);
  });
});

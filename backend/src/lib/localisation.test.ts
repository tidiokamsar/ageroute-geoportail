import { describe, expect, it } from "vitest";
import { localisationDe, repartitionLocalisation, REGION_NON_RENSEIGNEE, type ChantierALocaliser } from "./localisation";

/**
 * La regle du §17 : ne jamais presenter une localisation approximative comme precise,
 * et ne jamais inventer une position la ou il n'y en a aucune.
 *
 * 50 chantiers sur 488 sont rattaches a une entree nommee « Non renseigne », qui
 * n'est pas une region. Les placer au centre d'une zone par defaut creerait une
 * information fausse.
 */

const chantier = (p: Partial<ChantierALocaliser> = {}): ChantierALocaliser => ({
  aGeometrie: false,
  tronconId: null,
  pkDebut: null,
  pkFin: null,
  regionNom: "Kankan",
  ...p,
});

describe("Niveau de localisation d'un chantier", () => {
  it("reconnaît une emprise géométrique comme précise", () => {
    const l = localisationDe(chantier({ aGeometrie: true }));
    expect(l.statut).toBe("PRECISE");
    expect(l.cartographiable).toBe(true);
  });

  it("reconnaît un référencement linéaire complet", () => {
    const l = localisationDe(chantier({ tronconId: "t1", pkDebut: 24, pkFin: 66 }));
    expect(l.statut).toBe("LINEAIRE");
    expect(l.libelle).toMatch(/déduite des PK/);
  });

  it("ne prend pas une route connue pour une emprise", () => {
    // Sans PK, on sait quelle route, pas ou sur la route.
    const l = localisationDe(chantier({ tronconId: "t1" }));
    expect(l.statut).toBe("APPROXIMATIVE");
    expect(l.libelle).toMatch(/position inconnue/);
  });

  it("exige les DEUX points kilométriques", () => {
    expect(localisationDe(chantier({ tronconId: "t1", pkDebut: 24 })).statut).toBe("APPROXIMATIVE");
    expect(localisationDe(chantier({ tronconId: "t1", pkFin: 66 })).statut).toBe("APPROXIMATIVE");
  });

  it("accepte un PK de début à zéro", () => {
    // 0 est une valeur legitime : le piege serait de la traiter comme absente.
    const l = localisationDe(chantier({ tronconId: "t1", pkDebut: 0, pkFin: 12 }));
    expect(l.statut).toBe("LINEAIRE");
  });

  it("classe une région réelle en approximatif, et le dit", () => {
    const l = localisationDe(chantier({ regionNom: "Boké" }));
    expect(l.statut).toBe("APPROXIMATIVE");
    expect(l.libelle).toMatch(/non localisée/);
    expect(l.fondement).toMatch(/Boké/);
  });

  it("SORT DE LA CARTE les chantiers sans localisation", () => {
    // Le point central du ticket : 50 chantiers ne doivent pas apparaitre.
    const l = localisationDe(chantier({ regionNom: REGION_NON_RENSEIGNEE }));
    expect(l.statut).toBe("NONE");
    expect(l.cartographiable).toBe(false);
    expect(l.fondement).toMatch(/n'est pas une région/);
  });

  it("traite une région absente ou vide comme une absence de localisation", () => {
    for (const region of [null, "", "   "]) {
      const l = localisationDe(chantier({ regionNom: region }));
      expect(l.statut).toBe("NONE");
      expect(l.cartographiable).toBe(false);
    }
  });

  it("laisse cartographiables tous les niveaux sauf NONE", () => {
    const cas: ChantierALocaliser[] = [
      chantier({ aGeometrie: true }),
      chantier({ tronconId: "t1", pkDebut: 1, pkFin: 2 }),
      chantier({ tronconId: "t1" }),
      chantier({ regionNom: "Labé" }),
    ];
    for (const c of cas) expect(localisationDe(c).cartographiable).toBe(true);
  });

  it("donne toujours un fondement lisible", () => {
    const cas = [
      chantier({ aGeometrie: true }),
      chantier({ tronconId: "t1", pkDebut: 1, pkFin: 2 }),
      chantier({ regionNom: "Mamou" }),
      chantier({ regionNom: REGION_NON_RENSEIGNEE }),
    ];
    for (const c of cas) expect(localisationDe(c).fondement.length).toBeGreaterThan(8);
  });

  it("retrouve la répartition mesurée en production", () => {
    // 6 precis, 0 lineaire, 432 approximatifs, 50 sans localisation.
    const population: ChantierALocaliser[] = [
      ...Array.from({ length: 6 }, () => chantier({ aGeometrie: true })),
      ...Array.from({ length: 432 }, () => chantier({ regionNom: "Conakry" })),
      ...Array.from({ length: 50 }, () => chantier({ regionNom: REGION_NON_RENSEIGNEE })),
    ];
    expect(repartitionLocalisation(population)).toEqual({
      PRECISE: 6,
      LINEAIRE: 0,
      APPROXIMATIVE: 432,
      NONE: 50,
    });
  });
});

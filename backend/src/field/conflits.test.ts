import { describe, expect, it } from "vitest";
import { peutArbitrer, resolutionsPossibles } from "./conflits";

/**
 * Ce que l'ecran des conflits annonce AVANT le clic doit etre ce que la route `POST /sync/resolve` fait.
 * Les trois refus de LOCAL y sont ecrits (creation, defaut, operation inconnue) ; l'accord avec la route
 * reelle est verifie contre une base par `tests-integration/conflits-sync.integration.mts` (L4).
 */
describe("resolutionsPossibles", () => {
  it("permet LOCAL pour la modification et la suppression d'une observation", () => {
    for (const operation of ["UPDATE", "DELETE"]) {
      expect(resolutionsPossibles("Observation", operation)).toEqual({ SERVEUR: true, LOCAL: true, motifLocalImpossible: null });
    }
  });

  it("refuse LOCAL pour une creation en conflit : la retenir remplacerait une ligne existante", () => {
    const r = resolutionsPossibles("Observation", "CREATE");
    expect(r.LOCAL).toBe(false);
    expect(r.motifLocalImpossible).toMatch(/nouvel identifiant/);
  });

  it("refuse LOCAL pour un defaut, quelle que soit l'operation", () => {
    for (const operation of ["CREATE", "UPDATE", null]) {
      expect(resolutionsPossibles("Defaut", operation).LOCAL).toBe(false);
    }
  });

  it("refuse LOCAL pour un type ou une operation inconnus, sans inventer de permission", () => {
    expect(resolutionsPossibles("Portion", "CREATE").LOCAL).toBe(false);
    expect(resolutionsPossibles("Observation", null).LOCAL).toBe(false);
    expect(resolutionsPossibles("Observation", "AUTRE").LOCAL).toBe(false);
  });

  it("garde toujours SERVEUR possible : retenir l'existant n'ecrase rien", () => {
    for (const [type, op] of [["Observation", "CREATE"], ["Defaut", "CREATE"], ["Portion", null]] as const) {
      expect(resolutionsPossibles(type, op).SERVEUR).toBe(true);
    }
  });
});

describe("peutArbitrer", () => {
  it("reserve l'arbitrage aux responsables", () => {
    expect(peutArbitrer("ADMIN")).toBe(true);
    expect(peutArbitrer("GESTIONNAIRE")).toBe(true);
    expect(peutArbitrer("INSPECTEUR")).toBe(false);
    expect(peutArbitrer("LECTEUR")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { metrer, quantite, statutQualiteQuantite, EXPLICATIONS, type MetreEmprise, type TypeDefaut } from "./defauts.regles";

/**
 * A5 : la quantite d'un defaut tiree de son CONTOUR GPS, mesure en UTM (jamais en degres).
 *
 * Le moteur est pur : il recoit la mesure de l'emprise (faite par PostGIS, `metre_utm`) et decide de
 * ce qu'elle vaut. La mesure elle-meme est eprouvee en base par
 * `tests-integration/metre-defaut.integration.mts`, contre des figures dont la taille est connue
 * par construction.
 */
const ligne = (longueurM: number): MetreEmprise => ({ type: "ligne", longueurM, surfaceM2: null });
const surface = (surfaceM2: number, perimetre = 40): MetreEmprise => ({ type: "surface", longueurM: perimetre, surfaceM2 });

const FISSURE: TypeDefaut = { code: "FISSURE", unite: "METRE", mesuresRequises: ["LONGUEUR"], graviteMax: 4 };
const FAIENCAGE: TypeDefaut = { code: "FAIENCAGE", unite: "METRE_CARRE", mesuresRequises: ["LONGUEUR", "LARGEUR"], graviteMax: 4 };
const NID: TypeDefaut = { code: "NID", unite: "METRE_CUBE", mesuresRequises: ["LONGUEUR", "LARGEUR", "PROFONDEUR"], graviteMax: 4 };
const SIGNAL: TypeDefaut = { code: "SIGNAL", unite: "UNITE", mesuresRequises: ["NOMBRE"], graviteMax: null };

describe("quantite par emprise", () => {
  it("METRE : la longueur du contour, methode EMPRISE_UTM", () => {
    expect(quantite({}, "METRE", null, null, ligne(123.4567))).toEqual({ valeur: 123.457, methode: "EMPRISE_UTM" });
  });

  it("METRE_CARRE : la surface du contour", () => {
    expect(quantite({}, "METRE_CARRE", null, null, surface(10000))).toEqual({ valeur: 10000, methode: "EMPRISE_UTM" });
  });

  it("METRE_CARRE avec une ligne et une largeur saisie : longueur mesuree x largeur", () => {
    expect(quantite({ largeurM: 3 }, "METRE_CARRE", null, null, ligne(50))).toEqual({ valeur: 150, methode: "EMPRISE_UTM" });
  });

  it("METRE_CUBE : surface x profondeur ; ligne x largeur x profondeur", () => {
    expect(quantite({ profondeurM: 0.1 }, "METRE_CUBE", null, null, surface(12))).toEqual({ valeur: 1.2, methode: "EMPRISE_UTM" });
    expect(quantite({ largeurM: 2, profondeurM: 0.1 }, "METRE_CUBE", null, null, ligne(30))).toEqual({ valeur: 6, methode: "EMPRISE_UTM" });
  });

  it("UNITE : un contour ne donne jamais un nombre, qui se compte", () => {
    expect(quantite({ nombre: 3 }, "UNITE", null, null, surface(50))).toEqual({ valeur: 3, methode: "COMPTAGE" });
  });

  it("le CONSTAT SAISI l'emporte sur le contour mesure", () => {
    expect(quantite({ quantiteSaisie: 8 }, "METRE_CARRE", null, null, surface(10000))).toEqual({ valeur: 8, methode: "SAISIE" });
  });

  it("le contour l'emporte sur le rectangle longueur x largeur et sur le comptage conventionnel", () => {
    expect(quantite({ longueurM: 2, largeurM: 2 }, "METRE_CARRE", null, null, surface(7))).toEqual({ valeur: 7, methode: "EMPRISE_UTM" });
    expect(quantite({ nombre: 12 }, "METRE_CARRE", null, 0.5, surface(7))).toEqual({ valeur: 7, methode: "EMPRISE_UTM" });
  });

  it("un contour qui ne donne rien dans l'unite du type n'est pas une erreur : les autres mesures decident", () => {
    // Un polygone pour un METRE, une ligne sans largeur pour un METRE_CARRE.
    expect(quantite({ longueurM: 40 }, "METRE", null, null, surface(100))).toEqual({ valeur: 40, methode: "LONGUEUR" });
    expect(quantite({ nombre: 12 }, "METRE_CARRE", null, 0.5, ligne(50))).toEqual({ valeur: 6, methode: "COMPTAGE_COEFFICIENT" });
    expect(quantite({}, "METRE_CARRE", null, null, ligne(50))).toEqual({ valeur: null, motif: "MESURES_INSUFFISANTES" });
  });

  it("un contour sans longueur ni surface exploitable est REFUSE (EMPRISE_ABERRANTE), pas ignore", () => {
    expect(quantite({ longueurM: 5 }, "METRE", null, null, ligne(0))).toEqual({ valeur: null, motif: "EMPRISE_ABERRANTE" });
    expect(quantite({}, "METRE_CARRE", null, null, surface(Number.NaN))).toEqual({ valeur: null, motif: "EMPRISE_ABERRANTE" });
    expect(quantite({}, "METRE", null, null, ligne(-3))).toEqual({ valeur: null, motif: "EMPRISE_ABERRANTE" });
  });

  it("une ligne plus longue que le troncon qui la porte est refusee, comme une longueur saisie", () => {
    expect(quantite({}, "METRE", 2200, null, ligne(2500))).toEqual({ valeur: null, motif: "DEPASSE_LE_TRONCON" });
    expect(quantite({}, "METRE", 2200, null, ligne(2100))).toEqual({ valeur: 2100, methode: "EMPRISE_UTM" });
  });

  it("sans emprise, rien ne change", () => {
    expect(quantite({ longueurM: 4, largeurM: 3 }, "METRE_CARRE")).toEqual({ valeur: 12, methode: "LONGUEUR_LARGEUR" });
    expect(quantite({ longueurM: 4, largeurM: 3 }, "METRE_CARRE", null, null, null)).toEqual({ valeur: 12, methode: "LONGUEUR_LARGEUR" });
  });
});

describe("metrer avec une emprise : les mesures que le contour remplace", () => {
  it("un faiencage exige longueur et largeur : un POLYGONE les remplace", () => {
    expect(metrer({}, FAIENCAGE, null, surface(300))).toEqual({ valeur: 300, unite: "METRE_CARRE", methode: "EMPRISE_UTM" });
    // ... sans contour, le releve reste incomplet et nomme ce qui manque.
    expect(metrer({}, FAIENCAGE, null, null)).toEqual({ valeur: null, motif: "RELEVE_INCOMPLET", manquantes: ["LONGUEUR", "LARGEUR"] });
  });

  it("une fissure exige une longueur : une LIGNE la remplace, un polygone non", () => {
    expect(metrer({}, FISSURE, null, ligne(87))).toEqual({ valeur: 87, unite: "METRE", methode: "EMPRISE_UTM" });
    expect(metrer({}, FISSURE, null, surface(87))).toEqual({ valeur: null, motif: "RELEVE_INCOMPLET", manquantes: ["LONGUEUR"] });
  });

  it("la PROFONDEUR n'est jamais remplacee par un contour", () => {
    expect(metrer({}, NID, null, surface(2))).toEqual({ valeur: null, motif: "RELEVE_INCOMPLET", manquantes: ["PROFONDEUR"] });
    expect(metrer({ profondeurM: 0.08 }, NID, null, surface(2))).toEqual({ valeur: 0.16, unite: "METRE_CUBE", methode: "EMPRISE_UTM" });
  });

  it("le NOMBRE d'un type qui se compte n'est jamais remplace", () => {
    expect(metrer({}, SIGNAL, null, surface(10))).toEqual({ valeur: null, motif: "RELEVE_INCOMPLET", manquantes: ["NOMBRE"] });
  });

  it("une mesure saisie fausse est signalee avant le contour", () => {
    expect(metrer({ longueurM: -1 }, FISSURE, null, ligne(10))).toEqual({ valeur: null, motif: "MESURE_ABERRANTE" });
  });

  it("un contour aberrant est signale en premier, avec une explication lisible par un agent", () => {
    expect(metrer({ longueurM: 5 }, FISSURE, null, ligne(0))).toEqual({ valeur: null, motif: "EMPRISE_ABERRANTE" });
    expect(EXPLICATIONS.EMPRISE_ABERRANTE).toMatch(/contour/);
  });
});

describe("provenance d'une quantite par emprise", () => {
  it("est DERIVED : un contour releve puis mesure n'est pas un constat saisi au decametre", () => {
    expect(statutQualiteQuantite("EMPRISE_UTM")).toBe("DERIVED");
  });
});

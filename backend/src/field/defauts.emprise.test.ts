import { describe, expect, it } from "vitest";
import { compatible, empriseComble, mesuresRemplacees, quantiteParEmprise } from "./defauts.emprise";
import { statutQualiteQuantite } from "./defauts.regles";

/**
 * Metre par l'emprise : ce que ces tests defendent.
 *   - une ligne metre un defaut en metres, un polygone un defaut en metres carres, rien d'autre ;
 *   - l'emprise ne comble que les mesures qu'elle remplace : jamais la profondeur, jamais un comptage ;
 *   - une quantite par emprise est DERIVEE ;
 *   - un defaut lineaire plus long que son troncon est refuse, comme une longueur mesuree.
 */
describe("Compatibilite emprise / unite", () => {
  it.each([
    ["METRE", "LineString", ["LONGUEUR"]],
    ["METRE_CARRE", "Polygon", ["LONGUEUR", "LARGEUR"]],
    ["METRE", "Polygon", []],
    ["METRE_CARRE", "LineString", []],
    ["METRE_CUBE", "Polygon", []],
    ["UNITE", "LineString", []],
  ] as const)("%s + %s remplace %j", (u, d, attendu) => {
    expect(mesuresRemplacees(u, d)).toEqual(attendu);
    expect(compatible(u, d)).toBe(attendu.length > 0);
  });
});

describe("empriseComble", () => {
  it("comble un releve sans mesures ou ne manquant que de celles qu'elle remplace", () => {
    expect(empriseComble({ valeur: null, motif: "MESURES_INSUFFISANTES" }, "METRE_CARRE", "Polygon")).toBe(true);
    expect(empriseComble({ valeur: null, motif: "RELEVE_INCOMPLET", manquantes: ["LONGUEUR", "LARGEUR"] }, "METRE_CARRE", "Polygon")).toBe(true);
  });
  it("ne comble ni la profondeur, ni une mesure aberrante, ni un metre deja obtenu", () => {
    expect(empriseComble({ valeur: null, motif: "RELEVE_INCOMPLET", manquantes: ["LONGUEUR", "PROFONDEUR"] }, "METRE", "LineString")).toBe(false);
    expect(empriseComble({ valeur: null, motif: "MESURE_ABERRANTE" }, "METRE", "LineString")).toBe(false);
    expect(empriseComble({ valeur: 3, unite: "METRE", methode: "LONGUEUR" }, "METRE", "LineString")).toBe(false);
  });
});

describe("quantiteParEmprise", () => {
  it("prend la longueur d'une ligne, la surface d'un polygone, arrondies au millieme", () => {
    expect(quantiteParEmprise("METRE", "LineString", { longueurM: 12.34567, surfaceM2: 0 })).toEqual({ valeur: 12.346, methode: "EMPRISE_UTM" });
    expect(quantiteParEmprise("METRE_CARRE", "Polygon", { longueurM: 40, surfaceM2: 99.9999 })).toEqual({ valeur: 100, methode: "EMPRISE_UTM" });
  });
  it("refuse incompatible, degeneree, ou plus longue que le troncon", () => {
    expect(quantiteParEmprise("METRE", "Polygon", { longueurM: 4, surfaceM2: 1 })).toEqual({ valeur: null, motif: "EMPRISE_INCOMPATIBLE" });
    expect(quantiteParEmprise("METRE_CARRE", "Polygon", { longueurM: 0, surfaceM2: 0 })).toEqual({ valeur: null, motif: "EMPRISE_DEGENEREE" });
    expect(quantiteParEmprise("METRE", "LineString", { longueurM: 2500, surfaceM2: 0 }, 2000)).toEqual({ valeur: null, motif: "DEPASSE_LE_TRONCON" });
  });
  it("une surface de polygone plus grande que la longueur du troncon reste admise", () => {
    expect(quantiteParEmprise("METRE_CARRE", "Polygon", { longueurM: 900, surfaceM2: 5000 }, 200).valeur).toBe(5000);
  });
  it("la quantite par emprise est DERIVEE", () => {
    expect(statutQualiteQuantite("EMPRISE_UTM")).toBe("DERIVED");
  });
});

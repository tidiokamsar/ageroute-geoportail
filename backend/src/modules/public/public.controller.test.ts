import { describe, expect, it } from "vitest";
import { toleranceSelonZoom } from "./public.controller";

/**
 * Simplification de la carte publique selon le zoom.
 *
 * Ce n'est pas un reglage cosmetique : la geometrie brute pese 2 366 ko, et elle est
 * servie a chaque chargement de la carte publique — donc a chaque visiteur, souvent
 * sur une connexion mobile guineenne. Les paliers decident de ce qu'on lui fait
 * telecharger.
 */

describe("Les paliers suivent ce que l'ecran peut montrer", () => {
  it("simplifie le plus a l'echelle du pays", () => {
    // Au zoom 7, la Guinee entiere tient a l'ecran : 220 m sont sous le pixel.
    expect(toleranceSelonZoom(7)).toBe(0.002);
  });

  it("affine a l'echelle regionale puis urbaine", () => {
    expect(toleranceSelonZoom(11)).toBe(0.0005);
    expect(toleranceSelonZoom(14)).toBe(0.0001);
  });

  it("ne simplifie plus au plus pres — c'est la forme exacte qu'on regarde", () => {
    expect(toleranceSelonZoom(16)).toBe(0);
    expect(toleranceSelonZoom(19)).toBe(0);
  });

  it("est monotone : plus on zoome, moins on simplifie", () => {
    const paliers = [7, 10, 13, 16, 19].map(toleranceSelonZoom);
    for (let i = 1; i < paliers.length; i++) {
      expect(paliers[i]).toBeLessThanOrEqual(paliers[i - 1]);
    }
  });
});

describe("Un zoom absent ou aberrant protege le visiteur", () => {
  it("retombe sur le palier le plus grossier, pas sur la geometrie brute", () => {
    // La valeur par defaut doit proteger celui qui n'a rien demande, pas le penaliser
    // en lui envoyant 2 366 ko.
    for (const z of [undefined, null, "", "abc", NaN]) {
      expect(toleranceSelonZoom(z), String(z)).toBe(0.002);
    }
  });

  it("refuse un zoom negatif ou absurde", () => {
    expect(toleranceSelonZoom(-5)).toBe(0.002);
    expect(toleranceSelonZoom(-Infinity)).toBe(0.002);
  });

  it("accepte un zoom transmis en chaine, comme le fait une query string", () => {
    expect(toleranceSelonZoom("7")).toBe(0.002);
    expect(toleranceSelonZoom("16")).toBe(0);
  });

  it("traite un zoom demesurement grand comme le plus fin", () => {
    // Aucun fond de plan ne va au-dela de 20 ; mieux vaut rendre l'exact que rien.
    expect(toleranceSelonZoom(99)).toBe(0);
  });
});

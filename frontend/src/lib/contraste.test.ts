import { describe, expect, it } from "vitest";
import { assombrirPour, estHex, hexVersRvb, ratioContraste, rvbVersHex, surFond } from "./contraste";

describe("calcul de contraste WCAG", () => {
  it("noir sur blanc vaut 21:1, une couleur sur elle-meme 1:1", () => {
    expect(ratioContraste("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(ratioContraste("#1a2942", "#1a2942")).toBeCloseTo(1, 5);
  });

  it("reproduit les mesures publiees des anciens gris de texte sur blanc", () => {
    // Valeurs relevees dans docs/accessibilite/CONTRASTE.md et recoupees avec axe-core.
    expect(ratioContraste("#9ca3af", "#ffffff")).toBeCloseTo(2.54, 2);
    expect(ratioContraste("#6b7280", "#ffffff")).toBeCloseTo(4.83, 2);
    expect(ratioContraste("#f5a623", "#ffffff")).toBeCloseTo(2.03, 2);
  });

  it("est symetrique", () => {
    expect(ratioContraste("#1a2942", "#f5a623")).toBeCloseTo(ratioContraste("#f5a623", "#1a2942"), 10);
  });

  it("lit #rgb comme #rrggbb et refuse les autres formes", () => {
    expect(hexVersRvb("#fff")).toEqual([255, 255, 255]);
    expect(hexVersRvb("#1A2942")).toEqual([26, 41, 66]);
    expect(() => hexVersRvb("rgb(0,0,0)")).toThrow();
    expect(estHex("#12345")).toBe(false);
    expect(estHex("var(--x)")).toBe(false);
    expect(rvbVersHex([26, 41, 66])).toBe("#1a2942");
  });

  it("superpose une couleur translucide sur un fond", () => {
    expect(surFond("#ffffff", 0.5, "#000000")).toBe("#808080");
    expect(surFond("#ffffff", 0, "#1a2942")).toBe("#1a2942");
  });
});

describe("assombrirPour", () => {
  it("rend telle quelle une couleur deja assez contrastee", () => {
    expect(assombrirPour("#1a2942")).toBe("#1a2942");
  });

  it("assombrit l'or jusqu'a 4,5:1 sur blanc en gardant une teinte or", () => {
    const r = assombrirPour("#f5a623");
    expect(ratioContraste(r, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    const [rr, gg, bb] = hexVersRvb(r);
    expect(rr).toBeGreaterThan(gg); // la teinte chaude est conservee
    expect(gg).toBeGreaterThan(bb);
  });

  it("atteint le seuil demande sur n'importe quel fond", () => {
    const r = assombrirPour("#0891b2", "#f3f4f6", 4.5);
    expect(ratioContraste(r, "#f3f4f6")).toBeGreaterThanOrEqual(4.5);
  });
});

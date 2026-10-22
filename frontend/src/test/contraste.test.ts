import { describe, expect, it } from "vitest";
import { mesurer, palette, ratio } from "./contraste";

/**
 * Contraste des textes (WCAG 2.1, 1.4.3, AA) mesuré sur le code source : voir `contraste.ts` pour
 * la méthode et ses limites. Ce test échoue dès qu'une paire texte / fond passe sous 4,5:1 (3:1 en
 * grand texte), en nommant le fichier et la ligne.
 *
 * EN SUSPENS, ET POURQUOI : deux fichiers sont modifiés par une autre session au 22/10/2026 (travail
 * non commité sur la programmation et les rapports). Les corriger ici aurait écrasé ce travail à la
 * fusion. Leurs défauts sont COMPTÉS, pas ignorés : le test échoue si leur nombre change, dans un sens
 * ou dans l'autre, pour qu'on retire l'exemption au lieu de l'oublier.
 */
const EN_SUSPENS: Record<string, number> = {
  "pages/ProgrammationPage.tsx": 2,
  "pages/RapportsPage.tsx": 19,
};

describe("La formule est celle de WCAG", () => {
  it("21:1 noir sur blanc, 1:1 une couleur sur elle-même, gris 500 sur blanc à 4,83:1", () => {
    expect(ratio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(ratio("#6b7280", "#6b7280")).toBeCloseTo(1, 5);
    expect(ratio(palette()["gray-500"], "#ffffff")).toBeCloseTo(4.83, 2);
  });
  it("la palette vient de Tailwind installé et de la charte", () => {
    const p = palette();
    expect(p["gray-400"]).toBe("#9ca3af");
    expect(p.navy).toBe("#1a2942");
    expect(p.background).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("Contraste des textes du code source", () => {
  const r = mesurer();
  it("juge assez de paires pour que la mesure veuille dire quelque chose", () => {
    expect(r.juges).toBeGreaterThan(1000);
  });
  it("aucun échec hors des fichiers en suspens", () => {
    const hors = r.echecs.filter((e) => !(e.fichier in EN_SUSPENS)).map((e) => `${e.fichier}:${e.ligne} ${e.texte} sur ${e.fond} = ${e.ratio}:1 (seuil ${e.seuil})`);
    expect(hors).toEqual([]);
  });
  it.each(Object.entries(EN_SUSPENS))("%s : %i défauts comptés, en attente de la fusion", (fichier, n) => {
    expect(r.echecs.filter((e) => e.fichier === fichier)).toHaveLength(n);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { violationsAccessibilite } from "../../test/accessibilite";
import { ecranEtroit, longueurDeclareeKm, styleTroncon, TRAIT_ETAT_DECLARE } from "./affichageTroncon";
import { LegendeEtat } from "./LegendeEtat";
import { echapDansAutreDialogue } from "./echap";
import { ETAT_COLORS, type TronconGeoFeature } from "./types";

/**
 * Carte interne : un état DÉCLARÉ ne se peint pas comme un état CONSTATÉ.
 *
 * Même couleur d'état, mais trait pointillé ; la légende le dit ; sous un curseur temporel, le
 * tracé de référence est gris et uni (il ne porte aucun état). Ces tests défendent aussi le repli
 * du panneau des couches sur téléphone, que la page lit via `ecranEtroit()`.
 */
const base: TronconGeoFeature = {
  id: "t", code: "RN1", nom: "RN1", classe: "RN", etat: "BON", longueurKm: 10, region: null, geometry: "{}",
};

describe("styleTroncon", () => {
  it("un état constaté (ou sans mention) est tracé en trait plein, de la couleur de son état", () => {
    expect(styleTroncon(base, false)).toEqual({ color: ETAT_COLORS.BON, weight: 4, dashArray: undefined });
    expect(styleTroncon({ ...base, etatDeclare: false }, false).dashArray).toBeUndefined();
  });

  it("un état seulement déclaré garde la couleur de son état mais passe en pointillé", () => {
    const s = styleTroncon({ ...base, etat: "MAUVAIS", etatDeclare: true }, false);
    expect(s.color).toBe(ETAT_COLORS.MAUVAIS);
    expect(s.dashArray).toBe(TRAIT_ETAT_DECLARE);
  });

  it("sous le curseur temporel, le tracé de référence est gris et plein, déclaré ou non", () => {
    const s = styleTroncon({ ...base, etatDeclare: true }, true);
    expect(s).toEqual({ color: "#9aa0aa", weight: 3, opacity: 0.8 });
  });

  it("un tronçon inconnu retombe sur la couleur neutre", () => {
    expect(styleTroncon(undefined, false).color).toBe("#1a2942");
  });
});

describe("longueurDeclareeKm", () => {
  it("ne somme que les tronçons à l'état déclaré", () => {
    expect(longueurDeclareeKm([
      { etatDeclare: true, longueurKm: 4 }, { etatDeclare: false, longueurKm: 100 }, { longueurKm: 7 }, { etatDeclare: true, longueurKm: 1.5 },
    ])).toBe(5.5);
  });
});

describe("LegendeEtat", () => {
  it("garde les cinq états et ajoute l'entrée « trait pointillé : état déclaré »", () => {
    render(<LegendeEtat />);
    expect(screen.getByText(/Trait pointillé : état déclaré, non constaté sur le terrain/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "État de la chaussée" })).toBeInTheDocument();
  });

  it("n'a pas de violation d'accessibilité détectable", async () => {
    const { container } = render(<LegendeEtat />);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

describe("ecranEtroit : panneau des couches replié par défaut sur téléphone", () => {
  const original = window.matchMedia;
  afterEach(() => { window.matchMedia = original; });

  function simuler(largeur: number) {
    window.matchMedia = vi.fn((q: string) => {
      const max = /max-width:\s*(\d+)px/.exec(q);
      return { matches: max ? largeur <= Number(max[1]) : false, media: q } as MediaQueryList;
    });
  }

  it("vrai sous 768 px (téléphone), faux au-delà (bureau)", () => {
    simuler(375);
    expect(ecranEtroit()).toBe(true);
    simuler(767);
    expect(ecranEtroit()).toBe(true);
    simuler(768);
    expect(ecranEtroit()).toBe(false);
    simuler(1440);
    expect(ecranEtroit()).toBe(false);
  });

  it("sans matchMedia (jsdom, vieux navigateur), on suppose un bureau : panneau ouvert comme avant", () => {
    // @ts-expect-error simulation d'un environnement sans l'API
    window.matchMedia = undefined;
    expect(ecranEtroit()).toBe(false);
  });
});

describe("echapDansAutreDialogue", () => {
  it("ignore un Echap déjà traité ou destiné à une boîte de dialogue ouverte", () => {
    const dialogue = document.createElement("div");
    dialogue.setAttribute("role", "dialog");
    dialogue.setAttribute("data-state", "open");
    const champ = document.createElement("input");
    dialogue.appendChild(champ);
    document.body.appendChild(dialogue);

    const dedans = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    champ.dispatchEvent(dedans);
    expect(echapDansAutreDialogue(Object.defineProperty(dedans, "target", { value: champ }))).toBe(true);

    const libre = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    Object.defineProperty(libre, "target", { value: document.body });
    expect(echapDansAutreDialogue(libre)).toBe(false);
    dialogue.remove();
  });
});

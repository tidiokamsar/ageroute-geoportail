import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InfoBulle } from "./InfoBulle";
import { ecouteursOrphelins, espionnerEcouteurs } from "./ecouteurs.testutil";

/**
 * Hygiene des ecouteurs (EO-FIX-FRONT 3) : l'info-bulle pose deux ecouteurs sur `document` tant qu'elle est ouverte ; ils partent a la
 * fermeture ET au demontage, sinon ils retiendraient le composant (et son arbre DOM) apres le depart de la page.
 */

afterEach(() => { vi.restoreAllMocks(); });

describe("InfoBulle : aucun ecouteur ne survit", () => {
  it("ouverte puis demontee : tous les ecouteurs de document et window sont retires", () => {
    const { getByRole, unmount } = render(<InfoBulle libelle="Taux"><span>texte</span></InfoBulle>);
    const espion = espionnerEcouteurs(); // apres le rendu : on ne compte que ce que l'info-bulle pose elle-meme
    fireEvent.click(getByRole("button", { name: "Définition : Taux" }));
    expect(espion.ajouts.some((a) => a.type === "keydown")).toBe(true); // elle ecoute bien tant qu'elle est ouverte
    unmount();
    expect(ecouteursOrphelins(espion)).toEqual([]);
  });

  it("ouverte puis fermee par Echap : plus aucun ecouteur", () => {
    const { getByRole } = render(<InfoBulle libelle="Taux"><span>texte</span></InfoBulle>);
    const espion = espionnerEcouteurs();
    fireEvent.click(getByRole("button", { name: "Définition : Taux" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(ecouteursOrphelins(espion)).toEqual([]);
  });
});

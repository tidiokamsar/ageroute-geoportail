import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `useMap` est remplace par un double qui rend un conteneur choisi par le test : jsdom ne rend pas Leaflet (voir vitest.config.ts). Ce qui est
 * verifie ici est le CONTRAT du composant : quels elements recoivent `tabindex="-1"`, quand, et que l'observateur est bien deconnecte.
 * La mesure du comportement reel (arrets de Tab) est faite dans Chromium, pas ici.
 */
const etat = vi.hoisted(() => ({ carte: { getContainer: undefined as unknown as (() => HTMLElement | null) | undefined } }));
vi.mock("react-leaflet", () => ({ useMap: () => etat.carte }));

import { ElementsCarteHorsTabulation, SELECTEUR_ELEMENTS_TABULABLES } from "./ElementsCarteHorsTabulation";

let conteneur: HTMLDivElement;

function ajouter(balise: string, attrs: Record<string, string>): HTMLElement {
  const e = document.createElement(balise);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  conteneur.appendChild(e);
  return e;
}

beforeEach(() => {
  conteneur = document.createElement("div");
  etat.carte.getContainer = () => conteneur;
});
afterEach(() => { vi.restoreAllMocks(); });

describe("ElementsCarteHorsTabulation", () => {
  it("retire de la tabulation les traces et les icones deja presentes, et seulement eux", () => {
    const trace = ajouter("path", { class: "leaflet-interactive" });
    const icone = ajouter("div", { class: "leaflet-marker-icon", tabindex: "0" });
    const groupe = ajouter("div", { class: "leaflet-marker-icon marker-cluster", tabindex: "0" });
    const traceNonInteractive = ajouter("path", { class: "leaflet-zoom-animated" });
    const bouton = ajouter("a", { class: "leaflet-control-zoom-in", href: "#" });
    const champ = ajouter("input", { type: "search" });
    render(<ElementsCarteHorsTabulation />);
    expect(trace).toHaveAttribute("tabindex", "-1");
    expect(icone).toHaveAttribute("tabindex", "-1");
    expect(groupe).toHaveAttribute("tabindex", "-1");
    // Ni le trace non interactif, ni les commandes de zoom, ni un champ de recherche ne sont touches.
    expect(traceNonInteractive).not.toHaveAttribute("tabindex");
    expect(bouton).not.toHaveAttribute("tabindex");
    expect(champ).not.toHaveAttribute("tabindex");
  });

  it("corrige aussi les elements AJOUTES apres coup, a n'importe quelle profondeur (zoom, rechargement d'un calque)", async () => {
    render(<ElementsCarteHorsTabulation />);
    const volet = ajouter("div", { class: "leaflet-overlay-pane" });
    const tardifs = [document.createElement("path"), document.createElement("div")];
    tardifs[0].setAttribute("class", "leaflet-interactive");
    tardifs[1].setAttribute("class", "leaflet-marker-icon");
    tardifs[1].setAttribute("tabindex", "0");
    for (const t of tardifs) volet.appendChild(t);
    await waitFor(() => {
      for (const t of tardifs) expect(t).toHaveAttribute("tabindex", "-1");
    });
  });

  it("ne reecrit pas un tabindex deja a -1 (le selecteur l'exclut)", () => {
    const deja = ajouter("path", { class: "leaflet-interactive", tabindex: "-1" });
    expect(deja.matches(SELECTEUR_ELEMENTS_TABULABLES)).toBe(false);
    const espion = vi.spyOn(Element.prototype, "setAttribute");
    render(<ElementsCarteHorsTabulation />);
    expect(espion.mock.calls.filter(([nom]) => nom === "tabindex")).toHaveLength(0);
  });

  it("se deconnecte au demontage : un element ajoute ensuite n'est plus touche", async () => {
    const deconnexion = vi.spyOn(MutationObserver.prototype, "disconnect");
    const { unmount } = render(<ElementsCarteHorsTabulation />);
    unmount();
    expect(deconnexion).toHaveBeenCalledTimes(1);
    const apres = ajouter("path", { class: "leaflet-interactive" });
    // Les rappels de MutationObserver sont des micro-taches : on laisse la file se vider avant de conclure.
    await new Promise((r) => setTimeout(r, 20));
    expect(apres).not.toHaveAttribute("tabindex");
  });

  it("ne leve pas et ne touche rien quand la carte n'a pas de conteneur lisible", () => {
    etat.carte.getContainer = undefined;
    expect(() => render(<ElementsCarteHorsTabulation />)).not.toThrow();
    etat.carte.getContainer = () => null;
    expect(() => render(<ElementsCarteHorsTabulation />)).not.toThrow();
  });

  it("ne rend aucun element dans le DOM", () => {
    const { container } = render(<ElementsCarteHorsTabulation />);
    expect(container).toBeEmptyDOMElement();
  });
});

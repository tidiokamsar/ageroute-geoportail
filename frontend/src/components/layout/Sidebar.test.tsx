import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * Menu lateral : ce que ces tests defendent.
 *   - une seule entree est active a la fois, meme quand l'adresse d'une entree est le PREFIXE de celle
 *     d'une autre (/veille et /veille/configuration) : sans cela, deux entrees paraissent actives ;
 *   - le groupe « Releve terrain » existe et porte les quatre outils de releve.
 */

vi.mock("../../lib/auth", () => ({ useAuth: () => ({ user: { id: "u", role: "ADMIN", modulesAutorises: [] } }) }));

import { Sidebar } from "./Sidebar";

function rendreA(chemin: string) {
  return render(<MemoryRouter initialEntries={[chemin]}><Sidebar open /></MemoryRouter>);
}
const actifs = () => screen.getAllByRole("link").filter((l) => l.getAttribute("aria-current") === "page").map((l) => l.textContent);

describe("Sidebar : entree active", () => {
  it("sur /veille/configuration, seule « Configuration de la veille » est active", () => {
    rendreA("/veille/configuration");
    expect(actifs()).toEqual(["Configuration de la veille"]);
  });
  it("sur /veille, seule « Cellule de veille » est active", () => {
    rendreA("/veille");
    expect(actifs()).toEqual(["Cellule de veille"]);
  });
  it("sur /inspections/terrain/defauts, seule « Défauts terrain » est active", () => {
    rendreA("/inspections/terrain/defauts");
    expect(actifs()).toEqual(["Défauts terrain"]);
  });
  it("sur /inspections/releve, seule « Relevé en véhicule » est active", () => {
    rendreA("/inspections/releve");
    expect(actifs()).toEqual(["Relevé en véhicule"]);
  });
});

describe("Sidebar : groupe Releve terrain", () => {
  it("regroupe le releve en vehicule et les trois ecrans de saisie terrain, avec leurs adresses", () => {
    rendreA("/");
    expect(screen.getByText("RELEVÉ TERRAIN")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Relevé en véhicule" })).toHaveAttribute("href", "/inspections/releve");
    expect(screen.getByRole("link", { name: "Inspection terrain" })).toHaveAttribute("href", "/inspections/terrain");
    expect(screen.getByRole("link", { name: "Défauts terrain" })).toHaveAttribute("href", "/inspections/terrain/defauts");
    expect(screen.getByRole("link", { name: "Portions terrain" })).toHaveAttribute("href", "/inspections/terrain/portions");
  });
  it("« Défauts terrain » n'apparait plus en double dans le groupe Travaux", () => {
    rendreA("/");
    expect(screen.getAllByRole("link", { name: "Défauts terrain" })).toHaveLength(1);
  });
});

describe("Sidebar : Control Tower", () => {
  it("figure dans le groupe Pilotage et s'active sur /control-tower", () => {
    rendreA("/control-tower");
    expect(screen.getByRole("link", { name: "Control Tower" })).toHaveAttribute("href", "/control-tower");
    expect(actifs()).toEqual(["Control Tower"]);
  });
});

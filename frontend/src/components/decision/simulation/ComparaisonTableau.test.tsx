import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { violationsAccessibilite } from "../../../test/accessibilite";
import { ComparaisonTableau } from "./ComparaisonTableau";
import { comparaisonSim } from "./simulation.fixtures";

/**
 * Comparaison cote a cote : tableau accessible (en-tetes de colonne et de ligne, legende) + barres de renfort ; le deficit garde son
 * signe et sa mention « minimum » ; la longueur metier absente se dit ; les hypotheses qui different sont reperees par le texte.
 */
afterEach(() => cleanup());
const sp = (s: string | null) => (s ?? "").replace(/[\s\u202f\u00a0]/g, " ");
const regions = [{ id: 1, nom: "Basse-Guinée" }, { id: 2, nom: "Moyenne-Guinée" }];

describe("ComparaisonTableau", () => {
  it("un tableau avec legende, un en-tete de colonne par scenario et un en-tete de ligne par indicateur", () => {
    render(<ComparaisonTableau comparaison={comparaisonSim()} regions={regions} />);
    const t = screen.getByRole("table", { name: /Comparaison côte à côte de 2 scénarios/ });
    expect(within(t).getByRole("columnheader", { name: /Scénario s-a/ })).toBeInTheDocument();
    expect(within(t).getByRole("columnheader", { name: /Scénario s-b/ })).toBeInTheDocument();
    for (const ligne of ["Enveloppe", "Consommé", "Reste", "Déficit", "Interventions retenues", "Kilomètres (longueur métier)", "Risque couvert", "Version des paramètres", "Version des barèmes"]) {
      expect(within(t).getByRole("rowheader", { name: ligne })).toBeInTheDocument();
    }
  });

  it("enveloppe, consomme, reste, deficit : valeurs de chaque scenario, en francs groupes", () => {
    render(<ComparaisonTableau comparaison={comparaisonSim()} regions={regions} />);
    const val = (id: string) => sp(screen.getByTestId(id).textContent);
    expect(val("ligne-enveloppe")).toContain("5 000 000 000 GNF");
    expect(val("ligne-enveloppe")).toContain("8 000 000 000 GNF");
    expect(val("ligne-consomme")).toContain("4 300 000 000 GNF");
    expect(val("ligne-consomme")).toContain("7 900 000 000 GNF");
    expect(val("ligne-reste")).toContain("700 000 000 GNF");
    expect(val("ligne-interventions")).toContain("2 sur 3");
  });

  it("le deficit n'est pas masque : montant, solde signe, et « minimum » quand des couts manquent", () => {
    render(<ComparaisonTableau comparaison={comparaisonSim()} regions={regions} />);
    const l = sp(screen.getByTestId("ligne-deficit").textContent);
    expect(l).toContain("3 700 000 000 GNF");
    expect(l).toContain("solde - 3 700 000 000 GNF");
    expect(l).toContain("700 000 000 GNF");
    expect(l).toContain("minimum : 1 coût(s) non fiable(s)");
    const barres = sp(screen.getByTestId("barres-comparaison").textContent);
    expect(barres).toContain("Déficit de 3 700 000 000 GNF");
    expect(barres).toContain("Déficit de 700 000 000 GNF (minimum)");
  });

  it("un scenario sans deficit dit « Aucun déficit » (pas un 0 nu)", () => {
    const c = comparaisonSim();
    c.scenarios[0] = { ...c.scenarios[0], deficitGnf: "0", soldeGnf: "1300000000" };
    render(<ComparaisonTableau comparaison={c} regions={regions} />);
    expect(screen.getByTestId("barres-comparaison")).toHaveTextContent("Aucun déficit");
    expect(sp(screen.getByTestId("ligne-deficit").textContent)).toContain("aucun");
  });

  it("un deficit nul avec des couts non fiables n'est PAS dit « Aucun déficit » tout court (minorant)", () => {
    const c = comparaisonSim();
    c.scenarios[1] = { ...c.scenarios[1], deficitGnf: "0", soldeGnf: "3700000000", deficitMinorant: true, nbCoutsNonFiables: 2 };
    render(<ComparaisonTableau comparaison={c} regions={regions} />);
    expect(screen.getByTestId("barres-comparaison")).toHaveTextContent("Aucun déficit chiffré : 2 coût(s) non fiable(s) ne sont pas comptés");
  });

  it("kilometres : la longueur metier absente est dite, la geometrique est a part et jamais substituee", () => {
    render(<ComparaisonTableau comparaison={comparaisonSim()} regions={regions} />);
    const km = sp(screen.getByTestId("ligne-km").textContent);
    expect(km).toContain("11,000 km");
    expect(km).toContain("longueur métier absente");
    expect(km).toContain("géométrique à part : 5,000 km");
  });

  it("les hypotheses qui different sont reperees (texte « diffère » pour les lecteurs d'ecran, ligne marquee)", () => {
    render(<ComparaisonTableau comparaison={comparaisonSim()} regions={regions} />);
    const t = screen.getByTestId("hypotheses");
    const lignes = within(t).getAllByRole("row").slice(1);
    expect(lignes.map((r) => r.getAttribute("data-differe"))).toEqual(["true", "true", "false"]);
    expect(within(t).getByRole("rowheader", { name: /Logique de priorité \(diffère\)/ })).toBeInTheDocument();
    expect(within(t).getByRole("rowheader", { name: "Version des paramètres" })).toBeInTheDocument();
  });

  it("mention non engageante, periode commune, interventions communes", () => {
    render(<ComparaisonTableau comparaison={comparaisonSim()} regions={regions} />);
    expect(screen.getByTestId("mention-simulation")).toHaveTextContent("SIMULATION NON ENGAGEANTE");
    expect(screen.getByText(/Période commune : 01\/01\/2027 au 31\/12\/2027 · devise GNF/)).toBeInTheDocument();
    expect(screen.getByTestId("interventions-communes")).toHaveTextContent(/dans tous les scénarios : 1.*Scénario s-a 1 ; Scénario s-b 1/);
  });

  it("les barres sont masquees aux lecteurs d'ecran : la valeur est ecrite a cote", () => {
    render(<ComparaisonTableau comparaison={comparaisonSim()} regions={regions} />);
    const barres = screen.getByTestId("barres-comparaison");
    expect(barres.querySelectorAll("[aria-hidden=true]").length).toBe(2);
    expect(sp(barres.textContent)).toContain("86 % de l'enveloppe consommée");
  });

  it("0 violation d'accessibilite (axe-core, WCAG 2.1 A et AA, contraste exclu)", async () => {
    const { container } = render(<ComparaisonTableau comparaison={comparaisonSim()} regions={regions} />);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

describe("ComparaisonTableau : enveloppe nulle", () => {
  it("la part de l'enveloppe consommee est non calculable, pas « 0 % »", () => {
    const c = comparaisonSim();
    c.scenarios[0] = { ...c.scenarios[0], enveloppeGnf: "0", consommeGnf: "0", resteGnf: "0", deficitGnf: "8700000000", soldeGnf: "-8700000000" };
    render(<ComparaisonTableau comparaison={c} regions={regions} />);
    const barres = sp(screen.getByTestId("barres-comparaison").textContent);
    expect(barres).toContain("non calculable (enveloppe nulle)");
    expect(barres).not.toMatch(/^0 %|[^0-9]0 % de l'enveloppe/);
    expect(barres).toContain("98,7 % de l'enveloppe consommée");
  });
});

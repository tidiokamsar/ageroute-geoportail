import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BarreOnglets } from "./BarreOnglets";
import type { IdOnglet } from "./types";
import { violationsAccessibilite } from "../../test/accessibilite";

function Banc({ initial = "carte", onChoisir }: { initial?: IdOnglet; onChoisir?: (id: IdOnglet) => void }) {
  const [actif, setActif] = useState<IdOnglet>(initial);
  return (
    <>
      <BarreOnglets actif={actif} onChoisir={(id) => { onChoisir?.(id); setActif(id); }} prefixe="t" />
      <div role="tabpanel" id="t-panneau" aria-labelledby={`t-onglet-${actif}`} tabIndex={0}>contenu</div>
    </>
  );
}

describe("BarreOnglets : tablist accessible", () => {
  it("expose role tablist, six tabs aux libelles de la maquette, un seul selectionne", () => {
    render(<Banc />);
    expect(screen.getByRole("tablist", { name: /aide à la décision/i })).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Carte et priorisation", "Liste des interventions", "Simulation budgétaire", "Suivi contractuel", "Scénarios", "Rapports"]);
    expect(tabs.filter((t) => t.getAttribute("aria-selected") === "true")).toHaveLength(1);
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Carte et priorisation");
    for (const t of tabs) expect(t).toHaveAttribute("aria-controls", "t-panneau");
  });

  it("n'a qu'un onglet dans l'ordre de tabulation (tabindex roulant)", () => {
    render(<Banc initial="scenarios" />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.filter((t) => t.tabIndex === 0)).toEqual([screen.getByRole("tab", { name: "Scénarios" })]);
    expect(tabs.filter((t) => t.tabIndex === -1)).toHaveLength(5);
  });

  it("les fleches, Debut et Fin deplacent le focus (avec boucle) sans activer", async () => {
    const onChoisir = vi.fn();
    render(<Banc onChoisir={onChoisir} />);
    await userEvent.tab();
    expect(screen.getByRole("tab", { name: "Carte et priorisation" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Liste des interventions" })).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Rapports" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Carte et priorisation" })).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Rapports" })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "Carte et priorisation" })).toHaveFocus();
    expect(onChoisir).not.toHaveBeenCalled();
  });

  it("Entree et Espace activent l'onglet qui a le focus ; le panneau suit", async () => {
    const onChoisir = vi.fn();
    render(<Banc onChoisir={onChoisir} />);
    await userEvent.tab();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}{Enter}");
    expect(onChoisir).toHaveBeenLastCalledWith("simulation");
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Simulation budgétaire");
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Simulation budgétaire");
    await userEvent.keyboard("{ArrowRight}{ }");
    expect(onChoisir).toHaveBeenLastCalledWith("contractuel");
  });

  it("le clic active, et la cible fait au moins 44 px (classe min-h-[44px])", async () => {
    const onChoisir = vi.fn();
    render(<Banc onChoisir={onChoisir} />);
    await userEvent.click(screen.getByRole("tab", { name: "Rapports" }));
    expect(onChoisir).toHaveBeenCalledWith("rapports");
    for (const t of screen.getAllByRole("tab")) expect(t.className).toContain("min-h-[44px]");
  });

  it("passe axe", async () => {
    const { container } = render(<Banc />);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

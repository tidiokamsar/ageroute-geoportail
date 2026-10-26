import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FILTRES_LOTS_VIDES, FiltresLots, filtresActifs } from "./FiltresLots";
import { violationsAccessibilite } from "../../test/accessibilite";
import type { FiltresLots as ValeursFiltres, SourceConnue } from "./types";

/**
 * Les filtres sont CONTRÔLÉS : ils ne touchent ni à l'URL ni au réseau. Le nombre de résultats est annoncé
 * en aria-live, et « Effacer les filtres » remet tout à vide sans perdre le focus.
 */

const SOURCES: SourceConnue[] = [{ valeur: "ONR_BDR", nombreLots: 12 }, { valeur: "L2R", nombreLots: 3 }];

function Hote({ initial = FILTRES_LOTS_VIDES, total = 12, onChange = vi.fn() }: { initial?: ValeursFiltres; total?: number; onChange?: (f: ValeursFiltres) => void }) {
  const [filtres, setFiltres] = useState(initial);
  return <FiltresLots filtres={filtres} sources={SOURCES} total={total} onChange={(f) => { onChange(f); setFiltres(f); }} />;
}

describe("Champs des filtres", () => {
  it("expose trois champs libellés : statut, source, recherche", () => {
    render(<Hote />);
    expect(screen.getByRole("search", { name: /Filtrer les lots/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Statut")).toBeInstanceOf(HTMLSelectElement);
    expect(screen.getByLabelText("Source")).toBeInstanceOf(HTMLSelectElement);
    expect(screen.getByLabelText("Rechercher")).toHaveAttribute("type", "search");
  });

  it("le statut propose les libellés, dont « non appliqué », jamais un mot de réussite", () => {
    render(<Hote />);
    const options = within(screen.getByLabelText("Statut")).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Tous les statuts", "Reçu", "Schéma validé : non appliqué", "Rejeté", "Importé en test", "Importé"]);
  });

  it("la source propose « Toutes les sources » puis les sources connues avec leur nombre de lots", () => {
    render(<Hote />);
    const options = within(screen.getByLabelText("Source")).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Toutes les sources", "ONR_BDR (12)", "L2R (3)"]);
  });

  it("une source portée par l'URL mais absente de la liste reste visible et choisie", () => {
    render(<Hote initial={{ statut: "", source: "ANCIENNE_SOURCE", q: "" }} />);
    const select = screen.getByLabelText("Source") as HTMLSelectElement;
    expect(select.value).toBe("ANCIENNE_SOURCE");
    expect(within(select).getByRole("option", { name: "ANCIENNE_SOURCE" })).toBeInTheDocument();
  });

  it("une source au nom hostile est du texte", () => {
    const { container } = render(
      <FiltresLots filtres={FILTRES_LOTS_VIDES} sources={[{ valeur: "<img src=x onerror=alert(1)>", nombreLots: 1 }]} onChange={vi.fn()} total={1} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("option", { name: /<img src=x onerror=alert\(1\)> \(1\)/ })).toBeInTheDocument();
  });
});

describe("Les changements remontent sans toucher à l'URL", () => {
  it("choisir un statut appelle onChange avec les autres filtres conservés", async () => {
    const onChange = vi.fn();
    render(<Hote initial={{ statut: "", source: "L2R", q: "rn1" }} onChange={onChange} />);
    await userEvent.selectOptions(screen.getByLabelText("Statut"), "REJETE");
    expect(onChange).toHaveBeenLastCalledWith({ statut: "REJETE", source: "L2R", q: "rn1" });
  });

  it("choisir une source, puis taper une recherche", async () => {
    const onChange = vi.fn();
    render(<Hote onChange={onChange} />);
    await userEvent.selectOptions(screen.getByLabelText("Source"), "ONR_BDR");
    expect(onChange).toHaveBeenLastCalledWith({ statut: "", source: "ONR_BDR", q: "" });
    await userEvent.type(screen.getByLabelText("Rechercher"), "rn1");
    expect(onChange).toHaveBeenLastCalledWith({ statut: "", source: "ONR_BDR", q: "rn1" });
  });
});

describe("Effacer les filtres", () => {
  it("est inactif sans filtre, actif avec, et remet tout à vide en rendant le focus à la recherche", async () => {
    const onChange = vi.fn();
    render(<Hote onChange={onChange} />);
    const bouton = screen.getByRole("button", { name: "Effacer les filtres" });
    expect(bouton).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Rechercher"), "x");
    expect(bouton).toBeEnabled();
    await userEvent.click(bouton);
    expect(onChange).toHaveBeenLastCalledWith({ statut: "", source: "", q: "" });
    expect(screen.getByLabelText("Rechercher")).toHaveValue("");
    expect(screen.getByLabelText("Rechercher")).toHaveFocus();
    expect(bouton).toBeDisabled();
  });

  it("filtresActifs : un q fait seulement d'espaces n'est pas un filtre", () => {
    expect(filtresActifs({ statut: "", source: "", q: "   " })).toBe(false);
    expect(filtresActifs({ statut: "REJETE", source: "", q: "" })).toBe(true);
  });
});

describe("Annonce du nombre de résultats (aria-live)", () => {
  it("dit combien de lots, avec ou sans filtre, et au singulier", () => {
    const { rerender } = render(<FiltresLots filtres={FILTRES_LOTS_VIDES} sources={SOURCES} total={12} onChange={vi.fn()} />);
    const zone = screen.getByRole("status");
    expect(zone).toHaveAttribute("aria-live", "polite");
    expect(zone).toHaveTextContent("12 lots reçus.");
    rerender(<FiltresLots filtres={{ ...FILTRES_LOTS_VIDES, statut: "REJETE" }} sources={SOURCES} total={1} onChange={vi.fn()} />);
    expect(zone).toHaveTextContent("1 lot correspondant aux filtres.");
    rerender(<FiltresLots filtres={{ ...FILTRES_LOTS_VIDES, q: "zzz" }} sources={SOURCES} total={0} onChange={vi.fn()} />);
    expect(zone).toHaveTextContent("Aucun lot ne correspond aux filtres.");
    rerender(<FiltresLots filtres={FILTRES_LOTS_VIDES} sources={SOURCES} total={0} onChange={vi.fn()} />);
    expect(zone).toHaveTextContent("Aucun lot reçu.");
  });

  it("tant que le total n'est pas connu, la zone reste montée mais vide (pas de 0 inventé)", () => {
    render(<FiltresLots filtres={FILTRES_LOTS_VIDES} sources={[]} onChange={vi.fn()} />);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });
});

describe("Cibles tactiles et accessibilité", () => {
  it("chaque champ et chaque bouton a une hauteur minimale de 44 px", () => {
    render(<Hote />);
    for (const el of [screen.getByLabelText("Statut"), screen.getByLabelText("Source"), screen.getByLabelText("Rechercher"), screen.getByRole("button")]) {
      expect(el.className).toMatch(/min-h-\[44px\]/);
    }
  });

  it("axe : filtres vides, actifs, et avec une source hors liste", async () => {
    const { container, rerender } = render(<FiltresLots filtres={FILTRES_LOTS_VIDES} sources={SOURCES} total={12} onChange={vi.fn()} />);
    expect(await violationsAccessibilite(container)).toEqual([]);
    rerender(<FiltresLots filtres={{ statut: "REJETE", source: "INCONNUE", q: "rn1" }} sources={SOURCES} total={2} onChange={vi.fn()} />);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

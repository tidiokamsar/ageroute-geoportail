import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { PanneauFiltres, type RegionsLues } from "./PanneauFiltres";
import type { FiltresDecision } from "./types";
import { REGIONS_SYNTHETIQUES } from "./synthetique.testutil";
import { FILTRES_INDISPONIBLES } from "../../lib/decision";
import { violationsAccessibilite } from "../../test/accessibilite";

function Banc({ initial = {}, regions = { etat: "ok", regions: REGIONS_SYNTHETIQUES } as RegionsLues, espion }: { initial?: FiltresDecision; regions?: RegionsLues; espion?: (f: FiltresDecision) => void }) {
  const [f, setF] = useState<FiltresDecision>(initial);
  return <PanneauFiltres filtres={f} onFiltres={(n) => { espion?.(n); setF(n); }} regions={regions} />;
}

describe("PanneauFiltres : filtres globaux (region, classe, etat, periode)", () => {
  it("change la region, la classe, l'etat et la periode", async () => {
    const espion = vi.fn();
    render(<Banc espion={espion} />);
    await userEvent.selectOptions(screen.getByLabelText("Région"), "2");
    expect(espion).toHaveBeenLastCalledWith({ regionId: 2 });
    await userEvent.click(screen.getByLabelText("RN"));
    await userEvent.click(screen.getByLabelText("Critique"));
    await userEvent.type(screen.getByLabelText("Du"), "2026-01-01");
    expect(espion).toHaveBeenLastCalledWith({ regionId: 2, classe: ["RN"], etat: ["CRITIQUE"], depuis: "2026-01-01" });
    expect(screen.getByTestId("nb-filtres")).toHaveTextContent("4 filtres actifs");
  });

  it("decocher le dernier element retire la cle (pas de liste vide)", async () => {
    const espion = vi.fn();
    render(<Banc initial={{ etat: ["BON"] }} espion={espion} />);
    await userEvent.click(screen.getByLabelText("Bon"));
    expect(espion).toHaveBeenLastCalledWith({});
    expect(Object.keys(espion.mock.calls.at(-1)?.[0] ?? {})).toEqual([]);
  });

  it("Reinitialiser vide les filtres ; desactive quand il n'y en a aucun", async () => {
    render(<Banc initial={{ regionId: 1, etat: ["BON"] }} />);
    const b = screen.getByRole("button", { name: "Réinitialiser" });
    expect(b).toBeEnabled();
    await userEvent.click(b);
    expect(screen.getByTestId("nb-filtres")).toHaveTextContent("aucun filtre actif");
    expect(screen.getByRole("button", { name: "Réinitialiser" })).toBeDisabled();
  });

  it("une periode incoherente est signalee par une alerte et marquee invalide", async () => {
    render(<Banc initial={{ depuis: "2026-05-01", jusqua: "2026-04-01" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/postérieure/);
    expect(screen.getByLabelText("Du")).toHaveAttribute("aria-invalid", "true");
  });
});

describe("PanneauFiltres : filtres indisponibles, affiches DESACTIVES avec leur raison", () => {
  it("expose prefecture, axe, bailleur, gravite et type d'intervention, tous desactives, chacun decrit par sa raison", () => {
    render(<Banc />);
    expect(FILTRES_INDISPONIBLES.map((f) => f.libelle)).toEqual(["Préfecture", "Axe", "Bailleur / financement", "Gravité", "Type d'intervention"]);
    for (const f of FILTRES_INDISPONIBLES) {
      const champ = screen.getByLabelText(f.libelle);
      expect(champ).toBeDisabled();
      expect(champ).toHaveAccessibleDescription(`Indisponible : ${f.raison}.`);
    }
  });

  it("un filtre indisponible ne change jamais les filtres actifs", async () => {
    const espion = vi.fn();
    render(<Banc espion={espion} />);
    await userEvent.click(screen.getByLabelText("Préfecture"));
    expect(espion).not.toHaveBeenCalled();
  });
});

describe("PanneauFiltres : liste des regions", () => {
  it("chargement : le filtre est desactive et le dit", () => {
    render(<Banc regions={{ etat: "chargement" }} />);
    expect(screen.getByLabelText("Région")).toBeDisabled();
    expect(within(screen.getByLabelText("Région")).getByText("Chargement des régions…")).toBeInTheDocument();
  });

  it("erreur : filtre desactive avec une note, et une region deja choisie par l'URL reste lisible", () => {
    render(<Banc regions={{ etat: "erreur" }} initial={{ regionId: 12 }} />);
    expect(screen.getByLabelText("Région")).toBeDisabled();
    expect(screen.getByLabelText("Région")).toHaveAccessibleDescription(/indisponible/);
    expect(screen.getByRole("option", { name: "Région n° 12" })).toBeInTheDocument();
  });

  it("le panneau peut se replier, et le bouton dit son etat", async () => {
    render(<Banc />);
    const b = screen.getByRole("button", { name: "Masquer les filtres" });
    expect(b).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(b);
    expect(screen.getByRole("button", { name: "Afficher les filtres" })).toHaveAttribute("aria-expanded", "false");
  });

  it("passe axe", async () => {
    const { container } = render(<Banc initial={{ regionId: 1, etat: ["BON"] }} />);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

describe("PanneauFiltres : saisie de date (pas de requete tant que la date est incomplete ou hors 2000-2100)", () => {
  it("une annee EN COURS de frappe (0002, 0020, 0202) ne remonte jamais aux filtres : le serveur la refuserait (400)", () => {
    const espion = vi.fn();
    render(<Banc espion={espion} />);
    const du = screen.getByLabelText("Du");
    for (const v of ["0002-05-01", "0020-05-01", "0202-05-01", "1999-12-31", "2101-01-01"]) fireEvent.change(du, { target: { value: v } });
    expect(espion).not.toHaveBeenCalled();
    // la saisie reste visible pendant la frappe
    expect(du).toHaveValue("2101-01-01");
    fireEvent.change(du, { target: { value: "2026-05-01" } });
    expect(espion).toHaveBeenCalledTimes(1);
    expect(espion).toHaveBeenLastCalledWith({ depuis: "2026-05-01" });
  });

  it("une date impossible (31 fevrier) ne remonte pas", () => {
    const espion = vi.fn();
    render(<Banc espion={espion} />);
    fireEvent.change(screen.getByLabelText("Au"), { target: { value: "2026-02-31" } });
    expect(espion).not.toHaveBeenCalled();
  });

  it("vider le champ retire explicitement le filtre", () => {
    const espion = vi.fn();
    render(<Banc initial={{ depuis: "2026-05-01" }} espion={espion} />);
    fireEvent.change(screen.getByLabelText("Du"), { target: { value: "" } });
    expect(espion).toHaveBeenLastCalledWith({});
  });

  it("un changement venu d'ailleurs (Reinitialiser) remplace le brouillon", async () => {
    render(<Banc initial={{ depuis: "2026-05-01" }} />);
    expect(screen.getByLabelText("Du")).toHaveValue("2026-05-01");
    await userEvent.click(screen.getByRole("button", { name: "Réinitialiser" }));
    expect(screen.getByLabelText("Du")).toHaveValue("");
  });

  it("les champs bornent la saisie a 2000-2100", () => {
    render(<Banc />);
    expect(screen.getByLabelText("Du")).toHaveAttribute("min", "2000-01-01");
    expect(screen.getByLabelText("Au")).toHaveAttribute("max", "2100-12-31");
  });
});

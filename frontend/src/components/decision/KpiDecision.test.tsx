import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KpiDecision } from "./KpiDecision";
import { kpiReel } from "./synthetique.testutil";
import { violationsAccessibilite } from "../../test/accessibilite";
import type { KpiLu } from "../../lib/aideDecisionApi";

const degrade = kpiReel("reseau_degrade_pct");
const budgetEngage = kpiReel("budget_engage_gnf");
const nette = (s: string | null) => (s ?? "").replace(/[\u00a0\u202f]/g, " ");

function rendre(k: KpiLu, props: Partial<Parameters<typeof KpiDecision>[0]> = {}) {
  const onOuvrir = vi.fn();
  const onDefinition = vi.fn();
  const r = render(<KpiDecision kpi={k} onOuvrir={onOuvrir} onDefinition={onDefinition} {...props} />);
  return { onOuvrir, onDefinition, ...r };
}

const valeurDe = () => nette(screen.getByRole("article").querySelector("[id$='-valeur']")?.textContent ?? "");

describe("KpiDecision sur un indicateur REEL : valeur, unite, periode, perimetre, source, date, definition", () => {
  it("montre valeur et unite, avec les metadonnees exigees par le contrat", () => {
    rendre(degrade);
    const carte = screen.getByRole("article");
    expect(valeurDe()).toBe("25 %");
    expect(within(carte).getByText("Période :").nextSibling).toHaveTextContent("Instantané du 26/10/2026");
    expect(within(carte).getByText("Périmètre :").nextSibling).toHaveTextContent("Ensemble du pays : réseau classé saisi");
    expect(within(carte).getByText("Source :").nextSibling).toHaveTextContent(degrade.source);
    expect(within(carte).getByText("Calculé le :").nextSibling).toHaveTextContent("26/10/2026");
  });

  it("la couverture est une phrase COHERENTE : etat valide, non valide, non evalue, sur la longueur connue", () => {
    rendre(degrade);
    const t = nette(within(screen.getByRole("article")).getByText("Couverture :").nextSibling?.textContent ?? "");
    expect(t).toBe("200 km à état valide, 500 km à état non valide, 100 km non évalués, sur 800 km de longueur connue");
    expect(t).not.toMatch(/700 km évalués sur 200 km/);
  });

  it("porte le badge « Définition provisoire » (et « validée » quand elle l'est)", () => {
    const { rerender } = rendre(degrade);
    expect(screen.getByText("Définition provisoire")).toBeInTheDocument();
    rerender(<KpiDecision kpi={{ ...degrade, statutDefinition: "VALIDEE" }} onOuvrir={() => {}} onDefinition={() => {}} />);
    expect(screen.queryByText("Définition provisoire")).not.toBeInTheDocument();
    expect(screen.getByText("Définition validée")).toBeInTheDocument();
  });

  it("dit « source non précisée » et « période non précisée » au lieu d'inventer", () => {
    rendre({ ...degrade, source: "", periode: null, perimetre: { libelle: "", regionId: null }, calculeLe: "" });
    expect(screen.getByText("Source :").nextSibling).toHaveTextContent("non précisée");
    expect(screen.getByText("Période :").nextSibling).toHaveTextContent("Période non précisée");
    expect(screen.getByText("Périmètre :").nextSibling).toHaveTextContent("non précisé");
    expect(screen.getByText("Calculé le :").nextSibling).toHaveTextContent("date inconnue");
  });
});

describe("unites : jamais « 0 part » ni « 5 nombre »", () => {
  it("une fraction « part » s'affiche en pourcentage", () => {
    rendre(kpiReel("couverture_etat_part"));
    expect(valeurDe()).toBe("25 %");
    rendre({ ...kpiReel("couverture_etat_part"), valeur: 0.5455 });
    expect(screen.getAllByRole("article")[1].querySelector("[id$='-valeur']")?.textContent?.replace(/[\u00a0\u202f]/g, " ")).toBe("54,55 %");
  });

  it("un nombre sans unite n'imprime pas « nombre »", () => {
    rendre(kpiReel("chantiers_en_cours"));
    expect(valeurDe()).toBe("5");
    expect(screen.getByRole("article").textContent).not.toMatch(/nombre/);
  });

  it("« éléments » reste lisible", () => {
    rendre(kpiReel("donnees_a_confirmer"));
    expect(valeurDe()).toBe("13 éléments");
  });
});

describe("montant GNF non representable : la valeur exacte du texte", () => {
  it("montre 9 007 199 254 740 993 GNF (valeur null, valeurTexte exacte), pas « Valeur indisponible »", () => {
    const k = kpiReel("budget_contractuel_gnf");
    expect(k.valeur).toBeNull();
    rendre(k);
    expect(valeurDe()).toBe("9 007 199 254 740 993 GNF");
    expect(screen.getByRole("article").textContent).not.toMatch(/indisponible/i);
    expect(screen.getByText("Partiel")).toBeInTheDocument();
  });
});

describe("KpiDecision : un indicateur NON_DISPONIBLE ne montre jamais zero", () => {
  it("affiche « Non disponible » avec la raison du serveur", () => {
    rendre(budgetEngage);
    const carte = screen.getByRole("article");
    expect(within(carte).getAllByText("Non disponible").length).toBeGreaterThan(0);
    expect(screen.getByTestId("raison-kpi")).toHaveTextContent(/Budget engagé : source financière de référence non validée \(B-08, ADR-003\)/);
    expect(carte.textContent).not.toMatch(/(^|\D)0(\D|$)/);
    expect(valeurDe()).toBe("Non disponible");
  });

  it("n'affiche pas 0 meme si le serveur envoie valeur 0 sur un indicateur NON_DISPONIBLE", () => {
    rendre({ ...budgetEngage, valeur: 0 });
    expect(valeurDe()).toBe("Non disponible");
  });

  it("une valeur null sur un indicateur DISPONIBLE est dite indisponible, pas 0", () => {
    rendre({ ...kpiReel("chantiers_en_cours"), valeur: null });
    expect(valeurDe()).toBe("Valeur indisponible");
  });

  it("un zero REEL envoye par le serveur reste un zero", () => {
    rendre({ ...degrade, valeur: 0 });
    expect(valeurDe()).toMatch(/^0 %$/);
  });

  it("signale un etat PARTIEL et affiche les avertissements du serveur", () => {
    rendre(degrade);
    expect(screen.getByText("Partiel")).toBeInTheDocument();
    expect(screen.getByText(/tronçons? non évalués?/)).toBeInTheDocument();
  });
});

describe("KpiDecision : cliquable, definition accessible", () => {
  it("est un BOUTON dont le nom commence par le libelle visible, qui appelle onOuvrir", async () => {
    const { onOuvrir } = rendre(degrade);
    const b = screen.getByRole("button", { name: /^Réseau dégradé/ });
    // Le nom contient tout le texte visible du bouton (WCAG 2.5.3) : libelle, valeur, destination.
    expect(b).toHaveAccessibleName(/Réseau dégradé.*25.*%.*Voir : Carte et priorisation/);
    await userEvent.click(b);
    expect(onOuvrir).toHaveBeenCalledWith(degrade);
  });

  it("s'active au clavier (Entree et Espace)", async () => {
    const { onOuvrir } = rendre(degrade);
    await userEvent.tab();
    expect(screen.getByRole("button", { name: /^Réseau dégradé/ })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(onOuvrir).toHaveBeenCalledTimes(2);
  });

  it("un indicateur NON_DISPONIBLE est lui aussi cliquable (il ouvre ce qui explique l'absence)", async () => {
    const { onOuvrir } = rendre(budgetEngage);
    await userEvent.click(screen.getByRole("button", { name: /^Budget engagé/ }));
    expect(onOuvrir).toHaveBeenCalledWith(budgetEngage);
  });

  it("l'info-bulle de definition s'ouvre au clavier, se lit sans souris et se ferme par Echap", async () => {
    rendre(degrade);
    const bulle = screen.getByRole("button", { name: "Définition : Réseau dégradé" });
    expect(bulle).toHaveAttribute("aria-expanded", "false");
    expect(bulle).toHaveAccessibleDescription(/Part de la longueur métier du réseau classé saisi/);
    bulle.focus();
    await userEvent.keyboard("{Enter}");
    expect(bulle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("note")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(bulle).toHaveAttribute("aria-expanded", "false");
  });

  it("« Voir la définition » appelle onDefinition avec le code", async () => {
    const { onDefinition } = rendre(degrade);
    await userEvent.click(screen.getByRole("button", { name: "Voir la définition : Réseau dégradé" }));
    expect(onDefinition).toHaveBeenCalledWith("reseau_degrade_pct");
  });

  it("n'imbrique aucun controle dans le bouton principal et passe axe", async () => {
    const { container } = rendre(budgetEngage);
    const principal = screen.getByRole("button", { name: /^Budget engagé/ });
    expect(principal.querySelector("button, a, input, select")).toBeNull();
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

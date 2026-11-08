import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TableauMarches } from "./TableauMarches";
import { ID, ENGAGE_NON_DISPONIBLE, marcheVue, montant, reponse } from "./synthetique.testutil";
import { violationsAccessibilite } from "../../../test/accessibilite";
import { formaterGnf } from "../../../lib/aideDecisionContractuel";

/** jest-dom normalise les espaces du DOM (insecables compris) mais pas la valeur attendue : on normalise celle-ci. */
const gnf = (v: string) => formaterGnf(v).replace(/[\u202f\u00a0]/g, " ");

/**
 * Tableau des marches : les separations du cahier se LISENT dans le DOM. Les « mutations de controle » ci-dessous echouent si
 * quelqu'un fait afficher l'engage comme le contractuel, copie le declare dans le constate, ou ecrit « actifs » pour « recenses ».
 */

const marches = reponse().marches;
const rendre = (m = marches, props: Partial<Parameters<typeof TableauMarches>[0]> = {}) =>
  render(<TableauMarches marches={m} total={m.length} idSelectionne={null} onOuvrir={() => undefined} {...props} />);

const ligneDe = (intitule: string) => screen.getByRole("button", { name: new RegExp(`Ouvrir la fiche du marché ${intitule.replace(/[()]/g, "\\$&")}`) }).closest("tr")!;
const colonne = (nom: string) => screen.getAllByRole("columnheader").findIndex((h) => h.textContent === nom);
const cellule = (tr: HTMLElement, nom: string) => within(tr).getAllByRole("cell")[colonne(nom) - 1]; // la 1re colonne est l'en-tete de ligne

describe("structure et accessibilite", () => {
  it("légende, en-têtes de colonne, en-tête de ligne, un nom unique par bouton, région de défilement focalisable", async () => {
    const { container } = rendre();
    expect(screen.getByRole("table")).toHaveAccessibleName(/Marchés recensés dans la copie gelée : 3 affiché\(s\) sur 3/);
    const colonnes = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(colonnes).toEqual(["Marché et référence", "Bailleur", "Entreprise (chantiers liés)", "Statut saisi", "Dates contractuelles", "Contractuel", "Engagé", "Décaissé", "Prévisionnel", "Avancement", "Retard", "Liens chantier et tronçon", "Anomalies"]);
    for (const h of screen.getAllByRole("columnheader")) expect(h).toHaveAttribute("scope", "col");
    expect(screen.getAllByRole("rowheader")).toHaveLength(3);
    const noms = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(new Set(noms).size).toBe(noms.length);
    expect(screen.getByRole("region", { name: /défilement horizontal/ })).toHaveAttribute("tabindex", "0");
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("deux marchés de même intitulé gardent des noms accessibles distincts", () => {
    rendre([marcheVue({ id: ID(10) }), marcheVue({ id: ID(11) })]);
    const noms = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(new Set(noms).size).toBe(2);
  });

  it("cibles tactiles de 44 px sous 1280 px (classe min-h-[44px] xl:min-h-0)", () => {
    rendre();
    for (const b of screen.getAllByRole("button")) expect(b.className).toMatch(/min-h-\[44px\]/);
  });

  it("ouvrir une fiche : onOuvrir reçoit l'identifiant, et le bouton annonce aria-expanded", async () => {
    const onOuvrir = vi.fn();
    const { rerender } = rendre(marches, { onOuvrir });
    await userEvent.click(screen.getByRole("button", { name: /Ouvrir la fiche du marché Réhabilitation RN1/ }));
    expect(onOuvrir).toHaveBeenCalledWith(ID(1));
    rerender(<TableauMarches marches={marches} total={3} idSelectionne={ID(1)} onOuvrir={onOuvrir} />);
    expect(screen.getByRole("button", { name: /Réhabilitation RN1/ })).toHaveAttribute("aria-expanded", "true");
  });
});

describe("separation des grandeurs", () => {
  it("MUTATION DE CONTROLE : l'engagé n'est PAS le contractuel : il lit « Non disponible » avec sa raison, le contractuel garde sa valeur", () => {
    rendre([marcheVue({ montants: { ...marcheVue().montants, contractuel: montant({ valeurGnf: "1250000000" }), engage: ENGAGE_NON_DISPONIBLE } })]);
    const tr = ligneDe("Réhabilitation RN1");
    expect(cellule(tr, "Contractuel")).toHaveTextContent(gnf("1250000000"));
    expect(cellule(tr, "Engagé")).toHaveTextContent("Non disponible");
    expect(cellule(tr, "Engagé")).toHaveTextContent("source financière non validée");
    expect(cellule(tr, "Engagé")).not.toHaveTextContent(/GNF|\d{3}/);
  });

  it("contractuel, décaissé et prévisionnel : chacun sa colonne et sa valeur", () => {
    rendre([marcheVue({ montants: { ...marcheVue().montants, contractuel: montant({ valeurGnf: "1000" }), decaisse: montant({ valeurGnf: "300" }), previsionnel: montant({ etat: "PARTIEL", valeurGnf: "700" }) } })]);
    const tr = ligneDe("Réhabilitation RN1");
    expect(cellule(tr, "Contractuel")).toHaveTextContent(gnf("1000"));
    expect(cellule(tr, "Décaissé")).toHaveTextContent(gnf("300"));
    expect(cellule(tr, "Prévisionnel")).toHaveTextContent(gnf("700"));
    expect(cellule(tr, "Prévisionnel")).toHaveTextContent("(partiel)");
  });

  it("un montant indisponible dit POURQUOI et n'affiche jamais 0", () => {
    rendre();
    const tr = ligneDe("Marché sans lien");
    expect(cellule(tr, "Contractuel")).toHaveTextContent("Non disponible");
    expect(cellule(tr, "Contractuel")).toHaveTextContent("aucun montant saisi");
    expect(cellule(tr, "Décaissé")).toHaveTextContent("aucun décompte saisi");
    expect(cellule(tr, "Prévisionnel")).toHaveTextContent("aucun lien établi");
    for (const c of ["Contractuel", "Engagé", "Décaissé", "Prévisionnel"]) expect(cellule(tr, c)).not.toHaveTextContent(/\b0\b/);
  });

  it("MUTATION DE CONTROLE : l'avancement constaté n'est jamais le déclaré", () => {
    rendre([marcheVue()]);
    const tr = ligneDe("Réhabilitation RN1");
    const av = cellule(tr, "Avancement");
    expect(av).toHaveTextContent(/Avancement déclaré : 55/);
    expect(av).toHaveTextContent("Avancement constaté : non disponible");
    expect(av).toHaveTextContent(/Financier déclaré : 30/);
    expect(av.textContent).not.toMatch(/constaté : 55/);
  });

  it("un avancement non saisi n'est pas 0 %", () => {
    rendre();
    const av = cellule(ligneDe("Marché sans lien"), "Avancement");
    expect(av).toHaveTextContent("Avancement déclaré : non disponible");
    expect(av).not.toHaveTextContent(/0\s*%/);
  });

  it("montant en devise étrangère : valeur d'origine, pas de GNF inventé", () => {
    rendre([marcheVue({ devise: "USD", montants: { ...marcheVue().montants, contractuel: montant({ etat: "NON_DISPONIBLE", valeurGnf: null, motif: "DEVISE_NON_GNF", valeurOrigine: { montant: "2000", devise: "USD" } }) } })]);
    const c = cellule(ligneDe("Réhabilitation RN1"), "Contractuel");
    expect(c).toHaveTextContent("USD");
    expect(c).toHaveTextContent("devise étrangère, non convertie");
    expect(c).not.toHaveTextContent("GNF");
  });

  it("MUTATION DE CONTROLE : le mot « actifs » n'apparaît dans aucun libellé du tableau", () => {
    rendre();
    expect(screen.getByRole("table").textContent).not.toMatch(/actifs?\b/i);
  });
});

describe("liens et retards", () => {
  it("qualité des liens : manquant et ambigu sont dits par le texte (pas seulement la couleur)", () => {
    rendre();
    expect(within(ligneDe("Marché sans lien")).getByText(/Chantiers \(0\) : Manquant/)).toBeInTheDocument();
    expect(within(ligneDe("Marché en retard")).getByText(/Chantiers \(1\) : Ambigu/)).toBeInTheDocument();
    expect(within(ligneDe("Réhabilitation RN1")).getByText(/Tronçons \(1\) : Par le chantier/)).toBeInTheDocument();
  });

  it("retard : libellé, jours après la fin prévue et écart physique ; non évaluable dit non évaluable", () => {
    rendre();
    const r = cellule(ligneDe("Marché en retard"), "Retard");
    expect(r).toHaveTextContent("En retard");
    expect(r).toHaveTextContent("40 jour(s) après la fin prévue");
    expect(r).toHaveTextContent("Écart physique 30 points");
    expect(cellule(ligneDe("Marché sans lien"), "Retard")).toHaveTextContent("Retard non évaluable");
  });

  it("anomalies listées par leur libellé ; sinon « Aucune détectée »", () => {
    rendre();
    expect(cellule(ligneDe("Marché sans lien"), "Anomalies")).toHaveTextContent("Marché sans chantier lié");
    expect(cellule(ligneDe("Réhabilitation RN1"), "Anomalies")).toHaveTextContent("Aucune détectée");
  });

  it("dates contractuelles et avenants : non disponibles dits en clair", () => {
    rendre([marcheVue()]);
    const d = cellule(ligneDe("Réhabilitation RN1"), "Dates contractuelles");
    expect(d).toHaveTextContent(/Début prévu : .*2026/);
    expect(d).toHaveTextContent("Avenants : non disponibles");
  });
});

import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ControlesCoherence } from "./ControlesCoherence";
import { SyntheseContractuelle } from "./SyntheseContractuelle";
import { BandeauDonneesPartielles } from "./BandeauDonneesPartielles";
import { CONTROLES, ID, montant, reponse, syntheseVue } from "./synthetique.testutil";
import { violationsAccessibilite } from "../../../test/accessibilite";

describe("controles de coherence", () => {
  const rendre = (onOuvrirMarche = vi.fn()) => ({ onOuvrirMarche, ...render(<MemoryRouter><ControlesCoherence controles={CONTROLES} onOuvrirMarche={onOuvrirMarche} /></MemoryRouter>) });

  it("chaque contrôle dit son compte ET sa population ; un zéro est affiché avec sa population", () => {
    rendre();
    const sansChantier = document.querySelector('[data-controle="MARCHE_SANS_CHANTIER"]') as HTMLElement;
    expect(sansChantier).toHaveTextContent("1 marché(s) sur 3 examiné(s)");
    expect(document.querySelector('[data-controle="CHANTIER_SANS_MARCHE"]')).toHaveTextContent("7 chantier(s) sur 40 examiné(s)");
    const zero = document.querySelector('[data-controle="DECOMPTE_SUPERIEUR_MARCHE"]') as HTMLElement;
    expect(zero).toHaveTextContent("0 marché(s) sur 3 examiné(s)");
    expect(zero).toHaveTextContent("1 non vérifiable(s) faute de donnée : ni conformes, ni en anomalie");
  });

  it("exemple de marché : bouton « Ouvrir la fiche » qui transmet l'identifiant du marché", async () => {
    const { onOuvrirMarche } = rendre();
    await userEvent.click(screen.getByRole("button", { name: /Ouvrir la fiche : Marché sans lien \(essai\)/ }));
    expect(onOuvrirMarche).toHaveBeenCalledWith(ID(2));
  });

  it("exemple de chantier sans marché : lien vers la page Chantiers (pas de fiche de marché)", () => {
    rendre();
    const lien = screen.getByRole("link", { name: /Chantier orphelin \(essai\)/ });
    expect(lien).toHaveAttribute("href", "/chantiers");
  });

  it("définition PROVISOIRE accessible, et dit qu'un contrôle ne corrige ni ne tranche", () => {
    rendre();
    expect(screen.getAllByText(/Définition \(provisoire\)/).length).toBe(3);
    expect(screen.getByText(/ne dit pas laquelle des deux copies/)).toBeInTheDocument();
  });

  it("exemples bornés : « … et N autre(s) » quand le compte dépasse les exemples", () => {
    render(<MemoryRouter><ControlesCoherence controles={[{ ...CONTROLES[0], nombre: 12, exemples: CONTROLES[0].exemples }]} onOuvrirMarche={() => undefined} /></MemoryRouter>);
    expect(screen.getByText(/… et 11 autre\(s\)/)).toBeInTheDocument();
  });

  it("aucune violation axe", async () => {
    const { container } = rendre();
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

describe("synthese", () => {
  it("MUTATION DE CONTROLE : « Marchés recensés », jamais « actifs » ; la note dit que ce n'est pas un nombre de marchés actifs", () => {
    render(<SyntheseContractuelle synthese={syntheseVue()} />);
    expect(screen.getByText("Marchés recensés", { selector: "dt" })).toBeInTheDocument();
    expect(screen.queryByText(/^Marchés actifs/i)).toBeNull();
    expect(screen.getByText(/Pas un nombre de marchés actifs/)).toBeInTheDocument();
  });

  it("quatre cartes de montants SÉPARÉES ; l'engagé est non disponible avec sa raison, il ne reprend pas le contractuel", () => {
    render(<SyntheseContractuelle synthese={syntheseVue()} />);
    const dt = (txt: RegExp) => screen.getByText(txt, { selector: "dt" }).parentElement!;
    expect(dt(/^Contractuel \(montant du marché\)/)).toHaveTextContent("2 500 000 000 GNF");
    expect(dt(/^Engagé \(non disponible\)/)).toHaveTextContent("Non disponible");
    expect(dt(/^Engagé \(non disponible\)/)).toHaveTextContent("source financière non validée");
    expect(dt(/^Engagé \(non disponible\)/).textContent).not.toContain("2 500 000 000");
    expect(dt(/^Décaissé \(décomptes payés\)/)).toHaveTextContent("300 000 000 GNF");
    expect(dt(/^Prévisionnel/)).toHaveTextContent("aucun marché dans ce périmètre");
  });

  it("agrégat partiel : « (partiel) » et la couverture, jamais un total présenté comme complet", () => {
    render(<SyntheseContractuelle synthese={syntheseVue()} />);
    const c = screen.getByText(/^Contractuel \(montant du marché\)/, { selector: "dt" }).parentElement!;
    expect(c).toHaveTextContent("(partiel)");
    expect(c).toHaveTextContent("2 marché(s) sur 3");
  });

  it("contractuel par bailleur : légende « ni engagés ni décaissés », bailleur non renseigné nommé, devise étrangère à part", () => {
    render(<SyntheseContractuelle synthese={syntheseVue()} />);
    const t = screen.getByRole("table", { name: /Contractuel par bailleur/ });
    expect(t).toHaveAccessibleName(/ni engagés ni décaissés/);
    expect(within(t).getByRole("rowheader", { name: "BAD (essai)" })).toBeInTheDocument();
    expect(within(t).getByRole("rowheader", { name: "Bailleur non renseigné" })).toBeInTheDocument();
    expect(within(t).getByText(/2 000 USD/)).toBeInTheDocument();
    expect(within(t).getByText("aucun montant saisi")).toBeInTheDocument();
  });

  it("retard : la règle PROVISOIRE et son dénominateur sont dits", () => {
    render(<SyntheseContractuelle synthese={syntheseVue()} />);
    expect(screen.getByText("1 en retard sur 2 évalués (1 non évaluables, 0 terminés non évalués)")).toBeInTheDocument();
    expect(screen.getByText(/PROVISOIRE\. Retard calendaire et physique/)).toBeInTheDocument();
  });

  it("aucun marché : les montants disent « aucun marché dans ce périmètre », pas 0", () => {
    const vide = syntheseVue({
      marchesRecenses: { nombre: 0, libelle: "Marchés recensés", definition: "", source: "" }, totauxParBailleur: [],
      financier: {
        contractuel: montant({ etat: "NON_DISPONIBLE", valeurGnf: null, motif: "AUCUN_MARCHE" }), engage: montant({ etat: "NON_DISPONIBLE", valeurGnf: null, motif: "SOURCE_NON_VALIDEE" }),
        decaisse: montant({ etat: "NON_DISPONIBLE", valeurGnf: null, motif: "AUCUN_MARCHE" }), previsionnel: montant({ etat: "NON_DISPONIBLE", valeurGnf: null, motif: "AUCUN_MARCHE" }),
      },
    });
    render(<SyntheseContractuelle synthese={vide} />);
    expect(screen.getAllByText("Non disponible").length).toBe(4);
    expect(screen.getByText("Aucun marché dans ce périmètre.")).toBeInTheDocument();
  });

  it("aucune violation axe", async () => {
    const { container } = render(<SyntheseContractuelle synthese={syntheseVue()} />);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

describe("bandeau de donnees partielles", () => {
  const r = reponse();
  it("dit la source externe non intégrée, le périmètre, la fraîcheur et les raisons", () => {
    render(<BandeauDonneesPartielles partielles={r.donneesPartielles} fraicheur={r.fraicheur} perimetre={r.perimetre} />);
    const b = screen.getByTestId("bandeau-partiel");
    expect(b).toHaveTextContent("Données contractuelles partielles : source de vérité externe non intégrée (DigitalRoad)");
    expect(b).toHaveTextContent("National : tous les marchés recensés");
    expect(b).toHaveTextContent("Copie locale gelée (ADR-003)");
    expect(b).toHaveTextContent("Dernière synchronisation avec DigitalRoad : inconnue");
    expect(screen.getByText(/Pourquoi les données sont partielles \(2 raisons\)/)).toBeInTheDocument();
    expect(b).not.toHaveTextContent("périmées");
  });

  it("copie ancienne : dite PÉRIMÉE avec le seuil provisoire", () => {
    render(<BandeauDonneesPartielles partielles={r.donneesPartielles} fraicheur={{ ...r.fraicheur, ageJours: 200, perime: true }} perimetre={r.perimetre} />);
    expect(screen.getByTestId("bandeau-partiel")).toHaveTextContent("Données périmées (au-delà de 90 jours, seuil provisoire)");
  });

  it("compte régional : le périmètre le dit, sans total national", () => {
    render(<BandeauDonneesPartielles partielles={r.donneesPartielles} fraicheur={r.fraicheur} perimetre={{ ...r.perimetre, national: false, regionIds: [1], libelle: "Périmètre régional (Conakry) ; aucun total national" }} />);
    expect(screen.getByTestId("bandeau-partiel")).toHaveTextContent("aucun total national");
  });

  it("aucune violation axe", async () => {
    const { container } = render(<BandeauDonneesPartielles partielles={r.donneesPartielles} fraicheur={r.fraicheur} perimetre={r.perimetre} />);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

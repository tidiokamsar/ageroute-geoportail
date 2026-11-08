import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UseQueryResult } from "@tanstack/react-query";
import { FicheMarche } from "./FicheMarche";
import { ENGAGE_NON_DISPONIBLE, ficheReponse, marcheVue, montant } from "./synthetique.testutil";
import { violationsAccessibilite } from "../../../test/accessibilite";
import type { ReponseMarche } from "../../../lib/aideDecisionContractuel";

/** Resultat de requete minimal : la fiche ne lit que ces champs. */
function requete(o: Partial<Record<string, unknown>>): UseQueryResult<ReponseMarche, unknown> {
  return { isPending: false, isError: false, isFetching: false, data: undefined, error: null, refetch: vi.fn(), ...o } as unknown as UseQueryResult<ReponseMarche, unknown>;
}
const m = marcheVue();
const dispo = requete({ data: ficheReponse(m) });

describe("fiche d'un marche", () => {
  it("quatre montants distincts, chacun avec sa source ; l'engagé est non disponible avec son avertissement", () => {
    render(<FicheMarche marche={m} detail={dispo} onFermer={() => undefined} />);
    const sec = screen.getByRole("region", { name: /Montants \(quatre grandeurs distinctes\)/ });
    for (const lib of ["Contractuel", "Engagé", "Décaissé", "Prévisionnel"]) expect(within(sec).getByText(lib, { selector: "dt" })).toBeInTheDocument();
    const engage = within(sec).getByText("Engagé", { selector: "dt" }).parentElement!;
    expect(engage).toHaveTextContent("Non disponible");
    expect(engage).toHaveTextContent("Source : aucune source financiere validee (B-08, ADR-003)");
    expect(engage).toHaveTextContent("la source financière n'est pas validée");
    const contractuel = within(sec).getByText("Contractuel", { selector: "dt" }).parentElement!;
    expect(contractuel).toHaveTextContent("1 250 000 000 GNF");
    expect(engage.textContent).not.toContain("1 250 000 000");
  });

  it("avancement : déclaré, constaté et financier sont trois lignes distinctes ; le constaté n'est jamais le déclaré", () => {
    render(<FicheMarche marche={m} detail={dispo} onFermer={() => undefined} />);
    const sec = screen.getByRole("region", { name: /Avancement \(déclaré, constaté, financier/ });
    const declare = within(sec).getByText("Avancement déclaré", { selector: "dt" }).nextElementSibling!;
    const constate = within(sec).getByText("Avancement constaté", { selector: "dt" }).nextElementSibling!;
    const financier = within(sec).getByText("Avancement financier déclaré", { selector: "dt" }).nextElementSibling!;
    expect(declare).toHaveTextContent(/55/);
    expect(constate).toHaveTextContent("Non disponible");
    expect(constate.textContent).not.toMatch(/55/);
    expect(financier).toHaveTextContent(/30/);
  });

  it("lots, avenants, suspensions, pièces : non disponibles, dits en clair", () => {
    render(<FicheMarche marche={m} detail={dispo} onFermer={() => undefined} />);
    expect(screen.getByText("Lots", { selector: "dt" }).nextElementSibling).toHaveTextContent("Non disponible");
    expect(screen.getByText("Avenants", { selector: "dt" }).nextElementSibling).toHaveTextContent("Non disponible");
    expect(screen.getByText("Suspensions", { selector: "dt" }).nextElementSibling).toHaveTextContent("Non disponible");
    expect(screen.getByText(/Pièces et liens source : non disponibles/)).toBeInTheDocument();
  });

  it("décomptes : tableau avec ce qui compte dans le décaissé ; seul PAYE", () => {
    render(<FicheMarche marche={m} detail={dispo} onFermer={() => undefined} />);
    const t = screen.getByRole("table", { name: /Seuls les décomptes de statut saisi/ });
    const lignes = within(t).getAllByRole("row").slice(1);
    expect(lignes).toHaveLength(2);
    expect(lignes[0]).toHaveTextContent(/PAYE.*Oui/);
    expect(lignes[1]).toHaveTextContent(/EMIS.*Non/);
  });

  it("décomptes : chargement, erreur avec Réessayer, vide sans « paiement nul », montants masqués", async () => {
    const { rerender } = render(<FicheMarche marche={m} detail={requete({ isPending: true })} onFermer={() => undefined} />);
    expect(screen.getByRole("status")).toHaveTextContent("Chargement des décomptes");

    const refetch = vi.fn();
    rerender(<FicheMarche marche={m} detail={requete({ isError: true, error: { response: { status: 500 } }, refetch })} onFermer={() => undefined} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Décomptes : chargement impossible");
    await userEvent.click(screen.getByRole("button", { name: "Réessayer : Décomptes" }));
    expect(refetch).toHaveBeenCalled();

    rerender(<FicheMarche marche={m} detail={requete({ isError: true, error: { response: { status: 403 } } })} onFermer={() => undefined} />);
    expect(screen.getByText(/Décomptes : accès refusé/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();

    rerender(<FicheMarche marche={m} detail={requete({ data: ficheReponse(m, { decomptes: { liste: [], tronque: false } }) })} onFermer={() => undefined} />);
    expect(screen.getByText(/Aucun décompte saisi : ce n'est pas un paiement nul/)).toBeInTheDocument();

    rerender(<FicheMarche marche={m} detail={requete({ data: ficheReponse(m, { decomptes: { liste: [{ numero: 1, type: "DECOMPTE", statut: "PAYE", montantGnf: null, dateEmission: null, datePaiement: null, compteDansDecaisse: true }], tronque: false } }) })} onFermer={() => undefined} />);
    expect(screen.getByRole("cell", { name: "Masqué" })).toBeInTheDocument();
  });

  it("marché multi-régional vu d'un compte régional : montants non disponibles avec la raison, chantiers d'autres régions annoncés masqués", () => {
    const masque = marcheVue({
      montants: {
        contractuel: montant({ etat: "NON_DISPONIBLE", valeurGnf: null, motif: "TERRITOIRE" }), engage: ENGAGE_NON_DISPONIBLE,
        decaisse: montant({ etat: "NON_DISPONIBLE", valeurGnf: null, motif: "TERRITOIRE" }), previsionnel: montant({ etat: "NON_DISPONIBLE", valeurGnf: null, motif: "TERRITOIRE" }),
      },
      territoire: { etabli: true, regionIds: [1], multiRegions: true, incertain: false, montantsMasques: true },
      liens: { ...m.liens, chantiers: { ...m.liens.chantiers, autresRegionsMasquees: true } },
    });
    render(<FicheMarche marche={masque} detail={requete({ data: ficheReponse(masque, { decomptes: { liste: [], tronque: false } }) })} onFermer={() => undefined} />);
    expect(screen.getAllByText("marché plus large que votre périmètre").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText(/chantiers d'autres régions sont liés à ce marché et ne sont pas affichés/)).toBeInTheDocument();
    expect(screen.queryByText(/GNF/)).toBeNull();
  });

  it("liens : qualité dite, chantier partagé signalé", () => {
    const ambigu = marcheVue({ liens: { ...m.liens, chantiers: { ...m.liens.chantiers, qualite: "AMBIGU", liste: [{ ...m.liens.chantiers.liste[0], partageEntreMarches: true }] } } });
    render(<FicheMarche marche={ambigu} detail={dispo} onFermer={() => undefined} />);
    expect(screen.getByText(/Ce chantier est rattaché à plusieurs marchés/)).toBeInTheDocument();
    expect(screen.getAllByText("Ambigu").length).toBeGreaterThan(0);
  });

  it("focus sur le titre à l'ouverture ; Échap ferme ; le bouton Fermer a un nom propre au marché", async () => {
    const onFermer = vi.fn();
    render(<FicheMarche marche={m} detail={dispo} onFermer={onFermer} />);
    expect(screen.getByRole("heading", { level: 3, name: m.intitule })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(onFermer).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: `Fermer la fiche du marché ${m.intitule}` }));
    expect(onFermer).toHaveBeenCalledTimes(2);
  });

  it("aucune violation axe (WCAG 2.1 A et AA, hors contraste)", async () => {
    const { container } = render(<FicheMarche marche={m} detail={dispo} onFermer={() => undefined} />);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

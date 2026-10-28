import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BandeauPerime, EtatChargement, EtatErreur, EtatInattendu, EtatPermission, EtatVide } from "./EtatsDecision";
import { GardeOnglet } from "./GardeOnglet";
import { classerErreurDecision } from "../../lib/aideDecisionApi";
import { violationsAccessibilite } from "../../test/accessibilite";

afterEach(() => vi.useRealTimers());

describe("EtatChargement : role status, squelette borne dans le temps", () => {
  it("annonce le chargement (role status)", () => {
    render(<EtatChargement libelle="Chargement des indicateurs…" panneau="indicateurs" />);
    expect(screen.getByRole("status")).toHaveTextContent("Chargement des indicateurs…");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("au-dela du delai, dit que la reponse tarde et propose « Reessayer : <panneau> »", async () => {
    vi.useFakeTimers();
    const onReessayer = vi.fn();
    render(<EtatChargement libelle="Chargement des indicateurs…" panneau="indicateurs" onReessayer={onReessayer} delaiMs={5000} />);
    act(() => { vi.advanceTimersByTime(4999); });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(2); });
    expect(screen.getByRole("status")).toHaveTextContent(/la réponse tarde plus que prévu/);
    const b = screen.getByRole("button", { name: "Réessayer : indicateurs" });
    b.click();
    expect(onReessayer).toHaveBeenCalledOnce();
  });
});

describe("EtatErreur : erreur API et refus de droit", () => {
  it("erreur 500 : role alert, message, Reessayer au nom unique", async () => {
    const onReessayer = vi.fn();
    render(<EtatErreur panneau="indicateurs" erreur={classerErreurDecision({ response: { status: 500 } })} onReessayer={onReessayer} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Indicateurs : chargement impossible.");
    await userEvent.click(screen.getByRole("button", { name: "Réessayer : indicateurs" }));
    expect(onReessayer).toHaveBeenCalledOnce();
  });

  it("403 : message de permission dedie, sans « Reessayer » (le rejouer ne change rien)", () => {
    render(<EtatErreur panneau="indicateurs" erreur={classerErreurDecision({ response: { status: 403 } })} onReessayer={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("Indicateurs : accès refusé.");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reponse inattendue : le dit, avec un titre propre", () => {
    render(<EtatErreur panneau="indicateurs" erreur={{ genre: "inattendue", status: null, message: "forme inattendue" }} onReessayer={() => {}} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Indicateurs : réponse inattendue.");
  });

  it("EtatInattendu : alerte de panneau avec Reessayer au nom unique", () => {
    render(<EtatInattendu panneau="budget" onReessayer={() => {}} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Budget : réponse inattendue.");
    expect(screen.getByRole("button", { name: "Réessayer : budget" })).toBeInTheDocument();
  });

  it("deux panneaux, deux noms de bouton differents", () => {
    render(<><EtatInattendu panneau="budget" onReessayer={() => {}} /><EtatInattendu panneau="régions" onReessayer={() => {}} /></>);
    const noms = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(new Set(noms).size).toBe(2);
  });
});

describe("autres etats", () => {
  it("vide : explicite, avec un titre", () => {
    render(<EtatVide titre="Aucun tronçon." detail="Élargissez les filtres." />);
    expect(screen.getByText("Aucun tronçon.")).toBeInTheDocument();
    expect(screen.getByText("Élargissez les filtres.")).toBeInTheDocument();
  });

  it("perime : date de la derniere lecture et avertissement", () => {
    render(<BandeauPerime panneau="Indicateurs" misAJourLe={Date.UTC(2026, 9, 26, 8, 0)} onReessayer={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent(/datent du 26\/10\/2026 08:00 UTC et peuvent être périmées/);
    expect(screen.getByRole("button", { name: "Actualiser : Indicateurs" })).toBeInTheDocument();
  });

  it("permission : role status avec le nom du panneau", () => {
    render(<EtatPermission panneau="Budget" />);
    expect(screen.getByRole("status")).toHaveTextContent("Budget : accès refusé.");
  });

  it("tous passent axe", async () => {
    const { container } = render(
      <>
        <EtatChargement libelle="Chargement…" />
        <EtatVide titre="Vide" />
        <EtatPermission panneau="A" />
        <EtatErreur panneau="B" erreur={{ genre: "serveur", status: 500, message: "x" }} onReessayer={() => {}} />
        <EtatInattendu panneau="C" onReessayer={() => {}} />
        <BandeauPerime panneau="D" misAJourLe={0} onReessayer={() => {}} />
      </>,
    );
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

describe("GardeOnglet", () => {
  function Bombe({ casse }: { casse: boolean }) {
    if (casse) throw new Error("boum");
    return <p>onglet sain</p>;
  }

  it("arrete l'exception, nomme l'onglet et remonte a neuf apres Reessayer", async () => {
    const trace = vi.spyOn(console, "error").mockImplementation(() => {});
    let casse = true;
    const { rerender } = render(<GardeOnglet nom="Carte et priorisation"><Bombe casse={casse} /></GardeOnglet>);
    expect(screen.getByRole("alert")).toHaveTextContent("L'onglet « Carte et priorisation » n'a pas pu s'afficher.");
    expect(screen.getByRole("alert")).toHaveTextContent("boum");
    casse = false;
    rerender(<GardeOnglet nom="Carte et priorisation"><Bombe casse={casse} /></GardeOnglet>);
    await userEvent.click(screen.getByRole("button", { name: "Réessayer : onglet Carte et priorisation" }));
    expect(screen.getByText("onglet sain")).toBeInTheDocument();
    trace.mockRestore();
  });
});

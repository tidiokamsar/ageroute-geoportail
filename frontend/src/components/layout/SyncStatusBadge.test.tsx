import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { violationsAccessibilite } from "../../test/accessibilite";

/**
 * Le badge de synchronisation de l'en-tete : ce que ces tests defendent.
 *   - « Verrouillé » quand la file n'est pas lisible (session locale verrouillee) ;
 *   - la quarantaine pour droits a SA pastille, distincte des erreurs, hors du compteur « à synchroniser », avec un lien vers le panneau ;
 *   - l'arret de l'envoi (appareil retire, compte inactif) est dit, et le bouton « synchroniser » disparait (il ne ferait rien) ;
 *   - le comportement d'avant est conserve quand rien de tout cela ne s'applique.
 */

const defaut = {
  pendingCount: 0, conflitCount: 0, abandonCount: 0, refusDroitsCount: 0, syncing: false, online: true,
  fileVerrouillee: false, appareilRevoque: false, compteInactif: false,
};
const h = vi.hoisted(() => ({ etat: {} as Record<string, unknown>, syncNow: vi.fn() }));
vi.mock("../../hooks/useOfflineSync", () => ({ useOfflineSync: () => ({ ...h.etat, syncNow: h.syncNow }) }));

import { LIEN_REFUS_DROITS, SyncStatusBadge } from "./SyncStatusBadge";

const rendre = () => render(<MemoryRouter><SyncStatusBadge /></MemoryRouter>);

beforeEach(() => { h.etat = { ...defaut }; h.syncNow.mockReset(); });
afterEach(() => cleanup());

describe("comportement conserve", () => {
  it("rien a signaler : rien n'est rendu", () => {
    const { container } = rendre();
    expect(container).toBeEmptyDOMElement();
  });

  it("en ligne avec des saisies : le bouton « à synchroniser » lance la synchronisation", async () => {
    h.etat = { ...defaut, pendingCount: 3, conflitCount: 1 };
    const user = userEvent.setup();
    rendre();
    const bouton = screen.getByRole("button", { name: /3 à synchroniser · dont 1 en conflit/ });
    await user.click(bouton);
    expect(h.syncNow).toHaveBeenCalledTimes(1);
    // Un clic est un geste de l'agent : cycle MANUEL (il leve la suspension de l'enregistrement d'appareil).
    expect(h.syncNow).toHaveBeenCalledWith({ manuel: true });
  });

  it("enregistrement d'appareil suspendu : la pastille reste un bouton « à synchroniser » (le geste est manuel), sans parler d'arret", async () => {
    h.etat = { ...defaut, pendingCount: 2, enregistrementSuspendu: true };
    const user = userEvent.setup();
    rendre();
    expect(screen.queryByText(/envoi arrêté/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "2 à synchroniser" }));
    expect(h.syncNow).toHaveBeenCalledWith({ manuel: true });
  });

  it("hors ligne : le dit, avec le nombre en attente", () => {
    h.etat = { ...defaut, online: false, pendingCount: 2 };
    rendre();
    expect(screen.getByText("Hors-ligne · 2 en attente")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("synchronisation en cours : bouton inactif", () => {
    h.etat = { ...defaut, pendingCount: 1, syncing: true };
    rendre();
    expect(screen.getByRole("button", { name: "Synchronisation…" })).toBeDisabled();
  });
});

describe("« Verrouillé »", () => {
  it("session locale verrouillee : la pastille le dit, avec son explication", () => {
    h.etat = { ...defaut, fileVerrouillee: true };
    rendre();
    const p = screen.getByText("Verrouillé");
    expect(p.closest("span")).toHaveAttribute("title", expect.stringMatching(/saisissez votre code PIN/));
  });

  it("verrouille ET des saisies en attente : les deux se voient", () => {
    h.etat = { ...defaut, fileVerrouillee: true, pendingCount: 2 };
    rendre();
    expect(screen.getByText("Verrouillé")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /2 à synchroniser/ })).toBeInTheDocument();
  });

  it("ouvert : pas de « Verrouillé »", () => {
    h.etat = { ...defaut, pendingCount: 1 };
    rendre();
    expect(screen.queryByText("Verrouillé")).not.toBeInTheDocument();
  });
});

describe("refus de droits : une rubrique a part", () => {
  it("une pastille-lien distincte, qui mene au panneau, avec son explication", () => {
    h.etat = { ...defaut, pendingCount: 2, refusDroitsCount: 2 };
    rendre();
    const lien = screen.getByRole("link", { name: "2 refusées (droits)" });
    expect(lien).toHaveAttribute("href", LIEN_REFUS_DROITS);
    expect(LIEN_REFUS_DROITS).toBe("/inspections/terrain/observations#refus-droits");
    expect(lien).toHaveAttribute("title", expect.stringMatching(/ne partent pas toutes seules/));
  });

  it("singulier", () => {
    h.etat = { ...defaut, pendingCount: 1, refusDroitsCount: 1 };
    rendre();
    expect(screen.getByRole("link", { name: "1 refusée (droits)" })).toBeInTheDocument();
  });

  it("la quarantaine est hors du compteur d'envoi : plus de bouton « à synchroniser » quand il ne reste qu'elle", () => {
    h.etat = { ...defaut, pendingCount: 2, refusDroitsCount: 2 };
    rendre();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText(/à synchroniser/)).not.toBeInTheDocument();
  });

  it("avec d'autres saisies : le compteur ne compte que celles qui partiront, la quarantaine garde sa pastille", () => {
    h.etat = { ...defaut, pendingCount: 5, refusDroitsCount: 2 };
    rendre();
    expect(screen.getByRole("button", { name: "3 à synchroniser" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "2 refusées (droits)" })).toBeInTheDocument();
  });

  it("distincte des conflits et des abandons : ils ne sont pas melanges au libelle des droits", () => {
    h.etat = { ...defaut, pendingCount: 4, conflitCount: 1, abandonCount: 1, refusDroitsCount: 1 };
    rendre();
    expect(screen.getByRole("button", { name: "3 à synchroniser · dont 1 en conflit" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "1 refusée (droits)" })).toBeInTheDocument();
  });

  it("hors ligne : la pastille des droits reste", () => {
    h.etat = { ...defaut, online: false, pendingCount: 1, refusDroitsCount: 1 };
    rendre();
    expect(screen.getByRole("link", { name: "1 refusée (droits)" })).toBeInTheDocument();
    expect(screen.getByText("Hors-ligne")).toBeInTheDocument();
  });
});

describe("envoi arrete", () => {
  it("appareil retire : pastille rouge, et le compteur n'est plus un bouton", () => {
    h.etat = { ...defaut, appareilRevoque: true, pendingCount: 3 };
    rendre();
    expect(screen.getByText("Appareil retiré · envoi arrêté")).toBeInTheDocument();
    expect(screen.getByText("3 en attente")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("compte inactif", () => {
    h.etat = { ...defaut, compteInactif: true };
    rendre();
    expect(screen.getByText("Compte inactif · envoi arrêté")).toBeInTheDocument();
  });
});

describe("accessibilite (axe-core, WCAG 2.1 A et AA, contraste exclu)", () => {
  it("0 violation : toutes les pastilles ensemble", async () => {
    h.etat = { ...defaut, pendingCount: 6, conflitCount: 1, refusDroitsCount: 2, fileVerrouillee: true };
    const { container } = rendre();
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("0 violation : envoi arrete et hors ligne", async () => {
    h.etat = { ...defaut, online: false, appareilRevoque: true, compteInactif: true, pendingCount: 1, refusDroitsCount: 1 };
    const { container } = rendre();
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

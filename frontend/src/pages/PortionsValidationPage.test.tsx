import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * L'écran de validation des portions : ce que ces tests défendent.
 *
 * TROIS AFFIRMATIONS QUE L'ÉCRAN DOIT PORTER
 *
 * **Valider resserre le référentiel.** Une portion validée interdit toute autre portion
 * validée sur les mêmes mètres, par contrainte de base. Un validateur qui l'ignore croit
 * cocher une case alors qu'il ferme une porte.
 *
 * **« À corriger » n'est pas un rejet.** Elle renvoie le relevé à son auteur avec un
 * commentaire. Les confondre ferait perdre une saisie que l'agent aurait pu sauver — et une
 * saisie de terrain perdue ne se refait pas.
 *
 * **Un commentaire est exigé pour rejeter ou renvoyer, jamais pour valider.** Un rejet sans
 * motif laisse l'auteur sans prise : il ne saura pas quoi reprendre.
 *
 * ET DEUX SIGNAUX QUI DOIVENT ÊTRE VISIBLES AVANT LE CLIC
 *
 * Une portion qui n'affirme ni revêtement ni état occuperait des mètres du référentiel
 * officiel sans rien y dire. Et une date de constat ABSENTE n'est pas une date récente : la
 * taire laisserait supposer qu'elle vaut la date de proposition.
 */

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  portions: [] as Record<string, unknown>[],
}));

vi.mock("../lib/api", () => ({ api: h }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PortionsValidationPage } from "./PortionsValidationPage";

const UUID = "11111111-1111-4111-8111-111111111111";

function portion(over: Record<string, unknown> = {}) {
  return {
    id: UUID,
    debutM: 8_000,
    finM: 13_000,
    revetement: "LATERITE",
    etat: "MOYEN",
    praticabilite: null,
    statutValidation: "A_VALIDER",
    origine: "SAISIE_TERRAIN",
    source: "terrain:GN N0001 3-1216",
    observeeLe: "2026-10-09T08:00:00.000Z",
    confiance: "HIGH",
    createdAt: "2026-10-13T10:00:00.000Z",
    clientOperationId: "portion-abc-8000-1760000000000",
    troncon: { id: "t-1", code: "GN N0001 3-1216", nom: "Conakry - Coyah", classe: "RN" },
    creePar: { id: "u-agent", nomComplet: "Mamadou Diallo" },
    revetementRef: { libelle: "Latérite", bitumineux: false },
    etatRef: { libelle: "Moyen", critique: false },
    praticabiliteRef: null,
    ...over,
  };
}

function afficher() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}><PortionsValidationPage /></QueryClientProvider>,
  );
}

beforeEach(() => {
  h.get.mockReset();
  h.post.mockReset();
  h.portions = [portion()];
  h.get.mockImplementation(async () => ({ data: { portions: h.portions, curseurSuivant: null } }));
});

describe("Ce que l'écran annonce d'entrée", () => {
  it("dit que VALIDER RESSERRE le référentiel", async () => {
    afficher();
    expect(await screen.findByText(/Valider resserre le référentiel/)).toBeInTheDocument();
    expect(screen.getByText(/interdit toute\s+autre portion validée sur les mêmes mètres/)).toBeInTheDocument();
  });

  it("dit que « à corriger » N'EST PAS un rejet", async () => {
    afficher();
    expect(await screen.findByText(/n'est pas un rejet/)).toBeInTheDocument();
  });

  it("ne demande QUE les portions A_VALIDER, et les courantes", async () => {
    afficher();
    await waitFor(() => expect(h.get).toHaveBeenCalled());
    expect(h.get.mock.calls[0][0]).toMatch(/statut=A_VALIDER/);
    // Pas d'historique : mélanger les versions ferait apparaître plusieurs portions sur les
    // mêmes mètres, et on ne saurait plus laquelle trancher.
    expect(h.get.mock.calls[0][0]).not.toMatch(/historique/);
  });

  it("annonce une file vide plutôt qu'une page muette", async () => {
    h.portions = [];
    afficher();
    expect(await screen.findByText(/Aucune portion en attente/)).toBeInTheDocument();
  });
});

describe("Ce que le validateur doit voir avant de trancher", () => {
  it("AVERTIT quand la portion n'affirme ni revêtement ni état", async () => {
    // La valider ferait occuper des mètres du référentiel officiel sans rien y dire.
    h.portions = [portion({ revetement: null, etat: null, revetementRef: null, etatRef: null })];
    afficher();
    expect(await screen.findByText(/sans rien y dire/)).toBeInTheDocument();
  });

  it("n'avertit PAS quand au moins un attribut est affirmé", async () => {
    h.portions = [portion({ etat: null, etatRef: null })];
    afficher();
    // On attend le bouton de decision, pas le code du troncon : celui-ci apparait aussi
    // dans la source du releve, et un waitFor ambigu passerait a cote de ce qu'on verifie.
    await screen.findByRole("button", { name: /Trancher/ });
    expect(screen.queryByText(/sans rien y dire/)).not.toBeInTheDocument();
  });

  it("dit qu'une DATE DE CONSTAT manque, au lieu de laisser un vide", async () => {
    // Une date absente n'est pas une date récente : la taire laisserait supposer qu'elle
    // vaut la date de proposition.
    h.portions = [portion({ observeeLe: null })];
    afficher();
    expect(await screen.findByText(/date de constat non renseignée/)).toBeInTheDocument();
  });

  it("signale un appariement GPS douteux", async () => {
    h.portions = [portion({ confiance: "LOW" })];
    afficher();
    expect(await screen.findByText(/appariement GPS douteux/)).toBeInTheDocument();
  });

  it("montre l'ORIGINE, qui ne s'apprécie pas de la même façon", async () => {
    h.portions = [portion({ origine: "DECOUPE" })];
    afficher();
    expect(await screen.findByText(/Origine : DECOUPE/)).toBeInTheDocument();
  });

  it("signale un état CRITIQUE", async () => {
    h.portions = [portion({ etatRef: { libelle: "Critique", critique: true } })];
    afficher();
    expect(await screen.findByText(/critique/)).toBeInTheDocument();
  });
});

describe("Trancher", () => {
  async function ouvrir() {
    // `delay: null` : sans cela, user-event marque une pause a chaque frappe, et la saisie d'un
    // commentaire de 25 caracteres depassait seule le plafond de 5 s sur un poste charge (19/10).
    // Meme correctif que DefautTerrainPage (T-1) ; le comportement teste ne change pas.
    const user = userEvent.setup({ delay: null });
    afficher();
    await user.click(await screen.findByRole("button", { name: /Trancher/ }));
    return user;
  }

  it("valide SANS exiger de commentaire", async () => {
    // Un rejet demande un motif ; une validation n'en demande pas, puisqu'elle n'oblige
    // personne à reprendre quoi que ce soit.
    h.post.mockResolvedValue({ data: {} });
    const user = await ouvrir();
    await user.click(screen.getByRole("button", { name: /Valider/ }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(
      `/v2/portions/${UUID}/validation`, { decision: "VALIDE" },
    ));
  });

  it("EXIGE un commentaire pour rejeter et pour renvoyer", async () => {
    // Un rejet sans motif laisse l'auteur sans prise : il ne saura pas quoi reprendre.
    await ouvrir();
    expect(screen.getByRole("button", { name: /Rejeter/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /À corriger/ })).toBeDisabled();
  });

  it("transmet le commentaire une fois saisi", async () => {
    h.post.mockResolvedValue({ data: {} });
    const user = await ouvrir();
    await user.type(screen.getByLabelText(/Commentaire de décision/), "Revoir l'abscisse de fin.");
    await user.click(screen.getByRole("button", { name: /À corriger/ }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(
      `/v2/portions/${UUID}/validation`,
      { decision: "A_CORRIGER", commentaire: "Revoir l'abscisse de fin." },
    ));
  }, 15_000);

  it("affiche le MOTIF du serveur quand la décision est refusée", async () => {
    // AUTO_VALIDATION, HORS_DELEGATION, ROLE_INSUFFISANT : traduire un refus d'autorité en
    // « erreur » ferait croire à une panne et pousserait à réessayer.
    const { toast } = await import("../lib/toast");
    h.post.mockRejectedValue({
      response: { data: { motif: "AUTO_VALIDATION", message: "Vous ne pouvez pas valider votre propre relevé." } },
    });
    const user = await ouvrir();
    await user.click(screen.getByRole("button", { name: /Valider/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Vous ne pouvez pas valider votre propre relevé."));
  });

  it("rappelle que l'auto-validation est refusée AVANT le clic", async () => {
    // Un 403 après coup donne l'impression d'une panne.
    await ouvrir();
    expect(screen.getByText(/que vous avez vous-même proposée/)).toBeInTheDocument();
  });

  it("n'offre AUCUN moyen de modifier la portion", async () => {
    // Requalifier, découper ou fusionner sont des opérations de terrain. Les offrir ici
    // donnerait au validateur le pouvoir de réécrire ce qu'il doit juger.
    await ouvrir();
    expect(screen.queryByRole("button", { name: /Requalifier|Découper|Fusionner/ })).not.toBeInTheDocument();
  });
});

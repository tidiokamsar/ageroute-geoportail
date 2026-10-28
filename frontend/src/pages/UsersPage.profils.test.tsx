import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock("../lib/api", () => ({ api: h }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ProfilModal, ModuleAccessModal } from "./UsersPage";
import type { User } from "../types";

/**
 * Les profils metier dans l'interface : ce que ces tests defendent.
 *
 * DEUX RISQUES, ET ILS SONT DE MEME NATURE
 *
 * Appliquer un profil REMPLACE le role et les modules d'un compte. Un administrateur qui
 * ne voit pas ce qu'il remplace decouvre le resultat sur un compte en service.
 *
 * Et cinq des onze correspondances ne sont pas arbitrees. Les presenter comme etablies
 * ferait prendre des deductions pour des decisions d'AGEROUTE. Le serveur porte cet
 * avertissement ; l'interface doit l'afficher, pas l'avaler.
 *
 * LE TROISIEME TEST EST LE PLUS IMPORTANT DU FICHIER
 *
 * Il ne concerne pas les profils. L'ecran d'acces aux modules AFFIRMAIT que decocher la
 * case rendait l'acces « sans restriction supplementaire ». C'etait faux depuis la
 * correction du 05/09/2026 : une liste vide vaut « aucun module ». Un administrateur qui
 * decochait pour ouvrir les droits les revoquait tous, en croyant faire l'inverse.
 */

const COMPTE: User = {
  id: "u-1",
  email: "agent@ageroute.gov.gn",
  nomComplet: "Agent Terrain",
  role: "LECTEUR",
  actif: true,
  modulesAutorises: ["dashboard"],
} as User;

const PROFILS = [
  {
    code: "AGENT_TERRAIN",
    libelle: "Agent terrain",
    usages: "Missions, GPS, observations, photos, mesures.",
    role: "INSPECTEUR",
    modules: ["dashboard", "geoportail", "troncons", "ouvrages", "inspections"],
  },
  {
    code: "ADMIN_PLATEFORME",
    libelle: "Administrateur plateforme",
    usages: "Utilisateurs, rôles, paramètres, sécurité, audit.",
    role: "ADMIN",
    modules: [],
  },
  {
    code: "AUDITEUR",
    libelle: "Auditeur",
    usages: "Consultation des historiques et journaux.",
    role: "LECTEUR",
    modules: ["dashboard", "geoportail"],
    aArbitrer:
      "L'historique se lit par entité, module par module. Il n'existe aucune vue de journal global.",
  },
];

function afficher(element: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

beforeEach(() => {
  h.get.mockReset();
  h.post.mockReset();
  h.put.mockReset();
  h.get.mockResolvedValue({ data: PROFILS });
});

describe("Appliquer un profil métier", () => {
  it("liste les profils avec la phrase d'usage du cahier", async () => {
    afficher(<ProfilModal user={COMPTE} onClose={() => {}} />);
    expect(await screen.findByText("Agent terrain")).toBeInTheDocument();
    expect(screen.getByText("Missions, GPS, observations, photos, mesures.")).toBeInTheDocument();
    expect(screen.getByText("Administrateur plateforme")).toBeInTheDocument();
  });

  it("AFFICHE L'AVERTISSEMENT des profils non arbitrés", async () => {
    // Le point le plus important sur les profils : une correspondance proposée qui se
    // présenterait comme établie ferait prendre mes déductions pour des décisions.
    afficher(<ProfilModal user={COMPTE} onClose={() => {}} />);
    expect(await screen.findByText(/À arbitrer/)).toBeInTheDocument();
    expect(screen.getByText(/aucune vue de journal global/)).toBeInTheDocument();
  });

  it("montre le remplacement du rôle avant de l'appliquer", async () => {
    const user = userEvent.setup();
    afficher(<ProfilModal user={COMPTE} onClose={() => {}} />);
    await user.click(await screen.findByRole("radio", { name: /Agent terrain/ }));

    // L'ancien rôle ET le nouveau : un profil remplace, il n'ajoute pas.
    expect(screen.getByText(/LECTEUR/)).toBeInTheDocument();
    expect(screen.getByText(/INSPECTEUR/)).toBeInTheDocument();
    expect(screen.getByText(/inspections/)).toBeInTheDocument();
  });

  it("dit qu'un administrateur n'est pas restreint par module", async () => {
    // Une liste vide signifie ici l'inverse de ce qu'elle signifie ailleurs. L'écrire
    // évite de lire « 0 module » comme « aucun accès ».
    const user = userEvent.setup();
    afficher(<ProfilModal user={COMPTE} onClose={() => {}} />);
    await user.click(await screen.findByRole("radio", { name: /Administrateur plateforme/ }));
    expect(screen.getByText(/n'est pas restreint par module/)).toBeInTheDocument();
  });

  it("n'applique rien tant qu'aucun profil n'est choisi", async () => {
    afficher(<ProfilModal user={COMPTE} onClose={() => {}} />);
    expect(await screen.findByRole("button", { name: /Appliquer ce profil/ })).toBeDisabled();
    expect(h.post).not.toHaveBeenCalled();
  });

  it("envoie le CODE du profil, et non son libellé", async () => {
    // Le libellé peut changer, le code non : c'est lui que l'API attend.
    h.post.mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    const fermer = vi.fn();
    afficher(<ProfilModal user={COMPTE} onClose={fermer} />);

    await user.click(await screen.findByRole("radio", { name: /Agent terrain/ }));
    await user.click(screen.getByRole("button", { name: /Appliquer ce profil/ }));

    await waitFor(() => expect(h.post).toHaveBeenCalledWith("/users/u-1/profil", { profil: "AGENT_TERRAIN" }));
    await waitFor(() => expect(fermer).toHaveBeenCalled());
  });
});

describe("L'écran d'accès aux modules ne ment plus sur le vide", () => {
  it("AVERTIT que décocher révoque tous les modules", async () => {
    /**
     * Le défaut corrigé. Ce texte affirmait : « Décoché : l'utilisateur voit tout ce que
     * son rôle autorise déjà, sans restriction supplémentaire. »
     *
     * C'était faux depuis la correction du 05/09/2026 dans `lib/access.ts` : une liste
     * vide vaut « aucun module ». Un administrateur qui décochait pour ouvrir les droits
     * les révoquait tous, en croyant faire l'inverse — et rien ne le lui disait.
     */
    afficher(<ModuleAccessModal user={{ ...COMPTE, modulesAutorises: [] }} onClose={() => {}} />);
    expect(screen.getByText(/perd l'accès à tous les modules/)).toBeInTheDocument();
    expect(screen.getByText(/ne vaut pas « aucune restriction »/)).toBeInTheDocument();
    expect(screen.queryByText(/sans restriction supplémentaire/)).not.toBeInTheDocument();
  });
});

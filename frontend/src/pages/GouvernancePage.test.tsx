import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  user: { id: "dt-1", role: "GESTIONNAIRE", peutDeleguerValidation: true } as Record<string, unknown>,
  etat: null as Record<string, unknown> | null,
  delegations: [] as Record<string, unknown>[],
}));

vi.mock("../lib/api", () => ({ api: h }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: h.user }) }));
vi.mock("../hooks/useConfirm", () => ({
  // La confirmation accepte toujours : ce qu'on verifie ici est l'appel qui suit, pas le
  // dialogue lui-meme.
  useConfirm: () => ({ confirm: vi.fn(async () => true), dialog: null }),
}));

import { GouvernancePage } from "./GouvernancePage";

/**
 * L'écran de désignation des validateurs : ce que ces tests défendent.
 *
 * DEUX AFFIRMATIONS QUE L'ÉCRAN DOIT PORTER, ET QUI NE VONT PAS DE SOI
 *
 * **Cinq des sept domaines n'ont aucune route de validation.** Y désigner un validateur
 * serait sans effet. Les présenter à l'identique inviterait à cocher des cases qui ne
 * changent rien — pire qu'un manque affiché, puisque cela donne le sentiment du travail
 * fait.
 *
 * **Désigner la première personne RESSERRE le domaine.** Tant que personne n'est désigné,
 * tout gestionnaire valide ; dès qu'un seul l'est, le domaine lui est réservé. Un
 * administrateur qui l'ignore croit ajouter un droit alors qu'il en retire à tous les
 * autres.
 *
 * Le reste de l'écran suit la règle du serveur, qui a ses propres tests.
 */

const DELEGATIONS = [
  {
    id: "d-1", domaine: "DEFAUT", regionId: null,
    debutLe: "2026-01-01T00:00:00.000Z", finLe: null, revoqueeLe: null,
    motif: "Arbitrage technique national", enVigueur: true,
    validateur: { id: "g-1", nomComplet: "Mamadou Diallo", role: "GESTIONNAIRE" },
    deleguePar: { id: "dt-1", nomComplet: "Direction Technique" },
    region: null,
  },
  {
    id: "d-2", domaine: "OBSERVATION", regionId: 7,
    debutLe: "2026-01-01T00:00:00.000Z", finLe: null,
    revoqueeLe: "2026-09-01T00:00:00.000Z",
    motif: null, enVigueur: false,
    validateur: { id: "g-2", nomComplet: "Aïssata Camara", role: "GESTIONNAIRE" },
    deleguePar: { id: "dt-1", nomComplet: "Direction Technique" },
    region: { id: 7, nom: "Kankan" },
  },
];

const ETAT = {
  domaines: 7, designes: 1,
  nonDesignes: ["OBSERVATION", "TRONCON", "OUVRAGE", "POINT_NOIR", "POSTE", "CHANTIER"],
  sansChemindeValidation: ["TRONCON", "OUVRAGE", "POINT_NOIR", "POSTE", "CHANTIER"],
  domainesActifs: ["DEFAUT", "OBSERVATION"],
  aDesigner: ["OBSERVATION"],
  delegationsEnVigueur: 1,
};

function afficher() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><GouvernancePage /></QueryClientProvider>);
}

beforeEach(() => {
  h.get.mockReset();
  h.post.mockReset();
  h.user = { id: "dt-1", role: "GESTIONNAIRE", peutDeleguerValidation: true };
  h.etat = ETAT;
  h.delegations = DELEGATIONS;
  h.get.mockImplementation(async (url: string) => {
    if (url.includes("/admin/gouvernance/validation")) return { data: h.etat };
    if (url.includes("/gouvernance/delegations")) return { data: h.delegations };
    if (url.startsWith("/regions")) return { data: [{ id: 7, nom: "Kankan" }] };
    if (url.includes("/gouvernance/domaines")) {
      return { data: { actifs: ETAT.domainesActifs, sansChemindeValidation: ETAT.sansChemindeValidation } };
    }
    if (url.includes("/gouvernance/validateurs-possibles")) {
      // Le serveur exclut deja les lecteurs et le demandeur : le mock reproduit cela,
      // sinon le test verifierait un filtrage qui n'existe plus cote client.
      return { data: [{ id: "g-1", nomComplet: "Mamadou Diallo", role: "GESTIONNAIRE" }] };
    }
    return { data: [] };
  });
});

describe("L'écran dit ce que la désignation change", () => {
  it("AVERTIT que désigner la première personne resserre le domaine", async () => {
    // Un administrateur qui l'ignore croit ajouter un droit alors qu'il en retire à tous
    // les autres gestionnaires.
    afficher();
    expect(await screen.findByText(/resserre/)).toBeInTheDocument();
    expect(screen.getByText(/tout gestionnaire y valide/)).toBeInTheDocument();
  });

  it("explique qu'une délégation régionale ne couvre pas une région inconnue", async () => {
    afficher();
    expect(await screen.findByText(/dont la région est inconnue/)).toBeInTheDocument();
  });
});

describe("Les domaines sans route de validation sont séparés", () => {
  it("AVERTIT que désigner y serait sans effet, et les nomme", async () => {
    // Le test le plus important de ce fichier. Sans cet avertissement, l'écran inviterait
    // à combler cinq cases qui ne changent rien.
    afficher();
    expect(await screen.findByText(/serait sans effet aujourd'hui/)).toBeInTheDocument();
    expect(screen.getByText(/Tronçons, Ouvrages d'art, Points noirs/)).toBeInTheDocument();
  });

  it("marque ces domaines dans la liste de choix", async () => {
    afficher();
    // On attend une option, pas le titre du formulaire : celui-ci est statique et apparait
    // AVANT l'arrivee des donnees — le test passait alors a cote de ce qu'il verifie.
    expect(await screen.findByRole("option", { name: /Tronçons — sans effet aujourd'hui/ })).toBeInTheDocument();
    // Les domaines qui valident, eux, sont proposés sans réserve.
    expect(screen.getByRole("option", { name: "Défauts" })).toBeInTheDocument();
  });
});

describe("Qui peut être désigné", () => {
  it("ne propose QUE des comptes qui peuvent valider", async () => {
    // Le serveur exclut les lecteurs et les inspecteurs, que `ROLES_VALIDATEURS` n'admet
    // pas : les désigner créerait une délégation qui ne servirait jamais.
    afficher();
    expect(await screen.findByRole("option", { name: /Mamadou Diallo/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Lecteur/ })).not.toBeInTheDocument();
  });

  it("NE SE PROPOSE JAMAIS SOI-MÊME", async () => {
    // Le serveur retire le demandeur de la liste : l'auto-désignation est refusée, et
    // proposer un choix qui sera rejeté fait perdre du temps.
    afficher();
    // On attend d'abord qu'une option existe, sinon l'absence constatee ne prouverait que
    // la lenteur du chargement.
    await screen.findByRole("option", { name: /Mamadou Diallo/ });
    expect(screen.queryByRole("option", { name: /Direction Technique/ })).not.toBeInTheDocument();
  });
});

describe("L'historique des désignations reste visible", () => {
  it("affiche une désignation révoquée au lieu de la masquer", async () => {
    // Des validations ont été rendues sous son autorité : les faire disparaître les
    // rendrait inexplicables.
    afficher();
    expect(await screen.findByText(/Aïssata Camara/)).toBeInTheDocument();
    expect(screen.getByText("Révoquée")).toBeInTheDocument();
  });

  it("n'offre pas de révoquer ce qui l'est déjà", async () => {
    afficher();
    await screen.findByText(/Aïssata Camara/);
    expect(screen.getAllByTitle("Révoquer")).toHaveLength(1);
  });

  it("distingue le périmètre national du régional", async () => {
    afficher();
    expect(await screen.findByText(/Tout le pays · désignée par/)).toBeInTheDocument();
    expect(screen.getByText(/Kankan · désignée par/)).toBeInTheDocument();
  });

  it("révoque sans supprimer, et le dit", async () => {
    h.post.mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    afficher();
    // Mamadou figure desormais DEUX fois — dans la liste de choix et dans les
    // designations — donc on attend le bouton plutot que son nom.
    await user.click(await screen.findByTitle("Révoquer"));
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith("/gouvernance/delegations/d-1/revocation", {}));
  });
});

describe("Désigner", () => {
  it("envoie le domaine, le validateur et le périmètre", async () => {
    h.post.mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    afficher();
    await screen.findByRole("option", { name: "Défauts" });

    await user.selectOptions(screen.getByLabelText(/Domaine/), "DEFAUT");
    await user.selectOptions(screen.getByLabelText(/Validateur/), "g-1");
    await user.selectOptions(screen.getByLabelText(/Périmètre/), "7");
    await user.click(screen.getByRole("button", { name: /Désigner/ }));

    await waitFor(() => expect(h.post).toHaveBeenCalledWith("/gouvernance/delegations",
      expect.objectContaining({ domaine: "DEFAUT", validateurId: "g-1", regionId: 7 })));
  });

  it("envoie un périmètre NUL pour tout le pays, et non zéro", async () => {
    // Zéro serait un identifiant de région, et aucune région ne porte le numéro zéro :
    // la délégation deviendrait régionale sur une région inexistante, donc inopérante.
    h.post.mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    afficher();
    await screen.findByRole("option", { name: "Défauts" });

    await user.selectOptions(screen.getByLabelText(/Domaine/), "DEFAUT");
    await user.selectOptions(screen.getByLabelText(/Validateur/), "g-1");
    await user.click(screen.getByRole("button", { name: /Désigner/ }));

    await waitFor(() => expect(h.post).toHaveBeenCalledWith("/gouvernance/delegations",
      expect.objectContaining({ regionId: null })));
  });
});

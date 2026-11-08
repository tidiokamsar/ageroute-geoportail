import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { violationsAccessibilite } from "../test/accessibilite";

/**
 * L'ecran des conflits de synchronisation : ce que ces tests defendent.
 *
 * LES DEUX VERSIONS, COTE A COTE, AVANT TOUTE DECISION. Un responsable qui tranche sans voir ce que le
 * telephone a envoye ET ce que le serveur portait decide a l'aveugle.
 *
 * CE QUI EST IMPOSSIBLE EST DIT AVANT LE CLIC. Retenir la version du telephone est refuse par le serveur pour
 * une creation et pour un defaut : le bouton est desactive et la raison affichee, au lieu d'un 409 apres coup
 * qui passerait pour une panne.
 *
 * UNE DECISION SE CONFIRME ; UNE DEMANDE DE VERIFICATION NE TRANCHE PAS. Aucune requete d'arbitrage ne part
 * avant la confirmation, et demander une verification n'appelle jamais la route de resolution.
 *
 * Le serveur est ici SIMULE (api mockee) : la route reelle est eprouvee par
 * `backend/tests-integration/conflits-sync.integration.mts`.
 */

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  conflits: [] as Record<string, unknown>[],
  total: 0,
  tronque: false,
  toastErreur: vi.fn(),
  toastSucces: vi.fn(),
}));

vi.mock("../lib/api", () => ({ api: h }));
vi.mock("../lib/toast", () => ({ toast: { success: h.toastSucces, error: h.toastErreur } }));

import { ConflitsSyncPage } from "./ConflitsSyncPage";

const ID_U = "11111111-1111-4111-8111-111111111111";
const ID_C = "22222222-2222-4222-8222-222222222222";
const ID_S = "33333333-3333-4333-8333-333333333333";

function conflit(over: Record<string, unknown> = {}) {
  return {
    id: ID_U, operationId: "op-u", entityType: "Observation", entityId: "obs-u", operation: "UPDATE", motif: "VERSION_PERIMEE",
    creeLe: "2026-10-22T10:00:00.000Z",
    agent: { id: "a1", nomComplet: "Mamadou Diallo" }, appareil: { id: "d1", nom: "Tecno de terrain", plateforme: "android" },
    payloadLocal: { description: "Nid de poule, 40 cm" },
    payloadServeur: { id: "obs-u", description: "Nid de poule, 20 cm", version: 2, gravite: "FAIBLE" },
    resolutionsPossibles: { SERVEUR: true, LOCAL: true, motifLocalImpossible: null },
    verificationDemandee: null,
    ...over,
  };
}

const conflitCreation = () => conflit({
  id: ID_C, operationId: "op-c", entityId: "obs-c", operation: "CREATE", motif: "DEJA_EXISTANTE",
  payloadLocal: { type: "DEGRADATION", description: "version du telephone", lat: 9.5 },
  payloadServeur: { id: "obs-c", type: "DEGRADATION", description: "version du serveur", lat: 9.5, version: 1 },
  resolutionsPossibles: { SERVEUR: true, LOCAL: false, motifLocalImpossible: "Une création en conflit doit être représentée avec un nouvel identifiant avant arbitrage." },
});

const conflitSuppression = () => conflit({
  id: ID_S, operationId: "op-s", entityId: "obs-s", operation: "DELETE", motif: "VERSION_PERIMEE",
  payloadLocal: {}, payloadServeur: { id: "obs-s", description: "modifiee entre-temps", version: 2 },
});

function afficher() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><ConflitsSyncPage /></QueryClientProvider>);
}

beforeEach(() => {
  h.get.mockReset(); h.post.mockReset(); h.toastErreur.mockReset(); h.toastSucces.mockReset();
  h.conflits = [conflit()];
  h.total = 1;
  h.tronque = false;
  h.get.mockImplementation(async () => ({ data: { conflits: h.conflits, total: h.total, tronque: h.tronque } }));
  h.post.mockResolvedValue({ data: {} });
});

describe("Ce que l'ecran annonce et demande", () => {
  it("dit que les DEUX versions sont toujours conservees, et qu'il n'y a pas de fusion", async () => {
    afficher();
    expect(await screen.findByText(/Les deux versions sont toujours conservées/)).toBeInTheDocument();
    expect(screen.getByText(/Aucune fusion automatique/)).toBeInTheDocument();
  });

  it("ne demande que les conflits ouverts, via la route de liste", async () => {
    afficher();
    await screen.findByText(/Mamadou Diallo/);
    expect(h.get).toHaveBeenCalledWith("/v2/sync/conflits?limite=100");
  });

  it("annonce une liste vide plutot qu'une page muette", async () => {
    h.conflits = []; h.total = 0;
    afficher();
    expect(await screen.findByText(/Aucun conflit ouvert/)).toBeInTheDocument();
  });

  it("dit quand la liste est tronquee", async () => {
    h.total = 340; h.tronque = true;
    afficher();
    expect(await screen.findByText(/340 conflit\(s\) ouvert\(s\) \(les 1 plus anciens sont affichés\)/)).toBeInTheDocument();
  });

  it("affiche l'erreur du serveur, par exemple le refus d'acces", async () => {
    h.get.mockRejectedValue({ response: { status: 403, data: { message: "Seul un gestionnaire ou un administrateur consulte les conflits de synchronisation." } } });
    afficher();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Seul un gestionnaire/);
  });
});

describe("Les deux versions cote a cote", () => {
  it("montre, pour chaque champ envoye par le telephone, SA valeur et celle du SERVEUR, et marque ce qui differe", async () => {
    afficher();
    const tableau = await screen.findByRole("table");
    expect(within(tableau).getByRole("columnheader", { name: "Version du téléphone" })).toBeInTheDocument();
    expect(within(tableau).getByRole("columnheader", { name: "Version du serveur" })).toBeInTheDocument();

    const ligne = within(tableau).getByRole("row", { name: /description/ });
    const cellules = within(ligne).getAllByRole("cell");
    expect(cellules[0]).toHaveTextContent("Nid de poule, 40 cm");
    expect(cellules[1]).toHaveTextContent("Nid de poule, 20 cm");
    expect(within(ligne).getByText("différent")).toBeInTheDocument();

    // La version du serveur est montree meme si le telephone ne l'a pas envoyee.
    const version = within(tableau).getByRole("row", { name: /version/ });
    expect(within(version).getAllByRole("cell")[1]).toHaveTextContent("2");
    expect(within(version).getAllByRole("cell")[0]).toHaveTextContent("non touché par le téléphone");
  });

  it("nomme l'agent, l'appareil, l'operation et le motif en clair", async () => {
    afficher();
    expect(await screen.findByText(/Modification/)).toBeInTheDocument();
    expect(screen.getByText("Mamadou Diallo")).toBeInTheDocument();
    expect(screen.getByText(/Tecno de terrain/)).toBeInTheDocument();
    expect(screen.getByText(/Le serveur a changé depuis la dernière version connue du téléphone/)).toBeInTheDocument();
  });

  it("une suppression est annoncee comme telle (et comme LOGIQUE)", async () => {
    h.conflits = [conflitSuppression()];
    afficher();
    expect(await screen.findByText(/demande la SUPPRESSION/)).toBeInTheDocument();
    expect(screen.getByText(/ligne est conservée/)).toBeInTheDocument();
    // Le telephone n'envoie aucun champ pour une suppression : seule la version du serveur est comparable.
    const lignes = within(screen.getByRole("table")).getAllByRole("row");
    expect(lignes).toHaveLength(2);   // l'en-tete + la version
    expect(within(lignes[1]).getAllByRole("cell")[0]).toHaveTextContent("non touché par le téléphone");
  });
});

describe("Ce qui est impossible est dit avant le clic", () => {
  it("desactive « version du telephone » pour une creation, avec la raison affichee", async () => {
    h.conflits = [conflitCreation()];
    afficher();
    const bouton = await screen.findByRole("button", { name: "Retenir la version du téléphone" });
    expect(bouton).toBeDisabled();
    expect(screen.getByText(/nouvel identifiant/)).toBeInTheDocument();
    expect(bouton).toHaveAccessibleDescription(/nouvel identifiant/);
    expect(screen.getByRole("button", { name: "Garder la version du serveur" })).toBeEnabled();
  });

  it("l'active pour une modification", async () => {
    afficher();
    expect(await screen.findByRole("button", { name: "Retenir la version du téléphone" })).toBeEnabled();
  });
});

describe("Trancher se confirme", () => {
  it("« garder le serveur » : aucune requete avant la confirmation, puis /resolve SERVEUR", async () => {
    const user = userEvent.setup();
    afficher();
    await user.click(await screen.findByRole("button", { name: "Garder la version du serveur" }));
    expect(h.post).not.toHaveBeenCalled();
    const groupe = screen.getByRole("group", { name: "Confirmer l'arbitrage" });
    expect(within(groupe).getByText(/rien n'est modifié/)).toBeInTheDocument();
    expect(within(groupe).getByText(/définitive/)).toBeInTheDocument();

    await user.click(within(groupe).getByRole("button", { name: "Confirmer" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith("/v2/sync/resolve", { conflitId: ID_U, resolution: "SERVEUR" }));
    expect(h.post).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(h.toastSucces).toHaveBeenCalledWith(expect.stringMatching(/reste conservée/)));
  });

  it("annuler ne poste rien et remet les trois choix", async () => {
    const user = userEvent.setup();
    afficher();
    await user.click(await screen.findByRole("button", { name: "Garder la version du serveur" }));
    await user.click(screen.getByRole("button", { name: "Annuler" }));
    expect(h.post).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Demander une vérification" })).toBeInTheDocument();
  });

  it("« version du telephone » : /resolve LOCAL, et le texte de confirmation parle d'ecriture au nom de l'arbitre", async () => {
    const user = userEvent.setup();
    afficher();
    await user.click(await screen.findByRole("button", { name: "Retenir la version du téléphone" }));
    const groupe = screen.getByRole("group", { name: "Confirmer l'arbitrage" });
    expect(within(groupe).getByText(/au nom de l'arbitre, avec une trace d'audit/)).toBeInTheDocument();
    await user.click(within(groupe).getByRole("button", { name: "Confirmer" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith("/v2/sync/resolve", { conflitId: ID_U, resolution: "LOCAL" }));
  });

  it("retenir une suppression dit que la suppression est LOGIQUE", async () => {
    h.conflits = [conflitSuppression()];
    const user = userEvent.setup();
    afficher();
    await user.click(await screen.findByRole("button", { name: "Retenir la version du téléphone" }));
    expect(screen.getByText(/supprimé LOGIQUEMENT \(la ligne est conservée\)/)).toBeInTheDocument();
  });

  it("un refus du serveur (409) est affiche avec son message, et la decision n'est pas presentee comme prise", async () => {
    h.post.mockRejectedValue({ response: { status: 409, data: { message: "L'observation a changé depuis la création du conflit." } } });
    const user = userEvent.setup();
    afficher();
    await user.click(await screen.findByRole("button", { name: "Retenir la version du téléphone" }));
    await user.click(screen.getByRole("button", { name: "Confirmer" }));
    await waitFor(() => expect(h.toastErreur).toHaveBeenCalledWith("L'observation a changé depuis la création du conflit."));
    expect(h.toastSucces).not.toHaveBeenCalled();
  });

  it("recharge la liste apres un arbitrage reussi", async () => {
    const user = userEvent.setup();
    afficher();
    await user.click(await screen.findByRole("button", { name: "Garder la version du serveur" }));
    await user.click(screen.getByRole("button", { name: "Confirmer" }));
    await waitFor(() => expect(h.get.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});

describe("Demander une verification ne tranche pas", () => {
  it("exige un motif d'au moins 3 caracteres, poste sur la route de verification, JAMAIS sur /resolve", async () => {
    const user = userEvent.setup();
    afficher();
    await user.click(await screen.findByRole("button", { name: "Demander une vérification" }));
    const envoyer = screen.getByRole("button", { name: "Envoyer la demande" });
    expect(envoyer).toBeDisabled();
    expect(screen.getByText(/Le conflit n'est pas tranché/)).toBeInTheDocument();

    await user.type(screen.getByLabelText("Pourquoi une vérification ?"), "  appeler l'agent  ");
    expect(envoyer).toBeEnabled();
    await user.click(envoyer);

    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`/v2/sync/conflits/${ID_U}/verification`, { motif: "appeler l'agent" }));
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post.mock.calls.some((c) => c[0] === "/v2/sync/resolve")).toBe(false);
  });

  it("une demande deja posee est montree, le conflit reste ouvert, et on ne peut pas la redemander", async () => {
    h.conflits = [conflit({ verificationDemandee: { le: "2026-10-22T12:00:00.000Z", parId: "chef", motif: "appeler l'agent" } })];
    afficher();
    expect(await screen.findByText(/Vérification demandée/)).toBeInTheDocument();
    expect(screen.getByText(/appeler l'agent/)).toBeInTheDocument();
    expect(screen.getByText(/Le conflit reste ouvert/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Demander une vérification" })).not.toBeInTheDocument();
    // On peut toujours trancher apres.
    expect(screen.getByRole("button", { name: "Garder la version du serveur" })).toBeEnabled();
  });
});

describe("Accessibilite (axe-core, WCAG 2.1 A et AA, contraste exclu : jsdom ne le calcule pas)", () => {
  it("0 violation : liste de trois conflits (modification, creation, suppression)", async () => {
    h.conflits = [conflit(), conflitCreation(), conflitSuppression()]; h.total = 3;
    const { container } = afficher();
    await screen.findAllByRole("table");
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("0 violation : confirmation ouverte, formulaire de verification ouvert, verification deja demandee", async () => {
    h.conflits = [
      conflit(),
      conflitCreation(),
      conflit({ id: "44444444-4444-4444-8444-444444444444", verificationDemandee: { le: "2026-10-22T12:00:00.000Z", parId: "c", motif: "appeler" } }),
    ];
    h.total = 3;
    const user = userEvent.setup();
    const { container } = afficher();
    const gardes = await screen.findAllByRole("button", { name: "Garder la version du serveur" });
    await user.click(gardes[0]);
    await user.click(screen.getAllByRole("button", { name: "Demander une vérification" })[0]);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("0 violation : liste vide et erreur", async () => {
    h.conflits = []; h.total = 0;
    const { container, unmount } = afficher();
    await screen.findByText(/Aucun conflit ouvert/);
    expect(await violationsAccessibilite(container)).toEqual([]);
    unmount();
    h.get.mockRejectedValue(new Error("reseau"));
    const second = afficher();
    await screen.findByRole("alert");
    expect(await violationsAccessibilite(second.container)).toEqual([]);
  });
});

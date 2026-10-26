import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { violationsAccessibilite } from "../test/accessibilite";

/**
 * Releves envoyes (liste) : ce que ces tests defendent.
 *   - la liste montre date et heure, duree, distance, positions, reperes, rattachement, et un lien au nom distinct par ligne ;
 *   - un taux `null` se lit « non évalué », jamais « 0 % » ;
 *   - un ECHEC (reseau, serveur, reponse illisible, droit refuse) n'est JAMAIS presente comme « aucun relevé » ;
 *   - le vide dit la verite (un releve non envoye reste sur le telephone) et renvoie vers l'enregistrement ;
 *   - la pagination par curseur ajoute les pages sans perdre les precedentes, meme quand la page suivante echoue ;
 *   - la colonne et le filtre « agent » n'existent que pour les roles qui voient plusieurs agents ;
 *   - zero violation d'accessibilite (axe-core) sur chaque vue.
 * Le serveur est SIMULE (api mockee) : les releves ci-dessous sont des donnees d'essai propres a ce fichier.
 */

const h = vi.hoisted(() => ({
  get: vi.fn(),
  user: { id: "agent-1", role: "INSPECTEUR" as string, nomComplet: "Agent Un", modulesAutorises: [] as string[] },
}));
vi.mock("../lib/api", () => ({ api: { get: h.get } }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: h.user }) }));

import { ReleveEnvoyesPage } from "./ReleveEnvoyesPage";
import { LISTE_REELLE } from "../lib/roulageEnvoyes.reel.fixture";

function releve(n: number, sur: Record<string, unknown> = {}) {
  const jour = String(10 + n).padStart(2, "0");
  return {
    id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`,
    debutA: `2026-10-${jour}T11:${String(n).padStart(2, "0")}:07Z`, finA: `2026-10-${jour}T12:30:00Z`,
    dureeS: 1_500 + n, nbPoints: 800 + n, nbMarqueurs: n, nbEvenements: 1,
    tauxRattachement: null, longueurM: null, missionId: null,
    agent: { id: "agent-1", nom: "Agent Un" }, nbTronconsTraverses: 0, creeLe: `2026-10-${jour}T13:00:00Z`,
    ...sur,
  };
}

const page = (items: unknown[], suivant: string | null = null, total: number = items.length) => ({ data: { items, suivant, total } });
const erreurHttp = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: { error: "x", code: "X" } } });

function afficher() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter><ReleveEnvoyesPage /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  h.get.mockReset();
  h.user = { id: "agent-1", role: "INSPECTEUR", nomComplet: "Agent Un", modulesAutorises: [] };
});

describe("liste", () => {
  it("montre un tableau nomme, avec ses en-tetes de colonne et une ligne par releve", async () => {
    h.get.mockResolvedValue(page([releve(1, { tauxRattachement: 0.874, longueurM: 12_345 }), releve(2)]));
    afficher();
    const tableau = await screen.findByRole("table", { name: /Relevés en roulant envoyés/ });
    const entetes = within(tableau).getAllByRole("columnheader").map((c) => c.textContent);
    expect(entetes).toEqual(["Date et heure", "Détail", "Durée", "Distance parcourue", "Positions", "Repères", "Rattachement au réseau"]);
    expect(within(tableau).getAllByRole("rowheader")).toHaveLength(2);
    expect(within(tableau).getByText("87 %")).toBeInTheDocument();
    expect(within(tableau).getByText("12,3 km")).toBeInTheDocument();
    expect(screen.getByText("2 relevés envoyés")).toBeInTheDocument();
    expect(h.get).toHaveBeenCalledWith("/v2/roulage/sessions", { params: { limite: 25 } });
  });

  it("lit la liste REELLE du serveur (roulageEnvoyes.reel.fixture.ts) : trois releves, distance parcourue et taux 0..1 tels que rendus", async () => {
    h.get.mockResolvedValue({ data: LISTE_REELLE });
    h.user = { ...h.user, id: LISTE_REELLE.items[0].agent.id }; // l'agent d'essai lit ses propres releves : pas de colonne « agent »
    afficher();
    const tableau = await screen.findByRole("table", { name: /Relevés en roulant envoyés/ });
    const lignes = within(tableau).getAllByRole("row").slice(1);
    expect(lignes).toHaveLength(3);
    // ECR-2 (hors reseau, 0 % est une valeur reelle), ECR-1 (sur le reseau, 100 %), ECR-3 (25 000 positions, hors reseau).
    expect(lignes.map((l) => within(l).getAllByRole("cell").map((c) => c.textContent))).toEqual([
      [expect.stringMatching(/^Voir le relevé/), "1 min 29 s", "878 m", "90", "1", "0 %"],
      [expect.stringMatching(/^Voir le relevé/), "4 min 40 s", "2,8 km", "281", "2", "100 %"],
      [expect.stringMatching(/^Voir le relevé/), "6 h 56 min", "18,9 km", expect.stringMatching(/^25\s000$/), "0", "0 %"],
    ]);
    expect(screen.getByText("3 relevés envoyés")).toBeInTheDocument();
  });

  it("un taux null se lit « non évalué » et une distance null « non calculée », jamais 0", async () => {
    h.get.mockResolvedValue(page([releve(1)]));
    afficher();
    const ligne = (await screen.findAllByRole("row"))[1];
    expect(within(ligne).getByText("non évalué")).toBeInTheDocument();
    expect(within(ligne).getByText("non calculée")).toBeInTheDocument();
    expect(ligne.textContent).not.toMatch(/\b0 %/);
  });

  it("chaque ligne a un lien au nom distinct, vers son detail", async () => {
    h.get.mockResolvedValue(page([releve(1), releve(2)]));
    afficher();
    const liens = await screen.findAllByRole("link", { name: /^Voir le relevé du / });
    expect(liens).toHaveLength(2);
    expect(new Set(liens.map((l) => l.textContent)).size).toBe(2);
    expect(liens[0]).toHaveAttribute("href", "/inspections/releve/envoyes/00000000-0000-4000-8000-000000000001");
    expect(liens[0].textContent).toMatch(/Voir le relevé du \d{2}\/\d{2}\/2026 à \d{2}:\d{2}:07/);
  });

  it("n'affiche ni colonne ni filtre « agent » pour un role qui ne voit que ses releves", async () => {
    h.get.mockResolvedValue(page([releve(1)]));
    afficher();
    await screen.findByRole("table");
    expect(screen.queryByRole("columnheader", { name: "Agent" })).toBeNull();
    expect(screen.queryByLabelText("Agent")).toBeNull();
  });
});

describe("etats", () => {
  it("chargement : un message de statut, ni vide ni erreur", async () => {
    h.get.mockReturnValue(new Promise(() => undefined));
    afficher();
    expect(await screen.findByRole("status")).toHaveTextContent("Chargement des relevés envoyés");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Aucun relevé envoyé/)).toBeNull();
  });

  it("vide : dit la verite et renvoie vers l'enregistrement", async () => {
    h.get.mockResolvedValue(page([]));
    afficher();
    expect(await screen.findByRole("heading", { name: "Aucun relevé envoyé depuis ce compte" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Aucun relevé envoyé depuis ce compte" })).getByText(/reste sur le téléphone/)).toBeInTheDocument();
    const liens = screen.getAllByRole("link", { name: "Enregistrer un relevé en roulant" });
    expect(liens.length).toBeGreaterThan(0);
    for (const l of liens) expect(l).toHaveAttribute("href", "/inspections/releve/enregistrer");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("erreur reseau : une alerte avec « Réessayer », jamais un vide ; le bouton relance la requete", async () => {
    h.get.mockRejectedValueOnce(new Error("Network Error")).mockResolvedValueOnce(page([releve(1)]));
    afficher();
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent(/n'a pas répondu/);
    expect(screen.queryByText(/Aucun relevé envoyé depuis ce compte/)).toBeNull();
    await userEvent.click(within(alerte).getByRole("button", { name: "Réessayer" }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(h.get).toHaveBeenCalledTimes(2);
  });

  it("erreur serveur 500 : une alerte, jamais un vide", async () => {
    h.get.mockRejectedValue(erreurHttp(500));
    afficher();
    expect(await screen.findByRole("alert")).toHaveTextContent(/erreur/);
    expect(screen.queryByText(/Aucun relevé envoyé depuis ce compte/)).toBeNull();
  });

  it("reponse illisible : une alerte (le serveur a repondu mais pas selon le contrat), jamais un vide", async () => {
    h.get.mockResolvedValue({ data: { resultats: [] } });
    afficher();
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent(/n'a pas pu être lue/);
    expect(alerte).toHaveTextContent(/Ce n'est pas une absence de relevé/);
    expect(screen.queryByRole("heading", { name: /Aucun relevé envoyé/ })).toBeNull();
  });

  it("acces refuse (403) : le droit est dit, sans bouton « Réessayer »", async () => {
    h.get.mockRejectedValue(erreurHttp(403));
    afficher();
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent(/Accès refusé/);
    expect(within(alerte).queryByRole("button", { name: "Réessayer" })).toBeNull();
    expect(screen.queryByText(/Aucun relevé envoyé depuis ce compte/)).toBeNull();
  });
});

describe("pagination", () => {
  it("« Charger plus » demande la page suivante avec son curseur et ajoute les lignes", async () => {
    h.get
      .mockResolvedValueOnce(page([releve(1), releve(2)], "curseur-2", 3))
      .mockResolvedValueOnce(page([releve(3)], null, 3));
    afficher();
    expect(await screen.findByText("2 relevés affichés sur 3")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Charger plus" }));
    await waitFor(() => expect(screen.getAllByRole("link", { name: /^Voir le relevé du / })).toHaveLength(3));
    expect(h.get).toHaveBeenLastCalledWith("/v2/roulage/sessions", { params: { limite: 25, curseur: "curseur-2" } });
    expect(screen.getByText("3 relevés envoyés")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Charger plus" })).toBeNull();
  });

  it("une page suivante qui echoue garde les lignes deja chargees et propose de reessayer", async () => {
    h.get
      .mockResolvedValueOnce(page([releve(1)], "curseur-2", 2))
      .mockRejectedValueOnce(new Error("Network Error"))
      .mockResolvedValueOnce(page([releve(2)], null, 2));
    afficher();
    await userEvent.click(await screen.findByRole("button", { name: "Charger plus" }));
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent(/déjà chargés restent affichés/);
    expect(screen.getAllByRole("link", { name: /^Voir le relevé du / })).toHaveLength(1);
    await userEvent.click(within(alerte).getByRole("button", { name: "Réessayer" }));
    await waitFor(() => expect(screen.getAllByRole("link", { name: /^Voir le relevé du / })).toHaveLength(2));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("filtres", () => {
  it("les dates partent au serveur en instants, et un filtre sans resultat n'est pas un echec", async () => {
    h.get.mockResolvedValueOnce(page([releve(1)])).mockResolvedValue(page([]));
    afficher();
    await screen.findByRole("table");
    fireEvent.change(screen.getByLabelText("Du"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("Au (jour inclus)"), { target: { value: "2026-10-05" } });
    await waitFor(() => expect(h.get).toHaveBeenLastCalledWith("/v2/roulage/sessions", {
      params: { limite: 25, depuis: new Date(2026, 9, 1, 0, 0, 0, 0).toISOString(), jusqua: new Date(2026, 9, 5, 23, 59, 59, 999).toISOString() },
    }));
    expect(await screen.findByText(/Aucun relevé ne correspond à ces filtres/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    await userEvent.click(screen.getAllByRole("button", { name: /Réinitialiser les filtres/ })[0]);
    await waitFor(() => expect(h.get).toHaveBeenLastCalledWith("/v2/roulage/sessions", { params: { limite: 25 } }));
  });

  it("un debut apres la fin n'est pas envoye : l'ecran le dit", async () => {
    h.get.mockResolvedValue(page([releve(1)]));
    afficher();
    await screen.findByRole("table");
    const appels = h.get.mock.calls.length;
    fireEvent.change(screen.getByLabelText("Du"), { target: { value: "2026-10-20" } });
    fireEvent.change(screen.getByLabelText("Au (jour inclus)"), { target: { value: "2026-10-05" } });
    expect(await screen.findByRole("alert")).toHaveTextContent(/postérieure/);
    // seule la saisie valide « Du » a pu partir ; aucune requete avec une periode inversee
    for (const [, opts] of h.get.mock.calls.slice(appels)) {
      expect((opts as { params: Record<string, string> }).params.jusqua).toBeUndefined();
    }
  });
});

describe("role qui voit plusieurs agents", () => {
  beforeEach(() => { h.user = { id: "chef-1", role: "GESTIONNAIRE", nomComplet: "Chef Un", modulesAutorises: [] }; });

  it("montre la colonne « Agent » et un filtre, rempli avec les agents deja vus", async () => {
    h.get.mockResolvedValue(page([releve(1, { agent: { id: "agent-9", nom: "Agent Neuf" } }), releve(2, { agent: { id: "agent-3", nom: "Agent Trois" } })]));
    afficher();
    const tableau = await screen.findByRole("table");
    expect(within(tableau).getByRole("columnheader", { name: "Agent" })).toBeInTheDocument();
    expect(within(tableau).getByText("Agent Neuf")).toBeInTheDocument();
    const select = screen.getByLabelText("Agent");
    await waitFor(() => expect(within(select).getByRole("option", { name: "Agent Trois" })).toBeInTheDocument());
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Tous les agents", "Mes relevés", "Agent Neuf", "Agent Trois"]);
  });

  it("choisir un agent envoie son identifiant, et la liste des agents reste complete", async () => {
    h.get.mockResolvedValueOnce(page([releve(1, { agent: { id: "agent-9", nom: "Agent Neuf" } }), releve(2, { agent: { id: "agent-3", nom: "Agent Trois" } })]))
      .mockResolvedValue(page([releve(1, { agent: { id: "agent-9", nom: "Agent Neuf" } })]));
    afficher();
    await screen.findByRole("table");
    const select = screen.getByLabelText("Agent");
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(4));
    await userEvent.selectOptions(select, "agent-9");
    await waitFor(() => expect(h.get).toHaveBeenLastCalledWith("/v2/roulage/sessions", { params: { limite: 25, userId: "agent-9" } }));
    await screen.findByRole("table");
    expect(within(screen.getByLabelText("Agent")).getAllByRole("option")).toHaveLength(4);
  });

  it("vide : le message ne pretend pas qu'il s'agit de ce seul compte", async () => {
    h.get.mockResolvedValue(page([]));
    afficher();
    expect(await screen.findByRole("heading", { name: "Aucun relevé envoyé n'est visible avec ce compte" })).toBeInTheDocument();
  });
});

describe("accessibilite (axe-core)", () => {
  it("liste", async () => {
    h.get.mockResolvedValue(page([releve(1, { tauxRattachement: 0.5 }), releve(2)], "c2", 5));
    const { container } = afficher();
    await screen.findByRole("table");
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
  it("liste pour un role multi-agents", async () => {
    h.user = { id: "chef-1", role: "ADMIN", nomComplet: "Chef Un", modulesAutorises: [] };
    h.get.mockResolvedValue(page([releve(1)]));
    const { container } = afficher();
    await screen.findByRole("table");
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
  it("vide", async () => {
    h.get.mockResolvedValue(page([]));
    const { container } = afficher();
    await screen.findByRole("heading", { name: /Aucun relevé envoyé/ });
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
  it("erreur", async () => {
    h.get.mockRejectedValue(new Error("Network Error"));
    const { container } = afficher();
    await screen.findByRole("alert");
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
  it("acces refuse", async () => {
    h.get.mockRejectedValue(erreurHttp(403));
    const { container } = afficher();
    await screen.findByRole("alert");
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
  it("chargement", async () => {
    h.get.mockReturnValue(new Promise(() => undefined));
    const { container } = afficher();
    await screen.findByRole("status");
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

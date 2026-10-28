import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), role: "GESTIONNAIRE" }));
vi.mock("../lib/api", () => ({ api: { get: h.get, post: h.post, patch: vi.fn(), delete: vi.fn() } }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u", role: h.role, modulesAutorises: ["projets-voirie"] } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ProjetsVoirieListePage } from "./ProjetsVoirieListePage";
import { violationsAccessibilite } from "../test/accessibilite";

const P1 = { id: "p1", code: "VOIRIE-SYNTH-2026", nom: "Voirie synthetique", commune: "Commune test", prefecture: "Prefecture test", largeurEmpriseM: "15.00", largeurChausseeM: "7.00", statutParametres: "THEORIQUE", nbJeux: 3 };
const P2 = { id: "p2", code: "AUTRE-2026", nom: "Autre projet", commune: null, prefecture: null, largeurEmpriseM: "20.00", largeurChausseeM: "8.00", statutParametres: "VALIDE", nbJeux: 0 };

function rendre() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={["/projets-voirie"]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/projets-voirie" element={<ProjetsVoirieListePage />} />
          <Route path="/projets-voirie/:id" element={<p>Page du projet</p>} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function enLigne(v: boolean) { Object.defineProperty(window.navigator, "onLine", { configurable: true, value: v }); }

beforeEach(() => { h.get.mockReset(); h.post.mockReset(); h.role = "GESTIONNAIRE"; enLigne(true); });
afterEach(() => enLigne(true));

describe("liste des projets", () => {
  it("affiche chaque projet : lien, code, localisation, nombre de jeux, largeurs et leur statut (theoriques / validees)", async () => {
    h.get.mockResolvedValue({ data: { projets: [P1, P2], suivant: null } });
    rendre();
    const t = await screen.findByRole("table", { name: "Projets de voirie et réseaux" });
    const l1 = within(t).getByRole("link", { name: /Voirie synthetique/ });
    expect(l1).toHaveAttribute("href", "/projets-voirie/p1");
    const r1 = l1.closest("tr")!;
    expect(r1).toHaveTextContent("Commune test, Prefecture test");
    expect(r1).toHaveTextContent("Chaussée 7 m, emprise 15 m (théoriques)");
    expect(within(t).getByRole("link", { name: /Autre projet/ }).closest("tr")).toHaveTextContent("(validées)");
    expect(within(t).getByRole("link", { name: /Autre projet/ }).closest("tr")).toHaveTextContent("Non renseignée");
    expect(h.get).toHaveBeenCalledWith("/v2/projets-voirie", { params: { limite: 25 } });
  });

  it("recherche : le filtre q est envoye (apres une pause), pas a chaque frappe", async () => {
    h.get.mockResolvedValue({ data: { projets: [P1], suivant: null } });
    rendre();
    await screen.findByRole("table");
    await userEvent.type(screen.getByLabelText("Rechercher un projet"), "kissi");
    await waitFor(() => expect(h.get).toHaveBeenLastCalledWith("/v2/projets-voirie", { params: { q: "kissi", limite: 25 } }));
    expect(h.get.mock.calls.filter((c) => c[1].params.q && c[1].params.q.length < 5)).toHaveLength(0);
  });

  it("pagination par curseur : « Charger plus de projets »", async () => {
    h.get.mockResolvedValueOnce({ data: { projets: [P1], suivant: "curseur-2" } }).mockResolvedValueOnce({ data: { projets: [P2], suivant: null } });
    rendre();
    await userEvent.click(await screen.findByRole("button", { name: "Charger plus de projets" }));
    expect(await screen.findByRole("link", { name: /Autre projet/ })).toBeInTheDocument();
    expect(h.get).toHaveBeenLastCalledWith("/v2/projets-voirie", { params: { curseur: "curseur-2", limite: 25 } });
    expect(screen.queryByRole("button", { name: "Charger plus de projets" })).toBeNull();
  });
});

describe("etats", () => {
  it("chargement", () => {
    h.get.mockReturnValue(new Promise(() => {}));
    rendre();
    expect(screen.getByRole("status")).toHaveTextContent("Chargement des projets…");
  });
  it("vide : explique comment commencer (creer un projet, deposer KML ou GeoJSON, simuler, autoriser)", async () => {
    h.get.mockResolvedValue({ data: { projets: [], suivant: null } });
    rendre();
    expect(await screen.findByText("Aucun projet pour l'instant")).toBeInTheDocument();
    expect(screen.getByText(/créez un projet avec « Nouveau projet »/)).toBeInTheDocument();
    expect(screen.getByText(/KML ou GeoJSON/)).toBeInTheDocument();
    expect(screen.getByText(/simulé, puis reçu, puis autorisé/)).toBeInTheDocument();
  });
  it("vide pour un lecteur : il n'a pas le bouton, on lui dit a qui demander", async () => {
    h.role = "LECTEUR";
    h.get.mockResolvedValue({ data: { projets: [], suivant: null } });
    rendre();
    expect(await screen.findByText(/Demandez à un gestionnaire ou à un administrateur/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Nouveau projet/ })).toBeNull();
  });
  it("recherche sans resultat : message dedie, different du vide", async () => {
    h.get.mockResolvedValueOnce({ data: { projets: [P1], suivant: null } }).mockResolvedValue({ data: { projets: [], suivant: null } });
    rendre();
    await screen.findByRole("table");
    await userEvent.type(screen.getByLabelText("Rechercher un projet"), "zzz");
    expect(await screen.findByText("Aucun projet ne correspond à cette recherche")).toBeInTheDocument();
  });
  it("403 : pas de cle de module, dit en clair, jamais un vide", async () => {
    h.get.mockRejectedValue({ response: { status: 403, data: { error: "Accès à ce module non autorisé pour votre compte", code: "MODULE_NON_AUTORISE" } } });
    rendre();
    const a = await screen.findByRole("alert");
    expect(a).toHaveTextContent(/Accès refusé/);
    expect(a).toHaveTextContent(/clé de module « Projets de voirie »/);
    expect(screen.queryByText("Aucun projet pour l'instant")).toBeNull();
  });
  it("erreur reseau : dite comme telle avec reessai ; le reessai relance la requete", async () => {
    h.get.mockRejectedValueOnce(new Error("Network Error")).mockResolvedValue({ data: { projets: [P1], suivant: null } });
    rendre();
    const a = await screen.findByRole("alert");
    expect(a).toHaveTextContent(/réseau indisponible/);
    await userEvent.click(within(a).getByRole("button", { name: "Réessayer : Liste des projets" }));
    expect(await screen.findByRole("link", { name: /Voirie synthetique/ })).toBeInTheDocument();
  });
  it("erreur serveur 500", async () => {
    h.get.mockRejectedValue({ response: { status: 500, data: {} } });
    rendre();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Liste des projets : chargement impossible/);
  });
  it("reponse inattendue : une erreur, jamais une liste vide", async () => {
    h.get.mockResolvedValue({ data: { n_importe: "quoi" } });
    rendre();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Réponse inattendue du serveur/);
    expect(screen.queryByText("Aucun projet pour l'instant")).toBeNull();
  });
  it("hors ligne : bandeau « ce module a besoin du reseau », creation desactivee", async () => {
    enLigne(false);
    h.get.mockRejectedValue(new Error("Network Error"));
    rendre();
    const bandeau = await screen.findAllByRole("alert");
    expect(bandeau.some((b) => /Vous êtes hors ligne/.test(b.textContent ?? ""))).toBe(true);
    expect(screen.getByRole("button", { name: /Nouveau projet/ })).toBeDisabled();
  });
});

describe("creation d'un projet", () => {
  async function ouvrir() {
    h.get.mockResolvedValue({ data: { projets: [P1], suivant: null } });
    rendre();
    await userEvent.click(await screen.findByRole("button", { name: /Nouveau projet/ }));
    return screen.findByRole("dialog", { name: "Nouveau projet de voirie et réseaux" });
  }
  it("envoie code (en majuscules), nom, localisation et largeurs theoriques par defaut, puis ouvre le projet", async () => {
    h.post.mockResolvedValue({ data: { id: "p9", code: "KISSI-VOIRIE-2026", nom: "Kissidougou test", jeux: [] } });
    const d = await ouvrir();
    expect(within(d).getByLabelText("Chaussée (m)")).toHaveValue("7");
    expect(within(d).getByLabelText("Emprise (m)")).toHaveValue("15");
    expect(within(d).getByText(/théoriques/, { selector: "strong" })).toBeInTheDocument();
    await userEvent.type(within(d).getByLabelText("Code du projet"), "kissi-voirie-2026");
    await userEvent.type(within(d).getByLabelText("Nom du projet"), "Kissidougou test");
    await userEvent.type(within(d).getByLabelText("Commune (facultatif)"), "Commune test");
    await userEvent.click(within(d).getByRole("button", { name: "Créer le projet" }));
    expect(h.post).toHaveBeenCalledWith("/v2/projets-voirie", { code: "KISSI-VOIRIE-2026", nom: "Kissidougou test", commune: "Commune test", largeurEmpriseM: 15, largeurChausseeM: 7 });
    expect(await screen.findByText("Page du projet")).toBeInTheDocument();
  });
  it("champs invalides : messages par champ, rien n'est envoye", async () => {
    const d = await ouvrir();
    await userEvent.type(within(d).getByLabelText("Code du projet"), "a!");
    await userEvent.click(within(d).getByRole("button", { name: "Créer le projet" }));
    expect(within(d).getByText(/Le code compte 2 à 64 caractères/)).toBeInTheDocument();
    expect(within(d).getByText(/Saisissez le nom du projet/)).toBeInTheDocument();
    expect(h.post).not.toHaveBeenCalled();
  });
  it("emprise plus etroite que la chaussee : refus", async () => {
    const d = await ouvrir();
    await userEvent.type(within(d).getByLabelText("Code du projet"), "ABC-1");
    await userEvent.type(within(d).getByLabelText("Nom du projet"), "Projet");
    await userEvent.clear(within(d).getByLabelText("Emprise (m)"));
    await userEvent.type(within(d).getByLabelText("Emprise (m)"), "5");
    await userEvent.click(within(d).getByRole("button", { name: "Créer le projet" }));
    expect(within(d).getByText(/au moins égale à la chaussée/)).toBeInTheDocument();
    expect(h.post).not.toHaveBeenCalled();
  });
  it("refus du serveur (code deja pris) : dit dans le dialogue, qui reste ouvert", async () => {
    h.post.mockRejectedValue({ response: { status: 409, data: { error: "Ce code de projet existe déjà", code: "CODE_DEJA_UTILISE" } } });
    const d = await ouvrir();
    await userEvent.type(within(d).getByLabelText("Code du projet"), "ABC-1");
    await userEvent.type(within(d).getByLabelText("Nom du projet"), "Projet");
    await userEvent.click(within(d).getByRole("button", { name: "Créer le projet" }));
    expect(await within(d).findByText("Ce code de projet existe déjà")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  it("un lecteur n'a pas le bouton de creation", async () => {
    h.role = "LECTEUR";
    h.get.mockResolvedValue({ data: { projets: [P1], suivant: null } });
    rendre();
    await screen.findByRole("table");
    expect(screen.queryByRole("button", { name: /Nouveau projet/ })).toBeNull();
  });
});

describe("accessibilite (axe)", () => {
  it("aucune violation : liste, vide, erreur, dialogue de creation", async () => {
    h.get.mockResolvedValue({ data: { projets: [P1, P2], suivant: "c2" } });
    const a = rendre();
    await screen.findByRole("table");
    expect(await violationsAccessibilite(a.container)).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: /Nouveau projet/ }));
    await screen.findByRole("dialog");
    expect(await violationsAccessibilite(document.body)).toEqual([]);
    a.unmount();

    h.get.mockResolvedValue({ data: { projets: [], suivant: null } });
    const b = rendre();
    await screen.findByText("Aucun projet pour l'instant");
    expect(await violationsAccessibilite(b.container)).toEqual([]);
    b.unmount();

    h.get.mockRejectedValue({ response: { status: 403, data: {} } });
    const c = rendre();
    await screen.findByRole("alert");
    expect(await violationsAccessibilite(c.container)).toEqual([]);
  }, 60_000);
});

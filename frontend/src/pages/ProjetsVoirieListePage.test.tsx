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
    expect(h.get).toHaveBeenCalledWith("/v2/projets-voirie", expect.objectContaining({ params: { limite: 25 } }));
  });

  it("compteurs par statut du serveur : autorises pour tous, « a autoriser » pour les seuls gestionnaires", async () => {
    h.get.mockResolvedValue({ data: { projets: [{ ...P1, nbJeux: undefined, jeux: { AUTORISE: 2, CONTROLE: 1, REMPLACE: 3 } }], curseurSuivant: null } });
    const a = rendre();
    const ligne = (await screen.findByRole("link", { name: /Voirie synthetique/ })).closest("tr")!;
    expect(ligne).toHaveTextContent("2");
    expect(ligne).toHaveTextContent("et 1 à autoriser");
    a.unmount();
    h.role = "LECTEUR";
    rendre();
    const ligneLecteur = (await screen.findByRole("link", { name: /Voirie synthetique/ })).closest("tr")!;
    expect(ligneLecteur).not.toHaveTextContent("à autoriser");
  });

  it("recherche : le filtre q est envoye (apres une pause), pas a chaque frappe", async () => {
    h.get.mockResolvedValue({ data: { projets: [P1], suivant: null } });
    rendre();
    await screen.findByRole("table");
    await userEvent.type(screen.getByLabelText("Rechercher un projet"), "kissi");
    await waitFor(() => expect(h.get).toHaveBeenLastCalledWith("/v2/projets-voirie", expect.objectContaining({ params: { q: "kissi", limite: 25 } })));
    expect(h.get.mock.calls.filter((c) => c[1].params.q && c[1].params.q.length < 5)).toHaveLength(0);
  });

  it("pagination par curseur : « Charger plus de projets »", async () => {
    h.get.mockResolvedValueOnce({ data: { projets: [P1], suivant: "curseur-2" } }).mockResolvedValueOnce({ data: { projets: [P2], suivant: null } });
    rendre();
    await userEvent.click(await screen.findByRole("button", { name: "Charger plus de projets" }));
    expect(await screen.findByRole("link", { name: /Autre projet/ })).toBeInTheDocument();
    expect(h.get).toHaveBeenLastCalledWith("/v2/projets-voirie", expect.objectContaining({ params: { curseur: "curseur-2", limite: 25 } }));
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

const TERR = (id: string, chemin: string, over: Record<string, unknown> = {}) => ({
  id, code: `SYN-${id.toUpperCase()}`, nom: `Territoire ${id}`, niveau: "COMMUNE", parentId: null, chemin, profondeur: chemin.split("/").filter(Boolean).length - 1,
  regionId: null, regionEffectiveId: 1, crsMetriqueEpsg: null, bbox: null, source: null, actif: true, version: 1, ...over,
});
const TERRITOIRES = [
  TERR("reg", "/reg/", { niveau: "REGION", nom: "Region synthetique" }),
  TERR("com", "/reg/com/", { parentId: "reg", nom: "Commune synthetique" }),
  TERR("old", "/reg/old/", { parentId: "reg", nom: "Commune fermee", actif: false }),
];
const CATEGORIES = [
  { id: "k1", domaine: "CATEGORIE_PROJET", code: "VOIRIE_URBAINE", libelle: "Voirie urbaine", ordre: 10, actif: true, parametres: { largeurEmpriseM: 15, largeurChausseeM: 7 }, version: 1, systeme: true },
  { id: "k2", domaine: "CATEGORIE_PROJET", code: "ROUTE_LARGE", libelle: "Route large", ordre: 20, actif: true, parametres: { largeurEmpriseM: 30, largeurChausseeM: 12.5 }, version: 1, systeme: false },
  { id: "k4", domaine: "CATEGORIE_PROJET", code: "PRECISE", libelle: "Categorie precise", ordre: 25, actif: true, parametres: { largeurEmpriseM: 14.375, largeurChausseeM: 7.125 }, version: 1, systeme: false },
  { id: "k3", domaine: "CATEGORIE_PROJET", code: "ANCIENNE", libelle: "Categorie ancienne", ordre: 30, actif: false, parametres: { largeurEmpriseM: 10, largeurChausseeM: 5 }, version: 1, systeme: false },
];
function serveurT1(projets: unknown[] = [P1]) {
  h.get.mockImplementation(async (url: string) => {
    if (url === "/v2/projets-voirie/territoires") return { data: { territoires: TERRITOIRES, curseurSuivant: null } };
    if (url === "/v2/projets-voirie/referentiels/CATEGORIE_PROJET") return { data: { domaine: "CATEGORIE_PROJET", valeurs: CATEGORIES } };
    return { data: { projets, suivant: null } };
  });
}

describe("territoire (lot T1)", () => {
  it("colonne Territoire : nom et niveau du territoire, puis commune et prefecture derivees", async () => {
    h.get.mockResolvedValue({ data: { projets: [{ ...P1, territoireId: "com", territoire: { id: "com", code: "SYN-COM", nom: "Commune synthetique", niveau: "COMMUNE" } }], suivant: null } });
    rendre();
    const l = (await screen.findByRole("link", { name: /Voirie synthetique/ })).closest("tr")!;
    expect(l).toHaveTextContent("Commune synthetique (Commune)");
    expect(l).toHaveTextContent("Commune test, Prefecture test");
  });
  it("filtre par territoire (le territoire et ses subdivisions) : ?territoireId= ; chemin des ancetres ; retrait du filtre", async () => {
    serveurT1();
    const u = userEvent.setup();
    rendre();
    await screen.findByRole("table");
    expect(h.get.mock.calls.map((c) => c[0])).not.toContain("/v2/projets-voirie/territoires");
    await u.click(screen.getByRole("button", { name: "Filtrer par territoire" }));
    const choix = await screen.findByRole("radio", { name: /Commune synthetique/ });
    expect(choix.closest("label")).toHaveTextContent("Region synthetique");
    expect(screen.getByRole("radio", { name: /Commune fermee/ }).closest("label")).toHaveTextContent("(inactif)");
    await u.click(choix);
    await waitFor(() => expect(h.get).toHaveBeenLastCalledWith("/v2/projets-voirie", expect.objectContaining({ params: { territoireId: "com", limite: 25 } })));
    expect(screen.getByTestId("filtre-territoire-actif")).toHaveTextContent("Territoire : Commune synthetique (Commune), avec ses subdivisions.");
    await u.click(screen.getByRole("button", { name: /Retirer le filtre/ }));
    await waitFor(() => expect(h.get).toHaveBeenLastCalledWith("/v2/projets-voirie", expect.objectContaining({ params: { limite: 25 } })));
  });
  it("le selecteur de territoire en erreur (hors ligne) le dit, avec un reessai", async () => {
    h.get.mockImplementation(async (url: string) => {
      if (url === "/v2/projets-voirie/territoires") throw new Error("Network Error");
      return { data: { projets: [P1], suivant: null } };
    });
    rendre();
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Filtrer par territoire" }));
    expect(await screen.findByText(/Les territoires n'ont pas pu être chargés/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Réessayer" })).toBeInTheDocument();
  });
});

describe("creation d'un projet", () => {
  async function ouvrir() {
    serveurT1();
    rendre();
    await userEvent.click(await screen.findByRole("button", { name: /Nouveau projet/ }));
    return screen.findByRole("dialog", { name: "Nouveau projet de voirie et réseaux" });
  }
  async function remplir(d: HTMLElement, code = "voirie-synth-01") {
    await userEvent.type(within(d).getByLabelText("Code du projet"), code);
    await userEvent.type(within(d).getByLabelText("Nom du projet"), "Projet synthetique");
  }
  it("envoie code (en majuscules), nom, territoire (obligatoire, actifs seulement) ; sans largeurs saisies, AUCUNE n'est envoyee (le serveur applique son defaut, revue m2)", async () => {
    h.post.mockResolvedValue({ data: { projet: { id: "p9", code: "VOIRIE-SYNTH-01", nom: "Projet synthetique", jeux: [] } } });
    const d = await ouvrir();
    expect(within(d).getByLabelText("Chaussée (m)")).toHaveValue("");
    expect(within(d).getByLabelText("Emprise (m)")).toHaveValue("");
    expect(within(d).getByText(/le serveur applique ses largeurs par défaut/)).toBeInTheDocument();
    expect(within(d).getByText(/théoriques/, { selector: "strong" })).toBeInTheDocument();
    await remplir(d);
    expect(await within(d).findByRole("radio", { name: /Commune synthetique/ })).toBeInTheDocument();
    expect(within(d).queryByRole("radio", { name: /Commune fermee/ })).toBeNull();
    await userEvent.click(within(d).getByRole("radio", { name: /Commune synthetique/ }));
    expect(within(d).getByTestId("territoire-choisi")).toHaveTextContent("Choisi : Commune synthetique (Commune, SYN-COM)Dans : Region synthetique");
    await userEvent.click(within(d).getByRole("button", { name: "Créer le projet" }));
    expect(h.post).toHaveBeenCalledWith("/v2/projets-voirie", { code: "VOIRIE-SYNTH-01", nom: "Projet synthetique", territoireId: "com" });
    expect(await screen.findByText("Page du projet")).toBeInTheDocument();
  });
  it("categorie : ses largeurs sont proposees ; gardees telles quelles, elles ne sont pas envoyees (le serveur les applique) ; une categorie desactivee n'est pas proposee", async () => {
    h.post.mockResolvedValue({ data: { projet: { id: "p9", code: "A-1", nom: "A", jeux: [] } } });
    const d = await ouvrir();
    await remplir(d);
    await userEvent.click(await within(d).findByRole("radio", { name: /Commune synthetique/ }));
    const cat = within(d).getByLabelText("Catégorie de projet (facultatif)");
    await within(d).findByRole("option", { name: "Route large" });
    expect(within(d).queryByRole("option", { name: /Categorie ancienne/ })).toBeNull();
    await userEvent.selectOptions(cat, "ROUTE_LARGE");
    expect(within(d).getByLabelText("Emprise (m)")).toHaveValue("30");
    expect(within(d).getByLabelText("Chaussée (m)")).toHaveValue("12,5");
    await userEvent.click(within(d).getByRole("button", { name: "Créer le projet" }));
    expect(h.post).toHaveBeenLastCalledWith("/v2/projets-voirie", { code: "VOIRIE-SYNTH-01", nom: "Projet synthetique", territoireId: "com", categorieCode: "ROUTE_LARGE" });
  });
  it("revue m2 : largeurs de categorie lues sans arrondi (14,375 et 7,125) et, inchangees, laissees au serveur", async () => {
    h.post.mockResolvedValue({ data: { projet: { id: "p9", code: "A-1", nom: "A", jeux: [] } } });
    const d = await ouvrir();
    await remplir(d);
    await userEvent.click(await within(d).findByRole("radio", { name: /Commune synthetique/ }));
    await within(d).findByRole("option", { name: "Categorie precise" });
    await userEvent.selectOptions(within(d).getByLabelText("Catégorie de projet (facultatif)"), "PRECISE");
    expect(within(d).getByLabelText("Emprise (m)")).toHaveValue("14,375");
    expect(within(d).getByLabelText("Chaussée (m)")).toHaveValue("7,125");
    await userEvent.click(within(d).getByRole("button", { name: "Créer le projet" }));
    expect(h.post).toHaveBeenLastCalledWith("/v2/projets-voirie", { code: "VOIRIE-SYNTH-01", nom: "Projet synthetique", territoireId: "com", categorieCode: "PRECISE" });
  });
  it("revue m2 : une seule largeur saisie est refusee (les deux, ou aucune)", async () => {
    const d = await ouvrir();
    await remplir(d);
    await userEvent.click(await within(d).findByRole("radio", { name: /Commune synthetique/ }));
    await userEvent.type(within(d).getByLabelText("Emprise (m)"), "20");
    await userEvent.click(within(d).getByRole("button", { name: "Créer le projet" }));
    expect(within(d).getByText(/Saisissez les deux largeurs, ou aucune/)).toBeInTheDocument();
    expect(h.post).not.toHaveBeenCalled();
  });
  it("categorie avec largeurs changees : la categorie ET les largeurs saisies partent", async () => {
    h.post.mockResolvedValue({ data: { projet: { id: "p9", code: "A-1", nom: "A", jeux: [] } } });
    const d = await ouvrir();
    await remplir(d);
    await userEvent.click(await within(d).findByRole("radio", { name: /Commune synthetique/ }));
    await within(d).findByRole("option", { name: "Route large" });
    await userEvent.selectOptions(within(d).getByLabelText("Catégorie de projet (facultatif)"), "ROUTE_LARGE");
    await userEvent.clear(within(d).getByLabelText("Emprise (m)"));
    await userEvent.type(within(d).getByLabelText("Emprise (m)"), "28");
    await userEvent.click(within(d).getByRole("button", { name: "Créer le projet" }));
    expect(h.post).toHaveBeenLastCalledWith("/v2/projets-voirie", { code: "VOIRIE-SYNTH-01", nom: "Projet synthetique", territoireId: "com", categorieCode: "ROUTE_LARGE", largeurEmpriseM: 28, largeurChausseeM: 12.5 });
  });
  it("sans territoire : refus local explique, rien n'est envoye", async () => {
    const d = await ouvrir();
    await remplir(d);
    await userEvent.click(within(d).getByRole("button", { name: "Créer le projet" }));
    expect(within(d).getByText(/Choisissez le territoire du projet : il est obligatoire/)).toBeInTheDocument();
    expect(h.post).not.toHaveBeenCalled();
  });
  it("400 TERRITOIRE_REQUIS et 404 TERRITOIRE_INTROUVABLE du serveur : dits en clair, le dialogue reste ouvert", async () => {
    h.post.mockRejectedValueOnce({ response: { status: 400, data: { error: "brut", code: "TERRITOIRE_REQUIS" } } })
      .mockRejectedValueOnce({ response: { status: 404, data: { error: "brut", code: "TERRITOIRE_INTROUVABLE" } } });
    const d = await ouvrir();
    await remplir(d);
    await userEvent.click(await within(d).findByRole("radio", { name: /Commune synthetique/ }));
    await userEvent.click(within(d).getByRole("button", { name: "Créer le projet" }));
    expect((await within(d).findAllByText(/Le territoire du projet est obligatoire/)).length).toBeGreaterThan(0);
    await userEvent.click(within(d).getByRole("button", { name: "Créer le projet" }));
    expect((await within(d).findAllByText(/pas dans votre périmètre/)).length).toBeGreaterThan(0);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
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
    await remplir(d, "ABC-1");
    await userEvent.type(within(d).getByLabelText("Chaussée (m)"), "7");
    await userEvent.type(within(d).getByLabelText("Emprise (m)"), "5");
    await userEvent.click(within(d).getByRole("button", { name: "Créer le projet" }));
    expect(within(d).getByText(/au moins égale à la chaussée/)).toBeInTheDocument();
    expect(h.post).not.toHaveBeenCalled();
  });
  it("refus du serveur (409 code deja pris) : dit dans le dialogue, qui reste ouvert", async () => {
    h.post.mockRejectedValue({ response: { status: 409, data: { error: "Ce code de projet existe déjà", code: "CODE_DEJA_UTILISE" } } });
    const d = await ouvrir();
    await remplir(d, "ABC-1");
    await userEvent.click(await within(d).findByRole("radio", { name: /Commune synthetique/ }));
    await userEvent.click(within(d).getByRole("button", { name: "Créer le projet" }));
    expect(await within(d).findByText(/Ce code est déjà utilisé/)).toBeInTheDocument();
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
    serveurT1([P1, P2]);
    await userEvent.click(screen.getByRole("button", { name: "Filtrer par territoire" }));
    await screen.findByRole("radio", { name: /Commune synthetique/ });
    expect(await violationsAccessibilite(a.container)).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: /Nouveau projet/ }));
    await within(await screen.findByRole("dialog")).findByRole("radio", { name: /Commune synthetique/ });
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

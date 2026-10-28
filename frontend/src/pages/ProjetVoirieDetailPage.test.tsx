import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("react-leaflet", async () => (await import("../components/projets-voirie/carteDouble.testutil")).moduleReactLeaflet());

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), role: "GESTIONNAIRE" }));
vi.mock("../lib/api", () => ({ api: { get: h.get, post: h.post, patch: h.patch, delete: h.delete } }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u", role: h.role, modulesAutorises: ["projets-voirie"] } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/download", () => ({ downloadViaApi: vi.fn().mockResolvedValue(undefined) }));

import { ProjetVoirieDetailPage } from "./ProjetVoirieDetailPage";
import { carteEtat, mapDouble, reinitialiserCarte } from "../components/projets-voirie/carteDouble.testutil";
import { analyse, couche, JEU_AXES, JEU_GAZ_CONTROLE, JEU_TEL, ligne, projetFiche } from "../components/projets-voirie/synthetique.testutil";
import { downloadViaApi } from "../lib/download";
import { violationsAccessibilite } from "../test/accessibilite";

/**
 * Page d'un projet : carte + panneau. Les reponses de l'API sont SYNTHETIQUES. On verifie ce qui part sur le fil (parametres de la carte,
 * de l'analyse, de l'export) et ce que la page montre dans chaque etat.
 */

const BASE = "/v2/projets-voirie/p1";

function installer(over: { fiche?: unknown; analyse?: unknown; carte?: unknown } = {}) {
  h.get.mockImplementation(async (url: string, opts?: { params?: Record<string, unknown> }) => {
    const r = (v: unknown) => { if (v instanceof Error || (v && typeof v === "object" && "response" in (v as object))) throw v; return { data: v }; };
    if (url === BASE) return r(over.fiche ?? projetFiche());
    if (url === `${BASE}/analyse`) return r(over.analyse ?? brutAnalyse());
    if (url === `${BASE}/carte`) {
      if (over.carte !== undefined) return r(over.carte);
      const ids = String(opts?.params?.jeux ?? "").split(",").filter(Boolean);
      return r(ids.map((id) => ({ ...couche({ jeuId: id }), nonAutorise: id === "jeu-gaz" })));
    }
    if (url === "/v2/projets-voirie/concessionnaires") return r([{ id: "c1", nom: "Operateur synthetique A", typeReseau: "TELECOM" }]);
    return r({});
  });
}

/** L'analyse « brute » du serveur : les lignes portent `statut`, la racine porte `regle` (contrat v2), pas `verification`. */
function brutAnalyse() {
  const a = JSON.parse(JSON.stringify(analyse()));
  a.regle = { version: "1.0" };
  for (const l of [...a.conflits.parAxe, ...a.conflits.parConcessionnaire]) { l.statut = "A_VERIFIER"; delete l.verification; }
  return a;
}

function rendre(entree = "/projets-voirie/p1") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[entree]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/projets-voirie/:id" element={<ProjetVoirieDetailPage />} />
          <Route path="/projets-voirie" element={<p>Liste des projets</p>} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function enLigne(v: boolean) { Object.defineProperty(window.navigator, "onLine", { configurable: true, value: v }); }
const appelsCarte = () => h.get.mock.calls.filter((c) => c[0] === `${BASE}/carte`).map((c) => c[1].params as Record<string, string>);
const appelsAnalyse = () => h.get.mock.calls.filter((c) => c[0] === `${BASE}/analyse`).map((c) => c[1].params as Record<string, string>);

beforeEach(() => { for (const f of [h.get, h.post, h.patch, h.delete]) f.mockReset(); h.role = "GESTIONNAIRE"; reinitialiserCarte(); enLigne(true); vi.mocked(downloadViaApi).mockClear(); });
afterEach(() => enLigne(true));

describe("page projet : carte, panneau, onglets", () => {
  it("affiche le projet, la carte (fond plan par defaut), l'analyse et l'onglet Analyse selectionne", async () => {
    installer();
    rendre();
    expect(await screen.findByRole("heading", { level: 1, name: "Voirie synthetique" })).toBeInTheDocument();
    expect(await screen.findByTestId("carte")).toBeInTheDocument();
    expect(screen.getByTestId("tuiles").dataset.url).toContain("openstreetmap.org");
    expect(screen.getByRole("tab", { name: "Analyse" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("Réseaux par type")).toBeInTheDocument();
  });

  it("chaque ligne d'analyse est « a verifier » avec la version de la regle prise a la racine de la reponse", async () => {
    installer();
    rendre();
    const t = await screen.findByRole("table", { name: /Longueurs de réseau dans la chaussée/ });
    expect(within(t).getAllByText("À vérifier (règle v1.0)").length).toBe(3);
  });

  it("onglets WAI-ARIA : fleches, Origine, Fin ; un seul onglet dans l'ordre de tabulation ; le panneau suit", async () => {
    installer();
    rendre();
    const analyseTab = await screen.findByRole("tab", { name: "Analyse" });
    const couchesTab = screen.getByRole("tab", { name: "Couches" });
    expect(analyseTab).toHaveAttribute("tabindex", "0");
    expect(couchesTab).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tablist", { name: "Contenu du panneau" })).toBeInTheDocument();
    analyseTab.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(couchesTab).toHaveAttribute("aria-selected", "true");
    expect(couchesTab).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "pv-onglet-couches");
    expect(analyseTab).toHaveAttribute("tabindex", "-1");
    await userEvent.keyboard("{ArrowRight}");
    expect(analyseTab).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{End}");
    expect(couchesTab).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(analyseTab).toHaveFocus();
    expect(analyseTab).toHaveAttribute("aria-controls", "pv-panneau-analyse");
  });

  it("fond satellite : les tuiles changent ; un fieldset nomme le choix", async () => {
    installer();
    rendre();
    await screen.findByTestId("carte");
    expect(screen.getByRole("group", { name: "Fond de carte" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: /Satellite \(Esri\)/ }));
    expect(screen.getByTestId("tuiles").dataset.url).toContain("World_Imagery");
  });

  it("« Centrer sur le projet » recadre la carte sur l'emprise", async () => {
    installer();
    rendre();
    await screen.findByTestId("carte");
    const avant = mapDouble.fitBounds.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: /Centrer sur le projet/ }));
    expect(mapDouble.fitBounds.mock.calls.length).toBe(avant + 1);
  });

  it("chargement de la carte par emprise et zoom : parametres jeux, bbox, zoom ; seuls les jeux AUTORISES sont demandes", async () => {
    installer();
    rendre();
    await waitFor(() => expect(appelsCarte().length).toBeGreaterThan(0));
    const p = appelsCarte()[0];
    expect(p.jeux.split(",").sort()).toEqual(["jeu-axes", "jeu-eau", "jeu-tel"]);
    expect(p.jeux).not.toContain("jeu-gaz");
    expect(p.zoom).toBe(15);
    const [o, s, e, n] = p.bbox.split(",").map(Number);
    expect(o).toBeLessThan(-10.103);
    expect(e).toBeGreaterThan(-10.097);
    expect(s).toBeLessThan(9.177);
    expect(n).toBeGreaterThan(9.183);
    expect(p.inclureNonAutorises).toBeUndefined();
  });

  it("un deplacement qui reste dans l'emprise deja chargee ne relance pas de requete ; un changement de zoom, si", async () => {
    installer();
    rendre();
    await waitFor(() => expect(appelsCarte().length).toBe(1));
    carteEtat.bounds = { w: -10.1025, s: 9.1775, e: -10.0975, n: 9.1825 };
    act(() => { carteEtat.handlers.moveend?.(); });
    await new Promise((r) => setTimeout(r, 600));
    expect(appelsCarte().length).toBe(1);
    carteEtat.zoom = 17;
    act(() => { carteEtat.handlers.zoomend?.(); });
    await waitFor(() => expect(appelsCarte().length).toBe(2));
    expect(appelsCarte()[1].zoom).toBe(17);
  });

  it("deplacement hors de l'emprise chargee : nouvelle requete", async () => {
    installer();
    rendre();
    await waitFor(() => expect(appelsCarte().length).toBe(1));
    carteEtat.bounds = { w: -10.2, s: 9.3, e: -10.19, n: 9.31 };
    act(() => { carteEtat.handlers.moveend?.(); });
    await waitFor(() => expect(appelsCarte().length).toBe(2));
  });

  it("serveur qui plafonne : bandeau « tronque » dit", async () => {
    installer({ carte: [{ ...couche({ jeuId: "jeu-tel" }), tronque: true }] });
    rendre();
    expect(await screen.findByTestId("bandeau-tronque")).toHaveTextContent(/Affichage tronqué : le serveur plafonne le nombre d'objets par réponse \(20 000\)/);
  });
});

describe("quarantaine : non affichee par defaut, ni sur la carte ni dans l'analyse", () => {
  it("bandeau « fichier a autoriser » avec le message ; l'analyse est demandee SANS inclureNonAutorises", async () => {
    installer();
    rendre();
    expect(await screen.findByTestId("bandeau-a-autoriser")).toHaveTextContent("1 fichier(s) à autoriser. Un fichier reçu n'est pas un fichier importé");
    await waitFor(() => expect(appelsAnalyse().length).toBeGreaterThan(0));
    expect(appelsAnalyse()[0].inclureNonAutorises).toBeUndefined();
  });

  it("l'interrupteur envoie inclureNonAutorises=true a la carte ET a l'analyse, et la carte marque le jeu « non autorise »", async () => {
    installer();
    rendre();
    await screen.findByTestId("bandeau-a-autoriser");
    await userEvent.click(screen.getByRole("tab", { name: "Couches" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /Afficher aussi les données non autorisées/ }));
    await waitFor(() => expect(appelsCarte().some((p) => p.inclureNonAutorises === "true")).toBe(true));
    await waitFor(() => expect(appelsAnalyse().some((p) => p.inclureNonAutorises === "true")).toBe(true));
    expect(appelsCarte().find((p) => p.inclureNonAutorises === "true")!.jeux).toContain("jeu-gaz");
    await waitFor(() => expect(screen.getAllByTestId("objet-carte").some((o) => /^Non autorisé · /.test(o.dataset.infobulle ?? ""))).toBe(true));
    expect(screen.getByText(/non autorisé, trait atténué/)).toBeInTheDocument();
  });

  it("autoriser un jeu : POST /autoriser avec la justification, puis rechargement du projet", async () => {
    installer();
    h.post.mockResolvedValue({ data: { jeu: { ...JEU_GAZ_CONTROLE, statut: "AUTORISE" } } });
    rendre();
    await screen.findByTestId("bandeau-a-autoriser");
    await userEvent.click(screen.getByRole("tab", { name: "Couches" }));
    await userEvent.click(screen.getByRole("button", { name: /Autoriser le jeu Hydrocarbures/ }));
    const d = await screen.findByRole("dialog");
    await userEvent.type(within(d).getByLabelText(/Justification/), "Conforme au plan reçu");
    const avant = h.get.mock.calls.filter((c) => c[0] === BASE).length;
    await userEvent.click(within(d).getByRole("button", { name: "Autoriser le jeu" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${BASE}/jeux/jeu-gaz/autoriser`, { justification: "Conforme au plan reçu" }));
    await waitFor(() => expect(h.get.mock.calls.filter((c) => c[0] === BASE).length).toBeGreaterThan(avant));
  });

  it("retirer un jeu : DELETE apres confirmation", async () => {
    installer();
    h.delete.mockResolvedValue({ data: {} });
    rendre();
    await userEvent.click(await screen.findByRole("tab", { name: "Couches" }));
    await userEvent.click(screen.getByRole("button", { name: /Retirer le jeu Operateur synthetique A/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Retirer le jeu" }));
    await waitFor(() => expect(h.delete).toHaveBeenCalledWith(`${BASE}/jeux/jeu-tel`));
  });

  it("decocher un jeu le retire de la requete de carte", async () => {
    installer();
    rendre();
    await waitFor(() => expect(appelsCarte().length).toBe(1));
    await userEvent.click(screen.getByRole("tab", { name: "Couches" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /Operateur synthetique A/ }));
    await waitFor(() => expect(appelsCarte().length).toBe(2));
    expect(appelsCarte()[1].jeux).not.toContain("jeu-tel");
  });
});

describe("fiche au clic sur un objet", () => {
  it("un clic sur la carte ouvre la fiche avec les attributs d'origine, rendus comme du texte", async () => {
    installer({ carte: [couche({ features: [ligne("Fibre FO-01", 0, 0, 5, 5, { description: "<img src=x onerror=alert(1)>", Circuit: "C-1" })] })] });
    rendre();
    await userEvent.click(await screen.findByTestId("objet-carte"));
    const fiche = await screen.findByTestId("fiche-objet");
    expect(within(fiche).getByRole("heading", { name: "Fibre FO-01" })).toBeInTheDocument();
    expect(within(fiche).getByText("C-1")).toBeInTheDocument();
    expect(within(fiche).getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(fiche.querySelector("img")).toBeNull();
    await waitFor(() => expect(within(fiche).getByRole("heading", { name: "Fibre FO-01" })).toHaveFocus());
    await userEvent.click(within(fiche).getByRole("button", { name: "Fermer la fiche de l'objet" }));
    expect(screen.queryByTestId("fiche-objet")).toBeNull();
  });
  it("voie clavier : la liste des objets de l'onglet Couches ouvre la meme fiche", async () => {
    installer({ carte: [couche({ features: [ligne("Fibre FO-01", 0, 0, 5, 5)] })] });
    rendre();
    await screen.findByTestId("objet-carte");
    await userEvent.click(screen.getByRole("tab", { name: "Couches" }));
    await userEvent.click(await within(screen.getByRole("tabpanel")).findByRole("button", { name: /Fibre FO-01/ }));
    expect(await screen.findByTestId("fiche-objet")).toBeInTheDocument();
  });
});

describe("analyse : apercu des largeurs, export", () => {
  it("previsualiser relance l'analyse avec les largeurs en parametres, sans rien enregistrer", async () => {
    installer();
    rendre();
    const form = await screen.findByRole("form", { name: "Largeurs d'emprise et de chaussée" });
    await userEvent.clear(within(form).getByLabelText("Emprise (m)"));
    await userEvent.type(within(form).getByLabelText("Emprise (m)"), "20");
    await userEvent.click(within(form).getByRole("button", { name: /Prévisualiser/ }));
    await waitFor(() => expect(appelsAnalyse().some((p) => Number(p.largeurEmpriseM) === 20 && Number(p.largeurChausseeM) === 7)).toBe(true));
    expect(h.patch).not.toHaveBeenCalled();
    expect(await screen.findAllByText(/aperçu non enregistré/i)).not.toHaveLength(0);
  });
  it("enregistrer envoie un PATCH puis recharge", async () => {
    installer();
    h.patch.mockResolvedValue({ data: projetFiche({ largeurChausseeM: 8 }) });
    rendre();
    const form = await screen.findByRole("form", { name: "Largeurs d'emprise et de chaussée" });
    await userEvent.clear(within(form).getByLabelText("Chaussée (m)"));
    await userEvent.type(within(form).getByLabelText("Chaussée (m)"), "8");
    await userEvent.click(within(form).getByRole("button", { name: /Enregistrer/ }));
    await waitFor(() => expect(h.patch).toHaveBeenCalledWith(BASE, { largeurEmpriseM: 15, largeurChausseeM: 8 }));
  });
  it("l'export CSV (agregats) passe par l'API authentifiee, avec les memes largeurs que l'apercu", async () => {
    installer();
    rendre();
    const form = await screen.findByRole("form", { name: "Largeurs d'emprise et de chaussée" });
    await userEvent.clear(within(form).getByLabelText("Emprise (m)"));
    await userEvent.type(within(form).getByLabelText("Emprise (m)"), "20");
    await userEvent.click(within(form).getByRole("button", { name: /Prévisualiser/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Exporter en CSV" }));
    await waitFor(() => expect(downloadViaApi).toHaveBeenCalledWith(`${BASE}/analyse/export.csv?largeurEmpriseM=20&largeurChausseeM=7`, "VOIRIE-SYNTH-2026-conflits.csv"));
  });
  it("un lecteur voit tout mais ne peut ni deposer, ni enregistrer, ni autoriser, ni exporter (export reserve a ADMIN et GESTIONNAIRE)", async () => {
    h.role = "LECTEUR";
    installer();
    rendre();
    await screen.findByRole("heading", { level: 1 });
    await screen.findByText("Réseaux par type");
    expect(screen.queryByRole("button", { name: /Ajouter des données/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Enregistrer/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Exporter en CSV" })).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "Couches" }));
    expect(screen.queryByRole("button", { name: /Autoriser|Rejeter|Retirer/ })).toBeNull();
  });
});

describe("depot depuis la page", () => {
  it("« Ajouter des donnees » ouvre le dialogue ; « Voir le jeu existant » (409) ferme, ouvre Couches et met le jeu en avant", async () => {
    installer();
    h.post.mockRejectedValue({ response: { status: 409, data: { code: "JEU_DEJA_CHARGE", jeuId: "jeu-tel" } } });
    rendre();
    await userEvent.click(await screen.findByRole("button", { name: /Ajouter des données/ }));
    const d = await screen.findByRole("dialog", { name: "Ajouter des données au projet" });
    await userEvent.upload(d.querySelector("input[type=file]")!, new File(["<kml/>"], "reseau.kml"));
    await screen.findByRole("option", { name: /Operateur synthetique A/ });
    await userEvent.selectOptions(within(d).getByLabelText("Concessionnaire propriétaire du réseau"), "c1");
    await userEvent.click(within(d).getByRole("button", { name: "Simuler le dépôt" }));
    await userEvent.click(await within(d).findByRole("button", { name: "Voir le jeu existant" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("tab", { name: "Couches" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(document.getElementById("pv-jeu-jeu-tel")).toHaveFocus());
  });
});

describe("etats complets", () => {
  it("chargement", () => {
    h.get.mockReturnValue(new Promise(() => {}));
    rendre();
    expect(screen.getByRole("status")).toHaveTextContent("Chargement du projet…");
  });
  it("projet sans donnee : explique comment commencer, carte vide annoncee, pas de plantage", async () => {
    installer({ fiche: projetFiche({ jeux: [], bbox: null }), analyse: { ...brutAnalyse(), axes: { nb: 0, longueurM: 0 }, reseaux: { parType: [], parConcessionnaire: [] }, conflits: { total: {}, parAxe: [], parConcessionnaire: [], croisements: null, zones: {} }, limites: ["Aucun axe ni réseau."] } });
    rendre();
    expect(await screen.findByText("Ce projet n'a pas encore de données")).toBeInTheDocument();
    expect(screen.getByText(/Pour commencer : 1\. déposez le plan d'axes/)).toBeInTheDocument();
    expect(screen.getByTestId("carte-vide")).toHaveTextContent(/pas encore de données autorisées/);
    expect(screen.getByRole("button", { name: /Centrer sur le projet/ })).toBeDisabled();
    expect(await screen.findByText("Aucun axe ni réseau.")).toBeInTheDocument();
  });
  it("403 : pas de cle de module", async () => {
    installer({ fiche: { response: { status: 403, data: { error: "Accès à ce module non autorisé", code: "MODULE_NON_AUTORISE" } } } });
    rendre();
    const a = await screen.findByRole("alert");
    expect(a).toHaveTextContent(/Accès refusé/);
    expect(a).toHaveTextContent(/clé de module « Projets de voirie »/);
    expect(screen.queryByTestId("carte")).toBeNull();
  });
  it("404 : projet introuvable (aussi hors perimetre regional), lien de retour vers la liste", async () => {
    installer({ fiche: { response: { status: 404, data: { error: "Projet introuvable", code: "PROJET_INTROUVABLE" } } } });
    rendre();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Projet : introuvable/);
    await userEvent.click(screen.getByRole("link", { name: /Projets de voirie/ }));
    expect(await screen.findByText("Liste des projets")).toBeInTheDocument();
  });
  it("erreur reseau : dite, avec reessai", async () => {
    installer({ fiche: new Error("Network Error") });
    rendre();
    const a = await screen.findByRole("alert");
    expect(a).toHaveTextContent(/réseau indisponible/);
    expect(within(a).getByRole("button", { name: "Réessayer : Projet" })).toBeInTheDocument();
  });
  it("erreur de la carte seule : la page reste, la carte dit son echec avec reessai", async () => {
    installer({ carte: { response: { status: 500, data: {} } } });
    rendre();
    expect(await screen.findByRole("heading", { level: 1, name: "Voirie synthetique" })).toBeInTheDocument();
    const a = await screen.findByRole("alert");
    expect(a).toHaveTextContent(/Carte : chargement impossible/);
    expect(screen.getByRole("button", { name: "Réessayer : Carte" })).toBeInTheDocument();
  });
  it("erreur de l'analyse seule : dite dans le panneau, le reste fonctionne", async () => {
    installer({ analyse: { response: { status: 500, data: {} } } });
    rendre();
    expect(await screen.findByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Réessayer : Analyse" })).toBeInTheDocument();
    expect(screen.getByTestId("carte")).toBeInTheDocument();
  });
  it("hors ligne : bandeau clair, depot et ecritures desactives, la carte ne demande rien", async () => {
    installer();
    enLigne(false);
    rendre();
    expect(await screen.findByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/Vous êtes hors ligne\./)).toBeInTheDocument();
    expect(screen.getByText(/jamais conservés sur cet appareil/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ajouter des données/ })).toBeDisabled();
    await new Promise((r) => setTimeout(r, 500));
    expect(appelsCarte()).toHaveLength(0);
  });
  it("le passage hors ligne en cours de route fait apparaitre le bandeau", async () => {
    installer();
    rendre();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByText(/Vous êtes hors ligne\./)).toBeNull();
    act(() => { enLigne(false); window.dispatchEvent(new Event("offline")); });
    expect(await screen.findByText(/Vous êtes hors ligne\./)).toBeInTheDocument();
  });
});

describe("accessibilite (axe)", () => {
  it("aucune violation : onglet Analyse, onglet Couches (quarantaine), fiche ouverte, dialogue de depot", async () => {
    installer({ carte: [couche({ features: [ligne("Fibre FO-01", 0, 0, 5, 5, { a: 1 })] })] });
    const { container } = rendre();
    await screen.findByText("Réseaux par type");
    await userEvent.click(await screen.findByTestId("objet-carte"));
    await screen.findByTestId("fiche-objet");
    expect(await violationsAccessibilite(container)).toEqual([]);
    await userEvent.click(screen.getByRole("tab", { name: "Couches" }));
    await screen.findByRole("heading", { name: /Fichiers reçus, à autoriser/ });
    expect(await violationsAccessibilite(container)).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: /Ajouter des données/ }));
    await screen.findByRole("dialog");
    expect(await violationsAccessibilite(document.body)).toEqual([]);
  }, 60_000);
  it("aucune violation : etats 403, 404, projet sans donnee, hors ligne", async () => {
    installer({ fiche: { response: { status: 403, data: {} } } });
    const a = rendre();
    await screen.findByRole("alert");
    expect(await violationsAccessibilite(a.container)).toEqual([]);
    a.unmount();
    installer({ fiche: { response: { status: 404, data: {} } } });
    const b = rendre();
    await screen.findByRole("alert");
    expect(await violationsAccessibilite(b.container)).toEqual([]);
    b.unmount();
    installer({ fiche: projetFiche({ jeux: [JEU_AXES, JEU_TEL].map((j) => ({ ...j, statut: "RETIRE" as const })), bbox: null }) });
    enLigne(false);
    const c = rendre();
    await screen.findByText(/Vous êtes hors ligne\./);
    expect(await violationsAccessibilite(c.container)).toEqual([]);
  }, 60_000);
});

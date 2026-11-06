import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("react-leaflet", async () => (await import("../components/projets-voirie/carteDouble.testutil")).moduleReactLeaflet());

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../lib/api", () => ({ api: { get: h.get, post: h.post, patch: vi.fn(), delete: vi.fn() } }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u", role: "ADMIN", modulesAutorises: [] } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/download", () => ({ downloadViaApi: vi.fn().mockResolvedValue(undefined) }));

import { ProjetVoirieDetailPage } from "./ProjetVoirieDetailPage";
import { analyse, couche, ligne, projetFiche } from "../components/projets-voirie/synthetique.testutil";
import { BASE, reponseApi } from "../components/projets-voirie/conflitsPage.testutil";
import { downloadViaApi } from "../lib/download";

/**
 * AUCUN RESEAU DE CONCESSIONNAIRE N'EST CONSERVE SUR L'APPAREIL (contrat, sections 2 et 6).
 *
 * Deux preuves complementaires :
 *  1. STATIQUE : le code du module (hors tests) n'emploie aucune API de stockage (localStorage, sessionStorage, IndexedDB, Cache API,
 *     service worker), ne lit pas le contenu d'un fichier (FileReader), et n'injecte aucun HTML (innerHTML, popups Leaflet, setHTML).
 *     Les commentaires sont ecartes avant la recherche : ils expliquent justement ces interdits.
 *  2. A L'EXECUTION : on parcourt la page (carte, fiche, couches, depot simule puis ecrit) avec des espions sur tous les stockages ; aucun n'est touche.
 * Le service worker du projet ne met jamais en cache /api/ (swPolicy.test.ts) ; ce module n'en ajoute aucun.
 */

const RACINE = path.resolve(__dirname, "..");

function fichiersDuModule(): string[] {
  const sortie: string[] = [];
  const dossier = path.join(RACINE, "components/projets-voirie");
  for (const f of readdirSync(dossier)) if (/\.tsx?$/.test(f) && !/\.test\.|\.testutil\./.test(f)) sortie.push(path.join(dossier, f));
  for (const f of readdirSync(path.join(RACINE, "pages"))) if (/^Projet(s)?Voirie.*\.tsx$/.test(f) && !/\.test\./.test(f)) sortie.push(path.join(RACINE, "pages", f));
  for (const f of readdirSync(path.join(RACINE, "lib"))) if (/^projetsVoirie.*\.ts$/.test(f) && !/\.test\./.test(f)) sortie.push(path.join(RACINE, "lib", f));
  return sortie;
}

const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

describe("preuve statique", () => {
  const fichiers = fichiersDuModule();
  it("le module compte bien des fichiers (la recherche ne porte pas sur un dossier vide)", () => {
    // Socle (14) + dossiers de conflit (lot RC-3 : 3 lib, 8 composants).
    expect(fichiers.length).toBeGreaterThanOrEqual(25);
  });
  it.each([
    ["stockage local", /localStorage|sessionStorage|indexedDB|IndexedDB|openDatabase|\bcaches\b|serviceWorker|navigator\.storage|persistQueryClient|createSyncStoragePersister/],
    ["lecture du contenu d'un fichier par le navigateur", /FileReader|readAsText|readAsArrayBuffer|\.arrayBuffer\(|URL\.createObjectURL/],
    ["injection de HTML", /dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write|bindPopup|\.setHTML|DOMParser/],
    ["execution dynamique", /\beval\(|new Function\(/],
  ])("aucun usage de : %s", (_nom, motif) => {
    const fautifs = fichiers.filter((f) => motif.test(sansCommentaires(readFileSync(f, "utf8")))).map((f) => path.relative(RACINE, f));
    expect(fautifs).toEqual([]);
  });
  it("contre-epreuve : la recherche detecte bien un usage interdit", () => {
    expect(/localStorage/.test(sansCommentaires("const x = localStorage.getItem('a');"))).toBe(true);
    expect(/localStorage/.test(sansCommentaires("/* jamais localStorage */ // ni localStorage\nconst x = 1;"))).toBe(false);
  });
  it("les dossiers de conflit n'appellent ni l'API publique, ni une exportation de geometrie, ni une route qui deplace, ordonne ou execute", () => {
    const api = sansCommentaires(readFileSync(path.join(RACINE, "lib/projetsVoirieConflitsApi.ts"), "utf8"));
    expect(api).not.toMatch(/\/api\/public|\/public\//);
    expect(api).not.toMatch(/export\.(geojson|kml|kmz|shp)/i);
    // `/${id(projetId)}/conflits/:cid/statut` devient `/conflits/statut` : on compare les segments fixes des routes.
    const routes = [...api.matchAll(/`\$\{BASE\}([^`]*)`/g)].map((m) => m[1].replace(/\/\$\{id\(\w+\)\}/g, ""));
    expect(routes.length).toBeGreaterThanOrEqual(15);
    expect(routes.filter((r) => /deplacer|ordre|ordonner|executer|execution/i.test(r))).toEqual([]);
    // Le seul export est le CSV d'agregats.
    expect(routes.filter((r) => /export/.test(r))).toEqual(["/conflits/export.csv"]);
  });
  it("aucune route, aucun appel du module ne vise l'API publique ni une exportation de geometrie", () => {
    const api = sansCommentaires(readFileSync(path.join(RACINE, "lib/projetsVoirieApi.ts"), "utf8"));
    expect(api).not.toMatch(/\/api\/public|\/public\//);
    expect(api).not.toMatch(/export\.(geojson|kml|kmz|shp)/i);
    const appels = [...api.matchAll(/`\$\{BASE\}([^`]*)`|BASE,|\(BASE\b/g)];
    expect(appels.length).toBeGreaterThan(5);
  });
});

describe("preuve a l'execution : un parcours complet ne touche aucun stockage", () => {
  const espions: Array<ReturnType<typeof vi.fn>> = [];
  const sauvegarde: Array<[object, string, PropertyDescriptor | undefined]> = [];

  function definir(cible: object, nom: string, valeur: unknown) {
    sauvegarde.push([cible, nom, Object.getOwnPropertyDescriptor(cible, nom)]);
    Object.defineProperty(cible, nom, { configurable: true, writable: true, value: valeur });
  }

  beforeAll(() => { /* rien : tout est pose par test, restitue apres */ });
  beforeEach(() => {
    espions.length = 0;
    const unEspion = () => { const f = vi.fn(); espions.push(f); return f; };
    definir(globalThis, "indexedDB", { open: unEspion(), deleteDatabase: unEspion() });
    definir(globalThis, "caches", { open: unEspion(), match: unEspion(), keys: unEspion() });
    definir(navigator, "serviceWorker", { register: unEspion(), getRegistrations: unEspion(), ready: Promise.resolve({}) });
    for (const m of ["setItem", "getItem", "removeItem", "clear"] as const) {
      const e = vi.spyOn(Storage.prototype, m);
      espions.push(e as unknown as ReturnType<typeof vi.fn>);
    }
    h.get.mockReset(); h.post.mockReset();
    h.get.mockImplementation(async (url: string, opts?: { params?: Record<string, unknown> }) => {
      if (url === "/v2/projets-voirie/p1") return { data: projetFiche() };
      if (url === "/v2/projets-voirie/p1/analyse") return { data: JSON.parse(JSON.stringify(analyse())) };
      if (url === "/v2/projets-voirie/p1/carte") {
        const ids = String(opts?.params?.jeux ?? "").split(",").filter(Boolean);
        return { data: ids.map((id) => couche({ jeuId: id, features: [ligne("Fibre FO-01", 0, 0, 5, 5, { Circuit: "C-1" })] })) };
      }
      if (url === "/v2/projets-voirie/concessionnaires") return { data: [{ id: "c1", nom: "Operateur synthetique A", typeReseau: "TELECOM" }] };
      return { data: {} };
    });
    h.post.mockResolvedValue({ data: { simulation: true, jeu: null, resume: { nbObjets: 1, parTypeGeom: { LIGNE: 1 }, attributsDetectes: [] }, avertissements: [] } });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const [cible, nom, d] of sauvegarde.splice(0).reverse()) { if (d) Object.defineProperty(cible, nom, d); else delete (cible as Record<string, unknown>)[nom]; }
  });

  it("carte, fiche d'objet, couches, simulation puis ecriture d'un depot : zero appel de stockage", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <MemoryRouter initialEntries={["/projets-voirie/p1"]}>
        <QueryClientProvider client={qc}>
          <Routes><Route path="/projets-voirie/:id" element={<ProjetVoirieDetailPage />} /></Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    await userEvent.click((await screen.findAllByTestId("objet-carte", undefined, { timeout: 25000 }))[0]);
    await screen.findByTestId("fiche-objet");
    await userEvent.click(screen.getByRole("tab", { name: "Couches" }));
    await screen.findByRole("heading", { name: /Fichiers reçus, à autoriser/ });
    await userEvent.click(screen.getByRole("button", { name: /Ajouter des données/ }));
    const d = await screen.findByRole("dialog");
    await userEvent.upload(d.querySelector("input[type=file]")!, new File(["<kml/>"], "reseau-synthetique.kml"));
    await screen.findByRole("option", { name: /Operateur synthetique A/ });
    await userEvent.selectOptions(within(d).getByLabelText("Concessionnaire propriétaire du réseau"), "c1");
    await userEvent.click(within(d).getByRole("button", { name: "Simuler le dépôt" }));
    await userEvent.click(await within(d).findByRole("button", { name: "Confirmer l'écriture" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(2));
    expect(espions.length).toBeGreaterThanOrEqual(10);
    expect(espions.flatMap((e) => e.mock.calls)).toEqual([]);
  }, 60_000);

  it("onglet Conflits : liste, dossier, transition, attribution, preuve, decision, analyse, historique, comparaison, regles, export : zero appel de stockage", async () => {
    h.get.mockImplementation(async (url: string, opts?: { params?: Record<string, unknown> }) => reponseApi(url, opts?.params));
    h.post.mockReset(); h.post.mockResolvedValue({ data: {} });
    const patch = vi.fn().mockResolvedValue({ data: {} });
    (await import("../lib/api")).api.patch = patch as never;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <MemoryRouter initialEntries={["/projets-voirie/p1"]}>
        <QueryClientProvider client={qc}>
          <Routes><Route path="/projets-voirie/:id" element={<ProjetVoirieDetailPage />} /></Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByRole("tab", { name: "Conflits" }, { timeout: 25000 }));
    const lien = await waitFor(() => { const b = document.querySelector<HTMLButtonElement>('button[data-conflit-id="cf-1"]'); if (!b) throw new Error("liste absente"); return b; }, { timeout: 25000 });
    await userEvent.click(lien);
    const f = await screen.findByTestId("fiche-conflit");
    // Preuve.
    await userEvent.click(within(f).getByRole("button", { name: /Ajouter une preuve/ }));
    let d = await screen.findByRole("dialog");
    await userEvent.type(within(d).getByLabelText("Texte de la preuve"), "Note de terrain");
    await userEvent.click(within(d).getByRole("button", { name: "Ajouter la preuve" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Attribution.
    await userEvent.click(within(f).getByRole("button", { name: /Attribuer ou modifier/ }));
    d = await screen.findByRole("dialog");
    await userEvent.selectOptions(within(d).getByLabelText("Risque"), "ELEVE");
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer l'attribution" }));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Transition.
    await userEvent.click(within(f).getByRole("button", { name: "Infirmer ce conflit" }));
    d = await screen.findByRole("dialog");
    await userEvent.type(within(d).getByLabelText(/Justification/), "Écarté après contrôle");
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer la transition" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Analyse, historique, comparaison, regles, export.
    await userEvent.click(screen.getByRole("button", { name: "Retour à la liste des conflits" }));
    await userEvent.click(screen.getByRole("button", { name: "Lancer une analyse" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${BASE}/analyses`, {}));
    await userEvent.click(screen.getByRole("button", { name: "Analyses" }));
    await userEvent.click(await screen.findByRole("button", { name: "Comparer" }));
    await screen.findByTestId("resultat-comparaison");
    await userEvent.click(screen.getByRole("button", { name: "Règles" }));
    await screen.findAllByText(/^version [0-9]/);
    await userEvent.click(screen.getByRole("button", { name: /Exporter les conflits/ }));
    await waitFor(() => expect(downloadViaApi).toHaveBeenCalled());
    expect(espions.length).toBeGreaterThanOrEqual(10);
    expect(espions.flatMap((e) => e.mock.calls)).toEqual([]);
  }, 90_000);

  it("contre-epreuve : les espions voient bien un appel de stockage", () => {
    localStorage.setItem("essai", "1");
    expect(espions.flatMap((e) => e.mock.calls).length).toBeGreaterThan(0);
    localStorage.removeItem("essai");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("react-leaflet", async () => (await import("../components/projets-voirie/carteDouble.testutil")).moduleReactLeaflet());

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), role: "GESTIONNAIRE" }));
vi.mock("../lib/api", () => ({ api: { get: h.get, post: h.post, patch: h.patch, delete: h.delete } }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u", role: h.role, modulesAutorises: ["projets-voirie"] } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ProjetVoirieDetailPage } from "./ProjetVoirieDetailPage";
import { reinitialiserCarte } from "../components/projets-voirie/carteDouble.testutil";
import { analyse, projetFiche } from "../components/projets-voirie/synthetique.testutil";
import { violationsAccessibilite } from "../test/accessibilite";

/**
 * Fiche projet, lot UI-C : territoire et categorie (affichage, modification par PATCH), onglet « Sources ». Donnees 100 % SYNTHETIQUES.
 */

configure({ asyncUtilTimeout: 8000 });
const BASE = "/v2/projets-voirie/p1";
const TERRITOIRE = { id: "com", code: "SYN-COM", nom: "Commune synthetique", niveau: "COMMUNE", ancetres: [{ id: "n", code: "SYN-N", nom: "Nation synthetique", niveau: "NATION" }, { id: "reg", code: "SYN-REG", nom: "Region synthetique", niveau: "REGION" }] };
const TERR = (id: string, chemin: string, over: Record<string, unknown> = {}) => ({
  id, code: `SYN-${id.toUpperCase()}`, nom: `Territoire ${id}`, niveau: "COMMUNE", parentId: null, chemin, profondeur: 1, regionId: null, regionEffectiveId: 1, crsMetriqueEpsg: null, bbox: null, source: null, actif: true, version: 1, ...over,
});

function installer(over: { fiche?: unknown } = {}) {
  h.get.mockImplementation(async (url: string) => {
    if (url === BASE) return { data: over.fiche ?? { ...projetFiche({ jeux: [] }), regionId: 1, territoireId: "com", territoire: TERRITOIRE, categorieCode: "ANCIENNE" } };
    if (url === `${BASE}/analyse`) return { data: JSON.parse(JSON.stringify(analyse())) };
    if (url === `${BASE}/carte`) return { data: [] };
    if (url === "/v2/projets-voirie/referentiels/CATEGORIE_PROJET") {
      return { data: { valeurs: [
        { id: "k1", domaine: "CATEGORIE_PROJET", code: "VOIRIE_URBAINE", libelle: "Voirie urbaine", actif: true, parametres: { largeurEmpriseM: 15, largeurChausseeM: 7 } },
        { id: "k2", domaine: "CATEGORIE_PROJET", code: "ANCIENNE", libelle: "Categorie ancienne", actif: false, parametres: { largeurEmpriseM: 10, largeurChausseeM: 5 } },
      ] } };
    }
    if (url === "/v2/projets-voirie/territoires") return { data: { territoires: [TERR("reg", "/reg/", { niveau: "REGION", nom: "Region synthetique" }), TERR("com", "/reg/com/", { nom: "Commune synthetique" }), TERR("q", "/reg/q/", { nom: "Quartier voisin", niveau: "QUARTIER" }), TERR("ail", "/ail/", { nom: "Commune d'une autre region", regionEffectiveId: 2 })], curseurSuivant: null } };
    if (url === `${BASE}/sources`) return { data: { reseaux: [{ role: "AXES_TRAVAUX", statut: "SOURCE_UNIQUE_COMPARAISON_INDISPONIBLE", sources: [{ jeuId: "ja", version: 1, nomFichier: "axes.geojson" }] }] } };
    if (url === `${BASE}/comparaisons`) return { data: { comparaisons: [], curseurSuivant: null } };
    if (url === `${BASE}/regles-rapprochement`) return { data: { regles: [], effectives: [], avertissements: [] } };
    if (url.startsWith("/v2/projets-voirie/referentiels/")) return { data: { valeurs: [] } };
    return { data: {} };
  });
}

function rendre() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={["/projets-voirie/p1"]}>
      <QueryClientProvider client={qc}>
        <Routes><Route path="/projets-voirie/:id" element={<ProjetVoirieDetailPage />} /></Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => { for (const f of [h.get, h.post, h.patch, h.delete]) f.mockReset(); h.role = "GESTIONNAIRE"; reinitialiserCarte(); });

describe("territoire et categorie du projet", () => {
  it("affiche le territoire, le chemin de ses ancetres et la categorie (une categorie desactivee reste lisible)", async () => {
    installer();
    rendre();
    const t = await screen.findByTestId("territoire-projet");
    expect(t).toHaveTextContent("Territoire : Commune synthetique (Commune) · Nation synthetique › Region synthetique");
    await waitFor(() => expect(t).toHaveTextContent("Catégorie : Categorie ancienne (valeur désactivée)"));
  });
  it("modification : seuls les champs changes partent (PATCH) ; 400 TERRITOIRE_REGION_INCOHERENTE explique", async () => {
    installer();
    h.patch.mockRejectedValueOnce({ response: { status: 400, data: { code: "TERRITOIRE_REGION_INCOHERENTE", error: "brut" } } }).mockResolvedValueOnce({ data: { projet: projetFiche() } });
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: "Modifier le territoire ou la catégorie" }));
    const d = await screen.findByRole("dialog", { name: "Territoire et catégorie du projet" });
    expect(within(d).getByRole("button", { name: "Enregistrer" })).toBeDisabled();
    await u.click(await within(d).findByRole("radio", { name: /Quartier voisin/ }));
    await u.click(within(d).getByRole("button", { name: "Enregistrer" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent(/même région que le projet/);
    expect(h.patch).toHaveBeenCalledWith(BASE, { territoireId: "q" });
    await u.selectOptions(within(d).getByLabelText("Catégorie de projet"), "VOIRIE_URBAINE");
    await u.click(within(d).getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(h.patch).toHaveBeenLastCalledWith(BASE, { territoireId: "q", categorieCode: "VOIRIE_URBAINE" }));
  });
  it("revue m8 : seuls les territoires de la region du projet sont proposes (le serveur reste la garde)", async () => {
    installer();
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: "Modifier le territoire ou la catégorie" }));
    const d = await screen.findByRole("dialog", { name: "Territoire et catégorie du projet" });
    await within(d).findByRole("radio", { name: /Quartier voisin/ });
    expect(within(d).queryByRole("radio", { name: /autre region/ })).toBeNull();
    expect(d).toHaveTextContent(/Seuls les territoires de la région du projet sont proposés/);
  });
  it("un lecteur ne voit pas le bouton de modification", async () => {
    h.role = "LECTEUR";
    installer();
    rendre();
    await screen.findByTestId("territoire-projet");
    expect(screen.queryByRole("button", { name: /Modifier le territoire/ })).toBeNull();
  });
  it("projet sans territoire (serveur ancien) : « Territoire non renseigne », sans erreur", async () => {
    installer({ fiche: projetFiche({ jeux: [] }) });
    rendre();
    expect(await screen.findByTestId("territoire-projet")).toHaveTextContent("Territoire non renseigné");
  });
});

describe("onglet Sources", () => {
  it("cinquieme onglet ; source unique dite comme etat normal ; axe sans violation", async () => {
    installer();
    const u = userEvent.setup();
    const r = rendre();
    await u.click(await screen.findByRole("tab", { name: "Sources" }));
    expect(await screen.findByTestId("source-unique")).toHaveTextContent("Source unique : comparaison indisponible");
    expect(h.get.mock.calls.map((c) => c[0])).toContain(`${BASE}/sources`);
    expect(await violationsAccessibilite(r.container)).toEqual([]);
  }, 30_000);
});

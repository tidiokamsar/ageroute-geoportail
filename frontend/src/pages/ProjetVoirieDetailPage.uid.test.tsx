import { beforeEach, describe, expect, it, vi } from "vitest";
import { configure, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("react-leaflet", async () => (await import("../components/projets-voirie/carteDouble.testutil")).moduleReactLeaflet());

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), role: "LECTEUR" }));
vi.mock("../lib/api", () => ({ api: { get: h.get, post: h.post, patch: h.patch, delete: h.delete } }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u", role: h.role, modulesAutorises: ["projets-voirie"] } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ProjetVoirieDetailPage } from "./ProjetVoirieDetailPage";
import { ProjetsVoirieListePage } from "./ProjetsVoirieListePage";
import { reinitialiserCarte } from "../components/projets-voirie/carteDouble.testutil";
import { analyse, projetFiche } from "../components/projets-voirie/synthetique.testutil";

/**
 * Fiche projet, lot UI-D : onglets « Documents » (tous les comptes du module) et « Export » (decideurs seulement), lien vers le tableau de bord depuis
 * la liste. Les verifications de role portent sur du contenu CHARGE (document lu du serveur), avec contre-epreuve ADMIN. Donnees 100 % SYNTHETIQUES.
 */

configure({ asyncUtilTimeout: 8000 });
const BASE = "/v2/projets-voirie/p1";
const DOC = {
  id: "d1", projetId: "p1", ligneeId: "d1", version: 1, typeCode: "PLAN_AXES", type: { code: "PLAN_AXES", libelle: "Plan d'axes", actif: true }, titre: "Plan valide synthetique",
  statut: "VALIDE", piece: { reference: "REF-1", nomFichier: null, format: null, sha256: null, tailleOctets: null, jeuLie: false }, jeu: null, exploitable: { possible: true, raison: null },
};

function installer() {
  h.get.mockImplementation(async (url: string) => {
    if (url === BASE) return { data: projetFiche({ jeux: [] }) };
    if (url === `${BASE}/analyse`) return { data: JSON.parse(JSON.stringify(analyse())) };
    if (url === `${BASE}/carte`) return { data: [] };
    if (url === `${BASE}/documents`) return { data: { documents: [h.role === "LECTEUR" ? DOC : { ...DOC, transitionsPossibles: [] }], curseurSuivant: null } };
    if (url === `${BASE}/completude`) return { data: { fonctions: [{ code: "ANALYSE_2D", etat: "INDISPONIBLE", conditions: [] }], piecesManquantes: [], documents: { total: 1, parStatut: { VALIDE: 1 } } } };
    if (url === `${BASE}/export/journal`) return { data: { exports: [] } };
    if (url === `${BASE}/export/derogations`) return { data: { derogations: [] } };
    if (url.startsWith("/v2/projets-voirie/referentiels/")) return { data: { valeurs: [] } };
    if (url === "/v2/projets-voirie") return { data: { projets: [], curseurSuivant: null } };
    return { data: {} };
  });
}

function rendre(chemin = "/projets-voirie/p1") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[chemin]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/projets-voirie" element={<ProjetsVoirieListePage />} />
          <Route path="/projets-voirie/:id" element={<ProjetVoirieDetailPage />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => { for (const f of [h.get, h.post, h.patch, h.delete]) f.mockReset(); h.role = "LECTEUR"; reinitialiserCarte(); installer(); });

describe("onglets Documents et Export", () => {
  it("lecteur : onglet Documents (pieces validees, sur contenu charge, aucun bouton d'ecriture), pas d'onglet Export", async () => {
    const u = userEvent.setup();
    rendre();
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Analyse", "Couches", "Conflits", "Réseaux", "Sources", "Documents"]);
    await u.click(screen.getByRole("tab", { name: "Documents" }));
    const panneau = screen.getByRole("tabpanel");
    await within(panneau).findByRole("article", { name: /^Plan valide synthetique/ });
    expect(within(panneau).queryByRole("button", { name: /Nouveau document/ })).toBeNull();
    expect(h.get.mock.calls.some((c) => String(c[0]).includes("/export/"))).toBe(false);
  });
  it("contre-epreuve ADMIN : les deux onglets, bouton de creation et de fabrication du dossier", async () => {
    h.role = "ADMIN";
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("tab", { name: "Documents" }));
    await within(screen.getByRole("tabpanel")).findByRole("article", { name: /^Plan valide synthetique/ });
    expect(screen.getByRole("button", { name: /Nouveau document/ })).toBeInTheDocument();
    await u.click(screen.getByRole("tab", { name: "Export" }));
    expect(await within(screen.getByRole("tabpanel")).findByRole("button", { name: /Fabriquer et télécharger/ })).toBeInTheDocument();
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "pv-onglet-export");
  });
});

describe("liste des projets", () => {
  it("lien vers le tableau de bord, pour tout compte", async () => {
    rendre("/projets-voirie");
    expect(await screen.findByRole("link", { name: /Tableau de bord/ })).toHaveAttribute("href", "/projets-voirie/tableau-de-bord");
  });
});

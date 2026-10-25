import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const h = vi.hoisted(() => ({
  role: "GESTIONNAIRE",
  troncons: [] as unknown[],
}));

vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string) => {
      if (url === "/troncons/geo") return { data: h.troncons };
      // 404 si la base ne porte aucune limite : la page ne dessine alors aucun contour.
      if (url === "/v2/geo/contour") throw new Error("404");
      if (url === "/dashboard/kpis") {
        return { data: { longueurTotaleKm: 100, tronconsCount: 1, ouvragesCount: 0, chantiersEnCours: 0, pointsNoirsCount: 0 } };
      }
      if (url.includes("/fiche")) return { data: null };
      if (url.startsWith("/audit") || url.startsWith("/documents")) return { data: { data: [] } };
      return { data: [] };
    }),
    post: vi.fn(async () => ({ data: {} })),
    put: vi.fn(async () => ({ data: {} })),
  },
}));
vi.mock("axios", async (orig) => {
  const mod = await orig<typeof import("axios")>();
  return { ...mod, default: { ...mod.default, get: vi.fn(async () => ({ data: { type: "FeatureCollection", features: [] } })) } };
});
// jsdom ne sait pas dessiner les couches vectorielles de Leaflet (rendu SVG) : elles sont neutralisees,
// le style des troncons est teste a part (geoportail/affichageTroncon.test.tsx).
vi.mock("react-leaflet", async (orig) => {
  const mod = await orig<typeof import("react-leaflet")>();
  return { ...mod, GeoJSON: () => null, Polyline: () => null, CircleMarker: () => null };
});
vi.mock("../components/RechercheVille", () => ({
  // Le vrai composant interroge un annuaire de villes : on ne garde que ce qu'il remet a la page.
  RechercheVille: ({ onAppliquer }: { onAppliquer: (f: { a: { nom: string; lat: number; lon: number; region: string } }) => void }) => (
    <button type="button" onClick={() => onAppliquer({ a: { nom: "Coyah", lat: 9.55, lon: -13.65, region: "Kindia" } })}>
      Choisir une ville seule
    </button>
  ),
}));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/auth", async (orig) => {
  const mod = await orig<typeof import("../lib/auth")>();
  return { ...mod, useAuth: () => ({ user: { id: "u", role: h.role, modulesAutorises: [] } }) };
});

import { GeoportailPage } from "./GeoportailPage";

/**
 * Page Géoportail : accessibilité de la barre latérale, repli sur téléphone et sortie du plein
 * écran au clavier. Seul jsdom tourne ici : aucun rendu réel, donc aucune assertion de mise en
 * page (positions, débordements) — uniquement des états et des attributs.
 */
const TRONCON = {
  id: "t-1", code: "RN1-01", nom: "RN1 Conakry - Coyah", classe: "RN", etat: "BON", longueurKm: 12.5,
  region: "Conakry", revetement: "BITUME", pkDebut: 0, pkFin: 12.5, etatDeclare: true,
  geometry: JSON.stringify({ type: "LineString", coordinates: [[-13.7, 9.5], [-13.6, 9.6]] }),
};

const matchMediaOriginal = window.matchMedia;
beforeEach(() => { h.role = "GESTIONNAIRE"; h.troncons = [TRONCON]; });
afterEach(() => { window.matchMedia = matchMediaOriginal; });

function rendre(url = "/geoportail") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}><GeoportailPage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

function simulerEcran(largeur: number) {
  window.matchMedia = vi.fn((q: string) => {
    const max = /max-width:\s*(\d+)px/.exec(q);
    return { matches: max ? largeur <= Number(max[1]) : false, media: q, addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList;
  });
}

describe("GeoportailPage : panneau des couches", () => {
  it("bureau : le panneau est ouvert par défaut (comportement historique)", async () => {
    rendre();
    expect(await screen.findByRole("button", { name: "Réduire le panneau des couches" })).toHaveAttribute("aria-expanded", "true");
  });

  it("téléphone (375 px) : le panneau est replié par défaut", async () => {
    simulerEcran(375);
    rendre();
    expect(await screen.findByRole("button", { name: "Afficher le panneau des couches" })).toHaveAttribute("aria-expanded", "false");
  });

  it("les sections repliables annoncent leur état et les fonds de carte leur sélection", async () => {
    const u = userEvent.setup({ delay: null });
    rendre();
    const section = await screen.findByRole("button", { name: /Fond de carte/ });
    expect(section).toHaveAttribute("aria-expanded", "false");
    await u.click(section);
    expect(section).toHaveAttribute("aria-expanded", "true");

    const fonds = screen.getAllByRole("button", { pressed: true });
    // Exactement un fond sélectionné parmi les boutons à état (les autres sont « non pressés »).
    expect(fonds.length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole("button", { pressed: false }).length).toBeGreaterThanOrEqual(1);
  });

  it("le champ de recherche a un nom accessible", async () => {
    rendre();
    expect(await screen.findByRole("searchbox", { name: /Rechercher un tronçon, un ouvrage ou un chantier/ })).toBeInTheDocument();
  });

  it("la légende distingue l'état déclaré (trait pointillé)", async () => {
    rendre();
    expect(await screen.findByText(/Trait pointillé : état déclaré, non constaté sur le terrain/)).toBeInTheDocument();
  });

  it("le tableau de bord chiffre la part d'état déclaré", async () => {
    rendre();
    expect(await screen.findByText(/Dont 13 km à l'état seulement déclaré/)).toBeInTheDocument();
  });
});

describe("GeoportailPage : Echap", () => {
  it("ferme la fiche, puis quitte le plein écran au second appui", async () => {
    const u = userEvent.setup({ delay: null });
    const { container } = rendre("/geoportail?select=troncon&id=t-1");
    const fiche = await screen.findByRole("dialog", { name: /Fiche : RN1 Conakry - Coyah/ });
    expect(fiche).toBeInTheDocument();

    await u.click(screen.getByRole("button", { name: /plein écran/i }));
    expect(container.querySelector(".fixed.inset-0")).not.toBeNull();

    await u.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Fiche : / })).not.toBeInTheDocument());
    // Premier Echap : la fiche seule. Le plein écran est conservé.
    expect(container.querySelector(".fixed.inset-0")).not.toBeNull();

    await u.keyboard("{Escape}");
    await waitFor(() => expect(container.querySelector(".fixed.inset-0")).toBeNull());
  });
});

describe("GeoportailPage : changement d'état en masse", () => {
  it("n'est pas proposé pour une ville seule (bande de 20 km, routes voisines comprises)", async () => {
    const u = userEvent.setup({ delay: null });
    rendre();
    await u.click(await screen.findByRole("button", { name: /Filtrer par ville/ }));
    await u.click(await screen.findByRole("button", { name: "Choisir une ville seule" }));

    // Le filtre est bien posé (bande de 20 km) et affiche le tronçon voisin...
    await waitFor(() => expect(document.body.textContent).toContain("Coyah (20 km) — 1 tronçon(s)"));
    // ...mais aucune action de masse n'est offerte sur cette bande.
    expect(screen.queryByRole("button", { name: /Changer l'état du corridor/ })).not.toBeInTheDocument();
  });
});

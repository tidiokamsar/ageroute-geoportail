import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { violationsAccessibilite } from "../test/accessibilite";

/**
 * Page « Tronçons routiers » (BDRI, lot B) : ce que ces tests défendent.
 *   - les filtres vivent dans l'URL, partent au SERVEUR (y compris PK non renseignés et tracé) et se réinitialisent ;
 *   - la synthèse affiche le nombre COMPTÉ par le serveur et ses liens appliquent le filtre correspondant ;
 *   - longueur déclarée et longueur du tracé sont distinctes ; une valeur absente est dite « non renseignée » ;
 *   - « Carte » n'est pas proposé pour un tronçon sans tracé ;
 *   - l'export reçoit les filtres courants ; zéro violation d'accessibilité.
 */
const h = vi.hoisted(() => ({ gets: [] as { url: string; params?: Record<string, unknown> }[] }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u", role: "GESTIONNAIRE" } }), canWrite: () => true, canDelete: () => true }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../components/RouteEntreVilles", () => ({ RouteEntreVilles: () => null }));
vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string, cfg?: { params?: Record<string, unknown>; responseType?: string }) => {
      h.gets.push({ url, params: cfg?.params });
      if (url === "/regions") return { data: [{ id: 3, nom: "Kindia" }] };
      if (url.endsWith("/synthese")) {
        return { data: {
          troncons: 1691, longueur: { declareeKm: 21156.6, geometriqueKm: 20890.2, methodeGeometrique: "ST_Length(geom::geography), tracés valides seulement", tronconsSansGeometrie: 12 },
          completude: { pkNonRenseignes: 340, sansGeometrie: 12, geometriesInvalides: 1, classeNonRenseignee: 0, revetementNonRenseigne: 5, etatNonEvalue: 800 },
          parRegion: [{ cle: "Kindia", troncons: 200, kmDeclares: 2400 }], parClasse: [], parRevetement: [], parEtat: [], validation: [],
          registre: { derniereAnalyse: null, ouvertes: 0, doublonsPotentiels: 0, parRegle: [] }, activite: { inspections90j: 4, chantiersEnCours: 2 },
        } };
      }
      if (url === "/troncons/export") return { data: new Blob(["x"]) };
      return { data: { data: [
        { id: "t1", code: "GN N0001", nom: "Coyah Kindia", classe: "RN", regionId: 3, region: { nom: "Kindia" }, longueurKm: 12, revetement: "BITUME", etat: "BON", pkDebut: 0, pkFin: 12, aGeometrie: true, longueurGeometriqueKm: 11.9 },
        { id: "t2", code: "GN N0002", nom: "Sans tracé", classe: "RN", regionId: 3, region: { nom: "Kindia" }, longueurKm: 0, revetement: "NON_RENSEIGNE", etat: "NON_EVALUE", pkDebut: 0, pkFin: 0, aGeometrie: false, longueurGeometriqueKm: null },
      ], total: 2, page: 1, pageSize: 20, totalPages: 1 } };
    }),
    post: vi.fn(async () => ({ data: {} })),
  },
}));

import { TronconsPage } from "./TronconsPage";

function Url() { const l = useLocation(); return <output data-testid="url">{l.search}</output>; }
const rendre = (url = "/troncons") => render(
  <MemoryRouter initialEntries={[url]}>
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Routes><Route path="/troncons" element={<><TronconsPage /><Url /></>} /></Routes>
    </QueryClientProvider>
  </MemoryRouter>,
);
const derniereListe = () => [...h.gets].reverse().find((g) => g.url === "/troncons")?.params ?? {};

beforeEach(() => { h.gets.length = 0; URL.createObjectURL = vi.fn(() => "blob:x"); URL.revokeObjectURL = vi.fn(); });

describe("TronconsPage", () => {
  it("lit les filtres dans l'URL et les envoie au serveur, PK et tracé compris", async () => {
    rendre("/troncons?type=NON_CLASSEE&revetement=TERRE&pk=non_renseigne&geometrie=absente");
    await screen.findByText("Coyah Kindia");
    await waitFor(() => expect(derniereListe()).toMatchObject({ type: "NON_CLASSEE", revetement: "TERRE", pk: "non_renseigne", geometrie: "absente" }));
    expect((screen.getByLabelText("Classe") as HTMLSelectElement).value).toBe("NON_CLASSEE");
  });
  it("un filtre choisi s'écrit dans l'URL ; réinitialiser les retire tous", async () => {
    rendre();
    await screen.findByText("Coyah Kindia");
    expect(screen.queryByRole("button", { name: /Réinitialiser les filtres/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Revêtement"), { target: { value: "LATERITE" } });
    await waitFor(() => expect(screen.getByTestId("url")).toHaveTextContent("revetement=LATERITE"));
    fireEvent.click(screen.getByRole("button", { name: /Réinitialiser les filtres/ }));
    await waitFor(() => expect(screen.getByTestId("url").textContent).toBe(""));
  });
  it("la synthèse affiche le nombre compté par le serveur ; son lien applique le filtre PK", async () => {
    rendre();
    const synthese = await screen.findByTestId("synthese-referentiel");
    expect(within(synthese).getByText("1 691")).toBeInTheDocument();
    expect(within(synthese).getByText(/aucune analyse enregistrée/)).toBeInTheDocument();
    fireEvent.click(within(synthese).getAllByRole("button", { name: "Afficher dans la liste" })[0]);
    await waitFor(() => expect(screen.getByTestId("url")).toHaveTextContent("pk=non_renseigne"));
  });
  it("longueurs distinctes, valeurs absentes dites, « Carte » masqué sans tracé", async () => {
    rendre();
    await screen.findByText("Coyah Kindia");
    expect(screen.getByText("tracé 11.9 km")).toBeInTheDocument();
    expect(screen.getByText("non renseignée")).toBeInTheDocument();
    expect(screen.getByText("sans tracé")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Carte" })).toHaveLength(1);
  });
  it("l'export reçoit les filtres courants et la recherche", async () => {
    rendre("/troncons?etat=MAUVAIS&q=Kindia");
    await screen.findByText("Coyah Kindia");
    fireEvent.click(screen.getByRole("button", { name: /Exporter/ }));
    await waitFor(() => expect(h.gets.find((g) => g.url === "/troncons/export")?.params).toMatchObject({ etat: "MAUVAIS", search: "Kindia" }));
  });
  it("zéro violation d'accessibilité", async () => {
    const { container } = rendre();
    await screen.findByText("Coyah Kindia");
    expect(await violationsAccessibilite(container)).toEqual([]);
  }, 30_000);
});

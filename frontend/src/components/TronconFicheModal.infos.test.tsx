import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Fiche tronçon, onglet Infos et nouveaux onglets (BDRI, lot B) : ce que ces tests défendent.
 *   - longueur déclarée et longueur du tracé sont deux lignes distinctes ; sans tracé, la fiche le dit ;
 *   - PK 0 → 0 s'affiche « non renseignés », un PK renseigné en notation 1+400 ; classe et revêtement en clair ;
 *   - statut de validation et source sont affichés, ou « non renseigné » ;
 *   - défauts et missions, chargés par la fiche, sont enfin montrés ;
 *   - les anomalies du registre ne sont demandées qu'à l'ouverture de leur onglet, pour CE tronçon.
 */
const h = vi.hoisted(() => ({ appels: [] as { url: string; params?: Record<string, unknown> }[], troncon: {} as Record<string, unknown>, geomM: 11_950 as number | null }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u", role: "LECTEUR" } }), canWrite: () => false }));
vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string, cfg?: { params?: Record<string, unknown> }) => {
      h.appels.push({ url, params: cfg?.params });
      if (url === "/troncons/t1/fiche") {
        return { data: {
          troncon: h.troncon, longueurGeometriqueM: h.geomM, ouvrages: [], pointsNoirs: [], postes: [], chantiers: [], inspections: [], portions: [],
          defauts: [{ id: "d1", code: "DEF-1", gravite: 3, catalogue: { libelle: "Nid de poule" } }],
          missions: [{ id: "m1", code: "MIS-1", intitule: "Inspection RN1", statut: "EN_COURS" }],
          couverture: null, repartitions: null, chevauchements: [],
        } };
      }
      if (url === "/qualite/Troncon/t1") return { data: { champs: [] } };
      if (url === "/v2/referentiel/troncons/anomalies") return { data: { data: [{ id: "a1", regle: "PK_NON_RENSEIGNES", gravite: "MAJEURE", statut: "A_EXAMINER", detecteeLe: "2026-10-25T08:00:00Z", disparueLe: null }], total: 1 } };
      throw new Error(`URL inattendue ${url}`);
    }),
  },
}));

import { TronconFicheModal } from "./TronconFicheModal";

const base = { id: "t1", code: "GN N0001", nom: "Coyah Kindia", classe: "RR", region: { nom: "Kindia" }, longueurKm: 12, revetement: "LATERITE", pkDebut: 0, pkFin: 0, traficMoyenJma: null, etat: "BON" };
const rendre = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TronconFicheModal open onClose={() => {}} tronconId="t1" /></QueryClientProvider>);
const ligne = (libelle: string) => screen.getByText(libelle).parentElement!;

beforeEach(() => { h.appels.length = 0; h.troncon = { ...base }; h.geomM = 11_950; });

describe("Fiche tronçon : Infos", () => {
  it("deux longueurs distinctes, PK non renseignés, classe et revêtement en clair, source absente dite", async () => {
    rendre();
    await screen.findByText("Longueur déclarée");
    expect(ligne("Longueur déclarée")).toHaveTextContent("12.00 km");
    expect(ligne("Longueur du tracé")).toHaveTextContent("11.95 km");
    expect(ligne("PK début → fin")).toHaveTextContent("non renseignés");
    expect(ligne("Classe")).toHaveTextContent("Route préfectorale");
    expect(ligne("Revêtement")).toHaveTextContent("Latérite");
    expect(ligne("Statut de validation")).toHaveTextContent("non renseigné");
    expect(ligne("Source")).toHaveTextContent("non renseigné");
  });
  it("sans tracé : la fiche le dit ; PK renseigné, validation et source affichés", async () => {
    h.geomM = null;
    h.troncon = { ...base, pkDebut: 1.4, pkFin: 13.4, statutValidation: "VALIDE", sourceType: "IMPORT", sourceReference: "BDR 2019", sourceConfidence: "MEDIUM" };
    rendre();
    await screen.findByText("Longueur déclarée");
    expect(ligne("Longueur du tracé")).toHaveTextContent("sans tracé exploitable");
    expect(ligne("PK début → fin")).toHaveTextContent("1+400 → 13+400");
    expect(ligne("Statut de validation")).toHaveTextContent("Validé");
    expect(ligne("Source")).toHaveTextContent("IMPORT · BDR 2019 · confiance MEDIUM");
  });
});

describe("Fiche tronçon : nouveaux onglets", () => {
  it("défauts et missions sont montrés", async () => {
    rendre();
    fireEvent.click(await screen.findByRole("button", { name: /Défauts et missions/ }));
    expect(screen.getByText(/Nid de poule · DEF-1 · gravité 3/)).toBeInTheDocument();
    expect(screen.getByText(/MIS-1 · Inspection RN1 · en cours/)).toBeInTheDocument();
  });
  it("les anomalies du registre ne sont demandées qu'à l'ouverture de leur onglet, pour ce tronçon", async () => {
    rendre();
    await screen.findByText("Longueur déclarée");
    expect(h.appels.some((a) => a.url === "/v2/referentiel/troncons/anomalies")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Anomalies du référentiel" }));
    expect(await screen.findByText(/pk non renseignes · majeure/)).toBeInTheDocument();
    expect(h.appels.find((a) => a.url === "/v2/referentiel/troncons/anomalies")?.params).toMatchObject({ tronconId: "t1", inclureDisparues: "true" });
  });
});

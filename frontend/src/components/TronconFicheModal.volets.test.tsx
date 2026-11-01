import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * La fiche tronçon existante recoit les deux volets de la fiche 360 (portion, programmation) comme
 * onglets supplementaires : ni remplacement, ni seconde fiche. Les onglets existants restent la.
 */

const h = vi.hoisted(() => ({ appels: [] as string[] }));
vi.mock("../lib/auth", () => ({
  useAuth: () => ({ user: { id: "u", role: "LECTEUR", modulesAutorises: [] } }),
  canWrite: () => false,
}));
vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string) => {
      h.appels.push(url);
      if (url === "/troncons/t1/fiche") {
        return { data: {
          troncon: { id: "t1", code: "GN N0001", nom: "Conakry", classe: "RN", region: { nom: "Conakry" }, longueurKm: 12, revetement: "BITUME", pkDebut: 0, pkFin: 12, traficMoyenJma: null, etat: "BON" },
          longueurGeometriqueM: 12000, ouvrages: [], pointsNoirs: [], postes: [], chantiers: [], inspections: [], portions: [], defauts: [], missions: [],
          couverture: null, repartitions: null, chevauchements: [],
        } };
      }
      if (url === "/qualite/Troncon/t1") return { data: { champs: [] } };
      if (url === "/v2/fiche-360/troncons/t1/portions") {
        return { data: { tronconId: "t1", tronconCode: "GN N0001", tronconNom: "Conakry", courantes: [], historique: [], tronque: false, plafond: 500, comptes: { courantes: 0, remplacees: 0, sansDateEffet: 0 } } };
      }
      if (url === "/v2/fiche-360/troncons/t1/programmation") {
        return { data: { tronconId: "t1", tronconCode: "GN N0001", previsions: [], totaux: [], chantiers: [], interventionsFigees: { disponible: false, motif: "Aucune table de fiches d'intervention." } } };
      }
      throw new Error(`URL inattendue ${url}`);
    }),
  },
}));

import { TronconFicheModal } from "./TronconFicheModal";

function rendre() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><TronconFicheModal open onClose={() => {}} tronconId="t1" /></QueryClientProvider>);
}

beforeEach(() => { h.appels = []; });

describe("Fiche tronçon : volets de la fiche 360", () => {
  it("garde ses onglets existants et ajoute « Historique des portions » et « Programmation »", async () => {
    rendre();
    for (const nom of ["Infos", "Portions", "Ouvrages", "Documents"]) {
      expect(await screen.findByRole("button", { name: new RegExp(`^${nom}`) })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Historique des portions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Programmation" })).toBeInTheDocument();
  });

  it("n'appelle les volets qu'a l'ouverture de leur onglet", async () => {
    rendre();
    await screen.findByRole("button", { name: "Programmation" });
    expect(h.appels.some((u) => u.startsWith("/v2/fiche-360"))).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Historique des portions" }));
    expect(await screen.findByTestId("volet-portions")).toBeInTheDocument();
    expect(h.appels).toContain("/v2/fiche-360/troncons/t1/portions");

    await userEvent.click(screen.getByRole("button", { name: "Programmation" }));
    expect(await screen.findByTestId("volet-programmation")).toBeInTheDocument();
    expect(h.appels).toContain("/v2/fiche-360/troncons/t1/programmation");
    expect(screen.getByText(/Interventions figées : indisponibles/)).toBeInTheDocument();
  });
});

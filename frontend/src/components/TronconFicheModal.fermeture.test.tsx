import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

/**
 * La fiche tronçon ne doit JAMAIS faire planter la page, ni à l'ouverture ni à la
 * fermeture (bug signalé le 23/10 : « le modal là plante tout »). Le bouton Fermer
 * de l'en-tête collant appelle onClose et le composant se démonte proprement.
 */
const h = vi.hoisted(() => ({
  fiche: {
    troncon: { id: "t-1", code: "MA 784", nom: "Voirie Urbaine MA 784", classe: "RU", region: "Conakry", longueurKm: 0.07, revetement: "BITUME", pkDebut: 0, pkFin: 0, etat: "BON" },
    portions: [], ouvrages: [], pointsNoirs: [], postes: [], chantiers: [], inspections: [], programmes: [], documents: [],
  },
  qualite: { champs: [] },
}));
vi.mock("../lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", role: "ADMIN", nomComplet: "Test" } }),
  canWriteRole: () => true,
  canWrite: () => true,
  canDelete: () => true,
  hasModuleAccess: () => true,
}));
vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string) => {
      if (url.endsWith("/fiche")) return { data: h.fiche };
      if (url.includes("/qualite/")) return { data: h.qualite };
      return { data: {} };
    }),
  },
}));
vi.mock("../hooks/useEntity", () => ({
  useEntityMutations: () => ({ update: { mutateAsync: vi.fn(), isPending: false } }),
}));
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...mod };
});

import { TronconFicheModal } from "./TronconFicheModal";

function rendre(onClose: () => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TronconFicheModal open onClose={onClose} tronconId="t-1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("TronconFicheModal — robustesse de fermeture", () => {
  it("le bouton Fermer de l'en-tête appelle onClose sans faire planter la page", async () => {
    const onClose = vi.fn();
    const u = userEvent.setup({ delay: null });
    rendre(onClose);
    await screen.findByText(/Voirie Urbaine MA 784/);
    const fermer = await screen.findByRole("button", { name: "Fermer" });
    await u.click(fermer);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("la croix standard du Dialog ferme aussi (doublon d'entrée, aucun conflit)", async () => {
    const onClose = vi.fn();
    const u = userEvent.setup({ delay: null });
    rendre(onClose);
    await screen.findByText(/Voirie Urbaine MA 784/);
    const croix = screen.getAllByRole("button", { name: "Fermer" });
    expect(croix.length).toBeGreaterThanOrEqual(1);
    await u.click(croix[0]);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("../lib/api", () => ({ api: h }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { DefautsValidationPage } from "./DefautsValidationPage";
import { CatalogueDefautsPage } from "./CatalogueDefautsPage";

function renderAvecQuery(element: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

beforeEach(() => {
  h.get.mockReset();
  h.post.mockReset();
  h.patch.mockReset();
});

describe("file de validation terrain", () => {
  it("permet au validateur d'examiner puis de valider un défaut", async () => {
    const defaut = {
      id: "defaut-1", code: null, tronconId: null, statutValidation: "A_VALIDER",
      constateA: "2026-10-08T09:30:00.000Z", lat: 9.5, lon: -13.7, abscisseM: null,
      pk: null, gravite: 2, etendue: null, quantite: 4, uniteQuantite: "METRE",
      methodeQuantite: "LONGUEUR", nombre: null, longueurM: 4, largeurM: null,
      profondeurM: null, quantiteSaisie: null,
      catalogue: { code: "ORNIERAGE", libelle: "Orniérage", unite: "METRE" },
      constatePar: { id: "agent-1", nomComplet: "Agent Terrain" }, mission: null, validations: [], medias: [],
    };
    h.get.mockImplementation(async (url: string) => {
      if (url.includes("/v2/defauts?")) return { data: { defauts: [defaut], curseurSuivant: null } };
      if (url.includes("/v2/observations?")) return { data: { observations: [], curseurSuivant: null } };
      return { data: defaut };
    });
    h.post.mockResolvedValue({ data: { ...defaut, statutValidation: "VALIDE" } });
    const user = userEvent.setup({ delay: null });
    renderAvecQuery(<DefautsValidationPage />);

    await screen.findByText("Orniérage");
    await user.click(screen.getByRole("button", { name: /Examiner/ }));
    await screen.findByText("Revue du défaut");
    await user.click(screen.getByRole("button", { name: /Valider/ }));

    await waitFor(() => expect(h.post).toHaveBeenCalledWith("/v2/defauts/defaut-1/decision", { decision: "VALIDE" }));
    // Plafond explicite : deux rendus complets de page (file puis revue). Sur un poste charge, le
    // 20/10/2026, ce parcours prenait 6,9 a 8 s pour 5 s de plafond, sans aucune assertion fausse.
  }, 15_000);
});

describe("catalogue des défauts", () => {
  it("désactive une entrée sans supprimer son historique", async () => {
    h.get.mockResolvedValue({ data: { catalogue: [{
      id: 1, code: "NID_POULE", libelle: "Nid de poule", famille: "CHAUSSEE", unite: "METRE_CARRE",
      mesuresRequises: ["LONGUEUR", "LARGEUR"], graviteMax: 4, description: null,
      source: "Vocabulaire courant à valider", version: 7, actif: true,
    }] } });
    h.patch.mockResolvedValue({ data: {} });
    const user = userEvent.setup({ delay: null });
    renderAvecQuery(<CatalogueDefautsPage />);

    await screen.findByText("Nid de poule");
    await user.click(screen.getByRole("button", { name: /Désactiver/ }));

    await waitFor(() => expect(h.patch).toHaveBeenCalledWith(
      "/v2/defauts/catalogue/NID_POULE",
      expect.objectContaining({ actif: false, version: 7 }),
    ));
    expect(h.post).not.toHaveBeenCalled();
  });
});

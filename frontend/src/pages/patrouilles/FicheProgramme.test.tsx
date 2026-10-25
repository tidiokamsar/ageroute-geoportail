import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Fiche d'un programme de patrouille : ce que ces tests défendent.
 *   - l'itinéraire s'affiche dans l'ordre et la fiche dit qu'il ne se modifie pas ;
 *   - la couverture d'un passage s'ouvre avec une tolérance bornée, et nomme les tronçons non vus ;
 *   - la modification n'envoie que le rythme (jamais d'itinéraire) ; suspendre envoie actif:false ;
 *   - le retrait exige un motif ; un LECTEUR ne voit aucun geste d'écriture.
 */

const h = vi.hoisted(() => ({ patchs: [] as unknown[], posts: [] as unknown[], params: [] as unknown[] }));
vi.mock("../../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string, cfg?: { params?: unknown }) => {
      h.params.push({ url, params: cfg?.params });
      if (url.endsWith("/couverture")) {
        return { data: { toleranceM: 30, longueurItineraireM: 2000, couvertM: 1000, taux: 0.5, horsItineraireM: 120, tronconsNonVus: ["t-b"],
          troncons: [{ tronconId: "t-a", ordre: 1, longueurM: 1000, couvertM: 1000, taux: 1 }, { tronconId: "t-b", ordre: 2, longueurM: 1000, couvertM: 0, taux: 0 }] } };
      }
      return { data: {
        id: "p-1", code: "PAT-RN1", libelle: "RN1", periodiciteJours: 7, moisActifs: [6, 7], actif: true, responsable: { id: "u-1", nomComplet: "Chef" },
        troncons: [{ ordre: 1, troncon: { id: "t-a", code: "RN1-A", nom: "Coyah" } }, { ordre: 2, troncon: { id: "t-b", code: "RN1-B", nom: "Kindia" } }],
        passages: [{ id: "m-1", code: "PAT-RN1-20261001", statut: "TERMINEE", debutPrevu: "2026-10-01", finReelle: "2026-10-01", assigne: null }],
        dernierPassage: "2026-10-01",
      } };
    }),
    patch: vi.fn(async (_u: string, corps: unknown) => { h.patchs.push(corps); return { data: {} }; }),
    post: vi.fn(async (url: string, corps: unknown) => { h.posts.push({ url, corps }); return { data: {} }; }),
  },
}));

import { FicheProgramme } from "./FicheProgramme";

const rendre = (peutEcrire = true) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <FicheProgramme id="p-1" peutEcrire={peutEcrire} personnes={[{ id: "u-1", nomComplet: "Chef" }, { id: "u-2", nomComplet: "Adjoint" }]} onClose={() => {}} />
  </QueryClientProvider>,
);

beforeEach(() => { h.patchs.length = 0; h.posts.length = 0; h.params.length = 0; });

describe("FicheProgramme", () => {
  it("affiche l'itinéraire ordonné, dit qu'il ne se modifie pas, ouvre la couverture d'un passage", async () => {
    rendre();
    expect(await screen.findByText(/RN1-A — Coyah/)).toBeInTheDocument();
    expect(screen.getAllByText(/ne se modifie pas/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Couverture" }));
    expect(await screen.findByText(/Non vus : RN1-B/)).toBeInTheDocument();
    expect(h.params).toContainEqual({ url: "/v2/exploitation/patrouilles/missions/m-1/couverture", params: { tolerance: 30 } });
  });
  it("modifie le rythme sans jamais envoyer d'itinéraire ; suspend", async () => {
    rendre();
    fireEvent.click(await screen.findByRole("button", { name: "Modifier le rythme" }));
    fireEvent.change(screen.getByLabelText(/Périodicité/), { target: { value: "14" } });
    fireEvent.change(screen.getByLabelText("Responsable"), { target: { value: "u-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(h.patchs[0]).toEqual({ libelle: "RN1", periodiciteJours: 14, moisActifs: [6, 7], responsableId: "u-2" }));
    fireEvent.click(await screen.findByRole("button", { name: "Suspendre" }));
    await waitFor(() => expect(h.patchs[1]).toEqual({ actif: false }));
  });
  it("le retrait exige un motif", async () => {
    rendre();
    const bouton = await screen.findByRole("button", { name: "Retirer le programme" });
    expect(bouton).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/motif/), { target: { value: "axe confié à la DR" } });
    fireEvent.click(bouton);
    await waitFor(() => expect(h.posts[0]).toEqual({ url: "/v2/exploitation/patrouilles/programmes/p-1/retrait", corps: { motif: "axe confié à la DR" } }));
  });
  it("un LECTEUR ne voit aucun geste d'écriture", async () => {
    rendre(false);
    await screen.findByText(/RN1-A — Coyah/);
    expect(screen.queryByRole("button", { name: "Modifier le rythme" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retirer le programme" })).not.toBeInTheDocument();
  });
});

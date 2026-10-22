import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Périmètres territoriaux : ce que ces tests défendent.
 *   - l'écran dit d'abord combien de comptes n'ont aucun périmètre, et que la règle est provisoire ;
 *   - il prévient qu'attribuer une région restreint le compte ;
 *   - le bouton reste inactif sans compte, région et motif ;
 *   - une attribution révoquée reste affichée.
 */

const h = vi.hoisted(() => ({ get: {} as Record<string, unknown>, posts: [] as { url: string; corps: unknown }[] }));
vi.mock("../../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string) => ({ data: h.get[url] })),
    post: vi.fn(async (url: string, corps?: unknown) => { h.posts.push({ url, corps }); return { data: {} }; }),
  },
}));

import { PerimetresTerritoriaux } from "./PerimetresTerritoriaux";

function rendre() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><PerimetresTerritoriaux /></QueryClientProvider>);
}

beforeEach(() => {
  h.posts.length = 0;
  h.get = {
    "/regions": [{ id: 3, nom: "Kindia" }],
    "/v2/perimetres": {
      regle: "…", comptesActifs: 12, comptesRestreints: 1, comptesSansPerimetre: 11,
      comptes: [{ id: "u-1", nomComplet: "Aissatou Bah", role: "GESTIONNAIRE" }],
      perimetres: [
        { id: "p-1", userId: "u-2", regionId: 3, debutLe: "2026-10-01", finLe: null, revoqueLe: "2026-10-10", motif: "mutation", enVigueur: false, user: { nomComplet: "Mamadou Diallo", role: "GESTIONNAIRE" }, region: { nom: "Kindia" } },
      ],
    },
  };
});

describe("PerimetresTerritoriaux", () => {
  it("dit l'état provisoire et prévient du resserrement", async () => {
    rendre();
    expect(await screen.findByText(/sans périmètre/)).toHaveTextContent("11");
    expect(screen.getByText(/règle provisoire/)).toBeInTheDocument();
    expect(screen.getByText(/restreint/)).toBeInTheDocument();
  });
  it("une attribution révoquée reste affichée, sans bouton de révocation", async () => {
    rendre();
    expect(await screen.findByText(/révoquée le/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Révoquer/ })).not.toBeInTheDocument();
  });
  it("attribue seulement avec compte, région et motif", async () => {
    rendre();
    const bouton = await screen.findByRole("button", { name: "Attribuer la région" });
    expect(bouton).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Compte"), { target: { value: "u-1" } });
    await screen.findByRole("option", { name: "Kindia" });
    fireEvent.change(screen.getByLabelText("Région"), { target: { value: "3" } });
    expect(bouton).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Motif/), { target: { value: "note de service 12/2026" } });
    fireEvent.click(bouton);
    await waitFor(() => expect(h.posts[0]).toEqual({ url: "/v2/perimetres", corps: { userId: "u-1", regionId: 3, motif: "note de service 12/2026" } }));
  });
});

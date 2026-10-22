import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Périmètres territoriaux : ce que ces tests défendent.
 *   - l'écran dit d'abord combien de comptes sont nationaux par défaut, et que la règle est provisoire ;
 *   - il prévient que rattacher une région restreint le compte ;
 *   - un administrateur n'est pas proposé à la restriction ;
 *   - l'enregistrement envoie la liste COMPLÈTE des régions cochées (remplacement, pas ajout).
 */

const h = vi.hoisted(() => ({ get: {} as Record<string, unknown>, puts: [] as { url: string; corps: unknown }[] }));
vi.mock("../../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string) => ({ data: h.get[url] })),
    put: vi.fn(async (url: string, corps?: unknown) => { h.puts.push({ url, corps }); return { data: {} }; }),
  },
}));

import { PerimetresTerritoriaux } from "./PerimetresTerritoriaux";

function rendre() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><PerimetresTerritoriaux /></QueryClientProvider>);
}

beforeEach(() => {
  h.puts.length = 0;
  h.get = {
    "/regions": [{ id: 3, nom: "Kindia" }, { id: 5, nom: "Labé" }],
    "/v2/perimetres": {
      comptesNationauxParDefaut: 1,
      comptes: [
        { id: "a-1", email: "a@x", nomComplet: "Admin Principal", role: "ADMIN", regions: [], perimetre: "NATIONAL", nationalParDefaut: false },
        { id: "u-1", email: "u@x", nomComplet: "Aissatou Bah", role: "GESTIONNAIRE", regions: [{ id: 3, nom: "Kindia" }], perimetre: "REGIONAL", nationalParDefaut: false },
        { id: "u-2", email: "v@x", nomComplet: "Mamadou Diallo", role: "INSPECTEUR", regions: [], perimetre: "NATIONAL", nationalParDefaut: true },
      ],
    },
  };
});

describe("PerimetresTerritoriaux", () => {
  it("dit l'état provisoire, prévient du resserrement et ne propose pas l'administrateur", async () => {
    rendre();
    expect(await screen.findByText(/national\(aux\) par défaut/)).toHaveTextContent("1");
    expect(screen.getByText(/règle provisoire/)).toBeInTheDocument();
    expect(screen.getByText(/restreint/)).toBeInTheDocument();
    expect(screen.getByText("National (administrateur)")).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Admin Principal/ })).not.toBeInTheDocument();
  });
  it("enregistre la liste complète des régions cochées pour le compte", async () => {
    rendre();
    fireEvent.change(await screen.findByLabelText("Compte"), { target: { value: "u-1" } });
    const labe = await screen.findByLabelText("Labé");
    expect(screen.getByLabelText("Kindia")).toBeChecked();
    fireEvent.click(labe);
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer le périmètre" }));
    await waitFor(() => expect(h.puts[0]).toEqual({ url: "/v2/perimetres/u-1", corps: { regionIds: [3, 5] } }));
  });
  it("tout décocher remet le compte au périmètre national", async () => {
    rendre();
    fireEvent.change(await screen.findByLabelText("Compte"), { target: { value: "u-1" } });
    fireEvent.click(await screen.findByLabelText("Kindia"));
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer le périmètre" }));
    await waitFor(() => expect(h.puts[0]).toEqual({ url: "/v2/perimetres/u-1", corps: { regionIds: [] } }));
  });
});

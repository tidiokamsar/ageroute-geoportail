import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Prévisions budgétaires : ce que ces tests défendent.
 *   - AUCUN champ n'est prérempli, et le bouton reste inactif tant que l'année,
 *     l'intitulé et le montant ne sont pas posés — un budget ne se devine pas ;
 *   - le montant part en CHAÎNE de chiffres (au-delà de 2^53, un nombre JSON ment) ;
 *   - toute prévision naît PROPOSÉE : le statut n'est offert qu'en édition, jamais
 *     à la création — l'arbitrage est un acte séparé ;
 *   - un LECTEUR voit la liste mais aucun bouton d'écriture.

 * (Frappe directe des valeurs complètes plutôt que touche par touche : la frappe
 * unitaire ne prouve rien de plus ici et coûtait le budget du test sur poste chargé,
 * leçon du 19/10 sur DefautTerrainPage.)
 */
const h = vi.hoisted(() => ({
  role: "GESTIONNAIRE",
  patch: [] as { url: string; corps: unknown }[],
  posts: [] as { url: string; corps: unknown }[],
}));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u-gest", role: h.role } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string) => {
      if (url === "/v2/programmation") {
        return { data: { data: [], total: 0 } };
      }
      if (url === "/troncons") {
        return { data: { data: [{ id: "t-1", code: "GN N0001", nom: "Conakry - Coyah" }] } };
      }
      return { data: {} };
    }),
    post: vi.fn(async (url: string, corps?: unknown) => { h.posts.push({ url, corps }); return { data: { id: "p-2" } }; }),
    patch: vi.fn(async (url: string, corps?: unknown) => { h.patch.push({ url, corps }); return { data: { id: "p-1" } }; }),
  },
}));

import { PrevisionsBudgetaires } from "./PrevisionsBudgetaires";

function rendre() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><PrevisionsBudgetaires /></QueryClientProvider>);
}

beforeEach(() => {
  h.role = "GESTIONNAIRE";
  h.posts.length = 0;
  h.patch.length = 0;
});

describe("PrevisionsBudgetaires", () => {
  it("rien n'est prérempli et le bouton reste inactif tant que le requis manque", async () => {
    const u = userEvent.setup({ delay: null });
    rendre();
    const annee = await screen.findByLabelText(/Année \*/);
    expect((annee as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(/Intitulé \*/) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(/Montant prévu \(GNF\) \*/) as HTMLInputElement).value).toBe("");
    const poser = screen.getByRole("button", { name: "Poser la prévision" });
    expect(poser).toBeDisabled();

    // L'intitulé seul ne suffit pas.
    await u.type(screen.getByLabelText(/Intitulé \*/), "Réhabilitation RN1");
    expect(screen.getByRole("button", { name: "Poser la prévision" })).toBeDisabled();
  });

  it("pose une prévision PROPOSÉE, montant en chaîne, sans statut dans le corps", async () => {
    const u = userEvent.setup({ delay: null });
    rendre();
    await u.type(await screen.findByLabelText(/Année \*/), "2027");
    await u.type(screen.getByLabelText(/Intitulé \*/), "Réhabilitation RN1 Conakry-Kindia");
    await u.type(screen.getByLabelText(/Montant prévu \(GNF\) \*/), "2400000000");
    await u.type(screen.getByLabelText(/Bailleur/), "AFD");
    await u.click(screen.getByRole("button", { name: "Poser la prévision" }));

    await waitFor(() => expect(h.posts).toHaveLength(1));
    expect(h.posts[0].url).toBe("/v2/programmation");
    expect(h.posts[0].corps).toMatchObject({
      annee: 2027, intitule: "Réhabilitation RN1 Conakry-Kindia",
      montantPrevuGnf: "2400000000", bailleur: "AFD",
    });
    // Une création ne porte JAMAIS de statut : elle naît PROPOSÉE côté serveur.
    expect(h.posts[0].corps).not.toHaveProperty("statut");
  }, 15000);

  it("refuse en face un montant qui n'est pas une chaîne de chiffres", async () => {
    const u = userEvent.setup({ delay: null });
    rendre();
    await u.type(await screen.findByLabelText(/Année \*/), "2027");
    await u.type(screen.getByLabelText(/Intitulé \*/), "Renforcement RN2");
    await u.type(screen.getByLabelText(/Montant prévu \(GNF\) \*/), "12,5");
    expect(screen.getByRole("button", { name: "Poser la prévision" })).toBeDisabled();
  });

  it("un LECTEUR voit la liste mais aucun bouton d'écriture", async () => {
    h.role = "LECTEUR";
    rendre();
    await screen.findByText(/Aucune prévision saisie/);
    expect(screen.queryByRole("button", { name: "Poser la prévision" })).not.toBeInTheDocument();
  });
});

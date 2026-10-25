import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../lib/api", () => ({ api: { get: vi.fn(async () => ({ data: [] })), post: vi.fn(async () => ({ data: {} })), put: vi.fn(async () => ({ data: {} })) } }));

import { FicheChildManager } from "./FicheChildManager";

/**
 * Garde anti-perte de saisie dans la fiche d'un tronçon (ajout d'un ouvrage, d'un chantier...).
 * Avant, fermer le modal avec Echap, un clic hors zone ou la croix jetait la saisie sans rien dire :
 * le modal ne recevait pas `sale`.
 */
function rendre() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <FicheChildManager
        tronconId="t-1" endpoint="ouvrages" title="Ouvrage"
        fields={[{ name: "nom", label: "Nom", type: "text", required: true }]}
        items={[]} renderItem={() => ""} emptyLabel="Aucun ouvrage" canWrite
      />
    </QueryClientProvider>,
  );
}

describe("FicheChildManager : fermeture avec saisie", () => {
  it("ferme sans demander tant que le formulaire est intact", async () => {
    const u = userEvent.setup({ delay: null });
    rendre();
    await u.click(screen.getByRole("button", { name: "+ Ajouter" }));
    await screen.findByLabelText("Nom");
    await u.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByLabelText("Nom")).not.toBeInTheDocument());
  });

  it("demande confirmation quand une saisie est en cours, puis garde ou abandonne", async () => {
    const u = userEvent.setup({ delay: null });
    rendre();
    await u.click(screen.getByRole("button", { name: "+ Ajouter" }));
    await u.type(await screen.findByLabelText("Nom"), "Pont de Coyah");
    await u.keyboard("{Escape}");
    expect(await screen.findByText(/Des modifications n'ont pas été enregistrées/)).toBeInTheDocument();

    await u.click(screen.getByRole("button", { name: "Continuer la saisie" }));
    expect(screen.getByLabelText("Nom")).toHaveValue("Pont de Coyah");

    await u.keyboard("{Escape}");
    await u.click(await screen.findByRole("button", { name: "Fermer sans enregistrer" }));
    await waitFor(() => expect(screen.queryByLabelText("Nom")).not.toBeInTheDocument());
  });
});

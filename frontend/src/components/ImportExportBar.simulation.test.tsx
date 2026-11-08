import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Import simulé (BDRI, lot H) : ce que ces tests défendent.
 *   - le fichier est d'abord SIMULÉ (`simulation=true`) et l'écran dit que rien n'a été écrit ;
 *   - les mises à jour sont montrées champ par champ et exigent une confirmation explicite ;
 *   - l'import réel ne part qu'au geste, avec `confirmer=true` quand des fiches existantes changent ;
 *   - le rapport se télécharge ; sans `simulation`, l'import reste direct (aucune régression des autres pages).
 */
const h = vi.hoisted(() => ({ posts: [] as { url: string; params?: Record<string, unknown> }[] }));
vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async () => ({ data: new Blob(["x"]) })),
    post: vi.fn(async (url: string, _f: unknown, cfg?: { params?: Record<string, unknown> }) => {
      h.posts.push({ url, params: cfg?.params });
      if (cfg?.params?.simulation) {
        return { data: {
          simulation: true, created: 1, updated: 1, unchanged: 2, errors: [{ row: 5, message: 'Région "Atlantide" introuvable' }],
          avertissements: [{ row: 2, message: "Doublon potentiel : le nom est déjà porté par GN N0001" }],
          lignes: [{ row: 2, code: "A", action: "CREER" }, { row: 3, code: "B", action: "METTRE_A_JOUR", changements: [{ champ: "longueurKm", actuelle: 10, nouvelle: 12.5 }] }],
        } };
      }
      return { data: { simulation: false, created: 1, updated: 1, unchanged: 2, errors: [] } };
    }),
  },
}));

import { ImportExportBar } from "./ImportExportBar";

const rendre = (simulation?: boolean) => render(
  <QueryClientProvider client={new QueryClient()}><ImportExportBar endpoint="troncons" filenamePrefix="troncons" simulation={simulation} /></QueryClientProvider>,
);
const choisirFichier = () => {
  fireEvent.click(screen.getByRole("button", { name: "Importer" }));
  fireEvent.change(screen.getByLabelText("Fichier Excel à importer"), { target: { files: [new File(["x"], "troncons.xlsx")] } });
};

beforeEach(() => { h.posts.length = 0; URL.createObjectURL = vi.fn(() => "blob:x"); URL.revokeObjectURL = vi.fn(); });

describe("ImportExportBar avec simulation", () => {
  it("simule d'abord et dit que rien n'a été écrit ; montre changements, avertissements et erreurs", async () => {
    rendre(true);
    choisirFichier();
    expect(await screen.findByText(/Simulation : 1 à créer, 1 à mettre à jour, 2 inchangée\(s\), 1 en erreur\. Rien n'a été écrit\./)).toBeInTheDocument();
    expect(h.posts).toEqual([{ url: "/troncons/import", params: { simulation: "true" } }]);
    expect(screen.getByText(/Ligne 3 \(B\) : longueurKm 10 → 12.5/)).toBeInTheDocument();
    expect(screen.getByText(/Doublon potentiel/)).toBeInTheDocument();
    expect(screen.getByText(/Atlantide/)).toBeInTheDocument();
  });
  it("les mises à jour exigent la confirmation ; l'import réel part alors avec confirmer=true", async () => {
    rendre(true);
    choisirFichier();
    const importer = await screen.findByRole("button", { name: "Importer 2 ligne(s)" });
    expect(importer).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/Je confirme les 1 mise\(s\) à jour/));
    fireEvent.click(importer);
    await waitFor(() => expect(h.posts[1]).toEqual({ url: "/troncons/import", params: { confirmer: "true" } }));
    expect(await screen.findByText(/1 ligne\(s\) créée\(s\), 1 mise\(s\) à jour, 2 inchangée\(s\)/)).toBeInTheDocument();
  });
  it("le rapport se télécharge en CSV", async () => {
    rendre(true);
    choisirFichier();
    fireEvent.click(await screen.findByRole("button", { name: /Télécharger le rapport/ }));
    expect(URL.createObjectURL).toHaveBeenCalled();
  });
});

describe("ImportExportBar sans simulation", () => {
  it("l'import reste direct, sans paramètre", async () => {
    rendre();
    choisirFichier();
    await waitFor(() => expect(h.posts).toEqual([{ url: "/troncons/import", params: undefined }]));
  });
});

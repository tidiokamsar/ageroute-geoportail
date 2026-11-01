import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Barèmes de coût : ce que ces tests défendent.
 *   - l'écran DIT ce qui bloque : les lignes non approuvées se voient, et le bouton
 *     Approuver reste inactif tant que millésime ou largeur manque — on ne signe pas
 *     un prix illisible ;
 *   - toute édition part des champs réels de la ligne (vides pour les neuf d'origine :
 *     rien n'est deviné) et le bouton Enregistrer reste inactif tant que le coût
 *     n'est pas une chaîne de chiffres ;
 *   - un GESTIONNAIRE paramètre mais n'approuve pas : l'approbation est ADMIN.
 */
const h = vi.hoisted(() => ({
  role: "ADMIN",
  ligne: {
    id: 3, familleRevetement: "bitume", etatDepart: "CRITIQUE", typeIntervention: "reconstruction",
    coutKmGnf: "3500000000", code: null, libelle: null, source: "standard_initial", version: 1,
    approuveLe: null, approuvePar: null, anneeReference: null, largeurChausseeM: null, commentaire: null,
  },
  patch: [] as { url: string; corps: unknown }[],
  posts: [] as { url: string }[],
}));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u-1", role: h.role } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async () => ({ data: { data: [{ ...h.ligne }] } })),
    patch: vi.fn(async (url: string, corps?: unknown) => { h.patch.push({ url, corps }); return { data: { ...h.ligne } }; }),
    post: vi.fn(async (url: string) => { h.posts.push({ url }); return { data: {} }; }),
  },
}));

import { BaremesPage } from "./BaremesPage";

function rendre() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><BaremesPage /></QueryClientProvider>);
}

beforeEach(() => {
  h.role = "ADMIN";
  h.patch.length = 0;
  h.posts.length = 0;
  h.ligne.anneeReference = null;
  h.ligne.largeurChausseeM = null;
  h.ligne.approuveLe = null;
});

describe("BaremesPage", () => {
  it("affiche la ligne, son coût en clair, et Approuver inactif tant que millésime et largeur manquent", async () => {
    rendre();
    expect(await screen.findByText(/Bitume/)).toBeInTheDocument();
    expect(screen.getByText(/3,5 Md GNF\/km/)).toBeInTheDocument();
    const approuver = screen.getByRole("button", { name: "Approuver" });
    expect(approuver).toBeDisabled();
    expect(approuver).toHaveAttribute("title", expect.stringContaining("millésime"));
  });

  it("l'édition part vide sur les champs inconnus et n'enregistre pas un coût non numérique", async () => {
    const u = userEvent.setup({ delay: null });
    rendre();
    await u.click(await screen.findByRole("button", { name: /Modifier la ligne bitume/ }));
    const cout = await screen.findByLabelText(/Coût par kilomètre en GNF/);
    expect((cout as HTMLInputElement).value).toBe("3500000000");
    const annee = screen.getByLabelText(/Millésime/);
    expect((annee as HTMLInputElement).value).toBe("");
    await u.clear(cout);
    await u.type(cout, "12,5");
    expect(screen.getByRole("button", { name: "Enregistrer" })).toBeDisabled();
  }, 15000);

  it("enregistre millésime et largeur posés à la main", async () => {
    const u = userEvent.setup({ delay: null });
    rendre();
    await u.click(await screen.findByRole("button", { name: /Modifier la ligne bitume/ }));
    await u.type(screen.getByLabelText(/Millésime/), "2026");
    await u.type(screen.getByLabelText(/Largeur de chaussée en mètres/), "6.5");
    await u.click(screen.getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(h.patch).toHaveLength(1));
    expect(h.patch[0].corps).toMatchObject({ anneeReference: 2026, largeurChausseeM: 6.5 });
  }, 15000);

  it("un GESTIONNAIRE ne voit aucun bouton Approuver", async () => {
    h.role = "GESTIONNAIRE";
    rendre();
    await screen.findByText(/Bitume/);
    expect(screen.queryByRole("button", { name: "Approuver" })).not.toBeInTheDocument();
  });
});

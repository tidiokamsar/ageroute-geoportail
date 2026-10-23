import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * ChangerEtatCorridor — le corridor entier, une décision.
 *
 *   - rien ne part tant que l'état ET le motif (5 caractères minimum) ne sont pas
 *     posés : changer 80 tronçons d'un geste est un acte, il se motive ;
 *   - le POST emporte les identifiants du corridor, l'état et le motif ;
 *   - le compte rendu affiche « déjà à jour » : un « 0 modifié » ne doit pas
 *     ressembler à une panne.
 */
const h = vi.hoisted(() => ({
  posts: [] as { url: string; corps: unknown }[],
  reponse: { modifie: 2, inchanges: 1, introuvables: [] as string[] },
}));
vi.mock("../lib/api", () => ({
  api: {
    post: vi.fn(async (url: string, corps?: unknown) => {
      h.posts.push({ url, corps });
      return { data: h.reponse };
    }),
  },
}));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ChangerEtatCorridor } from "./ChangerEtatCorridor";

const IDS = ["t1", "t2", "t3"];

function rendre(onApplique: () => void = () => {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ChangerEtatCorridor ids={IDS} libelle="Mamou ↔ Faranah" onApplique={onApplique} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  h.posts = [];
  h.reponse = { modifie: 2, inchanges: 1, introuvables: [] };
});

describe("ChangerEtatCorridor", () => {
  it("n'ouvre le formulaire qu'au geste, et l'applique à tous les identifiants du corridor", async () => {
    const u = userEvent.setup({ delay: null });
    const onApplique = vi.fn();
    rendre(onApplique);
    await u.click(await screen.findByRole("button", { name: /Changer l'état du corridor \(3\)/ }));

    const etat = screen.getByLabelText(/Nouvel état \*/);
    expect((etat as HTMLSelectElement).value).toBe("");
    const motif = screen.getByLabelText(/Motif de la décision \*/);
    expect((motif as HTMLInputElement).value).toBe("");

    // Le motif seul ne suffit pas : pas d'état, pas d'envoi.
    await u.type(motif, "Campagne Coyah-Kindia octobre 2026");
    expect(screen.getByRole("button", { name: /Appliquer à 3 tronçon\(s\)/ })).toBeDisabled();

    await u.selectOptions(etat, "MOYEN");
    await u.click(screen.getByRole("button", { name: /Appliquer à 3 tronçon\(s\)/ }));

    await waitFor(() => expect(h.posts).toHaveLength(1));
    expect(h.posts[0].url).toBe("/v2/troncons-corridor/bulk-etat");
    expect(h.posts[0].corps).toEqual({
      ids: IDS, etat: "MOYEN", motif: "Campagne Coyah-Kindia octobre 2026",
    });
    expect(onApplique).toHaveBeenCalled();
  });

  it("refuse un motif trop court et rend le compte rendu « déjà à jour »", async () => {
    const u = userEvent.setup({ delay: null });
    rendre();
    await u.click(await screen.findByRole("button", { name: /Changer l'état du corridor/ }));
    await u.selectOptions(screen.getByLabelText(/Nouvel état \*/), "BON");
    await u.type(screen.getByLabelText(/Motif de la décision \*/), "ok");
    expect(screen.getByRole("button", { name: /Appliquer/ })).toBeDisabled();

    // Motif valide maintenant, avec une réponse « tout était déjà à jour » :
    // le compte rendu doit le dire, pas faire croire à un échec.
    h.reponse = { modifie: 0, inchanges: 3, introuvables: [] };
    await u.clear(screen.getByLabelText(/Motif de la décision \*/));
    await u.type(screen.getByLabelText(/Motif de la décision \*/), "Confirmation de l'état connu");
    await u.click(screen.getByRole("button", { name: /Appliquer/ }));
    await waitFor(() => expect(h.posts).toHaveLength(1));
    expect(await screen.findByRole("status")).toHaveTextContent(/0 modifié\(s\), 3 déjà à jour/);
  }, 15000);
});

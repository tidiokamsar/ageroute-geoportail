import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * ChangerEtatCorridor — le corridor entier, une décision.
 *
 *   - rien ne part tant que l'état ET le motif (5 caractères minimum) ne sont pas
 *     posés : changer 80 tronçons d'un geste est un acte, il se motive ;
 *   - DEUX TEMPS : « Vérifier » ouvre un récapitulatif (nombre, état d'avant, état visé, motif, audit)
 *     et n'envoie RIEN ; « Revenir » ne change rien ; seul « Confirmer » envoie ;
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

function rendre(onApplique: () => void = () => {}, etatsActuels?: string[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ChangerEtatCorridor ids={IDS} libelle="Mamou ↔ Faranah" onApplique={onApplique} etatsActuels={etatsActuels} />
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
    expect(screen.getByRole("button", { name: /Vérifier avant d'appliquer à 3 tronçon\(s\)/ })).toBeDisabled();

    await u.selectOptions(etat, "MOYEN");
    await u.click(screen.getByRole("button", { name: /Vérifier avant d'appliquer à 3 tronçon\(s\)/ }));
    // Premier temps : le récapitulatif, aucun envoi.
    expect(h.posts).toHaveLength(0);
    await u.click(screen.getByRole("button", { name: "Confirmer" }));

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
    expect(screen.getByRole("button", { name: /Vérifier/ })).toBeDisabled();

    // Motif valide maintenant, avec une réponse « tout était déjà à jour » :
    // le compte rendu doit le dire, pas faire croire à un échec.
    h.reponse = { modifie: 0, inchanges: 3, introuvables: [] };
    await u.clear(screen.getByLabelText(/Motif de la décision \*/));
    await u.type(screen.getByLabelText(/Motif de la décision \*/), "Confirmation de l'état connu");
    await u.click(screen.getByRole("button", { name: /Vérifier/ }));
    await u.click(screen.getByRole("button", { name: "Confirmer" }));
    await waitFor(() => expect(h.posts).toHaveLength(1));
    expect(await screen.findByRole("status")).toHaveTextContent(/0 modifié\(s\), 3 déjà à jour/);
  }, 15000);
});

describe("ChangerEtatCorridor : confirmation à deux temps", () => {
  async function jusquAuRecapitulatif(etatsActuels?: string[]) {
    const u = userEvent.setup({ delay: null });
    rendre(() => {}, etatsActuels);
    await u.click(await screen.findByRole("button", { name: /Changer l'état du corridor/ }));
    await u.selectOptions(screen.getByLabelText(/Nouvel état \*/), "MAUVAIS");
    await u.type(screen.getByLabelText(/Motif de la décision \*/), "Constat de la campagne d'octobre");
    await u.click(screen.getByRole("button", { name: /Vérifier avant d'appliquer/ }));
    return u;
  }

  it("le récapitulatif dit combien, de quel état vers quel état, le motif et l'audit, sans rien envoyer", async () => {
    await jusquAuRecapitulatif(["BON", "BON", "MOYEN"]);
    const recap = screen.getByRole("group", { name: /Récapitulatif avant application/ });
    expect(recap).toHaveTextContent("3 tronçon(s)");
    expect(recap).toHaveTextContent("actuel (2 bon, 1 moyen)");
    expect(recap).toHaveTextContent("vers l'état Mauvais");
    expect(recap).toHaveTextContent("Constat de la campagne d'octobre");
    expect(recap).toHaveTextContent("L'état précédent de chaque tronçon reste dans l'audit");
    expect(h.posts).toHaveLength(0);
  });

  it("« Revenir » ramène à la saisie, intacte, sans envoi", async () => {
    const u = await jusquAuRecapitulatif();
    await u.click(screen.getByRole("button", { name: "Revenir" }));
    expect((screen.getByLabelText(/Nouvel état \*/) as HTMLSelectElement).value).toBe("MAUVAIS");
    expect((screen.getByLabelText(/Motif de la décision \*/) as HTMLInputElement).value).toBe("Constat de la campagne d'octobre");
    expect(h.posts).toHaveLength(0);
  });

  it("sans états d'avant connus, le récapitulatif ne prétend pas en connaître un seul", async () => {
    await jusquAuRecapitulatif();
    expect(screen.getByRole("group", { name: /Récapitulatif/ })).toHaveTextContent("de l'état actuel de chacun");
  });
});

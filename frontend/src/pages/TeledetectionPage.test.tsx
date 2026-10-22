import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Ecran de teledetection (partie E) : ce que ces tests defendent.
 *   - l'ecran dit qu'une detection est une proposition ;
 *   - une methode sans verdict affiche « aucun verdict », pas 0 % ;
 *   - le verdict exige ce que le terrain a constate et la reference du constat ;
 *   - un LECTEUR ne voit ni verdict ni depeche ;
 *   - les anomalies de coherence sont dites, bloquantes et a examiner distinguees.
 */

const h = vi.hoisted(() => ({ role: "GESTIONNAIRE", get: {} as Record<string, unknown>, posts: [] as { url: string; corps: unknown }[] }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u", role: h.role } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string) => ({ data: h.get[url] ?? {} })),
    post: vi.fn(async (url: string, corps?: unknown) => { h.posts.push({ url, corps }); return { data: { code: "VER-TD-1" } }; }),
  },
}));

import { TeledetectionPage } from "./TeledetectionPage";

const proposition = {
  id: "pr-1", type: "INONDATION", methode: "seuil-sar v0", score: 0.7, statut: "A_VERIFIER", distanceTronconM: 18.4, missionId: null,
  motifVerdict: null, constatRef: null, produit: { code: "S1", source: "Sentinel-1 GRD", dateAcquisition: "2026-10-02T00:00:00Z" },
  troncon: { code: "GN N0001", nom: "Conakry - Coyah" },
};

function rendre() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><TeledetectionPage /></QueryClientProvider>);
}

beforeEach(() => {
  h.role = "GESTIONNAIRE"; h.posts.length = 0;
  h.get = {
    "/v2/teledetection/propositions": { propositions: [proposition] },
    "/v2/teledetection/precision": { lignes: [{ type: "INONDATION", methode: "seuil-sar v0", total: 1, aVerifier: 1, confirmees: 0, infirmees: 0, precision: null }] },
    "/v2/teledetection/produits": { produits: [] },
  };
});

describe("TeledetectionPage", () => {
  it("dit qu'une detection est une proposition, et qu'une methode sans verdict n'a pas de precision", async () => {
    rendre();
    expect(await screen.findByText(/Rattachée à GN N0001/)).toBeInTheDocument();
    expect(screen.getByText(/jamais des données officielles/)).toBeInTheDocument();
    expect(await screen.findByText("— (aucun verdict)")).toBeInTheDocument();
    expect(screen.queryByText("0 %")).not.toBeInTheDocument();
    expect(await screen.findByText(/aucune source n'a encore été choisie/)).toBeInTheDocument();
  });

  it("le verdict exige le constat et sa reference", async () => {
    const u = userEvent.setup({ delay: null });
    rendre();
    // Ancre d'abord sur la proposition affichee : sous charge, la liste arrive apres le delai
    // d'attente par defaut de findByRole (1 s).
    await screen.findByText(/Rattachée à GN N0001/, undefined, { timeout: 10_000 });
    const enregistrer = screen.getByRole("button", { name: "Enregistrer le verdict" });
    await u.selectOptions(screen.getByLabelText(/^Verdict/), "INFIRMEE");
    fireEvent.change(screen.getByLabelText(/Ce que le terrain a constaté/), { target: { value: "Chaussee seche" } });
    expect(enregistrer).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Référence du constat/), { target: { value: "observation:O-1" } });
    await u.click(enregistrer);
    await waitFor(() => expect(h.posts[0]).toEqual({
      url: "/v2/teledetection/propositions/pr-1/verdict", corps: { statut: "INFIRMEE", motif: "Chaussee seche", constatRef: "observation:O-1" },
    }));
  }, 30_000);

  it("un LECTEUR ne voit ni verdict ni depeche", async () => {
    h.role = "LECTEUR";
    rendre();
    expect(await screen.findByText(/Rattachée à GN N0001/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enregistrer le verdict" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dépêcher une vérification" })).not.toBeInTheDocument();
  });

  it("dit les anomalies de coherence, bloquantes et a examiner distinguees", async () => {
    h.get["/v2/teledetection/coherence"] = {
      bloquantes: 1, aExaminer: 1, tronquee: false,
      anomalies: [
        { code: "HORS_EMPRISE", gravite: "BLOQUANTE", propositionId: "pr-9", produitId: "p-1", detail: "geometrie hors de l'emprise du produit" },
        { code: "MISSION_SANS_VERDICT", gravite: "A_EXAMINER", propositionId: "pr-8", produitId: "p-1", detail: "mission VER-1 TERMINEE, aucun verdict rendu" },
      ],
    };
    rendre();
    expect(await screen.findByText(/Hors de l'emprise du produit/)).toBeInTheDocument();
    expect(screen.getByText(/Mission close sans verdict/)).toBeInTheDocument();
    expect(screen.getByText("Bloquante")).toBeInTheDocument();
    expect(screen.getByText("À examiner")).toBeInTheDocument();
  });

  it("sans anomalie, le dit", async () => {
    h.get["/v2/teledetection/coherence"] = { bloquantes: 0, aExaminer: 0, tronquee: false, anomalies: [] };
    rendre();
    expect(await screen.findByText("Aucune anomalie.")).toBeInTheDocument();
  });
});

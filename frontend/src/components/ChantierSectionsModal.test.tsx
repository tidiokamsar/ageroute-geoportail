import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { violationsAccessibilite } from "../test/accessibilite";

/**
 * Tronçons et sections d'un chantier, et chantiers d'un tronçon (BDRI, lot G) : ce que ces tests défendent.
 *   - lier le tronçon entier n'envoie aucune borne ; un intervalle exige début et fin, la fin après le début ;
 *   - un retrait exige un motif ; un lien retiré reste affiché, avec son auteur et son motif ;
 *   - un LECTEUR ne voit aucun geste ;
 *   - la fiche du tronçon classe les inspections avant / pendant / après le chantier ; zéro violation d'accessibilité.
 */
const h = vi.hoisted(() => ({ role: "GESTIONNAIRE", posts: [] as { url: string; corps: unknown }[] }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u", role: h.role } }), canWrite: (r: string) => r === "ADMIN" || r === "GESTIONNAIRE" }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("./TronconPicker", () => ({
  TronconPicker: ({ id, onChange }: { id: string; onChange: (v: string) => void }) => <button id={id} type="button" onClick={() => onChange("t-b")}>choisir</button>,
}));
vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string) => {
      if (url.includes("/par-troncon/")) {
        return { data: { chantiers: [{
          chantier: { id: "c1", intitule: "Réhabilitation Coyah-Kindia", entreprise: "ETP", statut: "TERMINE", avancementPct: 100, dateDebutReelle: "2026-03-01", dateFinReelle: "2026-09-30" },
          principal: false, sections: [{ id: "s1", debutM: 200, finM: 800, portionId: null, retireLe: null }],
        }] } };
      }
      return { data: { sections: [
        { id: "s1", debutM: null, finM: null, portionId: null, commentaire: null, creeLe: "2026-10-01T08:00:00Z", retireLe: null, motifRetrait: null, troncon: { id: "t-a", code: "GN N0001", nom: "Coyah" }, creePar: { nomComplet: "Chef" }, retirePar: null },
        { id: "s2", debutM: 200, finM: 800, portionId: null, commentaire: null, creeLe: "2026-10-01T08:00:00Z", retireLe: "2026-10-10T08:00:00Z", motifRetrait: "emprise réduite", troncon: { id: "t-a", code: "GN N0001", nom: "Coyah" }, creePar: { nomComplet: "Chef" }, retirePar: { nomComplet: "Adjoint" } },
      ] } };
    }),
    post: vi.fn(async (url: string, corps: unknown) => { h.posts.push({ url, corps }); return { data: {} }; }),
  },
}));

import { ChantierSectionsModal } from "./ChantierSectionsModal";
import { ChantiersDuTroncon } from "./ChantiersDuTroncon";

const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const rendre = () => render(<QueryClientProvider client={qc()}><ChantierSectionsModal chantier={{ id: "c1", intitule: "Réhabilitation" }} onClose={() => {}} /></QueryClientProvider>);

beforeEach(() => { h.role = "GESTIONNAIRE"; h.posts.length = 0; });

describe("ChantierSectionsModal", () => {
  it("lier le tronçon entier n'envoie aucune borne", async () => {
    rendre();
    await screen.findAllByText(/GN N0001/);
    fireEvent.click(screen.getByRole("button", { name: "Tronçon" }));
    fireEvent.click(screen.getByRole("button", { name: "Lier" }));
    await waitFor(() => expect(h.posts[0]).toEqual({ url: "/v2/chantiers/c1/sections", corps: { tronconId: "t-b", commentaire: null } }));
  });
  it("un intervalle exige début et fin, la fin après le début", async () => {
    rendre();
    await screen.findAllByText(/GN N0001/);
    fireEvent.click(screen.getByRole("button", { name: "Tronçon" }));
    fireEvent.click(screen.getByLabelText(/Intervalle/));
    const lier = screen.getByRole("button", { name: "Lier" });
    fireEvent.change(screen.getByLabelText("Début (m)"), { target: { value: "800" } });
    fireEvent.change(screen.getByLabelText("Fin (m)"), { target: { value: "200" } });
    expect(lier).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Fin (m)"), { target: { value: "1200,5" } });
    fireEvent.click(lier);
    await waitFor(() => expect(h.posts[0].corps).toEqual({ tronconId: "t-b", debutM: 800, finM: 1200.5, commentaire: null }));
  });
  it("un retrait exige un motif ; un lien retiré reste affiché avec auteur et motif", async () => {
    rendre();
    expect(await screen.findByText(/retiré le .* par Adjoint : emprise réduite/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retirer" }));
    const confirmer = screen.getByRole("button", { name: "Confirmer le retrait" });
    expect(confirmer).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Motif du retrait"), { target: { value: "doublon de saisie" } });
    fireEvent.click(confirmer);
    await waitFor(() => expect(h.posts[0]).toEqual({ url: "/v2/chantiers/sections/s1/retrait", corps: { motif: "doublon de saisie" } }));
  });
  it("un LECTEUR ne voit aucun geste", async () => {
    h.role = "LECTEUR";
    rendre();
    await screen.findAllByText(/GN N0001/);
    expect(screen.queryByRole("button", { name: "Retirer" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Lier" })).not.toBeInTheDocument();
  });
});

describe("ChantiersDuTroncon", () => {
  it("classe les inspections avant / pendant / après le chantier ; aucune violation", async () => {
    const { container } = render(<QueryClientProvider client={qc()}><ChantiersDuTroncon tronconId="t-b" inspections={[
      { id: "i1", dateInspection: "2026-01-10", etatObserve: "MAUVAIS" }, { id: "i2", dateInspection: "2026-10-20", etatObserve: "BON" },
    ]} /></QueryClientProvider>);
    expect(await screen.findByText(/Lié par section · sections : 200 m → 800 m/)).toBeInTheDocument();
    expect(screen.getByText(/Inspections avant : 10\/01\/2026 \(mauvais\)/)).toBeInTheDocument();
    expect(screen.getByText(/Après : 20\/10\/2026 \(bon\)/)).toBeInTheDocument();
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

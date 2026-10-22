import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Registre des défauts : ce que ces tests défendent.
 *   - les filtres partent au serveur, la suite se charge par curseur ;
 *   - la fiche ne propose que les transitions d'état permises ;
 *   - seul l'auteur (ou un administrateur) voit la resoumission d'un relevé « à corriger »,
 *     et elle n'envoie que les mesures saisies ;
 *   - un LECTEUR ne voit aucun geste.
 */
const h = vi.hoisted(() => ({ role: "INSPECTEUR", gets: [] as { url: string; params?: Record<string, unknown> }[], posts: [] as { url: string; corps: unknown }[], fiche: {} as Record<string, unknown> }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u-1", role: h.role } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const ligne = (id: string, o: Record<string, unknown> = {}) => ({
  id, code: null, statutValidation: "VALIDE", etat: "ACTIF", traiteA: null, constateA: "2026-10-01T08:00:00Z", lat: 9.6, lon: -13.6,
  catalogue: { code: "NID", libelle: "Nid de poule", unite: "UNITE" }, constatePar: { id: "u-1", nomComplet: "Agent" }, medias: [], ...o,
});
vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string, cfg?: { params?: Record<string, unknown> }) => {
      h.gets.push({ url, params: cfg?.params });
      if (url === "/v2/defauts/catalogue") return { data: { catalogue: [{ code: "NID", libelle: "Nid de poule" }] } };
      if (url === "/v2/defauts") {
        return cfg?.params?.curseur ? { data: { defauts: [ligne("d-2")], curseurSuivant: null } } : { data: { defauts: [ligne("d-1")], curseurSuivant: "d-1" } };
      }
      return { data: h.fiche };
    }),
    post: vi.fn(async (url: string, corps: unknown) => { h.posts.push({ url, corps }); return { data: {} }; }),
  },
}));

import { DefautsRegistrePage, FicheDefaut } from "./DefautsRegistrePage";

const rendre = (el: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{el}</QueryClientProvider>);

beforeEach(() => {
  h.role = "INSPECTEUR"; h.gets.length = 0; h.posts.length = 0;
  h.fiche = { ...ligne("d-1"), catalogue: { code: "NID", libelle: "Nid de poule", unite: "UNITE", mesuresRequises: ["NOMBRE"], graviteMax: 4 }, validations: [], nombre: 3 };
});

describe("DefautsRegistrePage", () => {
  it("envoie les filtres et charge la suite par curseur", async () => {
    rendre(<DefautsRegistrePage />);
    await screen.findByText("Nid de poule", { selector: "td" });
    fireEvent.click(await screen.findByRole("button", { name: "Charger la suite" }));
    await waitFor(() => expect(h.gets.some((g) => g.params?.curseur === "d-1")).toBe(true));
    fireEvent.change(screen.getByLabelText("État physique"), { target: { value: "TRAITE" } });
    await waitFor(() => expect(h.gets.some((g) => g.url === "/v2/defauts" && g.params?.etat === "TRAITE")).toBe(true));
  });
});

describe("FicheDefaut", () => {
  it("ne propose que les transitions permises", async () => {
    rendre(<FicheDefaut id="d-1" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Marquer traité" }));
    expect(screen.getByRole("button", { name: "Marquer disparu" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remettre actif" })).not.toBeInTheDocument();
    await waitFor(() => expect(h.posts[0]).toEqual({ url: "/v2/defauts/d-1/etat", corps: { etat: "TRAITE" } }));
  });
  it("l'auteur resoumet un relevé à corriger avec les seules mesures saisies", async () => {
    h.fiche = { ...h.fiche, nombre: null, statutValidation: "A_CORRIGER", validations: [{ id: "v", statutAvant: "A_VALIDER", statutApres: "A_CORRIGER", commentaire: "Compter les nids", source: null, decideA: "2026-10-02T08:00:00Z" }] };
    rendre(<FicheDefaut id="d-1" onClose={() => {}} />);
    expect(await screen.findByText(/Demande du validateur/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resoumettre" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/^Nombre/), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Resoumettre" }));
    await waitFor(() => expect(h.posts[0]).toEqual({ url: "/v2/defauts/d-1/resoumettre", corps: { mesures: { nombre: 5 } } }));
  });
  it("un autre agent ne voit pas la resoumission ; un LECTEUR ne voit aucun geste", async () => {
    h.fiche = { ...h.fiche, statutValidation: "A_CORRIGER", constatePar: { id: "u-2", nomComplet: "Autre" } };
    const { unmount } = rendre(<FicheDefaut id="d-1" onClose={() => {}} />);
    await screen.findByRole("button", { name: "Marquer traité" });
    expect(screen.queryByRole("button", { name: "Resoumettre" })).not.toBeInTheDocument();
    unmount();
    h.role = "LECTEUR";
    rendre(<FicheDefaut id="d-1" onClose={() => {}} />);
    await screen.findByText("Nid de poule (NID)");
    expect(screen.queryByRole("button", { name: "Marquer traité" })).not.toBeInTheDocument();
  });
});

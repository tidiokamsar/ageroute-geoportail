import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { manquesFiche } from "../lib/inspectionTerrain";

/**
 * Fiche d'inspection terrain (BDRI, lot F) : ce que ces tests défendent.
 *   - le cache local prend TOUT le réseau classé (page par page), plus seulement les 200 premiers ;
 *   - la recherche locale filtre le référentiel caché (elle marche hors ligne) ;
 *   - constat, méthode, conditions, section et mission partent dans la saisie conservée hors ligne ;
 *   - une contradiction (aucun défaut ET une description) est annoncée et bloque l'enregistrement ;
 *   - l'avis d'un responsable : motif exigé pour un refus, aucune décision sur sa propre inspection.
 */
const h = vi.hoisted(() => ({ gets: [] as { url: string; params?: Record<string, unknown> }[], enregistres: [] as { payload: Record<string, unknown> }[], posts: [] as { url: string; corps: unknown }[] }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u-agent", role: "GESTIONNAIRE" } }), canWrite: () => true }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../hooks/useOfflineSync", () => ({ useOfflineSync: () => ({ online: true, pendingCount: 0, syncing: false }) }));
vi.mock("../lib/offlineSync", () => ({ refreshPendingCount: async () => undefined, syncPendingOfflineData: async () => undefined }));
vi.mock("../lib/offlineDb", () => ({
  addPendingInspection: vi.fn(async (p: { payload: Record<string, unknown> }) => { h.enregistres.push(p); }),
  getAllPending: vi.fn(async () => []),
}));
vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string, cfg?: { params?: Record<string, unknown> }) => {
      h.gets.push({ url, params: cfg?.params });
      if (url === "/troncons") {
        const page = Number(cfg?.params?.page ?? 1);
        const data = page === 1 ? [{ id: "t1", code: "GN N0001", nom: "Coyah" }] : [{ id: "t2", code: "GN N0902", nom: "Faranah" }];
        return { data: { data, totalPages: 2 } };
      }
      if (url === "/ouvrages") return { data: { data: [] } };
      if (url === "/v2/missions") return { data: [{ id: "m1", code: "MIS-1", intitule: "RN1", statut: "EN_COURS", assigneId: "u-agent", createurId: "chef" }, { id: "m2", code: "MIS-2", intitule: "Autre", statut: "EN_COURS", assigneId: "x", createurId: "y" }] };
      if (url.endsWith("/validations")) return { data: { validations: [] } };
      return { data: {} };
    }),
    post: vi.fn(async (url: string, corps: unknown) => { h.posts.push({ url, corps }); return { data: {} }; }),
  },
}));

import { InspectionTerrainPage } from "./InspectionTerrainPage";
import { AvisInspectionModal } from "../components/AvisInspectionModal";

const rendre = () => render(<MemoryRouter><QueryClientProvider client={new QueryClient()}><InspectionTerrainPage /></QueryClientProvider></MemoryRouter>);

beforeEach(() => { h.gets.length = 0; h.enregistres.length = 0; h.posts.length = 0; localStorage.clear(); });

describe("manquesFiche", () => {
  const base = { constatDefauts: "", defautsConstates: "", etatObserve: "BON", debutM: "", finM: "" };
  it.each([
    [{ constatDefauts: "DEFAUTS_RELEVES" }, /se décrivent/],
    [{ constatDefauts: "AUCUN_DEFAUT_OBSERVE", defautsConstates: "fissures" }, /contredit/],
    [{ constatDefauts: "NON_INSPECTE" }, /Non évalué/],
    [{ debutM: "100" }, /un début et une fin/],
    [{ debutM: "600", finM: "100" }, /après son début/],
  ])("%j est annoncé", (o, motif) => {
    expect(manquesFiche({ ...base, ...o })[0]).toMatch(motif);
  });
  it("une fiche cohérente ne dit rien", () => {
    expect(manquesFiche({ ...base, constatDefauts: "AUCUN_DEFAUT_OBSERVE", debutM: "0", finM: "250,5" })).toEqual([]);
  });
});

describe("InspectionTerrainPage", () => {
  it("cache TOUT le réseau classé, page par page, et seulement les missions de l'agent", async () => {
    rendre();
    expect(await screen.findByRole("option", { name: /GN N0902 — Faranah/ })).toBeInTheDocument();
    expect(h.gets.filter((g) => g.url === "/troncons").map((g) => g.params?.page)).toEqual([1, 2]);
    const mission = screen.getByLabelText("Mission") as HTMLSelectElement;
    expect([...mission.options].map((o) => o.value)).toEqual(["", "m1"]);
  });
  it("la recherche locale filtre le référentiel caché", async () => {
    rendre();
    await screen.findByRole("option", { name: /Faranah/ });
    fireEvent.change(screen.getByLabelText("Rechercher dans le référentiel local"), { target: { value: "coyah" } });
    expect(screen.queryByRole("option", { name: /Faranah/ })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Coyah/ })).toBeInTheDocument();
  });
  it("constat, méthode, conditions, section et mission partent dans la saisie hors ligne", async () => {
    rendre();
    await screen.findByRole("option", { name: /Faranah/ });
    fireEvent.change(screen.getByLabelText("Tronçon inspecté"), { target: { value: "t2" } });
    fireEvent.change(screen.getByLabelText("Constat des défauts"), { target: { value: "AUCUN_DEFAUT_OBSERVE" } });
    fireEvent.change(screen.getByLabelText("Méthode d'observation"), { target: { value: "VISUELLE_EN_VEHICULE" } });
    fireEvent.change(screen.getByLabelText("Conditions d'observation"), { target: { value: "temps sec" } });
    fireEvent.change(screen.getByLabelText(/Section observée : début/), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText(/Section observée : fin/), { target: { value: "600" } });
    fireEvent.change(screen.getByLabelText("Mission"), { target: { value: "m1" } });
    fireEvent.click(screen.getByRole("button", { name: /Enregistrer/ }));
    await waitFor(() => expect(h.enregistres[0]?.payload).toMatchObject({
      tronconId: "t2", constatDefauts: "AUCUN_DEFAUT_OBSERVE", methodeObservation: "VISUELLE_EN_VEHICULE", conditionsObservation: "temps sec", debutM: 100, finM: 600, missionId: "m1",
    }));
  });
  it("une contradiction est annoncée et rien n'est enregistré", async () => {
    rendre();
    await screen.findByRole("option", { name: /Faranah/ });
    fireEvent.change(screen.getByLabelText("Tronçon inspecté"), { target: { value: "t1" } });
    fireEvent.change(screen.getByLabelText("Constat des défauts"), { target: { value: "AUCUN_DEFAUT_OBSERVE" } });
    fireEvent.change(screen.getByLabelText("Défauts constatés"), { target: { value: "nids-de-poule" } });
    expect(screen.getByRole("alert")).toHaveTextContent(/contredit/);
    fireEvent.click(screen.getByRole("button", { name: /Enregistrer/ }));
    await new Promise((r) => setTimeout(r, 50));
    expect(h.enregistres).toEqual([]);
  });
});

describe("AvisInspectionModal", () => {
  const rendreAvis = (inspecteurId: string, statutValidation: string | null = null) => render(
    <QueryClientProvider client={new QueryClient()}><AvisInspectionModal inspection={{ id: "i1", inspecteurId, statutValidation, libelle: "GN N0001" }} onClose={() => {}} /></QueryClientProvider>,
  );
  it("un refus exige un motif ; l'avis part avec la décision", async () => {
    rendreAvis("autre");
    fireEvent.change(await screen.findByLabelText("Décision"), { target: { value: "REJETE" } });
    const bouton = screen.getByRole("button", { name: "Enregistrer l'avis" });
    expect(bouton).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Commentaire/), { target: { value: "photos illisibles" } });
    fireEvent.click(bouton);
    await waitFor(() => expect(h.posts[0]).toEqual({ url: "/v2/inspections/i1/validation", corps: { decision: "REJETE", commentaire: "photos illisibles" } }));
  });
  it("aucune décision sur sa propre inspection ; un avis définitif ne se rouvre pas", async () => {
    const { unmount } = rendreAvis("u-agent");
    expect(await screen.findByText(/une autre personne doit donner l'avis/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Décision")).not.toBeInTheDocument();
    unmount();
    rendreAvis("autre", "VALIDE");
    expect(await screen.findByText(/Avis définitif/)).toBeInTheDocument();
  });
});

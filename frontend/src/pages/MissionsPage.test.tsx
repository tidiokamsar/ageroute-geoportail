import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TRANSITIONS_MISSION, versIso } from "../lib/missions";

/**
 * Missions terrain : ce que ces tests défendent.
 *   - la table des transitions est EXACTEMENT celle du serveur (relue dans son fichier) ;
 *   - la création n'envoie que les champs remplis, dates en ISO, et refuse une fin avant le début ;
 *   - la fiche ne propose que les transitions permises ; une mission annulée n'en propose aucune ;
 *   - un agent ne voit pas « Nouvelle mission ».
 */
const h = vi.hoisted(() => ({ role: "GESTIONNAIRE", posts: [] as { url: string; corps: unknown }[], fiche: {} as Record<string, unknown> }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u", role: h.role } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string) => {
      if (url === "/v2/missions") return { data: [{ id: "m-1", code: "MIS-1", intitule: "RN1 Coyah", type: "INSPECTION", statut: "EN_COURS", debutPrevu: null }] };
      if (url === "/v2/exploitation/veille/personnes") return { data: { personnes: [{ id: "a-1", nomComplet: "Agent" }] } };
      if (url === "/regions") return { data: [{ id: 3, nom: "Kankan" }] };
      return { data: h.fiche };
    }),
    post: vi.fn(async (url: string, corps: unknown) => { h.posts.push({ url, corps }); return { data: { id: "m-2", code: "MIS-2" } }; }),
  },
}));

import { FicheMission, MissionsPage } from "./MissionsPage";

const rendre = (el: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{el}</QueryClientProvider>);
const fiche = (statut: string) => ({ id: "m-1", code: "MIS-1", intitule: "RN1", type: "INSPECTION", statut, debutPrevu: null, finPrevue: null, debutReel: null, finReelle: null, vehicule: null, equipe: null, traces: [] });

beforeEach(() => { h.role = "GESTIONNAIRE"; h.posts.length = 0; h.fiche = fiche("EN_COURS"); });

describe("transitions de mission", () => {
  it("sont celles du serveur", () => {
    const src = readFileSync(join(__dirname, "..", "..", "..", "backend", "src", "field", "missions.regles.ts"), "utf8");
    const debut = src.indexOf("TRANSITIONS:");
    const bloc = src.slice(debut, src.indexOf("};", debut));
    const serveur: Record<string, string[]> = {};
    for (const m of bloc.matchAll(/(\w+):\s*\[([^\]]*)\]/g)) serveur[m[1]] = [...m[2].matchAll(/"(\w+)"/g)].map((x) => x[1]);
    expect(Object.keys(serveur)).toHaveLength(8);
    expect(Object.fromEntries(Object.entries(TRANSITIONS_MISSION).map(([k, v]) => [k, [...v]]))).toEqual(serveur);
  });
  it("versIso : vide absent, illisible nul", () => {
    expect(versIso("")).toBeUndefined();
    expect(versIso("pas une date")).toBeNull();
    expect(versIso("2026-10-22T08:00")).toMatch(/^2026-10-22T/);
  });
});

describe("MissionsPage", () => {
  it("crée une mission avec les seuls champs remplis", async () => {
    rendre(<MissionsPage />);
    await screen.findByText("MIS-1");
    fireEvent.click(screen.getByRole("button", { name: /Nouvelle mission/ }));
    fireEvent.change(screen.getByLabelText("Code (unique)"), { target: { value: "MIS-2" } });
    fireEvent.change(screen.getByLabelText("Intitulé"), { target: { value: "Pont de Linsan" } });
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "SURVEILLANCE" } });
    await screen.findByRole("option", { name: "Agent" });
    fireEvent.change(screen.getByLabelText("Agent assigné"), { target: { value: "a-1" } });
    fireEvent.change(screen.getByLabelText("Début prévu"), { target: { value: "2026-10-25T08:00" } });
    fireEvent.change(screen.getByLabelText("Fin prévue"), { target: { value: "2026-10-24T08:00" } });
    expect(screen.getByText(/La fin prévue doit suivre/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Créer la mission" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Fin prévue"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Créer la mission" }));
    await waitFor(() => expect(h.posts[0]?.url).toBe("/v2/missions"));
    expect(h.posts[0].corps).toEqual({ code: "MIS-2", intitule: "Pont de Linsan", type: "SURVEILLANCE", assigneId: "a-1", debutPrevu: versIso("2026-10-25T08:00") });
  });
  it("un agent ne voit pas la création", async () => {
    h.role = "INSPECTEUR";
    rendre(<MissionsPage />);
    await screen.findByText("MIS-1");
    expect(screen.queryByRole("button", { name: /Nouvelle mission/ })).not.toBeInTheDocument();
  });
});

describe("FicheMission", () => {
  it("ne propose que les transitions permises et les envoie", async () => {
    rendre(<FicheMission id="m-1" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Passer à : suspendue" }));
    expect(screen.getByRole("button", { name: "Annuler la mission" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /planifiée/ })).not.toBeInTheDocument();
    await waitFor(() => expect(h.posts[0]).toEqual({ url: "/v2/missions/m-1/statut", corps: { statut: "SUSPENDUE" } }));
  });
  it("une mission annulée ne propose aucun geste", async () => {
    h.fiche = fiche("ANNULEE");
    rendre(<FicheMission id="m-1" onClose={() => {}} />);
    await screen.findByText("Aucune trace rattachée.");
    expect(screen.queryByRole("button", { name: /Passer à|Annuler la mission/ })).not.toBeInTheDocument();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { CelluleVeillePage, duree, type Tableau } from "./CelluleVeillePage";

/**
 * Vue murale de la cellule de veille : ce que ces tests defendent.
 *   - l'evaluation des escalades precede la lecture du tableau, et son echec n'empeche pas
 *     l'affichage ;
 *   - l'absence de regle d'escalade est dite en tete ;
 *   - un trou de permanence est montre, pas masque ;
 *   - le mode non declare se dit non declare.
 */

const h = vi.hoisted(() => ({ appels: [] as string[], tableau: null as unknown, evaluationEchoue: false }));
vi.mock("../lib/api", () => ({
  api: {
    post: vi.fn(async (url: string) => { h.appels.push(`POST ${url}`); if (h.evaluationEchoue) throw new Error("403"); return { data: {} }; }),
    get: vi.fn(async (url: string) => { h.appels.push(`GET ${url}`); return { data: h.tableau }; }),
  },
}));

const base: Tableau = {
  genereLe: "2026-10-19T08:00:00Z",
  mode: { mode: "NORMAL", declare: false, motif: null, declareLe: null, declarePar: null },
  evenements: [],
  astreintes: [],
  regles: { actives: 0, incoherences: [], aucuneRegle: true },
  infoRouteEnCours: 0,
  signalementsNouveaux: 0,
  patrouilles: [],
};

function rendre() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}><CelluleVeillePage /></QueryClientProvider></MemoryRouter>);
}

beforeEach(() => { h.appels.length = 0; h.tableau = base; h.evaluationEchoue = false; });

describe("CelluleVeillePage", () => {
  it("evalue les escalades puis lit le tableau ; dit l'absence de regle et de mode", async () => {
    rendre();
    expect(await screen.findByText(/Aucune règle d'escalade n'est saisie/)).toBeInTheDocument();
    expect(screen.getByText(/aucun mode déclaré/)).toBeInTheDocument();
    expect(screen.getByText(/Personne n'est d'astreinte/)).toBeInTheDocument();
    expect(h.appels).toEqual(["POST /v2/exploitation/veille/escalades/evaluer", "GET /v2/exploitation/veille/tableau"]);
  });

  it("affiche le tableau meme si l'evaluation echoue", async () => {
    h.evaluationEchoue = true;
    rendre();
    expect(await screen.findByTestId("cellule-veille")).toBeInTheDocument();
  });

  it("montre un trou de permanence et la saison des pluies declaree", async () => {
    h.tableau = {
      ...base,
      mode: { mode: "SAISON_PLUIES", declare: true, motif: "Crues", declareLe: "2026-10-19T06:00:00Z", declarePar: { id: "u", nomComplet: "Chef de veille" } },
      regles: { actives: 1, incoherences: [], aucuneRegle: false },
      evenements: [{
        evenementId: "e1", typeCode: "COUPURE", statut: "OUVERT", ouvertLe: "2026-10-19T06:00:00Z", texte: "Radier submergé",
        tronconCode: "GN N0001", ageMinutes: 125,
        escalade: { niveau: 2, declencheeLe: "2026-10-19T07:30:00Z", destinataire: null, sansDestinataire: true },
      }],
    };
    rendre();
    expect(await screen.findByText("SAISON DES PLUIES")).toBeInTheDocument();
    expect(screen.getByText(/Trou de permanence/)).toBeInTheDocument();
    expect(screen.getByText(/Escalade niveau 2 — PERSONNE D'ASTREINTE/)).toBeInTheDocument();
    expect(screen.getByText("depuis 2 h 05")).toBeInTheDocument();
    expect(screen.queryByText(/Aucune règle d'escalade/)).not.toBeInTheDocument();
  });

  it("bascule en mode mural et en sort", async () => {
    const u = userEvent.setup({ delay: null });
    rendre();
    await u.click(await screen.findByRole("button", { name: /Mode mural/ }));
    expect(screen.getByTestId("cellule-veille").className).toContain("fixed");
    await u.click(screen.getByRole("button", { name: /Quitter le mode mural/ }));
    await waitFor(() => expect(screen.getByTestId("cellule-veille").className).not.toContain("fixed"));
  });
});

describe("duree", () => {
  it("minutes, heures, jours", () => {
    expect(duree(5)).toBe("5 min");
    expect(duree(125)).toBe("2 h 05");
    expect(duree(60 * 50)).toBe("2 j 2 h");
  });
});

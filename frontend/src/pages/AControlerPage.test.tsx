import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { violationsAccessibilite } from "../test/accessibilite";

/**
 * Points à contrôler. Ce que ces tests défendent :
 *   - chaque rang dit ses facteurs et ses points ; l'écran dit que c'est une aide, pas une décision, et que les poids sont provisoires ;
 *   - les tronçons sans constat sont comptés à part (absence de donnée), jamais classés ;
 *   - la région demandée part au serveur ; l'export CSV n'est possible que s'il y a des lignes ;
 *   - zéro violation d'accessibilité.
 */
const h = vi.hoisted(() => ({ appels: [] as { url: string; params: Record<string, unknown> }[], lignes: true }));

vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string, opts?: { params?: Record<string, unknown> }) => {
      h.appels.push({ url, params: opts?.params ?? {} });
      if (url === "/regions") return { data: [{ id: 1, nom: "Conakry" }, { id: 2, nom: "Boké" }] };
      return {
        data: {
          genereLe: "2026-10-25T12:00:00.000Z", totalClasses: h.lignes ? 2 : 0, sansConstatSurLeReseau: 40, constatsLus: 9, lectureIncomplete: false,
          poids: { provenance: "PROVISOIRE_NON_CALIBRE", parConstatGrave: 3, parConstatEnAttente: 1, parRecurrence: 2, siInformationAncienne: 2, joursFenetreRecente: 180, joursSansConstat: 365 },
          avertissements: ["Classement d'AIDE AU CONTRÔLE : il dit où un humain doit regarder en premier, jamais quoi réparer."],
          lignes: h.lignes ? [
            { tronconId: "t1", tronconCode: "GN N0001", tronconNom: "Conakry - Coyah", regionId: 1, regionNom: "Conakry", score: 13, dernierConstat: "2026-10-22",
              facteurs: [{ facteur: "constats_graves", libelle: "constat(s) grave(s) présent(s) dans les 180 derniers jours", nombre: 3, pointsParUnite: 3, points: 9 }, { facteur: "recurrences", libelle: "type(s) de constat revenu(s) à au moins deux dates", nombre: 2, pointsParUnite: 2, points: 4 }], explication: "x" },
            { tronconId: "t2", tronconCode: "GN N0002", tronconNom: "Boké - Sangarédi", regionId: 2, regionNom: "Boké", score: 4, dernierConstat: "2026-10-24", facteurs: [{ facteur: "constats_en_attente", libelle: "constat(s) proposé(s), pas encore tranché(s) par un responsable", nombre: 4, pointsParUnite: 1, points: 4 }], explication: "y" },
          ] : [],
        },
      };
    }),
  },
}));
vi.mock("../components/TronconFicheModal", () => ({
  TronconFicheModal: (p: { tronconId: string }) => <div role="dialog" aria-label="Fiche tronçon">fiche {p.tronconId}</div>,
}));

import { AControlerPage } from "./AControlerPage";

function rendre() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><AControlerPage /></QueryClientProvider>);
}

beforeEach(() => {
  h.appels = []; h.lignes = true;
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:essai") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});
afterEach(cleanup);

describe("points à contrôler", () => {
  it("classe dans l'ordre du serveur, dit pourquoi chaque rang, et dit que c'est une aide et que les poids sont provisoires", async () => {
    rendre();
    const table = await screen.findByRole("table", { name: /Tronçons à contrôler/ });
    const lignes = Array.from(table.querySelectorAll("tbody tr"));
    expect(lignes).toHaveLength(2);
    expect(lignes[0]).toHaveTextContent(/GN N0001/);
    expect(lignes[0]).toHaveTextContent(/3 × 3 = 9 : 3 constat\(s\) grave\(s\)/);
    expect(lignes[0]).toHaveTextContent(/2 × 2 = 4 : 2 type\(s\) de constat revenu\(s\)/);
    expect(lignes[0].querySelector("td:nth-child(4)")).toHaveTextContent("13");
    expect(screen.getByText(/C'est une aide au contrôle, pas une décision/)).toBeInTheDocument();
    expect(screen.getByText(/PROVISOIRES, non calibrés/)).toBeInTheDocument();
  });

  it("les tronçons sans constat sont comptés à part, comme une absence de donnée", async () => {
    rendre();
    expect(await screen.findByText(/sans aucun constat : une absence de donnée, pas un risque mesuré/)).toBeInTheDocument();
    expect(screen.getByText("40")).toBeInTheDocument();
  });

  it("une région choisie part au serveur ; sans choix, aucune région n'est demandée", async () => {
    rendre();
    await screen.findByRole("table");
    expect(h.appels.find((a) => a.url === "/v2/fiche-360/a-controler")?.params).toEqual({ limite: 50 });
    fireEvent.change(screen.getByLabelText("Région"), { target: { value: "2" } });
    await screen.findByRole("table");
    expect(h.appels.filter((a) => a.url === "/v2/fiche-360/a-controler").some((a) => a.params.region === "2")).toBe(true);
  });

  it("l'export CSV télécharge un fichier daté ; il est désactivé quand il n'y a rien à exporter", async () => {
    rendre();
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: /Exporter en CSV/ }));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    cleanup();
    h.lignes = false;
    rendre();
    await screen.findByText(/Aucun tronçon à contrôler/);
    expect(screen.getByRole("button", { name: /Exporter en CSV/ })).toBeDisabled();
  });

  it("un clic sur le code d'un tronçon ouvre sa fiche", async () => {
    rendre();
    fireEvent.click(await screen.findByRole("button", { name: "GN N0002" }));
    expect(await screen.findByRole("dialog", { name: "Fiche tronçon" })).toHaveTextContent("fiche t2");
  });

  it("zéro violation d'accessibilité", async () => {
    const { container } = rendre();
    await screen.findByRole("table");
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

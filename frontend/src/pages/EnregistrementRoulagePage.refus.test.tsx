import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * Phase 1 SMART FIELD — un journal retrouvé mais INJOUABLE n'est jamais ignoré en
 * silence : la raison est affichée, les données restent sur l'appareil, et l'effacement
 * est un choix explicite de l'agent.
 *
 * Ici le stockage est SEME avec un journal sans DEMARRAGE (seq 1) : rejouer refuse
 * avec DEMARRAGE_ABSENT — exactement ce que verrait un agent dont le journal a été
 * tronqué. La page ne doit PAS ressembler à un écran vierge (qui ferait croire à une
 * perte), elle doit nommer le problème.
 */
const h = vi.hoisted(() => ({
  journal: [] as unknown[],
}));
vi.mock("../lib/roulageHote", async (importOriginal) => {
  const reel = await importOriginal<typeof import("../lib/roulageHote")>();
  const stockage = reel.stockageMemoire();
  return {
    ...reel,
    ouvrirStockage: () => stockage,
    stockageBrut: stockage,
    garderEcranAllume: async () => ({ actif: true, liberer: async () => undefined }),
  };
});
vi.mock("../lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", role: "GESTIONNAIRE", nomComplet: "Agent Test" } }),
}));

import { EnregistrementRoulagePage } from "./EnregistrementRoulagePage";

describe("reprise refusée (phase 1 SMART FIELD)", () => {
  it("un journal injouable est DIT — raison affichée, données dites gardées", async () => {
    const { stockageBrut } = (await import("../lib/roulageHote")) as unknown as {
      stockageBrut: { ajouter: (e: unknown) => void; toutes: () => Promise<unknown[]> };
    };
    // Un journal sans DEMARRAGE (seq 1) : rejouer refuse avec DEMARRAGE_ABSENT.
    stockageBrut.ajouter({ seq: 2, type: "PAUSE", tMs: Date.now(), sessionId: "s-x", details: {} });

    render(<MemoryRouter><EnregistrementRoulagePage /></MemoryRouter>);

    expect(await screen.findByText(/ne peut pas être rouverte/)).toBeInTheDocument();
    expect(screen.getByText(/toujours sur cet appareil/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Effacer ce journal/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Décider plus tard/ })).toBeInTheDocument();

    // Le stockage n'a pas été vidé par la simple consultation.
    expect(await stockageBrut.toutes()).toHaveLength(1);
  });
});

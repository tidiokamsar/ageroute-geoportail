import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { violationsAccessibilite } from "../../test/accessibilite";

/**
 * Mes sessions envoyées : ce que ces tests défendent.
 *   - rien n'est demandé au serveur avant le geste (l'écran de route ne dépend pas du réseau) ;
 *   - la liste puis l'analyse d'une session s'affichent, indicateurs absents non inventés ;
 *   - zéro violation d'accessibilité, fiche ouverte.
 */
const h = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock("../../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string) => {
      h.urls.push(url);
      if (url === "/v2/roulage/mes-sessions") {
        return { data: { sessions: [{ id: "s-1", debutA: "2026-10-01T08:00:00Z", finA: "2026-10-01T08:30:00Z", nbPoints: 300, tauxRattachement: 0.812, mission: { id: "m", code: "MIS-1", intitule: "RN1" } }] } };
      }
      return { data: {
        id: "s-1", debutA: "2026-10-01T08:00:00Z", finA: "2026-10-01T08:30:00Z", nbPoints: 300, tauxRattachement: 0.812, mission: null,
        trous: [{}], interruptions: [], pauses: [{}, {}],
        analyse: { indicateurs: { pointsRecus: 300, pointsRetenus: 276, distanceParcourueM: 5511 }, avertissements: ["1 changement(s) de troncon non verifies"] },
      } };
    }),
  },
}));

import { MesSessions } from "./MesSessions";

describe("MesSessions", () => {
  it("ne charge qu'au geste, puis affiche liste et analyse", async () => {
    const { container } = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MesSessions /></QueryClientProvider>);
    expect(h.urls).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Afficher mes sessions envoyées" }));
    expect(await screen.findByText("MIS-1")).toBeInTheDocument();
    expect(screen.getByText("81.2 %")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Analyse" }));
    expect(await screen.findByText(/5,5 km/)).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Pauses 2/ })).toBeInTheDocument();
    expect(screen.queryByText("Segments ignorés")).not.toBeInTheDocument();
    expect(screen.getByText(/non verifies/)).toBeInTheDocument();
    expect(await violationsAccessibilite(container.ownerDocument.body)).toEqual([]);
  });
});

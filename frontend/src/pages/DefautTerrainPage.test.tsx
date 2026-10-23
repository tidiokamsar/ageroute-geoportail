import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({
  ajoute: vi.fn(async (item: Record<string, unknown>) => { h.brouillons.push(item); }),
  brouillons: [] as Record<string, unknown>[],
}));

vi.mock("../hooks/useOfflineSync", () => ({
  useOfflineSync: () => ({ online: false, syncing: false, pendingCount: h.brouillons.length, syncNow: vi.fn() }),
}));
vi.mock("../lib/defautsTerrain", () => ({
  chargerReferentielsDefautsTerrain: async () => ({
    troncons: [{ id: "troncon-1", code: "RN1", nom: "Conakry — Kindia" }],
    catalogue: [{
      code: "NID_POULE",
      libelle: "Nid-de-poule",
      famille: "CHAUSSEE",
      unite: "METRE_CARRE",
      mesuresRequises: ["LONGUEUR", "LARGEUR", "PROFONDEUR"],
      graviteMax: 4,
    }],
    tronconsEnCache: true,
    catalogueEnCache: true,
  }),
}));
vi.mock("../lib/offlineDb", () => ({
  addPendingDefaut: h.ajoute,
  getAllPendingDefauts: vi.fn(async () => h.brouillons),
  removePendingDefaut: vi.fn(async () => {}),
  updatePendingDefaut: vi.fn(async () => {}),
}));
vi.mock("../lib/offlineSync", () => ({
  refreshPendingCount: vi.fn(async () => {}),
  syncPendingOfflineData: vi.fn(async () => {}),
}));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "agent-1", role: "INSPECTEUR" } }) }));

import { DefautTerrainPage } from "./DefautTerrainPage";

beforeEach(() => {
  h.ajoute.mockClear();
  h.brouillons.length = 0;
});

describe("Saisie terrain des défauts", () => {
  // `delay: null` : user-event cède la main au navigateur après CHAQUE frappe par défaut, et ce
  // parcours en compte une vingtaine sur une page complète. Mesuré le 14/10 : 4,9 à 6,2 s seul,
  // pour un plafond de 5 s -- un échec sur trois, davantage sous la charge de la suite. Sans ce
  // délai, le même parcours est exercé, seulement sans les pauses inutiles. La marge de 15 s
  // couvre les postes lents ; elle n'affaiblit aucune assertion.
  it("enregistre hors-ligne les mesures, le repère et la clé locale", async () => {
    const user = userEvent.setup({ delay: null });
    // Le picker géo de tronçon (recherche GPS/ville/texte) utilise react-query : le
    // test lui fournit un client dont toutes les requêtes restent en échec silencieux
    // (hors ligne : pas de recherche réseau, le cache du référentiel suffit).
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
    render(<QueryClientProvider client={qc}><MemoryRouter><DefautTerrainPage /></MemoryRouter></QueryClientProvider>);

    await screen.findByRole("option", { name: /Nid-de-poule/ });
    await user.click(screen.getByRole("button", { name: "Tronçon et repère" }));
    await user.selectOptions(screen.getByLabelText("Tronçon"), "troncon-1");
    await user.type(screen.getByLabelText("Valeur du repère"), "125");
    await user.type(screen.getByLabelText("Longueur *"), "2");
    await user.type(screen.getByLabelText("Largeur *"), "1");
    await user.type(screen.getByLabelText("Profondeur *"), "0.1");
    await user.selectOptions(screen.getByLabelText("Gravité (1 à 4)"), "2");
    await user.click(screen.getByRole("button", { name: "Enregistrer le défaut" }));

    await waitFor(() => expect(h.ajoute).toHaveBeenCalledOnce());
    const item = h.ajoute.mock.calls[0][0] as {
      localId: string;
      ownerUserId: string;
      status: string;
      payload: Record<string, unknown>;
    };
    expect(item.localId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(item.status).toBe("pending");
    expect(item.ownerUserId).toBe("agent-1");
    expect(item.payload).toMatchObject({
      catalogueCode: "NID_POULE",
      tronconId: "troncon-1",
      abscisseM: 125,
      confianceAppariement: 0.8,
      gravite: 2,
      mesures: { longueurM: 2, largeurM: 1, profondeurM: 0.1 },
    });
  }, 15_000);
});

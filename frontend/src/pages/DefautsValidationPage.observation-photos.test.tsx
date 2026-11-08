import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Revue d'une observation par un responsable : les PHOTOS jointes depuis le terrain sont visibles, avec leur date de prise,
 * leur position et leur empreinte SHA-256, et rien n'est affiché quand il n'y en a pas.
 */
const h = vi.hoisted(() => ({
  medias: [] as unknown[], lectures: [] as string[], ecritures: [] as { url: string; corps: unknown }[],
  suggestion: { tronconId: "t1", code: "GN N0001", nom: "RN1", distanceM: 12, abscisseM: 340, pk: 4.2, confiance: 0.88, ambigu: false } as Record<string, unknown> | null,
}));

vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string) => {
      h.lectures.push(url);
      if (url.startsWith("/v2/defauts?")) return { data: { defauts: [], curseurSuivant: null } };
      if (url.startsWith("/v2/observations?")) {
        return { data: { observations: [{ id: "o1", type: "DEGRADATION", statut: "PROPOSEE", description: "Relevé en roulant, session abcdef12", observeA: "2026-10-25T09:00:00.000Z", lat: 9.64, lon: -13.6, pk: null, agentId: "a1", mission: null }], curseurSuivant: null } };
      }
      if (url === "/v2/observations/o1") {
        return { data: { id: "o1", type: "DEGRADATION", statut: "PROPOSEE", description: "Relevé en roulant, session abcdef12", observeA: "2026-10-25T09:00:00.000Z", lat: 9.64, lon: -13.6, pk: null, agentId: "a1", validations: [], medias: h.medias } };
      }
      if (url.startsWith("/photos/")) return { data: new Blob(["x"], { type: "image/jpeg" }) };
      throw new Error(`GET inattendu : ${url}`);
    }),
    post: vi.fn(async (url: string, corps?: unknown) => {
      h.ecritures.push({ url, corps });
      if (url.endsWith("/appariement/suggestion")) return { data: { suggestion: h.suggestion } };
      return { data: {} };
    }),
  },
}));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { DefautsValidationPage } from "./DefautsValidationPage";

const MEDIA = { id: "m1", chemin: "obs-photo.jpg", sha256: "ab".repeat(32), mimeType: "image/jpeg", tailleOctets: 204_800, lat: 9.64, lon: -13.6, precisionM: 6, capturedA: "2026-10-25T09:00:30.000Z" };

function rendre() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><DefautsValidationPage /></QueryClientProvider>);
}

async function ouvrirObservation() {
  fireEvent.click(await screen.findByRole("tab", { name: /Observations/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Examiner/ }));
  await screen.findByText("Revue de l’observation");
}

beforeEach(() => {
  h.medias = []; h.lectures = []; h.ecritures = [];
  h.suggestion = { tronconId: "t1", code: "GN N0001", nom: "RN1", distanceM: 12, abscisseM: 340, pk: 4.2, confiance: 0.88, ambigu: false };
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:essai") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});
afterEach(cleanup);

describe("revue d'une observation : photos de preuve", () => {
  it("les photos jointes sont affichées, avec date, position, précision et empreinte, et lues par l'API authentifiée", async () => {
    h.medias = [MEDIA];
    rendre();
    await ouvrirObservation();
    expect(await screen.findByText("Photos de preuve")).toBeInTheDocument();
    expect(await screen.findByAltText(/Preuve du relevé/)).toBeInTheDocument();
    expect(screen.getByText(/GPS 9\.64000, -13\.60000 ±6 m/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`SHA-256 ${"ab".repeat(32)}`))).toBeInTheDocument();
    expect(h.lectures).toContain("/photos/obs-photo.jpg");
  });

  it("sans photo : aucune rubrique « Photos de preuve »", async () => {
    rendre();
    await ouvrirObservation();
    expect(screen.queryByText("Photos de preuve")).not.toBeInTheDocument();
  });
});

describe("revue d'une observation : rattachement à un tronçon, sur proposition", () => {
  it("dit que l'observation n'entre dans l'historique d'aucune section, propose un tronçon, et ne rattache qu'après confirmation", async () => {
    rendre();
    await ouvrirObservation();
    const section = screen.getByRole("region", { name: "Rattachement à un tronçon" });
    expect(section).toHaveTextContent(/n'entre dans l'historique d'aucune section/);
    fireEvent.click(screen.getByRole("button", { name: /Proposer un tronçon/ }));
    expect(await screen.findByText(/GN N0001 · RN1/)).toBeInTheDocument();
    expect(screen.getByText(/À 12 m · confiance 88 %/)).toBeInTheDocument();
    // Proposé, pas encore rattaché : aucune confirmation envoyée.
    expect(h.ecritures.map((e) => e.url)).toEqual(["/v2/observations/o1/appariement/suggestion"]);
    fireEvent.click(screen.getByRole("button", { name: /Confirmer ce tronçon/ }));
    await vi.waitFor(() => expect(h.ecritures).toHaveLength(2));
    expect(h.ecritures[1]).toEqual({ url: "/v2/observations/o1/appariement/confirmation", corps: { tronconId: "t1" } });
  });

  it("un candidat ambigu est dit ; « Ne pas rattacher » n'écrit rien", async () => {
    h.suggestion = { tronconId: "t1", code: "GN N0001", nom: null, distanceM: 30, abscisseM: 10, pk: null, confiance: 0.4, ambigu: true };
    rendre();
    await ouvrirObservation();
    fireEvent.click(screen.getByRole("button", { name: /Proposer un tronçon/ }));
    expect(await screen.findByText(/candidat ambigu : vérifier avant de confirmer/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Ne pas rattacher/ }));
    expect(h.ecritures).toHaveLength(1);
  });

  it("aucun candidat sûr : rien n'est proposé ni forcé", async () => {
    h.suggestion = null;
    rendre();
    await ouvrirObservation();
    fireEvent.click(screen.getByRole("button", { name: /Proposer un tronçon/ }));
    await vi.waitFor(() => expect(h.ecritures).toHaveLength(1));
    expect(screen.queryByRole("button", { name: /Confirmer ce tronçon/ })).not.toBeInTheDocument();
  });
});

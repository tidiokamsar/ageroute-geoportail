import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Revue d'une observation par un responsable : les PHOTOS jointes depuis le terrain sont visibles, avec leur date de prise,
 * leur position et leur empreinte SHA-256, et rien n'est affiché quand il n'y en a pas.
 */
const h = vi.hoisted(() => ({ medias: [] as unknown[], lectures: [] as string[] }));

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
    post: vi.fn(),
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
  h.medias = []; h.lectures = [];
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

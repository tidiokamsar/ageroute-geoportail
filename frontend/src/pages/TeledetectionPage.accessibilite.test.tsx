import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { violationsAccessibilite } from "../test/accessibilite";

/**
 * Accessibilite de l'ecran Observation de la Terre : UN test axe-core (WCAG 2.1 A et AA) par vue.
 *
 * Le contraste n'est pas mesure par axe sous jsdom : il est garde par les calculs explicites de
 * `lib/teledetectionAffichage.test.ts` (couples de couleurs de statut, de priorite et d'etat de
 * source, via `lib/contraste.ts`) et par la mesure en navigateur reel (captures du chantier).
 * Donnees SYNTHETIQUES.
 */

const h = vi.hoisted(() => ({ role: "ADMIN", get: vi.fn(), post: vi.fn() }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u", role: h.role } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/api", () => ({ api: { get: h.get, post: h.post } }));
vi.mock("../components/observation-terre/CarteObservationTerre", () => ({
  CarteObservationTerre: () => <div role="img" aria-label="Carte des propositions (doublure de test)" />,
}));

import { TeledetectionPage } from "./TeledetectionPage";
import { detail, echec, page, proposition, routeurGet, source, synthese } from "../components/observation-terre/synthetique.testutil";

const OBS = [{ id: "o-1", date: "2026-10-22T09:00:00Z", auteur: "Agent A", resume: "Chaussée submergée" }];
let table: Record<string, unknown>;

function rendre() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}><TeledetectionPage /></QueryClientProvider></MemoryRouter>);
}
async function violations() {
  return violationsAccessibilite(document.body);
}

beforeEach(() => {
  h.role = "ADMIN";
  h.get.mockReset(); h.post.mockReset();
  table = {
    "/v2/teledetection/synthese": synthese({ tauxConfirmation: { confirmees: 37, infirmees: 24, jugees: 61, valeur: 37 / 61, echantillonSuffisant: true, seuil: 30, definition: "Confirmées ÷ (confirmées + infirmées)." } }),
    "/v2/teledetection/propositions": page([proposition(), proposition({ id: "p-2", type: "VEGETATION", rattachee: false, troncon: null, rattachement: { confiance: "AUCUN", distanceM: null, algorithme: "a" }, priorite: { niveau: "FAIBLE", regle: "r" } })]),
    "/v2/teledetection/sources": [
      source(), source({ code: "B", nom: "Source B", etat: "EN_ERREUR", message: "Délai dépassé" }), source({ code: "C", nom: "Source C", etat: "NON_CONFIGUREE" }),
      source({ code: "D", nom: "Source D", etat: "EN_ATTENTE_CONFIGURATION", requiertIdentifiants: true }),
    ],
    "/regions": [{ id: 1, nom: "Conakry" }],
    "/v2/teledetection/qualite-methodes": { seuilEchantillon: 30, definition: "d", lignes: [
      { type: "INONDATION", methode: "seuil-sar v0", methodeNom: "seuil-sar", methodeVersion: "0", total: 12, aVerifier: 0, enAttente: 0, nonConcluantes: 0, confirmees: 8, infirmees: 4, jugees: 12, tauxConfirmation: 0.667, echantillonSuffisant: false, seuilEchantillon: 30 },
      { type: "VEGETATION", methode: "seuil-sar v0", methodeNom: "seuil-sar", methodeVersion: "0", total: 3, aVerifier: 3, enAttente: 0, nonConcluantes: 0, confirmees: 0, infirmees: 0, jugees: 0, tauxConfirmation: null, echantillonSuffisant: false, seuilEchantillon: 30 },
    ] },
    "/v2/teledetection/propositions/p-1": detail({ terrain: { observations: OBS }, historique: [{ de: "A_VERIFIER", vers: "EN_ATTENTE", auteur: { id: "u", nom: "Chef" }, date: "2026-10-21T08:30:00Z", motif: "Image floue", commentaire: null }] }),
  };
  h.get.mockImplementation((url: string, c?: unknown) => routeurGet(table)(url, c as never));
  h.post.mockResolvedValue({ data: {} });
});

describe("accessibilite : une mesure axe par vue", () => {
  it("vue d'ensemble : indicateurs, carte, liste, taux (echantillon suffisant), sources dont erreur et identifiants requis", async () => {
    rendre();
    await screen.findByRole("button", { name: /Inondation/ });
    await screen.findByRole("table", { name: /Sources d'observation/ });
    await screen.findByTestId("valeur-taux");
    expect(await violations()).toEqual([]);
  }, 30_000);

  it("vue filtres ouverts", async () => {
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: /Filtres/ }));
    await screen.findByRole("group", { name: "Filtres des propositions" });
    expect(await violations()).toEqual([]);
  }, 30_000);

  it("vue detail (apercu absent), avec limites, provenance et indicateurs de qualite", async () => {
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: /Inondation/ }));
    await screen.findByText("Indicateurs de qualité");
    expect(await violations()).toEqual([]);
  }, 30_000);

  it.each(["Comparaison", "Terrain", "Historique"])("vue detail, onglet %s", async (onglet) => {
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: /Inondation/ }));
    await u.click(await screen.findByRole("tab", { name: onglet }));
    await waitFor(() => expect(screen.getByRole("tab", { name: onglet })).toHaveAttribute("aria-selected", "true"));
    await screen.findAllByRole("tabpanel");
    expect(await violations()).toEqual([]);
  }, 30_000);

  it("vue detail avec formulaire de decision ouvert (motif obligatoire, preuves de terrain)", async () => {
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: /Inondation/ }));
    await u.click(await screen.findByRole("button", { name: /^Confirmer la proposition/ }));
    await screen.findByRole("group", { name: /formulaire de décision/ });
    expect(await violations()).toEqual([]);
  }, 30_000);

  it("vue detail d'un verdict definitif", async () => {
    table["/v2/teledetection/propositions/p-1"] = detail({ statut: "CONFIRMEE" });
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: /Inondation/ }));
    await screen.findByText(/Verdict définitif/);
    expect(await violations()).toEqual([]);
  }, 30_000);

  it("vue en lecture seule (LECTEUR)", async () => {
    h.role = "LECTEUR";
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: /Inondation/ }));
    await screen.findByText(/Consultation seule/);
    expect(await violations()).toEqual([]);
  }, 30_000);

  it("vue aucun verdict et liste vide", async () => {
    table["/v2/teledetection/synthese"] = synthese({ tauxConfirmation: { confirmees: 0, infirmees: 0, jugees: 0, valeur: null, echantillonSuffisant: false, seuil: 30, definition: "" } });
    table["/v2/teledetection/propositions"] = page([], { total: 0 });
    table["/v2/teledetection/sources"] = [];
    rendre();
    await screen.findByText("Aucun verdict", { selector: "[data-testid=valeur-taux]" });
    await screen.findByText("Aucune source d'observation enregistrée");
    await screen.findByText(/Aucune proposition «/);
    expect(await violations()).toEqual([]);
  }, 30_000);

  it("vue echantillon insuffisant", async () => {
    table["/v2/teledetection/synthese"] = synthese();
    rendre();
    await screen.findByTestId("mention-echantillon");
    expect(await violations()).toEqual([]);
  }, 30_000);

  it("vue chargement", async () => {
    h.get.mockImplementation(() => new Promise(() => {}));
    rendre();
    await screen.findByText("Chargement des indicateurs…");
    expect(await violations()).toEqual([]);
  }, 30_000);

  it("vue erreurs d'API sur tous les panneaux", async () => {
    for (const u of ["/v2/teledetection/synthese", "/v2/teledetection/propositions", "/v2/teledetection/sources", "/v2/teledetection/qualite-methodes"]) table[u] = echec(500, "Panne");
    rendre();
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThanOrEqual(4), { timeout: 6000 });
    expect(await violations()).toEqual([]);
  }, 30_000);

  it("vue permission refusee sur tous les panneaux", async () => {
    for (const u of ["/v2/teledetection/synthese", "/v2/teledetection/propositions", "/v2/teledetection/sources", "/v2/teledetection/qualite-methodes"]) table[u] = echec(403, "Refusé");
    rendre();
    await waitFor(() => expect(screen.getAllByText(/accès refusé/).length).toBeGreaterThanOrEqual(4), { timeout: 6000 });
    expect(await violations()).toEqual([]);
  }, 30_000);
});

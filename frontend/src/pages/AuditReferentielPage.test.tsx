import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { violationsAccessibilite } from "../test/accessibilite";

/**
 * Audit du référentiel des tronçons : ce que ces tests défendent.
 *   - les filtres vivent dans l'URL et partent au serveur ; ils se réinitialisent ;
 *   - l'analyse exige une portée ; la portée nationale n'est proposée qu'à l'administrateur ;
 *   - une proposition de correction envoie champ, valeur, justification et source, rien de déduit ;
 *   - l'écran retient l'auto-validation ; une correction validée s'applique, une appliquée s'annule avec motif ;
 *   - l'application groupée est prévisualisée et refusée en bloc si une ligne n'est plus applicable ;
 *   - un LECTEUR lit sans aucun geste ; zéro violation d'accessibilité.
 */
const REGLES = {
  regles: [
    { code: "PK_NON_RENSEIGNES", libelle: "PK non renseignés", gravite: "MAJEURE", regle: "PK 0 → 0.", champs: ["pkDebut", "pkFin"] },
    { code: "GEOMETRIE_ABSENTE", libelle: "Géométrie absente", gravite: "MAJEURE", regle: "Pas de tracé.", champs: [] },
  ],
  statuts: ["A_EXAMINER", "CORRECTION_PROPOSEE", "VALIDEE", "REJETEE", "CORRIGEE"],
  transitions: { A_EXAMINER: ["CORRECTION_PROPOSEE", "VALIDEE", "REJETEE"], CORRECTION_PROPOSEE: ["VALIDEE", "REJETEE", "A_EXAMINER"], VALIDEE: ["CORRECTION_PROPOSEE", "A_EXAMINER"], REJETEE: ["A_EXAMINER"], CORRIGEE: [] },
};
const anomalie = (id: string, o: Record<string, unknown> = {}) => ({
  id, tronconId: `t-${id}`, regle: "PK_NON_RENSEIGNES", gravite: "MAJEURE", statut: "A_EXAMINER", valeurs: { pkDebut: 0, pkFin: 0 },
  source: "controle:PK_NON_RENSEIGNES v1", correction: null, detecteeLe: "2026-10-25T08:00:00Z", derniereDetectionLe: "2026-10-25T08:00:00Z", disparueLe: null,
  troncon: { id: `t-${id}`, code: `GN ${id}`, nom: "Coyah", region: { nom: "Kindia" }, deletedAt: null }, ...o,
});
const correction = { champ: "pkFin", ancienne: 0, nouvelle: 41.2, justification: "PV de réception", source: "PV 2024-17", proposeeParId: "u-autre" };

const h = vi.hoisted(() => ({
  role: "GESTIONNAIRE", gets: [] as { url: string; params?: Record<string, unknown> }[], posts: [] as { url: string; corps: unknown }[],
  fiche: {} as Record<string, unknown>, liste: [] as unknown[], prev: [] as unknown[],
}));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u-moi", role: h.role } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/download", () => ({ downloadViaApi: vi.fn(async () => undefined) }));
vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string, cfg?: { params?: Record<string, unknown> }) => {
      h.gets.push({ url, params: cfg?.params });
      if (url.endsWith("/regles")) return { data: REGLES };
      if (url === "/regions") return { data: [{ id: 3, nom: "Kindia" }] };
      if (url.endsWith("/anomalies")) return { data: { data: h.liste, total: h.liste.length, totalPages: 1, parStatut: { A_EXAMINER: 1 } } };
      return { data: h.fiche };
    }),
    post: vi.fn(async (url: string, corps: unknown) => {
      h.posts.push({ url, corps });
      if (url.endsWith("/previsualisation")) return { data: { lignes: h.prev } };
      return { data: { appliquees: 1, nouvelles: 2, confirmees: 0, disparues: 0, tronconsExamines: 9, tronque: false } };
    }),
  },
}));

import { downloadViaApi } from "../lib/download";
import { AuditReferentielPage, FicheAnomalie } from "./AuditReferentielPage";

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const rendrePage = (url = "/troncons/audit") => render(<MemoryRouter initialEntries={[url]}><QueryClientProvider client={client()}><AuditReferentielPage /></QueryClientProvider></MemoryRouter>);
const rendreFiche = () => render(<QueryClientProvider client={client()}><FicheAnomalie id="a1" catalogue={REGLES as never} onClose={() => {}} /></QueryClientProvider>);

beforeEach(() => {
  h.role = "GESTIONNAIRE"; h.gets.length = 0; h.posts.length = 0; h.prev = [];
  h.liste = [anomalie("a1"), anomalie("a2", { statut: "VALIDEE", correction })];
  h.fiche = { ...anomalie("a1"), decisions: [{ id: "d1", statutAvant: null, statutApres: "A_EXAMINER", commentaire: "Constatée par l'analyse", correction: null, decideLe: "2026-10-25T08:00:00Z", auteur: { nomComplet: "Agent" } }], definition: REGLES.regles[0] };
});

describe("AuditReferentielPage", () => {
  it("les filtres de l'URL partent au serveur ; réinitialiser les vide", async () => {
    rendrePage("/troncons/audit?statut=VALIDEE&regle=PK_NON_RENSEIGNES&disparues=1");
    await screen.findByText("GN a1");
    expect(h.gets.find((g) => g.url.endsWith("/anomalies"))?.params).toEqual({ statut: "VALIDEE", regle: "PK_NON_RENSEIGNES", inclureDisparues: "true", page: 1, pageSize: 50 });
    fireEvent.click(screen.getByRole("button", { name: "Réinitialiser les filtres" }));
    await waitFor(() => expect(h.gets.at(-1)?.params).toEqual({ page: 1, pageSize: 50 }));
  });
  it("exporte le CSV avec les filtres courants", async () => {
    rendrePage("/troncons/audit?regle=GEOMETRIE_ABSENTE");
    await screen.findByText("GN a1");
    fireEvent.click(screen.getByRole("button", { name: /Exporter \(CSV\)/ }));
    expect(downloadViaApi).toHaveBeenCalledWith("/v2/referentiel/troncons/anomalies.csv?regle=GEOMETRIE_ABSENTE", "anomalies-referentiel-troncons.csv");
  });
  it("l'analyse exige une portée ; le national n'est proposé qu'à l'administrateur", async () => {
    rendrePage();
    fireEvent.click(await screen.findByRole("button", { name: /Lancer une analyse/ }));
    const portee = screen.getByLabelText("Portée") as HTMLSelectElement;
    expect([...portee.options].map((o) => o.value)).toEqual(["", "3"]);
    expect(screen.getByRole("button", { name: /^Analyser/ })).toBeDisabled();
    fireEvent.change(portee, { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText(/Écart longueur déclarée/), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: /^Analyser/ }));
    await waitFor(() => expect(h.posts[0]).toEqual({ url: "/v2/referentiel/troncons/analyse", corps: { regionId: 3, ecartLongueurPct: 25, ecartPkPct: 10 } }));
  });
  it("l'application groupée est prévisualisée et refusée en bloc si une ligne a changé", async () => {
    h.prev = [{ anomalieId: "a2", code: "GN a2", champ: "pkFin", constatee: 0, actuelle: 3, nouvelle: 41.2, applicable: false, motif: "La valeur a changé" }];
    rendrePage();
    fireEvent.click(await screen.findByRole("checkbox", { name: /Sélectionner la correction de GN a2/ }));
    expect(screen.queryByRole("checkbox", { name: /GN a1/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Prévisualiser et appliquer" }));
    expect(await screen.findByText("La valeur a changé")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Appliquer 1 correction/ })).toBeDisabled();
    expect(h.posts.map((p) => p.url)).toEqual(["/v2/referentiel/troncons/anomalies/previsualisation"]);
  });
  it("un LECTEUR lit sans aucun geste", async () => {
    h.role = "LECTEUR";
    rendrePage();
    await screen.findByText("GN a1");
    expect(screen.queryByRole("button", { name: /Lancer une analyse/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Sélectionner/ })).not.toBeInTheDocument();
  });
  it("zéro violation d'accessibilité", async () => {
    const { container } = rendrePage();
    await screen.findByText("GN a1");
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

describe("FicheAnomalie", () => {
  it("propose une correction avec champ, valeur, justification et source", async () => {
    rendreFiche();
    fireEvent.change(await screen.findByLabelText("Décision"), { target: { value: "CORRECTION_PROPOSEE" } });
    const bouton = screen.getByRole("button", { name: "Enregistrer la décision" });
    fireEvent.change(screen.getByLabelText("Champ"), { target: { value: "pkFin" } });
    fireEvent.change(screen.getByLabelText("Nouvelle valeur"), { target: { value: "41,2" } });
    fireEvent.change(screen.getByLabelText("Justification"), { target: { value: "PV de réception" } });
    expect(bouton).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Source de la valeur"), { target: { value: "PV 2024-17" } });
    fireEvent.click(bouton);
    await waitFor(() => expect(h.posts[0]).toEqual({ url: "/v2/referentiel/troncons/anomalies/a1/decision", corps: {
      statut: "CORRECTION_PROPOSEE", commentaire: null, correction: { champ: "pkFin", nouvelle: "41.2", justification: "PV de réception", source: "PV 2024-17" },
    } }));
  });
  it("un rejet exige un motif", async () => {
    rendreFiche();
    fireEvent.change(await screen.findByLabelText("Décision"), { target: { value: "REJETEE" } });
    const bouton = screen.getByRole("button", { name: "Enregistrer la décision" });
    expect(bouton).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Commentaire/), { target: { value: "deux chaussées distinctes" } });
    expect(bouton).toBeEnabled();
  });
  it("retient l'auto-validation d'une correction qu'on a proposée", async () => {
    h.fiche = { ...h.fiche, statut: "CORRECTION_PROPOSEE", correction: { ...correction, proposeeParId: "u-moi" } };
    rendreFiche();
    fireEvent.change(await screen.findByLabelText("Décision"), { target: { value: "VALIDEE" } });
    expect(screen.getByText(/une autre personne doit la valider/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enregistrer la décision" })).toBeDisabled();
  });
  it("une correction validée s'applique ; une appliquée s'annule avec motif", async () => {
    h.fiche = { ...h.fiche, statut: "VALIDEE", correction };
    const { unmount } = rendreFiche();
    fireEvent.click(await screen.findByRole("button", { name: "Appliquer la correction au tronçon" }));
    await waitFor(() => expect(h.posts[0]).toEqual({ url: "/v2/referentiel/troncons/anomalies/application", corps: { ids: ["a1"] } }));
    unmount();
    h.fiche = { ...h.fiche, statut: "CORRIGEE" };
    rendreFiche();
    const annuler = await screen.findByRole("button", { name: "Annuler la correction" });
    expect(annuler).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Annuler la correction \(rend/), { target: { value: "PV contesté" } });
    fireEvent.click(annuler);
    await waitFor(() => expect(h.posts.at(-1)).toEqual({ url: "/v2/referentiel/troncons/anomalies/a1/annulation", corps: { motif: "PV contesté" } }));
  });
  it("une anomalie sans champ corrigeable le dit ; l'historique est affiché", async () => {
    h.fiche = { ...h.fiche, regle: "GEOMETRIE_ABSENTE", definition: REGLES.regles[1] };
    const { container } = rendreFiche();
    expect(within(await screen.findByRole("list")).getByText(/Constatée par l'analyse/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Décision"), { target: { value: "CORRECTION_PROPOSEE" } });
    expect(screen.getByText(/ne se corrige pas depuis le registre/)).toBeInTheDocument();
    expect(await violationsAccessibilite(container.ownerDocument.body)).toEqual([]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { violationsAccessibilite } from "../../../test/accessibilite";
import type { FiltresDecision } from "../types";

/**
 * Onglet « Rapports » (lot 6), en jsdom : mention consultative visible, choix du type, filtres de la page, apercu des
 * parametres (filtres NON appliques dits), export, journal, etats (chargement, vide, erreur, permission), axe. Les donnees sont
 * SYNTHETIQUES et vivent dans ce fichier de test, jamais dans le code de production.
 */
const h = vi.hoisted(() => ({
  user: { id: "u1", role: "GESTIONNAIRE", modulesAutorises: ["rapports", "programmation", "marches", "decision"] } as { id: string; role: string; modulesAutorises: string[] },
  gets: [] as { url: string; params?: Record<string, string> }[],
  posts: [] as { url: string; corps: Record<string, unknown> }[],
  rapport: "ok" as "ok" | "vide" | "403" | "500",
  journal: "ok" as "ok" | "vide" | "500" | "attente",
  scenarios: "ok" as "ok" | "vide",
}));

vi.mock("../../../lib/auth", () => ({ useAuth: () => ({ user: h.user }) }));
vi.mock("../../../lib/api", () => {
  const ligne = (region: string, o: Record<string, unknown> = {}) => ({
    region, troncons: 3, tronconsSansLongueurMetier: 0, kmBon: 10, kmMoyen: 0, kmMauvais: 5, kmCritique: 3, kmEtatNonValide: 0, kmNonEvalue: 40, kmEligible: 18,
    kmPerimetre: 58, degradePct: 44.4, critiquePct: 16.7, partNonEvaluee: 0.69, disponibilite: "PARTIEL", ...o,
  });
  return {
    api: {
      get: vi.fn(async (url: string, config?: { params?: Record<string, string> }) => {
        h.gets.push({ url, params: config?.params });
        if (url === "/regions") return { data: [{ id: 3, nom: "Kindia" }, { id: 4, nom: "Labé" }] };
        if (url.endsWith("/rapports/regions")) {
          if (h.rapport === "403") throw { response: { status: 403, data: { error: "Accès refusé" } } };
          if (h.rapport === "500") throw { response: { status: 500, data: {} } };
          const regions = h.rapport === "vide" ? [] : [ligne("Kindia"), ligne("Labé", { degradePct: null, critiquePct: null, kmEligible: 0, disponibilite: "NON_DISPONIBLE" })];
          return { data: { rapport: { perimetre: { libelle: "Ensemble du pays" }, regions, total: ligne("TOTAL national"), avertissements: ["Perimetre : reseau classe saisi."] }, filtres: { appliques: {}, nonAppliques: [] } } };
        }
        if (url.endsWith("/aide-decision/exports")) {
          if (h.journal === "500") throw { response: { status: 500, data: {} } };
          if (h.journal === "attente") return new Promise(() => undefined);
          const data = h.journal === "vide" ? [] : [{
            id: "e1", type: "reseau_regions", format: "csv", auteur: { id: "u1", email: "gest@ageroute.invalid", role: "GESTIONNAIRE" }, filtres: { regionId: 3 },
            perimetre: { libelle: "Region Kindia" }, nbLignes: 2, tailleOctets: 800, empreinteSha256: "cd".repeat(32), droitFinancier: false, colonnesRetirees: ["cout_estime_gnf"], creeLe: "2026-10-29T10:00:00Z",
          }, {
            id: "e2", type: "synthese", format: "json", auteur: { id: "u1", email: "gest@ageroute.invalid", role: "GESTIONNAIRE" }, filtres: {},
            perimetre: { libelle: "National" }, nbLignes: 10, tailleOctets: 4000, empreinteSha256: "ef".repeat(32), droitFinancier: true, colonnesRetirees: [], creeLe: "2026-10-28T10:00:00Z",
          }];
          return { data: { total: data.length, data } };
        }
        if (url.includes("/simulations")) {
          return { data: { data: h.scenarios === "vide" ? [] : [{ id: "s-1", intitule: "Scénario synthétique", annee: 2027, provisoire: true }], total: 1 } };
        }
        throw new Error(`appel inattendu : ${url}`);
      }),
      post: vi.fn(async (url: string, corps: unknown) => {
        h.posts.push({ url, corps: corps as Record<string, unknown> });
        return { data: new Blob(["x"]), headers: { "content-disposition": 'attachment; filename="export.csv"', "x-export-nb-lignes": "2" } };
      }),
    },
  };
});

import { OngletRapports } from "./OngletRapports";

function rendre(filtres: FiltresDecision = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><OngletRapports filtres={filtres} onFiltres={() => undefined} /></QueryClientProvider>);
}

beforeEach(() => {
  h.user = { id: "u1", role: "GESTIONNAIRE", modulesAutorises: ["rapports", "programmation", "marches", "decision"] };
  h.gets.length = 0; h.posts.length = 0; h.rapport = "ok"; h.journal = "ok"; h.scenarios = "ok";
  URL.createObjectURL = vi.fn(() => "blob:test"); URL.revokeObjectURL = vi.fn();
  HTMLAnchorElement.prototype.click = vi.fn();
});

describe("OngletRapports", () => {
  it("MUTATION DE CONTROLE : la mention « consultatif, non engageant » est visible en permanence", async () => {
    const { container } = rendre();
    const mention = container.querySelector('[data-mention="consultatif"]');
    expect(mention).not.toBeNull();
    expect(mention).toHaveTextContent(/Consultatif, non engageant/);
    await screen.findByText("Kindia");
  });

  it("propose les quatre types de rapport et le format ; le PDF est dit indisponible", () => {
    rendre();
    for (const t of ["Rapport de synthèse", "État du réseau par région", "Liste des interventions prioritaires", "Scénario de programmation"]) {
      expect(screen.getByRole("radio", { name: new RegExp(t) })).toBeInTheDocument();
    }
    expect(screen.getByLabelText("Format du fichier")).toBeInTheDocument();
    expect(screen.getByText(/PDF : non disponible/)).toBeInTheDocument();
  });

  it("apercu par region : non evalue a part, taux non calculable = « Non disponible », jamais 0 %", async () => {
    rendre();
    const table = await screen.findByRole("table", { name: /Kilomètres par état et par région/ });
    const lab = within(table).getByRole("row", { name: /Labé/ });
    expect(within(lab).getByText("Non disponible")).toBeInTheDocument();
    expect(lab).not.toHaveTextContent(/\b0\s?%/);
    const kin = within(table).getByRole("row", { name: /Kindia/ });
    expect(kin).toHaveTextContent(/44,4\s*%/);
    expect(kin).toHaveTextContent(/40\s*km/);
  });

  it("l'apercu et l'export portent les MEMES filtres que la page ; la periode est annoncee NON appliquee avec sa raison", async () => {
    const u = userEvent.setup({ delay: null });
    rendre({ regionId: 3, classe: ["RN"], depuis: "2026-01-01" });
    await waitFor(() => expect(h.gets.some((g) => g.url.endsWith("/rapports/regions"))).toBe(true));
    expect(h.gets.find((g) => g.url.endsWith("/rapports/regions"))?.params).toMatchObject({ regionId: "3", classe: "RN", depuis: "2026-01-01" });
    const ap = screen.getByRole("region", { name: /Paramètres de l'export/ });
    expect(await within(ap).findByText(/Région : Kindia/)).toBeInTheDocument();
    expect(within(ap).getByText(/Début de période : non appliqué, l'état du réseau est un instantané courant/)).toBeInTheDocument();
    expect(within(ap).getByText(/Axe \/ projet : indisponible/)).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: /Exporter : État du réseau par région \(CSV\)/ }));
    await waitFor(() => expect(h.posts).toHaveLength(1));
    expect(h.posts[0].corps).toEqual({ type: "reseau_regions", format: "csv", filtres: { regionId: 3, classe: ["RN"], depuis: "2026-01-01" } });
  });

  it("MUTATION DE CONTROLE : export sans filtres = pas de champ filtres, et l'apercu dit que tout le perimetre autorise sera exporte", async () => {
    const u = userEvent.setup({ delay: null });
    rendre();
    expect(await screen.findByText(/Aucun filtre : tout le périmètre autorisé est exporté/)).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: /Exporter : État du réseau par région \(CSV\)/ }));
    await waitFor(() => expect(h.posts).toHaveLength(1));
    expect(h.posts[0].corps).toEqual({ type: "reseau_regions", format: "csv" });
  });

  it("le format JSON choisi est celui envoye", async () => {
    const u = userEvent.setup({ delay: null });
    rendre();
    await u.selectOptions(screen.getByLabelText("Format du fichier"), "json");
    await u.click(screen.getByRole("button", { name: /Exporter : État du réseau par région \(JSON\)/ }));
    await waitFor(() => expect(h.posts[0].corps.format).toBe("json"));
  });

  it("type scenario : liste des scenarios, bouton inactif avec sa raison tant qu'aucun n'est choisi, puis scenarioId envoye", async () => {
    const u = userEvent.setup({ delay: null });
    rendre();
    await u.click(screen.getByRole("radio", { name: /Scénario de programmation/ }));
    const bouton = screen.getByRole("button", { name: /Exporter : Scénario de programmation/ });
    expect(bouton).toBeDisabled();
    expect(screen.getByText(/Choisissez le scénario à exporter/)).toBeVisible();
    await u.selectOptions(await screen.findByLabelText("Scénario à exporter"), "s-1");
    expect(bouton).toBeEnabled();
    await u.click(bouton);
    await waitFor(() => expect(h.posts).toHaveLength(1));
    expect(h.posts[0].corps).toEqual({ type: "scenario", format: "csv", scenarioId: "s-1" });
  });

  it("aucun scenario calcule : etat vide explicite, pas un select vide", async () => {
    h.scenarios = "vide";
    const u = userEvent.setup({ delay: null });
    rendre();
    await u.click(screen.getByRole("radio", { name: /Liste des interventions prioritaires/ }));
    expect(await screen.findByText("Aucun scénario calculé")).toBeInTheDocument();
  });

  it("un LECTEUR voit le bouton inactif avec la raison", async () => {
    h.user = { id: "u2", role: "LECTEUR", modulesAutorises: ["rapports"] };
    rendre();
    expect(screen.getByRole("button", { name: /Exporter/ })).toBeDisabled();
    expect(screen.getByText(/réservé aux rôles Administrateur et Gestionnaire/)).toBeVisible();
    await screen.findByText("Kindia");
  });

  it("journal : qui, quand, type, filtres, perimetre, lignes, empreinte ; un export sans filtre le dit", async () => {
    rendre();
    const table = await screen.findByRole("table", { name: /Exports récents/ });
    expect(within(table).getAllByText("gest@ageroute.invalid")).toHaveLength(2);
    expect(within(table).getByText(/regionId = 3/)).toBeInTheDocument();
    expect(within(table).getByText(/aucun filtre \(tout le périmètre autorisé\)/)).toBeInTheDocument();
    expect(within(table).getByText(/sans colonnes financières/)).toBeInTheDocument();
    expect(within(table).getByText("cdcdcdcdcdcd…")).toHaveAttribute("title", "cd".repeat(32));
  });

  it("journal vide : etat vide explicite ; journal en erreur : alerte + Reessayer ; chargement : status", async () => {
    h.journal = "vide";
    const { unmount } = rendre();
    expect(await screen.findByText("Aucun export enregistré")).toBeInTheDocument();
    unmount();
    h.journal = "500";
    const r2 = rendre();
    const alerte = await screen.findByRole("alert", {}, { timeout: 3000 });
    expect(alerte).toHaveTextContent(/journal des exports/i);
    expect(within(alerte).getByRole("button", { name: /Réessayer : journal des exports/ })).toBeInTheDocument();
    r2.unmount();
    h.journal = "attente";
    rendre();
    expect(await screen.findByText(/Chargement du journal des exports/)).toBeInTheDocument();
  });

  it("apercu par region : vide explicite, erreur 500 avec Reessayer, refus 403 en etat dedie", async () => {
    h.rapport = "vide";
    const a = rendre();
    expect(await screen.findByText("Aucune région dans ce périmètre")).toBeInTheDocument();
    a.unmount();
    h.rapport = "500";
    const b = rendre();
    expect(await screen.findByRole("alert", {}, { timeout: 3000 })).toHaveTextContent(/aperçu par région/i);
    b.unmount();
    h.rapport = "403";
    rendre();
    expect(await screen.findByText(/aperçu par région : accès refusé/i)).toBeInTheDocument();
  });

  it("periode incoherente : l'apercu n'appelle pas le serveur, le bouton est inactif avec la raison", () => {
    rendre({ depuis: "2026-05-02", jusqua: "2026-05-01" });
    expect(h.gets.some((g) => g.url.endsWith("/rapports/regions"))).toBe(false);
    expect(screen.getByRole("button", { name: /Exporter/ })).toBeDisabled();
    expect(screen.getByText(/Corrigez la période avant d'exporter/)).toBeVisible();
  });

  it("sans violation d'accessibilite (axe), vue par region et vue scenario", async () => {
    const u = userEvent.setup({ delay: null });
    const { container } = rendre({ regionId: 3, depuis: "2026-01-01" });
    await screen.findByRole("table", { name: /Kilomètres par état/ });
    await screen.findByRole("table", { name: /Exports récents/ });
    expect(await violationsAccessibilite(container)).toEqual([]);
    await u.click(screen.getByRole("radio", { name: /Scénario de programmation/ }));
    await screen.findByLabelText("Scénario à exporter");
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

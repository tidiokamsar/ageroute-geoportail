import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { violationsAccessibilite } from "../../../test/accessibilite";

/**
 * Revue independante du frontend (lot 6), composants : journal reserve selon les droits (aucune requete evitable), relance
 * seulement sur panne passagere, longueur metier inconnue dite en mots (pas « 0 km »). Donnees SYNTHETIQUES.
 */
const h = vi.hoisted(() => ({
  user: { id: "u1", role: "GESTIONNAIRE", modulesAutorises: ["rapports"] } as { id: string; role: string; modulesAutorises: string[] },
  appels: [] as string[],
  statutJournal: 200 as number,
  statutRapport: 200 as number,
}));

vi.mock("../../../lib/auth", () => ({ useAuth: () => ({ user: h.user }) }));
vi.mock("../../../lib/api", () => {
  const ligne = (region: string, o: Record<string, unknown> = {}) => ({
    region, troncons: 4, tronconsSansLongueurMetier: 0, kmPerimetre: 100, kmBon: 60, kmMoyen: 0, kmMauvais: 30, kmCritique: 10, kmEtatNonValide: 0,
    kmNonEvalue: 0, kmEligible: 100, degradePct: 40, critiquePct: 10, partNonEvaluee: 0, disponibilite: "DISPONIBLE", ...o,
  });
  return {
    api: {
      get: vi.fn(async (url: string) => {
        h.appels.push(url);
        if (url.endsWith("/aide-decision/exports")) {
          if (h.statutJournal !== 200) throw { response: { status: h.statutJournal, data: { error: "refus" } } };
          return { data: { total: 1, data: [{ id: "e1", type: "synthese", format: "csv", auteur: { id: "u", email: "g@x.invalid", role: "GESTIONNAIRE" }, filtres: {}, perimetre: { libelle: "National" }, nbLignes: 3, tailleOctets: 10, empreinteSha256: "ab".repeat(32), droitFinancier: true, colonnesRetirees: [], creeLe: "2026-10-29T10:00:00Z" }] } };
        }
        if (url.endsWith("/rapports/regions")) {
          if (h.statutRapport !== 200) throw { response: { status: h.statutRapport, data: { error: "indisponible" } } };
          const sans = ligne("Mamou", { troncons: 4, tronconsSansLongueurMetier: 4, kmPerimetre: 0, kmBon: 0, kmMauvais: 0, kmCritique: 0, kmEligible: 0, degradePct: null, critiquePct: null, disponibilite: "NON_DISPONIBLE" });
          const partiel = ligne("Labé", { troncons: 5, tronconsSansLongueurMetier: 1, kmPerimetre: 80, disponibilite: "PARTIEL" });
          return { data: { rapport: { perimetre: { libelle: "Ensemble du pays" }, regions: [sans, partiel, ligne("Kindia")], total: ligne("TOTAL national"), avertissements: [] }, filtres: { nonAppliques: [] } } };
        }
        throw new Error(`appel inattendu : ${url}`);
      }),
    },
  };
});

import { JournalExports } from "./JournalExports";
import { RapportRegionsTable } from "./RapportRegionsTable";

// La relance est celle du code applicatif (retry/retryDelay des requetes) : le client de test ne la neutralise pas.
const rendre = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
const appelsJournal = () => h.appels.filter((u) => u.endsWith("/aide-decision/exports")).length;
const appelsRapport = () => h.appels.filter((u) => u.endsWith("/rapports/regions")).length;

beforeEach(() => {
  h.user = { id: "u1", role: "GESTIONNAIRE", modulesAutorises: ["rapports"] };
  h.appels.length = 0; h.statutJournal = 200; h.statutRapport = 200;
});

describe("JournalExports : selon les droits, sans requete evitable", () => {
  it("un LECTEUR (meme avec le module rapports) : message neutre, AUCUNE requete, aucune alerte", async () => {
    h.user = { id: "u2", role: "LECTEUR", modulesAutorises: ["rapports"] };
    const { container } = rendre(<JournalExports />);
    expect(await screen.findByText(/consultable que par les Administrateurs et Gestionnaires/)).toBeInTheDocument();
    expect(appelsJournal()).toBe(0);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/accès refusé/i)).toBeNull();
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("regle des modules du serveur : une liste VIDE = aucun module, donc pas de requete ; ADMIN jamais restreint", async () => {
    h.user = { id: "u3", role: "GESTIONNAIRE", modulesAutorises: [] };
    const a = rendre(<JournalExports />);
    expect(await screen.findByText(/consultable que par/)).toBeInTheDocument();
    expect(appelsJournal()).toBe(0);
    a.unmount();
    h.user = { id: "u4", role: "ADMIN", modulesAutorises: [] };
    rendre(<JournalExports />);
    expect(await screen.findByRole("table", { name: /Exports récents/ })).toBeInTheDocument();
    expect(appelsJournal()).toBe(1);
  });

  it("un GESTIONNAIRE avec le module rapports lit le journal", async () => {
    rendre(<JournalExports />);
    expect(await screen.findByRole("table", { name: /Exports récents/ })).toBeInTheDocument();
    expect(screen.queryByText(/consultable que par/)).toBeNull();
  });

  it("un 403 du serveur (droit retire entre-temps) n'est PAS relance et prend l'etat dedie", async () => {
    h.statutJournal = 403;
    rendre(<JournalExports />);
    expect(await screen.findByText(/accès refusé/i)).toBeInTheDocument();
    expect(appelsJournal()).toBe(1);
  });
});

describe("relance : jamais sur une erreur de requete", () => {
  it.each([400, 401, 403, 404])("%i sur l'apercu par region : une seule requete", async (statut) => {
    h.statutRapport = statut;
    rendre(<RapportRegionsTable filtres={{}} />);
    await waitFor(() => expect(screen.queryByText(/Chargement de l'aperçu/)).toBeNull(), { timeout: 3000 });
    expect(appelsRapport()).toBe(1);
  });

  it("un 500 est relance UNE fois (panne passagere), puis l'erreur est affichee avec Reessayer", async () => {
    h.statutRapport = 500;
    rendre(<RapportRegionsTable filtres={{}} />);
    const alerte = await screen.findByRole("alert", {}, { timeout: 4000 });
    expect(alerte).toHaveTextContent(/aperçu par région/i);
    expect(appelsRapport()).toBe(2);
  });
});

describe("rapport par region : une longueur inconnue n'est pas 0 km", () => {
  it("region sans aucune longueur metier : « Longueur non renseignée » et son nombre de troncons, aucune valeur « 0 km »", async () => {
    const { container } = rendre(<RapportRegionsTable filtres={{}} />);
    const table = await screen.findByRole("table", { name: /Kilomètres par état/ });
    const mamou = within(table).getByRole("row", { name: /Mamou/ });
    expect(within(mamou).getByText("Longueur non renseignée")).toBeInTheDocument();
    expect(within(mamou).getByText("4 tronçons")).toBeInTheDocument();
    expect(mamou).not.toHaveTextContent(/\b0\s*km/);
    expect(within(mamou).getAllByText("Non disponible").length).toBeGreaterThanOrEqual(7);
    expect(within(mamou).getByText("Taux non disponible")).toBeInTheDocument();
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("region partiellement renseignee : le nombre de troncons manquants et la disponibilite partielle sont dits ; region complete : aucune mention", async () => {
    rendre(<RapportRegionsTable filtres={{}} />);
    const table = await screen.findByRole("table", { name: /Kilomètres par état/ });
    const labe = within(table).getByRole("row", { name: /Labé/ });
    expect(within(labe).getByText("1 tronçon sans longueur métier : km partiels")).toBeInTheDocument();
    expect(within(labe).getByText("Taux partiel (données incomplètes)")).toBeInTheDocument();
    const kindia = within(table).getByRole("row", { name: /Kindia/ });
    expect(within(kindia).queryByText(/longueur/i)).toBeNull();
    expect(kindia).toHaveTextContent(/40\s*%/);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { VoletPortions as Portions, VoletProgrammation as Programmation } from "../lib/tableauDeBord";
import { violationsAccessibilite } from "../test/accessibilite";

/**
 * Fiche 360, volets portion et programmation : ce que ces tests defendent.
 *   - la version courante, l'historique (versions remplacees, lignage) et l'etat a une date sont distincts ;
 *   - une date d'effet absente est dite « non renseignee », jamais remplacee par une date ;
 *   - l'etat a une date appelle le curseur temporel existant, et ne propose aucune date future ;
 *   - un montant en GNF reste une chaine ; les interventions figees sont declarees absentes ;
 *   - hors perimetre (403), le refus du serveur est affiche ; chargement, erreur et vide sont soignes.
 */

const h = vi.hoisted(() => ({
  portions: null as unknown, programmation: null as unknown, curseur: null as unknown,
  erreur: null as null | { response?: { data?: { error?: string } } }, appels: [] as { url: string; params?: unknown }[],
}));
vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string, config?: { params?: unknown }) => {
      h.appels.push({ url, params: config?.params });
      if (h.erreur) throw h.erreur;
      if (url.endsWith("/portions")) return { data: h.portions };
      if (url.endsWith("/programmation")) return { data: h.programmation };
      if (url === "/v2/portions/a-la-date") return { data: h.curseur };
      throw new Error(`URL inattendue ${url}`);
    }),
  },
}));

import { VoletPortions, VoletProgrammation } from "./Fiche360Volets";

const n = (s: string | null) => (s ?? "").replace(/\s/g, " ");
function rendre(el: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{el}</QueryClientProvider>);
}

const version = (id: string, o: Partial<Portions["historique"][number]> = {}): Portions["historique"][number] => ({
  id, debutM: 0, finM: 400, etat: "BON", etatLibelle: "Bon", revetement: "BITUME", statutValidation: "VALIDE", origine: "SAISIE_TERRAIN",
  valideDu: "2026-01-01", valideAu: null, enregistreLe: "2026-01-10T08:00:00Z", observeeLe: null, remplaceeLe: null, courante: true, issueDe: [], ...o,
});
const v1 = version("p1", { courante: false, valideAu: "2026-06-01", remplaceeLe: "2026-06-02T09:00:00Z" });
const v2 = version("p2", { etat: "MAUVAIS", etatLibelle: "Mauvais", valideDu: "2026-06-01", issueDe: ["p1"] });
const portionsBase: Portions = {
  tronconId: "t1", tronconCode: "GN N0001", tronconNom: "Conakry", courantes: [v2], historique: [v1, v2], tronque: false, plafond: 500,
  comptes: { courantes: 1, remplacees: 1, sansDateEffet: 0 },
};
const programmationBase: Programmation = {
  tronconId: "t1", tronconCode: "GN N0001",
  previsions: [
    { id: "a", annee: 2027, intitule: "Réhabilitation", statut: "RETENU", source: "SAISIE", bailleur: "AFD", typeIntervention: "REHABILITATION", priorite: 1, montantPrevuGnf: "9007199254740993" },
    { id: "b", annee: 2028, intitule: "Entretien", statut: "PROPOSE", source: "SAISIE", bailleur: null, typeIntervention: null, priorite: null, montantPrevuGnf: "500" },
  ],
  totaux: [{ statut: "RETENU", nb: 1, montantGnf: "9007199254740993" }, { statut: "PROPOSE", nb: 1, montantGnf: "500" }],
  chantiers: [{ id: "c", intitule: "Reprise radier", statut: "EN_COURS", avancementPct: 40, entreprise: "ETP", montantGnf: null, dateDebutPrevue: null, dateFinPrevue: "2026-12-31" }],
  interventionsFigees: {
    disponible: true, total: 1, tronque: false, plafond: 100,
    fiches: [{
      id: "f1", reference: "FI-2027-ABCDEF1234", scenarioId: "s1", annee: 2027, parametresVersion: "prog-provisoire-1", empreinteSha256: "ab".repeat(32),
      figeLe: "2026-10-23T10:00:00Z", statut: "PROPOSE", rangStatut: 2, statutDepuis: "2026-10-24T08:00:00Z", traitement: "rehabilitation",
      montantGnf: "4400000000", provisoire: true, etiquette: "PROVISOIRE, non approuvé",
      historique: [
        { rang: 1, de: null, vers: "BROUILLON", origine: "GEOPORTAIL", motif: null, enregistreLe: "2026-10-23T10:00:01Z" },
        { rang: 2, de: "BROUILLON", vers: "PROPOSE", origine: "GEOPORTAIL", motif: "relue", enregistreLe: "2026-10-24T08:00:00Z" },
      ],
    }],
  },
};

beforeEach(() => {
  h.portions = portionsBase; h.programmation = programmationBase; h.erreur = null; h.appels = [];
  h.curseur = {
    dateTerrain: "2026-03-15", connuLe: null, inclureAValider: false, tronque: false, plafond: 5000,
    comptes: { retenues: 1, aValiderEcartees: 0, sansDateEffet: 0, datesIncoherentes: 0, remplaceesSansFin: 0, ambigues: 0 }, longueurCouverteM: 400,
    portions: [{ id: "p1", tronconId: "t1", tronconCode: "GN N0001", tronconNom: "Conakry", debutM: 0, finM: 400, longueurM: 400, revetement: null, etat: "BON", etatLibelle: "Bon",
      praticabilite: null, largeurM: null, source: null, confiance: null, observeeLe: null, valideDu: "2026-01-01", valideAu: "2026-06-01", enregistreLe: "2026-01-10T08:00:00Z", statut: "VALIDE", ambigue: false, geometry: null }],
  };
});

describe("VoletPortions", () => {
  it("distingue la version courante de l'historique, avec les versions remplacees et le lignage", async () => {
    rendre(<VoletPortions tronconId="t1" />);
    const courante = await screen.findByRole("table", { name: "Portions courantes du tronçon" });
    expect(within(courante).getByText("Mauvais")).toBeInTheDocument();
    expect(within(courante).queryByText("Bon")).not.toBeInTheDocument();
    const histo = screen.getByRole("table", { name: "Toutes les versions de portions du tronçon" });
    expect(within(histo).getByText(/Remplacée le 02\/06\/2026/)).toBeInTheDocument();
    expect(within(histo).getByText(/issue de 1 version/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Historique des versions \(2, dont 1 remplacée\)/ })).toBeInTheDocument();
  });

  it("une date d'effet absente est dite non renseignee, et comptee", async () => {
    h.portions = { ...portionsBase, courantes: [version("p3", { valideDu: null })], historique: [version("p3", { valideDu: null })], comptes: { courantes: 1, remplacees: 0, sansDateEffet: 1 } };
    rendre(<VoletPortions tronconId="t1" />);
    expect((await screen.findAllByText("date d'effet non renseignée")).length).toBeGreaterThan(0);
    expect(screen.getByText(/1 version sans date d'effet : elle n'est placée à aucune date/)).toBeInTheDocument();
  });

  it("aucune portion : le dit sans inventer d'etat", async () => {
    h.portions = { ...portionsBase, courantes: [], historique: [], comptes: { courantes: 0, remplacees: 0, sansDateEffet: 0 } };
    rendre(<VoletPortions tronconId="t1" />);
    expect(await screen.findByText(/n'a jamais été inventorié/)).toBeInTheDocument();
    expect(screen.getByText("Aucune version enregistrée.")).toBeInTheDocument();
  });

  it("dit quand l'historique est tronque", async () => {
    h.portions = { ...portionsBase, tronque: true, plafond: 500 };
    rendre(<VoletPortions tronconId="t1" />);
    expect(await screen.findByText(/Historique tronqué à 500 versions/)).toBeInTheDocument();
  });

  it("l'etat a une date appelle le curseur temporel existant, restreint au troncon", async () => {
    rendre(<VoletPortions tronconId="t1" />);
    const champ = await screen.findByLabelText("Jour de terrain");
    expect(screen.getByText(/jamais l'avenir/)).toBeInTheDocument();
    await userEvent.type(champ, "2026-03-15");
    await userEvent.click(screen.getByLabelText("Inclure les propositions non validées"));
    const resume = await screen.findByText(/vraie le 15 mars 2026/);
    expect(resume).toBeInTheDocument();
    const appel = h.appels.filter((a) => a.url === "/v2/portions/a-la-date").pop();
    expect(appel?.params).toEqual({ tronconId: "t1", date: "2026-03-15", inclureAValider: "true" });
    const table = screen.getByRole("table", { name: "Portions vraies le 15 mars 2026" });
    expect(within(table).getByText(/jusqu'au 01\/06\/2026/)).toBeInTheDocument();
  });

  it("le champ date est borne a aujourd'hui : aucune date future proposee", async () => {
    rendre(<VoletPortions tronconId="t1" />);
    const champ = await screen.findByLabelText("Jour de terrain");
    expect(champ).toHaveAttribute("max", new Date().toISOString().slice(0, 10));
    await userEvent.type(champ, "2999-01-01");
    await new Promise((r) => setTimeout(r, 30));
    expect(h.appels.some((a) => a.url === "/v2/portions/a-la-date")).toBe(false);
  });

  it("une vue vide a une date le dit", async () => {
    h.curseur = { ...(h.curseur as object), portions: [], longueurCouverteM: 0 };
    rendre(<VoletPortions tronconId="t1" />);
    await userEvent.type(await screen.findByLabelText("Jour de terrain"), "2026-03-15");
    expect(await screen.findByText(/Aucune portion connue le 15 mars 2026/)).toBeInTheDocument();
  });

  it("hors perimetre (403) : le refus du serveur est affiche, aucune donnee n'est montree", async () => {
    h.erreur = { response: { data: { error: "Cette ecriture touche une region hors de votre perimetre." } } };
    rendre(<VoletPortions tronconId="t1" />);
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent("Le volet portions n'a pas pu être chargé.");
    expect(alerte).toHaveTextContent("hors de votre perimetre");
    expect(screen.queryByTestId("volet-portions")).not.toBeInTheDocument();
  });

  it("affiche un etat de chargement", () => {
    rendre(<VoletPortions tronconId="t1" />);
    expect(screen.getByRole("status")).toHaveTextContent("Chargement du volet portions");
  });
});

describe("VoletProgrammation", () => {
  it("montre les previsions, leurs totaux par statut, et les montants sans les convertir en nombre", async () => {
    rendre(<VoletProgrammation tronconId="t1" />);
    const table = await screen.findByRole("table", { name: "Prévisions budgétaires du tronçon" });
    expect(n(within(table).getByText(/9 007 199 254 740 993/).textContent)).toBe("9 007 199 254 740 993 GNF");
    expect(within(table).getByText("Retenue")).toBeInTheDocument();
    expect(within(table).getByText("non renseigné")).toBeInTheDocument();
    expect(n(screen.getByText(/Proposée : 1 ligne, 500 GNF/).textContent)).toBe("Proposée : 1 ligne, 500 GNF");
  });

  it("liste les chantiers, un montant nul reste « non renseigne »", async () => {
    rendre(<VoletProgrammation tronconId="t1" />);
    const ligne = await screen.findByText(/Reprise radier/);
    expect(ligne).toHaveTextContent("montant non renseigné");
    expect(ligne).toHaveTextContent("fin prévue le 31/12/2026");
  });

  it("liste les interventions figees avec statut courant, etiquette, empreinte et cycle de vie en ajout seul", async () => {
    rendre(<VoletProgrammation tronconId="t1" />);
    const section = await screen.findByTestId("interventions-figees");
    expect(within(section).getByRole("heading", { name: "Interventions figées (1)" })).toBeInTheDocument();
    expect(n(section.textContent)).toContain("FI-2027-ABCDEF1234 · 2027 · Proposée depuis le 24/10/2026 · rehabilitation · 4 400 000 000 GNF");
    expect(within(section).getByText("PROVISOIRE, non approuvé")).toBeInTheDocument();
    expect(within(section).getByText("ab".repeat(32))).toBeInTheDocument();
    const cycle = within(section).getByRole("list", { name: "Cycle de vie de FI-2027-ABCDEF1234" });
    const etapes = within(cycle).getAllByRole("listitem").map((li) => n(li.textContent));
    expect(etapes[0]).toMatch(/^Ouverte à Brouillon · Géoportail · 23\/10\/2026$/);
    expect(etapes[1]).toMatch(/^Brouillon vers Proposée · Géoportail · 24\/10\/2026 · relue$/);
  });

  it("aucune fiche figee : le volet dit que ce n'est pas une absence de besoin", async () => {
    h.programmation = { ...programmationBase, interventionsFigees: { disponible: true, total: 0, tronque: false, plafond: 100, fiches: [] } };
    rendre(<VoletProgrammation tronconId="t1" />);
    expect(await screen.findByText(/Aucune intervention n'a été figée pour ce tronçon/)).toBeInTheDocument();
    expect(screen.getByText(/Ce n'est pas une absence de besoin/)).toBeInTheDocument();
  });

  it("table des fiches absente : le volet le dit, il ne rend pas une liste vide", async () => {
    h.programmation = { ...programmationBase, interventionsFigees: { disponible: false, motif: "La table des fiches d'intervention n'existe pas dans cette base." } };
    rendre(<VoletProgrammation tronconId="t1" />);
    expect(await screen.findByText("Interventions figées : indisponibles.")).toBeInTheDocument();
    expect(screen.getByText(/n'existe pas dans cette base/)).toBeInTheDocument();
  });

  it("aucune violation d'accessibilite sur la liste des interventions figees", async () => {
    const { container } = rendre(<VoletProgrammation tronconId="t1" />);
    await screen.findByTestId("interventions-figees");
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("aucune prevision : ce n'est pas un budget nul", async () => {
    h.programmation = { ...programmationBase, previsions: [], totaux: [], chantiers: [] };
    rendre(<VoletProgrammation tronconId="t1" />);
    expect(await screen.findByText(/Ce n'est pas un budget nul/)).toBeInTheDocument();
    expect(screen.getByText("Aucun chantier rattaché à ce tronçon.")).toBeInTheDocument();
  });

  it("module programmation refuse ou hors perimetre : le refus est affiche", async () => {
    h.erreur = { response: { data: { error: "Accès à ce module non autorisé pour votre compte" } } };
    rendre(<VoletProgrammation tronconId="t1" />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Accès à ce module non autorisé pour votre compte"));
  });
});

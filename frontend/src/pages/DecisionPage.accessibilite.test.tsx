import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configure, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { dictionnaireReel, kpisReels, MAINTENANT_SYNTHETIQUE, REGIONS_SYNTHETIQUES, syntheseReelle } from "../components/decision/synthetique.testutil";
import { violationsAccessibilite } from "../test/accessibilite";

// Le premier import dynamique d'un onglet (Suspense) et la premiere passe d'axe sont lents sur ce poste (disque externe) : le delai par defaut de 1 s ne mesure alors que la machine.
configure({ asyncUtilTimeout: 15_000 });
// Une passe d'axe sur la page entiere en jsdom prend de 5 a 45 s sur ce poste (mesure du 26/10/2026) : le plafond de 30 s de la configuration commune est trop court pour elle.
vi.setConfig({ testTimeout: 120_000 });

vi.mock("../lib/api", () => ({ api: { get: vi.fn() } }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u1", role: "GESTIONNAIRE", modulesAutorises: ["decision", "rapports", "programmation", "marches"] } }) }));
for (const nom of ["Carte", "Liste", "Simulation", "Contractuel", "Scenarios", "Rapports"]) {
  vi.doMock(`../components/decision/onglets/Onglet${nom}`, () => ({
    [`Onglet${nom}`]: () => <p data-testid={`onglet-${nom.toLowerCase()}`}>Contenu synthétique de l&apos;onglet {nom}.</p>,
  }));
}

import { api } from "../lib/api";
import { DecisionPage } from "./DecisionPage";

const get = api.get as unknown as ReturnType<typeof vi.fn>;
type Corps = unknown;
let synthese: Corps | (() => Promise<unknown>) = null;

const erreurHttp = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: {} } });

get.mockImplementation(async (url: string) => {
  if (url === "/regions") return { data: REGIONS_SYNTHETIQUES };
  if (url.endsWith("/dictionnaire")) return { data: dictionnaireReel() };
  if (typeof synthese === "function") return { data: await (synthese as () => Promise<unknown>)() };
  if (synthese instanceof Error) throw synthese;
  return { data: synthese };
});

async function rendreVue(entree: string, attente: () => Promise<unknown>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const r = render(
    <MemoryRouter initialEntries={[entree]}>
      <QueryClientProvider client={qc}><DecisionPage /></QueryClientProvider>
    </MemoryRouter>,
  );
  await attente();
  return r;
}
const kpis = () => screen.findByRole("button", { name: /^Réseau dégradé/ });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(MAINTENANT_SYNTHETIQUE);
  synthese = syntheseReelle();
});
afterEach(() => vi.useRealTimers());

/** Une vue par etat : chacune doit etre exempte de violation axe (WCAG 2 A et AA ; le contraste est mesure en navigateur reel). */
describe("DecisionPage : axe sur chaque vue", () => {
  it.each([
    ["carte", "carte"], ["liste", "liste"], ["simulation", "simulation"], ["contractuel", "contractuel"], ["scenarios", "scenarios"], ["rapports", "rapports"],
  ])("onglet %s, donnees nominales", async (onglet) => {
    const { container } = await rendreVue(`/decision?onglet=${onglet}`, async () => { await kpis(); await screen.findByTestId(`onglet-${onglet}`); });
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("chargement", async () => {
    synthese = () => new Promise(() => {});
    const { container } = await rendreVue("/decision", async () => { await screen.findAllByRole("status"); });
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("erreur 500", async () => {
    synthese = erreurHttp(500);
    const { container } = await rendreVue("/decision", async () => { await screen.findAllByRole("alert"); });
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("permission refusee (403)", async () => {
    synthese = erreurHttp(403);
    const { container } = await rendreVue("/decision", async () => { await screen.findByText(/Indicateurs : accès refusé/); });
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it.each([["objet vide", {}], ["null", null]])("reponse mal formee (%s)", async (_n, corps) => {
    synthese = corps;
    const { container } = await rendreVue("/decision", async () => { await screen.findAllByText(/réponse inattendue/); });
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("aucun indicateur (vide)", async () => {
    synthese = syntheseReelle("nationale", { kpis: [] });
    const { container } = await rendreVue("/decision", async () => { await screen.findByText("Aucun indicateur disponible pour ce périmètre."); });
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("donnees perimees et partielles, sections inattendues", async () => {
    synthese = syntheseReelle("nationale", { fraicheur: { calculeLe: "2026-01-01T00:00:00.000Z", derniereEvaluationLe: null, plusAncienneEvaluationLe: null, ageJours: null, note: "n" }, budget: null, kpis: [...kpisReels(), { code: "x" }] });
    const { container } = await rendreVue("/decision", async () => { await kpis(); await screen.findByRole("button", { name: "Réessayer : budget" }); });
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("definition ouverte, info-bulle ouverte, filtres actifs", async () => {
    const { container } = await rendreVue("/decision?regionId=2&etat=CRITIQUE&depuis=2026-01-01", async () => { await kpis(); });
    await userEvent.click(screen.getByRole("button", { name: "Voir la définition : Réseau dégradé" }));
    await screen.findByRole("region", { name: "Définition : Réseau dégradé" });
    await userEvent.click(screen.getByRole("button", { name: "Définition : Réseau critique (part)" }));
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it.each(["regionaleSansDroits", "tronque", "vide"] as const)("reponse reelle %s", async (nom) => {
    synthese = syntheseReelle(nom);
    const { container } = await rendreVue("/decision", async () => { await screen.findByRole("region", { name: "Fraîcheur et couverture des données" }); await screen.findByText("Budget"); });
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("periode incoherente", async () => {
    const { container } = await rendreVue("/decision?depuis=2026-05-01&jusqua=2026-04-01", async () => { await screen.findByRole("alert"); });
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

describe("DecisionPage : clavier et noms accessibles", () => {
  it("l'ordre de tabulation suit l'ordre visuel : evitement, filtres, indicateurs, onglets, export, panneau", async () => {
    await rendreVue("/decision", async () => { await kpis(); await screen.findByTestId("onglet-carte"); });
    const ordre: string[] = [];
    for (let i = 0; i < 80; i++) {
      await userEvent.tab();
      const el = document.activeElement as HTMLElement;
      if (!el || el === document.body) break;
      const libelleChamp = (el as HTMLInputElement).labels?.[0]?.textContent;
      ordre.push(el.getAttribute("aria-label") ?? libelleChamp ?? el.textContent?.trim().slice(0, 40) ?? el.tagName);
      if (el.getAttribute("role") === "tabpanel") break;
    }
    const pos = (re: RegExp) => ordre.findIndex((n) => re.test(n));
    const reperes = [/Aller au contenu/, /^Région$|Masquer les filtres/, /^Réseau dégradé|Réseau dégradé/, /Carte et priorisation/, /^Exporter/];
    const indices = reperes.map(pos);
    expect(indices.every((i) => i >= 0)).toBe(true);
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
    expect(document.activeElement).toHaveAttribute("role", "tabpanel");
  });

  it("les boutons « Réessayer » de la page ont des noms accessibles uniques", async () => {
    synthese = erreurHttp(500);
    await rendreVue("/decision", async () => { await screen.findAllByRole("alert"); });
    const noms = screen.getAllByRole("button", { name: /^Réessayer/ }).map((b) => b.getAttribute("aria-label"));
    expect(new Set(noms).size).toBe(noms.length);
  });

  it("le focus est visible : les controles interactifs portent un anneau de focus", async () => {
    await rendreVue("/decision", async () => { await kpis(); });
    const sansAnneau = Array.from(document.querySelectorAll<HTMLElement>("button, a[href], select, input")).filter((el) => {
      if ((el as HTMLButtonElement).disabled) return false;
      const c = `${el.className} ${el.parentElement?.className ?? ""}`;
      return !/focus(-visible)?:(ring|outline|after:ring)|focus:outline-none|focus-visible:ring|focus:not-sr-only/.test(c) && !/focus-within:ring/.test(el.closest("article")?.className ?? "");
    });
    // Les champs natifs (select, date, case) gardent l'anneau natif du navigateur.
    expect(sansAnneau.filter((e) => !["SELECT", "INPUT"].includes(e.tagName)).map((e) => e.outerHTML.slice(0, 80))).toEqual([]);
  });
});

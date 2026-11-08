import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { FiltresDecision } from "../types";
import { violationsAccessibilite } from "../../../test/accessibilite";
import { ID, ficheReponse, marcheVue, reponse } from "../contractuel/synthetique.testutil";

vi.mock("../../../lib/api", () => ({ api: { get: vi.fn() } }));
import { api } from "../../../lib/api";
import { OngletContractuel } from "./OngletContractuel";

/**
 * Onglet « Suivi contractuel », rendu avec l'API interceptee. Les etats obligatoires (contrat paragraphe 7) sont tous couverts :
 * chargement, erreur, permission refusee (distinct du vide), vide, donnees perimees, donnees partielles. Les « mutations de
 * controle » (engage egal contractuel, declare copie dans le constate, « actifs » pour « recenses ») sont dans les tests de
 * composants voisins et rappelees ici sur l'ecran complet.
 */

const get = api.get as unknown as Mock;
const http = (status: number, data: object = {}) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });
const URL_LISTE = "/v2/aide-decision/contractuel";

function rendre(filtres: FiltresDecision = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (f: FiltresDecision) => (
    <MemoryRouter><QueryClientProvider client={qc}><OngletContractuel filtres={f} onFiltres={() => undefined} /></QueryClientProvider></MemoryRouter>
  );
  const r = render(ui(filtres));
  return { ...r, qc, changerFiltres: (f: FiltresDecision) => r.rerender(ui(f)) };
}

/** Repond a la liste et a la fiche selon l'URL. */
function repondre(liste: () => Promise<unknown> | unknown, fiche?: (id: string) => Promise<unknown> | unknown) {
  get.mockImplementation(async (url: string) => {
    if (url === URL_LISTE) return { data: await liste() };
    const m = /\/marches\/([^/]+)$/.exec(url);
    if (m) {
      if (!fiche) throw http(500);
      return { data: await fiche(decodeURIComponent(m[1])) };
    }
    throw new Error(`appel inattendu ${url}`);
  });
}

beforeEach(() => { get.mockReset(); });

describe("etats de l'ecran", () => {
  it("chargement : role=status, aucun chiffre, aucun tableau", async () => {
    get.mockImplementation(() => new Promise(() => undefined));
    rendre();
    expect(await screen.findByRole("status")).toHaveTextContent("Chargement du suivi contractuel");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("succès : bandeau, synthèse, contrôles et tableau ; titre « Suivi contractuel »", async () => {
    repondre(() => reponse());
    rendre();
    expect(await screen.findByTestId("bandeau-partiel")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Suivi contractuel" })).toBeInTheDocument();
    expect(screen.getByTestId("bandeau-partiel")).toHaveTextContent("Données contractuelles partielles : source de vérité externe non intégrée (DigitalRoad)");
    expect(screen.getByRole("heading", { name: "Synthèse du périmètre" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Contrôles de cohérence" })).toBeInTheDocument();
    expect(screen.getAllByRole("rowheader")).toHaveLength(3 + 2); // tableau des marches + tableau des bailleurs
    expect(screen.queryByText(/Cet onglet n'est pas encore disponible/)).toBeNull();
  });

  it("erreur 500 : role=alert avec « Réessayer » ; le clic relit et affiche les données", async () => {
    let appels = 0;
    repondre(() => { appels += 1; if (appels <= 2) throw http(500, { error: "base indisponible" }); return reponse(); });
    rendre();
    const alerte = await screen.findByRole("alert", {}, { timeout: 4000 });
    expect(alerte).toHaveTextContent("Suivi contractuel : chargement impossible");
    expect(alerte).toHaveTextContent("base indisponible");
    expect(screen.queryByRole("table")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Réessayer : Suivi contractuel" }));
    expect(await screen.findByTestId("bandeau-partiel")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("permission refusée (403) : état dédié, ni alerte de panne, ni vide, ni tableau, et aucune nouvelle tentative", async () => {
    repondre(() => { throw http(403, { error: "Accès à ce module non autorisé pour votre compte" }); });
    rendre();
    const etat = await screen.findByText(/Suivi contractuel : accès refusé/);
    expect(etat.closest("[data-etat]")).toHaveAttribute("data-etat", "permission");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.querySelector('[data-etat="vide"]')).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByTestId("bandeau-partiel")).toBeNull();
    await new Promise((r) => setTimeout(r, 450));
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("vide : message explicite qui ne conclut pas « aucun marché n'existe » ; les contrôles restent affichés", async () => {
    repondre(() => reponse({ marches: [], page: { limite: 25, total: 0, curseurSuivant: null } }));
    rendre();
    const vide = await screen.findByText("Aucun marché recensé pour ce périmètre et ces filtres");
    expect(vide.closest("[data-etat]")).toHaveAttribute("data-etat", "vide");
    expect(screen.getByText(/Ce n'est pas la preuve qu'aucun marché n'existe/)).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: /Marchés recensés dans la copie gelée/ })).toBeNull();
    expect(screen.getByRole("heading", { name: "Contrôles de cohérence" })).toBeInTheDocument();
  });

  it("copie périmée : le bandeau le dit avec le seuil provisoire", async () => {
    const r = reponse();
    repondre(() => ({ ...r, fraicheur: { ...r.fraicheur, ageJours: 200, perime: true } }));
    rendre();
    expect(await screen.findByTestId("bandeau-partiel")).toHaveTextContent("Données périmées (au-delà de 90 jours, seuil provisoire)");
  });

  it("actualisation échouée alors que des données sont affichées : bandeau d'actualisation, le tableau reste", async () => {
    repondre(() => reponse());
    const { qc } = rendre();
    await screen.findByRole("table", { name: /Marchés recensés dans la copie gelée/ });
    get.mockImplementation(async () => { throw http(500); });
    void qc.refetchQueries();
    const bandeau = await waitFor(() => {
      const el = document.querySelector('[data-etat="perime"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    }, { timeout: 4000 });
    expect(bandeau).toHaveTextContent("l'actualisation a échoué");
    expect(screen.getByRole("table", { name: /Marchés recensés dans la copie gelée/ })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("changement de filtre dont la lecture échoue : erreur dédiée, pas de données du filtre précédent", async () => {
    repondre(() => reponse());
    const { changerFiltres } = rendre();
    await screen.findByRole("table", { name: /Marchés recensés dans la copie gelée/ });
    get.mockImplementation(async () => { throw http(500); });
    changerFiltres({ regionId: 2 });
    expect(await screen.findByRole("alert", {}, { timeout: 4000 })).toHaveTextContent("Suivi contractuel : chargement impossible");
    expect(screen.queryByRole("table", { name: /Marchés recensés dans la copie gelée/ })).toBeNull();
  });

  it("sans droit financier : le dit, et aucun montant n'est affiché", async () => {
    const r = reponse({ droitFinancier: false });
    const sansMontant = r.marches.map((m) => marcheVue({
      ...m, montants: Object.fromEntries(Object.entries(m.montants).map(([k, v]) => [k, { ...v, etat: "NON_DISPONIBLE", valeurGnf: null, motif: "DROIT_FINANCIER" }])) as never,
    }));
    repondre(() => ({ ...r, marches: sansMontant, synthese: { ...r.synthese, financier: { contractuel: sansMontant[0].montants.contractuel, engage: sansMontant[0].montants.engage, decaisse: sansMontant[0].montants.decaisse, previsionnel: sansMontant[0].montants.previsionnel }, totauxParBailleur: [] } }));
    rendre();
    expect(await screen.findByText(/n'a pas le droit de consulter les données financières/)).toBeInTheDocument();
    expect(screen.queryByText(/\d\s\d{3}\s\d{3}\s?GNF/)).toBeNull();
    expect(screen.getAllByText("droit financier requis").length).toBeGreaterThan(0);
  });

  it("plafond atteint : l'écran le dit", async () => {
    repondre(() => reponse({ plafond: { marchesAnalyses: 2000, plafond: 2000, tronque: true } }));
    rendre();
    expect(await screen.findByText(/la synthèse et les contrôles portent sur les 2000 plus récents/)).toBeInTheDocument();
  });
});

describe("requetes", () => {
  it("les filtres du module sont envoyés ; le statut de marché est un filtre local de l'onglet", async () => {
    repondre(() => reponse());
    rendre({ regionId: 2, classe: ["RN", "RR"], statutChantier: ["EN_COURS"], depuis: "2026-01-01" });
    await screen.findByTestId("bandeau-partiel");
    expect(get).toHaveBeenLastCalledWith(URL_LISTE, { params: { regionId: "2", classe: "RN,RR", statutChantier: "EN_COURS", depuis: "2026-01-01", limite: "25" } });
    await userEvent.click(screen.getByRole("checkbox", { name: "Soldé" }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(URL_LISTE, { params: expect.objectContaining({ statutMarche: "SOLDE", regionId: "2" }) }));
  });

  it("pagination par curseur : le bouton demande la page suivante avec le curseur et ajoute les lignes", async () => {
    const page1 = reponse({ marches: [marcheVue({ id: ID(1), intitule: "Premier" })], page: { limite: 25, total: 2, curseurSuivant: "CUR" } });
    const page2 = reponse({ marches: [marcheVue({ id: ID(2), intitule: "Second" })], page: { limite: 25, total: 2, curseurSuivant: null } });
    repondre(() => (get.mock.calls.some((c) => (c[1] as { params: { curseur?: string } }).params.curseur === "CUR") ? page2 : page1));
    rendre();
    expect(await screen.findByRole("button", { name: /Ouvrir la fiche du marché Premier/ })).toBeInTheDocument();
    expect(screen.getByText("1 affiché(s) sur 2")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Afficher les marchés suivants" }));
    expect(await screen.findByRole("button", { name: /Ouvrir la fiche du marché Second/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ouvrir la fiche du marché Premier/ })).toBeInTheDocument();
    expect(get).toHaveBeenLastCalledWith(URL_LISTE, { params: expect.objectContaining({ curseur: "CUR" }) });
    expect(screen.queryByRole("button", { name: "Afficher les marchés suivants" })).toBeNull();
  });
});

describe("fiche d'un marche", () => {
  it("clic sur un marché : la fiche s'ouvre, lit la route de fiche, prend le focus ; Échap la ferme et rend le focus à la ligne", async () => {
    const m = reponse().marches[0];
    repondre(() => reponse(), (id) => ficheReponse(m, { marche: { ...m, id } }));
    rendre();
    const bouton = await screen.findByRole("button", { name: /Ouvrir la fiche du marché Réhabilitation RN1/ });
    await userEvent.click(bouton);
    const fiche = await screen.findByTestId("fiche-marche");
    expect(get).toHaveBeenCalledWith(`${URL_LISTE}/marches/${ID(1)}`);
    expect(within(fiche).getByRole("heading", { level: 3, name: m.intitule })).toHaveFocus();
    expect(await within(fiche).findByRole("table", { name: /Seuls les décomptes/ })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("fiche-marche")).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: /Ouvrir la fiche du marché Réhabilitation RN1/ })).toHaveFocus());
  });

  it("depuis un contrôle : « Ouvrir la fiche » ouvre le marché, y compris absent des pages chargées (la fiche suffit)", async () => {
    const r = reponse();
    const absent = marcheVue({ id: ID(77), intitule: "Marché de la page 2" });
    r.controles = [{ ...r.controles[0], nombre: 1, exemples: [{ type: "marche", id: ID(77), marcheId: ID(77), intitule: "Marché de la page 2", detail: "Aucun chantier lié." }] }];
    repondre(() => r, () => ficheReponse(absent));
    rendre();
    await userEvent.click(await screen.findByRole("button", { name: /Ouvrir la fiche : Marché de la page 2/ }));
    expect(await screen.findByRole("heading", { level: 3, name: "Marché de la page 2" })).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith(`${URL_LISTE}/marches/${ID(77)}`);
  });

  it("fiche d'un marché hors des pages chargées en échec (404, hors périmètre) : erreur dédiée, la liste reste", async () => {
    const r = reponse();
    r.controles = [{ ...r.controles[0], nombre: 1, exemples: [{ type: "marche", id: ID(88), marcheId: ID(88), intitule: "Marché hors périmètre", detail: "Aucun chantier lié." }] }];
    repondre(() => r, () => { throw http(404); });
    rendre();
    await userEvent.click(await screen.findByRole("button", { name: /Ouvrir la fiche : Marché hors périmètre/ }));
    expect(await screen.findByText(/Fiche du marché : chargement impossible/)).toBeInTheDocument();
    expect(screen.getByRole("table", { name: /Marchés recensés dans la copie gelée/ })).toBeInTheDocument();
  });

  it("fiche d'un marché de la liste dont la lecture des décomptes échoue : la fiche s'affiche, les décomptes disent l'erreur", async () => {
    repondre(() => reponse(), () => { throw http(500); });
    rendre();
    await userEvent.click(await screen.findByRole("button", { name: /Ouvrir la fiche du marché Réhabilitation RN1/ }));
    const fiche = await screen.findByTestId("fiche-marche");
    expect(await within(fiche).findByText(/Décomptes : chargement impossible/, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(within(fiche).getByText("Avancement constaté", { selector: "dt" })).toBeInTheDocument();
  });

  it("un changement de filtre ferme la fiche", async () => {
    const m = reponse().marches[0];
    repondre(() => reponse(), () => ficheReponse(m));
    const { changerFiltres } = rendre();
    await userEvent.click(await screen.findByRole("button", { name: /Ouvrir la fiche du marché Réhabilitation RN1/ }));
    await screen.findByTestId("fiche-marche");
    changerFiltres({ regionId: 5 });
    await waitFor(() => expect(screen.queryByTestId("fiche-marche")).toBeNull());
  });
});

describe("libelles stricts et accessibilite de l'ecran complet", () => {
  it("MUTATION DE CONTROLE : « recensés » partout, jamais « actifs » comme libellé ; engagé non disponible partout", async () => {
    repondre(() => reponse());
    const { container } = rendre();
    await screen.findByTestId("bandeau-partiel");
    expect(screen.getByRole("heading", { name: "Marchés recensés" })).toBeInTheDocument();
    expect(screen.getByText("Marchés recensés", { selector: "dt" })).toBeInTheDocument();
    for (const mot of ["Contractuel", "Engagé", "Décaissé", "Prévisionnel"]) expect(screen.getAllByText(new RegExp(`^${mot}`)).length).toBeGreaterThan(0);
    // le seul « actif » autorisé est la négation explicite
    const textes = (container.textContent ?? "").match(/[^.]*\bactifs?\b[^.]*\./gi) ?? [];
    for (const t of textes) expect(t).toMatch(/pas un nombre de marchés actifs|aucune règle de statut/i);
    for (const ligne of container.querySelectorAll("tbody tr[data-marche-id]")) {
      const cells = ligne.querySelectorAll("td");
      expect(cells[5].textContent).toContain("Non disponible"); // colonne Engagé (apres l'en-tete de ligne : Bailleur, Entreprise, Statut, Dates, Contractuel, Engage)
    }
  });

  it("aucune violation axe sur l'écran complet, fiche ouverte comprise", async () => {
    const m = reponse().marches[0];
    repondre(() => reponse(), () => ficheReponse(m));
    const { container } = rendre();
    await screen.findByTestId("bandeau-partiel");
    expect(await violationsAccessibilite(container)).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: /Ouvrir la fiche du marché Réhabilitation RN1/ }));
    await screen.findByRole("table", { name: /Seuls les décomptes/ });
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("tous les boutons et cases ont un nom accessible unique par rôle", async () => {
    repondre(() => reponse());
    rendre();
    await screen.findByTestId("bandeau-partiel");
    const noms = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(new Set(noms).size).toBe(noms.length);
  });
});

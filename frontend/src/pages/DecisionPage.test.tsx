import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { dictionnaireReel, kpisReels, MAINTENANT_SYNTHETIQUE, REGIONS_SYNTHETIQUES, syntheseReelle } from "../components/decision/synthetique.testutil";
import { libelleOnglet } from "../lib/decision";

// Le premier import dynamique d'un onglet (Suspense) et la premiere passe d'axe sont lents sur ce poste (disque externe) : le delai par defaut de 1 s ne mesure alors que la machine.
configure({ asyncUtilTimeout: 15_000 });
// Une passe d'axe sur la page entiere en jsdom prend de 5 a 45 s sur ce poste (mesure du 26/10/2026) : le plafond de 30 s de la configuration commune est trop court pour elle.
vi.setConfig({ testTimeout: 120_000 });

vi.mock("../lib/api", () => ({ api: { get: vi.fn() } }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u1", role: "GESTIONNAIRE", modulesAutorises: ["decision", "rapports", "programmation", "marches"] } }) }));

const etat = vi.hoisted(() => ({ planter: false }));
vi.mock("../components/decision/onglets/OngletCarte", () => ({
  OngletCarte: ({ filtres, onFiltres }: { filtres: unknown; onFiltres: (f: unknown) => void }) => (
    <div data-testid="onglet-carte">
      <output data-testid="filtres-recus">{JSON.stringify(filtres)}</output>
      <button type="button" onClick={() => onFiltres({ regionId: 3 })}>Stub : région 3</button>
    </div>
  ),
}));
vi.mock("../components/decision/onglets/OngletListe", () => ({
  OngletListe: ({ filtres }: { filtres: unknown }) => {
    if (etat.planter) throw new Error("plantage volontaire de l'onglet Liste");
    return <div data-testid="onglet-liste"><output data-testid="filtres-recus">{JSON.stringify(filtres)}</output></div>;
  },
}));
for (const nom of ["Simulation", "Contractuel", "Scenarios", "Rapports"]) {
  vi.doMock(`../components/decision/onglets/Onglet${nom}`, () => ({
    [`Onglet${nom}`]: ({ filtres }: { filtres: unknown }) => <div data-testid={`onglet-${nom.toLowerCase()}`}><output data-testid="filtres-recus">{JSON.stringify(filtres)}</output></div>,
  }));
}

import { api } from "../lib/api";
import { DecisionPage } from "./DecisionPage";

const get = api.get as unknown as ReturnType<typeof vi.fn>;

type Reponse = unknown | (() => Promise<unknown>);
interface Serveur { synthese: Reponse; regions: Reponse; dictionnaire: Reponse }
const serveur: Serveur = { synthese: null, regions: null, dictionnaire: null };

const erreurHttp = (status: number, error?: string) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: error ? { error } : {} } });

/** Les reponses sont des reponses REELLES de composerSynthese et reponseDictionnaire (voir synthetique.testutil.ts). */
function servir(p: Partial<Serveur> = {}) {
  Object.assign(serveur, { synthese: syntheseReelle(), regions: REGIONS_SYNTHETIQUES, dictionnaire: dictionnaireReel() }, p);
}

get.mockImplementation(async (url: string) => {
  const cle = url.endsWith("/synthese") ? "synthese" : url.endsWith("/dictionnaire") ? "dictionnaire" : url === "/regions" ? "regions" : null;
  if (!cle) throw new Error(`appel inattendu : ${url}`);
  const r = serveur[cle];
  if (typeof r === "function") return { data: await (r as () => Promise<unknown>)() };
  if (r instanceof Error) throw r;
  return { data: r };
});

function Sonde() {
  const l = useLocation();
  return <output data-testid="url">{l.pathname + l.search}</output>;
}

function rendre(entree = "/decision") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const r = render(
    <MemoryRouter initialEntries={[entree]}>
      <QueryClientProvider client={qc}>
        <DecisionPage />
        <Sonde />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { qc, ...r };
}

const url = () => screen.getByTestId("url").textContent ?? "";
const appelsSynthese = () => get.mock.calls.filter((c) => String(c[0]).endsWith("/synthese"));
const attendreKpi = () => screen.findByRole("button", { name: /^Réseau dégradé/ });
/** Le nom accessible d'une vignette COMMENCE par son libelle (qui peut contenir des parentheses : pas de regex). */
const boutonKpi = (libelle: string) => screen.findByRole("button", { name: (n) => n.startsWith(`${libelle} `) });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(MAINTENANT_SYNTHETIQUE);
  etat.planter = false;
  get.mockClear();
  servir();
});
afterEach(() => vi.useRealTimers());

describe("DecisionPage : shell", () => {
  it("porte description, mention consultative, six onglets, bouton d'export gouverne, sans second titre", async () => {
    rendre();
    await attendreKpi();
    expect(screen.getByText(/Priorisation des interventions, simulation budgétaire et suivi contractuel/)).toBeInTheDocument();
    expect(screen.getByTestId("mention-consultative")).toHaveTextContent("Consultatif : les priorités et simulations ne sont ni des ordres de travaux ni des autorisations financières");
    expect(screen.getAllByRole("tab")).toHaveLength(6);
    // Un seul titre de page : celui du Header. La page n'ajoute pas de h1.
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    // L'export gouverne est branche (lot 6) : le bouton est celui de BoutonExportDecision, plus un bouton inerte.
    const exporter = screen.getByRole("button", { name: /Exporter/ });
    expect(exporter).toBeInTheDocument();
    expect(screen.queryByText(/Export indisponible/)).not.toBeInTheDocument();
    expect(url()).toBe("/decision");
  });

  it("le lien d'evitement amene le focus au contenu de l'onglet", async () => {
    rendre();
    await attendreKpi();
    await userEvent.click(screen.getByRole("link", { name: /Aller au contenu/ }));
    expect(screen.getByRole("tabpanel")).toHaveFocus();
  });

  it("monte l'onglet Carte par defaut avec la zone de synthese, et la retire sur les autres onglets", async () => {
    rendre();
    expect(await screen.findByTestId("onglet-carte")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Répartition de l'état du réseau" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Liste des interventions" }));
    expect(await screen.findByTestId("onglet-liste")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Répartition de l'état du réseau" })).not.toBeInTheDocument();
    expect(url()).toBe("/decision?onglet=liste");
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Liste des interventions");
  });

  it("monte chacun des six onglets avec { filtres, onFiltres }", async () => {
    rendre();
    for (const [nom, testid] of [["Carte et priorisation", "onglet-carte"], ["Liste des interventions", "onglet-liste"], ["Simulation budgétaire", "onglet-simulation"], ["Suivi contractuel", "onglet-contractuel"], ["Scénarios", "onglet-scenarios"], ["Rapports", "onglet-rapports"]] as const) {
      await userEvent.click(screen.getByRole("tab", { name: nom }));
      expect(await screen.findByTestId(testid)).toBeInTheDocument();
    }
  });
});

describe("DecisionPage : indicateurs cliquables (chaque KPI ouvre son explication)", () => {
  it("rend chacun des douze indicateurs de la reponse reelle comme un bouton", async () => {
    rendre();
    await attendreKpi();
    expect(kpisReels()).toHaveLength(12);
    for (const k of kpisReels()) expect(await boutonKpi(k.libelle), k.code).toBeInTheDocument();
  });

  it.each(kpisReels().map((k) => [k.code, k] as const))("%s ouvre son onglet et ses filtres, par-dessus les filtres de la page", async (_code, k) => {
    rendre("/decision?regionId=2");
    await userEvent.click(await boutonKpi(k.libelle));
    const attendu = new URLSearchParams(url().split("?")[1]);
    expect(attendu.get("onglet") ?? "carte").toBe(k.ouvre.onglet);
    expect(attendu.get("regionId")).toBe("2");
    for (const [cle, val] of Object.entries(k.ouvre.filtres)) expect(attendu.get(cle)).toBe(Array.isArray(val) ? val.join(",") : String(val));
    expect(screen.getByRole("tab", { selected: true })).toHaveAccessibleName(libelleOnglet(k.ouvre.onglet));
    await waitFor(() => expect(screen.getByRole("tabpanel")).toHaveFocus());
  });

  it("un indicateur NON_DISPONIBLE montre sa raison et aucun zero dans toute la rangee", async () => {
    rendre();
    const bouton = await boutonKpi("Budget engagé");
    const carte = bouton.closest("article") as HTMLElement;
    expect(within(carte).getByTestId("raison-kpi")).toHaveTextContent(/Budget engagé : source financière de référence non validée/);
    expect(carte).toHaveAttribute("data-etat", "NON_DISPONIBLE");
    expect(carte.textContent).not.toMatch(/(^|\D)0(\D|$)/);
  });

  it("le montant contractuel exact (valeur null, valeurTexte) est montre en entier sur la vignette", async () => {
    rendre();
    const carte = (await boutonKpi("Budget contractuel")).closest("article") as HTMLElement;
    expect(carte.textContent?.replace(/[\u00a0\u202f]/g, " ")).toContain("9 007 199 254 740 993 GNF");
    expect(carte.textContent).not.toMatch(/indisponible/i);
  });

  it("les unites « part » et « nombre » ne s'impriment pas brutes", async () => {
    rendre();
    await attendreKpi();
    const texte = screen.getAllByRole("article").map((a) => a.textContent ?? "").join("\n");
    expect(texte).not.toMatch(/\bpart\b\s*(Voir|$)/m);
    expect(texte).not.toMatch(/\d\s*nombre/);
    const couverture = (await boutonKpi("Couverture de l'état (part du réseau à état valide)")).closest("article") as HTMLElement;
    expect(couverture.querySelector("[id$='-valeur']")?.textContent?.replace(/[\u00a0\u202f]/g, " ")).toBe("25 %");
  });

  it("« Voir la définition » ouvre la definition detaillee du DICTIONNAIRE REEL (conditions, exclusions, decisions ouvertes), la ferme et rend le focus", async () => {
    const entree = (dictionnaireReel().indicateurs as { code: string; conditionsCalcul: string[]; reglesExclusion: string[]; decisionsOuvertes: string[]; responsableMetier: string }[]).find((e) => e.code === "reseau_degrade_pct")!;
    rendre();
    await attendreKpi();
    const voir = screen.getByRole("button", { name: "Voir la définition : Réseau dégradé" });
    await userEvent.click(voir);
    const panneau = await screen.findByRole("region", { name: "Définition : Réseau dégradé" });
    expect(await within(panneau).findByText(entree.conditionsCalcul[0])).toBeInTheDocument();
    expect(within(panneau).getByText(entree.reglesExclusion[0])).toBeInTheDocument();
    // les decisions metier NON tranchees sont montrees
    const ouvertes = within(panneau).getByTestId("decisions-ouvertes");
    expect(within(panneau).getByText("Décisions métier non tranchées")).toBeInTheDocument();
    for (const d of entree.decisionsOuvertes) expect(within(ouvertes).getByText(d)).toBeInTheDocument();
    expect(within(panneau).getByText(entree.responsableMetier)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Définition : Réseau dégradé" })).toHaveFocus();
    await userEvent.click(within(panneau).getByRole("button", { name: /Fermer la définition/ }));
    expect(screen.queryByRole("region", { name: "Définition : Réseau dégradé" })).not.toBeInTheDocument();
    await waitFor(() => expect(voir).toHaveFocus());
  });

  it("dictionnaire en panne : la definition de la reponse reste lisible, avec une note", async () => {
    servir({ dictionnaire: erreurHttp(500) });
    rendre();
    await attendreKpi();
    await userEvent.click(screen.getByRole("button", { name: "Voir la définition : Réseau dégradé" }));
    const panneau = await screen.findByRole("region", { name: "Définition : Réseau dégradé" });
    expect(within(panneau).getByText(/Part de la longueur métier du réseau classé saisi/)).toBeInTheDocument();
    expect(await within(panneau).findByText(/dictionnaire détaillé est indisponible/)).toBeInTheDocument();
  });
});

describe("DecisionPage : filtres synchronises avec l'URL", () => {
  it("lit l'onglet et les filtres de l'URL, les transmet a l'onglet et a l'API", async () => {
    rendre("/decision?onglet=liste&regionId=2&etat=BON,MOYEN&depuis=2026-01-01");
    expect(await screen.findByTestId("onglet-liste")).toBeInTheDocument();
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Liste des interventions");
    expect(JSON.parse(screen.getByTestId("filtres-recus").textContent ?? "{}")).toEqual({ regionId: 2, etat: ["BON", "MOYEN"], depuis: "2026-01-01" });
    await waitFor(() => expect(appelsSynthese().length).toBeGreaterThan(0));
    expect(appelsSynthese()[0][1]).toEqual({ params: { regionId: "2", etat: "BON,MOYEN", depuis: "2026-01-01" } });
    expect(await screen.findByLabelText("Région")).toHaveValue("2");
  });

  it("ignore une URL invalide sans planter ni envoyer le parametre", async () => {
    rendre("/decision?onglet=bidon&regionId=abc&etat=<x>,SUPER&classe=XX&depuis=2026-13-45&jusqua=2101-01-01");
    await attendreKpi();
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Carte et priorisation");
    expect(appelsSynthese()[0][1]).toEqual({ params: {} });
  });

  it("un changement de filtre met l'URL a jour (remplacement) et relit la synthese au nouveau perimetre", async () => {
    rendre();
    await attendreKpi();
    await userEvent.selectOptions(await screen.findByLabelText("Région"), "2");
    expect(url()).toBe("/decision?regionId=2");
    await waitFor(() => expect(appelsSynthese().at(-1)?.[1]).toEqual({ params: { regionId: "2" } }));
    await userEvent.click(screen.getByLabelText("Critique"));
    expect(url()).toBe("/decision?regionId=2&etat=CRITIQUE");
  });

  it("le changement de perimetre ne montre jamais les anciens chiffres sous le nouveau filtre", async () => {
    let n = 0;
    servir({ synthese: () => { n += 1; return n === 1 ? Promise.resolve(syntheseReelle()) : new Promise(() => {}); } });
    rendre();
    await attendreKpi();
    await userEvent.selectOptions(await screen.findByLabelText("Région"), "2");
    expect(await screen.findByText("Chargement des indicateurs…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Réseau dégradé/ })).not.toBeInTheDocument();
  });

  it("un onglet qui change les filtres (onFiltres) met l'URL et les indicateurs a jour", async () => {
    rendre();
    await userEvent.click(await screen.findByRole("button", { name: "Stub : région 3" }));
    expect(url()).toBe("/decision?regionId=3");
    await waitFor(() => expect(appelsSynthese().at(-1)?.[1]).toEqual({ params: { regionId: "3" } }));
    expect(JSON.parse(screen.getByTestId("filtres-recus").textContent ?? "{}")).toEqual({ regionId: 3 });
  });

  it("Reinitialiser vide les filtres de l'URL en gardant l'onglet", async () => {
    rendre("/decision?onglet=liste&regionId=2&etat=BON");
    await screen.findByTestId("onglet-liste");
    await userEvent.click(screen.getByRole("button", { name: "Réinitialiser" }));
    expect(url()).toBe("/decision?onglet=liste");
  });

  it("une periode incoherente n'est pas envoyee au serveur", async () => {
    rendre("/decision?depuis=2026-05-01&jusqua=2026-04-01");
    expect(await screen.findByRole("alert")).toHaveTextContent(/postérieure/);
    expect(appelsSynthese()).toHaveLength(0);
  });

  it("une date INCOMPLETE ou hors 2000-2100 saisie dans le champ ne declenche aucune requete", async () => {
    rendre();
    await attendreKpi();
    const avant = appelsSynthese().length;
    const du = await screen.findByLabelText("Du");
    for (const v of ["0002-05-01", "0202-05-01", "1999-12-31", "2101-01-01"]) fireEvent.change(du, { target: { value: v } });
    expect(appelsSynthese()).toHaveLength(avant);
    expect(url()).toBe("/decision");
    fireEvent.change(du, { target: { value: "2026-05-01" } });
    expect(url()).toBe("/decision?depuis=2026-05-01");
    await waitFor(() => expect(appelsSynthese().at(-1)?.[1]).toEqual({ params: { depuis: "2026-05-01" } }));
  });

  it("les filtres indisponibles sont visibles, desactives, avec leur raison", async () => {
    rendre();
    for (const nom of ["Préfecture", "Axe", "Bailleur / financement", "Gravité"]) expect(await screen.findByLabelText(nom)).toBeDisabled();
    expect(screen.getByText(/Indisponible : texte libre sur le tronçon/)).toBeInTheDocument();
  });

  it("liste des regions en panne : le filtre est desactive et dit pourquoi, la page reste utilisable", async () => {
    servir({ regions: erreurHttp(500) });
    rendre();
    await attendreKpi();
    // une relance (panne 5xx) precede l'echec : la note arrive apres le delai de relance
    expect(await screen.findByText(/liste des régions est indisponible/)).toBeInTheDocument();
    expect(screen.getByLabelText("Région")).toBeDisabled();
  });
});

describe("DecisionPage : etats de la synthese", () => {
  it("chargement : role status, squelette masque aux technologies d'assistance", async () => {
    servir({ synthese: () => new Promise(() => {}) });
    rendre();
    const statuts = await screen.findAllByRole("status");
    expect(statuts.map((s) => s.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("Chargement des indicateurs…"), expect.stringContaining("Chargement de la synthèse du réseau…")]));
    expect(screen.queryByRole("button", { name: /^Réseau dégradé/ })).not.toBeInTheDocument();
  });

  it("erreur 500 : deux alertes aux noms de bouton UNIQUES, jamais un squelette indefini ; Reessayer relit", async () => {
    servir({ synthese: erreurHttp(500) });
    rendre();
    const alertes = await screen.findAllByRole("alert");
    expect(alertes.length).toBeGreaterThanOrEqual(2);
    const noms = screen.getAllByRole("button", { name: /^Réessayer/ }).map((b) => b.getAttribute("aria-label"));
    expect(noms).toEqual(expect.arrayContaining(["Réessayer : indicateurs", "Réessayer : synthèse du réseau"]));
    expect(new Set(noms).size).toBe(noms.length);
    servir();
    await userEvent.click(screen.getByRole("button", { name: "Réessayer : indicateurs" }));
    expect(await attendreKpi()).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("PAS DE RELANCE sur 400, 401, 403 et 404 : un seul appel, le refus s'affiche tout de suite", async () => {
    for (const status of [400, 401, 403, 404]) {
      get.mockClear();
      servir({ synthese: erreurHttp(status) });
      const { unmount } = rendre();
      await screen.findAllByRole(status === 403 ? "status" : "alert");
      // laisse le temps a une relance eventuelle (delai nominal de 1 s) de se produire
      await new Promise((r) => setTimeout(r, 1300));
      expect(appelsSynthese(), `HTTP ${status}`).toHaveLength(1);
      unmount();
    }
  });

  it("UNE relance sur une panne 5xx (2 appels), puis l'alerte", async () => {
    servir({ synthese: erreurHttp(500) });
    rendre();
    await screen.findAllByRole("alert");
    await waitFor(() => expect(appelsSynthese()).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 1300));
    expect(appelsSynthese()).toHaveLength(2);
  });

  it("permission refusee (403) : message dedie, pas un vide, pas de Reessayer", async () => {
    servir({ synthese: erreurHttp(403) });
    rendre();
    expect(await screen.findByText(/Indicateurs : accès refusé/)).toBeInTheDocument();
    expect(await screen.findByText(/Synthèse du réseau : accès refusé/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Réessayer : indicateurs/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Aucun indicateur disponible pour ce périmètre.")).not.toBeInTheDocument();
  });

  it("compte SANS droit financier (reponse reelle NON_AUTORISE) : montants « Non autorisé », ni plantage ni « réponse inattendue »", async () => {
    servir({ synthese: syntheseReelle("regionaleSansDroits") });
    rendre();
    await attendreKpi();
    expect(await screen.findByText("Budget")).toBeInTheDocument();
    expect(screen.queryByText(/réponse inattendue/i)).not.toBeInTheDocument();
    const contractuel = document.querySelector('[data-montant="Contractuel"]') as HTMLElement;
    expect(contractuel).toHaveTextContent("Non autorisé");
    expect(document.querySelector('[data-montant="Décaissé"]')).toHaveTextContent("Non autorisé");
    expect(document.querySelector('[data-montant="Prévisionnel"]')).toHaveTextContent("Non autorisé");
    expect(screen.getByText(/Budget par bailleur : accès refusé/)).toBeInTheDocument();
    // le perimetre regional est dit, jamais « pays »
    expect(screen.getByRole("region", { name: "Fraîcheur et couverture des données" })).toHaveTextContent("Périmètre : Région Boké");
  });

  it("compte national : le perimetre « Ensemble du pays » est dit dans le bandeau", async () => {
    rendre();
    await attendreKpi();
    expect(screen.getByRole("region", { name: "Fraîcheur et couverture des données" })).toHaveTextContent("Périmètre : Ensemble du pays");
  });

  it.each([
    ["{}", {}],
    ["null", null],
    ["kpis absent", { budget: {}, repartitionEtat: {} }],
    ["kpis non tableau", { kpis: "x" }],
    ["page HTML de repli", "<!doctype html><html></html>"],
  ])("reponse mal formee (%s) : « réponse inattendue », aucun plantage, aucune valeur", async (_n, corps) => {
    servir({ synthese: corps });
    rendre();
    expect(await screen.findByText(/Indicateurs : réponse inattendue/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Réessayer : indicateurs" })).toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: /^(Réseau|Chantiers|Budget)/ })).toHaveLength(0);
    // La barre d'onglets et les filtres survivent.
    expect(screen.getAllByRole("tab")).toHaveLength(6);
  });

  it("section de la reponse mal formee : seul son panneau est en erreur, les indicateurs restent", async () => {
    servir({ synthese: syntheseReelle("nationale", { budget: { contractuel: 1 }, repartitionEtat: null }) });
    rendre();
    await attendreKpi();
    expect(await screen.findByRole("button", { name: "Réessayer : budget" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Réessayer : état du réseau" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Part du réseau dégradé par région" })).toBeInTheDocument();
  });

  it("aucun indicateur : etat vide explicite", async () => {
    servir({ synthese: syntheseReelle("nationale", { kpis: [] }) });
    rendre();
    expect(await screen.findByText("Aucun indicateur disponible pour ce périmètre.")).toBeInTheDocument();
  });

  it("indicateurs illisibles : ecartes, comptes et signales", async () => {
    servir({ synthese: syntheseReelle("nationale", { kpis: [...kpisReels().slice(0, 2), { code: "casse" }, null] }) });
    rendre();
    expect(await screen.findByText(/2 indicateurs de la réponse ont une forme inattendue/)).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  it("donnees perimees (derniere lecture + echec) : les chiffres restent, le bandeau le dit avec la date", async () => {
    const { qc } = rendre();
    await attendreKpi();
    servir({ synthese: erreurHttp(500) });
    await act(async () => { await qc.refetchQueries({ queryKey: ["aide-decision", "synthese"] }); });
    expect((await screen.findAllByText(/l'actualisation a échoué.*peuvent être périmées/)).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /^Réseau dégradé/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Actualiser : Indicateurs" })).toBeInTheDocument();
  });

  it("bandeau de fraicheur : date d'actualisation, derniere evaluation, perimetre et couverture COHERENTE, et mise en garde quand les donnees sont anciennes", async () => {
    servir({ synthese: syntheseReelle("nationale", { fraicheur: { calculeLe: "2026-08-01T08:00:00.000Z", derniereEvaluationLe: "2026-07-31T00:00:00.000Z", plusAncienneEvaluationLe: "2025-01-01T00:00:00.000Z", ageJours: 86, note: "n" } }) });
    rendre();
    await attendreKpi();
    const bandeau = screen.getByRole("region", { name: "Fraîcheur et couverture des données" });
    expect(bandeau).toHaveTextContent("Actualisé le 01/08/2026");
    expect(bandeau).toHaveTextContent(/dernière évaluation d'état : 31\/07\/2026 \(86 jours\)/);
    const t = bandeau.textContent?.replace(/[\u00a0\u202f]/g, " ") ?? "";
    expect(t).toMatch(/Longueur : 200 km à état valide, 500 km à état non valide, 100 km non évalués, sur 800 km de longueur connue/);
    expect(t).not.toMatch(/700 km évalués sur 200 km/);
    expect(within(bandeau).getByTestId("mise-en-garde-fraicheur")).toHaveTextContent(/Données anciennes.*N'en tirez pas de conclusion définitive/);
  });

  it("les avertissements du serveur (dont les filtres NON appliques) sont affiches, pas ignores", async () => {
    servir({ synthese: syntheseReelle("nationale", { avertissements: ["Non appliqué : les indicateurs sont des instantanés calculés à la date de la requête, sans historique d'état dans la base."] }) });
    rendre("/decision?depuis=2026-01-01");
    await attendreKpi();
    expect(screen.getByRole("region", { name: "Fraîcheur et couverture des données" })).toHaveTextContent(/Non appliqué : les indicateurs sont des instantanés/);
  });

  it("donnees partielles : la couverture est dite et la prudence demandee", async () => {
    rendre();
    await attendreKpi();
    expect(screen.getByTestId("mise-en-garde-fraicheur")).toHaveTextContent(/Couverture partielle/);
  });

  it("donnees fraiches et completes : aucune mise en garde", async () => {
    servir({ synthese: syntheseReelle("nationale", { couverture: { evalueKm: 100, eligibleKm: 100, nonEvalueKm: 0, partNonEvaluee: 0, etatNonValideKm: 0, tronconsTotal: 10, tronconsNonEvalues: 0, tronconsEtatNonValide: 0, tronconsSansLongueurMetier: 0 }, kpis: kpisReels().filter((k) => k.etat === "DISPONIBLE") }) });
    rendre();
    await attendreKpi().catch(() => undefined);
    await screen.findByRole("region", { name: "Fraîcheur et couverture des données" });
    expect(screen.queryByTestId("mise-en-garde-fraicheur")).not.toBeInTheDocument();
  });

  it("date de derniere evaluation inconnue : dite, jamais 0 jour", async () => {
    servir({ synthese: syntheseReelle("nationale", { fraicheur: { calculeLe: "2026-10-26T08:00:00.000Z", derniereEvaluationLe: null, plusAncienneEvaluationLe: null, ageJours: null, note: "n" } }) });
    rendre();
    await attendreKpi();
    expect(screen.getByRole("region", { name: "Fraîcheur et couverture des données" })).toHaveTextContent("date de la dernière évaluation d'état inconnue");
  });
});

describe("DecisionPage : un onglet qui plante ne fait pas tomber la page", () => {
  it("affiche une alerte de portee onglet, garde indicateurs et barre, et Reessayer remonte l'onglet", async () => {
    const trace = vi.spyOn(console, "error").mockImplementation(() => {});
    etat.planter = true;
    rendre("/decision?onglet=liste");
    const alerte = await screen.findByText(/L'onglet « Liste des interventions » n'a pas pu s'afficher/);
    expect(alerte).toBeInTheDocument();
    expect(await attendreKpi()).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(6);
    etat.planter = false;
    await userEvent.click(screen.getByRole("button", { name: "Réessayer : onglet Liste des interventions" }));
    expect(await screen.findByTestId("onglet-liste")).toBeInTheDocument();
    trace.mockRestore();
  });
});

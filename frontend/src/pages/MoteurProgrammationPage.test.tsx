import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { violationsAccessibilite } from "../test/accessibilite";
import type { LigneScenario, PlanPluriannuel, ReponsePlan, ReponseScenario, Scenario } from "../lib/moteurProgrammation";

/**
 * Ecran « Moteur de programmation » : ce que ces tests defendent.
 *   - « PROVISOIRE, non approuvé » est visible tant qu'aucune version des parametres n'est approuvee, et sur chaque resultat ;
 *   - aucune enveloppe n'est proposee : le champ part vide, le bouton reste inactif tant que la saisie n'est pas valide,
 *     le montant part en CHAINE de chiffres (jamais en nombre), 0 est une saisie valide pour une annee d'un plan ;
 *   - un resultat ou tous les troncons sont ecartes DIT pourquoi (motif, facteurs disponibles, minimum, facteurs absents) ;
 *   - la lecture est LIGNE PAR LIGNE avec sa justification (entrees, facteurs, formule, version des parametres, motif) ;
 *   - figer exige une confirmation explicite et affiche l'empreinte SHA-256 ; le rejeu dit « octet pour octet » ;
 *   - la praticabilite dit « non branchee : aucune valeur approuvee (D-02) » ;
 *   - le plan dit qu'il est glouton, sans optimisation ; les fiches figees se consultent avec leur empreinte verifiee ;
 *   - aucune violation d'accessibilite (axe-core, WCAG 2.1 A et AA, contraste exclu).
 */

const sp = (s: string) => s.replace(new RegExp(`[\\s${String.fromCharCode(0x202f, 0xa0)}]`, "g"), " ");

const facteurs = (dispo: string[]) => ["ETAT", "TRAFIC_IMPORTANCE", "SECURITE", "CLIMAT", "POPULATION"].map((f) => ({
  facteur: f, poids: 10, disponible: dispo.includes(f), valeur: dispo.includes(f) ? 65 : null, brut: dispo.includes(f) ? 1 : null,
  origine: dispo.includes(f) ? "troncons.etat via etatVersRisque" : null, note: dispo.includes(f) ? `${f} lu` : `${f} sans source`,
}));

const retenue: LigneScenario = {
  troncon: { id: "t-a", code: "RN-A", nom: "Conakry Kindia", regionId: 1, classe: "RN", revetement: "BITUME", etat: "MAUVAIS", longueurM: 4000, longueurOrigine: "GEOMETRIE" },
  decision: "RETENUE", rangPriorite: 1, rangRetenu: 1, motifExclusion: null,
  risque: { ok: true, score: 60.625, couverture: 0.8, facteursDisponibles: 3, facteursPonderes: 5, formule: "risque = somme(poids x valeur) / somme(poids)", facteurs: facteurs(["ETAT", "TRAFIC_IMPORTANCE", "SECURITE"]) },
  projection: { ok: true, etatCourant: "MAUVAIS", etatSuivant: "CRITIQUE", pAnnuelle: 0.28, horizonAnnees: 1, pHorizon: 0.28, matrice: { familleRevetement: "bitume", classeTrafic: "T3_fort", version: 1, approuvee: false } },
  risqueAttendu: { score: 67.5, scoreMicro: 675000, formule: "risque attendu = risque courant + p(horizon) x (risque a l'etat suivant - risque courant)" },
  traitement: { ok: true, traitement: { code: "rehabilitation", libelle: "Réhabilitation", famille: "REHABILITATION", version: 1, approuve: false }, condition: { portee: "generale", classeTrafic: null }, attributsNonRenseignes: ["dureeVieAttendueAns"] },
  cout: {
    ok: true, montantGnf: "4400000000", devise: "GNF", classePrecision: "RESEAU_30", margePct: 30, provisoire: true, hypothesesManquantes: ["millesime"],
    bareme: { id: 2, code: null, typeIntervention: "rehabilitation", coutKmGnf: "1100000000", anneeReference: null, largeurChausseeM: null, approuve: false }, calcul: "4000 m x 1100000000 GNF/km = 4400000000 GNF",
  },
  priorite: { ratioPointsParMilliardGnf: "15.3409", formule: "priorite = risque attendu / cout en milliards de GNF" },
  budget: { resteAvantGnf: "5000000000", resteApresGnf: "600000000" }, etiquette: "PROVISOIRE, non approuvé",
  justification: "Retenue (rang 1, priorité 1/1) : risque 60.625, traitement rehabilitation, coût 4 400 000 000 GNF.",
};
const ecartee: LigneScenario = {
  troncon: { id: "t-b", code: "RN-B", nom: null, regionId: 2, classe: "RN", revetement: "BITUME", etat: "CRITIQUE", longueurM: 1000, longueurOrigine: "LONGUEUR_KM" },
  decision: "ECARTEE", rangPriorite: 2, rangRetenu: null, motifExclusion: { code: "BUDGET_INSUFFISANT", detail: "coût 3500000000 supérieur au reste de l'enveloppe 600000000" },
  risque: { ok: true, score: 48.75, couverture: 0.8, facteursDisponibles: 3, facteursPonderes: 5, formule: "f", facteurs: facteurs(["ETAT", "TRAFIC_IMPORTANCE", "SECURITE"]) },
  projection: null, risqueAttendu: { score: 48.75, scoreMicro: 487500, formule: "fa" },
  traitement: { ok: true, traitement: { code: "reconstruction", libelle: "Reconstruction", famille: "RECONSTRUCTION", version: 1, approuve: false }, condition: { portee: "generale", classeTrafic: null }, attributsNonRenseignes: [] },
  cout: null, priorite: { ratioPointsParMilliardGnf: "13.9285", formule: "fp" }, budget: { resteAvantGnf: "600000000", resteApresGnf: "600000000" }, etiquette: "PROVISOIRE, non approuvé",
  justification: "Écartée au rang de priorité 2/2 (BUDGET_INSUFFISANT) : coût supérieur au reste.",
};
const seulEtat = (id: string): LigneScenario => ({
  troncon: { id, code: `RN-${id}`, nom: null, regionId: 1, classe: "RN", revetement: "BITUME", etat: "MAUVAIS", longueurM: 1000, longueurOrigine: "LONGUEUR_KM" },
  decision: "ECARTEE", rangPriorite: null, rangRetenu: null, motifExclusion: { code: "RISQUE_NON_CALCULABLE", detail: "FACTEURS_INSUFFISANTS : 1 facteur(s) disponible(s) sur 5 ponderes, minimum 3" },
  risque: { ok: false, code: "FACTEURS_INSUFFISANTS", motif: "1 facteur(s) disponible(s) sur 5 ponderes, minimum 3 : manque TRAFIC_IMPORTANCE", facteurs: facteurs(["ETAT"]) },
  projection: null, risqueAttendu: null, traitement: null, cout: null, priorite: null, budget: null, etiquette: "PROVISOIRE, non approuvé",
  justification: "Écartée avant classement (RISQUE_NON_CALCULABLE) : FACTEURS_INSUFFISANTS.",
});

function scenario(lignes: LigneScenario[], o: Partial<Scenario> = {}): Scenario {
  const retenues = lignes.filter((l) => l.decision === "RETENUE").length;
  return {
    methode: { id: "programmation-glouton-explicable", version: "1" }, annee: 2027, budgetGnf: "5000000000",
    parametres: { version: "prog-provisoire-1", source: "amorcage_provisoire", approuveeLe: null, etiquette: "PROVISOIRE, non approuvé" },
    provisoire: true, etiquette: "PROVISOIRE, non approuvé", motifsProvisoire: ["paramètres de programmation non approuvés (version prog-provisoire-1, source amorcage_provisoire)"],
    limites: ["Le classement est glouton, non optimal."], avertissement: "Aucune estimation ni programmation ne crée de marché.",
    totaux: { candidats: lignes.length, eligibles: lignes.filter((l) => l.rangPriorite !== null).length, retenues, ecartees: lignes.length - retenues, engageGnf: retenues ? "4400000000" : "0", resteGnf: retenues ? "600000000" : "5000000000", ecartesParMotif: {}, engageParRegionGnf: {} },
    lignes, ...o,
  };
}
const reponseScenario = (s: Scenario, id = "s1"): ReponseScenario => ({
  scenario: { id, annee: s.annee, intitule: "PAE 2027 essai", parametresVersion: "prog-provisoire-1", parametresId: "p-seed", budgetGnf: s.budgetGnf, perimetre: {}, nbRetenues: s.totaux.retenues, nbEcartees: s.totaux.ecartees, montantEngageGnf: s.totaux.engageGnf, provisoire: true, etiquette: "PROVISOIRE, non approuvé", empreinteEntrees: "e".repeat(64), empreinteResultat: "r".repeat(64), creeParId: "u1", creeLe: "2026-10-26T09:00:00Z" },
  resultat: s,
});

function plan(): PlanPluriannuel {
  const s1 = scenario([retenue, ecartee]);
  const s2 = scenario([{ ...ecartee, decision: "RETENUE", motifExclusion: null, rangRetenu: 1, rangPriorite: 1, cout: { ...(retenue.cout as object) } as LigneScenario["cout"] }], { annee: 2028, budgetGnf: "6000000000" });
  return {
    methode: { id: "ppe-glouton-chaine-annuel", version: "1" }, anneeDebut: 2027, nbAnnees: 2,
    parametres: s1.parametres, provisoire: true, etiquette: "PROVISOIRE, non approuvé", motifsProvisoire: ["2027 : paramètres de programmation non approuvés"],
    limites: ["Méthode gloutonne et déterministe, année par année : ce n'est pas un optimum pluriannuel, aucune optimisation (PLNE) n'est faite."], avertissement: "Aucune estimation ni programmation ne crée de marché.",
    synthese: {
      enveloppeTotaleGnf: "11000000000", engageTotalGnf: "8800000000", resteTotalGnf: "2200000000", candidats: 2, retenus: 2, nonRetenus: 0, nonRetenusParMotif: {},
      parAnnee: [
        { annee: 2027, enveloppeGnf: "5000000000", engageGnf: "4400000000", resteGnf: "600000000", retenues: 1, ecartees: 1, candidatsEntrants: 2 },
        { annee: 2028, enveloppeGnf: "6000000000", engageGnf: "4400000000", resteGnf: "1600000000", retenues: 1, ecartees: 0, candidatsEntrants: 1 },
      ],
      tronconsRetenus: [
        { tronconId: "t-a", code: "RN-A", regionId: 1, anneeRetenue: 2027, rangRetenu: 1, montantGnf: "4400000000", traitement: "rehabilitation" },
        { tronconId: "t-b", code: "RN-B", regionId: 2, anneeRetenue: 2028, rangRetenu: 1, montantGnf: "4400000000", traitement: "rehabilitation" },
      ],
    },
    annees: [
      { annee: 2027, enveloppeGnf: "5000000000", candidatsEntrants: 2, dejaRetenusAvant: 0, scenario: s1 },
      { annee: 2028, enveloppeGnf: "6000000000", candidatsEntrants: 1, dejaRetenusAvant: 1, scenario: s2 },
    ],
  };
}
const reponsePlan = (p: PlanPluriannuel): ReponsePlan => ({
  plan: { id: "pl1", intitule: "PPE 2027-2028 essai", anneeDebut: 2027, nbAnnees: 2, anneeFin: 2028, parametresVersion: "prog-provisoire-1", parametresId: "p-seed", enveloppeTotaleGnf: p.synthese.enveloppeTotaleGnf, montantEngageGnf: p.synthese.engageTotalGnf, nbRetenus: 2, nbNonRetenus: 0, provisoire: true, etiquette: "PROVISOIRE, non approuvé", empreinteEntrees: "e".repeat(64), empreinteResultat: "r".repeat(64), creeParId: "u1", creeLe: "2026-10-26T09:00:00Z" },
  resultat: p,
});

const h = vi.hoisted(() => ({
  role: "ADMIN",
  parametres: [] as unknown[],
  praticabilite: {} as unknown,
  alertes: { statut: {}, alertes: [] } as unknown,
  scenarios: [] as unknown[],
  scenarioParId: {} as Record<string, unknown>,
  plans: [] as unknown[],
  planParId: {} as Record<string, unknown>,
  fiches: [] as unknown[],
  ficheParId: {} as Record<string, unknown>,
  verification: {} as unknown,
  prochainScenario: null as unknown,
  prochainPlan: null as unknown,
  posts: [] as { url: string; corps?: unknown }[],
  gets: [] as { url: string; params?: unknown }[],
  refus: null as null | { response: { data: { error: string } } },
}));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u-1", role: h.role } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string, config?: { params?: unknown }) => {
      h.gets.push({ url, params: config?.params });
      if (url === "/regions") return { data: [{ id: 1, nom: "Basse-Guinée" }] };
      if (url.endsWith("/moteur/parametres")) return { data: { data: h.parametres } };
      if (url.endsWith("/moteur/praticabilite")) return { data: h.praticabilite };
      if (url.endsWith("/praticabilite")) return { data: h.alertes };
      if (url.endsWith("/ppe/simulations")) return { data: { data: h.plans, total: h.plans.length } };
      if (/\/ppe\/simulations\/[^/]+$/.test(url)) return { data: h.planParId[url.split("/").pop()!] };
      if (url.endsWith("/moteur/simulations")) return { data: { data: h.scenarios, total: h.scenarios.length } };
      if (/\/moteur\/simulations\/[^/]+$/.test(url)) return { data: h.scenarioParId[url.split("/").pop()!] };
      if (url.endsWith("/verification")) return { data: h.verification };
      if (/\/moteur\/fiches\/[^/]+$/.test(url)) return { data: h.ficheParId[url.split("/").pop()!] };
      if (url.endsWith("/moteur/fiches")) return { data: { data: h.fiches, total: h.fiches.length, page: 1, pageSize: 20 } };
      throw new Error(`URL inattendue ${url}`);
    }),
    post: vi.fn(async (url: string, corps?: unknown) => {
      h.posts.push({ url, corps });
      if (h.refus) throw h.refus;
      if (url.endsWith("/ppe/simulations")) return { data: h.prochainPlan };
      if (url.endsWith("/moteur/simulations")) return { data: h.prochainScenario };
      if (url.endsWith("/rejouer")) return { data: { identique: true, entreesIntegres: true, empreinteStockee: "r".repeat(64), empreinteRecalculee: "r".repeat(64), explication: "Le rejeu donne le même texte, octet pour octet." } };
      if (url.endsWith("/fiches")) return { data: { fiches: [{ id: "f1", reference: "FI-2027-AAAAAAAAAA", empreinteSha256: "c".repeat(64), tronconId: "t-a", code: "RN-A" }], etiquette: "PROVISOIRE, non approuvé", provisoire: true } };
      throw new Error(`POST inattendu ${url}`);
    }),
  },
}));

import { MoteurProgrammationPage } from "./MoteurProgrammationPage";

function rendre() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MoteurProgrammationPage /></QueryClientProvider>);
}

const PARAMS_PROV = [{ id: "p-seed", version: "prog-provisoire-1", source: "amorcage_provisoire", valeurs: { facteursMinimum: 3 }, motif: null, provisoire: true, etiquette: "PROVISOIRE, non approuvé", approuveeLe: null }];
const PARAMS_APPR = [{ ...PARAMS_PROV[0], provisoire: false, etiquette: "paramètres approuvés", approuveeLe: "2026-10-20T08:00:00Z" }];

beforeEach(() => {
  h.role = "ADMIN";
  h.parametres = PARAMS_PROV;
  h.praticabilite = { branchee: false, valeursDeclarees: 4, valeursApprouvees: 0, libelle: "non branchée : aucune valeur approuvée (D-02)", motif: "4 valeur(s) déclarée(s), aucune approuvée : une valeur non approuvée ne sert pas au calcul", effet: "Aucun critère n'est inventé : la praticabilité n'influe sur aucun facteur, aucun rang et aucune exclusion." };
  h.alertes = { statut: h.praticabilite, alertes: [] };
  h.scenarios = []; h.scenarioParId = {}; h.plans = []; h.planParId = {}; h.fiches = []; h.ficheParId = {}; h.verification = {};
  h.prochainScenario = null; h.prochainPlan = null; h.posts = []; h.gets = []; h.refus = null;
});

async function remplirScenario(u: ReturnType<typeof userEvent.setup>, budget = "5 000 000 000") {
  await u.clear(screen.getByLabelText("Année du programme"));
  await u.type(screen.getByLabelText("Année du programme"), "2027");
  await u.type(screen.getByLabelText("Intitulé du scénario"), "PAE 2027 essai");
  if (budget) await u.type(screen.getByLabelText(/Enveloppe budgétaire/), budget);
}

describe("Bandeaux de l'ecran", () => {
  it("sans version approuvee : PROVISOIRE, non approuvé est visible AVANT tout calcul, et la praticabilite est dite non branchee", async () => {
    rendre();
    const b = await screen.findByTestId("bandeau-provisoire");
    expect(b).toHaveTextContent("PROVISOIRE, non approuvé.");
    expect(b).toHaveTextContent(/Aucune des 1 version\(s\) des paramètres n'est approuvée/);
    const p = await screen.findByTestId("bandeau-praticabilite");
    expect(p).toHaveTextContent("Praticabilité : non branchée : aucune valeur approuvée (D-02)");
    expect(p).toHaveTextContent("Aucun critère n'est inventé");
  });

  it("une version approuvee retire le bandeau de page (les resultats gardent le leur tant qu'ils sont provisoires)", async () => {
    h.parametres = PARAMS_APPR;
    rendre();
    await screen.findByTestId("bandeau-praticabilite");
    expect(screen.queryByTestId("bandeau-provisoire")).not.toBeInTheDocument();
  });

  it("praticabilite branchee : dit « en lecture » et « signal seulement »", async () => {
    h.praticabilite = { branchee: true, valeursDeclarees: 4, valeursApprouvees: 2, libelle: "branchée en lecture : 2 valeur(s) approuvée(s) (D-02)", motif: "au moins une valeur est approuvée", effet: "Signal seulement : aucun tronçon n'est écarté ni reclassé." };
    rendre();
    const p = await screen.findByTestId("bandeau-praticabilite");
    expect(p).toHaveTextContent("branchée en lecture");
    expect(p).toHaveTextContent("Signal seulement");
  });
});

describe("Scenario annuel : saisie", () => {
  it("l'enveloppe part VIDE, rien n'est propose, et le bouton reste inactif tant que la saisie n'est pas valide", async () => {
    const u = userEvent.setup({ delay: null });
    rendre();
    const budget = await screen.findByLabelText(/Enveloppe budgétaire/);
    expect((budget as HTMLInputElement).value).toBe("");
    expect(screen.getByText(/Aucune enveloppe n'est proposée/)).toBeInTheDocument();
    const bouton = screen.getByRole("button", { name: "Calculer le scénario" });
    expect(bouton).toBeDisabled();
    await u.type(screen.getByLabelText("Intitulé du scénario"), "PAE 2027 essai");
    expect(bouton).toBeDisabled();
    await u.type(budget, "12,5");
    expect(screen.getByText(/Saisie invalide/)).toBeInTheDocument();
    expect(bouton).toBeDisabled();
    await u.clear(budget);
    await u.type(budget, "5 000 000 000");
    expect(sp(screen.getByText(/^Soit /).textContent ?? "")).toBe("Soit 5 000 000 000 GNF (5 Md GNF).");
    expect(bouton).toBeEnabled();
  }, 30000);

  it("envoie le montant en CHAINE de chiffres (jamais un nombre) avec le perimetre choisi", async () => {
    const u = userEvent.setup({ delay: null });
    h.prochainScenario = reponseScenario(scenario([retenue, ecartee]));
    rendre();
    await screen.findByLabelText(/Enveloppe budgétaire/);
    await remplirScenario(u, "9 007 199 254 740 993");
    await u.selectOptions(screen.getByLabelText("Classe de route"), "RN");
    await u.click(screen.getByRole("button", { name: "Calculer le scénario" }));
    await waitFor(() => expect(h.posts.some((p) => p.url.endsWith("/moteur/simulations"))).toBe(true));
    const corps = h.posts.find((p) => p.url.endsWith("/moteur/simulations"))!.corps as Record<string, unknown>;
    expect(corps).toEqual({ annee: 2027, intitule: "PAE 2027 essai", budgetGnf: "9007199254740993", classe: "RN" });
    expect(typeof corps.budgetGnf).toBe("string");
  }, 30000);

  it("un refus du serveur est affiche, rien n'est presente comme calcule", async () => {
    const u = userEvent.setup({ delay: null });
    h.refus = { response: { data: { error: "aucune version approuvée et 2 versions provisoires" } } };
    rendre();
    await screen.findByLabelText(/Enveloppe budgétaire/);
    await remplirScenario(u);
    await u.click(screen.getByRole("button", { name: "Calculer le scénario" }));
    await waitFor(() => expect(h.posts).toHaveLength(1));
    expect(screen.queryByTestId("resultat-scenario")).not.toBeInTheDocument();
  }, 30000);
});

describe("Scenario annuel : lecture ligne par ligne", () => {
  async function calculer() {
    const u = userEvent.setup({ delay: null });
    h.prochainScenario = reponseScenario(scenario([retenue, ecartee]));
    const r = rendre();
    await screen.findByLabelText(/Enveloppe budgétaire/);
    await remplirScenario(u);
    await u.click(screen.getByRole("button", { name: "Calculer le scénario" }));
    const resultat = await screen.findByTestId("resultat-scenario");
    return { u, r, resultat };
  }

  it("affiche les totaux, le bandeau PROVISOIRE du resultat avec ses motifs, et les deux lignes", async () => {
    const { resultat } = await calculer();
    expect(within(resultat).getByTestId("bandeau-provisoire")).toHaveTextContent("PROVISOIRE, non approuvé.");
    expect(within(resultat).getByTestId("bandeau-provisoire")).toHaveTextContent(/paramètres de programmation non approuvés/);
    expect(sp(within(resultat).getByText("Montant engagé").nextElementSibling?.textContent ?? "")).toBe("4 400 000 000 GNF");
    expect(sp(within(resultat).getByText("Reste de l'enveloppe").nextElementSibling?.textContent ?? "")).toBe("600 000 000 GNF");
    const table = within(resultat).getByRole("table", { name: "Lignes du scénario 2027" });
    expect(within(table).getByText("RN-A")).toBeInTheDocument();
    expect(within(table).getByText("Budget insuffisant")).toBeInTheDocument();
    expect(within(resultat).queryByTestId("resultat-vide")).not.toBeInTheDocument();
  }, 30000);

  it("la justification d'une ligne retenue montre entrees, facteurs, formules, projection, traitement, cout, barème et version des parametres", async () => {
    const { u, resultat } = await calculer();
    await u.click(within(resultat).getByRole("button", { name: /Justification de RN-A/ }));
    const d = await screen.findByTestId("detail-RN-A");
    const texte = sp(d.textContent ?? "");
    expect(texte).toContain("Retenue (rang 1, priorité 1/1)");
    expect(texte).toContain("Longueur : 4 000 m (calculée sur la géométrie, non saisie)");
    expect(texte).toContain("Formule : risque = somme(poids x valeur) / somme(poids)");
    expect(within(d).getByRole("table", { name: "Facteurs du risque" })).toBeInTheDocument();
    expect(texte).toContain("Trafic ou importance");
    expect(texte).toContain("Vulnérabilité climatique");
    expect(texte).toContain("MAUVAIS vers CRITIQUE");
    expect(texte).toContain("Réhabilitation (rehabilitation, famille REHABILITATION), non approuvé");
    expect(texte).toContain("4 400 000 000 GNF · classe de précision RESEAU_30 (plus ou moins 30 %) · provisoire");
    expect(texte).toContain("Calcul : 4000 m x 1100000000 GNF/km");
    expect(texte).toContain("millésime non renseigné, largeur non renseignée, non approuvé");
    expect(texte).toContain("15.3409 point(s) de risque par milliard de GNF");
    expect(texte).toContain("prog-provisoire-1 (source amorcage_provisoire) · PROVISOIRE, non approuvé");
  }, 30000);

  it("la justification d'une ligne ecartee dit le motif d'exclusion et son detail", async () => {
    const { u, resultat } = await calculer();
    await u.click(within(resultat).getByRole("button", { name: /Justification de RN-B/ }));
    const d = await screen.findByTestId("detail-RN-B");
    expect(sp(d.textContent ?? "")).toContain("Budget insuffisant (BUDGET_INSUFFISANT) : coût 3500000000 supérieur au reste de l'enveloppe 600000000");
  }, 30000);

  it("le filtre ne garde que les retenues, ou que les ecartees", async () => {
    const { u, resultat } = await calculer();
    await u.selectOptions(within(resultat).getByLabelText("Lignes à afficher"), "RETENUE");
    const table = within(resultat).getByRole("table", { name: "Lignes du scénario 2027" });
    expect(within(table).getByText("RN-A")).toBeInTheDocument();
    expect(within(table).queryByText("RN-B")).not.toBeInTheDocument();
  }, 30000);

  it("rejouer dit « octet pour octet » et montre les deux empreintes", async () => {
    const { u, resultat } = await calculer();
    await u.click(within(resultat).getByRole("button", { name: "Rejouer depuis les entrées stockées" }));
    const r = await screen.findByTestId("rapport-rejeu");
    expect(r).toHaveTextContent("octet pour octet");
    expect(r).toHaveTextContent("Les entrées stockées sont intègres.");
    expect(r.textContent).toContain("r".repeat(64));
  }, 30000);

  it("figer exige une confirmation explicite, rien n'est envoye avant, puis l'empreinte SHA-256 est affichee", async () => {
    const { u, resultat } = await calculer();
    await u.click(within(resultat).getByRole("button", { name: /Figer les 1 intervention/ }));
    const dialogue = await screen.findByRole("dialog");
    expect(within(dialogue).getByText(/immuable/)).toBeInTheDocument();
    expect(within(dialogue).getByText(/Le résultat est PROVISOIRE, non approuvé/)).toBeInTheDocument();
    expect(h.posts.some((p) => p.url.endsWith("/fiches"))).toBe(false);
    await u.click(within(dialogue).getByRole("button", { name: "Annuler" }));
    expect(h.posts.some((p) => p.url.endsWith("/fiches"))).toBe(false);

    await u.click(within(resultat).getByRole("button", { name: /Figer les 1 intervention/ }));
    await u.type(await screen.findByLabelText(/Source de financement/), "FER");
    await u.click(screen.getByRole("button", { name: "Confirmer le gel" }));
    const ok = await screen.findByTestId("fiches-figees-creees");
    expect(ok).toHaveTextContent("1 fiche(s) figée(s)");
    expect(ok).toHaveTextContent("FI-2027-AAAAAAAAAA");
    expect(ok.textContent).toContain("c".repeat(64));
    expect(h.posts.find((p) => p.url.endsWith("/fiches"))!.corps).toEqual({ sourceFinancement: "FER" });
  }, 30000);

  it("sans source de financement saisie, aucune source n'est envoyee ni deduite", async () => {
    const { u, resultat } = await calculer();
    await u.click(within(resultat).getByRole("button", { name: /Figer les 1 intervention/ }));
    await u.click(await screen.findByRole("button", { name: "Confirmer le gel" }));
    await screen.findByTestId("fiches-figees-creees");
    expect(h.posts.find((p) => p.url.endsWith("/fiches"))!.corps).toEqual({});
  }, 30000);

  it("aucune violation d'accessibilite, resultat ouvert et ligne detaillee", async () => {
    const { u, r, resultat } = await calculer();
    await u.click(within(resultat).getByRole("button", { name: /Justification de RN-A/ }));
    await screen.findByTestId("detail-RN-A");
    expect(await violationsAccessibilite(r.container)).toEqual([]);
  }, 30000);
});

describe("Resultat ou tout est ecarte (seul l'etat est renseigne)", () => {
  async function calculerVide() {
    const u = userEvent.setup({ delay: null });
    h.prochainScenario = reponseScenario(scenario(["a", "b", "c"].map(seulEtat)));
    const r = rendre();
    await screen.findByLabelText(/Enveloppe budgétaire/);
    await remplirScenario(u);
    await u.click(screen.getByRole("button", { name: "Calculer le scénario" }));
    return { u, r, vide: await screen.findByTestId("resultat-vide") };
  }

  it("DIT pourquoi : motif, 1 facteur sur 5, minimum 3, il en manque 2, facteurs absents ; jamais une liste vide muette", async () => {
    const { vide } = await calculerVide();
    const t = sp(vide.textContent ?? "");
    expect(t).toContain("Aucune intervention retenue.");
    expect(t).toContain("Motif principal : Risque non calculable (facteurs manquants) (3)");
    expect(t).toContain("3 tronçon(s) disposent de 1 facteur(s) sur 5 pondérés, le minimum requis est 3 : il manque au moins 2 facteur(s) par tronçon");
    expect(t).toContain("Trafic ou importance : absent sur 3 tronçon(s)");
    expect(t).toContain("Vulnérabilité climatique : absent sur 3 tronçon(s)");
    expect(t).toContain("aucun poids n'est inventé");
  }, 30000);

  it("ne propose pas de figer quand rien n'est retenu, et les lignes restent lisibles avec leur motif", async () => {
    const { vide } = await calculerVide();
    expect(screen.queryByRole("button", { name: /Figer/ })).not.toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Lignes du scénario 2027" });
    expect(within(table).getAllByText("Risque non calculable (facteurs manquants)").length).toBeGreaterThanOrEqual(3);
    expect(vide).toBeInTheDocument();
  }, 30000);

  it("aucune violation d'accessibilite", async () => {
    const { r } = await calculerVide();
    expect(await violationsAccessibilite(r.container)).toEqual([]);
  }, 30000);
});

describe("Plan pluriannuel", () => {
  async function ouvrirOnglet(u: ReturnType<typeof userEvent.setup>) {
    await screen.findByLabelText(/Enveloppe budgétaire/);
    await u.click(screen.getByRole("tab", { name: "Plan pluriannuel" }));
    await screen.findByLabelText("Première année");
  }

  it("aucune enveloppe n'est proposee ; chaque annee se saisit ; 0 est valide ; le montant part en chaine", async () => {
    const u = userEvent.setup({ delay: null });
    h.prochainPlan = reponsePlan(plan());
    rendre();
    await ouvrirOnglet(u);
    await u.clear(screen.getByLabelText("Première année"));
    await u.type(screen.getByLabelText("Première année"), "2027");
    await u.selectOptions(screen.getByLabelText(/Nombre d'années/), "2");
    expect(screen.getAllByLabelText(/^Enveloppe 20/)).toHaveLength(2);
    expect(screen.getByLabelText("Enveloppe 2027")).toHaveValue("");
    expect(screen.getByLabelText("Enveloppe 2028")).toHaveValue("");
    await u.type(screen.getByLabelText("Intitulé du plan"), "PPE 2027-2028 essai");
    const bouton = screen.getByRole("button", { name: "Calculer le plan" });
    expect(bouton).toBeDisabled();
    await u.type(screen.getByLabelText("Enveloppe 2027"), "0");
    expect(bouton).toBeDisabled();
    await u.type(screen.getByLabelText("Enveloppe 2028"), "6 000 000 000");
    expect(bouton).toBeEnabled();
    await u.click(bouton);
    await waitFor(() => expect(h.posts.some((p) => p.url.endsWith("/ppe/simulations"))).toBe(true));
    expect(h.posts.find((p) => p.url.endsWith("/ppe/simulations"))!.corps).toEqual({
      anneeDebut: 2027, intitule: "PPE 2027-2028 essai", enveloppes: [{ budgetGnf: "0" }, { budgetGnf: "6000000000" }],
    });
  }, 30000);

  it("dit qu'il est glouton, sans optimisation, et que rien n'est reparti ni reporte", async () => {
    const u = userEvent.setup({ delay: null });
    rendre();
    await ouvrirOnglet(u);
    const f = screen.getByRole("form", { name: "Calculer un plan pluriannuel" });
    expect(f).toHaveTextContent(/gloutonne et déterministe/);
    expect(f).toHaveTextContent(/sans optimisation/);
    expect(f).toHaveTextContent(/ne reporte aucun reste/);
  }, 30000);

  it("refuse 1 ou 6 annees : le choix est borne a 2..5", async () => {
    const u = userEvent.setup({ delay: null });
    rendre();
    await ouvrirOnglet(u);
    const options = within(screen.getByLabelText(/Nombre d'années/)).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["2 années", "3 années", "4 années", "5 années"]);
  }, 30000);

  it("affiche le plan : etiquette PROVISOIRE, synthese par annee, lignes de l'annee ouverte, retenus sur l'horizon, rejeu", async () => {
    const u = userEvent.setup({ delay: null });
    h.plans = [reponsePlan(plan()).plan];
    h.planParId = { pl1: reponsePlan(plan()) };
    rendre();
    await ouvrirOnglet(u);
    await u.click(await screen.findByRole("button", { name: /Ouvrir PPE 2027-2028 essai/ }));
    const res = await screen.findByTestId("resultat-plan");
    expect(within(res).getByTestId("bandeau-provisoire")).toHaveTextContent("PROVISOIRE, non approuvé.");
    const synth = within(res).getByRole("table", { name: "Synthèse du plan, année par année" });
    const ligne2028 = within(synth).getByText("2028").closest("tr")!;
    expect(within(ligne2028).getAllByRole("cell").slice(0, 6).map((c) => sp(c.textContent ?? ""))).toEqual(["2028", "6 000 000 000 GNF", "4 400 000 000 GNF", "1 600 000 000 GNF", "1", "1"]);
    expect(within(res).getByText(/Non dépensé \(non reporté\)/)).toBeInTheDocument();
    await u.click(within(synth).getByRole("button", { name: /Lire les lignes de 2028/ }));
    const lignes = await screen.findByTestId("lignes-2028");
    expect(lignes).toHaveTextContent("1 déjà retenu(s) les années précédentes, non réexaminés");
    const retenus = within(res).getByRole("table", { name: /Tronçons retenus sur l'horizon \(2\)/ });
    expect(within(retenus).getByText("RN-A")).toBeInTheDocument();
    await u.click(within(res).getByRole("button", { name: "Rejouer depuis les entrées stockées" }));
    expect(await screen.findByTestId("rapport-rejeu-plan")).toHaveTextContent("octet pour octet");
    expect(within(res).getByText(/Un plan ne crée aucune fiche/)).toBeInTheDocument();
  }, 30000);

  it("un plan sans aucune retenue explique pourquoi", async () => {
    const u = userEvent.setup({ delay: null });
    const p = plan();
    p.annees = p.annees.map((a) => ({ ...a, scenario: scenario(["a", "b"].map(seulEtat), { annee: a.annee }) }));
    p.synthese = { ...p.synthese, retenus: 0, nonRetenus: 2, tronconsRetenus: [] };
    h.plans = [reponsePlan(p).plan];
    h.planParId = { pl1: reponsePlan(p) };
    rendre();
    await ouvrirOnglet(u);
    await u.click(await screen.findByRole("button", { name: /Ouvrir PPE 2027-2028 essai/ }));
    const vide = await screen.findByTestId("resultat-vide");
    expect(sp(vide.textContent ?? "")).toContain("il manque au moins 2 facteur(s) par tronçon");
  }, 30000);

  it("aucune violation d'accessibilite, plan ouvert et annee detaillee", async () => {
    const u = userEvent.setup({ delay: null });
    h.plans = [reponsePlan(plan()).plan];
    h.planParId = { pl1: reponsePlan(plan()) };
    const r = rendre();
    await ouvrirOnglet(u);
    await u.click(await screen.findByRole("button", { name: /Ouvrir PPE 2027-2028 essai/ }));
    const res = await screen.findByTestId("resultat-plan");
    await u.click(within(res).getByRole("button", { name: /Lire les lignes de 2027/ }));
    await screen.findByTestId("lignes-2027");
    expect(await violationsAccessibilite(r.container)).toEqual([]);
  }, 30000);
});

describe("Fiches figees", () => {
  const fiche = { id: "f1", reference: "FI-2027-ABCDEF1234", scenarioId: "s1", tronconId: "t-a", tronconCode: "RN-A", annee: 2027, parametresVersion: "prog-provisoire-1", empreinteSha256: "ab".repeat(32), figeLe: "2026-10-23T10:00:00Z", figeParId: "u1", statut: "PROPOSE", rangStatut: 2, statutDepuis: "2026-10-24T08:00:00Z" };

  it("aucune fiche : le dit, sans inventer", async () => {
    const u = userEvent.setup({ delay: null });
    rendre();
    await screen.findByLabelText(/Enveloppe budgétaire/);
    await u.click(screen.getByRole("tab", { name: "Fiches figées" }));
    expect(await screen.findByTestId("aucune-fiche")).toHaveTextContent("aucun scénario n'a encore été figé");
  }, 30000);

  it("liste, consultation : empreinte verifiee, etiquette figee, cycle de vie en ajout seul ; les statuts recus ne se saisissent pas ici", async () => {
    const u = userEvent.setup({ delay: null });
    h.fiches = [fiche];
    h.ficheParId = { f1: {
      fiche, contenu: { etiquette: "PROVISOIRE, non approuvé", justification: "Retenue (rang 1).", cout: { montantGnf: "4400000000" }, patrimoine: { code: "RN-A" } },
      historique: [
        { rang: 1, de: null, vers: "BROUILLON", origine: "GEOPORTAIL", motif: null, auteurId: "u1", enregistreLe: "2026-10-23T10:00:01Z" },
        { rang: 2, de: "BROUILLON", vers: "PROPOSE", origine: "GEOPORTAIL", motif: "relue", auteurId: "u1", enregistreLe: "2026-10-24T08:00:00Z" },
      ],
    } };
    h.verification = { id: "f1", reference: "FI-2027-ABCDEF1234", empreinteStockee: "ab".repeat(32), verdict: { ok: true } };
    const r = rendre();
    await screen.findByLabelText(/Enveloppe budgétaire/);
    await u.click(screen.getByRole("tab", { name: "Fiches figées" }));
    const table = await screen.findByRole("table", { name: "Fiches d'intervention figées" });
    expect(within(table).getByText("RN-A")).toBeInTheDocument();
    expect(within(table).getByText("Proposée")).toBeInTheDocument();
    await u.click(within(table).getByRole("button", { name: /Consulter FI-2027-ABCDEF1234/ }));
    const d = await screen.findByTestId("detail-fiche");
    expect(within(d).getByText("ab".repeat(32))).toBeInTheDocument();
    expect(await within(d).findByTestId("verdict-fiche")).toHaveTextContent("Recalculée à l'identique : le texte stocké est intact.");
    expect(d).toHaveTextContent("PROVISOIRE, non approuvé");
    expect(sp(d.textContent ?? "")).toContain("Brouillon vers Proposée");
    expect(sp(d.textContent ?? "")).toContain("4 400 000 000 GNF");
    expect(screen.queryByRole("button", { name: /Transmis|Transmise/ })).not.toBeInTheDocument();
    expect(await violationsAccessibilite(r.container)).toEqual([]);
  }, 30000);

  it("une empreinte qui ne correspond plus est signalee ECART, pas masquee", async () => {
    const u = userEvent.setup({ delay: null });
    h.fiches = [fiche];
    h.ficheParId = { f1: { fiche, contenu: {}, historique: [] } };
    h.verification = { id: "f1", reference: "x", empreinteStockee: "ab".repeat(32), verdict: { ok: false, code: "EMPREINTE_DIFFERENTE", motif: "empreinte recalculée différente de l'empreinte stockée" } };
    rendre();
    await screen.findByLabelText(/Enveloppe budgétaire/);
    await u.click(screen.getByRole("tab", { name: "Fiches figées" }));
    await u.click(await screen.findByRole("button", { name: /Consulter FI-2027-ABCDEF1234/ }));
    expect(await screen.findByTestId("verdict-fiche")).toHaveTextContent("ÉCART : empreinte recalculée différente");
  }, 30000);

  it("un filtre d'annee invalide n'est pas applique et le dit", async () => {
    const u = userEvent.setup({ delay: null });
    rendre();
    await screen.findByLabelText(/Enveloppe budgétaire/);
    await u.click(screen.getByRole("tab", { name: "Fiches figées" }));
    await u.type(await screen.findByLabelText("Année"), "20x7");
    expect(await screen.findByRole("alert")).toHaveTextContent("le filtre n'est pas appliqué");
    await waitFor(() => expect(h.gets.filter((g) => g.url.endsWith("/moteur/fiches")).every((g) => !(g.params as Record<string, unknown>).annee)).toBe(true));
  }, 30000);
});

describe("Droits", () => {
  it("un compte sans droit d'ecriture ne peut ni calculer ni figer (boutons inactifs)", async () => {
    h.role = "LECTEUR";
    const u = userEvent.setup({ delay: null });
    rendre();
    await screen.findByLabelText(/Enveloppe budgétaire/);
    await remplirScenario(u);
    expect(screen.getByRole("button", { name: "Calculer le scénario" })).toBeDisabled();
  }, 30000);
});

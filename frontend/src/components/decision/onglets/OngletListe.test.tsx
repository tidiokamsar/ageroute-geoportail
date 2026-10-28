import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useSearchParams } from "react-router-dom";

const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../../lib/api", () => ({ api: { get: h.get } }));

import { OngletListe } from "./OngletListe";
import { _reinitialiserSelection, selectionner, useSelection } from "../../../lib/aideDecisionInterventionsHooks";
import { violationsAccessibilite } from "../../../test/accessibilite";
import { brancherApi, erreurHttp, exclueSynth, ficheSynth, incompleteSynth, interventionSynth, listeSynth, REGIONS_SYNTH } from "../carte/synthetique.testutil";
import type { FiltresDecision } from "../types";

/** Donnees SYNTHETIQUES. L'API est un double : la forme est celle du backend REEL (`LigneClassee`), aucune valeur n'est reelle. */

function Onglet({ filtres = {} as FiltresDecision, onFiltres = vi.fn() }) {
  return <OngletListe filtres={filtres} onFiltres={onFiltres} />;
}
function Sonde() {
  const [p] = useSearchParams();
  return <p data-testid="url">{p.toString()}</p>;
}
function rendre(el = <Onglet />) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  return render(<MemoryRouter initialEntries={["/decision?onglet=liste"]}><QueryClientProvider client={qc}><Sonde />{el}</QueryClientProvider></MemoryRouter>);
}

const routesBase = (lignes: unknown[], extra: Record<string, unknown> = {}) => ({
  "/regions": () => REGIONS_SYNTH,
  "/v2/aide-decision/interventions": () => listeSynth(lignes, extra),
  "/v2/aide-decision/interventions/": () => ficheSynth(1),
});

beforeEach(() => { h.get.mockReset(); _reinitialiserSelection(); });

describe("etats de la liste : jamais un tableau muet", () => {
  it("chargement : role=status", async () => {
    h.get.mockReturnValue(new Promise(() => undefined));
    rendre();
    expect(await screen.findByRole("status", { name: "" })).toHaveTextContent("Chargement des interventions");
  });

  it("erreur serveur : role=alert distinct du vide, avec « Réessayer » au nom unique", async () => {
    brancherApi(h.get, { "/regions": () => REGIONS_SYNTH, "/v2/aide-decision/interventions": () => { throw erreurHttp(500, "base indisponible"); } });
    rendre();
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent("Liste des interventions : chargement impossible");
    expect(alerte).toHaveTextContent("base indisponible");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/Aucune intervention dans ce périmètre/)).toBeNull();
    expect(screen.getByRole("button", { name: "Réessayer : Liste des interventions" })).toBeInTheDocument();
  });

  it("permission refusee (403) : message dedie, ni un vide ni une panne", async () => {
    brancherApi(h.get, { "/regions": () => REGIONS_SYNTH, "/v2/aide-decision/interventions": () => { throw erreurHttp(403); } });
    rendre();
    expect(await screen.findByText(/Liste des interventions : accès refusé/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("vide explicite, avec invitation a reinitialiser les filtres actifs", async () => {
    brancherApi(h.get, routesBase([]));
    rendre(<Onglet filtres={{ regionId: 1 }} />);
    expect(await screen.findByText("Aucune intervention dans ce périmètre")).toBeInTheDocument();
    expect(screen.getByText(/Réinitialisez-les pour élargir/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("une reponse qui n'a pas la forme du contrat est une erreur, pas une liste vide", async () => {
    brancherApi(h.get, { "/regions": () => REGIONS_SYNTH, "/v2/aide-decision/interventions": () => "<html>" });
    rendre();
    expect(await screen.findByRole("alert")).toHaveTextContent("n'a pas la forme du contrat");
  });
});

describe("tableau accessible et colonnes", () => {
  it("caption, entetes scope=col, noms de boutons uniques", async () => {
    brancherApi(h.get, routesBase([interventionSynth(1), interventionSynth(2)]));
    rendre();
    const tableau = await screen.findByRole("table");
    expect(within(tableau).getByText(/Interventions classées par rang : 2 lignes affichées, 2 chargées sur 2 au total/)).toBeInTheDocument();
    const entetes = within(tableau).getAllByRole("columnheader");
    expect(entetes.map((e) => e.textContent)).toEqual(["Rang", "Intervention", "Région", "État physique", "Score", "Coût estimé", "Longueurs", "Dernier constat", "Statut du score", "Carte"]);
    for (const e of entetes) expect(e).toHaveAttribute("scope", "col");
    const noms = within(tableau).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(new Set(noms).size).toBe(noms.length);
    expect(noms).toContain("Ouvrir la fiche, rang 1 : SYN-1 — Tronçon synthétique 1");
    expect(noms).toContain("Voir sur la carte, rang 2 : SYN-2 — Tronçon synthétique 2");
  });

  it("cout : montant, devise, source, validite ; « Coût non estimable » (avec son motif) et « Coût non renseigné » ne sont jamais 0", async () => {
    const base = interventionSynth(1);
    brancherApi(h.get, routesBase([
      interventionSynth(1),
      interventionSynth(2, { coutEstime: null, coutNonEstimable: { code: "BAREME_ABSENT", motif: "aucun barème pour ce traitement" } }),
      interventionSynth(3, { coutEstime: null, coutNonEstimable: null }),
      interventionSynth(4, { coutEstime: { ...base.coutEstime, montantGnf: "5000", bareme: { ...base.coutEstime.bareme, source: "ancienne source", validA: "2020-01-01" } } }),
    ]));
    rendre();
    const t = await screen.findByRole("table");
    expect(within(t).getByText("1 200 000 000 GNF")).toBeInTheDocument();
    expect(within(t).getByText(/source : barème synthétique ; valide jusqu'au 01\/01\/2099 ; estimation provisoire/)).toBeInTheDocument();
    expect(within(t).getByText("Coût non estimable")).toBeInTheDocument();
    expect(within(t).getByText("aucun barème pour ce traitement")).toBeInTheDocument();
    expect(within(t).getByText("Coût non renseigné")).toBeInTheDocument();
    expect(within(t).getByText(/Coût périmé : à ne pas lire comme fiable/)).toBeInTheDocument();
    expect(t.textContent).not.toMatch(/\b0 GNF/);
  });

  it("longueurs metier et geometrique separees, ecart signale PAR LE SERVEUR ; derniere inspection ; statut du score", async () => {
    brancherApi(h.get, routesBase([
      interventionSynth(1, { longueur: { metierKm: 15, geometriqueM: 10000, longueurOrigine: "LONGUEUR_KM", divergence: { signalee: true, ecartRelatif: 0.5, seuilRelatif: 0.1 } } }),
      interventionSynth(2, { longueur: null, dernierConstat: { date: null } }),
    ]));
    rendre();
    const t = await screen.findByRole("table");
    expect(within(t).getByText("Métier : 15 km")).toBeInTheDocument();
    expect(within(t).getByText("Géométrique : 10 km")).toBeInTheDocument();
    expect(within(t).getByText(/Écart signalé : 5 km \(50 %\)/)).toBeInTheDocument();
    expect(within(t).getByText("Métier : non renseignée")).toBeInTheDocument();
    expect(within(t).getByText("Géométrique : non calculée")).toBeInTheDocument();
    expect(within(t).getByText("01/09/2026")).toBeInTheDocument();
    expect(within(t).getByText("date inconnue")).toBeInTheDocument();
    expect(within(t).getAllByText("Calculé")).toHaveLength(2);
  });

  it("MUTATION DE CONTROLE : un score INCOMPLET s'ecrit « Score incomplet », avec ses criteres manquants en clair, jamais le nombre seul", async () => {
    const base = interventionSynth(4);
    brancherApi(h.get, routesBase([
      interventionSynth(1),
      incompleteSynth(2, [{ critere: "TRAFIC", libelle: "Trafic", raison: "aucune mesure" }, { critere: "SECURITE", libelle: "Sécurité", raison: "point noir non confirmé" }], 22.5),
      incompleteSynth(3, [], null),
      { ...base, prioriteTechnique: { ...base.prioriteTechnique, score: null } },
    ]));
    rendre();
    const t = await screen.findByRole("table");
    const incompletes = t.querySelectorAll('[data-score="incomplet"]');
    expect(incompletes).toHaveLength(2);
    expect(incompletes[0]).toHaveTextContent("Score incomplet");
    expect(incompletes[0]).toHaveTextContent("Valeur partielle 22,5");
    expect(incompletes[0]).toHaveTextContent("Critères manquants : Trafic (aucune mesure) ; Sécurité (point noir non confirmé)");
    expect(incompletes[1]).toHaveTextContent("Aucune valeur partielle");
    expect(incompletes[1]).toHaveTextContent("Critères manquants non détaillés par le serveur");
    // le nombre 22,5 n'apparait jamais comme un score « nu » dans la ligne incomplete
    const ligne2 = t.querySelector('tr[data-intervention="synth-2"]')!;
    expect(within(ligne2 as HTMLElement).queryByText("22,5")).toBeNull();
    expect(within(ligne2 as HTMLElement).getByText("Incomplet")).toBeInTheDocument(); // statut du score
    expect(within(t).getByText("Score non calculé")).toBeInTheDocument();
    expect(within(t).getByText("79")).toBeInTheDocument(); // score complet de la ligne 1 (80 - 1)
  });

  it("une intervention NON CLASSEE n'a ni rang ni score : elle dit son motif, reste dans la liste", async () => {
    brancherApi(h.get, routesBase([interventionSynth(1), exclueSynth(2)]));
    rendre();
    const t = await screen.findByRole("table");
    const ligne = t.querySelector('tr[data-intervention="synth-2"]') as HTMLElement;
    expect(within(ligne).getByText("Non classée")).toBeInTheDocument();
    expect(within(ligne).getByText("état non évalué : l'état du tronçon n'est pas évalué")).toBeInTheDocument();
    expect(within(ligne).getByText("Non classé")).toBeInTheDocument();
    expect(within(ligne).getByRole("rowheader")).toHaveTextContent("non établi");
    expect(ligne.textContent).not.toMatch(/\b0\b/);
  });

  it("sans localisation valide : AVERTISSEMENT explicite, la ligne reste, et AUCUN bouton « voir sur la carte »", async () => {
    brancherApi(h.get, routesBase([interventionSynth(1), interventionSynth(2, { localisation: "invalide", localisationMotif: "géométrie absente" })]));
    rendre();
    const t = await screen.findByRole("table");
    const ligne = t.querySelector('tr[data-intervention="synth-2"]') as HTMLElement;
    expect(ligne).toBeTruthy();
    expect(within(ligne).getByText(/Sans localisation valide : consultable ici, pas sur la carte/)).toBeInTheDocument();
    expect(within(ligne).queryByRole("button", { name: /Voir sur la carte/ })).toBeNull();
    expect(within(ligne).getByText("Aucune position")).toBeInTheDocument();
    expect(within(t.querySelector('tr[data-intervention="synth-1"]') as HTMLElement).getByRole("button", { name: /Voir sur la carte/ })).toBeInTheDocument();
  });
});

describe("pagination par curseur, tri, vues", () => {
  it("« Charger plus » passe le curseur, ajoute les lignes, et dit tant que la liste n'est pas complete", async () => {
    const u = userEvent.setup();
    brancherApi(h.get, {
      "/regions": () => REGIONS_SYNTH,
      "/v2/aide-decision/interventions": (p) => (p?.curseur === "c2"
        ? listeSynth([interventionSynth(3)], { total: 3, totalAffiche: 3 })
        : listeSynth([interventionSynth(1), interventionSynth(2)], { page: { limite: 2, prochainCurseur: "c2", aSuivant: true }, total: 3, totalAffiche: 3 })),
    });
    rendre();
    await screen.findByRole("table");
    expect(screen.getByText(/2 interventions chargées sur 3 : la liste n'est pas complète/)).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Charger plus d'interventions" }));
    await waitFor(() => expect(screen.getByText("Liste complète : 3 interventions.")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Charger plus d'interventions" })).toBeNull();
    expect(h.get.mock.calls.filter((c) => c[0] === "/v2/aide-decision/interventions").map((c) => c[1].params.curseur)).toEqual([undefined, "c2"]);
  });

  it("une vue LOCALE et le tri portent sur les lignes CHARGEES : la liste le dit quand il en reste", async () => {
    const u = userEvent.setup();
    brancherApi(h.get, routesBase([interventionSynth(1), interventionSynth(2, { etatPhysique: "CRITIQUE" })], { page: { limite: 2, prochainCurseur: "c2", aSuivant: true }, total: 400, totalAffiche: 400 }));
    rendre();
    await screen.findByRole("table");
    expect(screen.queryByRole("note")).toBeNull();
    await u.selectOptions(screen.getByLabelText("Afficher"), "critiques");
    expect(screen.getByRole("note")).toHaveTextContent("portent sur les 2 interventions déjà chargées (sur 400 au total)");
    const t = screen.getByRole("table");
    expect(t.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(t.querySelector('tr[data-intervention="synth-2"]')).toBeTruthy();
  });

  it("« Score incomplet » et « Non classées » sont des filtres d'affichage du SERVEUR (statutScore) : exacts, sans avertissement de lignes chargees", async () => {
    const u = userEvent.setup();
    brancherApi(h.get, {
      "/regions": () => REGIONS_SYNTH,
      "/v2/aide-decision/interventions": (p) => (p?.statutScore === "INCOMPLET"
        ? listeSynth([incompleteSynth(2, [{ critere: "TRAFIC", libelle: "Trafic", raison: "absent" }])], { page: { limite: 25, prochainCurseur: "c2", aSuivant: true }, total: 400, totalAffiche: 20 })
        : listeSynth([interventionSynth(1), incompleteSynth(2, [])], { total: 400, totalAffiche: 400, page: { limite: 25, prochainCurseur: "c2", aSuivant: true } })),
    });
    rendre();
    await screen.findByRole("table");
    await u.selectOptions(screen.getByLabelText("Afficher"), "score-incomplet");
    await waitFor(() => expect(h.get.mock.calls.some((c) => c[1]?.params?.statutScore === "INCOMPLET")).toBe(true));
    await waitFor(() => expect(screen.getByText(/1 ligne affichée, 1 chargée sur 20 au total/)).toBeInTheDocument());
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("une vue sans ligne chargee dit pourquoi et propose de charger la suite", async () => {
    const u = userEvent.setup();
    brancherApi(h.get, routesBase([interventionSynth(1)], { page: { limite: 1, prochainCurseur: "c2", aSuivant: true }, total: 40, totalAffiche: 40 }));
    rendre();
    await screen.findByRole("table");
    await u.selectOptions(screen.getByLabelText("Afficher"), "sans-localisation");
    expect(screen.getByText("Aucune intervention chargée ne correspond à cette vue")).toBeInTheDocument();
    expect(screen.getByText(/Chargez la suite de la liste/)).toBeInTheDocument();
  });

  it("tri par score decroissant", async () => {
    const u = userEvent.setup();
    const a = interventionSynth(1); const b = interventionSynth(2);
    brancherApi(h.get, routesBase([{ ...a, prioriteTechnique: { ...a.prioriteTechnique, score: 10 } }, { ...b, prioriteTechnique: { ...b.prioriteTechnique, score: 90 } }]));
    rendre();
    await screen.findByRole("table");
    await u.selectOptions(screen.getByLabelText("Trier"), "score");
    const ids = Array.from(screen.getByRole("table").querySelectorAll("tbody tr")).map((r) => r.getAttribute("data-intervention"));
    expect(ids).toEqual(["synth-2", "synth-1"]);
  });

  it("une ligne sans identifiant est ecartee ET comptee", async () => {
    brancherApi(h.get, routesBase([interventionSynth(1), { rang: 9 }]));
    rendre();
    expect(await screen.findByText(/1 ligne illisible ignorée/)).toBeInTheDocument();
  });

  it("un filtre accepte mais NON APPLIQUE par le serveur (statutChantier) est DIT en tete de liste", async () => {
    brancherApi(h.get, routesBase([interventionSynth(1)], { filtres: { appliques: {}, nonAppliques: [{ filtre: "statutChantier", valeurs: ["EN_COURS"], raison: "aucun lien structuré entre une intervention et un chantier" }] } }));
    rendre(<Onglet filtres={{ statutChantier: ["EN_COURS"] }} />);
    const note = await screen.findByText(/Filtre « statutChantier » non appliqué aux interventions : aucun lien structuré/);
    expect(note.closest("[data-filtre-non-applique]")).toBeTruthy();
  });
});

describe("synchronisation avec la carte (AD-04)", () => {
  it("choisir une ligne surligne la ligne et ouvre la fiche de CET element", async () => {
    const u = userEvent.setup();
    brancherApi(h.get, { ...routesBase([interventionSynth(1), interventionSynth(2)]), "/v2/aide-decision/interventions/": () => ficheSynth(2) });
    rendre();
    await u.click(await screen.findByRole("button", { name: /Ouvrir la fiche, rang 2/ }));
    const fiche = await screen.findByRole("complementary", { name: "Fiche de l'intervention" });
    await waitFor(() => expect(fiche).toHaveAttribute("data-intervention", "synth-2"));
    expect(fiche).toHaveTextContent("SYN-2 — Tronçon synthétique 2");
    expect(h.get).toHaveBeenCalledWith("/v2/aide-decision/interventions/synth-2");
    const ligne = screen.getByRole("table").querySelector('tr[data-intervention="synth-2"]');
    expect(ligne).toHaveAttribute("data-selectionnee", "oui");
    expect(screen.getByRole("table").querySelector('tr[data-intervention="synth-1"]')).not.toHaveAttribute("data-selectionnee");
  });

  it("une selection faite AILLEURS (la carte) surligne la ligne ici", async () => {
    brancherApi(h.get, routesBase([interventionSynth(1), interventionSynth(2)]));
    rendre();
    await screen.findByRole("table");
    act(() => selectionner("synth-1"));
    await waitFor(() => expect(screen.getByRole("table").querySelector('tr[data-intervention="synth-1"]')).toHaveAttribute("data-selectionnee", "oui"));
  });

  it("« Voir sur la carte » demande le centrage ET change d'onglet par l'URL du shell (?onglet absent = carte)", async () => {
    const u = userEvent.setup();
    brancherApi(h.get, routesBase([interventionSynth(1)]));
    rendre();
    expect(screen.getByTestId("url")).toHaveTextContent("onglet=liste");
    await u.click(await screen.findByRole("button", { name: "Voir sur la carte, rang 1 : SYN-1 — Tronçon synthétique 1" }));
    expect(screen.getByTestId("url")).not.toHaveTextContent("onglet");
    expect(renderHook(() => useSelection()).result.current).toMatchObject({ id: "synth-1", centrageEnAttente: true });
  });

  it("fermer la fiche rend le focus a la ligne ouverte", async () => {
    const u = userEvent.setup();
    brancherApi(h.get, routesBase([interventionSynth(1)]));
    rendre();
    await u.click(await screen.findByRole("button", { name: /Ouvrir la fiche, rang 1/ }));
    await u.click(await screen.findByRole("button", { name: "Fermer la fiche de l'intervention" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Ouvrir la fiche, rang 1/ })).toHaveFocus());
    expect(screen.queryByRole("complementary", { name: "Fiche de l'intervention" })).toBeNull();
  });
});

describe("fiche : motif, contributions, donnees, limites, historique, actions", () => {
  it("chaque section est rendue telle que l'API la donne", async () => {
    const u = userEvent.setup();
    brancherApi(h.get, { ...routesBase([interventionSynth(1)]), "/v2/aide-decision/interventions/": () => ficheSynth(1) });
    rendre();
    await u.click(await screen.findByRole("button", { name: /Ouvrir la fiche, rang 1/ }));
    const fiche = await screen.findByRole("complementary", { name: "Fiche de l'intervention" });
    await within(fiche).findByText(/Motif synthétique/);
    expect(within(fiche).getByText("État et gravité")).toBeInTheDocument();
    expect(within(fiche).getByText("36 pts")).toBeInTheDocument();
    expect(within(fiche).getByText(/poids 40 % · valeur normalisée 90 sur 100 · mesure MAUVAIS \(valeurs_qualite\)/)).toBeInTheDocument();
    expect(within(fiche).getByText("état validé")).toBeInTheDocument();
    expect(within(fiche).getByText("Trafic de 2019 (synthétique).")).toBeInTheDocument();
    expect(within(fiche).getByText(/Historique des recalculs non disponible : le classement est calculé à la volée/)).toBeInTheDocument();
    expect(within(fiche).getByText(/BROUILLON vers PROPOSE : revue synthétique/)).toBeInTheDocument();
    expect(within(fiche).getByText(/Aucune action possible : Aucun workflow n'existe/)).toBeInTheDocument();
    expect(within(fiche).getByText(/Non disponibles : examiner, affecter, proposer a la programmation, reporter, rejeter|Non disponibles : examiner, affecter, proposer à la programmation, reporter, rejeter/)).toBeInTheDocument();
    expect(within(fiche).getByText(/Consultatif, non engageant/)).toBeInTheDocument();
    expect(within(fiche).getByText(/Provisoire\./)).toBeInTheDocument();
    expect(within(fiche).getByText("paramètres non approuvés (synthétique)")).toBeInTheDocument();
    expect(within(fiche).getByText(/Ordre d'arbitrage coût\/impact \(distinct de la priorité technique\) : rang 1/)).toBeInTheDocument();
    expect(within(fiche).getByText("100 % du poids")).toBeInTheDocument();
  });

  it("fiche minimale : « non fourni » partout, actions vides avec raison, jamais une valeur par defaut", async () => {
    const u = userEvent.setup();
    brancherApi(h.get, {
      ...routesBase([interventionSynth(1)]),
      "/v2/aide-decision/interventions/": () => ({ intervention: { id: "synth-1", localisation: "invalide", localisationMotif: "géométrie absente" }, actions: { disponibles: [], nonDisponibles: [], raison: "intervention déjà programmée" } }),
    });
    rendre();
    await u.click(await screen.findByRole("button", { name: /Ouvrir la fiche, rang 1/ }));
    const fiche = await screen.findByRole("complementary", { name: "Fiche de l'intervention" });
    await within(fiche).findByText("Motif non fourni par le serveur.");
    expect(within(fiche).getByText("Tronçon non rattaché")).toBeInTheDocument();
    expect(within(fiche).getByText("Historique non fourni par le serveur.")).toBeInTheDocument();
    expect(within(fiche).getByText("Aucune action possible : intervention déjà programmée")).toBeInTheDocument();
    expect(within(fiche).getByText(/Le serveur ne fournit pas de limites propres/)).toBeInTheDocument();
    expect(within(fiche).getByText("Aucune contribution fournie par le serveur.")).toBeInTheDocument();
    expect(within(fiche).getByText(/Sans localisation valide/)).toBeInTheDocument();
    expect(within(fiche).getByText(/Motif : géométrie absente\./)).toBeInTheDocument();
    expect(within(fiche).queryByRole("button", { name: /Voir sur la carte/ })).toBeNull();
    expect(within(fiche).getByText("Score non calculé.")).toBeInTheDocument();
  });

  it("fiche d'un score incomplet : criteres manquants en clair, valeur partielle nommee comme telle", async () => {
    const u = userEvent.setup();
    brancherApi(h.get, {
      ...routesBase([interventionSynth(1)]),
      "/v2/aide-decision/interventions/": () => ficheSynth(1, {}, incompleteSynth(1, [{ critere: "TRAFIC", libelle: "Trafic", raison: "aucune mesure" }], 31)),
    });
    rendre();
    await u.click(await screen.findByRole("button", { name: /Ouvrir la fiche, rang 1/ }));
    const fiche = await screen.findByRole("complementary", { name: "Fiche de l'intervention" });
    const bloc = await waitFor(() => { const b = fiche.querySelector('[data-score="incomplet"]'); if (!b) throw new Error("pas encore"); return b; });
    expect(bloc).toHaveTextContent("Score incomplet");
    expect(bloc).toHaveTextContent("Valeur partielle 31 sur 100");
    expect(bloc).toHaveTextContent("elle ne se lit pas comme un score complet");
    expect(bloc).toHaveTextContent("Trafic : aucune mesure");
  });

  it("fiche d'une intervention NON CLASSEE : « ni rang ni score » et le motif d'exclusion", async () => {
    const u = userEvent.setup();
    brancherApi(h.get, { ...routesBase([exclueSynth(1)]), "/v2/aide-decision/interventions/": () => ficheSynth(1, {}, exclueSynth(1)) });
    rendre();
    await u.click(await screen.findByRole("button", { name: /Ouvrir la fiche, rang non établi/ }));
    const fiche = await screen.findByRole("complementary", { name: "Fiche de l'intervention" });
    const bloc = await waitFor(() => { const b = fiche.querySelector('[data-score="exclu"]'); if (!b) throw new Error("pas encore"); return b; });
    expect(bloc).toHaveTextContent("Non classée : ni rang ni score");
    expect(bloc).toHaveTextContent("état non évalué : l'état du tronçon n'est pas évalué");
  });

  it("erreur de la fiche : role=alert et « Réessayer », la liste reste utilisable ; 404 = introuvable ou hors perimetre", async () => {
    const u = userEvent.setup();
    brancherApi(h.get, { ...routesBase([interventionSynth(1)]), "/v2/aide-decision/interventions/": () => { throw erreurHttp(404); } });
    rendre();
    await u.click(await screen.findByRole("button", { name: /Ouvrir la fiche, rang 1/ }));
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent("Fiche de l'intervention : chargement impossible");
    expect(alerte).toHaveTextContent("introuvable ou hors de votre périmètre");
    expect(screen.getByRole("button", { name: "Réessayer : Fiche de l'intervention" })).toBeInTheDocument();
  });
});

describe("filtres partages (AD-11)", () => {
  it("la liste envoie les memes parametres que ceux des filtres, et les resume", async () => {
    brancherApi(h.get, routesBase([interventionSynth(1)]));
    rendre(<Onglet filtres={{ regionId: 2, classe: ["RN", "RR"], etat: ["CRITIQUE"] }} />);
    await screen.findByRole("table");
    const appel = h.get.mock.calls.find((c) => c[0] === "/v2/aide-decision/interventions")!;
    expect(appel[1].params).toEqual({ regionId: "2", classe: "RN,RR", etat: "CRITIQUE" });
    await waitFor(() => expect(screen.getByText(/Filtres partagés actifs : région Région synthétique B/)).toBeInTheDocument());
  });

  it("« Réinitialiser » vide les filtres partages", async () => {
    const u = userEvent.setup();
    const onFiltres = vi.fn();
    brancherApi(h.get, routesBase([interventionSynth(1)]));
    rendre(<Onglet filtres={{ regionId: 2 }} onFiltres={onFiltres} />);
    await u.click(await screen.findByRole("button", { name: "Réinitialiser les filtres partagés" }));
    expect(onFiltres).toHaveBeenCalledWith({});
  });
});

describe("accessibilite", () => {
  it("sans violation axe : tableau, fiche ouverte", async () => {
    const u = userEvent.setup();
    brancherApi(h.get, routesBase([
      interventionSynth(1), incompleteSynth(2, [{ critere: "TRAFIC", libelle: "Trafic", raison: "absent" }]),
      interventionSynth(3, { localisation: "invalide", coutEstime: null, coutNonEstimable: { code: "X", motif: "m" } }), exclueSynth(4),
    ]));
    const { container } = rendre();
    await screen.findByRole("table");
    expect(await violationsAccessibilite(container)).toEqual([]);
    await u.click(screen.getByRole("button", { name: /Ouvrir la fiche, rang 1/ }));
    await screen.findByText(/Motif synthétique/);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

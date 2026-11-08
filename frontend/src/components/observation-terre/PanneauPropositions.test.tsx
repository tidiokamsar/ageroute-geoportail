import { useState } from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../../lib/api", () => ({ api: { get: h.get, post: h.post } }));

import type { Proposition, StatutProposition } from "../../lib/teledetectionApi";
import { usePropositionsListe, useSynthese } from "../../lib/teledetectionHooks";
import { FILTRES_VIDES, versFiltresPropositions, type FiltresEcran } from "../../lib/teledetectionFiltres";
import { PanneauPropositions } from "./PanneauPropositions";
import { rendreAvecClient } from "./rendre.testutil";
import { echec, page, proposition, routeurGet, source, synthese } from "./synthetique.testutil";

/**
 * Panneau Propositions : onglets avec compteurs, filtres, recherche, pagination par curseur, lignes.
 * Defendu : « Anomalie non rattachee » quand le rattachement n'est pas fiable, la confiance montree
 * AVEC sa nature (indice non calibre), aucun compteur a zero en cas d'erreur.
 */

let derniereSelection: Proposition | null = null;

function Harnais({ regionsIndisponibles = false }: { regionsIndisponibles?: boolean }) {
  const [statut, setStatut] = useState<StatutProposition>("A_VERIFIER");
  const [filtres, setFiltres] = useState<FiltresEcran>(FILTRES_VIDES);
  const [sel, setSel] = useState<string | null>(null);
  const s = useSynthese({});
  const liste = usePropositionsListe(versFiltresPropositions(filtres, statut));
  return (
    <PanneauPropositions
      statut={statut} onStatut={setStatut} comptes={s.data?.propositions ?? null} comptesEnErreur={s.isError}
      filtres={filtres} onFiltres={setFiltres} liste={liste}
      sources={[source()]} sourcesIndisponibles={false} regions={regionsIndisponibles ? undefined : [{ id: 1, nom: "Conakry" }]} regionsIndisponibles={regionsIndisponibles}
      selectionId={sel} onSelect={(p) => { derniereSelection = p; setSel(p.id); }}
    />
  );
}

const SYNTHESE = synthese({ propositions: { aVerifier: 5, enAttente: 2, nonConcluantes: 1, confirmees: 3, infirmees: 2, prioritaires: 2 } });

function routes(liste: unknown) {
  h.get.mockImplementation(routeurGet({ "/v2/teledetection/synthese": SYNTHESE, "/v2/teledetection/propositions": liste as never }));
}
const appelsListe = () => h.get.mock.calls.filter((c) => c[0] === "/v2/teledetection/propositions").map((c) => c[1].params as Record<string, unknown>);

beforeEach(() => { h.get.mockReset(); h.post.mockReset(); derniereSelection = null; });

describe("lignes de la liste", () => {
  it("dit le type, le troncon et la zone, la date, la source et la methode, la priorite et la confiance avec sa nature", async () => {
    routes(page([proposition()]));
    rendreAvecClient(<Harnais />);
    const ligne = await screen.findByRole("button", { name: /Inondation/ });
    expect(ligne).toHaveTextContent("GN N0001 · Conakry - Coyah");
    expect(ligne).toHaveTextContent("· Conakry"); // zone
    expect(ligne).toHaveTextContent("20 oct. 2026");
    expect(ligne).toHaveTextContent("Source A · méthode seuil-sar v0");
    expect(ligne).toHaveTextContent("Priorité haute");
    expect(ligne).toHaveTextContent("Détection : indice 0,87 (non calibré)");
    expect(ligne).not.toHaveTextContent("87 %");
  });

  it("rattachement non fiable : « Anomalie non rattachée », le troncon candidat n'est pas affirme", async () => {
    routes(page([
      proposition({ id: "p-2", rattachee: false, troncon: null, rattachement: { confiance: "AUCUN", distanceM: null, algorithme: "a" } }),
      proposition({ id: "p-3", type: "VEGETATION", rattachement: { confiance: "FAIBLE", distanceM: 480, algorithme: "a" } }),
    ]));
    rendreAvecClient(<Harnais />);
    const liste = await screen.findByRole("list", { name: /Propositions À vérifier/ });
    const lignes = within(liste).getAllByRole("button");
    expect(lignes[0]).toHaveTextContent("Anomalie non rattachée");
    expect(lignes[0]).not.toHaveTextContent("GN N0001");
    expect(lignes[1]).toHaveTextContent("Anomalie non rattachée");
    expect(lignes[1]).toHaveTextContent("Tronçon candidat : GN N0001");
    expect(lignes[1]).toHaveTextContent("rattachement de confiance faible");
  });

  it("confiance calibree : probabilite en pourcentage ; sans valeur : « Non renseignée »", async () => {
    routes(page([
      proposition({ id: "a", confianceDetection: { valeur: 0.9, calibree: true, signification: "Probabilité calibrée sur 200 vérifications." } }),
      proposition({ id: "b", confianceDetection: { valeur: null, calibree: false, signification: "" } }),
    ]));
    rendreAvecClient(<Harnais />);
    const lignes = within(await screen.findByRole("list", { name: /Propositions/ })).getAllByRole("button");
    expect(lignes[0]).toHaveTextContent("Détection : 90 %");
    expect(lignes[0]).not.toHaveTextContent("non calibré");
    expect(lignes[1]).toHaveTextContent("Détection : Non renseignée");
  });

  it("priorite non determinee et donnee synthetique : dites, pas masquees", async () => {
    routes(page([proposition({ priorite: { niveau: null, regle: "" } })]));
    rendreAvecClient(<Harnais />);
    const l = await screen.findByRole("button", { name: /Inondation/ });
    expect(l).toHaveTextContent("Priorité non déterminée");
    expect(l).toHaveTextContent("Donnée synthétique");
  });

  it("cliquer une ligne la selectionne et la marque aria-current", async () => {
    routes(page([proposition(), proposition({ id: "p-9", type: "VEGETATION" })]));
    const u = userEvent.setup();
    rendreAvecClient(<Harnais />);
    const l = await screen.findByRole("button", { name: /Végétation/ });
    await u.click(l);
    expect(derniereSelection?.id).toBe("p-9");
    expect(l).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /Inondation/ })).not.toHaveAttribute("aria-current");
  });
});

describe("onglets de statut", () => {
  it("cinq onglets avec compteurs de la synthese, un seul selectionne", async () => {
    routes(page([proposition()]));
    rendreAvecClient(<Harnais />);
    await screen.findByRole("button", { name: /Inondation/ });
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["À vérifier5", "En attente2", "Non concluantes1", "Confirmées3", "Infirmées2"]);
    expect(tabs.filter((t) => t.getAttribute("aria-selected") === "true")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: /À vérifier/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tablist", { name: "Statut des propositions" })).toBeInTheDocument();
  });

  it("changer d'onglet interroge le serveur avec le statut, sans melanger les listes", async () => {
    routes(page([proposition()]));
    const u = userEvent.setup();
    rendreAvecClient(<Harnais />);
    await screen.findByRole("button", { name: /Inondation/ });
    expect(appelsListe().at(-1)).toMatchObject({ statut: "A_VERIFIER" });
    await u.click(screen.getByRole("tab", { name: /Confirmées/ }));
    await waitFor(() => expect(appelsListe().at(-1)).toMatchObject({ statut: "CONFIRMEE" }));
    expect(screen.getByRole("tab", { name: /Confirmées/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "onglet-CONFIRMEE");
  });

  it("clavier : fleches, Fin et Debut deplacent la selection", async () => {
    routes(page([proposition()]));
    const u = userEvent.setup();
    rendreAvecClient(<Harnais />);
    await screen.findByRole("button", { name: /Inondation/ });
    screen.getByRole("tab", { name: /À vérifier/ }).focus();
    await u.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: /En attente/ })).toHaveAttribute("aria-selected", "true");
    await u.keyboard("{End}");
    expect(screen.getByRole("tab", { name: /Infirmées/ })).toHaveAttribute("aria-selected", "true");
    await u.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: /À vérifier/ })).toHaveAttribute("aria-selected", "true");
    await u.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: /Infirmées/ })).toHaveAttribute("aria-selected", "true");
    await u.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: /À vérifier/ })).toHaveAttribute("aria-selected", "true");
  });

  it("compteurs indisponibles (synthese en erreur) : des tirets, jamais 0", async () => {
    h.get.mockImplementation(routeurGet({ "/v2/teledetection/synthese": echec(500), "/v2/teledetection/propositions": page([proposition()]) }));
    rendreAvecClient(<Harnais />);
    await screen.findByRole("button", { name: /Inondation/ });
    await waitFor(() => expect(screen.getByText(/compteurs des onglets sont indisponibles/)).toBeInTheDocument(), { timeout: 5000 });
    for (const t of screen.getAllByRole("tab")) expect(t.textContent).toMatch(/—/);
    expect(screen.getAllByRole("tab").some((t) => /\b0\b/.test(t.textContent ?? ""))).toBe(false);
  });
});

describe("pagination par curseur et total", () => {
  it("« Charger plus » demande la page suivante avec le curseur et ajoute les lignes", async () => {
    routes((c?: { params?: Record<string, unknown> }) => (c?.params?.curseur
      ? page([proposition({ id: "p-3", type: "VEGETATION" })], { total: 3 })
      : page([proposition({ id: "p-1" }), proposition({ id: "p-2", type: "COUPURE_PROBABLE" })], { total: 3, suivant: "curseur-2" })));
    const u = userEvent.setup();
    rendreAvecClient(<Harnais />);
    await screen.findByRole("button", { name: /Coupure probable/ });
    expect(screen.getByRole("heading", { name: /Propositions/ })).toHaveTextContent("(3)");
    expect(screen.getByText("2 affichées sur 3")).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Charger plus" }));
    await screen.findByRole("button", { name: /Végétation/ });
    expect(appelsListe().at(-1)).toMatchObject({ curseur: "curseur-2", statut: "A_VERIFIER" });
    expect(screen.getByText("3 affichées sur 3")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Charger plus" })).not.toBeInTheDocument();
  });

  it("l'echec de la page suivante garde les lignes deja la et le dit (alerte)", async () => {
    routes((c?: { params?: Record<string, unknown> }) => {
      if (c?.params?.curseur) return echec(500, "Panne page 2");
      return page([proposition()], { total: 40, suivant: "c2" });
    });
    const u = userEvent.setup();
    rendreAvecClient(<Harnais />);
    await screen.findByRole("button", { name: /Inondation/ });
    await u.click(screen.getByRole("button", { name: "Charger plus" }));
    expect(await screen.findByRole("alert", undefined, { timeout: 5000 })).toHaveTextContent("Panne page 2");
    expect(screen.getByRole("button", { name: /Inondation/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Charger plus" })).toBeInTheDocument();
  });
});

describe("recherche et filtres", () => {
  it("la recherche part en parametre q", async () => {
    routes(page([proposition()]));
    rendreAvecClient(<Harnais />);
    await screen.findByRole("button", { name: /Inondation/ });
    fireEvent.change(screen.getByRole("searchbox", { name: "Rechercher dans les propositions" }), { target: { value: " Kindia " } });
    await waitFor(() => expect(appelsListe().at(-1)).toMatchObject({ q: "Kindia" }));
  });

  it("les filtres sont derriere un bouton qui annonce son etat, et envoient priorite, type, source, region, rattachee, dates", async () => {
    routes(page([proposition()]));
    const u = userEvent.setup();
    rendreAvecClient(<Harnais />);
    await screen.findByRole("button", { name: /Inondation/ });
    const bouton = screen.getByRole("button", { name: /Filtres/ });
    expect(bouton).toHaveAttribute("aria-expanded", "false");
    await u.click(bouton);
    expect(bouton).toHaveAttribute("aria-expanded", "true");
    const groupe = screen.getByRole("group", { name: "Filtres des propositions" });
    await u.selectOptions(within(groupe).getByLabelText("Priorité"), "HAUTE");
    await u.selectOptions(within(groupe).getByLabelText("Type de changement"), "VEGETATION");
    await u.selectOptions(within(groupe).getByLabelText("Source"), "SRC-A");
    await u.selectOptions(within(groupe).getByLabelText("Région"), "1");
    await u.selectOptions(within(groupe).getByLabelText("Rattachement au tronçon"), "non");
    fireEvent.change(within(groupe).getByLabelText("Observée à partir du"), { target: { value: "2026-10-01" } });
    await waitFor(() => expect(appelsListe().at(-1)).toMatchObject({
      statut: "A_VERIFIER", priorite: "HAUTE", type: "VEGETATION", source: "SRC-A", regionId: "1", rattachee: "false", depuis: "2026-10-01",
    }));
    expect(screen.getByRole("button", { name: /Filtres/ })).toHaveTextContent("6");
    await u.click(within(groupe).getByRole("button", { name: "Réinitialiser les filtres" }));
    // La liste revient a la cle de requete initiale, deja en cache : on controle les champs, pas un nouvel appel.
    await waitFor(() => expect(within(groupe).getByLabelText("Priorité")).toHaveValue(""));
    expect(within(groupe).getByLabelText("Rattachement au tronçon")).toHaveValue("");
    expect(screen.getByRole("button", { name: /Filtres/ })).not.toHaveTextContent("6");
  });

  it("un intervalle de dates incoherent est signale (alerte)", async () => {
    routes(page([proposition()]));
    const u = userEvent.setup();
    rendreAvecClient(<Harnais />);
    await screen.findByRole("button", { name: /Inondation/ });
    await u.click(screen.getByRole("button", { name: /Filtres/ }));
    const groupe = screen.getByRole("group", { name: "Filtres des propositions" });
    fireEvent.change(within(groupe).getByLabelText("Observée à partir du"), { target: { value: "2026-10-20" } });
    fireEvent.change(within(groupe).getByLabelText("Observée jusqu'au"), { target: { value: "2026-10-10" } });
    expect(await within(groupe).findByRole("alert")).toHaveTextContent(/postérieure/);
  });

  it("une liste de regions indisponible desactive le filtre et le dit", async () => {
    routes(page([proposition()]));
    const u = userEvent.setup();
    rendreAvecClient(<Harnais regionsIndisponibles />);
    await screen.findByRole("button", { name: /Inondation/ });
    await u.click(screen.getByRole("button", { name: /Filtres/ }));
    const select = screen.getByLabelText("Région");
    expect(select).toBeDisabled();
    expect(within(select).getByRole("option", { name: "Régions indisponibles" })).toBeInTheDocument();
  });
});

describe("etats de la liste", () => {
  it("vide : message explicite, different selon la presence de filtres", async () => {
    routes(page([], { total: 0 }));
    const u = userEvent.setup();
    rendreAvecClient(<Harnais />);
    expect(await screen.findByText("Aucune proposition « À vérifier »")).toBeInTheDocument();
    expect(screen.getByText(/rien à traiter dans cette catégorie/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz" } });
    await u.click(screen.getByRole("button", { name: /Filtres/ }));
    expect(await screen.findByText(/ne correspond à ces filtres/)).toBeInTheDocument();
  });

  it("chargement : role status ; titre sans nombre", () => {
    h.get.mockImplementation(() => new Promise(() => {}));
    rendreAvecClient(<Harnais />);
    expect(screen.getAllByRole("status").some((e) => /Chargement des propositions/.test(e.textContent ?? ""))).toBe(true);
    expect(screen.getByRole("heading", { name: /Propositions/ })).toHaveTextContent("(—)");
  });

  it("erreur serveur : alerte avec Reessayer, jamais une liste vide ; le titre n'annonce pas 0", async () => {
    routes(echec(500, "Panne liste"));
    rendreAvecClient(<Harnais />);
    const alerte = await screen.findByRole("alert", undefined, { timeout: 5000 });
    expect(alerte).toHaveTextContent("Panne liste");
    expect(within(alerte).getByRole("button", { name: /Réessayer/ })).toBeInTheDocument();
    expect(screen.queryByText(/Aucune proposition «/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Propositions/ })).toHaveTextContent("(—)");
  });

  it("liste en erreur AVEC donnees anciennes : UN SEUL message (le bandeau « donnees perimees »), pas une alerte d'erreur en plus", async () => {
    let n = 0;
    h.get.mockImplementation(async (url: string) => {
      if (url === "/v2/teledetection/synthese") return { data: SYNTHESE };
      n += 1;
      if (n === 1) return { data: page([proposition()]) };
      throw echec(500, "Panne liste");
    });
    const { qc } = rendreAvecClient(<Harnais />);
    await screen.findByRole("button", { name: /Inondation/ });
    await act(async () => { await qc.invalidateQueries({ queryKey: ["teledetection", "propositions"] }).catch(() => {}); });
    const bandeau = await screen.findByText(/Propositions : l'actualisation a échoué/, undefined, { timeout: 5000 });
    expect(bandeau.closest("[data-etat='perime']")).toBeInTheDocument();
    expect(screen.queryByText(/Propositions : chargement impossible/)).not.toBeInTheDocument();
    expect(document.querySelectorAll("[data-etat='erreur']")).toHaveLength(0);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Inondation/ })).toBeInTheDocument(); // les donnees anciennes restent lisibles
    expect(screen.getByRole("button", { name: "Actualiser : Propositions" })).toBeInTheDocument();
  });

  it("liste en erreur AVEC donnees anciennes : le message unique porte la cause ET la date des donnees affichees, le titre garde le total lu", async () => {
    let n = 0;
    h.get.mockImplementation(async (url: string) => {
      if (url === "/v2/teledetection/synthese") return { data: SYNTHESE };
      n += 1;
      if (n === 1) return { data: page([proposition()], { total: 7 }) };
      throw echec(500, "Panne liste");
    });
    const { qc } = rendreAvecClient(<Harnais />);
    await screen.findByRole("button", { name: /Inondation/ });
    await act(async () => { await qc.invalidateQueries({ queryKey: ["teledetection", "propositions"] }).catch(() => {}); });
    const bandeau = (await screen.findByText(/Propositions : l'actualisation a échoué/, undefined, { timeout: 5000 })).closest("[data-etat='perime']") as HTMLElement;
    expect(bandeau).toHaveTextContent("Panne liste");
    expect(bandeau).toHaveTextContent(/ces données datent du .*20\d\d/);
    // Un seul message d'etat pour la liste : ni alerte, ni second bandeau.
    expect(document.querySelectorAll("#panneau-propositions [data-etat]")).toHaveLength(1);
    expect(within(screen.getByRole("tabpanel")).queryByRole("alert")).not.toBeInTheDocument();
    // Les donnees affichees sont celles de la derniere lecture : le titre ne dit pas « indisponible » en face d'une liste lue.
    expect(screen.getByRole("heading", { name: /Propositions/ })).toHaveTextContent("(7)");
    expect(screen.getByRole("heading", { name: /Propositions/ })).not.toHaveTextContent("indisponible");
  });

  it("permission refusee : message dedie (statut), ni alerte ni liste vide", async () => {
    routes(echec(403, "Hors périmètre"));
    rendreAvecClient(<Harnais />);
    expect(await screen.findByText(/Propositions : accès refusé/)).toBeInTheDocument();
    expect(screen.queryByText(/Aucune proposition «/)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

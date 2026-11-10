import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("react-leaflet", async () => (await import("../components/projets-voirie/carteDouble.testutil")).moduleReactLeaflet());

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), role: "GESTIONNAIRE", userId: "u-gest" }));
vi.mock("../lib/api", () => ({ api: { get: h.get, post: h.post, patch: h.patch, delete: h.delete } }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: h.userId, nomComplet: "Moussa Gestionnaire", role: h.role, modulesAutorises: ["projets-voirie"] } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/download", () => ({ downloadViaApi: vi.fn().mockResolvedValue(undefined) }));

import { mapDouble, reinitialiserCarte } from "../components/projets-voirie/carteDouble.testutil";
import { O, S } from "../components/projets-voirie/synthetique.testutil";
import {
  CONFLIT_INVESTIGUER, COMPTEURS, brut, conflit, decision, fiche, histo, pageConflits, preuve, serveurConflit, serveurPage,
} from "../components/projets-voirie/conflitsSynthetiques.testutil";
import { BASE, erreurHttp, ficheDe, rendrePage, reponseApi, type SurchargesApi } from "../components/projets-voirie/conflitsPage.testutil";
import { AVERTISSEMENTS_DE_SECOURS, BANDEAU_GARDE_FOUS } from "../lib/projetsVoirieConflits";

/**
 * Onglet « Conflits » de la page projet : bandeau permanent, liste (filtres, compteurs, tri, curseur, etats), fiche (contenu, carte, clavier).
 * Les reponses de l'API sont SYNTHETIQUES ; on verifie ce qui part sur le fil et ce que la page montre.
 */

configure({ asyncUtilTimeout: 8000 });

function installer(over: SurchargesApi = {}) {
  h.get.mockImplementation(async (url: string, opts?: { params?: Record<string, unknown> }) => reponseApi(url, opts?.params, over));
}
const appelsListe = () => h.get.mock.calls.filter((c) => c[0] === `${BASE}/conflits`).map((c) => (c[1]?.params ?? {}) as Record<string, string>);

async function ouvrirOnglet(over: SurchargesApi = {}) {
  installer(over);
  const r = rendrePage();
  await userEvent.click(await screen.findByRole("tab", { name: "Conflits" }));
  return r;
}
async function ouvrirListe(over: SurchargesApi = {}) {
  await ouvrirOnglet(over);
  await screen.findByRole("list", { name: "Liste des conflits" });
}
const bouton = (id: string) => document.querySelector<HTMLButtonElement>(`button[data-conflit-id="${id}"]`)!;
async function ouvrirFiche(id = "cf-1", over: SurchargesApi = {}) {
  await ouvrirListe(over);
  await userEvent.click(bouton(id));
  return screen.findByTestId("fiche-conflit");
}

beforeEach(() => {
  for (const f of [h.get, h.post, h.patch, h.delete]) f.mockReset();
  h.role = "GESTIONNAIRE"; h.userId = "u-gest";
  reinitialiserCarte();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
});
afterEach(() => { Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true }); });

describe("onglet Conflits : place dans la page et bandeau permanent", () => {
  it("sept onglets WAI-ARIA pour un decideur, fleches et Fin : Conflits est le troisieme (Reseaux, Sources, Documents et Export ont leurs propres essais)", async () => {
    installer();
    rendrePage();
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Analyse", "Couches", "Conflits", "Réseaux", "Sources", "Documents", "Export"]);
    tabs[0].focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(tabs[2]).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(tabs[2]).toHaveAttribute("aria-selected", "true");
    expect(tabs[2]).toHaveAttribute("aria-controls", "pv-panneau-conflits");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "pv-onglet-conflits");
    await userEvent.keyboard("{End}");
    expect(tabs[6]).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(tabs[0]).toHaveFocus();
  });

  it("le bandeau des garde-fous reprend le texte du contrat et ne disparait dans aucun etat", async () => {
    await ouvrirOnglet();
    const b = await screen.findByTestId("bandeau-garde-fous");
    expect(b).toHaveTextContent(BANDEAU_GARDE_FOUS);
    await screen.findByRole("list", { name: "Liste des conflits" });
    expect(screen.getByTestId("bandeau-garde-fous")).toBeVisible();
    await userEvent.click(bouton("cf-1"));
    await screen.findByTestId("fiche-conflit");
    expect(screen.getByTestId("bandeau-garde-fous")).toHaveTextContent("n'est décidé ni ordonné");
    await userEvent.click(screen.getByRole("tab", { name: "Couches" }));
    await userEvent.click(screen.getByRole("tab", { name: "Conflits" }));
    expect(screen.getByTestId("bandeau-garde-fous")).toBeVisible();
  });

  it("bandeau present aussi en chargement, en erreur et en liste vide", async () => {
    installer({ liste: { conflits: [], compteurs: null } });
    rendrePage();
    await userEvent.click(await screen.findByRole("tab", { name: "Conflits" }));
    expect(screen.getByTestId("bandeau-garde-fous")).toBeInTheDocument();
    await screen.findByText("Aucun dossier de conflit pour ce projet");
    expect(screen.getByTestId("bandeau-garde-fous")).toBeInTheDocument();
  });

  it("l'onglet ne charge rien tant qu'on ne l'ouvre pas, puis garde son etat (filtres) quand on change d'onglet", async () => {
    installer();
    rendrePage();
    await screen.findByRole("tab", { name: "Conflits" });
    expect(appelsListe()).toHaveLength(0);
    await userEvent.click(screen.getByRole("tab", { name: "Conflits" }));
    await screen.findByRole("list", { name: "Liste des conflits" });
    await userEvent.click(screen.getByRole("button", { name: "Confirmé (2)" }));
    await waitFor(() => expect(appelsListe().some((p) => p.statut === "CONFIRME")).toBe(true));
    await userEvent.click(screen.getByRole("tab", { name: "Analyse" }));
    await userEvent.click(screen.getByRole("tab", { name: "Conflits" }));
    expect(screen.getByRole("button", { name: "Confirmé (2)" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("liste : contenu, badges texte + forme, compteurs", () => {
  it("chaque conflit montre statut et type en TEXTE avec une forme propre, axe, concessionnaire, mesure, responsable, echeance, risque", async () => {
    await ouvrirListe();
    const l = screen.getByRole("list", { name: "Liste des conflits" });
    const items = within(l).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    const premier = items.find((i) => i.querySelector('[data-conflit-id="cf-1"]'))!;
    expect(within(premier).getByText("Potentiel")).toBeInTheDocument();
    expect(within(premier).getByText("Intersection avec la chaussée")).toBeInTheDocument();
    expect(premier).toHaveTextContent("Axe A · Operateur synthetique A");
    expect(premier).toHaveTextContent("chaussée 74 m");
    expect(premier).toHaveTextContent("2 croisement(s)");
    expect(premier).toHaveTextContent("Responsable : Awa Responsable");
    expect(premier).toHaveTextContent("Risque moyen");
    // La forme (icone) differe d'un statut a l'autre : la couleur ne porte pas seule.
    const formes = [...l.querySelectorAll("[data-statut-conflit]")].map((e) => `${e.getAttribute("data-statut-conflit")}:${e.getAttribute("data-forme")}`);
    expect(new Set(formes.map((f) => f.split(":")[1])).size).toBe(new Set(formes.map((f) => f.split(":")[0])).size);
  });

  it("zone sans jeu reseau, a reexaminer avec son motif, echeance depassee, risque inconnu distinct de faible", async () => {
    await ouvrirListe();
    const sans = bouton("cf-4").closest("li")!;
    expect(sans).toHaveTextContent("aucun concessionnaire (zone sans jeu réseau)");
    expect(within(sans).getByText(/À réexaminer : non retrouvé par la dernière analyse/)).toBeInTheDocument();
    expect(within(sans).getByText("Risque inconnu")).toBeInTheDocument();
    const inv = bouton("cf-2").closest("li")!;
    expect(within(inv).getByText("Échéance dépassée")).toBeInTheDocument();
    expect(within(inv).getByText("Risque non renseigné")).toBeInTheDocument();
    expect(inv).toHaveTextContent("Responsable : non attribué");
  });

  it("compteurs par statut du serveur : boutons a bascule, « Tous » = somme ; un compteur absent n'affiche pas zero", async () => {
    await ouvrirListe();
    const g = screen.getByRole("group", { name: /Filtrer par statut/ });
    expect(within(g).getByRole("button", { name: "Tous (4)" })).toHaveAttribute("aria-pressed", "true");
    expect(within(g).getByRole("button", { name: "Confirmé (2)" })).toBeInTheDocument();
    expect(within(g).getByRole("button", { name: "À investiguer (1)" })).toBeInTheDocument();
    expect(within(g).getByRole("button", { name: "Clos (0)" })).toBeInTheDocument();
  });

  it("sans compteurs dans la reponse : aucun nombre n'est invente", async () => {
    await ouvrirListe({ liste: brut(serveurPage(pageConflits(undefined, { compteurs: null }))) });
    const g = screen.getByRole("group", { name: /Filtrer par statut/ });
    expect(within(g).getByRole("button", { name: "Tous" })).toBeInTheDocument();
    expect(within(g).getByRole("button", { name: "Confirmé" })).toBeInTheDocument();
    expect(g.textContent).not.toMatch(/\(\d/);
  });

  it("un element illisible du serveur n'est pas rendu mais signale", async () => {
    await ouvrirListe({ liste: { conflits: [brut(serveurConflit(conflit())), { id: "x", type: "INCONNU", statut: "INCONNU" }], compteurs: null } });
    expect(screen.getAllByRole("listitem").filter((i) => i.querySelector("[data-conflit-id]"))).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent("1 élément(s) de la réponse du serveur n'ont pas pu être lus");
  });
});

describe("liste : filtres, recherche, tri, curseur", () => {
  it("chip de statut : parametre `statut` envoye, re-clic pour retirer", async () => {
    await ouvrirListe();
    await userEvent.click(screen.getByRole("button", { name: "Potentiel (1)" }));
    await waitFor(() => expect(appelsListe().at(-1)).toEqual({ statut: "POTENTIEL" }));
    expect(screen.getByRole("button", { name: "Potentiel (1)" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Potentiel (1)" }));
    // La requete sans filtre est deja en cache : on verifie l'etat des filtres, pas un nouvel appel.
    expect(screen.getByRole("button", { name: "Potentiel (1)" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Tous (4)" })).toHaveAttribute("aria-pressed", "true");
  });

  it("recherche differee : une requete par pause, parametre `q`", async () => {
    await ouvrirListe();
    const n0 = appelsListe().length;
    await userEvent.type(screen.getByLabelText(/Rechercher \(axe/), "fibre");
    await waitFor(() => expect(appelsListe().at(-1)).toEqual({ q: "fibre" }));
    expect(appelsListe().length - n0).toBeLessThanOrEqual(2);
  });

  it("filtre axe differe comme la recherche : une requete par pause (pas une par touche), longueur 300, libelle « nom exact de l'axe »", async () => {
    await ouvrirListe();
    await userEvent.click(screen.getByRole("button", { name: /Filtres avancés/ }));
    const champ = screen.getByLabelText(/^Nom exact de l'axe/) as HTMLInputElement;
    expect(champ).toHaveAttribute("maxLength", "300");
    expect(champ).toHaveAccessibleDescription(/Le serveur compare le nom en entier/);
    const n0 = appelsListe().length;
    await userEvent.type(champ, "Axe Nord-Sud 12");
    expect(champ.value).toBe("Axe Nord-Sud 12");
    await waitFor(() => expect(appelsListe().at(-1)).toEqual({ axe: "Axe Nord-Sud 12" }));
    // Aucune requete intermediaire (« A », « Ax », ...) : au plus la requete finale.
    expect(appelsListe().slice(n0).filter((p) => p.axe !== "Axe Nord-Sud 12")).toEqual([]);
    expect(appelsListe().length - n0).toBeLessThanOrEqual(1);
  });

  it("le champ axe accepte 300 caracteres, la recherche 100 (limites du serveur)", async () => {
    await ouvrirListe();
    await userEvent.click(screen.getByRole("button", { name: /Filtres avancés/ }));
    const long = "a".repeat(300);
    await userEvent.click(screen.getByLabelText(/^Nom exact de l'axe/));
    await userEvent.paste(long);
    expect((screen.getByLabelText(/^Nom exact de l'axe/) as HTMLInputElement).value).toHaveLength(300);
    expect(screen.getByLabelText(/Rechercher \(axe/)).toHaveAttribute("maxLength", "100");
    await waitFor(() => expect(appelsListe().at(-1)).toEqual({ axe: long }));
  });

  it("filtres avances : type, axe, concessionnaire, responsable (Moi), a reexaminer, echeance depassee ; le tout part au serveur ; reinitialiser", async () => {
    await ouvrirListe();
    expect(screen.getByRole("button", { name: /Filtres avancés/ })).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(screen.getByRole("button", { name: /Filtres avancés/ }));
    await userEvent.selectOptions(screen.getByLabelText("Type de conflit"), "PROXIMITE");
    await userEvent.selectOptions(screen.getByLabelText("Concessionnaire"), "c1");
    await userEvent.selectOptions(screen.getByLabelText("Responsable"), "u-gest");
    await userEvent.type(screen.getByLabelText(/^Nom exact de l'axe/), "Axe B");
    await userEvent.click(screen.getByLabelText(/À réexaminer/));
    await userEvent.click(screen.getByLabelText("Échéance dépassée"));
    await waitFor(() => expect(appelsListe().at(-1)).toEqual({ type: "PROXIMITE", concessionnaireId: "c1", responsableId: "u-gest", axe: "Axe B", aReexaminer: "true", echeanceDepassee: "true" }));
    expect(screen.getByRole("button", { name: /Filtres avancés \(6 actifs\)/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Réinitialiser les filtres/ }));
    expect(screen.queryByRole("button", { name: /Réinitialiser les filtres/ })).toBeNull();
    expect((screen.getByLabelText("Type de conflit") as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText(/^Nom exact de l'axe/) as HTMLInputElement).value).toBe("");
    expect(screen.getByLabelText("Échéance dépassée")).not.toBeChecked();
  });

  it("les responsables et axes proposes viennent des dossiers charges", async () => {
    await ouvrirListe();
    await userEvent.click(screen.getByRole("button", { name: /Filtres avancés/ }));
    const resp = screen.getByLabelText("Responsable") as HTMLSelectElement;
    expect([...resp.options].map((o) => o.textContent)).toEqual(["Tous les responsables", "Moi (Moussa Gestionnaire)", "Awa Responsable"]);
    const axes = document.querySelector("datalist")!;
    expect([...axes.querySelectorAll("option")].map((o) => o.getAttribute("value"))).toEqual(["Axe A", "Axe B", "Axe C", "Axe D"]);
  });

  it("tri cote client sur les dossiers charges (le contrat n'a pas de parametre de tri) : aucune nouvelle requete, ordre change, mention", async () => {
    await ouvrirListe();
    const avant = appelsListe().length;
    const ordre = () => [...document.querySelectorAll("button[data-conflit-id]")].map((b) => b.getAttribute("data-conflit-id"));
    expect(ordre()).toEqual(["cf-1", "cf-2", "cf-3", "cf-4"]);
    await userEvent.selectOptions(screen.getByLabelText("Trier"), "risque");
    expect(ordre()).toEqual(["cf-3", "cf-1", "cf-4", "cf-2"]);
    expect(screen.getByTestId("aide-tri")).toHaveTextContent("Le tri ne porte que sur les conflits déjà chargés");
    await userEvent.selectOptions(screen.getByLabelText("Trier"), "echeance");
    expect(ordre()).toEqual(["cf-2", "cf-1", "cf-4", "cf-3"]);
    await userEvent.selectOptions(screen.getByLabelText("Trier"), "statut");
    expect(ordre()).toEqual(["cf-2", "cf-1", "cf-3", "cf-4"]);
    expect(appelsListe()).toHaveLength(avant);
  });

  it("curseur : « Charger les conflits suivants » envoie `curseur` et ajoute la page", async () => {
    const liste = (p?: Record<string, unknown>) => (p?.curseur === "c2"
      ? brut(serveurPage(pageConflits([CONFLIT_INVESTIGUER], { suivant: null })))
      : brut(serveurPage(pageConflits([conflit()], { suivant: "c2" }))));
    await ouvrirListe({ liste });
    expect(screen.getByTestId("etat-liste-conflits")).toHaveTextContent("d'autres restent à charger");
    await userEvent.click(screen.getByRole("button", { name: "Charger les conflits suivants" }));
    await waitFor(() => expect(appelsListe().at(-1)).toEqual({ curseur: "c2" }));
    await waitFor(() => expect(document.querySelectorAll("button[data-conflit-id]")).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Charger les conflits suivants" })).toBeNull();
  });
});

describe("liste : etats vide, chargement, erreurs expliquees", () => {
  it("vide sans filtre : explique comment commencer et rappelle que l'absence de conflit ne prouve pas l'absence de reseau", async () => {
    await ouvrirOnglet({ liste: { conflits: [], compteurs: null } });
    const t = await screen.findByText("Aucun dossier de conflit pour ce projet");
    const zone = t.closest("[data-etat=vide]")!;
    expect(zone).toHaveTextContent("lancez-en une");
    expect(zone).toHaveTextContent("l'absence de conflit détecté ne prouve pas l'absence de réseau");
  });

  it("objet du fichier concerne : montre dans la liste et dans la fiche", async () => {
    await ouvrirListe();
    expect(bouton("cf-1").closest("li")).toHaveTextContent("Objet : Fibre FO-01");
    await userEvent.click(bouton("cf-1"));
    const f = await screen.findByTestId("fiche-conflit");
    expect(within(f).getByRole("heading", { name: "Mesure" }).closest("section")).toHaveTextContent("Objet du fichierFibre FO-01");
    expect(within(f).getByRole("heading", { name: "Mesure" }).closest("section")).toHaveTextContent("Partie de réseau concernée145 m");
  });

  it("largeurs utilisees par la derniere analyse, algorithme et portee de la regle", async () => {
    const f = await ouvrirFiche();
    const regle = within(f).getByRole("heading", { name: "Règle appliquée" }).closest("section")!;
    expect(regle).toHaveTextContent("Largeurs utiliséeschaussée 7 m, emprise 15 m");
    expect(regle).toHaveTextContent("Algorithme2D-UTM-1");
    expect(regle).toHaveTextContent("(règle générale)");
  });

  it("vide avec filtre : message different, on propose de reinitialiser", async () => {
    await ouvrirOnglet({ liste: (p?: Record<string, unknown>) => (p?.statut ? { conflits: [], compteurs: COMPTEURS } : brut(serveurPage(pageConflits()))) });
    await screen.findByRole("list", { name: "Liste des conflits" });
    await userEvent.click(screen.getByRole("button", { name: "Clos (0)" }));
    await screen.findByText("Aucun conflit ne correspond à ces filtres");
  });

  it("chargement", async () => {
    h.get.mockImplementation(async (url: string, opts?: { params?: Record<string, unknown> }) => {
      if (url === `${BASE}/conflits`) return new Promise(() => undefined);
      return reponseApi(url, opts?.params);
    });
    rendrePage();
    await userEvent.click(await screen.findByRole("tab", { name: "Conflits" }));
    expect(await screen.findByText("Chargement des conflits…")).toBeInTheDocument();
  });

  it.each([
    [403, undefined, "permission", /clé de module/],
    [404, "PROJET_INTROUVABLE", "introuvable", /introuvable/],
    [503, "PROJET_OCCUPE", "erreur", /Ce projet ou ce dossier est occupé/],
    [503, undefined, "erreur", /momentanément indisponible ou occupé \(503\)/],
    [504, undefined, "erreur", /délai autorisé \(504\)/],
    [504, "ANALYSE_TROP_LONGUE", "erreur", /dépassé le délai/],
  ] as const)("erreur %i %s : expliquee, jamais rendue comme une liste vide", async (status, code, etat, motif) => {
    await ouvrirOnglet({ liste: erreurHttp(status, code) });
    const alerte = await screen.findByText(motif);
    const zone = alerte.closest("[role=alert]")!;
    expect(zone).toHaveAttribute("data-etat", etat);
    expect(screen.queryByText("Aucun dossier de conflit pour ce projet")).toBeNull();
    expect(screen.queryByText("Aucun conflit à afficher.")).toBeNull();
    expect(screen.getByTestId("bandeau-garde-fous")).toBeInTheDocument();
  });

  it("une reponse sans liste LEVE une erreur « reponse inattendue » (pas un vide)", async () => {
    await ouvrirOnglet({ liste: { foo: 1 } });
    expect(await screen.findByText(/Réponse inattendue du serveur/)).toBeInTheDocument();
  });
});

describe("fiche d'un conflit", () => {
  it("ouvre la fiche, focalise le titre, montre mesure, regle et version, precision, vertical non evalue, troncons proches", async () => {
    const f = await ouvrirFiche();
    const titre = within(f).getByRole("heading", { level: 3 });
    expect(titre).toHaveTextContent("Intersection avec la chaussée : Axe A");
    await waitFor(() => expect(titre).toHaveFocus());
    const mesure = within(f).getByRole("heading", { name: "Mesure" }).closest("section")!;
    expect(mesure).toHaveTextContent("Longueur dans la chaussée74 m");
    expect(mesure).toHaveTextContent("Distance minimale0 m");
    expect(mesure).toHaveTextContent("Croisements2");
    const regle = within(f).getByRole("heading", { name: "Règle appliquée" }).closest("section")!;
    expect(regle).toHaveTextContent("RC-2D-0.1, version 0");
    expect(regle).toHaveTextContent("Tolérance de proximité0 m");
    expect(regle).toHaveTextContent("Première analyse : n° 1");
    expect(within(f).getByTestId("mention-vertical")).toHaveTextContent("Vertical non évalué : profondeur et altitude absentes.");
    expect(within(f).getByRole("heading", { name: "Précision et limites" }).closest("section")).toHaveTextContent("Classe de précisionB : plan validé");
    const troncons = within(f).getByRole("heading", { name: /Tronçons proches/ }).closest("section")!;
    expect(troncons).toHaveTextContent("RN1-012 : Kissidougou - Faranah");
    expect(troncons).toHaveTextContent("lecture seule");
  });

  it("sources et versions des jeux : version, role, concessionnaire, empreinte tronquee", async () => {
    const f = await ouvrirFiche();
    const s = within(f).getByRole("heading", { name: /Sources et versions/ }).closest("section")!;
    expect(s).toHaveTextContent("reseau-synthetique.kml · version 2 · Réseau de concessionnaire · Operateur synthetique A");
    expect(s).toHaveTextContent("empreinte SHA-256 : abababababababab…");
    expect(s).toHaveTextContent("axes-synthetiques.geojson · version 1 · Axes de travaux");
  });

  it("classe inconnue : « position indicative, proximite a verifier »", async () => {
    const f = await ouvrirFiche("cf-2");
    expect(within(f).getByText(/Inconnue \(par défaut\) : position indicative, proximité à vérifier/)).toBeInTheDocument();
  });

  it("vertical non precise par le serveur : la mention reste, avec la reserve, sans affirmer", async () => {
    const f = await ouvrirFiche("cf-1", { fiches: { "cf-1": fiche({ verticalEvalue: null }) } });
    expect(within(f).getByTestId("mention-vertical")).toHaveTextContent("le serveur ne précise pas son évaluation");
  });
  it("vertical evalue : le dit", async () => {
    const f = await ouvrirFiche("cf-1", { fiches: { "cf-1": fiche({ verticalEvalue: true }) } });
    expect(within(f).getByTestId("mention-vertical")).toHaveTextContent(/^Évalué$/);
  });

  it("historique chronologique avec acteur humain, « calcul automatique » sans acteur, justification, statuts avant et apres", async () => {
    const f = await ouvrirFiche("cf-1", { fiches: { "cf-1": fiche({ historique: [histo({ id: "h3", action: "ACTION_FUTURE", nouveauStatut: null, createdAt: "2026-11-05T08:00:00Z" }), ...fiche().historique] }) } });
    const sec = within(f).getByRole("heading", { name: /Historique \(3\)/ }).closest("section")!;
    const lignes = within(sec).getAllByRole("listitem");
    expect(lignes[0]).toHaveTextContent("Création par une analyse");
    expect(lignes[0]).toHaveTextContent("calcul automatique, aucun acteur humain");
    expect(lignes[1]).toHaveTextContent("Changement de statut");
    expect(lignes[1]).toHaveTextContent("Moussa Gestionnaire");
    expect(lignes[1]).toHaveTextContent("Justification : Classe B confirmée par le plan validé");
    expect(within(lignes[1]).getByText("À investiguer")).toBeInTheDocument();
    expect(lignes[2]).toHaveTextContent("ACTION_FUTURE (action inconnue de cette version)");
    expect(sec).toHaveTextContent("02/11/2026 08:00 UTC");
  });

  it("preuves (type, reference, auteur) et decisions : couts estime et reel DISTINCTS, « non renseigne » n'est pas zero, derogation visible", async () => {
    const d1 = decision({ id: "d1", coutEstime: 12000, coutReel: null });
    const d2 = decision({ id: "d2", option: "DEPLACER_RESEAU", statut: "APPROUVEE", coutEstime: null, coutReel: 0, approuvePar: { id: "u-adm", nom: "Fatou Admin" }, approuveLe: "2026-11-05T10:00:00Z", motifDecision: "Approuvé en comité", derogationSeparation: "Seul compte habilité", dateDebutPrevue: null, dateFinPrevue: null });
    const f = await ouvrirFiche("cf-1", { fiches: { "cf-1": fiche({ decisions: [d1, d2], preuves: [preuve()] }) } });
    const pr = within(f).getByRole("heading", { name: /Preuves \(1\)/ }).closest("section")!;
    expect(pr).toHaveTextContent("Contact avec le concessionnaire · réf. Courrier 42/2026");
    expect(pr).toHaveTextContent("fourreau à 0,8 m");
    const sec = within(f).getByRole("heading", { name: /Décisions \(2\)/ }).closest("section")!;
    const [a, b] = within(sec).getAllByRole("listitem");
    expect(a).toHaveTextContent("Protéger le réseau en place");
    expect(a).toHaveTextContent("Coût estimé12 000 GNF");
    expect(a).toHaveTextContent("Coût réelnon renseigné");
    expect(a).toHaveTextContent("Début prévu10/01/2027");
    expect(b).toHaveTextContent("Déplacer le réseau (proposition)");
    expect(b).toHaveTextContent("Coût estiménon renseigné");
    expect(b).toHaveTextContent("Coût réel0 GNF");
    expect(b).toHaveTextContent("Décidée parFatou Admin, 05/11/2026 10:00 UTC");
    expect(b).toHaveTextContent("Dérogation à la séparation des tâchesSeul compte habilité");
    expect(sec).toHaveTextContent("Le système n'ordonne et n'exécute rien");
  });

  it("attribution et dossier a reexaminer : motif explique, verdict humain conserve", async () => {
    const f = await ouvrirFiche("cf-4");
    const note = within(f).getByText(/Une nouvelle analyse ne l'a pas retrouvé/);
    expect(note.closest("[role=note]")).toHaveTextContent("verdict humain est conservé");
    const at = within(f).getByRole("heading", { name: "Attribution" }).closest("section")!;
    expect(at).toHaveTextContent("ResponsableAwa Responsable");
    expect(at).toHaveTextContent("Concessionnaireaucun concessionnaire (zone sans jeu réseau)");
  });

  it("geometrie non fournie : la fiche le dit, aucun zoom", async () => {
    const f = await ouvrirFiche("cf-1", { fiches: { "cf-1": fiche({ geom: null }) } });
    expect(within(f).getByText(/La géométrie de ce conflit n'est pas fournie/)).toBeInTheDocument();
    expect(screen.queryByTestId("legende-dossier")).toBeNull();
  });

  it("geometrie masquee par le serveur (jeu de reseau non lisible pour ce compte) : dite, aucun zoom, aucune surbrillance", async () => {
    const f = await ouvrirFiche("cf-1", { fiches: { "cf-1": fiche({ geom: null, geometrieMasquee: true }) } });
    expect(within(f).getByText(/masquée pour votre compte/)).toBeInTheDocument();
    expect(screen.queryByTestId("legende-dossier")).toBeNull();
    expect(bouton("cf-1").closest("li")).not.toHaveTextContent("Géométrie masquée");
  });

  it("liste : un conflit dont la geometrie est masquee le dit", async () => {
    await ouvrirListe({ liste: brut(serveurPage(pageConflits([conflit({ geometrieMasquee: true })]))) });
    expect(bouton("cf-1").closest("li")).toHaveTextContent("Géométrie masquée pour votre compte");
  });

  it("l'ecart d'echeance vient du serveur quand il le dit : echeance passee mais echeanceDepassee faux = pas de badge", async () => {
    await ouvrirListe({ liste: brut(serveurPage(pageConflits([conflit({ echeance: "2020-01-01", echeanceDepassee: false })]))) });
    expect(within(bouton("cf-1").closest("li")!).queryByText("Échéance dépassée")).toBeNull();
  });

  it("fiche en erreur 404 : message explique, retour possible, bandeau conserve", async () => {
    await ouvrirListe({ fiches: { "cf-1": erreurHttp(404, "CONFLIT_INTROUVABLE") } });
    await userEvent.click(bouton("cf-1"));
    const alerte = await screen.findByText(/Dossier de conflit : introuvable/);
    expect(alerte.closest("[role=alert]")).toHaveAttribute("data-etat", "introuvable");
    expect(screen.getByTestId("bandeau-garde-fous")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Retour à la liste/ }));
    expect(await screen.findByRole("list", { name: "Liste des conflits" })).toBeVisible();
  });

  it("fiche : 403 puis 504 expliques", async () => {
    await ouvrirListe({ fiches: { "cf-1": erreurHttp(403) as never, "cf-2": erreurHttp(504) as never } });
    await userEvent.click(bouton("cf-1"));
    expect(await screen.findByText(/clé de module/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Retour à la liste/ }));
    await userEvent.click(bouton("cf-2"));
    expect(await screen.findByText(/délai autorisé \(504\)/)).toBeInTheDocument();
  });

  it("une reponse de fiche illisible LEVE (jamais une fiche vide)", async () => {
    await ouvrirListe();
    h.get.mockImplementation(async (url: string, opts?: { params?: Record<string, unknown> }) => (url === `${BASE}/conflits/cf-1` ? { data: { id: "cf-1", type: "PROXIMITE", statut: "SECRET" } } : reponseApi(url, opts?.params)));
    await userEvent.click(bouton("cf-1"));
    expect(await screen.findByText(/Réponse inattendue du serveur/)).toBeInTheDocument();
  });
});

describe("carte : zoom et surbrillance du conflit ouvert", () => {
  it("ouvrir un conflit zoome sur sa geometrie et la met en evidence (halo + trait sombre), avec une ligne de legende ; retour : plus rien", async () => {
    await ouvrirFiche();
    await screen.findByTestId("carte");
    const traits = () => screen.queryAllByTestId("couche-passive").map((e) => JSON.parse(e.getAttribute("data-style") ?? "{}") as { color?: string; weight?: number });
    await waitFor(() => expect(traits().filter((s) => s.color === "#7f1d1d")).toHaveLength(1));
    expect(traits().filter((s) => s.color === "#ffffff" && s.weight === 16)).toHaveLength(1);
    expect(mapDouble.fitBounds).toHaveBeenLastCalledWith([[S + 0.0002, O - 0.0004], [S + 0.0002, O + 0.0004]], { padding: [48, 48], maxZoom: 19 });
    expect(screen.getByTestId("legende-dossier")).toHaveTextContent("Dossier de conflit ouvert (trait sombre épais cerclé de blanc)");
    await userEvent.click(screen.getByRole("button", { name: /Retour à la liste/ }));
    await waitFor(() => expect(traits().filter((s) => s.color === "#7f1d1d")).toHaveLength(0));
    expect(screen.queryByTestId("legende-dossier")).toBeNull();
  });

  it("changer d'onglet retire la surbrillance ; revenir sur Conflits la remet", async () => {
    await ouvrirFiche();
    await waitFor(() => expect(screen.getByTestId("legende-dossier")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("tab", { name: "Couches" }));
    await waitFor(() => expect(screen.queryByTestId("legende-dossier")).toBeNull());
    await userEvent.click(screen.getByRole("tab", { name: "Conflits" }));
    await waitFor(() => expect(screen.getByTestId("legende-dossier")).toBeInTheDocument());
  });

  it("un point (croisement) est mis en evidence aussi", async () => {
    await ouvrirFiche("cf-2");
    await waitFor(() => expect(mapDouble.fitBounds).toHaveBeenLastCalledWith([[S, O], [S, O]], { padding: [48, 48], maxZoom: 19 }));
  });

  it("la geometrie vient de la FICHE (la liste ne la porte pas) : tant qu'elle charge, rien n'est dessine", async () => {
    await ouvrirFiche("cf-3", { fiches: { "cf-3": ficheDe("cf-3", { geom: { type: "Point", coordinates: [O + 0.001, S + 0.001] } }) } });
    await waitFor(() => expect(mapDouble.fitBounds).toHaveBeenLastCalledWith([[S + 0.001, O + 0.001], [S + 0.001, O + 0.001]], { padding: [48, 48], maxZoom: 19 }));
  });

  it("fiche lente : aucune surbrillance ni zoom avant sa reponse", async () => {
    h.get.mockImplementation(async (url: string, opts?: { params?: Record<string, unknown> }) => {
      if (url === `${BASE}/conflits/cf-1`) return new Promise(() => undefined);
      return reponseApi(url, opts?.params);
    });
    rendrePage();
    await userEvent.click(await screen.findByRole("tab", { name: "Conflits" }));
    await screen.findByRole("list", { name: "Liste des conflits" });
    await userEvent.click(bouton("cf-1"));
    expect(await screen.findByText("Chargement du dossier…")).toBeInTheDocument();
    expect(screen.queryByTestId("legende-dossier")).toBeNull();
    expect(screen.queryAllByTestId("couche-passive").filter((e) => (e.getAttribute("data-style") ?? "").includes("#7f1d1d"))).toHaveLength(0);
  });
});

describe("clavier : parcours de la liste a la fiche et retour", () => {
  it("Tab atteint les compteurs, la recherche, les boutons de dossier ; Entree ouvre ; le titre prend le focus ; Retour rend le focus au dossier", async () => {
    await ouvrirListe();
    const b = bouton("cf-3");
    b.focus();
    await userEvent.keyboard("{Enter}");
    const f = await screen.findByTestId("fiche-conflit");
    await waitFor(() => expect(within(f).getByRole("heading", { level: 3 })).toHaveFocus());
    await userEvent.click(within(f).getByRole("button", { name: /Retour à la liste/ }));
    await waitFor(() => expect(bouton("cf-3")).toHaveFocus());
    expect(bouton("cf-3")).toHaveAttribute("aria-current", "true");
  });

  it("tous les controles de la liste sont des boutons, champs ou liens natifs (aucun role bouton factice, aucun tabindex positif)", async () => {
    await ouvrirListe();
    const panneau = document.getElementById("pv-panneau-conflits")!;
    expect(panneau.querySelectorAll("[tabindex]:not([tabindex='0']):not([tabindex='-1'])")).toHaveLength(0);
    expect(panneau.querySelectorAll("[role=button]")).toHaveLength(0);
  });
});

describe("hors ligne", () => {
  it("hors ligne : les actions d'ecriture sont desactivees, la lecture deja chargee reste", async () => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });
    installer();
    rendrePage();
    await userEvent.click(await screen.findByRole("tab", { name: "Conflits" }));
    expect(screen.getByRole("button", { name: "Lancer une analyse" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Exporter les conflits/ })).toBeDisabled();
  });
});

describe("avertissements du dossier : ceux du serveur, avec repli sur les textes de secours", () => {
  it("la fiche affiche les avertissements ENVOYES par le serveur (et non les textes de secours)", async () => {
    const f = await ouvrirFiche("cf-1", { fiches: { "cf-1": fiche({ avertissements: ["Avertissement propre au serveur n° 1.", "Avertissement propre au serveur n° 2."] }) } });
    const l = within(f).getByTestId("avertissements-dossier");
    expect(l).toHaveAttribute("data-source", "serveur");
    expect([...l.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["Avertissement propre au serveur n° 1.", "Avertissement propre au serveur n° 2."]);
    for (const secours of AVERTISSEMENTS_DE_SECOURS) expect(l).not.toHaveTextContent(secours);
  });
  it("sans `avertissements` dans la reponse : repli sur les textes de secours, dits comme tels dans l'attribut data-source", async () => {
    const f = await ouvrirFiche("cf-1", { fiches: { "cf-1": fiche({ avertissements: null }) } });
    const l = within(f).getByTestId("avertissements-dossier");
    expect(l).toHaveAttribute("data-source", "secours");
    expect([...l.querySelectorAll("li")].map((li) => li.textContent)).toEqual([...AVERTISSEMENTS_DE_SECOURS]);
  });
  it("le bandeau permanent reste le texte du contrat, mot pour mot, quels que soient les avertissements du dossier", async () => {
    await ouvrirFiche("cf-1", { fiches: { "cf-1": fiche({ avertissements: ["Autre texte."] }) } });
    expect(screen.getByTestId("bandeau-garde-fous")).toHaveTextContent(BANDEAU_GARDE_FOUS);
  });
});

describe("champs masques par le serveur pour un lecteur : « masque », jamais une erreur ni un faux « aucun »", () => {
  const listeMasquee = () => ({
    conflits: [{ ...(brut(serveurConflit(conflit())) as Record<string, unknown>), mesure: null, objet: null, concessionnaire: null, typeReseau: null, jeuReseauId: null, bbox: null, geometrieMasquee: true }],
    compteurs: COMPTEURS, total: 1, curseurSuivant: null,
  });

  it("liste : mesure, objet et concessionnaire masques sont dits tels, sans zero ni « aucun concessionnaire »", async () => {
    h.role = "LECTEUR";
    await ouvrirListe({ liste: listeMasquee() });
    const li = bouton("cf-1").closest("li")!;
    expect(li).toHaveTextContent("Mesure masquée pour votre compte");
    expect(li).toHaveTextContent("Objet : masqué pour votre compte");
    expect(li).toHaveTextContent("concessionnaire masqué pour votre compte");
    expect(li).not.toHaveTextContent("aucun concessionnaire");
    expect(li).not.toHaveTextContent("Mesure non fournie");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("fiche : mesure, objet, troncons proches et sources masques sont dits tels, la page ne plante pas", async () => {
    h.role = "LECTEUR";
    const masquee = fiche({
      geom: null, geometrieMasquee: true, objet: null, concessionnaire: null, typeReseau: null, jeuReseauId: null, bbox: null, sources: [], tronconsProches: [], regle: null, largeurs: null,
      mesure: { longueurChausseeM: null, longueurEmpriseM: null, distanceMinM: null, nbCroisements: null, longueurPieceM: null },
    });
    const f = await ouvrirFiche("cf-1", { fiches: { "cf-1": masquee } });
    expect(within(f).getByTestId("mesure-absente")).toHaveTextContent("Mesure masquée pour votre compte.");
    const section = (titre: string | RegExp) => within(f).getByRole("heading", { name: titre }).closest("section")!;
    expect(section("Mesure")).not.toHaveTextContent("non mesurée");
    expect(section(/Sources et versions/)).toHaveTextContent("Sources masquées pour votre compte");
    expect(section(/Tronçons proches/)).toHaveTextContent("masqués pour votre compte");
    expect(section(/Tronçons proches/)).not.toHaveTextContent("Aucun tronçon du référentiel relevé");
    expect(section("Attribution")).toHaveTextContent("concessionnaire masqué pour votre compte");
  });

  it("correctif D7 : la fiche d'un dossier de couverture regroupe donne le nombre de morceaux, leur longueur totale et le detail de chacun", async () => {
    const couv = fiche({
      type: "COUVERTURE_INSUFFISANTE", axe: "Corridor synthetique", objet: null, concessionnaire: null, typeReseau: null, jeuReseauId: null,
      mesure: { longueurChausseeM: 0, longueurEmpriseM: 0, distanceMinM: null, nbCroisements: 0, longueurPieceM: 750,
        morceaux: { nb: 3, longueurTotaleM: 750, detailTronque: true, detail: [
          { objetId: "11", ordre: 0, nom: "Corridor synthetique", longueurM: 250 }, { objetId: "12", ordre: 1, nom: null, longueurM: 250 },
        ] } },
    });
    const f = await ouvrirFiche("cf-1", { fiches: { "cf-1": couv } });
    expect(within(f).getByTestId("morceaux-couverture")).toHaveTextContent("3 morceaux du plan d'axes, 750 m au total");
    const detail = within(f).getByTestId("detail-morceaux");
    expect(within(detail).getAllByRole("listitem")).toHaveLength(2);
    expect(detail).toHaveTextContent("Corridor synthetique (rang 1 du fichier)250 m");
    expect(detail).toHaveTextContent("Morceau sans nom (rang 2 du fichier)250 m");
    expect(within(f).getByText(/Détail limité aux 2 premiers morceaux/)).toBeInTheDocument();
  });

  it("correctif D7 : un dossier sans morceaux (autres types, couverture d'avant le regroupement) n'affiche aucune ligne de morceaux", async () => {
    const f = await ouvrirFiche();
    expect(within(f).queryByTestId("morceaux-couverture")).toBeNull();
    expect(within(f).queryByTestId("detail-morceaux")).toBeNull();
  });

  it("fiche NON masquee : une source ou un troncon absent garde son texte habituel (le serveur n'a rien masque)", async () => {
    const f = await ouvrirFiche("cf-1", { fiches: { "cf-1": fiche({ sources: [], tronconsProches: [] }) } });
    expect(within(f).getByRole("heading", { name: /Sources et versions/ }).closest("section")).toHaveTextContent("Aucune source n'est listée par le serveur");
    expect(within(f).getByRole("heading", { name: /Tronçons proches/ }).closest("section")).toHaveTextContent("Aucun tronçon du référentiel relevé");
  });

  it("un conflit devenu illisible (404 CONFLIT_INTROUVABLE) : message qui dit aussi qu'il n'est peut-etre plus lisible pour le compte", async () => {
    h.role = "LECTEUR";
    await ouvrirListe({ fiches: { "cf-1": erreurHttp(404, "CONFLIT_INTROUVABLE") } });
    await userEvent.click(bouton("cf-1"));
    expect(await screen.findByText(/n'est plus lisible pour votre compte/)).toBeInTheDocument();
  });

  it("liste qui a perdu des conflits (jeu non autorise) : la liste vide est un etat valide, sans erreur", async () => {
    h.role = "LECTEUR";
    await ouvrirOnglet({ liste: { conflits: [], compteurs: { ...COMPTEURS, POTENTIEL: 0, A_INVESTIGUER: 0, CONFIRME: 0 }, total: 0, curseurSuivant: null } });
    expect(await screen.findByText("Aucun dossier de conflit pour ce projet")).toBeInTheDocument();
  });
});

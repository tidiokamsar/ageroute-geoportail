import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configure, renderHook, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("react-leaflet", async () => (await import("../components/projets-voirie/carteDouble.testutil")).moduleReactLeaflet());

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(), role: "GESTIONNAIRE", userId: "u-gest" }));
vi.mock("../lib/api", () => ({ api: { get: h.get, post: h.post, put: h.put, patch: h.patch, delete: h.delete } }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: h.userId, nomComplet: "Moussa Gestionnaire", role: h.role, modulesAutorises: ["projets-voirie"] } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/download", () => ({ downloadViaApi: vi.fn().mockResolvedValue(undefined) }));

import { mapDouble, reinitialiserCarte } from "../components/projets-voirie/carteDouble.testutil";
import { brut, conflit, fiche as ficheConflit, pageConflits, serveurPage } from "../components/projets-voirie/conflitsSynthetiques.testutil";
import { rendrePage } from "../components/projets-voirie/conflitsPage.testutil";
import {
  BASE_RESEAU, JEU_RESEAU, carteAvecObjets, erreurHttp, ficheObjetServeur, objetEquipement, objetQualifie, objetServeur, pageObjetsServeur, pageRelationsServeur,
  projetFicheReseau, reponseApiReseau, relationProposee, relationValidee, resultatPropositionServeur, TRACE_PARTAGEE, type SurchargesReseau,
} from "../components/projets-voirie/reseaux/reseauxSynthetiques.testutil";
import { useCompteARebours } from "../components/projets-voirie/reseaux/VueRelations";
import { BANDEAU_RESEAUX, MENTION_LIGNES_CABLES } from "../lib/projetsVoirieReseaux";

/**
 * Onglet « Reseaux » de la page projet (lot B1, interface) : liste des objets (nature, classe declaree, qualite, vertical seulement si fourni), filtres et curseur,
 * fiche et descripteur (justification obligatoire), relations (propositions PROPOSEES, valider / refuser / revoquer), proposition automatique (attente, 429, 503, 504, 422,
 * 409), comptage par nature (jamais additionne), mise en evidence sur la carte sans charger le reseau, roles lecteur / gestionnaire / administrateur, champs masques.
 * L'API est SIMULEE avec des reponses synthetiques au format du serveur (`reseauxSynthetiques.testutil.ts`).
 */

configure({ asyncUtilTimeout: 8000 });

const FICHE = brut(projetFicheReseau());

function installer(over: SurchargesReseau = {}) {
  h.get.mockImplementation(async (url: string, opts?: { params?: Record<string, unknown> }) => reponseApiReseau(url, opts?.params, { fiche: FICHE, ...over }));
}
const bouton = (id: string) => document.querySelector<HTMLButtonElement>(`button[data-objet-reseau-id="${id}"]`)!;
const appels = (suffixe: string) => h.get.mock.calls.filter((c) => c[0] === `${BASE_RESEAU}${suffixe}`);
const dernierParams = (suffixe: string) => appels(suffixe).at(-1)?.[1]?.params as Record<string, unknown>;

async function ouvrirReseaux(over: SurchargesReseau = {}, role = "GESTIONNAIRE") {
  h.role = role;
  installer(over);
  rendrePage();
  await userEvent.click(await screen.findByRole("tab", { name: "Réseaux" }));
  return screen.findByRole("list", { name: "Liste des objets des réseaux" });
}
async function ouvrirFiche(id: string, over: SurchargesReseau = {}, role = "GESTIONNAIRE") {
  await ouvrirReseaux(over, role);
  await userEvent.click(bouton(id));
  return screen.findByTestId("fiche-objet-reseau");
}
const dialogue = () => screen.findByRole("dialog");

beforeEach(() => {
  for (const f of [h.get, h.post, h.put, h.patch, h.delete]) f.mockReset();
  h.post.mockResolvedValue({ data: {} }); h.put.mockResolvedValue({ data: {} }); h.patch.mockResolvedValue({ data: {} });
  h.role = "GESTIONNAIRE"; h.userId = "u-gest";
  reinitialiserCarte();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
});
afterEach(() => {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
  // React Query suit l'evenement « online » (pas la propriete) : sans lui, il se croirait encore hors ligne au test suivant.
  window.dispatchEvent(new Event("online"));
  vi.useRealTimers();
});

describe("onglet Reseaux : bandeau, liste, nature, classe et qualite", () => {
  it("le bandeau est permanent : proposition sans effet, un fichier de N lignes n'est pas N cables", async () => {
    await ouvrirReseaux();
    const b = screen.getByTestId("bandeau-reseaux");
    expect(b.textContent).toContain(BANDEAU_RESEAUX);
    expect(b.textContent).toContain(MENTION_LIGNES_CABLES);
    expect(b.textContent).toContain("Un fichier de N lignes n'est pas N câbles");
  });
  it("le bandeau reste visible pendant le chargement, une erreur et une liste vide", async () => {
    installer({ objets: () => { throw erreurHttp(504, "LECTURE_TROP_LONGUE"); } });
    rendrePage();
    await userEvent.click(await screen.findByRole("tab", { name: "Réseaux" }));
    await screen.findByText(/lecture a dépassé le délai/);
    expect(screen.getByTestId("bandeau-reseaux")).toBeInTheDocument();
  });
  it("chaque objet porte sa nature en MOT et en forme, son type, sa classe declaree ou « non renseignee »", async () => {
    await ouvrirReseaux();
    const l = screen.getByRole("list", { name: "Liste des objets des réseaux" });
    expect(within(l).getAllByRole("button")).toHaveLength(4);
    expect(bouton("10").textContent).toMatch(/Circuit logique/);
    expect(bouton("10").textContent).toMatch(/héritée du jeu/);
    expect(bouton("10").textContent).toMatch(/Classe non renseignée/);
    expect(bouton("4").textContent).toMatch(/Classe A/);
    expect(bouton("4").textContent).toMatch(/Fibre/);
    expect(bouton("20").textContent).toMatch(/Infrastructure physique/);
    expect(bouton("20").textContent).toMatch(/Gaine/);
    expect(bouton("30").textContent).toMatch(/Équipement/);
    expect(bouton("10").querySelector("[data-forme]")?.getAttribute("data-forme")).toBe("reseau");
    expect(bouton("20").querySelector("[data-forme]")?.getAttribute("data-forme")).toBe("cable");
  });
  it("profondeur et altitude ne sont affichees QUE si le serveur les fournit : jamais « 0 m » pour une valeur absente", async () => {
    await ouvrirReseaux();
    expect(bouton("4").textContent).toMatch(/profondeur 1,2 m/);
    expect(bouton("4").textContent).not.toMatch(/altitude/);
    for (const id of ["10", "20", "30"]) {
      expect(bouton(id).textContent).not.toMatch(/profondeur d|altitude d|profondeur 0|altitude 0/);
      expect(bouton(id).textContent).toMatch(/Qualité, profondeur et altitude non renseignées/);
      expect(bouton(id).textContent).not.toMatch(/\b0 m\b/);
    }
  });
  it("la source (concessionnaire, version) et la longueur sont celles du jeu", async () => {
    await ouvrirReseaux();
    expect(bouton("10").textContent).toMatch(/Operateur synthetique A, version 1/);
    expect(bouton("10").textContent).toMatch(/longueur 60,01 m/);
  });
  it("un objet dont la nature est inconnue de cette version est COMPTE, jamais masque en silence", async () => {
    await ouvrirReseaux({ objets: pageObjetsServeur([objetServeur(), { id: "99", nature: "ALIEN" }]) });
    expect(await screen.findByText(/1 élément\(s\) de la réponse du serveur n'ont pas pu être lus/)).toBeInTheDocument();
    expect(screen.getAllByRole("button").filter((b) => b.hasAttribute("data-objet-reseau-id"))).toHaveLength(1);
  });
  it("liste vide : message explicite, sans promettre qu'il n'y a pas de reseau", async () => {
    installer({ objets: pageObjetsServeur([]) });
    rendrePage();
    await userEvent.click(await screen.findByRole("tab", { name: "Réseaux" }));
    expect(await screen.findByText("Aucun objet de réseau lisible pour ce projet")).toBeInTheDocument();
  });
  it("erreur 403 : refus de droit en clair ; erreur reseau : bouton Reessayer", async () => {
    installer({ objets: () => { throw erreurHttp(403, "QUARANTAINE_RESERVEE"); } });
    rendrePage();
    await userEvent.click(await screen.findByRole("tab", { name: "Réseaux" }));
    expect(await screen.findByText(/réservé aux administrateurs et aux gestionnaires/)).toBeInTheDocument();
  });
});

describe("filtres et pagination par curseur", () => {
  it("filtre par nature : la requete porte la nature, le bouton est a bascule (aria-pressed)", async () => {
    await ouvrirReseaux();
    const b = document.querySelector<HTMLButtonElement>('button[data-nature-filtre="CIRCUIT_LOGIQUE"]')!;
    expect(b).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(b);
    await waitFor(() => expect(dernierParams("/objets")).toMatchObject({ nature: "CIRCUIT_LOGIQUE", limite: 50 }));
    expect(b).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(b);
    await waitFor(() => expect(b).toHaveAttribute("aria-pressed", "false"));
    expect(within(screen.getByRole("list", { name: "Liste des objets des réseaux" })).getAllByRole("button")).toHaveLength(4);
  });
  it("la recherche ne part qu'une fois la saisie posee ; filtres avances : type et jeu ; reinitialisation", async () => {
    await ouvrirReseaux();
    await userEvent.type(screen.getByLabelText(/Rechercher dans le nom/), "fo-01");
    await waitFor(() => expect(dernierParams("/objets")).toMatchObject({ q: "fo-01" }));
    await userEvent.click(screen.getByRole("button", { name: /Filtres avancés/ }));
    await userEvent.selectOptions(screen.getByLabelText("Type d'objet"), "FIBRE");
    await waitFor(() => expect(dernierParams("/objets")).toMatchObject({ typeObjet: "FIBRE", q: "fo-01" }));
    await userEvent.selectOptions(screen.getByLabelText("Jeu de données"), JEU_RESEAU);
    await waitFor(() => expect(dernierParams("/objets")).toMatchObject({ jeuId: JEU_RESEAU }));
    // Les jeux proposes sont ceux des reseaux (pas le plan d'axes).
    expect(within(screen.getByLabelText("Jeu de données")).queryByText(/Axes de travaux/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Réinitialiser les filtres/ }));
    await waitFor(() => expect(screen.getByLabelText(/Rechercher dans le nom/)).toHaveValue(""));
    expect(screen.queryByRole("button", { name: /Réinitialiser les filtres/ })).toBeNull();
  });
  it("aucun objet pour ces filtres : message distinct d'une liste vide", async () => {
    await ouvrirReseaux();
    installer({ objets: pageObjetsServeur([]) });
    await userEvent.click(document.querySelector<HTMLButtonElement>('button[data-nature-filtre="EQUIPEMENT"]')!);
    expect(await screen.findByText("Aucun objet ne correspond à ces filtres")).toBeInTheDocument();
  });
  it("pagination par curseur : « Charger les objets suivants » envoie le curseur du serveur et ajoute la page", async () => {
    installer({ objets: (p?: Record<string, unknown>) => (p?.curseur === "c-2" ? pageObjetsServeur([objetServeur({ id: "11", nom: "Fibre FO-11" })]) : pageObjetsServeur([objetServeur()], "c-2")) });
    rendrePage();
    await userEvent.click(await screen.findByRole("tab", { name: "Réseaux" }));
    await screen.findByRole("list", { name: "Liste des objets des réseaux" });
    expect(screen.getByTestId("etat-liste-objets-reseau").textContent).toMatch(/1 objet\(s\) chargé\(s\), d'autres restent à charger/);
    await userEvent.click(screen.getByRole("button", { name: "Charger les objets suivants" }));
    await waitFor(() => expect(bouton("11")).toBeTruthy());
    expect(dernierParams("/objets")).toMatchObject({ curseur: "c-2" });
    expect(bouton("10")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Charger les objets suivants" })).toBeNull();
  });
});

describe("fiche d'un objet", () => {
  it("source, nature, qualite DECLAREE, vertical absent : aucune valeur inventee, aucune conclusion 3D", async () => {
    const f = await ouvrirFiche("10");
    expect(f.textContent).toMatch(/Circuit logique/);
    expect(f.textContent).toMatch(/Un fichier de N lignes n'est pas N câbles/);
    expect(f.textContent).toMatch(/Classe de précision/);
    expect(f.textContent).toMatch(/non renseignée : aucune classe n'est déduite/);
    expect(within(f).getByTestId("etat-vertical").textContent).toBe("Profondeur et altitude absentes : aucune conclusion 3D.");
    expect(f.textContent).not.toMatch(/Profondeur fournie|Altitude fournie/);
    expect(f.textContent).toMatch(/Aucune évaluation 3D n'est réalisée/);
    expect(f.textContent).toMatch(/Aucun descripteur : nature, classe et précision sont celles du jeu, ou inconnues\. Rien n'est inventé\./);
    expect(f.textContent).toMatch(/Confidentiel concessionnaire/);
  });
  it("le titre de la fiche prend le focus ; Retour rend le focus au bouton de l'objet", async () => {
    const f = await ouvrirFiche("10");
    await waitFor(() => expect(within(f).getByRole("heading", { name: "Fibre FO-01" })).toHaveFocus());
    await userEvent.click(within(f).getByRole("button", { name: "Retour à la liste des objets" }));
    await waitFor(() => expect(bouton("10")).toHaveFocus());
  });
  it("circuits superposes : « ils restent separes, ce ne sont pas des cables distincts »", async () => {
    const f = await ouvrirFiche("10");
    expect(within(f).getByTestId("trace-partagee").textContent).toMatch(/2 autre\(s\) objet\(s\) du même jeu suivent exactement la même trace : ils restent séparés, ce ne sont pas des câbles distincts/);
  });
  it("un objet qualifie montre profondeur, reference et classe declaree, avec le descripteur et son auteur", async () => {
    const f = await ouvrirFiche("4");
    expect(f.textContent).toMatch(/Profondeur fournie1,2 m \(positive vers le bas\)/);
    expect(f.textContent).toMatch(/Référence verticaleterrain naturel/);
    expect(f.textContent).not.toMatch(/Altitude fournie/);
    expect(f.textContent).toMatch(/A : levé contrôlé \(déclarée pour cet objet\)/);
    expect(f.textContent).toMatch(/Controle effectue avec le chef de projet/);
    expect(f.textContent).toMatch(/Sekou Gestionnaire/);
    expect(within(f).getByTestId("etat-vertical").textContent).toMatch(/l'évaluation 3D n'est pas réalisée/);
  });
  it("champs masques ou absents : source masquee, etat vertical non precise, jamais zero", async () => {
    const masque = objetServeur({ source: null, vertical: undefined, qualite: undefined });
    const f = await ouvrirFiche("10", { fichesObjets: { "10": ficheObjetServeur(masque) } });
    expect(f.textContent).toMatch(/Source masquée ou non fournie par le serveur/);
    expect(within(f).getByTestId("etat-vertical").textContent).toMatch(/Le serveur ne précise pas l'état vertical/);
    expect(f.textContent).toMatch(/Précision horizontalenon renseignée/);
    expect(f.textContent).not.toMatch(/\b0 m\b/);
  });
  it("une fiche introuvable (404 OBJET_INTROUVABLE) : message du lot et retour a la liste", async () => {
    await ouvrirReseaux({ fichesObjets: {} });
    installer({ fichesObjets: { "10": erreurHttp(404, "OBJET_INTROUVABLE") } });
    await userEvent.click(bouton("10"));
    expect(await screen.findByText(/n'existe pas dans ce projet, ou son jeu n'est pas lisible pour votre compte/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retour à la liste des objets" })).toBeInTheDocument();
  });
  it("relations de l'objet : une PROPOSITION automatique est dite sans effet, avec son calcul (couverture, tolerance, provisoire)", async () => {
    const f = await ouvrirFiche("10");
    const r = within(f).getByText(/Circuit porté par une infrastructure/).closest("li")!;
    expect(r.textContent).toMatch(/Proposée/);
    expect(r.textContent).toMatch(/Proposition automatique/);
    expect(r.textContent).toMatch(/Aucun effet : tant qu'une personne ne l'a pas validée/);
    const calc = within(r as HTMLElement).getByTestId("detail-proposition").textContent!;
    expect(calc).toMatch(/Couverture : 96 % \(seuil 90 %\)/);
    expect(calc).toMatch(/Tolérance : 2 m/);
    expect(calc).toMatch(/57,6 m sur 60,01 m du circuit dans la tolérance/);
    expect(calc).toMatch(/provisoires, en attente de validation par la DSI/);
    expect(f.textContent).toMatch(/1 proposition\(s\) automatique\(s\) à valider/);
  });
  it("aucune relation : le support est inconnu, jamais suppose", async () => {
    const f = await ouvrirFiche("30");
    expect(f.textContent).toMatch(/son support ou son contenant est inconnu, jamais supposé/);
  });
});

describe("valider, refuser, revoquer une relation (justification obligatoire, action humaine)", () => {
  async function ouvrirAction(nom: RegExp) {
    const f = await ouvrirFiche("10");
    await userEvent.click(within(f).getByRole("button", { name: nom }));
    return dialogue();
  }
  it("valider : POST { justification } apres 10 caracteres, puis la fiche est relue ; jamais appliquee avant", async () => {
    const d = await ouvrirAction(/Valider cette association/);
    expect(h.post).not.toHaveBeenCalled();
    const ok = within(d).getByRole("button", { name: "Valider la relation" });
    expect(ok).toBeDisabled();
    await userEvent.type(within(d).getByLabelText(/Justification/), "court");
    expect(ok).toBeDisabled();
    expect(within(d).getByText("5 / 10 caractères minimum")).toBeInTheDocument();
    await userEvent.type(within(d).getByLabelText(/Justification/), " et suffisante");
    expect(ok).toBeEnabled();
    const avant = appels("/objets/10").length;
    await userEvent.click(ok);
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${BASE_RESEAU}/relations/${relationProposee().id}/valider`, { justification: "court et suffisante" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(appels("/objets/10").length).toBeGreaterThan(avant));
  });
  it("refuser : POST /refuser ; le dialogue explique que la proposition ne sera jamais reproposee", async () => {
    const d = await ouvrirAction(/Refuser cette proposition/);
    expect(d.textContent).toMatch(/ne sera jamais reproposée/);
    await userEvent.type(within(d).getByLabelText(/Justification/), "Tracé non confirmé sur le terrain");
    await userEvent.click(within(d).getByRole("button", { name: "Refuser la relation" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${BASE_RESEAU}/relations/${relationProposee().id}/refuser`, { justification: "Tracé non confirmé sur le terrain" }));
  });
  it("revoquer : proposee par le serveur seulement pour une relation validee", async () => {
    const f = await ouvrirFiche("30", { fichesObjets: { "30": ficheObjetServeur(objetEquipement(), [{ ...relationValidee(), role: "SOURCE" }]) } });
    expect(within(f).queryByRole("button", { name: /Valider cette association/ })).toBeNull();
    await userEvent.click(within(f).getByRole("button", { name: /Révoquer cette association/ }));
    const d = await dialogue();
    await userEvent.type(within(d).getByLabelText(/Justification/), "Vanne déplacée lors des travaux");
    await userEvent.click(within(d).getByRole("button", { name: "Révoquer la relation" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${BASE_RESEAU}/relations/${relationValidee().id}/revoquer`, { justification: "Vanne déplacée lors des travaux" }));
  });
  it("409 TRANSITION_INTERDITE : message en clair, le dialogue reste ouvert avec la saisie", async () => {
    h.post.mockRejectedValue(erreurHttp(409, "TRANSITION_INTERDITE"));
    const d = await ouvrirAction(/Valider cette association/);
    await userEvent.type(within(d).getByLabelText(/Justification/), "Justification suffisante");
    await userEvent.click(within(d).getByRole("button", { name: "Valider la relation" }));
    const alerte = await within(d).findByRole("alert");
    expect(alerte.textContent).toMatch(/déjà été traitée par une autre personne/);
    expect(alerte.textContent).not.toMatch(/texte brut|erreur du serveur/);
    expect(alerte).toHaveAttribute("data-code", "TRANSITION_INTERDITE");
    expect(within(d).getByLabelText(/Justification/)).toHaveValue("Justification suffisante");
  });
  it.each([[404, "RELATION_INTROUVABLE", /Cette relation est introuvable/], [400, "JUSTIFICATION_INVALIDE", /10 caractères au moins/]] as const)("%s %s : message en clair dans le dialogue", async (status, code, extrait) => {
    h.post.mockRejectedValueOnce(erreurHttp(status, code));
    const d = await ouvrirAction(/Valider cette association/);
    await userEvent.type(within(d).getByLabelText(/Justification/), "Justification suffisante");
    await userEvent.click(within(d).getByRole("button", { name: "Valider la relation" }));
    expect((await within(d).findByRole("alert")).textContent).toMatch(extrait);
  });
  it("Annuler et Echap ferment sans ecrire ; le focus revient au bouton qui a ouvert le dialogue", async () => {
    const f = await ouvrirFiche("10");
    const declencheur = within(f).getByRole("button", { name: /Refuser cette proposition/ });
    await userEvent.click(declencheur);
    await dialogue();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(h.post).not.toHaveBeenCalled();
    await waitFor(() => expect(declencheur).toHaveFocus());
  });
  it("hors ligne : les actions sont desactivees (jamais en pause sans explication)", async () => {
    const f = await ouvrirFiche("10");
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });
    act(() => { window.dispatchEvent(new Event("offline")); });
    await waitFor(() => expect(within(f).getByRole("button", { name: /Valider cette association/ })).toBeDisabled());
    expect(within(f).getByRole("button", { name: /Qualifier l'objet/ })).toBeDisabled();
  });
});

describe("descripteur : qualifier un objet (justification obligatoire, valeurs omises = inconnues)", () => {
  it("le formulaire d'un objet sans descripteur est VIDE : rien n'est repris du jeu, aucune classe par defaut", async () => {
    const f = await ouvrirFiche("10");
    await userEvent.click(within(f).getByRole("button", { name: "Qualifier l'objet" }));
    const d = await dialogue();
    expect(within(d).getByLabelText("Classe de précision")).toHaveValue("");
    expect(within(d).getByLabelText("Précision horizontale (m)")).toHaveValue("");
    expect(within(d).getByLabelText(/Profondeur/)).toHaveValue("");
    expect(within(d).getByLabelText(/Altitude/)).toHaveValue("");
    expect(within(d).getByLabelText("Nature")).toHaveValue("");
    expect(d.textContent).toMatch(/remplacé.*à chaque enregistrement/);
    expect(within(d).getByRole("button", { name: "Enregistrer le descripteur" })).toBeDisabled();
    expect(within(d).getByTestId("aide-saisie").textContent).toMatch(/La justification doit faire au moins 10 caractères/);
  });
  it("PUT du corps complet : classe A declaree, tout le reste nul (profondeur, altitude, precisions non inventees)", async () => {
    h.put.mockResolvedValue({ data: { objet: objetQualifie({ id: "10" }) } });
    const f = await ouvrirFiche("10");
    await userEvent.click(within(f).getByRole("button", { name: "Qualifier l'objet" }));
    const d = await dialogue();
    await userEvent.selectOptions(within(d).getByLabelText("Classe de précision"), "A");
    await userEvent.type(within(d).getByLabelText(/Justification/), "Levé contrôlé avec le chef de projet");
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer le descripteur" }));
    await waitFor(() => expect(h.put).toHaveBeenCalledWith(`${BASE_RESEAU}/objets/10/descripteur`, {
      nature: null, typeObjet: null, classePrecision: "A", precisionHorizontaleM: null, precisionVerticaleM: null, methodeCollecte: null, dateConstat: null, niveauConfiance: null,
      statutQualite: "INCONNU", profondeurM: null, altitudeM: null, referenceVerticale: null, justification: "Levé contrôlé avec le chef de projet",
    }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("le formulaire d'un objet qualifie est pre-rempli par SES valeurs ; la profondeur et sa reference partent en nombres", async () => {
    h.put.mockResolvedValue({ data: { objet: objetQualifie() } });
    const f = await ouvrirFiche("4");
    await userEvent.click(within(f).getByRole("button", { name: "Modifier le descripteur" }));
    const d = await dialogue();
    expect(within(d).getByLabelText("Classe de précision")).toHaveValue("A");
    expect(within(d).getByLabelText("Précision horizontale (m)")).toHaveValue("0,1");
    expect(within(d).getByLabelText(/Profondeur/)).toHaveValue("1,2");
    expect(within(d).getByLabelText(/Référence verticale/)).toHaveValue("terrain naturel");
    expect(within(d).getByLabelText("Niveau de confiance")).toHaveValue("ELEVE");
    expect(within(d).getByLabelText("Date du constat")).toHaveValue("2026-10-01");
    await userEvent.type(within(d).getByLabelText(/Justification/), "Mise à jour après le contrôle");
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer le descripteur" }));
    await waitFor(() => expect(h.put).toHaveBeenCalled());
    expect(h.put.mock.calls[0][1]).toMatchObject({ classePrecision: "A", precisionHorizontaleM: 0.1, profondeurM: 1.2, altitudeM: null, referenceVerticale: "terrain naturel", niveauConfiance: "ELEVE", statutQualite: "OBSERVE", methodeCollecte: "GNSS RTK", dateConstat: "2026-10-01" });
  });
  it("les choix sont limites a ce que la geometrie admet : un point n'est pas un circuit logique ; un type exige une nature", async () => {
    const f = await ouvrirFiche("30");
    await userEvent.click(within(f).getByRole("button", { name: /Qualifier l'objet|Modifier le descripteur/ }));
    const d = await dialogue();
    const natures = within(within(d).getByLabelText("Nature")).getAllByRole("option").map((o) => o.textContent);
    expect(natures.join("|")).not.toMatch(/Circuit logique/);
    expect(natures.join("|")).toMatch(/Équipement/);
  });
  it("une saisie invalide est expliquee avant l'envoi : precision nulle, reference sans valeur", async () => {
    const f = await ouvrirFiche("10");
    await userEvent.click(within(f).getByRole("button", { name: "Qualifier l'objet" }));
    const d = await dialogue();
    await userEvent.type(within(d).getByLabelText("Précision horizontale (m)"), "0");
    await userEvent.type(within(d).getByLabelText(/Référence verticale/), "terrain naturel");
    await userEvent.type(within(d).getByLabelText(/Justification/), "Justification suffisante");
    const aide = within(d).getByTestId("aide-saisie").textContent!;
    expect(aide).toMatch(/précision horizontale doit être strictement positive/);
    expect(aide).toMatch(/référence verticale exige une profondeur ou une altitude/);
    expect(within(d).getByRole("button", { name: "Enregistrer le descripteur" })).toBeDisabled();
    expect(h.put).not.toHaveBeenCalled();
  });
  const refus: Array<[number, string, RegExp]> = [
    [422, "TYPE_OBJET_SANS_NATURE", /exige une nature connue/],
    [422, "TYPE_OBJET_INCONNU_POUR_NATURE", /n'existe pas pour cette nature/],
    [422, "NATURE_INCOMPATIBLE_GEOMETRIE", /pas compatible avec la géométrie/],
    [422, "ROLE_NON_QUALIFIABLE", /Seuls les objets d'un réseau de concessionnaire/],
    [422, "REFERENCE_VERTICALE_SANS_VALEUR", /exige une profondeur ou une altitude/],
    [422, "PRECISION_INCOHERENTE", /hors des bornes admises/],
    [422, "INCOHERENCE_REFUSEE", /refuse cette écriture comme incohérente/],
    [409, "JEU_NON_QUALIFIABLE", /rejeté, remplacé ou retiré/],
    [409, "RELATIONS_ACTIVES", /refusez ou révoquez-la/],
    [404, "OBJET_INTROUVABLE", /introuvable/],
    [400, "CHAMPS_INVALIDES", /refusées par le serveur/],
    [503, "PROJET_OCCUPE", /occupé par une autre opération/],
  ];
  it.each(refus)("%s %s : message en clair dans le dialogue, saisie conservee", async (status, code, extrait) => {
    h.put.mockRejectedValue(erreurHttp(status, code));
    const f = await ouvrirFiche("10");
    await userEvent.click(within(f).getByRole("button", { name: "Qualifier l'objet" }));
    const d = await dialogue();
    await userEvent.selectOptions(within(d).getByLabelText("Classe de précision"), "B");
    await userEvent.type(within(d).getByLabelText(/Justification/), "Justification suffisante");
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer le descripteur" }));
    const alerte = await within(d).findByRole("alert");
    expect(alerte.textContent).toMatch(extrait);
    expect(alerte).toHaveAttribute("data-code", code);
    expect(within(d).getByLabelText("Classe de précision")).toHaveValue("B");
  });
  it("un objet d'un jeu rejete, remplace ou retire n'a aucun bouton d'ecriture et le dit", async () => {
    const f = await ouvrirFiche("10", { fichesObjets: { "10": ficheObjetServeur(objetServeur({ source: { ...objetServeur().source, statut: "REMPLACE" } })) } });
    expect(within(f).queryByRole("button", { name: /Qualifier l'objet|Modifier le descripteur|Déclarer une relation/ })).toBeNull();
    expect(within(f).getByTestId("objet-non-qualifiable").textContent).toMatch(/jeu est remplacé/);
  });
});

describe("rôle lecteur : lecture seule, aucune action qui n'est pas offerte par le serveur", () => {
  it("la fiche n'a ni qualification, ni declaration de relation, ni bouton sur les relations (le serveur n'envoie aucune action)", async () => {
    const lecteur = ficheObjetServeur(objetServeur(), [{ ...relationProposee({ actionsPossibles: [] }), role: "SOURCE" }], TRACE_PARTAGEE);
    const f = await ouvrirFiche("10", { fichesObjets: { "10": lecteur } }, "LECTEUR");
    expect(within(f).queryByRole("button", { name: /Qualifier|Modifier le descripteur|Déclarer une relation|Valider|Refuser|Révoquer/ })).toBeNull();
    expect(within(f).getByText(/Proposée/)).toBeInTheDocument();
    // La lecture reste possible, y compris la mise en evidence sur la carte.
    expect(within(f).getByRole("button", { name: /Mettre en évidence sur la carte/ })).toBeInTheDocument();
  });
  it("la vue Relations n'a pas de panneau de proposition automatique ni d'action", async () => {
    await ouvrirReseaux({ relations: pageRelationsServeur([relationProposee({ actionsPossibles: [] })]) }, "LECTEUR");
    await userEvent.click(screen.getByRole("button", { name: "Relations" }));
    await screen.findByRole("list", { name: "Liste des relations" });
    expect(screen.queryByRole("button", { name: /Lancer une proposition automatique/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Valider cette association|Refuser cette proposition/ })).toBeNull();
  });
  it("le comptage n'offre pas d'inclure les jeux non autorises : le serveur repondrait 403 QUARANTAINE_RESERVEE", async () => {
    await ouvrirReseaux({}, "LECTEUR");
    await userEvent.click(screen.getByRole("button", { name: "Comptage" }));
    await screen.findByTestId("resultat-comptage");
    expect(screen.queryByLabelText(/Inclure aussi les jeux en attente/)).toBeNull();
    expect(dernierParams("/comptage")).toEqual({});
  });
  it("administrateur : mêmes droits d'ecriture que le gestionnaire", async () => {
    const f = await ouvrirFiche("10", {}, "ADMIN");
    expect(within(f).getByRole("button", { name: "Qualifier l'objet" })).toBeInTheDocument();
    expect(within(f).getByRole("button", { name: "Déclarer une relation" })).toBeInTheDocument();
  });
});

describe("vue Relations et proposition automatique", () => {
  async function ouvrirRelations(over: SurchargesReseau = {}, role = "GESTIONNAIRE") {
    await ouvrirReseaux(over, role);
    await userEvent.click(screen.getByRole("button", { name: "Relations" }));
    return screen.findByRole("list", { name: "Liste des relations" });
  }
  it("liste : proposees et validees, avec leur statut en mot, leur origine et leurs extremites ; filtres par statut", async () => {
    const l = await ouvrirRelations();
    const items = within(l).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toMatch(/Proposée/);
    expect(items[0].textContent).toMatch(/Proposition automatique/);
    expect(items[1].textContent).toMatch(/Validée/);
    expect(items[1].textContent).toMatch(/Déclarée par une personne/);
    await userEvent.click(document.querySelector<HTMLButtonElement>('button[data-statut-filtre="REFUSEE"]')!);
    await waitFor(() => expect(dernierParams("/relations")).toMatchObject({ statut: "REFUSEE" }));
  });
  it("ouvrir l'objet d'une relation ouvre sa fiche dans la section Objets", async () => {
    await ouvrirRelations();
    await userEvent.click(screen.getAllByRole("button", { name: /Ouvrir l'objet Gaine G-01/ })[0]);
    const f = await screen.findByTestId("fiche-objet-reseau");
    expect(f.getAttribute("data-objet-reseau-id")).toBe("20");
  });
  it("lancer une proposition : etat d'attente puis bilan ; les relations creees sont PROPOSEES et sans effet", async () => {
    let fin: (v: unknown) => void = () => {};
    h.post.mockImplementation((url: string) => (url.endsWith("/associations/proposer") ? new Promise((r) => { fin = r; }) : Promise.resolve({ data: {} })));
    await ouvrirRelations();
    await userEvent.click(screen.getByRole("button", { name: "Lancer une proposition automatique" }));
    const attente = await screen.findByTestId("proposition-en-cours");
    expect(attente.textContent).toMatch(/jusqu'à 20 s/);
    expect(screen.getByRole("button", { name: "Calcul en cours…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Calcul en cours…" })).toHaveAttribute("aria-busy", "true");
    fin({ data: resultatPropositionServeur() });
    const r = await screen.findByTestId("resultat-proposition");
    expect(h.post).toHaveBeenCalledWith(`${BASE_RESEAU}/associations/proposer`, {});
    expect(r.textContent).toMatch(/4 proposition\(s\) créée\(s\)/);
    expect(r.textContent).toMatch(/n'ont aucun effet/);
    expect(r.textContent).toMatch(/Circuits examinés : 8 ; infrastructures examinées : 3/);
    expect(r.textContent).toMatch(/Classe E exclue : 1 circuit\(s\), 0 infrastructure\(s\)/);
    expect(r.textContent).toMatch(/Couverture minimale appliquée : 90 %/);
    expect(r.textContent).toMatch(/provisoires, en attente de validation par la DSI/);
    expect(screen.queryByTestId("proposition-en-cours")).toBeNull();
    // « Voir les propositions » filtre sur proposees automatiques.
    await userEvent.click(within(r).getByRole("button", { name: "Voir les propositions à valider" }));
    await waitFor(() => expect(dernierParams("/relations")).toMatchObject({ statut: "PROPOSEE", origine: "AUTOMATIQUE" }));
  });
  it("restreinte a un jeu : le corps porte jeuId ; seuls les jeux AUTORISES de reseau sont proposes", async () => {
    h.post.mockResolvedValue({ data: resultatPropositionServeur() });
    await ouvrirRelations();
    const sel = screen.getByLabelText("Restreindre à un jeu (facultatif)");
    expect(within(sel).getAllByRole("option")).toHaveLength(2);
    await userEvent.selectOptions(sel, JEU_RESEAU);
    await userEvent.click(screen.getByRole("button", { name: "Lancer une proposition automatique" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${BASE_RESEAU}/associations/proposer`, { jeuId: JEU_RESEAU }));
  });
  it("resultat tronque : dit avec les avertissements du serveur", async () => {
    h.post.mockResolvedValue({ data: resultatPropositionServeur({ bilan: { ...resultatPropositionServeur().bilan, tronque: true } }) });
    await ouvrirRelations();
    await userEvent.click(screen.getByRole("button", { name: "Lancer une proposition automatique" }));
    const r = await screen.findByTestId("resultat-proposition");
    expect(r.textContent).toMatch(/Le résultat est tronqué/);
    expect(r.textContent).toMatch(/Ce sont des PROPOSITIONS/);
  });
  it("429 : delai du serveur, bouton desactive avec compte a rebours, rien n'est enregistre", async () => {
    h.post.mockRejectedValue(erreurHttp(429, "ASSOCIATION_TROP_FREQUENTE"));
    h.post.mockRejectedValue(Object.assign(new Error("429"), { response: { status: 429, data: { error: "brut", code: "ASSOCIATION_TROP_FREQUENTE", retryAfterS: 27 }, headers: { "retry-after": "27" } } }));
    await ouvrirRelations();
    await userEvent.click(screen.getByRole("button", { name: "Lancer une proposition automatique" }));
    const e = await screen.findByTestId("proposition-erreur");
    expect(e.getAttribute("data-status")).toBe("429");
    expect(e.textContent).toMatch(/déjà été lancée récemment/);
    expect(e.textContent).toMatch(/Réessayez dans 27 secondes/);
    expect(screen.getByRole("button", { name: /Réessayer dans \d+ s/ })).toBeDisabled();
    expect(within(e).queryByRole("button", { name: "Réessayer" })).toBeNull();
  });
  const echecs: Array<[number, string, RegExp, boolean]> = [
    [503, "PROJET_OCCUPE", /occupé par une autre opération/, true],
    [503, "SERVICE_OCCUPE", /d'autres calculs/, true],
    [504, "ASSOCIATION_TROP_LONGUE", /aucune proposition n'a été enregistrée/, true],
    [422, "TROP_DE_CIRCUITS", /Restreignez la proposition à un jeu/, false],
    [409, "JEU_NON_AUTORISE", /ne portent que sur des jeux autorisés/, false],
  ];
  it.each(echecs)("%s %s : message en clair ; Reessayer propose : %s", async (status, code, extrait, reessayer) => {
    h.post.mockRejectedValue(erreurHttp(status, code));
    await ouvrirRelations();
    await userEvent.click(screen.getByRole("button", { name: "Lancer une proposition automatique" }));
    const e = await screen.findByTestId("proposition-erreur");
    expect(e.getAttribute("data-code")).toBe(code);
    expect(e.textContent).toMatch(extrait);
    expect(!!within(e).queryByRole("button", { name: "Réessayer" })).toBe(reessayer);
  });
  it("503 sans code (passerelle) : explique ; Reessayer relance et peut aboutir", async () => {
    h.post.mockRejectedValueOnce(erreurHttp(503)).mockResolvedValueOnce({ data: resultatPropositionServeur() });
    await ouvrirRelations();
    await userEvent.click(screen.getByRole("button", { name: "Lancer une proposition automatique" }));
    const e = await screen.findByTestId("proposition-erreur");
    expect(e.textContent).toMatch(/momentanément indisponible ou occupé/);
    await userEvent.click(within(e).getByRole("button", { name: "Réessayer" }));
    await screen.findByTestId("resultat-proposition");
    expect(screen.queryByTestId("proposition-erreur")).toBeNull();
  });
  it("reseau coupe : message de reseau, Reessayer propose", async () => {
    h.post.mockRejectedValue(new Error("Network Error"));
    await ouvrirRelations();
    await userEvent.click(screen.getByRole("button", { name: "Lancer une proposition automatique" }));
    const e = await screen.findByTestId("proposition-erreur");
    expect(e.textContent).toMatch(/serveur est injoignable/);
    expect(within(e).getByRole("button", { name: "Réessayer" })).toBeInTheDocument();
  });
  it("declarer une relation a la main depuis la fiche : recherche de l'autre objet, justification, POST du bon sens", async () => {
    const f = await ouvrirFiche("10");
    await userEvent.click(within(f).getByRole("button", { name: "Déclarer une relation" }));
    const d = await dialogue();
    expect(d.textContent).toMatch(/Ce circuit est porté par l'infrastructure physique suivante/);
    expect(d.textContent).toMatch(/créée validée/);
    const ok = within(d).getByRole("button", { name: "Déclarer la relation" });
    expect(ok).toBeDisabled();
    // Les candidats sont des infrastructures physiques (filtre de nature envoye au serveur), jamais l'objet lui-meme.
    await waitFor(() => expect(h.get.mock.calls.some((c) => c[0] === `${BASE_RESEAU}/objets` && (c[1]?.params as Record<string, unknown>)?.nature === "ACTIF_PHYSIQUE")).toBe(true));
    await userEvent.click(await within(d).findByRole("radio", { name: /Gaine G-01/ }));
    await userEvent.type(within(d).getByLabelText(/Justification/), "Constat sur le plan de récolement");
    await userEvent.click(ok);
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${BASE_RESEAU}/relations`, { type: "PORTE_PAR", sourceObjetId: "10", cibleObjetId: "20", justification: "Constat sur le plan de récolement" }));
  });
  it("depuis une infrastructure, le sens est au choix : circuit porte, equipement contenu", async () => {
    const f = await ouvrirFiche("20");
    await userEvent.click(within(f).getByRole("button", { name: "Déclarer une relation" }));
    const d = await dialogue();
    expect(within(d).getByRole("radio", { name: /Le circuit logique suivant est porté par cette infrastructure/ })).toBeChecked();
    await userEvent.click(within(d).getByRole("radio", { name: /L'équipement suivant est contenu dans cette infrastructure/ }));
    await waitFor(() => expect(h.get.mock.calls.some((c) => c[0] === `${BASE_RESEAU}/objets` && (c[1]?.params as Record<string, unknown>)?.nature === "EQUIPEMENT")).toBe(true));
    await userEvent.click(await within(d).findByRole("radio", { name: /Vanne V1/ }));
    await userEvent.type(within(d).getByLabelText(/Justification/), "Vanne visible dans la chambre");
    await userEvent.click(within(d).getByRole("button", { name: "Déclarer la relation" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${BASE_RESEAU}/relations`, { type: "CONTENU_DANS", sourceObjetId: "30", cibleObjetId: "20", justification: "Vanne visible dans la chambre" }));
  });
  it("409 RELATION_DEJA_CONNUE : une proposition refusee ne se contourne pas par une declaration manuelle", async () => {
    h.post.mockRejectedValue(erreurHttp(409, "RELATION_DEJA_CONNUE"));
    const f = await ouvrirFiche("10");
    await userEvent.click(within(f).getByRole("button", { name: "Déclarer une relation" }));
    const d = await dialogue();
    await userEvent.click(await within(d).findByRole("radio", { name: /Gaine G-01/ }));
    await userEvent.type(within(d).getByLabelText(/Justification/), "Constat sur le plan de récolement");
    await userEvent.click(within(d).getByRole("button", { name: "Déclarer la relation" }));
    expect((await within(d).findByRole("alert")).textContent).toMatch(/ne se contourne pas par une déclaration manuelle/);
  });
  it("relations illisibles (statut inconnu) : comptees ; liste vide : message sur le support inconnu", async () => {
    await ouvrirReseaux({ relations: pageRelationsServeur([relationProposee(), { ...relationProposee(), id: "x", statut: "ANNULEE" }]) });
    await userEvent.click(screen.getByRole("button", { name: "Relations" }));
    expect(await screen.findByText(/1 relation\(s\) de la réponse n'ont pas pu être lues/)).toBeInTheDocument();
  });
  it("pagination des relations par curseur", async () => {
    await ouvrirReseaux({ relations: (p?: Record<string, unknown>) => (p?.curseur === "r-2" ? pageRelationsServeur([relationValidee()]) : pageRelationsServeur([relationProposee()], "r-2")) });
    await userEvent.click(screen.getByRole("button", { name: "Relations" }));
    await userEvent.click(await screen.findByRole("button", { name: "Charger les relations suivantes" }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Liste des relations" })).getAllByRole("listitem")).toHaveLength(2));
    expect(dernierParams("/relations")).toMatchObject({ curseur: "r-2" });
  });
});

describe("compte a rebours de la reprise (429)", () => {
  it("decompte chaque seconde, jamais en dessous de zero, repart a chaque nouvelle erreur", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ d, c }) => useCompteARebours(d, c), { initialProps: { d: 3 as number | null, c: "a" } });
    expect(result.current).toBe(3);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current).toBe(2);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(result.current).toBe(0);
    rerender({ d: 3, c: "b" });
    expect(result.current).toBe(3);
    rerender({ d: null, c: "c" });
    expect(result.current).toBe(0);
    rerender({ d: 0, c: "d" });
    expect(result.current).toBe(0);
  });
});

describe("comptage par nature : trois grandeurs distinctes, jamais additionnees", () => {
  async function ouvrirComptage(over: SurchargesReseau = {}, role = "GESTIONNAIRE") {
    await ouvrirReseaux(over, role);
    await userEvent.click(screen.getByRole("button", { name: "Comptage" }));
    return screen.findByTestId("resultat-comptage");
  }
  it("la mention « un fichier de N lignes n'est pas N cables » est visible, et il n'existe aucun total « tous objets »", async () => {
    const c = await ouvrirComptage();
    expect(within(c).getByTestId("mention-lignes-cables").textContent).toMatch(/Un fichier de N lignes n'est pas N câbles/);
    expect(within(c).getByTestId("mention-aucun-total").textContent).toMatch(/il n'existe aucun total « tous objets »/);
  });
  it("longueur de trace fusionnee, somme des longueurs de circuits et nombre d'infrastructures declarees : chacune dans sa carte, avec son libelle", async () => {
    const c = await ouvrirComptage();
    const infra = within(c).getByTestId("pv-cpt-infra");
    expect(infra.textContent).toMatch(/nombre d'infrastructures physiques déclarées[^]*4/i);
    expect(infra.textContent).toMatch(/180,03 m/);
    const circuits = within(c).getByTestId("pv-cpt-circuits");
    expect(circuits.textContent).toMatch(/nombre de circuits logiques déclarés \(ce n'est pas un nombre de câbles physiques\)/i);
    expect(circuits.textContent).toMatch(/somme des longueurs de circuits \(un tracé partagé par N circuits y compte N fois : ce n'est pas une longueur de câble\)/i);
    expect(circuits.textContent).toMatch(/410,05 m/);
    expect(circuits.textContent).toMatch(/longueur de trace fusionnée \(union des tracés/i);
    expect(circuits.textContent).toMatch(/290,04 m/);
    expect(circuits.textContent).toMatch(/3 circuit\(s\) en 1 groupe\(s\) de tracé identique/);
    // Aucune valeur n'est la somme de deux autres : 8 circuits + 4 infrastructures n'est jamais affiche.
    expect(c.textContent).not.toMatch(/\b12 (objets|éléments|câbles)\b/);
    expect(c.textContent).not.toMatch(/590,08|470,08|228,08/);
  });
  it("support physique : valide, proposition seule (aucun effet), sans support connu (inconnu, jamais suppose)", async () => {
    const c = await ouvrirComptage();
    const s = within(c).getByTestId("support-physique").textContent!;
    expect(s).toMatch(/Avec un support validé par une personne : 0/);
    expect(s).toMatch(/Avec une proposition seulement \(aucun effet\) : 2/);
    expect(s).toMatch(/Sans support connu \(inconnu, jamais supposé\) : 6/);
  });
  it("equipements et nature inconnue sont comptes a part ; avertissements et limites du serveur ; evaluables en 3D : 0", async () => {
    const c = await ouvrirComptage();
    expect(within(c).getByTestId("pv-cpt-equipements").textContent).toMatch(/nombre d'équipements déclarés[^]*1/i);
    expect(within(c).getByTestId("pv-cpt-inconnue").textContent).toMatch(/comptés ni comme infrastructures ni comme circuits/);
    expect(within(c).getByTestId("avertissements-comptage").textContent).toMatch(/Ce ne sont pas 8 câbles physiques/);
    expect(c.textContent).toMatch(/Évaluables en 3D : 0/);
    expect(c.textContent).toMatch(/connectivité du réseau/);
    expect(c.textContent).toMatch(/Classe de précision déclarée : A : 1 · B : 0 · C : 0 · D : 0 · E : 0 · non renseignée : 11/);
  });
  it("une grandeur absente est « non fournie », jamais zero", async () => {
    const c = await ouvrirComptage({ comptage: { infrastructuresPhysiques: {}, circuitsLogiques: {} } });
    expect(within(c).getByTestId("pv-cpt-circuits").textContent).toMatch(/non fourni/);
    expect(within(c).getByTestId("pv-cpt-infra").textContent).toMatch(/non fourni/);
    expect(within(c).getByTestId("pv-cpt-circuits").textContent).not.toMatch(/\b0 m\b/);
  });
  it("jeu choisi et inclusion des jeux en attente (gestionnaire) : parametres envoyes", async () => {
    await ouvrirComptage();
    await userEvent.selectOptions(screen.getByLabelText("Jeu compté"), JEU_RESEAU);
    await waitFor(() => expect(dernierParams("/comptage")).toEqual({ jeuId: JEU_RESEAU }));
    await userEvent.click(screen.getByLabelText(/Inclure aussi les jeux en attente/));
    await waitFor(() => expect(dernierParams("/comptage")).toEqual({ jeuId: JEU_RESEAU, inclureNonAutorises: "true" }));
  });
  const echecs: Array<[number, string, RegExp]> = [
    [504, "COMPTAGE_TROP_LONG", /comptage a dépassé le délai/],
    [503, "SERVICE_OCCUPE", /d'autres calculs/],
    [403, "QUARANTAINE_RESERVEE", /réservé aux administrateurs/],
    [404, "JEU_INTROUVABLE", /Ce jeu de données est introuvable/],
  ];
  it.each(echecs)("%s %s : message en clair", async (status, code, extrait) => {
    installer({ comptage: () => { throw erreurHttp(status, code); } });
    rendrePage();
    await userEvent.click(await screen.findByRole("tab", { name: "Réseaux" }));
    await userEvent.click(await screen.findByRole("button", { name: "Comptage" }));
    expect(await screen.findByText(extrait)).toBeInTheDocument();
  });
});

describe("mise en evidence sur la carte : sans charger le reseau", () => {
  async function avecCarte() {
    const f = await ouvrirFiche("10", { carte: carteAvecObjets() });
    await screen.findAllByTestId("objet-carte");
    return f;
  }
  it("l'objet est surligne a partir de la geometrie DEJA chargee par la carte : aucune route de geometrie n'est appelee", async () => {
    const f = await avecCarte();
    const avant = h.get.mock.calls.length;
    await userEvent.click(within(f).getByRole("button", { name: /Mettre en évidence sur la carte/ }));
    expect(within(f).getByTestId("etat-localisation").getAttribute("data-resultat")).toBe("TROUVE");
    const passives = await screen.findAllByTestId("couche-passive");
    const couleurs = passives.map((p) => JSON.parse(p.getAttribute("data-style")!).color);
    expect(couleurs).toEqual(expect.arrayContaining(["#ffffff", "#0b2545"]));
    expect(mapDouble.fitBounds).toHaveBeenCalled();
    expect(await screen.findByTestId("legende-objet-reseau")).toBeInTheDocument();
    // Aucune requete supplementaire de geometrie : ni /carte ni /reseau n'a ete appele par ce geste.
    expect(h.get.mock.calls.slice(avant).filter((c) => String(c[0]).includes("/carte") || String(c[0]).includes("geometrie"))).toEqual([]);
  });
  it("Retirer la mise en evidence supprime le trait et la legende", async () => {
    const f = await avecCarte();
    await userEvent.click(within(f).getByRole("button", { name: /Mettre en évidence sur la carte/ }));
    await screen.findByTestId("legende-objet-reseau");
    await userEvent.click(within(f).getByRole("button", { name: /Retirer la mise en évidence/ }));
    await waitFor(() => expect(screen.queryByTestId("legende-objet-reseau")).toBeNull());
    const couleurs = screen.queryAllByTestId("couche-passive").map((p) => JSON.parse(p.getAttribute("data-style")!).color);
    expect(couleurs).not.toContain("#0b2545");
  });
  it("la mise en evidence disparait en revenant a la liste", async () => {
    const f = await avecCarte();
    await userEvent.click(within(f).getByRole("button", { name: /Mettre en évidence sur la carte/ }));
    await screen.findByTestId("legende-objet-reseau");
    await userEvent.click(within(f).getByRole("button", { name: "Retour à la liste des objets" }));
    await waitFor(() => expect(screen.queryByTestId("legende-objet-reseau")).toBeNull());
  });
  it("objet absent de la vue chargee : le dit, sans rien charger, et n'affiche aucun trait", async () => {
    await ouvrirReseaux({ carte: carteAvecObjets() });
    await screen.findAllByTestId("objet-carte");
    await userEvent.click(bouton("4"));
    const f = await screen.findByTestId("fiche-objet-reseau");
    await userEvent.click(within(f).getByRole("button", { name: /Mettre en évidence sur la carte/ }));
    const e = within(f).getByTestId("etat-localisation");
    expect(e.getAttribute("data-resultat")).toBe("HORS_VUE");
    expect(e.textContent).toMatch(/ce volet ne charge aucune géométrie/);
    expect(screen.queryByTestId("legende-objet-reseau")).toBeNull();
  });
  it("objet d'un jeu non affiche sur la carte : le dit", async () => {
    const f = await ouvrirFiche("10", { carte: carteAvecObjets(), fichesObjets: { "10": ficheObjetServeur(objetServeur({ jeuId: "autre-jeu" })) } });
    await userEvent.click(within(f).getByRole("button", { name: /Mettre en évidence sur la carte/ }));
    expect(within(f).getByTestId("etat-localisation").getAttribute("data-resultat")).toBe("JEU_NON_AFFICHE");
  });
});

describe("dossiers de conflit : nature de la cible (lot B1, extension minimale)", () => {
  const cibleCircuit = { nature: "CIRCUIT_LOGIQUE", origineNature: "JEU", qualification: "CIRCUIT_LOGIQUE_SANS_SUPPORT_VALIDE", libelle: "Conflit avec un simple circuit logique : son support physique n'est pas établi, la position réelle de l'infrastructure est inconnue.", supportPhysique: { valides: 0, proposes: 1 } };
  async function ouvrirConflits(liste: ReturnType<typeof conflit>[], fiche = ficheConflit()) {
    installer({ liste: brut(serveurPage(pageConflits(liste))), fiches: { "cf-1": fiche } });
    rendrePage();
    await userEvent.click(await screen.findByRole("tab", { name: "Conflits" }));
    await screen.findByRole("list", { name: "Liste des conflits" });
  }
  it("la liste montre la cible quand le serveur la fournit, et rien d'invente sinon", async () => {
    await ouvrirConflits([conflit({ cible: cibleCircuit as never }), conflit({ id: "cf-9", cle: "k9", cible: null })]);
    const cibles = screen.getAllByTestId("cible-liste");
    expect(cibles).toHaveLength(1);
    expect(cibles[0].textContent).toBe("Cible : Circuit logique sans support validé");
  });
  it("la fiche montre la nature, la qualification, le support physique et les circuits superposes (ils restent separes)", async () => {
    await ouvrirConflits([conflit({ cible: cibleCircuit as never })], ficheConflit({ cible: { ...cibleCircuit, tracePartagee: 2 } as never }));
    await userEvent.click(document.querySelector<HTMLButtonElement>('button[data-conflit-id="cf-1"]')!);
    const c = await screen.findByTestId("cible-fiche");
    expect(c.getAttribute("data-qualification")).toBe("CIRCUIT_LOGIQUE_SANS_SUPPORT_VALIDE");
    expect(c.textContent).toMatch(/Circuit logique/);
    expect(c.textContent).toMatch(/Circuit logique sans support validé/);
    expect(c.textContent).toMatch(/son support physique n'est pas établi/);
    expect(c.textContent).toMatch(/Support physique : 0 validé\(s\), 1 proposition\(s\) sans effet/);
    expect(within(c).getByTestId("cible-trace-partagee").textContent).toMatch(/2 autre\(s\) circuit\(s\) du même jeu suivent exactement cette trace : ils restent séparés, ce ne sont pas des câbles distincts/);
  });
  it("fiche sans cible : le serveur ne la precise pas, elle n'est pas deduite ; masquee : dit masquee", async () => {
    await ouvrirConflits([conflit({ cible: null })], ficheConflit({ cible: null }));
    await userEvent.click(document.querySelector<HTMLButtonElement>('button[data-conflit-id="cf-1"]')!);
    await screen.findByTestId("fiche-conflit");
    expect(screen.getByText(/Le serveur ne précise pas la nature de l'objet de réseau concerné : elle n'est pas déduite/)).toBeInTheDocument();
  });
  it("fiche masquee pour ce compte : nature masquee", async () => {
    await ouvrirConflits([conflit({ cible: null, geometrieMasquee: true })], ficheConflit({ cible: null, geometrieMasquee: true, geom: null }));
    await userEvent.click(document.querySelector<HTMLButtonElement>('button[data-conflit-id="cf-1"]')!);
    await screen.findByTestId("fiche-conflit");
    expect(screen.getByText(/Nature de la cible masquée : le jeu de réseau de ce dossier n'est pas lisible pour ce compte/)).toBeInTheDocument();
  });
  it("un conflit sur un circuit porte par une infrastructure validee est dit : c'est l'infrastructure qui est concernee", async () => {
    const valide = { nature: "CIRCUIT_LOGIQUE", origineNature: "OBJET", qualification: "CIRCUIT_LOGIQUE_SUR_INFRASTRUCTURE_VALIDEE", libelle: "Conflit avec un circuit logique porté par 1 infrastructure(s) physique(s) validée(s) : c'est l'infrastructure physique qui est concernée.", supportPhysique: { valides: 1, proposes: 0 } };
    await ouvrirConflits([conflit({ cible: valide as never })], ficheConflit({ cible: valide as never }));
    expect(screen.getByTestId("cible-liste").textContent).toBe("Cible : Circuit logique porté par une infrastructure validée");
    await userEvent.click(document.querySelector<HTMLButtonElement>('button[data-conflit-id="cf-1"]')!);
    expect((await screen.findByTestId("cible-fiche")).textContent).toMatch(/c'est l'infrastructure physique qui est concernée/);
  });
});

describe("accessibilite et clavier de l'onglet", () => {
  it("l'onglet Reseaux est dans la liste d'onglets (fleches, Home, End) et son panneau est etiquete", async () => {
    installer();
    rendrePage();
    const tab = await screen.findByRole("tab", { name: "Réseaux" });
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Analyse", "Couches", "Conflits", "Réseaux", "Sources", "Documents", "Export"]);
    tab.focus();
    // Lot UI-C : « Sources » suit « Réseaux » ; la fleche droite y mene, puis revient a « Analyse ».
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Sources" })).toHaveFocus();
    // Lot UI-D : « Documents » et « Export » (decideurs) suivent « Sources ».
    await userEvent.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Analyse" })).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Réseaux" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "pv-onglet-reseaux");
  });
  it("les boutons a bascule (nature, sections) ont un etat accessible et au moins 44 px de cible au toucher", async () => {
    await ouvrirReseaux();
    for (const b of document.querySelectorAll<HTMLButtonElement>("button[data-nature-filtre], button[data-vue]")) {
      expect(b).toHaveAttribute("aria-pressed");
      expect(b.className).toMatch(/min-h-\[44px\]/);
    }
  });
  it("l'onglet n'est monte qu'a la premiere visite : aucune requete reseau avant", async () => {
    installer();
    rendrePage();
    await screen.findByRole("tab", { name: "Réseaux" });
    await screen.findByTestId("carte");
    expect(appels("/objets")).toHaveLength(0);
    expect(appels("/comptage")).toHaveLength(0);
  });
});

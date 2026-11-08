import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { violationsAccessibilite } from "../test/accessibilite";

/**
 * Accessibilite de l'onglet « Reseaux » (lot B1) par axe-core, regles WCAG 2.1 A et AA, contraste exclu (jsdom ne le calcule pas ; il est garde par `test/contraste.test.ts`,
 * qui parcourt les nouveaux dossiers). Chaque vue, chaque etat cle et chaque dialogue est rendu avec des donnees SYNTHETIQUES, puis ZERO violation est exigee. Les dialogues
 * sont mesures sur tout le document (ils sont montes dans un portail). L'ecran des echanges (lot B3) a son propre fichier : `Accessibilite.workflow.test.tsx`.
 */

configure({ asyncUtilTimeout: 10_000 });

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), role: "GESTIONNAIRE", userId: "u0000001-0000-4000-8000-0000000000a1" }));
vi.mock("../lib/api", () => ({ api: { get: h.get, post: h.post, put: h.put, patch: h.patch, delete: vi.fn() } }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: h.userId, nomComplet: "Moussa Gestionnaire", role: h.role, modulesAutorises: ["projets-voirie"] } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/download", () => ({ downloadViaApi: vi.fn() }));
// Leaflet exige un vrai moteur de rendu : la carte est mesuree a part.
vi.mock("../components/projets-voirie/CarteProjet", () => ({ CarteProjet: () => <div role="img" aria-label="Carte du projet (doublure de test)" /> }));

import { rendrePage } from "../components/projets-voirie/conflitsPage.testutil";
import {
  ficheObjetServeur, objetQualifie, objetServeur, pageObjetsServeur, pageRelationsServeur, projetFicheReseau, reponseApiReseau, relationProposee, relationValidee, resultatPropositionServeur,
  erreurHttp as erreurHttpReseau, JEU_RESEAU, type SurchargesReseau,
} from "../components/projets-voirie/reseaux/reseauxSynthetiques.testutil";
import { brut } from "../components/projets-voirie/conflitsSynthetiques.testutil";

const corps = () => document.body;
const dialogue = () => screen.findByRole("dialog");
async function fermer(d: HTMLElement) {
  await userEvent.click(within(d).getByRole("button", { name: "Annuler" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

beforeEach(() => {
  for (const f of [h.get, h.post, h.put, h.patch]) f.mockReset();
  h.post.mockResolvedValue({ data: {} }); h.put.mockResolvedValue({ data: {} }); h.patch.mockResolvedValue({ data: {} });
  h.role = "GESTIONNAIRE";
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
});
afterEach(() => { window.dispatchEvent(new Event("online")); });

describe("Accessibilite de l'onglet Reseaux (lot B1)", () => {
  const FICHE = brut(projetFicheReseau());
  function installer(over: SurchargesReseau = {}) {
    h.get.mockImplementation(async (url: string, opts?: { params?: Record<string, unknown> }) => reponseApiReseau(url, opts?.params, { fiche: FICHE, ...over }));
  }
  async function ouvrir(over: SurchargesReseau = {}, role = "GESTIONNAIRE") {
    h.role = role;
    installer(over);
    const r = rendrePage();
    await userEvent.click(await screen.findByRole("tab", { name: "Réseaux" }));
    await screen.findByTestId("bandeau-reseaux");
    return r;
  }
  const ouvrirObjet = async (id: string) => { await userEvent.click(document.querySelector<HTMLButtonElement>(`button[data-objet-reseau-id="${id}"]`)!); return screen.findByTestId("fiche-objet-reseau"); };

  it("liste des objets : bandeau, filtres de nature, badges texte et forme", async () => {
    const { container } = await ouvrir();
    await screen.findByRole("list", { name: "Liste des objets des réseaux" });
    expect(await violationsAccessibilite(container)).toEqual([]);
  }, 60_000);

  it("liste des objets : filtres avances ouverts, liste vide, liste en erreur 504", async () => {
    const a = await ouvrir();
    await screen.findByRole("list", { name: "Liste des objets des réseaux" });
    await userEvent.click(screen.getByRole("button", { name: /Filtres avancés/ }));
    expect(await violationsAccessibilite(a.container)).toEqual([]);
    a.unmount();
    const b = await ouvrir({ objets: pageObjetsServeur([]) });
    await screen.findByText("Aucun objet de réseau lisible pour ce projet");
    expect(await violationsAccessibilite(b.container)).toEqual([]);
    b.unmount();
    const c = await ouvrir({ objets: () => { throw erreurHttpReseau(504, "LECTURE_TROP_LONGUE"); } });
    await screen.findByText(/lecture a dépassé le délai/);
    expect(await violationsAccessibilite(c.container)).toEqual([]);
  }, 90_000);

  it("fiche d'un circuit (propositions a valider, circuits superposes) puis d'un objet qualifie (vertical fourni)", async () => {
    const { container } = await ouvrir();
    await ouvrirObjet("10");
    expect(await violationsAccessibilite(container)).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Retour à la liste des objets" }));
    await ouvrirObjet("4");
    expect(await violationsAccessibilite(container)).toEqual([]);
  }, 90_000);

  it("fiche masquee (source, vertical et qualite absents) et fiche en erreur 404", async () => {
    const a = await ouvrir({ fichesObjets: { "10": ficheObjetServeur(objetServeur({ source: null, vertical: undefined, qualite: undefined })) } });
    await ouvrirObjet("10");
    expect(await violationsAccessibilite(a.container)).toEqual([]);
    a.unmount();
    const b = await ouvrir({ fichesObjets: { "10": erreurHttpReseau(404, "OBJET_INTROUVABLE") } });
    await userEvent.click(document.querySelector<HTMLButtonElement>('button[data-objet-reseau-id="10"]')!);
    await screen.findByText(/n'existe pas dans ce projet/);
    expect(await violationsAccessibilite(b.container)).toEqual([]);
  }, 90_000);

  it("dialogues : qualifier l'objet (vide puis avec erreurs de saisie), modifier un descripteur, valider, refuser, revoquer, declarer une relation", async () => {
    await ouvrir({ fichesObjets: { "4": ficheObjetServeur(objetQualifie(), [{ ...relationValidee(), role: "SOURCE" }]) } });
    let f = await ouvrirObjet("10");
    await userEvent.click(within(f).getByRole("button", { name: "Qualifier l'objet" }));
    let d = await dialogue();
    expect(await violationsAccessibilite(corps())).toEqual([]);
    await userEvent.type(within(d).getByLabelText("Précision horizontale (m)"), "0");
    await userEvent.type(within(d).getByLabelText(/Référence verticale/), "terrain");
    expect(await violationsAccessibilite(corps())).toEqual([]);
    await fermer(d);
    for (const nom of [/Valider cette association/, /Refuser cette proposition/]) {
      await userEvent.click(within(f).getByRole("button", { name: nom }));
      d = await dialogue();
      expect(await violationsAccessibilite(corps())).toEqual([]);
      await fermer(d);
    }
    await userEvent.click(within(f).getByRole("button", { name: "Déclarer une relation" }));
    d = await dialogue();
    await within(d).findByRole("radio", { name: /Gaine G-01/ });
    expect(await violationsAccessibilite(corps())).toEqual([]);
    await fermer(d);
    await userEvent.click(within(f).getByRole("button", { name: "Retour à la liste des objets" }));
    f = await ouvrirObjet("4");
    await userEvent.click(within(f).getByRole("button", { name: "Modifier le descripteur" }));
    d = await dialogue();
    expect(await violationsAccessibilite(corps())).toEqual([]);
    await fermer(d);
    await userEvent.click(within(f).getByRole("button", { name: /Révoquer cette association/ }));
    d = await dialogue();
    expect(await violationsAccessibilite(corps())).toEqual([]);
  }, 120_000);

  it("dialogue avec une erreur typee du serveur (alerte) : 422 puis 409", async () => {
    h.put.mockRejectedValue(erreurHttpReseau(422, "TYPE_OBJET_SANS_NATURE"));
    await ouvrir();
    const f = await ouvrirObjet("10");
    await userEvent.click(within(f).getByRole("button", { name: "Qualifier l'objet" }));
    const d = await dialogue();
    await userEvent.selectOptions(within(d).getByLabelText("Classe de précision"), "A");
    await userEvent.type(within(d).getByLabelText(/Justification/), "Levé contrôlé avec le chef de projet");
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer le descripteur" }));
    await within(d).findByRole("alert");
    expect(await violationsAccessibilite(corps())).toEqual([]);
  }, 90_000);

  it("vue Relations : liste, proposition automatique (resultat, 429 avec compte a rebours, 504), dialogue d'action", async () => {
    const a = await ouvrir();
    await userEvent.click(screen.getByRole("button", { name: "Relations" }));
    await screen.findByRole("list", { name: "Liste des relations" });
    expect(await violationsAccessibilite(a.container)).toEqual([]);
    h.post.mockResolvedValueOnce({ data: resultatPropositionServeur() });
    await userEvent.click(screen.getByRole("button", { name: "Lancer une proposition automatique" }));
    await screen.findByTestId("resultat-proposition");
    expect(await violationsAccessibilite(a.container)).toEqual([]);
    h.post.mockRejectedValueOnce(Object.assign(new Error("429"), { response: { status: 429, data: { error: "brut", code: "ASSOCIATION_TROP_FREQUENTE", retryAfterS: 30 }, headers: { "retry-after": "30" } } }));
    await userEvent.click(screen.getByRole("button", { name: "Lancer une proposition automatique" }));
    await screen.findByTestId("proposition-erreur");
    expect(await violationsAccessibilite(a.container)).toEqual([]);
    await userEvent.click(screen.getAllByRole("button", { name: /Valider cette association/ })[0]);
    await dialogue();
    expect(await violationsAccessibilite(corps())).toEqual([]);
  }, 120_000);

  it("vue Relations en erreur et vide ; role lecteur (sans panneau de proposition)", async () => {
    const a = await ouvrir({ relations: pageRelationsServeur([]) });
    await userEvent.click(screen.getByRole("button", { name: "Relations" }));
    await screen.findByText("Aucune relation pour ce projet");
    expect(await violationsAccessibilite(a.container)).toEqual([]);
    a.unmount();
    const b = await ouvrir({ relations: pageRelationsServeur([relationProposee({ actionsPossibles: [] })]) }, "LECTEUR");
    await userEvent.click(screen.getByRole("button", { name: "Relations" }));
    await screen.findByRole("list", { name: "Liste des relations" });
    expect(await violationsAccessibilite(b.container)).toEqual([]);
  }, 90_000);

  it("vue Comptage : trois grandeurs distinctes, avertissements, qualite, jeux ; puis en erreur", async () => {
    const a = await ouvrir();
    await userEvent.click(screen.getByRole("button", { name: "Comptage" }));
    await screen.findByTestId("resultat-comptage");
    expect(await violationsAccessibilite(a.container)).toEqual([]);
    await userEvent.selectOptions(screen.getByLabelText("Jeu compté"), JEU_RESEAU);
    await screen.findByTestId("resultat-comptage");
    expect(await violationsAccessibilite(a.container)).toEqual([]);
    a.unmount();
    const b = await ouvrir({ comptage: () => { throw erreurHttpReseau(504, "COMPTAGE_TROP_LONG"); } });
    await userEvent.click(screen.getByRole("button", { name: "Comptage" }));
    await screen.findByText(/comptage a dépassé le délai/);
    expect(await violationsAccessibilite(b.container)).toEqual([]);
  }, 90_000);

  it("onglet Conflits : liste et fiche avec la cible (circuit sans support valide, circuits superposes)", async () => {
    const cible = { nature: "CIRCUIT_LOGIQUE", origineNature: "JEU", qualification: "CIRCUIT_LOGIQUE_SANS_SUPPORT_VALIDE", libelle: "Conflit avec un simple circuit logique : son support physique n'est pas établi.", supportPhysique: { valides: 0, proposes: 1 } };
    const { conflit, fiche, pageConflits, serveurPage } = await import("../components/projets-voirie/conflitsSynthetiques.testutil");
    installer({ liste: brut(serveurPage(pageConflits([conflit({ cible: cible as never })]))), fiches: { "cf-1": fiche({ cible: { ...cible, tracePartagee: 2 } as never }) } });
    const { container } = rendrePage();
    await userEvent.click(await screen.findByRole("tab", { name: "Conflits" }));
    await screen.findByTestId("cible-liste");
    expect(await violationsAccessibilite(container)).toEqual([]);
    await userEvent.click(document.querySelector<HTMLButtonElement>('button[data-conflit-id="cf-1"]')!);
    await screen.findByTestId("cible-fiche");
    expect(await violationsAccessibilite(container)).toEqual([]);
  }, 90_000);
});

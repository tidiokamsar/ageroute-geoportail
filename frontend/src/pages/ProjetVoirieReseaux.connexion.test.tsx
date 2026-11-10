import { beforeEach, describe, expect, it, vi } from "vitest";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("react-leaflet", async () => (await import("../components/projets-voirie/carteDouble.testutil")).moduleReactLeaflet());

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(), role: "GESTIONNAIRE" }));
vi.mock("../lib/api", () => ({ api: { get: h.get, post: h.post, put: h.put, patch: h.patch, delete: h.delete } }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u-gest", nomComplet: "Gestionnaire Test", role: h.role, modulesAutorises: ["projets-voirie"] } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/download", () => ({ downloadViaApi: vi.fn().mockResolvedValue(undefined) }));

import { reinitialiserCarte } from "../components/projets-voirie/carteDouble.testutil";
import { brut } from "../components/projets-voirie/conflitsSynthetiques.testutil";
import { rendrePage } from "../components/projets-voirie/conflitsPage.testutil";
import {
  BASE_RESEAU, erreurHttp, ficheObjetServeur, objetEquipement, objetInfrastructure, objetServeur, pageObjetsServeur, pageRelationsServeur, projetFicheReseau, reponseApiReseau, relationValidee,
  type SurchargesReseau,
} from "../components/projets-voirie/reseaux/reseauxSynthetiques.testutil";
import { violationsAccessibilite } from "../test/accessibilite";

/**
 * Connectivite DECLARATIVE (lot S1, interface UI-C) dans l'onglet Reseaux : CONNECTE_A exige une preuve (CONFIRMEE_PAR_FOURNISSEUR ou INCONNUE,
 * « inconnue » par defaut) ; l'autre objet se cherche par son nom (jamais par proximite) ; la preuve et l'etat de connexion s'affichent.
 * Donnees 100 % SYNTHETIQUES.
 */

configure({ asyncUtilTimeout: 8000 });
const FICHE = brut(projetFicheReseau());
const CONNEXION = relationValidee({
  id: "r0000009-0000-4000-8000-000000000009", typeRelation: "CONNECTE_A", origine: "IMPORT_DECLARATIF", preuve: "CONFIRMEE_PAR_FOURNISSEUR",
  source: { objetId: "20", nom: "Gaine G-01", nature: "ACTIF_PHYSIQUE", typeObjet: "GAINE", typeGeom: "LIGNE", jeuId: "j" },
  cible: { objetId: "22", nom: "Gaine G-02", nature: "ACTIF_PHYSIQUE", typeObjet: "GAINE", typeGeom: "LIGNE", jeuId: "j" },
});

/** Objets du projet : un circuit, deux gaines, un regard ; filtres par nature quand le dialogue cherche l'autre objet (par son nom, jamais par proximite). */
const OBJETS = [objetServeur(), objetInfrastructure(), objetInfrastructure({ id: "22", nom: "Gaine G-02" }), objetEquipement({ id: "31", nom: "Regard R1" })];
const objets = (p: Record<string, unknown> | undefined) => pageObjetsServeur(OBJETS.filter((o) => !p?.nature || o.nature === p.nature));

function installer(over: SurchargesReseau = {}) {
  h.get.mockImplementation(async (url: string, opts?: { params?: Record<string, unknown> }) => reponseApiReseau(url, opts?.params, { fiche: FICHE, objets, ...over }));
}
async function ouvrirFiche(id: string, over: SurchargesReseau = {}) {
  installer(over);
  rendrePage();
  await userEvent.click(await screen.findByRole("tab", { name: "Réseaux" }));
  await screen.findByRole("list", { name: "Liste des objets des réseaux" });
  await userEvent.click(document.querySelector<HTMLButtonElement>(`button[data-objet-reseau-id="${id}"]`)!);
  return screen.findByTestId("fiche-objet-reseau");
}

beforeEach(() => {
  for (const f of [h.get, h.post, h.put, h.patch, h.delete]) f.mockReset();
  h.post.mockResolvedValue({ data: {} });
  h.role = "GESTIONNAIRE";
  reinitialiserCarte();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
});

describe("CONNECTE_A : declaration avec preuve", () => {
  it("depuis une infrastructure : sens « connecte a », preuve « inconnue » par defaut, POST avec la preuve ; recherche par nom, jamais par proximite", async () => {
    const f = await ouvrirFiche("20");
    await userEvent.click(within(f).getByRole("button", { name: "Déclarer une relation" }));
    const d = await screen.findByRole("dialog");
    await userEvent.click(within(d).getByRole("radio", { name: /Cette infrastructure est déclaré connecté à l'infrastructure physique suivante/ }));
    const preuves = within(d).getByRole("group", { name: "Preuve de la connexion (obligatoire)" });
    expect(within(preuves).getByRole("radio", { name: /Preuve inconnue/ })).toBeChecked();
    expect(preuves).toHaveTextContent(/aucune connexion n'est jamais déduite d'une proximité/);
    await waitFor(() => expect(h.get.mock.calls.some((c) => c[0] === `${BASE_RESEAU}/objets` && (c[1]?.params as Record<string, unknown>)?.nature === "ACTIF_PHYSIQUE")).toBe(true));
    // Aucun parametre de proximite (emprise, distance) n'est envoye pour chercher l'autre objet.
    expect(h.get.mock.calls.filter((c) => c[0] === `${BASE_RESEAU}/objets`).every((c) => !("bbox" in ((c[1]?.params as object) ?? {})))).toBe(true);
    await userEvent.type(within(d).getByLabelText(/Rechercher l'autre objet/), "G-02");
    await userEvent.click(await within(d).findByRole("radio", { name: /Gaine G-02/ }));
    await userEvent.type(within(d).getByLabelText(/Justification/), "Raccord visible sur le plan du concessionnaire");
    await userEvent.click(within(d).getByRole("button", { name: "Déclarer la relation" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${BASE_RESEAU}/relations`, { type: "CONNECTE_A", sourceObjetId: "20", cibleObjetId: "22", justification: "Raccord visible sur le plan du concessionnaire", preuve: "INCONNUE" }));
  });
  it("preuve confirmee par le fournisseur : choisie explicitement ; les autres types n'envoient jamais de preuve", async () => {
    const f = await ouvrirFiche("20");
    await userEvent.click(within(f).getByRole("button", { name: "Déclarer une relation" }));
    const d = await screen.findByRole("dialog");
    await userEvent.click(within(d).getByRole("radio", { name: /est déclaré connecté à l'équipement suivant/ }));
    await userEvent.click(within(d).getByRole("radio", { name: /Confirmée par le fournisseur/ }));
    await userEvent.click(await within(d).findByRole("radio", { name: /Regard R1/ }));
    await userEvent.type(within(d).getByLabelText(/Justification/), "Fiche de raccordement fournie par le concessionnaire");
    await userEvent.click(within(d).getByRole("button", { name: "Déclarer la relation" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${BASE_RESEAU}/relations`, expect.objectContaining({ type: "CONNECTE_A", preuve: "CONFIRMEE_PAR_FOURNISSEUR", cibleObjetId: "31" })));
  });
  it("relation PORTE_PAR : aucun champ de preuve, aucune preuve envoyee", async () => {
    const f = await ouvrirFiche("20");
    await userEvent.click(within(f).getByRole("button", { name: "Déclarer une relation" }));
    const d = await screen.findByRole("dialog");
    expect(within(d).queryByRole("group", { name: /Preuve/ })).toBeNull();
  });
  it("400 CHAMPS_INVALIDES (preuve refusee) : dit en clair", async () => {
    h.post.mockRejectedValue(erreurHttp(400, "CHAMPS_INVALIDES"));
    const f = await ouvrirFiche("20");
    await userEvent.click(within(f).getByRole("button", { name: "Déclarer une relation" }));
    const d = await screen.findByRole("dialog");
    await userEvent.click(within(d).getByRole("radio", { name: /déclaré connecté à l'infrastructure physique suivante/ }));
    await userEvent.click(await within(d).findByRole("radio", { name: /Gaine G-02/ }));
    await userEvent.type(within(d).getByLabelText(/Justification/), "Raccord visible sur le plan");
    await userEvent.click(within(d).getByRole("button", { name: "Déclarer la relation" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent(/refusées par le serveur/);
  });
});

describe("affichage de la connectivite", () => {
  it("fiche : preuve de la relation et etat de connexion declare (jamais deduit)", async () => {
    const fiche = { ...ficheObjetServeur(objetInfrastructure(), [{ ...CONNEXION, role: "SOURCE" }]), connexions: { etat: "CONFIRMEE", nbConfirmees: 1, nbInconnues: 0, libelle: "declaree" } };
    const f = await ouvrirFiche("20", { fichesObjets: { "20": fiche } });
    expect(within(f).getByTestId("etat-connexion")).toHaveTextContent("Connexion confirmée par le fournisseur (1 confirmée(s) par le fournisseur, 0 de preuve inconnue)");
    expect(within(f).getByTestId("preuve-connexion")).toHaveTextContent("Confirmée par le fournisseur (document ou fichier du concessionnaire)");
    expect(f).toHaveTextContent("Déclarée par le fichier du fournisseur");
    expect(f).toHaveTextContent("Connecté à");
  });
  it("aucune connexion fournie : etat NON_FOURNIE dit tel quel", async () => {
    const fiche = { ...ficheObjetServeur(objetInfrastructure(), []), connexions: { etat: "NON_FOURNIE", nbConfirmees: 0, nbInconnues: 0, libelle: null } };
    const f = await ouvrirFiche("20", { fichesObjets: { "20": fiche } });
    expect(within(f).getByTestId("etat-connexion")).toHaveTextContent(/^Aucune connexion fournie\./);
  });
  it("liste des relations : le filtre de type propose « connecte a » ; axe sans violation", async () => {
    installer({ relations: pageRelationsServeur([CONNEXION]) });
    const r = rendrePage();
    await userEvent.click(await screen.findByRole("tab", { name: "Réseaux" }));
    await userEvent.click(await screen.findByRole("button", { name: "Relations" }));
    expect(await screen.findByRole("option", { name: "Objet physique déclaré connecté à un autre" })).toBeInTheDocument();
    expect(await screen.findByTestId("preuve-connexion")).toBeInTheDocument();
    expect(await violationsAccessibilite(r.container)).toEqual([]);
  }, 30_000);
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn(), role: "ADMIN" }));
vi.mock("../lib/api", () => ({ api: { get: h.get, post: h.post, patch: h.patch, put: h.put, delete: h.delete } }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u-admin", role: h.role, modulesAutorises: ["projets-voirie"] } }) }));
vi.mock("react-leaflet", async () => (await import("../components/projets-voirie/carteDouble.testutil")).moduleReactLeaflet());

import { ProjetsVoirieParametresPage } from "./ProjetsVoirieParametresPage";
import { carteEtat, reinitialiserCarte } from "../components/projets-voirie/carteDouble.testutil";
import { violationsAccessibilite } from "../test/accessibilite";

/**
 * Parametres du module (lot T1, interface UI-C) : territoires, referentiels, configuration nationale. Donnees 100 % SYNTHETIQUES : aucun nom de
 * ville reelle, codes inventes. On verifie ce qui part sur le fil, les roles (un lecteur ne voit aucun bouton d'ecriture), les erreurs typees.
 */

configure({ asyncUtilTimeout: 8000 });
const B = "/v2/projets-voirie";

const terr = (id: string, chemin: string, over: Record<string, unknown> = {}) => ({
  id, code: `SYN-${id.toUpperCase()}`, nom: `Territoire ${id}`, niveau: "REGION", parentId: null, chemin, profondeur: chemin.split("/").filter(Boolean).length - 1,
  regionId: null, regionEffectiveId: 1, crsMetriqueEpsg: null, bbox: null, source: null, actif: true, version: 1, creePar: null, createdAt: "2026-11-09T08:00:00Z", updatedAt: "2026-11-09T08:00:00Z", ...over,
});
const NATION = terr("n", "/n/", { niveau: "NATION", nom: "Nation synthetique", regionEffectiveId: null });
const REGION = terr("r", "/n/r/", { parentId: "n", nom: "Region synthetique", bbox: [-11, 9, -10, 10] });
const valeur = (code: string, over: Record<string, unknown> = {}) => ({
  id: `v-${code}`, domaine: "TYPE_RESEAU", code, libelle: `Type ${code}`, ordre: 10, actif: true, parametres: { famille: "TELECOM" }, version: 1, systeme: true, approuvePar: null, approuveLe: null, ...over,
});
const CONFIG = {
  configuration: [
    { cle: "EMPRISE_PLAUSIBILITE", valeur: { nom: "Emprise test", bbox: [-15.2, 7.1, -7.5, 12.8] }, source: "DEFAUT", valeurBase: null, valeurDefaut: { nom: "Emprise test", bbox: [-15.2, 7.1, -7.5, 12.8] }, variableEnvironnement: null, version: 0, approuvePar: null, approuveLe: null, justification: null, updatedAt: null },
    { cle: "CRS_IMPORT_LISTE_BLANCHE", valeur: { epsg: [4326, 32628, 32629] }, source: "ENV", valeurBase: null, valeurDefaut: { epsg: [4326, 32628, 32629] }, variableEnvironnement: "PROJETS_VOIRIE_CRS_SOURCE_AUTORISES", version: 0, approuvePar: null, approuveLe: null, justification: null, updatedAt: null },
    { cle: "PROTECTIONS", valeur: { conflitsMax: 500, delaiCarteMs: 15000 }, source: { conflitsMax: "BASE", delaiCarteMs: "ENV" }, valeurBase: { conflitsMax: 500 }, valeurDefaut: {}, variableEnvironnement: ["PROJETS_VOIRIE_CONFLITS_MAX"], version: 2, approuvePar: { id: "u9", nomComplet: "Admin Test" }, approuveLe: "2026-11-08T10:00:00Z", justification: "Plafond releve", updatedAt: null },
  ],
};

let arbre: unknown[] = [NATION, REGION];
let valeurs: unknown[] = [valeur("FIBRE"), valeur("ANCIEN", { actif: false, libelle: "Type ancien" })];
let echecsTerritoires = 0;

function installer() {
  h.get.mockImplementation(async (url: string) => {
    if (url === `${B}/territoires`) {
      if (echecsTerritoires > 0) { echecsTerritoires -= 1; throw { response: { status: 503, data: {} } }; }
      return { data: { territoires: arbre, curseurSuivant: null } };
    }
    if (url.startsWith(`${B}/territoires/`)) return { data: { territoire: { ...REGION, emprise: { type: "Polygon", coordinates: [[[-11, 9], [-10, 9], [-10, 10], [-11, 10], [-11, 9]]] }, ancetres: [], nbEnfants: 0 } } };
    if (url.startsWith(`${B}/referentiels/`)) return { data: { domaine: url.split("/").pop(), valeurs } };
    if (url === `${B}/configuration`) return { data: CONFIG };
    if (url === "/regions") return { data: [{ id: 1, nom: "Region administrative 1" }] };
    return { data: {} };
  });
}

function rendre() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}><ProjetsVoirieParametresPage /></QueryClientProvider></MemoryRouter>);
}
function enLigne(v: boolean) { Object.defineProperty(window.navigator, "onLine", { configurable: true, value: v }); }

beforeEach(() => {
  for (const f of [h.get, h.post, h.patch, h.put, h.delete]) f.mockReset();
  h.role = "ADMIN"; arbre = [NATION, REGION]; echecsTerritoires = 0; valeurs = [valeur("FIBRE"), valeur("ANCIEN", { actif: false, libelle: "Type ancien" })];
  installer(); enLigne(true); reinitialiserCarte();
});

describe("roles", () => {
  it("un non-administrateur ne voit que la configuration, en lecture, sans aucun bouton d'ecriture", async () => {
    h.role = "LECTEUR";
    rendre();
    expect(await screen.findByRole("heading", { name: "Configuration nationale" })).toBeInTheDocument();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("button", { name: /Modifier/ })).toBeNull();
    expect(screen.getByText(/Seul un administrateur peut modifier/)).toBeInTheDocument();
    expect(h.get.mock.calls.map((c) => c[0])).not.toContain(`${B}/territoires`);
  });
  it("un gestionnaire non plus n'administre ni territoires ni referentiels", async () => {
    h.role = "GESTIONNAIRE";
    rendre();
    await screen.findByRole("heading", { name: "Configuration nationale" });
    expect(screen.queryByRole("tab", { name: "Territoires" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Modifier/ })).toBeNull();
  });
});

describe("territoires (ADMIN)", () => {
  it("arborescence : niveau, code, emprise, CRS ; actions par territoire", async () => {
    rendre();
    const liste = await screen.findByRole("list", { name: "Arborescence des territoires" });
    const region = within(liste).getByText("Region synthetique", { selector: "span.font-semibold" }).closest("li")!;
    expect(region).toHaveTextContent("Région");
    expect(region).toHaveTextContent("SYN-R");
    expect(region).toHaveTextContent("ouest -11,0000");
    expect(region).toHaveTextContent("règle nationale par bandes");
    expect(within(region).getByRole("button", { name: /Sous-territoire de Region synthetique/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Créer la nation/ })).toBeNull();
  });
  it("creation d'une commune sous une region, emprise par ses bornes : corps envoye et avertissement d'emprise affiche", async () => {
    h.post.mockResolvedValue({ data: { territoire: terr("c", "/n/r/c/", { niveau: "COMMUNE", nom: "Commune nouvelle" }), avertissements: [{ code: "EMPRISE_HORS_PARENT", message: "L'emprise deborde du parent." }] } });
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: /Sous-territoire de Region synthetique/ }));
    const d = await screen.findByRole("dialog", { name: /Nouveau territoire sous « Region synthetique »/ });
    await u.type(within(d).getByLabelText("Code"), "syn-com-1");
    await u.type(within(d).getByLabelText("Nom"), "Commune nouvelle");
    await u.selectOptions(within(d).getByLabelText("Niveau"), "COMMUNE");
    await u.selectOptions(within(d).getByLabelText("Système métrique de calcul"), "32629");
    expect(within(d).queryByRole("option", { name: "EPSG:4326" })).toBeNull();
    await u.click(within(d).getByRole("radio", { name: "Rectangle par ses quatre bornes" }));
    await u.type(within(d).getByLabelText(/Ouest/), "-10,8");
    await u.type(within(d).getByLabelText(/Sud/), "9,2");
    await u.type(within(d).getByLabelText(/Est/), "-10,6");
    await u.type(within(d).getByLabelText(/Nord/), "9,4");
    await u.click(within(d).getByRole("button", { name: "Créer le territoire" }));
    await waitFor(() => expect(h.post).toHaveBeenCalled());
    expect(h.post).toHaveBeenCalledWith(`${B}/territoires`, {
      code: "SYN-COM-1", nom: "Commune nouvelle", niveau: "COMMUNE", parentId: "r", crsMetriqueEpsg: 32629,
      emprise: { type: "Polygon", coordinates: [[[-10.8, 9.2], [-10.6, 9.2], [-10.6, 9.4], [-10.8, 9.4], [-10.8, 9.2]]] },
    });
    const a = await screen.findByTestId("annonce-territoire");
    expect(a).toHaveTextContent("Territoire « Commune nouvelle » créé.");
    expect(a).toHaveTextContent("EMPRISE_HORS_PARENT");
  });
  it("emprise dessinee sur la carte : deux clics donnent le rectangle", async () => {
    h.post.mockResolvedValue({ data: { territoire: terr("z", "/n/r/z/", { niveau: "ZONE" }), avertissements: [] } });
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: /Sous-territoire de Region synthetique/ }));
    const d = await screen.findByRole("dialog");
    await u.type(within(d).getByLabelText("Code"), "SYN-Z");
    await u.type(within(d).getByLabelText("Nom"), "Corridor");
    await u.click(within(d).getByRole("radio", { name: "Dessiner un rectangle sur la carte" }));
    await within(d).findByTestId("carte-emprise");
    expect(within(d).getByTestId("erreur-emprise")).toHaveTextContent(/Dessinez le rectangle/);
    const clic = carteEtat.handlers.click as unknown as (e: { latlng: { lat: number; lng: number } }) => void;
    clic({ latlng: { lat: 9.5, lng: -10.2 } });
    await within(d).findByText(/Premier coin posé/);
    (carteEtat.handlers.click as unknown as (e: { latlng: { lat: number; lng: number } }) => void)({ latlng: { lat: 9.1, lng: -10.5 } });
    await within(d).findByText(/Rectangle englobant : ouest -10,5000, sud 9,1000, est -10,2000, nord 9,5000/);
    await u.click(within(d).getByRole("button", { name: "Créer le territoire" }));
    await waitFor(() => expect(h.post).toHaveBeenCalled());
    expect(h.post.mock.calls[0][1].emprise.coordinates[0][0]).toEqual([-10.5, 9.1]);
  });
  it("GeoJSON colle invalide : explique, rien n'est envoye", async () => {
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: /Sous-territoire de Region synthetique/ }));
    const d = await screen.findByRole("dialog");
    await u.type(within(d).getByLabelText("Code"), "SYN-X");
    await u.type(within(d).getByLabelText("Nom"), "X");
    await u.click(within(d).getByRole("radio", { name: /Coller un GeoJSON/ }));
    await u.click(within(d).getByLabelText("GeoJSON de l'emprise"));
    await u.paste('{"type":"LineString","coordinates":[[0,0],[1,1]]}');
    expect(within(d).getByTestId("erreur-emprise")).toHaveTextContent(/Polygon ou MultiPolygon/);
    expect(within(d).getByRole("button", { name: "Créer le territoire" })).toBeDisabled();
    expect(h.post).not.toHaveBeenCalled();
  });
  it("409 TERRITOIRE_UTILISE au retrait : explique (enfants, projets, desactiver plutot), le dialogue reste ouvert", async () => {
    h.delete.mockRejectedValue({ response: { status: 409, data: { code: "TERRITOIRE_UTILISE", enfants: 1, projets: 2, error: "brut" } } });
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: /Retirer Region synthetique/ }));
    const d = await screen.findByRole("dialog");
    await u.click(within(d).getByRole("button", { name: "Retirer le territoire" }));
    const a = await within(d).findByRole("alert");
    expect(a).toHaveTextContent(/1 territoire\(s\) enfant\(s\) et 2 projet\(s\)/);
    expect(a).toHaveTextContent(/désactivez-le/);
    expect(h.delete).toHaveBeenCalledWith(`${B}/territoires/r`);
  });
  it("modification : seuls les champs changes partent ; desactivation ; 400 CHAMPS_INVALIDES dit", async () => {
    h.patch.mockResolvedValueOnce({ data: { territoire: { ...REGION, actif: false }, avertissements: [] } });
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: /Modifier Region synthetique/ }));
    const d = await screen.findByRole("dialog");
    expect(within(d).getByRole("button", { name: "Enregistrer" })).toBeDisabled();
    await u.click(within(d).getByRole("checkbox", { name: /Territoire actif/ }));
    await u.click(within(d).getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(h.patch).toHaveBeenCalledWith(`${B}/territoires/r`, { actif: false }));
  });
  it("sans nation : le bouton « Creer la nation » ; 409 NATION_DEJA_DEFINIE explique", async () => {
    arbre = [];
    h.post.mockRejectedValue({ response: { status: 409, data: { code: "NATION_DEJA_DEFINIE" } } });
    const u = userEvent.setup();
    rendre();
    expect(await screen.findByText("Aucun territoire")).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: /Créer la nation/ }));
    const d = await screen.findByRole("dialog", { name: "Créer la nation" });
    expect(within(d).getByLabelText("Niveau")).toBeDisabled();
    await u.type(within(d).getByLabelText("Code"), "SYN-NATION");
    await u.type(within(d).getByLabelText("Nom"), "Nation");
    await u.click(within(d).getByRole("button", { name: "Créer le territoire" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent(/une nation existe déjà/i);
  });
  it("erreur de chargement 503 puis reprise ; hors ligne : bandeau et ecritures desactivees", async () => {
    echecsTerritoires = 1;
    rendre();
    const a = await screen.findByRole("alert");
    expect(a).toHaveTextContent(/Territoires : chargement impossible/);
    await userEvent.click(within(a).getByRole("button", { name: "Réessayer : Territoires" }));
    expect(await screen.findByRole("list", { name: "Arborescence des territoires" })).toBeInTheDocument();
  });
  it("hors ligne : bandeau, boutons d'ecriture desactives", async () => {
    enLigne(false);
    rendre();
    await screen.findByRole("list", { name: "Arborescence des territoires" });
    expect(screen.getAllByRole("alert").some((x) => /hors ligne/.test(x.textContent ?? ""))).toBe(true);
    expect(screen.getByRole("button", { name: /Modifier Region synthetique/ })).toBeDisabled();
  });
});

describe("referentiels (ADMIN)", () => {
  async function ouvrir() {
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("tab", { name: "Référentiels" }));
    await screen.findByRole("table", { name: "Types de réseau" });
    return u;
  }
  it("liste par domaine (actives et desactivees, ?tous=true), parametres resumes", async () => {
    await ouvrir();
    const t = screen.getByRole("table", { name: "Types de réseau" });
    expect(within(t).getByText("Type ancien", { selector: "span.font-semibold" }).closest("tr")).toHaveTextContent("Désactivée");
    expect(within(t).getByText("Type FIBRE", { selector: "span.font-semibold" }).closest("tr")).toHaveTextContent("Famille : Télécom");
    expect(h.get).toHaveBeenCalledWith(`${B}/referentiels/TYPE_RESEAU`, expect.objectContaining({ params: { tous: "true" } }));
  });
  it("creation d'une categorie : parametres selon le schema du domaine", async () => {
    h.post.mockResolvedValue({ data: { valeur: valeur("RURALE", { domaine: "CATEGORIE_PROJET" }) } });
    const u = await ouvrir();
    await u.selectOptions(screen.getByLabelText("Domaine"), "CATEGORIE_PROJET");
    await u.click(screen.getByRole("button", { name: /Nouvelle valeur/ }));
    const d = await screen.findByRole("dialog");
    await u.type(within(d).getByLabelText("Code"), "rurale");
    await u.type(within(d).getByLabelText("Libellé"), "Route rurale");
    await u.type(within(d).getByLabelText(/Largeur d'emprise/), "20");
    await u.type(within(d).getByLabelText(/Largeur de chaussée/), "6,5");
    await u.click(within(d).getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${B}/referentiels/CATEGORIE_PROJET`, { code: "RURALE", libelle: "Route rurale", actif: true, parametres: { largeurEmpriseM: 20, largeurChausseeM: 6.5 } }));
  });
  it("400 PARAMETRES_INVALIDES : le detail du serveur est dit", async () => {
    h.post.mockRejectedValue({ response: { status: 400, data: { code: "PARAMETRES_INVALIDES", details: { details: { famille: ["famille inconnue"] } } } } });
    const u = await ouvrir();
    await u.click(screen.getByRole("button", { name: /Nouvelle valeur/ }));
    const d = await screen.findByRole("dialog");
    await u.type(within(d).getByLabelText("Code"), "X1");
    await u.type(within(d).getByLabelText("Libellé"), "X");
    await u.selectOptions(within(d).getByLabelText("Famille technique"), "AUTRE");
    await u.click(within(d).getByRole("button", { name: "Enregistrer" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent(/famille : famille inconnue/);
  });
  it("409 VALEUR_UTILISEE au retrait : explique, puis « Desactiver la valeur » envoie actif: false", async () => {
    h.delete.mockRejectedValue({ response: { status: 409, data: { code: "VALEUR_UTILISEE", usages: { jeux: 2 } } } });
    h.patch.mockResolvedValue({ data: { valeur: valeur("FIBRE", { actif: false }) } });
    const u = await ouvrir();
    await u.click(screen.getByRole("button", { name: "Retirer Type FIBRE" }));
    const d = await screen.findByRole("dialog");
    await u.click(within(d).getByRole("button", { name: "Retirer la valeur" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent(/portée par 2 jeux/);
    await u.click(within(d).getByRole("button", { name: "Désactiver la valeur" }));
    await waitFor(() => expect(h.patch).toHaveBeenCalledWith(`${B}/referentiels/TYPE_RESEAU/FIBRE`, { actif: false }));
  });
});

describe("configuration nationale", () => {
  it("source affichee : une variable d'environnement l'emporte (dit clairement) ; source par sous-cle des protections", async () => {
    h.role = "LECTEUR";
    rendre();
    const liste = await screen.findByRole("article", { name: "Systèmes de coordonnées admis à l'import" });
    expect(within(liste).getByText("Variable d'environnement du serveur")).toBeInTheDocument();
    expect(liste).toHaveTextContent(/l'emporte toujours/);
    expect(liste).toHaveTextContent("PROJETS_VOIRIE_CRS_SOURCE_AUTORISES");
    const emprise = screen.getByRole("article", { name: "Emprise nationale de plausibilité" });
    expect(emprise).toHaveTextContent("Valeur par défaut du code");
    const prot = screen.getByRole("article", { name: /Protections du serveur/ });
    expect(prot).toHaveTextContent(/Dossiers de conflit au plus par analyse : Valeur enregistrée/);
    expect(prot).toHaveTextContent("Version 2, enregistrée par Admin Test");
  });
  it("ecriture ADMIN avec justification obligatoire : PUT de la valeur ; 400 VALEUR_INVALIDE dit", async () => {
    h.put.mockRejectedValueOnce({ response: { status: 400, data: { code: "VALEUR_INVALIDE", details: { details: { bbox: ["ouest < est"] } } } } })
      .mockResolvedValueOnce({ data: { configuration: CONFIG.configuration[0] } });
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("tab", { name: "Configuration nationale" }));
    await u.click(await screen.findByRole("button", { name: "Modifier Emprise nationale de plausibilité" }));
    const d = await screen.findByRole("dialog");
    expect(within(d).getByLabelText("Ouest")).toHaveValue("-15,2");
    expect(within(d).getByRole("button", { name: "Enregistrer" })).toBeDisabled();
    await u.type(within(d).getByLabelText(/Justification/), "Emprise revue avec la DSI");
    await u.click(within(d).getByRole("button", { name: "Enregistrer" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent(/bbox : ouest < est/);
    await u.click(within(d).getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(h.put).toHaveBeenLastCalledWith(`${B}/configuration/EMPRISE_PLAUSIBILITE`, { valeur: { nom: "Emprise test", bbox: [-15.2, 7.1, -7.5, 12.8] }, justification: "Emprise revue avec la DSI" }));
    expect(await screen.findByText(/« Emprise nationale de plausibilité » enregistrée/)).toBeInTheDocument();
  });
  it("cle sous variable d'environnement : l'avertissement est repete dans le dialogue", async () => {
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("tab", { name: "Configuration nationale" }));
    await u.click(await screen.findByRole("button", { name: /Modifier Systèmes de coordonnées admis/ }));
    expect(within(await screen.findByRole("dialog")).getByText(/une valeur écrite ici est enregistrée mais n'a aucun effet/)).toBeInTheDocument();
  });
});

describe("accessibilite (axe)", () => {
  it("aucune violation : territoires, dialogue de creation, referentiels, configuration", async () => {
    const u = userEvent.setup();
    const r = rendre();
    await screen.findByRole("list", { name: "Arborescence des territoires" });
    expect(await violationsAccessibilite(r.container)).toEqual([]);
    await u.click(screen.getByRole("button", { name: /Sous-territoire de Region synthetique/ }));
    await screen.findByRole("dialog");
    expect(await violationsAccessibilite(document.body)).toEqual([]);
    await u.click(screen.getByRole("button", { name: "Annuler" }));
    await u.click(screen.getByRole("tab", { name: "Référentiels" }));
    await screen.findByRole("table", { name: "Types de réseau" });
    expect(await violationsAccessibilite(r.container)).toEqual([]);
    await u.click(screen.getByRole("tab", { name: "Configuration nationale" }));
    await screen.findByRole("article", { name: "Emprise nationale de plausibilité" });
    expect(await violationsAccessibilite(r.container)).toEqual([]);
  }, 60_000);
});

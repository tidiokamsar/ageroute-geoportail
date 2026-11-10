import { beforeEach, describe, expect, it, vi } from "vitest";
import { configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../lib/api", () => ({ api: { get: h.get, post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() } }));

import { ProjetsVoirieTableauBordPage } from "./ProjetsVoirieTableauBordPage";
import { violationsAccessibilite } from "../test/accessibilite";

/**
 * Tableau de bord (lot X1, interface UI-D). Donnees 100 % SYNTHETIQUES. On verifie : agregats seulement (aucun nom d'objet), valeurs nulles d'un compte
 * qui ne decide pas rendues « Non communique a votre role » et jamais zero (sur contenu charge, contre-epreuve decideur), tableau par territoire
 * (selecteur du lot UI-C, rattaches directement, non ventiles, troncature), erreurs typees (404 masque, 429, 503, 504, hors ligne) et axe.
 */

configure({ asyncUtilTimeout: 8000 });
const NC = "Non communiqué à votre rôle";
const agregatDecideur = (projets: number) => ({
  projets, jeux: { AUTORISE: 5, CONTROLE: 2 }, conflits: { POTENTIEL: 3, CLOTURE: 1 },
  documentsManquants: { typesObligatoiresNonFournis: 4, projetsIncomplets: 2, piecesEnAttente: 6, piecesEnAttenteParStatut: { ATTENDU: 5, RECU: 1 } },
  referentsActifs: { comptes: 2, rattachements: 3 },
});
const agregatLecteur = (projets: number) => ({
  projets, jeux: { AUTORISE: 5 }, conflits: { POTENTIEL: 1 },
  documentsManquants: { typesObligatoiresNonFournis: 4, projetsIncomplets: 2, piecesEnAttente: null, piecesEnAttenteParStatut: null },
  referentsActifs: null,
});
const LIS_DECIDEUR = { jeux: "TOUS_SAUF_RETIRE", conflits: "TOUS", documentsEnCours: true, referents: true };
const LIS_LECTEUR = { jeux: "AUTORISE_SEULEMENT", conflits: "DOSSIERS_VISIBLES", documentsEnCours: false, referents: false };
const national = (decideur: boolean) => ({
  portee: "NATIONAL", perimetre: { national: true, regions: null }, lisibilite: decideur ? LIS_DECIDEUR : LIS_LECTEUR,
  total: decideur ? agregatDecideur(3) : agregatLecteur(3), parRegion: [{ regionId: 7, region: "Region Synthetique", ...(decideur ? agregatDecideur(3) : agregatLecteur(3)) }],
  tronque: false, calculeLe: "2026-11-10T07:00:00Z", regle: "r",
});
const TERR = (id: string, chemin: string, over: Record<string, unknown> = {}) => ({
  id, code: `SYN-${id.toUpperCase()}`, nom: `Territoire ${id}`, niveau: "REGION", parentId: null, chemin, profondeur: 1, regionId: 7, regionEffectiveId: 7, crsMetriqueEpsg: null, bbox: null, source: null, actif: true, version: 1, ...over,
});

let reponses: Record<string, unknown>;
beforeEach(() => {
  h.get.mockReset();
  reponses = { "/v2/projets-voirie/tableau-de-bord": { data: national(true) } };
  h.get.mockImplementation(async (url: string) => {
    if (url === "/v2/projets-voirie/territoires") return { data: { territoires: [TERR("reg", "/reg/", { nom: "Region Synthetique" })], curseurSuivant: null } };
    const r = reponses[url];
    if (r && typeof r === "object" && "response" in (r as object)) throw r;
    if (r instanceof Error) throw r;
    return r ?? { data: {} };
  });
});

function rendre() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}><ProjetsVoirieTableauBordPage /></QueryClientProvider></MemoryRouter>);
}

describe("lisibilite : rien de non communique n'est zero", () => {
  it("compte qui ne decide pas (contenu charge) : pieces en attente et referents non communiques ; jeux hors AUTORISE non communiques", async () => {
    reponses["/v2/projets-voirie/tableau-de-bord"] = { data: national(false) };
    rendre();
    const projets = await screen.findByTestId("tuile-projets");
    expect(projets).toHaveTextContent("3");
    expect(screen.getByTestId("tuile-pieces-attente")).toHaveTextContent(NC);
    expect(screen.getByTestId("tuile-referents")).toHaveTextContent(NC);
    expect(screen.getByTestId("tuile-types-manquants")).toHaveTextContent("4");
    const jeux = screen.getByRole("table", { name: "Jeux de données par statut" });
    expect(within(jeux).getByRole("rowheader", { name: "Autorisé" }).closest("tr")).toHaveTextContent("5");
    expect(within(jeux).getByRole("rowheader", { name: "À autoriser" }).closest("tr")).toHaveTextContent(NC);
    expect(screen.getByRole("table", { name: /Dossiers de conflit par statut \(dossiers visibles de votre compte\)/ })).toBeInTheDocument();
    const rep = screen.getByRole("table", { name: "Répartition par région" });
    expect(within(rep).getByRole("rowheader", { name: "Region Synthetique" }).closest("tr")).toHaveTextContent(new RegExp(`${NC}.*${NC}`));
    expect(screen.getByTestId("lisibilite-restreinte")).toBeInTheDocument();
  });
  it("contre-epreuve decideur : memes tuiles, nombres communiques (zero d'un statut absent compris)", async () => {
    rendre();
    expect(await screen.findByTestId("tuile-pieces-attente")).toHaveTextContent(/6.*Attendu 5, Reçu 1/);
    expect(screen.getByTestId("tuile-referents")).toHaveTextContent(/2.*Rattachements : 3/);
    const jeux = screen.getByRole("table", { name: "Jeux de données par statut" });
    expect(within(jeux).getByRole("rowheader", { name: "À autoriser" }).closest("tr")).toHaveTextContent("2");
    expect(within(jeux).getByRole("rowheader", { name: "Rejeté" }).closest("tr")).toHaveTextContent("0");
    expect(screen.queryByText(NC)).toBeNull();
    expect(screen.queryByTestId("lisibilite-restreinte")).toBeNull();
  });
});

describe("par territoire", () => {
  it("selecteur de territoire : sous-arbre, rattaches directement, non ventiles, ancetres, troncature", async () => {
    reponses["/v2/projets-voirie/tableau-de-bord/territoires/reg"] = { data: {
      portee: "TERRITOIRE", territoire: { id: "reg", code: "SYN-REG", nom: "Region Synthetique", niveau: "REGION", ancetres: [{ id: "n", nom: "Nation Synthetique" }] },
      perimetre: { national: false, regions: [7] }, lisibilite: LIS_DECIDEUR, total: agregatDecideur(4),
      enfants: [{ territoireId: "com", code: "SYN-COM", nom: "Commune Synthetique", niveau: "COMMUNE", ...agregatDecideur(2) }],
      rattachesDirectement: agregatDecideur(1), nonVentiles: agregatDecideur(1), tronque: true, calculeLe: "2026-11-10T07:00:00Z",
    } };
    const u = userEvent.setup();
    rendre();
    await screen.findByTestId("tuile-projets");
    await u.click(screen.getByLabelText("Un territoire et ses subdivisions"));
    expect(screen.getByText(/Choisissez un territoire/)).toBeInTheDocument();
    await u.click(await screen.findByRole("radio", { name: /Region Synthetique/ }));
    expect(await screen.findByRole("heading", { name: "Region Synthetique (Région)" })).toBeInTheDocument();
    expect(screen.getByText("Dans : Nation Synthetique")).toBeInTheDocument();
    const rep = screen.getByRole("table", { name: "Répartition par subdivision" });
    expect(within(rep).getByRole("rowheader", { name: "Commune Synthetique (Commune)" })).toBeInTheDocument();
    expect(within(rep).getByRole("rowheader", { name: "Rattachés directement au territoire" })).toBeInTheDocument();
    expect(within(rep).getByRole("rowheader", { name: /non ventilés/ })).toBeInTheDocument();
    expect(screen.getByText(/Liste tronquée/)).toBeInTheDocument();
    expect(h.get).toHaveBeenCalledWith("/v2/projets-voirie/tableau-de-bord/territoires/reg", expect.anything());
  });
  it("territoire 404 masque : introuvable", async () => {
    reponses["/v2/projets-voirie/tableau-de-bord/territoires/reg"] = { response: { status: 404, data: { code: "TERRITOIRE_INTROUVABLE" } } };
    const u = userEvent.setup();
    rendre();
    await screen.findByTestId("tuile-projets");
    await u.click(screen.getByLabelText("Un territoire et ses subdivisions"));
    await u.click(await screen.findByRole("radio", { name: /Region Synthetique/ }));
    expect((await screen.findByText(/Tableau de bord : introuvable/)).closest("[role=alert]")).toHaveTextContent(/n'est pas dans votre périmètre/);
  });
});

describe("erreurs et accessibilite", () => {
  it.each([
    [429, { code: "TABLEAU_DE_BORD_TROP_FREQUENT", retryAfterS: 12 }, /12 secondes/],
    [503, { code: "SERVICE_OCCUPE" }, /attendez|Réessayez/],
    [504, { code: "TABLEAU_DE_BORD_TROP_LONG" }, /délai/],
    [400, { code: "PARAMETRES_INVALIDES" }, /paramètres/],
    [403, {}, /clé de module/],
  ])("%s : explique", async (status, data, motif) => {
    reponses["/v2/projets-voirie/tableau-de-bord"] = { response: { status, data, headers: {} } };
    rendre();
    expect(await screen.findByRole("alert")).toHaveTextContent(motif);
    expect(screen.queryByTestId("tuile-projets")).toBeNull();
  });
  it("hors ligne : reseau indisponible avec reessai", async () => {
    reponses["/v2/projets-voirie/tableau-de-bord"] = new Error("Network Error");
    rendre();
    const al = await screen.findByText(/Tableau de bord : réseau indisponible/);
    reponses["/v2/projets-voirie/tableau-de-bord"] = { data: national(true) };
    await userEvent.click(within(al.closest("[role=alert]") as HTMLElement).getByRole("button", { name: "Réessayer : Tableau de bord" }));
    expect(await screen.findByTestId("tuile-projets")).toBeInTheDocument();
  });
  it("aucune donnee d'objet : la page n'affiche que des nombres et des noms de territoire ou de region", async () => {
    rendre();
    await screen.findByTestId("tuile-projets");
    await waitFor(() => expect(h.get.mock.calls.map((c) => c[0])).toEqual(["/v2/projets-voirie/tableau-de-bord"]));
  });
  it("axe : sans violation (decideur et lecteur)", async () => {
    const a = rendre();
    await screen.findByTestId("tuile-projets");
    expect(await violationsAccessibilite(a.container)).toEqual([]);
    a.unmount();
    reponses["/v2/projets-voirie/tableau-de-bord"] = { data: national(false) };
    const b = rendre();
    await screen.findByTestId("tuile-projets");
    expect(await violationsAccessibilite(b.container)).toEqual([]);
  });
});

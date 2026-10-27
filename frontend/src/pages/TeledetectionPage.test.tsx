import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { CarteObservationTerreProps } from "../components/observation-terre/types";

/**
 * Ecran Observation de la Terre, de bout en bout (API simulee, carte remplacee par une doublure).
 *
 * Ce que ces tests defendent :
 *   - l'ecran dit qu'une detection est une proposition, et qu'un compteur en erreur n'est pas 0 ;
 *   - chaque panneau tombe en panne SEPAREMENT (la liste vit si les sources echouent, et inversement) ;
 *   - les droits : « État des sources » et « Verifier » pour ADMIN seulement, decisions pour
 *     ADMIN et GESTIONNAIRE, et le serveur reste juge ;
 *   - la carte recoit le contrat convenu (zoom suffisant, selection, cadrage) et la selection circule
 *     entre carte, liste et detail ;
 *   - toutes les donnees ici sont SYNTHETIQUES (synthetique: true), jamais des constantes de l'interface.
 */

const h = vi.hoisted(() => ({
  role: "GESTIONNAIRE",
  get: vi.fn(),
  post: vi.fn(),
  /** Ce que la doublure de carte annonce au bouton « Annoncer l'emprise » (la vraie carte le fait apres 300 ms et seulement si la vue sort de l'emprise chargee). */
  carteLeve: false,
  annonce: { bbox: [-14.0004, 9.0004, -13, 10] as [number, number, number, number], zoom: 10 },
}));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u", role: h.role } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/api", () => ({ api: { get: h.get, post: h.post } }));
// Leaflet exige un vrai moteur de rendu : la doublure expose les proprietes recues et quelques gestes.
vi.mock("../components/observation-terre/CarteObservationTerre", () => ({
  CarteObservationTerre: (p: CarteObservationTerreProps) => {
    // Ce que fait Leaflet sur un GeoJSON invalide : lever pendant le rendu.
    if (h.carteLeve) throw new Error("Invalid GeoJSON object.");
    return (
    <div
      data-testid="carte" data-zoom-suffisant={String(p.zoomSuffisant)} data-selection={p.selectionId ?? ""} data-erreur={p.erreur ?? ""}
      data-nb={p.propositions?.features.length ?? "null"} data-focus={p.focus ? p.focus.bbox.join(",") : ""}
      data-troncature={p.troncature === undefined ? "absente" : p.troncature === null ? "null" : `${p.troncature.tronque}/${p.troncature.total}`}
    >
      <button type="button" onClick={() => p.onEmpriseChange([-14.0004, 9.0004, -13, 10], 10)}>Cadrer zoom 10</button>
      <button type="button" onClick={() => p.onEmpriseChange([-17, 7, -8, 13], 5)}>Cadrer zoom 5</button>
      <button type="button" onClick={() => p.onEmpriseChange(h.annonce.bbox, h.annonce.zoom)}>Annoncer l&apos;emprise</button>
      <button type="button" onClick={() => p.onSelect("p-77")}>Choisir p-77 sur la carte</button>
      <button type="button" onClick={() => p.onSelect("p-78")}>Choisir p-78 sur la carte</button>
      <button type="button" onClick={() => p.onSelect(null)}>Cliquer le fond de la carte</button>
      <button type="button" onClick={() => p.onCouchesChange({ ...p.couches, propositions: false })}>Masquer les propositions</button>
    </div>
    );
  },
}));

import { TeledetectionPage } from "./TeledetectionPage";
import { ZOOM_MINIMUM_PROPOSITIONS } from "../lib/teledetectionCarte";
import { detail, echec, page, proposition, routeurGet, source, synthese } from "../components/observation-terre/synthetique.testutil";

const URL_SYN = "/v2/teledetection/synthese";
const URL_LISTE = "/v2/teledetection/propositions";
const URL_GEO = "/v2/teledetection/propositions.geojson";
const URL_SRC = "/v2/teledetection/sources";
const URL_QUALITE = "/v2/teledetection/qualite-methodes";

const GEO = { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [-13.5, 9.5] }, properties: { id: "p-1", type: "INONDATION", statut: "A_VERIFIER", priorite: "HAUTE", rattachee: true } }] };

let table: Record<string, unknown>;

function rendre() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}><TeledetectionPage /></QueryClientProvider></MemoryRouter>);
}
const appels = (url: string) => h.get.mock.calls.filter((c) => c[0] === url).map((c) => (c[1]?.params ?? {}) as Record<string, unknown>);
const carte = () => screen.getByTestId("carte");

beforeEach(() => {
  h.role = "GESTIONNAIRE";
  h.get.mockReset(); h.post.mockReset();
  h.annonce = { bbox: [-14.0004, 9.0004, -13, 10], zoom: 10 };
  h.carteLeve = false;
  table = {
    [URL_SYN]: synthese(),
    [URL_LISTE]: page([proposition(), proposition({ id: "p-2", type: "VEGETATION", rattachee: false, troncon: null, rattachement: { confiance: "AUCUN", distanceM: null, algorithme: "a" } })]),
    [URL_GEO]: GEO,
    [URL_SRC]: [source({ code: "SRC-A", nom: "Source A" }), source({ code: "SRC-B", nom: "Source B", etat: "ACCESSIBLE" })],
    "/regions": [{ id: 1, nom: "Conakry" }],
    [URL_QUALITE]: { seuilEchantillon: 30, definition: "d", lignes: [{ type: "INONDATION", methode: "seuil-sar v0", methodeNom: "seuil-sar", methodeVersion: "0", total: 5, aVerifier: 3, enAttente: 0, nonConcluantes: 0, confirmees: 1, infirmees: 1, jugees: 2, tauxConfirmation: 0.5, echantillonSuffisant: false, seuilEchantillon: 30 }] },
    "/v2/teledetection/propositions/p-1": detail(),
    "/v2/teledetection/propositions/p-77": detail({ id: "p-77", type: "COUPURE_PROBABLE" }),
    "/v2/teledetection/propositions/p-78": detail({ id: "p-78", type: "VEGETATION" }),
  };
  h.get.mockImplementation((url: string, c?: unknown) => routeurGet(table)(url, c as never));
  h.post.mockResolvedValue({ data: {} });
});

describe("ecran Observation de la Terre : contenu", () => {
  it("titre, sous-titre, et la regle : une detection est une proposition, jamais une donnee officielle", async () => {
    rendre();
    expect(screen.getByRole("heading", { level: 1, name: "Observation de la Terre" })).toBeInTheDocument();
    expect(screen.getByText("Imagerie satellite et détection de changements sur le réseau routier")).toBeInTheDocument();
    expect(screen.getByText(/jamais des données officielles/)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Inondation/ }, { timeout: 10_000 })).toBeInTheDocument();
  });

  it("rend les indicateurs, la liste, le taux, les sources et la carte", async () => {
    rendre();
    await screen.findByRole("button", { name: /Inondation/ });
    expect(screen.getByRole("region", { name: "Indicateurs de synthèse" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Propositions/ })).toHaveTextContent("(2)");
    expect(screen.getByRole("heading", { name: "Taux de confirmation terrain" })).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: /Sources d'observation/ })).toBeInTheDocument();
    expect(carte()).toBeInTheDocument();
    expect(screen.getByText("Anomalie non rattachée")).toBeInTheDocument();
  });

  it("sans selection : le detail dit qu'il attend un choix, il n'invente rien", async () => {
    rendre();
    expect(await screen.findByText("Aucune proposition sélectionnée")).toBeInTheDocument();
  });
});

describe("droits d'affichage (le serveur decide)", () => {
  it("ADMIN : « État des sources » et « Verifier » sont visibles", async () => {
    h.role = "ADMIN";
    rendre();
    expect(screen.getByRole("button", { name: "État des sources" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Vérifier la source Source A" })).toBeInTheDocument();
  });

  it.each(["GESTIONNAIRE", "INSPECTEUR", "LECTEUR"])("%s : ni « État des sources » ni « Verifier »", async (role) => {
    h.role = role;
    rendre();
    await screen.findByRole("table", { name: /Sources d'observation/ });
    expect(screen.queryByRole("button", { name: "État des sources" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Vérifier la source/ })).not.toBeInTheDocument();
  });

  it("« État des sources » amene au tableau des sources (focus) ; le bouton ne promet plus une configuration qu'il ne fait pas", async () => {
    h.role = "ADMIN";
    const u = userEvent.setup();
    rendre();
    await screen.findByRole("table", { name: /Sources d'observation/ });
    expect(screen.queryByRole("button", { name: /Configurer/ })).not.toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "État des sources" }));
    expect(screen.getByRole("heading", { name: "Sources d'observation" })).toHaveFocus();
  });

  it("un LECTEUR ouvre le detail mais ne voit aucune decision", async () => {
    h.role = "LECTEUR";
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: /Inondation/ }));
    expect(await screen.findByText(/Consultation seule/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Confirmer la proposition/ })).not.toBeInTheDocument();
  });
});

describe("selection : liste, detail et carte", () => {
  it("choisir une ligne ouvre le detail, selectionne sur la carte et cadre la carte sur la proposition", async () => {
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: /Inondation/ }));
    expect(await screen.findByRole("heading", { name: "Détail de la proposition" })).toBeInTheDocument();
    await screen.findByText("Indicateurs de qualité");
    expect(carte()).toHaveAttribute("data-selection", "p-1");
    expect(carte()).toHaveAttribute("data-focus", "-13.61,9.59,-13.59,9.61");
    expect(h.get.mock.calls.filter((c) => c[0] === "/v2/teledetection/propositions/p-1")).toHaveLength(1);
  });

  it("choisir une proposition sur la carte charge son detail meme si elle n'est pas dans la liste", async () => {
    const u = userEvent.setup();
    rendre();
    await screen.findByRole("button", { name: /Inondation/ });
    await u.click(screen.getByRole("button", { name: "Choisir p-77 sur la carte" }));
    expect(await screen.findByText("Coupure probable", { selector: "p" })).toBeInTheDocument();
    expect(carte()).toHaveAttribute("data-selection", "p-77");
  });

  it("« Retour à la liste » ferme le detail et deselectionne la carte", async () => {
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: /Inondation/ }));
    await screen.findByText("Indicateurs de qualité");
    await u.click(screen.getByRole("button", { name: "Retour à la liste" }));
    expect(await screen.findByText("Aucune proposition sélectionnée")).toBeInTheDocument();
    expect(carte()).toHaveAttribute("data-selection", "");
  });

  it("detail 404 : message clair dans le panneau, la liste reste utilisable", async () => {
    table["/v2/teledetection/propositions/p-1"] = echec(404);
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: /Inondation/ }));
    expect(await screen.findByText(/introuvable ou hors de votre périmètre/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Végétation/ })).toBeInTheDocument();
  });
});

describe("carte : contrat d'interface", () => {
  it("zoom suffisant : interroge le geojson avec la bbox arrondie et le statut de l'onglet", async () => {
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: "Cadrer zoom 10" }));
    await waitFor(() => expect(appels(URL_GEO)).toHaveLength(1), { timeout: 5000 });
    expect(appels(URL_GEO)[0]).toEqual({ bbox: "-14,9,-13,10", statut: "A_VERIFIER" });
    await waitFor(() => expect(carte()).toHaveAttribute("data-nb", "1"));
    expect(carte()).toHaveAttribute("data-zoom-suffisant", "true");
  });

  it("zoom insuffisant : aucune requete d'emprise, et la carte est prevenue (zoomSuffisant = false)", async () => {
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: "Cadrer zoom 5" }));
    await waitFor(() => expect(carte()).toHaveAttribute("data-zoom-suffisant", "false"));
    await new Promise((r) => setTimeout(r, 600));
    expect(appels(URL_GEO)).toHaveLength(0);
    expect(carte()).toHaveAttribute("data-nb", "null");
  });

  it("couche « propositions » desactivee : aucune requete", async () => {
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: "Masquer les propositions" }));
    await u.click(screen.getByRole("button", { name: "Cadrer zoom 10" }));
    await new Promise((r) => setTimeout(r, 600));
    expect(appels(URL_GEO)).toHaveLength(0);
  });

  it("changer d'onglet change le statut demande a la carte", async () => {
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: "Cadrer zoom 10" }));
    await waitFor(() => expect(appels(URL_GEO)).toHaveLength(1), { timeout: 5000 });
    await u.click(screen.getByRole("tab", { name: /Confirmées/ }));
    await waitFor(() => expect(appels(URL_GEO).at(-1)).toMatchObject({ statut: "CONFIRMEE" }), { timeout: 5000 });
  });

  it("erreur du geojson : transmise a la carte (jamais une carte vide silencieuse), la liste n'est pas touchee", async () => {
    table[URL_GEO] = echec(500, "Emprise trop large");
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: "Cadrer zoom 10" }));
    await waitFor(() => expect(carte().getAttribute("data-erreur")).toContain("Emprise trop large"), { timeout: 8000 });
    expect(screen.getByRole("button", { name: /Inondation/ })).toBeInTheDocument();
  });
});

describe("carte : zoom minimal, une seule source de verite (celle de la carte)", () => {
  it.each([
    ["le zoom minimal exact de la carte", ZOOM_MINIMUM_PROPOSITIONS, true],
    ["un cran en dessous", ZOOM_MINIMUM_PROPOSITIONS - 1, false],
  ])("%s : la requete d'emprise part seulement si le zoom suffit", async (_nom, zoom, partira) => {
    h.annonce = { bbox: [-14, 9, -13, 10], zoom };
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: "Annoncer l'emprise" }));
    await waitFor(() => expect(carte()).toHaveAttribute("data-zoom-suffisant", String(partira)));
    if (partira) await waitFor(() => expect(appels(URL_GEO)).toHaveLength(1), { timeout: 5000 });
    else { await new Promise((r) => setTimeout(r, 700)); expect(appels(URL_GEO)).toHaveLength(0); }
  });

  it("zoom suffisant mais emprise plus large que le maximum de la carte : pas de requete, la carte est prevenue", async () => {
    h.annonce = { bbox: [-20, 7, -8, 13], zoom: ZOOM_MINIMUM_PROPOSITIONS + 1 }; // 12 degres de large : au-dela de la borne (10)
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: "Annoncer l'emprise" }));
    await waitFor(() => expect(carte()).toHaveAttribute("data-zoom-suffisant", "false"));
    await new Promise((r) => setTimeout(r, 700));
    expect(appels(URL_GEO)).toHaveLength(0);
  });
});

describe("carte : troncature du geojson (contrat §5)", () => {
  it("tronque et total remontent jusqu'a la carte", async () => {
    table[URL_GEO] = { ...GEO, tronque: true, total: 412 };
    const u = userEvent.setup();
    rendre();
    expect(carte()).toHaveAttribute("data-troncature", "null");
    await u.click(await screen.findByRole("button", { name: "Cadrer zoom 10" }));
    await waitFor(() => expect(carte()).toHaveAttribute("data-troncature", "true/412"), { timeout: 5000 });
  });

  it("reponse complete : tronque=false est transmis tel quel ; serveur muet : null, jamais une troncature inventee", async () => {
    table[URL_GEO] = { ...GEO, tronque: false, total: 1 };
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: "Cadrer zoom 10" }));
    await waitFor(() => expect(carte()).toHaveAttribute("data-troncature", "false/1"), { timeout: 5000 });
  });

  it("reponse sans membres tronque/total (serveur ancien) : null", async () => {
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: "Cadrer zoom 10" }));
    await waitFor(() => expect(carte()).toHaveAttribute("data-nb", "1"), { timeout: 5000 });
    expect(carte()).toHaveAttribute("data-troncature", "null");
  });
});

describe("carte : onEmpriseChange n'est pas appele a chaque deplacement", () => {
  it("la bbox annoncee est arrondie : c'est la cle de la requete ; deux annonces qui arrondissent pareil = une seule requete", async () => {
    const u = userEvent.setup();
    rendre();
    h.annonce = { bbox: [-14.0004, 9.0004, -13, 10], zoom: 10 };
    await u.click(await screen.findByRole("button", { name: "Annoncer l'emprise" }));
    await waitFor(() => expect(appels(URL_GEO)).toHaveLength(1), { timeout: 5000 });
    expect(appels(URL_GEO)[0].bbox).toBe("-14,9,-13,10");
    h.annonce = { bbox: [-14.0003, 9.0001, -13.0004, 10.0004], zoom: 10 };
    await u.click(screen.getByRole("button", { name: "Annoncer l'emprise" }));
    await new Promise((r) => setTimeout(r, 700));
    expect(appels(URL_GEO)).toHaveLength(1);
  });

  it("une emprise differente relance la requete avec la nouvelle bbox", async () => {
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: "Annoncer l'emprise" }));
    await waitFor(() => expect(appels(URL_GEO)).toHaveLength(1), { timeout: 5000 });
    h.annonce = { bbox: [-13, 9, -12, 10], zoom: 10 };
    await u.click(screen.getByRole("button", { name: "Annoncer l'emprise" }));
    await waitFor(() => expect(appels(URL_GEO)).toHaveLength(2), { timeout: 5000 });
    expect(appels(URL_GEO)[1].bbox).toBe("-13,9,-12,10");
  });

  it("un changement d'onglet ou de filtre rejoue la DERNIERE emprise annoncee, sans nouvel appel de la carte", async () => {
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: "Annoncer l'emprise" }));
    await waitFor(() => expect(appels(URL_GEO)).toHaveLength(1), { timeout: 5000 });
    await u.click(screen.getByRole("tab", { name: /Confirmées/ }));
    await waitFor(() => expect(appels(URL_GEO)).toHaveLength(2), { timeout: 5000 });
    expect(appels(URL_GEO)[1]).toEqual({ bbox: "-14,9,-13,10", statut: "CONFIRMEE" });
  });

  it("« Reessayer » de la carte (meme emprise redemandee) relance la requete en echec ; sans echec, elle ne fait rien de plus", async () => {
    let panne = true;
    table[URL_GEO] = () => (panne ? echec(500, "Panne geojson") : GEO);
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: "Annoncer l'emprise" }));
    await waitFor(() => expect(carte().getAttribute("data-erreur")).toContain("Panne geojson"), { timeout: 8000 });
    const avant = appels(URL_GEO).length;
    panne = false;
    await u.click(screen.getByRole("button", { name: "Annoncer l'emprise" }));
    await waitFor(() => expect(carte()).toHaveAttribute("data-nb", "1"), { timeout: 5000 });
    expect(carte()).toHaveAttribute("data-erreur", "");
    expect(appels(URL_GEO).length).toBe(avant + 1);
    // Reessayer alors que tout va bien : aucune requete superflue.
    await u.click(screen.getByRole("button", { name: "Annoncer l'emprise" }));
    await new Promise((r) => setTimeout(r, 600));
    expect(appels(URL_GEO).length).toBe(avant + 1);
  });

  it("un echec sur une nouvelle emprise n'efface pas silencieusement la carte : l'erreur est transmise (la carte dit « non affichees »)", async () => {
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: "Annoncer l'emprise" }));
    await waitFor(() => expect(carte()).toHaveAttribute("data-nb", "1"), { timeout: 5000 });
    table[URL_GEO] = echec(503, "Source indisponible", "SOURCE_INDISPONIBLE");
    h.annonce = { bbox: [-13, 9, -12, 10], zoom: 10 };
    await u.click(screen.getByRole("button", { name: "Annoncer l'emprise" }));
    await waitFor(() => expect(carte().getAttribute("data-erreur")).toContain("Source indisponible"), { timeout: 8000 });
    // la liste, elle, reste intacte
    expect(screen.getByRole("button", { name: /Inondation/ })).toBeInTheDocument();
  });
});

describe("selection : marqueur, liste et detail, sans boucle de rendu", () => {
  const appelsDetail = (id: string) => h.get.mock.calls.filter((c) => c[0] === `/v2/teledetection/propositions/${id}`).length;

  it("cliquer un marqueur ouvre le detail de la proposition, sans recadrer la carte (elle est deja sur place)", async () => {
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: "Choisir p-77 sur la carte" }));
    expect(await screen.findByText("Coupure probable", { selector: "p" })).toBeInTheDocument();
    expect(carte()).toHaveAttribute("data-selection", "p-77");
    expect(carte()).toHaveAttribute("data-focus", "");
    await new Promise((r) => setTimeout(r, 500));
    expect(appelsDetail("p-77")).toBe(1);
  });

  it("selectionner depuis la liste centre la carte (focus) ; la fermeture du detail deselectionne", async () => {
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: /Inondation/ }));
    await screen.findByText("Indicateurs de qualité");
    expect(carte()).toHaveAttribute("data-focus", "-13.61,9.59,-13.59,9.61");
    await u.click(screen.getByRole("button", { name: "Fermer le détail de la proposition" }));
    expect(carte()).toHaveAttribute("data-selection", "");
    expect(await screen.findByText("Aucune proposition sélectionnée")).toBeInTheDocument();
  });

  it("un clic sur le fond de la carte ferme le detail", async () => {
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: "Choisir p-77 sur la carte" }));
    await screen.findByText("Indicateurs de qualité");
    await u.click(screen.getByRole("button", { name: "Cliquer le fond de la carte" }));
    expect(carte()).toHaveAttribute("data-selection", "");
    expect(await screen.findByText("Aucune proposition sélectionnée")).toBeInTheDocument();
  });

  it("passer d'un marqueur a l'autre change le detail, une requete par proposition, aucune relance en boucle", async () => {
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: "Choisir p-77 sur la carte" }));
    await screen.findByText("Coupure probable", { selector: "p" });
    await u.click(screen.getByRole("button", { name: "Choisir p-78 sur la carte" }));
    await screen.findByText("Végétation", { selector: "p" });
    await new Promise((r) => setTimeout(r, 600));
    expect(appelsDetail("p-77")).toBe(1);
    expect(appelsDetail("p-78")).toBe(1);
    expect(carte()).toHaveAttribute("data-selection", "p-78");
  });

  it("marqueur puis liste puis marqueur : la selection reste unique et coherente entre la carte et le detail", async () => {
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: "Choisir p-77 sur la carte" }));
    await screen.findByText("Coupure probable", { selector: "p" });
    // la liste est masquee sous 1280 px quand un detail est ouvert : on la rouvre par le retour, comme l'utilisateur
    await u.click(screen.getByRole("button", { name: "Retour à la liste" }));
    await u.click(await screen.findByRole("button", { name: /Inondation/ }));
    await screen.findByText("Indicateurs de qualité");
    expect(carte()).toHaveAttribute("data-selection", "p-1");
    await u.click(screen.getByRole("button", { name: "Choisir p-77 sur la carte" }));
    await screen.findByText("Coupure probable", { selector: "p" });
    expect(carte()).toHaveAttribute("data-selection", "p-77");
  });

  it("mobile et tablette : le detail ouvert masque la liste mais JAMAIS la carte ; la carte ne masque jamais le detail", async () => {
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: "Choisir p-77 sur la carte" }));
    const titreDetail = await screen.findByRole("heading", { name: "Détail de la proposition" });
    const sectionCarte = carte().closest("section")!;
    expect(sectionCarte.className).not.toMatch(/(^|\s)(max-xl:)?hidden(\s|$)/);
    expect(sectionCarte.parentElement!.className).not.toContain("max-xl:hidden");
    expect(titreDetail.closest("section")!.parentElement!.className).not.toContain("max-xl:hidden");
    expect(screen.getByRole("heading", { level: 2, name: /^Propositions \(/ }).closest("section")!.parentElement!.className).toContain("max-xl:hidden");
    // le detail s'affiche apres la carte dans l'ordre de lecture et de tabulation
    expect(sectionCarte.compareDocumentPosition(titreDetail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("retour a la liste apres un marqueur absent de la liste : le focus retombe sur le titre de la liste, pas dans le vide", async () => {
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: "Choisir p-77 sur la carte" }));
    await screen.findByText("Coupure probable", { selector: "p" });
    await u.click(screen.getByRole("button", { name: "Retour à la liste" }));
    expect(screen.getByRole("heading", { level: 2, name: /^Propositions \(/ })).toHaveFocus();
  });
});

describe("garde-fou : la panne de la carte ne casse pas la page", () => {
  it("si la carte leve au rendu, un message avec « Réessayer » prend sa place et le reste de la page vit", async () => {
    h.carteLeve = true;
    rendre();
    expect(await screen.findByText("La carte n'a pas pu s'afficher.", { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/Invalid GeoJSON object/)).toBeInTheDocument();
    // indicateurs, liste, sources : intacts
    expect(await screen.findByRole("button", { name: /Inondation/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Indicateurs de synthèse" })).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: /Sources d'observation/ })).toBeInTheDocument();
  });

  it("« Réessayer » remonte la carte a neuf (et remet les couches optionnelles a leur etat d'origine)", async () => {
    h.carteLeve = true;
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: "Réessayer : carte" }));
    // la doublure leve encore tant que h.carteLeve est vrai : le garde-fou reprend la main sans boucle
    expect(await screen.findByText("La carte n'a pas pu s'afficher.", { exact: false })).toBeInTheDocument();
    h.carteLeve = false;
    await u.click(screen.getByRole("button", { name: "Réessayer : carte" }));
    expect(await screen.findByTestId("carte")).toBeInTheDocument();
    expect(screen.queryByText("La carte n'a pas pu s'afficher.", { exact: false })).toBeNull();
  });
});

describe("compteurs : l'onglet et le total filtre ne se contredisent jamais sans explication", () => {
  it("compteur d'onglet different du total de la liste, sans filtre : le total filtre est dit et l'ecart est explique", async () => {
    // synthese : 5 a verifier ; liste : 2 propositions
    rendre();
    await screen.findByRole("button", { name: /Inondation/ });
    expect(await screen.findByTestId("total-filtre")).toHaveTextContent("Total filtré renvoyé par le serveur : 2");
    const ecart = await screen.findByTestId("ecart-compteurs");
    expect(ecart).toHaveTextContent("Le compteur de l'onglet « À vérifier » (5)");
    expect(ecart).toHaveTextContent("deux lectures distinctes");
  });

  it("chiffres identiques : le total filtre est dit, aucune explication superflue", async () => {
    table[URL_SYN] = synthese({ propositions: { aVerifier: 2, enAttente: 0, nonConcluantes: 0, confirmees: 0, infirmees: 0, prioritaires: 0 } });
    rendre();
    await screen.findByRole("button", { name: /Inondation/ });
    expect(await screen.findByTestId("total-filtre")).toHaveTextContent("Total filtré renvoyé par le serveur : 2");
    expect(screen.queryByTestId("ecart-compteurs")).toBeNull();
  });

  it("un filtre que la synthese ignore (type) : l'ecart est attribue a ce filtre", async () => {
    table[URL_LISTE] = (config?: { params?: Record<string, unknown> }) => (config?.params?.type === "INONDATION" ? page([proposition()]) : page([proposition(), proposition({ id: "p-2", type: "VEGETATION" })]));
    const u = userEvent.setup();
    rendre();
    await screen.findByRole("button", { name: /Inondation/ });
    await u.click(screen.getByRole("button", { name: /Filtres/ }));
    await u.selectOptions(screen.getByLabelText("Type de changement"), "INONDATION");
    await waitFor(() => expect(screen.getByTestId("total-filtre")).toHaveTextContent("Total filtré renvoyé par le serveur : 1 (filtres appliqués : type)"), { timeout: 5000 });
    expect(screen.getByTestId("ecart-compteurs")).toHaveTextContent("La liste applique en plus : type");
  });

  it("liste en erreur : aucun total n'est affiche (jamais un faux zero)", async () => {
    table[URL_LISTE] = echec(500, "Panne liste");
    rendre();
    await screen.findByText(/Propositions : chargement impossible/, undefined, { timeout: 6000 });
    expect(screen.queryByTestId("total-filtre")).toBeNull();
  });
});

describe("disposition : l'ordre du DOM est l'ordre de lecture et de tabulation (EO-FIX-FRONT 4)", () => {
  it("carte, liste, detail, taux, qualite par methode, sources : dans cet ordre, a toute largeur", async () => {
    rendre();
    await screen.findByRole("button", { name: /Inondation/ });
    await screen.findByRole("table", { name: /Sources d'observation/ });
    const dans = (el: Element) => el.closest("section") as HTMLElement;
    const ordre = [
      screen.getByRole("region", { name: "Zone cartographique" }),
      dans(screen.getByRole("heading", { name: /^Propositions/ })),
      dans(screen.getByRole("heading", { name: "Détail de la proposition" })),
      dans(screen.getByRole("heading", { name: "Taux de confirmation terrain" })),
      dans(screen.getByRole("heading", { name: "Qualité par méthode" })),
      dans(screen.getByRole("heading", { name: "Sources d'observation" })),
    ];
    for (let i = 1; i < ordre.length; i++) {
      expect(ordre[i - 1].compareDocumentPosition(ordre[i]) & Node.DOCUMENT_POSITION_FOLLOWING, `panneau ${i}`).toBeTruthy();
    }
  });

  it("aucun `order-*` ni `contents` ne separe l'ordre visuel de l'ordre du focus (le widget Taux ne devance plus la liste sous 1280 px)", async () => {
    const { container } = rendre();
    await screen.findByRole("button", { name: /Inondation/ });
    const fautifs = Array.from(container.querySelectorAll("*")).filter((e) => Array.from(e.classList).some((c) => /^(?:[\w-]+:)*(?:order-|contents$)/.test(c)));
    expect(fautifs.map((e) => e.className)).toEqual([]);
  });

  it("a partir de 1280 px les panneaux sont PLACES dans la grille (colonne et ligne explicites), donc la mise en page desktop ne depend pas de l'ordre du DOM", async () => {
    const { container } = rendre();
    await screen.findByRole("button", { name: /Inondation/ });
    const grille = Array.from(container.querySelectorAll("div")).find((d) => d.classList.contains("xl:grid")) as HTMLElement;
    expect(grille).toBeInTheDocument();
    const places = Array.from(grille.children).map((c) => c.className);
    expect(places).toHaveLength(5);
    for (const classes of places) expect(classes).toMatch(/xl:col-start-\d|xl:col-span-3/);
  });
});

describe("qualite par methode : panneau national, absence de permission pour un compte regional (EO-FIX-FRONT 8a)", () => {
  it("compte national : verdicts par methode avec effectif, a cote du taux", async () => {
    rendre();
    expect(await screen.findByRole("table", { name: /Verdicts du terrain par type de changement/ })).toBeInTheDocument();
    expect(screen.getByText("seuil-sar v0")).toBeInTheDocument();
    const ligne = screen.getByText("seuil-sar v0").closest("tr") as HTMLElement;
    expect(ligne).toHaveTextContent("50,0 % (n = 2)");
  });

  it("compte regional : 403 HORS_PERIMETRE sur /qualite-methodes -> message dedie ; le taux regional (synthese) reste affiche ; la page ne tombe pas en panne", async () => {
    table[URL_QUALITE] = echec(403, "Agrégat national", "HORS_PERIMETRE");
    rendre();
    await screen.findByRole("button", { name: /Inondation/ });
    expect(await screen.findByText(/Qualité par méthode : accès refusé/)).toBeInTheDocument();
    expect(screen.getByText(/réservé aux comptes nationaux/)).toBeInTheDocument();
    expect(screen.getByTestId("valeur-taux")).toBeInTheDocument(); // le taux de la region vient de /synthese
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("noms accessibles uniques : plusieurs panneaux en erreur ne donnent pas quatre « Reessayer » identiques (F7)", () => {
  it("indicateurs, taux, sources, liste et qualite en panne : chaque bouton de reprise dit son panneau", async () => {
    for (const u of [URL_SYN, URL_LISTE, URL_SRC, URL_QUALITE]) table[u] = echec(500, "Panne synthetique");
    rendre();
    await screen.findByText(/Sources : chargement impossible/, undefined, { timeout: 8000 });
    await screen.findByText(/Qualité par méthode : chargement impossible/, undefined, { timeout: 8000 });
    await screen.findByText(/Propositions : chargement impossible/, undefined, { timeout: 8000 });
    const noms = screen.getAllByRole("button", { name: /^Réessayer/ }).map((b) => b.getAttribute("aria-label"));
    expect(noms.length).toBeGreaterThanOrEqual(4);
    expect(new Set(noms).size).toBe(noms.length);
    for (const panneau of ["Indicateurs", "Taux de confirmation", "Sources", "Propositions", "Qualité par méthode"]) expect(noms).toContain(`Réessayer : ${panneau}`);
  });
});

describe("pannes partielles : chaque panneau a son etat", () => {
  it("sources en erreur : alerte dans le tableau, liste et indicateurs intacts", async () => {
    table[URL_SRC] = echec(500, "Panne sources");
    rendre();
    expect(await screen.findByRole("button", { name: /Inondation/ })).toBeInTheDocument();
    const alerte = await screen.findByText(/Sources : chargement impossible/, undefined, { timeout: 6000 });
    expect(alerte.closest("[role=alert]")).toHaveTextContent("Panne sources");
    expect(screen.getByText("dont 2 prioritaires")).toBeInTheDocument();
  });

  it("synthese en erreur : indicateurs et taux en erreur (pas de 0), liste et sources disponibles", async () => {
    table[URL_SYN] = echec(500, "Panne synthese");
    rendre();
    expect(await screen.findByRole("button", { name: /Inondation/ })).toBeInTheDocument();
    await screen.findByText(/Indicateurs : chargement impossible/, undefined, { timeout: 6000 });
    const zone = screen.getByRole("region", { name: "Indicateurs de synthèse" });
    expect(within(zone).queryByText("0")).not.toBeInTheDocument();
    expect(screen.queryByTestId("valeur-taux")).not.toBeInTheDocument();
    expect(await screen.findByRole("table", { name: /Sources d'observation/ })).toBeInTheDocument();
    for (const t of screen.getAllByRole("tab")) expect(t.textContent).toContain("—");
  });

  it("module non autorise (403 partout) : des messages de permission, aucun faux vide", async () => {
    for (const u of [URL_SYN, URL_LISTE, URL_SRC]) table[u] = echec(403, "Module non autorisé", "ROLE_INSUFFISANT");
    rendre();
    await waitFor(() => expect(screen.getAllByText(/accès refusé/).length).toBeGreaterThanOrEqual(3), { timeout: 6000 });
    expect(screen.queryByText(/Aucune proposition «/)).not.toBeInTheDocument();
    expect(screen.queryByText("Aucune source d'observation enregistrée")).not.toBeInTheDocument();
  });
});

describe("decision depuis l'ecran : ecriture puis rechargement", () => {
  it("un verdict est envoye avec son motif puis la liste et les indicateurs sont relus", async () => {
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: /Inondation/ }));
    await u.click(await screen.findByRole("button", { name: /^Infirmer la proposition inondation/ }));
    await u.type(screen.getByLabelText(/Motif/), "Chaussée sèche, aucun changement");
    await u.type(screen.getByLabelText(/Référence du constat/), "RAPPORT-SYN-3"); // aucune observation liee : la reference est exigee
    const avant = { liste: appels(URL_LISTE).length, synthese: appels(URL_SYN).length };
    await u.click(screen.getByRole("button", { name: "Enregistrer la décision" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith("/v2/teledetection/propositions/p-1/transition", { vers: "INFIRMEE", motif: "Chaussée sèche, aucun changement", constatRef: "RAPPORT-SYN-3" }));
    await waitFor(() => expect(appels(URL_LISTE).length).toBeGreaterThan(avant.liste));
    expect(appels(URL_SYN).length).toBeGreaterThan(avant.synthese);
  });

  it("champ de recherche : la frappe est differee puis envoyee comme parametre q", async () => {
    rendre();
    await screen.findByRole("button", { name: /Inondation/ });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Coyah" } });
    await waitFor(() => expect(appels(URL_LISTE).at(-1)).toMatchObject({ q: "Coyah" }), { timeout: 5000 });
  });

  it("dit les anomalies de coherence, bloquantes et a examiner distinguees", async () => {
    h.get["/v2/teledetection/coherence"] = {
      bloquantes: 1, aExaminer: 1, tronquee: false,
      anomalies: [
        { propositionId: "pr-9", regle: "HORS_EMPRISE_PRODUIT", detail: "S1", gravite: "BLOQUANTE" },
        { propositionId: "pr-8", regle: "MISSION_SANS_VERDICT", detail: "VER-1 TERMINEE", gravite: "A_EXAMINER" },
      ],
    };
    rendre();
    expect(await screen.findByText(/Hors de l'emprise du produit/)).toBeInTheDocument();
    expect(screen.getByText(/Mission close sans verdict/)).toBeInTheDocument();
    expect(screen.getByText("Bloquante")).toBeInTheDocument();
    expect(screen.getByText("À examiner")).toBeInTheDocument();
  });

  it("sans anomalie, le dit", async () => {
    h.get["/v2/teledetection/coherence"] = { bloquantes: 0, aExaminer: 0, tronquee: false, anomalies: [] };
    rendre();
    expect(await screen.findByText("Aucune anomalie.")).toBeInTheDocument();
  });
});

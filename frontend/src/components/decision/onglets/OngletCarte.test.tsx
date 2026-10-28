import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useSearchParams } from "react-router-dom";

/**
 * Leaflet ne rend pas sous jsdom (voir vitest.config.ts) : `react-leaflet` est remplace par un double (carte/leaflet.testutil.tsx) qui garde ce qui
 * compte ici : quels marqueurs, quelles lignes, quels styles, quelle vue. Le dessin reel est verifie dans Chromium (captures du rapport). Toutes les
 * donnees sont SYNTHETIQUES (`synth-*`).
 */
vi.mock("react-leaflet", async () => (await import("../carte/leaflet.testutil")).moduleReactLeaflet());
vi.mock("react-leaflet-cluster", async () => (await import("../carte/leaflet.testutil")).moduleCluster());
const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../../lib/api", () => ({ api: { get: h.get } }));

import { OngletCarte } from "./OngletCarte";
import { PLAFOND_MARQUEURS } from "../../../lib/aideDecisionCarte";
import { _reinitialiserSelection, selectionner, useSelection } from "../../../lib/aideDecisionInterventionsHooks";
import { violationsAccessibilite } from "../../../test/accessibilite";
import { carteEtat, mapDouble, reinitialiserCarte } from "../carte/leaflet.testutil";
import { brancherApi, collectionSynth, erreurHttp, featureSynth, ficheSynth, incompleteSynth, interventionSynth, listeSynth, REGIONS_SYNTH } from "../carte/synthetique.testutil";
import type { FiltresDecision } from "../types";

const LIGNE = JSON.stringify({ type: "LineString", coordinates: [[-13.8, 9.5], [-13.7, 9.6], [-13.6, 9.7]] });
const troncon = (id: string, over: Record<string, unknown> = {}) => ({ id, code: `SYN-${id}`, nom: `Tronçon ${id}`, classe: "RN", etat: "CRITIQUE", etatDeclare: false, region: "Région synthétique B", longueurKm: 3, geometry: LIGNE, ...over });

let filtresCourants: FiltresDecision = {};
const onFiltres = vi.fn();
function Sonde() {
  const [p] = useSearchParams();
  return <p data-testid="url">{p.toString()}</p>;
}
function Etat() {
  const s = useSelection();
  return <p data-testid="selection">{`${s.id ?? "-"}|${s.centrageEnAttente ? "centrer" : "-"}`}</p>;
}
function rendre(filtres: FiltresDecision = {}, over: { onRender?: () => void } = {}) {
  filtresCourants = filtres;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  const contenu = <OngletCarte filtres={filtres} onFiltres={onFiltres} />;
  return render(
    <MemoryRouter initialEntries={["/decision"]}>
      <QueryClientProvider client={qc}>
        <Sonde /><Etat />
        {over.onRender ? <Profiler id="carte" onRender={over.onRender}>{contenu}</Profiler> : contenu}
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const items = (n: number) => Array.from({ length: n }, (_, k) => interventionSynth(k + 1));
function routes(over: Record<string, (p?: Record<string, string>) => unknown> = {}) {
  brancherApi(h.get, {
    "/regions": () => REGIONS_SYNTH,
    "/troncons/geo": () => [troncon("t-1"), troncon("t-2", { etat: "BON", etatDeclare: true, classe: "RR" })],
    "/v2/geo/contour": () => ({ type: "Feature", geometry: { type: "LineString", coordinates: [[-14, 9], [-13, 10]] }, properties: {} }),
    "/ouvrages/geo": () => [],
    "/chantiers/geo": () => [],
    "/points-noirs/geo": () => [],
    "/v2/troncons-recherche": () => ({ data: [] }),
    "/v2/aide-decision/interventions": () => listeSynth(items(3)),
    "/v2/aide-decision/interventions.geojson": () => collectionSynth([featureSynth(1), featureSynth(2, { scoreIncomplet: true, statutScore: "INCOMPLET" }), featureSynth(3, { rang: null, score: null, statutScore: "EXCLU" })]),
    "/v2/aide-decision/interventions/": () => ficheSynth(1),
    ...over,
  });
}
const marqueurs = () => screen.queryAllByTestId("marqueur").filter((m) => m.dataset.classe === "bdri-intervention-ad");
async function passerEnPriorites(u: ReturnType<typeof userEvent.setup>) {
  await u.click(screen.getByRole("radio", { name: "Priorités" }));
  await waitFor(() => expect(h.get.mock.calls.some((c) => c[0] === "/v2/aide-decision/interventions.geojson")).toBe(true));
}
const attendreTemps = async (ms: number) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
async function avecMarqueurs(u: ReturnType<typeof userEvent.setup>) {
  await passerEnPriorites(u);
  await waitFor(() => expect(marqueurs().length).toBeGreaterThan(0), { timeout: 3000 });
}

beforeEach(() => {
  h.get.mockReset(); onFiltres.mockReset(); reinitialiserCarte(); _reinitialiserSelection();
  vi.stubGlobal("matchMedia", undefined);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("modes de vue : jamais un mode vide et muet", () => {
  it("Chantiers et Budget sont desactives et DISENT pourquoi ; Etat actuel est le mode de depart", async () => {
    routes();
    rendre();
    const groupe = await screen.findByRole("group", { name: "Type d'affichage" });
    expect(within(groupe).getByRole("radio", { name: /État actuel/ })).toBeChecked();
    for (const nom of ["Chantiers", "Budget"]) {
      const r = within(groupe).getByRole("radio", { name: new RegExp(nom) });
      expect(r).toBeDisabled();
      expect(r).toHaveAccessibleDescription(/Non disponible :/);
    }
    expect(within(groupe).getByText(/le bailleur est un texte libre/)).toBeInTheDocument();
    expect(within(groupe).getByText(/source financière n'est pas validée \(décision B-08\)/)).toBeInTheDocument();
  });

  it("prefecture, axe, bailleur, gravite, type d'intervention : DESACTIVES avec leur raison, jamais retires", async () => {
    routes();
    rendre();
    await screen.findByRole("group", { name: "Type d'affichage" });
    for (const lib of ["Préfecture", "Axe", "Bailleur / financement", "Gravité", "Type d'intervention"]) {
      const champ = screen.getByLabelText(lib);
      expect(champ).toBeDisabled();
      expect(champ).toHaveAccessibleDescription(/Non disponible :/);
    }
    expect(screen.getByLabelText("Limites des régions et préfectures")).toBeDisabled();
    expect(screen.getByText(/non disponible dans cette vue : seul le contour du pays/i)).toBeInTheDocument();
  });
});

describe("deux echelles qui ne se melangent pas", () => {
  it("vue Etat actuel : le reseau est colore par l'etat, pointille si declare ; aucune intervention n'est demandee", async () => {
    routes();
    rendre();
    await waitFor(() => expect(screen.getAllByTestId("geojson").length).toBeGreaterThan(0));
    const reseau = screen.getAllByTestId("geojson").find((g) => g.dataset.n === "2")!;
    const styles = JSON.parse(reseau.dataset.styles!);
    expect(styles[0].color).toBe("#b91c1c"); // CRITIQUE
    expect(styles[0].dashArray).toBeUndefined();
    expect(styles[1].color).toBe("#1b8a5a"); // BON
    expect(styles[1].dashArray).toBe("10 7"); // etat declare
    expect(JSON.parse(reseau.dataset.infobulles!)[0]).toBe("SYN-t-1 — Tronçon t-1 : Critique");
    expect(JSON.parse(reseau.dataset.infobulles!)[1]).toContain("(état déclaré)");
    expect(h.get.mock.calls.some((c) => c[0] === "/v2/aide-decision/interventions.geojson")).toBe(false);
    expect(marqueurs()).toHaveLength(0);
  });

  it("vue Priorites : le reseau devient un fond GRIS (l'etat n'est pas peint) et les interventions sont des hexagones violets a part", async () => {
    routes();
    const u = userEvent.setup();
    rendre();
    await screen.findByRole("group", { name: "Type d'affichage" });
    await avecMarqueurs(u);
    const reseau = screen.getAllByTestId("geojson").find((g) => g.dataset.n === "2")!;
    for (const s of JSON.parse(reseau.dataset.styles!)) { expect(s.color).toBe("#9aa0aa"); expect(s.dashArray).toBeUndefined(); }
    const html = marqueurs().map((m) => m.innerHTML).join("");
    expect(html).toContain("<polygon");
    for (const etat of ["#1b8a5a", "#b08200", "#e0631d", "#b91c1c"]) expect(html.toLowerCase()).not.toContain(etat);
  });

  it("un score INCOMPLET a un marqueur distinct (contour pointille et « ? ») ; son nom accessible le dit", async () => {
    routes();
    const u = userEvent.setup();
    rendre();
    await avecMarqueurs(u);
    await waitFor(() => expect(marqueurs()).toHaveLength(3));
    const [m1, m2] = marqueurs();
    expect(m1.innerHTML).not.toContain("stroke-dasharray");
    expect(m2.innerHTML).toContain("stroke-dasharray");
    expect(m2.innerHTML).toContain(">?<");
    expect(within(m2).getByRole("img", { name: /Marqueur : Intervention rang 2 SYN-2, score incomplet, état mauvais/ })).toBeInTheDocument();
    expect(within(m1).getByRole("img", { name: /score complet/ })).toBeInTheDocument();
    expect(within(marqueurs()[2]).getByRole("img", { name: /Marqueur : Intervention non classée SYN-3, sans score/ })).toBeInTheDocument();
    expect(marqueurs()[2].innerHTML).not.toContain(">?<");
  });

  it("les marqueurs ne sont pas des arrets de tabulation (keyboard=false) : 300 arrets rendraient la page inutilisable", async () => {
    routes();
    const u = userEvent.setup();
    rendre();
    await avecMarqueurs(u);
    for (const m of marqueurs()) expect(m.dataset.clavier).toBe("false");
  });

  it("les traces et icones de groupe de Leaflet ne sont PAS des arrets de tabulation (mesure Chromium : chaque path interactif l'etait)", async () => {
    routes();
    const conteneur = document.createElement("div");
    conteneur.innerHTML = '<path class="leaflet-interactive" id="p1"></path><div class="leaflet-marker-icon" tabindex="0" id="m1"></div>';
    carteEtat.conteneur = conteneur;
    rendre();
    await waitFor(() => expect(conteneur.querySelector("#p1")).toHaveAttribute("tabindex", "-1"));
    expect(conteneur.querySelector("#m1")).toHaveAttribute("tabindex", "-1");
    // un calque ajoute APRES coup (zoom, rechargement) est corrige aussi
    const tardif = document.createElement("path");
    tardif.setAttribute("class", "leaflet-interactive");
    conteneur.appendChild(tardif);
    await waitFor(() => expect(tardif).toHaveAttribute("tabindex", "-1"));
  });

  it("la legende dit les deux echelles et le signe du score incomplet", async () => {
    routes();
    const u = userEvent.setup();
    rendre();
    const legende = await screen.findByText("Légende");
    expect(legende.closest("details")).toHaveTextContent("Trait pointillé : état déclaré, non constaté sur le terrain");
    expect(legende.closest("details")).not.toHaveTextContent("Priorité des interventions");
    await passerEnPriorites(u);
    await waitFor(() => expect(screen.getByText("Légende").closest("details")).toHaveTextContent("Contour pointillé et « ? » : score incomplet"));
    expect(screen.getByText("Légende").closest("details")).toHaveTextContent("Gris, sans rang : non classée");
    expect(screen.getByText("Légende").closest("details")).toHaveTextContent("Fond gris : l'état physique n'est pas peint dans cette vue");
  });
});

describe("zoom minimal, emprise bornee, troncature jamais silencieuse", () => {
  it("zoom insuffisant : « Zoomez pour afficher les interventions », aucune requete geojson, aucun marqueur", async () => {
    routes();
    carteEtat.zoom = 5;
    const u = userEvent.setup();
    rendre();
    await u.click(screen.getByRole("radio", { name: "Priorités" }));
    expect(await screen.findByText("Zoomez pour afficher les interventions")).toBeInTheDocument();
    await attendreTemps(500);
    expect(h.get.mock.calls.some((c) => c[0] === "/v2/aide-decision/interventions.geojson")).toBe(false);
    expect(marqueurs()).toHaveLength(0);
  });

  it("emprise visible de plus de 10 degres : meme message, rien n'est demande", async () => {
    routes();
    carteEtat.bounds = { w: -17, s: 8, e: -6, n: 12 };
    const u = userEvent.setup();
    rendre();
    await u.click(screen.getByRole("radio", { name: "Priorités" }));
    expect(await screen.findByText("Zoomez pour afficher les interventions")).toBeInTheDocument();
    await attendreTemps(600);
    expect(h.get.mock.calls.some((c) => c[0] === "/v2/aide-decision/interventions.geojson")).toBe(false);
  });

  it("la requete porte la bbox de la vue ET les memes filtres que la liste (AD-11)", async () => {
    routes();
    const u = userEvent.setup();
    rendre({ regionId: 2, classe: ["RN"] });
    await passerEnPriorites(u);
    const geo = h.get.mock.calls.find((c) => c[0] === "/v2/aide-decision/interventions.geojson")![1].params;
    const liste = h.get.mock.calls.find((c) => c[0] === "/v2/aide-decision/interventions")![1].params;
    expect(geo.bbox).toMatch(/^-13\.\d+,9\.\d+,-13\.\d+,9\.\d+$/);
    const { bbox, ...filtresGeo } = geo;
    expect(bbox).toBeTruthy();
    expect(filtresGeo).toEqual(liste);
    expect(liste).toEqual({ regionId: "2", classe: "RN" });
  });

  it("MUTATION DE CONTROLE : un resultat TRONQUE par le serveur est DIT avec le total et le nombre affiche, jamais en silence", async () => {
    routes({ "/v2/aide-decision/interventions.geojson": () => collectionSynth([featureSynth(1), featureSynth(2), featureSynth(3)], { tronque: true, total: 412 }) });
    const u = userEvent.setup();
    rendre();
    await avecMarqueurs(u);
    expect(await screen.findByText("412 interventions au total, seules les 3 plus prioritaires sont affichées : zoomez")).toBeInTheDocument();
  });

  it("au-dela du plafond du navigateur, le reste est compte et dit", async () => {
    const beaucoup = Array.from({ length: PLAFOND_MARQUEURS + 5 }, (_, k) => featureSynth(k + 1));
    routes({ "/v2/aide-decision/interventions.geojson": () => collectionSynth(beaucoup) });
    const u = userEvent.setup();
    rendre();
    await passerEnPriorites(u);
    await waitFor(() => expect(marqueurs()).toHaveLength(PLAFOND_MARQUEURS), { timeout: 3000 });
    expect(screen.getByText("5 interventions non affichées, zoomez")).toBeInTheDocument();
  });

  it("les interventions sans geometrie du perimetre (horsGeometrie) sont DITES : absentes de la carte, presentes dans la liste", async () => {
    routes({ "/v2/aide-decision/interventions.geojson": () => collectionSynth([featureSynth(1)], { horsGeometrie: 7 }) });
    const u = userEvent.setup();
    rendre();
    await avecMarqueurs(u);
    expect(await screen.findByText("7 interventions du périmètre n'ont pas de localisation valide : absentes de la carte, elles restent dans la liste")).toBeInTheDocument();
  });

  it("une feature illisible est ecartee ET comptee", async () => {
    routes({ "/v2/aide-decision/interventions.geojson": () => collectionSynth([featureSynth(1), { type: "Feature", geometry: null, properties: { id: "synth-x" } }]) });
    const u = userEvent.setup();
    rendre();
    await avecMarqueurs(u);
    expect(await screen.findByText(/1 intervention illisible ignorée/)).toBeInTheDocument();
  });

  it("emprise vide : « Aucune intervention dans cette emprise », pas une carte muette", async () => {
    routes({ "/v2/aide-decision/interventions.geojson": () => collectionSynth([]) });
    const u = userEvent.setup();
    rendre();
    await passerEnPriorites(u);
    expect(await screen.findByText("Aucune intervention dans cette emprise, avec ces filtres.")).toBeInTheDocument();
  });

  it("erreur du geojson : role=alert distinct du vide, « Réessayer » relance ; permission refusee : message dedie", async () => {
    let n = 0;
    routes({ "/v2/aide-decision/interventions.geojson": () => { n += 1; if (n <= 2) throw erreurHttp(500, "geo en panne"); return collectionSynth([featureSynth(1)]); } });
    const u = userEvent.setup();
    rendre();
    await u.click(screen.getByRole("radio", { name: "Priorités" }));
    const alerte = await screen.findByText(/Interventions non affichées : geo en panne/, undefined, { timeout: 3000 });
    expect(alerte.closest('[role="alert"]')).toBeTruthy();
    expect(marqueurs()).toHaveLength(0);
    await u.click(screen.getByRole("button", { name: "Réessayer : interventions de la carte" }));
    await waitFor(() => expect(marqueurs()).toHaveLength(1));
  });

  it("permission refusee sur le geojson : statut dedie, pas d'alerte de panne", async () => {
    routes({ "/v2/aide-decision/interventions.geojson": () => { throw erreurHttp(403); } });
    const u = userEvent.setup();
    rendre();
    await u.click(screen.getByRole("radio", { name: "Priorités" }));
    expect(await screen.findByText(/Interventions non affichées : accès refusé/, undefined, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Réessayer : interventions de la carte" })).toBeNull();
  });
});

describe("GeoJSON invalide : une couche invalide est ignoree avec un message, la page ne plante pas", () => {
  it("couche Ouvrages invalide : message dit, filtres et constats toujours la", async () => {
    routes({ "/ouvrages/geo": () => ({ pas: "une liste" }) });
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("checkbox", { name: "Ouvrages d'art" }));
    expect(await screen.findByText("Données de la couche « Ouvrages d'art » invalides : couche ignorée (la réponse n'est pas une liste).")).toBeInTheDocument();
    expect(screen.getByText("1 anomalie dans les données des couches", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Filtres de la carte" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Insights et recommandations" })).toBeInTheDocument();
    expect(screen.queryByText("La carte n'a pas pu s'afficher.")).toBeNull();
  });

  it("reseau invalide (page HTML de repli) : couche ignoree et dite, aucune exception", async () => {
    routes({ "/troncons/geo": () => "<html>repli SPA</html>" });
    rendre();
    expect(await screen.findByText("Données de la couche « Réseau routier » invalides : couche ignorée (la réponse n'est pas une liste).")).toBeInTheDocument();
    expect(screen.queryByText("La carte n'a pas pu s'afficher.")).toBeNull();
  });

  it("contour invalide : couche ignoree ; contour 404 : « Aucune limite administrative en base »", async () => {
    routes({ "/v2/geo/contour": () => ({ type: "FeatureCollection", features: [{ type: "Feature", geometry: null }] }) });
    rendre();
    expect(await screen.findByText(/Données de la couche « Contour du pays » invalides/)).toBeInTheDocument();
  });

  it("contour 404 : dit, ne trace rien", async () => {
    routes({ "/v2/geo/contour": () => { throw erreurHttp(404); } });
    rendre();
    expect(await screen.findByText("Aucune limite administrative en base : rien n'est tracé.", { exact: false })).toBeInTheDocument();
  });

  it("garde de carte : si le rendu de la carte leve, le reste de l'onglet reste utilisable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    routes();
    carteEtat.lever = true;
    rendre();
    const alerte = await screen.findByText("La carte n'a pas pu s'afficher.");
    expect(alerte.closest('[role="alert"]')).toHaveTextContent("Détail technique : Invalid GeoJSON object.");
    expect(screen.getByRole("heading", { name: "Filtres de la carte" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Insights et recommandations" })).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});

describe("selection bidirectionnelle (AD-04) sans boucle de rendu", () => {
  it("un clic sur un marqueur surligne la ligne de la liste alternative ET ouvre la fiche de CET element, sans recentrer la carte", async () => {
    routes({ "/v2/aide-decision/interventions/": () => ficheSynth(2) });
    const u = userEvent.setup();
    rendre();
    await avecMarqueurs(u);
    await waitFor(() => expect(marqueurs()).toHaveLength(3));
    await u.click(screen.getByRole("button", { name: /Interventions affichées sur la carte \(3\)/ }));
    await u.click(marqueurs()[1]);
    expect(screen.getByTestId("selection")).toHaveTextContent("synth-2|-");
    const fiche = await screen.findByRole("complementary", { name: "Fiche de l'intervention" });
    await waitFor(() => expect(fiche).toHaveAttribute("data-intervention", "synth-2"));
    const liste = screen.getByRole("list", { name: "Interventions affichées sur la carte" });
    const boutons = within(liste).getAllByRole("button");
    expect(boutons[1]).toHaveAttribute("aria-pressed", "true");
    expect(boutons[0]).toHaveAttribute("aria-pressed", "false");
    expect(boutons[1].className).toContain("bg-amber-50");
    expect(marqueurs()[1].dataset.z).toBe("1000"); // halo et priorite d'empilement
    expect(mapDouble.fitBounds).not.toHaveBeenCalled();
  });

  it("un clic sur la liste alternative selectionne (et ne recentre que si le marqueur est hors vue)", async () => {
    routes();
    const u = userEvent.setup();
    rendre();
    await avecMarqueurs(u);
    await waitFor(() => expect(marqueurs()).toHaveLength(3));
    await u.click(screen.getByRole("button", { name: /Interventions affichées sur la carte \(3\)/ }));
    const liste = screen.getByRole("list", { name: "Interventions affichées sur la carte" });
    await u.click(within(liste).getAllByRole("button")[2]);
    expect(screen.getByTestId("selection")).toHaveTextContent("synth-3|-");
    expect(mapDouble.panTo).not.toHaveBeenCalled(); // dans la vue
  });

  it("une ligne de l'onglet Liste (centrage demande) recentre la carte UNE fois, sur le trace du troncon, puis acquitte", async () => {
    routes();
    rendre();
    await screen.findByRole("group", { name: "Type d'affichage" });
    // la ligne 1 n'est pas dans l'emprise chargee (aucun geojson) : on retombe sur le trace du troncon du reseau de reference
    await waitFor(() => expect(h.get.mock.calls.some((c) => c[0] === "/v2/aide-decision/interventions")).toBe(true));
    await waitFor(() => expect(screen.getByText(/Calculé sur les 3 interventions/)).toBeInTheDocument());
    act(() => selectionner("synth-1", { centrer: true }));
    await waitFor(() => expect(mapDouble.fitBounds).toHaveBeenCalledTimes(1));
    expect(mapDouble.fitBounds.mock.calls[0][0]).toEqual([[9.5, -13.8], [9.7, -13.6]]);
    await waitFor(() => expect(screen.getByTestId("selection")).toHaveTextContent("synth-1|-")); // acquitte
    await attendreTemps(300);
    expect(mapDouble.fitBounds).toHaveBeenCalledTimes(1);
  });

  it("centrage demande sur une intervention sans trace connu : la carte ne bouge pas et le dit", async () => {
    routes({ "/v2/aide-decision/interventions": () => listeSynth([interventionSynth(1, { objet: null })]), "/v2/aide-decision/interventions/": () => ficheSynth(1, {}, interventionSynth(1, { objet: null })) });
    rendre();
    await waitFor(() => expect(screen.getByText(/Calculé sur les 1 intervention/)).toBeInTheDocument());
    act(() => selectionner("synth-1", { centrer: true }));
    expect(await screen.findByText(/Position introuvable : cette intervention n'est ni dans l'emprise chargée ni sur un tronçon/)).toBeInTheDocument();
    expect(mapDouble.fitBounds).not.toHaveBeenCalled();
  });

  it("anti-boucle : cliquer un marqueur provoque un nombre BORNE de rendus de l'onglet et aucune requete supplementaire de liste ou de geojson", async () => {
    routes();
    const u = userEvent.setup();
    let rendus = 0;
    rendre({}, { onRender: () => { rendus += 1; } });
    await avecMarqueurs(u);
    await waitFor(() => expect(marqueurs()).toHaveLength(3));
    await findFiche(u);
    await attendreTemps(400);
    const avant = rendus;
    const appelsAvant = h.get.mock.calls.length;
    await u.click(marqueurs()[0]); // meme element : aucune emission
    await attendreTemps(400);
    expect(rendus - avant).toBeLessThanOrEqual(2);
    await u.click(marqueurs()[1]);
    await waitFor(() => expect(screen.getByTestId("selection")).toHaveTextContent("synth-2|-"));
    await attendreTemps(600);
    expect(rendus - avant).toBeLessThanOrEqual(12);
    const liste = h.get.mock.calls.slice(appelsAvant).filter((c) => c[0] === "/v2/aide-decision/interventions" || c[0] === "/v2/aide-decision/interventions.geojson");
    expect(liste).toHaveLength(0);
    expect(mapDouble.fitBounds).not.toHaveBeenCalled();
  });

  async function findFiche(u: ReturnType<typeof userEvent.setup>) {
    await u.click(marqueurs()[0]);
    await screen.findByRole("complementary", { name: "Fiche de l'intervention" });
  }
});

describe("filtres partages (AD-11)", () => {
  it("changer la region, une classe, un etat, la periode appelle onFiltres avec les memes cles que le shell ; « Réinitialiser » vide", async () => {
    routes();
    const u = userEvent.setup();
    rendre({ regionId: 2 });
    await screen.findByRole("option", { name: "Région synthétique A" });
    await u.selectOptions(screen.getByLabelText("Région"), "1");
    expect(onFiltres).toHaveBeenLastCalledWith({ regionId: 1 });
    await u.click(screen.getByRole("checkbox", { name: "Routes nationales (RN)" }));
    expect(onFiltres).toHaveBeenLastCalledWith({ regionId: 2, classe: ["RN"] });
    await u.click(screen.getByRole("checkbox", { name: "Critique" }));
    expect(onFiltres).toHaveBeenLastCalledWith({ regionId: 2, etat: ["CRITIQUE"] });
    await u.click(screen.getByRole("button", { name: "Réinitialiser les filtres de la carte" }));
    expect(onFiltres).toHaveBeenLastCalledWith({});
    expect(screen.getByText(/La période s'applique aux interventions \(liste, carte, constats\), pas au tracé du réseau/)).toBeInTheDocument();
  });

  it("les filtres region et classe s'appliquent aussi au trace du reseau ; region non resolue : le trace n'est PAS filtre", async () => {
    routes();
    rendre({ regionId: 1, classe: ["RN"] });
    await waitFor(() => expect(screen.getAllByTestId("geojson").length).toBeGreaterThan(0));
    // region 1 = « Région synthétique A » : aucun troncon synthetique n'y est ; le reseau est vide, la carte ne dessine rien et n'invente rien
    expect(screen.getAllByTestId("geojson").some((g) => g.dataset.n === "2")).toBe(false);
  });
});

describe("constats : calcules, jamais statiques (AD-06)", () => {
  const trafic = [{ critere: "TRAFIC", libelle: "Trafic", raison: "absent" }];
  it("lot PARTIEL : score incomplet et non classees viennent du decompte du serveur (tout le perimetre), le reste des lignes chargees, avec la couverture", async () => {
    routes({
      "/v2/aide-decision/interventions": () => listeSynth(
        [
          incompleteSynth(1, trafic, 22, { etatPhysique: "CRITIQUE" }),
          interventionSynth(2, { localisation: "invalide", coutEstime: null, coutNonEstimable: { code: "BAREME_ABSENT", motif: "aucun barème" } }),
          incompleteSynth(3, trafic),
        ],
        { page: { limite: 3, prochainCurseur: "c2", aSuivant: true }, total: 40, totalAffiche: 40, resume: { candidats: 40, classes: 38, complets: 30, incomplets: 8, exclus: 2, parMotifExclusion: { ETAT_NON_EVALUE: 2 } } },
      ),
    });
    rendre();
    const panneau = (await screen.findByRole("heading", { name: "Insights et recommandations" })).closest("section")!;
    await within(panneau).findByText("8 interventions au score incomplet");
    expect(within(panneau).getByText(/Critère le plus souvent manquant parmi les chargées : Trafic \(2 interventions\)/)).toBeInTheDocument();
    expect(within(panneau).getByText("2 interventions non classées")).toBeInTheDocument();
    expect(within(panneau).getByText("Motifs : état non évalué (2).")).toBeInTheDocument();
    expect(within(panneau).getByText("1 intervention sans localisation valide")).toBeInTheDocument();
    expect(within(panneau).getByText("1 intervention sur un tronçon à l'état critique")).toBeInTheDocument();
    expect(within(panneau).getByText("1 intervention au coût non estimable")).toBeInTheDocument();
    expect(within(panneau).getByText(/Scores incomplets et non classées : comptes du serveur sur tout le périmètre/)).toBeInTheDocument();
    expect(within(panneau).getByText(/3 interventions chargées \(40 au total\)/)).toBeInTheDocument();
    expect(within(panneau).getAllByText("Sur tout le périmètre (décompte du serveur).")).toHaveLength(2);
    expect(within(panneau).getAllByText("Parmi les 3 chargées seulement.").length).toBeGreaterThanOrEqual(3);
    expect(within(panneau).getByText(/Consultatif, non engageant/)).toBeInTheDocument();
    expect(within(panneau).getByRole("button", { name: "Charger plus d'interventions pour étendre les constats" })).toBeInTheDocument();
    // aucun texte de recommandation statique de la maquette
    expect(panneau.textContent).not.toMatch(/régions prioritaires|marchés recensés|Taux d'engagement|Kindia, Faranah/);
  });

  it("chaque constat renvoie a la liste FILTREE : vue posee dans le magasin et onglet ouvert par l'URL du shell", async () => {
    routes({ "/v2/aide-decision/interventions": () => listeSynth([incompleteSynth(1, trafic)]) });
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: "Voir dans la liste : 1 intervention au score incomplet" }));
    expect(screen.getByTestId("url")).toHaveTextContent("onglet=liste");
    expect(renderHook(() => useSelection()).result.current.vue).toBe("score-incomplet");
    expect(screen.queryByRole("button", { name: /Voir dans la liste : Aucune/ })).toBeNull();
  });

  it("etats : chargement (status), erreur (alert + Réessayer), permission (statut dedie), vide (pas un zero)", async () => {
    routes({ "/v2/aide-decision/interventions": () => new Promise(() => undefined) });
    const r1 = rendre();
    expect(await screen.findByText("Calcul des constats…")).toBeInTheDocument();
    r1.unmount();

    routes({ "/v2/aide-decision/interventions": () => { throw erreurHttp(500, "moteur arrêté"); } });
    const r2 = rendre();
    const alerte = await screen.findByText(/Constats : chargement impossible/);
    expect(alerte.closest('[role="alert"]')).toHaveTextContent("moteur arrêté");
    expect(screen.getByRole("button", { name: "Réessayer : Constats" })).toBeInTheDocument();
    r2.unmount();

    routes({ "/v2/aide-decision/interventions": () => { throw erreurHttp(403); } });
    const r3 = rendre();
    expect(await screen.findByText(/Constats : accès refusé/)).toBeInTheDocument();
    r3.unmount();

    routes({ "/v2/aide-decision/interventions": () => listeSynth([]) });
    rendre();
    expect(await screen.findByText("Aucun constat à calculer")).toBeInTheDocument();
    expect(screen.queryByText(/0 intervention/)).toBeNull();
  });
});

describe("plein ecran accessible", () => {
  it("le fond de page devient inert, Echap quitte, le focus revient sur le bouton", async () => {
    routes();
    const u = userEvent.setup();
    const { container } = render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <header data-testid="fond">fond de page</header>
          <main><div data-testid="frere">frere</div><div data-testid="onglet"><OngletCarte filtres={{}} onFiltres={onFiltres} /></div></main>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    const bouton = await screen.findByRole("button", { name: "Plein écran" });
    await u.click(bouton);
    expect(bouton).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("fond")).toHaveAttribute("inert");
    expect(screen.getByTestId("frere")).toHaveAttribute("inert");
    expect(screen.getByTestId("onglet")).not.toHaveAttribute("inert");
    expect(container.querySelector(".fixed.inset-0")).toBeTruthy();
    // MESURE CHROMIUM : en plein ecran la carte avait une hauteur de 0 (un `min-h` seul ne donne pas de hauteur au `height:100%` de Leaflet) : hauteur explicite exigee.
    expect(screen.getByTestId("carte").parentElement?.className).toContain("h-[62vh]");
    await u.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByTestId("fond")).not.toHaveAttribute("inert"));
    expect(screen.getByTestId("frere")).not.toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: "Plein écran" })).toHaveFocus();
  });

  it("demontage en plein ecran : l'attribut inert est retire (pas de page figee)", async () => {
    routes();
    const u = userEvent.setup();
    const { unmount } = render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <p data-testid="fond">fond</p>
          <OngletCarte filtres={{}} onFiltres={onFiltres} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    await u.click(await screen.findByRole("button", { name: "Plein écran" }));
    expect(screen.getByTestId("fond")).toHaveAttribute("inert");
    unmount();
    // le fond n'existe plus : on verifie qu'aucun element du document ne garde `inert`
    expect(document.querySelectorAll("[inert]")).toHaveLength(0);
  });
});

describe("recherche d'une zone ou d'un troncon (mecanisme existant)", () => {
  it("une zone recadre la carte et le dit (centre approximatif, pas une limite administrative)", async () => {
    routes();
    const u = userEvent.setup();
    rendre();
    await u.type(await screen.findByRole("searchbox", { name: "Rechercher une zone ou un tronçon" }), "Kindia");
    await u.click(await screen.findByRole("button", { name: /Kindia\s*Zone, région de Kindia/ }));
    expect(mapDouble.fitBounds).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/centre approximatif du chef-lieu, pas une limite administrative/)).toBeInTheDocument();
  });

  it("un troncon est cherche par /v2/troncons-recherche et cadre sur son trace du reseau de reference", async () => {
    routes({ "/v2/troncons-recherche": () => ({ data: [{ id: "t-1", code: "SYN-t-1", nom: "Tronçon t-1", region: "Région synthétique B" }] }) });
    const u = userEvent.setup();
    rendre();
    await u.type(await screen.findByRole("searchbox", { name: "Rechercher une zone ou un tronçon" }), "SYN-t");
    await u.click(await screen.findByRole("button", { name: /SYN-t-1 — Tronçon t-1/ }, { timeout: 3000 }));
    await waitFor(() => expect(mapDouble.fitBounds).toHaveBeenCalledTimes(1));
    expect(mapDouble.fitBounds.mock.calls[0][0]).toEqual([[9.5, -13.8], [9.7, -13.6]]);
  });

  it("un troncon absent du reseau de reference n'est pas cadre « a cote » : message d'erreur", async () => {
    routes({ "/v2/troncons-recherche": () => ({ data: [{ id: "t-inconnu", code: "SYN-9", nom: "Hors réseau", region: "R" }] }) });
    const u = userEvent.setup();
    rendre();
    await u.type(await screen.findByRole("searchbox", { name: "Rechercher une zone ou un tronçon" }), "SYN-9");
    await u.click(await screen.findByRole("button", { name: /SYN-9 — Hors réseau/ }, { timeout: 3000 }));
    expect(await screen.findByText(/Tracé indisponible pour SYN-9 — Hors réseau/)).toBeInTheDocument();
    expect(mapDouble.fitBounds).not.toHaveBeenCalled();
  });
});

describe("accessibilite", () => {
  it("sans violation axe : onglet charge en vue Etat, en vue Priorites et fiche ouverte", async () => {
    routes();
    const u = userEvent.setup();
    const { container } = rendre();
    await screen.findByText(/Calculé sur les 3 interventions/);
    expect(await violationsAccessibilite(container)).toEqual([]);
    await avecMarqueurs(u);
    await waitFor(() => expect(marqueurs()).toHaveLength(3));
    await u.click(marqueurs()[0]);
    await screen.findByText(/Motif synthétique/);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("les ecouteurs de fenetre poses par le plein ecran sont retires au demontage", async () => {
    routes();
    const ajouts: string[] = []; const retraits: string[] = [];
    const a = window.addEventListener.bind(window); const r = window.removeEventListener.bind(window);
    vi.spyOn(window, "addEventListener").mockImplementation((t: string, f: unknown, o?: unknown) => { ajouts.push(t); return (a as (...x: unknown[]) => void)(t, f, o); });
    vi.spyOn(window, "removeEventListener").mockImplementation((t: string, f: unknown, o?: unknown) => { retraits.push(t); return (r as (...x: unknown[]) => void)(t, f, o); });
    const u = userEvent.setup();
    const { unmount } = rendre();
    await u.click(await screen.findByRole("button", { name: "Plein écran" }));
    unmount();
    expect(ajouts.filter((t) => t === "keydown").length).toBeLessThanOrEqual(retraits.filter((t) => t === "keydown").length);
    vi.restoreAllMocks();
  });
});

void filtresCourants;

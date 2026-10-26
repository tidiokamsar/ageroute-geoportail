import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CarteObservationTerreProps, CouchesCarte } from "./types";

/**
 * Leaflet ne rend pas sous jsdom (voir vitest.config.ts) : `react-leaflet` est remplace par un double qui garde ce
 * qui compte ici : QUELS marqueurs sont demandes, avec quelle icone, quels gestionnaires, quelle vue. Le dessin reel
 * est verifie dans Chromium (captures du compte rendu). Toutes les donnees sont SYNTHETIQUES (`synth-*`) : aucune
 * position ne decrit une anomalie reelle.
 */

const h = vi.hoisted(() => {
  // `taille` : conteneur en pixels (0 x 0 = masque, comme sous jsdom). Quand elle est donnee, `setView` recalcule l'emprise visible comme
  // Leaflet : largeur = px * 360 / (256 * 2^z) degres de longitude, hauteur reduite par cos(latitude) (projection de Mercator).
  const etat = { zoom: 10, bounds: { w: -13.8, s: 9.5, e: -13.5, n: 9.8 }, handlers: {} as Record<string, () => void>, taille: { x: 0, y: 0 } };
  const map = {
    getSize: () => etat.taille,
    setView: vi.fn((centre: [number, number], zoom: number) => {
      etat.zoom = zoom;
      if (etat.taille.x > 0) {
        const degParPx = 360 / (256 * 2 ** zoom);
        const demiL = (etat.taille.x * degParPx) / 2;
        const demiH = (etat.taille.y * degParPx * Math.cos((centre[0] * Math.PI) / 180)) / 2;
        etat.bounds = { w: centre[1] - demiL, s: centre[0] - demiH, e: centre[1] + demiL, n: centre[0] + demiH };
      }
    }),
    getZoom: () => etat.zoom,
    getBounds: () => ({
      getWest: () => etat.bounds.w, getSouth: () => etat.bounds.s, getEast: () => etat.bounds.e, getNorth: () => etat.bounds.n,
      contains: (p: [number, number]) => p[0] >= etat.bounds.s && p[0] <= etat.bounds.n && p[1] >= etat.bounds.w && p[1] <= etat.bounds.e,
    }),
    getContainer: () => document.createElement("div"),
    fitBounds: vi.fn(), panTo: vi.fn(), invalidateSize: vi.fn(),
  };
  return { etat, map, axiosGet: vi.fn(), apiGet: vi.fn() };
});

vi.mock("react-leaflet", () => ({
  MapContainer: ({ children, center, zoom }: { children: React.ReactNode; center: number[]; zoom: number }) => (
    <div data-testid="carte" data-centre={center.join(",")} data-zoom={zoom}>{children}</div>
  ),
  TileLayer: ({ url, attribution }: { url: string; attribution: string }) => <div data-testid="tuiles" data-url={url} data-attribution={attribution} />,
  ZoomControl: () => null,
  ScaleControl: () => <div data-testid="echelle" />,
  GeoJSON: ({ data }: { data: { features?: unknown[] } }) => <div data-testid="geojson" data-n={data.features?.length ?? "feature"} />,
  Polygon: ({ eventHandlers }: { eventHandlers?: { click: () => void } }) => <button type="button" data-testid="polygone" onClick={() => eventHandlers?.click()}>polygone</button>,
  Polyline: ({ children }: { children?: React.ReactNode }) => <div data-testid="ligne">{children}</div>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <span data-testid="infobulle">{children}</span>,
  Marker: ({ position, icon, eventHandlers, zIndexOffset, children }: {
    position: [number, number]; icon: { options: { html: string; className: string } }; eventHandlers?: { click: () => void }; zIndexOffset?: number; children?: React.ReactNode;
  }) => (
    <button
      type="button" data-testid="marqueur" data-classe={icon.options.className} data-pos={position.join(",")} data-z={zIndexOffset ?? 0}
      onClick={() => eventHandlers?.click()}
    >
      <span dangerouslySetInnerHTML={{ __html: icon.options.html }} />
      {children}
    </button>
  ),
  useMap: () => h.map,
  useMapEvents: (hd: Record<string, () => void>) => { h.etat.handlers = hd; return h.map; },
}));
vi.mock("axios", () => ({ default: { get: h.axiosGet, isAxiosError: (e: unknown) => Boolean((e as { isAxiosError?: boolean })?.isAxiosError) } }));
vi.mock("../../lib/api", () => ({ api: { get: h.apiGet } }));

import { CarteObservationTerre } from "./CarteObservationTerre";
import { _viderCacheTroncons } from "../../pages/geoportail/RechercheZoneTroncon";
import { PLAFOND_MARQUEURS } from "../../lib/teledetectionCarte";
import { violationsAccessibilite } from "../../test/accessibilite";
import { ecouteursOrphelins, espionnerEcouteurs } from "./ecouteurs.testutil";

const COUCHES: CouchesCarte = { reseau: false, limites: false, propositions: true, observationsTerrain: false, chantiers: false, ouvrages: false };

function feature(i: number, props: Record<string, unknown> = {}) {
  return {
    type: "Feature" as const,
    geometry: { type: "Point" as const, coordinates: [-13.7 + (i % 50) * 0.001, 9.6 + Math.floor(i / 50) * 0.001] },
    properties: { id: `synth-${i}`, type: "COUPURE_PROBABLE", statut: "A_VERIFIER", priorite: "HAUTE", rattachee: true, ...props },
  };
}
const collection = (...features: unknown[]) => ({ type: "FeatureCollection" as const, features }) as unknown as GeoJSON.FeatureCollection;

function rendre(over: Partial<CarteObservationTerreProps> = {}) {
  const props: CarteObservationTerreProps = {
    propositions: null, chargement: false, erreur: null, zoomSuffisant: true, selectionId: null,
    onSelect: vi.fn(), onEmpriseChange: vi.fn(), couches: COUCHES, onCouchesChange: vi.fn(), ...over,
  };
  const r = render(<CarteObservationTerre {...props} />);
  return { ...r, props };
}

const marqueurs = () => screen.queryAllByTestId("marqueur").filter((m) => m.dataset.classe === "bdri-proposition-eo");
function deplacer(bounds: { w: number; s: number; e: number; n: number }, zoom = h.etat.zoom) {
  h.etat.bounds = bounds;
  h.etat.zoom = zoom;
  act(() => { h.etat.handlers.moveend?.(); });
}

beforeEach(() => {
  h.etat.zoom = 10;
  h.etat.bounds = { w: -13.8, s: 9.5, e: -13.5, n: 9.8 };
  h.etat.handlers = {};
  h.etat.taille = { x: 0, y: 0 };
  h.map.setView.mockClear();
  h.map.fitBounds.mockReset(); h.map.panTo.mockReset(); h.map.invalidateSize.mockReset();
  h.axiosGet.mockReset(); h.apiGet.mockReset();
  h.apiGet.mockResolvedValue({ data: { data: [] } });
  _viderCacheTroncons();
  vi.stubGlobal("matchMedia", undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("etats de la carte : jamais une carte muette", () => {
  it("zoom insuffisant : message clair et aucun marqueur, meme si des propositions sont fournies", () => {
    rendre({ zoomSuffisant: false, propositions: collection(feature(1)) });
    expect(screen.getByRole("status", { name: "" })).toBeInTheDocument();
    expect(screen.getByText("Zoomez pour afficher les propositions")).toBeInTheDocument();
    expect(marqueurs()).toHaveLength(0);
  });

  it("zoom suffisant pour le parent mais emprise visible trop large : meme message, rien n'est demande", () => {
    vi.useFakeTimers();
    h.etat.bounds = { w: -17, s: 8, e: -6, n: 12 }; // 11 degres de large : au-dela de la borne serveur (10)
    const { props } = rendre();
    act(() => { vi.advanceTimersByTime(400); });
    expect(screen.getByText("Zoomez pour afficher les propositions")).toBeInTheDocument();
    expect(props.onEmpriseChange).not.toHaveBeenCalled();
  });

  it("zoom local trop bas malgre un parent optimiste : le message l'emporte", () => {
    h.etat.zoom = 5;
    rendre({ zoomSuffisant: true, propositions: collection(feature(1)) });
    expect(screen.getByText("Zoomez pour afficher les propositions")).toBeInTheDocument();
    expect(marqueurs()).toHaveLength(0);
  });

  it("chargement : message de statut, distinct du vide", () => {
    rendre({ chargement: true, propositions: null });
    expect(screen.getByRole("status")).toHaveTextContent("Chargement des propositions");
    expect(screen.queryByText("Aucune proposition dans cette emprise")).toBeNull();
  });

  it("vide : « Aucune proposition dans cette emprise », different du chargement", () => {
    rendre({ propositions: collection() });
    expect(screen.getByRole("status")).toHaveTextContent("Aucune proposition dans cette emprise");
    expect(screen.queryByText(/Chargement des propositions/)).toBeNull();
  });

  it("pendant un rechargement, le vide n'est pas annonce", () => {
    rendre({ propositions: collection(), chargement: true });
    expect(screen.queryByText("Aucune proposition dans cette emprise")).toBeNull();
    expect(screen.getByText(/Chargement des propositions/)).toBeInTheDocument();
  });

  it("rien charge et rien en cours : le dit, ne laisse pas une carte vide", () => {
    rendre({ propositions: null, chargement: false });
    expect(screen.getByRole("status")).toHaveTextContent("pas encore chargées");
  });

  it("erreur : role=alert avec le message, aucun marqueur, jamais « aucune proposition »", () => {
    rendre({ erreur: "Source indisponible (503)", propositions: collection(feature(1)) });
    expect(screen.getByRole("alert")).toHaveTextContent("Propositions non affichées : Source indisponible (503)");
    expect(marqueurs()).toHaveLength(0);
    expect(screen.queryByText("Aucune proposition dans cette emprise")).toBeNull();
  });

  it("« Reessayer » redemande l'emprise visible", () => {
    vi.useFakeTimers();
    const { props } = rendre({ erreur: "Source indisponible (503)" });
    act(() => { vi.advanceTimersByTime(400); });
    const appels = props.onEmpriseChange as ReturnType<typeof vi.fn>;
    appels.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Réessayer : propositions de la carte" }));
    expect(appels).toHaveBeenCalledTimes(1);
    expect(appels.mock.calls[0][1]).toBe(10);
    expect(appels.mock.calls[0][0]).toEqual([-13.83, 9.47, -13.47, 9.83]);
  });

  it("couche Propositions decochee : le dit, ne dessine rien", () => {
    rendre({ couches: { ...COUCHES, propositions: false }, propositions: collection(feature(1)) });
    expect(screen.getByText(/Couche « Propositions » masquée/)).toBeInTheDocument();
    expect(marqueurs()).toHaveLength(0);
  });
});

describe("dessin des propositions", () => {
  const trois = collection(
    feature(1, { statut: "A_VERIFIER", priorite: "HAUTE", rattachee: true }),
    feature(2, { statut: "CONFIRMEE", priorite: "FAIBLE", rattachee: false }),
    {
      type: "Feature", properties: { id: "synth-poly", type: "INONDATION", statut: "EN_ATTENTE", priorite: "MOYENNE", rattachee: true },
      geometry: { type: "Polygon", coordinates: [[[-13.7, 9.6], [-13.69, 9.6], [-13.69, 9.61], [-13.7, 9.61], [-13.7, 9.6]]] },
    },
  );

  it("un marqueur par proposition lisible, polygone trace en plus, et la synthese dit combien ne sont pas rattachees", () => {
    rendre({ propositions: trois });
    expect(marqueurs()).toHaveLength(3);
    expect(screen.getAllByTestId("polygone")).toHaveLength(1);
    expect(screen.getByText("3 propositions affichées, dont 1 non rattachée à un tronçon.")).toBeInTheDocument();
  });

  it("chaque marqueur porte un nom accessible : type, statut, priorite, rattachement (prefixe « Marqueur : »)", () => {
    rendre({ propositions: trois });
    expect(screen.getByRole("img", { name: "Marqueur : Coupure probable, à vérifier, priorité haute, rattachée à un tronçon" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Marqueur : Coupure probable, confirmée, priorité faible, non rattachée à un tronçon" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Marqueur : Inondation, en attente, priorité moyenne, rattachée à un tronçon" })).toBeInTheDocument();
  });

  it("un marqueur de la carte et son entree dans la liste alternative n'ont jamais le meme nom accessible", async () => {
    const user = userEvent.setup();
    rendre({ propositions: trois });
    await user.click(screen.getByRole("button", { name: /Liste des propositions affichées/ }));
    const liste = within(screen.getByRole("list", { name: "Propositions affichées sur la carte" }));
    const nomsMarqueurs = screen.getAllByRole("img").map((i) => i.getAttribute("aria-label")).filter((n): n is string => !!n && n.startsWith("Marqueur"));
    expect(nomsMarqueurs).toHaveLength(3);
    expect(liste.getAllByRole("button")).toHaveLength(3);
    // Meme proposition, meme texte de fond, mais deux noms distincts : un lecteur d'ecran ne lit pas deux fois la meme chose.
    for (const nomMarqueur of nomsMarqueurs) {
      const libelle = nomMarqueur.replace(/^Marqueur : /, "");
      expect(libelle).not.toBe(nomMarqueur);
      const entree = liste.getByRole("button", { name: libelle });
      expect(entree).toBeInTheDocument();
      expect(screen.queryAllByRole("img", { name: libelle })).toHaveLength(0);
    }
  });

  it("le dessin differe par statut ET par priorite, sans dependre de la couleur", () => {
    rendre({ propositions: trois });
    const dessins = marqueurs().map((m) => m.querySelector("svg")!.innerHTML.replace(/#[0-9a-f]{6}/gi, "#"));
    expect(new Set(dessins).size).toBe(3);
  });

  it("une non rattachee a l'anneau pointille, une rattachee non", () => {
    rendre({ propositions: collection(feature(1, { rattachee: true }), feature(2, { rattachee: false })) });
    const [a, b] = marqueurs();
    expect(a.innerHTML).not.toContain("stroke-dasharray");
    expect(b.innerHTML).toContain("stroke-dasharray");
  });

  it("le marqueur est place a la position de la donnee : latitude puis longitude", () => {
    rendre({ propositions: collection(feature(0)) });
    expect(marqueurs()[0].dataset.pos).toBe("9.6,-13.7");
  });

  it("une zone cliquable de 44 px autour du dessin", () => {
    rendre({ propositions: collection(feature(1)) });
    expect(marqueurs()[0].innerHTML).toContain("width:44px;height:44px");
  });

  it("clic sur un marqueur : onSelect(id)", async () => {
    const user = userEvent.setup();
    const { props } = rendre({ propositions: collection(feature(1), feature(2)) });
    await user.click(marqueurs()[1]);
    expect(props.onSelect).toHaveBeenCalledWith("synth-2");
  });

  it("clic sur un polygone : onSelect(id)", async () => {
    const user = userEvent.setup();
    const { props } = rendre({ propositions: trois });
    await user.click(screen.getByTestId("polygone"));
    expect(props.onSelect).toHaveBeenCalledWith("synth-poly");
  });

  it("clic sur le fond de la carte : onSelect(null)", () => {
    const { props } = rendre({ propositions: collection(feature(1)) });
    act(() => { h.etat.handlers.click?.(); });
    expect(props.onSelect).toHaveBeenCalledWith(null);
  });

  it("selection reflechie : seul le marqueur selectionne a le halo dore et passe au premier plan", () => {
    rendre({ propositions: collection(feature(1), feature(2)), selectionId: "synth-2" });
    const [a, b] = marqueurs();
    expect(a.innerHTML).not.toContain("#f5a623");
    expect(a.dataset.z).toBe("0");
    expect(b.innerHTML).toContain("#f5a623");
    expect(b.dataset.z).toBe("1000");
  });

  it("une selection qui ne correspond a rien est sans effet", () => {
    rendre({ propositions: collection(feature(1)), selectionId: "synth-absent" });
    expect(marqueurs()).toHaveLength(1);
    expect(marqueurs()[0].innerHTML).not.toContain("#f5a623");
  });

  it("ecarte et COMPTE les features illisibles", () => {
    rendre({
      propositions: collection(feature(1), { type: "Feature", properties: { id: "synth-sans-geo" }, geometry: null }, feature(3, { id: "" })),
    });
    expect(marqueurs()).toHaveLength(1);
    expect(screen.getByText(/2 propositions illisibles ignorées/)).toBeInTheDocument();
  });

  it("ne dessine jamais une position inventee : une feature hors bornes est ecartee", () => {
    rendre({ propositions: collection({ type: "Feature", properties: { id: "synth-x" }, geometry: { type: "Point", coordinates: [-13.7, 99] } }) });
    expect(marqueurs()).toHaveLength(0);
    expect(screen.getByText(/1 proposition illisible ignorée/)).toBeInTheDocument();
  });

  it("plafond : N marqueurs au plus, le reste est dit (jamais de troncature silencieuse)", () => {
    const n = PLAFOND_MARQUEURS + 5;
    rendre({ propositions: collection(...Array.from({ length: n }, (_, i) => feature(i))) });
    expect(marqueurs()).toHaveLength(PLAFOND_MARQUEURS);
    expect(screen.getByText("5 propositions non affichées, zoomez")).toBeInTheDocument();
  });

  it("la proposition selectionnee reste dessinee meme au-dela du plafond", () => {
    const n = PLAFOND_MARQUEURS + 5;
    const features = Array.from({ length: n }, (_, i) => feature(i, { priorite: i === n - 1 ? "FAIBLE" : "HAUTE" }));
    rendre({ propositions: collection(...features), selectionId: `synth-${n - 1}` });
    expect(marqueurs()).toHaveLength(PLAFOND_MARQUEURS);
    expect(marqueurs().some((m) => m.innerHTML.includes("#f5a623"))).toBe(true);
  });
});

describe("annonce de l'emprise au parent", () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it("annonce la vue apres 300 ms, elargie de la marge, avec le zoom", () => {
    const { props } = rendre();
    expect(props.onEmpriseChange).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(299); });
    expect(props.onEmpriseChange).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(2); });
    expect(props.onEmpriseChange).toHaveBeenCalledTimes(1);
    const [bbox, zoom] = (props.onEmpriseChange as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(zoom).toBe(10);
    expect(bbox).toEqual([-13.83, 9.47, -13.47, 9.83]);
  });

  it("limite par debounce : dix deplacements rapproches ne font qu'un appel", () => {
    const { props } = rendre();
    act(() => { vi.advanceTimersByTime(400); });
    (props.onEmpriseChange as ReturnType<typeof vi.fn>).mockClear();
    for (let i = 1; i <= 10; i++) {
      deplacer({ w: -13.8 + i, s: 9.5, e: -13.5 + i, n: 9.8 });
      act(() => { vi.advanceTimersByTime(50); });
    }
    expect(props.onEmpriseChange).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(300); });
    expect(props.onEmpriseChange).toHaveBeenCalledTimes(1);
    expect((props.onEmpriseChange as ReturnType<typeof vi.fn>).mock.calls[0][0][0]).toBeCloseTo(-3.83, 2);
  });

  it("ne recharge pas quand la vue reste dans l'emprise deja annoncee", () => {
    const { props } = rendre();
    act(() => { vi.advanceTimersByTime(400); });
    expect(props.onEmpriseChange).toHaveBeenCalledTimes(1);
    deplacer({ w: -13.78, s: 9.51, e: -13.48, n: 9.81 });
    act(() => { vi.advanceTimersByTime(400); });
    expect(props.onEmpriseChange).toHaveBeenCalledTimes(1);
  });

  it("recharge quand la vue sort de l'emprise annoncee", () => {
    const { props } = rendre();
    act(() => { vi.advanceTimersByTime(400); });
    deplacer({ w: -12.8, s: 9.5, e: -12.5, n: 9.8 });
    act(() => { vi.advanceTimersByTime(400); });
    expect(props.onEmpriseChange).toHaveBeenCalledTimes(2);
  });

  it("sous le zoom minimal : previent le parent une fois par niveau de zoom, sans repeter pour un simple deplacement", () => {
    h.etat.zoom = 5;
    h.etat.bounds = { w: -15, s: 8, e: -11, n: 12 };
    const { props } = rendre({ zoomSuffisant: false });
    act(() => { vi.advanceTimersByTime(400); });
    expect(props.onEmpriseChange).toHaveBeenCalledTimes(1);
    expect((props.onEmpriseChange as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe(5);
    deplacer({ w: -14, s: 8, e: -10, n: 12 });
    act(() => { vi.advanceTimersByTime(400); });
    expect(props.onEmpriseChange).toHaveBeenCalledTimes(1);
    deplacer({ w: -14, s: 8, e: -10, n: 12 }, 4);
    act(() => { vi.advanceTimersByTime(400); });
    expect(props.onEmpriseChange).toHaveBeenCalledTimes(2);
  });

  it("apres un retour au zoom suffisant, la demande repart de zero", () => {
    h.etat.zoom = 5;
    h.etat.bounds = { w: -15, s: 8, e: -11, n: 12 };
    const { props } = rendre({ zoomSuffisant: false });
    act(() => { vi.advanceTimersByTime(400); });
    deplacer({ w: -13.8, s: 9.5, e: -13.5, n: 9.8 }, 10);
    act(() => { vi.advanceTimersByTime(400); });
    const appels = (props.onEmpriseChange as ReturnType<typeof vi.fn>).mock.calls;
    expect(appels).toHaveLength(2);
    expect(appels[1][1]).toBe(10);
  });

  it("apres une erreur du parent, un deplacement DANS l'emprise relance quand meme la demande", () => {
    const { props, rerender } = rendre();
    act(() => { vi.advanceTimersByTime(400); });
    rerender(<CarteObservationTerre {...props} erreur="Source indisponible" />);
    deplacer({ w: -13.78, s: 9.51, e: -13.48, n: 9.81 });
    act(() => { vi.advanceTimersByTime(400); });
    expect(props.onEmpriseChange).toHaveBeenCalledTimes(2);
  });

  it("rallumer la couche Propositions redemande l'emprise visible", () => {
    const { props, rerender } = rendre({ couches: { ...COUCHES, propositions: false } });
    act(() => { vi.advanceTimersByTime(400); });
    const avant = (props.onEmpriseChange as ReturnType<typeof vi.fn>).mock.calls.length;
    rerender(<CarteObservationTerre {...props} couches={{ ...COUCHES, propositions: true }} />);
    expect((props.onEmpriseChange as ReturnType<typeof vi.fn>).mock.calls.length).toBe(avant + 1);
  });
});

describe("panneau de couches", () => {
  it("replie/deplie : le bouton annonce l'etat avec aria-expanded", async () => {
    const user = userEvent.setup();
    rendre();
    const bouton = screen.getByRole("button", { name: /Couches d'affichage/ });
    expect(bouton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("group", { name: "Couches d'affichage" })).toBeInTheDocument();
    await user.click(bouton);
    expect(bouton).toHaveAttribute("aria-expanded", "false");
    expect(bouton).toHaveTextContent("Replié");
    expect(screen.queryByRole("group", { name: "Couches d'affichage" })).toBeNull();
    await user.click(bouton);
    expect(bouton).toHaveTextContent("Déplié");
  });

  it("sur un ecran etroit, le panneau est replie a l'ouverture", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    rendre();
    expect(screen.getByRole("button", { name: /Couches d'affichage/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("chaque case est libellee et reflete la prop ; la cocher appelle onCouchesChange avec la nouvelle valeur", async () => {
    const user = userEvent.setup();
    const { props } = rendre();
    const groupe = screen.getByRole("group", { name: "Couches d'affichage" });
    for (const nom of ["Réseau routier", "Propositions (satellite)", "Chantiers", "Ouvrages d'art", "Limites administratives"]) {
      expect(within(groupe).getByRole("checkbox", { name: nom })).toBeInTheDocument();
    }
    expect(within(groupe).getByRole("checkbox", { name: "Propositions (satellite)" })).toBeChecked();
    expect(within(groupe).getByRole("checkbox", { name: "Chantiers" })).not.toBeChecked();
    await user.click(within(groupe).getByRole("checkbox", { name: "Chantiers" }));
    expect(props.onCouchesChange).toHaveBeenCalledWith({ ...COUCHES, chantiers: true });
  });

  it("Observations terrain : case desactivee, decochee, avec « non disponible dans cette vue »", async () => {
    const user = userEvent.setup();
    const { props } = rendre({ couches: { ...COUCHES, observationsTerrain: true } });
    const case_ = screen.getByRole("checkbox", { name: "Observations terrain" });
    expect(case_).toBeDisabled();
    expect(case_).not.toBeChecked();
    expect(screen.getByText("non disponible dans cette vue")).toBeInTheDocument();
    expect(case_).toHaveAccessibleDescription("non disponible dans cette vue");
    await user.click(case_);
    expect(props.onCouchesChange).not.toHaveBeenCalled();
  });

  it("aucune couche optionnelle n'est chargee tant que sa case n'est pas cochee", () => {
    rendre();
    expect(h.axiosGet).not.toHaveBeenCalled();
    expect(h.apiGet).not.toHaveBeenCalled();
  });

  it("reseau : charge le fond statique a la premiere activation, annonce combien de tracés, sans etat de chaussee", async () => {
    const trace = { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[-13.7, 9.6], [-13.6, 9.7]] } };
    h.axiosGet.mockResolvedValue({ data: { type: "FeatureCollection", features: [trace, trace, trace] } });
    rendre({ couches: { ...COUCHES, reseau: true } });
    await waitFor(() => expect(screen.getByText(/3 tracés d'un fond statique : sans état de chaussée/)).toBeInTheDocument());
    expect(h.axiosGet).toHaveBeenCalledWith("/osm-routes.geojson");
    expect(h.axiosGet).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId("geojson").some((g) => g.dataset.n === "3")).toBe(true);
  });

  it("reseau en erreur : message dans le panneau (alerte), pas une couche vide", async () => {
    h.axiosGet.mockRejectedValue({ isAxiosError: true, message: "Network Error" });
    rendre({ couches: { ...COUCHES, reseau: true } });
    const panneau = screen.getByRole("group", { name: "Couches d'affichage" });
    await waitFor(() => expect(within(panneau).getByRole("alert")).toHaveTextContent("Réseau indisponible : chargement impossible."));
    expect(screen.queryAllByTestId("geojson")).toHaveLength(0);
  });

  it("limites : 404 devient « Aucune limite administrative en base », sans trace invente", async () => {
    h.apiGet.mockRejectedValue({ isAxiosError: true, response: { status: 404, data: { error: "x" } } });
    rendre({ couches: { ...COUCHES, limites: true } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Aucune limite administrative en base : rien n'est tracé."));
    expect(h.apiGet).toHaveBeenCalledWith("/v2/geo/contour");
    expect(screen.queryAllByTestId("geojson")).toHaveLength(0);
  });

  it("limites : 403 dit que le module manque", async () => {
    h.apiGet.mockRejectedValue({ isAxiosError: true, response: { status: 403, data: {} } });
    rendre({ couches: { ...COUCHES, limites: true } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Accès refusé"));
  });

  it("limites : reponse valide, contour trace avec la mention « pas une frontiere officielle »", async () => {
    h.apiGet.mockResolvedValue({ data: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[-13.7, 9.6], [-13.6, 9.6], [-13.6, 9.7], [-13.7, 9.6]]] } } });
    rendre({ couches: { ...COUCHES, limites: true } });
    await waitFor(() => expect(screen.getByText("Contour simplifié, pas une frontière officielle")).toBeInTheDocument());
    expect(screen.getAllByTestId("geojson")).toHaveLength(1);
  });

  it("ouvrages : marqueurs du geoportail, nombre annonce ; liste vide dite « Aucun element en base »", async () => {
    h.apiGet.mockResolvedValue({ data: [
      { id: "o1", nom: "Ouvrage synthetique 1", type: "PONT", etat: "BON", lat: 9.6, lon: -13.7, repris: false },
      { id: "o2", nom: "Ouvrage synthetique 2", type: "DALOT", etat: "CRITIQUE", lat: 9.61, lon: -13.71, repris: true },
    ] });
    rendre({ couches: { ...COUCHES, ouvrages: true } });
    await waitFor(() => expect(screen.getByText("2 éléments")).toBeInTheDocument());
    expect(h.apiGet).toHaveBeenCalledWith("/ouvrages/geo");
    expect(screen.getAllByTestId("marqueur").filter((m) => m.dataset.classe === "bdri-nature-marker")).toHaveLength(2);
    expect(screen.getByText(/Pont : Ouvrage synthetique 1/)).toBeInTheDocument();
  });

  it("chantiers : liste vide dite, jamais confondue avec une couche qui n'a pas charge", async () => {
    h.apiGet.mockResolvedValue({ data: [] });
    rendre({ couches: { ...COUCHES, chantiers: true } });
    await waitFor(() => expect(screen.getByText("Aucun élément en base")).toBeInTheDocument());
    expect(h.apiGet).toHaveBeenCalledWith("/chantiers/geo");
  });

  it("chantiers : une ligne pour un trace exact, un marqueur pour une position approximative", async () => {
    h.apiGet.mockResolvedValue({ data: [
      { id: "c1", intitule: "Chantier synthetique A", statut: "EN_COURS", approximate: false, geometry: '{"type":"LineString","coordinates":[[-13.7,9.6],[-13.69,9.61]]}', lat: null, lon: null, region: "R" },
      { id: "c2", intitule: "Chantier synthetique B", statut: "PLANIFIE", approximate: true, geometry: null, lat: 9.7, lon: -13.6, region: "R" },
      { id: "c3", intitule: "Chantier sans position", statut: "PLANIFIE", approximate: true, geometry: null, lat: null, lon: null, region: "R" },
    ] });
    rendre({ couches: { ...COUCHES, chantiers: true } });
    await waitFor(() => expect(screen.getByText("3 éléments")).toBeInTheDocument());
    expect(screen.getAllByTestId("ligne")).toHaveLength(1);
    expect(screen.getByText(/Chantier synthetique B \(position approximative/)).toBeInTheDocument();
    expect(screen.queryByText(/Chantier sans position/)).toBeNull();
  });

  it("une couche en erreur se recharge quand on la decoche puis la recoche", async () => {
    h.apiGet.mockRejectedValueOnce({ isAxiosError: true, response: { status: 500, data: { error: "Panne serveur" } } });
    h.apiGet.mockResolvedValueOnce({ data: [] });
    const { rerender, props } = rendre({ couches: { ...COUCHES, chantiers: true } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Panne serveur"));
    rerender(<CarteObservationTerre {...props} couches={{ ...COUCHES, chantiers: false }} />);
    rerender(<CarteObservationTerre {...props} couches={{ ...COUCHES, chantiers: true }} />);
    await waitFor(() => expect(screen.getByText("Aucun élément en base")).toBeInTheDocument());
    expect(h.apiGet).toHaveBeenCalledTimes(2);
  });
});

describe("troncature annoncee par le serveur (contrat §5)", () => {
  const deux = collection(feature(1), feature(2));

  it("reponse tronquee : « N au total, seules les M plus prioritaires sont affichees : zoomez »", () => {
    rendre({ propositions: deux, troncature: { tronque: true, total: 412 } });
    expect(screen.getByText("412 propositions au total, seules les 2 plus prioritaires sont affichées : zoomez")).toBeInTheDocument();
    expect(screen.getByText("412 propositions au total, seules les 2 plus prioritaires sont affichées : zoomez").closest("[role=status]")).not.toBeNull();
  });

  it("reponse complete, absente ou null : aucun message de troncature", () => {
    const { rerender, props } = rendre({ propositions: deux, troncature: { tronque: false, total: 2 } });
    expect(screen.queryByText(/au total, seules/)).toBeNull();
    rerender(<CarteObservationTerre {...props} troncature={null} />);
    expect(screen.queryByText(/au total, seules/)).toBeNull();
    rerender(<CarteObservationTerre {...props} troncature={undefined} />);
    expect(screen.queryByText(/au total, seules/)).toBeNull();
  });

  it("le message compte ce qui est dessine, apres le plafond du navigateur", () => {
    const n = PLAFOND_MARQUEURS + 5;
    rendre({ propositions: collection(...Array.from({ length: n }, (_, i) => feature(i))), troncature: { tronque: true, total: 900 } });
    expect(screen.getByText(`900 propositions au total, seules les ${PLAFOND_MARQUEURS} plus prioritaires sont affichées : zoomez`)).toBeInTheDocument();
    expect(screen.getByText("5 propositions non affichées, zoomez")).toBeInTheDocument();
  });

  it("pas de message sur une carte qui ne dessine pas (zoom insuffisant ou erreur) : le message de zoom ou d'erreur parle seul", () => {
    rendre({ propositions: deux, troncature: { tronque: true, total: 412 }, zoomSuffisant: false });
    expect(screen.queryByText(/au total, seules/)).toBeNull();
  });

  describe("rechargement", () => {
    beforeEach(() => { vi.useFakeTimers(); });

    it("zoomer DANS l'emprise chargee relance la demande quand la reponse etait tronquee", () => {
      const { props } = rendre({ propositions: deux, troncature: { tronque: true, total: 412 } });
      act(() => { vi.advanceTimersByTime(400); });
      expect(props.onEmpriseChange).toHaveBeenCalledTimes(1);
      deplacer({ w: -13.7, s: 9.6, e: -13.6, n: 9.7 }, 12);
      act(() => { vi.advanceTimersByTime(400); });
      expect(props.onEmpriseChange).toHaveBeenCalledTimes(2);
      const [bbox, zoom] = (props.onEmpriseChange as ReturnType<typeof vi.fn>).mock.calls[1];
      expect(zoom).toBe(12);
      expect(bbox[0]).toBeGreaterThan(-13.8); // la nouvelle emprise est plus petite que la premiere : on affine
    });

    it("la meme manoeuvre sur une reponse complete ne recharge rien", () => {
      const { props } = rendre({ propositions: deux, troncature: { tronque: false, total: 2 } });
      act(() => { vi.advanceTimersByTime(400); });
      deplacer({ w: -13.7, s: 9.6, e: -13.6, n: 9.7 }, 12);
      act(() => { vi.advanceTimersByTime(400); });
      expect(props.onEmpriseChange).toHaveBeenCalledTimes(1);
    });

    it("l'arrivee d'une reponse tronquee ne relance pas, a elle seule, une demande (pas de boucle)", () => {
      const { props, rerender } = rendre({ propositions: null });
      act(() => { vi.advanceTimersByTime(400); });
      rerender(<CarteObservationTerre {...props} propositions={deux} troncature={{ tronque: true, total: 412 }} />);
      act(() => { vi.advanceTimersByTime(2000); });
      expect(props.onEmpriseChange).toHaveBeenCalledTimes(1);
    });
  });
});

describe("couches optionnelles : une reponse invalide n'emporte pas la page", () => {
  // Ce que Leaflet ferait de ces reponses : « Invalid GeoJSON object » (ou une TypeError), donc un ecran d'erreur React Router.
  // Le double de <GeoJSON> ci-dessus ne leve pas : on verifie donc que la carte NE LUI LES CONFIE JAMAIS.
  const invalides: [string, unknown][] = [
    ["{}", {}],
    ["null", null],
    ["une FeatureCollection sans features", { type: "FeatureCollection" }],
    ["une Feature a geometrie nulle", { type: "Feature", properties: {}, geometry: null }],
    ["une page HTML", "<!doctype html><html></html>"],
  ];

  it.each(invalides)("limites : %s -> couche ignoree, message, aucun GeoJSON dessine, compteur d'anomalie", async (_nom, reponse) => {
    h.apiGet.mockResolvedValue({ data: reponse });
    rendre({ couches: { ...COUCHES, limites: true } });
    const panneau = screen.getByRole("group", { name: "Couches d'affichage" });
    await waitFor(() => expect(within(panneau).getByRole("alert")).toHaveTextContent("Données de la couche « Limites administratives » invalides : couche ignorée"));
    expect(screen.queryAllByTestId("geojson")).toHaveLength(0);
    expect(screen.getByText("1 anomalie dans les données des couches", { exact: false })).toBeInTheDocument();
    // le reste de la carte vit
    expect(screen.getByTestId("carte")).toBeInTheDocument();
  });

  it.each(invalides)("reseau : %s -> couche ignoree, aucun GeoJSON dessine", async (_nom, reponse) => {
    h.axiosGet.mockResolvedValue({ data: reponse });
    rendre({ couches: { ...COUCHES, reseau: true } });
    const panneau = screen.getByRole("group", { name: "Couches d'affichage" });
    await waitFor(() => expect(within(panneau).getByRole("alert")).toHaveTextContent("Données de la couche « Réseau routier » invalides"));
    expect(screen.queryAllByTestId("geojson")).toHaveLength(0);
  });

  it.each([["{}", {}], ["null", null], ["un texte", "oups"]])("ouvrages : %s -> couche ignoree (un .map dessus ferait planter le rendu)", async (_nom, reponse) => {
    h.apiGet.mockResolvedValue({ data: reponse });
    rendre({ couches: { ...COUCHES, ouvrages: true } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Données de la couche « Ouvrages d'art » invalides"));
    expect(screen.queryAllByTestId("marqueur").filter((m) => m.dataset.classe === "bdri-nature-marker")).toHaveLength(0);
  });

  it.each([["{}", {}], ["null", null]])("chantiers : %s -> couche ignoree", async (_nom, reponse) => {
    h.apiGet.mockResolvedValue({ data: reponse });
    rendre({ couches: { ...COUCHES, chantiers: true } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Données de la couche « Chantiers » invalides"));
  });

  it("collection mixte : les elements lisibles sont traces, les illisibles ecartes ET comptes", async () => {
    const trace = { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[-13.7, 9.6], [-13.6, 9.7]] } };
    h.axiosGet.mockResolvedValue({ data: { type: "FeatureCollection", features: [trace, { type: "Feature", properties: {}, geometry: null }, { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [999, 0] } }] } });
    rendre({ couches: { ...COUCHES, reseau: true } });
    await waitFor(() => expect(screen.getByText("2 éléments illisibles ignorés")).toBeInTheDocument());
    expect(screen.getAllByTestId("geojson").some((g) => g.dataset.n === "1")).toBe(true);
    expect(screen.getByText("2 anomalies dans les données des couches", { exact: false })).toBeInTheDocument();
  });

  it("ouvrages : un element sans position est ecarte et compte, les autres sont dessines", async () => {
    h.apiGet.mockResolvedValue({ data: [
      { id: "o1", nom: "Ouvrage synthetique 1", type: "PONT", etat: "BON", lat: 9.6, lon: -13.7, repris: false },
      { id: "o2", nom: "Sans position", type: "PONT", etat: "BON", lat: null, lon: null, repris: false },
    ] });
    rendre({ couches: { ...COUCHES, ouvrages: true } });
    await waitFor(() => expect(screen.getByText("1 élément illisible ignoré")).toBeInTheDocument());
    expect(screen.getAllByTestId("marqueur").filter((m) => m.dataset.classe === "bdri-nature-marker")).toHaveLength(1);
  });

  it("une couche invalide se recharge quand on la decoche puis la recoche", async () => {
    h.apiGet.mockResolvedValueOnce({ data: {} });
    h.apiGet.mockResolvedValueOnce({ data: [] });
    const { rerender, props } = rendre({ couches: { ...COUCHES, chantiers: true } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("invalides"));
    rerender(<CarteObservationTerre {...props} couches={{ ...COUCHES, chantiers: false }} />);
    rerender(<CarteObservationTerre {...props} couches={{ ...COUCHES, chantiers: true }} />);
    await waitFor(() => expect(screen.getByText("Aucun élément en base")).toBeInTheDocument());
    expect(screen.queryByText(/anomalie/)).toBeNull();
  });

  it("les propositions restent dessinees quand une couche est invalide", async () => {
    h.apiGet.mockResolvedValue({ data: {} });
    rendre({ couches: { ...COUCHES, limites: true }, propositions: collection(feature(1)) });
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(marqueurs()).toHaveLength(1);
  });
});

describe("fond de carte, echelle, plein ecran, cadrage", () => {
  it("ouvre sur la Guinee (centre du geoportail, zoom NATIONAL 6), avec une echelle", () => {
    rendre();
    expect(screen.getByTestId("carte")).toHaveAttribute("data-centre", "10.5,-10.8");
    expect(screen.getByTestId("carte")).toHaveAttribute("data-zoom", "6");
    expect(screen.getByTestId("echelle")).toBeInTheDocument();
  });

  describe("vue d'ouverture nationale honnete (M2 de la relecture)", () => {
    it("conteneur de 453 x 440 px : la Guinee entiere (9,96 x 9,5 degres) au zoom 6, sans « Zoomez », avec une demande d'emprise des l'ouverture", () => {
      vi.useFakeTimers();
      h.etat.taille = { x: 453, y: 440 };
      const { props } = rendre({ zoomSuffisant: true });
      expect(h.map.setView).toHaveBeenLastCalledWith([10.5, -10.8], 6, { animate: false });
      act(() => { vi.advanceTimersByTime(400); });
      expect(screen.queryByText("Zoomez pour afficher les propositions")).toBeNull();
      const appels = (props.onEmpriseChange as ReturnType<typeof vi.fn>).mock.calls;
      expect(appels).toHaveLength(1);
      expect(appels[0][1]).toBe(6);
      // l'emprise demandee est celle de la Guinee, et elle passe la borne serveur
      const [o, s, e, n] = appels[0][0] as number[];
      expect(e - o).toBeLessThanOrEqual(10);
      expect(n - s).toBeLessThanOrEqual(10);
      expect(o).toBeLessThan(-15.1); expect(e).toBeGreaterThan(-7.6); // couvre le pays (environ -15,1 a -7,6)
    });

    it("conteneur plus haut (453 x 518 px) : 11,2 degres de haut au zoom 6, la carte s'approche d'un cran (zoom 7) au lieu de rester muette", () => {
      vi.useFakeTimers();
      h.etat.taille = { x: 453, y: 518 };
      const { props } = rendre({ zoomSuffisant: true });
      expect(h.map.setView).toHaveBeenLastCalledWith([10.5, -10.8], 7, { animate: false });
      act(() => { vi.advanceTimersByTime(400); });
      expect(screen.queryByText("Zoomez pour afficher les propositions")).toBeNull();
      expect((props.onEmpriseChange as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe(7);
    });

    it("conteneur sans taille (masque, jsdom) : la vue initiale est conservee, rien n'est recadre", () => {
      rendre();
      expect(h.map.setView).not.toHaveBeenCalled();
    });

    it("avec 300 propositions plafonnees : les 300 plus prioritaires sont dessinees et la troncature est DITE", () => {
      vi.useFakeTimers();
      h.etat.taille = { x: 453, y: 440 };
      rendre({
        zoomSuffisant: true, troncature: { tronque: true, total: 412 },
        propositions: collection(...Array.from({ length: PLAFOND_MARQUEURS }, (_, i) => feature(i))),
      });
      act(() => { vi.advanceTimersByTime(400); });
      expect(marqueurs()).toHaveLength(PLAFOND_MARQUEURS);
      expect(screen.getByText(/412 propositions au total, seules les 300 plus prioritaires sont affichées : zoomez/)).toBeInTheDocument();
    });
  });

  it("la legende n'a pas de titre h4 sans h3 (ordre des titres) : ses sous-titres sont des h3", () => {
    const { container } = rendre();
    expect(container.querySelectorAll("h4")).toHaveLength(0);
    const titres = Array.from(container.querySelectorAll("h1, h2, h3, h4, h5, h6")).map((e) => e.tagName);
    expect(titres).toEqual(["H3", "H3", "H3"]);
  });

  it("n'emploie que des fournisseurs de tuiles deja utilises par le geoportail (Esri, OpenStreetMap)", async () => {
    const user = userEvent.setup();
    rendre();
    const urls: string[] = [screen.getByTestId("tuiles").dataset.url!];
    for (const nom of ["Plan clair", "OpenStreetMap", "Satellite"]) {
      await user.click(screen.getByRole("button", { name: nom }));
      urls.push(screen.getByTestId("tuiles").dataset.url!);
    }
    for (const u of urls) expect(u).toMatch(/^https:\/\/(server\.arcgisonline\.com\/|\{s\}\.tile\.openstreetmap\.org\/)/);
    expect(urls[0]).toContain("World_Imagery");
    expect(urls[2]).toContain("openstreetmap.org");
  });

  it("le fond choisi est signale (aria-pressed) et l'attribution suit, avec le credit des donnees", async () => {
    const user = userEvent.setup();
    rendre();
    expect(screen.getByRole("button", { name: "Satellite" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "OpenStreetMap" }));
    expect(screen.getByRole("button", { name: "OpenStreetMap" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Satellite" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("tuiles").dataset.attribution).toContain("OpenStreetMap");
  });

  it("plein ecran : le bouton bascule, Echap quitte, la carte est redimensionnee", async () => {
    const user = userEvent.setup();
    const { container } = rendre();
    const section = container.querySelector("section")!;
    await user.click(screen.getByRole("button", { name: "Plein écran" }));
    expect(section.className).toContain("fixed inset-0");
    expect(screen.getByRole("button", { name: "Quitter le plein écran" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(h.map.invalidateSize).toHaveBeenCalled());
    await user.keyboard("{Escape}");
    expect(section.className).not.toContain("fixed inset-0");
  });

  it("demontage : tous les ecouteurs poses sur window et document (Echap du plein ecran compris) sont retires", () => {
    const { unmount } = rendre();
    const espion = espionnerEcouteurs(); // apres le rendu : on ne compte que ce que la carte pose elle-meme
    fireEvent.click(screen.getByRole("button", { name: "Plein écran" }));
    expect(espion.ajouts.some((a) => a.cible === "window" && a.type === "keydown")).toBe(true); // l'ecouteur d'Echap existe bien tant que le plein ecran est ouvert
    unmount();
    expect(ecouteursOrphelins(espion)).toEqual([]);
  });

  describe("plein ecran : le reste de la page est inerte (EO-FIX-FRONT 5)", () => {
    function dansUnePage() {
      const props: CarteObservationTerreProps = {
        propositions: null, chargement: false, erreur: null, zoomSuffisant: true, selectionId: null,
        onSelect: vi.fn(), onEmpriseChange: vi.fn(), couches: COUCHES, onCouchesChange: vi.fn(),
      };
      return render(
        <div id="page">
          <header>entete <a href="#x">lien</a></header>
          <main>
            <div id="avant"><button type="button">avant</button></div>
            <div id="enveloppe"><div><CarteObservationTerre {...props} /></div></div>
            <div id="apres"><button type="button">apres</button></div>
          </main>
          <footer>pied</footer>
        </div>,
      );
    }
    const inertes = (c: HTMLElement) => ["header", "#avant", "#apres", "footer"].map((sel) => c.querySelector(sel)!.hasAttribute("inert"));

    it("a l'ouverture du plein ecran : les freres de la carte, a chaque niveau, sont inertes ; la carte et ses ancetres ne le sont pas", async () => {
      const user = userEvent.setup();
      const { container } = dansUnePage();
      expect(inertes(container)).toEqual([false, false, false, false]);
      await user.click(screen.getByRole("button", { name: "Plein écran" }));
      expect(inertes(container)).toEqual([true, true, true, true]);
      for (const sel of ["#page", "main", "#enveloppe", "section[aria-label='Carte des propositions']"]) expect(container.querySelector(sel)!.hasAttribute("inert"), sel).toBe(false);
      // la carte reste utilisable : son propre bouton n'est pas inerte
      expect(screen.getByRole("button", { name: "Quitter le plein écran" }).closest("[inert]")).toBeNull();
    });

    it("Echap (comme le bouton) : l'inertie est levee et le focus revient sur le bouton « Plein ecran », pas sur le corps de la page", async () => {
      const user = userEvent.setup();
      const { container } = dansUnePage();
      await user.click(screen.getByRole("button", { name: "Plein écran" }));
      await user.keyboard("{Escape}");
      expect(inertes(container)).toEqual([false, false, false, false]);
      expect(container.querySelector("[inert]")).toBeNull();
      expect(screen.getByRole("button", { name: "Plein écran" })).toHaveFocus();
      await user.click(screen.getByRole("button", { name: "Plein écran" }));
      await user.click(screen.getByRole("button", { name: "Quitter le plein écran" }));
      expect(container.querySelector("[inert]")).toBeNull();
      expect(screen.getByRole("button", { name: "Plein écran" })).toHaveFocus();
    });

    it("Echap pressee alors que le focus est ailleurs dans la carte : il revient sur le bouton « Plein ecran » (restitution explicite)", async () => {
      const user = userEvent.setup();
      dansUnePage();
      await user.click(screen.getByRole("button", { name: "Plein écran" }));
      screen.getByRole("button", { name: /Couches d'affichage/ }).focus();
      expect(screen.getByRole("button", { name: /Couches d'affichage/ })).toHaveFocus();
      await user.keyboard("{Escape}");
      expect(screen.getByRole("button", { name: "Plein écran" })).toHaveFocus();
    });

    it("demontee en plein ecran : l'inertie ne reste pas sur la page", async () => {
      const user = userEvent.setup();
      const { container, unmount } = dansUnePage();
      await user.click(screen.getByRole("button", { name: "Plein écran" }));
      const page = container.firstElementChild as HTMLElement;
      const freres = Array.from(container.querySelectorAll("header, footer, #avant, #apres"));
      unmount();
      expect(freres.every((e) => !e.hasAttribute("inert"))).toBe(true);
      expect(page.querySelector("[inert]")).toBeNull();
    });

    it("un frere deja inerte avant le plein ecran le reste apres (on ne leve que ce qu'on a pose)", async () => {
      const user = userEvent.setup();
      const { container } = dansUnePage();
      container.querySelector("footer")!.setAttribute("inert", "");
      await user.click(screen.getByRole("button", { name: "Plein écran" }));
      await user.keyboard("{Escape}");
      expect(container.querySelector("footer")!.hasAttribute("inert")).toBe(true);
      expect(container.querySelector("header")!.hasAttribute("inert")).toBe(false);
    });
  });

  it("focus du parent : la carte se recadre sur son emprise, une seule fois par emprise", () => {
    const { rerender, props } = rendre({ focus: { bbox: [-13.2, 9.9, -13.1, 10] } });
    expect(h.map.fitBounds).toHaveBeenCalledTimes(1);
    expect(h.map.fitBounds.mock.calls[0][0]).toEqual([[9.9, -13.2], [10, -13.1]]);
    rerender(<CarteObservationTerre {...props} focus={{ bbox: [-13.2, 9.9, -13.1, 10] }} />);
    expect(h.map.fitBounds).toHaveBeenCalledTimes(1);
    rerender(<CarteObservationTerre {...props} focus={{ bbox: [-12.2, 9.9, -12.1, 10] }} />);
    expect(h.map.fitBounds).toHaveBeenCalledTimes(2);
  });

  it("className est applique a la section", () => {
    const { container } = rendre({ className: "ma-classe" });
    expect(container.querySelector("section")!.className).toContain("ma-classe");
  });
});

describe("recherche de zone ou de tronçon, branchee sur la carte", () => {
  it("choisir une zone recadre la carte autour du chef-lieu et dit que le centre est approximatif", async () => {
    const user = userEvent.setup();
    rendre();
    await user.type(screen.getByRole("searchbox", { name: "Rechercher une zone ou un tronçon" }), "kindi");
    await user.click(await screen.findByRole("button", { name: /Kindia/ }));
    expect(h.map.fitBounds).toHaveBeenCalledTimes(1);
    const [[s, w], [n, e]] = h.map.fitBounds.mock.calls[0][0];
    expect([s, w, n, e].map((v: number) => Math.round(v * 100) / 100)).toEqual([9.96, -12.96, 10.16, -12.76]);
    expect(screen.getByText(/centre approximatif du chef-lieu/)).toBeInTheDocument();
  });

  it("choisir un tronçon charge son trace et recadre dessus", async () => {
    const user = userEvent.setup();
    h.apiGet.mockImplementation(async (url: string) => {
      if (url === "/v2/troncons-recherche") return { data: { data: [{ id: "t1", code: "SYNTH 1", nom: "Troncon synthetique", region: "Region synthetique" }] } };
      if (url === "/troncons/geo") return { data: [{ id: "t1", geometry: '{"type":"LineString","coordinates":[[-13.5,9.5],[-13.1,9.9]]}' }] };
      throw new Error(`appel inattendu ${url}`);
    });
    rendre();
    await user.type(screen.getByRole("searchbox"), "synth");
    await user.click(await screen.findByRole("button", { name: /SYNTH 1/ }, { timeout: 3000 }));
    await waitFor(() => expect(h.map.fitBounds).toHaveBeenCalledTimes(1));
    expect(h.map.fitBounds.mock.calls[0][0]).toEqual([[9.5, -13.5], [9.9, -13.1]]);
  });

  it("un tronçon sans trace dans le reseau de reference : message, la carte n'est PAS recadree", async () => {
    const user = userEvent.setup();
    h.apiGet.mockImplementation(async (url: string) => {
      if (url === "/v2/troncons-recherche") return { data: { data: [{ id: "t9", code: "SYNTH 9", nom: "Hors reseau", region: "R" }] } };
      return { data: [] };
    });
    rendre();
    await user.type(screen.getByRole("searchbox"), "synth");
    await user.click(await screen.findByRole("button", { name: /SYNTH 9/ }, { timeout: 3000 }));
    expect(await screen.findByText(/Tracé indisponible pour SYNTH 9/)).toBeInTheDocument();
    expect(h.map.fitBounds).not.toHaveBeenCalled();
  });
});

describe("liste alternative au clavier", () => {
  const trois = collection(feature(1), feature(2, { rattachee: false }), feature(3, { statut: "INFIRMEE", priorite: null }));

  it("replie par defaut, le bouton annonce l'etat et le nombre", async () => {
    const user = userEvent.setup();
    rendre({ propositions: trois });
    const bouton = screen.getByRole("button", { name: /Liste des propositions affichées \(3\)/ });
    expect(bouton).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "Propositions affichées sur la carte" })).toBeNull();
    await user.click(bouton);
    expect(bouton).toHaveAttribute("aria-expanded", "true");
    expect(within(screen.getByRole("list", { name: "Propositions affichées sur la carte" })).getAllByRole("listitem")).toHaveLength(3);
  });

  it("chaque proposition est un bouton nomme ; l'activer au clavier selectionne", async () => {
    const user = userEvent.setup();
    const { props } = rendre({ propositions: trois, selectionId: "synth-2" });
    await user.click(screen.getByRole("button", { name: /Liste des propositions affichées/ }));
    const liste = screen.getByRole("list", { name: "Propositions affichées sur la carte" });
    const boutons = within(liste).getAllByRole("button");
    expect(boutons.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true", "false"]);
    boutons[2].focus();
    await user.keyboard("{Enter}");
    expect(props.onSelect).toHaveBeenCalledWith("synth-3");
    expect(within(liste).getByRole("button", { name: /non rattachée à un tronçon/ })).toBeInTheDocument();
  });

  it("choisir une proposition hors de la vue recentre la carte (panTo) ; dans la vue, non", async () => {
    const user = userEvent.setup();
    const hors = collection(feature(1), { ...feature(2), geometry: { type: "Point" as const, coordinates: [-13.0, 9.65] } });
    rendre({ propositions: hors });
    await user.click(screen.getByRole("button", { name: /Liste des propositions affichées/ }));
    const boutons = within(screen.getByRole("list", { name: "Propositions affichées sur la carte" })).getAllByRole("button");
    await user.click(boutons[0]);
    expect(h.map.panTo).not.toHaveBeenCalled();
    await user.click(boutons[1]);
    expect(h.map.panTo).toHaveBeenCalledWith([9.65, -13.0]);
  });

  it("liste vide : le dit au lieu de n'afficher rien", async () => {
    const user = userEvent.setup();
    rendre({ propositions: collection() });
    await user.click(screen.getByRole("button", { name: /Liste des propositions affichées \(0\)/ }));
    expect(screen.getByText("Aucune proposition affichée sur la carte.")).toBeInTheDocument();
  });
});

describe("legende", () => {
  it("donne chaque statut, chaque priorite, le rattachement et la selection", async () => {
    const user = userEvent.setup();
    rendre();
    await user.click(screen.getByText("Légende des marqueurs"));
    for (const t of ["À vérifier", "En attente", "Non concluante", "Confirmée", "Infirmée"]) expect(screen.getAllByText(t).length).toBeGreaterThan(0);
    for (const t of ["Priorité haute", "Priorité moyenne", "Priorité faible", "Priorité non établie"]) expect(screen.getByText(t)).toBeInTheDocument();
    expect(screen.getByText(/Anneau pointillé : non rattachée à un tronçon/)).toBeInTheDocument();
    expect(screen.getByText(/Halo doré : proposition sélectionnée/)).toBeInTheDocument();
  });
});

describe("accessibilite (axe)", () => {
  it("sans violation, panneau, legende et liste ouverts, avec des propositions", async () => {
    const user = userEvent.setup();
    const { container } = rendre({
      propositions: collection(feature(1), feature(2, { rattachee: false, statut: "CONFIRMEE" }), feature(3, { priorite: null, statut: "BIZARRE" })),
      selectionId: "synth-1",
    });
    await user.click(screen.getByText("Légende des marqueurs"));
    await user.click(screen.getByRole("button", { name: /Liste des propositions affichées/ }));
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it.each([
    ["zoom insuffisant", { zoomSuffisant: false }],
    ["erreur", { erreur: "Source indisponible" }],
    ["chargement", { chargement: true }],
    ["vide", { propositions: collection() }],
  ] as [string, Partial<CarteObservationTerreProps>][])("sans violation : %s", async (_n, over) => {
    const { container } = rendre(over);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("sans violation avec le panneau replie", async () => {
    const user = userEvent.setup();
    const { container } = rendre();
    await user.click(screen.getByRole("button", { name: /Couches d'affichage/ }));
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("sans violation avec la recherche ouverte", async () => {
    const user = userEvent.setup();
    const { container } = rendre();
    await user.type(screen.getByRole("searchbox"), "kin");
    expect(await screen.findByRole("list", { name: "Résultats de la recherche" })).toBeInTheDocument();
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

describe("controles tactiles", () => {
  it("les boutons et cases de la carte ont une cible d'au moins 44 px (classes h-11 / min-h-11 sur ecran etroit)", () => {
    const { container } = rendre({ propositions: collection(feature(1)) });
    const boutons = Array.from(container.querySelectorAll<HTMLElement>("button, summary")).filter((b) => !b.dataset.testid);
    expect(boutons.length).toBeGreaterThan(5);
    for (const b of boutons) {
      const nom = b.getAttribute("aria-label") ?? b.textContent;
      // Les boutons de fond de carte n'ont h-11 qu'en dessous de md : on lit la classe de base.
      expect(b.className, `cible tactile de « ${nom} »`).toMatch(/(^|\s)(h-11|min-h-11)(\s|$)/);
    }
  });
});

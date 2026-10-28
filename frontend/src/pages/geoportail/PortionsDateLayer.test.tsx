import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { PortionALaDate, ReponseCurseur } from "../../lib/curseur";

/**
 * La couche des portions a une date : ce que ces tests defendent.
 *
 *   - RIEN ne se charge sous le zoom minimal : l'emprise depasserait ce que le serveur accepte ;
 *   - la requete porte la date, l'emprise, l'axe systeme et les propositions, rien d'autre ;
 *   - le trace porte l'ETAT DE LA PORTION, avec son motif de trait, et une proposition est attenuee ;
 *   - un refus du serveur est rendu avec SON message, jamais un ecran muet ;
 *   - seule une LigneString est dessinee ; une geometrie absente ou degeneree est ignoree sans casser.
 */

const h = vi.hoisted(() => ({
  zoom: 12,
  bounds: { w: -13.8, s: 9.5, e: -13.5, n: 9.8 },
  handlers: {} as Record<string, () => void>,
  appels: [] as { url: string; params: Record<string, string> }[],
  reponse: null as unknown,
  erreur: null as unknown,
  lignes: [] as { positions: [number, number][]; options: Record<string, unknown> }[],
}));

vi.mock("react-leaflet", () => ({
  useMapEvents: (hd: Record<string, () => void>) => {
    h.handlers = hd;
    return {
      getZoom: () => h.zoom,
      getBounds: () => ({ getWest: () => h.bounds.w, getSouth: () => h.bounds.s, getEast: () => h.bounds.e, getNorth: () => h.bounds.n }),
    };
  },
  Polyline: ({ positions, pathOptions, children }: { positions: [number, number][]; pathOptions: Record<string, unknown>; children?: React.ReactNode }) => {
    h.lignes.push({ positions, options: pathOptions });
    return <div data-testid="ligne">{children}</div>;
  },
  Tooltip: ({ children }: { children: React.ReactNode }) => <span data-testid="infobulle">{children}</span>,
  Popup: ({ children }: { children: React.ReactNode }) => <div data-testid="fiche">{children}</div>,
}));
vi.mock("../../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string, o: { params: Record<string, string> }) => {
      h.appels.push({ url, params: o.params });
      if (h.erreur) throw h.erreur;
      return { data: h.reponse };
    }),
  },
}));

import { FichePortionDate, PortionsDateLayer, versLatLng, ZOOM_MINIMUM_CURSEUR, type EtatCouchePortions } from "./PortionsDateLayer";

const LIGNE = '{"type":"LineString","coordinates":[[-13.7,9.5],[-13.69,9.5],[-13.68,9.51]]}';

function portion(over: Partial<PortionALaDate> = {}): PortionALaDate {
  return {
    id: "p-1", tronconId: "t-1", tronconCode: "GN N0001", tronconNom: "Conakry - Coyah", debutM: 0, finM: 1000, longueurM: 1000,
    revetement: "BITUME", etat: "BON", etatLibelle: "Bon", praticabilite: null, largeurM: 6, source: "mission", confiance: "HIGH",
    observeeLe: "2026-02-01", valideDu: "2026-01-01", valideAu: null, enregistreLe: "2026-01-10T08:00:00Z",
    statut: "VALIDE", ambigue: false, geometry: LIGNE, ...over,
  };
}
function reponse(portions: PortionALaDate[]): ReponseCurseur {
  return {
    dateTerrain: "2026-03-15", connuLe: null, inclureAValider: false, tronque: false, plafond: 5000,
    comptes: { retenues: portions.length, aValiderEcartees: 0, sansDateEffet: 0, datesIncoherentes: 0, remplaceesSansFin: 0, ambigues: 0 },
    longueurCouverteM: 1000, portions,
  };
}

beforeEach(() => { h.zoom = 12; h.appels.length = 0; h.lignes.length = 0; h.reponse = reponse([portion()]); h.erreur = null; });

describe("versLatLng", () => {
  it("passe de [lon, lat] a [lat, lon]", () => {
    expect(versLatLng(LIGNE)).toEqual([[9.5, -13.7], [9.5, -13.69], [9.51, -13.68]]);
  });
  it.each([
    ["absente", null],
    ["vide", ""],
    ["pas du JSON", "{pas json"],
    ["un point (portion degeneree)", '{"type":"Point","coordinates":[-13.7,9.5]}'],
    ["sans coordonnees", '{"type":"LineString"}'],
  ])("rend un tableau vide pour une geometrie %s, sans lever", (_n, g) => {
    expect(versLatLng(g as string | null)).toEqual([]);
  });
});

describe("PortionsDateLayer : chargement", () => {
  it("ne charge RIEN sous le zoom minimal, et le dit au panneau", async () => {
    h.zoom = ZOOM_MINIMUM_CURSEUR - 1;
    const etats: EtatCouchePortions[] = [];
    render(<PortionsDateLayer date="2026-03-15" connu={null} inclureAValider={false} onChargement={(e) => etats.push(e)} />);
    await waitFor(() => expect(etats.length).toBeGreaterThan(0));
    expect(h.appels).toHaveLength(0);
    expect(etats.at(-1)?.zoomSuffisant).toBe(false);
    expect(screen.queryByTestId("ligne")).not.toBeInTheDocument();
  });

  it("au zoom minimal, charge avec la date, l'emprise arrondie, et propositions=false par defaut", async () => {
    h.zoom = ZOOM_MINIMUM_CURSEUR;
    render(<PortionsDateLayer date="2026-03-15" connu={null} inclureAValider={false} />);
    await waitFor(() => expect(h.appels).toHaveLength(1));
    expect(h.appels[0].url).toBe("/v2/portions/a-la-date");
    expect(h.appels[0].params).toEqual({ date: "2026-03-15", bbox: "-13.8000,9.5000,-13.5000,9.8000", inclureAValider: "false" });
  });

  it("transmet l'axe systeme et les propositions seulement quand ils sont demandes", async () => {
    render(<PortionsDateLayer date="2026-03-15" connu="2026-04-01" inclureAValider={true} />);
    await waitFor(() => expect(h.appels).toHaveLength(1));
    expect(h.appels[0].params).toMatchObject({ connu: "2026-04-01", inclureAValider: "true" });
  });

  it("recharge quand la date change, et pas autrement", async () => {
    const { rerender } = render(<PortionsDateLayer date="2026-03-15" connu={null} inclureAValider={false} />);
    await waitFor(() => expect(h.appels).toHaveLength(1));
    rerender(<PortionsDateLayer date="2026-03-15" connu={null} inclureAValider={false} />);
    expect(h.appels).toHaveLength(1);
    rerender(<PortionsDateLayer date="2026-06-01" connu={null} inclureAValider={false} />);
    await waitFor(() => expect(h.appels).toHaveLength(2));
    expect(h.appels[1].params.date).toBe("2026-06-01");
  });

  it("recharge quand la carte bouge et que l'emprise change", async () => {
    render(<PortionsDateLayer date="2026-03-15" connu={null} inclureAValider={false} />);
    await waitFor(() => expect(h.appels).toHaveLength(1));
    h.bounds = { w: -13.6, s: 9.6, e: -13.3, n: 9.9 };
    act(() => h.handlers.moveend());
    await waitFor(() => expect(h.appels).toHaveLength(2));
    expect(h.appels[1].params.bbox).toBe("-13.6000,9.6000,-13.3000,9.9000");
  });
});

describe("PortionsDateLayer : le trace", () => {
  it("dessine l'etat de la portion avec son motif de trait, plein pour une portion validee", async () => {
    h.reponse = reponse([portion({ etat: "CRITIQUE", etatLibelle: "Critique" })]);
    render(<PortionsDateLayer date="2026-03-15" connu={null} inclureAValider={false} />);
    await waitFor(() => expect(h.lignes.length).toBeGreaterThan(0));
    const o = h.lignes.at(-1)!.options;
    expect(o.color).toBe("#b91c1c");
    expect(o.dashArray).toBe("4 4"); // le motif double la couleur
    expect(o.opacity).toBe(0.95);
  });

  it("ATTENUE une proposition non validee", async () => {
    h.reponse = reponse([portion({ statut: "A_VALIDER" })]);
    render(<PortionsDateLayer date="2026-03-15" connu={null} inclureAValider={true} />);
    await waitFor(() => expect(h.lignes.length).toBeGreaterThan(0));
    expect(h.lignes.at(-1)!.options.opacity).toBe(0.5);
    expect(screen.getByTestId("infobulle")).toHaveTextContent("(proposition)");
  });

  it("un etat inconnu du referentiel prend le repli gris, sans lever", async () => {
    h.reponse = reponse([portion({ etat: "ETAT_AJOUTE_PAR_AGEROUTE", etatLibelle: "Etat maison" })]);
    render(<PortionsDateLayer date="2026-03-15" connu={null} inclureAValider={false} />);
    await waitFor(() => expect(h.lignes.length).toBeGreaterThan(0));
    expect(h.lignes.at(-1)!.options.color).toBe("#848992");
  });

  it("ignore une portion sans trace exploitable, et dessine les autres", async () => {
    h.reponse = reponse([portion({ id: "a", geometry: null }), portion({ id: "b" }), portion({ id: "c", geometry: '{"type":"Point","coordinates":[1,2]}' })]);
    render(<PortionsDateLayer date="2026-03-15" connu={null} inclureAValider={false} />);
    await waitFor(() => expect(screen.getAllByTestId("ligne")).toHaveLength(1));
  });

  it("l'infobulle dit depuis quand, ou que la date d'effet est inconnue", async () => {
    h.reponse = reponse([portion({ valideDu: null })]);
    render(<PortionsDateLayer date="2026-03-15" connu={null} inclureAValider={false} />);
    await waitFor(() => expect(screen.getByTestId("infobulle")).toHaveTextContent("date d'effet inconnue"));
  });
});

describe("PortionsDateLayer : les echecs", () => {
  it("rend le message du serveur (emprise trop large, date future...) au panneau", async () => {
    h.erreur = { response: { data: { error: "L'emprise depasse 5 degres de cote." } } };
    const etats: EtatCouchePortions[] = [];
    render(<PortionsDateLayer date="2026-03-15" connu={null} inclureAValider={false} onChargement={(e) => etats.push(e)} />);
    await waitFor(() => expect(etats.at(-1)?.erreur).toBe("L'emprise depasse 5 degres de cote."));
    expect(screen.queryByTestId("ligne")).not.toBeInTheDocument();
  });

  it("un echec sans message du serveur donne un repli explicite, jamais un ecran muet", async () => {
    h.erreur = new Error("reseau");
    const etats: EtatCouchePortions[] = [];
    render(<PortionsDateLayer date="2026-03-15" connu={null} inclureAValider={false} onChargement={(e) => etats.push(e)} />);
    await waitFor(() => expect(etats.at(-1)?.erreur).toBe("Chargement des portions impossible."));
  });
});

describe("FichePortionDate", () => {
  it("dit l'etat, les dates d'effet et la distinction avec la date du releve", () => {
    render(<FichePortionDate p={portion({ valideAu: "2026-06-01" })} dateTerrain="2026-03-15" />);
    expect(screen.getByText("GN N0001")).toBeInTheDocument();
    expect(screen.getByText("Bon")).toBeInTheDocument();
    expect(screen.getByText("1er janvier 2026")).toBeInTheDocument();
    expect(screen.getByText("1er juin 2026")).toBeInTheDocument();
    expect(screen.getByText("15 mars 2026")).toBeInTheDocument();
    expect(screen.getByText(/distincte de la date du relevé/)).toBeInTheDocument();
  });

  it("une version sans fin connue et sans date d'effet le dit", () => {
    render(<FichePortionDate p={portion({ valideDu: null, valideAu: null })} dateTerrain="2026-03-15" />);
    expect(screen.getByText("date inconnue")).toBeInTheDocument();
    expect(screen.getByText("sans fin connue")).toBeInTheDocument();
  });

  it("annonce une proposition comme non officielle, avant les mesures", () => {
    render(<FichePortionDate p={portion({ statut: "A_VALIDER" })} dateTerrain="2026-03-15" />);
    expect(screen.getByText(/Proposition non validée : pas encore une donnée officielle/)).toBeInTheDocument();
  });

  it("n'affiche pas ce bandeau pour une portion validee", () => {
    render(<FichePortionDate p={portion()} dateTerrain="2026-03-15" />);
    expect(screen.queryByText(/Proposition non validée/)).not.toBeInTheDocument();
  });

  it("signale un recouvrement : le curseur ne tranche pas", () => {
    render(<FichePortionDate p={portion({ ambigue: true })} dateTerrain="2026-03-15" />);
    expect(screen.getByText(/le curseur ne tranche pas/)).toBeInTheDocument();
  });

  it("n'invente ni revetement ni praticabilite : « non relevé »", () => {
    render(<FichePortionDate p={portion({ revetement: null, praticabilite: null })} dateTerrain="2026-03-15" />);
    expect(screen.getByText("Non relevé")).toBeInTheDocument();
    expect(screen.getByText("Non relevée")).toBeInTheDocument();
  });
});

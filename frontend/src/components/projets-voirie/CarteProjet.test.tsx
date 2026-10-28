import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Feature, LineString } from "geojson";

vi.mock("react-leaflet", async () => (await import("./carteDouble.testutil")).moduleReactLeaflet());

import { CarteProjet } from "./CarteProjet";
import { carteEtat, mapDouble, reinitialiserCarte } from "./carteDouble.testutil";
import { analyse, couche, JEU_AXES, JEU_GAZ_CONTROLE, JEU_TEL, ligne, O, S } from "./synthetique.testutil";
import type { CleConflit } from "../../lib/projetsVoirie";

const CONFLITS_TOUS: Record<CleConflit, boolean> = { chaussee: true, emprise: true, hors: true, croisements: true };
const CONFLITS_AUCUN: Record<CleConflit, boolean> = { chaussee: false, emprise: false, hors: false, croisements: false };

function rendre(over: Partial<React.ComponentProps<typeof CarteProjet>> = {}) {
  const props: React.ComponentProps<typeof CarteProjet> = {
    fond: "osm", bbox: [O - 0.003, S - 0.003, O + 0.003, S + 0.003], cadrageCle: 0, couches: [couche()], jeux: [JEU_AXES, JEU_TEL],
    analyse: undefined, conflitsVisibles: CONFLITS_AUCUN, selection: null, onSelect: vi.fn(), onVue: vi.fn(), ...over,
  };
  const r = render(<CarteProjet {...props} />);
  return { ...r, props };
}

const styleDe = (el: HTMLElement) => JSON.parse(el.dataset.style ?? "{}") as Record<string, unknown>;

beforeEach(() => reinitialiserCarte());

describe("fonds de plan et echelle", () => {
  it("plan : tuiles OpenStreetMap, echelle metrique, rendu canvas", () => {
    rendre({ fond: "osm" });
    expect(screen.getByTestId("tuiles").dataset.url).toContain("tile.openstreetmap.org");
    expect(screen.getByTestId("echelle")).toBeInTheDocument();
    expect(screen.getByTestId("carte").dataset.canvas).toBe("true");
  });
  it("satellite : tuiles Esri World Imagery (meme fournisseur que le geoportail)", () => {
    rendre({ fond: "satellite" });
    expect(screen.getByTestId("tuiles").dataset.url).toContain("server.arcgisonline.com/ArcGIS/rest/services/World_Imagery");
  });
});

describe("cadrage et vue", () => {
  it("cadre l'emprise du projet au montage, et de nouveau quand `cadrageCle` change (Centrer sur le projet)", () => {
    const { rerender, props } = rendre();
    expect(mapDouble.fitBounds).toHaveBeenCalledTimes(1);
    const [limites, options] = mapDouble.fitBounds.mock.calls[0] as [number[][], { maxZoom: number }];
    expect(limites).toEqual([[S - 0.003, O - 0.003], [S + 0.003, O + 0.003]]);
    expect(options.maxZoom).toBe(18);
    rerender(<CarteProjet {...props} cadrageCle={1} />);
    expect(mapDouble.fitBounds).toHaveBeenCalledTimes(2);
  });
  it("sans emprise (projet vide) : aucun cadrage", () => {
    rendre({ bbox: null });
    expect(mapDouble.fitBounds).not.toHaveBeenCalled();
  });
  it("annonce la vue (emprise arrondie a 4 decimales, zoom) au montage et a chaque deplacement", () => {
    const { props } = rendre();
    expect(props.onVue).toHaveBeenCalledWith([-10.103, 9.177, -10.097, 9.183], 15);
    carteEtat.bounds = { w: -10.10012345, s: 9.17912345, e: -10.09912345, n: 9.18012345 };
    carteEtat.zoom = 17;
    act(() => { carteEtat.handlers.moveend?.(); });
    expect(props.onVue).toHaveBeenLastCalledWith([-10.1001, 9.1791, -10.0991, 9.1801], 17);
  });
});

describe("couches : couleur ET motif de trait, jamais la couleur seule", () => {
  it("axes : bleu marine, trait plein ; reseau telecom : orange, trait plein ; eau : bleu, tirets", () => {
    const eau = couche({ jeuId: "jeu-eau", typeReseau: "EAU_POTABLE", concessionnaire: { id: "c2", nom: "Eaux", typeReseau: "EAU_POTABLE" }, features: [ligne("Conduite", 0, -50, 0, 50)] });
    const axes = couche({ jeuId: "jeu-axes", role: "AXES_TRAVAUX", typeReseau: null, concessionnaire: null, features: [ligne("Axe A", -100, 0, 100, 0)] });
    rendre({ couches: [axes, couche(), eau], jeux: [JEU_AXES, JEU_TEL, { ...JEU_TEL, id: "jeu-eau", typeReseau: "EAU_POTABLE" }] });
    const objets = screen.getAllByTestId("objet-carte");
    const axe = styleDe(objets.find((o) => o.textContent === "Axe A")!);
    const fibre = styleDe(objets.find((o) => o.textContent === "Fibre FO-01")!);
    const conduite = styleDe(objets.find((o) => o.textContent === "Conduite")!);
    expect(axe).toMatchObject({ color: "#0b2545" });
    expect(axe.dashArray).toBeUndefined();
    expect(fibre).toMatchObject({ color: "#ff7900" });
    expect(fibre.dashArray).toBeUndefined();
    expect(conduite).toMatchObject({ color: "#1e66f5", dashArray: "10 5" });
  });

  it("un jeu non autorise (affiche a la demande) est attenue ET nomme « non autorise » dans l'infobulle", () => {
    rendre({ couches: [couche({ jeuId: "jeu-gaz", nonAutorise: true, typeReseau: "GAZ_HYDROCARBURES" })], jeux: [JEU_GAZ_CONTROLE] });
    const o = screen.getAllByTestId("objet-carte")[0];
    expect(styleDe(o).opacity).toBe(0.45);
    expect(o.dataset.infobulle).toMatch(/^Non autorisé · Fibre FO-01/);
  });

  it("l'infobulle est un TEXTE : un nom contenant du HTML n'est pas interprete", () => {
    const piege: Feature<LineString> = ligne("<img src=x onerror=alert(1)>", 0, 0, 10, 10);
    rendre({ couches: [couche({ features: [piege] })] });
    const o = screen.getByTestId("objet-carte");
    expect(o.dataset.infobulle).toContain("<img src=x onerror=alert(1)>");
    expect(o.dataset.infobulleEnfants).toBe("0");
    expect(document.querySelector("img")).toBeNull();
  });

  it("un clic sur un objet annonce l'objet (nom, attributs d'origine conserves) ; aucune popup HTML", async () => {
    const { props } = rendre({ couches: [couche({ features: [ligne("Fibre FO-01", -100, 2, 100, 2, { Circuit: "C-1" })] })] });
    await userEvent.click(screen.getByTestId("objet-carte"));
    expect(props.onSelect).toHaveBeenCalledTimes(1);
    const o = vi.mocked(props.onSelect).mock.calls[0][0];
    expect(o).toMatchObject({ jeuId: "jeu-tel", nom: "Fibre FO-01", attributs: { Name: "Fibre FO-01", Circuit: "C-1" } });
  });
});

describe("couches de conflit et selection", () => {
  it("n'affiche que les couches de conflit cochees, et seulement celles qui ont une geometrie", () => {
    rendre({ couches: [], analyse: analyse(), conflitsVisibles: CONFLITS_TOUS });
    // chaussee (zone) + croisements (points) ; emprise et hors sont null dans la fixture
    expect(screen.getAllByTestId("geojson")).toHaveLength(2);
    expect(screen.getAllByTestId("geojson").every((g) => g.dataset.interactive === "false")).toBe(true);
  });
  it("conflits decoches : aucune couche de conflit", () => {
    rendre({ couches: [], analyse: analyse(), conflitsVisibles: CONFLITS_AUCUN });
    expect(screen.queryAllByTestId("geojson")).toHaveLength(0);
  });
  it("la selection ajoute une couche de surbrillance non interactive", () => {
    const f = ligne("Fibre FO-01", -100, 2, 100, 2);
    rendre({ couches: [], selection: { jeuId: "jeu-tel", id: "x", nom: "Fibre FO-01", longueurM: null, typeGeom: null, attributs: {}, nonAutorise: false, feature: f } });
    const g = screen.getByTestId("geojson");
    expect(g.dataset.interactive).toBe("false");
  });
});

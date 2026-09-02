import { describe, expect, it } from "vitest";
import type { FeatureCollection } from "geojson";
import {
  categorieVoie,
  compterParCategorie,
  milieuGeometrie,
  nomPropose,
  pointsFranchissements,
  type FranchissementPoint,
} from "./FranchissementsLayer";

/**
 * Franchissements OSM validés (D9).
 *
 * Ces tests portent sur les fonctions pures — classement, nommage, comptage. Le
 * rendu Leaflet n'est pas éprouvable sous jsdom : les marqueurs, le regroupement et
 * les popups ne s'éprouvent que dans un navigateur.
 */

/** Les 14 natures réellement présentes dans ponts-osm.geojson, avec leurs comptes. */
const NATURES_REELLES: [string, number][] = [
  ["Route non classifiée", 941],
  ["Chemin carrossable", 668],
  ["Chemin non carrossable", 406],
  ["Route tertiaire", 406],
  ["Voie rapide", 292],
  ["Route secondaire", 164],
  ["Route primaire", 126],
  ["Route résidentielle", 115],
  ["Route d accès", 27],
  ["Voie piétonne", 26],
  ["Route en construction", 3],
  ["Bretelle voie rapide", 2],
  ["Rue piétonne", 1],
  ["Inconnu", 1],
];

function point(p: Partial<FranchissementPoint>): FranchissementPoint {
  return {
    id: "x", franchissement: "Pont", nature: "Voie rapide", categorie: "CLASSE",
    numero: "", nom: "", region: "", classement: "PONT_SANS_OUVRAGE",
    longueurM: 0, distanceM: 0, lat: 10, lon: -11, ...p,
  };
}

describe("Classement des voies", () => {
  it("range les cinq natures du réseau classé", () => {
    for (const n of ["Voie rapide", "Bretelle voie rapide", "Route primaire", "Route secondaire", "Route tertiaire"]) {
      expect(categorieVoie(n), n).toBe("CLASSE");
    }
  });

  it("range les autres voies carrossables", () => {
    for (const n of ["Route non classifiée", "Route résidentielle", "Route d accès", "Route en construction"]) {
      expect(categorieVoie(n), n).toBe("AUTRE_ROUTE");
    }
  });

  it("range les chemins, sentiers et voies piétonnes", () => {
    for (const n of ["Chemin carrossable", "Chemin non carrossable", "Voie piétonne", "Rue piétonne", "Inconnu"]) {
      expect(categorieVoie(n), n).toBe("CHEMIN");
    }
  });

  it("classe une nature inconnue en CHEMIN, jamais en réseau classé", () => {
    // Une nature non reconnue doit rester masquée par défaut plutôt que d'être
    // comptée dans le réseau classé, où elle passerait pour un ouvrage manquant.
    expect(categorieVoie("Téléphérique")).toBe("CHEMIN");
    expect(categorieVoie("")).toBe("CHEMIN");
  });

  it("couvre les 14 natures réelles et retrouve la ventilation mesurée", () => {
    const totaux = { CLASSE: 0, AUTRE_ROUTE: 0, CHEMIN: 0 };
    for (const [nature, n] of NATURES_REELLES) totaux[categorieVoie(nature)] += n;

    expect(totaux.CLASSE).toBe(990);
    expect(totaux.AUTRE_ROUTE).toBe(1086);
    expect(totaux.CHEMIN).toBe(1102);
    expect(totaux.CLASSE + totaux.AUTRE_ROUTE + totaux.CHEMIN).toBe(3178);
  });
});

describe("Nom proposé", () => {
  it("n'appelle pas « Pont » un gué — le défaut corrigé", () => {
    expect(nomPropose(point({ franchissement: "Gué", nom: "Kokoulo" }))).toBe("Gué Kokoulo");
    expect(nomPropose(point({ franchissement: "Tunnel", nom: "Samou" }))).toBe("Tunnel Samou");
    expect(nomPropose(point({ franchissement: "Pont", nom: "Kaporo" }))).toBe("Pont Kaporo");
  });

  it("retombe sur le numéro puis la région quand le nom manque", () => {
    expect(nomPropose(point({ franchissement: "Pont", numero: "N5" }))).toBe("Pont N5");
    expect(nomPropose(point({ franchissement: "Gué", region: "Faranah" }))).toBe("Gué Faranah");
  });

  it("produit un nom situé plutôt qu'un nom vide", () => {
    const n = nomPropose(point({ franchissement: "Pont", lat: 9.5123, lon: -13.7456 }));
    expect(n).toContain("9.5123");
    expect(n).toContain("-13.7456");
  });

  it("ne laisse jamais de libellé vide", () => {
    expect(nomPropose(point({ franchissement: "" })).trim().length).toBeGreaterThan(0);
  });
});

describe("Lecture du jeu GeoJSON", () => {
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "LineString", coordinates: [[-13.7, 9.5], [-13.6, 9.6], [-13.5, 9.7]] },
        properties: { franchissement: "Pont", nature: "Voie rapide", region: "Conakry", classement: "PONT_SANS_OUVRAGE", longueurM: 66, distanceM: 23331 },
      },
      {
        type: "Feature",
        geometry: { type: "LineString", coordinates: [[-12.0, 10.0], [-12.1, 10.1]] },
        properties: { franchissement: "Gué", nature: "Chemin carrossable", region: "Faranah", classement: "PONT_SANS_OUVRAGE" },
      },
      {
        // Sans géométrie linéaire exploitable : doit être ignoré, pas planter.
        type: "Feature",
        geometry: { type: "Point", coordinates: [-11, 9] },
        properties: { franchissement: "Tunnel", nature: "Route primaire" },
      },
    ],
  };

  it("ignore les géométries non linéaires au lieu d'échouer", () => {
    const pts = pointsFranchissements(fc);
    expect(pts).toHaveLength(2);
  });

  it("attache la catégorie à chaque point", () => {
    const pts = pointsFranchissements(fc);
    expect(pts[0].categorie).toBe("CLASSE");
    expect(pts[1].categorie).toBe("CHEMIN");
  });

  it("donne une clé stable en l'absence d'identifiant dans la source", () => {
    // Le jeu ne porte pas de propriété `id` : la position sert de clé, et deux
    // lectures du même fichier doivent produire les mêmes clés.
    const a = pointsFranchissements(fc).map((p) => p.id);
    const b = pointsFranchissements(fc).map((p) => p.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });

  it("place le symbole sur un sommet de la ligne", () => {
    const pts = pointsFranchissements(fc);
    expect([pts[0].lat, pts[0].lon]).toEqual([9.6, -13.6]);
  });

  it("compte par catégorie", () => {
    expect(compterParCategorie(pointsFranchissements(fc))).toEqual({
      CLASSE: 1, AUTRE_ROUTE: 0, CHEMIN: 1,
    });
  });
});

describe("Milieu de géométrie", () => {
  it("rend null sur une géométrie sans ligne", () => {
    expect(milieuGeometrie({ type: "Point", coordinates: [1, 2] })).toBeNull();
  });

  it("traite les MultiLineString", () => {
    const m = milieuGeometrie({
      type: "MultiLineString",
      coordinates: [[[-13, 9], [-12, 10]], [[-11, 11], [-10, 12]]],
    });
    expect(m).not.toBeNull();
  });
});

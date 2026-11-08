/**
 * Reponses SYNTHETIQUES de l'API d'import (CONTRAT-IMPORT.md, lot A1) pour les tests de l'assistant. Aucune donnee reelle : noms inventes, coordonnees autour
 * d'un point arbitraire. Les formes suivent le code reel du backend (`sourcesAutorises`, `elementsEcartes`, `objetId` des echantillons ajoutes...).
 * Fichier pour les tests seulement.
 */

import { jeu } from "../synthetique.testutil";

export const O = -10.1;
export const S = 9.18;

const format = (f: string, extensions: string[], choixCrs: string, crsParDefinition: string | null) => ({ format: f, extensions, detection: "contenu", crsParDefinition, choixCrs });

export const OPTIONS = {
  formats: [
    format("KML", [".kml"], "interdit", "EPSG:4326"), format("KMZ", [".kmz"], "interdit", "EPSG:4326"), format("GEOJSON", [".geojson", ".json"], "facultatif", "EPSG:4326"),
    format("GPX", [".gpx"], "interdit", "EPSG:4326"), format("CSV", [".csv", ".tsv", ".txt"], "obligatoire", null),
  ],
  nonSupportes: [
    { format: "GEOPACKAGE", raison: "chaine de conversion GDAL isolee" }, { format: "SHAPEFILE", raison: "chaine de conversion GDAL isolee" },
    { format: "DXF", raison: "chaine de conversion GDAL isolee" }, { format: "DWG", raison: "convertisseur approuve requis" },
  ],
  limites: {
    tailleMaxOctets: 25 * 1024 * 1024, objetsMax: 50000, sommetsParObjetMax: 100000, sommetsParFichierMax: 2000000,
    archive: { entreesMax: 100, tailleDecompresseeMaxOctets: 104857600, tauxCompressionMax: 100, profondeurMax: 8 },
    csv: { lignesMax: 500000, colonnesMax: 200, celluleMaxCaracteres: 10000 }, echantillonMax: 20, delaiApercuMs: 30000,
  },
  crs: {
    cible: { epsg: 4326, nom: "WGS 84", unite: "degre" },
    sourcesAutorises: [
      { epsg: 4326, nom: "WGS 84", unite: "degre", disponible: true },
      { epsg: 32628, nom: "WGS 84 / UTM zone 28N", unite: "metre", disponible: true },
      { epsg: 32629, nom: "WGS 84 / UTM zone 29N", unite: "metre", disponible: true },
    ],
    zoneAttendue: { nom: "Guinee", bbox: [-15.2, 7.1, -7.5, 12.8] },
  },
  champsCibles: [
    { champ: "nom", portee: "objet", description: "Nom de l'objet, pris dans la colonne." },
    { champ: "identifiant", portee: "objet", description: "Cle stable qui rapproche les objets d'une version a l'autre." },
    { champ: "typeReseau", portee: "jeu", description: "Type de reseau du jeu : valeur unique de la colonne." },
    { champ: "concessionnaire", portee: "jeu", description: "Nom du concessionnaire, retrouve parmi les connus." },
    { champ: "classePrecision", portee: "jeu", description: "Classe de precision declaree A a E." },
  ],
  csv: { delimiteurs: [",", ";", "\t", "|"], encodages: ["utf-8", "iso-8859-1", "windows-1252"], separateursDecimaux: [".", ","], modes: ["points", "lignes", "wkt"] },
  conservationOriginal: "EMPREINTE_SEULE",
};

export const SHA = "ab".repeat(32);
const fichier = (nom: string, taille = 2048) => ({ nom, tailleOctets: taille, sha256: SHA });

export function inventaireKml(over: Record<string, unknown> = {}) {
  return {
    fichier: fichier("reseau-synthetique.kml"), format: "KML", detection: { methode: "contenu", extensionDeclaree: "kml", extensionCoherente: true }, archive: null,
    couches: [
      { id: "c0", nom: "Fibre / Principal", nbObjets: 3, parTypeGeom: { LIGNE: 3, POINT: 0, POLYGONE: 0 } },
      { id: "c1", nom: "Fibre / Chambres", nbObjets: 2, parTypeGeom: { LIGNE: 0, POINT: 2, POLYGONE: 0 } },
    ],
    csv: null, crs: { normeDuFormat: "EPSG:4326", declareDansLeFichier: null, choixObligatoire: false },
    champsDisponibles: ["Circuit", "Name", "Reseau"], suggestionsMapping: { nom: "Name" }, avertissements: [{ code: "COUCHES_MULTIPLES", message: "Le fichier contient 2 couches", nb: 2 }], ...over,
  };
}

export function inventaireKmlUneCouche(over: Record<string, unknown> = {}) {
  return inventaireKml({ couches: [{ id: "c0", nom: "Fibre", nbObjets: 3, parTypeGeom: { LIGNE: 3, POINT: 0, POLYGONE: 0 } }], avertissements: [], ...over });
}

export function inventaireCsv(over: Record<string, unknown> = {}) {
  return {
    fichier: fichier("plan-axes-synthetique.csv", 546), format: "CSV", detection: { methode: "contenu", extensionDeclaree: "csv", extensionCoherente: true }, archive: null, couches: [],
    csv: {
      delimiteur: ";", delimiteurDetecte: true, encodage: "utf-8", encodageDetecte: true, bom: false, separateurDecimal: ",", separateurDecimalDetecte: true, nbLignes: 13,
      colonnes: [
        { nom: "axe", exemples: ["A", "B", "C"] }, { nom: "ordre", exemples: ["1", "2"] }, { nom: "x", exemples: ["380250,357", "380030,541"] },
        { nom: "y", exemples: ["1016150,670", "1016160,100"] }, { nom: "commune", exemples: ["Commune test"] },
      ],
      echantillon: [["A", "1", "380250,357", "1016150,670", "Commune test"]],
    },
    crs: { normeDuFormat: null, declareDansLeFichier: null, choixObligatoire: true },
    champsDisponibles: ["axe", "ordre", "x", "y", "commune"], suggestionsMapping: {}, avertissements: [], ...over,
  };
}

export function inventaireKmz(over: Record<string, unknown> = {}) {
  return {
    fichier: fichier("archive-synthetique.kmz", 4096), format: "KMZ", detection: { methode: "contenu", extensionDeclaree: "kmz", extensionCoherente: true },
    archive: {
      nbEntrees: 3, tailleDecompresseeOctets: 9000, kmlPrincipal: null, entreesKml: ["a/premier.kml", "b/second.kml"], choixRequis: true,
      entrees: [{ nom: "a/premier.kml", tailleOctets: 3000, type: "kml" }, { nom: "b/second.kml", tailleOctets: 4000, type: "kml" }, { nom: "icone.png", tailleOctets: 2000, type: "image" }],
    },
    couches: [], csv: null, crs: { normeDuFormat: "EPSG:4326", declareDansLeFichier: null, choixObligatoire: false },
    champsDisponibles: [], suggestionsMapping: {}, avertissements: [], ...over,
  };
}

export function inventaireGeojson(declare: string | null, over: Record<string, unknown> = {}) {
  return inventaireKml({
    fichier: fichier("axes-synthetiques.geojson"), format: "GEOJSON", detection: { methode: "contenu", extensionDeclaree: "geojson", extensionCoherente: true },
    couches: [{ id: "c0", nom: "Entites", nbObjets: 3, parTypeGeom: { LIGNE: 3, POINT: 0, POLYGONE: 0 } }],
    crs: { normeDuFormat: "EPSG:4326", declareDansLeFichier: declare, choixObligatoire: declare !== null && declare !== "EPSG:4326" }, avertissements: [], ...over,
  });
}

export const CRS_WGS84 = {
  source: "WGS84 (EPSG:4326)", cible: "EPSG:4326", methode: "aucune transformation", justification: "WGS84 par norme KML 2.2, aucune transformation",
  epsgSource: 4326, epsgCible: 4326, uniteSource: "degre", uniteCible: "degre", origine: "norme_du_format", transformation: "aucune", versionProj: null,
  plausibilite: { zoneAttendue: { nom: "Guinee", bbox: [-15.2, 7.1, -7.5, 12.8] }, empriseResultat: [O - 0.003, S - 0.003, O + 0.003, S + 0.003], nbElementsHorsZone: 0, nbObjets: 3, statut: "CONFORME", confirmationRequise: false, confirmee: false },
};

export const CRS_UTM29 = {
  source: "EPSG:32629 (WGS 84 / UTM zone 29N)", cible: "EPSG:4326", methode: "ST_Transform (PostGIS, PROJ 7.2.1)", justification: "CRS EPSG:32629 choisi par l'utilisateur (liste blanche).",
  epsgSource: 32629, epsgCible: 4326, uniteSource: "metre", uniteCible: "degre", origine: "choisi_par_utilisateur", transformation: "ST_Transform", versionProj: "7.2.1",
  plausibilite: { zoneAttendue: { nom: "Guinee", bbox: [-15.2, 7.1, -7.5, 12.8] }, empriseResultat: [-10.1, 9.187, -10.09, 9.1945], nbElementsHorsZone: 0, nbObjets: 3, statut: "CONFORME", confirmationRequise: false, confirmee: false },
};

const objet = (ordre: number, nom: string | null, x0: number, y0: number, x1: number, y1: number, attributs: Record<string, unknown> = {}) => ({
  ordre, nom, typeGeom: "LIGNE", simplifiee: false, attributs,
  geometrie: { type: "LineString", coordinates: [[O + x0 * 1e-5, S + y0 * 1e-5], [O + x1 * 1e-5, S + y1 * 1e-5]] },
});

export function apercu(over: Record<string, unknown> = {}) {
  return {
    fichier: fichier("reseau-synthetique.kml"), format: "KML", couche: null,
    resume: {
      nbObjets: 3, libelleNbObjets: "circuits ou objets du fichier", parTypeGeom: { LIGNE: 2, POINT: 1, POLYGONE: 0 }, longueurTotaleM: 1200.5, bbox: [O - 0.003, S - 0.003, O + 0.003, S + 0.003],
      attributsDetectes: ["Circuit", "Name"], crs: CRS_WGS84,
      import: { couche: null, entreeKml: null, csv: null, mapping: {}, rejets: [], rejetsTronques: false },
    },
    statistiques: { nbObjets: 3, parTypeGeom: { LIGNE: 2, POINT: 1, POLYGONE: 0 }, longueurTotaleM: 1200.5, doublonsInternes: 1, sommets: 7, geometriesAReparer: 1, geometriesVides: 0 },
    validationGeometrique: {
      nbProblemes: 1, tronque: false, problemes: [{ ordre: 1, nom: "Fibre FO-02", typeGeom: "LIGNE", code: "AUTO_INTERSECTION", message: "Auto-intersection" }],
      elementsEcartes: [{ element: 4, nom: "Element hors zone", code: "COORDONNEES_HORS_ZONE", message: "Coordonnees hors de l'emprise de la Guinee : ecarte." }],
    },
    echantillon: {
      taille: 3, total: 3,
      objets: [
        objet(1, "Fibre FO-02", 0, 5, 100, 6, { Circuit: "C-2", Name: "Fibre FO-02" }),
        objet(0, "Fibre FO-01", -100, 2, 100, 2, { Circuit: "C-1", Name: "Fibre FO-01" }),
        { ordre: 2, nom: null, typeGeom: "POINT", simplifiee: false, attributs: {}, geometrie: { type: "Point", coordinates: [O, S] } },
      ],
    },
    mapping: { applique: {}, propositionsJeu: {}, avertissements: [] },
    avertissements: [{ code: "TRACES_DOUBLES", message: "Traces doubles", nb: 1 }, { code: "ALTITUDE_IGNOREE", message: "Altitude ignoree", nb: 12 }], ...over,
  };
}

export function reponseDepot(over: Record<string, unknown> = {}, simulation = true) {
  return {
    simulation,
    jeu: simulation ? { ...jeu({ id: "nouveau", statut: "CONTROLE", nonAutorise: true, version: 3 }), id: undefined } : jeu({ id: "jeu-nouveau", statut: "CONTROLE", nonAutorise: true, version: 3 }),
    resume: { nbObjets: 3, parTypeGeom: { LIGNE: 3 }, longueurTotaleM: 1200, longueurTraceFusionneM: 900, bbox: [O - 0.003, S - 0.003, O + 0.003, S + 0.003], attributsDetectes: ["Name", "Circuit"], crs: CRS_WGS84, delta: null, suppressions: null },
    avertissements: [{ code: "ALTITUDE_IGNOREE", message: "L'altitude des points est ignoree.", nb: 12 }],
    delta: { ajoutes: 1, modifies: 1, retires: 1, identiques: 0 }, remplace: { jeuId: "ancien", version: 2 }, suppressions: { statut: "A_REVOIR", nb: 1 },
    validationGeometrique: { nbProblemes: 0, problemes: [], tronque: false, elementsEcartes: [] }, ...over,
  };
}

export function deltaDetail(over: Record<string, unknown> = {}) {
  return {
    jeu: { id: "jeu-nouveau", version: 3, statut: "CONTROLE", role: "RESEAU_TIERS" },
    comparaison: { jeuId: "ancien", version: 2, statut: "AUTORISE" },
    delta: { ajoutes: 1, modifies: 1, retires: 1, identiques: 0 }, cleComparaison: "identifiant", clesAmbigues: 0,
    echantillons: {
      ajoutes: [{ objetId: "30", nom: "Regard 3" }], modifies: [{ cle: "R1", nomAvant: "Regard 1", nomApres: "Regard 1 (deplace)" }], retires: [{ objetId: "24", nom: "Regard 2" }],
    },
    suppressions: { statut: "A_REVOIR", nb: 1, revue: null }, retourArriere: null, evenements: [], ...over,
  };
}

export const DELTA_SANS_SUPPRESSION = () => deltaDetail({
  delta: { ajoutes: 2, modifies: 0, retires: 0, identiques: 3 }, echantillons: { ajoutes: [{ objetId: "31", nom: "Regard 4" }], modifies: [], retires: [] },
  suppressions: { statut: "AUCUNE", nb: 0, revue: null },
});

export const DELTA_AUTORISE_AVEC_RETOUR = () => deltaDetail({
  jeu: { id: "jeu-nouveau", version: 3, statut: "AUTORISE", role: "RESEAU_TIERS" }, suppressions: { statut: "ACCEPTEES", nb: 1, revue: { par: { id: "u1", nomComplet: "Sekou Gestionnaire" }, le: "2026-11-07T10:00:00Z", decision: "ACCEPTER", justification: "Regard 2 supprime sur le terrain" } },
  retourArriere: { possible: true, raison: null, restaureraJeuId: "ancien", restaureraVersion: 2 },
});

export const ERREUR = (status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => ({ response: { status, data: { error: "texte brut du serveur", code, ...extra }, headers } });

/**
 * Types et constantes communs aux lecteurs KML et GeoJSON du module Projets de voirie et reseaux. Sans E/S.
 * Contrat : docs/projets-voirie/CONTRAT.md, section 4 (limites) et section 3 (modele).
 */

export type Pos = [number, number];

/** Geometries lues, toujours en 2D (l'altitude est ignoree) et en WGS 84 (longitude, latitude). */
export type GeometrieLue =
  | { type: "Point"; coordinates: Pos }
  | { type: "MultiPoint"; coordinates: Pos[] }
  | { type: "LineString"; coordinates: Pos[] }
  | { type: "MultiLineString"; coordinates: Pos[][] }
  | { type: "Polygon"; coordinates: Pos[][] }
  | { type: "MultiPolygon"; coordinates: Pos[][][] };

export type TypeGeom = "LIGNE" | "POINT" | "POLYGONE";
export type FormatFichier = "KML" | "GEOJSON";

export interface ObjetLu {
  nom: string | null;
  typeGeom: TypeGeom;
  geometrie: GeometrieLue;
  /** Tous les champs d'origine, tels quels (chaines, nombres, booleens ; jamais interpretes comme du HTML). */
  attributs: Record<string, unknown>;
  /** SHA-1 de la geometrie normalisee et du nom (delta de versions). */
  empreinte: string;
  /** Position de l'objet dans le fichier (0, 1, 2...), apres retrait des elements ignores. */
  ordre: number;
}

export interface Avertissement {
  code: CodeAvertissement;
  message: string;
  nb?: number;
}

export type CodeAvertissement =
  | "ALTITUDE_IGNOREE"
  | "ELEMENTS_HORS_GUINEE"
  | "GEOMETRIES_INVALIDES_IGNOREES"
  | "ANNEAUX_FERMES"
  | "ELEMENTS_KML_IGNORES"
  | "OBJETS_SANS_GEOMETRIE"
  | "POINTS_REPETES_RETIRES"
  | "TRACES_DOUBLES"
  | "OBJETS_SANS_NOM"
  | "GEOMETRIES_REPAREES"
  | "GEOMETRIES_VIDES_IGNOREES"
  | "TRACES_SUPERPOSES";

export type Bbox = [number, number, number, number];

export interface ResumeLecture {
  nbObjets: number;
  parTypeGeom: Record<TypeGeom, number>;
  /** [ouest, sud, est, nord] ; nul sans objet. */
  bbox: Bbox | null;
  /** Noms des attributs rencontres avec le nombre d'objets qui les portent, du plus frequent au moins frequent (50 au plus). */
  attributsDetectes: { nom: string; nb: number }[];
}

/** Systeme de coordonnees : AUCUNE transformation silencieuse, le resume dit ce qui a ete fait et pourquoi. */
export interface InfoCrs {
  source: string;
  cible: "EPSG:4326";
  methode: string;
  justification: string;
}

export interface ResultatLecture {
  format: FormatFichier;
  crs: InfoCrs;
  objets: ObjetLu[];
  avertissements: Avertissement[];
  resume: ResumeLecture;
}

export type CodeErreurLecture =
  | "FICHIER_VIDE"
  | "FICHIER_TROP_GROS"
  | "FORMAT_NON_SUPPORTE"
  | "CONTENU_NON_RECONNU"
  | "JSON_TROP_PROFOND"
  | "ENCODAGE_NON_SUPPORTE"
  | "XML_INVALIDE"
  | "DTD_REFUSEE"
  | "ENTITE_REFUSEE"
  | "XML_TROP_PROFOND"
  | "XML_TROP_VOLUMINEUX"
  | "JSON_INVALIDE"
  | "CRS_NON_SUPPORTE"
  | "GEOMETRIE_INVALIDE"
  | "HORS_GUINEE"
  | "TROP_D_OBJETS";

export class ErreurLecture extends Error {
  constructor(public readonly code: CodeErreurLecture, message: string) {
    super(message);
    this.name = "ErreurLecture";
  }
}

// ---------- Limites du contrat (section 4) ----------

/** Aligne sur `client_max_body_size 25m` de nginx et sur `TAILLE_MAX_OCTETS` des imports. */
export const TAILLE_MAX_OCTETS = 25 * 1024 * 1024;
export const OBJETS_MAX = 50_000;
/** Emprise de la Guinee : longitude -15,2 a -7,5 ; latitude 7,1 a 12,8. */
export const BBOX_GUINEE: Bbox = [-15.2, 7.1, -7.5, 12.8];

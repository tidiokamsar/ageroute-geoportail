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
// Lot D1 : LANDXML (axes en plan et points, lecteur XML du module).
export type FormatFichier = "KML" | "KMZ" | "GEOJSON" | "GPX" | "CSV" | "GPKG" | "SHAPEFILE" | "DXF" | "LANDXML";

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
  code: CodeAvertissement | CodeAvertissementImport;
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
  | "TRACES_SUPERPOSES"
  // Lot T1 : objets conserves mais hors de l'emprise (approximative) du territoire du projet.
  | "ELEMENTS_HORS_TERRITOIRE";

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
  | "TROP_D_OBJETS"
  | "TROP_DE_SOMMETS"
  | CodeErreurImport;

/**
 * Codes ajoutes par le lot A1 (formats ouverts, CRS, mapping). Contrat : docs/projets-voirie/CONTRAT-IMPORT.md.
 * Les erreurs de lecture portent un statut 422 par defaut (voir `STATUT_LECTURE` des routes) ; 409 pour la confirmation attendue.
 */
export type CodeErreurImport =
  // archives (KMZ)
  | "ARCHIVE_INVALIDE" | "ARCHIVE_TROP_D_ENTREES" | "ARCHIVE_CHEMIN_DANGEREUX" | "ARCHIVE_NOMS_AMBIGUS" | "ARCHIVE_LIEN_SYMBOLIQUE"
  | "ARCHIVE_ENTREE_SPECIALE" | "ARCHIVE_CHIFFREE" | "ARCHIVE_METHODE_NON_SUPPORTEE" | "ARCHIVE_IMBRIQUEE" | "ARCHIVE_TROP_GROSSE"
  | "ARCHIVE_TAUX_COMPRESSION" | "ARCHIVE_CHEVAUCHEMENT" | "ARCHIVE_TROP_PROFONDE" | "KMZ_SANS_KML" | "KMZ_PLUSIEURS_KML" | "ENTREE_KML_INTROUVABLE"
  // CSV et GPX
  | "ENCODAGE_AMBIGU" | "DELIMITEUR_AMBIGU" | "SEPARATEUR_DECIMAL_AMBIGU" | "CSV_STRUCTURE_INVALIDE" | "CSV_TROP_DE_LIGNES" | "CSV_TROP_DE_COLONNES" | "CSV_TROP_DE_CELLULES"
  | "CSV_CELLULE_TROP_LONGUE" | "CSV_COLONNES_REQUISES" | "CSV_COLONNE_INTROUVABLE" | "GPX_INVALIDE"
  // couches, mapping
  | "COUCHE_INTROUVABLE" | "MAPPING_COLONNE_INTROUVABLE"
  // CRS
  | "SHAPEFILE_INCOMPLET" | "DXF_BINAIRE_NON_PRIS_EN_CHARGE" | "UNITES_REQUISES" | "DXF_UNITES_CONFLIT"
  | "CRS_MULTIPLES" | "CRS_REQUIS" | "CRS_NON_AUTORISE" | "CRS_NON_DISPONIBLE" | "CRS_INCOMPATIBLE_FORMAT" | "CRS_CONFLIT" | "CRS_INCOHERENT" | "TRANSFORMATION_ECHEC"
  | "CONFIRMATION_HORS_ZONE_REQUISE"
  // lot D1 : LandXML (CONTRAT-DOCUMENTS.md, section 7.1)
  | "LANDXML_SPIRALE_NON_PRISE_EN_CHARGE" | "LANDXML_ARC_DEGENERE" | "LANDXML_UNITES_NON_SUPPORTEES" | "LANDXML_POINT_INTROUVABLE";

/** Avertissements ajoutes par le lot A1. */
export type CodeAvertissementImport =
  | "COUCHES_MULTIPLES" | "COUCHES_TRONQUEES" | "LIGNES_CSV_REJETEES" | "COLONNES_RENOMMEES" | "HORODATAGES_IGNORES" | "EXTENSION_INCOHERENTE"
  | "ENTREES_ARCHIVE_IGNOREES" | "MAPPING_VALEURS_MULTIPLES" | "MAPPING_VALEUR_INCONNUE" | "CRS_CHOISI_PAR_UTILISATEUR" | "ELEMENTS_GPX_IGNORES"
  | "CONCESSIONNAIRE_INCONNU" | "MAPPING_CHAMP_IGNORE"
  // lot B2 : conversion GDAL (codes du conteneur renvoyes tels quels, libelles fixes ; voir gdal/conversion.noyau.ts)
  | "ATTRIBUTS_ADAPTES" | "COMPTE_DXF_DIVERGENT" | "CRS_DECLARE_DANS_LE_FICHIER" | "DXF_ENTITES_IGNOREES" | "DXF_BLOCS_IGNORES" | "CRS_ABSENT" | "CRS_FOURNI_PAR_LA_DEMANDE"
  | "CRS_SURCHARGE" | "CRS_SANS_CODE_EPSG" | "COMPTE_DECLARE_DIVERGENT" | "COORDONNEES_NON_FINIES" | "COORDONNEES_HORS_PLAGE" | "GEOMETRIES_NULLES"
  | "AVERTISSEMENTS_GDAL" | "ANALYSE_GEOMETRIE_PARTIELLE" | "COUCHE_VIDE" | "UNITES_ABSENTES" | "COUCHE_SANS_GEOMETRIE_IGNOREE" | "COUCHE_SANS_GEOMETRIE"
  | "COUCHE_NOM_REFUSE" | "FICHIERS_ORPHELINS" | "NOM_FICHIER_RENOMME"
  // lot S1 : connexions declarees par le fichier (mapping connecteA) dont l objet designe est introuvable ou ambigu dans le meme fichier
  | "CONNEXIONS_NON_RESOLUES"
  // lot D1 : LandXML (elements ignores et comptes, discretisation des arcs)
  | "LANDXML_ARCS_DISCRETISES" | "LANDXML_SPIRALES" | "LANDXML_DISCONTINUITES" | "LANDXML_PROFILS_IGNORES" | "LANDXML_SURFACES_IGNOREES" | "LANDXML_ELEMENTS_IGNORES";

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
/**
 * Plafonds de SOMMETS (revue de securite, M2) : le cout d'un fichier pour la base depend des sommets, pas du nombre d'objets.
 * 100 000 par objet : un cable de 100 km releve au metre. 2 000 000 par fichier : la limite de 25 Mo en GeoJSON compact
 * (environ 12 octets par position). Reglables par l'environnement (voir config.ts) ; ces valeurs sont les defauts.
 */
export const SOMMETS_PAR_OBJET_MAX = 100_000;
export const SOMMETS_PAR_FICHIER_MAX = 2_000_000;

/** Zone geographique nommee (rectangle WGS 84) : emprise nationale de plausibilite ou boite englobante d'un territoire. */
export interface ZoneLecture { nom: string; bbox: Bbox }

export interface LimitesLecture {
  sommetsParObjet?: number;
  sommetsParFichier?: number;
  /** Lot T1 : emprise nationale configuree, au-dela de laquelle un element est ECARTE (defaut : ZONE_PAR_DEFAUT). */
  emprise?: ZoneLecture;
  /** Lot T1 : emprise (approximative) du territoire du projet : un objet qui en sort est CONSERVE et compte (ELEMENTS_HORS_TERRITOIRE). */
  territoire?: ZoneLecture;
}
/**
 * Emprise nationale PAR DEFAUT : longitude -15,2 a -7,5 ; latitude 7,1 a 12,8. Depuis le lot T1 c'est le defaut de la cle de configuration
 * `EMPRISE_PLAUSIBILITE` (CONTRAT-TERRITOIRES.md section 6) : les services passent la valeur configuree par `LimitesLecture.emprise`.
 */
export const BBOX_GUINEE: Bbox = [-15.2, 7.1, -7.5, 12.8];
export const ZONE_PAR_DEFAUT: ZoneLecture = { nom: "Guinee", bbox: BBOX_GUINEE };

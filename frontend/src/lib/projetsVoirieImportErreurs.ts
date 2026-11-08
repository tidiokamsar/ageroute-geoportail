import type { IdEtape } from "./projetsVoirieImport";

/**
 * Etape de l'assistant ou se corrige chaque erreur typee de l'API (CONTRAT-IMPORT.md, sections 5.4, 6 et 11). Une erreur d'aperçu ou de
 * simulation ne se corrige pas toujours a l'etape ou elle arrive : un separateur decimal ambigu se choisit avec les options de lecture du tableau,
 * un CRS incoherent a l'etape du systeme de coordonnees. Sans correspondance, `null` : l'erreur est dite, rien de plus.
 */

const FORMAT = [
  "ENCODAGE_AMBIGU", "ENCODAGE_NON_SUPPORTE", "DELIMITEUR_AMBIGU", "SEPARATEUR_DECIMAL_AMBIGU", "CSV_COLONNES_REQUISES", "CSV_COLONNE_INTROUVABLE",
  "COUCHE_INTROUVABLE", "KMZ_PLUSIEURS_KML", "ENTREE_KML_INTROUVABLE",
];
const CRS = ["CRS_REQUIS", "CRS_NON_AUTORISE", "CRS_NON_DISPONIBLE", "CRS_INCOMPATIBLE_FORMAT", "CRS_CONFLIT", "CRS_INCOHERENT", "TRANSFORMATION_ECHEC", "HORS_GUINEE", "CRS_NON_SUPPORTE"];
const MAPPING = ["MAPPING_INVALIDE", "MAPPING_COLONNE_INTROUVABLE"];
const DEPOT = ["CONCESSIONNAIRE_REQUIS", "CONCESSIONNAIRE_INTROUVABLE", "NATURE_INCOMPATIBLE"];

export function etapeDeCorrection(code: string): IdEtape | null {
  if (FORMAT.includes(code)) return "format";
  if (CRS.includes(code)) return "crs";
  if (MAPPING.includes(code)) return "mapping";
  if (DEPOT.includes(code)) return "depot";
  return null;
}

/** Erreurs de l'inventaire qui laissent l'utilisateur corriger les options de lecture du tableau sans quitter l'etape « Format et couches ». */
export const CODES_LECTURE_TABLEAU = ["ENCODAGE_AMBIGU", "ENCODAGE_NON_SUPPORTE", "DELIMITEUR_AMBIGU"];

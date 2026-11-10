/**
 * Reglages du lot X1 (export du dossier technique, tableaux de bord ; contrat CONTRAT-EXPORTS.md, sections 4.3, 4.4 et 6.4). Chaque reglage est BORNE :
 * une valeur absente, illisible ou hors bornes redonne le defaut (meme lecteur que le socle, `borneEnv`). Ce sont des VALEURS DE PROTECTION (volume,
 * duree, frequence), a valider par le DSI ; aucune n'est un seuil metier.
 */

import { borneEnv } from "../config";

// Revue du lot X1, M3 : bornes hautes ramenees a des valeurs compatibles avec la memoire d'un processus qui sert toute la Console.
export const exportObjetsMax = () => borneEnv("PROJETS_VOIRIE_EXPORT_OBJETS_MAX", 50_000, 1_000, 200_000);
export const exportSommetsMax = () => borneEnv("PROJETS_VOIRIE_EXPORT_SOMMETS_MAX", 1_000_000, 10_000, 5_000_000);
/** Octets NON compresses de l'ensemble des fichiers (ce qui fait la memoire), estimes avant la lecture et comptes PENDANT la fabrication (M3). */
export const exportTailleMaxOctets = () => borneEnv("PROJETS_VOIRIE_EXPORT_TAILLE_MAX_OCTETS", 64 * 1024 * 1024, 1024 * 1024, 256 * 1024 * 1024);
/**
 * Budget total de fabrication (revue du lot X1, M4) : SOUS le delai par defaut du mandataire nginx de production (`proxy_read_timeout` absent, donc 60 s) ;
 * 50 s au plus, quel que soit le reglage. Chaque lecture recoit au plus ce qui reste du budget.
 */
export const exportDelaiMs = () => borneEnv("PROJETS_VOIRIE_EXPORT_DELAI_MS", 45_000, 10_000, 50_000);
/** Une reservation de derogation par une tentative EN_COURS plus ancienne que ce delai est perimee (processus arrete en cours d'export). */
export const reservationPerimeeS = () => Math.ceil(exportDelaiMs() / 1000) + 120;
/** Longueur maximale d'un nom d'objet dans le GeoJSON (au-dela : tronque, `nomTronque: true`, compte dans le manifeste). */
export const NOM_EXPORT_MAX = 500;
/** Objets lus par requete pour un GeoJSON (lecture par lots, octets comptes au fil de l'eau). */
export const LOT_GEOJSON = 5_000;
export const exportCadenceMax = () => borneEnv("PROJETS_VOIRIE_EXPORT_CADENCE_MAX", 10, 1, 1_000);
export const exportCadenceFenetreS = () => borneEnv("PROJETS_VOIRIE_EXPORT_CADENCE_FENETRE_S", 3_600, 60, 86_400);
export const derogationDureeH = () => borneEnv("PROJETS_VOIRIE_EXPORT_DEROGATION_DUREE_H", 24, 1, 168);
export const DEROGATION_DUREE_MAX_H = 168;

export const tableauCadenceMax = () => borneEnv("PROJETS_VOIRIE_TABLEAU_CADENCE_MAX", 30, 1, 1_000);
export const tableauCadenceFenetreS = () => borneEnv("PROJETS_VOIRIE_TABLEAU_CADENCE_FENETRE_S", 60, 10, 3_600);

/** Exports simultanes par processus, et par compte. */
export const EXPORTS_SIMULTANES_MAX = 2;
export const EXPORTS_PAR_COMPTE_MAX = 1;
/** Calculs de tableau de bord simultanes par processus. */
export const TABLEAUX_SIMULTANES_MAX = 4;

/** Niveaux qu'AUCUN reglage ne rend exportables : seule une derogation ADMIN, a usage unique, les ouvre (CONTRAT-EXPORTS.md, section 5). */
export const NIVEAUX_SOUS_DEROGATION = ["CONFIDENTIEL_CONCESSIONNAIRE", "INFRASTRUCTURE_SENSIBLE"] as const;
/** Niveaux exportables par defaut ; le reglage ne peut que RESTREINDRE cette liste. */
export const NIVEAUX_EXPORTABLES_DEFAUT = ["PUBLIC", "INTERNE", "RESTREINT_PROJET"] as const;

/** `PROJETS_VOIRIE_EXPORT_GEOJSON_NIVEAUX` : sous-ensemble des niveaux par defaut ; liste vide, illisible ou sans valeur connue : le defaut. */
export function niveauxExportables(brut = process.env.PROJETS_VOIRIE_EXPORT_GEOJSON_NIVEAUX): string[] {
  if (brut === undefined) return [...NIVEAUX_EXPORTABLES_DEFAUT];
  const demandes = brut.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const retenus = NIVEAUX_EXPORTABLES_DEFAUT.filter((n) => demandes.includes(n));
  return retenus.length > 0 ? [...retenus] : [...NIVEAUX_EXPORTABLES_DEFAUT];
}

/**
 * Vocabulaire et constantes du NOYAU PUR des dossiers de conflit (lot RC-3 ; contrat : docs/projets-voirie/CONTRAT-CONFLITS.md).
 * Sans base, sans E/S : tout ce qui est ici se teste sans PostGIS. Les valeurs des enumerations sont celles de la base
 * (migration 20261031100000) et de `schema.prisma`.
 */

export const TYPES_CONFLIT = ["INTERSECTION_CHAUSSEE", "INTERSECTION_EMPRISE", "PROXIMITE", "TRAVERSEE", "COUVERTURE_INSUFFISANTE", "DIVERGENCE_SOURCES"] as const;
export type TypeConflit = (typeof TYPES_CONFLIT)[number];

export const STATUTS_CONFLIT = ["A_INVESTIGUER", "POTENTIEL", "CONFIRME", "INFIRME", "TRAITEMENT_DECIDE", "CLOTURE"] as const;
export type StatutConflit = (typeof STATUTS_CONFLIT)[number];

export const RISQUES_CONFLIT = ["FAIBLE", "MOYEN", "ELEVE", "INCONNU"] as const;
export type RisqueConflit = (typeof RISQUES_CONFLIT)[number];

export const MOTIFS_REEXAMEN = ["NON_RETROUVE", "MESURE_MODIFIEE", "NOUVELLE_VERSION_DONNEES"] as const;
export type MotifReexamen = (typeof MOTIFS_REEXAMEN)[number];

export const ACTIONS_HISTORIQUE = ["CREATION", "RETROUVE", "MESURE_MODIFIEE", "STATUT", "ATTRIBUTION", "PREUVE", "DECISION_PROPOSEE", "DECISION_APPROUVEE", "DECISION_REFUSEE", "REEXAMEN"] as const;
export type ActionHistorique = (typeof ACTIONS_HISTORIQUE)[number];

export const TYPES_PREUVE = ["NOTE", "REFERENCE_DOCUMENT", "CONTACT_CONCESSIONNAIRE", "RELEVE_TERRAIN"] as const;
export type TypePreuve = (typeof TYPES_PREUVE)[number];

export const OPTIONS_DECISION = ["PROTEGER", "ADAPTER_PROJET", "DEPLACER_RESEAU", "SANS_INTERVENTION", "A_ETUDIER"] as const;
export type OptionDecision = (typeof OPTIONS_DECISION)[number];

export type StatutDecision = "PROPOSEE" | "APPROUVEE" | "REFUSEE" | "ANNULEE";
export type StatutRegle = "BROUILLON" | "APPROUVEE" | "RETIREE";
export type ClassePrecision = "A" | "B" | "C" | "D" | "E" | null;

/** Les seuls roles qui agissent sur un dossier (les lecteurs, inspecteurs et autres comptes ne font que lire). */
export type RoleDecideur = "ADMIN" | "GESTIONNAIRE";
export const estDecideur = (role: string): role is RoleDecideur => role === "ADMIN" || role === "GESTIONNAIRE";

/**
 * Version de l'algorithme de DETECTION PERSISTEE. Elle embarque celle du socle (`2D-UTM-1` : projection UTM, bandes tamponnees,
 * morceaux d'axe voisins) : la mesure d'un conflit est la meme que celle de l'analyse indicative pour le meme objet et le meme axe.
 * Toute modification du calcul incremente ce texte : une analyse enregistre la version avec laquelle elle a ete faite.
 */
export const VERSION_ALGORITHME_CONFLITS = "RC3-2D-UTM-2";
/** Historique : `RC3-2D-UTM-1` (jusqu'au 10/11/2026) faisait un dossier de couverture insuffisante par OBJET du plan d'axes ; `-2` en fait un par AXE (D7). */

/** Justification minimale (caracteres, apres retrait des espaces de bord), comme pour l'autorisation d'un jeu. */
export const JUSTIFICATION_MIN = 10;

/** Cote d'une cellule de localisation, en degres (environ 22 m) : independante du fuseau UTM choisi pour le calcul. */
export const PAS_CELLULE_DEG = 0.0002;

/** Verdicts HUMAINS : un recalcul ne les modifie jamais. */
export const VERDICTS_HUMAINS: readonly StatutConflit[] = ["CONFIRME", "INFIRME", "TRAITEMENT_DECIDE", "CLOTURE"];
export const estVerdictHumain = (s: StatutConflit): boolean => VERDICTS_HUMAINS.includes(s);

/** Mesure d'un conflit (contrat, section 3) : longueurs en metres (au centimetre), distance minimale a l'axe, croisements. */
export interface Mesure {
  longueurChausseeM: number;
  longueurEmpriseM: number;
  distanceMinM: number | null;
  nbCroisements: number;
  /** Longueur de la partie de reseau qui porte ce dossier (ou de l'axe pour une couverture insuffisante). */
  longueurPieceM: number;
  /**
   * Correctif D7 : morceaux du plan d'axes reunis dans un dossier de couverture insuffisante (un dossier par axe, voir couverture.noyau.ts).
   * Absent pour tout autre type, et pour un dossier de couverture calcule avant ce correctif.
   */
  morceaux?: MorceauxCouverture;
}

/** Morceaux non couverts d'un axe : nombre exact, longueur totale (somme des morceaux), detail par objet (borne, `detailTronque`). */
export interface MorceauxCouverture {
  nb: number;
  longueurTotaleM: number;
  detail: { objetId: string; ordre: number; nom: string | null; longueurM: number }[];
  detailTronque: boolean;
}

/** Phrases qui accompagnent TOUT dossier : un conflit est un signal de verification, jamais un ordre. */
export const AVERTISSEMENTS_DOSSIER = [
  "Un conflit est un signal de vérification : aucun déplacement n'est décidé ni ordonné par le système.",
  "Conflit vertical non évalué : profondeur et altitude absentes.",
  "L'absence de conflit détecté ne prouve pas l'absence de réseau.",
] as const;

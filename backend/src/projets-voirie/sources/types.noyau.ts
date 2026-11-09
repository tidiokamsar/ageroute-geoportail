/**
 * Vocabulaire et constantes du NOYAU PUR des sources multiples et de la comparaison entre sources (lot S1 ; contrat :
 * docs/projets-voirie/CONTRAT-SOURCES.md). Sans base, sans E/S. Les valeurs des enumerations sont celles de la base (migration
 * 20261103300000) et de `schema.prisma`.
 */

export const STATUTS_RESULTAT_COMPARAISON = ["CONCORDANCE", "DIVERGENCE", "RAPPROCHEMENT_INCERTAIN", "SANS_CORRESPONDANCE_A", "SANS_CORRESPONDANCE_B"] as const;
export type StatutResultatComparaison = (typeof STATUTS_RESULTAT_COMPARAISON)[number];

export const PREUVES_CONNEXION = ["CONFIRMEE_PAR_FOURNISSEUR", "INCONNUE"] as const;
export type PreuveConnexion = (typeof PREUVES_CONNEXION)[number];

/** Etat de connexion d un objet : ce qui a ete FOURNI, jamais « continue » (aucune connexion n est deduite). */
export const ETATS_CONNEXION = ["CONFIRMEE", "INCONNUE", "NON_FOURNIE"] as const;
export type EtatConnexion = (typeof ETATS_CONNEXION)[number];

/** Etat d un reseau du projet selon son nombre de sources AUTORISEES. */
export const STATUTS_RESEAU_SOURCES = ["SOURCE_UNIQUE_COMPARAISON_INDISPONIBLE", "COMPARABLE"] as const;
export type StatutReseauSources = (typeof STATUTS_RESEAU_SOURCES)[number];

/** Origine de la precision retenue pour un objet : descripteur (OBJET), jeu, classe declaree convertie par la regle, ou inconnue. */
export type OriginePrecision = "OBJET" | "JEU" | "CLASSE" | "INCONNUE";

/**
 * Version de l algorithme de comparaison : projection UTM (meme choix que l analyse 2D), appariement par rayon, corridor = max des precisions
 * declarees + marge, mesure de la longueur hors corridor et de la distance de Hausdorff. Toute modification du calcul incremente ce texte.
 */
export const VERSION_ALGORITHME_COMPARAISON = "S1-CORRIDOR-UTM-1";

export const CODE_REGLE_RAPPROCHEMENT_DEFAUT = "S1-CORRIDOR-0.1";

/** Tolerance NUMERIQUE (pas metier) sur une longueur hors corridor : en dessous d un centimetre, c est un eclat de decoupe du tampon. */
export const TOLERANCE_LONGUEUR_M = 0.01;

/** Phrases qui accompagnent toute comparaison : un resultat est une synthese a lire, jamais une decision. */
export const LIMITES_COMPARAISON = [
  "Une comparaison entre sources est une synthèse : elle ne décide rien, ne modifie ni ne fusionne aucune géométrie ; chaque source est préservée.",
  "Une divergence mesurée n'est pas une erreur attribuée à l'une des sources : seule une investigation (dossier de conflit ouvert par une personne) peut trancher.",
  "Un rapprochement incertain signifie qu'une précision déclarée manque : aucune mesure de divergence n'est produite, aucune précision n'est inventée.",
  "Seuls les objets linéaires sont comparés ; les objets ponctuels et surfaciques sont comptés sans être évalués.",
] as const;

/** Libelle fixe tenant lieu d « axe » pour un dossier de conflit issu d une comparaison (un dossier RC-3 porte un axe non vide). */
export const AXE_DIVERGENCE_SOURCES = "Divergence de sources";

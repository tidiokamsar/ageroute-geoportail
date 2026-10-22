/**
 * IRI par pas de 100 m : INTERFACE SEULEMENT. AUCUN CALCUL N'EST FAIT.
 *
 * POURQUOI CE MODULE REFUSE
 *
 * Un IRI (International Roughness Index, en m/km) n'est une mesure que s'il est etalonne : la reponse
 * d'un accelerometre de telephone depend de l'appareil, de sa fixation, du vehicule, de sa suspension
 * et de sa vitesse. Sans etalon (profilometre de reference, ou correlation etablie par AGEROUTE sur des
 * sections connues) et sans donnees d'accelerometre reelles, tout nombre produit ici serait INVENTE, et
 * un IRI invente alimenterait l'evaluation de l'etat des routes. Le projet n'a ni l'un ni l'autre.
 *
 * Ce fichier fixe donc seulement le CONTRAT d'entree et de sortie, pour que l'enregistrement des
 * echantillons d'accelerometre (plugin natif, 100 Hz selon l'ADR-009) puisse etre concu contre une
 * interface stable. `calculerIri` REFUSE, avec un motif explicite :
 *
 *     ENTREE_INVALIDE        l'entree ne respecte pas le contrat (pas different de 100 m, trop peu de donnees)
 *     ETALONNAGE_ABSENT      aucun etalonnage approuve n'est fourni
 *     CALCUL_NON_IMPLEMENTE  meme avec un etalonnage, l'algorithme n'est pas ecrit
 *
 * La branche `CALCULE` du type de sortie n'est PRODUITE PAR AUCUN CODE de ce depot. Le serveur, de son
 * cote, rejette toute charge de session qui porterait un champ `iri`.
 */

/** Pas de report de l'IRI, en metres (critere A18 : « IRI par 100 m »). */
export const PAS_IRI_M = 100;

export interface EchantillonAcceleration {
  tMs: number;
  /** Accelerations en m/s2 dans le repere de l'appareil. Le repere vertical n'est PAS suppose connu. */
  axMs2: number;
  ayMs2: number;
  azMs2: number;
}

export interface PositionVitesse {
  tMs: number;
  lat: number;
  lon: number;
  vitesseMs: number | null;
}

export interface DemandeIri {
  accelerations: readonly EchantillonAcceleration[];
  /** Frequence d'echantillonnage declaree de l'accelerometre, en Hz, ou `null` si inconnue. */
  frequenceHz: number | null;
  positions: readonly PositionVitesse[];
  /** Doit valoir `PAS_IRI_M`. */
  pasM: number;
}

/** Un etalonnage n'est « approuve » que par une decision d'AGEROUTE, tracee. Aucun n'existe a ce jour. */
export interface EtalonnageApprouve {
  reference: string;
  approuveLe: string;
  approuvePar: string;
}

export interface IriPas {
  indice: number;
  debutM: number;
  finM: number;
  /** IRI en m/km. Jamais produit par ce depot. */
  iriMParKm: number;
}

export type MotifRefusIri = "ENTREE_INVALIDE" | "ETALONNAGE_ABSENT" | "CALCUL_NON_IMPLEMENTE";

export type ResultatIri =
  | { statut: "CALCULE"; pas: IriPas[]; etalonnage: EtalonnageApprouve }
  | { statut: "REFUSE"; motif: MotifRefusIri; detail: string };

/** Nombre minimal d'echantillons pour parler d'une entree exploitable. Valeur de forme, pas une norme metrologique. */
export const ACCELERATIONS_MIN = 2;

export function calculerIri(demande: DemandeIri, etalonnage: EtalonnageApprouve | null = null): ResultatIri {
  if (demande.pasM !== PAS_IRI_M) {
    return { statut: "REFUSE", motif: "ENTREE_INVALIDE", detail: `Le pas doit valoir ${PAS_IRI_M} m (recu ${demande.pasM}).` };
  }
  if (demande.accelerations.length < ACCELERATIONS_MIN || demande.positions.length < 2) {
    return { statut: "REFUSE", motif: "ENTREE_INVALIDE", detail: "Accelerations ou positions en nombre insuffisant." };
  }
  if (etalonnage === null) {
    return {
      statut: "REFUSE",
      motif: "ETALONNAGE_ABSENT",
      detail: "Aucun etalonnage approuve : un IRI calcule sans etalon serait un nombre invente. Voir docs/roulage/COLLECTE-ROULAGE.md.",
    };
  }
  return {
    statut: "REFUSE",
    motif: "CALCUL_NON_IMPLEMENTE",
    detail: "L'algorithme de calcul de l'IRI n'est pas ecrit ; un etalonnage approuve ne suffit pas.",
  };
}

/** Types partages du noyau de collecte en roulage. Aucun import : ce fichier decrit des donnees, rien d'autre. */

/** Une position GNSS telle que le recepteur la rend. L'horodatage est celui du recepteur (ms depuis 1970). */
export interface EchantillonGnss {
  tMs: number;
  lat: number;
  lon: number;
  /** Precision horizontale annoncee, en metres. `null` quand le recepteur n'en donne pas : jamais inventee. */
  precisionM: number | null;
  /** Vitesse sol annoncee, en m/s, ou `null`. */
  vitesseMs: number | null;
  capDeg: number | null;
  altitudeM: number | null;
}

/** Echantillon retenu, avec le segment de trace auquel il appartient. Deux segments ne sont jamais relies. */
export interface EchantillonRetenu extends EchantillonGnss {
  segment: number;
}

export type MotifRejet =
  | "SESSION_NON_EN_COURS"
  | "COORDONNEES_INVALIDES"
  | "HORODATAGE_INVALIDE"
  | "PRECISION_ABSENTE"
  | "PRECISION_INSUFFISANTE"
  | "HORODATAGE_DOUBLON"
  | "HORODATAGE_RECULE"
  | "SAUT_IMPOSSIBLE"
  | "FIX_FIGE";

export const MOTIFS_REJET: readonly MotifRejet[] = [
  "SESSION_NON_EN_COURS", "COORDONNEES_INVALIDES", "HORODATAGE_INVALIDE", "PRECISION_ABSENTE",
  "PRECISION_INSUFFISANTE", "HORODATAGE_DOUBLON", "HORODATAGE_RECULE", "SAUT_IMPOSSIBLE", "FIX_FIGE",
];

export type TypeAlerte = "DERIVE_HORLOGE" | "REANCRAGE" | "JOURNAL_ECHEC" | "SANS_PRECISION";

export interface Alerte {
  type: TypeAlerte;
  tMs: number;
  detail?: string;
}

/** Un trou : deux echantillons acceptes consecutifs separes de plus de `trouMs`. */
export interface Trou {
  debutMs: number;
  finMs: number;
  dureeMs: number;
  /** Vrai si le trou a coupe la trace en deux segments. */
  coupeSegment: boolean;
}

export type CauseInterruption = "APPEL" | "VEILLE" | "GNSS_PERDU" | "PERMISSION_RETIREE" | "REDEMARRAGE";

export interface Interruption {
  cause: CauseInterruption;
  debutMs: number;
  /** `null` tant que l'interruption dure. */
  finMs: number | null;
  /** Present si l'interruption n'a pas ete close par l'evenement attendu : l'arret de la session, ou un redemarrage. */
  closePar?: "ARRET" | "REDEMARRAGE";
}

/** Un instant, avec la position connue a cet instant. `lat`/`lon` sont nuls si aucun fix n'a jamais ete recu. */
export interface Repere {
  tMs: number;
  lat: number | null;
  lon: number | null;
  precisionM: number | null;
  /** Anciennete du fix utilise, en ms, ou `null` s'il n'y en a pas. */
  ageFixMs: number | null;
  vitesseMs: number | null;
  /** Vrai si le fix est plus vieux que `ageFixMaxMarqueurMs` ou absent. */
  positionPerimee: boolean;
}

export interface Marqueur {
  id: string;
  code: string;
  note: string | null;
  repere: Repere;
  /** Duree de construction du marqueur, mesuree par le compteur injecte. LOGICIELLE seulement. */
  latenceLogicielleMs: number;
}

/** Attributs de portion qu'un evenement lineaire peut porter. Codes de referentiel, jamais du texte libre. */
export interface Qualification {
  revetement?: string | null;
  etat?: string | null;
  praticabilite?: string | null;
  largeurM?: number | null;
}

export type StatutEvenement = "OUVERT" | "CLOS" | "CLOS_PAR_ARRET" | "ABANDONNE";

export interface EvenementLineaire {
  id: string;
  code: string;
  note: string | null;
  qualification: Qualification | null;
  statut: StatutEvenement;
  debut: Repere;
  fin: Repere | null;
  /** Part de la duree couverte par des echantillons, 0..1. Calculee a la cloture. */
  couvertureGnss: number | null;
  distanceDirecteM: number | null;
  avertissements: string[];
  motifAbandon: string | null;
}

export type StatutSession = "EN_COURS" | "EN_PAUSE" | "ARRETEE";

/** Evenements du systeme injectes par l'hote (plugin natif, ecouteurs du navigateur, ou test). */
export type EvenementSysteme =
  | { type: "APPEL_ENTRANT" }
  | { type: "APPEL_TERMINE" }
  | { type: "VEILLE_DEBUT" }
  | { type: "VEILLE_FIN" }
  | { type: "GNSS_INDISPONIBLE" }
  | { type: "GNSS_DISPONIBLE" }
  | { type: "PERMISSION_RETIREE" }
  | { type: "PERMISSION_ACCORDEE" };

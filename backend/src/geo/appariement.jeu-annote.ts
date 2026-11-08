/**
 * Jeu de points annotes pour le critere A2, et ce qu'il prouve exactement.
 *
 * CE QU'IL PROUVE
 *
 * Que la DECISION classe le bon troncon en tete quand elle se declare confiante, et qu'elle
 * s'abstient sinon. C'est litteralement ce que demande le critere A2 : « sur un jeu de test de
 * points annotes (incluant routes parallelles et carrefours) : >= 95 % de bon candidat en tete
 * quand la confiance est haute ; 0 rattachement automatique sous le seuil ».
 *
 * CE QU'IL NE PROUVE PAS, ET IL FAUT LE DIRE
 *
 * Les distances et orientations sont DONNEES, pas calculees : le calcul geometrique est le
 * travail de PostGIS et s'eprouve ailleurs. Ce jeu ne dit donc rien de la justesse de
 * `ST_Distance` ni de `ST_LineLocatePoint`.
 *
 * Et il ne dit rien du comportement du bruit GPS reel. Les situations sont construites d'apres
 * des configurations routieres decrites par le paragraphe 7.3.5, avec des distances
 * plausibles ; ce ne sont pas des releves de terrain.
 *
 * POURQUOI SYNTHETIQUE PLUTOT QU'EXTRAIT DE LA PRODUCTION
 *
 * Deux raisons, et la premiere est la meilleure.
 *
 * LA VERITE TERRAIN EST CONNUE PAR CONSTRUCTION. Dans un extrait de production, « quel est le
 * bon troncon » serait justement ce qu'il faudrait etablir — et l'etablir en lancant
 * l'appariement rendrait la mesure circulaire. Ici, le bon troncon est pose avant le calcul.
 *
 * Et le garde-fou 2.1 du mandat v2.1 a coupe l'acces a la production (B-13).
 *
 * CHAQUE CAS PORTE SA SITUATION ET SON ATTENDU, et les situations couvrent les cinq que le
 * paragraphe 7.3.5 exige explicitement : routes parallelles a moins de 50 m, intersections,
 * chaussees separees, precision degradee, route absente du referentiel.
 */
import type { CandidatNoyau, ContexteAppariement } from "./appariement.noyau";

export type Situation =
  | "ROUTE_ISOLEE"
  | "PARALLELES_PROCHES"
  | "CARREFOUR"
  | "CHAUSSEES_SEPAREES"
  | "PRECISION_DEGRADEE"
  | "HORS_REFERENTIEL";

export interface CasAnnote {
  nom: string;
  situation: Situation;
  candidats: CandidatNoyau[];
  contexte: ContexteAppariement;
  /**
   * Le troncon qui est reellement sous le point. `null` quand aucun ne l'est — route absente
   * du referentiel — et l'appariement DOIT alors s'abstenir.
   */
  attendu: string | null;
  /**
   * Faut-il s'abstenir de rattacher automatiquement ? Vrai pour les cas ou la bonne reponse
   * est « demander a l'agent » ou « ne rien rattacher », meme quand `attendu` est connu.
   */
  abstentionAttendue: boolean;
  /** Pourquoi ce cas existe, en une phrase. */
  motif: string;
}

function t(
  tronconId: string,
  distanceM: number,
  capTronconDeg: number | null = null,
  classe = "RN",
): CandidatNoyau {
  return {
    tronconId, code: tronconId, nom: tronconId, classe,
    distanceM, fraction: 0.5, longueurM: 5000,
    pkDebut: null, pkFin: null, capTronconDeg,
  };
}

const ctx = (p: Partial<ContexteAppariement>): ContexteAppariement => ({
  incertitudeM: 5, capDeg: null, vitesseKmH: null, tronconPrecedentId: null, ...p,
});

export const JEU_ANNOTE: readonly CasAnnote[] = [
  // ---- Route isolee : le cas facile, qui doit marcher sans discussion ----
  {
    nom: "RN1 en rase campagne, GPS a 4 m",
    situation: "ROUTE_ISOLEE",
    candidats: [t("RN1", 3)],
    contexte: ctx({ incertitudeM: 4 }),
    attendu: "RN1", abstentionAttendue: false,
    motif: "Un seul troncon a portee : rien ne concurrence, la confiance doit etre haute.",
  },
  {
    nom: "RN1 avec une piste a 40 m",
    situation: "ROUTE_ISOLEE",
    candidats: [t("RN1", 4), t("PISTE-7", 40, null, "PISTE")],
    contexte: ctx({ incertitudeM: 5 }),
    attendu: "RN1", abstentionAttendue: false,
    motif: "Le concurrent est loin : la separation doit permettre la preselection.",
  },
  {
    nom: "RN4 a 2 m, cap aligne, 70 km/h",
    situation: "ROUTE_ISOLEE",
    candidats: [t("RN4", 2, 95), t("RR-12", 38, 10)],
    contexte: ctx({ incertitudeM: 4, capDeg: 92, vitesseKmH: 70 }),
    attendu: "RN4", abstentionAttendue: false,
    motif: "Cap coherent : le facteur de cap ne doit pas degrader un bon appariement.",
  },
  {
    nom: "RN4 a 2 m, parcourue a CONTRESENS",
    situation: "ROUTE_ISOLEE",
    candidats: [t("RN4", 2, 95), t("RR-12", 38, 10)],
    contexte: ctx({ incertitudeM: 4, capDeg: 275, vitesseKmH: 70 }),
    attendu: "RN4", abstentionAttendue: false,
    motif: "Une route se parcourt dans les deux sens : 180 degres d'ecart reste coherent.",
  },

  // ---- Paralleles proches : le cas que le paragraphe 7.3.5 cite en premier ----
  {
    nom: "Deux voies parallelles a 12 m, point entre les deux",
    situation: "PARALLELES_PROCHES",
    candidats: [t("CKY-A", 5, 90), t("CKY-B", 7, 90)],
    contexte: ctx({ incertitudeM: 8 }),
    attendu: "CKY-A", abstentionAttendue: true,
    motif: "Deux metres d'ecart sous 8 m d'incertitude : choisir reviendrait a tirer au sort.",
  },
  {
    nom: "Paralleles a 12 m, mais le cap tranche",
    situation: "PARALLELES_PROCHES",
    candidats: [t("CKY-A", 5, 90), t("CKY-B", 7, 180)],
    contexte: ctx({ incertitudeM: 8, capDeg: 92, vitesseKmH: 45 }),
    attendu: "CKY-A", abstentionAttendue: false,
    motif: "Le cap est ce qui departage deux paralleles d'orientations differentes. "
      + "Sans ce facteur, le cas etait indecidable.",
  },
  {
    nom: "Paralleles, et l'on suivait deja la premiere",
    situation: "PARALLELES_PROCHES",
    candidats: [t("CKY-B", 5), t("CKY-A", 6)],
    contexte: ctx({ incertitudeM: 9, tronconPrecedentId: "CKY-A" }),
    attendu: "CKY-A", abstentionAttendue: true,
    motif: "La continuite doit remonter CKY-A en tete, sans pour autant autoriser une "
      + "preselection : un metre d'ecart reste un metre d'ecart.",
  },
  {
    nom: "Corniche Nord et Sud, 30 m d'ecart, GPS a 5 m",
    situation: "PARALLELES_PROCHES",
    candidats: [t("CORNICHE-N", 4), t("CORNICHE-S", 30)],
    contexte: ctx({ incertitudeM: 5 }),
    attendu: "CORNICHE-N", abstentionAttendue: false,
    motif: "Trente metres sous 5 m d'incertitude : la separation est franche.",
  },

  // ---- Carrefours ----
  {
    nom: "Approche d'un carrefour, trois branches a portee",
    situation: "CARREFOUR",
    candidats: [t("RN1", 4, 0), t("RN2", 6, 90), t("RR-8", 9, 45)],
    contexte: ctx({ incertitudeM: 7 }),
    attendu: "RN1", abstentionAttendue: true,
    motif: "Au carrefour sans cap, les branches sont indiscernables : il faut demander.",
  },
  {
    nom: "Carrefour franchi, cap plein nord",
    situation: "CARREFOUR",
    candidats: [t("RN1", 4, 2), t("RN2", 6, 90)],
    contexte: ctx({ incertitudeM: 7, capDeg: 0, vitesseKmH: 35 }),
    attendu: "RN1", abstentionAttendue: false,
    motif: "Le cap annule RN2, perpendiculaire : c'est le cas que le facteur resout.",
  },
  {
    nom: "On quitte RN1 pour RN2 au carrefour",
    situation: "CARREFOUR",
    candidats: [t("RN2", 3, 90), t("RN1", 35, 0)],
    contexte: ctx({ incertitudeM: 6, tronconPrecedentId: "RN1" }),
    attendu: "RN2", abstentionAttendue: false,
    motif: "La continuite NE DOIT PAS coller a RN1, qui s'est eloigne : un changement de "
      + "troncon est legitime. C'est le defaut inverse, et le plus insidieux.",
  },

  // ---- Chaussees separees ----
  {
    nom: "Chaussees separees de 15 m, sens opposes, cap connu",
    situation: "CHAUSSEES_SEPAREES",
    candidats: [t("AUTO-EST", 6, 90), t("AUTO-OUEST", 9, 270)],
    contexte: ctx({ incertitudeM: 7, capDeg: 88, vitesseKmH: 80 }),
    attendu: "AUTO-EST", abstentionAttendue: true,
    motif: "PIEGE CONNU : deux chaussees de sens opposes ont des caps a 180 degres, et le "
      + "facteur de cap les traite comme equivalents a dessein. Le cap ne peut donc PAS "
      + "les departager, et l'abstention est la bonne reponse.",
  },
  {
    nom: "Chaussees separees, on suivait la voie est",
    situation: "CHAUSSEES_SEPAREES",
    candidats: [t("AUTO-OUEST", 6, 270), t("AUTO-EST", 8, 90)],
    contexte: ctx({ incertitudeM: 9, capDeg: 88, vitesseKmH: 80, tronconPrecedentId: "AUTO-EST" }),
    attendu: "AUTO-EST", abstentionAttendue: true,
    motif: "La continuite est le seul facteur capable de departager deux chaussees "
      + "separees. Elle doit remonter la bonne en tete sans autoriser l'automatisme.",
  },

  // ---- Precision degradee ----
  {
    nom: "Sous couvert forestier, 35 m d'incertitude",
    situation: "PRECISION_DEGRADEE",
    candidats: [t("RR-40", 12), t("PISTE-3", 20, null, "PISTE")],
    contexte: ctx({ incertitudeM: 35 }),
    attendu: "RR-40", abstentionAttendue: true,
    motif: "A 35 m d'incertitude, 8 m d'ecart ne separent rien : la confiance doit chuter.",
  },
  {
    nom: "Canyon urbain, 60 m d'incertitude, un trace a 3 m",
    situation: "PRECISION_DEGRADEE",
    candidats: [t("CKY-C", 3), t("CKY-D", 25)],
    contexte: ctx({ incertitudeM: 60 }),
    attendu: null, abstentionAttendue: true,
    motif: "Au-dela de 50 m d'incertitude, le mandat interdit tout rattachement. Les 3 m "
      + "sont une coincidence, pas une mesure.",
  },
  {
    nom: "Precision moyenne, 18 m, mais un seul troncon",
    situation: "PRECISION_DEGRADEE",
    candidats: [t("RN6", 8)],
    contexte: ctx({ incertitudeM: 18 }),
    attendu: "RN6", abstentionAttendue: false,
    motif: "Un seul candidat : la separation est totale, et 8 m sous 18 m d'incertitude "
      + "reste coherent. Une precision moyenne n'interdit pas de conclure.",
  },

  // ---- Hors referentiel ----
  {
    nom: "Piste non cartographiee, le plus proche a 80 m",
    situation: "HORS_REFERENTIEL",
    candidats: [t("RN1", 80)],
    contexte: ctx({ incertitudeM: 6 }),
    attendu: null, abstentionAttendue: true,
    motif: "Au-dela de la distance maximale, le point n'est sur aucune route connue. Le "
      + "paragraphe 7.3.5 veut qu'on propose un nouveau troncon, pas qu'on rattache.",
  },
  {
    nom: "Aucun troncon a portee",
    situation: "HORS_REFERENTIEL",
    candidats: [],
    contexte: ctx({ incertitudeM: 5 }),
    attendu: null, abstentionAttendue: true,
    motif: "Aucun candidat : le refus doit nommer cette cause et non une autre.",
  },
  {
    nom: "Route absente, un trace a 52 m",
    situation: "HORS_REFERENTIEL",
    candidats: [t("RR-99", 52), t("RN1", 140)],
    contexte: ctx({ incertitudeM: 5 }),
    attendu: null, abstentionAttendue: true,
    motif: "Juste au-dela du plafond : la frontiere doit etre franche, pas approximative.",
  },

  // ---- Cas de frontiere et configurations plus denses ----
  {
    nom: "Paralleles proches, vehicule a l'arret",
    situation: "PARALLELES_PROCHES",
    candidats: [t("CKY-A", 5, 90), t("CKY-B", 7, 180)],
    contexte: ctx({ incertitudeM: 8, capDeg: 42, vitesseKmH: 1 }),
    attendu: "CKY-A", abstentionAttendue: true,
    motif: "A l'arret, le cap rendu par le GPS est aleatoire : le facteur doit redevenir "
      + "neutre, donc le cas reste indecidable comme s'il n'y avait pas de cap du tout.",
  },
  {
    nom: "Precision exactement au plafond de 50 m",
    situation: "PRECISION_DEGRADEE",
    candidats: [t("RN6", 6)],
    contexte: ctx({ incertitudeM: 50 }),
    attendu: "RN6", abstentionAttendue: false,
    motif: "Le mandat interdit le rattachement AU-DELA de 50 m. A exactement 50 m, la "
      + "frontiere doit etre inclusive, sinon le seuil n'est pas celui qui est ecrit.",
  },
  {
    nom: "Carrefour a quatre branches, cap vers l'est",
    situation: "CARREFOUR",
    candidats: [t("RN1", 5, 0), t("RN2", 5, 90), t("RR-8", 6, 180), t("RR-9", 7, 270)],
    contexte: ctx({ incertitudeM: 8, capDeg: 91, vitesseKmH: 30 }),
    attendu: "RN2", abstentionAttendue: true,
    motif: "Quatre branches dont deux alignees avec le cap a 180 degres pres : le cap "
      + "elimine RN1 et RR-9, mais laisse RN2 et RR-8 equivalents. L'abstention est juste.",
  },
  {
    nom: "Forest degradee, mais on suivait deja ce troncon",
    situation: "PRECISION_DEGRADEE",
    candidats: [t("RR-40", 12), t("PISTE-3", 14, null, "PISTE")],
    contexte: ctx({ incertitudeM: 30, tronconPrecedentId: "RR-40" }),
    attendu: "RR-40", abstentionAttendue: true,
    motif: "La continuite doit remonter RR-40 en tete malgre 2 m d'ecart seulement, sans "
      + "autoriser un automatisme que 30 m d'incertitude interdisent.",
  },
] as const;

/** Les cas ou un rattachement automatique est la bonne reponse. */
export const CAS_RATTACHABLES = JEU_ANNOTE.filter((c) => !c.abstentionAttendue);
/** Les cas ou s'abstenir est la bonne reponse. */
export const CAS_ABSTENTION = JEU_ANNOTE.filter((c) => c.abstentionAttendue);

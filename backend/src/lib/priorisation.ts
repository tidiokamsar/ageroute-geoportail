/**
 * Priorisation transparente : un score n'est rendu que s'il peut l'etre (T8).
 *
 * CE QUE LE SCORE ETAIT
 *
 * Quatre criteres ponderes — etat 35 %, trafic 25 %, criticite 20 %, cout 20 %. Sur
 * les 1 690 troncons, mesure du 01/09/2026 :
 *
 *   etat        647 renseignes sur 1 690 (1 043 valent NON_EVALUE), aucun date
 *   trafic        0 sur 1 690
 *   criticite     0 sur 1 690
 *   cout          0 sur 1 690
 *
 * Trois criteres sur quatre etaient donc vides. Le calcul ne s'arretait pas pour
 * autant : le trafic normalise valait 0 pour tout le monde tout en pesant 25 % du
 * total, et surtout deux criteres etaient FABRIQUES —
 *
 *   criticite <- une valeur deduite de la classe de route
 *   cout      <- longueur x un tarif au kilometre choisi selon l'etat
 *
 * Ces estimations etaient ensuite presentees a l'ecran au meme titre que l'etat
 * reellement constate. C'est exactement ce que le §41 interdit : presenter une
 * estimation comme une donnee reelle.
 *
 * LA REGLE RETENUE
 *
 * Un score n'est rendu que si CHAQUE critere portant un poids non nul dispose d'une
 * valeur reelle. Sinon, pas de score, et la liste des criteres manquants.
 *
 * La regle est volontairement simple et sans seuil arbitraire — le §32 interdit une
 * formule opaque. Elle se lit d'une phrase : vous avez demande a ce que le trafic
 * compte pour un quart ; le trafic est inconnu ; le classement que vous demandez ne
 * peut pas etre calcule.
 *
 * Et elle laisse la main : mettre un poids a zero exclut le critere explicitement, et
 * le score redevient calculable sur les criteres restants. Le choix est alors visible
 * et assume, au lieu d'etre masque par une valeur de repli.
 */

export type Disponibilite = "DISPONIBLE" | "ABSENTE" | "ESTIMEE";

export interface CritereEvalue {
  critere: "etat" | "trafic" | "criticite" | "cout";
  libelle: string;
  /** Valeur normalisee sur 100. Null quand le critere n'est pas disponible. */
  valeur: number | null;
  /** Valeur brute, telle qu'elle figure en base, pour que l'ecran ne mente pas. */
  valeurBrute: number | string | null;
  poids: number;
  disponibilite: Disponibilite;
  /** Date du constat. Aucune valeur de la base n'en porte aujourd'hui. */
  date: string | null;
  source: string | null;
  /** Ce qui manque, ou d'ou vient la valeur. */
  commentaire: string;
}

export interface ResultatPriorisation {
  /** Null quand le score n'est pas calculable. Jamais 0 : 0 serait un classement. */
  score: number | null;
  calculable: boolean;
  /** Critères pondérés mais indisponibles. Vide quand le score est calculable. */
  criteresManquants: string[];
  criteres: CritereEvalue[];
  /** Phrase destinee a l'ecran, pour que la raison ne se perde pas en route. */
  explication: string;
}

export interface Ponderation {
  etat: number;
  trafic: number;
  criticite: number;
  cout: number;
}

export interface DonneesTroncon {
  etat: string;
  traficMoyenJma: number | null;
  criticiteStrategique: number | null;
  coutRehabEstime: number | null;
  dateDerniereEvaluation: Date | null;
}

/** Etat en score sur 100. Un etat plus degrade prime. */
const SCORE_ETAT: Record<string, number> = {
  CRITIQUE: 100,
  MAUVAIS: 80,
  MOYEN: 50,
  BON: 10,
};

const LIBELLES: Record<CritereEvalue["critere"], string> = {
  etat: "État de la chaussée",
  trafic: "Trafic moyen journalier",
  criticite: "Criticité stratégique",
  cout: "Coût de réhabilitation",
};

/**
 * Evalue les quatre criteres d'un troncon, sans jamais combler un manque.
 *
 * `normalisation` porte les bornes du sous-ensemble compare, pour ramener trafic et
 * cout sur 100. Absente, ces criteres restent bruts et non normalisables.
 */
export function evaluerCriteres(
  t: DonneesTroncon,
  poids: Ponderation,
  normalisation?: { traficMax: number; coutMax: number }
): CritereEvalue[] {
  const date = t.dateDerniereEvaluation ? t.dateDerniereEvaluation.toISOString().slice(0, 10) : null;

  // NON_EVALUE n'est pas un etat degrade : c'est une absence d'information. La
  // traiter comme une valeur basse ferait passer un troncon inconnu pour un troncon
  // en bon etat.
  const etatConnu = t.etat !== "NON_EVALUE" && SCORE_ETAT[t.etat] != null;

  return [
    {
      critere: "etat",
      libelle: LIBELLES.etat,
      valeur: etatConnu ? SCORE_ETAT[t.etat] : null,
      valeurBrute: t.etat,
      poids: poids.etat,
      disponibilite: etatConnu ? "DISPONIBLE" : "ABSENTE",
      date,
      source: etatConnu ? "Base BDRI" : null,
      commentaire: etatConnu
        ? date
          ? "Constaté"
          : "Renseigné, mais non daté : non comparable à un autre état"
        : "Jamais évalué — 1 043 tronçons sur 1 690 sont dans ce cas",
    },
    {
      critere: "trafic",
      libelle: LIBELLES.trafic,
      valeur:
        t.traficMoyenJma != null && normalisation && normalisation.traficMax > 0
          ? (t.traficMoyenJma / normalisation.traficMax) * 100
          : null,
      valeurBrute: t.traficMoyenJma,
      poids: poids.trafic,
      disponibilite: t.traficMoyenJma != null ? "DISPONIBLE" : "ABSENTE",
      date: null,
      source: t.traficMoyenJma != null ? "Base BDRI" : null,
      commentaire:
        t.traficMoyenJma != null ? "Comptage enregistré" : "Aucun comptage — 0 tronçon sur 1 690",
    },
    {
      critere: "criticite",
      libelle: LIBELLES.criticite,
      // Aucun repli sur la classe de route : c'etait une valeur fabriquee.
      valeur: t.criticiteStrategique,
      valeurBrute: t.criticiteStrategique,
      poids: poids.criticite,
      disponibilite: t.criticiteStrategique != null ? "DISPONIBLE" : "ABSENTE",
      date: null,
      source: t.criticiteStrategique != null ? "Base BDRI" : null,
      commentaire:
        t.criticiteStrategique != null
          ? "Criticité renseignée"
          : "Non définie — aucun critère de criticité n'a été arrêté par AGEROUTE",
    },
    {
      critere: "cout",
      libelle: LIBELLES.cout,
      // Aucun repli sur longueur x tarif : c'etait une estimation presentee comme
      // une donnee.
      valeur:
        t.coutRehabEstime != null && normalisation && normalisation.coutMax > 0
          ? (t.coutRehabEstime / normalisation.coutMax) * 100
          : null,
      valeurBrute: t.coutRehabEstime,
      poids: poids.cout,
      disponibilite: t.coutRehabEstime != null ? "DISPONIBLE" : "ABSENTE",
      date: null,
      source: t.coutRehabEstime != null ? "Base BDRI" : null,
      commentaire:
        t.coutRehabEstime != null ? "Coût renseigné" : "Aucun coût — 0 tronçon sur 1 690",
    },
  ];
}

/**
 * Rend un score UNIQUEMENT si tous les criteres ponderes sont disponibles.
 *
 * Un poids a zero vaut exclusion explicite : le critere n'est alors pas exige, et
 * l'operateur assume ce choix au lieu de le subir.
 */
export function calculerScore(criteres: CritereEvalue[]): ResultatPriorisation {
  const ponderes = criteres.filter((c) => c.poids > 0);
  const manquants = ponderes.filter((c) => c.disponibilite !== "DISPONIBLE" || c.valeur == null);

  if (ponderes.length === 0) {
    return {
      score: null,
      calculable: false,
      criteresManquants: [],
      criteres,
      explication: "Aucun critère n'est pondéré : il n'y a rien à classer.",
    };
  }

  if (manquants.length > 0) {
    const noms = manquants.map((c) => c.libelle);
    return {
      score: null,
      calculable: false,
      criteresManquants: manquants.map((c) => c.critere),
      criteres,
      explication:
        `Score non calculable : ${noms.join(", ")} ${manquants.length > 1 ? "sont demandés" : "est demandé"} ` +
        `dans la pondération mais ${manquants.length > 1 ? "ne sont" : "n'est"} pas renseigné${manquants.length > 1 ? "s" : ""}. ` +
        `Mettre son poids à zéro l'exclut explicitement du classement.`,
    };
  }

  const total = ponderes.reduce((s, c) => s + c.poids, 0);
  const score = ponderes.reduce((s, c) => s + (c.valeur ?? 0) * c.poids, 0) / total;

  return {
    score: Math.round(score * 10) / 10,
    calculable: true,
    criteresManquants: [],
    criteres,
    explication: `Score calculé sur ${ponderes.length} critère${ponderes.length > 1 ? "s" : ""} : ${ponderes
      .map((c) => `${c.libelle} ${c.poids} %`)
      .join(", ")}.`,
  };
}

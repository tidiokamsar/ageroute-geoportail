/**
 * Condition Engine : le RCI, et ce qu'il refuse de faire.
 *
 * CE QUE LE CAHIER DEMANDE (paragraphe 13)
 *
 * « Le RCI est un score 0–100 configurable et versionné. Base indicative à calibrer :
 * chaussée 30 %, drainage 15 %, ouvrages 15 %, signalisation 10 %, sécurité 10 %,
 * trafic 10 %, historique 5 %, incidents 5 %. Chaque calcul conserve score, composantes,
 * règle/version, date, sources et confiance. Le système doit expliquer pourquoi le score
 * est obtenu. »
 *
 * CE FICHIER NE CONTIENT AUCUN COEFFICIENT
 *
 * Les pourcentages ci-dessus sont donnes comme « base indicative A CALIBRER ». Les ecrire
 * dans le code produirait un score qui a l'air officiel et que personne n'a valide — ce
 * que la regle imperative du paragraphe 39 interdit explicitement.
 *
 * Ils vivent donc en base, dans une REGLE VERSIONNEE, et une regle non approuvee produit
 * des scores marques comme non publiables. Le mecanisme est du code ; les nombres sont une
 * decision d'AGEROUTE.
 *
 * LE PROBLEME CENTRAL N'EST PAS LA PONDERATION, C'EST L'ABSENCE DE DONNEES
 *
 * Mesure du 13/10/2026 sur la production : `traficMoyenJma` est renseigne sur ZERO des
 * 1 690 troncons anterieurs a la promotion de la voirie. Le TRAFIC, un dixieme du modele,
 * porterait donc sur du vide, et les autres composantes sont inegalement couvertes —
 * l'etat n'est connu que sur une partie du reseau.
 *
 * (`criticiteStrategique` est vide aussi, mais ce n'est pas une composante du §13 : c'est
 * un facteur du Risk Engine. Les compter ensemble donnerait au RCI un trou qu'il n'a pas.)
 *
 * La couverture partielle est donc le cas NORMAL, pas l'exception. Trois reponses etaient
 * possibles, et deux sont des mensonges :
 *
 *   - Compter une composante absente comme ZERO. Un troncon sans donnee de trafic
 *     paraitrait en mauvais etat, et le score chuterait pour une raison qui n'a rien a
 *     voir avec la route.
 *
 *   - Compter une composante absente comme MOYENNE. Pire, parce qu'invisible : le score
 *     serait plausible, personne ne le mettrait en doute, et il reposerait sur une valeur
 *     inventee.
 *
 *   - RENORMALISER sur les composantes disponibles, et dire laquelle manque et pourquoi.
 *     Retenu. Le score porte alors sur une part declaree du modele, et cette part est
 *     elle-meme une information : « 6 composantes sur 8, 80 % du poids ».
 *
 * ET IL EXISTE UN PLANCHER
 *
 * Renormaliser sur 30 % du modele produirait un nombre entre 0 et 100 qui ne dit presque
 * rien. Sous un seuil de couverture, le moteur REFUSE de scorer. Ce seuil est un parametre
 * de la regle, pas une constante : c'est AGEROUTE qui dit a partir de quelle part du
 * modele un score merite d'etre regarde.
 *
 * UNE COMPOSANTE PERIMEE N'EST PAS UNE COMPOSANTE ABSENTE
 *
 * Un etat releve il y a dix ans et un etat jamais releve sont deux problemes differents :
 * le premier demande une reinspection, le second un inventaire. Les deux sortent du calcul,
 * mais avec un motif distinct — sans quoi on ne saurait pas quoi aller chercher.
 *
 * SENS DU SCORE
 *
 * 100 est le meilleur etat, 0 le pire. Le cahier ne le precise pas ; le choix est porte par
 * la regle (`sensCroissant`) pour qu'il ne puisse pas se perdre dans une relecture.
 */

/** Les huit composantes du paragraphe 13, dans son ordre. */
export type ComposanteRci =
  | "CHAUSSEE"
  | "DRAINAGE"
  | "OUVRAGES"
  | "SIGNALISATION"
  | "SECURITE"
  | "TRAFIC"
  | "HISTORIQUE"
  | "INCIDENTS";

export const COMPOSANTES_RCI: readonly ComposanteRci[] = [
  "CHAUSSEE", "DRAINAGE", "OUVRAGES", "SIGNALISATION",
  "SECURITE", "TRAFIC", "HISTORIQUE", "INCIDENTS",
];

/** Pourquoi une composante ne participe pas au score. */
export type MotifExclusion =
  /** Aucune valeur n'existe : c'est un probleme d'inventaire. */
  | "ABSENTE"
  /** Une valeur existe mais elle est trop ancienne : c'est un probleme de reinspection. */
  | "PERIMEE"
  /** Une valeur existe, datee, mais sa provenance est trop incertaine. */
  | "CONFIANCE_INSUFFISANTE"
  /** La regle n'accorde aucun poids a cette composante. */
  | "POIDS_NUL";

export interface EntreeComposante {
  composante: ComposanteRci;
  /**
   * Valeur deja normalisee entre 0 et 100 par l'appelant, qui connait la semantique de
   * chaque source. Le moteur ne devine pas comment un etat BON devient un nombre : cette
   * correspondance est elle aussi une decision, portee par la regle.
   */
  valeur: number | null;
  /** Date du CONSTAT, pas de la saisie. Nulle quand elle est inconnue. */
  observeeLe: Date | null;
  /** Confiance de la source, selon le vocabulaire deja utilise par `valeurs_qualite`. */
  confiance: "HIGH" | "MEDIUM" | "LOW" | null;
  /** D'ou vient la valeur, conserve tel quel pour l'explication. */
  source: string | null;
}

export interface RegleRci {
  /** Identifiant lisible de la version, inscrit dans chaque score. */
  version: string;
  /** Poids par composante. Leur somme n'a pas besoin de valoir 1 : on renormalise. */
  poids: Partial<Record<ComposanteRci, number>>;
  /** Age maximal d'un constat, en jours. Au-dela la composante est PERIMEE. */
  fraicheurMaxJours: number;
  /** Confiances acceptees. Une confiance absente est traitee comme insuffisante. */
  confiancesAcceptees: readonly ("HIGH" | "MEDIUM" | "LOW")[];
  /**
   * Part minimale du poids total qui doit etre couverte pour qu'un score soit rendu,
   * entre 0 et 1. En dessous, le moteur refuse.
   */
  couvertureMinimale: number;
  /** `true` si 100 est le meilleur etat. Explicite pour ne pas se perdre en relecture. */
  sensCroissant: boolean;
  /** `false` tant qu'AGEROUTE n'a pas approuve cette version. */
  approuvee: boolean;
}

export interface ComposanteCalculee {
  composante: ComposanteRci;
  /** Null quand la composante est exclue. */
  valeur: number | null;
  /** Poids declare par la regle. */
  poidsDeclare: number;
  /** Poids EFFECTIF apres renormalisation. Nul pour une composante exclue. */
  poidsEffectif: number;
  /** Contribution au score final. */
  contribution: number;
  exclue: MotifExclusion | null;
  source: string | null;
  observeeLe: Date | null;
}

export type RefusRci =
  | "COUVERTURE_INSUFFISANTE"
  | "AUCUN_POIDS_DECLARE";

export type ResultatRci =
  | {
      score: number;
      /** Part du poids total effectivement couverte, entre 0 et 1. */
      couverture: number;
      /** Confiance du score, deduite de la couverture et des confiances des sources. */
      confiance: "HIGH" | "MEDIUM" | "LOW";
      /**
       * `false` quand la regle n'est pas approuvee : le score se calcule, s'affiche en
       * interne, et NE SE PUBLIE PAS.
       */
      publiable: boolean;
      composantes: ComposanteCalculee[];
      explication: string;
    }
  | {
      score: null;
      motif: RefusRci;
      couverture: number;
      composantes: ComposanteCalculee[];
      explication: string;
    };

const JOUR_MS = 24 * 60 * 60 * 1000;

/** Une valeur doit etre un nombre fini dans l'intervalle du score. */
function valeurUtilisable(v: number | null): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;
}

function arrondir(v: number, decimales = 1): number {
  const f = 10 ** decimales;
  return Math.round(v * f) / f;
}

/**
 * Pourquoi cette composante est exclue, ou `null` si elle participe.
 *
 * L'ORDRE DES MOTIFS COMPTE
 *
 * Un poids nul passe en premier : une composante que la regle ignore n'a pas a etre
 * reprochee comme absente, et demander une inspection pour elle serait du travail inutile.
 *
 * Vient ensuite l'absence, puis la peremption, puis la confiance — du plus grossier au plus
 * fin, parce que le motif rendu dit ce qu'il faut aller chercher.
 */
export function motifExclusion(
  e: EntreeComposante,
  regle: RegleRci,
  maintenant: Date,
): MotifExclusion | null {
  const poids = regle.poids[e.composante] ?? 0;
  if (poids <= 0) return "POIDS_NUL";
  if (!valeurUtilisable(e.valeur)) return "ABSENTE";
  // Une valeur sans date ne se compare a rien : elle est traitee comme perimee, parce
  // qu'on ne peut pas affirmer qu'elle est fraiche.
  if (e.observeeLe === null) return "PERIMEE";
  if (maintenant.getTime() - e.observeeLe.getTime() > regle.fraicheurMaxJours * JOUR_MS) {
    return "PERIMEE";
  }
  if (e.confiance === null || !regle.confiancesAcceptees.includes(e.confiance)) {
    return "CONFIANCE_INSUFFISANTE";
  }
  return null;
}

/**
 * Confiance du score.
 *
 * Elle depend de la COUVERTURE autant que des sources : un score parfait sur un tiers du
 * modele n'est pas un score de confiance haute. Et une seule source LOW suffit a retirer
 * la confiance haute — c'est le maillon faible qui compte, pas la moyenne.
 */
export function confianceDuScore(
  couverture: number,
  confiancesRetenues: readonly ("HIGH" | "MEDIUM" | "LOW")[],
): "HIGH" | "MEDIUM" | "LOW" {
  if (confiancesRetenues.length === 0) return "LOW";
  const pire = confiancesRetenues.includes("LOW")
    ? "LOW"
    : confiancesRetenues.includes("MEDIUM") ? "MEDIUM" : "HIGH";
  if (couverture < 0.6) return "LOW";
  if (couverture < 0.85) return pire === "HIGH" ? "MEDIUM" : pire;
  return pire;
}

/**
 * Calcule le RCI d'un troncon, ou refuse de le calculer.
 *
 * Fonction PURE : elle ne lit rien, n'ecrit rien, et se rejoue a l'identique. C'est ce qui
 * permet d'expliquer un score rendu il y a deux ans, a condition d'avoir conserve ses
 * entrees — ce que l'instantane des sources prevoit.
 */
export function calculerRci(
  entrees: readonly EntreeComposante[],
  regle: RegleRci,
  maintenant: Date = new Date(),
): ResultatRci {
  const parComposante = new Map(entrees.map((e) => [e.composante, e]));

  const poidsTotalDeclare = COMPOSANTES_RCI.reduce(
    (s, c) => s + Math.max(0, regle.poids[c] ?? 0),
    0,
  );

  const examinees = COMPOSANTES_RCI.map((composante) => {
    const e = parComposante.get(composante) ?? {
      composante, valeur: null, observeeLe: null, confiance: null, source: null,
    };
    const poidsDeclare = Math.max(0, regle.poids[composante] ?? 0);
    const exclue = motifExclusion(e, regle, maintenant);
    return { e, poidsDeclare, exclue };
  });

  const retenues = examinees.filter((x) => x.exclue === null);
  const poidsRetenu = retenues.reduce((s, x) => s + x.poidsDeclare, 0);
  const couverture = poidsTotalDeclare > 0 ? poidsRetenu / poidsTotalDeclare : 0;

  const composantes: ComposanteCalculee[] = examinees.map((x) => ({
    composante: x.e.composante,
    valeur: x.exclue === null ? (x.e.valeur as number) : null,
    poidsDeclare: x.poidsDeclare,
    // RENORMALISATION : le poids effectif se rapporte au poids RETENU, pas au declare.
    poidsEffectif: x.exclue === null && poidsRetenu > 0 ? x.poidsDeclare / poidsRetenu : 0,
    contribution: x.exclue === null && poidsRetenu > 0
      ? arrondir(((x.e.valeur as number) * x.poidsDeclare) / poidsRetenu, 2)
      : 0,
    exclue: x.exclue,
    source: x.e.source,
    observeeLe: x.e.observeeLe,
  }));

  const manquantes = composantes.filter((c) => c.exclue !== null && c.exclue !== "POIDS_NUL");
  const resume = manquantes.length === 0
    ? "toutes les composantes pondérées sont disponibles"
    : manquantes.map((c) => `${c.composante} ${c.exclue}`).join(", ");

  if (poidsTotalDeclare <= 0) {
    return {
      score: null,
      motif: "AUCUN_POIDS_DECLARE",
      couverture: 0,
      composantes,
      explication: `Règle ${regle.version} : aucune composante pondérée, aucun score possible.`,
    };
  }

  if (couverture < regle.couvertureMinimale) {
    return {
      score: null,
      motif: "COUVERTURE_INSUFFISANTE",
      couverture: arrondir(couverture, 3),
      composantes,
      explication:
        `Règle ${regle.version} : ${Math.round(couverture * 100)} % du modèle couvert, `
        + `minimum ${Math.round(regle.couvertureMinimale * 100)} %. Manquant : ${resume}.`,
    };
  }

  const score = arrondir(composantes.reduce((s, c) => s + c.contribution, 0), 1);
  const confiance = confianceDuScore(
    couverture,
    retenues.map((x) => x.e.confiance as "HIGH" | "MEDIUM" | "LOW"),
  );

  return {
    score,
    couverture: arrondir(couverture, 3),
    confiance,
    // Le point qui empeche un chiffre non arbitre de devenir officiel.
    publiable: regle.approuvee,
    composantes,
    explication:
      `RCI ${score} / 100 selon la règle ${regle.version}`
      + `${regle.approuvee ? "" : " (NON APPROUVÉE — ne pas publier)"}, `
      + `sur ${retenues.length} composante(s) et ${Math.round(couverture * 100)} % du modèle. `
      + `Confiance ${confiance}. ${manquantes.length === 0 ? resume : `Manquant : ${resume}.`}`,
  };
}

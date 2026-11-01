/**
 * Map-matching de TRACE par modele de Markov cache (HMM).
 *
 * Paragraphe 7.3.7 du mandat V10, approche Newson & Krumm : « probabilite d'emission selon la
 * distance, probabilite de transition selon la coherence distance parcourue / distance sur le
 * reseau », execute sur le telephone depuis le pack de mission puis recalcule cote serveur.
 *
 * Critere A18 : « Trace 1 Hz complete sur 2 h sans reseau, rattachee par HMM (>= 97 % des
 * points sur le bon troncon sur le jeu de test) ». Cible de performance du paragraphe 7.3 :
 * une trace d'une heure, 3 600 points, en moins de 5 s sur le telephone.
 *
 * IMPORTS : uniquement `./appariement.noyau`, qui n'importe rien. Le paragraphe 15 fige le
 * map-matching comme « bibliotheque TypeScript maison partagee [...] memes tests serveur et
 * mobile » : ce fichier doit donc tourner dans la coque Capacitor sans modification. Le test
 * de garde le verifie.
 *
 * CE QUE LA TRACE APPORTE, ET QUE LE POINT A POINT NE PEUT PAS DONNER
 *
 * Le rattachement ponctuel (`decider`) regarde un point et ses voisins immediats. Il refuse
 * donc, a juste titre, un point dont la precision annoncee depasse 50 m : seul, un tel point
 * n'informe de rien.
 *
 * La trace, elle, dispose du PARCOURS. Si les points precedents et suivants sont fermement sur
 * la RN1 et que le vehicule roule a 60 km/h, le point degrade du milieu est sur la RN1 — ce
 * n'est pas une tolerance, c'est une deduction. C'est exactement ce que le paragraphe 7.3.7
 * attend : « il tranche les cas ambigus grace a la continuite du parcours ».
 *
 * Ce module rattache donc ces points, et les MARQUE (`precisionInsuffisante`). Il ne promeut
 * pas en silence un point a 80 m au rang de rattachement confirme : le paragraphe 7.3.6 exige
 * de conserver precision et score, et l'agent doit pouvoir distinguer les deux.
 *
 * TROIS CHOIX QUI ENGAGENT LES RESULTATS, ENONCES ICI PLUTOT QUE CACHES DANS LA FORMULE
 *
 * 1. ESPACE LOGARITHMIQUE, PAR NECESSITE ET NON PAR ELEGANCE. Une trace de 3 600 points
 *    multiplie 3 600 probabilites inferieures a 1. En flottant double, le produit atteint zero
 *    bien avant la fin : le Viterbi rendrait un chemin arbitraire, sans aucun signe d'erreur.
 *    Les logarithmes s'additionnent et ne debordent pas.
 *
 * 2. SIGMA VIENT DE L'APPAREIL, PAS D'UNE CONSTANTE. Newson & Krumm estiment un bruit GPS
 *    unique pour tout un jeu de donnees, faute de mieux a l'epoque. Un telephone moderne
 *    annonce sa precision A CHAQUE POINT, et cette information est meilleure : elle distingue
 *    le point pris en ville ouverte du point pris sous couvert forestier. Le sigma par defaut
 *    est donc la precision annoncee, bornee par `INCERTITUDE_MINIMALE_M`.
 *
 *    Je ne reprends aucune valeur numerique du papier : je ne l'ai pas sous les yeux, et le
 *    garde-fou du mandat interdit de presenter un seuil invente comme une norme.
 *
 * 3. UNE DISTANCE RESEAU INCONNUE NE VAUT PAS ZERO. Entre deux troncons differents, la
 *    distance sur le reseau demande un graphe que ce noyau n'a pas — il est injecte par
 *    `distanceReseauM`. Quand il manque, deux mauvaises reponses se presentent : traiter
 *    l'ecart comme nul, c'est-a-dire inventer une preuve favorable ; ou penaliser, c'est-a-dire
 *    inventer une preuve defavorable.
 *
 *    Le module reste NEUTRE et COMPTE. C'est le principe deja retenu ailleurs dans ce depot :
 *    `facteurCap` rend 1 quand le cap est inconnu, et le RCI renormalise au lieu de compter
 *    zero. Une mesure absente n'est pas une mesure nulle. Mais le resultat porte
 *    `transitionsNonVerifiees`, pour qu'un taux de 97 % ne puisse pas se lire sans savoir
 *    combien de transitions n'ont pas ete verifiees.
 */

import {
  type CandidatNoyau,
  type PositionNoyau,
  INCERTITUDE_MINIMALE_M,
  INCERTITUDE_PAR_DEFAUT_M,
  DISTANCE_MAX_PAR_DEFAUT_M,
  PRECISION_MAX_RATTACHEMENT_M,
} from "./appariement.noyau";

/** Rayon moyen de la Terre (WGS84, moyenne arithmetique des demi-axes). */
const RAYON_TERRE_M = 6371008.8;

/**
 * Echelle de l'ecart de distance, en metres, pour la probabilite de transition.
 *
 * C'EST UN CHOIX, PAS UNE MESURE, et il est provisoire — meme statut que
 * `PENALITE_DISCONTINUITE` dans le noyau ponctuel. Beta est la moyenne de la loi exponentielle
 * sur l'ecart entre distance parcourue et distance sur le reseau. A 1 Hz, cet ecart est domine
 * par le bruit GPS, donc beta doit etre du meme ordre que ce bruit.
 *
 * Il sera calibre sur le jeu de traces annotees, par la mediane des ecarts observes. La valeur
 * vit ici, nommee, plutot que noyee dans la formule.
 */
export const BETA_TRANSITION_PAR_DEFAUT_M = 10;

/** Un point de la trace, avec ses candidats deja calcules par la couche geospatiale. */
export interface PointTrace {
  horodatageMs: number;
  position: PositionNoyau;
  candidats: readonly CandidatNoyau[];
}

/** Une position appariee sur le reseau, telle que la fonction de distance la recoit. */
export interface PositionAppariee {
  tronconId: string;
  abscisseM: number;
}

/**
 * Distance SUR LE RESEAU entre deux positions appariees, en metres, ou `null` si elle n'est
 * pas calculable — graphe absent, troncons non connexes, pack de mission incomplet.
 *
 * `null` est une reponse legitime et attendue, pas une erreur : voir le choix 3 de l'en-tete.
 */
export type DistanceReseau = (
  depuis: PositionAppariee,
  vers: PositionAppariee,
) => number | null;

export interface ParametresHmm {
  /** Voir `BETA_TRANSITION_PAR_DEFAUT_M`. */
  betaTransitionM?: number;
  /**
   * Bruit GPS impose, en metres, au lieu de la precision annoncee point par point. A n'utiliser
   * que pour reproduire un calcul a l'identique ou pour une trace sans precision annoncee.
   */
  sigmaFixeM?: number | null;
  /** Au-dela, un candidat est ecarte. Defaut : `DISTANCE_MAX_PAR_DEFAUT_M`. */
  distanceMaxM?: number;
  distanceReseauM?: DistanceReseau;
  /**
   * Vitesse au-dela de laquelle une transition est tenue pour impossible, en km/h.
   *
   * DESACTIVE PAR DEFAUT, volontairement. C'est un filtre utile — il ecarte les sauts
   * geometriquement absurdes — mais tout seuil non calibre deviendrait une norme inventee. Le
   * mecanisme est disponible ; sa valeur appartient a la calibration.
   *
   * IL NE S'APPLIQUE QUE LA OU LA DISTANCE RESEAU EST CONNUE, et il faut le savoir pour ne pas
   * le croire plus protecteur qu'il n'est : sans graphe, une transition entre deux troncons
   * differents reste acceptee quelle que soit la vitesse qu'elle impliquerait, puisque la
   * distance qui permettrait de la juger n'existe pas. Un test le verifie explicitement.
   */
  vitesseMaxKmH?: number;
}

export type MotifRupture = "AUCUN_CANDIDAT" | "TOUS_TROP_LOIN";

export interface PointApparie {
  index: number;
  horodatageMs: number;
  /** `null` quand le point rompt la chaine : aucun troncon ne l'explique. */
  tronconId: string | null;
  code: string | null;
  abscisseM: number | null;
  distanceM: number | null;
  /** Le point a ete rattache par la continuite du parcours, malgre sa precision. */
  precisionInsuffisante: boolean;
  rupture: MotifRupture | null;
  /** La transition depuis le point precedent n'a pas pu etre verifiee sur le reseau. */
  transitionNonVerifiee: boolean;
}

/**
 * Une suite de points qu'aucun troncon du referentiel n'explique.
 *
 * Le paragraphe 7.3.7 l'exige : le HMM « detecte les sorties du referentiel (route absente →
 * proposition de nouveau troncon) ». Ces suites sont le materiau de cette proposition ; elles
 * ne creent rien par elles-memes.
 */
export interface SegmentHorsReferentiel {
  indexDebut: number;
  indexFin: number;
  nombrePoints: number;
  /** Longueur parcourue entre le premier et le dernier point, somme des sauts successifs. */
  longueurM: number;
}

/** Passage sur un troncon : de quel point a quel point. */
export interface PassageTroncon {
  tronconId: string;
  code: string;
  indexDebut: number;
  indexFin: number;
  nombrePoints: number;
}

export interface ResultatTrace {
  points: PointApparie[];
  pointsRattaches: number;
  pointsTotal: number;
  /** Suites non expliquees, candidates a une proposition de nouveau troncon. */
  horsReferentiel: SegmentHorsReferentiel[];
  /** Voir le choix 3 de l'en-tete : a lire avec tout taux de reussite. */
  transitionsNonVerifiees: number;
  /** Nombre de sous-chaines Viterbi. 1 = trace continue. */
  chaines: number;
  /** Troncons traverses dans l'ordre : couverture parcourue, et annonce des changements. */
  passages: PassageTroncon[];
}

/**
 * Distance orthodromique entre deux positions, en metres (haversine).
 *
 * Calcul sur la sphere, pas sur l'ellipsoide : l'erreur est de l'ordre de 0,5 %, soit quelques
 * centimetres sur les quelques dizaines de metres qui separent deux points a 1 Hz. Le
 * paragraphe 7.1 impose `geography` ou l'UTM pour les longueurs PUBLIEES ; ici la distance ne
 * sort jamais du calcul de transition, ou cette erreur est deux ordres de grandeur sous le
 * bruit GPS.
 */
export function distanceHaversineM(a: PositionNoyau, b: PositionNoyau): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const lat1 = a.lat * rad;
  const lat2 = b.lat * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * RAYON_TERRE_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Logarithme de la probabilite d'emission : un point a `distanceM` d'un trace, avec un bruit
 * `sigmaM`, gaussienne centree sur le trace.
 *
 * La constante de normalisation est conservee bien qu'elle s'annule dans l'argmax — sigma ne
 * depend que du point, pas du candidat, donc elle est identique pour tous les etats d'un meme
 * instant. La garder rend la valeur comparable d'un point a l'autre, ce qui sert au diagnostic.
 */
export function logProbaEmission(distanceM: number, sigmaM: number): number {
  const s = Math.max(sigmaM, INCERTITUDE_MINIMALE_M);
  const z = distanceM / s;
  return -0.5 * z * z - Math.log(s * Math.sqrt(2 * Math.PI));
}

/**
 * Logarithme de la probabilite de transition : loi exponentielle sur l'ecart entre la distance
 * parcourue a vol d'oiseau et la distance sur le reseau.
 *
 * L'intuition de Newson & Krumm : si le GPS dit que l'on a avance de 18 m et que le reseau dit
 * que passer du candidat A au candidat B demande 400 m, l'appariement est faux. Un ecart nul
 * est le cas parfait ; la vraisemblance decroit exponentiellement.
 */
export function logProbaTransition(ecartM: number, betaM: number): number {
  const b = Math.max(betaM, 1e-9);
  return -Math.abs(ecartM) / b - Math.log(b);
}

function sigmaDuPoint(p: PointTrace, parametres: ParametresHmm): number {
  if (parametres.sigmaFixeM != null && Number.isFinite(parametres.sigmaFixeM)) {
    return Math.max(parametres.sigmaFixeM, INCERTITUDE_MINIMALE_M);
  }
  const annoncee = p.position.precisionM;
  const base =
    annoncee != null && Number.isFinite(annoncee) && annoncee > 0
      ? annoncee
      : INCERTITUDE_PAR_DEFAUT_M;
  return Math.max(base, INCERTITUDE_MINIMALE_M);
}

function abscisseDe(c: CandidatNoyau): number {
  return c.fraction * c.longueurM;
}

/** Etat du Viterbi : un candidat a un instant, avec son meilleur predecesseur. */
interface Etat {
  candidat: CandidatNoyau;
  score: number;
  precedent: number | null;
  transitionNonVerifiee: boolean;
}

/**
 * Apparie une trace entiere. Viterbi en espace logarithmique, avec rupture et reprise.
 *
 * LA RUPTURE N'EST PAS UN ECHEC. Quand aucun candidat n'explique un point, le mandat ne demande
 * pas de forcer un rattachement : il demande de DETECTER la sortie du referentiel. La chaine se
 * clot, la suite non expliquee est enregistree, et une nouvelle chaine demarre apres. Forcer
 * produirait une trace continue et fausse, c'est-a-dire credible — le pire des deux defauts.
 *
 * COUT : O(T x K^2), T points et K candidats par point. Pour 3 600 points a 5 candidats, environ
 * 90 000 evaluations de transition, dont chacune est quelques operations flottantes et au plus
 * un appel a `distanceReseauM`.
 */
export function apparierTrace(
  points: readonly PointTrace[],
  parametres: ParametresHmm = {},
): ResultatTrace {
  const beta = parametres.betaTransitionM ?? BETA_TRANSITION_PAR_DEFAUT_M;
  const distanceMax = parametres.distanceMaxM ?? DISTANCE_MAX_PAR_DEFAUT_M;
  const distanceReseau = parametres.distanceReseauM;
  const vitesseMax = parametres.vitesseMaxKmH;

  const resultats: PointApparie[] = [];
  const horsReferentiel: SegmentHorsReferentiel[] = [];
  let transitionsNonVerifiees = 0;
  let chaines = 0;

  // Chaine courante : la liste des couches d'etats, et l'index du premier point.
  let couches: Etat[][] = [];
  let indexPremier = 0;
  // Suite de points non expliques en cours d'accumulation.
  let ruptureDebut: number | null = null;

  const cloreRupture = (indexFin: number) => {
    if (ruptureDebut === null) return;
    let longueur = 0;
    for (let k = ruptureDebut + 1; k <= indexFin; k += 1) {
      longueur += distanceHaversineM(points[k - 1].position, points[k].position);
    }
    horsReferentiel.push({
      indexDebut: ruptureDebut,
      indexFin,
      nombrePoints: indexFin - ruptureDebut + 1,
      longueurM: Math.round(longueur * 10) / 10,
    });
    ruptureDebut = null;
  };

  /**
   * Remonte le meilleur chemin et emet les points de la chaine courante.
   *
   * ELLE PEUT RENDRE PLUSIEURS SEGMENTS, et c'est une correction. Un etat dont toutes les
   * transitions entrantes etaient impossibles porte `precedent = null` : il REDEMARRE la
   * chaine. Cet etat peut parfaitement etre le meilleur de sa couche, puisque son score est son
   * emission seule, non grevee d'une penalite de transition.
   *
   * La premiere version remontait d'un seul trait depuis la derniere couche et s'arretait au
   * premier `precedent` nul, laissant les couches anterieures NON EMISES — un tableau a trous,
   * donc un plantage sur le premier point manquant. Un test de garde-fou l'a revele.
   *
   * La remontee se fait donc par segments : a chaque rupture de chainage, le segment se clot et
   * un nouveau repart du meilleur etat de la couche precedente. Chaque segment compte pour une
   * chaine, ce qui est exactement son sens — une portion de trace que le parcours n'a pas pu
   * relier a la precedente.
   */
  const cloreChaine = () => {
    if (couches.length === 0) return;

    let fin = couches.length - 1;
    while (fin >= 0) {
      const derniere = couches[fin];
      let meilleur = 0;
      for (let i = 1; i < derniere.length; i += 1) {
        if (derniere[i].score > derniere[meilleur].score) meilleur = i;
      }

      // Remontee jusqu'a la rupture de chainage, en ordre inverse.
      const segment: Etat[] = [];
      let curseur: number | null = meilleur;
      let t = fin;
      while (t >= 0 && curseur !== null) {
        // Annotation necessaire : sans elle, TypeScript ne peut pas inferer `etat`, dont le
        // type depend de `curseur`, qui est reaffecte depuis `etat.precedent` (TS7022).
        const etat: Etat = couches[t][curseur];
        segment.push(etat);
        curseur = etat.precedent;
        t -= 1;
      }
      segment.reverse();

      const debut = fin - segment.length + 1;
      chaines += 1;

      for (let k = 0; k < segment.length; k += 1) {
        const etat = segment[k];
        const index = indexPremier + debut + k;
        const point = points[index];
        const sigma = sigmaDuPoint(point, parametres);
        if (etat.transitionNonVerifiee) transitionsNonVerifiees += 1;
        resultats.push({
          index,
          horodatageMs: point.horodatageMs,
          tronconId: etat.candidat.tronconId,
          code: etat.candidat.code,
          abscisseM: Math.round(abscisseDe(etat.candidat) * 100) / 100,
          distanceM: Math.round(etat.candidat.distanceM * 10) / 10,
          precisionInsuffisante: sigma > PRECISION_MAX_RATTACHEMENT_M,
          rupture: null,
          transitionNonVerifiee: etat.transitionNonVerifiee,
        });
      }

      fin = debut - 1;
    }
    couches = [];
  };

  for (let t = 0; t < points.length; t += 1) {
    const point = points[t];
    const retenus = point.candidats.filter((c) => c.distanceM <= distanceMax);

    if (retenus.length === 0) {
      // Le point sort du referentiel : la chaine en cours se clot ici.
      cloreChaine();
      const motif: MotifRupture =
        point.candidats.length === 0 ? "AUCUN_CANDIDAT" : "TOUS_TROP_LOIN";
      resultats.push({
        index: t,
        horodatageMs: point.horodatageMs,
        tronconId: null,
        code: null,
        abscisseM: null,
        distanceM: null,
        precisionInsuffisante: false,
        rupture: motif,
        transitionNonVerifiee: false,
      });
      if (ruptureDebut === null) ruptureDebut = t;
      continue;
    }

    cloreRupture(t - 1);

    const sigma = sigmaDuPoint(point, parametres);

    if (couches.length === 0) {
      indexPremier = t;
      couches.push(
        retenus.map((candidat) => ({
          candidat,
          score: logProbaEmission(candidat.distanceM, sigma),
          precedent: null,
          transitionNonVerifiee: false,
        })),
      );
      continue;
    }

    const precedente = couches[couches.length - 1];
    const pointPrecedent = points[t - 1];
    const dGps = distanceHaversineM(pointPrecedent.position, point.position);
    const dtS = Math.max(0, (point.horodatageMs - pointPrecedent.horodatageMs) / 1000);

    const couche: Etat[] = retenus.map((candidat) => {
      const emission = logProbaEmission(candidat.distanceM, sigma);
      const vers: PositionAppariee = {
        tronconId: candidat.tronconId,
        abscisseM: abscisseDe(candidat),
      };

      let meilleurScore = -Infinity;
      let meilleurIndex: number | null = null;
      let meilleurNonVerifiee = false;

      for (let i = 0; i < precedente.length; i += 1) {
        const source = precedente[i];
        const depuis: PositionAppariee = {
          tronconId: source.candidat.tronconId,
          abscisseM: abscisseDe(source.candidat),
        };

        let dReseau: number | null;
        if (depuis.tronconId === vers.tronconId) {
          // Meme troncon : la distance sur le reseau est l'ecart d'abscisse. Aucun graphe requis.
          dReseau = Math.abs(vers.abscisseM - depuis.abscisseM);
        } else {
          dReseau = distanceReseau ? distanceReseau(depuis, vers) : null;
        }

        const nonVerifiee = dReseau === null;
        // Mesure absente n'est pas mesure nulle : neutre et compte. Voir le choix 3.
        let logTransition = nonVerifiee ? logProbaTransition(0, beta) : logProbaTransition(dGps - (dReseau as number), beta);

        if (
          !nonVerifiee &&
          vitesseMax != null &&
          Number.isFinite(vitesseMax) &&
          dtS > 0 &&
          (dReseau as number) / dtS > (vitesseMax * 1000) / 3600
        ) {
          logTransition = -Infinity;
        }

        const score = source.score + logTransition;
        if (score > meilleurScore) {
          meilleurScore = score;
          meilleurIndex = i;
          meilleurNonVerifiee = nonVerifiee;
        }
      }

      // Toutes les transitions impossibles : on ne force pas, on repart. Le score devient
      // l'emission seule et le predecesseur est nul, ce qui coupe la chaine a cet endroit.
      if (meilleurIndex === null || !Number.isFinite(meilleurScore)) {
        return { candidat, score: emission, precedent: null, transitionNonVerifiee: false };
      }

      return {
        candidat,
        score: meilleurScore + emission,
        precedent: meilleurIndex,
        transitionNonVerifiee: meilleurNonVerifiee,
      };
    });

    couches.push(couche);
  }

  cloreChaine();
  cloreRupture(points.length - 1);

  resultats.sort((a, b) => a.index - b.index);

  const passages: PassageTroncon[] = [];
  for (const r of resultats) {
    if (r.tronconId === null || r.code === null) continue;
    const dernier = passages[passages.length - 1];
    if (dernier && dernier.tronconId === r.tronconId && dernier.indexFin === r.index - 1) {
      dernier.indexFin = r.index;
      dernier.nombrePoints += 1;
      continue;
    }
    passages.push({
      tronconId: r.tronconId,
      code: r.code,
      indexDebut: r.index,
      indexFin: r.index,
      nombrePoints: 1,
    });
  }

  return {
    points: resultats,
    pointsRattaches: resultats.filter((r) => r.tronconId !== null).length,
    pointsTotal: points.length,
    horsReferentiel,
    transitionsNonVerifiees,
    chaines,
    passages,
  };
}

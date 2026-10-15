/**
 * Jeu de TRACES annotees pour le critere A18 : « Trace 1 Hz complete sur 2 h sans reseau,
 * rattachee par HMM (>= 97 % des points sur le bon troncon sur le jeu de test) ».
 *
 * CE QUE CE JEU EST, ET CE QU'IL N'EST PAS
 *
 * Les positions et les distances sont DERIVEES D'UNE GEOMETRIE ENONCEE, point par point, et non
 * choisies a la main. Chaque scenario declare ou passent les routes, ou roule le vehicule et
 * quel decalage perpendiculaire le GPS ajoute ; les distances aux candidats en decoulent par le
 * calcul. On ne peut donc pas y glisser un chiffre qui arrange le resultat.
 *
 * Mais il reste SYNTHETIQUE, et cela borne ce qu'il prouve. Le bruit GPS y est periodique,
 * alors qu'un bruit reel est correle dans le temps et biaise par les multitrajets. Ce jeu
 * etablit que le HMM tranche correctement quand les distances sont justes ; il ne dit rien du
 * comportement sous bruit reel. La mesure sur trace reelle demande le pilote corridor (D12), et
 * le dire fait partie du resultat.
 *
 * Il ne couvre pas non plus la duree : le critere A18 parle de 2 h, soit 7 200 points. Les
 * scenarios ci-dessous en comptent 138. La duree est eprouvee separement, par le test de
 * performance et de stabilite numerique.
 */

import type { CandidatNoyau } from "./appariement.noyau";
import type { PointTrace, PositionAppariee } from "./appariement.trace";

/** Origine des scenarios : region de Conakry, pour que les conversions degre/metre soient justes. */
const LAT0 = 9.6412;
const LON0 = -13.5784;
/** A cette latitude. Un degre de latitude, et un degre de longitude. */
const M_PAR_DEG_LAT = 110574;
const M_PAR_DEG_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);

const LONGUEUR_TRONCON_M = 2000;

/** Position a `estM` metres a l'est et `nordM` metres au nord de l'origine. */
function position(estM: number, nordM: number, precisionM: number) {
  return {
    lat: LAT0 + nordM / M_PAR_DEG_LAT,
    lon: LON0 + estM / M_PAR_DEG_LON,
    precisionM,
    capDeg: null,
    vitesseKmH: 60,
  };
}

function candidat(
  tronconId: string,
  code: string,
  distanceM: number,
  abscisseM: number,
): CandidatNoyau {
  return {
    tronconId,
    code,
    nom: null,
    classe: code.startsWith("RN") ? "RN" : "RR",
    distanceM,
    fraction: Math.max(0, Math.min(1, abscisseM / LONGUEUR_TRONCON_M)),
    longueurM: LONGUEUR_TRONCON_M,
    pkDebut: 0,
    pkFin: LONGUEUR_TRONCON_M / 1000,
    capTronconDeg: null,
  };
}

export interface TraceAnnotee {
  nom: string;
  /** La situation du paragraphe 7.3.5 que ce scenario eprouve. */
  situation: string;
  points: PointTrace[];
  /** Troncon attendu point par point ; `null` = aucun rattachement attendu. */
  attendu: (string | null)[];
  /** Pourquoi le point a point echouerait, et ce que la trace apporte. */
  pourquoi: string;
}

/** Pas de 16,7 m : 60 km/h a 1 Hz. */
const PAS_M = 16.7;

/**
 * T1 — Deux routes parallelles a 25 m, le vehicule sur la RN1.
 *
 * Le decalage perpendiculaire du GPS oscille jusqu'a 18 m vers la contre-allee. A ces instants
 * le point est a 18 m de la RN1 mais a 7 m de la contre-allee : le rattachement ponctuel choisit
 * la contre-allee, et il a raison de le faire — seul, le point ne dit rien d'autre.
 */
function t1ParallelesProches(): TraceAnnotee {
  const n = 40;
  const points: PointTrace[] = [];
  const attendu: (string | null)[] = [];
  for (let i = 0; i < n; i += 1) {
    const est = i * PAS_M;
    // Oscillation de periode 8, amplitude 18 m, vers le nord ou se trouve la contre-allee.
    const decalage = 18 * Math.sin((i * Math.PI) / 4);
    const dRn1 = Math.abs(decalage);
    const dContreAllee = Math.abs(25 - decalage);
    points.push({
      horodatageMs: i * 1000,
      position: position(est, decalage, 15),
      candidats: [
        candidat("rn1", "RN1-T1", dRn1, est),
        candidat("ca1", "CA1-T1", dContreAllee, est),
      ].filter((c) => c.distanceM <= 50),
    });
    attendu.push("rn1");
  }
  return {
    nom: "T1 routes parallelles a 25 m",
    situation: "routes parallelles < 50 m",
    points,
    attendu,
    pourquoi:
      "Dix points sur quarante sont plus proches de la contre-allee que de la RN1. " +
      "Le point a point les rattache a la contre-allee. La trace tient la RN1 parce que " +
      "changer de troncon coute le detour reel par le carrefour.",
  };
}

/**
 * T2 — Carrefour : le vehicule tourne, et le changement de troncon est LEGITIME.
 *
 * C'est le cas symetrique de T1, et le piege de la continuite : un module qui penalise tout
 * changement collerait a la RN1 apres le virage et produirait une trace continue et fausse.
 */
function t2Carrefour(): TraceAnnotee {
  const avant = 20;
  const apres = 20;
  const points: PointTrace[] = [];
  const attendu: (string | null)[] = [];
  const estCarrefour = avant * PAS_M;

  for (let i = 0; i < avant; i += 1) {
    const est = i * PAS_M;
    const decalage = 3 * Math.sin((i * Math.PI) / 3);
    // La RR5 part du carrefour vers le nord : la distance a sa demi-droite est l'ecart en est.
    const dRr5 = estCarrefour - est;
    points.push({
      horodatageMs: i * 1000,
      position: position(est, decalage, 12),
      candidats: [
        candidat("rn1", "RN1-T2", Math.abs(decalage), est),
        candidat("rr5", "RR5-T2", dRr5, 0),
      ].filter((c) => c.distanceM <= 50),
    });
    attendu.push("rn1");
  }

  for (let i = 0; i < apres; i += 1) {
    const nord = (i + 1) * PAS_M;
    const decalage = 3 * Math.sin((i * Math.PI) / 3);
    points.push({
      horodatageMs: (avant + i) * 1000,
      position: position(estCarrefour + decalage, nord, 12),
      candidats: [
        // Apres le carrefour, le point le plus proche de la RN1 reste le carrefour lui-meme.
        candidat("rn1", "RN1-T2", nord, estCarrefour),
        candidat("rr5", "RR5-T2", Math.abs(decalage), nord),
      ].filter((c) => c.distanceM <= 50),
    });
    attendu.push("rr5");
  }

  return {
    nom: "T2 carrefour et virage legitime",
    situation: "intersections et carrefours",
    points,
    attendu,
    pourquoi:
      "Le changement de troncon est reel. Une penalite aveugle de discontinuite ferait " +
      "coller la trace a la RN1 apres le virage : fausse mais continue, donc credible.",
  };
}

/**
 * T3 — Route absente du referentiel.
 *
 * Huit points ne sont expliques par aucun troncon. Le paragraphe 7.3.7 demande de DETECTER la
 * sortie, pas de forcer un rattachement.
 */
function t3RouteAbsente(): TraceAnnotee {
  const points: PointTrace[] = [];
  const attendu: (string | null)[] = [];
  let t = 0;

  for (let i = 0; i < 10; i += 1, t += 1) {
    const est = i * PAS_M;
    points.push({
      horodatageMs: t * 1000,
      position: position(est, 2, 10),
      candidats: [candidat("rn1", "RN1-T3", 2, est)],
    });
    attendu.push("rn1");
  }

  // Huit points sur une piste absente du referentiel : elle s'ecarte vers le nord.
  for (let i = 0; i < 8; i += 1, t += 1) {
    const est = 10 * PAS_M + i * PAS_M * 0.7;
    const nord = 60 + i * PAS_M * 0.7;
    points.push({
      horodatageMs: t * 1000,
      position: position(est, nord, 10),
      candidats: [],
    });
    attendu.push(null);
  }

  for (let i = 0; i < 10; i += 1, t += 1) {
    const est = 20 * PAS_M + i * PAS_M;
    points.push({
      horodatageMs: t * 1000,
      position: position(est, 2, 10),
      candidats: [candidat("rn1", "RN1-T3", 2, est)],
    });
    attendu.push("rn1");
  }

  return {
    nom: "T3 route absente du referentiel",
    situation: "route absente du referentiel",
    points,
    attendu,
    pourquoi:
      "Forcer un rattachement fabriquerait une trace continue et fausse. La rupture est " +
      "le resultat attendu, et la suite non expliquee devient le materiau d'une proposition.",
  };
}

/**
 * T4 — Precision degradee sous couvert forestier.
 *
 * Dix points annoncent 70 m de precision, au-dela du plafond de 50 m du paragraphe 7.3.4 : le
 * rattachement ponctuel les refuse, a juste titre. La trace les franchit par continuite et les
 * marque.
 */
function t4PrecisionDegradee(): TraceAnnotee {
  const n = 30;
  const points: PointTrace[] = [];
  const attendu: (string | null)[] = [];
  for (let i = 0; i < n; i += 1) {
    const est = i * PAS_M;
    const degrade = i >= 10 && i < 20;
    const precision = degrade ? 70 : 12;
    const decalage = degrade ? 30 * Math.sin((i * Math.PI) / 5) : 3 * Math.sin((i * Math.PI) / 3);
    points.push({
      horodatageMs: i * 1000,
      position: position(est, decalage, precision),
      candidats: [candidat("rn1", "RN1-T4", Math.abs(decalage), est)].filter(
        (c) => c.distanceM <= 50,
      ),
    });
    attendu.push("rn1");
  }
  return {
    nom: "T4 precision degradee",
    situation: "precision degradee (foret, canyon urbain)",
    points,
    attendu,
    pourquoi:
      "Le point a point refuse ces points, et c'est la bonne reponse pour un point isole. " +
      "La trace les deduit du parcours et les marque `precisionInsuffisante`.",
  };
}

export const TRACES_ANNOTEES: TraceAnnotee[] = [
  t1ParallelesProches(),
  t2Carrefour(),
  t3RouteAbsente(),
  t4PrecisionDegradee(),
];

/**
 * Distance sur le reseau pour ces scenarios, injectee dans le HMM.
 *
 * ELLE EST LA PIECE DECISIVE, et c'est le principal enseignement de ce jeu. Sans graphe, le HMM
 * ne sait pas qu'une contre-allee parallele est a 800 m de detour : la transition devient neutre
 * et la decision retombe sur l'emission, donc sur la distance seule. Un test le mesure.
 *
 * Geometrie declaree : la contre-allee CA1 ne rejoint la RN1 qu'a un carrefour distant, d'ou
 * 800 m ; la RR5 part du carrefour de la RN1 a 334 m, d'ou une distance qui passe par lui.
 */
export function distanceReseauScenarios(
  depuis: PositionAppariee,
  vers: PositionAppariee,
): number | null {
  const paire = [depuis.tronconId, vers.tronconId].sort().join("|");

  if (paire === "ca1|rn1") {
    // Detour oblige par le carrefour le plus proche.
    return 800;
  }
  if (paire === "rn1|rr5") {
    const surRn1 = depuis.tronconId === "rn1" ? depuis : vers;
    const surRr5 = depuis.tronconId === "rr5" ? depuis : vers;
    const CARREFOUR_M = 20 * PAS_M;
    return Math.abs(CARREFOUR_M - surRn1.abscisseM) + surRr5.abscisseM;
  }
  return null;
}

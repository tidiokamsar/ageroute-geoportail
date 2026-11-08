/**
 * Noyau d'appariement GPS. AUCUN IMPORT : ni Prisma, ni Express, ni module Node.
 *
 * POURQUOI CE FICHIER EXISTE
 *
 * Le paragraphe 7.3 du mandat v2.1 exige l'algorithme « cote serveur ET embarque cote mobile
 * (hors ligne) ». `geo/appariement.ts` melangeait la decision et la requete : il importe
 * Prisma, donc importer `confiance()` entrainait Prisma avec elle. Le noyau etait
 * inextricable.
 *
 * Et c'est l'argument central de l'ADR-002 qui en dependait : « les regles sont deja
 * partageables, donc React Native coute peu ». C'etait vrai pour les portions, le metre et la
 * condition — pas pour l'appariement, qui est precisement la regle dont le mobile a le plus
 * besoin.
 *
 * Un test verifie l'absence d'import. Une dependance ajoutee un jour par commodite casserait
 * le portage sans que rien ne le signale.
 *
 * LES CINQ FACTEURS DU PARAGRAPHE 7.3.3
 *
 *   distance normalisee                                 deja la
 *   precision GPS                                       deja la, incluse dans l'ecart
 *   ecart avec le 2e candidat                           deja la
 *   ecart cap de deplacement / orientation du troncon   AJOUTE ici
 *   continuite avec le troncon precedemment confirme    AJOUTE ici
 *
 * Mesure du 14/10/2026 : `heading` comptait zero occurrence dans le depot.
 *
 * LES FACTEURS SE MULTIPLIENT, ET CE N'EST PAS UN DETAIL
 *
 * Ils doivent TOUS tenir. Un point a un metre d'un trace, mais traverse perpendiculairement,
 * n'est pas sur ce trace : il le franchit. Une somme ponderee laisserait la proximite
 * compenser l'incoherence de cap, et rendrait une confiance elevee pour un rattachement faux.
 * La multiplication interdit cette compensation.
 */

/** Position brute, telle que l'appareil la rend. */
export interface PositionNoyau {
  lat: number;
  lon: number;
  /** Incertitude annoncee, en metres. */
  precisionM?: number | null;
  /** Cap de deplacement en degres, 0 = nord. Nul a l'arret ou si l'appareil se taait. */
  capDeg?: number | null;
  /** Vitesse instantanee, en km/h. Sert a savoir si le cap veut dire quelque chose. */
  vitesseKmH?: number | null;
}

/** Un troncon candidat, tel que la couche geospatiale le rend. */
export interface CandidatNoyau {
  tronconId: string;
  code: string;
  nom: string | null;
  classe: string;
  /** Distance du point au trace, en metres. */
  distanceM: number;
  /** Position le long du trace, de 0 a 1. */
  fraction: number;
  longueurM: number;
  pkDebut: number | null;
  pkFin: number | null;
  /**
   * Orientation LOCALE du trace au point le plus proche, en degres. Nulle quand la couche
   * geospatiale ne la fournit pas — le noyau reste alors neutre plutot que de deviner.
   */
  capTronconDeg: number | null;
}

export interface ContexteAppariement {
  incertitudeM: number;
  capDeg: number | null;
  vitesseKmH: number | null;
  /** Troncon confirme au point precedent, pour la continuite du parcours. */
  tronconPrecedentId: string | null;
  distanceMaxM?: number;
}

/** Incertitude retenue quand l'appareil n'en annonce pas. Voir `appariement.ts`. */
export const INCERTITUDE_PAR_DEFAUT_M = 15;
/** Plancher : aucun GPS grand public ne fait mieux, et diviser par zero n'a pas de sens. */
export const INCERTITUDE_MINIMALE_M = 3;
/** Au-dela, le point n'est sur aucune route connue. */
export const DISTANCE_MAX_PAR_DEFAUT_M = 50;
/** En deca, le moteur se tait. */
export const CONFIANCE_MINIMALE = 0.35;

/** Seuil haut du paragraphe 7.3.4 : au-dela, confirmation en un geste. */
export const SEUIL_PRESELECTION = 0.85;
/** Et l'ecart minimal avec le 2e candidat qu'exige la meme regle. */
export const SEPARATION_PRESELECTION = 0.2;
/**
 * Au-dela, aucun rattachement (paragraphe 7.3.4).
 *
 * Une position a 80 m d'incertitude ne rattache rien, meme si un trace passe a un metre : ce
 * metre est illusoire, et le rattachement serait une coincidence presentee comme une mesure.
 */
export const PRECISION_MAX_RATTACHEMENT_M = 50;
/**
 * Sous cette vitesse, le cap est ignore.
 *
 * Un GPS immobile rend un cap aleatoire : le prendre en compte penaliserait au hasard. Trois
 * km/h est la vitesse de marche lente, en deca de laquelle aucun cap n'est exploitable.
 */
export const VITESSE_CAP_MINIMALE_KMH = 3;
/**
 * Penalite appliquee a un candidat qui n'est pas le troncon precedemment confirme, QUAND
 * celui-ci est encore a portee.
 *
 * 0,75 est un choix, pas une mesure : il doit suffire a departager deux traces voisins sans
 * empecher un changement de troncon franc. Il sera recalibre quand le jeu de points annotes
 * couvrira des carrefours reels. La valeur vit ici, nommee, plutot que noyee dans la formule.
 */
export const PENALITE_DISCONTINUITE = 0.75;

function borner(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Facteur de cap : le deplacement est-il coherent avec l'orientation du troncon ?
 *
 * UNE ROUTE SE PARCOURT DANS LES DEUX SENS, et c'est le piege de ce facteur. Un cap oppose de
 * 180 degres est parfaitement coherent : l'agent descend le troncon au lieu de le monter.
 * C'est pourquoi la formule prend la VALEUR ABSOLUE du cosinus — 0 et 180 degres valent tous
 * deux 1, 90 degres vaut 0.
 *
 * Rend 1, donc neutre, quand le cap est inconnu, quand le troncon n'a pas d'orientation
 * locale, ou a l'arret. Neutre et non penalisant : une information absente ne doit pas
 * degrader un appariement par ailleurs bon, comme une composante absente du RCI ne vaut pas
 * zero.
 */
export function facteurCap(
  capDeg: number | null,
  capTronconDeg: number | null,
  vitesseKmH: number | null,
): number {
  if (capDeg === null || capTronconDeg === null) return 1;
  if (!Number.isFinite(capDeg) || !Number.isFinite(capTronconDeg)) return 1;
  if (vitesseKmH === null || !Number.isFinite(vitesseKmH)) return 1;
  if (vitesseKmH < VITESSE_CAP_MINIMALE_KMH) return 1;

  const ecartDeg = capDeg - capTronconDeg;
  const radians = (ecartDeg * Math.PI) / 180;
  // Valeur absolue : le contresens est coherent avec le trace.
  //
  // ARRONDI NECESSAIRE : Math.cos(PI/2) rend 6,12e-17 et non zero. Un facteur de 6e-17 est
  // numeriquement inoffensif, mais il rend « s'annule pour un deplacement perpendiculaire »
  // faux a la lettre, et un seuil compare a zero cesserait d'etre franc.
  return Math.round(borner(Math.abs(Math.cos(radians))) * 10000) / 10000;
}

/**
 * Facteur de continuite : rester sur le troncon deja confirme.
 *
 * LA REGLE N'EST PAS « PENALISER TOUT CHANGEMENT », et c'est la difficulte.
 *
 * Sur une route droite, un trace voisin est souvent aussi proche que le bon : sans continuite,
 * l'appariement saute d'un troncon a l'autre a chaque point. Mais au carrefour, l'agent change
 * LEGITIMEMENT de troncon, et penaliser alors ferait coller l'appariement a une route qu'on a
 * quittee — le defaut inverse, et le pire des deux, puisqu'il produit une trace fausse mais
 * continue, donc credible.
 *
 * La penalite ne s'applique donc QUE si le troncon precedent est encore un candidat a portee
 * de l'incertitude. S'il s'est eloigne, on a vraiment quitte : aucune penalite.
 */
export function facteurContinuite(
  candidat: CandidatNoyau,
  tous: readonly CandidatNoyau[],
  tronconPrecedentId: string | null,
  incertitudeM: number,
): number {
  if (tronconPrecedentId === null) return 1;
  if (candidat.tronconId === tronconPrecedentId) return 1;

  const precedent = tous.find((x) => x.tronconId === tronconPrecedentId);
  if (!precedent) return 1;
  // Encore a portee ? Alors le quitter demande une raison, et la proximite n'en est pas une.
  if (precedent.distanceM > Math.max(incertitudeM, INCERTITUDE_MINIMALE_M)) return 1;

  return PENALITE_DISCONTINUITE;
}

/**
 * QUALITE INTRINSEQUE d'un candidat : est-il bon, independamment de ses concurrents ?
 *
 * Trois facteurs : l'ecart au trace, le cap, la continuite.
 *
 * L'ECART AU TRACE. Un point a moins d'une incertitude du trace est coherent avec lui ; a
 * trois incertitudes, il ne l'est plus. Decroissance lineaire entre les deux.
 *
 * POURQUOI LA SEPARATION N'EST PAS ICI, ET C'EST UNE CORRECTION
 *
 * La premiere version de ce module incluait la separation dans le score de chaque candidat.
 * Un test l'a mise en defaut : la separation d'un candidat qui n'est pas le plus proche est
 * NEGATIVE, donc bornee a zero, donc tout candidat autre que le premier avait une confiance
 * nulle. Le classement redevenait purement distanciel, et la continuite ne pouvait JAMAIS
 * remonter un candidat — ce qui etait precisement sa raison d'etre.
 *
 * La separation repond a « suis-je le meilleur », pas a « suis-je bon ». Elle appartient donc
 * a la DECISION, entre les deux premiers, et non au classement.
 */
export function qualiteCandidat(
  candidat: CandidatNoyau,
  tous: readonly CandidatNoyau[],
  contexte: ContexteAppariement,
): number {
  const u = Math.max(contexte.incertitudeM, INCERTITUDE_MINIMALE_M);
  const ecart = borner(1 - (candidat.distanceM - u) / (2 * u));
  const cap = facteurCap(contexte.capDeg, candidat.capTronconDeg, contexte.vitesseKmH);
  const continuite = facteurContinuite(candidat, tous, contexte.tronconPrecedentId, u);
  return Math.round(ecart * cap * continuite * 10000) / 10000;
}

/**
 * Separation entre un candidat et son concurrent le plus proche, de 0 a 1.
 *
 * Si le deuxieme candidat est a la meme distance, choisir le premier revient a tirer a pile ou
 * face : la separation vaut 0. C'est le facteur qui manque aux implementations naives, et
 * celui que le cas urbain reclame — le trace etait proche, mais celui d'a cote aussi.
 */
export function separationDe(
  candidat: CandidatNoyau,
  tous: readonly CandidatNoyau[],
  incertitudeM: number,
): number {
  const u = Math.max(incertitudeM, INCERTITUDE_MINIMALE_M);
  const concurrents = tous.filter((x) => x.tronconId !== candidat.tronconId);
  if (concurrents.length === 0) return 1;
  const plusProche = Math.min(...concurrents.map((x) => x.distanceM));
  return borner((plusProche - candidat.distanceM) / u);
}

/**
 * Confiance FINALE d'un candidat retenu : sa qualite, moderee par sa separation.
 *
 * C'est le nombre qui s'affiche a l'agent et qui se compare aux seuils. Il garde exactement le
 * sens de l'ancien `confiance()` a deux facteurs, dont il est une generalisation : cap et
 * continuite neutres valent 1.
 */
export function confianceComplete(
  candidat: CandidatNoyau,
  tous: readonly CandidatNoyau[],
  contexte: ContexteAppariement,
): number {
  const q = qualiteCandidat(candidat, tous, contexte);
  const s = separationDe(candidat, tous, contexte.incertitudeM);
  return Math.round(q * s * 100) / 100;
}

export interface CandidatScore {
  candidat: CandidatNoyau;
  /** Qualite intrinseque : c'est elle qui CLASSE. */
  qualite: number;
  /** Confiance finale, qualite moderee par la separation : c'est elle qui DECIDE. */
  confiance: number;
}

/**
 * Les candidats avec leurs deux scores, du meilleur au pire.
 *
 * LE CLASSEMENT SE FAIT SUR LA QUALITE, pas sur la confiance finale : voir
 * `qualiteCandidat`. Tri stable sur la distance a egalite de qualite.
 */
export function scorer(
  candidats: readonly CandidatNoyau[],
  contexte: ContexteAppariement,
): CandidatScore[] {
  return candidats
    .map((candidat) => ({
      candidat,
      qualite: qualiteCandidat(candidat, candidats, contexte),
      confiance: confianceComplete(candidat, candidats, contexte),
    }))
    .sort((a, b) => b.qualite - a.qualite || a.candidat.distanceM - b.candidat.distanceM);
}

/**
 * PK d'un point le long d'un troncon, ou `null` avec son motif.
 *
 * On ne substitue PAS un kilometrage geometrique : il repondrait a une autre question, et un
 * PK derive presente comme un PK officiel est une valeur inventee (paragraphe 7.2).
 */
export function pkDeFraction(
  fraction: number,
  pkDebut: number | null,
  pkFin: number | null,
): { pk: number | null; motif: "CALCULE" | "TRONCON_SANS_PK" } {
  if (pkDebut == null || pkFin == null || pkFin <= pkDebut) {
    return { pk: null, motif: "TRONCON_SANS_PK" };
  }
  const pk = pkDebut + borner(fraction) * (pkFin - pkDebut);
  return { pk: Math.round(pk * 1000) / 1000, motif: "CALCULE" };
}

export interface AppariementNoyau {
  tronconId: string;
  code: string;
  nom: string | null;
  classe: string;
  distanceM: number;
  abscisseM: number;
  pk: number | null;
  pkMotif: "CALCULE" | "TRONCON_SANS_PK";
  confiance: number;
  ambigu: boolean;
}

export type MotifNonRattache =
  | "AUCUN_CANDIDAT"
  | "TROP_LOIN"
  | "PRECISION_INSUFFISANTE"
  | "CONFIANCE_INSUFFISANTE";

/**
 * Les trois issues du paragraphe 7.3.4.
 *
 * Le code n'en avait que deux : rattacher, ou rendre `null`. Or la regle en demande trois, et
 * la troisieme est celle qui compte pour un agent — une liste de candidats a trancher, au lieu
 * d'un refus qui l'oblige a ressaisir.
 *
 * Chaque issue porte les CANDIDATS EXAMINES, meme le refus. Le paragraphe 7.3.6 exige de
 * conserver « le score, le candidat retenu, l'auteur du choix » : un refus muet empecherait un
 * rattachement ulterieur au bureau, alors que la position brute, elle, est conservee.
 */
export type Decision =
  | { issue: "PRESELECTION"; appariement: AppariementNoyau; candidats: CandidatScore[] }
  | { issue: "CHOIX_AGENT"; candidats: CandidatScore[] }
  | { issue: "NON_RATTACHE"; motif: MotifNonRattache; candidats: CandidatScore[] };

function versAppariement(s: CandidatScore): AppariementNoyau {
  const { candidat, confiance } = s;
  const { pk, motif } = pkDeFraction(candidat.fraction, candidat.pkDebut, candidat.pkFin);
  return {
    tronconId: candidat.tronconId,
    code: candidat.code,
    nom: candidat.nom,
    classe: candidat.classe,
    distanceM: Math.round(candidat.distanceM * 10) / 10,
    abscisseM: Math.round(candidat.fraction * candidat.longueurM * 100) / 100,
    pk,
    pkMotif: motif,
    confiance,
    ambigu: false,
  };
}

/**
 * Decide, ou ne decide pas, et dit toujours pourquoi.
 *
 * L'ORDRE DES REFUS EST VOLONTAIRE. La precision est examinee AVANT la distance : une position
 * a 80 m d'incertitude ne rattache rien meme si un trace passe a un metre, et dire « trop
 * loin » dans ce cas serait un diagnostic faux. Le motif rendu doit designer la vraie cause,
 * sinon il envoie l'agent corriger ce qui n'est pas en faute.
 */
export function decider(
  candidats: readonly CandidatNoyau[],
  contexte: ContexteAppariement,
): Decision {
  const classe = scorer(candidats, contexte);

  if (classe.length === 0) {
    return { issue: "NON_RATTACHE", motif: "AUCUN_CANDIDAT", candidats: [] };
  }

  if (contexte.incertitudeM > PRECISION_MAX_RATTACHEMENT_M) {
    return { issue: "NON_RATTACHE", motif: "PRECISION_INSUFFISANTE", candidats: classe };
  }

  const distanceMax = contexte.distanceMaxM ?? DISTANCE_MAX_PAR_DEFAUT_M;
  const plusProche = Math.min(...classe.map((x) => x.candidat.distanceM));
  if (plusProche > distanceMax) {
    return { issue: "NON_RATTACHE", motif: "TROP_LOIN", candidats: classe };
  }

  const premier = classe[0];
  if (premier.confiance < CONFIANCE_MINIMALE) {
    return { issue: "NON_RATTACHE", motif: "CONFIANCE_INSUFFISANTE", candidats: classe };
  }

  const second = classe[1];
  // « ecart avec le 2e candidat >= 0,2 » (paragraphe 7.3.4), mesure sur la QUALITE.
  //
  // Le mesurer sur la confiance finale serait degenere : la confiance d'un candidat qui
  // n'est pas le plus proche est presque toujours nulle, donc l'ecart serait presque
  // toujours suffisant — et la seconde condition du mandat ne filtrerait plus rien.
  const separationSuffisante = second === undefined
    || premier.qualite - second.qualite >= SEPARATION_PRESELECTION;

  // LES DEUX CONDITIONS, comme l'exige le paragraphe 7.3.4. Un score haut avec un concurrent
  // colle ne se confirme pas en un geste : c'est le cas urbain, celui qui produit les faux
  // rattachements les plus credibles.
  if (premier.confiance >= SEUIL_PRESELECTION && separationSuffisante) {
    return {
      issue: "PRESELECTION",
      appariement: versAppariement(premier),
      candidats: classe,
    };
  }

  return { issue: "CHOIX_AGENT", candidats: classe };
}

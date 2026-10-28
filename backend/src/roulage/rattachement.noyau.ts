/**
 * Placement dans le temps et sur le reseau des marqueurs et des evenements lineaires d'une session de
 * roulage. NOYAU PUR : aucun import, aucune base. Il decide QUEL TRONCON et QUELLES PORTIONS ; les
 * abscisses exactes des extremites sont ensuite calculees en SQL (projection sur le troncon retenu),
 * le noyau n'ayant pas la geometrie.
 *
 * LE PRINCIPE
 *
 * La trace a ete rattachee au reseau par le HMM (`geo/appariement.trace.ts`), qui tranche les cas
 * ambigus par la continuite du parcours. Un marqueur ou un evenement ne reinvente pas ce rattachement :
 * il HERITE du troncon du point rattache le plus proche DANS LE TEMPS. La position, elle, vient de la
 * trace brute interpolee a l'instant voulu : le dernier fix connu de l'appareil peut etre perime
 * (vitesse x anciennete), la trace, elle, contient aussi les echantillons qui SUIVENT le geste.
 *
 * LES FENETRES (provisoires, non calibrees)
 *
 * `FENETRE_RATTACHEMENT_MS` borne l'ecart entre l'instant demande et le point rattache le plus
 * proche. Au-dela, on ne conclut pas : l'evenement est NON_RATTACHE avec son motif. Cette valeur n'est
 * pas mesuree sur des traces reelles.
 */

/** Ecart temporel maximal, en ms, entre un instant et le point rattache dont il herite son troncon. PROVISOIRE. */
export const FENETRE_RATTACHEMENT_MS = 10_000;

/** Un passage de deux points ou moins, entoure du meme troncon des deux cotes, est absorbe (voisin parallele, carrefour). */
export const POINTS_PASSAGE_ABSORBE = 2;

export interface PointRattache {
  tMs: number;
  segment: number;
  /** `null` quand le HMM n'a trouve aucun troncon pour ce point. */
  tronconId: string | null;
  abscisseM: number | null;
}

export interface PositionTrace {
  tMs: number;
  lat: number;
  lon: number;
  segment: number;
}

export interface TronconAuTemps {
  tronconId: string;
  /** Position dans le tableau des points rattaches fourni. */
  index: number;
  ecartMs: number;
}

/** Plus proche en temps parmi les points DEJA rattaches (tronconId non nul), trie par temps croissant. */
export function tronconAuTemps(
  tMs: number,
  rattaches: readonly PointRattache[],
  fenetreMs: number = FENETRE_RATTACHEMENT_MS,
): TronconAuTemps | null {
  if (rattaches.length === 0) return null;
  // Recherche dichotomique du premier point d'instant >= tMs.
  let lo = 0;
  let hi = rattaches.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (rattaches[mid].tMs < tMs) lo = mid + 1; else hi = mid;
  }
  let meilleur: TronconAuTemps | null = null;
  for (const i of [lo - 1, lo]) {
    if (i < 0 || i >= rattaches.length) continue;
    const p = rattaches[i];
    if (p.tronconId === null) continue;
    const ecart = Math.abs(p.tMs - tMs);
    // A egalite, le point AVANT l'instant est prefere : c'est celui que le vehicule venait de quitter.
    if (ecart <= fenetreMs && (meilleur === null || ecart < meilleur.ecartMs)) {
      meilleur = { tronconId: p.tronconId, index: i, ecartMs: ecart };
    }
  }
  return meilleur;
}

/**
 * Position de la trace brute a l'instant `tMs`, interpolee lineairement entre les deux echantillons qui
 * l'encadrent quand ils sont du MEME segment. Hors trace, ou a cheval sur deux segments, l'echantillon
 * le plus proche est rendu s'il est a moins de `fenetreMs`, sinon `null` : jamais d'extrapolation.
 */
export function positionAuTemps(
  tMs: number,
  brut: readonly PositionTrace[],
  fenetreMs: number = FENETRE_RATTACHEMENT_MS,
): { lat: number; lon: number; methode: "INTERPOLATION" | "PLUS_PROCHE" } | null {
  if (brut.length === 0) return null;
  let lo = 0;
  let hi = brut.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (brut[mid].tMs < tMs) lo = mid + 1; else hi = mid;
  }
  const apres = lo < brut.length ? brut[lo] : null;
  const avant = lo > 0 ? brut[lo - 1] : null;
  if (apres && apres.tMs === tMs) return { lat: apres.lat, lon: apres.lon, methode: "INTERPOLATION" };
  if (avant && apres && avant.segment === apres.segment) {
    const f = (tMs - avant.tMs) / (apres.tMs - avant.tMs);
    return { lat: avant.lat + f * (apres.lat - avant.lat), lon: avant.lon + f * (apres.lon - avant.lon), methode: "INTERPOLATION" };
  }
  const candidats = [avant, apres].filter((x): x is PositionTrace => x !== null);
  candidats.sort((a, b) => Math.abs(a.tMs - tMs) - Math.abs(b.tMs - tMs));
  const proche = candidats[0];
  if (proche && Math.abs(proche.tMs - tMs) <= fenetreMs) return { lat: proche.lat, lon: proche.lon, methode: "PLUS_PROCHE" };
  return null;
}

export interface PassagePlan {
  tronconId: string;
  /** Abscisses du premier et du dernier point rattache du passage, ou `null` si aucun n'en porte. */
  entreeM: number | null;
  sortieM: number | null;
  nombrePoints: number;
  /** Le passage contient l'instant de debut / de fin de l'evenement : ses bornes sont a affiner par projection. */
  porteLeDebut: boolean;
  porteLaFin: boolean;
}

export type RefusPlan = "AUCUN_POINT_RATTACHE_AU_DEBUT" | "AUCUN_POINT_RATTACHE_A_LA_FIN" | "FIN_AVANT_DEBUT";

export type PlanEvenement =
  | { refus: RefusPlan }
  | { refus: null; passages: PassagePlan[]; absorbes: number };

/**
 * Decoupe un evenement lineaire [debutMs, finMs] en passages sur des troncons successifs.
 *
 * `rattaches` : points rattaches (tronconId non nul), TRIES par temps, de tous les segments de la trace.
 * Les passages sont les suites consecutives de points d'un meme troncon entre le point le plus proche
 * du debut et celui le plus proche de la fin. Un passage de `POINTS_PASSAGE_ABSORBE` points ou moins
 * qui separe deux passages du MEME troncon est fondu dans eux : c'est un parasite du rattachement
 * (voie parallele, carrefour), pas un troisieme troncon.
 */
export function planifierEvenement(
  debutMs: number,
  finMs: number,
  rattaches: readonly PointRattache[],
  fenetreMs: number = FENETRE_RATTACHEMENT_MS,
): PlanEvenement {
  if (finMs <= debutMs) return { refus: "FIN_AVANT_DEBUT" };
  const d = tronconAuTemps(debutMs, rattaches, fenetreMs);
  if (!d) return { refus: "AUCUN_POINT_RATTACHE_AU_DEBUT" };
  const f = tronconAuTemps(finMs, rattaches, fenetreMs);
  if (!f) return { refus: "AUCUN_POINT_RATTACHE_A_LA_FIN" };
  if (f.index < d.index) return { refus: "FIN_AVANT_DEBUT" };

  const pts = rattaches.slice(d.index, f.index + 1).filter((p) => p.tronconId !== null);
  // Suites consecutives d'un meme troncon.
  let passages: { tronconId: string; pts: PointRattache[] }[] = [];
  for (const p of pts) {
    const dernier = passages[passages.length - 1];
    if (dernier && dernier.tronconId === p.tronconId) dernier.pts.push(p);
    else passages.push({ tronconId: p.tronconId as string, pts: [p] });
  }

  // Absorption des parasites : A (n points) B (<= 2 points) A -> A.
  let absorbes = 0;
  let change = true;
  while (change) {
    change = false;
    for (let i = 1; i < passages.length - 1; i += 1) {
      const prec = passages[i - 1];
      const suiv = passages[i + 1];
      if (passages[i].pts.length <= POINTS_PASSAGE_ABSORBE && prec.tronconId === suiv.tronconId) {
        prec.pts.push(...suiv.pts);
        passages = [...passages.slice(0, i), ...passages.slice(i + 2)];
        absorbes += 1;
        change = true;
        break;
      }
    }
  }

  const sortie: PassagePlan[] = passages.map((p, i) => {
    const avecAbscisse = p.pts.filter((x) => x.abscisseM !== null);
    return {
      tronconId: p.tronconId,
      entreeM: avecAbscisse.length ? (avecAbscisse[0].abscisseM as number) : null,
      sortieM: avecAbscisse.length ? (avecAbscisse[avecAbscisse.length - 1].abscisseM as number) : null,
      nombrePoints: p.pts.length,
      porteLeDebut: i === 0,
      porteLaFin: i === passages.length - 1,
    };
  });
  return { refus: null, passages: sortie, absorbes };
}

export type SensParcours = "CROISSANT" | "DECROISSANT";

/** Bornes ordonnees d'une portion a partir de l'entree et de la sortie du vehicule, et sens de parcours. */
export function bornesPortion(entreeM: number, sortieM: number): { debutM: number; finM: number; sens: SensParcours } {
  return sortieM >= entreeM
    ? { debutM: entreeM, finM: sortieM, sens: "CROISSANT" }
    : { debutM: sortieM, finM: entreeM, sens: "DECROISSANT" };
}

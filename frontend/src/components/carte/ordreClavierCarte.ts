/**
 * Noyau PUR de la navigation au clavier d'une carte : ordre des elements, plafond, touches, textes. Sans Leaflet, sans DOM, sans React :
 * tout ce qui se decide ici se teste par des nombres et des chaines.
 *
 * POURQUOI UN ORDRE PAR DISTANCE AU CENTRE DE LA VUE (et non l'ordre alphabetique)
 *
 *  - Le libelle d'un element n'existe pas avant l'ouverture de son infobulle : les `<Tooltip>` de react-leaflet ne rendent leur contenu qu'a
 *    l'ouverture. Un tri alphabetique obligerait a ouvrir toutes les infobulles ; la distance, elle, ne demande que la geometrie.
 *  - Un parcours "le plus proche du centre d'abord" suit ce que l'utilisateur regarde : quand on zoome ou qu'on deplace la carte, les premiers
 *    elements sont ceux de la zone visee, pas ceux dont le nom commence par A.
 *  - L'ordre est fige tant que la vue ne bouge pas : la liste est calculee a l'entree dans le controleur et recalculee quand la carte bouge
 *    (jamais a chaque fleche), donc "suivant" reste "suivant".
 *
 * PLAFOND. Avec un reseau classe d'environ 1 700 troncons, la vue nationale contient tout : parcourir 1 700 elements a la fleche n'a pas de
 * sens. Seuls les `PLAFOND_ELEMENTS` plus proches du centre sont gardes ; l'ecran et l'annonce disent combien d'elements la vue contient
 * (`texteResume`), pour que personne ne croie avoir tout parcouru.
 */

/** [latitude, longitude] en degres. */
export type Coord = [number, number];

/** Nombre maximal d'elements parcourus a la fleche. Au-dela, on garde les plus proches du centre de la vue. */
export const PLAFOND_ELEMENTS = 150;

/** Saut de Page precedente / Page suivante. */
export const PAS_PAGE = 10;

export type GenreElement = "point" | "ligne" | "groupe";

export interface ElementNavigable {
  /** Identifiant stable pour la duree de vie de la couche (departage les egalites de distance). */
  cle: string;
  genre: GenreElement;
  /** Position d'un point ou d'un groupe. */
  point?: Coord;
  /** Parties d'une ligne (une seule pour un troncon, plusieurs pour une multi-ligne). */
  parties?: Coord[][];
}

export interface VueCarte {
  centre: Coord;
  sud: number;
  ouest: number;
  nord: number;
  est: number;
}

export interface ElementOrdonne<T extends ElementNavigable> {
  element: T;
  /** Distance au centre de la vue, en degres (echelle plate corrigee de la latitude) : sert a ordonner, pas a afficher. */
  distance: number;
  /** Point de l'element visible dans la vue, le plus proche du centre : la ou s'ouvre l'infobulle. */
  ancrage: Coord;
}

export interface ResultatOrdre<T extends ElementNavigable> {
  elements: ElementOrdonne<T>[];
  /** Nombre d'elements presents dans la vue, plafond non applique. */
  totalDansVue: number;
  tronque: boolean;
}

const dansLaVue = (p: Coord, v: VueCarte) => p[0] >= v.sud && p[0] <= v.nord && p[1] >= v.ouest && p[1] <= v.est;

/**
 * Portion du segment [a, b] qui se trouve dans la vue (Liang-Barsky), ou null si le segment ne la touche pas. Les coordonnees sont traitees
 * en degres, sans projection : sur l'emprise d'une vue cartographique, l'erreur ne change pas l'appartenance a la vue.
 */
export function segmentDansLaVue(a: Coord, b: Coord, v: VueCarte): [Coord, Coord] | null {
  let t0 = 0;
  let t1 = 1;
  const dy = b[0] - a[0];
  const dx = b[1] - a[1];
  const bornes: [number, number][] = [
    [-dx, a[1] - v.ouest],
    [dx, v.est - a[1]],
    [-dy, a[0] - v.sud],
    [dy, v.nord - a[0]],
  ];
  for (const [p, q] of bornes) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  return [
    [a[0] + t0 * dy, a[1] + t0 * dx],
    [a[0] + t1 * dy, a[1] + t1 * dx],
  ];
}

/** Echelle de longitude : un degre de longitude vaut cos(latitude) degres de latitude. */
const echelleLon = (latCentre: number) => Math.max(Math.cos((latCentre * Math.PI) / 180), 0.01);

function distanceCarree(p: Coord, c: Coord, k: number): number {
  const dy = p[0] - c[0];
  const dx = (p[1] - c[1]) * k;
  return dy * dy + dx * dx;
}

/** Point du segment le plus proche de `c`, avec sa distance carree. */
function plusProcheSurSegment(a: Coord, b: Coord, c: Coord, k: number): { p: Coord; d: number } {
  const ay = a[0];
  const ax = a[1] * k;
  const dy = b[0] - a[0];
  const dx = (b[1] - a[1]) * k;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((c[1] * k - ax) * dx + (c[0] - ay) * dy) / l2;
  t = Math.min(1, Math.max(0, t));
  const p: Coord = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  return { p, d: distanceCarree(p, c, k) };
}

/**
 * Position de l'element DANS la vue la plus proche du centre, ou null si l'element n'est pas dans la vue. Un point est dedans ou dehors ;
 * une ligne est ramenee a ses portions visibles, ce qui garantit que l'infobulle s'ouvre dans la vue meme pour une route qui la traverse.
 */
export function ancrageDansLaVue(el: ElementNavigable, v: VueCarte): { p: Coord; d: number } | null {
  const k = echelleLon(v.centre[0]);
  if (el.genre !== "ligne") {
    if (!el.point || !dansLaVue(el.point, v)) return null;
    return { p: el.point, d: distanceCarree(el.point, v.centre, k) };
  }
  let meilleur: { p: Coord; d: number } | null = null;
  for (const partie of el.parties ?? []) {
    if (partie.length === 1 && dansLaVue(partie[0], v)) {
      const d = distanceCarree(partie[0], v.centre, k);
      if (!meilleur || d < meilleur.d) meilleur = { p: partie[0], d };
    }
    for (let i = 1; i < partie.length; i++) {
      const visible = segmentDansLaVue(partie[i - 1], partie[i], v);
      if (!visible) continue;
      const r = plusProcheSurSegment(visible[0], visible[1], v.centre, k);
      if (!meilleur || r.d < meilleur.d) meilleur = r;
    }
  }
  return meilleur;
}

/**
 * Ordonne les elements presents dans la vue : du plus proche du centre au plus eloigne, a distance egale par cle (ordre total, donc
 * deterministe), puis ne garde que `plafond` elements.
 */
export function ordonner<T extends ElementNavigable>(elements: readonly T[], vue: VueCarte, plafond: number = PLAFOND_ELEMENTS): ResultatOrdre<T> {
  const visibles: ElementOrdonne<T>[] = [];
  for (const element of elements) {
    const a = ancrageDansLaVue(element, vue);
    if (a) visibles.push({ element, distance: Math.sqrt(a.d), ancrage: a.p });
  }
  visibles.sort((x, y) => x.distance - y.distance || (x.element.cle < y.element.cle ? -1 : x.element.cle > y.element.cle ? 1 : 0));
  return { elements: visibles.slice(0, plafond), totalDansVue: visibles.length, tronque: visibles.length > plafond };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Touches
// ---------------------------------------------------------------------------------------------------------------------------------------

export type Deplacement = "suivant" | "precedent" | "premier" | "dernier" | "page-suivante" | "page-precedente";
export type ActionClavier = { type: "deplacer"; vers: Deplacement } | { type: "activer" } | { type: "echap" };

export interface ToucheClavier {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

/**
 * Action d'une touche, ou null si la touche n'est pas pour le controleur (Tab et Maj+Tab en particulier : ils SORTENT de la carte). Les
 * combinaisons avec Ctrl, Alt, Meta ou Maj sont laissees au navigateur et aux lecteurs d'ecran.
 */
export function actionPourTouche(t: ToucheClavier): ActionClavier | null {
  if (t.ctrlKey || t.altKey || t.metaKey || t.shiftKey) return null;
  switch (t.key) {
    case "ArrowRight":
    case "ArrowDown":
      return { type: "deplacer", vers: "suivant" };
    case "ArrowLeft":
    case "ArrowUp":
      return { type: "deplacer", vers: "precedent" };
    case "Home":
      return { type: "deplacer", vers: "premier" };
    case "End":
      return { type: "deplacer", vers: "dernier" };
    case "PageDown":
      return { type: "deplacer", vers: "page-suivante" };
    case "PageUp":
      return { type: "deplacer", vers: "page-precedente" };
    case "Enter":
    case " ":
    case "Spacebar":
      return { type: "activer" };
    case "Escape":
    case "Esc":
      return { type: "echap" };
    default:
      return null;
  }
}

export interface Position {
  index: number;
  /** Renseigne quand l'appui n'a pas pu avancer : on est deja au debut ou a la fin de la liste. */
  butee: "debut" | "fin" | null;
}

/**
 * Nouvelle position apres un deplacement. `courant` vaut -1 quand rien n'est encore choisi : toute fleche (sauf Fin) pose alors le choix sur
 * le PREMIER element, le plus proche du centre. On ne boucle pas : arriver au bout de la liste est dit, pas masque par un retour au debut.
 */
export function positionApres(courant: number, vers: Deplacement, total: number): Position {
  if (total <= 0) return { index: -1, butee: null };
  if (courant < 0) return { index: vers === "dernier" ? total - 1 : 0, butee: null };
  const cible =
    vers === "suivant" ? courant + 1
    : vers === "precedent" ? courant - 1
    : vers === "premier" ? 0
    : vers === "dernier" ? total - 1
    : vers === "page-suivante" ? courant + PAS_PAGE
    : courant - PAS_PAGE;
  const index = Math.min(total - 1, Math.max(0, cible));
  if (index === courant) return { index, butee: cible < 0 || vers === "premier" ? "debut" : "fin" };
  return { index, butee: null };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Textes (francais, lus tels quels par un lecteur d'ecran)
// ---------------------------------------------------------------------------------------------------------------------------------------

export const LIBELLE_CONTROLEUR = "Éléments de la carte";

/** Aide courte, visible a l'entree dans le controleur et referencee par aria-describedby. */
export const AIDE_CLAVIER =
  "Flèches : élément suivant ou précédent, du plus proche du centre de la vue au plus éloigné. Début et Fin : premier et dernier. " +
  "Page précédente et suivante : par dix. Entrée ou Espace : ouvrir la fiche (sur un groupe : zoomer). Échap : fermer, puis revenir à la carte. Tab : quitter la carte.";

const pluriel = (n: number, un: string, plusieurs: string) => `${n.toLocaleString("fr-FR")} ${n > 1 ? plusieurs : un}`;

/** Resume annonce et affiche a l'entree dans le controleur, et quand la vue change. Dit le plafond quand il est atteint. */
export function texteResume(total: number, tronque: boolean, plafond: number = PLAFOND_ELEMENTS): string {
  if (total === 0) return "Aucun élément dans la vue. Zoomez ou déplacez la carte.";
  if (tronque) {
    return `${pluriel(total, "élément", "éléments")} dans la vue : seuls les ${plafond} plus proches du centre se parcourent aux flèches. Zoomez ou déplacez la carte pour en voir d'autres.`;
  }
  return `${pluriel(total, "élément", "éléments")} dans la vue.`;
}

/** Texte annonce pour un element : son libelle (celui de l'infobulle), puis son rang. */
export function texteElement(libelle: string, index: number, total: number): string {
  return `${libelle}, ${index + 1} sur ${total}`;
}

export function texteButee(butee: "debut" | "fin", libelle: string, index: number, total: number): string {
  return `${butee === "debut" ? "Premier" : "Dernier"} élément. ${texteElement(libelle, index, total)}`;
}

export function libelleGroupe(nbEnfants: number): string {
  return `Groupe de ${pluriel(nbEnfants, "élément", "éléments")}, Entrée pour zoomer`;
}

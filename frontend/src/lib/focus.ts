/**
 * Mode « un seul element » du geoportail.
 *
 * QUAND ON ARRIVE SUR LA CARTE POUR VOIR UN ELEMENT (bouton « Carte » d'une liste, lien d'une alerte,
 * resultat de recherche), la carte n'affiche QUE cet element. Avant, elle se centrait dessus mais gardait
 * tous les troncons de la region a l'ecran : l'element se perdait dans le reseau.
 *
 * Un lien PARTAGE depuis la carte (bouton « Partager ») ne declenche pas ce mode : il porte
 * `vue=complete`, qui dit « rouvrir la vue complete, avec cet element ouvert ». C'est la seule
 * difference entre les deux usages de `select` + `id`.
 */

export type FocusKind = "troncon" | "ouvrage" | "pointNoir" | "poste" | "chantier";

export interface Focus {
  kind: FocusKind;
  id: string;
}

export type CleCouche = "troncons" | "chantiers" | "ouvrages" | "postes" | "pointsNoirs";

/**
 * Couches allumees a l'ouverture de la carte. Le reseau et les ouvrages ; les chantiers (travaux en cours), les
 * postes de peage/pesage et les points noirs sont des couches d'exploitation que l'on allume quand on les
 * cherche : les afficher d'emblee noyait le reseau sous des centaines de marqueurs.
 */
export const COUCHES_PAR_DEFAUT: Record<CleCouche, boolean> = {
  troncons: true,
  ouvrages: true,
  chantiers: false,
  postes: false,
  pointsNoirs: false,
};

/** Couche de la carte qui porte chaque sorte d'element. */
export const KIND_PAR_COUCHE: Record<CleCouche, FocusKind> = {
  troncons: "troncon",
  chantiers: "chantier",
  ouvrages: "ouvrage",
  postes: "poste",
  pointsNoirs: "pointNoir",
};

const KINDS = new Set<string>(Object.values(KIND_PAR_COUCHE));

/** Parametre qui desactive le mode (lien partage de la vue complete). */
export const PARAM_VUE = "vue";
export const VUE_COMPLETE = "complete";

export function lireFocus(params: URLSearchParams): Focus | null {
  const kind = params.get("select");
  const id = params.get("id");
  if (!kind || !id || !KINDS.has(kind)) return null;
  if (params.get(PARAM_VUE) === VUE_COMPLETE) return null;
  return { kind: kind as FocusKind, id };
}

/**
 * Une couche est-elle dessinee ? En mode « un seul element », seule la couche de cet element l'est,
 * quelle que soit la case cochee : l'utilisateur a demande CET element, pas la couche.
 */
export function coucheVisible(focus: Focus | null, couches: Record<CleCouche, boolean>, cle: CleCouche): boolean {
  return focus ? focus.kind === KIND_PAR_COUCHE[cle] : couches[cle];
}

/** Ne garde que l'element cible (ou tout, hors mode). Les elements d'une autre sorte disparaissent. */
export function garderLeFocus<T extends { id: string }>(elements: readonly T[], focus: Focus | null, kind: FocusKind): T[] {
  if (!focus) return [...elements];
  return focus.kind === kind ? elements.filter((e) => e.id === focus.id) : [];
}

/** Retire de l'URL ce qui declenche le mode, en gardant le reste (fond, region, zoom...). */
export function sansFocus(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete("select");
  next.delete("id");
  return next;
}

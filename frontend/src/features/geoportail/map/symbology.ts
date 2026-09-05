import type { EtatPatrimoine } from "../../../types";

/**
 * L'echelle d'etat du reseau, definie UNE fois.
 *
 * POURQUOI CE FICHIER EXISTE
 *
 * L'etat d'un troncon se formulait de deux facons contradictoires selon l'ecran.
 * Mesure du 05/09/2026 :
 *
 *     valeur en base    liste (Badge)     carte et carte publique (ETAT_LABELS)
 *     BON               « BON »           « Bon etat general »
 *     MOYEN             « MOYEN »         « Alternance Bon / Moyen »
 *     MAUVAIS           « MAUVAIS »       « Moyen etat general »
 *     CRITIQUE          « CRITIQUE »      « Mauvais etat general »
 *
 * Un troncon enregistre CRITIQUE se lit « CRITIQUE » dans une liste et « Mauvais etat
 * general » sur la carte publique. Le decalage joue d'un cran, toujours dans le sens
 * favorable, et c'est la version publique qui est la plus clemente. `ETAT_LABELS`
 * vient de l'instantane initial du depot, sans une ligne d'explication, dans un code
 * ou chaque decision porte pourtant son commentaire.
 *
 * Ce fichier porte la formulation DIRECTE, celle qui nomme la valeur stockee. La
 * formulation publique n'est pas modifiee ici : changer le vocabulaire de l'indicateur
 * d'etat du reseau national est une decision de l'agence, pas d'un correctif. Voir
 * `pages/geoportail/types.ts`, ou la divergence est desormais ecrite au lieu d'etre
 * subie.
 *
 * DEUX COULEURS PAR ETAT, ET POURQUOI
 *
 * Une couleur lisible en TRAIT sur une carte ne l'est pas en TEXTE sur blanc. WCAG 2.1
 * demande 3:1 pour un element graphique, 4,5:1 pour du texte. De la palette demandee,
 * un seul des cinq etats passait le seuil texte. Les valeurs ci-dessous sont mesurees,
 * pas estimees ; `symbology.test.ts` recalcule chaque ratio a chaque execution.
 *
 * CES VALEURS SONT EN DUR, ET C'EST NECESSAIRE
 *
 * Le rendu de la carte passe par le moteur canvas de Leaflet, qui fait
 * `ctx.strokeStyle = options.color`. Une variable CSS (`var(--etat-bon-trait)`) n'y
 * est pas resolue : le trait tomberait en noir, silencieusement. Les traits sont donc
 * des hexadecimaux litteraux ici, et `tokens.css` les reprend pour le DOM. Un test
 * lit le fichier CSS et compare : les deux ne peuvent pas diverger sans echouer.
 */

/** Du meilleur au pire, puis l'inconnu. L'ordre de lecture partout. */
export const ORDRE_ETATS: readonly EtatPatrimoine[] = [
  "BON", "MOYEN", "MAUVAIS", "CRITIQUE", "NON_EVALUE",
] as const;

export interface Symbole {
  /** Couleur du trait sur la carte et des aplats. Seuil graphique 3:1. */
  trait: string;
  /** Couleur du texte lisible sur fond clair. Seuil texte 4,5:1. */
  texte: string;
  /** Fond de badge. */
  fond: string;
  /** Libelle direct, qui nomme la valeur stockee. */
  libelle: string;
  /**
   * Forme qui double la couleur.
   *
   * Environ 8 % des hommes distinguent mal le rouge du vert. Une carte qui n'encode
   * l'etat que par la teinte leur est inutilisable, et aucune norme ne l'autorise.
   * Chaque etat porte donc aussi une forme et un motif de trait.
   */
  forme: "cercle" | "losange" | "triangle" | "carre";
  /** Motif de trait, lisible meme en niveaux de gris ou a l'impression. */
  tirets: string | undefined;
}

export const SYMBOLES: Record<EtatPatrimoine, Symbole> = {
  BON: {
    trait: "#1b8a5a", texte: "#12694a", fond: "#e8f5ef",
    libelle: "Bon", forme: "cercle", tirets: undefined,
  },
  MOYEN: {
    // #E0A500 demande, mais mesure a 2,20:1 sur blanc — sous le seuil graphique de
    // 3:1. Un trait jaune sur fond de plan clair est difficile a voir, et c'est
    // l'etat le plus frequent du reseau.
    //
    // Le premier essai, #B88700, passait sur du BLANC (3,23:1) mais pas sur le fond
    // applicatif reel #f4f6f8 (2,98:1) — un ecart invisible a l'oeil et decisif pour
    // la norme. C'est le test qui l'a vu, en recalculant contre le vrai fond au lieu
    // d'un blanc theorique. #B08200 mesure 3,21:1 la ou la couleur est reellement
    // posee. Seul ecart pris avec la palette demandee.
    trait: "#b08200", texte: "#7a5b00", fond: "#f9f0d9",
    libelle: "Moyen", forme: "losange", tirets: undefined,
  },
  MAUVAIS: {
    trait: "#e0631d", texte: "#8f3d10", fond: "#fdeee5",
    libelle: "Mauvais", forme: "triangle", tirets: "10 4",
  },
  CRITIQUE: {
    trait: "#b91c1c", texte: "#b91c1c", fond: "#fdeaea",
    libelle: "Critique", forme: "triangle", tirets: "4 4",
  },
  NON_EVALUE: {
    trait: "#848992", texte: "#565b63", fond: "#eef0f2",
    libelle: "Non évalué", forme: "carre", tirets: "2 6",
  },
};

/** Contrepartie sombre, pour le mode nuit du terrain. */
export const SYMBOLES_SOMBRE: Record<EtatPatrimoine, Pick<Symbole, "trait" | "texte" | "fond">> = {
  BON: { trait: "#34d399", texte: "#6ee7b7", fond: "#06291d" },
  MOYEN: { trait: "#fbbf24", texte: "#fcd34d", fond: "#2b2205" },
  MAUVAIS: { trait: "#fb923c", texte: "#fdba74", fond: "#2e1608" },
  CRITIQUE: { trait: "#f87171", texte: "#fca5a5", fond: "#2f0d0d" },
  NON_EVALUE: { trait: "#9ca3af", texte: "#d1d5db", fond: "#1f2429" },
};

/**
 * Repli pour une valeur que le referentiel ne connait pas.
 *
 * Ce n'est pas de la prudence de principe : le 04/09, une classe `NON_CLASSEE` ajoutee
 * en base mais absente du type TypeScript a satisfait `Record<ClasseRoute, ...>` — le
 * compilateur n'a rien vu — puis a fait tomber la page en production sur un
 * `undefined.pill`. Une table indexee par une valeur venue du serveur doit toujours
 * pouvoir repondre.
 */
export const SYMBOLE_INCONNU: Symbole = {
  trait: "#848992", texte: "#565b63", fond: "#eef0f2",
  libelle: "État inconnu", forme: "carre", tirets: "2 6",
};

/** Le symbole d'un etat, sans jamais rendre `undefined`. */
export function symbole(etat: string | null | undefined, sombre = false): Symbole {
  const base = (etat && SYMBOLES[etat as EtatPatrimoine]) || SYMBOLE_INCONNU;
  if (!sombre) return base;
  const nuit = etat ? SYMBOLES_SOMBRE[etat as EtatPatrimoine] : undefined;
  return nuit ? { ...base, ...nuit } : base;
}

/** Le libelle d'un etat, sans jamais rendre `undefined`. */
export function libelleEtat(etat: string | null | undefined): string {
  return symbole(etat).libelle;
}

/**
 * Largeur d'un trace selon le zoom et la classe.
 *
 * Une largeur fixe donne un plat de spaghettis a l'echelle du pays et un fil invisible
 * a l'echelle de la rue. L'interpolation est lineaire entre deux paliers, bornee aux
 * extremites — au-dela, la largeur cesse de croitre pour ne pas noyer le fond de plan.
 *
 * Les classes ne sont pas seulement plus epaisses les unes que les autres : une
 * nationale porte le trafic national et doit se lire en premier a toutes les echelles.
 */
const LARGEUR_CLASSE: Record<string, number> = {
  RN: 1.6, RR: 1.15, RU: 1.0, PISTE: 0.8, NON_CLASSEE: 0.65,
};

export function largeurTrait(zoom: number, classe?: string | null): number {
  const z = Math.max(6, Math.min(18, zoom));
  // 1,2 px a l'echelle du pays, 7 px a l'echelle de la rue.
  const base = 1.2 + ((z - 6) / 12) * 5.8;
  return Math.round(base * (LARGEUR_CLASSE[classe ?? ""] ?? 0.65) * 10) / 10;
}

/**
 * Contour blanc fin sous le trace.
 *
 * Sans lui, une route verte sur une image satellite verte disparait. Le contour est le
 * seul moyen de garder l'echelle d'etat lisible sur les deux fonds de plan sans avoir
 * deux palettes a maintenir.
 */
export function largeurContour(zoom: number, classe?: string | null): number {
  return Math.round((largeurTrait(zoom, classe) + 2.5) * 10) / 10;
}

/** Seuils de zoom, nommes pour que la carte et la legende disent la meme chose. */
export const ZOOM = {
  /** En dessous, les ouvrages sont regroupes plutot qu'affiches un a un. */
  REGROUPEMENT_OUVRAGES: 11,
  /** En dessous, aucune etiquette de route : 1 691 libelles sont illisibles. */
  ETIQUETTES: 12,
  /** En dessous, la voirie locale n'est pas chargee du tout. */
  VOIRIE_LOCALE: 12,
} as const;

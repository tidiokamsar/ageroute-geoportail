import type { EtatPatrimoine } from "../../types";
import type { PublicTroncon } from "./types";

/**
 * Lecture chiffree du reseau, pour le panneau public.
 *
 * POURQUOI CE CALCUL SORT DU COMPOSANT
 *
 * Il portait une affirmation fausse et invisible. La barre d'etat annonce « 15 % en
 * bon etat » en additionnant tous les troncons BON — y compris ceux dont l'etat a ete
 * DECLARE par un gestionnaire sans qu'aucune inspection n'ait eu lieu. Depuis la
 * promotion de la voirie, ces declarations ne sont plus marginales : elles pesent des
 * centaines de kilometres.
 *
 * Un pourcentage qui melange un releve de terrain et une declaration ne veut rien
 * dire, et rien a l'ecran ne permettait de s'en apercevoir. Le calcul distingue donc
 * les deux, et le panneau l'affiche.
 *
 * Sorti du composant pour etre teste : c'est de l'arithmetique sur des donnees, pas
 * du rendu.
 */

/** Ordre de lecture : du meilleur au pire, puis l'inconnu. */
export const ORDRE_ETATS: EtatPatrimoine[] = [
  "BON", "MOYEN", "MAUVAIS", "CRITIQUE", "NON_EVALUE",
];

/** Ordre de lecture : du plus structurant au moins classe. */
export const ORDRE_CLASSES = ["RN", "RR", "RU", "PISTE", "NON_CLASSEE"] as const;
export type ClasseRoute = (typeof ORDRE_CLASSES)[number];

export interface PartEtat {
  etat: EtatPatrimoine;
  km: number;
  pct: number;
  /** Part de ces kilometres dont l'etat est declare, jamais constate. */
  kmDeclare: number;
}

export interface PartClasse {
  classe: string;
  km: number;
  troncons: number;
}

export interface StatsReseau {
  totalKm: number;
  parEtat: PartEtat[];
  parClasse: PartClasse[];
  /** Total des kilometres dont l'etat repose sur une declaration. */
  kmDeclare: number;
  chantiersEnCours: number;
  pointsNoirs: number;
}

function arrondi(n: number): number {
  return Math.round(n);
}

export function calculerStats(
  troncons: PublicTroncon[],
  chantiersEnCours: number,
  pointsNoirs: number,
): StatsReseau {
  const totalKm = troncons.reduce((s, t) => s + (t.longueurKm || 0), 0);

  const parEtat = ORDRE_ETATS.map((etat) => {
    const lot = troncons.filter((t) => t.etat === etat);
    const km = lot.reduce((s, t) => s + (t.longueurKm || 0), 0);
    const kmDeclare = lot
      .filter((t) => t.etatDeclare)
      .reduce((s, t) => s + (t.longueurKm || 0), 0);
    return { etat, km, kmDeclare, pct: totalKm > 0 ? Math.round((km / totalKm) * 100) : 0 };
  }).filter((e) => e.km > 0);

  // Une classe absente du reseau ne merite pas une case a cocher vide ; une classe
  // inconnue du referentiel ne doit pas disparaitre pour autant.
  const classesVues = new Set(troncons.map((t) => t.classe));
  const ordre = [
    ...ORDRE_CLASSES.filter((c) => classesVues.has(c)),
    ...[...classesVues].filter((c) => !(ORDRE_CLASSES as readonly string[]).includes(c)).sort(),
  ];
  const parClasse = ordre.map((classe) => {
    const lot = troncons.filter((t) => t.classe === classe);
    return {
      classe,
      km: arrondi(lot.reduce((s, t) => s + (t.longueurKm || 0), 0)),
      troncons: lot.length,
    };
  });

  return {
    totalKm: arrondi(totalKm),
    parEtat,
    parClasse,
    kmDeclare: arrondi(
      troncons.filter((t) => t.etatDeclare).reduce((s, t) => s + (t.longueurKm || 0), 0),
    ),
    chantiersEnCours,
    pointsNoirs,
  };
}

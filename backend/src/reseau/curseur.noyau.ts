/**
 * Le curseur temporel : ce qu'une carte « a une date » doit montrer, et ce qu'elle doit refuser
 * de montrer. Les regles, sans la base.
 *
 * DEUX QUESTIONS, DEUX AXES (voir `bitemporel.ts`)
 *
 *   « Quel etait l'etat au 20 mars ? »        axe TERRAIN   -> `dateTerrain`
 *   « Que savait-on le 25 mars de l'etat ? »  axe SYSTEME   -> `connuLe`
 *
 * Le curseur repond a la premiere. La seconde est facultative : elle sert a prouver sur quelles
 * donnees une decision a ete prise, et change ce qui est visible meme a date de terrain egale.
 *
 * CE QUE LE CURSEUR NE FAIT JAMAIS
 *
 * - IL N'INVENTE AUCUN ETAT. Une portion sans date d'effet n'est placee a aucune date : elle est
 *   COMPTEE, pas supposee « depuis toujours ». Un metre qu'aucune portion ne couvre a cette date
 *   reste « non renseigne », jamais l'etat d'une portion voisine ni l'etat actuel du troncon.
 * - IL N'ELARGIT PAS LA VALIDATION. Par defaut seules les portions VALIDEES sont retenues ; les
 *   propositions ne sont montrees que sur demande, et restent marquees comme telles.
 * - IL NE MENT PAS SUR L'AXE SYSTEME. A `connuLe`, le statut de validation est celui qui etait
 *   connu A CETTE DATE (journal des decisions), pas le statut d'aujourd'hui : une portion validee
 *   hier ne doit pas paraitre validee dans ce que l'on savait le mois dernier.
 *
 * MODULE PUR : aucune base, aucune horloge implicite. Il n'importe que `bitemporel.ts`, qui l'est
 * aussi.
 */

import {
  refusVersion,
  telQuEnregistreA,
  valideA,
  type VersionTemporelle,
} from "./bitemporel";

export type StatutValidation = "A_VALIDER" | "VALIDE" | "REJETE" | "A_CORRIGER";

/** Une portion situee sur les deux axes de temps, et sur son troncon. */
export interface PortionDatee extends VersionTemporelle {
  tronconId: string;
  debutM: number;
  finM: number;
  /** Statut ACTUEL. Sur l'axe systeme, il est reconstitue a partir des decisions. */
  statutValidation: StatutValidation;
}

/** Une decision de validation, telle que le journal d'audit l'a consignee. */
export interface DecisionValidation {
  portionId: string;
  statut: StatutValidation;
  decideLe: Date;
}

/** Tolerance de chevauchement, en metres : celle de `portions.ts` (`TOLERANCE_M`). */
const TOLERANCE_M = 0.05;

/**
 * Le statut d'une portion tel qu'il etait CONNU a une date systeme.
 *
 * Toute portion naît `A_VALIDER` (voir `portions.service.ts`) : sans decision enregistree avant
 * `connuLe`, c'est donc son statut. A defaut de decision anterieure, rendre le statut actuel
 * ferait paraitre valide ce qui ne l'etait pas encore.
 *
 * Deux decisions au meme instant : la derniere du tableau l'emporte, ce qui rend le resultat
 * deterministe pour un journal donne.
 */
export function statutConnuLe(
  portionId: string,
  decisions: readonly DecisionValidation[],
  connuLe: Date,
): StatutValidation {
  const t = connuLe.getTime();
  let derniere: DecisionValidation | null = null;
  for (const d of decisions) {
    if (d.portionId !== portionId || d.decideLe.getTime() > t) continue;
    if (derniere === null || d.decideLe.getTime() >= derniere.decideLe.getTime()) derniere = d;
  }
  return derniere?.statut ?? "A_VALIDER";
}

export interface ParametresSelection {
  /** Le jour de terrain demande. */
  dateTerrain: Date;
  /** Axe systeme, facultatif : ce que le systeme savait a cette date. `null` = aujourd'hui. */
  connuLe: Date | null;
  /** Montrer aussi les propositions non validees. Faux par defaut : seul le valide fait foi. */
  inclureAValider: boolean;
}

export type PortionRetenue<P extends PortionDatee> = P & {
  /** Le statut tel que connu a la date demandee (actuel si `connuLe` est nul). */
  statutConnu: StatutValidation;
  /** Une autre portion retenue couvre les memes metres : le curseur ne tranche pas. */
  ambigue: boolean;
};

export interface ResultatSelection<P extends PortionDatee> {
  retenues: PortionRetenue<P>[];
  comptes: {
    retenues: number;
    /** Vraies a cette date mais en attente de validation, non demandees. */
    aValiderEcartees: number;
    /** Sans date d'effet : placees a AUCUNE date. Comptees, jamais supposees. */
    sansDateEffet: number;
    /** Dates inexploitables (fin avant debut...). Ecartees, et comptees. */
    datesIncoherentes: number;
    /**
     * Remplacees sans date d'effet de fin : on ne sait pas quand la realite a change. Ecartees
     * et comptees. Une decoupe en produit une par portion decoupee, et c'est normal.
     */
    remplaceesSansFin: number;
    /** Retenues qui en recouvrent une autre. */
    ambigues: number;
  };
  /** Longueur couverte par les portions retenues, recouvrements fusionnes, en metres. */
  longueurCouverteM: number;
}

/**
 * Les portions vraies a une date, selon les deux axes.
 *
 * ORDRE DES OPERATIONS, QUI COMPTE
 *
 * 1. L'axe systeme d'abord : `telQuEnregistreA` retire ce qui n'existait pas encore, et rouvre
 *    ce dont le remplacement n'etait pas enregistre. Faire l'inverse filtrerait sur un
 *    `valideAu` que le systeme ne connaissait pas encore.
 * 2. Le statut ensuite, tel que connu a cette date.
 * 3. L'axe terrain en dernier : `valideA`, intervalle semi-ouvert [valideDu, valideAu).
 */
export function selectionner<P extends PortionDatee>(
  portions: readonly P[],
  decisions: readonly DecisionValidation[],
  p: ParametresSelection,
): ResultatSelection<P> {
  // `telQuEnregistreA` copie chaque version par decomposition : les champs propres a P y sont
  // conserves a l'execution, seul son type de retour est plus etroit.
  const vues: readonly P[] =
    p.connuLe === null ? portions : (telQuEnregistreA(portions, p.connuLe) as unknown as P[]);

  const comptes = {
    retenues: 0, aValiderEcartees: 0, sansDateEffet: 0, datesIncoherentes: 0, remplaceesSansFin: 0, ambigues: 0,
  };
  const retenues: PortionRetenue<P>[] = [];

  for (const v of vues) {
    if (v.deletedAt !== null) continue;
    const statutConnu = p.connuLe === null ? v.statutValidation : statutConnuLe(v.id, decisions, p.connuLe);
    const eligible = statutConnu === "VALIDE" || (p.inclureAValider && statutConnu === "A_VALIDER");

    if (!eligible) {
      // Seul le « en attente » est compte : un rejet n'est pas une portion que l'on attendait.
      if (statutConnu === "A_VALIDER" && valideA(v, p.dateTerrain)) comptes.aValiderEcartees += 1;
      continue;
    }

    const refus = refusVersion(v);
    if (refus === "SANS_DATE_EFFET") { comptes.sansDateEffet += 1; continue; }
    if (refus !== null) { comptes.datesIncoherentes += 1; continue; }
    if (!valideA(v, p.dateTerrain)) continue;

    // UNE VERSION REMPLACEE SANS DATE DE FIN n'est plus montree : le systeme sait qu'une autre
    // version l'a remplacee, mais pas QUAND la realite a change. La garder « vraie » pour
    // toujours la superposerait a sa remplacante (parent d'une decoupe, requalification sans
    // date) ; l'ecarter en silence cacherait qu'on ne sait pas. Elle est ecartee ET comptee.
    if (v.remplaceeLe !== null && v.valideAu === null) { comptes.remplaceesSansFin += 1; continue; }

    retenues.push({ ...v, statutConnu, ambigue: false });
  }

  // Chevauchements entre portions retenues, troncon par troncon.
  const parTroncon = new Map<string, PortionRetenue<P>[]>();
  for (const r of retenues) {
    const l = parTroncon.get(r.tronconId);
    if (l) l.push(r); else parTroncon.set(r.tronconId, [r]);
  }
  let longueurCouverteM = 0;
  for (const liste of parTroncon.values()) {
    liste.sort((a, b) => a.debutM - b.debutM || a.finM - b.finM);
    for (let i = 0; i < liste.length; i += 1) {
      for (let j = i + 1; j < liste.length; j += 1) {
        if (liste[j].debutM >= liste[i].finM - TOLERANCE_M) break;
        liste[i].ambigue = true;
        liste[j].ambigue = true;
      }
    }
    // Union des intervalles : un metre couvert deux fois ne compte qu'une fois.
    let debut = liste[0].debutM;
    let fin = liste[0].finM;
    for (let i = 1; i < liste.length; i += 1) {
      if (liste[i].debutM <= fin) { fin = Math.max(fin, liste[i].finM); continue; }
      longueurCouverteM += fin - debut;
      debut = liste[i].debutM;
      fin = liste[i].finM;
    }
    longueurCouverteM += fin - debut;
  }

  comptes.retenues = retenues.length;
  comptes.ambigues = retenues.filter((r) => r.ambigue).length;

  // Ordre stable et lisible : par troncon puis par abscisse.
  retenues.sort((a, b) => (a.tronconId < b.tronconId ? -1 : a.tronconId > b.tronconId ? 1 : a.debutM - b.debutM));

  return { retenues, comptes, longueurCouverteM: Math.round(longueurCouverteM * 10) / 10 };
}

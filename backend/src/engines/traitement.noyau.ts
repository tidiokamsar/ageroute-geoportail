/**
 * CHOIX DU TRAITEMENT ET PROJECTION DE DEGRADATION -- noyau du Treatment Engine (paragraphe 7.7).
 * Aucun acces base.
 *
 * DEUX TABLES, DEUX ROLES, AUCUN MELANGE
 *
 *   catalogue_traitements + conditions_traitement  QUEL traitement pour (famille de cout, etat,
 *       classe de trafic). La matrice d'orientation est une FONCTION : une condition designe un
 *       traitement. Si deux traitements restent possibles, le moteur REFUSE, il ne choisit pas.
 *   matrices_degradation  A QUELLE VITESSE le troncon se degrade s'il n'est pas traite : trois
 *       probabilites annuelles de transition markovienne (BON vers MOYEN, MOYEN vers MAUVAIS,
 *       MAUVAIS vers CRITIQUE). CRITIQUE est absorbant.
 *
 * CE QUE LE CATALOGUE NE DIT PAS ENCORE, ET QUE LE MOTEUR N'INVENTE PAS
 *
 * `dureeVieAttendueAns`, `effetSurIndice` et `fenetreRealisation` sont NULS au semis (migration
 * 20261014220000) : personne ne les a arretes. Ce noyau ne s'en sert donc PAS, et le dit dans
 * chaque resultat (`attributsNonRenseignes`). Un traitement est suppose remettre le troncon hors
 * du risque qu'il traite : c'est une hypothese de simulation, nommee comme telle, que
 * `effetSurIndice` remplacera le jour ou il sera arrete.
 *
 * LE PAS DE TEMPS DES MATRICES N'EST PAS DOCUMENTE EN BASE. Le schema les appelle « probabilites
 * annuelles » et le semis HDM-4 simplifie est « a valider par la Direction Technique ». Ce
 * noyau les lit comme annuelles, comme le schema, et la projection reste PROVISOIRE tant que la
 * matrice n'est pas approuvee.
 *
 * LA CLASSE DE TRAFIC NE SE DEVINE PAS. Sans comptage, aucune ligne de matrice n'est choisie : la
 * projection est alors ABSENTE (jamais « T2 par defaut »), et le risque courant seul est retenu.
 */

import { arrondi4 } from "./risque.noyau";

export type ClasseTrafic = "T1_faible" | "T2_moyen" | "T3_fort";

export interface LigneMatrice {
  familleRevetement: string;
  classeTrafic: string;
  pBonVersMoyen: number;
  pMoyenVersMauvais: number;
  pMauvaisVersCritique: number;
  version?: number | null;
  approuveLe?: Date | string | null;
  actif?: boolean;
}

export interface Traitement {
  code: string;
  libelle: string;
  famille: string;
  dureeVieAttendueAns?: number | null;
  /** Decimal en base ; passe en nombre ou en chaine par l'appelant, jamais lu ici. */
  effetSurIndice?: number | string | null;
  fenetreRealisation?: string | null;
  version?: number | null;
  approuveLe?: Date | string | null;
  actif?: boolean;
}

export interface ConditionTraitement {
  traitementCode: string;
  familleRevetement: string;
  etatDepart: string;
  classeTrafic?: string | null;
  actif?: boolean;
}

/** Classe de trafic d'un comptage, selon les seuils (parametres). `null` sans comptage. */
export function classeTraficDe(jma: number | null, seuils: { t1MaxJma: number; t2MaxJma: number }): ClasseTrafic | null {
  if (jma === null || !Number.isFinite(jma) || jma < 0) return null;
  if (jma < seuils.t1MaxJma) return "T1_faible";
  if (jma < seuils.t2MaxJma) return "T2_moyen";
  return "T3_fort";
}

export const ETAT_SUIVANT: Record<string, string | null> = { BON: "MOYEN", MOYEN: "MAUVAIS", MAUVAIS: "CRITIQUE", CRITIQUE: null };

export type ProjectionDegradation =
  | {
      ok: true;
      etatCourant: string;
      /** `null` si l'etat est CRITIQUE (absorbant). */
      etatSuivant: string | null;
      /** Probabilite annuelle de passer a l'etat suivant. */
      pAnnuelle: number;
      horizonAnnees: number;
      /** Probabilite de passer a l'etat suivant dans l'horizon : 1 - (1 - p)^H, calculee par produits. */
      pHorizon: number;
      matrice: { familleRevetement: string; classeTrafic: string; version: number | null; approuvee: boolean };
    }
  | { ok: false; motif: string };

/**
 * Probabilite de se degrader dans l'horizon, ou le motif de son absence. Aucune ligne de repli :
 * famille inconnue, classe de trafic inconnue ou matrice absente donnent une projection absente.
 */
export function projeterDegradation(
  d: { familleRevetement: string | null; etat: string; classeTrafic: ClasseTrafic | null; horizonAnnees: number },
  matrices: readonly LigneMatrice[],
): ProjectionDegradation {
  if (d.familleRevetement === null) return { ok: false, motif: "famille de revetement inconnue : aucune matrice de degradation applicable" };
  if (d.classeTrafic === null) return { ok: false, motif: "classe de trafic inconnue (aucun comptage) : la matrice n'est pas choisie, aucune projection de degradation" };
  if (!(d.etat in ETAT_SUIVANT)) return { ok: false, motif: `etat ${d.etat} sans transition de degradation` };
  const lignes = matrices.filter((m) => m.actif !== false && m.familleRevetement === d.familleRevetement && m.classeTrafic === d.classeTrafic);
  if (lignes.length === 0) return { ok: false, motif: `aucune matrice de degradation pour (${d.familleRevetement}, ${d.classeTrafic})` };
  if (lignes.length > 1) return { ok: false, motif: `${lignes.length} matrices actives pour (${d.familleRevetement}, ${d.classeTrafic}) : le moteur ne choisit pas` };
  const m = lignes[0];
  const suivant = ETAT_SUIVANT[d.etat];
  const p = d.etat === "BON" ? m.pBonVersMoyen : d.etat === "MOYEN" ? m.pMoyenVersMauvais : d.etat === "MAUVAIS" ? m.pMauvaisVersCritique : 0;
  if (!Number.isFinite(p) || p < 0 || p > 1) return { ok: false, motif: `probabilite de transition hors de [0 ; 1] dans la matrice (${d.familleRevetement}, ${d.classeTrafic})` };
  // 1 - (1 - p)^H par produits successifs : pas de Math.pow, pour un resultat identique partout.
  let reste = 1;
  for (let i = 0; i < d.horizonAnnees; i++) reste *= 1 - p;
  return {
    ok: true,
    etatCourant: d.etat,
    etatSuivant: suivant,
    pAnnuelle: p,
    horizonAnnees: d.horizonAnnees,
    pHorizon: arrondi4(1 - reste),
    matrice: { familleRevetement: m.familleRevetement, classeTrafic: m.classeTrafic, version: m.version ?? null, approuvee: m.approuveLe !== null && m.approuveLe !== undefined },
  };
}

export type CodeRefusTraitement = "FAMILLE_COUT_ABSENTE" | "AUCUNE_CONDITION" | "CONDITIONS_AMBIGUES" | "TRAITEMENT_ABSENT_DU_CATALOGUE";

export type ChoixTraitement =
  | {
      ok: true;
      traitement: { code: string; libelle: string; famille: string; version: number | null; approuve: boolean };
      /** `exacte` si la condition porte la classe de trafic du troncon ; `generale` si elle ne la distingue pas. */
      condition: { portee: "exacte" | "generale"; classeTrafic: string | null };
      /** Attributs du catalogue qui sont nuls : non utilises, et dits tels. */
      attributsNonRenseignes: string[];
    }
  | { ok: false; code: CodeRefusTraitement; motif: string };

/**
 * Applique la matrice d'orientation (famille, etat, classe de trafic) vers un traitement.
 *
 * Une condition de classe nulle vaut « toute classe » ; une condition qui nomme la classe du
 * troncon l'emporte sur elle. Deux traitements encore possibles apres cela = refus.
 */
export function choisirTraitement(
  d: { familleRevetement: string | null; etat: string; classeTrafic: ClasseTrafic | null },
  catalogue: readonly Traitement[],
  conditions: readonly ConditionTraitement[],
): ChoixTraitement {
  if (d.familleRevetement === null) {
    return { ok: false, code: "FAMILLE_COUT_ABSENTE", motif: "revetement sans famille de cout : le troncon ne se traite pas sur une base chiffrable" };
  }
  const candidates = conditions.filter((c) =>
    c.actif !== false && c.familleRevetement === d.familleRevetement && c.etatDepart === d.etat
    && (c.classeTrafic === null || c.classeTrafic === undefined || c.classeTrafic === d.classeTrafic));
  if (candidates.length === 0) {
    return { ok: false, code: "AUCUNE_CONDITION", motif: `aucune condition d'application pour (${d.familleRevetement}, ${d.etat}${d.classeTrafic ? `, ${d.classeTrafic}` : ""}) : pas de traitement prevu` };
  }
  const exactes = candidates.filter((c) => c.classeTrafic !== null && c.classeTrafic !== undefined);
  const retenues = exactes.length > 0 ? exactes : candidates;
  const codes = [...new Set(retenues.map((c) => c.traitementCode))].sort();
  if (codes.length > 1) {
    return { ok: false, code: "CONDITIONS_AMBIGUES", motif: `plusieurs traitements possibles (${codes.join(", ")}) : la matrice doit etre une fonction, le moteur ne choisit pas` };
  }
  const t = catalogue.find((x) => x.code === codes[0] && x.actif !== false);
  if (!t) {
    return { ok: false, code: "TRAITEMENT_ABSENT_DU_CATALOGUE", motif: `le traitement ${codes[0]} est designe par une condition mais absent ou inactif au catalogue` };
  }
  const nonRenseignes: string[] = [];
  if (t.dureeVieAttendueAns === null || t.dureeVieAttendueAns === undefined) nonRenseignes.push("dureeVieAttendueAns");
  if (t.effetSurIndice === null || t.effetSurIndice === undefined) nonRenseignes.push("effetSurIndice");
  if (t.fenetreRealisation === null || t.fenetreRealisation === undefined) nonRenseignes.push("fenetreRealisation");
  return {
    ok: true,
    traitement: { code: t.code, libelle: t.libelle, famille: t.famille, version: t.version ?? null, approuve: t.approuveLe !== null && t.approuveLe !== undefined },
    condition: { portee: exactes.length > 0 ? "exacte" : "generale", classeTrafic: exactes.length > 0 ? (exactes[0].classeTrafic ?? null) : null },
    attributsNonRenseignes: nonRenseignes,
  };
}

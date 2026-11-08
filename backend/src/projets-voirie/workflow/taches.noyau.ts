/**
 * TACHES : ETATS, TRANSITIONS, DROITS ET SEPARATION DES TACHES (noyau pur ; contrat docs/projets-voirie/CONTRAT-WORKFLOW.md, section 5.2).
 *
 *   A_FAIRE -> EN_COURS -> TERMINEE                     (validationRequise = faux)
 *   A_FAIRE -> EN_COURS -> A_VALIDER -> TERMINEE        (validationRequise = vrai)
 *   A_VALIDER -> EN_COURS (refus motive) ; A_FAIRE, EN_COURS, A_VALIDER -> ANNULEE (motif)
 *
 * QUI FAIT QUOI : le RESPONSABLE de la tache (s'il a le droit `tache.executer`) la fait avancer ; `tache.gerer` fait toutes les transitions ;
 * VALIDER (A_VALIDER -> TERMINEE) exige `tache.gerer` ET la separation des taches (noyau commun avec RC-3, `separation.noyau.ts`) : le valideur
 * n'est ni la personne qui a mis la tache a A_VALIDER, ni son responsable, sauf derogation motivee d'un ADMIN.
 */

import { verifierSeparation } from "../separation.noyau";
import { JUSTIFICATION_MIN } from "../conflits/types.noyau";
import { exigerJustification, refus, type Refus } from "./validation.noyau";

export const STATUTS_TACHE = ["A_FAIRE", "EN_COURS", "A_VALIDER", "TERMINEE", "ANNULEE"] as const;
export type StatutTache = (typeof STATUTS_TACHE)[number];
export const STATUTS_TACHE_TERMINAUX: readonly StatutTache[] = ["TERMINEE", "ANNULEE"];
export const PRIORITES_TACHE = ["BASSE", "NORMALE", "HAUTE", "URGENTE"] as const;
export type PrioriteTache = (typeof PRIORITES_TACHE)[number];

type Qui = "RESPONSABLE" | "GERER";

interface DefinitionTransitionTache {
  de: StatutTache;
  vers: StatutTache;
  qui: Qui;
  /** Justification de 10 caracteres exigee. */
  justification: boolean;
  /** `true` : seulement si la validation est requise ; `false` : seulement si elle ne l'est pas ; absent : toujours. */
  siValidationRequise?: boolean;
  /** Valider : separation des taches. */
  separation?: boolean;
}

export const TRANSITIONS_TACHE: readonly DefinitionTransitionTache[] = [
  { de: "A_FAIRE", vers: "EN_COURS", qui: "RESPONSABLE", justification: false },
  { de: "EN_COURS", vers: "A_VALIDER", qui: "RESPONSABLE", justification: true, siValidationRequise: true },
  { de: "EN_COURS", vers: "TERMINEE", qui: "RESPONSABLE", justification: true, siValidationRequise: false },
  { de: "A_VALIDER", vers: "TERMINEE", qui: "GERER", justification: true, separation: true },
  { de: "A_VALIDER", vers: "EN_COURS", qui: "GERER", justification: true },
  { de: "A_FAIRE", vers: "ANNULEE", qui: "GERER", justification: true },
  { de: "EN_COURS", vers: "ANNULEE", qui: "GERER", justification: true },
  { de: "A_VALIDER", vers: "ANNULEE", qui: "GERER", justification: true },
];

export interface EntreeTransitionTache {
  de: StatutTache;
  vers: StatutTache;
  validationRequise: boolean;
  acteurId: string;
  role: string;
  responsableId: string;
  /** Droits de la matrice pour le profil de l'acteur. */
  peutGerer: boolean;
  peutExecuter: boolean;
  justification: string | undefined;
  derogation: string | undefined;
  /** Personne qui a mis la tache a A_VALIDER (derniere fois), pour la separation des taches. */
  aValiderParId: string | null;
}

export type VerdictTransitionTache = { ok: true; justification: string | null; derogation: string | null; transition: DefinitionTransitionTache } | Refus;

/**
 * Ordre des controles (stable, teste) :
 *   1. etat terminal (409 STATUT_INCOMPATIBLE) ; transition inconnue, ou incompatible avec `validationRequise` (409 TRANSITION_INTERDITE) ;
 *   2. droit (403 ACTION_NON_AUTORISEE) : `GERER` exige `tache.gerer` ; `RESPONSABLE` exige `tache.gerer`, ou `tache.executer` ET d'etre le responsable ;
 *   3. justification de 10 caracteres (422) ;
 *   4. valider : separation des taches (409 SEPARATION_DES_TACHES).
 */
export function evaluerTransitionTache(e: EntreeTransitionTache): VerdictTransitionTache {
  if (STATUTS_TACHE_TERMINAUX.includes(e.de)) return refus(409, "STATUT_INCOMPATIBLE", `Cette tâche est ${e.de === "TERMINEE" ? "terminée" : "annulée"} : elle ne change plus (créez une nouvelle tâche).`);
  const tr = TRANSITIONS_TACHE.find((t) => t.de === e.de && t.vers === e.vers && (t.siValidationRequise === undefined || t.siValidationRequise === e.validationRequise));
  if (!tr) {
    const parValidation = TRANSITIONS_TACHE.some((t) => t.de === e.de && t.vers === e.vers);
    return refus(409, "TRANSITION_INTERDITE", parValidation
      ? (e.validationRequise ? "Cette tâche exige une validation : passez par A_VALIDER avant TERMINEE." : "Cette tâche n'exige pas de validation : passez directement à TERMINEE.")
      : `La transition ${e.de} vers ${e.vers} n'existe pas.`);
  }
  const autorise = tr.qui === "GERER" ? e.peutGerer : e.peutGerer || (e.peutExecuter && e.acteurId === e.responsableId);
  if (!autorise) {
    return refus(403, "ACTION_NON_AUTORISEE", tr.qui === "GERER"
      ? "Cette transition est réservée aux comptes qui gèrent les tâches du projet."
      : "Seul le responsable de la tâche (ou un compte qui gère les tâches du projet) la fait avancer.");
  }
  if (tr.justification) { const j = exigerJustification(e.justification); if (j) return j; }
  let derogation: string | null = null;
  if (tr.separation) {
    const message = `La validation d'une tâche ne peut être faite ni par la personne qui l'a soumise à validation, ni par son responsable, sauf dérogation motivée d'un administrateur (${JUSTIFICATION_MIN} caractères au moins).`;
    const s = verifierSeparation({
      acteurId: e.acteurId, role: e.role, auteursIds: [e.aValiderParId, e.responsableId], derogation: e.derogation, adminExige: true,
      messageSansDerogation: message, messageAdminExige: message,
    });
    if (!s.ok) return s;
    derogation = s.derogation;
  }
  return { ok: true, justification: (e.justification ?? "").trim() || null, derogation, transition: tr };
}

export interface TransitionTachePossible { vers: StatutTache; justificationRequise: boolean; separation: boolean }

/** Transitions que l'acteur peut tenter maintenant (pour l'interface) ; le service les reverifie. */
export function transitionsTachePossibles(e: {
  de: StatutTache; validationRequise: boolean; acteurId: string; responsableId: string; peutGerer: boolean; peutExecuter: boolean;
}): TransitionTachePossible[] {
  if (STATUTS_TACHE_TERMINAUX.includes(e.de)) return [];
  return TRANSITIONS_TACHE
    .filter((t) => t.de === e.de && (t.siValidationRequise === undefined || t.siValidationRequise === e.validationRequise))
    .filter((t) => (t.qui === "GERER" ? e.peutGerer : e.peutGerer || (e.peutExecuter && e.acteurId === e.responsableId)))
    .map((t) => ({ vers: t.vers, justificationRequise: t.justification, separation: t.separation === true }));
}

/**
 * Un RESPONSABLE doit etre un compte actif avec la cle de module (`verifierResponsable` de RC-3 pour ces deux controles) ET etre en mesure d'agir :
 * ADMIN, GESTIONNAIRE, INSPECTEUR, ou un referent rattache au concessionnaire de la tache. Un LECTEUR non rattache ne modifie rien : il ne peut pas
 * etre responsable ; un referent d'un autre concessionnaire (ou d'une tache sans concessionnaire) non plus.
 */
export function responsableHabilite(e: {
  role: string; referentDuConcessionnaire: boolean; aDesRattachements: boolean; tacheConcessionnaireId: string | null;
}): { ok: true } | Refus {
  if (e.aDesRattachements) {
    return e.tacheConcessionnaireId !== null && e.referentDuConcessionnaire
      ? { ok: true }
      : refus(422, "RESPONSABLE_NON_HABILITE", "Ce compte est référent d'un autre concessionnaire : il ne peut être responsable que d'une tâche de son concessionnaire.");
  }
  if (e.role === "ADMIN" || e.role === "GESTIONNAIRE" || e.role === "INSPECTEUR") return { ok: true };
  return refus(422, "RESPONSABLE_NON_HABILITE", "Un compte en lecture seule ne peut pas être responsable d'une tâche.");
}

/**
 * RECOLEMENT (AS-BUILT) : ETATS, TRANSITIONS, ELIGIBILITE ET VALIDATION PAR UN TIERS (noyau pur ; contrat docs/projets-voirie/CONTRAT-WORKFLOW.md,
 * sections 5.3 et 7).
 *
 *   BROUILLON -> SOUMIS -> VALIDE (terminal) ; SOUMIS -> REJETE -> BROUILLON ; SOUMIS -> BROUILLON (retrait).
 *
 * VALIDER UN RECOLEMENT NE MODIFIE NI LE REFERENTIEL OFFICIEL, NI UN JEU, NI LE CONFLIT : c'est l'attestation d'un dossier, qui sert de pre-requis
 * a la cloture d'un conflit a deplacement decide. La validation est faite par un TIERS (separation des taches, noyau commun avec RC-3).
 */

import { verifierSeparation } from "../separation.noyau";
import { JUSTIFICATION_MIN } from "../conflits/types.noyau";
import { decisionsEnVigueur } from "../conflits/etats.noyau";
import { exigerJustification, refus, type Refus } from "./validation.noyau";

export const STATUTS_RECOLEMENT = ["BROUILLON", "SOUMIS", "VALIDE", "REJETE"] as const;
export type StatutRecolement = (typeof STATUTS_RECOLEMENT)[number];

type Droit = "ECRIRE" | "VALIDER";

export const TRANSITIONS_RECOLEMENT: readonly { de: StatutRecolement; vers: StatutRecolement; droit: Droit }[] = [
  { de: "BROUILLON", vers: "SOUMIS", droit: "ECRIRE" },
  { de: "SOUMIS", vers: "VALIDE", droit: "VALIDER" },
  { de: "SOUMIS", vers: "REJETE", droit: "VALIDER" },
  { de: "SOUMIS", vers: "BROUILLON", droit: "ECRIRE" },
  { de: "REJETE", vers: "BROUILLON", droit: "ECRIRE" },
];

/** Types de preuve qui comptent pour valider : une simple NOTE n'atteste rien. */
export const TYPES_PREUVE_SUFFISANTE = ["REFERENCE_DOCUMENT", "COURRIER", "REPONSE_CONCESSIONNAIRE", "PLAN_RECOLEMENT", "RELEVE_TERRAIN"] as const;

export interface EntreeTransitionRecolement {
  de: StatutRecolement;
  vers: StatutRecolement;
  acteurId: string;
  role: string;
  peutEcrire: boolean;
  peutValider: boolean;
  justification: string | undefined;
  derogation: string | undefined;
  objet: string;
  constat: string | null;
  /** Nombre de preuves qui comptent (types de `TYPES_PREUVE_SUFFISANTE`). */
  nbPreuvesSuffisantes: number;
  /** Createur, soumissionnaire courant et auteurs de modifications : le valideur n'en est pas un. */
  auteursIds: readonly (string | null | undefined)[];
}

export type VerdictTransitionRecolement = { ok: true; justification: string; derogation: string | null } | Refus;

/**
 * Ordre des controles (stable, teste) :
 *   1. etat VALIDE : 409 STATUT_INCOMPATIBLE ; transition inconnue : 409 TRANSITION_INTERDITE ;
 *   2. droit (403 ACTION_NON_AUTORISEE) : `recolement.ecrire` ou `recolement.valider` selon la transition ;
 *   3. justification de 10 caracteres (422) ;
 *   4. soumettre : `objet` et `constat` renseignes (422 CHAMPS_INCOMPLETS) ;
 *   5. valider : au moins une preuve qui compte (409 PREUVE_REQUISE), puis separation des taches (409 SEPARATION_DES_TACHES).
 */
export function evaluerTransitionRecolement(e: EntreeTransitionRecolement): VerdictTransitionRecolement {
  if (e.de === "VALIDE") return refus(409, "STATUT_INCOMPATIBLE", "Ce récolement est validé : il ne change plus (créez un nouveau récolement).");
  const tr = TRANSITIONS_RECOLEMENT.find((t) => t.de === e.de && t.vers === e.vers);
  if (!tr) return refus(409, "TRANSITION_INTERDITE", `La transition ${e.de} vers ${e.vers} n'existe pas.`);
  if (!(tr.droit === "VALIDER" ? e.peutValider : e.peutEcrire)) {
    return refus(403, "ACTION_NON_AUTORISEE", tr.droit === "VALIDER" ? "Valider ou rejeter un récolement est réservé aux comptes habilités à le valider." : "Cette transition est réservée aux comptes qui écrivent les récolements du projet.");
  }
  const j = exigerJustification(e.justification);
  if (j) return j;
  if (e.vers === "SOUMIS" && (e.objet.trim().length === 0 || (e.constat ?? "").trim().length === 0)) {
    return refus(422, "CHAMPS_INCOMPLETS", "Un récolement soumis doit avoir un objet et un constat renseignés.");
  }
  let derogation: string | null = null;
  if (e.vers === "VALIDE") {
    if (e.nbPreuvesSuffisantes < 1) {
      return refus(409, "PREUVE_REQUISE", "Au moins une preuve (plan de récolement, référence de document, courrier, réponse du concessionnaire ou relevé) doit être enregistrée avant de valider : une note ne suffit pas.");
    }
    const message = `Un récolement doit être validé par un tiers : ni son créateur, ni la personne qui l'a soumis, ni l'auteur d'une modification, sauf dérogation motivée d'un administrateur (${JUSTIFICATION_MIN} caractères au moins).`;
    const s = verifierSeparation({
      acteurId: e.acteurId, role: e.role, auteursIds: e.auteursIds, derogation: e.derogation, adminExige: true,
      messageSansDerogation: message, messageAdminExige: message,
    });
    if (!s.ok) return s;
    derogation = s.derogation;
  }
  return { ok: true, justification: (e.justification ?? "").trim(), derogation };
}

export interface TransitionRecolementPossible { vers: StatutRecolement; droit: Droit }

export function transitionsRecolementPossibles(e: { de: StatutRecolement; peutEcrire: boolean; peutValider: boolean }): TransitionRecolementPossible[] {
  return TRANSITIONS_RECOLEMENT.filter((t) => t.de === e.de && (t.droit === "VALIDER" ? e.peutValider : e.peutEcrire)).map((t) => ({ vers: t.vers, droit: t.droit }));
}

/**
 * Un recolement se rattache a un conflit dont un DEPLACEMENT est decide : statut TRAITEMENT_DECIDE ou CLOTURE (un dossier clos avec la mention
 * « recolement a valider » en recoit un apres coup) ET une decision DEPLACER_RESEAU approuvee EN VIGUEUR (depuis la derniere confirmation du
 * dossier : meme regle que la cloture de RC-3, `decisionsEnVigueur`).
 */
export function conflitEligible(e: {
  statut: string;
  decisions: readonly { id: string; option: string; statut: string; proposeParId: string; approuveLe: Date | null }[];
  dernierPassageConfirmeLe: Date | null;
}): { ok: true } | Refus {
  if (e.statut !== "TRAITEMENT_DECIDE" && e.statut !== "CLOTURE") {
    return refus(422, "CONFLIT_NON_ELIGIBLE", `Un récolement se rattache à un conflit dont un déplacement est décidé (statut TRAITEMENT_DECIDE ou CLOTURE) ; statut actuel : ${e.statut}.`);
  }
  const approuvees = e.decisions.filter((d) => d.statut === "APPROUVEE").map((d) => ({ id: d.id, option: d.option as never, proposeParId: d.proposeParId, approuveLe: d.approuveLe }));
  if (!decisionsEnVigueur(approuvees, e.dernierPassageConfirmeLe).some((d) => d.option === "DEPLACER_RESEAU")) {
    return refus(422, "CONFLIT_NON_ELIGIBLE", "Aucune décision de déplacement de réseau (DEPLACER_RESEAU) n'est approuvée en vigueur sur ce conflit : il n'y a pas de récolement à faire.");
  }
  return { ok: true };
}

/**
 * Concessionnaire d'un recolement : celui du conflit, sinon celui du jeu. S'ils sont tous deux connus et different : 422 CONCESSIONNAIRE_INCOHERENT.
 */
export function concessionnaireDuRecolement(conflit: string | null | undefined, jeu: string | null | undefined): { ok: true; concessionnaireId: string | null } | Refus {
  if (conflit && jeu && conflit !== jeu) return refus(422, "CONCESSIONNAIRE_INCOHERENT", "Le conflit et le jeu désignés ne concernent pas le même concessionnaire.");
  return { ok: true, concessionnaireId: conflit ?? jeu ?? null };
}

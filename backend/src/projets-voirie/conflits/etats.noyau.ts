/**
 * MACHINE A ETATS D'UN CONFLIT, SEPARATION DES TACHES ET REGLES DES DECISIONS (noyau pur ; contrat, sections 4 et 6).
 *
 * Un statut ne change que par une transition du tableau 4, jamais par un recalcul. Chaque refus est une erreur TYPEE (statut HTTP et
 * code stable) : le service la rend telle quelle. Rien ici n'est un ordre : une transition enregistre un verdict humain, avec son
 * auteur et sa justification, dans un historique en ajout seul.
 */

import {
  JUSTIFICATION_MIN, STATUTS_CONFLIT, type OptionDecision, type RoleDecideur, type StatutConflit, estDecideur,
} from "./types.noyau";

export interface Refus { ok: false; status: number; code: string; message: string }
const refus = (status: number, code: string, message: string): Refus => ({ ok: false, status, code, message });

// ------------------------------------------------------------------------------------------------
// Tableau 4
// ------------------------------------------------------------------------------------------------

export interface DefinitionTransition {
  de: StatutConflit;
  vers: StatutConflit;
  roles: readonly RoleDecideur[];
  /** Au moins une preuve enregistree. */
  preuveRequise: boolean;
  /** Au moins une decision APPROUVEE. */
  decisionRequise: boolean;
  /** Cloture : motif, auteur identifie, separation des taches, mention du recolement si le deplacement d'un reseau est decide. */
  cloture: boolean;
}

const ADMIN_GEST: readonly RoleDecideur[] = ["ADMIN", "GESTIONNAIRE"];
const ADMIN: readonly RoleDecideur[] = ["ADMIN"];
const t = (de: StatutConflit, vers: StatutConflit, roles: readonly RoleDecideur[], o: Partial<Pick<DefinitionTransition, "preuveRequise" | "decisionRequise" | "cloture">> = {}): DefinitionTransition =>
  ({ de, vers, roles, preuveRequise: false, decisionRequise: false, cloture: false, ...o });

/** Les dix transitions autorisees. Toute autre : 409 TRANSITION_INTERDITE. */
export const TRANSITIONS: readonly DefinitionTransition[] = [
  t("A_INVESTIGUER", "POTENTIEL", ADMIN_GEST),
  t("A_INVESTIGUER", "INFIRME", ADMIN_GEST),
  t("POTENTIEL", "CONFIRME", ADMIN_GEST, { preuveRequise: true }),
  t("POTENTIEL", "INFIRME", ADMIN_GEST),
  t("POTENTIEL", "A_INVESTIGUER", ADMIN_GEST),
  t("CONFIRME", "TRAITEMENT_DECIDE", ADMIN_GEST, { decisionRequise: true }),
  t("CONFIRME", "INFIRME", ADMIN),
  t("TRAITEMENT_DECIDE", "INFIRME", ADMIN),
  t("TRAITEMENT_DECIDE", "CLOTURE", ADMIN, { cloture: true }),
  t("INFIRME", "A_INVESTIGUER", ADMIN_GEST),
];

export const transitionDe = (de: StatutConflit, vers: StatutConflit): DefinitionTransition | undefined =>
  TRANSITIONS.find((x) => x.de === de && x.vers === vers);

export interface DecisionApprouvee {
  id: string; option: OptionDecision; proposeParId: string;
  /** Date de l'approbation (toujours renseignee par la base pour une decision approuvee). */
  approuveLe?: Date | null;
}

/**
 * Decisions approuvees EN VIGUEUR : approuvees APRES le dernier passage du dossier a CONFIRME (revue RC-3, m3). Une approbation qui date
 * d'une confirmation anterieure (le dossier a ete infirme puis rouvert depuis) ne vaut plus : le dossier a ete requalifie, la decision doit
 * etre reprise. Sans date de reference (aucun passage a CONFIRME connu), toutes comptent ; avec une date de reference, une decision dont la
 * date d'approbation est inconnue ne compte pas (prudence).
 */
export function decisionsEnVigueur(decisions: readonly DecisionApprouvee[], dernierPassageConfirmeLe: Date | null | undefined): DecisionApprouvee[] {
  if (!dernierPassageConfirmeLe) return [...decisions];
  const ref = dernierPassageConfirmeLe.getTime();
  return decisions.filter((d) => d.approuveLe !== undefined && d.approuveLe !== null && d.approuveLe.getTime() >= ref);
}

export interface EntreeTransition {
  de: StatutConflit;
  vers: StatutConflit;
  role: string;
  acteurId: string | null;
  justification: string | undefined;
  nbPreuves: number;
  decisionsApprouvees: readonly DecisionApprouvee[];
  /** Date du dernier passage du dossier a CONFIRME (ligne d'historique) : une approbation anterieure est perimee (voir `decisionsEnVigueur`). */
  dernierPassageConfirmeLe?: Date | null;
  /** Cloture : l'utilisateur a explicitement indique que le recolement du reseau deplace reste a valider. */
  recolementAValider?: boolean;
  /** Cloture : qui a place le dossier en TRAITEMENT_DECIDE (la « proposition » de cloture). */
  proposeurClotureId?: string | null;
  derogation?: string;
}

export type VerdictTransition = { ok: true; transition: DefinitionTransition; justification: string; derogation: string | null; recolementMentionne: boolean } | Refus;

const texte = (s: string | undefined) => (s ?? "").trim();

/**
 * Evalue une demande de transition. Ordre des controles (stable, teste) :
 *   1. la transition existe au tableau (409 TRANSITION_INTERDITE, y compris un statut vers lui-meme) ;
 *   2. le role est habilite (403 ROLE_INSUFFISANT) ; un compte non identifie n'agit jamais (403) ;
 *   3. justification d'au moins 10 caracteres (422 JUSTIFICATION_REQUISE) ;
 *   4. preuve requise pour CONFIRME (409 PREUVE_REQUISE) ; decision approuvee requise pour TRAITEMENT_DECIDE (409 DECISION_REQUISE) ;
 *   5. cloture : mention du recolement si DEPLACER_RESEAU (422 MENTION_RECOLEMENT_REQUISE), puis separation des taches (409).
 */
export function evaluerTransition(e: EntreeTransition): VerdictTransition {
  const tr = transitionDe(e.de, e.vers);
  if (!tr) return refus(409, "TRANSITION_INTERDITE", `La transition ${e.de} vers ${e.vers} n'existe pas.`);
  if (!e.acteurId || !estDecideur(e.role) || !tr.roles.includes(e.role)) {
    return refus(403, "ROLE_INSUFFISANT", `Cette transition est réservée à : ${tr.roles.join(", ")}.`);
  }
  const justification = texte(e.justification);
  if (justification.length < JUSTIFICATION_MIN) {
    return refus(422, "JUSTIFICATION_REQUISE", `Une justification de ${JUSTIFICATION_MIN} caractères au moins est requise.`);
  }
  if (tr.preuveRequise && e.nbPreuves < 1) {
    return refus(409, "PREUVE_REQUISE", "Au moins une preuve doit être enregistrée avant de confirmer un conflit.");
  }
  const enVigueur = decisionsEnVigueur(e.decisionsApprouvees, e.dernierPassageConfirmeLe);
  if (tr.decisionRequise && enVigueur.length < 1) {
    return refus(409, "DECISION_REQUISE", e.decisionsApprouvees.length > 0
      ? "Les décisions approuvées datent d'une confirmation antérieure du conflit : une décision doit être approuvée depuis la dernière confirmation."
      : "Une décision approuvée est requise avant de passer le conflit en traitement décidé.");
  }
  let derogation: string | null = null;
  let recolementMentionne = false;
  if (tr.cloture) {
    if (enVigueur.some((d) => d.option === "DEPLACER_RESEAU")) {
      if (e.recolementAValider !== true) {
        return refus(422, "MENTION_RECOLEMENT_REQUISE", "Le déplacement d'un réseau est décidé : indiquez explicitement que le récolement reste à valider (il n'est pas géré dans ce lot).");
      }
      recolementMentionne = true;
    }
    const sep = verifierSeparationCloture({ acteurId: e.acteurId, role: e.role, proposeurClotureId: e.proposeurClotureId ?? null, derogation: e.derogation });
    if (!sep.ok) return sep;
    derogation = sep.derogation;
  }
  return { ok: true, transition: tr, justification, derogation, recolementMentionne };
}

// ------------------------------------------------------------------------------------------------
// Separation des taches
// ------------------------------------------------------------------------------------------------

export type VerdictSeparation = { ok: true; derogation: string | null } | Refus;

const separation = (msg: string) => refus(409, "SEPARATION_DES_TACHES", msg);

/**
 * Approbation (ou refus) d'une decision par `acteur`.
 *   - personne differente de celle qui l'a proposee : autorise, sans derogation ;
 *   - MEME personne : une derogation motivee (10 caracteres au moins) est exigee, et pour DEPLACER_RESEAU elle doit etre donnee par un
 *     ADMIN ; pour les autres options la meme exigence vaut des qu'il existe au moins DEUX comptes habilites (`nbHabilites`) ; s'il
 *     n'y en a qu'un, la derogation motivee suffit, quel que soit son role.
 */
export function verifierSeparationDecision(e: {
  option: OptionDecision; proposeurId: string; acteurId: string; role: string; nbHabilites: number; derogation: string | undefined;
}): VerdictSeparation {
  if (e.acteurId !== e.proposeurId) return { ok: true, derogation: null };
  const d = texte(e.derogation);
  const adminExige = e.option === "DEPLACER_RESEAU" || e.nbHabilites >= 2;
  if (d.length < JUSTIFICATION_MIN) {
    return separation(`La personne qui a proposé une décision ne peut pas la trancher elle-même sans dérogation motivée (${JUSTIFICATION_MIN} caractères au moins).`);
  }
  if (adminExige && e.role !== "ADMIN") {
    return separation(e.option === "DEPLACER_RESEAU"
      ? "Le déplacement d'un réseau ne peut être approuvé par son proposant que par une dérogation d'un administrateur."
      : "Plusieurs comptes habilités existent : seul un administrateur peut déroger à la séparation des tâches.");
  }
  return { ok: true, derogation: d };
}

/** Cloture : la personne qui a place le dossier en TRAITEMENT_DECIDE ne le cloture pas sans derogation motivee d'un ADMIN. */
export function verifierSeparationCloture(e: { acteurId: string; role: string; proposeurClotureId: string | null; derogation: string | undefined }): VerdictSeparation {
  if (e.proposeurClotureId === null || e.acteurId !== e.proposeurClotureId) return { ok: true, derogation: null };
  const d = texte(e.derogation);
  if (d.length < JUSTIFICATION_MIN || e.role !== "ADMIN") {
    return separation(`La clôture ne peut pas être approuvée par la personne qui a placé le dossier en traitement décidé, sauf dérogation motivée d'un administrateur (${JUSTIFICATION_MIN} caractères au moins).`);
  }
  return { ok: true, derogation: d };
}

// ------------------------------------------------------------------------------------------------
// Decisions
// ------------------------------------------------------------------------------------------------

export interface EntreePropositionDecision {
  statutConflit: StatutConflit;
  option: OptionDecision;
  justification: string | undefined;
  dateDebutPrevue: string | null | undefined;
  dateFinPrevue: string | null | undefined;
  responsableId: string | null;
}

/**
 * Une decision se propose pour un conflit CONFIRME (409 STATUT_INCOMPATIBLE sinon), avec une justification (422). Deplacer un reseau
 * exige un RESPONSABLE (422 RESPONSABLE_REQUIS) et un PLANNING complet, debut et fin (422 PLANNING_REQUIS) : AT-09.
 */
export function verifierPropositionDecision(e: EntreePropositionDecision): { ok: true; justification: string } | Refus {
  if (e.statutConflit !== "CONFIRME") {
    return refus(409, "STATUT_INCOMPATIBLE", `Une décision ne se propose que pour un conflit confirmé (statut actuel : ${e.statutConflit}).`);
  }
  const justification = texte(e.justification);
  if (justification.length < JUSTIFICATION_MIN) {
    return refus(422, "JUSTIFICATION_REQUISE", `Une justification de ${JUSTIFICATION_MIN} caractères au moins est requise.`);
  }
  if (e.option === "DEPLACER_RESEAU") {
    if (!e.responsableId) return refus(422, "RESPONSABLE_REQUIS", "Un responsable doit être désigné sur le dossier avant de proposer le déplacement d'un réseau.");
    if (!e.dateDebutPrevue || !e.dateFinPrevue) return refus(422, "PLANNING_REQUIS", "Le déplacement d'un réseau exige un planning : date de début et date de fin prévues.");
  }
  if (e.dateDebutPrevue && e.dateFinPrevue && e.dateFinPrevue < e.dateDebutPrevue) {
    return refus(422, "PLANNING_REQUIS", "La date de fin prévue ne peut pas précéder la date de début prévue.");
  }
  return { ok: true, justification };
}

/** Approuver ou refuser : la decision doit etre PROPOSEE (409 DECISION_DEJA_TRANCHEE), le motif d'au moins 10 caracteres (422). */
export function verifierTranchage(e: { statutDecision: string; motif: string | undefined }): { ok: true; motif: string } | Refus {
  if (e.statutDecision !== "PROPOSEE") return refus(409, "DECISION_DEJA_TRANCHEE", `Cette décision est déjà ${e.statutDecision === "APPROUVEE" ? "approuvée" : e.statutDecision === "REFUSEE" ? "refusée" : "annulée"} : elle ne change plus.`);
  const motif = texte(e.motif);
  if (motif.length < JUSTIFICATION_MIN) return refus(422, "JUSTIFICATION_REQUISE", `Un motif de ${JUSTIFICATION_MIN} caractères au moins est requis.`);
  return { ok: true, motif };
}

// ------------------------------------------------------------------------------------------------
// Modification du dossier (attribution) : dossier clos, responsable d'un deplacement de reseau (revue RC-3, m4)
// ------------------------------------------------------------------------------------------------

export interface EntreeModification {
  statut: StatutConflit;
  /** Vrai si le PATCH touche au responsable, a l'echeance, au risque ou a l'action proposee (hors acquittement du re-examen). */
  modifieChampsHumains: boolean;
  /** Vrai si le PATCH retire le responsable (`responsableId: null`) alors qu'il y en avait un. */
  retireLeResponsable: boolean;
  /** Vrai si une decision DEPLACER_RESEAU du dossier est PROPOSEE ou APPROUVEE. */
  deplacementPropose: boolean;
}

/**
 * - un dossier CLOTURE ne se modifie plus (409 STATUT_INCOMPATIBLE), sauf l'acquittement d'un re-examen ;
 * - AT-09 : tant qu'une decision de deplacement de reseau est proposee ou approuvee, le dossier garde un responsable (422 RESPONSABLE_REQUIS).
 *   Le controle de la proposition (`verifierPropositionDecision`) ne suffisait pas : le responsable pouvait etre efface apres coup.
 */
export function verifierModificationDossier(e: EntreeModification): { ok: true } | Refus {
  if (e.statut === "CLOTURE" && e.modifieChampsHumains) {
    return refus(409, "STATUT_INCOMPATIBLE", "Ce dossier est clôturé : ni le responsable, ni l'échéance, ni le risque, ni l'action proposée ne se modifient plus.");
  }
  if (e.retireLeResponsable && e.deplacementPropose) {
    return refus(422, "RESPONSABLE_REQUIS", "Une décision de déplacement de réseau est proposée ou approuvée sur ce dossier : un responsable doit rester désigné (vous pouvez en désigner un autre).");
  }
  return { ok: true };
}

/**
 * Un responsable est un compte ACTIF qui a la cle du module `projets-voirie` (un ADMIN l'a toujours, comme pour `requireModuleAccess`).
 * Le perimetre territorial n'est pas controle (decision documentee, section 9.19 du contrat).
 */
export function verifierResponsable(e: { actif: boolean; role: string; modulesAutorises: readonly string[] }): { ok: true } | Refus {
  if (!e.actif) return refus(422, "RESPONSABLE_NON_HABILITE", "Le responsable désigné n'est pas un compte actif.");
  if (e.role !== "ADMIN" && !e.modulesAutorises.includes("projets-voirie")) {
    return refus(422, "RESPONSABLE_NON_HABILITE", "Le responsable désigné n'a pas accès au module Projets de voirie et réseaux.");
  }
  return { ok: true };
}

// ------------------------------------------------------------------------------------------------
// Transitions possibles, pour la fiche (aucune action « deplacer » ni « ordonner » n'existe)
// ------------------------------------------------------------------------------------------------

export interface TransitionPossible {
  vers: StatutConflit;
  justificationRequise: true;
  preuveRequise: boolean;
  decisionRequise: boolean;
  cloture: boolean;
  /** Code de l'erreur que la transition rendrait maintenant faute de preuve ou de decision ; nul si elle est faisable. */
  bloquee: "PREUVE_REQUISE" | "DECISION_REQUISE" | null;
}

/** Transitions que `role` peut tenter depuis `de`, avec ce qui les bloquerait aujourd'hui. Vide pour un compte qui ne decide pas. */
export function transitionsPossibles(e: { de: StatutConflit; role: string; nbPreuves: number; nbDecisionsApprouvees: number }): TransitionPossible[] {
  if (!estDecideur(e.role)) return [];
  return TRANSITIONS.filter((x) => x.de === e.de && x.roles.includes(e.role as RoleDecideur)).map((x) => ({
    vers: x.vers,
    justificationRequise: true as const,
    preuveRequise: x.preuveRequise,
    decisionRequise: x.decisionRequise,
    cloture: x.cloture,
    bloquee: x.preuveRequise && e.nbPreuves < 1 ? "PREUVE_REQUISE" as const : x.decisionRequise && e.nbDecisionsApprouvees < 1 ? "DECISION_REQUISE" as const : null,
  }));
}

/** Garde de coherence : tous les statuts du tableau existent dans l'enumeration (utilise par les tests). */
export const STATUTS_DU_TABLEAU = new Set(TRANSITIONS.flatMap((x) => [x.de, x.vers]));
export const estStatutConnu = (s: string): s is StatutConflit => (STATUTS_CONFLIT as readonly string[]).includes(s);

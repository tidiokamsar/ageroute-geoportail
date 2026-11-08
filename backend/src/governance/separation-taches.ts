import { EXPLICATIONS, ROLES_VALIDATEURS, type RefusValidation } from "./validation";

/**
 * SEPARATION DES TACHES du module Aide a la decision (AD-07, CONTRAT-AD.md section 2).
 *
 * LA REGLE
 *
 * Celui qui approuve un objet de programmation (version de poids, bareme, fiche d'intervention, prevision retenue)
 * n'est jamais celui qui l'a produit, quel que soit son role : un ADMIN n'echappe pas a la regle. C'est la
 * meme regle que `validationPermise` (governance/validation.ts), avec le MEME code stable `AUTO_VALIDATION` et le meme
 * texte d'explication.
 *
 * POURQUOI UNE FONCTION A COTE DE `validationPermise` ET NON UNE EXTENSION DE `ENTITES_VALIDABLES`
 *
 * `validationPermise` juge une DECISION sur un objet qui porte un `statutValidation` (A_VALIDER, VALIDE, ...) et dont
 * chaque type est un DOMAINE de delegation (`DOMAINES_VALIDATION`, ecran de gouvernance) : un test impose meme qu'il y
 * ait autant de domaines que d'entites. Les objets de programmation n'ont pas ce statut (une version de poids est
 * approuvee ou non, une fiche suit son propre cycle de vie) et designer un validateur sur ces domaines n'aurait aucun
 * effet : l'ecran de gouvernance proposerait une case qui ne change rien. On ajoute donc un ensemble DISTINCT et une
 * fonction qui ne reprend que ce qui est commun : le role habilite, la separation auteur / approbateur, le code et le
 * texte du refus.
 *
 * LES INTERVENANTS, PAS SEULEMENT L'AUTEUR
 *
 * Une fiche passe par BROUILLON (figee par A), PROPOSE, ARBITRE, APPROUVE. Si seul A etait oppose a l'approbateur, B
 * pourrait proposer, arbitrer et approuver seul : un deuxieme regard sur trois etapes. On oppose donc l'approbateur a
 * TOUS ceux qui sont intervenus avant lui ; l'explication nomme l'etape en cause pour que l'agent sache quoi faire
 * (faire approuver par un autre compte).
 *
 * UN OBJET SANS AUTEUR (version amorcee par migration) n'a personne a opposer : meme exception que dans
 * `validationPermise`, pour la meme raison.
 */

/**
 * Types d'objets dont l'approbation est soumise a la separation des taches : UNIQUEMENT ceux qui ont un point d'approbation
 * reel, c'est-a-dire une route qui appelle `approbationPermise` avec ce type.
 *
 *   ParametresProgrammation  moteur.service `approuverParametres`
 *   BaremeIntervention       api-v2/baremes.routes (approbation d'une version)
 *   FicheIntervention        moteur.service `changerStatutFiche` vers APPROUVE
 *   ProgrammeBudgetaire      api-v2/programmation.routes (passage a RETENU)
 *
 * `ScenarioProgrammation` N'Y EST PAS : un scenario (moteur ou simulateur) n'a AUCUN statut d'approbation, il est calcule,
 * scelle, rejouable et supprimable (SIMULATEUR.md paragraphe 8 : « un scenario n'a pas de statut d'approbation »). L'y laisser
 * affichait un double controle qui ne controlait rien. Le jour ou un workflow d'approbation de scenario existe, il ajoutera
 * son type ici EN MEME TEMPS que son appel a `approbationPermise` (un type absent est refuse : ENTITE_NON_VALIDABLE).
 */
export const ENTITES_A_DOUBLE_CONTROLE: ReadonlySet<string> = new Set([
  "ParametresProgrammation",
  "BaremeIntervention",
  "FicheIntervention",
  "ProgrammeBudgetaire",
]);

/** Le texte de `validation.ts`, repris tel quel : un seul message pour la meme regle. */
export const EXPLICATION_AUTO_VALIDATION: string = EXPLICATIONS.AUTO_VALIDATION;

export interface Intervenant {
  /** Compte intervenu avant l'approbation ; nul ou absent = origine sans auteur identifie. */
  id: string | null | undefined;
  /** Ce que ce compte a fait, a l'infinitif passe : « a figé la fiche ». Cite dans le refus. */
  etape: string;
}

export interface DemandeApprobation {
  entityType: string;
  approbateurId: string;
  approbateurRole: string;
  intervenants: readonly Intervenant[];
}

export type RefusApprobation = Extract<RefusValidation, "ENTITE_NON_VALIDABLE" | "ROLE_INSUFFISANT" | "AUTO_VALIDATION">;

export type VerdictApprobation =
  | { permis: true }
  | { permis: false; motif: RefusApprobation; explication: string };

export function approbationPermise(d: DemandeApprobation): VerdictApprobation {
  if (!ENTITES_A_DOUBLE_CONTROLE.has(d.entityType)) {
    return { permis: false, motif: "ENTITE_NON_VALIDABLE", explication: EXPLICATIONS.ENTITE_NON_VALIDABLE };
  }
  if (!ROLES_VALIDATEURS.has(d.approbateurRole)) {
    return { permis: false, motif: "ROLE_INSUFFISANT", explication: EXPLICATIONS.ROLE_INSUFFISANT };
  }
  const enCause = d.intervenants.find((i) => i.id != null && i.id === d.approbateurId);
  if (enCause) {
    return {
      permis: false,
      motif: "AUTO_VALIDATION",
      explication: `${EXPLICATION_AUTO_VALIDATION} Ce compte ${enCause.etape} : un autre compte doit approuver.`,
    };
  }
  return { permis: true };
}

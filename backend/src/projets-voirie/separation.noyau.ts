/**
 * SEPARATION DES TACHES : NOYAU PUR COMMUN (extrait de `conflits/etats.noyau.ts`, lot B3 ; contrat RC-3 section 4, contrat workflow section 5).
 *
 * Principe : la personne qui a PROPOSE, REDIGE ou FAIT un acte sensible ne le TRANCHE pas elle-meme. Si elle est la seule a pouvoir le faire, une
 * DEROGATION motivee (10 caracteres au moins) est exigee, et selon l'acte elle doit etre donnee par un ADMIN.
 *
 * Cette fonction ne contient QUE la regle ; les messages (et donc le comportement observable de RC-3, teste) restent ceux de l'appelant :
 * `verifierSeparationDecision` et `verifierSeparationCloture` (etats.noyau.ts) la deleguent sans changer un mot de leurs refus. Le workflow
 * (validation d'un recolement, d'une tache) l'utilise avec ses propres messages.
 *
 * Ordre des controles (stable, teste) :
 *   1. l'acteur n'est pas l'un des auteurs : autorise, sans derogation ;
 *   2. derogation absente ou trop courte : refus `messageSansDerogation` ;
 *   3. un ADMIN est exige et l'acteur n'en est pas un : refus `messageAdminExige` (par defaut `messageSansDerogation`).
 */

import { JUSTIFICATION_MIN } from "./conflits/types.noyau";

export interface RefusSeparation { ok: false; status: 409; code: "SEPARATION_DES_TACHES"; message: string }
export type VerdictSeparation = { ok: true; derogation: string | null } | RefusSeparation;

export interface EntreeSeparation {
  acteurId: string;
  role: string;
  /** Personnes dont l'acteur doit differer (createur, proposant, soumissionnaire...). Les valeurs nulles sont ignorees. */
  auteursIds: readonly (string | null | undefined)[];
  derogation: string | undefined;
  /** Vrai : la derogation n'est recevable que d'un ADMIN. */
  adminExige: boolean;
  messageSansDerogation: string;
  messageAdminExige?: string;
}

export function verifierSeparation(e: EntreeSeparation): VerdictSeparation {
  if (!e.auteursIds.some((id) => id !== null && id !== undefined && id === e.acteurId)) return { ok: true, derogation: null };
  const d = (e.derogation ?? "").trim();
  const refus = (message: string): RefusSeparation => ({ ok: false, status: 409, code: "SEPARATION_DES_TACHES", message });
  if (d.length < JUSTIFICATION_MIN) return refus(e.messageSansDerogation);
  if (e.adminExige && e.role !== "ADMIN") return refus(e.messageAdminExige ?? e.messageSansDerogation);
  return { ok: true, derogation: d };
}

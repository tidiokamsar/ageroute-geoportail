/**
 * CADENCE ET QUOTAS DE CREATION DU WORKFLOW (noyau pur ; contrat docs/projets-voirie/CONTRAT-WORKFLOW.md, section 9).
 *
 * Une route qui CREE des lignes (demande, tache, recolement, preuve) est un moyen de remplir les tables sans limite. Deux garde-fous :
 *   - CADENCE : au plus `plafond` creations par compte et par projet sur une fenetre glissante de `fenetreS` secondes (429 CADENCE_CREATION,
 *     avec le delai a attendre) ;
 *   - QUOTA : au plus `max` lignes par projet (ou par objet pour les preuves) : 422 QUOTA_ATTEINT.
 * Le calcul est pur : la base fournit les dates des creations recentes ; le service les compte sous un verrou du projet (donc sans course).
 */

import { refus, type Refus } from "./validation.noyau";

export const FENETRE_CADENCE_S = 60;

export type VerdictCadence = { ok: true } | (Refus & { retryAfterS: number });

/**
 * `creationsRecentes` : dates des creations de ce compte sur ce projet dans la fenetre. Si elles atteignent le plafond, la creation est refusee
 * jusqu'a ce que la plus ancienne de celles qui comptent sorte de la fenetre (jamais moins d'une seconde).
 */
export function verifierCadenceCreation(e: { creationsRecentes: readonly Date[]; maintenant: Date; fenetreS?: number; plafond: number }): VerdictCadence {
  const fenetreMs = (e.fenetreS ?? FENETRE_CADENCE_S) * 1000;
  const dansFenetre = e.creationsRecentes.map((d) => d.getTime()).filter((t) => e.maintenant.getTime() - t < fenetreMs).sort((a, b) => b - a);
  if (dansFenetre.length < e.plafond) return { ok: true };
  // Il faut que `dansFenetre.length - plafond + 1` creations sortent de la fenetre : on attend la sortie de la plus ancienne qui compte.
  const pivot = dansFenetre[e.plafond - 1];
  const reste = Math.max(1, Math.ceil((pivot + fenetreMs - e.maintenant.getTime()) / 1000));
  return { ...refus(429, "CADENCE_CREATION", `Trop de créations en ${e.fenetreS ?? FENETRE_CADENCE_S} secondes (${e.plafond} au plus) : réessayez dans ${reste} s.`), retryAfterS: reste };
}

export function verifierQuota(e: { nb: number; max: number; libelle: string }): { ok: true } | Refus {
  return e.nb < e.max ? { ok: true } : refus(422, "QUOTA_ATTEINT", `Le plafond de ${e.max} ${e.libelle} est atteint.`);
}

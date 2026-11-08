/**
 * CADENCE MINIMALE DES ANALYSES PERSISTEES D'UN PROJET (noyau pur ; revue RC-3, m8).
 *
 * Une analyse terminee ecrit une ligne immuable (non supprimable : declencheur) avec son instantane, plus une ligne d'audit, meme si rien
 * n'a change. Sans delai minimal, un compte qui decide peut remplir ces tables sans limite. Une analyse TERMINEE n'est donc acceptee que
 * si la precedente TERMINEE du meme projet date d'au moins `intervalleS` secondes (reglage `PROJETS_VOIRIE_ANALYSE_INTERVALLE_S`, defaut
 * 60 s). Une analyse en ECHEC ne compte pas : apres un delai depasse, on peut recommencer tout de suite.
 */

export type VerdictCadence = { ok: true } | { ok: false; retryAfterS: number };

export function verifierCadence(e: { derniereTermineeLe: Date | null; maintenant: Date; intervalleS: number }): VerdictCadence {
  if (e.intervalleS <= 0 || e.derniereTermineeLe === null) return { ok: true };
  const ecouleS = (e.maintenant.getTime() - e.derniereTermineeLe.getTime()) / 1000;
  // Une horloge qui recule (ecoule negatif) est traitee comme « a l'instant » : on ne laisse jamais passer faute de pouvoir mesurer.
  const reste = e.intervalleS - Math.max(0, ecouleS);
  return reste > 0 ? { ok: false, retryAfterS: Math.max(1, Math.ceil(reste)) } : { ok: true };
}

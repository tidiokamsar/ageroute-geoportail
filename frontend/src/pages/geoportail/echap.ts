/**
 * Vrai si un Echap est destine a une autre boite de dialogue que la fiche cartographique.
 *
 * Les dialogues Radix (Modal, confirmation) ecoutent Echap sur le document sans stopper la
 * propagation : sans ce garde, fermer une confirmation avec Echap fermerait AUSSI la fiche
 * derriere elle, et la saisie qu'elle protegeait serait perdue.
 */
export function echapDansAutreDialogue(e: KeyboardEvent): boolean {
  if (e.defaultPrevented) return true;
  const cible = e.target instanceof Element ? e.target : null;
  return Boolean(cible?.closest('[role="dialog"][data-state="open"], [role="alertdialog"]'));
}

/**
 * LISIBILITE D'UN DOSSIER DE CONFLIT SELON LE STATUT DU JEU DONT IL DEPEND (noyau pur ; contrat, section 9.17 ; revue RC-3, M1).
 *
 * Un dossier depend d'un jeu : le jeu de RESEAU qui l'a produit, ou, pour une couverture insuffisante (qui n'a pas de reseau), le PLAN
 * D'AXES dont la geometrie est portee par le dossier. La regle est celle que la fiche applique depuis l'origine aux `sources` et que le
 * socle applique aux jeux (`statutsVisibles`) :
 *
 *   - un jeu RETIRE n'est montre a PERSONNE ;
 *   - un jeu autre que AUTORISE (recu, controle, rejete, REMPLACE) n'est montre qu'aux roles qui decident (ADMIN, GESTIONNAIRE) ;
 *   - un jeu AUTORISE est montre a tout compte qui a la cle du module.
 *
 * Deux niveaux, pour deux sortes de comptes :
 *
 *   1. DOSSIER VISIBLE. Un compte qui ne decide pas (lecteur, inspecteur...) ne voit un dossier QUE si chaque jeu dont il depend est
 *      AUTORISE. Sinon le dossier n'existe pas pour lui : absent de la liste, du total, des compteurs et des comparaisons, 404 sur la
 *      fiche. Un compte qui decide voit toujours le dossier : c'est l'archive des verdicts, des preuves et des decisions humaines, qui ne
 *      disparait pas avec la donnee.
 *   2. DONNEES DU RESEAU LISIBLES. Tout ce qui vient du jeu (geometrie, boite englobante, identifiant du jeu, objet, mesure, troncons
 *      voisins, type de reseau, concessionnaire, classe de precision, regle appliquee, details du calcul dans l'historique) n'est rendu
 *      que si le jeu n'est pas RETIRE et, pour un compte qui ne decide pas, est AUTORISE. Pour un dossier dont le jeu est RETIRE, meme un
 *      ADMIN ne recoit que l'archive humaine : statut, historique des personnes, preuves, decisions, responsable, echeance.
 *
 * `statuts` : statuts COURANTS des jeux lies au dossier (zero, un ou deux : reseau et/ou axes). Aucun jeu lie : tout est lisible.
 */

import { estDecideur } from "./types.noyau";

/** Le compte voit-il le dossier (liste, total, compteurs, comparaison, fiche) ? */
export function dossierVisible(role: string, statuts: readonly string[]): boolean {
  return estDecideur(role) || statuts.every((s) => s === "AUTORISE");
}

/** Le compte recoit-il les donnees tirees du reseau (geometrie, mesure, objet, jeu...) ? */
export function donneesReseauLisibles(role: string, statuts: readonly string[]): boolean {
  return statuts.every((s) => s !== "RETIRE" && (estDecideur(role) || s === "AUTORISE"));
}

/** Jeu lisible par ce role (une seule valeur) : forme historique de `geometrieVisible` (nul : aucun jeu lie). */
export function jeuLisible(role: string, statutJeu: string | null): boolean {
  return donneesReseauLisibles(role, statutJeu === null ? [] : [statutJeu]);
}

/** Actions d'historique qui portent des details tires du calcul (mesure, jeu, motifs) et non une decision de personne. */
export const ACTIONS_HISTORIQUE_CALCULEES: readonly string[] = ["CREATION", "RETROUVE", "MESURE_MODIFIEE", "REEXAMEN"];

/**
 * Details d'une ligne d'historique selon le compte :
 *   - donnees du reseau non lisibles : les lignes du CALCUL perdent leurs details (mesure, motifs, jeu) ; celles des personnes les gardent ;
 *   - sinon, pour un compte qui ne decide pas, l'identifiant du jeu est retire (un ancien jeu peut avoir ete remplace) ;
 *   - sinon, inchange.
 */
export function donneesHistoriqueVisibles(action: string, donnees: unknown, o: { role: string; reseauLisible: boolean }): unknown {
  if (!o.reseauLisible && ACTIONS_HISTORIQUE_CALCULEES.includes(action)) return { masquees: true };
  if (estDecideur(o.role)) return donnees;
  if (!donnees || typeof donnees !== "object" || Array.isArray(donnees)) return donnees;
  const { jeuReseauId: _omis, ...reste } = donnees as Record<string, unknown>;
  void _omis;
  return reste;
}

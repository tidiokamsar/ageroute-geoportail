import type { ModuleKey } from "../../lib/modules";

/**
 * CONFIDENTIALITE FINANCIERE DES CHANTIERS EN LECTURE (D-C1-1, lot AD-7).
 *
 * LE CONSTAT
 *
 * Les lectures de chantiers (liste, carte, chantiers sans localisation) n'exigent qu'un compte connecte : le patrimoine est
 * lisible par tous (selecteurs, carte, fiche de troncon). Or une ligne de chantier porte le montant du marche, le bailleur,
 * l'entreprise et le numero de contrat. Un LECTEUR sans aucun module lisait donc ces champs, alors que les memes montants
 * sont refuses a un compte sans le module `marches` ou `chantiers`.
 *
 * L'OPTION RETENUE : MASQUER LES CHAMPS, NE PAS FERMER LA ROUTE
 *
 * Fermer les lectures derriere le module `chantiers` aurait casse la carte du Geoportail et le selecteur de chantiers pour
 * tous les comptes qui n'ont pas ce module ; or ils n'ont besoin ni du montant ni de l'entreprise pour afficher ou choisir
 * un chantier. On garde donc les routes ouvertes et on REMPLACE par `null` les quatre champs financiers pour un compte sans
 * droit financier. Le client traite deja ces champs comme facultatifs (types `string | null`), donc rien ne casse. C'est
 * REVERSIBLE : retirer l'appel au masque rend le comportement d'avant, sans migration.
 *
 * QUI A LE DROIT SUR LES MONTANTS CONTRACTUELS ET LE TITULAIRE (D-C1-1, regle PROVISOIRE, UNE SEULE FONCTION)
 *
 * `droitMontantsContractuels` est la SEULE definition, dans tout le depot, de « qui lit un montant contractuel ou l'identite
 * du titulaire d'un marche ou d'un chantier » : montant, bailleur, numero de contrat, entreprise, montants des marches et des
 * decomptes, et toute colonne financiere d'un export. Les lectures de chantiers, la synthese, le suivi contractuel et les
 * exports (gouverne, selection, scenario) l'appellent ; aucune autre liste de modules ne doit etre ecrite ailleurs.
 *
 * Regle PROVISOIRE : ADMIN, ou module `marches`, ou module `chantiers`. Les estimations de PROGRAMMATION (previsionnel,
 * scenarios de simulation) relevent du module `programmation`, qui n'ouvre AUCUN montant contractuel ; le module `decision`
 * seul non plus : il donne la lecture de l'ecran, pas les montants des marches. L'ancienne liste (`chantiers`, `marches`,
 * `programmation`, `decision`) ne servait qu'aux lectures de chantiers, alors que la synthese, le suivi contractuel et les
 * exports n'exigeaient que `marches` : un compte `decision` ou `programmation` seul lisait entreprise et montant par les
 * chantiers. DECISION METIER EN ATTENTE (D-C1-1) : a confirmer avec AGEROUTE.
 *
 * `null` ET NON L'ABSENCE DU CHAMP : un client qui lit `montantGnf` recoit « inconnu pour ce compte », pas une cle manquante
 * qu'il pourrait confondre avec « chantier sans montant ». Aucun zero n'est fabrique.
 */

export const CHAMPS_FINANCIERS_CHANTIER = ["montantGnf", "bailleur", "numContrat", "entreprise"] as const;

export const MODULES_MONTANTS_CONTRACTUELS: readonly ModuleKey[] = ["marches", "chantiers"];

/**
 * LA regle (PROVISOIRE) des montants contractuels et de l'identite du titulaire. `modules` = resultat de `modulesAutorisesDe` :
 * `null` pour ADMIN (aucune restriction), sinon l'ensemble accorde.
 */
export function droitMontantsContractuels(modules: ReadonlySet<ModuleKey> | null): boolean {
  return modules === null || MODULES_MONTANTS_CONTRACTUELS.some((m) => modules.has(m));
}

/** Copie de la ligne dont les champs financiers PRESENTS sont remplaces par `null` ; les autres champs sont intacts. */
export function masquerFinancesChantier<T extends object>(ligne: T): T {
  const copie: Record<string, unknown> = { ...(ligne as Record<string, unknown>) };
  for (const champ of CHAMPS_FINANCIERS_CHANTIER) if (champ in copie) copie[champ] = null;
  return copie as T;
}

export function masquerFinancesChantiers<T extends object>(lignes: readonly T[]): T[] {
  return lignes.map(masquerFinancesChantier);
}

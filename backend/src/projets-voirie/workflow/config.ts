/**
 * Reglages du workflow (lot B3) : plafonds, cadence, matrice des droits, recolement obligatoire. Variables d'environnement BORNEES : une valeur
 * absente, illisible ou hors bornes redonne le defaut (meme lecteur que le socle, `borneEnv`). Voir docs/projets-voirie/CONTRAT-WORKFLOW.md, 3.3 et 9.
 *
 *   PROJETS_VOIRIE_WORKFLOW_CREATIONS_PAR_MINUTE  defaut 30    (bornes 1 a 600)       creations par compte et par projet sur 60 s (429 CADENCE_CREATION)
 *   PROJETS_VOIRIE_WORKFLOW_DEMANDES_MAX          defaut 2000  (bornes 100 a 100 000) demandes par projet (422 QUOTA_ATTEINT)
 *   PROJETS_VOIRIE_WORKFLOW_TACHES_MAX            defaut 5000  (bornes 100 a 100 000) taches par projet
 *   PROJETS_VOIRIE_WORKFLOW_RECOLEMENTS_MAX       defaut 500   (bornes 10 a 10 000)   recolements par projet
 *   PROJETS_VOIRIE_WORKFLOW_PREUVES_MAX           defaut 200   (bornes 10 a 5 000)    preuves par objet
 *   PROJETS_VOIRIE_WORKFLOW_MATRICE               JSON         voir profils.noyau.ts
 *   PROJETS_VOIRIE_RECOLEMENT_OBLIGATOIRE         `1` active   la cloture d'un conflit a deplacement decide exige un recolement valide
 *
 * POURQUOI CES DEFAUTS (a valider) : 30 creations par minute et par compte et par projet laissent un travail humain (saisie, import manuel) et
 * coupent un script emballe ; les plafonds par projet (milliers) depassent largement un projet urbain (quelques dizaines de demandes, quelques
 * centaines de taches) tout en bornant la table ; 200 preuves par objet suffisent a un dossier meme tres documente. Aucun n'est un seuil metier.
 */

import { borneEnv } from "../config";
import { lireMatrice, type MatriceLue } from "./profils.noyau";

export const creationsParMinute = () => borneEnv("PROJETS_VOIRIE_WORKFLOW_CREATIONS_PAR_MINUTE", 30, 1, 600);
export const demandesParProjetMax = () => borneEnv("PROJETS_VOIRIE_WORKFLOW_DEMANDES_MAX", 2_000, 100, 100_000);
export const tachesParProjetMax = () => borneEnv("PROJETS_VOIRIE_WORKFLOW_TACHES_MAX", 5_000, 100, 100_000);
export const recolementsParProjetMax = () => borneEnv("PROJETS_VOIRIE_WORKFLOW_RECOLEMENTS_MAX", 500, 10, 10_000);
export const preuvesParObjetMax = () => borneEnv("PROJETS_VOIRIE_WORKFLOW_PREUVES_MAX", 200, 10, 5_000);

/** Recolement valide exige a la cloture d'un dossier a deplacement decide (defaut : non, RC-3 inchange). */
export const recolementObligatoire = (): boolean => process.env.PROJETS_VOIRIE_RECOLEMENT_OBLIGATOIRE === "1";

let memo: { brut: string | undefined; lue: MatriceLue } | null = null;
/** Matrice effective (lue de l'environnement, memorisee tant que la variable ne change pas). */
export function matriceEffective(): MatriceLue {
  const brut = process.env.PROJETS_VOIRIE_WORKFLOW_MATRICE;
  if (!memo || memo.brut !== brut) memo = { brut, lue: lireMatrice(brut) };
  return memo.lue;
}

/**
 * Reglages des reseaux physiques et circuits logiques (lot B1) : tolerances de proposition d'association et bornes. Une valeur absente,
 * illisible ou hors des bornes redonne le defaut : un mauvais reglage ne peut ni supprimer une borne ni la rendre absurde.
 *
 *   PROJETS_VOIRIE_ASSOC_TOLERANCES_M    defaut « A=0.5,B=1,C=2,D=5,INCONNUE=2 » (chaque valeur de 0,01 a 100 m ; toutes les cles A, B, C, D et
 *                                        INCONNUE sont exigees, sinon le defaut s'applique ; la classe E est exclue)
 *   PROJETS_VOIRIE_ASSOC_COUVERTURE_MIN  defaut 0.9 (bornes 0,5 a 1)
 *   PROJETS_VOIRIE_ASSOC_PAR_CIRCUIT_MAX defaut 5 (bornes 1 a 20) : propositions au plus par circuit
 *   PROJETS_VOIRIE_ASSOC_CIRCUITS_MAX    defaut 20 000 (bornes 100 a 100 000) : circuits au plus par execution (422 sinon)
 *
 * LES DEFAUTS SONT PROVISOIRES et a valider par la DSI : le cahier (20.2) dit de ne pas attribuer une precision standard ; ces valeurs sont des
 * tolerances de RAPPROCHEMENT pour proposer une association a une personne, pas des precisions attribuees aux donnees.
 */

import { COUVERTURE_MIN_DEFAUT, TOLERANCES_DEFAUT_M, type TableTolerances } from "./relations.noyau";

const CLES = ["A", "B", "C", "D", "INCONNUE"] as const;

/** Lit « A=0.5,B=1,... » ; toute irregularite (cle manquante, doublon, valeur hors bornes, texte en trop) redonne le defaut. */
export function lireTolerances(brut: string | undefined): TableTolerances {
  if (brut === undefined || brut.trim() === "") return TOLERANCES_DEFAUT_M;
  const t: Partial<Record<(typeof CLES)[number], number>> = {};
  for (const morceau of brut.split(",")) {
    const m = /^\s*(A|B|C|D|INCONNUE)\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*$/.exec(morceau);
    if (!m) return TOLERANCES_DEFAUT_M;
    const cle = m[1] as (typeof CLES)[number];
    const v = Number(m[2]);
    if (cle in t || !(v >= 0.01 && v <= 100)) return TOLERANCES_DEFAUT_M;
    t[cle] = v;
  }
  return CLES.every((c) => t[c] !== undefined) ? (t as TableTolerances) : TOLERANCES_DEFAUT_M;
}

function nombreBorne(nom: string, defaut: number, min: number, max: number, entier: boolean): number {
  const brut = process.env[nom];
  if (brut === undefined || brut.trim() === "") return defaut;
  const v = Number(brut);
  return Number.isFinite(v) && v >= min && v <= max && (!entier || Number.isInteger(v)) ? v : defaut;
}

export const tolerancesAssociation = (): TableTolerances => lireTolerances(process.env.PROJETS_VOIRIE_ASSOC_TOLERANCES_M);
export const couvertureMinAssociation = (): number => nombreBorne("PROJETS_VOIRIE_ASSOC_COUVERTURE_MIN", COUVERTURE_MIN_DEFAUT, 0.5, 1, false);
export const propositionsParCircuitMax = (): number => nombreBorne("PROJETS_VOIRIE_ASSOC_PAR_CIRCUIT_MAX", 5, 1, 20, true);
export const circuitsParExecutionMax = (): number => nombreBorne("PROJETS_VOIRIE_ASSOC_CIRCUITS_MAX", 20_000, 100, 100_000, true);

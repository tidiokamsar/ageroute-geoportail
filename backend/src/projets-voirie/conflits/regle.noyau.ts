/**
 * REGLES DE CONFLIT (noyau pur) : resolution de la regle applicable, distance de proximite, versions, approbation.
 *
 * Une regle porte une tolerance de proximite (bande a verifier AU-DELA de l'emprise) et une marge d'incertitude (facteur applique a la
 * precision horizontale DECLAREE du jeu). Aucun seuil n'est invente : la regle par defaut `RC-2D-0.1` a une tolerance de 0.
 */

import { JUSTIFICATION_MIN, type StatutRegle } from "./types.noyau";

export const CODE_REGLE_DEFAUT = "RC-2D-0.1";

export interface RegleLue {
  /** Nul : regle de repli du code (la table n'en porte aucune), jamais attendu sur une base migree. */
  regleId: string | null;
  projetId: string | null;
  famille: string | null;
  code: string;
  version: number;
  toleranceProximiteM: number;
  margeIncertitude: number;
  statut: StatutRegle;
  approuveLe: Date | null;
}

/** Portee d'une regle appliquee, de la plus specifique a la plus generale. */
export type PorteeRegle = "PROJET_FAMILLE" | "PROJET" | "GENERALE_FAMILLE" | "GENERALE" | "DEFAUT";

export const REGLE_PAR_DEFAUT: RegleLue = {
  regleId: null, projetId: null, famille: null, code: CODE_REGLE_DEFAUT, version: 0,
  toleranceProximiteM: 0, margeIncertitude: 1, statut: "APPROUVEE", approuveLe: null,
};

export interface RegleResolue { regle: RegleLue; portee: PorteeRegle }

const estDefaut = (r: RegleLue) => r.projetId === null && r.famille === null && r.code === CODE_REGLE_DEFAUT && r.version === 0;

/**
 * Regle applicable a une famille de reseau (contrat, section 5) : la plus recente version APPROUVEE
 *   1. du projet pour cette famille, 2. du projet pour toutes les familles, 3. generale pour cette famille,
 *   4. generale pour toutes les familles, 5. la regle par defaut.
 * « La plus recente » : date d'approbation, puis version, puis code (ordre total : le resultat ne depend pas de l'ordre de lecture).
 * Une regle BROUILLON ou RETIREE n'est jamais appliquee.
 */
export function resoudreRegle(regles: readonly RegleLue[], projetId: string, famille: string | null): RegleResolue {
  const approuvees = regles.filter((r) => r.statut === "APPROUVEE");
  const niveaux: { portee: PorteeRegle; filtre: (r: RegleLue) => boolean }[] = [
    { portee: "PROJET_FAMILLE", filtre: (r) => r.projetId === projetId && famille !== null && r.famille === famille },
    { portee: "PROJET", filtre: (r) => r.projetId === projetId && r.famille === null },
    { portee: "GENERALE_FAMILLE", filtre: (r) => r.projetId === null && famille !== null && r.famille === famille },
    { portee: "GENERALE", filtre: (r) => r.projetId === null && r.famille === null && !estDefaut(r) },
  ];
  for (const n of niveaux) {
    const candidates = approuvees.filter(n.filtre).sort(plusRecenteD);
    if (candidates.length > 0) return { regle: candidates[0], portee: n.portee };
  }
  const defaut = approuvees.find(estDefaut);
  return { regle: defaut ?? REGLE_PAR_DEFAUT, portee: "DEFAUT" };
}

function plusRecenteD(a: RegleLue, b: RegleLue): number {
  const ta = a.approuveLe ? a.approuveLe.getTime() : 0;
  const tb = b.approuveLe ? b.approuveLe.getTime() : 0;
  return tb - ta || b.version - a.version || a.code.localeCompare(b.code);
}

/**
 * Distance, au-dela de l'emprise, a laquelle un reseau reste « a verifier » : tolerance + precision horizontale DECLAREE x marge.
 * Une precision non declaree (null) ne contribue PAS : elle n'est jamais inventee (le jeu reste alors classe A_INVESTIGUER).
 */
export function distanceProximiteM(regle: Pick<RegleLue, "toleranceProximiteM" | "margeIncertitude">, precisionHorizontaleM: number | null): number {
  const precision = precisionHorizontaleM !== null && Number.isFinite(precisionHorizontaleM) && precisionHorizontaleM > 0 ? precisionHorizontaleM : 0;
  return arrondi2(regle.toleranceProximiteM + precision * regle.margeIncertitude);
}

const arrondi2 = (x: number) => Math.round(x * 100) / 100;

/** Prochain numero de version pour (projet, famille, code) : 1 + la plus grande version existante (1 pour la premiere). */
export function prochaineVersionRegle(versionsExistantes: readonly number[]): number {
  return versionsExistantes.length === 0 ? 1 : Math.max(...versionsExistantes) + 1;
}

export type ErreurRegle = { ok: false; status: number; code: string; message: string };
export type VerdictRegle = { ok: true; derogation: string | null } | ErreurRegle;

/**
 * Approbation d'une regle : ADMIN seulement (la route le garantit), regle BROUILLON seulement (une regle approuvee est immuable,
 * 409 REGLE_IMMUABLE), justification d'au moins 10 caracteres (422 JUSTIFICATION_REQUISE) ; l'AUTEUR ne peut pas approuver sa propre
 * regle sans derogation motivee (409 SEPARATION_DES_TACHES), qui est alors tracee.
 */
export function verifierApprobationRegle(e: {
  statut: StatutRegle; creeParId: string | null; acteurId: string; justification: string | undefined; derogation: string | undefined;
}): VerdictRegle {
  if (e.statut !== "BROUILLON") {
    return { ok: false, status: 409, code: "REGLE_IMMUABLE", message: "Cette règle n'est plus un brouillon : une règle approuvée ou retirée ne change pas (créez une nouvelle version)." };
  }
  if ((e.justification ?? "").trim().length < JUSTIFICATION_MIN) {
    return { ok: false, status: 422, code: "JUSTIFICATION_REQUISE", message: `Une justification de ${JUSTIFICATION_MIN} caractères au moins est requise pour approuver une règle.` };
  }
  if (e.creeParId !== null && e.creeParId === e.acteurId) {
    const d = (e.derogation ?? "").trim();
    if (d.length < JUSTIFICATION_MIN) {
      return { ok: false, status: 409, code: "SEPARATION_DES_TACHES", message: `L'auteur d'une règle ne peut pas l'approuver sans dérogation motivée (${JUSTIFICATION_MIN} caractères au moins).` };
    }
    return { ok: true, derogation: d };
  }
  return { ok: true, derogation: null };
}

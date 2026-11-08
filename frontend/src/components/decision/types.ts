/**
 * Aide a la decision : types partages entre le shell de page et les onglets (docs/aide-decision/CONTRAT-AD.md §3 et §8).
 * Fichier du contrat : ne le modifier qu'apres mise a jour du contrat.
 */
export interface FiltresDecision {
  regionId?: number;
  classe?: string[];
  etat?: string[];
  statutChantier?: string[];
  /** Date ISO (AAAA-MM-JJ). */
  depuis?: string;
  jusqua?: string;
}

export interface PropsOnglet {
  filtres: FiltresDecision;
  onFiltres: (f: FiltresDecision) => void;
}

export type IdOnglet = "carte" | "liste" | "simulation" | "contractuel" | "scenarios" | "rapports";

/** Etat d'un indicateur (contrat §5) : `valeur` vaut null hors DISPONIBLE et PARTIEL, jamais 0. */
export type EtatKpi = "DISPONIBLE" | "NON_DISPONIBLE" | "PARTIEL" | "PERIME" | "DEFINITION_NON_VALIDEE";

export interface Kpi {
  code: string;
  libelle: string;
  valeur: number | null;
  unite: string;
  etat: EtatKpi;
  statutDefinition: "PROVISOIRE" | "VALIDEE";
  periode: { depuis: string | null; jusqua: string | null } | null;
  perimetre: { libelle: string; regionId: number | null };
  source: string;
  calculeLe: string;
  couverture: { evalueKm: number; eligibleKm: number; nonEvalueKm: number; partNonEvaluee: number } | null;
  definition: string;
  formule: string;
  avertissements: string[];
  ouvre: { onglet: IdOnglet; filtres: FiltresDecision };
}

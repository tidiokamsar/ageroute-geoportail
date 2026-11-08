/**
 * Cycle de vie d'une mission terrain côté écran.
 *
 * Copie de `TRANSITIONS` (backend/src/field/missions.regles.ts) ; un test la relit dans son fichier
 * pour qu'elles ne divergent pas. Les horodatages réels (début, fin) sont posés par le serveur à la
 * transition, jamais saisis.
 */

export const STATUTS_MISSION = ["BROUILLON", "PLANIFIEE", "TELECHARGEE", "EN_COURS", "SUSPENDUE", "TERMINEE", "SYNC_EN_ATTENTE", "ANNULEE"] as const;
export type StatutMission = (typeof STATUTS_MISSION)[number];

export const TRANSITIONS_MISSION: Record<StatutMission, readonly StatutMission[]> = {
  BROUILLON: ["PLANIFIEE", "ANNULEE"],
  PLANIFIEE: ["TELECHARGEE", "EN_COURS", "ANNULEE"],
  TELECHARGEE: ["EN_COURS", "ANNULEE"],
  EN_COURS: ["SUSPENDUE", "TERMINEE", "ANNULEE"],
  SUSPENDUE: ["EN_COURS", "ANNULEE"],
  TERMINEE: ["SYNC_EN_ATTENTE"],
  SYNC_EN_ATTENTE: ["TERMINEE"],
  ANNULEE: [],
};

export const LIBELLE_STATUT_MISSION: Record<StatutMission, string> = {
  BROUILLON: "Brouillon", PLANIFIEE: "Planifiée", TELECHARGEE: "Téléchargée", EN_COURS: "En cours",
  SUSPENDUE: "Suspendue", TERMINEE: "Terminée", SYNC_EN_ATTENTE: "Synchronisation en attente", ANNULEE: "Annulée",
};

export const TYPES_MISSION = ["INSPECTION", "INVENTAIRE", "SURVEILLANCE", "CONTROLE_CHANTIER", "RECEPTION", "SECURITE", "URGENCE", "RELEVE_SIG"] as const;
export const LIBELLE_TYPE_MISSION: Record<(typeof TYPES_MISSION)[number], string> = {
  INSPECTION: "Inspection", INVENTAIRE: "Inventaire", SURVEILLANCE: "Surveillance", CONTROLE_CHANTIER: "Contrôle de chantier",
  RECEPTION: "Réception", SECURITE: "Sécurité", URGENCE: "Urgence", RELEVE_SIG: "Relevé SIG",
};

export function transitionsMission(statut: string | null | undefined): readonly StatutMission[] {
  return (statut && TRANSITIONS_MISSION[statut as StatutMission]) || [];
}

/** « 2026-10-22T08:00 » (champ datetime-local) vers ISO ; vide -> absent ; invalide -> null. */
export function versIso(local: string): string | undefined | null {
  if (!local.trim()) return undefined;
  const t = Date.parse(local);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

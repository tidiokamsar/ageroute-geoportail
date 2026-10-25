/**
 * Historique d'un tronçon autour d'une intervention (BDRI, lot G) : les inspections AVANT et APRÈS un chantier.
 *
 * Une intervention achevée n'efface rien : les inspections antérieures restent, celles d'après s'ajoutent. La
 * coupure se fait sur les dates RÉELLES du chantier ; à défaut, sur les dates prévues, et l'écran le dit. Sans
 * aucune date, rien n'est classé : on ne devine pas quand des travaux ont eu lieu.
 */

export interface DatesChantier {
  dateDebutReelle?: string | null; dateFinReelle?: string | null;
  dateDebutPrevue?: string | null; dateFinPrevue?: string | null;
}
export interface InspectionDatee { id: string; dateInspection: string }

export interface AvantApres<I> {
  avant: I[];
  pendant: I[];
  apres: I[];
  /** Quelles dates ont servi : réelles, prévues, ou aucune (rien n'est classé). */
  base: "reelles" | "prevues" | "aucune";
}

export function avantApres<I extends InspectionDatee>(inspections: readonly I[], c: DatesChantier): AvantApres<I> {
  const reelles = !!c.dateDebutReelle;
  const debut = c.dateDebutReelle ?? c.dateDebutPrevue ?? null;
  const fin = reelles ? c.dateFinReelle ?? null : c.dateFinPrevue ?? null;
  if (!debut) return { avant: [], pendant: [], apres: [], base: "aucune" };
  const t0 = Date.parse(debut), t1 = fin ? Date.parse(fin) : null;
  const tri = [...inspections].sort((a, b) => a.dateInspection.localeCompare(b.dateInspection));
  return {
    avant: tri.filter((i) => Date.parse(i.dateInspection) < t0),
    pendant: tri.filter((i) => Date.parse(i.dateInspection) >= t0 && (t1 === null || Date.parse(i.dateInspection) <= t1)),
    apres: t1 === null ? [] : tri.filter((i) => Date.parse(i.dateInspection) > t1),
    base: reelles ? "reelles" : "prevues",
  };
}

/** Bornes d'une section, en mètres le long du tracé ; le tronçon entier si aucune. */
export function libelleSection(s: { debutM: number | null; finM: number | null; portionId?: string | null }): string {
  if (s.debutM == null || s.finM == null) return "tronçon entier";
  const m = (v: number) => (v >= 1000 ? `${(v / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} km` : `${Math.round(v)} m`);
  return `${s.portionId ? "portion " : ""}${m(s.debutM)} → ${m(s.finM)}`;
}

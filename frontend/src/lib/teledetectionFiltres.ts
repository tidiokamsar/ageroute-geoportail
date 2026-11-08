import type { FiltresPropositions, FiltresSynthese, StatutProposition } from "./teledetectionApi";

/**
 * Filtres de l'ecran Observation de la Terre : etat de saisie (chaines, pour les champs de
 * formulaire) et sa traduction en parametres d'API. Noyau pur.
 */

export interface FiltresEcran {
  q: string;
  source: string;
  type: string;
  regionId: string;
  tronconId: string;
  /** Libelle du troncon choisi, pour reafficher le choix sans nouvelle requete. */
  tronconLibelle: string;
  priorite: string;
  /** "" (indifferent), "oui" ou "non". */
  rattachee: string;
  depuis: string;
  jusqua: string;
}

export const FILTRES_VIDES: FiltresEcran = {
  q: "", source: "", type: "", regionId: "", tronconId: "", tronconLibelle: "", priorite: "", rattachee: "", depuis: "", jusqua: "",
};

/** Nombre de filtres actifs, la recherche libre comprise. */
export function nombreFiltresActifs(f: FiltresEcran): number {
  return [f.q, f.source, f.type, f.regionId, f.tronconId, f.priorite, f.rattachee, f.depuis, f.jusqua].filter((v) => v.trim() !== "").length;
}

/**
 * Les filtres que la liste applique ET que la synthese (donc les compteurs d'onglet) ignore : tout sauf la region et la
 * periode. Sert a expliquer un ecart entre un compteur d'onglet et le total filtre de la liste.
 */
export function filtresHorsSynthese(f: FiltresEcran): string[] {
  const actifs: string[] = [];
  if (f.q.trim() !== "") actifs.push("recherche");
  if (f.source.trim() !== "") actifs.push("source");
  if (f.type.trim() !== "") actifs.push("type");
  if (f.tronconId.trim() !== "") actifs.push("tronçon");
  if (f.priorite.trim() !== "") actifs.push("priorité");
  if (f.rattachee.trim() !== "") actifs.push("rattachement");
  return actifs;
}

/** Vrai si l'intervalle est incoherent (debut apres la fin) : le serveur le refuserait. */
export function intervalleIncoherent(f: Pick<FiltresEcran, "depuis" | "jusqua">): boolean {
  return !!f.depuis && !!f.jusqua && f.depuis > f.jusqua;
}

export function versFiltresPropositions(f: FiltresEcran, statut: StatutProposition): FiltresPropositions {
  return {
    statut, type: f.type, source: f.source, regionId: f.regionId, tronconId: f.tronconId, priorite: f.priorite,
    rattachee: f.rattachee, depuis: f.depuis, jusqua: f.jusqua, q: f.q.trim(),
  };
}

/** La synthese suit la region et la periode, pas les autres filtres : les compteurs d'onglet restent lisibles. */
export function versFiltresSynthese(f: FiltresEcran): FiltresSynthese {
  return { regionId: f.regionId, depuis: f.depuis, jusqua: f.jusqua };
}

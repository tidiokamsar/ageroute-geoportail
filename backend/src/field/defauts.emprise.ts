import type { Metre, MesureDefaut, UniteDefaut } from "./defauts.regles";

/**
 * Metre d'un defaut par son EMPRISE relevee (paragraphe 7.1, scenario A5).
 *
 * Un agent qui contourne un defaut au GPS releve une geometrie : une ligne pour un defaut
 * lineaire (fissure, ornierage en metre lineaire), un polygone pour un defaut surfacique
 * (faiencage, nid-de-poule etendu). La longueur ou la surface se calcule alors dans le fuseau
 * UTM du point interieur (`metre_utm`), jamais en degres.
 *
 * L'ORDRE NE CHANGE PAS : LES MESURES PASSENT D'ABORD. Une quantite saisie ou un produit de
 * mesures reste prioritaire (`metrer`). L'emprise ne sert que quand les mesures manquent, et
 * seulement pour celles qu'elle remplace : une ligne remplace la longueur ; un polygone, la
 * longueur et la largeur. Elle ne remplace JAMAIS la profondeur (un contour n'a pas de
 * profondeur) ni un comptage.
 *
 * LA QUANTITE EST DERIVEE (`EMPRISE_UTM`), pas observee : la geometrie est le releve, la surface
 * un calcul sur ce releve.
 */

export type DimensionEmprise = "LineString" | "Polygon";

export type RefusEmprise = "EMPRISE_INCOMPATIBLE" | "DEPASSE_LE_TRONCON" | "EMPRISE_DEGENEREE";

/** Mesures du catalogue qu'une emprise de cette dimension remplace, pour une unite donnee. */
export function mesuresRemplacees(unite: UniteDefaut, dimension: DimensionEmprise): MesureDefaut[] {
  if (unite === "METRE" && dimension === "LineString") return ["LONGUEUR"];
  if (unite === "METRE_CARRE" && dimension === "Polygon") return ["LONGUEUR", "LARGEUR"];
  return [];
}

export function compatible(unite: UniteDefaut, dimension: DimensionEmprise): boolean {
  return mesuresRemplacees(unite, dimension).length > 0;
}

/**
 * Le metre par mesures a-t-il echoue d'une maniere que l'emprise peut combler ?
 * Seulement s'il manquait des mesures, et seulement celles que l'emprise remplace. Une mesure
 * aberrante, un depassement du troncon ou une profondeur manquante restent des refus.
 */
export function empriseComble(metre: Metre, unite: UniteDefaut, dimension: DimensionEmprise): boolean {
  if (metre.valeur !== null) return false;
  if (metre.motif === "MESURES_INSUFFISANTES") return compatible(unite, dimension);
  if (metre.motif === "RELEVE_INCOMPLET") {
    const remplacees = mesuresRemplacees(unite, dimension);
    return remplacees.length > 0 && (metre.manquantes ?? []).every((m) => remplacees.includes(m));
  }
  return false;
}

/** Quantite tiree d'une emprise deja mesuree en UTM (longueur en m, surface en m2). */
export function quantiteParEmprise(
  unite: UniteDefaut,
  dimension: DimensionEmprise,
  mesure: { longueurM: number; surfaceM2: number },
  longueurTronconM?: number | null,
): { valeur: number; methode: "EMPRISE_UTM" } | { valeur: null; motif: RefusEmprise } {
  if (!compatible(unite, dimension)) return { valeur: null, motif: "EMPRISE_INCOMPATIBLE" };
  const v = dimension === "LineString" ? mesure.longueurM : mesure.surfaceM2;
  if (!(Number.isFinite(v) && v > 0)) return { valeur: null, motif: "EMPRISE_DEGENEREE" };
  // Meme garde que pour une longueur mesuree : un defaut lineaire plus long que son troncon est
  // une erreur de releve ou de rattachement.
  if (dimension === "LineString" && longueurTronconM && longueurTronconM > 0 && v > longueurTronconM) {
    return { valeur: null, motif: "DEPASSE_LE_TRONCON" };
  }
  // Meme arrondi que les autres methodes (trois decimales).
  return { valeur: Math.round(v * 1000) / 1000, methode: "EMPRISE_UTM" };
}

export const EXPLICATIONS_EMPRISE: Record<RefusEmprise, string> = {
  EMPRISE_INCOMPATIBLE: "L'emprise ne correspond pas à l'unité du type : une ligne pour un défaut en mètres, un polygone pour un défaut en mètres carrés.",
  DEPASSE_LE_TRONCON: "L'emprise relevée est plus longue que le tronçon qui porte le défaut.",
  EMPRISE_DEGENEREE: "L'emprise relevée n'a ni longueur ni surface mesurable.",
};

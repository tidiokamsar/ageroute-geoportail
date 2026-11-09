/**
 * HIERARCHIE TERRITORIALE (noyau pur, sans base) : niveaux et rangs, admissibilite d'un parent, chemin materialise, region effective,
 * emprises GeoJSON (validation structurelle, boite englobante, contenance par rectangle). Contrat : docs/projets-voirie/CONTRAT-TERRITOIRES.md,
 * sections 3.1 et 4. La base applique les memes regles par declencheur ; ce noyau sert au service (messages types avant la base) et aux tests.
 *
 * AUCUN NOM DE LIEU ICI : les noms vivent dans la migration (pilote) et la graine de demonstration.
 */

import type { Bbox } from "../lecture.types";

export const NIVEAUX = ["NATION", "REGION", "PREFECTURE", "COMMUNE", "QUARTIER", "SECTEUR", "ZONE"] as const;
export type NiveauTerritoire = (typeof NIVEAUX)[number];

/** Rang d'un niveau : 0 (nation) a 6 (zone). */
export const rangNiveau = (n: NiveauTerritoire): number => NIVEAUX.indexOf(n);

/** Motif des codes (territoires et referentiels), le meme que celui des codes de projet. */
export const CODE_TERRITOIRE = /^[A-Z0-9][A-Z0-9_-]{1,63}$/;

/**
 * Un parent est admissible s'il est de rang STRICTEMENT inferieur : un niveau peut etre saute (commune sous une region quand la prefecture
 * n'est pas renseignee), jamais inverse ni egal. La nation n'a pas de parent ; tout autre niveau en a un.
 */
export function parentAdmissible(niveauEnfant: NiveauTerritoire, niveauParent: NiveauTerritoire | null): { ok: true } | { ok: false; code: "TERRITOIRE_PARENT_REQUIS" | "NIVEAU_INCOMPATIBLE"; message: string } {
  if (niveauEnfant === "NATION") {
    return niveauParent === null ? { ok: true } : { ok: false, code: "NIVEAU_INCOMPATIBLE", message: "Une nation n'a pas de parent." };
  }
  if (niveauParent === null) return { ok: false, code: "TERRITOIRE_PARENT_REQUIS", message: `Un territoire de niveau ${niveauEnfant} exige un parent.` };
  if (rangNiveau(niveauParent) >= rangNiveau(niveauEnfant)) {
    return { ok: false, code: "NIVEAU_INCOMPATIBLE", message: `Un territoire de niveau ${niveauEnfant} ne peut pas avoir un parent de niveau ${niveauParent}.` };
  }
  return { ok: true };
}

/** Chemin materialise d'un enfant : celui du parent suivi de l'identifiant. La nation : `/id/`. */
export const construireChemin = (cheminParent: string | null, id: string): string => `${cheminParent ?? "/"}${id}/`;

/** Identifiants des ancetres (nation en premier), sans le territoire lui-meme. */
export function ancetresDuChemin(chemin: string): string[] {
  const ids = chemin.split("/").filter(Boolean);
  return ids.slice(0, -1);
}

/** `b` est-il `a` ou l'un de ses descendants ? (prefixe de chemin). */
export const estDansSousArbre = (cheminRacine: string, cheminCandidat: string): boolean => cheminCandidat.startsWith(cheminRacine);

/** Region effective : la region propre, sinon celle du parent (deja effective). */
export const regionEffective = (regionPropre: number | null, regionEffectiveParent: number | null): number | null => regionPropre ?? regionEffectiveParent;

// ------------------------------------------------------------------------------------------------
// Emprises GeoJSON
// ------------------------------------------------------------------------------------------------

export const SOMMETS_EMPRISE_MAX = 10_000;
export type Position = [number, number];
export type EmpriseGeoJson = { type: "Polygon"; coordinates: Position[][] } | { type: "MultiPolygon"; coordinates: Position[][][] };

export type ErreurEmprise = { ok: false; code: "EMPRISE_INVALIDE"; message: string };
export type EmpriseLue = { ok: true; geojson: EmpriseGeoJson; bbox: Bbox; sommets: number };

function lireAnneau(brut: unknown, compte: { n: number }): Position[] | string {
  if (!Array.isArray(brut) || brut.length < 4) return "un anneau porte au moins quatre positions (dont la fermeture)";
  const anneau: Position[] = [];
  for (const p of brut) {
    if (!Array.isArray(p) || p.length < 2 || typeof p[0] !== "number" || typeof p[1] !== "number" || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
      return "une position est illisible (deux nombres finis attendus)";
    }
    if (Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) return "une position sort de -180/180 et -90/90 (WGS 84 attendu, longitude puis latitude)";
    anneau.push([p[0], p[1]]);
    compte.n += 1;
    if (compte.n > SOMMETS_EMPRISE_MAX) return `plus de ${SOMMETS_EMPRISE_MAX} sommets : simplifiez l'emprise (elle est approximative par nature)`;
  }
  const a = anneau[0], z = anneau[anneau.length - 1];
  if (a[0] !== z[0] || a[1] !== z[1]) return "un anneau n'est pas ferme (premiere et derniere positions differentes)";
  return anneau;
}

/**
 * Lit une emprise GeoJSON (Polygon ou MultiPolygon) : structure, fermeture des anneaux, bornes des coordonnees, plafond de sommets, boite
 * englobante. La validite topologique (anneaux qui se croisent) est verifiee par PostGIS a l'ecriture (contrainte `tv_emprise`).
 */
export function lireEmprise(brut: unknown): EmpriseLue | ErreurEmprise {
  const refus = (message: string): ErreurEmprise => ({ ok: false, code: "EMPRISE_INVALIDE", message: `Emprise invalide : ${message}.` });
  if (!brut || typeof brut !== "object" || Array.isArray(brut)) return refus("un objet GeoJSON Polygon ou MultiPolygon est attendu");
  const g = brut as { type?: unknown; coordinates?: unknown };
  const compte = { n: 0 };
  let polygones: Position[][][];
  if (g.type === "Polygon") {
    if (!Array.isArray(g.coordinates) || g.coordinates.length === 0) return refus("un polygone porte au moins un anneau");
    const anneaux: Position[][] = [];
    for (const a of g.coordinates) { const r = lireAnneau(a, compte); if (typeof r === "string") return refus(r); anneaux.push(r); }
    polygones = [anneaux];
  } else if (g.type === "MultiPolygon") {
    if (!Array.isArray(g.coordinates) || g.coordinates.length === 0 || g.coordinates.length > 500) return refus("un multipolygone porte de un a cinq cents polygones");
    polygones = [];
    for (const poly of g.coordinates) {
      if (!Array.isArray(poly) || poly.length === 0) return refus("un polygone porte au moins un anneau");
      const anneaux: Position[][] = [];
      for (const a of poly) { const r = lireAnneau(a, compte); if (typeof r === "string") return refus(r); anneaux.push(r); }
      polygones.push(anneaux);
    }
  } else {
    return refus("type GeoJSON Polygon ou MultiPolygon attendu");
  }
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const poly of polygones) for (const [x, y] of poly[0]) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
  if (!(w < e && s < n)) return refus("l'emprise est degeneree (largeur ou hauteur nulle)");
  const geojson: EmpriseGeoJson = g.type === "Polygon" ? { type: "Polygon", coordinates: polygones[0] } : { type: "MultiPolygon", coordinates: polygones };
  return { ok: true, geojson, bbox: [w, s, e, n], sommets: compte.n };
}

/** Le rectangle `enfant` est-il contenu dans le rectangle `parent` ? (test grossier, sans PostGIS ; la contenance exacte est `ST_Covers`). */
export const bboxContient = (parent: Bbox, enfant: Bbox): boolean => enfant[0] >= parent[0] && enfant[1] >= parent[1] && enfant[2] <= parent[2] && enfant[3] <= parent[3];

/** Une position est-elle dans le rectangle ? */
export const bboxContientPosition = (b: Bbox, lon: number, lat: number): boolean => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];

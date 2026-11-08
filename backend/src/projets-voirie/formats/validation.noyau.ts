/**
 * Validation geometrique et echantillon d'apercu : parties PURES (classement des raisons de PostGIS, choix de l'echantillon, decimation).
 * Contrat : docs/projets-voirie/CONTRAT-IMPORT.md, section 7.2. Le calcul de validite lui-meme (ST_IsValid, ST_IsValidReason) est fait par la
 * base : voir apercu.service.ts et import.service.ts.
 */

import type { GeometrieLue, ObjetLu, Pos, TypeGeom } from "../lecture.types";

export type CodeProbleme = "GEOMETRIE_VIDE" | "AUTO_INTERSECTION" | "TROP_PEU_DE_POINTS" | "ANNEAU_INVALIDE" | "GEOMETRIE_INVALIDE";

export interface Probleme {
  ordre: number;
  nom: string | null;
  typeGeom: TypeGeom;
  code: CodeProbleme;
  message: string;
}

const MESSAGES: Record<CodeProbleme, string> = {
  GEOMETRIE_VIDE: "Geometrie vide apres reparation : l'objet est ecarte.",
  AUTO_INTERSECTION: "Auto-intersection : la geometrie se croise elle-meme ; elle sera reparee (ST_MakeValid), l'original est conserve dans le fichier.",
  TROP_PEU_DE_POINTS: "Trop peu de points distincts pour former la geometrie ; elle sera reparee ou ecartee.",
  ANNEAU_INVALIDE: "Anneau de polygone invalide (non ferme, trou hors du contour ou imbrique) ; il sera repare (ST_MakeValid).",
  GEOMETRIE_INVALIDE: "Geometrie invalide au sens de PostGIS ; elle sera reparee (ST_MakeValid).",
};

/**
 * Classe la raison rendue par `ST_IsValidReason`. Le message rendu est FIXE : la raison de PostGIS contient les coordonnees du point fautif
 * (`Self-intersection[380000 1015000]`), qui ne sont jamais recopiees.
 */
export function classerRaison(raison: string | null, vide: boolean): { code: CodeProbleme; message: string } {
  let code: CodeProbleme;
  const r = raison ?? "";
  if (vide) code = "GEOMETRIE_VIDE";
  else if (/self-intersection/i.test(r)) code = "AUTO_INTERSECTION";
  else if (/too few points/i.test(r)) code = "TROP_PEU_DE_POINTS";
  else if (/hole|shell|ring|nested|interior is disconnected|not closed/i.test(r)) code = "ANNEAU_INVALIDE";
  else code = "GEOMETRIE_INVALIDE";
  return { code, message: MESSAGES[code] };
}

/**
 * Choisit l'echantillon : d'abord les objets a probleme (la moitie de la taille au plus), puis des objets REGULIEREMENT espaces dans le
 * fichier. Deterministe : le meme fichier donne le meme echantillon. Rend des indices dans `total`, tries.
 */
export function choisirEchantillon(total: number, taille: number, aProbleme: ReadonlySet<number>): number[] {
  if (total <= taille) return Array.from({ length: total }, (_, i) => i);
  const choisis = new Set<number>();
  for (const i of [...aProbleme].sort((a, b) => a - b)) {
    if (choisis.size >= Math.floor(taille / 2)) break;
    if (i >= 0 && i < total) choisis.add(i);
  }
  const reste = taille - choisis.size;
  for (let k = 0; k < reste; k++) {
    // Pas regulier ; en cas de collision avec un objet a probleme, on avance jusqu'au prochain libre.
    let i = Math.min(total - 1, Math.floor((k * total) / reste));
    while (choisis.has(i) && i < total - 1) i++;
    while (choisis.has(i) && i > 0) i--;
    choisis.add(i);
  }
  return [...choisis].sort((a, b) => a - b);
}

function decimer(c: Pos[], garde: number, anneau: boolean): Pos[] {
  const g = anneau ? Math.max(4, garde) : Math.max(2, garde);
  if (c.length <= g) return c;
  const pas = (c.length - 1) / (g - 1);
  const sortie: Pos[] = [];
  for (let i = 0; i < g; i++) sortie.push(c[Math.min(c.length - 1, Math.round(i * pas))]);
  if (anneau) sortie[sortie.length - 1] = sortie[0];
  return sortie;
}

/** Reduit une geometrie a `maxSommets` sommets environ (premier et dernier conserves, anneaux fermes) ; `simplifiee` dit si elle a ete reduite. */
export function decimerGeometrie(g: GeometrieLue, maxSommets: number): { geometrie: GeometrieLue; simplifiee: boolean } {
  const compter = (x: unknown): number => (typeof (x as number[])[0] === "number" ? 1 : (x as unknown[]).reduce<number>((s, y) => s + compter(y), 0));
  if (compter(g.coordinates) <= maxSommets) return { geometrie: g, simplifiee: false };
  switch (g.type) {
    case "Point": case "MultiPoint": return { geometrie: g, simplifiee: false };
    case "LineString": return { geometrie: { type: "LineString", coordinates: decimer(g.coordinates, maxSommets, false) }, simplifiee: true };
    case "MultiLineString": {
      const garde = Math.floor(maxSommets / g.coordinates.length);
      return { geometrie: { type: "MultiLineString", coordinates: g.coordinates.map((l) => decimer(l, garde, false)) }, simplifiee: true };
    }
    case "Polygon": {
      const garde = Math.floor(maxSommets / g.coordinates.length);
      return { geometrie: { type: "Polygon", coordinates: g.coordinates.map((a) => decimer(a, garde, true)) }, simplifiee: true };
    }
    case "MultiPolygon": {
      const parts = g.coordinates.reduce((s, p) => s + p.length, 0);
      const garde = Math.floor(maxSommets / parts);
      return { geometrie: { type: "MultiPolygon", coordinates: g.coordinates.map((p) => p.map((a) => decimer(a, garde, true))) }, simplifiee: true };
    }
  }
}

export interface ObjetEchantillon {
  ordre: number;
  nom: string | null;
  typeGeom: TypeGeom;
  geometrie: GeometrieLue;
  simplifiee: boolean;
  attributs: Record<string, unknown>;
}

const VALEUR_MAX = 200;
/** Attributs d'un objet d'echantillon : 30 champs au plus, valeurs textuelles tronquees (l'apercu n'est pas un export du fichier). */
function attributsBornes(a: Record<string, unknown>): Record<string, unknown> {
  const sortie: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(a)) {
    if (n++ >= 30) break;
    const val = typeof v === "string" && v.length > VALEUR_MAX ? `${v.slice(0, VALEUR_MAX)}...` : typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null ? v : JSON.stringify(v)?.slice(0, VALEUR_MAX) ?? null;
    Object.defineProperty(sortie, k, { value: val, writable: true, enumerable: true, configurable: true });
  }
  return sortie;
}

export function construireEchantillon(objets: readonly ObjetLu[], taille: number, aProbleme: ReadonlySet<number>, maxSommets: number): ObjetEchantillon[] {
  return choisirEchantillon(objets.length, taille, aProbleme).map((i) => {
    const o = objets[i];
    const { geometrie, simplifiee } = decimerGeometrie(o.geometrie, maxSommets);
    return { ordre: o.ordre, nom: o.nom, typeGeom: o.typeGeom, geometrie, simplifiee, attributs: attributsBornes(o.attributs) };
  });
}

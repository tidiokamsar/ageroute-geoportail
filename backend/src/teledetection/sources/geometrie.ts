/**
 * Geometrie minimale du moteur de catalogue : validation d'une emprise, intersection avec une zone,
 * part de la zone couverte. Aucune importation, aucune horloge : noyau pur.
 *
 * POURQUOI ICI ET PAS PostGIS : le catalogue est interroge AVANT tout enregistrement, sans base. Une
 * emprise invalide doit etre ecartee a la lecture de la reponse du fournisseur, pas apres coup. La
 * base garde la verite (ST_IsValid) quand le produit y entre ; ceci n'est qu'un garde-fou en amont.
 *
 * Coordonnees : WGS84, ordre GeoJSON [longitude, latitude]. Une altitude eventuelle est retiree.
 */

export type BBox = [ouest: number, sud: number, est: number, nord: number];

export interface PolygoneGeoJson {
  type: "Polygon";
  coordinates: number[][][];
}

export type ValidationPolygone = { ok: true; polygone: PolygoneGeoJson } | { ok: false; raison: string };

const estNombre = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function bboxValide(b: unknown): b is BBox {
  if (!Array.isArray(b) || b.length !== 4 || !b.every(estNombre)) return false;
  const [o, s, e, n] = b as number[];
  return o >= -180 && e <= 180 && s >= -90 && n <= 90 && o < e && s < n;
}

export function polygoneDeBbox(b: BBox): PolygoneGeoJson {
  const [o, s, e, n] = b;
  return { type: "Polygon", coordinates: [[[o, s], [e, s], [e, n], [o, n], [o, s]]] };
}

function aireSigneeAnneau(anneau: number[][]): number {
  let s = 0;
  for (let i = 0; i < anneau.length - 1; i++) s += anneau[i][0] * anneau[i + 1][1] - anneau[i + 1][0] * anneau[i][1];
  return s / 2;
}

function validerAnneau(anneau: unknown, nom: string): { ok: true; anneau: number[][] } | { ok: false; raison: string } {
  if (!Array.isArray(anneau) || anneau.length < 4) return { ok: false, raison: `${nom} : au moins 4 positions sont requises` };
  const propre: number[][] = [];
  for (const p of anneau) {
    if (!Array.isArray(p) || p.length < 2 || !estNombre(p[0]) || !estNombre(p[1])) return { ok: false, raison: `${nom} : position illisible` };
    if (p[0] < -180 || p[0] > 180 || p[1] < -90 || p[1] > 90) return { ok: false, raison: `${nom} : position hors du globe (${p[0]}, ${p[1]})` };
    propre.push([p[0], p[1]]);
  }
  const a = propre[0];
  const z = propre[propre.length - 1];
  if (a[0] !== z[0] || a[1] !== z[1]) return { ok: false, raison: `${nom} : anneau non ferme` };
  return { ok: true, anneau: propre };
}

/**
 * Valide une emprise annoncee par un fournisseur. Accepte un Polygon, ou un MultiPolygon qui n'en
 * contient qu'un seul (certains catalogues l'ecrivent ainsi). Tout autre cas est refuse : on ne
 * fabrique pas une emprise (pas de rectangle de remplacement tire du `bbox`).
 */
export function validerPolygone(g: unknown): ValidationPolygone {
  if (!g || typeof g !== "object") return { ok: false, raison: "geometrie absente" };
  const o = g as { type?: unknown; coordinates?: unknown };
  let rings: unknown;
  if (o.type === "Polygon") rings = o.coordinates;
  else if (o.type === "MultiPolygon" && Array.isArray(o.coordinates) && o.coordinates.length === 1) rings = o.coordinates[0];
  else return { ok: false, raison: `type de geometrie non pris en charge (${String(o.type)})` };
  if (!Array.isArray(rings) || rings.length === 0) return { ok: false, raison: "aucun anneau" };
  const sortie: number[][][] = [];
  for (let i = 0; i < rings.length; i++) {
    const r = validerAnneau(rings[i], i === 0 ? "anneau exterieur" : `trou ${i}`);
    if (!r.ok) return r;
    sortie.push(r.anneau);
  }
  if (Math.abs(aireSigneeAnneau(sortie[0])) < 1e-12) return { ok: false, raison: "anneau exterieur d'aire nulle" };
  return { ok: true, polygone: { type: "Polygon", coordinates: sortie } };
}

export function bboxDePolygone(p: PolygoneGeoJson): BBox {
  let o = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of p.coordinates[0]) {
    if (x < o) o = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [o, s, e, n];
}

function bboxSeRecouvrent(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/** Point dans un polygone (regle pair-impair sur tous les anneaux : un trou exclut le point). */
export function pointDansPolygone(x: number, y: number, p: PolygoneGeoJson): boolean {
  let dedans = false;
  for (const anneau of p.coordinates) {
    for (let i = 0, j = anneau.length - 1; i < anneau.length; j = i++) {
      const [xi, yi] = anneau[i];
      const [xj, yj] = anneau[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dedans = !dedans;
    }
  }
  return dedans;
}

function orientation(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const v = (by - ay) * (cx - bx) - (bx - ax) * (cy - by);
  return v === 0 ? 0 : v > 0 ? 1 : 2;
}

function surSegment(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  return bx <= Math.max(ax, cx) && bx >= Math.min(ax, cx) && by <= Math.max(ay, cy) && by >= Math.min(ay, cy);
}

function segmentsSeCroisent(p1: number[], q1: number[], p2: number[], q2: number[]): boolean {
  const o1 = orientation(p1[0], p1[1], q1[0], q1[1], p2[0], p2[1]);
  const o2 = orientation(p1[0], p1[1], q1[0], q1[1], q2[0], q2[1]);
  const o3 = orientation(p2[0], p2[1], q2[0], q2[1], p1[0], p1[1]);
  const o4 = orientation(p2[0], p2[1], q2[0], q2[1], q1[0], q1[1]);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && surSegment(p1[0], p1[1], p2[0], p2[1], q1[0], q1[1])) return true;
  if (o2 === 0 && surSegment(p1[0], p1[1], q2[0], q2[1], q1[0], q1[1])) return true;
  if (o3 === 0 && surSegment(p2[0], p2[1], p1[0], p1[1], q2[0], q2[1])) return true;
  if (o4 === 0 && surSegment(p2[0], p2[1], q1[0], q1[1], q2[0], q2[1])) return true;
  return false;
}

/** Deux polygones se touchent ou se recouvrent (anneaux exterieurs ; un trou n'est pas pris en compte). */
export function polygonesSIntersectent(a: PolygoneGeoJson, b: PolygoneGeoJson): boolean {
  if (!bboxSeRecouvrent(bboxDePolygone(a), bboxDePolygone(b))) return false;
  const ra = a.coordinates[0];
  const rb = b.coordinates[0];
  for (let i = 0; i < ra.length - 1; i++) {
    for (let j = 0; j < rb.length - 1; j++) if (segmentsSeCroisent(ra[i], ra[i + 1], rb[j], rb[j + 1])) return true;
  }
  return pointDansPolygone(ra[0][0], ra[0][1], b) || pointDansPolygone(rb[0][0], rb[0][1], a);
}

/**
 * Part de la zone couverte par l'emprise, de 0 a 1, estimee sur une grille reguliere de points
 * (pas x pas) pris dans la zone. C'est une ESTIMATION d'emprise : elle ne dit rien des pixels sans
 * donnee a l'interieur de l'emprise (champ `nodata` du fournisseur, non lu ici).
 */
export function fractionCouverte(zone: PolygoneGeoJson, emprise: PolygoneGeoJson, pas = 21): number {
  const [o, s, e, n] = bboxDePolygone(zone);
  let dansZone = 0;
  let couverts = 0;
  for (let i = 0; i < pas; i++) {
    for (let j = 0; j < pas; j++) {
      const x = o + ((i + 0.5) / pas) * (e - o);
      const y = s + ((j + 0.5) / pas) * (n - s);
      if (!pointDansPolygone(x, y, zone)) continue;
      dansZone++;
      if (pointDansPolygone(x, y, emprise)) couverts++;
    }
  }
  if (dansZone === 0) {
    // zone plus fine que la grille : on teste son centre (moyenne des sommets)
    const r = zone.coordinates[0].slice(0, -1);
    const cx = r.reduce((t, p) => t + p[0], 0) / r.length;
    const cy = r.reduce((t, p) => t + p[1], 0) / r.length;
    return pointDansPolygone(cx, cy, emprise) ? 1 : 0;
  }
  return couverts / dansZone;
}

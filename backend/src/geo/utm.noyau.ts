/**
 * Metre en projection UTM, sans base de donnees (paragraphe 7.1, scenario A5). Aucune importation.
 *
 * POURQUOI UNE SECONDE IMPLEMENTATION. Le serveur mesure avec PostGIS (`metre_utm`, migration
 * `20261020010000`). Celle-ci sert a deux choses que PostGIS ne permet pas :
 *   - eprouver le metre SANS base : les tests unitaires tournent partout, CI comprise, la ou le
 *     banc SQL demande un conteneur PostGIS ;
 *   - mesurer HORS LIGNE (terrain, mobile), quand le serveur est injoignable.
 * La valeur qui fait foi reste celle du serveur. Les deux sont confrontees au meme jeu de
 * geometries de reference (`geometries-reference.ts`) et doivent se rejoindre au millionieme.
 *
 * LA PROJECTION. Mercator transverse sur l'ellipsoide WGS 84, serie de Krueger a l'ordre n^3
 * (formulation de Karney, 2011), facteur d'echelle 0,9996, fausse abscisse 500 000 m, fausse
 * ordonnee 10 000 000 m dans l'hemisphere sud. A cet ordre, l'erreur de position est de l'ordre
 * du millimetre a l'interieur d'un fuseau ; le test la mesure contre PROJ au lieu de la supposer.
 *
 * LE FUSEAU, comme `epsg_utm` : floor((lon + 180) / 6) + 1 au POINT INTERIEUR de la geometrie,
 * calcule selon la methode de GEOS (`ST_PointOnSurface`), pour qu'une geometrie a cheval sur
 * 12 deg O tombe dans le meme fuseau des deux cotes.
 */

export type Position = readonly [number, number];
export type GeometrieMetrable =
  | { type: "Point"; coordinates: Position }
  | { type: "LineString"; coordinates: readonly Position[] }
  | { type: "Polygon"; coordinates: readonly (readonly Position[])[] };

const A_WGS84 = 6378137;
const F_WGS84 = 1 / 298.257223563;
const K0 = 0.9996;

const N = F_WGS84 / (2 - F_WGS84);
const A_RECT = (A_WGS84 / (1 + N)) * (1 + (N * N) / 4 + (N ** 4) / 64);
const ALPHA = [
  N / 2 - (2 * N * N) / 3 + (5 * N ** 3) / 16,
  (13 * N * N) / 48 - (3 * N ** 3) / 5,
  (61 * N ** 3) / 240,
];
const E2N = (2 * Math.sqrt(N)) / (1 + N);

export function epsgUtm(lon: number, lat: number): number {
  const zone = Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
  return (lat >= 0 ? 32600 : 32700) + zone;
}

/** Projette (lon, lat) en degres dans le fuseau UTM de l'EPSG donne (326xx ou 327xx). */
export function versUtm(lon: number, lat: number, epsg: number): [number, number] {
  const zone = epsg % 100;
  const sud = Math.floor(epsg / 100) === 327;
  const phi = (lat * Math.PI) / 180;
  const lambda = ((lon - (zone * 6 - 183)) * Math.PI) / 180;
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - E2N * Math.atanh(E2N * Math.sin(phi)));
  const xiP = Math.atan2(t, Math.cos(lambda));
  const etaP = Math.atanh(Math.sin(lambda) / Math.sqrt(1 + t * t));
  let xi = xiP;
  let eta = etaP;
  for (let j = 1; j <= 3; j++) {
    xi += ALPHA[j - 1] * Math.sin(2 * j * xiP) * Math.cosh(2 * j * etaP);
    eta += ALPHA[j - 1] * Math.cos(2 * j * xiP) * Math.sinh(2 * j * etaP);
  }
  return [500000 + K0 * A_RECT * eta, (sud ? 10000000 : 0) + K0 * A_RECT * xi];
}

// ---------- Point interieur, a la maniere de GEOS ----------

function pointInterieurPolygone(anneaux: readonly (readonly Position[])[]): Position {
  const ext = anneaux[0];
  let ymin = Infinity, ymax = -Infinity;
  for (const [, y] of ext) { ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
  const centre = (ymin + ymax) / 2;
  // Ligne de balayage entre le sommet le plus haut sous le centre et le plus bas au-dessus,
  // pour ne passer par aucun sommet (GEOS, InteriorPointArea).
  let dessous = ymin, dessus = ymax;
  for (const anneau of anneaux) {
    for (const [, y] of anneau) {
      if (y <= centre && y > dessous) dessous = y;
      if (y > centre && y < dessus) dessus = y;
    }
  }
  const yb = (dessous + dessus) / 2;
  const xs: number[] = [];
  for (const anneau of anneaux) {
    for (let i = 0; i + 1 < anneau.length; i++) {
      const [x1, y1] = anneau[i], [x2, y2] = anneau[i + 1];
      if ((y1 > yb) !== (y2 > yb)) xs.push(x1 + ((yb - y1) * (x2 - x1)) / (y2 - y1));
    }
  }
  xs.sort((a, b) => a - b);
  let meilleur: Position = ext[0];
  let largeur = -1;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i + 1] - xs[i] > largeur) { largeur = xs[i + 1] - xs[i]; meilleur = [(xs[i] + xs[i + 1]) / 2, yb]; }
  }
  return meilleur;
}

function pointInterieurLigne(pts: readonly Position[]): Position {
  // GEOS, InteriorPointLine : le sommet interieur le plus proche du centroide des sommets, ou
  // l'extremite la plus proche s'il n'y a pas de sommet interieur.
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const candidats = pts.length > 2 ? pts.slice(1, -1) : pts;
  let meilleur = candidats[0];
  let d = Infinity;
  for (const p of candidats) {
    const dp = (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
    if (dp < d) { d = dp; meilleur = p; }
  }
  return meilleur;
}

export function pointInterieur(g: GeometrieMetrable): Position {
  if (g.type === "Point") return g.coordinates;
  if (g.type === "LineString") return pointInterieurLigne(g.coordinates);
  return pointInterieurPolygone(g.coordinates);
}

// ---------- Metre ----------

function aireAnneau(pts: readonly [number, number][]): number {
  let s = 0;
  for (let i = 0; i + 1 < pts.length; i++) s += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
  return s / 2;
}
function longueurPlane(pts: readonly [number, number][]): number {
  let s = 0;
  for (let i = 0; i + 1 < pts.length; i++) s += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  return s;
}

export interface MetreUtm { epsg: number; longueurM: number; surfaceM2: number }
export type RefusMetreUtm = { refus: "GEOMETRIE_VIDE" | "ANNEAU_NON_FERME" | "COORDONNEE_INVALIDE" };

/**
 * Longueur (perimetre pour une surface) et surface, en metres, dans le fuseau du point
 * interieur. Une geometrie mal formee est REFUSEE avec sa raison, jamais reparee : un metre
 * calcule sur une geometrie corrigee en silence ne serait plus celui du releve.
 */
export function metreUtm(g: GeometrieMetrable): MetreUtm | RefusMetreUtm {
  const toutes: Position[] = g.type === "Point" ? [g.coordinates] : g.type === "LineString" ? [...g.coordinates] : g.coordinates.flat();
  if (toutes.length === 0) return { refus: "GEOMETRIE_VIDE" };
  for (const [x, y] of toutes) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 180 || Math.abs(y) > 90) return { refus: "COORDONNEE_INVALIDE" };
  }
  if (g.type === "Polygon") {
    for (const a of g.coordinates) {
      if (a.length < 4) return { refus: "GEOMETRIE_VIDE" };
      const [p, q] = [a[0], a[a.length - 1]];
      if (p[0] !== q[0] || p[1] !== q[1]) return { refus: "ANNEAU_NON_FERME" };
    }
  }
  const [lx, ly] = pointInterieur(g);
  const epsg = epsgUtm(lx, ly);
  const proj = (pts: readonly Position[]) => pts.map(([x, y]) => versUtm(x, y, epsg));
  if (g.type === "Point") return { epsg, longueurM: 0, surfaceM2: 0 };
  if (g.type === "LineString") return { epsg, longueurM: longueurPlane(proj(g.coordinates)), surfaceM2: 0 };
  const anneaux = g.coordinates.map(proj);
  const exterieur = Math.abs(aireAnneau(anneaux[0]));
  const trous = anneaux.slice(1).reduce((s, a) => s + Math.abs(aireAnneau(a)), 0);
  return { epsg, longueurM: anneaux.reduce((s, a) => s + longueurPlane(a), 0), surfaceM2: exterieur - trous };
}

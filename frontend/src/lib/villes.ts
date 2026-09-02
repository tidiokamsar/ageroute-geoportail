/**
 * Recherche par ville / localité (P4 — demande Direction).
 *
 * La BDRI n'a pas de référentiel administratif fin (décision D4 non tranchée :
 * les préfectures/communes ne sont pas en base). Cette liste des chefs-lieux de
 * préfecture sert UNIQUEMENT de helper de recherche cartographique : elle ne
 * sera jamais écrite en base, ni rattachée à un tronçon. Coordonnées arrondies
 * (précision ~1–5 km) — suffisantes pour un filtre de proximité à 20 km,
 * largement insuffisantes pour une attribution administrative.
 *
 * Quand D4 sera tranchée (référentiel officiel INS), cette liste sera remplacée
 * par le référentiel.
 */

export interface Ville {
  nom: string;
  lat: number;
  lon: number;
  region: string;
}

export const VILLES: Ville[] = [
  { nom: "Conakry", lat: 9.51, lon: -13.71, region: "Conakry" },
  { nom: "Boké", lat: 10.93, lon: -14.29, region: "Boké" },
  { nom: "Boffa", lat: 10.18, lon: -13.03, region: "Boké" },
  { nom: "Fria", lat: 10.37, lon: -13.68, region: "Boké" },
  { nom: "Gaoual", lat: 11.75, lon: -14.22, region: "Boké" },
  { nom: "Koundara", lat: 12.34, lon: -13.31, region: "Boké" },
  { nom: "Kindia", lat: 10.06, lon: -12.86, region: "Kindia" },
  { nom: "Coyah", lat: 9.71, lon: -13.39, region: "Kindia" },
  { nom: "Dubréka", lat: 9.81, lon: -13.52, region: "Kindia" },
  { nom: "Forécariah", lat: 9.43, lon: -13.09, region: "Kindia" },
  { nom: "Télimélé", lat: 10.90, lon: -12.79, region: "Kindia" },
  { nom: "Mamou", lat: 10.38, lon: -12.09, region: "Mamou" },
  { nom: "Dalaba", lat: 10.68, lon: -12.25, region: "Mamou" },
  { nom: "Pita", lat: 11.06, lon: -12.39, region: "Mamou" },
  { nom: "Labé", lat: 11.32, lon: -12.28, region: "Labé" },
  { nom: "Lélouma", lat: 11.20, lon: -11.97, region: "Labé" },
  { nom: "Tougué", lat: 11.30, lon: -11.67, region: "Labé" },
  { nom: "Koubia", lat: 11.47, lon: -11.56, region: "Labé" },
  { nom: "Mali", lat: 12.13, lon: -11.97, region: "Labé" },
  { nom: "Faranah", lat: 10.03, lon: -10.74, region: "Faranah" },
  { nom: "Dabola", lat: 10.00, lon: -11.11, region: "Faranah" },
  { nom: "Dinguiraye", lat: 10.72, lon: -10.72, region: "Faranah" },
  { nom: "Kankan", lat: 10.38, lon: -9.31, region: "Kankan" },
  { nom: "Kouroussa", lat: 10.66, lon: -9.89, region: "Kankan" },
  { nom: "Siguiri", lat: 11.42, lon: -9.17, region: "Kankan" },
  { nom: "Mandiana", lat: 10.49, lon: -9.00, region: "Kankan" },
  { nom: "Kérouané", lat: 9.03, lon: -9.00, region: "Kankan" },
  { nom: "Nzérékoré", lat: 7.75, lon: -8.82, region: "Nzérékoré" },
  { nom: "Guéckédou", lat: 8.57, lon: -10.13, region: "Nzérékoré" },
  { nom: "Kissidougou", lat: 9.20, lon: -10.10, region: "Nzérékoré" },
  { nom: "Lola", lat: 7.79, lon: -8.42, region: "Nzérékoré" },
  { nom: "Macenta", lat: 8.55, lon: -9.47, region: "Nzérékoré" },
  { nom: "Beyla", lat: 8.68, lon: -9.09, region: "Nzérékoré" },
  { nom: "Yomou", lat: 7.56, lon: -9.26, region: "Nzérékoré" },
];

/** Normalisation sans accents ni casse, pour la recherche. */
export function normaliser(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function chercherVilles(q: string, limite = 8): Ville[] {
  const n = normaliser(q);
  if (n.length < 2) return [];
  const commence: Ville[] = [];
  const contient: Ville[] = [];
  for (const v of VILLES) {
    const nv = normaliser(v.nom);
    if (nv.startsWith(n)) commence.push(v);
    else if (nv.includes(n)) contient.push(v);
  }
  return [...commence, ...contient].slice(0, limite);
}

export interface FiltreVille {
  a: Ville;
  b?: Ville;
}

const RAYON_METRES = 20_000;
const TERRE_R = 6_371_000;

function distanceHaversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * TERRE_R * Math.asin(Math.sqrt(a));
}

/** Distance d'un point au segment [A,B], en mètres (corridor entre deux villes). */
function distanceAuSegmentM(p: [number, number], a: [number, number], b: [number, number]): number {
  // Approximation plane locale : suffisant aux échelles guinéennes (< 600 km).
  const r = Math.PI / 180;
  const y0 = p[0] * r, x0 = p[1] * r, y1 = a[0] * r, x1 = a[1] * r, y2 = b[0] * r, x2 = b[1] * r;
  const dx = x2 - x1, dy = y2 - y1;
  const long2 = dx * dx + dy * dy;
  let t = long2 === 0 ? 0 : ((x0 - x1) * dx + (y0 - y1) * dy) / long2;
  t = Math.max(0, Math.min(1, t));
  const projLat = (y1 + t * dy) / r, projLon = (x1 + t * dx) / r;
  return distanceHaversineM(p[0], p[1], projLat, projLon);
}

/** Un sommet de géométrie est-il dans la zone du filtre (ville ou corridor) ? */
export function sommetDansFiltre(lat: number, lon: number, f: FiltreVille, rayonM = RAYON_METRES): boolean {
  if (!f.b) return distanceHaversineM(lat, lon, f.a.lat, f.a.lon) <= rayonM;
  return (
    distanceAuSegmentM([lat, lon], [f.a.lat, f.a.lon], [f.b.lat, f.b.lon]) <= rayonM
  );
}

/** Un tronçon (géojson LineString/MultiLineString brut) touche-t-il la zone ? */
export function tronconDansFiltre(geometry: string, f: FiltreVille): boolean {
  let geom: { type: string; coordinates: unknown };
  try {
    geom = JSON.parse(geometry);
  } catch {
    return false;
  }
  const lignes: number[][][] =
    geom.type === "LineString" ? [geom.coordinates as number[][]]
    : geom.type === "MultiLineString" ? (geom.coordinates as number[][][])
    : [];
  for (const ligne of lignes) {
    for (const c of ligne) {
      if (sommetDansFiltre(c[1], c[0], f)) return true;
    }
  }
  return false;
}

export const RAYON_VILLES_METRES = RAYON_METRES;

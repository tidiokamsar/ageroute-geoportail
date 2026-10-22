/**
 * Reseau routier SYNTHETIQUE a l'echelle de la Guinee, deterministe (graine fixe).
 *
 * CE QUE C'EST. Un jeu de troncons LineString qui imite la STRUCTURE du registre reel, sans en etre
 * une copie :
 *   - un reseau CLASSE (RN et RR) : des axes entre des chefs-lieux (positions approchees au dixieme
 *     de degre, seule la repartition spatiale compte), decoupes en troncons de 1,5 a 45 km
 *     (moyenne visee 12,5 km, celle du registre : 21 156 km pour 1 691 troncons), a meandres, dont
 *     les extremites se rejoignent EXACTEMENT aux jonctions ;
 *   - une VOIRIE LOCALE promue (`sourceReference` « voirie_locale:... »), en trames de rues
 *     irregulieres autour des agglomerations, de 70 a 140 m de maille, orientees au hasard, dont
 *     la densite decroit du centre vers la peripherie, avec rues manquantes et courbes legeres.
 *
 * CE QUE CE N'EST PAS. Ni la geometrie reelle d'une route, ni la topologie reelle des carrefours, ni
 * la distribution reelle des longueurs. Les mesures faites dessus dependent du VOLUME et de la
 * forme generale du reseau, pas de sa fidelite cartographique.
 *
 * DETERMINISME. Aucune dependance a PostgreSQL ni a l'horloge : memes parametres => memes troncons,
 * octet pour octet (coordonnees arrondies a 6 decimales, soit 0,1 m). `empreinte()` le prouve.
 */
import { createHash } from "node:crypto";
import { Alea } from "./prng";

export const GRAINE_DEFAUT = 20261023;
/** Nombre de troncons du registre complet releve en production (AGENTS.md / PROJECT_STATUS). */
export const NOMBRE_REGISTRE_COMPLET = 261_387;
/** Troncons du reseau classe au registre (1 691), repris comme cible du reseau classe synthetique. */
export const CIBLE_RESEAU_CLASSE = 1_691;

export type Coord = [number, number]; // [lon, lat]

export interface Ville { nom: string; region: string; lon: number; lat: number; poids: number }

/** Positions APPROCHEES de chefs-lieux : sert uniquement a repartir le reseau dans l'espace. */
export const VILLES: readonly Ville[] = [
  { nom: "Conakry", region: "Conakry", lon: -13.68, lat: 9.54, poids: 30 },
  { nom: "Kindia", region: "Kindia", lon: -12.87, lat: 10.06, poids: 5 },
  { nom: "Mamou", region: "Mamou", lon: -12.09, lat: 10.38, poids: 3 },
  { nom: "Labe", region: "Labe", lon: -12.28, lat: 11.32, poids: 3 },
  { nom: "Kankan", region: "Kankan", lon: -9.31, lat: 10.39, poids: 5 },
  { nom: "Nzerekore", region: "Nzerekore", lon: -8.82, lat: 7.76, poids: 4 },
  { nom: "Faranah", region: "Faranah", lon: -10.75, lat: 10.04, poids: 2 },
  { nom: "Boke", region: "Boke", lon: -14.29, lat: 10.94, poids: 2.5 },
  { nom: "Siguiri", region: "Kankan", lon: -9.17, lat: 11.42, poids: 2.5 },
  { nom: "Kissidougou", region: "Faranah", lon: -10.10, lat: 9.19, poids: 2 },
  { nom: "Macenta", region: "Nzerekore", lon: -9.47, lat: 8.54, poids: 2 },
  { nom: "Gueckedou", region: "Nzerekore", lon: -10.13, lat: 8.57, poids: 2.5 },
  { nom: "Dabola", region: "Faranah", lon: -11.12, lat: 10.75, poids: 1 },
  { nom: "Telimele", region: "Kindia", lon: -13.04, lat: 10.91, poids: 1 },
  { nom: "Fria", region: "Boke", lon: -13.58, lat: 10.37, poids: 1 },
  { nom: "Coyah", region: "Kindia", lon: -13.39, lat: 9.71, poids: 1.5 },
  { nom: "Forecariah", region: "Kindia", lon: -13.09, lat: 9.43, poids: 1.2 },
  { nom: "Dubreka", region: "Kindia", lon: -13.52, lat: 9.79, poids: 1.5 },
  { nom: "Boffa", region: "Boke", lon: -14.04, lat: 10.18, poids: 1 },
  { nom: "Gaoual", region: "Boke", lon: -13.20, lat: 11.75, poids: 1 },
  { nom: "Koundara", region: "Boke", lon: -13.30, lat: 12.48, poids: 0.8 },
  { nom: "Mali", region: "Labe", lon: -12.30, lat: 12.08, poids: 0.8 },
  { nom: "Lelouma", region: "Labe", lon: -12.58, lat: 11.40, poids: 0.7 },
  { nom: "Pita", region: "Mamou", lon: -12.40, lat: 11.07, poids: 1 },
  { nom: "Dalaba", region: "Mamou", lon: -12.25, lat: 10.69, poids: 0.8 },
  { nom: "Tougue", region: "Labe", lon: -11.66, lat: 11.44, poids: 0.7 },
  { nom: "Kouroussa", region: "Kankan", lon: -9.89, lat: 10.65, poids: 1 },
  { nom: "Mandiana", region: "Kankan", lon: -8.69, lat: 10.62, poids: 1 },
  { nom: "Beyla", region: "Nzerekore", lon: -8.65, lat: 8.69, poids: 1 },
  { nom: "Lola", region: "Nzerekore", lon: -8.53, lat: 7.80, poids: 0.8 },
  { nom: "Yomou", region: "Nzerekore", lon: -9.26, lat: 7.57, poids: 0.8 },
  { nom: "Kerouane", region: "Kankan", lon: -9.01, lat: 9.27, poids: 0.8 },
  { nom: "Dinguiraye", region: "Faranah", lon: -10.72, lat: 11.30, poids: 0.8 },
  { nom: "Koubia", region: "Labe", lon: -11.90, lat: 11.58, poids: 0.5 },
];

/** Enveloppe tres grossiere du territoire, pour tirer des villages « a terre ». */
const CONTOUR: readonly Coord[] = [
  [-14.93, 10.95], [-14.1, 10.2], [-13.7, 9.5], [-13.3, 9.05], [-12.5, 8.7], [-11.5, 8.2], [-10.3, 8.3],
  [-9.3, 7.5], [-8.6, 7.3], [-8.3, 7.7], [-8.4, 8.4], [-8.2, 9.2], [-8.3, 10.2], [-8.5, 10.9],
  [-8.9, 11.9], [-9.6, 12.0], [-10.5, 11.9], [-11.4, 12.4], [-12.2, 12.45], [-13.7, 12.25], [-14.6, 11.5],
];

export interface TronconSynthetique {
  id: string;
  code: string;
  nom: string;
  classe: "RN" | "RR" | "NON_CLASSEE";
  categorie: "CLASSE" | "VOIRIE";
  regionNom: string;
  revetement: "BITUME" | "TERRE" | "LATERITE" | "NON_RENSEIGNE";
  longueurKm: number;
  pkDebut: number;
  pkFin: number;
  sourceReference: string | null;
  coordonnees: Coord[];
  /** Agglomeration de rattachement (voirie) ou null (classe) : sert a tirer des points GPS urbains. */
  agglomeration: string | null;
}

export interface ReseauSynthetique {
  graine: number;
  nombre: number;
  troncons: TronconSynthetique[];
  nombreClasse: number;
  nombreVoirie: number;
  regions: string[];
}

const M_PAR_DEG_LAT = 111_320;
const arrondi6 = (v: number) => Math.round(v * 1e6) / 1e6;

export function metresParDegreLon(lat: number): number {
  return M_PAR_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

/** Distance approchee en metres (plan local equirectangulaire), suffisante pour fabriquer des jeux. */
export function distanceApprocheeM(a: Coord, b: Coord): number {
  const lat = (a[1] + b[1]) / 2;
  const dx = (b[0] - a[0]) * metresParDegreLon(lat);
  const dy = (b[1] - a[1]) * M_PAR_DEG_LAT;
  return Math.hypot(dx, dy);
}

export function longueurPolylineM(c: readonly Coord[]): number {
  let s = 0;
  for (let i = 1; i < c.length; i += 1) s += distanceApprocheeM(c[i - 1], c[i]);
  return s;
}

function dansContour(lon: number, lat: number): boolean {
  let dedans = false;
  for (let i = 0, j = CONTOUR.length - 1; i < CONTOUR.length; j = i, i += 1) {
    const [xi, yi] = CONTOUR[i];
    const [xj, yj] = CONTOUR[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) dedans = !dedans;
  }
  return dedans;
}

const SYLLABES = ["ka", "ba", "ko", "ma", "ni", "sa", "da", "fa", "gu", "ya", "la", "so", "ti", "re", "di", "mo", "ke", "sin", "kan", "bou", "ta", "na", "wa", "hi"];
function nomPropre(a: Alea): string {
  const n = a.entier(2, 3);
  let s = "";
  for (let i = 0; i < n; i += 1) s += a.choisir(SYLLABES);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

interface Noeud { nom: string; region: string; lon: number; lat: number; ville: boolean }

function regionLaPlusProche(lon: number, lat: number): string {
  let best = VILLES[0];
  let bd = Infinity;
  for (const v of VILLES) {
    const d = Math.hypot((v.lon - lon) * metresParDegreLon(lat), (v.lat - lat) * M_PAR_DEG_LAT);
    if (d < bd) { bd = d; best = v; }
  }
  return best.region;
}

/** Axe entre deux noeuds : points espaces de `pasM`, avec meandres lisses, extremites exactes. */
function polylineAxe(a: Alea, A: Coord, B: Coord, pasM: number, bruitM: number): Coord[] {
  const D = distanceApprocheeM(A, B);
  const n = Math.max(2, Math.ceil(D / pasM) + 1);
  const lat0 = (A[1] + B[1]) / 2;
  const mx = metresParDegreLon(lat0);
  const ux = ((B[0] - A[0]) * mx) / D, uy = ((B[1] - A[1]) * M_PAR_DEG_LAT) / D; // sens A -> B, en metres
  const nx = -uy, ny = ux; // normale
  const a1 = 0.03 * D, a2 = 0.008 * D;
  const f1 = a.entre(1, 3), f2 = a.entre(4, 9), p1 = a.entre(0, 6.283), p2 = a.entre(0, 6.283);
  const pts: Coord[] = [];
  for (let k = 0; k < n; k += 1) {
    const t = k / (n - 1);
    const taper = Math.sin(Math.PI * t);
    const off = taper * (a1 * Math.sin(2 * Math.PI * f1 * t + p1) + a2 * Math.sin(2 * Math.PI * f2 * t + p2)) + (k === 0 || k === n - 1 ? 0 : bruitM * a.gauss());
    const along = t * D;
    const x = along * ux + off * nx, y = along * uy + off * ny; // metres depuis A
    pts.push([arrondi6(A[0] + x / mx), arrondi6(A[1] + y / M_PAR_DEG_LAT)]);
  }
  pts[0] = [arrondi6(A[0]), arrondi6(A[1])];
  pts[n - 1] = [arrondi6(B[0]), arrondi6(B[1])];
  return pts;
}

function construireAxes(a: Alea): { noeuds: Noeud[]; aretes: { i: number; j: number; nationale: boolean }[] } {
  const noeuds: Noeud[] = VILLES.map((v) => ({ nom: v.nom, region: v.region, lon: v.lon, lat: v.lat, ville: true }));
  const poids = VILLES.map((v) => v.poids);
  while (noeuds.length < VILLES.length + 260) {
    let lon: number, lat: number;
    if (a.suivant() < 0.5) {
      const v = VILLES[a.indicePondere(poids)];
      lon = v.lon + (a.gauss() * 0.5);
      lat = v.lat + (a.gauss() * 0.5);
    } else {
      lon = a.entre(-14.9, -8.3);
      lat = a.entre(7.3, 12.4);
    }
    if (!dansContour(lon, lat)) continue;
    noeuds.push({ nom: `${nomPropre(a)}`, region: regionLaPlusProche(lon, lat), lon: arrondi6(lon), lat: arrondi6(lat), ville: false });
  }
  const dist = (i: number, j: number) => distanceApprocheeM([noeuds[i].lon, noeuds[i].lat], [noeuds[j].lon, noeuds[j].lat]);
  const cle = (i: number, j: number) => (i < j ? `${i}-${j}` : `${j}-${i}`);
  const vus = new Set<string>();
  const aretes: { i: number; j: number; nationale: boolean }[] = [];
  const ajouter = (i: number, j: number) => {
    const k = cle(i, j);
    if (i === j || vus.has(k)) return;
    vus.add(k);
    aretes.push({ i: Math.min(i, j), j: Math.max(i, j), nationale: noeuds[i].ville && noeuds[j].ville });
  };
  // Arbre couvrant minimal (Prim) : le reseau est connexe.
  const dansArbre = new Array<boolean>(noeuds.length).fill(false);
  const meilleur = new Array<number>(noeuds.length).fill(Infinity);
  const parent = new Array<number>(noeuds.length).fill(-1);
  meilleur[0] = 0;
  for (let it = 0; it < noeuds.length; it += 1) {
    let u = -1;
    for (let k = 0; k < noeuds.length; k += 1) if (!dansArbre[k] && (u === -1 || meilleur[k] < meilleur[u])) u = k;
    dansArbre[u] = true;
    if (parent[u] >= 0) ajouter(parent[u], u);
    for (let k = 0; k < noeuds.length; k += 1) {
      if (!dansArbre[k]) { const d = dist(u, k); if (d < meilleur[k]) { meilleur[k] = d; parent[k] = u; } }
    }
  }
  // Mailles : chaque noeud se relie a ses 3 plus proches voisins.
  for (let i = 0; i < noeuds.length; i += 1) {
    const voisins = noeuds.map((_, j) => ({ j, d: i === j ? Infinity : dist(i, j) })).sort((x, y) => x.d - y.d).slice(0, 4);
    for (const v of voisins) ajouter(i, v.j);
  }
  return { noeuds, aretes };
}

function genererClasse(a: Alea, departId: number): TronconSynthetique[] {
  const { noeuds, aretes } = construireAxes(a);
  const sortie: TronconSynthetique[] = [];
  let axe = 0;
  let n = departId;
  for (const e of aretes) {
    axe += 1;
    const A = noeuds[e.i], B = noeuds[e.j];
    const classe: "RN" | "RR" = e.nationale ? "RN" : "RR";
    // Densite de points du registre : 12,0 pts/km sur les nationales, 2,2 sur les regionales.
    const pasM = classe === "RN" ? 83 : 450;
    const ligne = polylineAxe(a, [A.lon, A.lat], [B.lon, B.lat], pasM, classe === "RN" ? 2 : 6);
    // Decoupage en troncons de longueur log-normale (moyenne ~12,5 km, bornes 1,5 a 45 km).
    const cumul: number[] = [0];
    for (let k = 1; k < ligne.length; k += 1) cumul.push(cumul[k - 1] + distanceApprocheeM(ligne[k - 1], ligne[k]));
    const total = cumul[cumul.length - 1];
    const bornes: number[] = [0];
    let courant = 0;
    while (courant < total) {
      const l = Math.min(45_000, Math.max(1_500, 14_000 * Math.exp(0.5 * a.gauss() - 0.125)));
      courant += l;
      if (total - courant < 1_500) break;
      let k = cumul.findIndex((c) => c >= courant);
      if (k <= bornes[bornes.length - 1]) k = bornes[bornes.length - 1] + 1;
      if (k >= ligne.length - 1) break;
      bornes.push(k);
      courant = cumul[k];
    }
    bornes.push(ligne.length - 1);
    let pkCourant = 0;
    for (let s = 0; s + 1 < bornes.length; s += 1) {
      const coords = ligne.slice(bornes[s], bornes[s + 1] + 1);
      const lKm = Math.round((longueurPolylineM(coords) / 1000) * 1000) / 1000;
      n += 1;
      const section = s + 1;
      // Un tiers des troncons classes portent un PK exploitable (551 sur 1 691 au registre).
      const avecPk = classe === "RN" && a.suivant() < 0.9 || classe === "RR" && a.suivant() < 0.02;
      sortie.push({
        id: `perf-${n}`,
        code: `GN ${classe === "RN" ? "N" : "R"}${String(axe).padStart(4, "0")} ${section}-${1000 + n}`,
        nom: `${classe === "RN" ? "RN" : "RR"}${axe} ${A.nom} - ${B.nom}`,
        classe,
        categorie: "CLASSE",
        regionNom: A.region,
        revetement: classe === "RN" ? (a.suivant() < 0.85 ? "BITUME" : "LATERITE") : (a.suivant() < 0.3 ? "BITUME" : a.suivant() < 0.5 ? "LATERITE" : "TERRE"),
        longueurKm: lKm,
        pkDebut: avecPk ? Math.round(pkCourant * 1000) / 1000 : 0,
        pkFin: avecPk ? Math.round((pkCourant + lKm) * 1000) / 1000 : 0,
        sourceReference: null,
        coordonnees: coords,
        agglomeration: null,
      });
      pkCourant += lKm;
    }
  }
  return sortie;
}

const TYPES_VOIE = ["Rue", "Avenue", "Boulevard", "Impasse", "Route de", "Chemin de", "Allee"];

interface Agglo { nom: string; lon: number; lat: number; region: string; poids: number; sigle: string }

function agglomerations(a: Alea): Agglo[] {
  const liste: Agglo[] = VILLES.map((v) => ({ nom: v.nom, lon: v.lon, lat: v.lat, region: v.region, poids: v.poids, sigle: v.nom.slice(0, 3).toUpperCase() }));
  // Quelques bourgs en plus des chefs-lieux : le semis local ne se limite pas aux grandes villes.
  const poids = VILLES.map((v) => v.poids);
  for (let i = 0; i < 60; i += 1) {
    const v = VILLES[a.indicePondere(poids)];
    const lon = v.lon + a.gauss() * 0.4, lat = v.lat + a.gauss() * 0.4;
    if (!dansContour(lon, lat)) { i -= 1; continue; }
    const nom = nomPropre(a);
    liste.push({ nom, lon: arrondi6(lon), lat: arrondi6(lat), region: v.region, poids: 0.15, sigle: `B${String(i).padStart(2, "0")}` });
  }
  return liste;
}

function genererVoirie(a: Alea, besoin: number, departId: number): TronconSynthetique[] {
  if (besoin <= 0) return [];
  const aggs = agglomerations(a);
  const totalPoids = aggs.reduce((s, g) => s + g.poids, 0);
  const attribue = aggs.map((g) => Math.floor((besoin * g.poids) / totalPoids));
  let reste = besoin - attribue.reduce((s, v) => s + v, 0);
  for (let i = 0; reste > 0; i = (i + 1) % aggs.length, reste -= 1) attribue[i] += 1;

  const sortie: TronconSynthetique[] = [];
  let n = departId;
  for (let gi = 0; gi < aggs.length; gi += 1) {
    const g = aggs[gi];
    const need = attribue[gi];
    if (need === 0) continue;
    const maille = a.entre(70, 140) * (gi === 0 ? 0.7 : 1);
    const theta = a.entre(0, Math.PI);
    const cos = Math.cos(theta), sin = Math.sin(theta);
    // 2 aretes par noeud, ~12 % de rues manquantes, ~45 % de marge pour decouper un disque.
    // Si la trame est trop petite (effets de bord des petites agglomerations), on l'agrandit :
    // le tirage reste deterministe, seule la taille de la trame change.
    let k = Math.max(3, Math.ceil(Math.sqrt((need / (2 * 0.88)) * 1.45)));
    let candidates: { rayon: number; ix: number; iy: number; dir: 0 | 1 }[] = [];
    for (;;) {
      candidates = [];
      for (let ix = 0; ix < k; ix += 1) {
        for (let iy = 0; iy < k; iy += 1) {
          const cx = ix - k / 2, cy = iy - k / 2;
          const rayon = Math.hypot(cx, cy) * (0.85 + 0.3 * a.suivant());
          if (ix + 1 < k && a.suivant() > 0.12) candidates.push({ rayon, ix, iy, dir: 0 });
          if (iy + 1 < k && a.suivant() > 0.12) candidates.push({ rayon, ix, iy, dir: 1 });
        }
      }
      if (candidates.length >= need) break;
      k += 1;
    }
    const taille = k;
    const mx = metresParDegreLon(g.lat);
    const noeud = (ix: number, iy: number): Coord => {
      // Jitter FIXE par noeud : derive de l'indice, pas d'un tirage dans l'ordre des aretes.
      const h = Math.imul(ix * 73856093 ^ iy * 19349663 ^ (gi + 1) * 83492791, 2654435761) >>> 0;
      const jx = ((h & 0xffff) / 65535 - 0.5) * 0.5 * maille;
      const jy = (((h >>> 16) & 0xffff) / 65535 - 0.5) * 0.5 * maille;
      const px = (ix - taille / 2) * maille + jx, py = (iy - taille / 2) * maille + jy;
      const rx = px * cos - py * sin, ry = px * sin + py * cos;
      return [arrondi6(g.lon + rx / mx), arrondi6(g.lat + ry / M_PAR_DEG_LAT)];
    };
    candidates.sort((x, y) => x.rayon - y.rayon || x.ix - y.ix || x.iy - y.iy || x.dir - y.dir);
    for (let c = 0; c < need; c += 1) {
      const e = candidates[c];
      const P = noeud(e.ix, e.iy);
      const Q = e.dir === 0 ? noeud(e.ix + 1, e.iy) : noeud(e.ix, e.iy + 1);
      const coords: Coord[] = [P];
      if (a.suivant() < 0.5) {
        const dx = (Q[0] - P[0]) * mx, dy = (Q[1] - P[1]) * M_PAR_DEG_LAT;
        const l = Math.hypot(dx, dy) || 1;
        const off = a.gauss() * 0.06 * l;
        coords.push([arrondi6((P[0] + Q[0]) / 2 + (-dy / l) * off / mx), arrondi6((P[1] + Q[1]) / 2 + (dx / l) * off / M_PAR_DEG_LAT)]);
      }
      coords.push(Q);
      n += 1;
      const lKm = Math.round((longueurPolylineM(coords) / 1000) * 1e5) / 1e5;
      const nomme = a.suivant() < 0.6;
      sortie.push({
        id: `perf-${n}`,
        code: `VL-${g.sigle}-${String(n).padStart(6, "0")}`,
        nom: nomme ? `${a.choisir(TYPES_VOIE)} ${nomPropre(a)} ${g.nom}` : `Voie sans nom ${g.nom} ${n}`,
        classe: "NON_CLASSEE",
        categorie: "VOIRIE",
        regionNom: g.region,
        revetement: "NON_RENSEIGNE",
        longueurKm: lKm,
        pkDebut: 0,
        pkFin: 0,
        sourceReference: `voirie_locale:perf:${n}`,
        coordonnees: coords,
        agglomeration: g.nom,
      });
    }
  }
  return sortie;
}

/**
 * Reseau complet de `nombre` troncons (au moins CIBLE_RESEAU_CLASSE + 1 000 ; en dessous, le
 * reseau classe garde sa taille emergente et la voirie complete le total).
 */
export function genererReseau(opts: { graine?: number; nombre: number } = { nombre: 20_000 }): ReseauSynthetique {
  const graine = opts.graine ?? GRAINE_DEFAUT;
  const classe = genererClasse(new Alea(graine), 0);
  const nombre = Math.max(opts.nombre, classe.length + 1_000);
  const voirie = genererVoirie(new Alea(graine + 1), nombre - classe.length, classe.length);
  const troncons = [...classe, ...voirie];
  return {
    graine, nombre: troncons.length, troncons,
    nombreClasse: classe.length, nombreVoirie: voirie.length,
    regions: [...new Set(troncons.map((t) => t.regionNom))].sort(),
  };
}

export function wkt(c: readonly Coord[]): string {
  return `LINESTRING(${c.map(([x, y]) => `${x} ${y}`).join(", ")})`;
}

/** SHA-256 de tout le jeu : deux executions identiques donnent la meme empreinte. */
export function empreinte(r: ReseauSynthetique): string {
  const h = createHash("sha256");
  for (const t of r.troncons) h.update(`${t.id}|${t.code}|${t.nom}|${t.classe}|${t.sourceReference ?? ""}|${t.pkDebut}|${t.pkFin}|${wkt(t.coordonnees)}\n`);
  return h.digest("hex");
}

/** Statistiques de description (pour le rapport : on mesure le jeu, on ne le suppose pas). */
export function decrire(r: ReseauSynthetique) {
  const stat = (liste: TronconSynthetique[]) => {
    const longs = liste.map((t) => longueurPolylineM(t.coordonnees));
    const somme = longs.reduce((s, v) => s + v, 0);
    const pts = liste.reduce((s, t) => s + t.coordonnees.length, 0);
    return {
      troncons: liste.length,
      kmTotal: Math.round(somme / 100) / 10,
      longueurMoyenneM: Math.round(somme / Math.max(1, liste.length)),
      longueurMaxM: Math.round(longs.reduce((m, v) => Math.max(m, v), 0)),
      pointsParTroncon: Math.round((pts / Math.max(1, liste.length)) * 10) / 10,
      pointsParKm: Math.round((pts / Math.max(1e-9, somme / 1000)) * 10) / 10,
    };
  };
  return {
    classe: stat(r.troncons.filter((t) => t.categorie === "CLASSE")),
    voirie: stat(r.troncons.filter((t) => t.categorie === "VOIRIE")),
  };
}

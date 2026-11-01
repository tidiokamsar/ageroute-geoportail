/**
 * Construction du graphe D'ORIGINE (commit 2943e22, avant l'index spatial des extremites de
 * `src/geo/graphe.noyau.ts`), recopiee telle quelle -- seul le nom change. Deux usages :
 *
 *   - `src/geo/graphe.noyau.equivalence.test.ts` exige que la version indexee rende exactement le meme
 *     graphe sur des reseaux tires au hasard ;
 *   - le banc de performance la chronometre sur les memes entrees que la version indexee, pour que
 *     le « avant » de la correction soit rejouable et non rapporte de memoire.
 *
 * Ne pas la corriger ni l'optimiser : sa raison d'etre est de rester l'ancienne.
 */
import type { TronconGraphe } from "./graphe.noyau";

const RAYON_TERRE_M = 6371008.8;
const DEG = Math.PI / 180;

interface ArcRef { vers: number; poidsM: number; tronconId: string; deM: number; aM: number }
interface NoeudsTronconRef { longueurM: number; abscisses: number[]; noeuds: number[] }

export interface GrapheReference {
  nbNoeuds: number;
  nbJonctionsInterieures: number;
  parTroncon: Map<string, NoeudsTronconRef>;
  adjacence: ArcRef[][];
}

function haversineM(a: [number, number], b: [number, number]): number {
  const dLat = (b[1] - a[1]) * DEG;
  const dLon = (b[0] - a[0]) * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * DEG) * Math.cos(b[1] * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * RAYON_TERRE_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function versPlan(o: [number, number], p: [number, number]): [number, number] {
  return [(p[0] - o[0]) * DEG * RAYON_TERRE_M * Math.cos(o[1] * DEG), (p[1] - o[1]) * DEG * RAYON_TERRE_M];
}

function projeter(poly: [number, number][], p: [number, number]): { distance: number; abscisse: number; longueur: number } {
  let meilleur = { distance: Infinity, abscisse: 0 };
  let cumul = 0;
  for (let i = 0; i < poly.length - 1; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[i + 1];
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const l = Math.sqrt(l2);
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2));
    const qx = ax + t * dx, qy = ay + t * dy;
    const d = Math.hypot(p[0] - qx, p[1] - qy);
    if (d < meilleur.distance) meilleur = { distance: d, abscisse: cumul + t * l };
    cumul += l;
  }
  return { ...meilleur, longueur: cumul };
}

export function construireGrapheReference(troncons: readonly TronconGraphe[], toleranceFusionM: number): GrapheReference {
  const valides = troncons.filter((t) => t.coordonnees.length >= 2 && t.longueurM > 0);
  const pos: [number, number][] = [];
  const grille = new Map<string, number[]>();
  const cle = (p: [number, number]) => {
    const latM = p[1] * DEG * RAYON_TERRE_M;
    const lonM = p[0] * DEG * RAYON_TERRE_M * Math.cos(p[1] * DEG);
    return [Math.floor(lonM / toleranceFusionM), Math.floor(latM / toleranceFusionM)];
  };
  function noeudPour(p: [number, number]): number {
    const [cx, cy] = cle(p);
    let meilleur = -1, dMin = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const n of grille.get(`${cx + dx}|${cy + dy}`) ?? []) {
        const d = haversineM(pos[n], p);
        if (d <= toleranceFusionM && d < dMin) { dMin = d; meilleur = n; }
      }
    }
    if (meilleur >= 0) return meilleur;
    pos.push(p);
    const k = `${cx}|${cy}`;
    grille.set(k, [...(grille.get(k) ?? []), pos.length - 1]);
    return pos.length - 1;
  }

  const parTroncon = new Map<string, NoeudsTronconRef>();
  const extremites: { tronconId: string; noeud: number; p: [number, number] }[] = [];
  for (const t of valides) {
    const a = t.coordonnees[0], b = t.coordonnees[t.coordonnees.length - 1];
    const na = noeudPour(a), nb = noeudPour(b);
    parTroncon.set(t.id, { longueurM: t.longueurM, abscisses: [0, t.longueurM], noeuds: [na, nb] });
    extremites.push({ tronconId: t.id, noeud: na, p: a }, { tronconId: t.id, noeud: nb, p: b });
  }

  let nbJonctionsInterieures = 0;
  for (const t of valides) {
    const o = t.coordonnees[0];
    const poly = t.coordonnees.map((c) => versPlan(o, c));
    const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
    const minX = Math.min(...xs) - toleranceFusionM, maxX = Math.max(...xs) + toleranceFusionM;
    const minY = Math.min(...ys) - toleranceFusionM, maxY = Math.max(...ys) + toleranceFusionM;
    const nt = parTroncon.get(t.id)!;
    for (const e of extremites) {
      if (e.tronconId === t.id) continue;
      const q = versPlan(o, e.p);
      if (q[0] < minX || q[0] > maxX || q[1] < minY || q[1] > maxY) continue;
      const pr = projeter(poly, q);
      if (pr.distance > toleranceFusionM || pr.longueur === 0) continue;
      const s = (pr.abscisse / pr.longueur) * t.longueurM;
      if (s <= toleranceFusionM || s >= t.longueurM - toleranceFusionM) continue;
      if (nt.noeuds.includes(e.noeud)) continue;
      nt.abscisses.push(s);
      nt.noeuds.push(e.noeud);
      nbJonctionsInterieures++;
    }
    const ordre = nt.abscisses.map((s, i) => [s, nt.noeuds[i]] as const).sort((x, y) => x[0] - y[0]);
    nt.abscisses = ordre.map((x) => x[0]);
    nt.noeuds = ordre.map((x) => x[1]);
  }

  const adjacence: ArcRef[][] = Array.from({ length: pos.length }, () => []);
  for (const [tronconId, nt] of parTroncon) {
    for (let i = 0; i < nt.noeuds.length - 1; i++) {
      const a = nt.noeuds[i], b = nt.noeuds[i + 1];
      const s0 = nt.abscisses[i], s1 = nt.abscisses[i + 1];
      const poids = s1 - s0;
      if (a === b) continue;
      adjacence[a].push({ vers: b, poidsM: poids, tronconId, deM: s0, aM: s1 });
      adjacence[b].push({ vers: a, poidsM: poids, tronconId, deM: s1, aM: s0 });
    }
  }
  return { nbNoeuds: pos.length, nbJonctionsInterieures, parTroncon, adjacence };
}

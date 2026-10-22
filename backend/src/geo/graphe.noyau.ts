/**
 * Graphe du reseau pour la distance SUR LE RESEAU (paragraphe 7.3.7), injectee dans le HMM de
 * `appariement.trace.ts` par `distanceReseauM`. Aucune importation.
 *
 * POURQUOI CE MODULE EXISTE
 *
 * Sans graphe, le HMM ne sait pas qu'une contre-allee parallele a 25 m est a 800 m de detour :
 * la transition entre deux troncons differents devient neutre et la decision retombe sur la
 * distance seule. Le jeu annote le mesurait avec une distance ecrite A LA MAIN ; ce module la
 * calcule depuis la geometrie.
 *
 * CONSTRUCTION
 *
 * 1. Les extremites de troncons distantes de moins de `toleranceFusionM` sont FUSIONNEES en un
 *    noeud. La tolerance est un parametre OBLIGATOIRE : une valeur par defaut serait une regle de
 *    topologie inventee, et elle depend de la qualite de saisie du referentiel.
 * 2. Une extremite qui touche l'INTERIEUR d'un autre troncon (jonction en T : une route qui
 *    part du milieu d'une autre) COUPE ce troncon en un noeud de jonction. Sans cela, tout
 *    carrefour place hors des extremites -- frequent quand les troncons ne sont pas decoupes aux
 *    carrefours -- serait invisible.
 * 3. Chaque troncon devient une suite d'arcs entre ses noeuds, ponderes par la LONGUEUR MESUREE
 *    (`longueurM`, calculee en `geography` par l'appelant, paragraphe 7.1), repartie au prorata
 *    de la polyligne.
 *
 * CE QUE LE GRAPHE NE SAIT PAS, ET QU'IL FAUT DIRE
 *
 * - Les SENS UNIQUES : le referentiel n'en porte aucun. Le graphe est NON ORIENTE ; une distance
 *   rendue peut emprunter un sens interdit.
 * - Les FRANCHISSEMENTS sans jonction (pont au-dessus d'une route) : deux troncons qui se
 *   croisent sans qu'une extremite touche l'autre ne sont PAS relies, et c'est le comportement
 *   voulu -- un croisement n'est pas un carrefour.
 * - Les troncons hors du lot charge : la distance est celle du sous-reseau fourni. Hors de lui,
 *   la reponse est `null`, jamais une estimation.
 *
 * Les calculs plans se font en projection equirectangulaire locale, troncon par troncon : sur
 * quelques kilometres, l'erreur est tres inferieure au metre, et la longueur publiee reste celle
 * de `longueurM`.
 */

const RAYON_TERRE_M = 6371008.8;
const DEG = Math.PI / 180;

export interface TronconGraphe {
  id: string;
  /** Longueur mesuree (geography), en metres. */
  longueurM: number;
  /** Polyligne [lon, lat] en EPSG:4326, dans le sens de l'abscisse. */
  coordonnees: [number, number][];
}

/** Un arc porte son troncon et ses abscisses, du noeud de depart vers le noeud d'arrivee. */
interface Arc { vers: number; poidsM: number; tronconId: string; deM: number; aM: number }

/** Sur un troncon : ses noeuds tries par abscisse. */
interface NoeudsTroncon { longueurM: number; abscisses: number[]; noeuds: number[] }

export interface Graphe {
  readonly nbNoeuds: number;
  readonly nbJonctionsInterieures: number;
  readonly parTroncon: ReadonlyMap<string, NoeudsTroncon>;
  readonly adjacence: readonly Arc[][];
}

/** Distance haversine en metres. */
function haversineM(a: [number, number], b: [number, number]): number {
  const dLat = (b[1] - a[1]) * DEG;
  const dLon = (b[0] - a[0]) * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * DEG) * Math.cos(b[1] * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * RAYON_TERRE_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Projection equirectangulaire locale autour de `o`, en metres. */
function versPlan(o: [number, number], p: [number, number]): [number, number] {
  return [(p[0] - o[0]) * DEG * RAYON_TERRE_M * Math.cos(o[1] * DEG), (p[1] - o[1]) * DEG * RAYON_TERRE_M];
}

/** Projection d'un point sur une polyligne plane : distance au trace et abscisse curviligne. */
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

export function construireGraphe(troncons: readonly TronconGraphe[], toleranceFusionM: number): Graphe {
  if (!(toleranceFusionM > 0)) {
    throw new Error("construireGraphe : la tolerance de fusion doit etre strictement positive (aucune valeur n'est supposee)");
  }
  const valides = troncons.filter((t) => t.coordonnees.length >= 2 && t.longueurM > 0);

  // 1. Fusion des extremites, par grille de pas `toleranceFusionM` (voisinage 3 x 3).
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

  const parTroncon = new Map<string, NoeudsTroncon>();
  const extremites: { tronconId: string; noeud: number; p: [number, number] }[] = [];
  for (const t of valides) {
    const a = t.coordonnees[0], b = t.coordonnees[t.coordonnees.length - 1];
    const na = noeudPour(a), nb = noeudPour(b);
    parTroncon.set(t.id, { longueurM: t.longueurM, abscisses: [0, t.longueurM], noeuds: [na, nb] });
    extremites.push({ tronconId: t.id, noeud: na, p: a }, { tronconId: t.id, noeud: nb, p: b });
  }

  // 2. Jonctions en T : une extremite pres de l'interieur d'un AUTRE troncon le coupe.
  let nbJonctionsInterieures = 0;

  // INDEX SPATIAL DES EXTREMITES (grille en degres, 0,01 deg ~ 1,1 km).
  //
  // Cette etape comparait chaque troncon a TOUTES les extremites du lot : O(T x E), avec une
  // projection trigonometrique par couple. Mesure du 23/10/2026 sur un sous-reseau de 7 000 troncons :
  // 34 s. L'index ne change PAS le resultat : il ne fait que ne presenter a l'ancien test (boite
  // englobante puis projection) que les extremites situees dans la boite englobante du troncon
  // (meme boite, exprimee en degres : la projection locale est lineaire en lon et en lat), et elles
  // sont presentees dans l'ordre d'origine, donc les jonctions s'ajoutent dans le meme ordre.
  const PAS_GRILLE = 0.01;
  const grilleExt = new Map<string, number[]>();
  extremites.forEach((e, idx) => {
    const k = `${Math.floor(e.p[0] / PAS_GRILLE)}|${Math.floor(e.p[1] / PAS_GRILLE)}`;
    const l = grilleExt.get(k);
    if (l) l.push(idx); else grilleExt.set(k, [idx]);
  });

  for (const t of valides) {
    const o = t.coordonnees[0];
    const poly = t.coordonnees.map((c) => versPlan(o, c));
    const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
    const minX = Math.min(...xs) - toleranceFusionM, maxX = Math.max(...xs) + toleranceFusionM;
    const minY = Math.min(...ys) - toleranceFusionM, maxY = Math.max(...ys) + toleranceFusionM;
    const nt = parTroncon.get(t.id)!;

    // Boite englobante en degres (marge de securite de 1e-7 deg ~ 1 cm : l'ancien test exact suit).
    const echelleLon = DEG * RAYON_TERRE_M * Math.cos(o[1] * DEG);
    const echelleLat = DEG * RAYON_TERRE_M;
    const lonMin = o[0] + minX / echelleLon - 1e-7, lonMax = o[0] + maxX / echelleLon + 1e-7;
    const latMin = o[1] + minY / echelleLat - 1e-7, latMax = o[1] + maxY / echelleLat + 1e-7;
    let candidats: number[] = [];
    const gx0 = Math.floor(lonMin / PAS_GRILLE), gx1 = Math.floor(lonMax / PAS_GRILLE);
    const gy0 = Math.floor(latMin / PAS_GRILLE), gy1 = Math.floor(latMax / PAS_GRILLE);
    const nbCellules = (gx1 - gx0 + 1) * (gy1 - gy0 + 1);
    if (!Number.isFinite(nbCellules) || nbCellules > extremites.length) {
      // Boite plus etendue que le semis d'extremites (ou coordonnees non finies) : balayage complet, comme avant.
      candidats = extremites.map((_, i) => i);
    } else {
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gy = gy0; gy <= gy1; gy++) {
          const l = grilleExt.get(`${gx}|${gy}`);
          if (l) for (const idx of l) candidats.push(idx);
        }
      }
      candidats.sort((a, b) => a - b);
    }

    for (const idx of candidats) {
      const e = extremites[idx];
      if (e.tronconId === t.id) continue;
      const q = versPlan(o, e.p);
      if (q[0] < minX || q[0] > maxX || q[1] < minY || q[1] > maxY) continue;
      const pr = projeter(poly, q);
      if (pr.distance > toleranceFusionM || pr.longueur === 0) continue;
      // Ramene a la longueur mesuree, au prorata de la polyligne.
      const s = (pr.abscisse / pr.longueur) * t.longueurM;
      // Trop pres d'une extremite : deja fusionnee a l'etape 1.
      if (s <= toleranceFusionM || s >= t.longueurM - toleranceFusionM) continue;
      if (nt.noeuds.includes(e.noeud)) continue;
      nt.abscisses.push(s);
      nt.noeuds.push(e.noeud);
      nbJonctionsInterieures++;
    }
    // Tri des noeuds par abscisse.
    const ordre = nt.abscisses.map((s, i) => [s, nt.noeuds[i]] as const).sort((x, y) => x[0] - y[0]);
    nt.abscisses = ordre.map((x) => x[0]);
    nt.noeuds = ordre.map((x) => x[1]);
  }

  // 3. Arcs entre noeuds consecutifs de chaque troncon.
  const adjacence: Arc[][] = Array.from({ length: pos.length }, () => []);
  for (const [tronconId, nt] of parTroncon) {
    for (let i = 0; i < nt.noeuds.length - 1; i++) {
      const a = nt.noeuds[i], b = nt.noeuds[i + 1];
      const s0 = nt.abscisses[i], s1 = nt.abscisses[i + 1];
      const poids = s1 - s0;
      if (a === b) continue; // boucle degeneree : un troncon ferme sur lui-meme
      adjacence[a].push({ vers: b, poidsM: poids, tronconId, deM: s0, aM: s1 });
      adjacence[b].push({ vers: a, poidsM: poids, tronconId, deM: s1, aM: s0 });
    }
  }
  return { nbNoeuds: pos.length, nbJonctionsInterieures, parTroncon, adjacence };
}

/** Tas binaire minimal pour Dijkstra. */
class Tas {
  private v: [number, number][] = [];
  get taille() { return this.v.length; }
  pousser(d: number, n: number) {
    const v = this.v; v.push([d, n]);
    let i = v.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (v[p][0] <= v[i][0]) break; [v[p], v[i]] = [v[i], v[p]]; i = p; }
  }
  extraire(): [number, number] {
    const v = this.v; const haut = v[0]; const dernier = v.pop()!;
    if (v.length > 0) {
      v[0] = dernier; let i = 0;
      for (;;) {
        const g = 2 * i + 1, d = g + 1; let m = i;
        if (g < v.length && v[g][0] < v[m][0]) m = g;
        if (d < v.length && v[d][0] < v[m][0]) m = d;
        if (m === i) break; [v[m], v[i]] = [v[i], v[m]]; i = m;
      }
    }
    return haut;
  }
}

/** Distances depuis un noeud, bornees a `maxM`. */
function dijkstra(g: Graphe, depart: number, maxM: number): Map<number, number> {
  const dist = new Map<number, number>([[depart, 0]]);
  const tas = new Tas();
  tas.pousser(0, depart);
  while (tas.taille > 0) {
    const [d, n] = tas.extraire();
    if (d > (dist.get(n) ?? Infinity)) continue;
    for (const a of g.adjacence[n]) {
      const nd = d + a.poidsM;
      if (nd > maxM) continue;
      if (nd < (dist.get(a.vers) ?? Infinity)) { dist.set(a.vers, nd); tas.pousser(nd, a.vers); }
    }
  }
  return dist;
}

/** Les deux noeuds qui encadrent une abscisse, avec la distance a chacun. */
function encadrement(nt: NoeudsTroncon, abscisseM: number): { noeud: number; coutM: number }[] {
  const s = Math.max(0, Math.min(nt.longueurM, abscisseM));
  let i = 0;
  while (i < nt.abscisses.length - 2 && nt.abscisses[i + 1] < s) i++;
  return [
    { noeud: nt.noeuds[i], coutM: s - nt.abscisses[i] },
    { noeud: nt.noeuds[i + 1], coutM: nt.abscisses[i + 1] - s },
  ];
}

/**
 * Fabrique la fonction `distanceReseauM` attendue par le HMM. Distance la plus courte sur le
 * graphe entre deux positions (troncon, abscisse), ou `null` : troncon hors du lot, ou aucun
 * chemin de moins de `distanceMaxM`. Les distances depuis chaque noeud sont mises en cache.
 */
export function distanceReseauDepuis(
  g: Graphe,
  opts: { distanceMaxM: number },
): (depuis: { tronconId: string; abscisseM: number }, vers: { tronconId: string; abscisseM: number }) => number | null {
  if (!(opts.distanceMaxM > 0)) throw new Error("distanceReseauDepuis : distanceMaxM doit etre strictement positive");
  const cache = new Map<number, Map<number, number>>();
  const depuisNoeud = (n: number) => {
    let d = cache.get(n);
    if (!d) { d = dijkstra(g, n, opts.distanceMaxM); cache.set(n, d); }
    return d;
  };
  return (a, b) => {
    const ta = g.parTroncon.get(a.tronconId), tb = g.parTroncon.get(b.tronconId);
    if (!ta || !tb) return null;
    let meilleure = Infinity;
    // Sur le meme troncon, entre les memes noeuds : le long du troncon.
    if (a.tronconId === b.tronconId) {
      const sa = Math.max(0, Math.min(ta.longueurM, a.abscisseM));
      const sb = Math.max(0, Math.min(ta.longueurM, b.abscisseM));
      meilleure = Math.abs(sa - sb);
    }
    for (const x of encadrement(ta, a.abscisseM)) {
      const d = depuisNoeud(x.noeud);
      for (const y of encadrement(tb, b.abscisseM)) {
        const m = d.get(y.noeud);
        if (m === undefined) continue;
        meilleure = Math.min(meilleure, x.coutM + m + y.coutM);
      }
    }
    return meilleure <= opts.distanceMaxM ? meilleure : null;
  };
}

// ===================== Deviation (paragraphe 7.14, R-01 ; § 7.16 ligne 13) =====================

/** Une coupure : un intervalle d'abscisses d'un troncon, que la deviation doit eviter. */
export interface Coupure { tronconId: string; debutM: number; finM: number }

/** Un morceau de troncon emprunte, de `deM` vers `aM` (le sens de parcours). */
export interface SegmentItineraire { tronconId: string; deM: number; aM: number }

export interface Deviation {
  /** Longueur de la deviation, en metres, du bord amont au bord aval de la coupure. */
  longueurM: number;
  /** Longueur coupee, donc evitee. */
  longueurCoupeeM: number;
  /** Ce que la deviation ajoute au trajet direct : longueur - longueur coupee. */
  allongementM: number;
  segments: SegmentItineraire[];
}

export type RefusDeviation = { refus: "TRONCON_HORS_GRAPHE" | "COUPURE_INVALIDE" | "AUCUNE_DEVIATION"; motif: string };

/**
 * Le plus court chemin d'un bord de la coupure a l'autre, SANS emprunter la portion coupee.
 *
 * Depuis le bord amont (`debutM`), on repart vers l'amont du troncon ; on rejoint le bord aval
 * (`finM`) par l'aval. Les arcs du troncon qui recouvrent la coupure sont exclus. Le reseau est
 * non oriente : une deviation rendue peut emprunter un sens interdit, que le referentiel ignore.
 *
 * AUCUNE DEVIATION n'est une reponse legitime : une route en cul-de-sac, ou dont le detour depasse
 * `distanceMaxM`, n'en a pas dans le sous-reseau charge. Elle est rendue telle quelle, jamais
 * remplacee par un trajet approximatif.
 */
export function deviation(g: Graphe, c: Coupure, opts: { distanceMaxM: number }): Deviation | RefusDeviation {
  if (!(opts.distanceMaxM > 0)) throw new Error("deviation : distanceMaxM doit etre strictement positive");
  const nt = g.parTroncon.get(c.tronconId);
  if (!nt) return { refus: "TRONCON_HORS_GRAPHE", motif: "Le troncon coupe n'est pas dans le sous-reseau charge." };
  if (!(c.debutM >= 0 && c.finM <= nt.longueurM && c.finM > c.debutM)) {
    return { refus: "COUPURE_INVALIDE", motif: `La coupure doit etre un intervalle de [0, ${nt.longueurM.toFixed(1)}] m, debut avant fin.` };
  }

  // Bord amont : le dernier noeud a l'abscisse <= debutM. Bord aval : le premier >= finM.
  let ia = 0;
  while (ia + 1 < nt.abscisses.length && nt.abscisses[ia + 1] <= c.debutM) ia++;
  let ib = nt.abscisses.length - 1;
  while (ib - 1 >= 0 && nt.abscisses[ib - 1] >= c.finM) ib--;
  const depart = nt.noeuds[ia], coutDepart = c.debutM - nt.abscisses[ia];
  const arrivee = nt.noeuds[ib], coutArrivee = nt.abscisses[ib] - c.finM;
  const longueurCoupeeM = c.finM - c.debutM;

  // Un arc est interdit s'il recouvre la coupure sur le troncon coupe.
  const interdit = (a: Arc) => a.tronconId === c.tronconId
    && Math.min(a.deM, a.aM) < c.finM && Math.max(a.deM, a.aM) > c.debutM;

  const dist = new Map<number, number>([[depart, coutDepart]]);
  const prec = new Map<number, { de: number; arc: Arc }>();
  const tas = new Tas();
  tas.pousser(coutDepart, depart);
  while (tas.taille > 0) {
    const [d, n] = tas.extraire();
    if (d > (dist.get(n) ?? Infinity)) continue;
    if (n === arrivee) break;
    for (const a of g.adjacence[n]) {
      if (interdit(a)) continue;
      const nd = d + a.poidsM;
      if (nd + coutArrivee > opts.distanceMaxM) continue;
      if (nd < (dist.get(a.vers) ?? Infinity)) { dist.set(a.vers, nd); prec.set(a.vers, { de: n, arc: a }); tas.pousser(nd, a.vers); }
    }
  }
  const atteint = dist.get(arrivee);
  if (atteint === undefined) {
    return { refus: "AUCUNE_DEVIATION", motif: `Aucun chemin evitant la coupure dans le sous-reseau charge, en moins de ${opts.distanceMaxM} m.` };
  }

  // Reconstitution : arcs du depart vers l'arrivee, encadres des deux morceaux du troncon coupe.
  const arcs: Arc[] = [];
  for (let n = arrivee; n !== depart; ) {
    const p = prec.get(n);
    if (!p) break;
    arcs.unshift(p.arc);
    n = p.de;
  }
  const brut: SegmentItineraire[] = [];
  if (coutDepart > 0) brut.push({ tronconId: c.tronconId, deM: c.debutM, aM: nt.abscisses[ia] });
  for (const a of arcs) brut.push({ tronconId: a.tronconId, deM: a.deM, aM: a.aM });
  if (coutArrivee > 0) brut.push({ tronconId: c.tronconId, deM: nt.abscisses[ib], aM: c.finM });
  // Fusion des morceaux consecutifs d'un meme troncon, parcourus dans le meme sens.
  const segments: SegmentItineraire[] = [];
  for (const s of brut) {
    const der = segments[segments.length - 1];
    if (der && der.tronconId === s.tronconId && der.aM === s.deM && Math.sign(der.aM - der.deM) === Math.sign(s.aM - s.deM)) der.aM = s.aM;
    else segments.push({ ...s });
  }
  const longueurM = atteint + coutArrivee;
  return { longueurM, longueurCoupeeM, allongementM: longueurM - longueurCoupeeM, segments };
}

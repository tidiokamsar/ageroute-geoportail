/**
 * Points GPS bruites, tires sur le reseau synthetique avec une graine fixe (independante de celle
 * du reseau). Chaque point garde la verite terrain (le troncon d'ou il vient), ce qui permet de
 * dire quelle part des rattachements est juste -- sans que cela entre dans les seuils de temps.
 */
import { Alea } from "./prng";
import { metresParDegreLon, distanceApprocheeM, type Coord, type ReseauSynthetique, type TronconSynthetique } from "./reseau-synthetique";

export type GroupePoints = "classe-5m" | "classe-15m" | "urbain-5m" | "urbain-15m" | "hors-route";

export interface PointGps {
  groupe: GroupePoints;
  lat: number;
  lon: number;
  /** Incertitude annoncee par l'appareil, en metres. */
  precisionM: number;
  /** Troncon d'origine ; null pour un point hors route. */
  verite: string | null;
}

const M_PAR_DEG_LAT = 111_320;

function pointSurLigne(c: readonly Coord[], fraction: number): { p: Coord; cap: [number, number] } {
  const cumul: number[] = [0];
  for (let i = 1; i < c.length; i += 1) cumul.push(cumul[i - 1] + distanceApprocheeM(c[i - 1], c[i]));
  const cible = fraction * cumul[cumul.length - 1];
  let i = 1;
  while (i < c.length - 1 && cumul[i] < cible) i += 1;
  const l = cumul[i] - cumul[i - 1] || 1;
  const t = (cible - cumul[i - 1]) / l;
  const p: Coord = [c[i - 1][0] + t * (c[i][0] - c[i - 1][0]), c[i - 1][1] + t * (c[i][1] - c[i - 1][1])];
  const lat = p[1];
  const dx = (c[i][0] - c[i - 1][0]) * metresParDegreLon(lat), dy = (c[i][1] - c[i - 1][1]) * M_PAR_DEG_LAT;
  const n = Math.hypot(dx, dy) || 1;
  return { p, cap: [dx / n, dy / n] };
}

function bruite(a: Alea, p: Coord, cap: [number, number], sigmaM: number): Coord {
  // Bruit isotrope (sigma par axe) : un GPS ne se trompe pas que perpendiculairement a la route.
  const ex = a.gauss() * sigmaM, ey = a.gauss() * sigmaM;
  void cap;
  return [p[0] + ex / metresParDegreLon(p[1]), p[1] + ey / M_PAR_DEG_LAT];
}

const arrondi6 = (v: number) => Math.round(v * 1e6) / 1e6;

export function genererPoints(
  reseau: ReseauSynthetique,
  opts: { graine: number; parGroupe: number },
): PointGps[] {
  const a = new Alea(opts.graine);
  const classe = reseau.troncons.filter((t) => t.categorie === "CLASSE");
  const voirie = reseau.troncons.filter((t) => t.categorie === "VOIRIE");
  const sortie: PointGps[] = [];

  const sur = (liste: TronconSynthetique[], groupe: GroupePoints, sigma: number) => {
    for (let k = 0; k < opts.parGroupe; k += 1) {
      const t = liste[Math.floor(a.suivant() * liste.length)];
      const { p, cap } = pointSurLigne(t.coordonnees, a.suivant());
      const q = bruite(a, p, cap, sigma);
      sortie.push({ groupe, lat: arrondi6(q[1]), lon: arrondi6(q[0]), precisionM: sigma, verite: t.id });
    }
  };
  sur(classe, "classe-5m", 5);
  sur(classe, "classe-15m", 15);
  sur(voirie, "urbain-5m", 5);
  sur(voirie, "urbain-15m", 15);

  // Hors route : points tires dans une boite, puis gardes seulement s'ils sont a plus de 200 m de
  // tout troncon CLASSE echantillonne (verification approchee sur les sommets, suffisante ici).
  const sommets: Coord[] = [];
  for (const t of classe) for (const c of t.coordonnees) sommets.push(c);
  let k = 0;
  while (k < opts.parGroupe) {
    const lon = a.entre(-14.8, -8.4), lat = a.entre(7.4, 12.3);
    let proche = false;
    for (let i = 0; i < sommets.length; i += 1) {
      const s = sommets[i];
      if (Math.abs(s[1] - lat) < 0.003 && Math.abs(s[0] - lon) < 0.003) { proche = true; break; }
    }
    if (proche) continue;
    sortie.push({ groupe: "hors-route", lat: arrondi6(lat), lon: arrondi6(lon), precisionM: 5, verite: null });
    k += 1;
  }
  return sortie;
}

export interface PointTraceBrut { lat: number; lon: number; tMs: number | null; precisionM: number | null }

/**
 * Trace de releve en vehicule : on roule le long du troncon sur `longueurM` metres, un point tous les
 * `pasM` metres (bruit gaussien `sigmaM` par axe), a 50 km/h (14 m/s). Meme forme que `PointBrut`.
 */
export function genererTrace(t: TronconSynthetique, opts: { graine: number; pasM: number; sigmaM: number; longueurM: number }): PointTraceBrut[] {
  const a = new Alea(opts.graine);
  const total = t.coordonnees.reduce((s, c, i) => (i ? s + distanceApprocheeM(t.coordonnees[i - 1], c) : 0), 0);
  const longueur = Math.min(opts.longueurM, total);
  const n = Math.max(2, Math.floor(longueur / opts.pasM) + 1);
  const t0 = Date.UTC(2026, 9, 1, 8, 0, 0);
  const sortie: PointTraceBrut[] = [];
  for (let k = 0; k < n; k += 1) {
    const { p, cap } = pointSurLigne(t.coordonnees, (k * opts.pasM) / total);
    const q = bruite(a, p, cap, opts.sigmaM);
    sortie.push({ lat: arrondi6(q[1]), lon: arrondi6(q[0]), tMs: t0 + Math.round(((k * opts.pasM) / 14) * 1000), precisionM: opts.sigmaM });
  }
  return sortie;
}

/** Emprise de mission : un carre de `demiCoteKm` autour du point, en WKT (ce que le terrain enverrait). */
export function empriseMission(p: { lat: number; lon: number }, demiCoteKm: number): string {
  const dlat = (demiCoteKm * 1000) / M_PAR_DEG_LAT, dlon = (demiCoteKm * 1000) / metresParDegreLon(p.lat);
  const [w, s, e, n] = [p.lon - dlon, p.lat - dlat, p.lon + dlon, p.lat + dlat].map((v) => Math.round(v * 1e5) / 1e5);
  return `POLYGON((${w} ${s}, ${e} ${s}, ${e} ${n}, ${w} ${n}, ${w} ${s}))`;
}

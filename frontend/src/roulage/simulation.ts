/**
 * SUPPORT DE TEST : simulation deterministe d'un vehicule et de son recepteur GNSS.
 *
 * CE QUE C'EST : un generateur reproductible (meme graine, memes echantillons) qui deplace un point le
 * long d'un chemin et y ajoute un bruit gaussien. Il sert a rejouer en quelques millisecondes une
 * session de deux heures a 1 Hz.
 *
 * CE QUE CE N'EST PAS : une mesure. Le bruit ici est un bruit blanc gaussien d'ecart-type choisi, ce
 * qui n'est PAS la loi d'erreur d'un vrai recepteur (erreurs correlees dans le temps, multi-trajets en
 * ville, canyon urbain, couvert vegetal). Tout resultat obtenu sur ces donnees est un resultat de
 * SIMULATION, a ne jamais presenter comme une mesure sur appareil. Ce fichier n'est importe par aucun
 * code de production.
 */
import { deplacer, distanceM, type Coordonnee } from "./geodesie";
import type { EchantillonGnss } from "./types";

/** PRNG mulberry32 : petit, rapide, deterministe. */
export function prng(graine: number): () => number {
  let a = graine >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Loi normale centree reduite par Box-Muller. */
export function gaussien(alea: () => number): number {
  const u = Math.max(alea(), 1e-12);
  const v = alea();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface PointVerite extends Coordonnee {
  tMs: number;
  /** Abscisse le long du chemin complet, en metres. */
  sM: number;
  vitesseMs: number;
}

export interface ParametresSimulation {
  /** Polyligne suivie par le vehicule. */
  chemin: readonly Coordonnee[];
  departMs: number;
  dureeS: number;
  /** Vitesse en km/h a l'instant `tS` depuis le depart. */
  vitesseKmH: (tS: number) => number;
  graine: number;
  /** Ecart-type du bruit de position, en metres, par axe. */
  sigmaM: number;
  /** Precision annoncee dans l'echantillon, en metres (valeur que le recepteur declarerait). */
  precisionAnnonceeM: number;
  /** Position de depart sur le chemin, en metres. */
  sDepartM?: number;
}

export interface TrajetSimule {
  verite: PointVerite[];
  echantillons: EchantillonGnss[];
  longueurCheminM: number;
}

/** Abscisses cumulees des sommets du chemin. */
export function abscissesChemin(chemin: readonly Coordonnee[]): number[] {
  const s = [0];
  for (let i = 1; i < chemin.length; i += 1) s.push(s[i - 1] + distanceM(chemin[i - 1], chemin[i]));
  return s;
}

/** Position sur le chemin a l'abscisse `sM` (bornee aux extremites), interpolation lineaire en lat/lon. */
export function positionSurChemin(chemin: readonly Coordonnee[], cumul: readonly number[], sM: number): Coordonnee {
  const total = cumul[cumul.length - 1];
  const s = Math.min(Math.max(sM, 0), total);
  let i = 1;
  while (i < cumul.length - 1 && cumul[i] < s) i += 1;
  const l = cumul[i] - cumul[i - 1];
  const f = l > 0 ? (s - cumul[i - 1]) / l : 0;
  return {
    lat: chemin[i - 1].lat + f * (chemin[i].lat - chemin[i - 1].lat),
    lon: chemin[i - 1].lon + f * (chemin[i].lon - chemin[i - 1].lon),
  };
}

/** Un echantillon par seconde (1 Hz). Le vehicule s'arrete en bout de chemin. */
export function simuler(p: ParametresSimulation): TrajetSimule {
  const alea = prng(p.graine);
  const cumul = abscissesChemin(p.chemin);
  const total = cumul[cumul.length - 1];
  const verite: PointVerite[] = [];
  const echantillons: EchantillonGnss[] = [];
  let s = p.sDepartM ?? 0;
  for (let t = 0; t <= p.dureeS; t += 1) {
    const v = Math.max(0, p.vitesseKmH(t)) / 3.6;
    const pos = positionSurChemin(p.chemin, cumul, s);
    const tMs = p.departMs + t * 1000;
    const vitesseMs = s >= total ? 0 : v;
    verite.push({ ...pos, tMs, sM: Math.min(s, total), vitesseMs });
    const bruitee = deplacer(pos, gaussien(alea) * p.sigmaM, gaussien(alea) * p.sigmaM);
    echantillons.push({
      tMs, lat: bruitee.lat, lon: bruitee.lon, precisionM: p.precisionAnnonceeM,
      vitesseMs, capDeg: null, altitudeM: null,
    });
    s = Math.min(total, s + v);
  }
  return { verite, echantillons, longueurCheminM: total };
}

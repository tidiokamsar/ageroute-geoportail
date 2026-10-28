/**
 * INDICE D'IRRÉGULARITÉ par accéléromètre (SMART FIELD, phase 3).
 *
 * CE QUE C'EST ET CE QUE CE N'EST PAS
 *
 * L'appareil échantillonne l'accélération verticale ; les chocs (nid-de-poule, dalle
 * cassée, ralentisseur) se voient comme des pics. Ce module agrège ces pics en un INDICE
 * expérimental par fenêtre de terrain — jamais un défaut, jamais une position de défaut :
 * le GPS du téléphone ne suffit pas à localiser précisément un choc, et le montage du
 * téléphone (où, comment fixé) domine le signal.
 *
 * RÈGLES DU MANDAT (V11 § 23.3 / 24.6) : les capteurs produisent des INDICES avec
 * méthode, version et incertitude ; le résultat porte le mot « expérimental » tant que
 * la calibration n'a pas été faite ; la collecte manuelle reste complète sans ce module
 * (téléphones sans accéléromètre : l'écran ne bloque rien).
 */

export interface EchantillonAccel {
  tMs: number;
  /** Accélération verticale en m/s² (gravité soustraite par l'hôte). */
  zMs2: number;
}

export interface IndiceFenetre {
  debutMs: number;
  finMs: number;
  /** Nombre de pics détectés (seuil dépassé sur l'accélération absolue). */
  pics: number;
  /** Indice expérimental 0..100 : pics normalisés par la distance ou la durée de la fenêtre. */
  indice: number;
}

export interface ResultatIndice {
  /** Version du calcul — un indice sans sa version ne se rejoue pas. */
  version: "indice-irregularite-1";
  seuilMs2: number;
  fenetres: IndiceFenetre[];
  totalPics: number;
  /** Vrai si l'appareil n'a fourni aucun échantillon : le module est absent ou refusé. */
  capteurAbsent: boolean;
  avertissement: string;
}

const FENETRE_MS = 30_000;
const SEUIL_DEFAUT_MS2 = 12;

/**
 * Pics = échantillons dont |z| dépasse le seuil, groupés par fenêtres de 30 s. L'indice
 * d'une fenêtre est min(100, pics × 10) : dix pics dans une demi-minute, c'est déjà une
 * chaussée très irrégulière — l'échelle sera recalibrée après le pilote corridor.
 */
export function indiceIrregularite(
  echantillons: readonly EchantillonAccel[],
  opts: { seuilMs2?: number; vitesseKmhMoyenne?: number } = {},
): ResultatIndice {
  const seuil = opts.seuilMs2 ?? SEUIL_DEFAUT_MS2;
  if (echantillons.length === 0) {
    return {
      version: "indice-irregularite-1", seuilMs2: seuil, fenetres: [], totalPics: 0,
      capteurAbsent: true,
      avertissement: "Aucun accéléromètre disponible ou module refusé : la collecte manuelle reste complète sans cet indice.",
    };
  }

  const fenetres: IndiceFenetre[] = [];
  let courant: { debut: number; fin: number; pics: number } | null = null;
  for (const e of echantillons) {
    if (!courant || e.tMs - courant.debut >= FENETRE_MS) {
      if (courant) {
        fenetres.push({ debutMs: courant.debut, finMs: courant.fin, pics: courant.pics, indice: Math.min(100, courant.pics * 10) });
      }
      courant = { debut: e.tMs, fin: e.tMs, pics: 0 };
    }
    courant.fin = e.tMs;
    if (Math.abs(e.zMs2) >= seuil) courant.pics += 1;
  }
  if (courant) {
    fenetres.push({ debutMs: courant.debut, finMs: courant.fin, pics: courant.pics, indice: Math.min(100, courant.pics * 10) });
  }

  const totalPics = fenetres.reduce((n, f) => n + f.pics, 0);
  return {
    version: "indice-irregularite-1", seuilMs2: seuil, fenetres, totalPics,
    capteurAbsent: false,
    avertissement: "Indice EXPÉRIMENTAL — dépend du téléphone, du montage et de la vitesse ; jamais un défaut confirmé.",
  };
}

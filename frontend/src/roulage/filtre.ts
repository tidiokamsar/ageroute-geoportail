/**
 * Filtre des echantillons GNSS : precision, ordre du temps, derive.
 *
 * Fonction PURE : elle recoit l'echantillon et le contexte, rend un verdict. Aucun seuil n'est ecrit
 * ici, ils viennent tous de `ParametresRoulage` (provisoires, voir `parametres.ts`).
 *
 * TROIS FORMES DE DERIVE, ET CE QUE CHACUNE VEUT DIRE
 *
 * - SAUT_IMPOSSIBLE : la position implique une vitesse superieure a `vitesseMaxKmH`. Le recepteur a
 *   « saute ». L'echantillon est ecarte ; apres `reancrageApresRejets` rejets consecutifs, on admet que
 *   c'est l'ANCIENNE reference qui etait fausse et la nouvelle position devient la reference
 *   (alerte REANCRAGE) : sans cela, une premiere position erronee bloquerait la session pour toujours.
 * - FIX_FIGE : la position ne bouge plus alors que le recepteur annonce une vitesse de deplacement.
 *   Un recepteur qui rejoue son dernier fix sans le dire produit exactement cela. Sans vitesse
 *   annoncee, l'immobilite ne se juge pas : un vehicule arrete donne legitimement la meme position.
 * - DERIVE_HORLOGE : l'horodatage GNSS s'ecarte de l'horloge de l'appareil de plus de `deriveHorlogeMs`.
 *   L'echantillon est GARDE (la trace reste exploitable) mais l'alerte est consignee : un marqueur pose
 *   avec cette horloge serait decale d'autant dans la trace. Ce que ce seuil vaut sur un appareil reel
 *   n'est pas mesure.
 */
import { coordonneeValide, distanceM } from "./geodesie";
import type { ParametresRoulage } from "./parametres";
import type { EchantillonGnss, MotifRejet, TypeAlerte } from "./types";

export interface ContexteFiltre {
  /** Dernier echantillon ACCEPTE de la session, ou `null`. */
  dernier: EchantillonGnss | null;
  sautsConsecutifs: number;
  identiquesConsecutifs: number;
}

export type VerdictEchantillon =
  | {
      accepte: true;
      alertes: TypeAlerte[];
      reancrage: boolean;
      sautsConsecutifs: number;
      identiquesConsecutifs: number;
      /** Ecart a l'horloge de l'appareil, en ms (positif : l'horloge de l'appareil est en retard sur le GNSS). */
      ecartHorlogeMs: number;
    }
  | { accepte: false; motif: MotifRejet; sautsConsecutifs: number; identiquesConsecutifs: number };

export function evaluerEchantillon(
  e: EchantillonGnss,
  ctx: ContexteFiltre,
  p: ParametresRoulage,
  maintenantMs: number,
  /**
   * Vrai quand l'hote livre un lot d'echantillons MIS EN TAMPON pendant une veille : leur age est alors
   * normal et ne dit rien de l'horloge. Sans cette indication, chaque reveil produirait une fausse alerte.
   */
  differe = false,
): VerdictEchantillon {
  const rejet = (motif: MotifRejet, sauts = ctx.sautsConsecutifs, identiques = ctx.identiquesConsecutifs): VerdictEchantillon =>
    ({ accepte: false, motif, sautsConsecutifs: sauts, identiquesConsecutifs: identiques });

  if (!coordonneeValide(e.lat, e.lon)) return rejet("COORDONNEES_INVALIDES");
  if (!Number.isFinite(e.tMs) || e.tMs <= 0) return rejet("HORODATAGE_INVALIDE");

  const alertes: TypeAlerte[] = [];
  if (e.precisionM === null || e.precisionM === undefined) {
    if (p.refuserSansPrecision) return rejet("PRECISION_ABSENTE");
    alertes.push("SANS_PRECISION");
  } else if (!Number.isFinite(e.precisionM) || e.precisionM <= 0 || e.precisionM > p.precisionMaxM) {
    return rejet("PRECISION_INSUFFISANTE");
  }

  const d = ctx.dernier;
  let identiques = 0;
  let sauts = 0;
  let reancrage = false;
  if (d) {
    if (e.tMs === d.tMs) return rejet("HORODATAGE_DOUBLON");
    if (e.tMs < d.tMs) return rejet("HORODATAGE_RECULE");

    if (e.lat === d.lat && e.lon === d.lon) {
      identiques = ctx.identiquesConsecutifs + 1;
      const enMouvement = e.vitesseMs !== null && e.vitesseMs >= p.vitesseMouvementMs;
      if (enMouvement && identiques >= p.fixFigeEchantillons) return rejet("FIX_FIGE", ctx.sautsConsecutifs, identiques);
    }

    const dtS = (e.tMs - d.tMs) / 1000;
    const vitesseKmH = (distanceM(d, e) / dtS) * 3.6;
    if (vitesseKmH > p.vitesseMaxKmH) {
      sauts = ctx.sautsConsecutifs + 1;
      if (sauts < p.reancrageApresRejets) return rejet("SAUT_IMPOSSIBLE", sauts, identiques);
      reancrage = true;
      alertes.push("REANCRAGE");
      sauts = 0;
    }
  }

  const ecartHorlogeMs = maintenantMs - e.tMs;
  if (!differe && Math.abs(ecartHorlogeMs) > p.deriveHorlogeMs) alertes.push("DERIVE_HORLOGE");

  return { accepte: true, alertes, reancrage, sautsConsecutifs: sauts, identiquesConsecutifs: identiques, ecartHorlogeMs };
}

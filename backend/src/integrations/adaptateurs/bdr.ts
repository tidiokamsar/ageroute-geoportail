/**
 * ADAPTATEUR BDR / L2R : le pivot ouvert, une ligne par evenement.
 *
 * Contrat : ChargePivot (contrats.ts) = la FeatureCollection GeoJSON du pivot, relue par
 * `lireGeoJson` puis `verifierLigne`, c'est-a-dire par le lecteur meme du contrat d'import.
 * AUCUN format L2R n'est produit : il n'est pas publie. Le mecanisme d'echange (fichiers, API,
 * passerelle) n'est pas choisi (BDR_INTEROPERABILITY_OPTIONS.md) ; cet appel HTTP en est une
 * hypothese, testee contre simulateurs/simulateur.ts.
 */
import type { ConfigDestination } from "../config";
import type { Adaptateur } from "../types";
import { fabriquerAdaptateur } from "./fabrique";
import type { FetchLike } from "./transport";

export function creerAdaptateurBdr(cfg: ConfigDestination, fetchImpl: FetchLike): Adaptateur {
  return fabriquerAdaptateur("BDR_L2R", cfg, fetchImpl);
}

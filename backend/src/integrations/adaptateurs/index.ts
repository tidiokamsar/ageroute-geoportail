/**
 * REGISTRE DES ADAPTATEURS. Seules les destinations ACTIVES (config.ts) en ont un : une
 * destination desactivee n'a pas d'adaptateur, donc aucun chemin qui mene au reseau.
 */
import type { ConfigIntegrations } from "../config";
import { DESTINATIONS, type Adaptateur, type Destination } from "../types";
import { creerAdaptateurBdr } from "./bdr";
import { creerAdaptateurDigitalRoad } from "./digitalroad";
import { creerAdaptateurSharePoint } from "./sharepoint";
import type { FetchLike } from "./transport";

export type Adaptateurs = Partial<Record<Destination, Adaptateur>>;

/** `fetch` natif, restreint au sous-ensemble utilise par le transport. */
export const fetchNatif: FetchLike = (url, init) => fetch(url, init);

export function creerAdaptateurs(config: ConfigIntegrations, fetchImpl: FetchLike = fetchNatif): Adaptateurs {
  const fabriques: Record<Destination, typeof creerAdaptateurBdr> = {
    DIGITALROAD: creerAdaptateurDigitalRoad,
    SHAREPOINT: creerAdaptateurSharePoint,
    BDR_L2R: creerAdaptateurBdr,
  };
  const sortie: Adaptateurs = {};
  for (const d of DESTINATIONS) {
    const cfg = config.destinations[d];
    if (cfg.actif) sortie[d] = fabriques[d](cfg, fetchImpl);
  }
  return sortie;
}

import { api } from "./api";
import type { Ville } from "./villes";

/**
 * Les troncons d'une ROUTE entre deux villes, dans l'ordre : le client resout les villes en positions (liste locale,
 * decision D4), le serveur suit le reseau (`GET /v2/troncons-recherche/chemin`). Ce n'est plus la bande de 20 km autour de
 * la droite : une route parallele ou qui croise n'en fait pas partie.
 */

export interface TronconDuChemin {
  ordre: number;
  id: string;
  code: string;
  nom: string;
  classe: string;
  etat: string;
  region: string;
  longueurM: number;
  parcourM: number;
  partiel: boolean;
  sens: "+" | "-";
}

export interface CheminEntreVilles {
  longueurM: number;
  droiteM: number;
  troncons: TronconDuChemin[];
  depart: { accrochageM: number; tronconId: string };
  arrivee: { accrochageM: number; tronconId: string };
  parametres: { rayonAccrochageM: number; toleranceFusionM: number; nbTronconsCharges: number };
  avertissements: string[];
}

export class RefusCheminVilles extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

/** Le refus du serveur, avec son code et sa phrase ; toute autre panne reste une panne, dite comme telle. */
export async function chargerChemin(a: Ville, b: Ville): Promise<CheminEntreVilles> {
  try {
    const { data } = await api.get<CheminEntreVilles>("/v2/troncons-recherche/chemin", {
      params: { deLat: a.lat, deLon: a.lon, versLat: b.lat, versLon: b.lon },
    });
    return data;
  } catch (e) {
    const r = (e as { response?: { status?: number; data?: { error?: string; code?: string } } }).response;
    if (r?.data?.code && r.data.error) throw new RefusCheminVilles(r.data.code, r.data.error);
    throw new RefusCheminVilles("PANNE", "Le calcul de la route a echoue (serveur injoignable ou erreur). Reessayer.");
  }
}

export const cleChemin = (a: Ville, b: Ville) => ["chemin-villes", a.nom, b.nom] as const;

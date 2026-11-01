import type { PathOptions } from "leaflet";
import { ETAT_COLORS, type TronconGeoFeature } from "./types";

/**
 * Trait des troncons dont l'etat n'est que DECLARE (pas constate sur le terrain).
 *
 * Un etat declare et un etat constate ont la meme couleur sur la carte ; seule la forme du
 * trait les separe. Le pointille reprend la convention deja posee pour les ouvrages repris
 * d'une source externe (« contour discontinu : jamais visite ») : un trait plein dit « releve »,
 * un trait discontinu dit « a confirmer ». Distinction par la forme et non par la couleur,
 * pour qu'elle survive au daltonisme et a l'impression en noir et blanc.
 */
export const TRAIT_ETAT_DECLARE = "10 7";

/** Style Leaflet d'un troncon de la couche reseau. */
export function styleTroncon(t: TronconGeoFeature | undefined, curseurActif: boolean): PathOptions {
  // Curseur temporel allume : le troncon n'est plus qu'un TRACE DE REFERENCE gris.
  // Sa couleur d'etat est celle d'AUJOURD'HUI ; la poser sous une date passee dirait
  // faux. Seules les portions de la date choisie portent un etat.
  if (curseurActif) return { color: "#9aa0aa", weight: 3, opacity: 0.8 };
  return {
    color: t ? ETAT_COLORS[t.etat] ?? "#1a2942" : "#1a2942",
    weight: 4,
    dashArray: t?.etatDeclare ? TRAIT_ETAT_DECLARE : undefined,
  };
}

/** Largeur sous laquelle l'ecran est traite comme un telephone (breakpoint `md` de Tailwind : 768 px). */
const REQUETE_ECRAN_ETROIT = "(max-width: 767px)";

/**
 * Vrai sur un ecran etroit. Le panneau des couches fait 18 rem : ouvert par defaut sur un
 * telephone de 375 px, il laisse moins de 90 px a la carte. Garde pour jsdom et les navigateurs
 * sans `matchMedia` : sans l'API, on suppose un bureau (comportement historique).
 */
export function ecranEtroit(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(REQUETE_ECRAN_ETROIT).matches;
}

/** Longueur cumulee (km) des troncons dont l'etat n'est que declare, pour le tableau de bord. */
export function longueurDeclareeKm(troncons: Pick<TronconGeoFeature, "etatDeclare" | "longueurKm">[]): number {
  return troncons.filter((t) => t.etatDeclare).reduce((s, t) => s + (t.longueurKm || 0), 0);
}

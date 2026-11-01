/**
 * Permaliens de carte (paragraphe 7.14 ; § 7.16 ligne 11, « portail public, permaliens »).
 *
 * Un lien partage est une ENTREE EXTERIEURE : il peut etre tronque, retouche ou forge. Les
 * valeurs sont donc validees -- latitude, longitude et zoom dans leurs bornes, nombres finis --
 * et un lien invalide est ignore (la carte s'ouvre alors sur son cadrage par defaut), jamais
 * applique a moitie.
 *
 * Cinq decimales de degre, soit environ un metre : assez pour retrouver une vue, sans allonger
 * le lien de chiffres sans objet.
 */

export interface VueCarte { lat: number; lng: number; zoom: number }

export const ZOOM_MIN = 0;
export const ZOOM_MAX = 20;

function nombre(v: string | null): number | null {
  if (v === null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** La vue portee par l'adresse, ou null si elle est absente ou invalide. */
export function lireVue(search: string): VueCarte | null {
  const p = new URLSearchParams(search);
  const lat = nombre(p.get("lat"));
  const lng = nombre(p.get("lng"));
  const zoom = nombre(p.get("zoom"));
  if (lat === null || lng === null || zoom === null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180 || zoom < ZOOM_MIN || zoom > ZOOM_MAX) return null;
  return { lat, lng, zoom };
}

/** L'adresse avec la vue ecrite, les autres parametres conserves. Sans le « ? » initial. */
export function ecrireVue(search: string, v: VueCarte): string {
  const p = new URLSearchParams(search);
  p.set("lat", v.lat.toFixed(5));
  p.set("lng", v.lng.toFixed(5));
  // Le zoom peut etre fractionnaire (zoomSnap) : deux decimales suffisent.
  p.set("zoom", String(Math.round(v.zoom * 100) / 100));
  return p.toString();
}

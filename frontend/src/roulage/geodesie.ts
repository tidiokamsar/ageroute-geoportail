/** Geodesie minimale du noyau : aucune dependance. Calcul spherique, assez precis pour des pas de quelques metres. */

const RAYON_TERRE_M = 6371008.8;

export interface Coordonnee { lat: number; lon: number }

export function distanceM(a: Coordonnee, b: Coordonnee): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * RAYON_TERRE_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Coordonnees plausibles. (0, 0) est la valeur d'un recepteur sans fixation : jamais une position reelle ici. */
export function coordonneeValide(lat: number, lon: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
  return !(lat === 0 && lon === 0);
}

/** Deplace un point de `versEstM` metres vers l'est et `versNordM` vers le nord (petits deplacements). */
export function deplacer(p: Coordonnee, versEstM: number, versNordM: number): Coordonnee {
  const rad = Math.PI / 180;
  return {
    lat: p.lat + versNordM / (RAYON_TERRE_M * rad),
    lon: p.lon + versEstM / (RAYON_TERRE_M * rad * Math.cos(p.lat * rad)),
  };
}

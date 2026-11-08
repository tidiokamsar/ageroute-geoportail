/**
 * ORACLES GEODESIQUES des bancs d'integration : ecrits en JavaScript pur, SANS PostGIS ni PROJ.
 *
 * Un banc qui compare PostGIS a PostGIS ne prouve rien : si `ST_Transform` se trompait, l'oracle se
 * tromperait de la meme facon. Ce module calcule les memes grandeurs par d'autres formules :
 *
 *   - `utmVersLonLat` / `lonLatVersUtm` : projection Transverse de Mercator par les series de Kruger
 *     (Karney 2011, ordre 3 en n : erreur sous le dixieme de millimetre en zone), pour CONSTRUIRE des
 *     figures dont la taille est connue par construction (un carre de 100 m en coordonnees UTM) ;
 *   - `distanceVincenty` : distance geodesique sur l'ellipsoide WGS 84 (Vincenty, 1975), reference
 *     d'une longueur de ligne sans passer par une projection ;
 *   - `aireRectangleEllipsoide` : aire EXACTE d'un rectangle de graticule (meridiens et paralleles)
 *     sur l'ellipsoide, par la formule de l'aire authalique ; reference d'une surface sans projection.
 *
 * Eprouve par `geodesie.test.ts`, qui le confronte a des valeurs mesurees sur PostGIS et a des cas
 * connus (le cas d'ecole de Vincenty, Flinders Peak - Buninyong).
 */

export const A_WGS84 = 6378137;
export const F_WGS84 = 1 / 298.257223563;
const E2 = F_WGS84 * (2 - F_WGS84);
const N = F_WGS84 / (2 - F_WGS84);
const K0 = 0.9996;
const E0 = 500000;
const AA = (A_WGS84 / (1 + N)) * (1 + N ** 2 / 4 + N ** 4 / 64);

const ALPHA = [N / 2 - (2 * N ** 2) / 3 + (5 * N ** 3) / 16, (13 * N ** 2) / 48 - (3 * N ** 3) / 5, (61 * N ** 3) / 240];
const BETA = [N / 2 - (2 * N ** 2) / 3 + (37 * N ** 3) / 96, N ** 2 / 48 + N ** 3 / 15, (17 * N ** 3) / 480];
const DELTA = [2 * N - (2 * N ** 2) / 3 - 2 * N ** 3, (7 * N ** 2) / 3 - (8 * N ** 3) / 5, (56 * N ** 3) / 15];

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Meridien central d'un fuseau UTM (degres). Fuseau 28 : -15, fuseau 29 : -9. */
export const meridienCentral = (fuseau: number) => -183 + 6 * fuseau;

/** (longitude, latitude) en degres -> (est, nord) en metres, dans le fuseau UTM donne (hemisphere nord). */
export function lonLatVersUtm(lon: number, lat: number, fuseau: number): { e: number; n: number } {
  const phi = rad(lat);
  const dl = rad(lon - meridienCentral(fuseau));
  const c = (2 * Math.sqrt(N)) / (1 + N);
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - c * Math.atanh(c * Math.sin(phi)));
  const xi0 = Math.atan2(t, Math.cos(dl));
  const eta0 = Math.asinh(Math.sin(dl) / Math.sqrt(t * t + Math.cos(dl) ** 2));
  let xi = xi0, eta = eta0;
  ALPHA.forEach((a, i) => {
    const j = 2 * (i + 1);
    xi += a * Math.sin(j * xi0) * Math.cosh(j * eta0);
    eta += a * Math.cos(j * xi0) * Math.sinh(j * eta0);
  });
  return { e: E0 + K0 * AA * eta, n: K0 * AA * xi };
}

/** (est, nord) en metres, fuseau UTM nord -> (longitude, latitude) en degres. */
export function utmVersLonLat(e: number, n: number, fuseau: number): { lon: number; lat: number } {
  const xi = n / (K0 * AA);
  const eta = (e - E0) / (K0 * AA);
  let xi0 = xi, eta0 = eta;
  BETA.forEach((b, i) => {
    const j = 2 * (i + 1);
    xi0 -= b * Math.sin(j * xi) * Math.cosh(j * eta);
    eta0 -= b * Math.cos(j * xi) * Math.sinh(j * eta);
  });
  const chi = Math.asin(Math.sin(xi0) / Math.cosh(eta0));
  let phi = chi;
  DELTA.forEach((d, i) => { phi += d * Math.sin(2 * (i + 1) * chi); });
  const lon = meridienCentral(fuseau) + deg(Math.atan2(Math.sinh(eta0), Math.cos(xi0)));
  return { lon, lat: deg(phi) };
}

/** Distance geodesique (metres) entre deux points WGS 84, par la formule inverse de Vincenty. */
export function distanceVincenty(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const b = (1 - F_WGS84) * A_WGS84;
  const L = rad(lon2 - lon1);
  const U1 = Math.atan((1 - F_WGS84) * Math.tan(rad(lat1)));
  const U2 = Math.atan((1 - F_WGS84) * Math.tan(rad(lat2)));
  const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1), sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);
  let lambda = L, iter = 0;
  let sinSigma = 0, cosSigma = 0, sigma = 0, cosSqAlpha = 0, cos2SigmaM = 0;
  for (; iter < 200; iter += 1) {
    const sinL = Math.sin(lambda), cosL = Math.cos(lambda);
    sinSigma = Math.sqrt((cosU2 * sinL) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosL) ** 2);
    if (sinSigma === 0) return 0;
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosL;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinL) / sinSigma;
    cosSqAlpha = 1 - sinAlpha ** 2;
    cos2SigmaM = cosSqAlpha === 0 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha;
    const C = (F_WGS84 / 16) * cosSqAlpha * (4 + F_WGS84 * (4 - 3 * cosSqAlpha));
    const precedent = lambda;
    lambda = L + (1 - C) * F_WGS84 * sinAlpha * (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
    if (Math.abs(lambda - precedent) < 1e-12) break;
  }
  if (iter >= 200) throw new Error("Vincenty : pas de convergence (points quasi antipodaux)");
  const uSq = (cosSqAlpha * (A_WGS84 ** 2 - b ** 2)) / b ** 2;
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const deltaSigma = B * sinSigma * (cos2SigmaM + (B / 4) * (cosSigma * (-1 + 2 * cos2SigmaM ** 2) - (B / 6) * cos2SigmaM * (-3 + 4 * sinSigma ** 2) * (-3 + 4 * cos2SigmaM ** 2)));
  return b * A * (sigma - deltaSigma);
}

/** Longueur geodesique d'une ligne brisee [lon, lat][] : somme des distances de Vincenty entre sommets. */
export function longueurLigneGeodesique(points: readonly (readonly [number, number])[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += distanceVincenty(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
  return total;
}

/**
 * Aire exacte (m2) du rectangle de graticule [lon1, lon2] x [lat1, lat2] sur l'ellipsoide WGS 84 :
 * (b^2 / 2) * dLambda * (q(phi2) - q(phi1)), avec q(phi) = sin(phi) / (1 - e^2 sin^2(phi)) + atanh(e sin(phi)) / e.
 */
export function aireRectangleEllipsoide(lon1: number, lon2: number, lat1: number, lat2: number): number {
  const e = Math.sqrt(E2);
  const b2 = A_WGS84 ** 2 * (1 - E2);
  const q = (phiDeg: number) => {
    const s = Math.sin(rad(phiDeg));
    return s / (1 - E2 * s * s) + Math.atanh(e * s) / e;
  };
  return (b2 / 2) * rad(lon2 - lon1) * (q(lat2) - q(lat1));
}

/** Fuseau UTM d'une longitude (formule standard) -- la meme regle que `epsg_utm`, ecrite independamment. */
export const fuseauDeLongitude = (lon: number) => Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));

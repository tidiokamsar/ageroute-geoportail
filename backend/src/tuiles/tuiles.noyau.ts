/**
 * Tuiles vectorielles du reseau (paragraphe 7.14 « tuiles vectorielles » ; scenario A20). Aucune
 * importation.
 *
 * POURQUOI. La carte publique recoit aujourd'hui TOUT le reseau classe en un seul GeoJSON
 * (`/api/public/carte/geo`), simplifie selon le zoom ; la voirie locale (259 000 troncons) ne peut
 * pas s'y ajouter ainsi. Une tuile Mapbox Vector Tile (MVT) ne porte que ce qu'un carreau de
 * l'ecran montre, deja quantifie a la resolution de ce zoom.
 *
 * LE DECOUPAGE est le pavage Web Mercator standard (z/x/y, schema XYZ, origine en haut a gauche),
 * le meme que celui des fonds OpenStreetMap deja employes par la carte.
 *
 * LES COUCHES ET LEURS ZOOMS. Le reseau classe des le zoom 5 (la Guinee tient dans deux tuiles) ;
 * la voirie locale seulement a partir du zoom 12, la ou chaque tuile n'en porte que quelques
 * centaines : au-dessous, elle saturerait la tuile sans rien montrer de lisible. Ces seuils sont
 * des choix d'affichage, pas des regles metier ; ils se changent ici.
 */

export const ZOOM_MIN = 5;
export const ZOOM_MAX = 16;
/** Resolution interne de la tuile (convention MVT) et marge anti-coupure aux bords. */
export const ETENDUE_TUILE = 4096;
export const MARGE_TUILE = 64;

export interface Couche {
  nom: "reseau_classe" | "voirie_locale";
  zoomMin: number;
  /** Proprietes publiees, et rien d'autre : la tuile est publique. */
  proprietes: readonly string[];
}

export const COUCHES: readonly Couche[] = [
  { nom: "reseau_classe", zoomMin: ZOOM_MIN, proprietes: ["code", "nom", "classe", "etat", "revetement"] },
  { nom: "voirie_locale", zoomMin: 12, proprietes: ["nom", "classe"] },
];

export type Tuile = { z: number; x: number; y: number };

/**
 * Lit z/x/y depuis le chemin. Une tuile est une entree EXTERIEURE (publique, sans
 * authentification) : entiers stricts, bornes du pavage, zoom borne. Hors de quoi, `null`.
 */
export function lireTuile(z: string, x: string, y: string): Tuile | null {
  const entier = (s: string) => (/^\d{1,6}$/.test(s) ? Number(s) : NaN);
  const t = { z: entier(z), x: entier(x), y: entier(y) };
  if (![t.z, t.x, t.y].every(Number.isInteger)) return null;
  if (t.z < ZOOM_MIN || t.z > ZOOM_MAX) return null;
  const n = 2 ** t.z;
  if (t.x >= n || t.y >= n) return null;
  return t;
}

export function couchesAuZoom(z: number): Couche[] {
  return COUCHES.filter((c) => z >= c.zoomMin);
}

/** Emprise d'une tuile en degres (lon/lat), pour le controle et les tests. */
export function empriseTuile({ z, x, y }: Tuile): { ouest: number; sud: number; est: number; nord: number } {
  const n = 2 ** z;
  const lon = (i: number) => (i / n) * 360 - 180;
  const lat = (j: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) * 180) / Math.PI;
  return { ouest: lon(x), est: lon(x + 1), nord: lat(y), sud: lat(y + 1) };
}

/** Une tuile du reseau change rarement : cinq minutes de cache, revalidation par empreinte. */
export const CACHE_TUILE = "public, max-age=300, must-revalidate";

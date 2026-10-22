/**
 * Contour du pays, pour le fond du geoportail.
 *
 * D'OU VIENT LE TRACE : les limites administratives de niveau 1 (les 8 regions) de la table
 * `limites_admin`, source OCHA COD-AB publiee sur HDX, geometries valides au 04/03/2016. Le contour du
 * pays est la FRONTIERE EXTERIEURE de l'union de ces regions : les limites interieures disparaissent.
 *
 * CE QUE CE TRACE N'EST PAS : une frontiere officielle de l'Etat. C'est le decoupage d'une source
 * humanitaire, anterieur a la reforme du 20 aout 2026 (voir la migration 20260905110000) ; la
 * reponse porte sa source et sa date pour que l'ecran puisse le dire. Il est SIMPLIFIE (tolerance
 * en degres) : il sert a se reperer, pas a mesurer.
 *
 * Si la base ne porte aucune limite de niveau 1, la reponse est `null` : on n'invente aucun trace de
 * repli (un contour approximatif ecrit a la main passerait pour une donnee).
 */

export interface DepotContour {
  $queryRaw<T = unknown>(chaines: TemplateStringsArray, ...valeurs: unknown[]): Promise<T>;
}

export interface ContourPays {
  type: "Feature";
  geometry: unknown;
  properties: {
    source: string;
    valideLe: string | null;
    simplificationDeg: number;
    nombreRegions: number;
    avertissement: string;
  };
}

/** Tolerance de simplification, en degres (environ 220 m) : invisible a l'echelle du pays. */
export const SIMPLIFICATION_DEG = 0.002;

/** La memoire dure une heure : l'union de huit polygones n'a aucune raison d'etre recalculee a chaque carte. */
const DUREE_MEMOIRE_MS = 3_600_000;
let memoire: { jusqua: number; valeur: ContourPays | null } | null = null;

export function oublierContour(): void {
  memoire = null;
}

interface Ligne {
  geojson: string | null;
  n: number;
  valide_le: string | null;
  source: string | null;
}

export async function contourPays(depot: DepotContour, maintenant: number = Date.now()): Promise<ContourPays | null> {
  if (memoire && maintenant < memoire.jusqua) return memoire.valeur;

  const lignes = await depot.$queryRaw<Ligne[]>`
    SELECT ST_AsGeoJSON(ST_SimplifyPreserveTopology(ST_Boundary(ST_Union(geom)), ${SIMPLIFICATION_DEG}::float8), 5) AS geojson,
           count(*)::int AS n,
           to_char(max("validOn"), 'YYYY-MM-DD') AS valide_le,
           max(source) AS source
      FROM limites_admin
     WHERE niveau = 1 AND geom IS NOT NULL`;
  const l = lignes[0];
  const valeur: ContourPays | null = !l || !l.geojson || l.n === 0
    ? null
    : {
        type: "Feature",
        geometry: JSON.parse(l.geojson),
        properties: {
          source: l.source ?? "limites administratives de niveau 1",
          valideLe: l.valide_le,
          simplificationDeg: SIMPLIFICATION_DEG,
          nombreRegions: l.n,
          avertissement:
            "Decoupage d'une source humanitaire, anterieur a la reforme du 20/08/2026 : ce n'est pas une frontiere officielle.",
        },
      };
  // Seul un resultat PLEIN est garde en memoire : une base momentanement vide ne doit pas
  // cacher le contour pendant une heure une fois les limites importees.
  if (valeur) memoire = { jusqua: maintenant + DUREE_MEMOIRE_MS, valeur };
  return valeur;
}

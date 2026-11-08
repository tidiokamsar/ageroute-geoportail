/**
 * Transformation de CRS PAR LA BASE (PostGIS `ST_Transform`, PROJ) : aucune formule de projection n'est ecrite dans l'application.
 * Contrat : docs/projets-voirie/CONTRAT-IMPORT.md, section 5. Lecture seule : aucune ecriture.
 *
 * Les coordonnees source partent par lots de 50 000 points (tableaux `float8[]`, valeurs LIEES, jamais concatenees) et reviennent dans le
 * meme ordre. Une coordonnee que PROJ refuse fait echouer le lot : TRANSFORMATION_ECHEC (422), sans message interne de la base.
 */

import { ErreurLecture } from "../lecture.types";
import { estDelaiDepasse, type TxMinimale } from "../bd";
import { META_WGS84, metaDepuisSpatialRef, type MetaCrs } from "./crs.noyau";
import type { Transformes } from "./lecture-import.noyau";
import type { SommetsBruts } from "./puits.noyau";

const LOT = 50_000;

/** Metadonnees du CRS depuis `spatial_ref_sys` ; 422 CRS_NON_DISPONIBLE si la base ne le connait pas. */
export async function resoudreCrs(tx: TxMinimale, epsg: number): Promise<MetaCrs> {
  if (epsg === META_WGS84.epsg) return META_WGS84;
  const l = await tx.$queryRaw<{ srid: number; srtext: string | null; proj4text: string | null }[]>`
    SELECT "srid"::int AS "srid", "srtext", "proj4text" FROM "spatial_ref_sys" WHERE "srid" = ${epsg}::int`;
  if (l.length === 0) throw new ErreurLecture("CRS_NON_DISPONIBLE", `la base ne connait pas EPSG:${epsg} (spatial_ref_sys) : contactez l'administrateur`);
  return metaDepuisSpatialRef(l[0]);
}

/** Version de PROJ vue par PostGIS (`null` si elle ne se lit pas). */
export async function versionProj(tx: TxMinimale): Promise<string | null> {
  try {
    const l = await tx.$queryRaw<{ v: string | null }[]>`SELECT PostGIS_PROJ_Version() AS "v"`;
    const m = /(\d+\.\d+(?:\.\d+)?)/.exec(l[0]?.v ?? "");
    return m ? m[1] : null;
  } catch (e) {
    if (estDelaiDepasse(e)) throw e;
    return null;
  }
}

/** Transforme les sommets source en (longitude, latitude) WGS 84. Les sommets marques invalides (remplaces par 0) rendent NaN. */
export async function transformerSommets(tx: TxMinimale, epsg: number, s: SommetsBruts): Promise<Transformes> {
  const n = s.x.length;
  const lon = new Float64Array(n);
  const lat = new Float64Array(n);
  for (let i = 0; i < n; i += LOT) {
    const xs = Array.from(s.x.subarray(i, i + LOT));
    const ys = Array.from(s.y.subarray(i, i + LOT));
    let r: { lon: number[] | null; lat: number[] | null }[];
    try {
      r = await tx.$queryRaw<{ lon: number[] | null; lat: number[] | null }[]>`
        SELECT array_agg(ST_X(q."g") ORDER BY q."o") AS "lon", array_agg(ST_Y(q."g") ORDER BY q."o") AS "lat"
          FROM (SELECT t."o", ST_Transform(ST_SetSRID(ST_MakePoint(t."x", t."y"), ${epsg}::int), 4326) AS "g"
                  FROM unnest(${xs}::float8[], ${ys}::float8[]) WITH ORDINALITY AS t("x", "y", "o")) q`;
    } catch (e) {
      if (estDelaiDepasse(e)) throw e;
      throw new ErreurLecture("TRANSFORMATION_ECHEC", `PROJ refuse de transformer une coordonnee du fichier depuis EPSG:${epsg} : verifiez le CRS choisi et les valeurs de coordonnees`);
    }
    const a = r[0]?.lon, b = r[0]?.lat;
    if (!a || !b || a.length !== xs.length || b.length !== xs.length) {
      throw new ErreurLecture("TRANSFORMATION_ECHEC", `la transformation depuis EPSG:${epsg} n'a pas rendu autant de points qu'envoye`);
    }
    for (let k = 0; k < a.length; k++) {
      // Un sommet illisible (envoye a 0) ou un resultat non fini devient NaN : l'objet est ecarte comme invalide par le collecteur.
      lon[i + k] = s.invalide[i + k] || !Number.isFinite(a[k]) ? NaN : a[k];
      lat[i + k] = s.invalide[i + k] || !Number.isFinite(b[k]) ? NaN : b[k];
    }
  }
  return { lon, lat };
}

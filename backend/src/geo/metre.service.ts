import type { PrismaClient } from "@prisma/client";

/**
 * Mesure d'une geometrie GeoJSON (EPSG:4326) en projection UTM, par PostGIS (`metre_utm`).
 *
 * Partagee par `POST /api/v2/geo/metre` et par la saisie des defauts : une geometrie invalide est
 * refusee avec la raison que donne PostGIS, jamais reparee (`ST_MakeValid` changerait la surface
 * mesuree sans le dire, paragraphe 7.1). La geometrie part en parametre lie.
 */
export interface MesureUtm {
  epsg: number; longueurM: number; surfaceM2: number;
  longueurGeodesiqueM: number; surfaceGeodesiqueM2: number;
  ecartLongueur: number | null; ecartSurface: number | null;
}

export type ResultatMesure =
  | { ok: true; mesure: MesureUtm }
  | { ok: false; code: "GEOMETRIE_ILLISIBLE" | "GEOMETRIE_INVALIDE"; raison: string };

export async function mesurerGeometrie(depot: Pick<PrismaClient, "$queryRaw">, geometrie: unknown): Promise<ResultatMesure> {
  const geojson = JSON.stringify(geometrie);
  let valide: { valide: boolean; raison: string }[];
  try {
    valide = await depot.$queryRaw<{ valide: boolean; raison: string }[]>`
      SELECT ST_IsValid(g) AS "valide", ST_IsValidReason(g) AS "raison" FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326) AS g) s`;
  } catch {
    // Coordonnees que PostGIS ne sait pas lire : c'est une erreur de l'appelant, pas du serveur.
    return { ok: false, code: "GEOMETRIE_ILLISIBLE", raison: "coordonnees GeoJSON non conformes" };
  }
  if (!valide[0]?.valide) return { ok: false, code: "GEOMETRIE_INVALIDE", raison: valide[0]?.raison ?? "inconnue" };
  const [m] = await depot.$queryRaw<MesureUtm[]>`SELECT * FROM metre_utm(ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326))`;
  return { ok: true, mesure: m };
}

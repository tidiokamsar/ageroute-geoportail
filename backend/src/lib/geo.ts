import { prisma } from "./prisma";

// Tables dont la colonne "geom" est un Point(4326) ecrite/lue via SQL brut
// (Prisma ne sait pas manipuler les colonnes Unsupported("geometry...")).
const ALLOWED_TABLES = new Set(["ouvrages", "points_noirs", "postes"]);

export async function setPointGeom(table: string, id: string, lat: number, lon: number): Promise<void> {
  if (!ALLOWED_TABLES.has(table)) throw new Error(`Table non autorisee pour setPointGeom: ${table}`);
  // id est une colonne text (Prisma String @id sans @db.Uuid) : pas de cast ::uuid.
  await prisma.$executeRawUnsafe(
    `UPDATE ${table} SET geom = ST_SetSRID(ST_MakePoint($1, $2), 4326) WHERE id = $3`,
    lon,
    lat,
    id
  );
}

export async function getPointLatLon(table: string, id: string): Promise<{ lat: number; lon: number } | null> {
  if (!ALLOWED_TABLES.has(table)) throw new Error(`Table non autorisee pour getPointLatLon: ${table}`);
  const rows = await prisma.$queryRawUnsafe<{ lat: number; lon: number }[]>(
    `SELECT ST_Y(geom) AS lat, ST_X(geom) AS lon FROM ${table} WHERE id = $1 AND geom IS NOT NULL`,
    id
  );
  return rows[0] ?? null;
}

/**
 * Referencement lineaire : derive la geometrie d'un chantier depuis le trace reel du troncon
 * entre pkDebut et pkFin (ST_LineSubstring). Le chantier epouse ainsi exactement la route.
 * Retourne true si une geometrie a ete posee, false sinon (troncon sans geom, PK invalides...).
 */
export async function deriveChantierGeom(
  chantierId: string,
  tronconId: string,
  pkDebut: number,
  pkFin: number
): Promise<boolean> {
  // Deux cas : si le troncon a un vrai intervalle PK (pkFin>pkDebut), le PK du chantier est
  // mappe en absolu sur cet intervalle. Sinon (PK 0/0, ~1029 troncons), on retombe sur la
  // longueur geometrique reelle : le PK du chantier = km depuis le debut du trace du troncon.
  const result = await prisma.$executeRaw`
    UPDATE chantiers c
    SET geom = ST_LineSubstring(t.geom, LEAST(f_start, f_end), GREATEST(f_start, f_end))
    FROM troncons t,
      LATERAL (
        SELECT
          CASE WHEN t."pkFin" > t."pkDebut" THEN t."pkDebut" ELSE 0 END AS base,
          CASE WHEN t."pkFin" > t."pkDebut" THEN (t."pkFin" - t."pkDebut")
               ELSE GREATEST(ST_Length(t.geom::geography) / 1000.0, 0.0001) END AS span
      ) ref,
      LATERAL (
        SELECT
          GREATEST(0, LEAST(1, (${pkDebut} - base) / span))::float8 AS f_start,
          GREATEST(0, LEAST(1, (${pkFin} - base) / span))::float8 AS f_end
      ) frac
    WHERE c.id = ${chantierId}
      AND t.id = ${tronconId}
      AND t.geom IS NOT NULL
      AND ST_GeometryType(t.geom) = 'ST_LineString'
      AND LEAST(f_start, f_end) <> GREATEST(f_start, f_end)
  `;
  return result > 0;
}

/**
 * Geolocalise un point (ouvrage/point noir/poste) depuis le trace reel de son troncon
 * rattache, par interpolation lineaire au PK (ST_LineInterpolatePoint). Utile pour les
 * fiches historiques qui ont un tronconId/pk mais jamais recu de coordonnees GPS directes.
 * Retourne true si une position a ete posee, false sinon (pas de geom troncon, etc.).
 */
export async function deriveGeomFromTroncon(table: string, id: string, tronconId: string, pk: number): Promise<boolean> {
  if (!ALLOWED_TABLES.has(table)) throw new Error(`Table non autorisee pour deriveGeomFromTroncon: ${table}`);
  const result = await prisma.$executeRawUnsafe(
    `UPDATE ${table} pt
     SET geom = ST_LineInterpolatePoint(t.geom, frac.f)
     FROM troncons t,
       LATERAL (
         SELECT
           CASE WHEN t."pkFin" > t."pkDebut" THEN t."pkDebut" ELSE 0 END AS base,
           CASE WHEN t."pkFin" > t."pkDebut" THEN (t."pkFin" - t."pkDebut")
                ELSE GREATEST(ST_Length(t.geom::geography) / 1000.0, 0.0001) END AS span
       ) ref,
       LATERAL (SELECT GREATEST(0, LEAST(1, ($3 - base) / span))::float8 AS f) frac
     WHERE pt.id = $1 AND t.id = $2
       AND t.geom IS NOT NULL AND ST_GeometryType(t.geom) = 'ST_LineString'`,
    id,
    tronconId,
    pk
  );
  return result > 0;
}

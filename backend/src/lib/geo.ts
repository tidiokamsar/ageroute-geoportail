import { prisma } from "./prisma";

// Tables dont la colonne "geom" est un Point(4326) ecrite/lue via SQL brut
// (Prisma ne sait pas manipuler les colonnes Unsupported("geometry...")).
const ALLOWED_TABLES = new Set(["ouvrages", "points_noirs", "postes", "defauts"]);

// Tables dont la colonne "geom" est une LineString(4326). Liste separee : ecrire une
// ligne la ou un point est attendu passerait les types SQL et casserait l'affichage.
const LIGNE_TABLES = new Set(["portions"]);

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

/**
 * Place un point depuis une abscisse locale en mètres, sans exiger de PK de route.
 * Contrairement à `deriveGeomFromTroncon`, cette interpolation suit directement la
 * longueur géographique du segment et ne dépend d'aucune calibration de PK.
 */
export async function deriveGeomFromTronconAbscisse(
  table: string,
  id: string,
  tronconId: string,
  abscisseM: number
): Promise<boolean> {
  if (!ALLOWED_TABLES.has(table)) throw new Error(`Table non autorisee pour deriveGeomFromTronconAbscisse: ${table}`);
  if (!Number.isFinite(abscisseM) || abscisseM < 0) return false;

  const result = await prisma.$executeRawUnsafe(
    `UPDATE ${table} pt
     SET geom = ST_LineInterpolatePoint(t.geom, $3 / NULLIF(ST_Length(t.geom::geography), 0))
     FROM troncons t
     WHERE pt.id = $1 AND t.id = $2
       AND t.geom IS NOT NULL
       AND ST_GeometryType(t.geom) = 'ST_LineString'
       AND $3 <= ST_Length(t.geom::geography)`,
    id,
    tronconId,
    abscisseM
  );
  return result > 0;
}

/**
 * Derive la LIGNE d'une portion entre deux abscisses locales, dans une transaction.
 *
 * POURQUOI `ST_LineSubstring` ET DES FRACTIONS
 *
 * `ST_LineSubstring` prend des fractions de la longueur planaire. L'abscisse, elle, est
 * definie par `geo/appariement.ts` comme `ST_LineLocatePoint(...) * ST_Length(geom::geography)`,
 * c'est-a-dire fraction x longueur geodesique. Diviser par cette MEME longueur rend donc
 * la fraction exacte par construction, et non une approximation : les deux sens
 * s'appuient sur la meme reference.
 *
 * POURQUOI UN CLIENT DE TRANSACTION EN PARAMETRE
 *
 * Une portion inseree sans sa geometrie, ou une geometrie posee sans sa portion, laisserait
 * la carte et la table en desaccord. Les deux doivent tomber ensemble, donc l'appelant
 * fournit son `tx`. C'est la difference avec `deriveGeomFromTronconAbscisse`, ecrit avant
 * que quoi que ce soit n'en ait besoin dans une transaction.
 *
 * Rend `false` quand rien n'a ete ecrit : geometrie de reference absente, bornes hors du
 * trace, ou longueur nulle. L'appelant decide quoi en faire — ici, une portion sans
 * geometrie reste parfaitement valide, puisque ce sont les ABSCISSES qui font autorite.
 */
export async function deriveLigneFromTronconAbscisses(
  tx: { $executeRawUnsafe(sql: string, ...args: unknown[]): Promise<number> },
  table: string,
  id: string,
  tronconId: string,
  debutM: number,
  finM: number
): Promise<boolean> {
  if (!LIGNE_TABLES.has(table)) {
    throw new Error(`Table non autorisee pour deriveLigneFromTronconAbscisses: ${table}`);
  }
  if (!Number.isFinite(debutM) || !Number.isFinite(finM) || debutM < 0 || finM <= debutM) {
    return false;
  }

  const n = await tx.$executeRawUnsafe(
    `UPDATE ${table} p
        SET geom = ST_LineSubstring(
              t.geom,
              LEAST(1, GREATEST(0, $3 / NULLIF(ST_Length(t.geom::geography), 0))),
              LEAST(1, GREATEST(0, $4 / NULLIF(ST_Length(t.geom::geography), 0)))
            )
       FROM troncons t
      WHERE p.id = $1 AND t.id = $2
        AND t.geom IS NOT NULL
        AND ST_GeometryType(t.geom) = 'ST_LineString'
        AND ST_Length(t.geom::geography) > 0`,
    id,
    tronconId,
    debutM,
    finM
  );
  return n > 0;
}

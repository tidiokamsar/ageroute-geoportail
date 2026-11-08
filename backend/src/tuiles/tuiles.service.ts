import { Prisma, type PrismaClient } from "@prisma/client";
import { clauseSqlReseauClasse } from "../lib/reseau";
import { couchesAuZoom, ETENDUE_TUILE, MARGE_TUILE, type Tuile } from "./tuiles.noyau";

/**
 * Engendre une tuile MVT du reseau par PostGIS (`ST_AsMVT`).
 *
 * LE FILTRE SPATIAL passe par `geom::geography && emprise::geography` : c'est la seule forme que
 * l'index de `troncons` (`troncons_geom_geography_idx`, sur l'expression geography) sait servir.
 * Mesure du 22/10/2026 a 261 387 troncons, tuile z10 de Conakry : 13 ms par l'index, 107 ms en
 * filtre planaire `geom && ...` (balayage parallele de la table). L'emprise est elargie de la marge
 * de la tuile, pour que les traits qui la frolent ne soient pas coupes au bord.
 *
 * LES PERIMETRES sont ceux de la carte publique : reseau classe (`clauseSqlReseauClasse`, hors
 * territoire et voirie locale exclus), voirie locale a part, troncons retires exclus.
 */
export async function tuileReseau(depot: Pick<PrismaClient, "$queryRaw">, t: Tuile): Promise<Buffer> {
  const couches = couchesAuZoom(t.z).map((c) => c.nom);
  const classe = couches.includes("reseau_classe");
  const voirie = couches.includes("voirie_locale");
  const marge = MARGE_TUILE / ETENDUE_TUILE;
  const lignes = await depot.$queryRaw<{ mvt: Buffer | null }[]>`
    WITH env AS (
      SELECT ST_TileEnvelope(${t.z}::integer, ${t.x}::integer, ${t.y}::integer) AS e3857,
             ST_Transform(ST_TileEnvelope(${t.z}::integer, ${t.x}::integer, ${t.y}::integer, margin => ${marge}::float8), 4326)::geography AS eg
    ),
    classe AS (
      SELECT ST_AsMVTGeom(ST_Transform(t.geom, 3857), env.e3857, ${ETENDUE_TUILE}::integer, ${MARGE_TUILE}::integer, true) AS geom,
             t.code, t.nom, t.classe::text AS classe, t.etat::text AS etat, t.revetement::text AS revetement
        FROM troncons t, env
       WHERE ${classe}::boolean AND t."deletedAt" IS NULL AND t.geom IS NOT NULL
         AND ${Prisma.raw(clauseSqlReseauClasse('t."sourceReference"'))}
         AND t.geom::geography && env.eg
    ),
    voirie AS (
      SELECT ST_AsMVTGeom(ST_Transform(t.geom, 3857), env.e3857, ${ETENDUE_TUILE}::integer, ${MARGE_TUILE}::integer, true) AS geom,
             t.nom, t.classe::text AS classe
        FROM troncons t, env
       WHERE ${voirie}::boolean AND t."deletedAt" IS NULL AND t.geom IS NOT NULL
         AND t."sourceReference" LIKE 'voirie_locale:%'
         AND t.geom::geography && env.eg
    )
    -- Une couche sans objet rend NULL : sans coalesce, la concatenation perdrait l'autre couche.
    SELECT coalesce((SELECT ST_AsMVT(classe.*, 'reseau_classe', ${ETENDUE_TUILE}::integer, 'geom') FROM classe WHERE geom IS NOT NULL), ''::bytea)
        || coalesce((SELECT ST_AsMVT(voirie.*, 'voirie_locale', ${ETENDUE_TUILE}::integer, 'geom') FROM voirie WHERE geom IS NOT NULL), ''::bytea) AS mvt`;
  return lignes[0]?.mvt ?? Buffer.alloc(0);
}

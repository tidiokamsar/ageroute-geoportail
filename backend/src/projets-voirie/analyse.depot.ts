/**
 * ACCES SQL DE L'ANALYSE (PostGIS). Toutes les requetes sont `$queryRaw` ETIQUETEES : les valeurs (identifiants, SRID, largeurs)
 * sont LIEES par le pilote, jamais concatenees (lib/sql-parametre.test.ts interdit la forme non etiquetee). Les fragments de CTE
 * sont des `Prisma.sql` composes.
 *
 * GEOMETRIE : les objets sont stockes en WGS 84 (4326). Les bandes se calculent en metres, dans la projection UTM choisie
 * (`epsgPourLongitude`) : `ST_Transform` vers l'UTM, `ST_Buffer` (bouts arrondis, 16 segments par quart de cercle), puis les
 * longueurs sont RE-MESUREES sur la geographie (`ST_Length(ST_Transform(x, 4326)::geography)`), la meme mesure que
 * `longueurTotaleM` et `longueurTraceFusionneM` : une portion ne peut donc pas depasser le total qui la contient.
 *
 * TRACES FUSIONNES : pour un jeu, `ST_UnaryUnion(ST_Collect(geom))` noeude les lignes et fusionne les parties superposees (un
 * meme trace repete par plusieurs circuits n'est compte qu'une fois). Les mesures de conflit portent sur ces tracés fusionnes.
 *
 * Rien n'est ecrit : l'appelant ouvre une transaction `READ ONLY`.
 */

import { Prisma, type PrismaClient } from "@prisma/client";

export type Tx = Pick<PrismaClient, "$queryRaw">;

const QUART_DE_CERCLE = "quad_segs=16";

export interface Bandes {
  epsg: number;
  /** Demi-largeur de chaussee, en metres. */
  dc: number;
  /** Demi-largeur d'emprise, en metres. */
  de: number;
  axesIds: string[];
  reseauIds: string[];
}

const axobj = (b: Bandes) => Prisma.sql`axobj AS (
  SELECT o."id" AS "id", COALESCE(o."nom", 'Axe ' || (o."ordre" + 1)::text) AS "axe", ST_Transform(o."geom", ${b.epsg}::int) AS "g"
    FROM "projets_voirie_objets" o
   WHERE o."jeuId" = ANY(${b.axesIds}::text[]) AND o."typeGeom" = 'LIGNE')`;

const bandesAxe = (b: Bandes) => Prisma.sql`bandes_axe AS (
  SELECT a."id", a."axe", a."g",
         ST_Buffer(a."g", ${b.dc}::float8, ${QUART_DE_CERCLE}) AS "bc",
         ST_Buffer(a."g", ${b.de}::float8, ${QUART_DE_CERCLE}) AS "be"
    FROM axobj a)`;

const bandesUnion = (b: Bandes) => Prisma.sql`axes_union AS (SELECT ST_UnaryUnion(ST_Collect("g")) AS "ax" FROM axobj),
bandes AS (
  SELECT "ax", ST_Buffer("ax", ${b.dc}::float8, ${QUART_DE_CERCLE}) AS "bc", ST_Buffer("ax", ${b.de}::float8, ${QUART_DE_CERCLE}) AS "be"
    FROM axes_union WHERE "ax" IS NOT NULL)`;

const reseau = (b: Bandes) => Prisma.sql`res AS (
  SELECT o."jeuId" AS "jeu", ST_Transform(ST_UnaryUnion(ST_Collect(o."geom")), ${b.epsg}::int) AS "g"
    FROM "projets_voirie_objets" o
   WHERE o."jeuId" = ANY(${b.reseauIds}::text[]) AND o."typeGeom" = 'LIGNE'
   GROUP BY o."jeuId")`;

/** Longueur, en metres, des seules parties lineaires de `x` (UTM), mesuree sur la geographie. */
const LONGUEUR = (x: Prisma.Sql) => Prisma.sql`COALESCE(ST_Length(ST_Transform(ST_CollectionExtract(${x}, 2), 4326)::geography), 0)`;

/** Etendue (longitudes) des objets des jeux donnes ; null sans objet. */
export async function etendueLongitude(tx: Tx, jeuxIds: string[]): Promise<{ ouest: number; est: number } | null> {
  if (jeuxIds.length === 0) return null;
  const r = await tx.$queryRaw<{ ouest: number | null; est: number | null }[]>`
    SELECT ST_XMin("e") AS "ouest", ST_XMax("e") AS "est"
      FROM (SELECT ST_Extent("geom") AS "e" FROM "projets_voirie_objets" WHERE "jeuId" = ANY(${jeuxIds}::text[])) q`;
  const l = r[0];
  return l && l.ouest !== null && l.est !== null ? { ouest: l.ouest, est: l.est } : null;
}

export interface LigneAxe { id: string; axe: string; longueurM: number }

export async function listerAxes(tx: Tx, b: Bandes): Promise<{ axes: LigneAxe[]; longueurFusionneeM: number }> {
  const axes = await tx.$queryRaw<{ id: bigint | string; axe: string; longueurM: number }[]>`
    WITH ${axobj(b)}
    SELECT "id"::text AS "id", "axe", ST_Length(ST_Transform("g", 4326)::geography) AS "longueurM" FROM axobj ORDER BY "axe", "id"`;
  const u = await tx.$queryRaw<{ l: number | null }[]>`
    WITH ${axobj(b)}
    SELECT ST_Length(ST_Transform(ST_UnaryUnion(ST_Collect("g")), 4326)::geography) AS "l" FROM axobj`;
  return { axes: axes.map((a) => ({ id: String(a.id), axe: a.axe, longueurM: Number(a.longueurM) })), longueurFusionneeM: Number(u[0]?.l ?? 0) };
}

export interface MesureJeu { jeu: string; chausseeM: number; empriseM: number; croisements: number; fusionneM: number }

/** Mesures par jeu de reseau : tracé fusionne dans l'UNION des bandes de tous les axes (un carrefour compte une fois). */
export async function mesurerParJeu(tx: Tx, b: Bandes): Promise<MesureJeu[]> {
  const r = await tx.$queryRaw<{ jeu: string; chaussee: number; emprise: number; croisements: number; fusionne: number }[]>`
    WITH ${axobj(b)}, ${bandesUnion(b)}, ${reseau(b)}
    SELECT r."jeu" AS "jeu",
           ${LONGUEUR(Prisma.sql`ST_Intersection(r."g", bn."bc")`)} AS "chaussee",
           ${LONGUEUR(Prisma.sql`ST_Intersection(r."g", bn."be")`)} AS "emprise",
           COALESCE(ST_NumGeometries(ST_CollectionExtract(ST_Intersection(r."g", bn."ax"), 1)), 0)::int AS "croisements",
           ST_Length(ST_Transform(r."g", 4326)::geography) AS "fusionne"
      FROM res r CROSS JOIN bandes bn`;
  return r.map((x) => ({ jeu: x.jeu, chausseeM: Number(x.chaussee), empriseM: Number(x.emprise), croisements: Number(x.croisements), fusionneM: Number(x.fusionne) }));
}

export interface MesureAxeJeu { axeId: string; axe: string; jeu: string; chausseeM: number; empriseM: number; croisements: number }

/** Mesures par axe et par jeu : tracé fusionne du jeu dans la bande de CET axe seul. */
export async function mesurerParAxe(tx: Tx, b: Bandes): Promise<MesureAxeJeu[]> {
  const r = await tx.$queryRaw<{ aid: bigint | string; axe: string; jeu: string; c: number; e: number; x: number }[]>`
    WITH ${axobj(b)}, ${bandesAxe(b)}, ${reseau(b)}
    SELECT * FROM (
      SELECT a."id"::text AS "aid", a."axe" AS "axe", r."jeu" AS "jeu",
             ${LONGUEUR(Prisma.sql`ST_Intersection(r."g", a."bc")`)} AS "c",
             ${LONGUEUR(Prisma.sql`ST_Intersection(r."g", a."be")`)} AS "e",
             COALESCE(ST_NumGeometries(ST_CollectionExtract(ST_Intersection(r."g", a."g"), 1)), 0)::int AS "x"
        FROM bandes_axe a JOIN res r ON ST_Intersects(r."g", a."be")
    ) m WHERE m."c" > 0 OR m."e" > 0 OR m."x" > 0`;
  return r.map((x) => ({ axeId: String(x.aid), axe: x.axe, jeu: x.jeu, chausseeM: Number(x.c), empriseM: Number(x.e), croisements: Number(x.x) }));
}

export interface MesureAxeObjet {
  axeId: string; axe: string; jeu: string; objetId: string; nom: string | null;
  chausseeM: number; empriseM: number; croisements: number;
}

/** Mesures par axe et par objet BRUT du fichier (non fusionne), plafonnees a `limite` lignes. */
export async function mesurerParObjet(tx: Tx, b: Bandes, limite: number): Promise<MesureAxeObjet[]> {
  const r = await tx.$queryRaw<{ aid: bigint | string; axe: string; jeu: string; oid: bigint | string; nom: string | null; c: number; e: number; x: number }[]>`
    WITH ${axobj(b)}, ${bandesAxe(b)},
    cand AS (
      SELECT a."id" AS "aid", a."axe" AS "axe", a."g" AS "ag", a."bc", a."be", o."id" AS "oid", o."jeuId" AS "jeu", o."nom" AS "nom",
             ST_Transform(o."geom", ${b.epsg}::int) AS "og"
        FROM bandes_axe a
        JOIN "projets_voirie_objets" o
          ON o."jeuId" = ANY(${b.reseauIds}::text[]) AND o."typeGeom" = 'LIGNE'
         AND o."geom" && ST_Expand(ST_Transform(a."be", 4326), 0.0001))
    SELECT * FROM (
      SELECT "aid"::text AS "aid", "axe", "jeu", "oid"::text AS "oid", "nom",
             ${LONGUEUR(Prisma.sql`ST_Intersection("og", "bc")`)} AS "c",
             ${LONGUEUR(Prisma.sql`ST_Intersection("og", "be")`)} AS "e",
             COALESCE(ST_NumGeometries(ST_CollectionExtract(ST_Intersection("og", "ag"), 1)), 0)::int AS "x"
        FROM cand WHERE ST_Intersects("og", "be")
    ) m WHERE m."c" > 0 OR m."e" > 0 OR m."x" > 0
    ORDER BY m."axe", m."e" DESC, m."oid"
    LIMIT ${limite}`;
  return r.map((x) => ({
    axeId: String(x.aid), axe: x.axe, jeu: x.jeu, objetId: String(x.oid), nom: x.nom,
    chausseeM: Number(x.c), empriseM: Number(x.e), croisements: Number(x.x),
  }));
}

export interface PointCroisement { jeu: string; lon: number; lat: number; axe: string }

/** Points de croisement (reseau fusionne x axes), avec l'axe le plus proche, plafonnes a `limite`. */
export async function pointsDeCroisement(tx: Tx, b: Bandes, limite: number): Promise<PointCroisement[]> {
  const r = await tx.$queryRaw<{ jeu: string; lon: number; lat: number; axe: string | null }[]>`
    WITH ${axobj(b)}, ${bandesUnion(b)}, ${reseau(b)},
    pts AS (
      SELECT r."jeu" AS "jeu", (ST_Dump(ST_CollectionExtract(ST_Intersection(r."g", bn."ax"), 1))).geom AS "p"
        FROM res r CROSS JOIN bandes bn)
    SELECT p."jeu" AS "jeu", ST_X(ST_Transform(p."p", 4326)) AS "lon", ST_Y(ST_Transform(p."p", 4326)) AS "lat",
           (SELECT a."axe" FROM axobj a ORDER BY ST_Distance(a."g", p."p") ASC, a."id" ASC LIMIT 1) AS "axe"
      FROM pts p
     ORDER BY p."jeu", ST_X(p."p"), ST_Y(p."p")
     LIMIT ${limite}`;
  return r.map((x) => ({ jeu: x.jeu, lon: Number(x.lon), lat: Number(x.lat), axe: x.axe ?? "" }));
}

export interface ZonesGeoJson { chaussee: string | null; emprise: string | null; hors: string | null }

/**
 * Trois couches DISJOINTES du reseau fusionne : dans la chaussee, dans l'emprise hors chaussee, hors emprise. Simplifiees
 * (0,25 m pour les deux premieres, 2 m pour la troisieme), coordonnees a 6 decimales.
 */
export async function zones(tx: Tx, b: Bandes): Promise<ZonesGeoJson> {
  const r = await tx.$queryRaw<{ zc: string | null; ze: string | null; zh: string | null }[]>`
    WITH ${axobj(b)}, ${bandesUnion(b)}, ${reseau(b)},
    morceaux AS (
      SELECT ST_Collect(ST_CollectionExtract(ST_Intersection(r."g", bn."bc"), 2)) AS "c",
             ST_Collect(ST_CollectionExtract(ST_Difference(ST_Intersection(r."g", bn."be"), bn."bc"), 2)) AS "e",
             ST_Collect(ST_CollectionExtract(ST_Difference(r."g", bn."be"), 2)) AS "h"
        FROM res r CROSS JOIN bandes bn)
    SELECT CASE WHEN "c" IS NULL OR ST_IsEmpty("c") THEN NULL
                ELSE ST_AsGeoJSON(ST_Transform(ST_SimplifyPreserveTopology(ST_CollectionExtract("c", 2), 0.25), 4326), 6) END AS "zc",
           CASE WHEN "e" IS NULL OR ST_IsEmpty("e") THEN NULL
                ELSE ST_AsGeoJSON(ST_Transform(ST_SimplifyPreserveTopology(ST_CollectionExtract("e", 2), 0.25), 4326), 6) END AS "ze",
           CASE WHEN "h" IS NULL OR ST_IsEmpty("h") THEN NULL
                ELSE ST_AsGeoJSON(ST_Transform(ST_SimplifyPreserveTopology(ST_CollectionExtract("h", 2), 2), 4326), 6) END AS "zh"
      FROM morceaux`;
  const l = r[0];
  return { chaussee: l?.zc ?? null, emprise: l?.ze ?? null, hors: l?.zh ?? null };
}

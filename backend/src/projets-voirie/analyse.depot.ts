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
 * COUT BORNE (revue de securite, M2). Trois mesures, chacune prouvee par le banc de charge (`projets-voirie-charge.integration.mts`) :
 *   1. les geometries sont SIMPLIFIEES avant tout calcul (axes a 0,1 m, reseaux a 0,05 m, Douglas-Peucker, tronçons ecrases conserves) :
 *      un axe leve au metre perd 95 % de ses sommets sans que la bande bouge de plus de 10 cm, ce qui est sans commune mesure avec la
 *      precision des donnees ; le tampon est calcule avec 8 segments par quart de cercle (ecart de 0,5 % du rayon, soit 2 cm a 3,5 m) ;
 *   2. aucune operation de recouvrement n'oppose un objet a un polygone de dizaines de milliers de sommets : le calcul PAR OBJET
 *      (liste des objets d'un axe, export CSV) n'utilise, pour chaque objet, que les morceaux de l'axe situes a moins de la demi-largeur
 *      d'emprise (axe decoupe en morceaux de 64 sommets par `ST_Subdivide`) ; l'ancienne forme (tampon entier x chaque objet) coutait
 *      plusieurs minutes pour 20 000 objets le long d'un axe de 100 000 sommets ;
 *   3. l'appelant pose `statement_timeout` (voir bd.ts) et refuse en amont les volumes demesures (`volumes`).
 *
 * Rien n'est ecrit : l'appelant ouvre une transaction `READ ONLY`.
 */

import { Prisma, type PrismaClient } from "@prisma/client";

export type Tx = Pick<PrismaClient, "$queryRaw">;

/** Segments par quart de cercle du tampon : 8 (ecart maximal de 0,5 % du rayon). */
export const QUART_DE_CERCLE = "quad_segs=8";
/** Tolerances de simplification, en metres (repere UTM). */
export const TOLERANCE_AXE_M = 0.1;
export const TOLERANCE_RESEAU_M = 0.05;
/** Morceaux d'axe de 64 sommets au plus pour le calcul par objet. */
export const SOMMETS_PAR_MORCEAU = 64;

export interface Bandes {
  epsg: number;
  /** Demi-largeur de chaussee, en metres. */
  dc: number;
  /** Demi-largeur d'emprise, en metres. */
  de: number;
  axesIds: string[];
  reseauIds: string[];
}

export const axobj = (b: Bandes) => Prisma.sql`axobj AS MATERIALIZED (
  SELECT o."id" AS "id", COALESCE(o."nom", 'Axe ' || (o."ordre" + 1)::text) AS "axe", ST_Simplify(ST_Transform(o."geom", ${b.epsg}::int), ${TOLERANCE_AXE_M}::float8, true) AS "g"
    FROM "projets_voirie_objets" o
   WHERE o."jeuId" = ANY(${b.axesIds}::text[]) AND o."typeGeom" = 'LIGNE')`;

const bandesAxe = (b: Bandes) => Prisma.sql`bandes_axe AS MATERIALIZED (
  SELECT a."id", a."axe", a."g",
         ST_Buffer(a."g", ${b.dc}::float8, ${QUART_DE_CERCLE}) AS "bc",
         ST_Buffer(a."g", ${b.de}::float8, ${QUART_DE_CERCLE}) AS "be"
    FROM axobj a)`;

const bandesUnion = (b: Bandes) => Prisma.sql`axes_union AS MATERIALIZED (SELECT ST_UnaryUnion(ST_Collect("g")) AS "ax" FROM axobj),
bandes AS MATERIALIZED (
  SELECT "ax", ST_Buffer("ax", ${b.dc}::float8, ${QUART_DE_CERCLE}) AS "bc", ST_Buffer("ax", ${b.de}::float8, ${QUART_DE_CERCLE}) AS "be"
    FROM axes_union WHERE "ax" IS NOT NULL)`;

/**
 * PREFILTRE DES OBJETS VOISINS (pilote local du 09/11/2026, defaut D4). Avant, chaque requete fusionnait TOUT le reseau (`ST_UnaryUnion` de
 * 50 000 lignes, refaite par quatre requetes : 300 s pour l'analyse 2D) alors que seules les parties a moins de la demi-emprise de l'axe entrent
 * dans les mesures de conflit. Les objets retenus sont ceux dont la boite englobante (index GiST de `projets_voirie_objets.geom`, en WGS 84)
 * touche la boite d'un morceau d'axe (64 sommets, `ST_Subdivide`) elargie de `distanceM` x 1,1 + 1 m, convertis en degres par le plus petit
 * degre de latitude (110 574 m) et par le degre de longitude au bord du morceau le plus eloigne de l'equateur : la boite elargie contient le
 * disque de rayon `distanceM` autour de chaque point du morceau, donc aucun objet a moins de `distanceM` d'un axe n'est ecarte (la marge couvre
 * l'ecart entre distance UTM et distance vraie, et les simplifications de 0,1 m et 0,05 m). C'est une borne : les mesures restent exactes,
 * calculees comme avant sur les seuls objets qui peuvent y contribuer (un objet ecarte a une intersection vide avec toute bande de ce rayon).
 */
export const proches = (b: Pick<Bandes, "axesIds" | "reseauIds">, distanceM: number) => Prisma.sql`proches AS MATERIALIZED (
  SELECT DISTINCT o."id" AS "id"
    FROM (SELECT ST_Subdivide(a."geom", ${SOMMETS_PAR_MORCEAU}::int) AS "g"
            FROM "projets_voirie_objets" a
           WHERE a."jeuId" = ANY(${b.axesIds}::text[]) AND a."typeGeom" = 'LIGNE') m
    CROSS JOIN LATERAL (SELECT (${distanceM}::float8 * 1.1 + 1) / 110574.0 AS "dy") y
    CROSS JOIN LATERAL (SELECT (${distanceM}::float8 * 1.1 + 1) / (111320.0 * cos(radians(least(89.0, greatest(abs(ST_YMin(m."g")), abs(ST_YMax(m."g"))) + y."dy")))) AS "dx") x
    JOIN "projets_voirie_objets" o ON o."geom" && ST_Expand(m."g", x."dx", y."dy")
   WHERE o."jeuId" = ANY(${b.reseauIds}::text[]) AND o."typeGeom" = 'LIGNE')`;

/** Reseau FUSIONNE par jeu, restreint aux objets voisins des axes : la CTE `proches` doit preceder. */
const reseau = (b: Bandes) => Prisma.sql`res AS MATERIALIZED (
  SELECT o."jeuId" AS "jeu", ST_Simplify(ST_Transform(ST_UnaryUnion(ST_Collect(o."geom")), ${b.epsg}::int), ${TOLERANCE_RESEAU_M}::float8, true) AS "g"
    FROM "projets_voirie_objets" o
   WHERE o."jeuId" = ANY(${b.reseauIds}::text[]) AND o."typeGeom" = 'LIGNE' AND o."id" IN (SELECT p."id" FROM proches p)
   GROUP BY o."jeuId")`;

/** Longueur, en metres, des seules parties lineaires de `x` (UTM), mesuree sur la geographie. */
export const LONGUEUR = (x: Prisma.Sql) => Prisma.sql`COALESCE(ST_Length(ST_Transform(ST_CollectionExtract(${x}, 2), 4326)::geography), 0)`;

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

export interface MesureJeu { jeu: string; chausseeM: number; empriseM: number; croisements: number }

/**
 * Mesures par jeu de reseau : tracé fusionne dans l'UNION des bandes de tous les axes (un carrefour compte une fois). Correctif D4 : la longueur
 * du trace fusionne ENTIER (d'ou le « hors emprise ») n'est plus recalculee ici : c'est `longueurTraceFusionneM` du jeu, mesuree au depot
 * avec la meme definition (`ST_Length(ST_UnaryUnion(ST_Collect(geom))::geography)`, import.service.ts).
 */
export async function mesurerParJeu(tx: Tx, b: Bandes): Promise<MesureJeu[]> {
  const r = await tx.$queryRaw<{ jeu: string; chaussee: number; emprise: number; croisements: number }[]>`
    WITH ${axobj(b)}, ${bandesUnion(b)}, ${proches(b, b.de)}, ${reseau(b)}
    SELECT r."jeu" AS "jeu",
           ${LONGUEUR(Prisma.sql`ST_Intersection(r."g", bn."bc")`)} AS "chaussee",
           ${LONGUEUR(Prisma.sql`ST_Intersection(r."g", bn."be")`)} AS "emprise",
           COALESCE(ST_NumGeometries(ST_CollectionExtract(ST_Intersection(r."g", bn."ax"), 1)), 0)::int AS "croisements"
      FROM res r CROSS JOIN bandes bn`;
  return r.map((x) => ({ jeu: x.jeu, chausseeM: Number(x.chaussee), empriseM: Number(x.emprise), croisements: Number(x.croisements) }));
}

export interface MesureAxeJeu { axeId: string; axe: string; jeu: string; chausseeM: number; empriseM: number; croisements: number }

/** Mesures par axe et par jeu : tracé fusionne du jeu dans la bande de CET axe seul. */
export async function mesurerParAxe(tx: Tx, b: Bandes): Promise<MesureAxeJeu[]> {
  const r = await tx.$queryRaw<{ aid: bigint | string; axe: string; jeu: string; c: number; e: number; x: number }[]>`
    WITH ${axobj(b)}, ${bandesAxe(b)}, ${proches(b, b.de)}, ${reseau(b)}
    SELECT * FROM (
      SELECT a."id"::text AS "aid", a."axe" AS "axe", r."jeu" AS "jeu",
             ${LONGUEUR(Prisma.sql`ST_Intersection(rc."g", a."bc")`)} AS "c",
             ${LONGUEUR(Prisma.sql`ST_Intersection(rc."g", a."be")`)} AS "e",
             COALESCE(ST_NumGeometries(ST_CollectionExtract(ST_Intersection(rc."g", a."g"), 1)), 0)::int AS "x"
        FROM bandes_axe a JOIN res r ON r."g" && a."be"
        -- Correctif D4 : le reseau fusionne est d'abord decoupe a la boite de la bande de l'axe (qui contient la bande et l'axe : resultat identique).
        CROSS JOIN LATERAL (SELECT ST_ClipByBox2D(r."g", Box2D(a."be")) AS "g") rc
    ) m WHERE m."c" > 0 OR m."e" > 0 OR m."x" > 0`;
  return r.map((x) => ({ axeId: String(x.aid), axe: x.axe, jeu: x.jeu, chausseeM: Number(x.c), empriseM: Number(x.e), croisements: Number(x.x) }));
}

export interface MesureAxeObjet {
  axeId: string; axe: string; jeu: string; objetId: string; nom: string | null;
  chausseeM: number; empriseM: number; croisements: number;
}

/**
 * Mesures par axe et par objet BRUT du fichier (non fusionne), plafonnees a `limite` lignes. Pour chaque objet, seuls les morceaux
 * de l'axe situes a moins de la demi-largeur d'emprise entrent dans le calcul (jamais le tampon entier de l'axe) : cout lineaire
 * en nombre d'objets, quelle que soit la longueur de l'axe. Correctif D4 : ces morceaux sont DECOUPES a la boite de l'objet elargie de deux
 * demi-emprises + 1 m (`ST_ClipByBox2D`) avant les tampons : un morceau de 64 sommets leves tous les 100 m fait 6,4 km, et son tampon etait
 * recalcule pour chaque objet. Le point de l'axe le plus proche d'un point de l'objet a moins de la demi-emprise est dans cette boite, a plus
 * d'une demi-emprise de son bord : les intersections avec les bandes sont les memes (au bruit flottant pres), les tampons bien plus petits.
 */
export async function mesurerParObjet(tx: Tx, b: Bandes, limite: number): Promise<MesureAxeObjet[]> {
  const r = await tx.$queryRaw<{ aid: bigint | string; axe: string; jeu: string; oid: bigint | string; nom: string | null; c: number; e: number; x: number }[]>`
    WITH ${axobj(b)}, ${proches(b, b.de)},
    morceaux AS MATERIALIZED (SELECT a."id" AS "aid", a."axe" AS "axe", ST_Subdivide(a."g", ${SOMMETS_PAR_MORCEAU}::int) AS "g" FROM axobj a),
    obj AS MATERIALIZED (
      SELECT o."id" AS "oid", o."jeuId" AS "jeu", o."nom" AS "nom",
             ST_Simplify(ST_Transform(o."geom", ${b.epsg}::int), ${TOLERANCE_RESEAU_M}::float8, true) AS "og"
        FROM "projets_voirie_objets" o
       WHERE o."jeuId" = ANY(${b.reseauIds}::text[]) AND o."typeGeom" = 'LIGNE' AND o."id" IN (SELECT p."id" FROM proches p))
    SELECT * FROM (
      SELECT m."aid"::text AS "aid", m."axe" AS "axe", o."jeu" AS "jeu", o."oid"::text AS "oid", o."nom" AS "nom",
             CASE WHEN ST_DWithin(o."og", m."loc", ${b.dc}::float8)
                  THEN ${LONGUEUR(Prisma.sql`ST_Intersection(o."og", ST_Buffer(m."loc", ${b.dc}::float8, ${QUART_DE_CERCLE}))`)} ELSE 0 END AS "c",
             ${LONGUEUR(Prisma.sql`ST_Intersection(o."og", ST_Buffer(m."loc", ${b.de}::float8, ${QUART_DE_CERCLE}))`)} AS "e",
             COALESCE(ST_NumGeometries(ST_CollectionExtract(ST_Intersection(o."og", m."loc"), 1)), 0)::int AS "x"
        FROM obj o
        CROSS JOIN LATERAL (
          SELECT p."aid", min(p."axe") AS "axe", ST_ClipByBox2D(ST_Collect(p."g"), ST_Expand(Box2D(o."og"), 2 * ${b.de}::float8 + 1)) AS "loc"
            FROM morceaux p
           WHERE p."g" && ST_Expand(o."og", ${b.de}::float8) AND ST_DWithin(p."g", o."og", ${b.de}::float8)
           GROUP BY p."aid") m
    ) q WHERE q."c" > 0 OR q."e" > 0 OR q."x" > 0
    ORDER BY q."axe", q."e" DESC, q."oid"
    LIMIT ${limite}`;
  return r.map((x) => ({
    axeId: String(x.aid), axe: x.axe, jeu: x.jeu, objetId: String(x.oid), nom: x.nom,
    chausseeM: Number(x.c), empriseM: Number(x.e), croisements: Number(x.x),
  }));
}

export interface Volumes { objetsAxes: number; objetsReseau: number; sommetsAxes: number; sommetsReseau: number }

/**
 * COMPTAGE PREALABLE (correctif D4) : objets LINEAIRES et sommets des jeux retenus, axes et reseaux, lus dans les objets eux-memes (jamais dans
 * le compteur `nbObjets` du jeu). Aucun calcul geometrique : `count(*)` et `ST_NPoints` (lecture de l'en-tete de chaque geometrie) ; 0,2 s
 * pour 50 000 objets et 200 000 sommets (banc `projets-voirie-capacite`). Les objets ponctuels et surfaciques n'entrent dans aucun calcul lourd.
 */
export async function volumes(tx: Tx, axesIds: readonly string[], reseauIds: readonly string[]): Promise<Volumes> {
  const r = await tx.$queryRaw<{ oa: number; or: number; sa: number; sr: number }[]>`
    SELECT (count(*) FILTER (WHERE "jeuId" = ANY(${[...axesIds]}::text[])))::float8 AS "oa",
           (count(*) FILTER (WHERE "jeuId" = ANY(${[...reseauIds]}::text[])))::float8 AS "or",
           COALESCE(SUM(ST_NPoints("geom")) FILTER (WHERE "jeuId" = ANY(${[...axesIds]}::text[])), 0)::float8 AS "sa",
           COALESCE(SUM(ST_NPoints("geom")) FILTER (WHERE "jeuId" = ANY(${[...reseauIds]}::text[])), 0)::float8 AS "sr"
      FROM "projets_voirie_objets"
     WHERE "jeuId" = ANY(${[...axesIds, ...reseauIds]}::text[]) AND "typeGeom" = 'LIGNE'`;
  const l = r[0];
  return { objetsAxes: Number(l?.oa ?? 0), objetsReseau: Number(l?.or ?? 0), sommetsAxes: Number(l?.sa ?? 0), sommetsReseau: Number(l?.sr ?? 0) };
}

export interface PointCroisement { jeu: string; lon: number; lat: number; axe: string }

/** Points de croisement (reseau fusionne x axes), avec l'axe le plus proche, plafonnes a `limite`. */
export async function pointsDeCroisement(tx: Tx, b: Bandes, limite: number): Promise<PointCroisement[]> {
  const r = await tx.$queryRaw<{ jeu: string; lon: number; lat: number; axe: string | null }[]>`
    WITH ${axobj(b)}, ${bandesUnion(b)}, ${proches(b, b.de)}, ${reseau(b)},
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
 * Trois couches DISJOINTES du reseau : dans la chaussee, dans l'emprise hors chaussee, hors emprise. Simplifiees (0,25 m pour les deux
 * premieres, 2 m pour la troisieme), coordonnees a 6 decimales. Correctif D4 : la couche « hors emprise » est la partie hors emprise du reseau
 * fusionne des objets voisins (`proches`, simplifiee a 2 m en preservant la topologie), plus les objets eloignes ajoutes tels quels (simplifies
 * a 2 m un par un, NON fusionnes entre eux : c'est une couche d'affichage ; un objet eloigne ne touche aucune bande, la couche reste disjointe
 * des deux autres).
 */
export async function zones(tx: Tx, b: Bandes): Promise<ZonesGeoJson> {
  const r = await tx.$queryRaw<{ zc: string | null; ze: string | null; zh: string | null }[]>`
    WITH ${axobj(b)}, ${bandesUnion(b)}, ${proches(b, b.de)}, ${reseau(b)},
    loin AS MATERIALIZED (
      SELECT ST_Collect(ST_Simplify(ST_Transform(o."geom", ${b.epsg}::int), 2, true)) AS "g"
        FROM "projets_voirie_objets" o
       WHERE o."jeuId" = ANY(${b.reseauIds}::text[]) AND o."typeGeom" = 'LIGNE' AND o."id" NOT IN (SELECT p."id" FROM proches p)),
    pres AS (
      SELECT ST_Collect(ST_CollectionExtract(ST_Intersection(r."g", bn."bc"), 2)) AS "c",
             ST_Collect(ST_CollectionExtract(ST_Difference(ST_Intersection(r."g", bn."be"), bn."bc"), 2)) AS "e",
             ST_Collect(ST_CollectionExtract(ST_Difference(r."g", bn."be"), 2)) AS "h"
        FROM res r CROSS JOIN bandes bn),
    proche_h AS (SELECT CASE WHEN p."h" IS NULL OR ST_IsEmpty(p."h") THEN NULL ELSE ST_SimplifyPreserveTopology(ST_CollectionExtract(p."h", 2), 2) END AS "h" FROM pres p),
    morceaux AS (
      SELECT p."c" AS "c", p."e" AS "e",
             ST_CollectionExtract(CASE WHEN l."g" IS NULL THEN q."h" WHEN q."h" IS NULL THEN l."g" ELSE ST_Collect(q."h", l."g") END, 2) AS "h"
        FROM pres p CROSS JOIN proche_h q CROSS JOIN loin l)
    SELECT CASE WHEN "c" IS NULL OR ST_IsEmpty("c") THEN NULL
                ELSE ST_AsGeoJSON(ST_Transform(ST_SimplifyPreserveTopology(ST_CollectionExtract("c", 2), 0.25), 4326), 6) END AS "zc",
           CASE WHEN "e" IS NULL OR ST_IsEmpty("e") THEN NULL
                ELSE ST_AsGeoJSON(ST_Transform(ST_SimplifyPreserveTopology(ST_CollectionExtract("e", 2), 0.25), 4326), 6) END AS "ze",
           CASE WHEN "h" IS NULL OR ST_IsEmpty("h") THEN NULL ELSE ST_AsGeoJSON(ST_Transform("h", 4326), 6) END AS "zh"
      FROM morceaux`;
  const l = r[0];
  return { chaussee: l?.zc ?? null, emprise: l?.ze ?? null, hors: l?.zh ?? null };
}

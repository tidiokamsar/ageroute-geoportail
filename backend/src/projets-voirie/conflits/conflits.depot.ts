/**
 * ACCES SQL DES DOSSIERS DE CONFLIT (PostGIS). Toutes les requetes sont `$queryRaw` / `$executeRaw` ETIQUETEES : les valeurs (identifiants,
 * SRID, largeurs, tableaux) sont LIEES par le pilote, jamais concatenees (lib/sql-parametre.test.ts interdit la forme non etiquetee).
 *
 * LE CALCUL REUTILISE CELUI DU SOCLE (`analyse.depot.ts`), il ne le duplique pas : memes axes simplifies (`axobj`, 0,1 m), memes tampons
 * (8 segments par quart de cercle), memes morceaux d'axe de 64 sommets, meme simplification des reseaux (0,05 m), meme mesure des
 * longueurs sur la geographie (`LONGUEUR`). La mesure d'un conflit est donc celle de l'analyse indicative pour le meme objet et le meme axe.
 *
 * UN CONFLIT = UNE PARTIE CONNEXE de reseau, pour un axe, un objet et un type :
 *   - INTERSECTION_CHAUSSEE : partie de l'objet dans la bande de chaussee (axe +/- demi-chaussee) ;
 *   - INTERSECTION_EMPRISE  : partie dans l'emprise (axe +/- demi-emprise), HORS chaussee ;
 *   - PROXIMITE             : objet sans aucune partie dans l'emprise, mais a moins de (demi-emprise + tolerance + precision x marge) de l'axe ;
 *                             la partie retenue est celle comprise dans cette bande elargie ;
 *   - TRAVERSEE             : un point ou l'objet coupe l'axe (un point par croisement).
 * Les parties d'un meme objet, d'un meme type et d'un meme axe qui tombent dans la MEME CELLULE de localisation (voir `cellule` du noyau : meme
 * arithmetique, `floor(x / pas + 0.5)`) ne font qu'un dossier : leurs geometries sont reunies, leurs longueurs additionnees.
 * Les objets ponctuels et polygonaux ne sont pas evalues (comme dans l'analyse indicative : seuls les lineaires le sont).
 *
 * COUVERTURE_INSUFFISANTE : un objet d'axe qu'aucun jeu de reseau autorise ne recouvre (l'emprise englobante d'un jeu lineaire doit CONTENIR
 * l'objet). C'est une zone a investiguer, jamais une absence de reseau. Correctif D7 : les objets non couverts d'un meme axe font UN dossier
 * (regroupement par couverture.noyau.ts, geometrie par `geometriesCouverture`).
 *
 * Aucune ecriture dans le referentiel : `troncons` n'est lu que pour `tronconsProches`.
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import { LONGUEUR, QUART_DE_CERCLE, SOMMETS_PAR_MORCEAU, TOLERANCE_RESEAU_M, axobj, proches, type Bandes } from "../analyse.depot";
import { PAS_CELLULE_DEG } from "./types.noyau";

export type TxLecture = Pick<PrismaClient, "$queryRaw">;
export type TxEcriture = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;

/** Longueur minimale (m) d'une partie de reseau pour faire un dossier : en dessous, c'est un eclat de decoupe sans portee. */
export const LONGUEUR_MIN_PIECE_M = 0.01;

export interface LigneCandidat {
  type: "INTERSECTION_CHAUSSEE" | "INTERSECTION_EMPRISE" | "PROXIMITE" | "TRAVERSEE";
  axe: string;
  jeu: string;
  oid: string;
  nom: string | null;
  emp: string;
  len: number;
  dmin: number;
  nx: number;
  lon: number;
  lat: number;
  /** Cellule de localisation (entiers), calculee par la base avec la meme arithmetique que le noyau. */
  cx: number;
  cy: number;
  g: string;
}

export interface JeuTolerance { jeu: string; tol: number }

/**
 * Parties de reseau en conflit avec les axes, triees de facon deterministe, plafonnees a `limite` lignes (le plafond de l'analyse + 1,
 * pour detecter le depassement).
 */
export async function candidatsLineaires(tx: TxLecture, b: Bandes, jeuxTol: readonly JeuTolerance[], limite: number): Promise<LigneCandidat[]> {
  if (jeuxTol.length === 0 || b.axesIds.length === 0) return [];
  const jeuIds = jeuxTol.map((j) => j.jeu);
  const tols = jeuxTol.map((j) => j.tol);
  // Correctif D4 : seuls les objets a moins de demi-emprise + tolerance (la plus grande des jeux) d'un axe sont transformes et examines
  // (prefiltre par index, `proches` d'analyse.depot.ts) ; les autres n'auraient produit aucune ligne.
  const portee = b.de + Math.max(0, ...tols);
  const r = await tx.$queryRaw<(Omit<LigneCandidat, "oid"> & { oid: bigint | string })[]>`
    WITH ${axobj(b)}, ${proches(b, portee)},
    morceaux AS MATERIALIZED (SELECT a."id" AS "aid", a."axe" AS "axe", ST_Subdivide(a."g", ${SOMMETS_PAR_MORCEAU}::int) AS "g" FROM axobj a),
    params AS MATERIALIZED (SELECT p."jeu" AS "jeu", p."tol" AS "tol" FROM unnest(${jeuIds}::text[], ${tols}::float8[]) AS p("jeu", "tol")),
    obj AS MATERIALIZED (
      SELECT o."id" AS "oid", o."jeuId" AS "jeu", o."nom" AS "nom", o."empreinte" AS "emp", p."tol" AS "tol",
             ST_Simplify(ST_Transform(o."geom", ${b.epsg}::int), ${TOLERANCE_RESEAU_M}::float8, true) AS "og"
        FROM "projets_voirie_objets" o JOIN params p ON p."jeu" = o."jeuId"
       WHERE o."typeGeom" = 'LIGNE' AND o."id" IN (SELECT x."id" FROM proches x)),
    paires AS MATERIALIZED (
      SELECT m."aid" AS "aid", m."axe" AS "axe", m."loc" AS "loc", o."oid" AS "oid", o."jeu" AS "jeu", o."nom" AS "nom", o."emp" AS "emp", o."og" AS "og", o."tol" AS "tol"
        FROM obj o
        CROSS JOIN LATERAL (
          -- Correctif D4 : morceaux decoupes a la boite de l'objet elargie de 2 x (demi-emprise + tolerance) + 1 m (voir mesurerParObjet du socle).
          SELECT p."aid" AS "aid", min(p."axe") AS "axe", ST_ClipByBox2D(ST_Collect(p."g"), ST_Expand(Box2D(o."og"), 2 * (${b.de}::float8 + o."tol") + 1)) AS "loc"
            FROM morceaux p
           WHERE p."g" && ST_Expand(o."og", ${b.de}::float8 + o."tol") AND ST_DWithin(p."g", o."og", ${b.de}::float8 + o."tol")
           GROUP BY p."aid") m),
    zones AS MATERIALIZED (
      SELECT q."aid", q."axe", q."loc", q."oid", q."jeu", q."nom", q."emp",
             CASE WHEN ST_DWithin(q."og", q."loc", ${b.dc}::float8)
                  THEN ST_CollectionExtract(ST_Intersection(q."og", ST_Buffer(q."loc", ${b.dc}::float8, ${QUART_DE_CERCLE})), 2) END AS "gc",
             CASE WHEN ST_DWithin(q."og", q."loc", ${b.de}::float8)
                  THEN ST_CollectionExtract(ST_Difference(ST_Intersection(q."og", ST_Buffer(q."loc", ${b.de}::float8, ${QUART_DE_CERCLE})), ST_Buffer(q."loc", ${b.dc}::float8, ${QUART_DE_CERCLE})), 2) END AS "ge",
             CASE WHEN NOT ST_DWithin(q."og", q."loc", ${b.de}::float8)
                  THEN ST_CollectionExtract(ST_Intersection(q."og", ST_Buffer(q."loc", ${b.de}::float8 + q."tol", ${QUART_DE_CERCLE})), 2) END AS "gp",
             ST_CollectionExtract(ST_Intersection(q."og", q."loc"), 1) AS "gx"
        FROM paires q),
    pieces AS MATERIALIZED (
      SELECT 'INTERSECTION_CHAUSSEE' AS "type", z."axe", z."jeu", z."oid", z."nom", z."emp", z."loc", (ST_Dump(ST_LineMerge(z."gc"))).geom AS "pg"
        FROM zones z WHERE z."gc" IS NOT NULL AND NOT ST_IsEmpty(z."gc")
      UNION ALL
      SELECT 'INTERSECTION_EMPRISE', z."axe", z."jeu", z."oid", z."nom", z."emp", z."loc", (ST_Dump(ST_LineMerge(z."ge"))).geom
        FROM zones z WHERE z."ge" IS NOT NULL AND NOT ST_IsEmpty(z."ge")
      UNION ALL
      SELECT 'PROXIMITE', z."axe", z."jeu", z."oid", z."nom", z."emp", z."loc", (ST_Dump(ST_LineMerge(z."gp"))).geom
        FROM zones z WHERE z."gp" IS NOT NULL AND NOT ST_IsEmpty(z."gp")
      UNION ALL
      SELECT 'TRAVERSEE', z."axe", z."jeu", z."oid", z."nom", z."emp", z."loc", (ST_Dump(ST_UnaryUnion(z."gx"))).geom
        FROM zones z WHERE z."gx" IS NOT NULL AND NOT ST_IsEmpty(z."gx")),
    mesures AS MATERIALIZED (
      SELECT p."type" AS "type", p."axe" AS "axe", p."jeu" AS "jeu", p."oid" AS "ob", p."nom" AS "nom", p."emp" AS "emp", p."pg" AS "pg",
             CASE WHEN p."type" = 'TRAVERSEE' THEN 0 ELSE ${LONGUEUR(Prisma.sql`p."pg"`)} END AS "len",
             ST_Distance(p."pg", p."loc") AS "dmin",
             CASE WHEN p."type" = 'TRAVERSEE' THEN 1
                  ELSE COALESCE(ST_NumGeometries(ST_CollectionExtract(ST_Intersection(p."pg", p."loc"), 1)), 0) END AS "nx",
             r."r" AS "rep",
             floor(ST_X(ST_Transform(r."r", 4326)) / ${PAS_CELLULE_DEG}::float8 + 0.5)::int AS "cx",
             floor(ST_Y(ST_Transform(r."r", 4326)) / ${PAS_CELLULE_DEG}::float8 + 0.5)::int AS "cy"
        FROM pieces p
        CROSS JOIN LATERAL (SELECT CASE WHEN GeometryType(p."pg") = 'LINESTRING' THEN ST_LineInterpolatePoint(p."pg", 0.5) ELSE ST_PointOnSurface(p."pg") END AS "r") r),
    groupes AS (
      SELECT m."type" AS "type", m."axe" AS "axe", m."jeu" AS "jeu", m."ob" AS "ob", m."nom" AS "nom", m."emp" AS "emp", m."cx" AS "cx", m."cy" AS "cy",
             CASE WHEN count(*) = 1 THEN (array_agg(m."pg" ORDER BY ST_X(m."rep"), ST_Y(m."rep")))[1]
                  ELSE ST_Collect(m."pg" ORDER BY ST_X(m."rep"), ST_Y(m."rep")) END AS "pg", sum(m."len") AS "len", min(m."dmin") AS "dmin", sum(m."nx")::int AS "nx",
             (array_agg(m."rep" ORDER BY ST_X(m."rep"), ST_Y(m."rep")))[1] AS "rep"
        FROM mesures m
       WHERE m."type" = 'TRAVERSEE' OR m."len" >= ${LONGUEUR_MIN_PIECE_M}::float8
       GROUP BY m."type", m."axe", m."jeu", m."ob", m."nom", m."emp", m."cx", m."cy")
    SELECT g."type" AS "type", g."axe" AS "axe", g."jeu" AS "jeu", g."ob"::text AS "oid", g."nom" AS "nom", g."emp" AS "emp",
           g."len"::float8 AS "len", g."dmin"::float8 AS "dmin", g."nx"::int AS "nx",
           ST_X(ST_Transform(g."rep", 4326)) AS "lon", ST_Y(ST_Transform(g."rep", 4326)) AS "lat", g."cx" AS "cx", g."cy" AS "cy",
           encode(ST_AsEWKB(ST_Transform(g."pg", 4326)), 'hex') AS "g"
      FROM groupes g
     ORDER BY g."axe", g."type", g."ob", g."cx", g."cy"
     LIMIT ${limite}`;
  return r.map((x) => ({
    type: x.type, axe: x.axe, jeu: x.jeu, oid: String(x.oid), nom: x.nom, emp: x.emp,
    len: Number(x.len), dmin: Number(x.dmin), nx: Number(x.nx), lon: Number(x.lon), lat: Number(x.lat), cx: Number(x.cx), cy: Number(x.cy), g: x.g,
  }));
}

export interface LigneCouverture { aid: string; jeu: string; ordre: number; nom: string | null; identifiant: string | null; axe: string; len: number; nbCouvrants: number }

/**
 * Tous les objets lineaires des jeux d'axes, avec le nombre de jeux de reseau LINEAIRES autorises dont l'emprise englobante contient l'objet.
 * Un objet sans jeu couvrant est une zone a investiguer. Correctif D7 : rend aussi l'ordre, le nom brut et la valeur de la colonne `identifiant`
 * du mapping de son jeu (`colonnes` : jeu d'axes -> colonne, absente = aucune), pour regrouper les morceaux par axe (couverture.noyau.ts) ;
 * la geometrie n'est plus lue ici, mais seulement pour les axes non couverts (`geometriesCouverture`).
 */
export async function couvertureDesAxes(tx: TxLecture, axesIds: readonly string[], reseauIds: readonly string[], colonnes: ReadonlyMap<string, string | null> = new Map()): Promise<LigneCouverture[]> {
  if (axesIds.length === 0) return [];
  const r = await tx.$queryRaw<{ aid: bigint | string; jeu: string; ordre: number; nom: string | null; ident: string | null; axe: string; len: number; nb: number }[]>`
    WITH enveloppes AS MATERIALIZED (
      SELECT o."jeuId" AS "jeu", ST_SetSRID(ST_Extent(o."geom")::geometry, 4326) AS "env"
        FROM "projets_voirie_objets" o
       WHERE o."jeuId" = ANY(${[...reseauIds]}::text[]) AND o."typeGeom" = 'LIGNE'
       GROUP BY o."jeuId"),
    colonnes AS MATERIALIZED (SELECT c."jeu" AS "jeu", NULLIF(c."col", '') AS "col" FROM unnest(${[...axesIds]}::text[], ${axesIds.map((j) => colonnes.get(j) ?? "")}::text[]) AS c("jeu", "col"))
    SELECT o."id"::text AS "aid", o."jeuId" AS "jeu", o."ordre" AS "ordre", o."nom" AS "nom",
           CASE WHEN k."col" IS NULL THEN NULL ELSE o."attributs" ->> k."col" END AS "ident",
           COALESCE(o."nom", 'Axe ' || (o."ordre" + 1)::text) AS "axe",
           ST_Length(o."geom"::geography) AS "len",
           (SELECT count(*)::int FROM enveloppes e WHERE ST_Covers(e."env", o."geom")) AS "nb"
      FROM "projets_voirie_objets" o
      LEFT JOIN colonnes k ON k."jeu" = o."jeuId"
     WHERE o."jeuId" = ANY(${[...axesIds]}::text[]) AND o."typeGeom" = 'LIGNE'
     ORDER BY "axe", o."id"`;
  return r.map((x) => ({ aid: String(x.aid), jeu: x.jeu, ordre: Number(x.ordre), nom: x.nom, identifiant: x.ident, axe: x.axe, len: Number(x.len), nbCouvrants: Number(x.nb) }));
}

export interface GeometrieCouverture { len: number; lon: number; lat: number; g: string }

/**
 * Correctif D7 : geometrie de chaque dossier de couverture, a partir des identifiants des morceaux NON couverts de son axe (`groupes[i]`).
 * Un seul morceau : sa geometrie telle quelle, sa longueur et le milieu de la ligne (exactement le calcul d'avant le regroupement, donc la meme
 * mesure et la meme cle pour un objet d'axe sans nom). Plusieurs : leur REUNION (`ST_UnaryUnion`, puis `ST_LineMerge` des morceaux bout a bout),
 * mesuree sur la geographie (une portion commune a deux morceaux ne compte qu'une fois), et un point de la reunion. Resultat dans l'ordre des groupes.
 */
export async function geometriesCouverture(tx: TxLecture, groupes: readonly (readonly string[])[]): Promise<GeometrieCouverture[]> {
  if (groupes.length === 0) return [];
  const idx = groupes.flatMap((g, i) => g.map(() => i));
  const ids = groupes.flatMap((g) => [...g]);
  const r = await tx.$queryRaw<{ i: number; len: number; lon: number; lat: number; g: string }[]>`
    WITH m AS MATERIALIZED (
      SELECT v."i" AS "i", o."geom" AS "geom"
        FROM unnest(${idx}::int[], ${ids}::bigint[]) AS v("i", "oid")
        JOIN "projets_voirie_objets" o ON o."id" = v."oid"),
    u AS MATERIALIZED (
      SELECT m."i" AS "i",
             CASE WHEN count(*) = 1 THEN (array_agg(m."geom"))[1] ELSE ST_LineMerge(ST_UnaryUnion(ST_Collect(m."geom"))) END AS "geom"
        FROM m GROUP BY m."i")
    SELECT u."i" AS "i", ST_Length(u."geom"::geography) AS "len", ST_X(rp."p") AS "lon", ST_Y(rp."p") AS "lat", encode(ST_AsEWKB(u."geom"), 'hex') AS "g"
      FROM u
      CROSS JOIN LATERAL (SELECT CASE WHEN GeometryType(u."geom") = 'LINESTRING' THEN ST_LineInterpolatePoint(u."geom", 0.5) ELSE ST_PointOnSurface(u."geom") END AS "p") rp
     ORDER BY u."i"`;
  const parI = new Map(r.map((x) => [Number(x.i), { len: Number(x.len), lon: Number(x.lon), lat: Number(x.lat), g: x.g }] as const));
  return groupes.map((_, i) => {
    const x = parI.get(i);
    if (!x) throw new Error("geometriesCouverture : groupe sans geometrie");
    return x;
  });
}

// ------------------------------------------------------------------------------------------------
// Ecriture (conflits). Les tableaux sont lies ; les valeurs absentes sont des textes vides (NULLIF), jamais des NULL dans un tableau.
// ------------------------------------------------------------------------------------------------

export interface LigneNouveauConflit {
  id: string; cle: string; type: string; axe: string; jeuReseauId: string; jeuAxesId: string; objetId: string; concessionnaireId: string;
  mesure: string; geomHex: string; statut: string; classePrecision: string;
}

/** Cree les conflits (premiere et derniere analyse = `analyseId`). `verticalEvalue` reste faux : aucune donnee verticale dans ce lot. */
export async function insererConflits(tx: TxEcriture, projetId: string, analyseId: string, l: readonly LigneNouveauConflit[]): Promise<number> {
  if (l.length === 0) return 0;
  return tx.$executeRaw`
    INSERT INTO "conflits_projet" ("id", "projetId", "cle", "type", "axe", "jeuReseauId", "jeuAxesId", "objetId", "concessionnaireId", "mesure", "geom", "statut", "classePrecision", "verticalEvalue", "premiereAnalyseId", "derniereAnalyseId", "aReexaminer", "motifReexamen", "tronconsProches")
    SELECT v."id", ${projetId}, v."cle", v."type"::"TypeConflit", v."axe", NULLIF(v."jeu", ''), NULLIF(v."jeuaxes", ''), NULLIF(v."objet", '')::bigint, NULLIF(v."conc", ''), v."mesure"::jsonb,
           ST_GeomFromEWKB(decode(v."geom", 'hex')), v."statut"::"StatutConflit", NULLIF(v."classe", '')::"ClassePrecision", false, ${analyseId}, ${analyseId}, false, NULL, '[]'::jsonb
      FROM unnest(${l.map((x) => x.id)}::text[], ${l.map((x) => x.cle)}::text[], ${l.map((x) => x.type)}::text[], ${l.map((x) => x.axe)}::text[],
                  ${l.map((x) => x.jeuReseauId)}::text[], ${l.map((x) => x.jeuAxesId)}::text[], ${l.map((x) => x.objetId)}::text[], ${l.map((x) => x.concessionnaireId)}::text[],
                  ${l.map((x) => x.mesure)}::text[], ${l.map((x) => x.geomHex)}::text[], ${l.map((x) => x.statut)}::text[], ${l.map((x) => x.classePrecision)}::text[])
           AS v("id", "cle", "type", "axe", "jeu", "jeuaxes", "objet", "conc", "mesure", "geom", "statut", "classe")`;
}

export interface LigneConflitRetrouve {
  id: string; jeuReseauId: string; jeuAxesId: string; objetId: string; concessionnaireId: string; mesure: string; geomHex: string; classePrecision: string;
  aReexaminer: boolean; motifReexamen: string;
}

/**
 * Met a jour un conflit retrouve : derniere analyse, mesure, geometrie courante, objet et jeu courants, classe copiee, drapeau a reexaminer.
 * Ne touche JAMAIS statut, risque, responsable, echeance ni action proposee (le declencheur de la base le refuserait de toute facon).
 * `updatedAt` ne change QUE si la mesure change : un recalcul qui ne change rien n est pas une mise a jour du dossier (revue RC-3, m11).
 */
export async function majConflitsRetrouves(tx: TxEcriture, analyseId: string, l: readonly LigneConflitRetrouve[]): Promise<number> {
  if (l.length === 0) return 0;
  return tx.$executeRaw`
    UPDATE "conflits_projet" c
       SET "derniereAnalyseId" = ${analyseId}, "mesure" = v."mesure"::jsonb, "geom" = ST_GeomFromEWKB(decode(v."geom", 'hex')),
           "jeuReseauId" = NULLIF(v."jeu", ''), "jeuAxesId" = NULLIF(v."jeuaxes", ''), "objetId" = NULLIF(v."objet", '')::bigint, "concessionnaireId" = NULLIF(v."conc", ''),
           "classePrecision" = NULLIF(v."classe", '')::"ClassePrecision", "aReexaminer" = v."are", "motifReexamen" = NULLIF(v."motif", '')::"MotifReexamenConflit",
           "updatedAt" = CASE WHEN c."mesure" IS DISTINCT FROM v."mesure"::jsonb THEN CURRENT_TIMESTAMP ELSE c."updatedAt" END
      FROM unnest(${l.map((x) => x.id)}::text[], ${l.map((x) => x.jeuReseauId)}::text[], ${l.map((x) => x.jeuAxesId)}::text[], ${l.map((x) => x.objetId)}::text[], ${l.map((x) => x.concessionnaireId)}::text[],
                  ${l.map((x) => x.mesure)}::text[], ${l.map((x) => x.geomHex)}::text[], ${l.map((x) => x.classePrecision)}::text[],
                  ${l.map((x) => x.aReexaminer)}::boolean[], ${l.map((x) => x.motifReexamen)}::text[])
           AS v("id", "jeu", "jeuaxes", "objet", "conc", "mesure", "geom", "classe", "are", "motif")
     WHERE c."id" = v."id"`;
}

/** Marque a reexaminer des conflits non retrouves (NON_RETROUVE). Rien d'autre ne change (pas meme `updatedAt` : la mesure n'a pas change). */
export async function marquerNonRetrouves(tx: TxEcriture, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  return tx.$executeRaw`
    UPDATE "conflits_projet" SET "aReexaminer" = true, "motifReexamen" = 'NON_RETROUVE'::"MotifReexamenConflit"
     WHERE "id" = ANY(${[...ids]}::text[])`;
}

/**
 * Troncons du referentiel a moins de la demi-largeur d emprise de chaque conflit : code et nom, au plus 10 par conflit, du plus proche
 * au plus eloigne. LECTURE SEULE de `troncons` ; seule la colonne `tronconsProches` du conflit est ecrite, et SEULEMENT si elle differe de
 * la valeur calculee (un dossier clos n est pas reecrit pour rien : revue RC-3, m11). Rend le nombre de lignes reellement reecrites.
 */
export async function majTronconsProches(tx: TxEcriture, ids: readonly string[], demiEmpriseM: number): Promise<number> {
  if (ids.length === 0) return 0;
  const deg = demiEmpriseM * 1.2e-5;
  return tx.$executeRaw`
    UPDATE "conflits_projet" c
       SET "tronconsProches" = n."proches"
      FROM (
        SELECT k."id" AS "id", COALESCE((
          SELECT jsonb_agg(jsonb_build_object('code', q."code", 'nom', q."nom") ORDER BY q."d", q."code")
            FROM (SELECT t."code" AS "code", t."nom" AS "nom", ST_Distance(t."geom"::geography, k."geom"::geography) AS "d"
                    FROM "troncons" t
                   WHERE t."deletedAt" IS NULL AND t."geom" IS NOT NULL
                     AND t."geom" && ST_Expand(k."geom", ${deg}::float8)
                     AND ST_DWithin(t."geom"::geography, k."geom"::geography, ${demiEmpriseM}::float8)
                   ORDER BY "d", t."code" LIMIT 10) q), '[]'::jsonb) AS "proches"
          FROM "conflits_projet" k WHERE k."id" = ANY(${[...ids]}::text[])) n
     WHERE c."id" = n."id" AND c."tronconsProches" IS DISTINCT FROM n."proches"`;
}

/** Nombre de comptes habilites a decider sur ce projet : ADMIN ou GESTIONNAIRE actifs, avec la cle de module, dans le perimetre du projet. */
export async function compterComptesHabilites(tx: TxLecture, regionId: number | null): Promise<number> {
  const r = await tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS "n" FROM "users" u
     WHERE u."actif" = true AND u."role" IN ('ADMIN', 'GESTIONNAIRE')
       AND (u."role" = 'ADMIN' OR 'projets-voirie' = ANY(u."modulesAutorises"))
       AND (u."role" = 'ADMIN'
            OR NOT EXISTS (SELECT 1 FROM "perimetres_comptes" pc WHERE pc."userId" = u."id")
            OR (${regionId}::int IS NOT NULL AND EXISTS (SELECT 1 FROM "perimetres_comptes" pc WHERE pc."userId" = u."id" AND pc."regionId" = ${regionId}::int)))`;
  return Number(r[0]?.n ?? 0);
}

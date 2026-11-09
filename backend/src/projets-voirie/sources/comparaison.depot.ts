/**
 * ACCES SQL DE LA COMPARAISON ENTRE SOURCES (PostGIS, lot S1). Toutes les requetes sont `$queryRaw` / `$executeRaw` ETIQUETEES : les valeurs
 * (identifiants, SRID, rayons, tableaux) sont LIEES par le pilote, jamais concatenees (lib/sql-parametre.test.ts interdit la forme non etiquetee).
 *
 * GEOMETRIE : les objets sont stockes en WGS 84 ; l appariement se fait en metres dans la projection UTM choisie comme pour l analyse 2D
 * (`epsgPourLongitude`), geometries simplifiees a 0,05 m comme les reseaux du socle. Les longueurs d un couple (A, B, recouvrement) sont toutes
 * mesurees dans le MEME plan, pour que « hors corridor » ne soit jamais un artefact de deux methodes de mesure.
 *
 * AUCUNE geometrie n est rendue a l API ; AUCUNE geometrie n est modifiee ni fusionnee : les objets des deux sources ne sont que LUS.
 * Les ecritures (resultats) ne portent que des identifiants, des noms, des precisions et des mesures.
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import { QUART_DE_CERCLE, TOLERANCE_RESEAU_M } from "../analyse.depot";
import type { ResultatCalcule } from "./classification-sources.noyau";

export type TxLecture = Pick<PrismaClient, "$queryRaw">;
export type TxEcriture = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;

/** Valeur liee qui tient lieu de precision INCONNUE dans un tableau (les tableaux lies ne portent pas de NULL) ; `NULLIF` la retire cote base. */
export const PRECISION_INCONNUE = -1;

export interface LigneObjetSource {
  id: string; nom: string | null; empreinte: string; typeGeom: string;
  /** Precision et classe DECLAREES par le descripteur B1 (nulles sans descripteur ou sans declaration). */
  precisionObjetM: number | null; classeObjet: string | null;
}

/** Objets d un jeu avec ce que leur descripteur declare (lecture seule). Lignes et autres types confondus : l appelant compte les non lineaires. */
export async function objetsDuJeu(tx: TxLecture, jeuId: string): Promise<LigneObjetSource[]> {
  const r = await tx.$queryRaw<{ id: string; nom: string | null; empreinte: string; typeGeom: string; po: number | null; co: string | null }[]>`
    SELECT o."id"::text AS "id", o."nom" AS "nom", o."empreinte" AS "empreinte", o."typeGeom"::text AS "typeGeom",
           d."precisionHorizontaleM"::float8 AS "po", d."classePrecision"::text AS "co"
      FROM "projets_voirie_objets" o
      LEFT JOIN "reseau_objets_descripteurs" d ON d."objetId" = o."id"
     WHERE o."jeuId" = ${jeuId}
     ORDER BY o."id"`;
  return r.map((x) => ({ id: String(x.id), nom: x.nom, empreinte: x.empreinte, typeGeom: x.typeGeom, precisionObjetM: x.po === null ? null : Number(x.po), classeObjet: x.co }));
}

/** Nombre de sommets des objets lineaires des deux jeux : refus en amont d une comparaison demesuree (meme plafond que l analyse). */
export async function sommetsLineaires(tx: TxLecture, jeuIds: readonly string[]): Promise<number> {
  const r = await tx.$queryRaw<{ n: number }[]>`
    SELECT COALESCE(SUM(ST_NPoints("geom")), 0)::float8 AS "n" FROM "projets_voirie_objets" WHERE "jeuId" = ANY(${[...jeuIds]}::text[]) AND "typeGeom" = 'LIGNE'`;
  return Number(r[0]?.n ?? 0);
}

export interface PrecisionObjet { id: string; precisionM: number | null }

export interface DemandeAppariement {
  epsg: number;
  jeuAId: string;
  jeuBId: string;
  /** Precisions retenues par objet (noyau regle-rapprochement) ; un objet absent de la liste est traite comme inconnu. */
  precisionsA: readonly PrecisionObjet[];
  precisionsB: readonly PrecisionObjet[];
  margeM: number;
  rayonAppariementM: number;
}

export interface LigneAppariement {
  aid: string;
  /** Candidat retenu ; nul quand aucun objet de B n est a moins du rayon d appariement. */
  bid: string | null;
  corridorM: number | null;
  hausdorffM: number | null;
  distanceMinM: number | null;
  /** Longueur de A dans le tampon de B (rayon : le corridor, ou le rayon d appariement si le corridor est inconnu). */
  longueurRecouvrementM: number | null;
  /** Longueur plane (UTM) de A et de B, mesurees comme le recouvrement. */
  longueurAM: number;
  longueurBM: number | null;
}

/**
 * Pour chaque objet LINEAIRE de A : le candidat de B retenu et ses mesures. Candidats : objets lineaires de B a moins du rayon (`ST_DWithin`, index
 * GiST par `&&`) ; retenu : la plus grande longueur de A dans le tampon de B, puis la distance de Hausdorff minimale, puis l identifiant minimal.
 * Le corridor d un couple est `GREATEST(pA, pB) + marge`, nul des qu une precision manque (aucune mesure de divergence n est alors retenue par
 * le noyau, mais la longueur dans le tampon du rayon sert encore a choisir le candidat).
 */
export async function apparier(tx: TxLecture, d: DemandeAppariement): Promise<LigneAppariement[]> {
  const idsA = d.precisionsA.map((p) => p.id);
  const precA = d.precisionsA.map((p) => (p.precisionM === null ? PRECISION_INCONNUE : p.precisionM));
  const idsB = d.precisionsB.map((p) => p.id);
  const precB = d.precisionsB.map((p) => (p.precisionM === null ? PRECISION_INCONNUE : p.precisionM));
  const r = await tx.$queryRaw<{ aid: string; bid: string | null; corr: number | null; hd: number | null; dmin: number | null; rec: number | null; la: number; lb: number | null }[]>`
    WITH pa AS MATERIALIZED (SELECT t."id", NULLIF(t."prec", ${PRECISION_INCONNUE}::float8) AS "prec" FROM unnest(${idsA}::bigint[], ${precA}::float8[]) AS t("id", "prec")),
    pb AS MATERIALIZED (SELECT t."id", NULLIF(t."prec", ${PRECISION_INCONNUE}::float8) AS "prec" FROM unnest(${idsB}::bigint[], ${precB}::float8[]) AS t("id", "prec")),
    oa AS MATERIALIZED (
      SELECT o."id" AS "id", o."geom" AS "geom", ST_Simplify(ST_Transform(o."geom", ${d.epsg}::int), ${TOLERANCE_RESEAU_M}::float8, true) AS "g", p."prec" AS "prec"
        FROM "projets_voirie_objets" o JOIN pa p ON p."id" = o."id"
       WHERE o."jeuId" = ${d.jeuAId} AND o."typeGeom" = 'LIGNE'),
    ob AS MATERIALIZED (
      SELECT o."id" AS "id", o."geom" AS "geom", ST_Simplify(ST_Transform(o."geom", ${d.epsg}::int), ${TOLERANCE_RESEAU_M}::float8, true) AS "g", p."prec" AS "prec"
        FROM "projets_voirie_objets" o JOIN pb p ON p."id" = o."id"
       WHERE o."jeuId" = ${d.jeuBId} AND o."typeGeom" = 'LIGNE'),
    cand AS MATERIALIZED (
      SELECT a."id" AS "aid", b."id" AS "bid", a."g" AS "ag", b."g" AS "bg",
             CASE WHEN a."prec" IS NOT NULL AND b."prec" IS NOT NULL THEN GREATEST(a."prec", b."prec") + ${d.margeM}::float8 END AS "corr"
        FROM oa a
        JOIN ob b ON b."geom" && ST_Expand(a."geom", ${d.rayonAppariementM}::float8 / 100000.0) AND ST_DWithin(a."g", b."g", ${d.rayonAppariementM}::float8)),
    mes AS (
      SELECT c."aid", c."bid", c."corr",
             ST_HausdorffDistance(c."ag", c."bg") AS "hd", ST_Distance(c."ag", c."bg") AS "dmin",
             ST_Length(ST_Intersection(c."ag", ST_Buffer(c."bg", COALESCE(c."corr", ${d.rayonAppariementM}::float8), ${QUART_DE_CERCLE}))) AS "rec",
             ST_Length(c."bg") AS "lb"
        FROM cand c),
    cls AS (SELECT m.*, row_number() OVER (PARTITION BY m."aid" ORDER BY m."rec" DESC, m."hd" ASC, m."bid" ASC) AS "rg" FROM mes m)
    SELECT a."id"::text AS "aid", c."bid"::text AS "bid", c."corr"::float8 AS "corr", c."hd"::float8 AS "hd", c."dmin"::float8 AS "dmin", c."rec"::float8 AS "rec",
           ST_Length(a."g")::float8 AS "la", c."lb"::float8 AS "lb"
      FROM oa a
      LEFT JOIN cls c ON c."aid" = a."id" AND c."rg" = 1
     ORDER BY a."id"`;
  return r.map((x) => ({
    aid: String(x.aid), bid: x.bid === null ? null : String(x.bid), corridorM: x.corr === null ? null : Number(x.corr), hausdorffM: x.hd === null ? null : Number(x.hd),
    distanceMinM: x.dmin === null ? null : Number(x.dmin), longueurRecouvrementM: x.rec === null ? null : Number(x.rec), longueurAM: Number(x.la), longueurBM: x.lb === null ? null : Number(x.lb),
  }));
}

/** Longueur plane (UTM) de chaque objet lineaire d un jeu : pour les objets de B sans correspondance (jamais mesures par `apparier`). */
export async function longueursPlanes(tx: TxLecture, jeuId: string, epsg: number): Promise<Map<string, number>> {
  const r = await tx.$queryRaw<{ id: string; l: number }[]>`
    SELECT o."id"::text AS "id", ST_Length(ST_Simplify(ST_Transform(o."geom", ${epsg}::int), ${TOLERANCE_RESEAU_M}::float8, true))::float8 AS "l"
      FROM "projets_voirie_objets" o WHERE o."jeuId" = ${jeuId} AND o."typeGeom" = 'LIGNE'`;
  return new Map(r.map((x) => [String(x.id), Number(x.l)]));
}

// ------------------------------------------------------------------------------------------------
// Ecriture des resultats (ajout seul) : tableaux lies, valeurs absentes en textes vides (NULLIF), jamais de NULL dans un tableau
// ------------------------------------------------------------------------------------------------

const vide = (v: string | number | null) => (v === null ? "" : String(v));

export async function insererResultats(tx: TxEcriture, comparaisonId: string, projetId: string, lot: readonly (ResultatCalcule & { id: string })[]): Promise<number> {
  if (lot.length === 0) return 0;
  return tx.$executeRaw`
    INSERT INTO "comparaisons_sources_resultats" ("id", "comparaisonId", "projetId", "ordre", "cle", "statut", "objetAId", "objetBId", "nomA", "nomB", "precisionAM", "precisionBM", "origineA", "origineB", "corridorM", "mesure")
    SELECT v."id", ${comparaisonId}, ${projetId}, v."ordre", v."cle", v."statut"::"StatutResultatComparaison", NULLIF(v."oa", '')::bigint, NULLIF(v."ob", '')::bigint,
           NULLIF(v."na", ''), NULLIF(v."nb", ''), NULLIF(v."pa", '')::numeric, NULLIF(v."pb", '')::numeric, v."oria", v."orib", NULLIF(v."corr", '')::numeric, NULLIF(v."mes", '')::jsonb
      FROM unnest(${lot.map((x) => x.id)}::text[], ${lot.map((x) => x.ordre)}::int[], ${lot.map((x) => x.cle)}::text[], ${lot.map((x) => x.statut)}::text[],
                  ${lot.map((x) => vide(x.objetAId))}::text[], ${lot.map((x) => vide(x.objetBId))}::text[], ${lot.map((x) => vide(x.nomA))}::text[], ${lot.map((x) => vide(x.nomB))}::text[],
                  ${lot.map((x) => vide(x.precisionAM))}::text[], ${lot.map((x) => vide(x.precisionBM))}::text[], ${lot.map((x) => x.origineA)}::text[], ${lot.map((x) => x.origineB)}::text[],
                  ${lot.map((x) => vide(x.corridorM))}::text[], ${lot.map((x) => (x.mesure === null ? "" : JSON.stringify(x.mesure)))}::text[])
           AS v("id", "ordre", "cle", "statut", "oa", "ob", "na", "nb", "pa", "pb", "oria", "orib", "corr", "mes")`;
}

// ------------------------------------------------------------------------------------------------
// Dossier de conflit DIVERGENCE_SOURCES (extension minimale de RC-3) : ecriture en SQL brut (geometrie Unsupported), geometrie de l objet A copiee
// ------------------------------------------------------------------------------------------------

export interface PointMilieu { lon: number; lat: number; geomHex: string }

/** Geometrie EWKB (WGS 84) et milieu d un objet : la geometrie du dossier est une COPIE de celle de l objet A, jamais une fusion. */
export async function geometrieObjet(tx: TxLecture, objetId: string): Promise<PointMilieu | null> {
  const r = await tx.$queryRaw<{ g: string; lon: number; lat: number }[]>`
    SELECT encode(ST_AsEWKB(o."geom"), 'hex') AS "g",
           ST_X(CASE WHEN GeometryType(o."geom") = 'LINESTRING' THEN ST_LineInterpolatePoint(o."geom", 0.5) ELSE ST_PointOnSurface(o."geom") END) AS "lon",
           ST_Y(CASE WHEN GeometryType(o."geom") = 'LINESTRING' THEN ST_LineInterpolatePoint(o."geom", 0.5) ELSE ST_PointOnSurface(o."geom") END) AS "lat"
      FROM "projets_voirie_objets" o WHERE o."id" = ${objetId}::bigint`;
  return r[0] ? { geomHex: r[0].g, lon: Number(r[0].lon), lat: Number(r[0].lat) } : null;
}

export interface LigneDossierDivergence {
  id: string; projetId: string; cle: string; jeuReseauId: string | null; jeuAxesId: string | null; objetId: string; concessionnaireId: string | null; mesure: string; geomHex: string;
  classePrecision: string | null; comparaisonId: string;
}

/** Cree le dossier (statut A_INVESTIGUER, sans analyse, lie a sa comparaison). `tronconsProches` reste vide : le referentiel n est pas lu ici. */
export async function insererDossierDivergence(tx: TxEcriture, l: LigneDossierDivergence, axe: string): Promise<number> {
  return tx.$executeRaw`
    INSERT INTO "conflits_projet" ("id", "projetId", "cle", "type", "axe", "jeuReseauId", "jeuAxesId", "objetId", "concessionnaireId", "mesure", "geom", "statut", "classePrecision", "verticalEvalue",
                                   "premiereAnalyseId", "derniereAnalyseId", "comparaisonId", "aReexaminer", "motifReexamen", "tronconsProches")
    VALUES (${l.id}, ${l.projetId}, ${l.cle}, 'DIVERGENCE_SOURCES'::"TypeConflit", ${axe}, ${l.jeuReseauId}, ${l.jeuAxesId}, ${l.objetId}::bigint, ${l.concessionnaireId}, ${l.mesure}::jsonb,
            ST_GeomFromEWKB(decode(${l.geomHex}, 'hex')), 'A_INVESTIGUER'::"StatutConflit", ${l.classePrecision}::"ClassePrecision", false, NULL, NULL, ${l.comparaisonId}, false, NULL, '[]'::jsonb)`;
}

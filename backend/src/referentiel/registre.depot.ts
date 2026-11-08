import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { clauseSqlReseauClasse } from "../lib/reseau";
import type { AttributsTroncon, PaireProche } from "./registre.noyau";

/**
 * Lectures SQL du registre : elles CONSTATENT des valeurs, elles ne jugent rien (le jugement est dans
 * `registre.noyau.ts`).
 *
 * MEME DISCIPLINE QUE `qualite/anomalies.depot.ts` : tout est borne par region et plafonne. Le perimetre est le
 * RESEAU CLASSE (le referentiel publie), pas la voirie promue : examiner 261 387 troncons de voirie derriere
 * une route HTTP n'aurait pas de sens, et ce ne sont pas eux que le referentiel garantit.
 */

export interface Portee {
  regionId: number | null;
}

/** Plafond de troncons lus par analyse. Le reseau classe en compte 1 691 au plan national. */
export const PLAFOND_TRONCONS = 5000;
/** Plafond de paires examinees : au-dela, l'analyse le dit (tronquee) au lieu de rendre un compte faux. */
export const PLAFOND_PAIRES = 2000;

const reseau = Prisma.raw(clauseSqlReseauClasse('t."sourceReference"'));
const reseauA = Prisma.raw(clauseSqlReseauClasse('a."sourceReference"'));
const reseauB = Prisma.raw(clauseSqlReseauClasse('b."sourceReference"'));

interface LigneAttributs {
  id: string; regionId: number | null; code: string;
  pkDebut: number; pkFin: number; longueurKm: number; classe: string; revetement: string;
  aGeometrie: boolean; geometrieValide: boolean | null; raisonInvalide: string | null; longueurGeometriqueM: number | null;
  xmin: number | null; ymin: number | null; xmax: number | null; ymax: number | null;
}

export async function lireAttributs(p: Portee): Promise<{ troncons: AttributsTroncon[]; tronque: boolean }> {
  // ST_IsValid AVANT ST_Length : la longueur d'une geometrie invalide n'est pas une mesure.
  const lignes = await prisma.$queryRaw<LigneAttributs[]>`
    SELECT t.id, t."regionId", t.code, t."pkDebut", t."pkFin", t."longueurKm",
           t.classe::text AS classe, t.revetement::text AS revetement,
           (t.geom IS NOT NULL) AS "aGeometrie",
           CASE WHEN t.geom IS NULL THEN NULL ELSE ST_IsValid(t.geom) END AS "geometrieValide",
           CASE WHEN t.geom IS NOT NULL AND NOT ST_IsValid(t.geom) THEN ST_IsValidReason(t.geom) END AS "raisonInvalide",
           CASE WHEN t.geom IS NOT NULL AND ST_IsValid(t.geom) THEN ST_Length(t.geom::geography) END AS "longueurGeometriqueM",
           ST_XMin(t.geom) AS xmin, ST_YMin(t.geom) AS ymin, ST_XMax(t.geom) AS xmax, ST_YMax(t.geom) AS ymax
      FROM troncons t
     WHERE t."deletedAt" IS NULL AND ${reseau}
       AND (${p.regionId}::int IS NULL OR t."regionId" = ${p.regionId}::int)
     ORDER BY t.id
     LIMIT ${PLAFOND_TRONCONS + 1}
  `;
  const tronque = lignes.length > PLAFOND_TRONCONS;
  return {
    tronque,
    troncons: lignes.slice(0, PLAFOND_TRONCONS).map((l) => ({
      id: l.id, regionId: l.regionId, code: l.code,
      pkDebut: Number(l.pkDebut), pkFin: Number(l.pkFin), longueurKm: Number(l.longueurKm),
      classe: l.classe, revetement: l.revetement,
      aGeometrie: l.aGeometrie, geometrieValide: l.geometrieValide, raisonInvalide: l.raisonInvalide,
      longueurGeometriqueM: l.longueurGeometriqueM === null ? null : Number(l.longueurGeometriqueM),
      emprise: l.xmin === null ? null : { xmin: Number(l.xmin), ymin: Number(l.ymin), xmax: Number(l.xmax), ymax: Number(l.ymax) },
    })),
  };
}

interface LignePaire {
  a: string; b: string; regionId: number | null; codeA: string; codeB: string;
  archiveA: boolean; archiveB: boolean; longueurAM: number; longueurBM: number;
  couvertureA: number; couvertureB: number; pkDebutA: number; pkFinA: number; pkDebutB: number; pkFinB: number;
}

/**
 * Paires de troncons de la MEME region dont l'un recouvre au moins `ratio` du trace de l'autre, a `toleranceM`
 * pres. `couvertureB` = part de B comprise dans le tampon de A. Un archive est compare aux actifs (« doublon
 * possible entre donnees actives et archivees ») ; deux archives entre eux, non.
 *
 * La jointure part de `ST_DWithin` en geographie : elle passe par l'index `troncons_geom_geography_idx`.
 *
 * LE RECOUVREMENT SE MESURE EN UTM (fuseau du premier trace, `epsg_utm`, comme le metre). La premiere forme
 * intersectait le trace planaire avec un tampon GEOGRAPHIQUE reconverti en geometrie : sur deux traces paralleles
 * a 2 m, elle rendait LINESTRING EMPTY, donc 0 % de recouvrement et aucun doublon (banc `registre`, 25/10).
 */
export async function pairesProches(p: Portee, toleranceM: number, ratio: number): Promise<{ paires: PaireProche[]; tronque: boolean }> {
  const lignes = await prisma.$queryRaw<LignePaire[]>`
    WITH c AS (
      SELECT a.id AS a, b.id AS b, a."regionId",
             a.code AS "codeA", b.code AS "codeB",
             (a."deletedAt" IS NOT NULL) AS "archiveA", (b."deletedAt" IS NOT NULL) AS "archiveB",
             ST_Length(a.geom::geography) AS "longueurAM", ST_Length(b.geom::geography) AS "longueurBM",
             a."pkDebut" AS "pkDebutA", a."pkFin" AS "pkFinA", b."pkDebut" AS "pkDebutB", b."pkFin" AS "pkFinB",
             a.geom AS ga, b.geom AS gb
        FROM troncons a
        JOIN troncons b
          ON a.id < b.id AND a."regionId" = b."regionId"
         AND ST_DWithin(a.geom::geography, b.geom::geography, ${toleranceM})
       WHERE a.geom IS NOT NULL AND b.geom IS NOT NULL AND ST_IsValid(a.geom) AND ST_IsValid(b.geom)
         AND (a."deletedAt" IS NULL OR b."deletedAt" IS NULL)
         AND ${reseauA} AND ${reseauB}
         AND (${p.regionId}::int IS NULL OR a."regionId" = ${p.regionId}::int)
    )
    SELECT a, b, "regionId", "codeA", "codeB", "archiveA", "archiveB", "longueurAM", "longueurBM",
           "pkDebutA", "pkFinA", "pkDebutB", "pkFinB",
           ST_Length(ST_Intersection(ST_Transform(ga, z), ST_Buffer(ST_Transform(gb, z), ${toleranceM}))) / NULLIF(ST_Length(ST_Transform(ga, z)), 0) AS "couvertureA",
           ST_Length(ST_Intersection(ST_Transform(gb, z), ST_Buffer(ST_Transform(ga, z), ${toleranceM}))) / NULLIF(ST_Length(ST_Transform(gb, z)), 0) AS "couvertureB"
      FROM (SELECT c.*, epsg_utm(c.ga) AS z FROM c) c
     ORDER BY a, b
     LIMIT ${PLAFOND_PAIRES * 4}
  `;
  const retenues = lignes
    .map((l) => ({ ...l, couvertureA: Number(l.couvertureA ?? 0), couvertureB: Number(l.couvertureB ?? 0) }))
    .filter((l) => Math.max(l.couvertureA, l.couvertureB) >= ratio);
  return {
    tronque: lignes.length >= PLAFOND_PAIRES * 4 || retenues.length > PLAFOND_PAIRES,
    paires: retenues.slice(0, PLAFOND_PAIRES).map((l) => ({
      a: l.a, b: l.b, regionId: l.regionId, codeA: l.codeA, codeB: l.codeB, archiveA: l.archiveA, archiveB: l.archiveB,
      longueurAM: Number(l.longueurAM), longueurBM: Number(l.longueurBM), couvertureA: l.couvertureA, couvertureB: l.couvertureB,
      pkA: [Number(l.pkDebutA), Number(l.pkFinA)], pkB: [Number(l.pkDebutB), Number(l.pkFinB)],
    })),
  };
}

export interface PaireNom { a: string; b: string; regionId: number | null; nom: string; codeA: string; codeB: string }

/** Meme nom (sans accents, casse ni espaces multiples) dans la meme region, SANS recouvrement de trace a `toleranceM` pres. */
export async function nomsIdentiques(p: Portee, toleranceM: number): Promise<{ paires: PaireNom[]; tronque: boolean }> {
  const lignes = await prisma.$queryRaw<PaireNom[]>`
    SELECT a.id AS a, b.id AS b, a."regionId", a.nom, a.code AS "codeA", b.code AS "codeB"
      FROM troncons a
      JOIN troncons b
        ON a.id < b.id AND a."regionId" = b."regionId"
       AND regexp_replace(lower(unaccent(btrim(a.nom))), '[[:space:]]+', ' ', 'g') = regexp_replace(lower(unaccent(btrim(b.nom))), '[[:space:]]+', ' ', 'g')
     WHERE a."deletedAt" IS NULL AND b."deletedAt" IS NULL AND ${reseauA} AND ${reseauB}
       AND btrim(a.nom) <> ''
       AND (${p.regionId}::int IS NULL OR a."regionId" = ${p.regionId}::int)
       AND NOT (a.geom IS NOT NULL AND b.geom IS NOT NULL AND ST_DWithin(a.geom::geography, b.geom::geography, ${toleranceM}))
     ORDER BY a.id, b.id
     LIMIT ${PLAFOND_PAIRES + 1}
  `;
  return { paires: lignes.slice(0, PLAFOND_PAIRES), tronque: lignes.length > PLAFOND_PAIRES };
}

/**
 * Detecteurs SQL du moteur de qualite.
 *
 * TOUT EST BORNE, ET CE N'EST PAS UNE PRECAUTION DE PRINCIPE
 *
 * Mesure du 13/10/2026 sur la production : compter les troncons entierement hors du
 * territoire a pris 20 secondes. Pour 261 387 troncons contre 10 multipolygones, c'est
 * normal, et c'est acceptable pour un traitement de nuit. Ce n'est pas acceptable derriere
 * une route HTTP, ou dix appels simultanes occuperaient la base de production trois minutes.
 *
 * Chaque detecteur ci-dessous est donc SCOPE par region ou par troncon, et plafonne le
 * nombre de lignes rendues. Le balayage national appartient a un traitement par lots, qui
 * n'existe pas encore et dont l'absence est consignee plutot que contournee.
 *
 * ET UN DETECTEUR EST DELIBEREMENT ABSENT
 *
 * La distinction entre un vrai hors-territoire et le BRUIT DE PRECISION des limites
 * administratives demande, par troncon, la distance minimale a la frontiere. Lancee sur la
 * production, cette requete ne s'est pas terminee en dix minutes et j'ai du l'annuler.
 *
 * Elle exigerait une frontiere nationale pretabli et mise en tampon, c'est-a-dire une vue
 * materialisee, c'est-a-dire une ecriture. Je ne l'ai donc pas faite, et le rapport dit
 * « entierement hors des limites de niveau 1 » sans pretendre distinguer une route
 * etrangere d'un trace qui longe la frontiere a cinquante metres.
 */
import { prisma } from "../lib/prisma";
import type { Anomalie, FamilleAnomalie } from "./anomalies";

/**
 * Plafond de lignes par detecteur.
 *
 * Le moteur agrege : il a besoin d'un COMPTE exact et de quelques exemples, pas de la
 * liste. Charger 6 572 identifiants pour n'en montrer trois serait du transport pour rien.
 */
export const PLAFOND_EXEMPLES = 20;

export interface Portee {
  /** Limite l'examen a une region. `null` examine tout, et coute cher : voir l'en-tete. */
  regionId: number | null;
}

export interface ComptageFamille {
  famille: FamilleAnomalie;
  nombre: number;
  surTotal: number | null;
  exemples: Anomalie[];
}

/**
 * Troncons dont la geometrie ne touche AUCUNE limite de niveau 1.
 *
 * `NOT EXISTS` plutot qu'une union prealable : la forme corrélée utilise l'index GiST de
 * `limites_admin`, l'union ne l'utiliserait pas.
 *
 * MESURE DU 13/10/2026, SANS PORTEE : 6 572 troncons, dont 7 du reseau classe d'origine
 * (72 km, les sept documentes depuis septembre) et 6 565 venus de la promotion de la
 * voirie, soit environ 6 000 km. La promotion a donc importe du reseau hors de Guinee, ce
 * qu'aucune mesure anterieure n'avait vu.
 */
export async function horsTerritoire(p: Portee): Promise<ComptageFamille> {
  const [compte] = await prisma.$queryRaw<{ n: bigint; total: bigint }[]>`
    SELECT count(*) FILTER (WHERE hors) AS n, count(*) AS total
      FROM (
        SELECT NOT EXISTS (
                 SELECT 1 FROM limites_admin l
                  WHERE l.niveau = 1 AND ST_Intersects(t.geom, l.geom)
               ) AS hors
          FROM troncons t
         WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL
           AND (${p.regionId}::int IS NULL OR t."regionId" = ${p.regionId}::int)
      ) q
  `;

  const exemples = await prisma.$queryRaw<{ id: string; code: string; km: number }[]>`
    SELECT t.id, t.code, ST_Length(t.geom::geography) / 1000.0 AS km
      FROM troncons t
     WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL
       AND (${p.regionId}::int IS NULL OR t."regionId" = ${p.regionId}::int)
       AND NOT EXISTS (
             SELECT 1 FROM limites_admin l
              WHERE l.niveau = 1 AND ST_Intersects(t.geom, l.geom)
           )
     ORDER BY ST_Length(t.geom::geography) DESC
     LIMIT ${PLAFOND_EXEMPLES}
  `;

  return {
    famille: "HORS_TERRITOIRE",
    nombre: Number(compte?.n ?? 0),
    surTotal: Number(compte?.total ?? 0),
    exemples: exemples.map((e) => ({
      famille: "HORS_TERRITOIRE" as const,
      entityType: "Troncon",
      entityId: e.id,
      explication:
        `${e.code} : ${e.km.toFixed(2)} km entierement hors des limites administratives de`
        + " niveau 1. La precision de la couche de limites n'est pas verifiee a cette echelle.",
      mesure: Math.round(e.km * 100) / 100,
    })),
  };
}

/**
 * Troncons portant une geometrie strictement identique a celle d'un autre.
 *
 * `ST_AsBinary` et non `ST_Equals` : l'egalite geometrique compare des formes a tolerance
 * et coute une comparaison par paire, soit un produit cartesien. L'egalite BINAIRE se
 * groupe, donc se calcule en un balayage, et ne rate que les doublons dont la
 * representation differe — qu'un `ST_Equals` sur les seuls candidats pourra chercher plus
 * tard, si quelqu'un en a besoin.
 *
 * MESURE DU 13/10/2026 : 42 groupes, 42 objets en trop. Toute statistique de lineaire
 * compte donc ces metres deux fois.
 */
export async function doublonsDeGeometrie(p: Portee): Promise<ComptageFamille> {
  const lignes = await prisma.$queryRaw<{ ids: string[]; codes: string[]; n: bigint; km: number }[]>`
    SELECT array_agg(t.id) AS ids, array_agg(t.code) AS codes, count(*) AS n,
           max(ST_Length(t.geom::geography)) / 1000.0 AS km
      FROM troncons t
     WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL
       AND (${p.regionId}::int IS NULL OR t."regionId" = ${p.regionId}::int)
     GROUP BY ST_AsBinary(t.geom)
    HAVING count(*) > 1
     ORDER BY max(ST_Length(t.geom::geography)) DESC
     LIMIT ${PLAFOND_EXEMPLES}
  `;

  // Le compte total se refait a part : le LIMIT ci-dessus plafonne les exemples, pas le
  // diagnostic. Rendre « 20 doublons » alors qu'il y en a 42 serait une erreur de lecture
  // bien plus couteuse qu'une seconde requete.
  const [total] = await prisma.$queryRaw<{ groupes: bigint; enTrop: bigint }[]>`
    SELECT count(*) AS groupes, coalesce(sum(n) - count(*), 0) AS "enTrop"
      FROM (SELECT count(*) AS n
              FROM troncons t
             WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL
               AND (${p.regionId}::int IS NULL OR t."regionId" = ${p.regionId}::int)
             GROUP BY ST_AsBinary(t.geom) HAVING count(*) > 1) d
  `;

  return {
    famille: "DOUBLON",
    nombre: Number(total?.groupes ?? 0),
    surTotal: null,
    exemples: lignes.map((l) => ({
      famille: "DOUBLON" as const,
      entityType: "Troncon",
      entityId: l.ids[0],
      explication:
        `${Number(l.n)} troncons de geometrie identique : ${l.codes.slice(0, 4).join(", ")}`
        + `${l.codes.length > 4 ? "…" : ""}. ${l.km.toFixed(2)} km comptes ${Number(l.n)} fois.`,
      mesure: Math.round(l.km * 100) / 100,
    })),
  };
}

/**
 * Geometries invalides au sens de PostGIS.
 *
 * MESURE DU 13/10/2026 : ZERO, sur 261 387 troncons et 1 172 ouvrages. Je m'attendais au
 * contraire apres une promotion OSM de cette ampleur. Le detecteur reste, parce que c'est
 * l'etat des donnees qui est bon, pas le risque qui a disparu : une correction geometrique
 * mal faite en introduirait.
 */
export async function geometriesInvalides(p: Portee): Promise<ComptageFamille> {
  const lignes = await prisma.$queryRaw<{ id: string; code: string; raison: string }[]>`
    SELECT t.id, t.code, ST_IsValidReason(t.geom) AS raison
      FROM troncons t
     WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL
       AND (${p.regionId}::int IS NULL OR t."regionId" = ${p.regionId}::int)
       AND NOT ST_IsValid(t.geom)
     LIMIT ${PLAFOND_EXEMPLES}
  `;
  return {
    famille: "GEOMETRIE_INVALIDE",
    nombre: lignes.length,
    surTotal: null,
    exemples: lignes.map((l) => ({
      famille: "GEOMETRIE_INVALIDE" as const,
      entityType: "Troncon",
      entityId: l.id,
      explication: `${l.code} : ${l.raison}`,
      mesure: null,
    })),
  };
}

/**
 * Ouvrages sans statut de validation.
 *
 * MESURE DU 13/10/2026 : les 1 172, soit TOUS. La colonne est neuve et la migration
 * additive n'ecrit rien, donc c'est attendu. La consequence tient quand meme : les
 * 81 ouvrages issus d'un PDF ne se distinguent d'aucune maniere de ceux qu'un agent aurait
 * constates sur place.
 */
export async function actifsSansValidation(p: Portee): Promise<ComptageFamille> {
  const where = p.regionId === null ? {} : { regionId: p.regionId };
  const [nombre, total, exemples] = await Promise.all([
    prisma.ouvrage.count({ where: { ...where, deletedAt: null, statutValidation: null } }),
    prisma.ouvrage.count({ where: { ...where, deletedAt: null } }),
    prisma.ouvrage.findMany({
      where: { ...where, deletedAt: null, statutValidation: null },
      select: { id: true, nom: true, type: true, sourceReference: true },
      take: PLAFOND_EXEMPLES,
    }),
  ]);
  return {
    famille: "ACTIF_SANS_VALIDATION",
    nombre,
    surTotal: total,
    exemples: exemples.map((o) => ({
      famille: "ACTIF_SANS_VALIDATION" as const,
      entityType: "Ouvrage",
      entityId: o.id,
      explication:
        `${o.type} « ${o.nom} » sans statut de validation`
        + `${o.sourceReference ? `, importe de ${o.sourceReference}` : ""}.`,
      mesure: null,
    })),
  };
}

/**
 * Ouvrages dont l'inspection est perimee ou absente.
 *
 * `fraicheurMaxJours` est un PARAMETRE : le cahier ne dit pas a partir de quand une
 * inspection est trop ancienne, et le figer ici en ferait la norme d'AGEROUTE par defaut.
 *
 * MESURE DU 13/10/2026 : les 1 172 ouvrages n'ont AUCUNE date d'inspection. Un indicateur
 * « ouvrages a inspecter » rend donc aujourd'hui la totalite du parc, ce qui est exact et
 * inutilisable tant que les inspections ne sont pas saisies.
 */
export async function inspectionsPerimeesEnBase(
  p: Portee,
  fraicheurMaxJours: number,
  maintenant: Date = new Date(),
): Promise<ComptageFamille> {
  const limite = new Date(maintenant.getTime() - fraicheurMaxJours * 24 * 60 * 60 * 1000);
  const where = p.regionId === null ? {} : { regionId: p.regionId };
  // Une date ABSENTE est perimee, pas fraiche : un ouvrage dont on ignore la date
  // d'inspection n'a pas ete inspecte recemment, il n'a pas ete documente.
  const critere = {
    ...where,
    deletedAt: null,
    OR: [{ derniereInspectionDate: null }, { derniereInspectionDate: { lt: limite } }],
  };
  const [nombre, total, exemples] = await Promise.all([
    prisma.ouvrage.count({ where: critere }),
    prisma.ouvrage.count({ where: { ...where, deletedAt: null } }),
    prisma.ouvrage.findMany({
      where: critere,
      select: { id: true, nom: true, type: true, derniereInspectionDate: true },
      orderBy: { derniereInspectionDate: { sort: "asc", nulls: "first" } },
      take: PLAFOND_EXEMPLES,
    }),
  ]);
  return {
    famille: "INSPECTION_PERIMEE",
    nombre,
    surTotal: total,
    exemples: exemples.map((o) => ({
      famille: "INSPECTION_PERIMEE" as const,
      entityType: "Ouvrage",
      entityId: o.id,
      explication: o.derniereInspectionDate === null
        ? `${o.type} « ${o.nom} » sans aucune date d'inspection enregistree.`
        : `${o.type} « ${o.nom} » inspecte le ${o.derniereInspectionDate.toISOString().slice(0, 10)},`
          + ` au-dela du seuil de ${fraicheurMaxJours} jours.`,
      mesure: null,
    })),
  };
}

/**
 * Troncons sans provenance declaree.
 *
 * MESURE DU 13/10/2026 : 1 691 sur 261 387, et ce sont exactement les troncons du reseau
 * classe d'origine. La voirie promue, elle, documente sa source. Le referentiel le plus
 * ancien est donc le moins trace, ce qui est l'inverse de l'intuition.
 */
export async function donneesSansProvenance(p: Portee): Promise<ComptageFamille> {
  const where = p.regionId === null ? {} : { regionId: p.regionId };
  const [nombre, total, exemples] = await Promise.all([
    prisma.troncon.count({ where: { ...where, deletedAt: null, sourceType: null } }),
    prisma.troncon.count({ where: { ...where, deletedAt: null } }),
    prisma.troncon.findMany({
      where: { ...where, deletedAt: null, sourceType: null },
      select: { id: true, code: true, classe: true },
      take: PLAFOND_EXEMPLES,
    }),
  ]);
  return {
    famille: "DONNEE_SANS_PROVENANCE",
    nombre,
    surTotal: total,
    exemples: exemples.map((t) => ({
      famille: "DONNEE_SANS_PROVENANCE" as const,
      entityType: "Troncon",
      entityId: t.id,
      explication: `${t.code} (${t.classe}) sans sourceType : on ne sait pas d'ou vient cet enregistrement.`,
      mesure: null,
    })),
  };
}

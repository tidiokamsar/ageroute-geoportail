/**
 * Implementation Prisma des sources du contexte terrain.
 *
 * Le raisonnement vit dans `contexte.ts`, qui se teste sans base. Ici il n'y a que des
 * requetes, et trois precautions qui meritent d'etre dites.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { apparier } from "../geo/appariement";
import type { ActifProche, SourcesContexte } from "./contexte";
import type { Portion } from "../reseau/portions";

/**
 * Longueur REELLE de la geometrie, en metres.
 *
 * `ST_Length(geom::geography)` et non `longueurKm`. Les deux divergent, et la regle
 * premiere du depot interdit d'ecraser l'une par l'autre : `longueurKm` est une donnee
 * declaree par AGEROUTE, la longueur geometrique est une mesure de la numerisation. Pour
 * borner une portion, c'est la seconde qui fait autorite, puisque les abscisses sont
 * mesurees le long de cette geometrie-la.
 */
async function longueurTronconM(tronconId: string): Promise<number | null> {
  const r = await prisma.$queryRaw<{ longueurM: number | null }[]>`
    SELECT ST_Length(geom::geography) AS "longueurM"
      FROM troncons
     WHERE id = ${tronconId}::text
       AND geom IS NOT NULL
  `;
  const v = r[0]?.longueurM ?? null;
  return v !== null && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Portions COURANTES du troncon.
 *
 * Le filtre sur `remplaceeLe` et `deletedAt` est ici une OPTIMISATION, pas la regle :
 * `courantes()` refiltre de toute facon dans le module. Charger l'historique complet d'un
 * troncon decoupe vingt fois pour n'en garder que l'etat courant serait du gaspillage sur
 * un reseau de 261 387 troncons.
 *
 * Qui veut l'historique appellera une route d'historique, qui le demandera explicitement.
 */
async function portionsDuTroncon(tronconId: string): Promise<Portion[]> {
  const lignes = await prisma.portion.findMany({
    where: { tronconId, remplaceeLe: null, deletedAt: null },
    orderBy: { debutM: "asc" },
    select: {
      id: true, tronconId: true, debutM: true, finM: true,
      revetement: true, etat: true, praticabilite: true, largeurM: true,
      source: true, observeeLe: true, confiance: true,
      statutValidation: true, origine: true, clientOperationId: true,
      remplaceeLe: true, deletedAt: true,
    },
  });
  return lignes.map((l) => ({ ...l, confiance: l.confiance ?? null }));
}

/**
 * Ouvrages a portee de vue, les plus proches d'abord.
 *
 * `ST_DWithin(...::geography, ..., rayon)` est la forme deja utilisee dans le depot : elle
 * se sert de l'index GiST et raisonne en metres, ce qu'un `ST_Distance` nu ne fait pas.
 *
 * `deletedAt IS NULL` : la suppression est logique sur le patrimoine, et un ouvrage
 * archive ne doit pas reapparaitre dans l'ecran d'un agent.
 *
 * LIMITE A 20. Un agent ne constate pas trente ouvrages d'un coup, et une reponse longue
 * est inutilisable sur un telephone en bord de route.
 */
async function actifsProches(
  p: { lat: number; lon: number },
  rayonM: number,
): Promise<ActifProche[]> {
  const point = Prisma.sql`ST_SetSRID(ST_MakePoint(${p.lon}::double precision, ${p.lat}::double precision), 4326)`;
  return prisma.$queryRaw<ActifProche[]>`
    SELECT o.id,
           o.type::text                                   AS type,
           o.nom,
           ST_Distance(o.geom::geography, ${point}::geography) AS "distanceM",
           o.etat::text                                   AS etat,
           o."derniereInspectionDate"                     AS "derniereInspectionLe"
      FROM ouvrages o
     WHERE o.geom IS NOT NULL
       AND o."deletedAt" IS NULL
       AND ST_DWithin(o.geom::geography, ${point}::geography, ${rayonM}::double precision)
     ORDER BY "distanceM" ASC
     LIMIT 20
  `;
}

export const sourcesPrisma: SourcesContexte = {
  apparier,
  longueurTronconM,
  portionsDuTroncon,
  actifsProches,
};

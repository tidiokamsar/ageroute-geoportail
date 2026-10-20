/**
 * Chargement du graphe du reseau depuis la base, pour une emprise (paragraphe 7.3.7).
 *
 * La longueur de chaque troncon est mesuree en `geography` (paragraphe 7.1), jamais en degres,
 * et la polyligne vient de la geometrie stockee. Seuls les troncons vivants (`deletedAt` nul)
 * et geometriques entrent dans le graphe. SQL parametre, jamais concatene.
 *
 * L'EMPRISE est celle de l'appelant -- typiquement la trace, elargie. Hors d'elle, la distance
 * rendue est `null` : le graphe ne connait que ce qu'on lui a charge, et ne devine rien.
 */

import type { PrismaClient } from "@prisma/client";
import { construireGraphe, type Graphe, type TronconGraphe } from "./graphe.noyau";

export interface Emprise { ouest: number; sud: number; est: number; nord: number }

/** Plafond de troncons charges : au-dela, l'emprise est trop large pour un calcul de trace. */
export const MAX_TRONCONS_GRAPHE = 20_000;

export class EmpriseTropLarge extends Error {
  constructor(public readonly nombre: number) { super(`Emprise trop large : ${nombre} troncons (plafond ${MAX_TRONCONS_GRAPHE})`); }
}

export async function chargerGraphe(
  depot: Pick<PrismaClient, "$queryRaw">,
  emprise: Emprise,
  toleranceFusionM: number,
): Promise<{ graphe: Graphe; nbTroncons: number }> {
  const lignes = await depot.$queryRaw<{ id: string; longueurM: number; geojson: string }[]>`
    SELECT t."id", ST_Length(t."geom"::geography) AS "longueurM", ST_AsGeoJSON(t."geom") AS "geojson"
      FROM "troncons" t
     WHERE t."deletedAt" IS NULL AND t."geom" IS NOT NULL
       AND t."geom" && ST_MakeEnvelope(${emprise.ouest}, ${emprise.sud}, ${emprise.est}, ${emprise.nord}, 4326)
     LIMIT ${MAX_TRONCONS_GRAPHE + 1}`;
  if (lignes.length > MAX_TRONCONS_GRAPHE) throw new EmpriseTropLarge(lignes.length);

  const troncons: TronconGraphe[] = [];
  for (const l of lignes) {
    const g = JSON.parse(l.geojson) as { type: string; coordinates: [number, number][] };
    // La colonne est une LineString (schema) ; toute autre forme est ignoree et non devinee.
    if (g.type !== "LineString") continue;
    troncons.push({ id: l.id, longueurM: Number(l.longueurM), coordonnees: g.coordinates });
  }
  return { graphe: construireGraphe(troncons, toleranceFusionM), nbTroncons: troncons.length };
}

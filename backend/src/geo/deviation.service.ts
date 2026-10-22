/**
 * Deviation routee autour d'une coupure (paragraphe 7.14, R-01 ; § 7.16 ligne 13).
 *
 * Charge le sous-reseau autour du troncon coupe, calcule le plus court chemin qui evite la
 * coupure (`graphe.noyau.ts`), et rend la geometrie du trajet pour la carte. Rien n'est ecrit.
 *
 * L'EMPRISE est le tampon du troncon coupe de rayon `distanceMaxM / 2` : un chemin de longueur
 * au plus D, d'un bord de la coupure a l'autre, ne s'eloigne pas de plus de D/2 du troncon. Le
 * sous-reseau charge contient donc toute deviation admissible.
 *
 * CE QUE LA DEVIATION NE SAIT PAS : les sens uniques (absents du referentiel), la praticabilite
 * des routes empruntees (niveaux P1-P4 non approuves, D-02), le gabarit des vehicules. Elle dit
 * par ou passer sur le reseau, pas que le passage est praticable.
 */

import type { PrismaClient } from "@prisma/client";
import { chargerGraphe } from "./graphe.depot";
import { deviation, type Coupure } from "./graphe.noyau";

export type DepotDeviation = Pick<PrismaClient, "$queryRaw">;

export class RefusDeviationHttp extends Error {
  constructor(public readonly code: string, message: string, public readonly http: 400 | 404 | 409 | 422 = 409) { super(message); }
}

export async function calculerDeviation(
  depot: DepotDeviation,
  d: { tronconId: string; debutM?: number | null; finM?: number | null; distanceMaxM: number; toleranceFusionM: number },
) {
  const [t] = await depot.$queryRaw<{ longueurM: number; ouest: number; sud: number; est: number; nord: number }[]>`
    WITH t AS (SELECT "geom" FROM "troncons" WHERE "id" = ${d.tronconId} AND "deletedAt" IS NULL AND "geom" IS NOT NULL),
         b AS (SELECT ST_Envelope(ST_Buffer(t."geom"::geography, ${d.distanceMaxM / 2}::double precision)::geometry) AS e FROM t)
    SELECT ST_Length(t."geom"::geography) AS "longueurM", ST_XMin(b.e) AS "ouest", ST_YMin(b.e) AS "sud", ST_XMax(b.e) AS "est", ST_YMax(b.e) AS "nord"
      FROM t, b`;
  if (!t) throw new RefusDeviationHttp("TRONCON_INTROUVABLE", "Troncon introuvable, supprime, ou sans geometrie.", 404);

  const coupure: Coupure = { tronconId: d.tronconId, debutM: d.debutM ?? 0, finM: d.finM ?? Number(t.longueurM) };
  const { graphe, nbTroncons } = await chargerGraphe(depot, t, d.toleranceFusionM);
  const r = deviation(graphe, coupure, { distanceMaxM: d.distanceMaxM });
  if ("refus" in r) {
    throw new RefusDeviationHttp(r.refus, r.motif, r.refus === "COUPURE_INVALIDE" ? 400 : 422);
  }

  // Geometrie du trajet : chaque segment decoupe sur son troncon, dans le sens de parcours.
  // Fraction = abscisse / longueur mesuree ; ST_LineSubstring raisonne en fraction plane, l'ecart
  // est negligeable a l'echelle d'un troncon.
  const ids = r.segments.map((s) => s.tronconId);
  // Les nombres partent en TEXTE, convertis cote SQL : pour un tableau de nombres, Prisma devine le type
  // d'apres le PREMIER element. [0, 19.87] partait en int8[] et 19.87 etait refuse (22P03).
  const de = r.segments.map((s) => s.deM);
  const a = r.segments.map((s) => s.aM);
  const lignes = await depot.$queryRaw<{ ordre: number; code: string; nom: string | null; geojson: string }[]>`
    WITH s AS (SELECT * FROM unnest(${ids}::text[], ${de.map(String)}::text[]::float8[], ${a.map(String)}::text[]::float8[]) WITH ORDINALITY AS x(id, de, a, ordre)),
         m AS (
           SELECT s.ordre, t."code", t."nom", t."geom", ST_Length(t."geom"::geography) AS l, s.de, s.a
             FROM s JOIN "troncons" t ON t."id" = s.id
         )
    SELECT m.ordre::int AS "ordre", m."code", m."nom",
           ST_AsGeoJSON(CASE WHEN m.a >= m.de
             THEN ST_LineSubstring(m."geom", LEAST(1, m.de / m.l), LEAST(1, m.a / m.l))
             ELSE ST_Reverse(ST_LineSubstring(m."geom", LEAST(1, m.a / m.l), LEAST(1, m.de / m.l))) END) AS "geojson"
      FROM m ORDER BY m.ordre`;

  return {
    coupure,
    longueurM: r.longueurM,
    longueurCoupeeM: r.longueurCoupeeM,
    allongementM: r.allongementM,
    troncons: lignes.map((l, i) => ({ ...r.segments[i], code: l.code, nom: l.nom, geometrie: JSON.parse(l.geojson) })),
    sousReseau: { troncons: nbTroncons, noeuds: graphe.nbNoeuds, jonctionsInterieures: graphe.nbJonctionsInterieures },
    limites: "Reseau non oriente (aucun sens unique au referentiel) ; praticabilite et gabarit non pris en compte.",
  };
}

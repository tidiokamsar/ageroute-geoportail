/**
 * Les troncons d'une ROUTE entre deux endroits (deux villes, deux positions), dans l'ordre.
 *
 * LE BESOIN (25/10) : « lister tous les troncons entre deux villes, comme Sangaredi et Telimele, pour changer l'etat
 * de l'ensemble de la route ». Le filtre qui existait gardait les troncons proches de la DROITE entre les deux villes
 * (une bande de 20 km) : il ramenait aussi les routes voisines et les routes qui croisent la bande, et manquait celles
 * qui font un detour. Ici, on suit le RESEAU : le plus court chemin du graphe des troncons, d'un point a l'autre.
 *
 * CE QUE C'EST : la route la plus courte DANS LE REFERENTIEL. Ce n'est pas « la route officielle » (aucun classement n'est
 * suppose, voir D-06) et le reseau est non oriente. Si le referentiel est interrompu entre les deux endroits, la reponse est
 * « aucun chemin » : jamais une ligne droite, jamais un troncon devine. Les parametres de calcul (rayon d'accrochage,
 * tolerance de fusion, marge) sont PROVISOIRES et rendus dans la reponse.
 *
 * Lecture seule, SQL parametre.
 */

import type { PrismaClient } from "@prisma/client";
import { chargerGraphe, EmpriseTropLarge, type Emprise } from "./graphe.depot";
import { cheminEntre } from "./graphe.noyau";

export type DepotChemin = Pick<PrismaClient, "$queryRaw">;

/** Au-dela, une ville n'est « sur » aucun troncon du referentiel : on le dit plutot que d'accrocher au plus proche. */
export const RAYON_ACCROCHAGE_M = 10_000;
export const TOLERANCE_FUSION_PAR_DEFAUT_M = 15;
/** Marges d'emprise essayees dans l'ordre (degres) : la route peut faire un detour hors de la boite des deux villes. */
const MARGES_DEG = [0.3, 0.9];

export interface Point { lat: number; lon: number }

export class RefusChemin extends Error {
  constructor(public readonly code: "ACCROCHAGE_IMPOSSIBLE" | "AUCUN_CHEMIN" | "EMPRISE_TROP_LARGE" | "POINTS_IDENTIQUES", message: string, public readonly http: 404 | 422 = 422) { super(message); }
}

interface Accroche { id: string; distanceM: number; abscisseM: number; longueurM: number }

async function accrocher(depot: DepotChemin, p: Point): Promise<Accroche | null> {
  const [l] = await depot.$queryRaw<{ id: string; distanceM: number; abscisseM: number; longueurM: number }[]>`
    WITH p AS (SELECT ST_SetSRID(ST_MakePoint(${p.lon}::float8, ${p.lat}::float8), 4326) AS g)
    SELECT t."id", ST_Distance(t."geom"::geography, p.g::geography) AS "distanceM",
           ST_LineLocatePoint(t."geom", p.g) * ST_Length(t."geom"::geography) AS "abscisseM",
           ST_Length(t."geom"::geography) AS "longueurM"
      FROM "troncons" t, p
     WHERE t."deletedAt" IS NULL AND t."geom" IS NOT NULL AND ST_GeometryType(t."geom") = 'ST_LineString'
       AND t."geom" && ST_Expand(p.g, 0.2)
     ORDER BY t."geom" <-> p.g
     LIMIT 1`;
  return l ? { id: l.id, distanceM: Number(l.distanceM), abscisseM: Number(l.abscisseM), longueurM: Number(l.longueurM) } : null;
}

export interface TronconDuChemin {
  ordre: number;
  id: string;
  code: string;
  nom: string;
  classe: string;
  etat: string;
  region: string;
  longueurM: number;
  /** Longueur effectivement parcourue par le chemin sur ce troncon. */
  parcourM: number;
  /** Vrai si seule une partie du troncon est sur le chemin (la ville est en son milieu). */
  partiel: boolean;
  /** `+` : dans le sens de l'abscisse, `-` : a l'envers. */
  sens: "+" | "-";
}

export interface ResultatChemin {
  depart: { lat: number; lon: number; accrochageM: number; tronconId: string };
  arrivee: { lat: number; lon: number; accrochageM: number; tronconId: string };
  longueurM: number;
  droiteM: number;
  troncons: TronconDuChemin[];
  parametres: { rayonAccrochageM: number; toleranceFusionM: number; margesDeg: number[]; margeUtiliseeDeg: number; nbTronconsCharges: number };
  avertissements: string[];
}

function emprise(a: Point, b: Point, marge: number): Emprise {
  return {
    ouest: Math.min(a.lon, b.lon) - marge, est: Math.max(a.lon, b.lon) + marge,
    sud: Math.min(a.lat, b.lat) - marge, nord: Math.max(a.lat, b.lat) + marge,
  };
}

export async function cheminEntrePoints(
  depot: DepotChemin,
  a: Point,
  b: Point,
  options: { toleranceFusionM?: number } = {},
): Promise<ResultatChemin> {
  if (a.lat === b.lat && a.lon === b.lon) throw new RefusChemin("POINTS_IDENTIQUES", "Les deux endroits sont identiques : choisir deux villes differentes.");
  const tolerance = options.toleranceFusionM ?? TOLERANCE_FUSION_PAR_DEFAUT_M;

  const [pa, pb] = await Promise.all([accrocher(depot, a), accrocher(depot, b)]);
  for (const [nom, p] of [["de depart", pa], ["d'arrivee", pb]] as const) {
    if (!p) throw new RefusChemin("ACCROCHAGE_IMPOSSIBLE", `Aucun troncon du referentiel pres de l'endroit ${nom}.`, 404);
    if (p.distanceM > RAYON_ACCROCHAGE_M) {
      throw new RefusChemin("ACCROCHAGE_IMPOSSIBLE", `Le troncon le plus proche de l'endroit ${nom} est a ${(p.distanceM / 1000).toFixed(1)} km (limite ${RAYON_ACCROCHAGE_M / 1000} km) : le referentiel ne couvre pas cet endroit.`, 404);
    }
  }
  const accrochageA = pa!, accrochageB = pb!;

  const droiteM = haversine(a, b);
  const distanceMaxM = Math.min(1_500_000, Math.max(60_000, droiteM * 3));
  let dernierRefus = "";
  let charges = 0;
  for (const marge of MARGES_DEG) {
    let charge;
    try { charge = await chargerGraphe(depot, emprise(a, b, marge), tolerance); }
    catch (e) {
      if (e instanceof EmpriseTropLarge) throw new RefusChemin("EMPRISE_TROP_LARGE", `${e.message} : les deux endroits sont trop eloignes pour un calcul en une fois.`);
      throw e;
    }
    charges = charge.nbTroncons;
    const r = cheminEntre(
      charge.graphe,
      { tronconId: accrochageA.id, abscisseM: accrochageA.abscisseM },
      { tronconId: accrochageB.id, abscisseM: accrochageB.abscisseM },
      { distanceMaxM },
    );
    if ("refus" in r) { dernierRefus = r.motif; continue; }

    const ids = [...new Set(r.segments.map((s) => s.tronconId))];
    const lignes = await depot.$queryRaw<{ id: string; code: string; nom: string; classe: string; etat: string; region: string; longueurM: number }[]>`
      SELECT t."id", t."code", t."nom", t."classe"::text AS "classe", t."etat"::text AS "etat", r."nom" AS "region",
             ST_Length(t."geom"::geography) AS "longueurM"
        FROM "troncons" t JOIN "regions" r ON r."id" = t."regionId"
       WHERE t."id" = ANY(${ids}::text[])`;
    const parId = new Map(lignes.map((l) => [l.id, l]));
    const troncons: TronconDuChemin[] = r.segments.map((s, i) => {
      const l = parId.get(s.tronconId)!;
      const longueurM = Number(l.longueurM);
      const parcourM = Math.abs(s.aM - s.deM);
      return {
        ordre: i + 1, id: l.id, code: l.code, nom: l.nom, classe: l.classe, etat: l.etat, region: l.region,
        longueurM, parcourM, partiel: parcourM < longueurM - 1, sens: s.aM >= s.deM ? "+" : "-",
      };
    });
    const avertissements: string[] = [];
    if (r.longueurM > droiteM * 2) avertissements.push(`Le chemin fait ${(r.longueurM / 1000).toFixed(0)} km pour ${(droiteM / 1000).toFixed(0)} km a vol d'oiseau : verifier qu'il s'agit bien de la route attendue (le referentiel peut etre interrompu et imposer un detour).`);
    if (troncons.some((t) => t.partiel)) avertissements.push("Un troncon n'est parcouru qu'en partie : changer son etat change l'etat du troncon ENTIER.");
    return {
      depart: { ...a, accrochageM: accrochageA.distanceM, tronconId: accrochageA.id },
      arrivee: { ...b, accrochageM: accrochageB.distanceM, tronconId: accrochageB.id },
      longueurM: r.longueurM, droiteM, troncons,
      parametres: { rayonAccrochageM: RAYON_ACCROCHAGE_M, toleranceFusionM: tolerance, margesDeg: MARGES_DEG, margeUtiliseeDeg: marge, nbTronconsCharges: charges },
      avertissements,
    };
  }
  throw new RefusChemin("AUCUN_CHEMIN", dernierRefus || "Aucun chemin continu entre les deux endroits dans le referentiel.");
}

function haversine(a: Point, b: Point): number {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

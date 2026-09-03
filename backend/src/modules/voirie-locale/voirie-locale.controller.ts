import type { NextFunction, Request, Response } from "express";
import { prisma } from "../../lib/prisma";

/**
 * Voirie locale — service cadre par emprise.
 *
 * POURQUOI L'EMPRISE EST OBLIGATOIRE
 *
 * La table porte 262 656 objets et 5,8 millions de sommets. Mesure sur la carte
 * publique : 22,8 octets par sommet une fois serialise en GeoJSON. Servir la couche
 * entiere representerait 133 Mo bruts, 41 Mo gzippes — quarante-sept fois ce que
 * l'application transporte aujourd'hui.
 *
 * Mais cadree, la meme couche est legere : Conakry entiere pese 263 Ko gzippes,
 * MOINS que les 876 Ko de la carte publique actuelle. Une commune : 35 Ko. Un
 * quartier : 2 Ko.
 *
 * C'est ce rapport qui a decide l'architecture — pas de tuiles vectorielles, qui
 * auraient impose un endpoint de tuiles, un cache et un changement de moteur de
 * rendu pour servir 263 Ko.
 *
 * TROIS PROTECTIONS, DANS CET ORDRE
 *
 * 1. L'emprise est obligatoire et bornee en surface. Une requete trop large est
 *    refusee avec un message explicite, pas servie en 41 Mo.
 * 2. La simplification suit la taille de l'emprise. Aux echelles ou le detail ne se
 *    voit pas, il ne part pas.
 * 3. Un plafond d'objets tronque la reponse et le DIT. Une carte qui annonce « trop
 *    d'objets, zoomez » vaut mieux qu'une carte qui se fige.
 */

/**
 * Surface maximale servie, en degres carres.
 *
 * 0,25 deg² correspond a peu pres a 0,5° x 0,5°, soit l'echelle d'une agglomeration
 * elargie — la mesure donne 1,2 Mo gzippes pour la region de Conakry a cette taille.
 * Au-dela, le volume decroche : le pays entier fait 41 Mo.
 */
const SURFACE_MAX_DEG2 = 0.25;

/** Au-dela, la reponse est tronquee et le signale. */
const PLAFOND_OBJETS = 12_000;

interface LigneVoirie {
  id: string;
  nature: string;
  nom: string | null;
  reference: string | null;
  categorie: string;
  statut: string;
  source: string;
  source_id: string;
  source_date: Date | null;
  longueur_km: number;
  region: string | null;
  region_methode: string | null;
  troncon_id: string | null;
  troncon_code: string | null;
  geometry: string;
}

/**
 * Tolerance de simplification, en degres, selon la taille de l'emprise.
 *
 * La mesure de la phase 4 sur les troncons BDRI reste valable ici : degrader une
 * geometrie jusqu'a 1,6 point par kilometre conservait 99,09 % de la longueur. Aux
 * echelles intermediaires, simplifier est donc quasiment gratuit en fidelite.
 *
 * Au plus pres — une emprise de quartier — aucune simplification : c'est
 * precisement la forme exacte de la voie qu'on regarde.
 */
function toleranceSimplification(surfaceDeg2: number): number {
  if (surfaceDeg2 > 0.05) return 0.0005;
  if (surfaceDeg2 > 0.005) return 0.0001;
  return 0;
}

function parseBbox(brut: unknown): [number, number, number, number] | null {
  if (typeof brut !== "string") return null;
  const p = brut.split(",").map((v) => Number(v.trim()));
  if (p.length !== 4 || p.some((v) => !Number.isFinite(v))) return null;
  const [minLon, minLat, maxLon, maxLat] = p;
  if (minLon >= maxLon || minLat >= maxLat) return null;
  if (Math.abs(minLon) > 180 || Math.abs(maxLon) > 180) return null;
  if (Math.abs(minLat) > 90 || Math.abs(maxLat) > 90) return null;
  return [minLon, minLat, maxLon, maxLat];
}

const CATEGORIES_VALIDES = new Set([
  "VOIE_RAPIDE", "PRINCIPALE", "SECONDAIRE", "TERTIAIRE",
  "VOIE_LOCALE", "RESIDENTIELLE", "ACCES",
  "CHEMIN", "SENTIER", "PIETON", "INCONNU",
]);

/**
 * Sert la voirie cadree par emprise.
 *
 * PARTAGE ENTRE LE GEOPORTAIL ET LA CARTE PUBLIQUE. Les deux surfaces montrent la
 * meme donnee — c'est de l'OpenStreetMap, deja publique — et doivent donc porter
 * les memes garde-fous. Les dupliquer aurait laisse les deux versions diverger.
 *
 * Ce qui differe est le montage : le geoportail place ce handler derriere
 * requireAuth, la route publique derriere une limitation de debit.
 */
export async function voirieGeoHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const bbox = parseBbox(req.query.bbox);
    if (!bbox) {
      return res.status(400).json({
        message:
          "Emprise requise : bbox=minLon,minLat,maxLon,maxLat. " +
          "Cette couche compte 262 656 objets et n'est jamais servie en entier.",
      });
    }

    const [minLon, minLat, maxLon, maxLat] = bbox;
    const surface = (maxLon - minLon) * (maxLat - minLat);
    if (surface > SURFACE_MAX_DEG2) {
      return res.status(400).json({
        message: "Emprise trop large pour cette couche — rapprochez la vue.",
        surfaceDemandee: Number(surface.toFixed(4)),
        surfaceMaximale: SURFACE_MAX_DEG2,
      });
    }

    // Filtre de categories. Une valeur inconnue est ignoree plutot que d'echouer :
    // le client peut evoluer sans casser, et la liste blanche empeche toute
    // injection dans la clause SQL.
    const demandees = String(req.query.categories ?? "")
      .split(",")
      .map((c) => c.trim().toUpperCase())
      .filter((c) => CATEGORIES_VALIDES.has(c));
    const categories = demandees.length > 0 ? demandees : [...CATEGORIES_VALIDES];

    const tolerance = toleranceSimplification(surface);

    // ST_Simplify a 0 renverrait une geometrie vide : on ne l'applique que si la
    // tolerance est non nulle.
    const lignes = await prisma.$queryRaw<LigneVoirie[]>`
      SELECT
        v.id,
        v.nature,
        v.nom,
        v.reference,
        v.categorie::text        AS categorie,
        v.statut::text           AS statut,
        v.source::text           AS source,
        v."sourceId"             AS source_id,
        v."sourceDate"           AS source_date,
        v."longueurCalculeeKm"   AS longueur_km,
        r.nom                    AS region,
        v."regionMethode"        AS region_methode,
        -- Une voie promue porte un troncon. La fiche doit pouvoir le dire : c'est la
        -- difference entre une donnee cartographique et un actif du patrimoine.
        v."tronconId"            AS troncon_id,
        t.code                   AS troncon_code,
        ST_AsGeoJSON(
          CASE WHEN ${tolerance}::float8 > 0
               THEN ST_SimplifyPreserveTopology(v.geom, ${tolerance}::float8)
               ELSE v.geom END
        )                        AS geometry
      FROM voirie_locale v
      LEFT JOIN regions r ON r.id = v."regionId"
      LEFT JOIN troncons t ON t.id = v."tronconId"
      WHERE v.geom && ST_MakeEnvelope(${minLon}, ${minLat}, ${maxLon}, ${maxLat}, 4326)
        AND v.categorie::text = ANY(${categories})
        AND v.statut <> 'ARCHIVEE'
      LIMIT ${PLAFOND_OBJETS + 1}
    `;

    const tronque = lignes.length > PLAFOND_OBJETS;
    const servies = tronque ? lignes.slice(0, PLAFOND_OBJETS) : lignes;

    return res.json({
      // Le client doit pouvoir dire a l'utilisateur qu'il ne voit pas tout.
      tronque,
      plafond: PLAFOND_OBJETS,
      simplifieeDe: tolerance,
      voies: servies.map((l) => ({
        id: l.id,
        nature: l.nature,
        nom: l.nom,
        reference: l.reference,
        categorie: l.categorie,
        statut: l.statut,
        source: l.source,
        sourceId: l.source_id,
        sourceDate: l.source_date,
        longueurKm: l.longueur_km,
        region: l.region,
        regionMethode: l.region_methode,
        tronconId: l.troncon_id,
        tronconCode: l.troncon_code,
        geometry: l.geometry,
      })),
    });
  } catch (err) {
    return next(err);
  }
}

/** Comptes par categorie — sert le panneau, sans transporter de geometrie. */
export async function voirieStatsHandler(_req: Request, res: Response, next: NextFunction) {
  try {
    const rows = await prisma.$queryRaw<{ categorie: string; voies: bigint; km: number }[]>`
      SELECT v.categorie::text AS categorie,
             count(*)          AS voies,
             COALESCE(SUM(v."longueurCalculeeKm"), 0) AS km
      FROM voirie_locale v
      WHERE v.statut <> 'ARCHIVEE'
      GROUP BY v.categorie
      ORDER BY km DESC
    `;
    res.json({
      // count(*) revient en bigint : JSON ne sait pas le serialiser.
      categories: rows.map((r) => ({
        categorie: r.categorie,
        voies: Number(r.voies),
        km: Math.round(Number(r.km)),
      })),
      total: rows.reduce((s, r) => s + Number(r.voies), 0),
    });
  } catch (err) {
    next(err);
  }
}

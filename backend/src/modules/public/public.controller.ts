import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../lib/prisma";
import { tronconsService } from "../troncons/troncons.service";
import { pointsNoirsService } from "../points-noirs/points-noirs.service";
import { chantiersService } from "../chantiers/chantiers.service";

interface TronconGeoRow {
  id: string; code: string; nom: string; classe: string; etat: string;
  longueurKm: number; region: string | null; geometry: string | null;
  /** L'etat vient d'une declaration, pas d'un releve terrain. */
  etatDeclare: boolean;
}
interface PointNoirGeoRow {
  id: string; gravite: string; region: string | null; lat: number; lon: number;
}
interface ChantierGeoRow {
  id: string; statut: string; avancementPct: number; region: string | null;
  geometry: string | null; approximate: boolean; lat: number | null; lon: number | null;
}
interface OuvrageGeoRow {
  id: string; nom: string; type: string; etat: string; lat: number; lon: number;
}

/**
 * Aperçu public du réseau (pas d'authentification) — champs volontairement
 * réduits (pas d'entreprise/bailleur/montant/numContrat/observations/pk/
 * revêtement/trafic) : destiné à un aperçu cartographique embarqué (mini-carte
 * SharePoint), jamais à un usage de gestion. Le détail complet reste derrière
 * les endpoints authentifiés existants (/api/troncons, /api/chantiers, ...).
 *
 * Ouvrages (D9, 02/09/2026, décision du propriétaire) : identité, type et
 * position uniquement. Les positions étant héritées (2016) et non vérifiées,
 * le rendu public porte la mention adéquate ; les franchissements OSM
 * (propositions) sont servis comme fichier statique par le frontend.
 */
/**
 * Tolerance de simplification selon le zoom demande par le client.
 *
 * Les paliers ne sont pas choisis au jugé : a un zoom donne, un degre couvre un
 * nombre connu de pixels, et simplifier en dessous du pixel ne retire rien de
 * visible. Au zoom 7 — la Guinee entiere a l'ecran — 220 m tiennent dans un pixel.
 *
 * Le gain mesure le 04/09/2026 : 2 366 ko de geometrie brute tombent a 307 ko au
 * zoom pays, en perdant 372 km sur 21 156 (1,76 %) qu'aucun ecran ne pourrait
 * afficher. Au zoom 16 et au-dela, aucune simplification : c'est la forme exacte
 * qu'on regarde.
 *
 * Un zoom absent ou aberrant retombe sur le palier le plus grossier plutot que sur
 * la geometrie brute : la valeur par defaut doit proteger le visiteur, pas le
 * penaliser.
 */
export function toleranceSelonZoom(zoom: unknown): number {
  const z = Number(zoom);
  if (!Number.isFinite(z) || z < 10) return 0.002;
  if (z < 13) return 0.0005;
  if (z < 16) return 0.0001;
  return 0;
}

export async function carteGeoHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const simplification = toleranceSelonZoom(req.query.zoom);
    const [troncons, pointsNoirs, chantiers, ouvrages] = await Promise.all([
      tronconsService.listGeo({ simplification }) as Promise<TronconGeoRow[]>,
      pointsNoirsService.listGeo() as Promise<PointNoirGeoRow[]>,
      chantiersService.listGeo() as Promise<ChantierGeoRow[]>,
      prisma.$queryRaw<OuvrageGeoRow[]>`
        SELECT o.id, o.nom, o.type, o.etat::text AS etat,
               ST_Y(o.geom) AS lat, ST_X(o.geom) AS lon
        FROM ouvrages o
        WHERE o."deletedAt" IS NULL AND o.geom IS NOT NULL
      `,
    ]);
    res.json({
      // Rendu explicite : le client doit pouvoir dire a l'utilisateur que le trace
      // affiche est simplifie, plutot que de laisser croire a une forme exacte.
      simplifieeDe: simplification,
      troncons: troncons.map((t) => ({
        id: t.id, code: t.code, nom: t.nom, classe: t.classe, etat: t.etat,
        longueurKm: t.longueurKm, region: t.region, geometry: t.geometry,
        etatDeclare: t.etatDeclare,
      })),
      pointsNoirs: pointsNoirs.map((p) => ({ id: p.id, gravite: p.gravite, region: p.region, lat: p.lat, lon: p.lon })),
      chantiers: chantiers.map((c) => ({
        id: c.id, statut: c.statut, avancementPct: c.avancementPct, region: c.region,
        geometry: c.geometry, approximate: c.approximate, lat: c.lat, lon: c.lon,
      })),
      ouvrages: ouvrages.map((o) => ({ id: o.id, nom: o.nom, type: o.type, etat: o.etat, lat: o.lat, lon: o.lon })),
    });
  } catch (err) {
    next(err);
  }
}

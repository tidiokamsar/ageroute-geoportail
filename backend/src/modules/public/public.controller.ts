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
export async function carteGeoHandler(_req: Request, res: Response, next: NextFunction) {
  try {
    const [troncons, pointsNoirs, chantiers, ouvrages] = await Promise.all([
      tronconsService.listGeo() as Promise<TronconGeoRow[]>,
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

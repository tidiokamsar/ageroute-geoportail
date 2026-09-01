import type { Request, Response, NextFunction } from "express";
import { tronconsService } from "../troncons/troncons.service";
import { pointsNoirsService } from "../points-noirs/points-noirs.service";
import { chantiersService } from "../chantiers/chantiers.service";

interface TronconGeoRow {
  id: string; code: string; nom: string; classe: string; etat: string;
  longueurKm: number; region: string | null; geometry: string | null;
}
interface PointNoirGeoRow {
  id: string; gravite: string; region: string | null; lat: number; lon: number;
}
interface ChantierGeoRow {
  id: string; statut: string; avancementPct: number; region: string | null;
  geometry: string | null; approximate: boolean; lat: number | null; lon: number | null;
}

/**
 * Aperçu public du réseau (pas d'authentification) — champs volontairement
 * réduits (pas d'entreprise/bailleur/montant/numContrat/observations/pk/
 * revêtement/trafic) : destiné à un aperçu cartographique embarqué (mini-carte
 * SharePoint), jamais à un usage de gestion. Le détail complet reste derrière
 * les endpoints authentifiés existants (/api/troncons, /api/chantiers, ...).
 */
export async function carteGeoHandler(_req: Request, res: Response, next: NextFunction) {
  try {
    const [troncons, pointsNoirs, chantiers] = await Promise.all([
      tronconsService.listGeo() as Promise<TronconGeoRow[]>,
      pointsNoirsService.listGeo() as Promise<PointNoirGeoRow[]>,
      chantiersService.listGeo() as Promise<ChantierGeoRow[]>,
    ]);
    res.json({
      troncons: troncons.map((t) => ({
        id: t.id, code: t.code, nom: t.nom, classe: t.classe, etat: t.etat,
        longueurKm: t.longueurKm, region: t.region, geometry: t.geometry,
      })),
      pointsNoirs: pointsNoirs.map((p) => ({ id: p.id, gravite: p.gravite, region: p.region, lat: p.lat, lon: p.lon })),
      chantiers: chantiers.map((c) => ({
        id: c.id, statut: c.statut, avancementPct: c.avancementPct, region: c.region,
        geometry: c.geometry, approximate: c.approximate, lat: c.lat, lon: c.lon,
      })),
    });
  } catch (err) {
    next(err);
  }
}

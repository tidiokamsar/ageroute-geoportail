import type { Request, Response, NextFunction } from "express";
import { perimetreDe } from "../territoire/territoire.service";
import { verifierTerritoire } from "../territoire/territoire.noyau";

/**
 * Controle d'acces territorial (A10) d'une route d'ECRITURE. A poser apres `requireAuth` et les
 * gardes de role et de module.
 *
 * `regions(req)` dit quelles regions l'ecriture touche (region d'avant, region d'apres, region
 * heritee du troncon ; `null` = inconnue). Il n'est appele QUE pour un compte regional : un compte
 * national (ADMIN, ou aucun rattachement) passe sans lecture supplementaire, comme avant.
 */
export function requireTerritoire(regions: (req: Request) => Promise<readonly (number | null | undefined)[]>) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) { res.status(401).json({ error: "Authentification requise" }); return; }
    try {
      const perimetre = await perimetreDe(req.user);
      if (perimetre.national) { next(); return; }
      const verdict = verifierTerritoire(perimetre, await regions(req));
      if (!verdict.ok) { res.status(403).json({ error: verdict.motif, code: verdict.code }); return; }
      next();
    } catch (err) {
      next(err);
    }
  };
}

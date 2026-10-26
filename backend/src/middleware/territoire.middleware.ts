import type { Request, Response, NextFunction } from "express";
import { perimetreDe } from "../territoire/territoire.service";
import { verifierTerritoire, type NatureAcces } from "../territoire/territoire.noyau";

/**
 * Controle d'acces territorial (A10) d'une route d'ECRITURE. A poser apres `requireAuth` et les
 * gardes de role et de module.
 *
 * `regions(req)` dit quelles regions l'ecriture touche (region d'avant, region d'apres, region
 * heritee du troncon ; `null` = inconnue). Il n'est appele QUE pour un compte regional : un compte
 * national (ADMIN, ou aucun rattachement) passe sans lecture supplementaire, comme avant.
 */
export function requireTerritoire(
  regions: (req: Request) => Promise<readonly (number | null | undefined)[]>,
  /** `lecture` : libelle neutre du refus pour une demande qui ne modifie rien (defaut : `ecriture`, libelles historiques). */
  options: { nature?: NatureAcces } = {},
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) { res.status(401).json({ error: "Authentification requise" }); return; }
    try {
      const perimetre = await perimetreDe(req.user);
      if (perimetre.national) { next(); return; }
      const verdict = verifierTerritoire(perimetre, await regions(req), options.nature);
      if (!verdict.ok) { res.status(403).json({ error: verdict.motif, code: verdict.code }); return; }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Controle territorial (A10) d'une route qui DESIGNE une ressource par son identifiant, en lecture
 * comme en ecriture. Hors perimetre (ou region inconnue), la ressource n'existe pas pour ce compte :
 * on repond `introuvable` (la MEME reponse que la route pour un identifiant inconnu), jamais 403, pour
 * ne pas reveler qu'elle existe.
 *
 * UNE RESSOURCE INEXISTANTE (`regions(req)` rend `[]`) REPOND ELLE AUSSI `introuvable`, pour un compte REGIONAL
 * (D9, point 5). Avant, elle « laissait passer » et la route rendait son propre resultat : sur une route qui valide
 * son corps avant de chercher la ressource (`/:id/statut`, `/:id/assigner`), un corps invalide donnait 404 pour un
 * ordre de travaux d'une autre region mais 400 pour un identifiant inconnu, et un compte regional pouvait donc
 * sonder l'existence des ressources des autres regions. Les deux cas rendent maintenant le meme statut et le meme
 * corps, et la validation du corps ne se fait qu'APRES. Un compte national passe sans lecture : il voit tout, il n'y
 * a rien a masquer, et la route rend son propre 404.
 *
 * Pour une creation, ou une region d'APRES (deplacement), utiliser `requireTerritoire` (403 et codes).
 * Un compte national passe sans lecture supplementaire.
 */
export function requireTerritoireMasque(
  regions: (req: Request) => Promise<readonly (number | null | undefined)[]>,
  introuvable: { status?: number; corps: unknown },
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) { res.status(401).json({ error: "Authentification requise" }); return; }
    try {
      const perimetre = await perimetreDe(req.user);
      if (perimetre.national) { next(); return; }
      const touchees = await regions(req);
      const verdict = verifierTerritoire(perimetre, touchees);
      if (touchees.length === 0 || !verdict.ok) { res.status(introuvable.status ?? 404).json(introuvable.corps); return; }
      next();
    } catch (err) {
      next(err);
    }
  };
}

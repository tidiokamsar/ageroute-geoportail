import type { Request, Response, NextFunction } from "express";
import { modulesAutorisesDe, moduleAutorise } from "../lib/access";
import type { ModuleKey } from "../lib/modules";

// A poser apres requireAuth sur chaque router de module. ADMIN passe toujours (un admin
// ne doit jamais pouvoir se bloquer lui-meme un module par erreur). Pour les autres
// roles : tableau modulesAutorises vide = aucune restriction (comportement historique,
// migration sans regression) ; sinon la cle du module doit y figurer explicitement.
export function requireModuleAccess(moduleKey: ModuleKey) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: "Authentification requise" });
      return;
    }
    try {
      // Regle partagee avec la recherche globale et le journal d'audit, via
      // lib/access : deux implementations separees finissaient par diverger.
      const modules = await modulesAutorisesDe(req.user);
      if (!moduleAutorise(modules, moduleKey)) {
        res.status(403).json({ error: "Accès à ce module non autorisé pour votre compte" });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

import type { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
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
    if (req.user.role === "ADMIN") {
      next();
      return;
    }
    try {
      const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { modulesAutorises: true } });
      if (!user || (user.modulesAutorises.length > 0 && !user.modulesAutorises.includes(moduleKey))) {
        res.status(403).json({ error: "Accès à ce module non autorisé pour votre compte" });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

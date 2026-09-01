import type { Request, Response, NextFunction } from "express";
import type { Role } from "@prisma/client";

// Usage : router.post("/", requireAuth, requireRole("ADMIN", "GESTIONNAIRE"), handler)
export function requireRole(...allowed: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "Authentification requise" });
      return;
    }
    if (!allowed.includes(req.user.role)) {
      res.status(403).json({ error: "Acces refuse pour votre role" });
      return;
    }
    next();
  };
}

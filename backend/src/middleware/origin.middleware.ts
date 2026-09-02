import type { Request, Response, NextFunction } from "express";
import { env } from "../config/env";

/**
 * P3-B : validation d'origine pour les endpoints porteurs du cookie de session.
 *
 * SameSite=Strict fait l'essentiel (un navigateur cross-site n'envoie pas le
 * cookie), mais HttpOnly n'est PAS une protection CSRF et SameSite ne couvre
 * pas tous les vecteurs (navigation same-site depuis un sous-domaine compromise,
 * anciens navigateurs). Defense en profondeur :
 *
 *   - Origin PRESENT et different de l'origine autorisee -> 403 immediat ;
 *   - Origin ABSENT -> autorise (clients non-navigateurs : curl, tests,
 *     applications serveur) ; la presence du cookie reste alors le seul
 *     sillage d'authentification, jamais une preuve d'origine frauduleuse ;
 *   - Origin egal a CORS_ORIGIN (ou a l'origine du proxy en dev) -> autorise.
 *
 * Ne rejette jamais sur l'ABSENCE : c'est l'etat normal de tout client
 * non-navigateur, et les tests d'integration.
 */
export function verifyOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (!origin) return next();

  const autorisees = originesAutorisees();
  if (autorisees.has(origin)) return next();

  res.status(403).json({ error: "Origine non autorisee" });
}

function originesAutorisees(): Set<string> {
  const liste = new Set<string>();
  if (env.CORS_ORIGIN) {
    for (const o of env.CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean)) {
      liste.add(o);
    }
  }
  return liste;
}

/**
 * GARDES EXPRESS DU WORKFLOW (lot B3). Deux gardes, aux roles distincts :
 *
 *   - `gardeReferent` : posee sur le routeur du module, juste apres l'authentification et la cle de module, donc AVANT toute route du socle et des
 *     dossiers de conflit. Elle resout le profil du compte (lu en base) ; un compte qui a au moins un rattachement ACTIF n'ouvre que les routes
 *     `/workflow/...` : toute autre route repond 403 `COMPTE_REFERENT_RESTREINT`, sans rien lire. Sans cela, un LECTEUR avec la cle de module lirait
 *     la carte, les analyses et les dossiers de TOUS les projets de son perimetre.
 *   - `gardeWorkflow(action)` : posee sur chaque route du workflow qui designe un projet, apres la garde territoriale du projet. Pour un referent,
 *     un projet auquel il n'est pas rattache repond la MEME 404 qu'un projet inconnu ; puis le droit de la matrice (403 `ACTION_NON_AUTORISEE`).
 *
 * Le contenu des reponses est ensuite filtre par les services (visibilite.noyau.ts) : ces gardes decident de l'ACCES a la route, pas des lignes.
 */

import type { NextFunction, Request, Response } from "express";
import { matriceEffective } from "./config";
import { autorise, type ActionWorkflow } from "./profils.noyau";
import { resoudreActeur } from "./referents.service";
import type { ActeurWorkflow } from "./communs";

/** Chemins (relatifs au routeur) qu'un compte rattache peut ouvrir : `/workflow/...` et `/<projet>/workflow/...`. */
export const CHEMIN_WORKFLOW = /^\/(?:workflow(?:\/|$)|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/workflow(?:\/|$))/i;

const acteurDeRequete = (req: Request) => ({ id: req.user!.id, role: req.user!.role, ip: req.ip });

/** Profil du compte pour cette requete (resolu une fois par la garde du routeur, repris ensuite). */
export async function acteurWorkflow(req: Request, res: Response): Promise<ActeurWorkflow> {
  const deja = res.locals.acteurWorkflow as ActeurWorkflow | undefined;
  if (deja) return deja;
  const a = await resoudreActeur(acteurDeRequete(req));
  res.locals.acteurWorkflow = a;
  return a;
}

export async function gardeReferent(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) { res.status(401).json({ error: "Authentification requise" }); return; }
  try {
    const a = await acteurWorkflow(req, res);
    if (a.referent && !CHEMIN_WORKFLOW.test(req.path)) {
      res.status(403).json({
        error: "Ce compte est rattaché à un concessionnaire : il n'ouvre que les routes du workflow (/workflow/...), jamais le socle ni les dossiers de conflit.",
        code: "COMPTE_REFERENT_RESTREINT",
      });
      return;
    }
    next();
  } catch (e) { next(e); }
}

/**
 * Droit de la matrice pour `action` (ou pour AU MOINS UNE des actions listees : un agent de terrain lit ses taches par `tache.executer` sans avoir
 * `workflow.lire`) ; pour un referent, rattachement au projet de l'URL (sinon 404 masque).
 */
export function gardeWorkflow(action: ActionWorkflow | readonly ActionWorkflow[]) {
  const actions = typeof action === "string" ? [action] : [...action];
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) { res.status(401).json({ error: "Authentification requise" }); return; }
    try {
      const a = await acteurWorkflow(req, res);
      const projet = req.params.id;
      if (a.referent && projet !== undefined && !a.rattachements.some((r) => r.projetId === projet)) {
        res.status(404).json({ error: "Projet introuvable", code: "PROJET_INTROUVABLE" });
        return;
      }
      if (!actions.some((x) => autorise(matriceEffective().matrice, x, a.profil))) {
        res.status(403).json({ error: "Votre profil n'a pas le droit d'effectuer cette action sur le workflow du projet.", code: "ACTION_NON_AUTORISEE", action: actions[0] });
        return;
      }
      next();
    } catch (e) { next(e); }
  };
}

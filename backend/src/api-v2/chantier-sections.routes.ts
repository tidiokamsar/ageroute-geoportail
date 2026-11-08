import { Router, type NextFunction, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { territoireChantierSection, territoireRetraitSection } from "../territoire/territoire.v2";
import { RefusSection, ajouter, lister, parTroncon, retirer } from "../chantiers/sections.service";

/**
 * Un chantier sur plusieurs troncons ou sections (BDRI, lot G) : `/api/v2/chantiers`.
 *
 *   GET  /:id/sections                    liens du chantier (en vigueur et retires)
 *   POST /:id/sections                    lier un troncon entier, une portion, ou un intervalle en metres
 *   POST /sections/:lienId/retrait        retirer un lien (motif), jamais l'effacer
 *   GET  /par-troncon/:tronconId          chantiers d'un troncon (principal et par section), pour sa fiche
 *
 * Lecture : module `chantiers`. Ecriture : ADMIN ou GESTIONNAIRE, chantier ET troncon dans le perimetre.
 */
export const chantierSectionsV2Router = Router();
chantierSectionsV2Router.use(requireAuth, requireModuleAccess("chantiers"));
const ecriture = requireRole("ADMIN", "GESTIONNAIRE");

function repondre(err: unknown, res: Response, next: NextFunction) {
  if (err instanceof RefusSection) { res.status(err.http).json({ error: err.message, code: err.code }); return; }
  next(err);
}

chantierSectionsV2Router.get("/par-troncon/:tronconId", async (req, res, next) => {
  try { res.json({ chantiers: await parTroncon(req.params.tronconId) }); } catch (err) { repondre(err, res, next); }
});

chantierSectionsV2Router.get("/:id/sections", async (req, res, next) => {
  try { res.json({ sections: await lister(req.params.id) }); } catch (err) { repondre(err, res, next); }
});

const corpsSection = z.object({
  tronconId: z.string().min(1).max(64),
  portionId: z.string().min(1).max(64).nullish(),
  debutM: z.number().min(0).max(10_000_000).nullish(),
  finM: z.number().min(0).max(10_000_000).nullish(),
  commentaire: z.string().max(1000).nullish(),
}).strict();

chantierSectionsV2Router.post("/:id/sections", ecriture, territoireChantierSection, async (req, res, next) => {
  try { res.status(201).json(await ajouter(req.params.id, corpsSection.parse(req.body), req.user!.id, req.ip)); } catch (err) { repondre(err, res, next); }
});

chantierSectionsV2Router.post("/sections/:lienId/retrait", ecriture, territoireRetraitSection, async (req, res, next) => {
  try {
    const { motif } = z.object({ motif: z.string().min(1).max(1000) }).strict().parse(req.body);
    res.json(await retirer(req.params.lienId, motif, req.user!.id, req.ip));
  } catch (err) { repondre(err, res, next); }
});

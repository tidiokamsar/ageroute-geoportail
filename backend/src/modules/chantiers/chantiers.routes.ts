import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { requireRole } from "../../middleware/rbac.middleware";
import { requireModuleAccess } from "../../middleware/module-access.middleware";
import { uploadExcel } from "../../middleware/upload.middleware";
import { createBulkRouter } from "../../lib/crud-factory";
import { requireTerritoireMasque } from "../../middleware/territoire.middleware";
import { filtreRegion } from "../../territoire/territoire.lecture";
import { regionsFiche } from "../../territoire/territoire.service";
import { chantiersService } from "./chantiers.service";
import {
  listHandler, getHandler, listGeoHandler, listSansLocalisationHandler, createHandler, updateHandler, deleteHandler,
  exportHandler, importHandler,
} from "./chantiers.controller";

export const chantiersRouter = Router();
chantiersRouter.use(requireAuth);
chantiersRouter.get("/stats", async (req, res, next) => {
  try {
    const { prisma } = await import("../../lib/prisma");
    const now = new Date();
    // Un compte regional ne compte que les chantiers de ses regions (aucun total national).
    const notDeleted = { deletedAt: null, ...(await filtreRegion(req.user!)) };
    const [total, enRetard, sansDates, linéaire] = await Promise.all([
      prisma.chantier.count({ where: notDeleted }),
      prisma.chantier.count({ where: { ...notDeleted, statut: "EN_COURS", dateFinPrevue: { lt: now } } }),
      prisma.chantier.count({ where: { ...notDeleted, OR: [{ dateDebutPrevue: null }, { dateFinPrevue: null }] } }),
      prisma.chantier.aggregate({ where: { ...notDeleted, pkDebut: { not: null }, pkFin: { not: null } }, _sum: { pkFin: true, pkDebut: true } }),
    ]);
    const pkFinSum = linéaire._sum.pkFin ?? 0;
    const pkDebutSum = linéaire._sum.pkDebut ?? 0;
    res.json({ total, enRetard, sansDates, linéaireTotalKm: Math.max(0, pkFinSum - pkDebutSum) });
  } catch (err) { next(err); }
});
chantiersRouter.get("/", listHandler);
chantiersRouter.get("/geo", listGeoHandler);
// Les chantiers qu'aucune position ne permet de placer sur la carte. Pendant
// necessaire de leur retrait : sans cette liste, les retirer reviendrait a les effacer.
// Meme niveau de garde que /geo, par coherence dans le module.
chantiersRouter.get("/sans-localisation", listSansLocalisationHandler);
// L'export telecharge toutes les colonnes financieres : module `chantiers` exige (la lecture, elle, masque les champs, voir
// chantiers.confidentialite.ts). Le perimetre regional est applique dans le handler.
chantiersRouter.get("/export", requireModuleAccess("chantiers"), exportHandler);
chantiersRouter.post("/import", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("chantiers"), uploadExcel, importHandler);
chantiersRouter.use(requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("chantiers"), createBulkRouter(chantiersService));
// Un chantier d'une autre region est INTROUVABLE (meme 404 et meme corps que pour un identifiant inconnu) pour un compte regional.
chantiersRouter.get("/:id", requireTerritoireMasque((req) => regionsFiche("chantier", req.params.id), { corps: { error: "Chantier introuvable" } }), getHandler);
chantiersRouter.post("/", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("chantiers"), createHandler);
chantiersRouter.put("/:id", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("chantiers"), updateHandler);
chantiersRouter.delete("/:id", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("chantiers"), deleteHandler);

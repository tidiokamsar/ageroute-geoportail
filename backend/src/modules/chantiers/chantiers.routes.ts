import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { requireRole } from "../../middleware/rbac.middleware";
import { requireModuleAccess } from "../../middleware/module-access.middleware";
import { uploadExcel } from "../../middleware/upload.middleware";
import { createBulkRouter } from "../../lib/crud-factory";
import { chantiersService } from "./chantiers.service";
import {
  listHandler, getHandler, listGeoHandler, createHandler, updateHandler, deleteHandler,
  exportHandler, importHandler,
} from "./chantiers.controller";

export const chantiersRouter = Router();
chantiersRouter.use(requireAuth);
chantiersRouter.get("/stats", async (_req, res, next) => {
  try {
    const { prisma } = await import("../../lib/prisma");
    const now = new Date();
    const notDeleted = { deletedAt: null };
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
chantiersRouter.get("/export", exportHandler);
chantiersRouter.post("/import", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("chantiers"), uploadExcel, importHandler);
chantiersRouter.use(requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("chantiers"), createBulkRouter(chantiersService));
chantiersRouter.get("/:id", getHandler);
chantiersRouter.post("/", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("chantiers"), createHandler);
chantiersRouter.put("/:id", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("chantiers"), updateHandler);
chantiersRouter.delete("/:id", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("chantiers"), deleteHandler);

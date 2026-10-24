import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { requireRole } from "../../middleware/rbac.middleware";
import { requireModuleAccess } from "../../middleware/module-access.middleware";
import { createBulkRouter } from "../../lib/crud-factory";
import { uploadPhoto } from "../../middleware/upload-photo.middleware";
import { plafondPhotos } from "../../middleware/quota-photos.middleware";
import { prisma } from "../../lib/prisma";
import { inspectionsService } from "./inspections.service";
import { listHandler, getHandler, createHandler, updateHandler, deleteHandler, addPhotoHandler, removePhotoHandler } from "./inspections.controller";
import { territoireInspection } from "../../territoire/territoire.v1";

export const inspectionsRouter = Router();
inspectionsRouter.use(requireAuth);
inspectionsRouter.get("/", requireModuleAccess("inspections"), listHandler);
inspectionsRouter.use(requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("inspections"), createBulkRouter(inspectionsService));
inspectionsRouter.get("/:id", requireModuleAccess("inspections"), getHandler);
// Les inspecteurs de terrain peuvent saisir des inspections, en plus des gestionnaires/admins
inspectionsRouter.post("/", requireRole("ADMIN", "GESTIONNAIRE", "INSPECTEUR"), requireModuleAccess("inspections"), territoireInspection, createHandler);
inspectionsRouter.put("/:id", requireRole("ADMIN", "GESTIONNAIRE", "INSPECTEUR"), requireModuleAccess("inspections"), territoireInspection, updateHandler);
inspectionsRouter.post(
  "/:id/photos",
  requireRole("ADMIN", "GESTIONNAIRE", "INSPECTEUR"),
  requireModuleAccess("inspections"),
  // `Inspection.photos` est un tableau de chaines : son plafond est sa longueur.
  plafondPhotos(async (req) => {
    const i = await prisma.inspection.findUnique({
      where: { id: req.params.id }, select: { photos: true },
    });
    return i ? i.photos.length : null;
  }),
  uploadPhoto,
  addPhotoHandler,
);
inspectionsRouter.delete("/:id/photos/:filename", requireRole("ADMIN", "GESTIONNAIRE", "INSPECTEUR"), requireModuleAccess("inspections"), removePhotoHandler);
inspectionsRouter.delete("/:id", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("inspections"), deleteHandler);

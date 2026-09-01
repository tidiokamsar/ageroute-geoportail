import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { requireRole } from "../../middleware/rbac.middleware";
import { requireModuleAccess } from "../../middleware/module-access.middleware";
import { createBulkRouter } from "../../lib/crud-factory";
import { uploadPhoto } from "../../middleware/upload-photo.middleware";
import { inspectionsService } from "./inspections.service";
import { listHandler, getHandler, createHandler, updateHandler, deleteHandler, addPhotoHandler, removePhotoHandler } from "./inspections.controller";

export const inspectionsRouter = Router();
inspectionsRouter.use(requireAuth);
inspectionsRouter.get("/", listHandler);
inspectionsRouter.use(requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("inspections"), createBulkRouter(inspectionsService));
inspectionsRouter.get("/:id", getHandler);
// Les inspecteurs de terrain peuvent saisir des inspections, en plus des gestionnaires/admins
inspectionsRouter.post("/", requireRole("ADMIN", "GESTIONNAIRE", "INSPECTEUR"), requireModuleAccess("inspections"), createHandler);
inspectionsRouter.put("/:id", requireRole("ADMIN", "GESTIONNAIRE", "INSPECTEUR"), requireModuleAccess("inspections"), updateHandler);
inspectionsRouter.post("/:id/photos", requireRole("ADMIN", "GESTIONNAIRE", "INSPECTEUR"), requireModuleAccess("inspections"), uploadPhoto, addPhotoHandler);
inspectionsRouter.delete("/:id/photos/:filename", requireRole("ADMIN", "GESTIONNAIRE", "INSPECTEUR"), requireModuleAccess("inspections"), removePhotoHandler);
inspectionsRouter.delete("/:id", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("inspections"), deleteHandler);

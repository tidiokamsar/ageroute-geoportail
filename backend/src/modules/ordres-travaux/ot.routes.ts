import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { requireRole } from "../../middleware/rbac.middleware";
import { requireModuleAccess } from "../../middleware/module-access.middleware";
import { uploadPhoto } from "../../middleware/upload-photo.middleware";
import {
  listHandler, getHandler, createHandler, updateHandler, assignHandler,
  changeStatutHandler, convertirHandler, addPhotoHandler, removePhotoHandler,
  deleteHandler, statsHandler, assignablesHandler,
} from "./ot.controller";

export const otRouter = Router();
otRouter.use(requireAuth, requireModuleAccess("ordres-travaux"));

otRouter.get("/", listHandler);
otRouter.get("/stats", statsHandler);
otRouter.get("/assignables", assignablesHandler);
otRouter.get("/:id", getHandler);

// Création : ADMIN/GESTIONNAIRE créent prêts à assigner, INSPECTEUR crée en brouillon
otRouter.post("/", requireRole("ADMIN", "GESTIONNAIRE", "INSPECTEUR"), createHandler);
otRouter.put("/:id", requireRole("ADMIN", "GESTIONNAIRE", "INSPECTEUR"), updateHandler);
otRouter.post("/:id/assigner", requireRole("ADMIN", "GESTIONNAIRE"), assignHandler);
otRouter.post("/:id/statut", requireRole("ADMIN", "GESTIONNAIRE", "INSPECTEUR"), changeStatutHandler);
otRouter.post("/:id/convertir-chantier", requireRole("ADMIN", "GESTIONNAIRE"), convertirHandler);
otRouter.post("/:id/photos", requireRole("ADMIN", "GESTIONNAIRE", "INSPECTEUR"), uploadPhoto, addPhotoHandler);
otRouter.delete("/:id/photos/:photoId", requireRole("ADMIN", "GESTIONNAIRE", "INSPECTEUR"), removePhotoHandler);
otRouter.delete("/:id", requireRole("ADMIN", "GESTIONNAIRE"), deleteHandler);

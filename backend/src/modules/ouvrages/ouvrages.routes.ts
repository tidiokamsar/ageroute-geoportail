import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { requireRole } from "../../middleware/rbac.middleware";
import { requireModuleAccess } from "../../middleware/module-access.middleware";
import { uploadExcel } from "../../middleware/upload.middleware";
import { uploadPhoto } from "../../middleware/upload-photo.middleware";
import { createBulkRouter } from "../../lib/crud-factory";
import { ouvragesService } from "./ouvrages.service";
import {
  listHandler, getHandler, listGeoHandler, createHandler, updateHandler, deleteHandler,
  exportHandler, importHandler, geolocateHandler, addPhotoHandler, removePhotoHandler,
} from "./ouvrages.controller";

export const ouvragesRouter = Router();
// Lecture ouverte (voir troncons.routes.ts) : OuvragePicker est utilisé par le module
// Inspections pour rattacher un ouvrage.
ouvragesRouter.use(requireAuth);
ouvragesRouter.get("/", listHandler);
ouvragesRouter.get("/geo", listGeoHandler);
ouvragesRouter.get("/export", exportHandler);
ouvragesRouter.post("/import", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("ouvrages"), uploadExcel, importHandler);
ouvragesRouter.use(requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("ouvrages"), createBulkRouter(ouvragesService));
ouvragesRouter.get("/:id", getHandler);
ouvragesRouter.post("/", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("ouvrages"), createHandler);
ouvragesRouter.put("/:id", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("ouvrages"), updateHandler);
ouvragesRouter.post("/:id/geolocate", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("ouvrages"), geolocateHandler);
ouvragesRouter.post("/:id/photos", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("ouvrages"), uploadPhoto, addPhotoHandler);
ouvragesRouter.delete("/:id/photos/:filename", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("ouvrages"), removePhotoHandler);
ouvragesRouter.delete("/:id", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("ouvrages"), deleteHandler);

import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { requireRole } from "../../middleware/rbac.middleware";
import { requireModuleAccess } from "../../middleware/module-access.middleware";
import { uploadExcel } from "../../middleware/upload.middleware";
import { createBulkRouter } from "../../lib/crud-factory";
import { postesService } from "./postes.service";
import {
  listHandler, getHandler, listGeoHandler, createHandler, updateHandler, deleteHandler,
  exportHandler, importHandler, geolocateHandler,
} from "./postes.controller";

export const postesRouter = Router();
postesRouter.use(requireAuth);
postesRouter.get("/", listHandler);
postesRouter.get("/geo", listGeoHandler);
postesRouter.get("/export", exportHandler);
postesRouter.post("/import", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("postes"), uploadExcel, importHandler);
postesRouter.use(requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("postes"), createBulkRouter(postesService));
postesRouter.get("/:id", getHandler);
postesRouter.post("/", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("postes"), createHandler);
postesRouter.put("/:id", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("postes"), updateHandler);
postesRouter.post("/:id/geolocate", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("postes"), geolocateHandler);
postesRouter.delete("/:id", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("postes"), deleteHandler);

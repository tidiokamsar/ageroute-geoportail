import { requireTerritoire, aLaCreation, importNational, surLObjet } from "../../governance/perimetre.service";
import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { requireRole } from "../../middleware/rbac.middleware";
import { requireModuleAccess } from "../../middleware/module-access.middleware";
import { uploadExcel } from "../../middleware/upload.middleware";
import { createBulkRouter } from "../../lib/crud-factory";
import { pointsNoirsService } from "./points-noirs.service";
import {
  listHandler, getHandler, listGeoHandler, createHandler, updateHandler, deleteHandler,
  exportHandler, importHandler, geolocateHandler,
} from "./points-noirs.controller";

export const pointsNoirsRouter = Router();
pointsNoirsRouter.use(requireAuth);
pointsNoirsRouter.get("/", listHandler);
pointsNoirsRouter.get("/geo", listGeoHandler);
pointsNoirsRouter.get("/export", exportHandler);
pointsNoirsRouter.post("/import", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("points-noirs"), requireTerritoire("POINT_NOIR", importNational), uploadExcel, importHandler);
pointsNoirsRouter.use(requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("points-noirs"), createBulkRouter(pointsNoirsService));
pointsNoirsRouter.get("/:id", getHandler);
pointsNoirsRouter.post("/", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("points-noirs"), requireTerritoire("POINT_NOIR", aLaCreation("POINT_NOIR")), createHandler);
pointsNoirsRouter.put("/:id", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("points-noirs"), requireTerritoire("POINT_NOIR", surLObjet("POINT_NOIR")), updateHandler);
pointsNoirsRouter.post("/:id/geolocate", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("points-noirs"), requireTerritoire("POINT_NOIR", surLObjet("POINT_NOIR")), geolocateHandler);
pointsNoirsRouter.delete("/:id", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("points-noirs"), requireTerritoire("POINT_NOIR", surLObjet("POINT_NOIR")), deleteHandler);

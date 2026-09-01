import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { requireRole } from "../../middleware/rbac.middleware";
import { requireModuleAccess } from "../../middleware/module-access.middleware";
import { uploadExcel } from "../../middleware/upload.middleware";
import { createBulkRouter } from "../../lib/crud-factory";
import { tronconsService } from "./troncons.service";
import {
  listHandler, getHandler, listGeoHandler, createHandler, updateHandler, deleteHandler,
  exportHandler, importHandler, ficheHandler, itineraireHandler, updateGeomHandler,
} from "./troncons.controller";

export const tronconsRouter = Router();

// La lecture (liste, fiche, geo, export) reste ouverte à tout utilisateur authentifié :
// de nombreux modules (Ouvrages, Chantiers, Postes...) referencent un tronçon via un
// sélecteur qui interroge cet endpoint — la restriction "module troncons" ne bloque
// donc que la page dédiée (masquée côté frontend) et les actions de modification.
tronconsRouter.use(requireAuth);
tronconsRouter.get("/", listHandler);
tronconsRouter.get("/geo", listGeoHandler);
tronconsRouter.get("/itineraire", itineraireHandler);
tronconsRouter.get("/export", exportHandler);
tronconsRouter.post("/import", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("troncons"), uploadExcel, importHandler);
tronconsRouter.use(requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("troncons"), createBulkRouter(tronconsService));
tronconsRouter.get("/:id/fiche", ficheHandler);
tronconsRouter.get("/:id", getHandler);
tronconsRouter.post("/", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("troncons"), createHandler);
tronconsRouter.put("/:id", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("troncons"), updateHandler);
tronconsRouter.patch("/:id/geom", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("troncons"), updateGeomHandler);
tronconsRouter.delete("/:id", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("troncons"), deleteHandler);

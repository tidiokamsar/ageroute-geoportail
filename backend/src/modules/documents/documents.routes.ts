import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { requireRole } from "../../middleware/rbac.middleware";
import { requireModuleAccess } from "../../middleware/module-access.middleware";
import { uploadDocument } from "../../middleware/upload-document.middleware";
import { listHandler, getHandler, createHandler, deleteHandler, downloadHandler } from "./documents.controller";

export const documentsRouter = Router();
documentsRouter.use(requireAuth);
documentsRouter.get("/", listHandler);
documentsRouter.get("/:id", getHandler);
documentsRouter.get("/:id/download", downloadHandler);
documentsRouter.post("/", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("documents"), uploadDocument, createHandler);
documentsRouter.delete("/:id", requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("documents"), deleteHandler);

import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { requireRole } from "../../middleware/rbac.middleware";
import { getSmtpHandler, putSmtpHandler, testSmtpHandler } from "./settings.controller";
import { gouvernanceValidationHandler } from "./gouvernance.controller";

export const adminSettingsRouter = Router();
adminSettingsRouter.use(requireAuth, requireRole("ADMIN"));

adminSettingsRouter.get("/settings/smtp", getSmtpHandler);
adminSettingsRouter.put("/settings/smtp", putSmtpHandler);
adminSettingsRouter.post("/settings/smtp/test", testSmtpHandler);

// Etat de la designation des validateurs. Reservee a ADMIN comme tout ce routeur :
// la liste des domaines NON designes est une carte des points faibles du controle de
// validation, et n'a rien a faire sur la sonde publique.
adminSettingsRouter.get("/gouvernance/validation", gouvernanceValidationHandler);

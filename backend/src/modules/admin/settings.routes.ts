import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { requireRole } from "../../middleware/rbac.middleware";
import { getSmtpHandler, putSmtpHandler, testSmtpHandler } from "./settings.controller";

export const adminSettingsRouter = Router();
adminSettingsRouter.use(requireAuth, requireRole("ADMIN"));

adminSettingsRouter.get("/settings/smtp", getSmtpHandler);
adminSettingsRouter.put("/settings/smtp", putSmtpHandler);
adminSettingsRouter.post("/settings/smtp/test", testSmtpHandler);

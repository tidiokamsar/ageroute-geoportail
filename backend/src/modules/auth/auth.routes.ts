import { Router } from "express";
import {
  loginHandler, refreshHandler, logoutHandler, logoutAllHandler, meHandler,
  twoFaLoginVerifyHandler, twoFaSetupHandler, twoFaConfirmHandler, twoFaDisableHandler,
} from "./auth.controller";
import { requireAuth } from "../../middleware/auth.middleware";

export const authRouter = Router();

/**
 * @openapi
 * /auth/login:
 *   post:
 *     summary: Connexion utilisateur
 *     tags: [Auth]
 */
authRouter.post("/login", loginHandler);
authRouter.post("/refresh", refreshHandler);
authRouter.post("/logout", logoutHandler);
// P3-A : coupe TOUTES les sessions refresh de l'utilisateur authentifié
// (tous appareils), avec journalisation SECURITY_EVENT.
authRouter.post("/logout-all", requireAuth, logoutAllHandler);
authRouter.get("/me", requireAuth, meHandler);

authRouter.post("/2fa/login-verify", twoFaLoginVerifyHandler);
authRouter.post("/2fa/setup", requireAuth, twoFaSetupHandler);
authRouter.post("/2fa/confirm", requireAuth, twoFaConfirmHandler);
authRouter.post("/2fa/disable", requireAuth, twoFaDisableHandler);

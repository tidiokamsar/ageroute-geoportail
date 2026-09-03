import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { voirieGeoHandler, voirieStatsHandler } from "./voirie-locale.controller";

/** Montage authentifie, pour le geoportail interne. La variante publique vit dans
 *  modules/public/public.routes.ts et partage les memes handlers. */
export const voirieLocaleRouter = Router();

voirieLocaleRouter.get("/geo", requireAuth, voirieGeoHandler);
voirieLocaleRouter.get("/stats", requireAuth, voirieStatsHandler);

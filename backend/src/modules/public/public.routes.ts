import { Router } from "express";
import rateLimit from "express-rate-limit";
import { carteGeoHandler } from "./public.controller";

// Routes PUBLIQUES : aucun requireAuth (contrairement à tous les autres
// routers de l'API). Limiter le débit ici puisque, sans authentification,
// rien d'autre ne protège la base contre un usage abusif.
export const publicRouter = Router();
publicRouter.use(rateLimit({ windowMs: 60 * 1000, max: 60 }));
publicRouter.get("/carte/geo", carteGeoHandler);

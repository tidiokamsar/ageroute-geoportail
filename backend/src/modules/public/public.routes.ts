import { Router } from "express";
import rateLimit from "express-rate-limit";
import { carteGeoHandler } from "./public.controller";
import { voirieGeoHandler } from "../voirie-locale/voirie-locale.controller";

// Routes PUBLIQUES : aucun requireAuth (contrairement à tous les autres
// routers de l'API). Limiter le débit ici puisque, sans authentification,
// rien d'autre ne protège la base contre un usage abusif.
export const publicRouter = Router();
publicRouter.use(rateLimit({ windowMs: 60 * 1000, max: 60 }));
publicRouter.get("/carte/geo", carteGeoHandler);

// Voirie locale : meme handler que le geoportail, memes garde-fous. La donnee est
// deja publique — c'est de l'OpenStreetMap — et le cadrage par emprise, la
// simplification et le plafond d'objets protegent la base ici comme la-bas.
publicRouter.get("/voirie-locale/geo", voirieGeoHandler);

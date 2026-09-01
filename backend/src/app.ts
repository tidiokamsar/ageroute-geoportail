import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import swaggerUi from "swagger-ui-express";
import swaggerJsdoc from "swagger-jsdoc";
import { env } from "./config/env";
import { authRouter } from "./modules/auth/auth.routes";
import { regionsRouter } from "./modules/regions/regions.routes";
import { tronconsRouter } from "./modules/troncons/troncons.routes";
import { ouvragesRouter } from "./modules/ouvrages/ouvrages.routes";
import { pointsNoirsRouter } from "./modules/points-noirs/points-noirs.routes";
import { postesRouter } from "./modules/postes/postes.routes";
import { chantiersRouter } from "./modules/chantiers/chantiers.routes";
import { inspectionsRouter } from "./modules/inspections/inspections.routes";
import { dashboardRouter } from "./modules/dashboard/dashboard.routes";
import { marchesRouter } from "./modules/marches/marches.routes";
import { adminSettingsRouter } from "./modules/admin/settings.routes";
import { otRouter } from "./modules/ordres-travaux/ot.routes";
import { usersRouter } from "./modules/users/users.routes";
import { auditRouter } from "./modules/audit/audit.routes";
import { searchRouter } from "./modules/search/search.routes";
import { documentsRouter } from "./modules/documents/documents.routes";
import { photosRouter } from "./modules/photos/photos.routes";
import { publicRouter } from "./modules/public/public.routes";
import { healthRouter } from "./modules/health/health.routes";
import { errorHandler, notFoundHandler } from "./middleware/error.middleware";
import fs from "fs";
import { UPLOAD_DIR } from "./middleware/upload-document.middleware";
import { PHOTOS_UPLOAD_DIR } from "./middleware/upload-photo.middleware";

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(PHOTOS_UPLOAD_DIR, { recursive: true });

export function createApp() {
  const app = express();

  // Derriere Traefik (reverse proxy) : necessaire pour que express-rate-limit et req.ip
  // identifient la vraie IP cliente via X-Forwarded-For plutot que l'IP du proxy.
  app.set("trust proxy", 1);

  // CSP explicite plutot que les defauts helmet : autorise le strict necessaire a
  // Swagger UI (style/script inline, polices data:) sans ouvrir sur des origines tierces.
  // L'API ne sert que du JSON hors /api/docs, donc une politique stricte ne casse rien
  // d'autre. Le HSTS force HTTPS cote navigateur pour toute reponse de cette API.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          fontSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      hsts: { maxAge: 15552000, includeSubDomains: true }, // 180 jours
    })
  );
  // Compression avant toute route : /api/public/carte/geo renvoyait 2,8 Mo de GeoJSON
  // non compresse, sur un public qui consulte majoritairement en 3G. Le GeoJSON est du
  // texte tres repetitif, gzip y gagne l'essentiel. Place ici pour couvrir toutes les
  // reponses, y compris les erreurs.
  app.use(compression());
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
  app.use(express.json({ limit: "5mb" }));
  app.use(morgan(env.NODE_ENV === "development" ? "dev" : "combined"));

  app.use(
    "/api/auth/login",
    rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: "Trop de tentatives, reessayez plus tard" } })
  );
  // Un code TOTP a 6 chiffres : sans limite, l'endpoint de verification serait
  // bruteforcable pendant la validite du challenge (5 min). Meme garde que /login.
  app.use(
    "/api/auth/2fa/login-verify",
    rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: "Trop de tentatives, reessayez plus tard" } })
  );

  // Sonde d'etat : voir modules/health. Elle repondait "ok" sans rien verifier,
  // donc "ok" meme base arretee.
  app.use("/api/health", healthRouter);

  const swaggerSpec = swaggerJsdoc({
    definition: {
      openapi: "3.0.0",
      info: { title: "Console BDRI API", version: "0.1.0", description: "API de gestion du patrimoine routier - AGEROUTE Guinee" },
      servers: [{ url: "/api" }],
    },
    apis: ["./src/modules/**/*.routes.ts"],
  });
  app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

  app.use("/api/auth", authRouter);
  app.use("/api/regions", regionsRouter);
  app.use("/api/troncons", tronconsRouter);
  app.use("/api/ouvrages", ouvragesRouter);
  app.use("/api/points-noirs", pointsNoirsRouter);
  app.use("/api/postes", postesRouter);
  app.use("/api/chantiers", chantiersRouter);
  app.use("/api/inspections", inspectionsRouter);
  app.use("/api/dashboard", dashboardRouter);
  app.use("/api", marchesRouter);
  app.use("/api/admin", adminSettingsRouter);
  app.use("/api/ordres-travaux", otRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/audit", auditRouter);
  app.use("/api/search", searchRouter);
  app.use("/api/documents", documentsRouter);
  app.use("/api/photos", photosRouter);
  app.use("/api/public", publicRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

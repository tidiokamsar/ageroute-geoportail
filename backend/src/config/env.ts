import { z } from "zod";
import "dotenv/config";
import {
  PLAFOND_PHOTOS_PAR_OBJET_DEFAUT, PLAFOND_DISQUE_MIO_DEFAUT,
} from "../lib/quota-photos";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  /** Origines autorisees en LECTURE sur /api/public, sans cookie (liste separee par des virgules). */
  PUBLIC_CORS_ORIGINS: z.string().default("https://ageroutegn.sharepoint.com"),
  /**
   * Metadonnees ISO 19115 (/api/public/metadonnees). Les deux sont FACULTATIVES et sans valeur par
   * defaut : tant qu'elles ne sont pas renseignees, les fiches sortent avec gco:nilReason et la
   * liste des lacunes, plutot qu'avec une adresse inventee.
   */
  METADATA_CONTACT_EMAIL: z.preprocess((v) => (v === "" ? undefined : v), z.string().email().optional()),
  PUBLIC_BASE_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET doit faire au moins 32 caracteres"),
  JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET doit faire au moins 32 caracteres"),
  JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),

  // SMTP optionnel : si absent, les notifications s'impriment en log au lieu d'échouer
  // (permet de deployer sans bloquer sur une config mail pas encore prete).
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default("BDRI AGEROUTE <no-reply@ageroute.gov.gn>"),

  // Plafonds de stockage des photos. Le middleware n'en avait qu'un, `fileSize` a 8 Mio
  // PAR FICHIER, et rien ne bornait le total : l'application de terrain synchronise
  // seule, et une file locale qui se rejoue en boucle televerse sans qu'aucun humain
  // regarde. Le disque heberge aussi PostgreSQL et le fond de carte public.
  //
  // Le cahier des charges ne fixe aucun seuil de media : ces valeurs sont prudentes et
  // reglables, elles ne valent pas un arbitrage metier. Zero vaut « pas de plafond »,
  // pour qu'une variable mal saisie n'arrete pas la collecte d'un pays entier.
  PHOTOS_MAX_PAR_OBJET: z.coerce.number().int().min(0)
    .default(PLAFOND_PHOTOS_PAR_OBJET_DEFAUT),
  PHOTOS_PLAFOND_DISQUE_MIO: z.coerce.number().int().min(0)
    .default(PLAFOND_DISQUE_MIO_DEFAUT),

  // Limitation de debit, PAR ADRESSE (derriere Traefik, `trust proxy` = 1 lit X-Forwarded-For).
  // Zero desactive le plafond concerne, sur le meme principe que les plafonds photos : une
  // variable mal saisie ne doit pas couper la collecte de tout un pays. Voir
  // middleware/rate-limit.middleware.ts pour le raisonnement des valeurs par defaut.
  RATE_LIMIT_REFRESH_MAX: z.coerce.number().int().min(0).default(60),
  RATE_LIMIT_REFRESH_FENETRE_MIN: z.coerce.number().int().min(1).default(15),
  RATE_LIMIT_V2_MAX: z.coerce.number().int().min(0).default(1200),
  RATE_LIMIT_V2_FENETRE_SEC: z.coerce.number().int().min(1).default(60),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Configuration invalide (.env) :", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

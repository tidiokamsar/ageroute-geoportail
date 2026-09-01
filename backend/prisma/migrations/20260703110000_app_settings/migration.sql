-- Store clé/valeur pour les paramètres configurables depuis l'interface (SMTP, etc.)
CREATE TABLE IF NOT EXISTS "app_settings" (
  "key"       TEXT PRIMARY KEY,
  "value"     TEXT NOT NULL,
  "updatedBy" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

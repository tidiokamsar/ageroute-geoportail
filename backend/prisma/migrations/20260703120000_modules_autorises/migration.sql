-- Restriction d'accès par module, par utilisateur (tableau vide = aucune restriction)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "modulesAutorises" TEXT[] NOT NULL DEFAULT '{}';

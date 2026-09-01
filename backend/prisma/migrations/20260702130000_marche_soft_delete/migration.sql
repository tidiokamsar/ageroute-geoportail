-- Ajout soft-delete sur marches (cohérence avec le reste du patrimoine)
ALTER TABLE "marches" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "marches_deletedAt_idx" ON "marches"("deletedAt");

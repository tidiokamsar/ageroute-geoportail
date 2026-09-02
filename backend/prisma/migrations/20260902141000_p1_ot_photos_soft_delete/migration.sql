-- P1-02 : retrait logique des photos d'ordre de travaux.
--
-- Une photo d'OT (avant/pendant/après) est une preuve d'exécution pour les
-- audits et les bailleurs : la ligne ne doit jamais disparaitre physiquement.
-- Le fichier reste sur disque dans tous les cas ; seule la reference devient
-- invisible dans les listes operationnelles.
ALTER TABLE "ot_photos" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "ot_photos_deletedAt_idx" ON "ot_photos"("deletedAt");

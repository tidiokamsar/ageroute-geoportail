-- RETOUR ARRIERE de `20261103400000_correctifs_sources_territoires` (correctifs apres la revue T1+S1 du 09/11/2026).
--
-- CE QUI EST PERDU :
--   - B1 : le lien d'un dossier DIVERGENCE_SOURCES vers le jeu B de sa comparaison (`conflits_projet.jeuSourceBId`) ; il se deduit de la comparaison,
--     rien n'est perdu de ce qui a ete decide ou mesure.
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261103400000_correctifs_sources_territoires.sql

-- ===== B1 =====
DROP TRIGGER IF EXISTS conflits_projet_jeu_source_b ON "conflits_projet";
DROP FUNCTION IF EXISTS conflits_projet_jeu_source_b();
ALTER TABLE "conflits_projet" DROP CONSTRAINT IF EXISTS "cp_jeu_source_b";
DROP INDEX IF EXISTS "conflits_projet_jeuSourceBId_idx";
ALTER TABLE "conflits_projet" DROP COLUMN IF EXISTS "jeuSourceBId";

-- Apres une descente reussie, retirer la ligne de l'historique de Prisma :
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261103400000_correctifs_sources_territoires';

-- Descente de 20261022020000 : retirer le controle de coherence des propositions de teledetection.
-- Aucune donnee n'est touchee : un declencheur, sa fonction et une vue. IF EXISTS : idempotent.

DROP VIEW IF EXISTS "coherence_teledetection";
DROP TRIGGER IF EXISTS propositions_teledetection_coherence ON "propositions_teledetection";
DROP FUNCTION IF EXISTS propositions_teledetection_coherence();

-- Et la ligne de `_prisma_migrations` :
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261022020000_teledetection_coherence';

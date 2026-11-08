-- Descente de 20261028120000 : retirer la vue de qualite des methodes et la constante de seuil.
-- Aucune donnee n'est touchee (une vue et une fonction). IF EXISTS : idempotent.
-- La vue historique `precision_teledetection` n'est pas concernee.

DROP VIEW IF EXISTS "qualite_methodes_eo";
DROP FUNCTION IF EXISTS eo_seuil_echantillon_taux();

-- Et la ligne de `_prisma_migrations` :
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261028120000_eo_qualite_methodes';

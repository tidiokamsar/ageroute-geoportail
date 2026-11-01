-- RETOUR ARRIERE de `20261020020000_index_gist_complets`.
--
-- CE QUI EST PERDU : six index. Aucune donnee. Les requetes de proximite sur ces tables
-- repassent en parcours sequentiel.
--
-- EXECUTEE ET VERIFIEE en aller-retour le 20/10/2026 sur la base de developpement.

DROP INDEX IF EXISTS "chantiers_geom_geography_gist";
DROP INDEX IF EXISTS "missions_itineraire_geography_gist";
DROP INDEX IF EXISTS "ouvrages_geom_geography_gist";
DROP INDEX IF EXISTS "points_noirs_geom_geography_gist";
DROP INDEX IF EXISTS "postes_geom_geography_gist";
DROP INDEX IF EXISTS "propositions_localisation_geom_geography_gist";

-- Et la ligne de `_prisma_migrations` :
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261020020000_index_gist_complets';

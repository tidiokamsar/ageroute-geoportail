-- RETOUR ARRIERE de `20261020010000_metre_utm`.
--
-- CE QUI EST PERDU : les deux fonctions de metre UTM. Aucune donnee : elles ne stockent rien.
-- Un appelant de `POST /api/v2/geo/metre` echouerait ensuite : descendre l'application avec.
--
-- EXECUTEE ET VERIFIEE en aller-retour le 20/10/2026 sur la base de developpement.

DROP FUNCTION IF EXISTS metre_utm(geometry);
DROP FUNCTION IF EXISTS epsg_utm(geometry);

-- Et la ligne de `_prisma_migrations` :
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261020010000_metre_utm';

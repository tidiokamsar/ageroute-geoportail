-- RETOUR ARRIERE de `20260901170000_index_spatial_troncons_geography`.
--
-- Cree l'index GiST troncons_geom_geography_idx sur (geom::geography).
--
-- CE QUI EST PERDU : RIEN en donnees. Les requetes ST_DWithin en geography retomberaient sur un parcours complet : 20 ms deviendraient plusieurs secondes sur le reseau national.
--
-- A SAVOIR : Reconstruire cet index sur 261 000 troncons prend bien plus que les quelques millisecondes mesurees sur 1 690 lignes : a faire hors heures de pointe.
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20260901170000_index_spatial_troncons_geography.sql
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique.

DROP INDEX IF EXISTS "troncons_geom_geography_idx";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260901170000_index_spatial_troncons_geography';

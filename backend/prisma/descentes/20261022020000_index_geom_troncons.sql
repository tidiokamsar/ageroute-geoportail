-- RETOUR ARRIERE de `20261022020000_index_geom_troncons`.
--
-- CE QUI EST PERDU : aucune donnee. Le rattachement ponctuel sans emprise retombe a un balayage de
-- la table (p95 831,9 ms mesure a 261 387 troncons, contre 0,85 ms avec l'index).
--
-- Verifiee par le banc `verifier.sh`.

DROP INDEX IF EXISTS "troncons_geom_gist";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261022020000_index_geom_troncons';

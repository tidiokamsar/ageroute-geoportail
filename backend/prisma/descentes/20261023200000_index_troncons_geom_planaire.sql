-- RETOUR ARRIERE de `20261023200000_index_troncons_geom_planaire`.
--
-- CE QUI EST PERDU : un index. Aucune donnee. L'appariement sur le reseau complet (`reseau = "tout"`),
-- le chargement du graphe de deviation et l'analyse de trace repassent en parcours sequentiel
-- (voir docs/performance/MESURES-A15-A20.md pour l'ordre de grandeur mesure).

DROP INDEX IF EXISTS "troncons_geom_gist";

-- Et la ligne de `_prisma_migrations` :
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261023200000_index_troncons_geom_planaire';

-- RETOUR ARRIERE de `20261019010000_info_route_bulletin`.
--
-- CE QUI EST PERDU : tout ce qui a ete dit au public (publications Info Route, mises a jour,
-- retraits) et l'archive des bulletins. C'est la trace de ce qu'AGEROUTE a annonce aux usagers,
-- et elle a une valeur probatoire. Compter avant :
--
--   SELECT (SELECT count(*) FROM publications_info_route) AS publications,
--          (SELECT count(*) FROM bulletins_routiers) AS bulletins;
--
-- Si l'un de ces comptes n'est pas nul : sauvegarde verifiee et autorisation explicite
-- (paragraphe A.5.2). La main courante n'est pas touchee.
--
-- EXECUTEE ET VERIFIEE en aller-retour le 19/10/2026 sur la base de developpement.

DROP TRIGGER IF EXISTS bulletins_routiers_fige ON "bulletins_routiers";
DROP FUNCTION IF EXISTS bulletins_routiers_fige();
DROP TABLE IF EXISTS "bulletins_routiers";
DROP VIEW IF EXISTS "info_route_courante";
DROP TRIGGER IF EXISTS info_route_ajout_seul ON "publications_info_route";
DROP FUNCTION IF EXISTS info_route_ajout_seul();
DROP TABLE IF EXISTS "publications_info_route";

-- Et la ligne de `_prisma_migrations` :
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261019010000_info_route_bulletin';

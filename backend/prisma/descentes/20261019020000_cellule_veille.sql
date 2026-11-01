-- RETOUR ARRIERE de `20261019020000_cellule_veille`.
--
-- CE QUI EST PERDU : le tableau des astreintes, les regles d'escalade saisies, le journal des
-- escalades et l'historique des modes de veille. Le journal des escalades dit qui devait reagir a
-- quel evenement, et quand : valeur probatoire. Compter avant :
--
--   SELECT (SELECT count(*) FROM astreintes) AS astreintes, (SELECT count(*) FROM regles_escalade) AS regles,
--          (SELECT count(*) FROM escalades) AS escalades, (SELECT count(*) FROM modes_veille) AS modes;
--
-- Comptes non nuls : sauvegarde verifiee et autorisation explicite (paragraphe A.5.2).
--
-- EXECUTEE ET VERIFIEE en aller-retour le 19/10/2026 sur la base de developpement.

DROP TRIGGER IF EXISTS modes_veille_ajout_seul ON "modes_veille";
DROP TRIGGER IF EXISTS escalades_ajout_seul ON "escalades";
DROP TABLE IF EXISTS "modes_veille";
DROP TABLE IF EXISTS "escalades";
DROP TABLE IF EXISTS "regles_escalade";
DROP TABLE IF EXISTS "astreintes";
DROP FUNCTION IF EXISTS veille_ajout_seul();

-- Et la ligne de `_prisma_migrations` :
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261019020000_cellule_veille';

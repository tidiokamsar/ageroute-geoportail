-- RETOUR ARRIERE de `20260904090000_reseau_reference_index`.
--
-- Cree deux index partiels : troncons_reseau_reference_idx et voirie_locale_tronconId_idx.
--
-- CE QUI EST PERDU : RIEN en donnees. Les requetes du reseau classe seraient plus lentes.
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20260904090000_reseau_reference_index.sql
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique.

DROP INDEX IF EXISTS "troncons_reseau_reference_idx";
DROP INDEX IF EXISTS "voirie_locale_tronconId_idx";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260904090000_reseau_reference_index';

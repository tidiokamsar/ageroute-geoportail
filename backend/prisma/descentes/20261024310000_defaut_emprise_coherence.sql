-- RETOUR ARRIERE de `20261024310000_defaut_emprise_coherence`.
--
-- Ajoute la contrainte CHECK defaut_methode_emprise_exige_emprise sur defauts.
--
-- CE QUI EST PERDU : rien. Une contrainte ne porte aucune donnee ; la retirer ne supprime aucune ligne. Ce qui disparait est la garantie « methode EMPRISE_UTM => une emprise existe ».
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261024310000_defaut_emprise_coherence.sql
--
-- A executer par le banc `verifier.sh` (voir README.md) ; resultat consigne dans docs/scenarios/SCENARIOS-PARTIELS.md.

ALTER TABLE "defauts" DROP CONSTRAINT IF EXISTS "defaut_methode_emprise_exige_emprise";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261024310000_defaut_emprise_coherence';

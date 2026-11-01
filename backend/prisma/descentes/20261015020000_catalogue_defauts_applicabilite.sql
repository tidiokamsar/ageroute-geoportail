-- RETOUR ARRIERE de `20261015020000_catalogue_defauts_applicabilite`.
--
-- Retire la colonne et sa contrainte. CE QUI EST PERDU : la valeur d'applicabilite posee sur
-- chaque type -- par le script de peuplement ou par l'administration. Compter avant :
--
--   SELECT "applicabilite", count(*) FROM catalogue_defauts GROUP BY 1;
--
-- Si des lignes portent autre chose que TOUS, la descente efface une decision d'administration ;
-- elle exige alors une sauvegarde verifiee et une autorisation explicite (paragraphe A.5.2).
--
-- Les dix-huit types semes par le script ne sont PAS retires ici : ils ne viennent pas de cette
-- migration. Pour les retirer sciemment, et seulement s'ils ne sont references par aucun
-- defaut :
--
--   DELETE FROM catalogue_defauts WHERE source = 'mandat_v10_7_4'
--     AND id NOT IN (SELECT "catalogueId" FROM defauts WHERE "catalogueId" IS NOT NULL);

ALTER TABLE "catalogue_defauts" DROP CONSTRAINT IF EXISTS "catalogue_applicabilite_connue";
ALTER TABLE "catalogue_defauts" DROP COLUMN IF EXISTS "applicabilite";

-- Et la ligne de `_prisma_migrations` :
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261015020000_catalogue_defauts_applicabilite';

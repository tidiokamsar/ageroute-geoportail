-- RETOUR ARRIERE de `20261015030000_inspections_typees`.
--
-- Retire les quatre colonnes, leurs contraintes et leurs index. CE QUI EST PERDU : le type de
-- chaque inspection, la reference d'intervention des inspections post-travaux, et les IRI
-- estimes -- des valeurs de terrain qui ne se reconstituent pas. Compter avant :
--
--   SELECT "type", count(*), count("interventionRef") AS avec_intervention,
--          count("iriEstime") AS avec_iri
--     FROM inspections GROUP BY 1;
--
-- Si une ligne porte un type autre que GENERALE, une reference ou un IRI, la descente efface un
-- constat de terrain : elle exige une sauvegarde verifiee et une autorisation explicite
-- (paragraphe A.5.2).
--
-- EXECUTEE ET VERIFIEE en aller-retour le 15/10/2026 sur la base de developpement.

DROP INDEX IF EXISTS "inspections_interventionRef_idx";
DROP INDEX IF EXISTS "inspections_type_idx";
ALTER TABLE "inspections" DROP CONSTRAINT IF EXISTS "inspection_iri_coherent";
ALTER TABLE "inspections" DROP CONSTRAINT IF EXISTS "inspection_post_travaux_complete";
ALTER TABLE "inspections" DROP CONSTRAINT IF EXISTS "inspection_type_connu";
ALTER TABLE "inspections"
  DROP COLUMN IF EXISTS "iriMethode",
  DROP COLUMN IF EXISTS "iriEstime",
  DROP COLUMN IF EXISTS "interventionRef",
  DROP COLUMN IF EXISTS "type";

-- Et la ligne de `_prisma_migrations` :
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261015030000_inspections_typees';

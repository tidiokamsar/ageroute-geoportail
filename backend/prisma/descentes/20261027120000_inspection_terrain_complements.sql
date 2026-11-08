-- RETOUR ARRIERE de `20261027120000_inspection_terrain_complements`.
--
-- CE QUI EST PERDU : pour chaque inspection, le constat des defauts (aucun / non inspecte / inconnu / non
-- applicable), la methode et les conditions d'observation, la section et la mission de rattachement, et le statut
-- de validation. Le journal `validations` n'est pas touche : les decisions y restent.
--
-- GARDE : la descente REFUSE de s'executer si une inspection porte l'une de ces valeurs. Pour passer outre, apres
-- sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261027120000_inspection_terrain_complements.sql
--
-- GARDE-TEST: INSERT INTO "users" ("id","email","nomComplet","passwordHash","role","updatedAt") VALUES ('g-u','g@local.invalid','x','x','GESTIONNAIRE',now()); INSERT INTO "inspections" ("id","inspecteurId","dateInspection","etatObserve","constatDefauts") VALUES ('gi','g-u',now(),'BON','AUCUN_DEFAUT_OBSERVE');

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT count(*) FROM "inspections"
   WHERE "constatDefauts" IS NOT NULL OR "methodeObservation" IS NOT NULL OR "conditionsObservation" IS NOT NULL
      OR "missionId" IS NOT NULL OR "portionId" IS NOT NULL OR "debutM" IS NOT NULL OR "statutValidation" IS NOT NULL
    INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % inspection(s) portent un constat, une section, une mission ou une validation. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

DROP INDEX IF EXISTS "inspections_statutValidation_idx";
DROP INDEX IF EXISTS "inspections_missionId_idx";
ALTER TABLE "inspections"
  DROP CONSTRAINT IF EXISTS "inspection_section_une_definition",
  DROP CONSTRAINT IF EXISTS "inspection_section_ordre",
  DROP CONSTRAINT IF EXISTS "inspection_section_bornes",
  DROP CONSTRAINT IF EXISTS "inspection_methode_connue",
  DROP CONSTRAINT IF EXISTS "inspection_constat_connu",
  DROP COLUMN IF EXISTS "statutValidation",
  DROP COLUMN IF EXISTS "finM",
  DROP COLUMN IF EXISTS "debutM",
  DROP COLUMN IF EXISTS "portionId",
  DROP COLUMN IF EXISTS "missionId",
  DROP COLUMN IF EXISTS "conditionsObservation",
  DROP COLUMN IF EXISTS "methodeObservation",
  DROP COLUMN IF EXISTS "constatDefauts";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261027120000_inspection_terrain_complements';

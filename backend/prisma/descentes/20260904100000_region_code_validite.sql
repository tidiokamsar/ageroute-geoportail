-- RETOUR ARRIERE de `20260904100000_region_code_validite`.
--
-- Ajoute a regions code, validFrom, validTo, source, sourceDate, et deux index.
--
-- CE QUI EST PERDU : les codes officiels des regions et leur fenetre de validite.
--
-- GARDE : la descente REFUSE de s'executer si des donnees seraient detruites. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20260904100000_region_code_validite.sql
--
-- GARDE-TEST: INSERT INTO "regions" ("nom","code") VALUES ('zz','GN-X');
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique. Garde eprouvee avec une donnee fabriquee.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "regions" WHERE num_nonnulls("code", "validFrom", "validTo", "source", "sourceDate") > 0) INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % region(s) portent un code ou une validite. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

DROP INDEX IF EXISTS "regions_code_key";
DROP INDEX IF EXISTS "regions_validite_idx";
ALTER TABLE "regions"
  DROP COLUMN IF EXISTS "code",
  DROP COLUMN IF EXISTS "validFrom",
  DROP COLUMN IF EXISTS "validTo",
  DROP COLUMN IF EXISTS "source",
  DROP COLUMN IF EXISTS "sourceDate";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260904100000_region_code_validite';

-- RETOUR ARRIERE de `20260905120000_ouvrage_provenance`.
--
-- Ajoute a ouvrages sourceType, sourceReference, sourceConfidence, sourceDetectedAt et deux index.
--
-- CE QUI EST PERDU : la provenance des ouvrages d'art.
--
-- GARDE : la descente REFUSE de s'executer si des donnees seraient detruites. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20260905120000_ouvrage_provenance.sql
--
-- GARDE-TEST: INSERT INTO "ouvrages" ("id","nom","type","regionId","updatedAt","sourceReference") VALUES ('g1','x','PONT',1,now(),'ouvrage_x:1');
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique. Garde eprouvee avec une donnee fabriquee.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "ouvrages" WHERE num_nonnulls("sourceType", "sourceReference", "sourceConfidence", "sourceDetectedAt") > 0) INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % ouvrage(s) portent une provenance. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

DROP INDEX IF EXISTS "ouvrages_sourceReference_key";
DROP INDEX IF EXISTS "ouvrages_inventaire_reference_idx";
ALTER TABLE "ouvrages"
  DROP COLUMN IF EXISTS "sourceType",
  DROP COLUMN IF EXISTS "sourceReference",
  DROP COLUMN IF EXISTS "sourceConfidence",
  DROP COLUMN IF EXISTS "sourceDetectedAt";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260905120000_ouvrage_provenance';

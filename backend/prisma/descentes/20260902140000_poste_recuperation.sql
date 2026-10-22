-- RETOUR ARRIERE de `20260902140000_poste_recuperation`.
--
-- Ajoute a postes historicalRecovered, recoveredFrom, recoveryStatus, cree le type StatutRecuperation et l'index unique sur le nom normalise.
--
-- CE QUI EST PERDU : la marque des postes recuperes depuis l'historique et leur statut de validation. L'unicite du nom normalise disparait aussi.
--
-- GARDE : la descente REFUSE de s'executer si des donnees seraient detruites. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20260902140000_poste_recuperation.sql
--
-- GARDE-TEST: INSERT INTO "postes" ("id","nom","type","regionId","updatedAt","historicalRecovered") VALUES ('g1','x','PEAGE',1,now(),true);
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique. Garde eprouvee avec une donnee fabriquee.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "postes" WHERE "historicalRecovered" OR "recoveredFrom" IS NOT NULL OR "recoveryStatus" IS NOT NULL) INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % poste(s) portent une marque de recuperation. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

DROP INDEX IF EXISTS "postes_nom_normalise_key";
ALTER TABLE "postes"
  DROP COLUMN IF EXISTS "historicalRecovered",
  DROP COLUMN IF EXISTS "recoveredFrom",
  DROP COLUMN IF EXISTS "recoveryStatus";
DROP TYPE IF EXISTS "StatutRecuperation";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260902140000_poste_recuperation';

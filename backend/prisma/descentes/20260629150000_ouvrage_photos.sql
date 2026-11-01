-- RETOUR ARRIERE de `20260629150000_ouvrage_photos`.
--
-- Ajoute ouvrages.photos (tableau de noms de fichiers, NOT NULL, vide par defaut).
--
-- CE QUI EST PERDU : la liste des photos rattachees aux ouvrages. Les fichiers restent sur le disque.
--
-- GARDE : la descente REFUSE de s'executer si des donnees seraient detruites. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20260629150000_ouvrage_photos.sql
--
-- GARDE-TEST: INSERT INTO "ouvrages" ("id","nom","type","regionId","updatedAt","photos") VALUES ('g1','x','PONT',1,now(),ARRAY['a.jpg']);
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique. Garde eprouvee avec une donnee fabriquee.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "ouvrages" WHERE cardinality("photos") > 0) INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % ouvrage(s) portent des photos. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

ALTER TABLE "ouvrages"
  DROP COLUMN IF EXISTS "photos";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260629150000_ouvrage_photos';

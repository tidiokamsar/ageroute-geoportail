-- RETOUR ARRIERE de `20260702110000_marches_bailleurs_avancement`.
--
-- Cree les types DeviseMarche et StatutMarche, les tables bailleurs (avec cinq bailleurs semes), marches, marches_chantiers et avancement_marche.
--
-- CE QUI EST PERDU : les marches, leurs liens aux chantiers et leur courbe d'avancement, ainsi que tout bailleur ajoute apres les cinq semes.
--
-- GARDE : la descente REFUSE de s'executer si des donnees seraient detruites. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20260702110000_marches_bailleurs_avancement.sql
--
-- GARDE-TEST: INSERT INTO "marches" ("intitule") VALUES ('x');
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique. Garde eprouvee avec une donnee fabriquee.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "marches") + (SELECT count(*) FROM "marches_chantiers") + (SELECT count(*) FROM "avancement_marche") + (SELECT count(*) FROM "bailleurs" WHERE "id" > 5) INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % ligne(s) de marches, de liens, d''avancement ou de bailleurs ajoutes. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

DROP TABLE IF EXISTS "avancement_marche";
DROP TABLE IF EXISTS "marches_chantiers";
DROP TABLE IF EXISTS "marches";
DROP TABLE IF EXISTS "bailleurs";
DROP TYPE IF EXISTS "StatutMarche";
DROP TYPE IF EXISTS "DeviseMarche";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260702110000_marches_bailleurs_avancement';

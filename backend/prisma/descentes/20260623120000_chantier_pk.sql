-- RETOUR ARRIERE de `20260623120000_chantier_pk`.
--
-- Ajoute chantiers.pkDebut et chantiers.pkFin (referencement lineaire).
--
-- CE QUI EST PERDU : les PK de debut et de fin saisis sur les chantiers.
--
-- GARDE : la descente REFUSE de s'executer si des donnees seraient detruites. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20260623120000_chantier_pk.sql
--
-- GARDE-TEST: INSERT INTO "chantiers" ("id","intitule","entreprise","regionId","updatedAt","pkDebut") VALUES ('g1','x','x',1,now(),12.5);
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique. Garde eprouvee avec une donnee fabriquee.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "chantiers" WHERE num_nonnulls("pkDebut", "pkFin") > 0) INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % chantier(s) portent un PK de debut ou de fin. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

ALTER TABLE "chantiers"
  DROP COLUMN IF EXISTS "pkDebut",
  DROP COLUMN IF EXISTS "pkFin";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260623120000_chantier_pk';

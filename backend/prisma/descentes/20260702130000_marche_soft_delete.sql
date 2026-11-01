-- RETOUR ARRIERE de `20260702130000_marche_soft_delete`.
--
-- Ajoute marches.deletedAt et son index (suppression logique).
--
-- CE QUI EST PERDU : la marque de suppression logique : les marches supprimes REDEVIENDRAIENT ACTIFS.
--
-- GARDE : la descente REFUSE de s'executer si des donnees seraient detruites. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20260702130000_marche_soft_delete.sql
--
-- GARDE-TEST: INSERT INTO "marches" ("intitule","deletedAt") VALUES ('x', now());
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique. Garde eprouvee avec une donnee fabriquee.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "marches" WHERE "deletedAt" IS NOT NULL) INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % marche(s) supprimes logiquement redeviendraient actifs. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

DROP INDEX IF EXISTS "marches_deletedAt_idx";
ALTER TABLE "marches"
  DROP COLUMN IF EXISTS "deletedAt";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260702130000_marche_soft_delete';

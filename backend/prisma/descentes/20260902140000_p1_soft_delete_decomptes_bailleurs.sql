-- RETOUR ARRIERE de `20260902140000_p1_soft_delete_decomptes_bailleurs`.
--
-- Ajoute deletedAt (et son index) a decomptes et a bailleurs.
--
-- CE QUI EST PERDU : la marque de suppression logique : decomptes et bailleurs supprimes REDEVIENDRAIENT ACTIFS.
--
-- GARDE : la descente REFUSE de s'executer si des donnees seraient detruites. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20260902140000_p1_soft_delete_decomptes_bailleurs.sql
--
-- GARDE-TEST: INSERT INTO "bailleurs" ("nom","deletedAt") VALUES ('zz-test', now());
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique. Garde eprouvee avec une donnee fabriquee.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "decomptes" WHERE "deletedAt" IS NOT NULL) + (SELECT count(*) FROM "bailleurs" WHERE "deletedAt" IS NOT NULL) INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % ligne(s) supprimees logiquement redeviendraient actives. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

DROP INDEX IF EXISTS "decomptes_deletedAt_idx";
DROP INDEX IF EXISTS "bailleurs_deletedAt_idx";
ALTER TABLE "decomptes"
  DROP COLUMN IF EXISTS "deletedAt";
ALTER TABLE "bailleurs"
  DROP COLUMN IF EXISTS "deletedAt";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260902140000_p1_soft_delete_decomptes_bailleurs';

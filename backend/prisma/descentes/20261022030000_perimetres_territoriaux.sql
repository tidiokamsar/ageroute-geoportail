-- RETOUR ARRIERE de `20261022030000_perimetres_territoriaux`.
--
-- CE QUI EST PERDU : les perimetres regionaux des comptes ; tous les comptes redeviennent
-- nationaux (aucune restriction territoriale d'ecriture).
--
-- GARDE : la descente REFUSE de s'executer si des perimetres sont rattaches. Pour passer outre,
-- apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261022030000_perimetres_territoriaux.sql
--
-- GARDE-TEST: INSERT INTO "users" ("id","email","nomComplet","passwordHash","role","updatedAt") VALUES ('g-u','g@local.invalid','x','x','GESTIONNAIRE',now()); INSERT INTO "perimetres_comptes" ("userId","regionId","accordeParId") VALUES ('g-u',1,'g-u');

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "perimetres_comptes";
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % rattachement(s) de perimetre. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

DROP TABLE IF EXISTS "perimetres_comptes";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261022030000_perimetres_territoriaux';

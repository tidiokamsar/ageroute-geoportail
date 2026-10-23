-- RETOUR ARRIERE de `20261026410000_correspondances_identifiants`.
--
-- CE QUI EST PERDU : toutes les correspondances saisies et le journal de leurs versions. Ce sont des decisions
-- humaines (proposees, confirmees, corrigees) ; les perdre fait perdre la reproductibilite des exports passes
-- (critere B12).
--
-- GARDE : la descente REFUSE de s'executer si une correspondance ou une version existe. Pour passer outre, apres
-- sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261026410000_correspondances_identifiants.sql
--
-- Les declencheurs d'ajout seul n'empechent pas le DROP TABLE : c'est la garde qui protege les donnees.
--
-- GARDE-TEST: INSERT INTO "users" ("id","email","nomComplet","passwordHash","role","updatedAt") VALUES ('g-u','g@local.invalid','x','x','GESTIONNAIRE',now()); INSERT INTO "versions_correspondance" ("version","auteurId","motif") VALUES (1,'g-u','essai de garde');

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "correspondances_identifiants") + (SELECT count(*) FROM "versions_correspondance") INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % correspondance(s) ou version(s) enregistrees. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

DROP TABLE IF EXISTS "correspondances_identifiants";
DROP TABLE IF EXISTS "versions_correspondance";
DROP FUNCTION IF EXISTS correspondance_cible_existe();
DROP FUNCTION IF EXISTS correspondance_ajout_seul();
DROP FUNCTION IF EXISTS version_correspondance_ajout_seul();

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261026410000_correspondances_identifiants';

-- RETOUR ARRIERE de `20261013120000_delegation_validation`.
--
-- Cree le type DomaineValidation et la table delegations_validation.
--
-- CE QUI EST PERDU : les delegations du pouvoir de validation, avec leur duree et leur revocation : la preuve de QUI pouvait valider QUOI.
--
-- GARDE : la descente REFUSE de s'executer si des donnees seraient detruites. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261013120000_delegation_validation.sql
--
-- GARDE-TEST: INSERT INTO "delegations_validation" ("id","domaine","validateurId","delegueParId","updatedAt") VALUES ('g1','TRONCON','u','u',now());
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique. Garde eprouvee avec une donnee fabriquee.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "delegations_validation") INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % delegation(s) de validation enregistrees. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

DROP TABLE IF EXISTS "delegations_validation";
DROP TYPE IF EXISTS "DomaineValidation";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261013120000_delegation_validation';

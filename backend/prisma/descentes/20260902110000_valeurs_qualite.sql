-- RETOUR ARRIERE de `20260902110000_valeurs_qualite`.
--
-- Cree le type StatutValeur et la table valeurs_qualite (statut, source, methode, date du constat de chaque valeur).
--
-- CE QUI EST PERDU : TOUTE la qualite des donnees : le statut, la source et la date de chaque valeur, qui distinguent un constat d'un defaut d'import.
--
-- GARDE : la descente REFUSE de s'executer si des donnees seraient detruites. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20260902110000_valeurs_qualite.sql
--
-- GARDE-TEST: INSERT INTO "valeurs_qualite" ("id","entityType","entityId","champ","statut","updatedAt") VALUES ('g1','troncon','t','etat','UNKNOWN',now());
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique. Garde eprouvee avec une donnee fabriquee.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "valeurs_qualite") INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % valeur(s) de qualite enregistrees. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

DROP TABLE IF EXISTS "valeurs_qualite";
DROP TYPE IF EXISTS "StatutValeur";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260902110000_valeurs_qualite';

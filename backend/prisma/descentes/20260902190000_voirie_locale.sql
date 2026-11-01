-- RETOUR ARRIERE de `20260902190000_voirie_locale`.
--
-- Cree les types SourceVoirie, CategorieVoirie, StatutVoirie et la table voirie_locale (voies locales importees d'OSM ou d'AGEROUTE).
--
-- CE QUI EST PERDU : les voies locales importees et leur statut de validation.
--
-- GARDE : la descente REFUSE de s'executer si des donnees seraient detruites. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20260902190000_voirie_locale.sql
--
-- GARDE-TEST: INSERT INTO "voirie_locale" ("id","source","sourceId","importLot","nature","categorie","longueurCalculeeKm") VALUES ('g1','OSM','1','l','n','INCONNU',0.1);
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique. Garde eprouvee avec une donnee fabriquee.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "voirie_locale") INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % voie(s) locales enregistrees. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

DROP TABLE IF EXISTS "voirie_locale";
DROP TYPE IF EXISTS "StatutVoirie";
DROP TYPE IF EXISTS "CategorieVoirie";
DROP TYPE IF EXISTS "SourceVoirie";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260902190000_voirie_locale';

-- RETOUR ARRIERE de `20260902120000_chantier_localisation`.
--
-- Ajoute chantiers.statutLocalisation, cree propositions_localisation et les types StatutLocalisation et StatutProposition.
--
-- CE QUI EST PERDU : le niveau de localisation des chantiers et les propositions de geometrie, dont les decisions des agents (validee, rejetee, motif).
--
-- GARDE : la descente REFUSE de s'executer si des donnees seraient detruites. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20260902120000_chantier_localisation.sql
--
-- GARDE-TEST: INSERT INTO "propositions_localisation" ("id","chantierId","methode","sourceTexte","confiance") VALUES ('g1','c','m','t','LOW');
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique. Garde eprouvee avec une donnee fabriquee.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "propositions_localisation") + (SELECT count(*) FROM "chantiers" WHERE "statutLocalisation" <> 'NONE') INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % ligne(s) de propositions ou de chantiers localises. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

DROP TABLE IF EXISTS "propositions_localisation";
DROP INDEX IF EXISTS "chantiers_statutLocalisation_idx";
ALTER TABLE "chantiers"
  DROP COLUMN IF EXISTS "statutLocalisation";
DROP TYPE IF EXISTS "StatutProposition";
DROP TYPE IF EXISTS "StatutLocalisation";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260902120000_chantier_localisation';

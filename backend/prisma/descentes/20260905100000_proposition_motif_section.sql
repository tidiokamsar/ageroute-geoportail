-- RETOUR ARRIERE de `20260905100000_proposition_motif_section`.
--
-- Ajoute propositions_localisation.motif et sectionPk, et un index.
--
-- CE QUI EST PERDU : le motif et la section des propositions de localisation.
--
-- GARDE : la descente REFUSE de s'executer si des donnees seraient detruites. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20260905100000_proposition_motif_section.sql
--
-- GARDE-TEST: INSERT INTO "propositions_localisation" ("id","chantierId","methode","sourceTexte","confiance","motif") VALUES ('g1','c','m','t','LOW','x');
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique. Garde eprouvee avec une donnee fabriquee.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "propositions_localisation" WHERE num_nonnulls("motif", "sectionPk") > 0) INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % proposition(s) portent un motif ou une section. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

DROP INDEX IF EXISTS "propositions_statut_section_idx";
ALTER TABLE "propositions_localisation"
  DROP COLUMN IF EXISTS "motif",
  DROP COLUMN IF EXISTS "sectionPk";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260905100000_proposition_motif_section';

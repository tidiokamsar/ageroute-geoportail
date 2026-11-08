-- RETOUR ARRIERE de `20261030100000_projets_voirie_reseaux`.
--
-- CE QUI EST PERDU : TOUT le module Projets de voirie et reseaux : les projets, les concessionnaires, les jeux de
-- donnees charges (avec leurs versions successives) et tous les objets geographiques (tracés des axes de travaux,
-- reseaux de concessionnaires, limites de route). Les fichiers d'origine ne sont pas conserves en base : seule une
-- sauvegarde permet de les retrouver. Ces donnees sont CONFIDENTIELLES (infrastructures critiques de tiers).
--
-- GARDE : la descente REFUSE de s'executer si l'une des quatre tables porte au moins une ligne. Pour passer outre,
-- apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- Les lignes de `audit_logs` qui decrivent ces operations (entites ProjetVoirie, JeuDonneesProjet, ConcessionnaireReseau,
-- ExportProjetVoirie) ne sont PAS supprimees : le journal est une trace d'archive.
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261030100000_projets_voirie_reseaux.sql
--
-- GARDE-TEST: INSERT INTO "concessionnaires_reseau" ("id","nom","typeReseau") VALUES ('g-c','Garde essai','TELECOM');

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "projets_voirie")
       + (SELECT count(*) FROM "concessionnaires_reseau")
       + (SELECT count(*) FROM "projets_voirie_jeux")
       + (SELECT count(*) FROM "projets_voirie_objets")
    INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % ligne(s) dans les tables des projets de voirie (projets, concessionnaires, jeux, objets). Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

-- Declencheurs de refus (les tables partent avec, mais on les retire d'abord pour que l'ordre soit lisible).
DROP TRIGGER IF EXISTS projets_voirie_objets_modification ON "projets_voirie_objets";
DROP TRIGGER IF EXISTS projets_voirie_objets_suppression ON "projets_voirie_objets";
DROP TRIGGER IF EXISTS projets_voirie_jeux_suppression ON "projets_voirie_jeux";
DROP TRIGGER IF EXISTS concessionnaires_reseau_suppression ON "concessionnaires_reseau";
DROP TRIGGER IF EXISTS projets_voirie_suppression ON "projets_voirie";

-- Les objets d'abord, puis les jeux, puis leurs references.
DROP TABLE IF EXISTS "projets_voirie_objets";
DROP TABLE IF EXISTS "projets_voirie_jeux";
DROP TABLE IF EXISTS "concessionnaires_reseau";
DROP TABLE IF EXISTS "projets_voirie";

DROP FUNCTION IF EXISTS projets_voirie_objets_immuables();
DROP FUNCTION IF EXISTS projets_voirie_refuse_suppression();

DROP TYPE IF EXISTS "TypeGeomObjet";
DROP TYPE IF EXISTS "StatutJeuProjet";
DROP TYPE IF EXISTS "NiveauConfidentialite";
DROP TYPE IF EXISTS "ClassePrecision";
DROP TYPE IF EXISTS "NatureObjetReseau";
DROP TYPE IF EXISTS "FormatJeuProjet";
DROP TYPE IF EXISTS "StatutParametresProjet";
DROP TYPE IF EXISTS "RoleJeuProjet";
DROP TYPE IF EXISTS "TypeReseauTiers";

-- Apres une descente reussie, retirer la ligne de l'historique de Prisma :
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261030100000_projets_voirie_reseaux';

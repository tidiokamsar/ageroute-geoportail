-- RETOUR ARRIERE de `20261103100000_territoires_referentiels`.
--
-- CE QUI EST PERDU :
--   - `territoires_voirie` et son historique : le referentiel territorial (nation, chaine du pilote, territoires crees depuis les projets
--     existants, territoires crees par un administrateur) ;
--   - `referentiels_voirie` et son historique : les valeurs configurables (types de reseau, categories, types de document, methodes
--     d'acquisition, statuts de qualite) et leurs versions ;
--   - `configuration_voirie` et son historique : l'emprise de plausibilite, les bandes de CRS, la liste blanche, les protections ;
--   - `projets_voirie.territoireId` et `categorieCode`, `projets_voirie_jeux.typeReseauCode`, `concessionnaires_reseau.typeReseauCode` :
--     le rattachement des projets a un territoire et les codes de type ; `commune`, `prefecture` et la famille `typeReseau` restent.
--   Les lignes d'`audit_logs` (TerritoireVoirie, ReferentielVoirie, ConfigurationVoirie) ne sont PAS supprimees : le journal est une archive.
--
-- GARDE : la descente REFUSE si une ligne a ete creee ou modifiee par un administrateur (territoire ou valeur avec `creeParId`, version
-- superieure a 1, ligne d'historique avec acteur). Les lignes de la migration seule (valeurs systeme, nation, pilote, territoires derives des
-- projets) ne declenchent pas la garde : elles se recreent a l'identique en rejouant la migration. Pour passer outre, apres sauvegarde
-- verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261103100000_territoires_referentiels.sql
--
-- GARDE-TEST: SET session_replication_role = replica; INSERT INTO "territoires_voirie" ("id","niveau","code","nom","chemin","profondeur","creeParId") VALUES ('g-t1','NATION','GARDE-T1','Garde','/g-t1/',0,'g-u');
-- GARDE-TEST: SET session_replication_role = replica; INSERT INTO "referentiels_voirie" ("id","domaine","code","libelle","parametres","version") VALUES ('g-r1','STATUT_QUALITE','GARDE-R1','Garde','{}',2);
-- GARDE-TEST: SET session_replication_role = replica; INSERT INTO "configuration_voirie_historique" ("cle","version","apres","acteurId") VALUES ('EMPRISE_PLAUSIBILITE',2,'{}','g-u');

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "territoires_voirie" WHERE "creeParId" IS NOT NULL OR "version" > 1)
       + (SELECT count(*) FROM "referentiels_voirie" WHERE "creeParId" IS NOT NULL OR "version" > 1)
       + (SELECT count(*) FROM "configuration_voirie" WHERE "version" > 1)
       + (SELECT count(*) FROM "territoires_voirie_historique" WHERE "acteurId" IS NOT NULL)
       + (SELECT count(*) FROM "referentiels_voirie_historique" WHERE "acteurId" IS NOT NULL)
       + (SELECT count(*) FROM "configuration_voirie_historique" WHERE "acteurId" IS NOT NULL)
    INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % ligne(s) de territoires, referentiels ou configuration creees ou modifiees par un administrateur. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

-- Declencheurs du socle et colonnes ajoutees.
DROP TRIGGER IF EXISTS projets_voirie_codes_referentiel ON "projets_voirie";
DROP TRIGGER IF EXISTS projets_voirie_jeux_type_reseau_code ON "projets_voirie_jeux";
DROP TRIGGER IF EXISTS concessionnaires_reseau_type_reseau_code ON "concessionnaires_reseau";
DROP FUNCTION IF EXISTS projets_voirie_codes_referentiel();
DROP FUNCTION IF EXISTS projets_voirie_type_reseau_code();
DROP INDEX IF EXISTS "projets_voirie_territoireId_idx";
ALTER TABLE "projets_voirie" DROP COLUMN IF EXISTS "territoireId";
ALTER TABLE "projets_voirie" DROP COLUMN IF EXISTS "categorieCode";
ALTER TABLE "projets_voirie_jeux" DROP COLUMN IF EXISTS "typeReseauCode";
ALTER TABLE "concessionnaires_reseau" DROP COLUMN IF EXISTS "typeReseauCode";

-- Configuration.
DROP TRIGGER IF EXISTS configuration_voirie_historique_troncature ON "configuration_voirie_historique";
DROP TRIGGER IF EXISTS configuration_voirie_historique_ajout_seul ON "configuration_voirie_historique";
DROP TRIGGER IF EXISTS configuration_voirie_troncature ON "configuration_voirie";
DROP TRIGGER IF EXISTS configuration_voirie_suppression ON "configuration_voirie";
DROP TABLE IF EXISTS "configuration_voirie_historique";
DROP TABLE IF EXISTS "configuration_voirie";

-- Referentiels.
DROP TRIGGER IF EXISTS referentiels_voirie_historique_troncature ON "referentiels_voirie_historique";
DROP TRIGGER IF EXISTS referentiels_voirie_historique_ajout_seul ON "referentiels_voirie_historique";
DROP TRIGGER IF EXISTS referentiels_voirie_troncature ON "referentiels_voirie";
DROP TRIGGER IF EXISTS referentiels_voirie_suppression ON "referentiels_voirie";
DROP TRIGGER IF EXISTS referentiels_voirie_avant_ecriture ON "referentiels_voirie";
DROP TABLE IF EXISTS "referentiels_voirie_historique";
DROP TABLE IF EXISTS "referentiels_voirie";
DROP FUNCTION IF EXISTS referentiels_voirie_exige("DomaineReferentielVoirie", text);
DROP FUNCTION IF EXISTS referentiels_voirie_avant_ecriture();

-- Territoires.
DROP TRIGGER IF EXISTS territoires_voirie_historique_troncature ON "territoires_voirie_historique";
DROP TRIGGER IF EXISTS territoires_voirie_historique_ajout_seul ON "territoires_voirie_historique";
DROP TRIGGER IF EXISTS territoires_voirie_troncature ON "territoires_voirie";
DROP TRIGGER IF EXISTS territoires_voirie_suppression ON "territoires_voirie";
DROP TRIGGER IF EXISTS territoires_voirie_apres_region ON "territoires_voirie";
DROP TRIGGER IF EXISTS territoires_voirie_avant_ecriture ON "territoires_voirie";
DROP TABLE IF EXISTS "territoires_voirie_historique";
DROP TABLE IF EXISTS "territoires_voirie";
DROP FUNCTION IF EXISTS territoires_voirie_ajout_seul();
DROP FUNCTION IF EXISTS territoires_voirie_refuse_suppression();
DROP FUNCTION IF EXISTS territoires_voirie_apres_region();
DROP FUNCTION IF EXISTS territoires_voirie_avant_ecriture();
DROP FUNCTION IF EXISTS territoires_voirie_rang("NiveauTerritoireVoirie");

DROP TYPE IF EXISTS "DomaineReferentielVoirie";
DROP TYPE IF EXISTS "NiveauTerritoireVoirie";

-- Apres une descente reussie, retirer la ligne de l'historique de Prisma :
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261103100000_territoires_referentiels';

-- RETOUR ARRIERE de `20261103400000_correctifs_sources_territoires` (correctifs apres la revue T1+S1 du 09/11/2026).
--
-- CE QUI EST PERDU :
--   - B1 : le lien d'un dossier DIVERGENCE_SOURCES vers le jeu B de sa comparaison (`conflits_projet.jeuSourceBId`) ; il se deduit de la comparaison,
--     rien n'est perdu de ce qui a ete decide ou mesure ;
--   - M2 : le controle par la base de la methode d'acquisition d'un jeu contre le referentiel (le service d'avant revient a sa liste codee) ;
--   - M3 : le type de reseau dans la cle de version ; la descente REFUSE, meme autorisee, si deux jeux ne se distinguent que par leur type ;
--   - M6 : la regle systeme sans bareme S1-CORRIDOR-0.2 (supprimee ; S1-CORRIDOR-0.1, retiree par la migration, redevient APPROUVEE) et les contraintes
--     du bareme. Le code d'avant attribue de nouveau le bareme provisoire {A: 0.5, B: 1, C: 2, D: 5} a toute regle sans table : la descente REFUSE sans
--     autorisation (bdri.perte_autorisee) si une regle de personne sans bareme a ete creee, ou si une comparaison a applique S1-CORRIDOR-0.2.
--
-- GARDE-TEST: INSERT INTO "users" ("id","email","nomComplet","passwordHash","role","updatedAt") VALUES ('g-u','g@local.invalid','x','x','GESTIONNAIRE',now()); INSERT INTO "regles_rapprochement_sources" ("id","famille","code","version","statut","justification","creeParId") VALUES ('g-rr',NULL,'GARDE-1',1,'BROUILLON','regle de garde pour la descente','g-u');
-- GARDE-TEST-SANS-DEROGATION: SET session_replication_role = replica; INSERT INTO "projets_voirie_jeux" ("id","projetId","role","concessionnaireId","typeReseau","typeReseauCode","nomFichier","format","sha256","tailleOctets","nbObjets","creeParId","statut") VALUES ('g-j1','g-p','RESEAU_TIERS','g-c','TELECOM','GARDE_A','a','GEOJSON',repeat('a',64),0,0,'g-u','RECU'),('g-j2','g-p','RESEAU_TIERS','g-c','TELECOM','GARDE_B','b','GEOJSON',repeat('b',64),0,0,'g-u','RECU');
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261103400000_correctifs_sources_territoires.sql

-- ===== Garde =====
DO $garde$
DECLARE dbl bigint; n bigint;
BEGIN
  -- M3 : deux jeux AUTORISE (ou deux depots en attente) d'une meme cle (projet, role, concessionnaire, methode) qui ne se distinguent que par le type de
  -- reseau : l'index du lot S1 ne peut pas etre retabli sans choisir lequel garder (decision metier, pas une autorisation).
  SELECT count(*) INTO dbl FROM (
    SELECT 1 FROM "projets_voirie_jeux" WHERE "statut" = 'AUTORISE' AND "role" <> 'AUTRE'
     GROUP BY "projetId", "role", COALESCE("concessionnaireId", ''), (CASE WHEN "role" = 'RESEAU_TIERS' THEN COALESCE("methodeAcquisition", '') ELSE '' END) HAVING count(*) > 1
    UNION ALL
    SELECT 1 FROM "projets_voirie_jeux" WHERE "statut" IN ('RECU', 'CONTROLE') AND "role" <> 'AUTRE'
     GROUP BY "projetId", "role", COALESCE("concessionnaireId", ''), (CASE WHEN "role" = 'RESEAU_TIERS' THEN COALESCE("methodeAcquisition", '') ELSE '' END) HAVING count(*) > 1) q;
  IF dbl > 0 THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % cle(s) (projet, role, concessionnaire, methode) portent plusieurs jeux autorises ou en attente qui ne se distinguent que par le type de reseau : l''index du lot S1 ne peut pas etre retabli sans choisir lequel garder (decision metier).', dbl;
  END IF;
  -- M6 : regles de personnes sans bareme (le code d'avant leur attribuerait le bareme provisoire) et comparaisons faites avec S1-CORRIDOR-0.2.
  SELECT (SELECT count(*) FROM "regles_rapprochement_sources" WHERE "creeParId" IS NOT NULL AND "precisionParClasseM" = '{}'::jsonb)
       + (SELECT count(*) FROM "comparaisons_sources_projet" WHERE "regle"->>'regleId' = '00000000-0000-4000-8000-00000000c502') INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % regle(s) de rapprochement sans bareme ou comparaison(s) faite(s) avec la regle systeme S1-CORRIDOR-0.2 : apres la descente, le code d''avant appliquerait le bareme provisoire par classe. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

-- ===== M6 =====
ALTER TABLE "regles_rapprochement_sources" DROP CONSTRAINT IF EXISTS "rrs_auteur_approbateur";
ALTER TABLE "regles_rapprochement_sources" DROP CONSTRAINT IF EXISTS "rrs_bareme_separation";
ALTER TABLE "regles_rapprochement_sources" DROP CONSTRAINT IF EXISTS "rrs_bareme_personne";
ALTER TABLE "regles_rapprochement_sources" ALTER COLUMN "precisionParClasseM" SET DEFAULT '{"A": 0.5, "B": 1, "C": 2, "D": 5}'::jsonb;
-- Les declencheurs d'immuabilite et de suppression sont suspendus le temps de retablir les deux regles systeme (dans cette seule transaction).
ALTER TABLE "regles_rapprochement_sources" DISABLE TRIGGER regles_rapprochement_sources_modification;
ALTER TABLE "regles_rapprochement_sources" DISABLE TRIGGER regles_rapprochement_sources_suppression;
DELETE FROM "regles_rapprochement_sources" WHERE "id" = '00000000-0000-4000-8000-00000000c502' AND "creeParId" IS NULL;
UPDATE "regles_rapprochement_sources" SET "statut" = 'APPROUVEE' WHERE "creeParId" IS NULL AND "code" = 'S1-CORRIDOR-0.1' AND "version" = 0 AND "statut" = 'RETIREE';
ALTER TABLE "regles_rapprochement_sources" ENABLE TRIGGER regles_rapprochement_sources_modification;
ALTER TABLE "regles_rapprochement_sources" ENABLE TRIGGER regles_rapprochement_sources_suppression;
ALTER TABLE "regles_rapprochement_sources" DROP CONSTRAINT IF EXISTS "rrs_systeme";
ALTER TABLE "regles_rapprochement_sources" ADD CONSTRAINT "rrs_systeme" CHECK ("creeParId" IS NOT NULL OR ("projetId" IS NULL AND "famille" IS NULL AND "version" = 0 AND "statut" = 'APPROUVEE'));

-- ===== M3 =====
DROP INDEX IF EXISTS "projets_voirie_jeux_cle_autorise_key";
DROP INDEX IF EXISTS "projets_voirie_jeux_cle_attente_key";
DROP FUNCTION IF EXISTS pv_identite_type_reseau(text, "TypeReseauTiers");
CREATE UNIQUE INDEX IF NOT EXISTS "projets_voirie_jeux_cle_autorise_key" ON "projets_voirie_jeux" ("projetId", "role", COALESCE("concessionnaireId", ''), (CASE WHEN "role" = 'RESEAU_TIERS' THEN COALESCE("methodeAcquisition", '') ELSE '' END))
  WHERE "statut" = 'AUTORISE' AND "role" <> 'AUTRE';
CREATE UNIQUE INDEX IF NOT EXISTS "projets_voirie_jeux_cle_attente_key" ON "projets_voirie_jeux" ("projetId", "role", COALESCE("concessionnaireId", ''), (CASE WHEN "role" = 'RESEAU_TIERS' THEN COALESCE("methodeAcquisition", '') ELSE '' END))
  WHERE "statut" IN ('RECU', 'CONTROLE') AND "role" <> 'AUTRE';

-- ===== M2 =====
-- RESIDU DE DONNEES (pas de schema) : les valeurs du lot S1 ajoutees au referentiel METHODE_ACQUISITION restent (des jeux les portent ; une valeur ne
-- se supprime pas physiquement). Le commentaire de colonne d'origine (lot S1) est retabli.
DROP TRIGGER IF EXISTS projets_voirie_jeux_methode_acquisition ON "projets_voirie_jeux";
DROP FUNCTION IF EXISTS projets_voirie_jeux_methode_acquisition();
COMMENT ON COLUMN "projets_voirie_jeux"."methodeAcquisition" IS 'Code de la methode d''acquisition (GNSS_RTK, GEORADAR, NUMERISATION_PLAN...) : liste du service (config.ts), reliable au referentiel METHODE_ACQUISITION (lot T1). Nul = non renseignee. Composante de la cle de version : deux methodes = deux sources du meme reseau.';

-- ===== B1 =====
DROP TRIGGER IF EXISTS conflits_projet_jeu_source_b ON "conflits_projet";
DROP FUNCTION IF EXISTS conflits_projet_jeu_source_b();
ALTER TABLE "conflits_projet" DROP CONSTRAINT IF EXISTS "cp_jeu_source_b";
DROP INDEX IF EXISTS "conflits_projet_jeuSourceBId_idx";
ALTER TABLE "conflits_projet" DROP COLUMN IF EXISTS "jeuSourceBId";

-- Apres une descente reussie, retirer la ligne de l'historique de Prisma :
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261103400000_correctifs_sources_territoires';

-- RETOUR ARRIERE de `20261101300000_workflow_roles_recolement`.
--
-- CE QUI EST PERDU : TOUT le workflow des projets de voirie : les rattachements des referents concessionnaires (qui retirent
-- aux comptes concernes la restriction qui les confine au workflow : un compte LECTEUR ainsi rattache redeviendrait un lecteur
-- ordinaire du socle), les demandes de donnees aux concessionnaires et l'enregistrement de leur envoi, les taches, les
-- recolements (as-built) et leur validation, les preuves referencees et l'historique. Ce sont des DECISIONS HUMAINES (validations
-- de recolement, motifs, derogations) : les perdre efface la memoire de la coordination avec les concessionnaires. Les projets,
-- les jeux, les objets, les concessionnaires et les dossiers de conflit (migrations 20261030100000 et 20261031100000) ne sont PAS
-- touches.
--
-- GARDE : la descente REFUSE de s'executer si l'une des six tables porte au moins une ligne. Pour passer outre, apres sauvegarde
-- verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- Les lignes de `audit_logs` qui decrivent ces operations (entites ReferentConcessionnaire, DemandeConcessionnaire,
-- TacheProjetVoirie, RecolementProjetVoirie) ne sont PAS supprimees : le journal est une trace d'archive.
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261101300000_workflow_roles_recolement.sql
--
-- GARDE-TEST: INSERT INTO "users" ("id","email","nomComplet","passwordHash","role","updatedAt") VALUES ('g-u','g@local.invalid','x','x','LECTEUR',now()); INSERT INTO "projets_voirie" ("id","code","nom","creeParId","updatedAt") VALUES ('g-p','GARDE-B3','garde','g-u',now()); INSERT INTO "concessionnaires_reseau" ("id","nom","typeReseau","updatedAt") VALUES ('g-c','Garde concessionnaire','TELECOM',now()); INSERT INTO "demandes_concessionnaire" ("id","projetId","concessionnaireId","objet","creeParId") VALUES ('g-d','g-p','g-c','demande de garde','g-u');

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "referents_concessionnaire")
       + (SELECT count(*) FROM "demandes_concessionnaire")
       + (SELECT count(*) FROM "taches_projet_voirie")
       + (SELECT count(*) FROM "recolements_projet_voirie")
       + (SELECT count(*) FROM "preuves_workflow_projet")
       + (SELECT count(*) FROM "workflow_projet_historique")
    INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % ligne(s) dans les tables du workflow des projets de voirie (rattachements, demandes, taches, recolements, preuves, historique). Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

-- Declencheurs (les tables partent avec, mais on les retire d'abord pour que l'ordre soit lisible).
DROP TRIGGER IF EXISTS workflow_projet_historique_troncature ON "workflow_projet_historique";
DROP TRIGGER IF EXISTS preuves_workflow_projet_troncature ON "preuves_workflow_projet";
DROP TRIGGER IF EXISTS recolements_projet_voirie_troncature ON "recolements_projet_voirie";
DROP TRIGGER IF EXISTS taches_projet_voirie_troncature ON "taches_projet_voirie";
DROP TRIGGER IF EXISTS demandes_concessionnaire_troncature ON "demandes_concessionnaire";
DROP TRIGGER IF EXISTS referents_concessionnaire_troncature ON "referents_concessionnaire";
DROP TRIGGER IF EXISTS workflow_projet_historique_ajout_seul ON "workflow_projet_historique";
DROP TRIGGER IF EXISTS preuves_workflow_projet_ajout_seul ON "preuves_workflow_projet";
DROP TRIGGER IF EXISTS recolements_projet_voirie_modification ON "recolements_projet_voirie";
DROP TRIGGER IF EXISTS recolements_projet_voirie_suppression ON "recolements_projet_voirie";
DROP TRIGGER IF EXISTS taches_projet_voirie_modification ON "taches_projet_voirie";
DROP TRIGGER IF EXISTS taches_projet_voirie_suppression ON "taches_projet_voirie";
DROP TRIGGER IF EXISTS demandes_concessionnaire_modification ON "demandes_concessionnaire";
DROP TRIGGER IF EXISTS demandes_concessionnaire_suppression ON "demandes_concessionnaire";
DROP TRIGGER IF EXISTS referents_concessionnaire_modification ON "referents_concessionnaire";
DROP TRIGGER IF EXISTS referents_concessionnaire_suppression ON "referents_concessionnaire";

-- Les tables qui en referencent d'autres d'abord (taches -> demandes, preuves et historique sans cle polymorphe).
DROP TABLE IF EXISTS "workflow_projet_historique";
DROP TABLE IF EXISTS "preuves_workflow_projet";
DROP TABLE IF EXISTS "recolements_projet_voirie";
DROP TABLE IF EXISTS "taches_projet_voirie";
DROP TABLE IF EXISTS "demandes_concessionnaire";
DROP TABLE IF EXISTS "referents_concessionnaire";

DROP FUNCTION IF EXISTS recolements_projet_voirie_garde();
DROP FUNCTION IF EXISTS taches_projet_voirie_garde();
DROP FUNCTION IF EXISTS demandes_concessionnaire_garde();
DROP FUNCTION IF EXISTS referents_concessionnaire_garde();
DROP FUNCTION IF EXISTS workflow_projet_ajout_seul();
DROP FUNCTION IF EXISTS workflow_projet_refuse_troncature();
DROP FUNCTION IF EXISTS workflow_projet_refuse_suppression();

DROP TYPE IF EXISTS "TypePreuveWorkflow";
DROP TYPE IF EXISTS "ActionHistoriqueWorkflow";
DROP TYPE IF EXISTS "TypeObjetWorkflow";
DROP TYPE IF EXISTS "StatutRecolementProjet";
DROP TYPE IF EXISTS "PrioriteTacheProjet";
DROP TYPE IF EXISTS "StatutTacheProjet";
DROP TYPE IF EXISTS "StatutDemandeConcessionnaire";

-- Apres une descente reussie, retirer la ligne de l'historique de Prisma :
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261101300000_workflow_roles_recolement';

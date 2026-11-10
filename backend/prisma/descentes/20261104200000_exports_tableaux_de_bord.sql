-- RETOUR ARRIERE de `20261104200000_exports_tableaux_de_bord` (lot X1).
--
-- CE QUI EST PERDU :
--   - `exports_dossier_projet_voirie` : le journal des tentatives d'export (qui, quand, issue, empreinte, manifeste) ; la cadence des exports repart de zero ;
--   - `derogations_export_projet_voirie` : les derogations de confidentialite (accordees, utilisees, expirees).
--   Les lignes d'`audit_logs` (entites ExportDossierProjetVoirie et DerogationExportProjetVoirie) ne sont PAS supprimees : le journal d'audit est une
--   archive, il garde la trace de chaque remise et de chaque derogation.
--
-- La descente REFUSE de s'executer si une ligne existe dans l'une des deux tables. Pour passer outre, apres sauvegarde verifiee et autorisation
-- explicite (A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261104200000_exports_tableaux_de_bord.sql
--
-- GARDE-TEST: SET session_replication_role = replica; INSERT INTO "exports_dossier_projet_voirie" ("id","projetId","acteurId","sha256","tailleOctets","nbFichiers") VALUES ('g-e','g-p','g-u','0000000000000000000000000000000000000000000000000000000000000000',1,1);
-- GARDE-TEST: SET session_replication_role = replica; INSERT INTO "derogations_export_projet_voirie" ("id","projetId","jeuxIds","beneficiaireId","accordeeParId","justification","createdAt","expireLe") VALUES ('g-d','g-p',ARRAY['g-j'],'g-u','g-a','Derogation de garde du banc des descentes','2026-11-10 00:00:00','2026-11-11 00:00:00');

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "exports_dossier_projet_voirie") + (SELECT count(*) FROM "derogations_export_projet_voirie") INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % ligne(s) de journal des exports ou de derogations. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

-- Les derogations referencent le journal : elles d'abord.
DROP TRIGGER IF EXISTS derogations_export_projet_voirie_troncature ON "derogations_export_projet_voirie";
DROP TRIGGER IF EXISTS derogations_export_projet_voirie_suppression ON "derogations_export_projet_voirie";
DROP TRIGGER IF EXISTS derogations_export_projet_voirie_controle ON "derogations_export_projet_voirie";
DROP TRIGGER IF EXISTS exports_dossier_projet_voirie_troncature ON "exports_dossier_projet_voirie";
DROP TRIGGER IF EXISTS exports_dossier_projet_voirie_ajout_seul ON "exports_dossier_projet_voirie";
DROP TRIGGER IF EXISTS exports_dossier_projet_voirie_suppression ON "exports_dossier_projet_voirie";
DROP TRIGGER IF EXISTS exports_dossier_projet_voirie_controle ON "exports_dossier_projet_voirie";
DROP TABLE IF EXISTS "derogations_export_projet_voirie";
DROP TABLE IF EXISTS "exports_dossier_projet_voirie";
DROP FUNCTION IF EXISTS derogations_export_projet_voirie_controle();
DROP FUNCTION IF EXISTS exports_tableaux_refuse();
DROP FUNCTION IF EXISTS exports_dossier_projet_voirie_controle();

-- Apres une descente reussie, retirer la ligne de l'historique de Prisma :
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261104200000_exports_tableaux_de_bord';

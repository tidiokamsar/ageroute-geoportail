-- RETOUR ARRIERE de `20261031100000_conflits_projets_voirie`.
--
-- CE QUI EST PERDU : TOUT le suivi des conflits des projets de voirie : les regles de conflit saisies (la regle par defaut
-- RC-2D-0.1 est recreee par la migration), les analyses persistees, les dossiers de conflit, leur historique, leurs preuves et
-- leurs decisions. Ce sont des DECISIONS HUMAINES (verdicts, decisions approuvees, preuves) et des donnees CONFIDENTIELLES
-- (geometrie de reseaux de tiers) : les perdre efface la memoire du traitement des conflits. Les jeux de donnees, les objets, les
-- projets et les concessionnaires (migration 20261030100000) ne sont PAS touches.
--
-- GARDE : la descente REFUSE de s'executer si l'une des tables porte au moins une ligne (hors la regle systeme par defaut). Pour
-- passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- Les lignes de `audit_logs` qui decrivent ces operations (entites ConflitProjet, AnalyseConflitProjet, RegleConflit,
-- ExportConflitsProjetVoirie) ne sont PAS supprimees : le journal est une trace d'archive.
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261031100000_conflits_projets_voirie.sql
--
-- GARDE-TEST: INSERT INTO "users" ("id","email","nomComplet","passwordHash","role","updatedAt") VALUES ('g-u','g@local.invalid','x','x','GESTIONNAIRE',now()); INSERT INTO "regles_conflit_projet" ("id","famille","code","version","statut","justification","creeParId") VALUES ('g-r',NULL,'GARDE-1',1,'BROUILLON','regle de garde pour la descente','g-u');

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "regles_conflit_projet" WHERE NOT ("creeParId" IS NULL AND "code" = 'RC-2D-0.1' AND "version" = 0))
       + (SELECT count(*) FROM "analyses_conflit_projet")
       + (SELECT count(*) FROM "conflits_projet")
       + (SELECT count(*) FROM "conflits_projet_historique")
       + (SELECT count(*) FROM "conflits_projet_preuves")
       + (SELECT count(*) FROM "conflits_projet_decisions")
    INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % ligne(s) dans les tables des dossiers de conflit (regles, analyses, conflits, historique, preuves, decisions). Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

-- Declencheurs (les tables partent avec, mais on les retire d'abord pour que l'ordre soit lisible).
DROP TRIGGER IF EXISTS conflits_projet_decisions_troncature ON "conflits_projet_decisions";
DROP TRIGGER IF EXISTS conflits_projet_preuves_troncature ON "conflits_projet_preuves";
DROP TRIGGER IF EXISTS conflits_projet_historique_troncature ON "conflits_projet_historique";
DROP TRIGGER IF EXISTS conflits_projet_troncature ON "conflits_projet";
DROP TRIGGER IF EXISTS analyses_conflit_projet_troncature ON "analyses_conflit_projet";
DROP TRIGGER IF EXISTS regles_conflit_projet_troncature ON "regles_conflit_projet";
DROP TRIGGER IF EXISTS conflits_projet_decisions_garde ON "conflits_projet_decisions";
DROP TRIGGER IF EXISTS conflits_projet_decisions_suppression ON "conflits_projet_decisions";
DROP TRIGGER IF EXISTS conflits_projet_preuves_ajout_seul ON "conflits_projet_preuves";
DROP TRIGGER IF EXISTS conflits_projet_historique_ajout_seul ON "conflits_projet_historique";
DROP TRIGGER IF EXISTS conflits_projet_recalcul ON "conflits_projet";
DROP TRIGGER IF EXISTS conflits_projet_suppression ON "conflits_projet";
DROP TRIGGER IF EXISTS analyses_conflit_projet_ajout_seul ON "analyses_conflit_projet";
DROP TRIGGER IF EXISTS regles_conflit_projet_modification ON "regles_conflit_projet";
DROP TRIGGER IF EXISTS regles_conflit_projet_suppression ON "regles_conflit_projet";

-- Les tables qui en referencent d'autres d'abord.
DROP TABLE IF EXISTS "conflits_projet_decisions";
DROP TABLE IF EXISTS "conflits_projet_preuves";
DROP TABLE IF EXISTS "conflits_projet_historique";
DROP TABLE IF EXISTS "conflits_projet";
DROP TABLE IF EXISTS "analyses_conflit_projet";
DROP TABLE IF EXISTS "regles_conflit_projet";

DROP FUNCTION IF EXISTS conflits_projet_refuse_troncature();
DROP FUNCTION IF EXISTS conflits_projet_decision_garde();
DROP FUNCTION IF EXISTS conflits_projet_garde_modification();
DROP FUNCTION IF EXISTS regles_conflit_projet_immuable();
DROP FUNCTION IF EXISTS conflits_projet_ajout_seul();
DROP FUNCTION IF EXISTS conflits_projet_refuse_suppression();

DROP TYPE IF EXISTS "StatutDecisionConflit";
DROP TYPE IF EXISTS "OptionDecisionConflit";
DROP TYPE IF EXISTS "TypePreuveConflit";
DROP TYPE IF EXISTS "ActionHistoriqueConflit";
DROP TYPE IF EXISTS "StatutAnalyseConflit";
DROP TYPE IF EXISTS "StatutRegleConflit";
DROP TYPE IF EXISTS "MotifReexamenConflit";
DROP TYPE IF EXISTS "RisqueConflit";
DROP TYPE IF EXISTS "StatutConflit";
DROP TYPE IF EXISTS "TypeConflit";

-- Apres une descente reussie, retirer la ligne de l'historique de Prisma :
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261031100000_conflits_projets_voirie';

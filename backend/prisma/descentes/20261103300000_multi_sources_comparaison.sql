-- RETOUR ARRIERE de `20261103300000_multi_sources_comparaison` (lot S1).
--
-- CE QUI EST PERDU :
--   - les regles de rapprochement saisies (la regle par defaut S1-CORRIDOR-0.1 est recreee par la migration), TOUTES les comparaisons de sources et
--     leurs resultats par objet (synthese de concordance et de divergence entre deux sources d'un reseau) ;
--   - la methode d'acquisition des jeux (`projets_voirie_jeux.methodeAcquisition`) : la cle de version du socle redevient (projet, role, concessionnaire) ;
--   - la preuve des relations ; les valeurs CONNECTE_A (type de relation) et IMPORT_DECLARATIF (origine) ;
--   - le lien d'un dossier de conflit vers sa comparaison, et la possibilite d'un dossier sans analyse.
--
-- La descente REFUSE de s'executer si une table du lot porte une ligne (hors regle systeme) ou si un jeu porte une methode d'acquisition. Pour passer
-- outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- Elle REFUSE, MEME AVEC CETTE AUTORISATION, quand revenir en arriere obligerait a inventer une valeur ou a supprimer une decision :
--   - une relation CONNECTE_A ou d'origine IMPORT_DECLARATIF existe (retirer la valeur du type exigerait de la remplacer : decision metier) ;
--   - un dossier de conflit DIVERGENCE_SOURCES existe (il n'a pas d'analyse ; les dossiers ne se suppriment pas physiquement) ;
--   - deux jeux AUTORISE (ou deux depots en attente) de meme projet, role et concessionnaire ne se distinguent que par la methode : l'index unique du
--     socle ne peut pas etre retabli sans choisir lequel garder.
-- Les lignes d'`audit_logs` (entites RegleRapprochementSources, ComparaisonSources, ConflitProjet, ReseauRelation) NE sont PAS supprimees.
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261103300000_multi_sources_comparaison.sql
--
-- GARDE-TEST: INSERT INTO "users" ("id","email","nomComplet","passwordHash","role","updatedAt") VALUES ('g-u','g@local.invalid','x','x','GESTIONNAIRE',now()); INSERT INTO "regles_rapprochement_sources" ("id","famille","code","version","statut","justification","creeParId") VALUES ('g-rr',NULL,'GARDE-1',1,'BROUILLON','regle de garde pour la descente','g-u');
-- GARDE-TEST-SANS-DEROGATION: SET session_replication_role = replica; INSERT INTO "users" ("id","email","nomComplet","passwordHash","role","updatedAt") VALUES ('g-u2','g2@local.invalid','x','x','GESTIONNAIRE',now()); INSERT INTO "reseau_relations" ("id","projetId","typeRelation","sourceObjetId","cibleObjetId","statut","origine","preuve","decideParId","decideLe","justificationDecision","creeParId") VALUES ('g-rel','g-p','CONNECTE_A',999001,999002,'VALIDEE','MANUELLE','INCONNUE','g-u2',now(),'connexion de garde pour la descente','g-u2');

DO $garde$
DECLARE n bigint; m bigint; d bigint; r bigint; dbl bigint;
BEGIN
  SELECT (SELECT count(*) FROM "regles_rapprochement_sources" WHERE NOT ("creeParId" IS NULL AND "code" = 'S1-CORRIDOR-0.1' AND "version" = 0))
       + (SELECT count(*) FROM "comparaisons_sources_projet")
       + (SELECT count(*) FROM "comparaisons_sources_resultats") INTO n;
  SELECT count(*) INTO m FROM "projets_voirie_jeux" WHERE "methodeAcquisition" IS NOT NULL;
  SELECT count(*) INTO d FROM "conflits_projet" WHERE "type" = 'DIVERGENCE_SOURCES' OR "comparaisonId" IS NOT NULL OR "premiereAnalyseId" IS NULL OR "derniereAnalyseId" IS NULL;
  SELECT count(*) INTO r FROM "reseau_relations" WHERE "typeRelation"::text = 'CONNECTE_A' OR "origine"::text = 'IMPORT_DECLARATIF' OR "preuve" IS NOT NULL;
  SELECT count(*) INTO dbl FROM (
    SELECT 1 FROM "projets_voirie_jeux" WHERE "statut" = 'AUTORISE' AND "role" <> 'AUTRE' GROUP BY "projetId", "role", COALESCE("concessionnaireId", '') HAVING count(*) > 1
    UNION ALL
    SELECT 1 FROM "projets_voirie_jeux" WHERE "statut" IN ('RECU', 'CONTROLE') AND "role" <> 'AUTRE' GROUP BY "projetId", "role", COALESCE("concessionnaireId", '') HAVING count(*) > 1) q;
  IF d > 0 THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % dossier(s) de conflit issus d''une comparaison de sources (DIVERGENCE_SOURCES, sans analyse). Un dossier ne se supprime pas et aucune analyse ne peut lui etre inventee : decision metier, pas une autorisation.', d;
  END IF;
  IF r > 0 THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % relation(s) CONNECTE_A ou declaree(s) par import. Retirer la valeur du type obligerait a inventer un type de remplacement : decision metier, pas une autorisation.', r;
  END IF;
  IF dbl > 0 THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % cle(s) (projet, role, concessionnaire) portent plusieurs jeux autorises ou en attente qui ne se distinguent que par la methode d''acquisition : l''index unique du socle ne peut pas etre retabli sans choisir lequel garder (decision metier).', dbl;
  END IF;
  IF (n > 0 OR m > 0) AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % ligne(s) dans les tables du lot S1 (regles de rapprochement, comparaisons, resultats) et % jeu(x) avec une methode d''acquisition. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n, m;
  END IF;
END
$garde$;

-- ===== Dossiers de conflit : retour a l'origine « analyse » obligatoire =====
ALTER TABLE "conflits_projet" DROP CONSTRAINT IF EXISTS "cp_origine_coherente";
DROP INDEX IF EXISTS "conflits_projet_comparaisonId_idx";
ALTER TABLE "conflits_projet" DROP COLUMN IF EXISTS "comparaisonId";
ALTER TABLE "conflits_projet" ALTER COLUMN "premiereAnalyseId" SET NOT NULL;
ALTER TABLE "conflits_projet" ALTER COLUMN "derniereAnalyseId" SET NOT NULL;

-- ===== Tables du lot (celle qui en reference d'autres d'abord) =====
DROP TRIGGER IF EXISTS comparaisons_sources_resultats_troncature ON "comparaisons_sources_resultats";
DROP TRIGGER IF EXISTS comparaisons_sources_resultats_garde ON "comparaisons_sources_resultats";
DROP TRIGGER IF EXISTS comparaisons_sources_resultats_suppression ON "comparaisons_sources_resultats";
DROP TRIGGER IF EXISTS comparaisons_sources_projet_troncature ON "comparaisons_sources_projet";
DROP TRIGGER IF EXISTS comparaisons_sources_projet_ajout_seul ON "comparaisons_sources_projet";
DROP TRIGGER IF EXISTS regles_rapprochement_sources_troncature ON "regles_rapprochement_sources";
DROP TRIGGER IF EXISTS regles_rapprochement_sources_modification ON "regles_rapprochement_sources";
DROP TRIGGER IF EXISTS regles_rapprochement_sources_suppression ON "regles_rapprochement_sources";
DROP TABLE IF EXISTS "comparaisons_sources_resultats";
DROP TABLE IF EXISTS "comparaisons_sources_projet";
DROP TABLE IF EXISTS "regles_rapprochement_sources";
DROP FUNCTION IF EXISTS comparaisons_sources_resultats_garde();
DROP FUNCTION IF EXISTS regles_rapprochement_immuable();
DROP FUNCTION IF EXISTS sources_ajout_seul();
DROP FUNCTION IF EXISTS sources_refuse_troncature();
DROP FUNCTION IF EXISTS sources_refuse_suppression();
DROP TYPE IF EXISTS "StatutResultatComparaison";

-- ===== Relations : preuve, declencheur et valeurs d'enumeration du lot B1 retablis =====
ALTER TABLE "reseau_relations" DROP CONSTRAINT IF EXISTS "rr_preuve_connexion";
ALTER TABLE "reseau_relations" DROP COLUMN IF EXISTS "preuve";
DROP TYPE IF EXISTS "PreuveConnexionReseau";
ALTER TABLE "reseau_relations" DROP CONSTRAINT IF EXISTS "rr_manuelle_decidee";
ALTER TABLE "reseau_relations" ADD CONSTRAINT "rr_manuelle_decidee" CHECK ("origine" <> 'MANUELLE' OR "statut" <> 'PROPOSEE');

-- Fonction de controle des relations telle que la migration 20261101200000 l'a definie (texte identique).
CREATE OR REPLACE FUNCTION reseau_relation_controle() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  s RECORD;
  c RECORD;
  ns "NatureObjetReseau";
  nc "NatureObjetReseau";
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."projetId" <> OLD."projetId" OR NEW."typeRelation" <> OLD."typeRelation" OR NEW."sourceObjetId" <> OLD."sourceObjetId"
       OR NEW."cibleObjetId" <> OLD."cibleObjetId" OR NEW."origine" <> OLD."origine" OR NEW."creeParId" <> OLD."creeParId"
       OR NEW."createdAt" <> OLD."createdAt" OR NEW."proposition" IS DISTINCT FROM OLD."proposition" THEN
      RAISE EXCEPTION 'reseau_relations : seuls le statut et la decision d''une relation changent (extremites, type, origine et proposition sont figes)'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT ob."typeGeom", j."projetId" INTO s FROM "projets_voirie_objets" ob JOIN "projets_voirie_jeux" j ON j."id" = ob."jeuId" WHERE ob."id" = NEW."sourceObjetId";
  IF NOT FOUND THEN RAISE EXCEPTION 'reseau_relations : objet source % inconnu', NEW."sourceObjetId" USING ERRCODE = 'foreign_key_violation'; END IF;
  SELECT ob."typeGeom", j."projetId" INTO c FROM "projets_voirie_objets" ob JOIN "projets_voirie_jeux" j ON j."id" = ob."jeuId" WHERE ob."id" = NEW."cibleObjetId";
  IF NOT FOUND THEN RAISE EXCEPTION 'reseau_relations : objet cible % inconnu', NEW."cibleObjetId" USING ERRCODE = 'foreign_key_violation'; END IF;
  IF s."projetId" <> NEW."projetId" OR c."projetId" <> NEW."projetId" THEN
    RAISE EXCEPTION 'reseau_relations : les deux objets doivent appartenir au projet de la relation' USING ERRCODE = 'check_violation';
  END IF;
  ns := reseau_nature_effective(NEW."sourceObjetId");
  nc := reseau_nature_effective(NEW."cibleObjetId");
  IF NEW."typeRelation" = 'PORTE_PAR' THEN
    IF ns <> 'CIRCUIT_LOGIQUE' OR nc <> 'ACTIF_PHYSIQUE' THEN
      RAISE EXCEPTION 'reseau_relations : PORTE_PAR relie un circuit logique a une infrastructure physique (recu : % -> %)', ns, nc USING ERRCODE = 'check_violation';
    END IF;
    IF s."typeGeom" <> 'LIGNE' OR c."typeGeom" <> 'LIGNE' THEN
      RAISE EXCEPTION 'reseau_relations : PORTE_PAR relie deux lignes' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF ns <> 'EQUIPEMENT' OR nc <> 'ACTIF_PHYSIQUE' THEN
      RAISE EXCEPTION 'reseau_relations : CONTENU_DANS relie un equipement a une infrastructure physique (recu : % -> %)', ns, nc USING ERRCODE = 'check_violation';
    END IF;
    IF s."typeGeom" <> 'POINT' OR c."typeGeom" NOT IN ('POINT', 'POLYGONE') THEN
      RAISE EXCEPTION 'reseau_relations : CONTENU_DANS relie un point a un point ou a un polygone' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

-- Retrait d'une valeur d'enumeration : PostgreSQL ne sait pas la retirer, le type est reconstruit (meme helper que la descente du lot B2) ;
-- refuse, sans derogation, si une ligne porte la valeur (la garde ci-dessus l'a deja verifie : defense en profondeur).
CREATE FUNCTION pg_temp.retirer_valeurs_enum(p_type text, p_valeurs text[]) RETURNS void
LANGUAGE plpgsql AS $f$
DECLARE
  c record;
  v_n bigint;
  v_labels text;
  v_defaut text;
  v_ancien text := p_type || '_avant_descente';
BEGIN
  FOR c IN
    SELECT n.nspname AS s, cl.relname AS t, a.attname AS col
      FROM pg_attribute a
      JOIN pg_class cl ON cl.oid = a.attrelid AND cl.relkind IN ('r', 'p')
      JOIN pg_namespace n ON n.oid = cl.relnamespace
      JOIN pg_type ty ON ty.oid = a.atttypid
     WHERE ty.typname = p_type AND a.attnum > 0 AND NOT a.attisdropped AND n.nspname = 'public'
  LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I WHERE %I::text = ANY (%L::text[])', c.s, c.t, c.col, p_valeurs) INTO v_n;
    IF v_n > 0 THEN
      RAISE EXCEPTION 'DESCENTE REFUSEE : % ligne(s) de %.% portent une valeur a retirer du type % (%). Aucune valeur de remplacement n''est inventee : decision metier.', v_n, c.t, c.col, p_type, p_valeurs;
    END IF;
  END LOOP;

  SELECT string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) INTO v_labels
    FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
   WHERE t.typname = p_type AND e.enumlabel <> ALL (p_valeurs);

  EXECUTE format('ALTER TYPE %I RENAME TO %I', p_type, v_ancien);
  EXECUTE format('CREATE TYPE %I AS ENUM (%s)', p_type, v_labels);

  FOR c IN
    SELECT n.nspname AS s, cl.relname AS t, a.attname AS col, a.attrelid AS rel, a.attnum AS num
      FROM pg_attribute a
      JOIN pg_class cl ON cl.oid = a.attrelid AND cl.relkind IN ('r', 'p')
      JOIN pg_namespace n ON n.oid = cl.relnamespace
      JOIN pg_type ty ON ty.oid = a.atttypid
     WHERE ty.typname = v_ancien AND a.attnum > 0 AND NOT a.attisdropped AND n.nspname = 'public'
  LOOP
    SELECT replace(pg_get_expr(d.adbin, d.adrelid), quote_ident(v_ancien), quote_ident(p_type)) INTO v_defaut
      FROM pg_attrdef d WHERE d.adrelid = c.rel AND d.adnum = c.num;
    IF v_defaut IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I DROP DEFAULT', c.s, c.t, c.col);
    END IF;
    EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I TYPE %I USING %I::text::%I', c.s, c.t, c.col, p_type, c.col, p_type);
    IF v_defaut IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I SET DEFAULT %s', c.s, c.t, c.col, v_defaut);
    END IF;
  END LOOP;

  EXECUTE format('DROP TYPE %I', v_ancien);
END
$f$;

SELECT pg_temp.retirer_valeurs_enum('TypeRelationReseau', ARRAY['CONNECTE_A']);
SELECT pg_temp.retirer_valeurs_enum('OrigineRelationReseau', ARRAY['IMPORT_DECLARATIF']);

-- ===== Jeux : cle de version du socle (projet, role, concessionnaire) et retrait de la methode d'acquisition =====
DROP INDEX IF EXISTS "projets_voirie_jeux_cle_autorise_key";
DROP INDEX IF EXISTS "projets_voirie_jeux_cle_attente_key";
ALTER TABLE "projets_voirie_jeux" DROP CONSTRAINT IF EXISTS "pvj_methode_acquisition_forme";
ALTER TABLE "projets_voirie_jeux" DROP COLUMN IF EXISTS "methodeAcquisition";
CREATE UNIQUE INDEX IF NOT EXISTS "projets_voirie_jeux_cle_autorise_key" ON "projets_voirie_jeux" ("projetId", "role", COALESCE("concessionnaireId", '')) WHERE "statut" = 'AUTORISE' AND "role" <> 'AUTRE';
CREATE UNIQUE INDEX IF NOT EXISTS "projets_voirie_jeux_cle_attente_key" ON "projets_voirie_jeux" ("projetId", "role", COALESCE("concessionnaireId", '')) WHERE "statut" IN ('RECU', 'CONTROLE') AND "role" <> 'AUTRE';

-- Apres une descente reussie, retirer la ligne de l'historique de Prisma :
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261103300000_multi_sources_comparaison';

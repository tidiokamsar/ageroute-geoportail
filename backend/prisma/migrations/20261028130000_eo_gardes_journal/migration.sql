-- OBSERVATION DE LA TERRE, LOT 1 (EO-FIX-BACK) : GARDES DU JOURNAL ET DU REGISTRE DES PRODUITS
--
-- Une relecture independante des migrations 20261028100000 et 20261028110000, attaquee en SQL direct avec de VRAIS commits, a trouve quatre
-- trous (non atteignables par l'API, mais le registre doit tenir meme face a un acces direct a la base) :
--
--   (a) un changement de `motifAttente` (EN_ATTENTE : INFO_DEMANDEE vers AUTRE) n'ecrivait aucune ligne de journal : le declencheur differe
--       ne regardait que le STATUT ;
--   (b) trois changements de statut dans une transaction avec seulement DEUX lignes de journal passaient : le declencheur appariait chaque
--       changement a une ligne portant le meme couple (de, vers), SANS COMPTER (une meme ligne servait deux fois) ;
--   (c) `verifieeParId` pouvait differer de l'auteur de la ligne de journal du verdict : un verdict signe d'un autre nom que celui qui l'a rendu ;
--   (d) `earth_observation_products` n'avait aucun garde : `synthetique`, `emprise`, `dateAcquisition` (et toute la provenance) se modifiaient
--       apres le depot des propositions ; la vue `coherence_teledetection` passait a 9 anomalies apres un seul UPDATE.
--
-- CE QUE CETTE MIGRATION FAIT
--
--   1. COMPTAGE EXACT (a, b). Un declencheur ordinaire, apres chaque UPDATE qui change le statut OU le motif d'attente, note le changement
--      (de > vers > motif) dans une variable de la TRANSACTION (`set_config(..., true)` : locale, annulee par un ROLLBACK ou un
--      ROLLBACK TO SAVEPOINT, jamais partagee entre transactions). Au COMMIT, le declencheur differe compare cette liste aux lignes de
--      journal de la meme transaction : chaque changement exige SA ligne (comparaison de multiensembles, pas d'appariement par couple),
--      et une ligne de journal qui ne correspond a aucun changement est refusee, sauf la « nouvelle demande » EN_ATTENTE vers EN_ATTENTE
--      (le contrat l'admet : elle ne change aucune colonne).
--   2. AUTEUR DU VERDICT (c). Un verdict (CONFIRMEE, INFIRMEE) rendu dans la transaction exige que `verifieeParId` soit l'auteur de la
--      ligne de journal qui l'a rendu.
--   3. PRODUITS (d). Un declencheur refuse de modifier les colonnes de provenance, de date, de resolution et d'emprise d'un produit.
--      Seul passage : une correction EXPLICITE, documentee et journalisee, avec un motif et un auteur poses dans la transaction :
--
--          SET LOCAL bdri.correction_produit_motif  = 'Emprise recalculee : ancienne valeur fausse (ticket ...)';
--          SET LOCAL bdri.correction_produit_auteur = '<identifiant du compte qui corrige>';
--
--      Chaque correction ecrit une ligne `audit_logs` (UPDATE, EarthObservationProduct) avec l'ancienne et la nouvelle valeur de chaque
--      colonne changee et le motif. Restent modifiables sans passage : `cycleVie`, `empreinteSha256`, `stockageChemin` (le produit est
--      telecharge, traite...), `incertitude`, `autorisationDepenseRef`, `deletedAt`.
--
-- CE QU'ELLE NE FAIT PAS : elle ne modifie aucune ligne ; elle ne supprime rien. LIMITE : un acces superutilisateur avec
-- `session_replication_role = replica` desactive les declencheurs ; un acces qui forge lui-meme la variable de comptage de la transaction
-- n'est pas couvert (le registre protege des erreurs et des contournements ordinaires, pas d'un administrateur de base decide).
-- Le mode IMMEDIATE (`SET CONSTRAINTS ... IMMEDIATE`) controle a chaque ecriture : il exige alors qu'une ligne de journal n'arrive pas
-- AVANT le dernier changement qu'elle couvre quand plusieurs changements se suivent dans la meme transaction (le mode par defaut, differe,
-- n'a pas cette contrainte : l'ordre est libre).
--
-- NATURE : additive. Fonctions et declencheurs seulement (CREATE OR REPLACE, DROP TRIGGER IF EXISTS). Idempotente.

-- ===== 1. Note des changements, par transaction =====

CREATE OR REPLACE FUNCTION propositions_teledetection_note_changement() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_cle text := 'bdri.ptc_' || md5(NEW."id");
  v_ligne text := OLD."statut" || '>' || NEW."statut" || '>' || coalesce(NEW."motifAttente", '-');
  v_acquis text := coalesce(current_setting(v_cle, true), '');
BEGIN
  PERFORM set_config(v_cle, CASE WHEN v_acquis = '' THEN v_ligne ELSE v_acquis || '|' || v_ligne END, true);
  RETURN NULL;
END;
$fn$;

-- LE NOM COMPTE : les declencheurs d'un meme evenement se jouent dans l'ordre alphabetique de leur nom. En mode IMMEDIATE (SET CONSTRAINTS ... IMMEDIATE,
-- utilise par les bancs), le declencheur de contrainte `propositions_teledetection_journal_exige` se joue a la fin de l'instruction : la note du
-- changement doit etre ecrite AVANT, d'ou le « a_ » qui place ce declencheur devant lui.
DROP TRIGGER IF EXISTS propositions_teledetection_a_note_changement ON "propositions_teledetection";
CREATE TRIGGER propositions_teledetection_a_note_changement
  AFTER UPDATE ON "propositions_teledetection"
  FOR EACH ROW
  WHEN (OLD."statut" IS DISTINCT FROM NEW."statut" OR OLD."motifAttente" IS DISTINCT FROM NEW."motifAttente")
  EXECUTE FUNCTION propositions_teledetection_note_changement();

-- ===== 2. Journal exige : comptage exact, auteur du verdict =====

CREATE OR REPLACE FUNCTION propositions_teledetection_exige_journal() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_brut text := coalesce(current_setting('bdri.ptc_' || md5(NEW."id"), true), '');
  v_changements text[] := CASE WHEN v_brut = '' THEN ARRAY[]::text[] ELSE string_to_array(v_brut, '|') END;
  v_sans_ligne text;
  v_ligne_sans_changement text;
  v_p record;
BEGIN
  -- Chaque changement exige SA ligne : EXCEPT ALL compte (un changement de plus que de lignes du meme couple laisse un reste).
  SELECT q.x INTO v_sans_ligne FROM (
    SELECT unnest(v_changements) AS x
    EXCEPT ALL
    SELECT t."de" || '>' || t."vers" || '>' || coalesce(t."motifAttente", '-')
      FROM "propositions_teledetection_transitions" t
     WHERE t."propositionId" = NEW."id" AND t."transactionId" = txid_current()
  ) q LIMIT 1;
  IF v_sans_ligne IS NOT NULL THEN
    RAISE EXCEPTION 'propositions_teledetection : le changement % de la proposition % n''a pas SA ligne de journal dans la meme transaction (une ligne ne couvre qu''un changement)',
      v_sans_ligne, NEW."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Une ligne de journal sans changement correspondant est un mensonge du journal. Seule exception : la nouvelle demande
  -- EN_ATTENTE vers EN_ATTENTE (aucune colonne ne change quand le motif d'attente reste le meme).
  SELECT q.x INTO v_ligne_sans_changement FROM (
    SELECT t."de" || '>' || t."vers" || '>' || coalesce(t."motifAttente", '-') AS x
      FROM "propositions_teledetection_transitions" t
     WHERE t."propositionId" = NEW."id" AND t."transactionId" = txid_current()
    EXCEPT ALL
    SELECT unnest(v_changements)
  ) q WHERE q.x NOT LIKE 'EN_ATTENTE>EN_ATTENTE>%' LIMIT 1;
  IF v_ligne_sans_changement IS NOT NULL THEN
    RAISE EXCEPTION 'propositions_teledetection : la ligne de journal % de la proposition % ne correspond a aucun changement de la transaction',
      v_ligne_sans_changement, NEW."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Le verdict est signe par l'auteur de la ligne de journal qui l'a rendu.
  SELECT "statut", "verifieeParId" INTO v_p FROM "propositions_teledetection" WHERE "id" = NEW."id";
  IF v_p."statut" IN ('CONFIRMEE', 'INFIRMEE')
     AND EXISTS (SELECT 1 FROM unnest(v_changements) c WHERE c LIKE '%>' || v_p."statut" || '>%')
     AND NOT EXISTS (
       SELECT 1 FROM "propositions_teledetection_transitions" t
        WHERE t."propositionId" = NEW."id" AND t."transactionId" = txid_current()
          AND t."vers" = v_p."statut" AND t."auteurId" = v_p."verifieeParId") THEN
    RAISE EXCEPTION 'propositions_teledetection : le verdict % de la proposition % n''est pas signe par l''auteur de sa ligne de journal',
      v_p."statut", NEW."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS propositions_teledetection_journal_exige ON "propositions_teledetection";
CREATE CONSTRAINT TRIGGER propositions_teledetection_journal_exige
  AFTER UPDATE ON "propositions_teledetection"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD."statut" IS DISTINCT FROM NEW."statut" OR OLD."motifAttente" IS DISTINCT FROM NEW."motifAttente")
  EXECUTE FUNCTION propositions_teledetection_exige_journal();

-- ===== 3. Produits : provenance, dates et emprise figees =====

CREATE OR REPLACE FUNCTION earth_observation_products_garde() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_avant jsonb := to_jsonb(OLD) - ARRAY['emprise', 'cycleVie', 'empreinteSha256', 'stockageChemin', 'incertitude', 'autorisationDepenseRef', 'deletedAt'];
  v_apres jsonb := to_jsonb(NEW) - ARRAY['emprise', 'cycleVie', 'empreinteSha256', 'stockageChemin', 'incertitude', 'autorisationDepenseRef', 'deletedAt'];
  v_changes jsonb;
  v_motif text := btrim(coalesce(current_setting('bdri.correction_produit_motif', true), ''));
  v_auteur text := btrim(coalesce(current_setting('bdri.correction_produit_auteur', true), ''));
BEGIN
  SELECT coalesce(jsonb_object_agg(a.key, jsonb_build_object('avant', a.value, 'apres', v_apres -> a.key)), '{}'::jsonb)
    INTO v_changes
    FROM jsonb_each(v_avant) a
   WHERE v_apres -> a.key IS DISTINCT FROM a.value;
  IF NOT ST_Equals(NEW."emprise", OLD."emprise") THEN
    v_changes := v_changes || jsonb_build_object('emprise', jsonb_build_object('avant', ST_AsText(OLD."emprise"), 'apres', ST_AsText(NEW."emprise")));
  END IF;
  IF v_changes = '{}'::jsonb THEN
    RETURN NEW;
  END IF;

  IF length(v_motif) < 10 OR v_auteur = '' THEN
    RAISE EXCEPTION 'earth_observation_products : la provenance, les dates, la resolution et l''emprise d''un produit sont figees (colonnes touchees : %). Correction exceptionnelle : SET LOCAL bdri.correction_produit_motif (10 caracteres au moins) et bdri.correction_produit_auteur dans la transaction ; elle est journalisee dans audit_logs.',
      (SELECT string_agg(k, ', ' ORDER BY k) FROM jsonb_object_keys(v_changes) k)
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "users" WHERE "id" = v_auteur) THEN
    RAISE EXCEPTION 'earth_observation_products : l''auteur de la correction (%) n''est pas un compte connu', v_auteur
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  INSERT INTO "audit_logs" ("id", "userId", "action", "entityType", "entityId", "before", "after")
  VALUES (gen_random_uuid()::text, v_auteur, 'UPDATE', 'EarthObservationProduct', OLD."id",
          jsonb_build_object('operation', 'CORRECTION_PRODUIT_FIGE', 'motif', v_motif,
                             'colonnes', (SELECT jsonb_object_agg(e.key, e.value -> 'avant') FROM jsonb_each(v_changes) e)),
          jsonb_build_object('operation', 'CORRECTION_PRODUIT_FIGE', 'motif', v_motif,
                             'colonnes', (SELECT jsonb_object_agg(e.key, e.value -> 'apres') FROM jsonb_each(v_changes) e)));
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS earth_observation_products_garde ON "earth_observation_products";
CREATE TRIGGER earth_observation_products_garde
  BEFORE UPDATE ON "earth_observation_products"
  FOR EACH ROW EXECUTE FUNCTION earth_observation_products_garde();

COMMENT ON FUNCTION propositions_teledetection_exige_journal() IS
  'Au COMMIT : chaque changement de statut ou de motif d''attente a SA ligne de journal (comptage exact), aucune ligne ne ment, le verdict est signe par l''auteur de sa ligne.';
COMMENT ON FUNCTION earth_observation_products_garde() IS
  'Provenance, dates, resolution et emprise d''un produit figees ; correction exceptionnelle par bdri.correction_produit_motif et bdri.correction_produit_auteur, journalisee dans audit_logs.';

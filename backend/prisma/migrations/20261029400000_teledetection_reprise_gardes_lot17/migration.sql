-- OBSERVATION DE LA TERRE : REPRISE DES GARDES DE COHERENCE DE LOT/17 PERDUES A LA FUSION
--
-- `20261025120000_teledetection_coherence_complements` (lot/17) a ajoute des gardes en base ; puis
-- `20261028110000_eo_propositions_workflow` (module Observation de la Terre) a REDEFINI, dans sa section 6,
-- la fonction `propositions_teledetection_coherence()` a partir de la version d'origine de
-- `20261022020000` : ordre alphabetique des dossiers, EO passe apres lot/17 et en a ecrase les ajouts.
-- `20261028130000_eo_gardes_journal` a de meme redefini `earth_observation_products_garde()`.
--
-- Trois gardes d'INSERTION perdues, reprises ici avec leurs messages d'origine :
--   1. une proposition sur un produit RETIRE du registre (deletedAt) est refusee ;
--   2. une proposition dont le produit de REFERENCE est retire est refusee ;
--   3. un rattachement se MESURE : troncon vivant et avec geometrie, distance declaree egale (a 0,01 m pres)
--      a la distance reelle (geographie) ; sinon refus.
-- Les controles propres a EO sont conserves a l'identique : entree A_VERIFIER seulement, region du troncon,
-- donnee synthetique jamais melangee a un produit reel, emprise et anteriorite de la reference.
--
-- Garde du registre : la regle de lot/17 « un produit cite par des propositions a sa provenance figee »
-- est SURPASSEE par celle d'EO (provenance, dates, resolution et emprise figees pour TOUT produit, correction
-- exceptionnelle motivee et journalisee) : elle n'est pas reprise. Reste perdu, et repris : la SUPPRESSION
-- PHYSIQUE d'un produit (regle 2 d'AGENTS.md : on retire par deletedAt), car le declencheur d'EO ne couvre
-- plus que UPDATE. Un declencheur BEFORE DELETE distinct la refuse, avec le message de lot/17 ; la fonction
-- `earth_observation_products_garde()` d'EO n'est PAS touchee.
--
-- NATURE : additive. Aucune ligne touchee. Rejouable (CREATE OR REPLACE, DROP TRIGGER IF EXISTS).

CREATE OR REPLACE FUNCTION propositions_teledetection_coherence() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  p_emprise geometry; p_date timestamp(3); p_synth boolean; p_retire timestamp(3);
  r_emprise geometry; r_date timestamp(3); r_synth boolean; r_retire timestamp(3);
  t_region integer;
  d double precision;
BEGIN
  IF NEW."statut" <> 'A_VERIFIER' THEN
    RAISE EXCEPTION 'propositions_teledetection : une proposition entre A_VERIFIER (statut % refuse a l''insertion)', NEW."statut"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "emprise", "dateAcquisition", "synthetique", "deletedAt" INTO p_emprise, p_date, p_synth, p_retire
    FROM "earth_observation_products" WHERE "id" = NEW."produitId";
  -- Produit inexistant : la cle etrangere le refuse ensuite, avec son propre message.
  IF p_retire IS NOT NULL THEN
    RAISE EXCEPTION 'propositions_teledetection : le produit % est retire du registre', NEW."produitId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_emprise IS NOT NULL AND NOT ST_Intersects(p_emprise, NEW."geom") THEN
    RAISE EXCEPTION 'propositions_teledetection : la detection est hors de l''emprise du produit %', NEW."produitId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_emprise IS NOT NULL AND p_synth IS DISTINCT FROM NEW."synthetique" THEN
    RAISE EXCEPTION 'propositions_teledetection : donnee synthetique et produit reel (ou l''inverse) ne se melangent pas (produit %)', NEW."produitId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."produitReferenceId" IS NOT NULL THEN
    SELECT "emprise", "dateAcquisition", "synthetique", "deletedAt" INTO r_emprise, r_date, r_synth, r_retire
      FROM "earth_observation_products" WHERE "id" = NEW."produitReferenceId";
    IF r_retire IS NOT NULL THEN
      RAISE EXCEPTION 'propositions_teledetection : le produit de reference % est retire du registre', NEW."produitReferenceId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF r_date IS NOT NULL AND r_date >= p_date THEN
      RAISE EXCEPTION 'propositions_teledetection : le produit de reference (%) doit etre acquis avant le produit analyse (%)', r_date, p_date
        USING ERRCODE = 'check_violation';
    END IF;
    IF r_emprise IS NOT NULL AND NOT ST_Intersects(r_emprise, NEW."geom") THEN
      RAISE EXCEPTION 'propositions_teledetection : la detection est hors de l''emprise du produit de reference %', NEW."produitReferenceId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF r_emprise IS NOT NULL AND r_synth IS DISTINCT FROM NEW."synthetique" THEN
      RAISE EXCEPTION 'propositions_teledetection : donnee synthetique et produit de reference reel (ou l''inverse) ne se melangent pas (produit %)', NEW."produitReferenceId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."tronconId" IS NOT NULL THEN
    SELECT "regionId" INTO t_region FROM "troncons" WHERE "id" = NEW."tronconId";
    IF NEW."regionId" IS NULL THEN
      NEW."regionId" := t_region;
    ELSIF t_region IS NOT NULL AND NEW."regionId" <> t_region THEN
      RAISE EXCEPTION 'propositions_teledetection : la region (%) n''est pas celle du troncon (%)', NEW."regionId", t_region
        USING ERRCODE = 'check_violation';
    END IF;
    -- Un rattachement se MESURE : troncon vivant, distance egale au centimetre a la distance reelle.
    -- La contrainte `pt_rattachement` exige deja les deux colonnes ensemble.
    IF NEW."distanceTronconM" IS NOT NULL THEN
      SELECT ST_Distance(t."geom"::geography, NEW."geom"::geography) INTO d
        FROM "troncons" t WHERE t."id" = NEW."tronconId" AND t."deletedAt" IS NULL AND t."geom" IS NOT NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'propositions_teledetection : troncon % absent, retire ou sans geometrie', NEW."tronconId"
          USING ERRCODE = 'check_violation';
      END IF;
      IF abs(d - NEW."distanceTronconM") > 0.01 THEN
        RAISE EXCEPTION 'propositions_teledetection : distance au troncon declaree % m, mesuree % m', NEW."distanceTronconM", round(d::numeric, 2)
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

-- Le declencheur d'insertion existe deja (20261028110000) et pointe sur la fonction par son nom : rien a recreer.

-- ===== Registre : aucune suppression physique =====
CREATE OR REPLACE FUNCTION earth_observation_products_suppression_garde() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'earth_observation_products : suppression physique refusee, retirer par deletedAt'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$fn$;

DROP TRIGGER IF EXISTS earth_observation_products_suppression ON "earth_observation_products";
CREATE TRIGGER earth_observation_products_suppression
  BEFORE DELETE ON "earth_observation_products"
  FOR EACH ROW EXECUTE FUNCTION earth_observation_products_suppression_garde();

COMMENT ON FUNCTION earth_observation_products_suppression_garde() IS
  'Aucun produit du registre ne se supprime physiquement (retirer par deletedAt) ; reprise de la garde de 20261025120000, perdue quand 20261028130000 a redefini le declencheur du registre en UPDATE seulement.';

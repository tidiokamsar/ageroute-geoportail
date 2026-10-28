-- RETOUR ARRIERE de `20261029400000_teledetection_reprise_gardes_lot17`.
--
-- CE QUI EST PERDU : aucune donnee (la migration n'en touche aucune). La fonction du declencheur d'insertion des
-- propositions reprend EXACTEMENT sa definition de `20261028110000_eo_propositions_workflow` (section 6, recopiee
-- ci-dessous) ; le declencheur et la fonction de refus de suppression physique du registre disparaissent.
-- Apres descente, la base accepte de nouveau une proposition sur un produit (ou une reference) retire, une distance
-- au troncon declaree au lieu d'etre mesuree, un rattachement a un troncon retire, et la suppression physique d'un produit.
--
-- EXECUTION : dans UNE transaction :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261029400000_teledetection_reprise_gardes_lot17.sql

DROP TRIGGER IF EXISTS earth_observation_products_suppression ON "earth_observation_products";
DROP FUNCTION IF EXISTS earth_observation_products_suppression_garde();

CREATE OR REPLACE FUNCTION propositions_teledetection_coherence() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  p_emprise geometry; p_date timestamp(3); p_synth boolean;
  r_emprise geometry; r_date timestamp(3); r_synth boolean;
  t_region integer;
BEGIN
  IF NEW."statut" <> 'A_VERIFIER' THEN
    RAISE EXCEPTION 'propositions_teledetection : une proposition entre A_VERIFIER (statut % refuse a l''insertion)', NEW."statut"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "emprise", "dateAcquisition", "synthetique" INTO p_emprise, p_date, p_synth
    FROM "earth_observation_products" WHERE "id" = NEW."produitId";
  -- Produit inexistant : la cle etrangere le refuse ensuite, avec son propre message.
  IF p_emprise IS NOT NULL AND NOT ST_Intersects(p_emprise, NEW."geom") THEN
    RAISE EXCEPTION 'propositions_teledetection : la detection est hors de l''emprise du produit %', NEW."produitId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_emprise IS NOT NULL AND p_synth IS DISTINCT FROM NEW."synthetique" THEN
    RAISE EXCEPTION 'propositions_teledetection : donnee synthetique et produit reel (ou l''inverse) ne se melangent pas (produit %)', NEW."produitId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."produitReferenceId" IS NOT NULL THEN
    SELECT "emprise", "dateAcquisition", "synthetique" INTO r_emprise, r_date, r_synth
      FROM "earth_observation_products" WHERE "id" = NEW."produitReferenceId";
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
  END IF;
  RETURN NEW;
END;
$fn$;

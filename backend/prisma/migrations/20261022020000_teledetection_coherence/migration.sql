-- Observation de la Terre (partie E, A30) : coherence registre / propositions / verdicts.
--
-- Deux regles manquaient au depot des propositions, et la base ne les tenait pas :
--
--   1. une detection se trouve dans l'EMPRISE du produit qui l'a produite (et dans celle du produit
--      de reference quand il y en a un) : une image ne voit rien hors de sa scene ;
--   2. une comparaison de deux dates compare une image ANTERIEURE a une image posterieure : le
--      produit de reference est acquis strictement avant le produit analyse.
--
-- Elles sont tenues a l'insertion (la detection est ensuite figee par `propositions_teledetection_garde`).
-- La vue `coherence_teledetection` liste ce que ces regles et les autres invariants signaleraient
-- sur des lignes deja presentes (une ligne = une anomalie) : elle doit rester vide.
--
-- Additive : un declencheur, une fonction, une vue. Aucune donnee touchee.

CREATE OR REPLACE FUNCTION propositions_teledetection_coherence() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  p_emprise geometry; p_date timestamp(3);
  r_emprise geometry; r_date timestamp(3);
BEGIN
  SELECT "emprise", "dateAcquisition" INTO p_emprise, p_date
    FROM "earth_observation_products" WHERE "id" = NEW."produitId";
  -- Produit inexistant : la cle etrangere le refuse ensuite, avec son propre message.
  IF p_emprise IS NOT NULL AND NOT ST_Intersects(p_emprise, NEW."geom") THEN
    RAISE EXCEPTION 'propositions_teledetection : la detection est hors de l''emprise du produit %', NEW."produitId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."produitReferenceId" IS NOT NULL THEN
    SELECT "emprise", "dateAcquisition" INTO r_emprise, r_date
      FROM "earth_observation_products" WHERE "id" = NEW."produitReferenceId";
    IF r_date IS NOT NULL AND r_date >= p_date THEN
      RAISE EXCEPTION 'propositions_teledetection : le produit de reference (%) doit etre acquis avant le produit analyse (%)', r_date, p_date
        USING ERRCODE = 'check_violation';
    END IF;
    IF r_emprise IS NOT NULL AND NOT ST_Intersects(r_emprise, NEW."geom") THEN
      RAISE EXCEPTION 'propositions_teledetection : la detection est hors de l''emprise du produit de reference %', NEW."produitReferenceId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS propositions_teledetection_coherence ON "propositions_teledetection";
CREATE TRIGGER propositions_teledetection_coherence
  BEFORE INSERT ON "propositions_teledetection"
  FOR EACH ROW EXECUTE FUNCTION propositions_teledetection_coherence();

-- Une ligne par anomalie : (proposition, regle, detail). Vide quand tout est coherent.
CREATE OR REPLACE VIEW "coherence_teledetection" AS
SELECT pt."id" AS "propositionId", 'HORS_EMPRISE_PRODUIT'::text AS "regle", p."code" AS "detail"
  FROM "propositions_teledetection" pt JOIN "earth_observation_products" p ON p."id" = pt."produitId"
 WHERE NOT ST_Intersects(p."emprise", pt."geom")
UNION ALL
SELECT pt."id", 'HORS_EMPRISE_REFERENCE', r."code"
  FROM "propositions_teledetection" pt JOIN "earth_observation_products" r ON r."id" = pt."produitReferenceId"
 WHERE NOT ST_Intersects(r."emprise", pt."geom")
UNION ALL
SELECT pt."id", 'REFERENCE_NON_ANTERIEURE', r."code" || ' >= ' || p."code"
  FROM "propositions_teledetection" pt
  JOIN "earth_observation_products" p ON p."id" = pt."produitId"
  JOIN "earth_observation_products" r ON r."id" = pt."produitReferenceId"
 WHERE r."dateAcquisition" >= p."dateAcquisition"
UNION ALL
-- Le troncon de rattachement a ete supprime (logiquement) depuis : la proposition reste, figee,
-- mais son rattachement ne designe plus un troncon vivant.
SELECT pt."id", 'TRONCON_SUPPRIME', t."code"
  FROM "propositions_teledetection" pt JOIN "troncons" t ON t."id" = pt."tronconId"
 WHERE t."deletedAt" IS NOT NULL
UNION ALL
SELECT pt."id", 'VERDICT_AVANT_DEPOT', to_char(pt."verifieeLe", 'YYYY-MM-DD HH24:MI:SS')
  FROM "propositions_teledetection" pt
 WHERE pt."verifieeLe" IS NOT NULL AND pt."verifieeLe" < pt."createdAt";

COMMENT ON VIEW "coherence_teledetection" IS
  'Anomalies de coherence de la partie E (une ligne par anomalie). Doit rester vide.';

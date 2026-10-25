-- RETOUR ARRIERE de `20261025120000_teledetection_coherence_complements`.
--
-- CE QUI EST PERDU : aucune donnee. La fonction du declencheur et la vue reprennent EXACTEMENT leur
-- definition de `20261022020000_teledetection_coherence` (recopiee ci-dessous) ; le declencheur du
-- registre disparait. Apres descente, la base accepte de nouveau une proposition sur un produit
-- retire, une distance au troncon declaree, la modification d'un produit cite et sa suppression
-- physique, et la vue ne dit plus les trois anomalies ajoutees.
--
-- Verifiee par le banc `verifier.sh` (schema compare objet par objet, aller-retour).

DROP TRIGGER IF EXISTS earth_observation_products_garde ON "earth_observation_products";
DROP FUNCTION IF EXISTS earth_observation_products_garde();

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

-- La vue perd des lignes : CREATE OR REPLACE ne le permet pas, on la recree.
DROP VIEW IF EXISTS "coherence_teledetection";
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

-- Et la ligne de `_prisma_migrations` :
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261025120000_teledetection_coherence_complements';

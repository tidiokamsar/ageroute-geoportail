-- OBSERVATION DE LA TERRE : COMPLEMENTS DE COHERENCE (partie E, A30)
--
-- `20261022020000_teledetection_coherence` tient a l'insertion l'emprise du produit et de la
-- reference, et l'anteriorite de la reference ; sa vue nomme cinq anomalies. Restaient ouverts :
--
--   1. une proposition deposee sur un produit (ou une reference) RETIRE du registre ;
--   2. un rattachement a un troncon retire, ou a une DISTANCE DECLAREE au lieu d'etre mesuree : le
--      service la calcule, mais rien n'empechait un autre chemin d'ecriture d'en affirmer une ;
--   3. un produit cite par des propositions dont la provenance, la licence ou l'emprise seraient
--      MODIFIEES ensuite (la precision mesuree se rapporterait a un autre produit), et sa
--      suppression PHYSIQUE (regle 2 d'AGENTS.md : on retire par `deletedAt`) ;
--   4. ce qui survient APRES le depot et que la vue ne disait pas : produit retire alors que des
--      propositions attendent leur verdict, mission terminee ou annulee sans verdict, verdict rendu
--      avant la fin de la mission de verification.
--
-- CE QUE CETTE MIGRATION FAIT : la fonction du declencheur existant est remplacee par une version
-- qui garde TOUTES ses regles (memes messages) et ajoute 1 et 2 ; un declencheur sur le registre
-- (3) ; la vue garde ses trois colonnes et ses cinq regles et en gagne trois (4).
--
-- La NATURE de la reference n'est pas contrainte : une reference optique d'avant la crue comparee
-- a un radar d'apres est une methode courante de cartographie des inondations.
--
-- NATURE : additive. Aucune ligne touchee.

CREATE OR REPLACE FUNCTION propositions_teledetection_coherence() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  p_emprise geometry; p_date timestamp(3); p_retire timestamp(3);
  r_emprise geometry; r_date timestamp(3); r_retire timestamp(3);
  d double precision;
BEGIN
  SELECT "emprise", "dateAcquisition", "deletedAt" INTO p_emprise, p_date, p_retire
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
  IF NEW."produitReferenceId" IS NOT NULL THEN
    SELECT "emprise", "dateAcquisition", "deletedAt" INTO r_emprise, r_date, r_retire
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
  END IF;
  -- Un rattachement se MESURE : troncon vivant, distance egale au centimetre a la distance reelle.
  -- La contrainte `pt_rattachement` exige deja les deux colonnes ensemble.
  IF NEW."tronconId" IS NOT NULL AND NEW."distanceTronconM" IS NOT NULL THEN
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
  RETURN NEW;
END;
$fn$;

-- ===== Le registre : ce qu'une proposition cite ne change plus, et rien ne se supprime =====
CREATE OR REPLACE FUNCTION earth_observation_products_garde() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'earth_observation_products : suppression physique refusee, retirer par deletedAt'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "propositions_teledetection" p WHERE p."produitId" = OLD."id" OR p."produitReferenceId" = OLD."id")
     AND (NEW."code" IS DISTINCT FROM OLD."code" OR NEW."palier" IS DISTINCT FROM OLD."palier"
       OR NEW."source" IS DISTINCT FROM OLD."source" OR NEW."nature" IS DISTINCT FROM OLD."nature"
       OR NEW."dateAcquisition" IS DISTINCT FROM OLD."dateAcquisition" OR NEW."dateFin" IS DISTINCT FROM OLD."dateFin"
       OR NEW."resolutionM" IS DISTINCT FROM OLD."resolutionM" OR NEW."couvertureNuagesPct" IS DISTINCT FROM OLD."couvertureNuagesPct"
       OR NEW."incertitude" IS DISTINCT FROM OLD."incertitude" OR NEW."provenance" IS DISTINCT FROM OLD."provenance"
       OR NEW."licence" IS DISTINCT FROM OLD."licence" OR NEW."versionTraitement" IS DISTINCT FROM OLD."versionTraitement"
       OR NEW."autorisationDepenseRef" IS DISTINCT FROM OLD."autorisationDepenseRef"
       OR NOT ST_Equals(NEW."emprise", OLD."emprise")) THEN
    RAISE EXCEPTION 'earth_observation_products : le produit % est cite par des propositions, sa provenance est figee', OLD."code"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS earth_observation_products_garde ON "earth_observation_products";
CREATE TRIGGER earth_observation_products_garde
  BEFORE UPDATE OR DELETE ON "earth_observation_products"
  FOR EACH ROW EXECUTE FUNCTION earth_observation_products_garde();

-- ===== La vue : memes colonnes, memes cinq regles, trois de plus =====
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
 WHERE pt."verifieeLe" IS NOT NULL AND pt."verifieeLe" < pt."createdAt"
UNION ALL
-- Le produit a ete retire du registre alors que des propositions attendent encore leur verdict.
SELECT pt."id", 'PRODUIT_RETIRE_EN_ATTENTE', p."code"
  FROM "propositions_teledetection" pt JOIN "earth_observation_products" p ON p."id" = pt."produitId"
 WHERE p."deletedAt" IS NOT NULL AND pt."statut" = 'A_VERIFIER'
UNION ALL
-- La mission de verification est close (terminee ou annulee) et aucun verdict n'a ete rendu.
SELECT pt."id", 'MISSION_SANS_VERDICT', m."code" || ' ' || m."statut"::text
  FROM "propositions_teledetection" pt JOIN "missions" m ON m."id" = pt."missionId"
 WHERE pt."statut" = 'A_VERIFIER' AND m."statut"::text IN ('TERMINEE', 'ANNULEE')
UNION ALL
-- Un verdict a ete rendu alors que la mission de verification n'etait pas terminee.
SELECT pt."id", 'VERDICT_AVANT_FIN_MISSION', m."code" || ' ' || m."statut"::text
  FROM "propositions_teledetection" pt JOIN "missions" m ON m."id" = pt."missionId"
 WHERE pt."statut" <> 'A_VERIFIER' AND m."statut"::text NOT IN ('TERMINEE', 'SYNC_EN_ATTENTE');

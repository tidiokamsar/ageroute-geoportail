-- OBSERVATION DE LA TERRE : COHERENCE DU REGISTRE, DES PROPOSITIONS ET DES VERDICTS (partie E, A30)
--
-- `20261020000000_observation_terre` tient chaque table pour elle-meme : un produit complet, une
-- proposition figee, un verdict unique. Elle ne tient pas les liens ENTRE elles. Trois incoherences
-- passaient donc la base sans bruit, et chacune fausse la mesure de precision :
--
--   1. une proposition HORS de l'emprise du produit dont elle se dit issue (une detection ne peut
--      venir que de ce que l'image couvre) ;
--   2. une comparaison de deux dates dont la REFERENCE n'est pas anterieure au produit, ou ne
--      couvre pas la geometrie. La nature n'est PAS contrainte : une reference optique d'avant la
--      crue comparee a un radar d'apres est une methode courante de cartographie des inondations ;
--   3. un produit dont la provenance, la licence ou l'emprise sont MODIFIEES apres que des
--      propositions s'y sont appuyees : la precision mesuree se rapporterait a un autre produit.
--
-- CE QUE CETTE MIGRATION FAIT
--
--   - un declencheur a l'INSERTION d'une proposition : produit vivant, geometrie dans son emprise,
--     reference anterieure et couvrant la geometrie, troncon rattache vivant et
--     distance egale (au centimetre) a la distance reelle -- une distance ne se saisit pas ;
--   - un declencheur sur le registre : un produit cite par une proposition a ses champs de
--     provenance FIGES ; aucune suppression physique d'un produit (regle 2 d'AGENTS.md : on retire
--     par `deletedAt`) ;
--   - une vue `coherence_teledetection` : ce que la base ne peut pas refuser a l'insertion parce que
--     cela survient APRES (produit retire avec des propositions en attente, troncon retire apres
--     rattachement, mission annulee ou terminee sans verdict, verdict rendu avant la fin de la
--     mission) et les lignes anterieures a cette migration.
--
-- CE QU'ELLE NE FAIT PAS : elle ne corrige aucune ligne, n'en retire aucune et n'invente aucun seuil.
--
-- NATURE : additive. Deux fonctions, deux declencheurs, une vue. Aucune ligne existante touchee.

CREATE OR REPLACE FUNCTION propositions_teledetection_coherence() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  prod RECORD;
  ref RECORD;
  prod_trouve boolean;
  d double precision;
BEGIN
  SELECT "nature", "dateAcquisition", "emprise", "deletedAt" INTO prod
    FROM "earth_observation_products" WHERE "id" = NEW."produitId";
  -- Produit absent : la cle etrangere le dira, avec son propre message.
  prod_trouve := FOUND;
  IF prod_trouve THEN
    IF prod."deletedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'propositions_teledetection : le produit % est retire du registre', NEW."produitId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT ST_Intersects(NEW."geom", prod."emprise") THEN
      RAISE EXCEPTION 'propositions_teledetection : geometrie hors de l''emprise du produit %', NEW."produitId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."produitReferenceId" IS NOT NULL THEN
    SELECT "nature", "dateAcquisition", "emprise", "deletedAt" INTO ref
      FROM "earth_observation_products" WHERE "id" = NEW."produitReferenceId";
    IF FOUND THEN
      IF ref."deletedAt" IS NOT NULL THEN
        RAISE EXCEPTION 'propositions_teledetection : le produit de reference % est retire du registre', NEW."produitReferenceId"
          USING ERRCODE = 'check_violation';
      END IF;
      -- Champs du produit lus seulement s'il existe : un RECORD non affecte leve une erreur.
      IF prod_trouve THEN
        IF ref."dateAcquisition" >= prod."dateAcquisition" THEN
          RAISE EXCEPTION 'propositions_teledetection : la reference (%) n''est pas anterieure au produit (%)', ref."dateAcquisition", prod."dateAcquisition"
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      IF NOT ST_Intersects(NEW."geom", ref."emprise") THEN
        RAISE EXCEPTION 'propositions_teledetection : geometrie hors de l''emprise du produit de reference %', NEW."produitReferenceId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NEW."tronconId" IS NOT NULL THEN
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

DROP TRIGGER IF EXISTS propositions_teledetection_coherence ON "propositions_teledetection";
CREATE TRIGGER propositions_teledetection_coherence
  BEFORE INSERT ON "propositions_teledetection"
  FOR EACH ROW EXECUTE FUNCTION propositions_teledetection_coherence();

-- ===== Le registre : ce qu'une proposition cite ne change plus =====
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

-- ===== Ce qui ne se refuse pas a l'insertion =====
--
-- Une ligne par anomalie. `gravite` : BLOQUANTE quand la mesure de precision est faussee,
-- A_EXAMINER quand une personne doit regarder (rien n'est faux, quelque chose est en suspens).
CREATE OR REPLACE VIEW "coherence_teledetection" AS
SELECT 'HORS_EMPRISE'::text AS "code", 'BLOQUANTE'::text AS "gravite", p."id" AS "propositionId", p."produitId",
       'geometrie hors de l''emprise du produit'::text AS "detail"
  FROM "propositions_teledetection" p JOIN "earth_observation_products" e ON e."id" = p."produitId"
 WHERE NOT ST_Intersects(p."geom", e."emprise")
UNION ALL
SELECT 'REFERENCE_INCOHERENTE', 'BLOQUANTE', p."id", p."produitId",
       CASE WHEN r."dateAcquisition" >= e."dateAcquisition" THEN 'reference non anterieure au produit'
            ELSE 'geometrie hors de l''emprise de la reference' END
  FROM "propositions_teledetection" p
  JOIN "earth_observation_products" e ON e."id" = p."produitId"
  JOIN "earth_observation_products" r ON r."id" = p."produitReferenceId"
 WHERE r."dateAcquisition" >= e."dateAcquisition" OR NOT ST_Intersects(p."geom", r."emprise")
UNION ALL
SELECT 'PRODUIT_RETIRE_EN_ATTENTE', 'A_EXAMINER', p."id", p."produitId",
       'produit retire du registre, proposition encore a verifier'
  FROM "propositions_teledetection" p JOIN "earth_observation_products" e ON e."id" = p."produitId"
 WHERE e."deletedAt" IS NOT NULL AND p."statut" = 'A_VERIFIER'
UNION ALL
SELECT 'TRONCON_RETIRE', 'A_EXAMINER', p."id", p."produitId",
       'rattachee au troncon ' || t."code" || ', retire depuis'
  FROM "propositions_teledetection" p JOIN "troncons" t ON t."id" = p."tronconId"
 WHERE t."deletedAt" IS NOT NULL
UNION ALL
SELECT 'MISSION_SANS_VERDICT', 'A_EXAMINER', p."id", p."produitId",
       'mission ' || m."code" || ' ' || m."statut"::text || ', aucun verdict rendu'
  FROM "propositions_teledetection" p JOIN "missions" m ON m."id" = p."missionId"
 WHERE p."statut" = 'A_VERIFIER' AND m."statut"::text IN ('TERMINEE', 'ANNULEE')
UNION ALL
SELECT 'VERDICT_AVANT_FIN_MISSION', 'A_EXAMINER', p."id", p."produitId",
       'verdict rendu alors que la mission ' || m."code" || ' est ' || m."statut"::text
  FROM "propositions_teledetection" p JOIN "missions" m ON m."id" = p."missionId"
 WHERE p."statut" <> 'A_VERIFIER' AND m."statut"::text NOT IN ('TERMINEE', 'SYNC_EN_ATTENTE');

COMMENT ON VIEW "coherence_teledetection" IS
  'Anomalies entre registre, propositions, missions et verdicts de teledetection (partie E). '
  'BLOQUANTE : la precision mesuree est faussee. A_EXAMINER : quelque chose est en suspens.';

-- RETOUR ARRIERE de `20261028110000_eo_propositions_workflow`.
--
-- CE QUI EST PERDU : le journal des transitions, les preuves de terrain citees, et, pour chaque proposition, la
-- priorite, la confiance de detection, la qualite d'image, le rattachement detaille (confiance, algorithme,
-- candidats), la methode en deux champs, les limites, le drapeau `synthetique`, le motif d'attente. La region
-- denormalisee est derivee du troncon et se recalcule : sa perte n'en est pas une.
--
-- DEUX GARDES.
--
--  1. SANS DEROGATION : si une proposition est EN_ATTENTE ou NON_CONCLUANTE, la descente refuse MEME avec
--     l'autorisation. L'ancienne contrainte ne connait que A_VERIFIER, CONFIRMEE et INFIRMEE : il faudrait
--     inventer un statut de remplacement, et le verdict du terrain n'est pas une valeur qu'on invente. Il faut
--     d'abord que ces propositions soient decidees (CONFIRMEE ou INFIRMEE) ou remises A_VERIFIER.
--  2. AVEC DEROGATION : si une ligne porte l'une des donnees ci-dessus, la descente refuse tant que la perte
--     n'est pas autorisee, apres sauvegarde verifiee (paragraphe A.5.2) :
--
--         SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- ATTENTION : la descente remet les anciennes versions des declencheurs `propositions_teledetection_garde` et
-- `propositions_teledetection_coherence`, et l'ancienne definition de la vue `precision_teledetection`.
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261028110000_eo_propositions_workflow.sql
--
-- GARDE-TEST-SANS-DEROGATION: INSERT INTO "users" ("id","email","nomComplet","passwordHash","role","updatedAt") VALUES ('g-u','g@local.invalid','x','x','GESTIONNAIRE',now()); INSERT INTO "earth_observation_products" ("id","code","palier","source","nature","dateAcquisition","resolutionM","incertitude","provenance","licence","versionTraitement","emprise","enregistreParId") VALUES ('g-p','g-p',0,'s','RADAR',now(),10,'i','p','l','v',ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))',4326),'g-u'); INSERT INTO "propositions_teledetection" ("id","produitId","type","methode","geom","creeParId","statut","motifAttente") VALUES ('g-t','g-p','INONDATION','m',ST_GeomFromText('POINT(0.5 0.5)',4326),'g-u','EN_ATTENTE','AUTRE');
-- GARDE-TEST: INSERT INTO "users" ("id","email","nomComplet","passwordHash","role","updatedAt") VALUES ('g-u','g@local.invalid','x','x','GESTIONNAIRE',now()); INSERT INTO "earth_observation_products" ("id","code","palier","source","nature","dateAcquisition","resolutionM","incertitude","provenance","licence","versionTraitement","emprise","enregistreParId") VALUES ('g-p','g-p',0,'s','RADAR',now(),10,'i','p','l','v',ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))',4326),'g-u'); INSERT INTO "propositions_teledetection" ("id","produitId","type","methode","geom","creeParId","limites") VALUES ('g-t','g-p','INONDATION','m',ST_GeomFromText('POINT(0.5 0.5)',4326),'g-u',ARRAY['resolution native 10 m']);
-- GARDE-TEST: INSERT INTO "users" ("id","email","nomComplet","passwordHash","role","updatedAt") VALUES ('g-u','g@local.invalid','x','x','GESTIONNAIRE',now()); INSERT INTO "earth_observation_products" ("id","code","palier","source","nature","dateAcquisition","resolutionM","incertitude","provenance","licence","versionTraitement","emprise","enregistreParId") VALUES ('g-p','g-p',0,'s','RADAR',now(),10,'i','p','l','v',ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))',4326),'g-u'); INSERT INTO "propositions_teledetection" ("id","produitId","type","methode","geom","creeParId") VALUES ('g-t','g-p','INONDATION','m',ST_GeomFromText('POINT(0.5 0.5)',4326),'g-u'); INSERT INTO "propositions_teledetection_transitions" ("id","propositionId","de","vers","auteurId","motif") VALUES ('g-tr','g-t','A_VERIFIER','NON_CONCLUANTE','g-u','essai');

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "propositions_teledetection" WHERE "statut" IN ('EN_ATTENTE', 'NON_CONCLUANTE');
  IF n > 0 THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % proposition(s) EN_ATTENTE ou NON_CONCLUANTE. L''ancien schema ne connait que A_VERIFIER, CONFIRMEE et INFIRMEE et aucun statut de remplacement n''est invente : decider ou remettre ces propositions A_VERIFIER d''abord (aucune derogation possible).', n;
  END IF;

  SELECT (SELECT count(*) FROM "propositions_teledetection"
           WHERE "prioriteNiveau" IS NOT NULL OR "confianceDetection" IS NOT NULL OR "imageCouvertureNuagesPct" IS NOT NULL
              OR "imageNote" IS NOT NULL OR "rattachementConfiance" IS NOT NULL OR "rattachementCandidats" IS NOT NULL
              OR "methodeNom" IS NOT NULL OR "limites" IS NOT NULL OR "synthetique" OR "motifAttente" IS NOT NULL)
       + (SELECT count(*) FROM "propositions_teledetection_transitions")
       + (SELECT count(*) FROM "propositions_teledetection_preuves")
    INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % ligne(s) portent des donnees du workflow (priorite, confiances, rattachement detaille, limites, journal, preuves). Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

-- Vue historique : sa definition d'avant (elle ne depend plus de `synthetique`).
CREATE OR REPLACE VIEW "precision_teledetection" AS
SELECT "type", "methode",
       count(*)::integer AS "total",
       count(*) FILTER (WHERE "statut" = 'A_VERIFIER')::integer AS "aVerifier",
       count(*) FILTER (WHERE "statut" = 'CONFIRMEE')::integer AS "confirmees",
       count(*) FILTER (WHERE "statut" = 'INFIRMEE')::integer AS "infirmees",
       CASE WHEN count(*) FILTER (WHERE "statut" <> 'A_VERIFIER') = 0 THEN NULL
            ELSE (count(*) FILTER (WHERE "statut" = 'CONFIRMEE'))::double precision
                 / (count(*) FILTER (WHERE "statut" <> 'A_VERIFIER')) END AS "precision"
  FROM "propositions_teledetection"
 GROUP BY "type", "methode";

-- Declencheurs : les versions d'avant (migrations 20261020000000 et 20261022020000).
DROP TRIGGER IF EXISTS propositions_teledetection_journal_exige ON "propositions_teledetection";
DROP FUNCTION IF EXISTS propositions_teledetection_exige_journal();

CREATE OR REPLACE FUNCTION propositions_teledetection_garde() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'propositions_teledetection : suppression refusee, la mesure de precision en depend'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."produitId" IS DISTINCT FROM OLD."produitId" OR NEW."produitReferenceId" IS DISTINCT FROM OLD."produitReferenceId"
     OR NEW."type" IS DISTINCT FROM OLD."type" OR NEW."methode" IS DISTINCT FROM OLD."methode"
     OR NEW."score" IS DISTINCT FROM OLD."score" OR NOT ST_Equals(NEW."geom", OLD."geom")
     OR NEW."tronconId" IS DISTINCT FROM OLD."tronconId" OR NEW."distanceTronconM" IS DISTINCT FROM OLD."distanceTronconM"
     OR NEW."creeParId" IS DISTINCT FROM OLD."creeParId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'propositions_teledetection : la detection est figee ; seuls le verdict et la mission changent'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."statut" <> 'A_VERIFIER' AND (
       NEW."statut" IS DISTINCT FROM OLD."statut" OR NEW."verifieeParId" IS DISTINCT FROM OLD."verifieeParId"
       OR NEW."verifieeLe" IS DISTINCT FROM OLD."verifieeLe" OR NEW."motifVerdict" IS DISTINCT FROM OLD."motifVerdict"
       OR NEW."constatRef" IS DISTINCT FROM OLD."constatRef") THEN
    RAISE EXCEPTION 'propositions_teledetection : le verdict du terrain (%) ne se reprend pas', OLD."statut"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."missionId" IS NOT NULL AND NEW."missionId" IS DISTINCT FROM OLD."missionId" THEN
    RAISE EXCEPTION 'propositions_teledetection : la mission de verification est deja rattachee'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."statut" <> 'A_VERIFIER' AND OLD."statut" = 'A_VERIFIER' THEN
    NEW."verifieeLe" := CURRENT_TIMESTAMP(3);
  END IF;
  RETURN NEW;
END;
$fn$;

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

-- Tables du workflow (preuves d'abord : elle cite le journal).
DROP TABLE IF EXISTS "propositions_teledetection_preuves";
DROP TABLE IF EXISTS "propositions_teledetection_transitions";
DROP FUNCTION IF EXISTS propositions_teledetection_journaux_ajout_seul();

-- Index et contraintes ajoutes, puis colonnes.
DROP INDEX IF EXISTS "propositions_teledetection_centre_gist";
DROP INDEX IF EXISTS "propositions_teledetection_produit_idx";
DROP INDEX IF EXISTS "propositions_teledetection_priorite_idx";
DROP INDEX IF EXISTS "propositions_teledetection_region_idx";

ALTER TABLE "propositions_teledetection"
  DROP CONSTRAINT IF EXISTS "pt_region_depuis_troncon",
  DROP CONSTRAINT IF EXISTS "pt_attente",
  DROP CONSTRAINT IF EXISTS "pt_limites",
  DROP CONSTRAINT IF EXISTS "pt_methode_separee",
  DROP CONSTRAINT IF EXISTS "pt_rattachement_confiance",
  DROP CONSTRAINT IF EXISTS "pt_image",
  DROP CONSTRAINT IF EXISTS "pt_confiance_detection",
  DROP CONSTRAINT IF EXISTS "pt_priorite",
  DROP CONSTRAINT IF EXISTS "pt_verdict_complet",
  DROP CONSTRAINT IF EXISTS "pt_statut";

ALTER TABLE "propositions_teledetection"
  DROP COLUMN IF EXISTS "centre",
  DROP COLUMN IF EXISTS "motifAttente",
  DROP COLUMN IF EXISTS "regionId",
  DROP COLUMN IF EXISTS "synthetique",
  DROP COLUMN IF EXISTS "limites",
  DROP COLUMN IF EXISTS "methodeVersion",
  DROP COLUMN IF EXISTS "methodeNom",
  DROP COLUMN IF EXISTS "rattachementCandidats",
  DROP COLUMN IF EXISTS "rattachementAlgorithme",
  DROP COLUMN IF EXISTS "rattachementConfiance",
  DROP COLUMN IF EXISTS "imageNote",
  DROP COLUMN IF EXISTS "imageCouvertureNuagesPct",
  DROP COLUMN IF EXISTS "confianceCalibree",
  DROP COLUMN IF EXISTS "confianceDetection",
  DROP COLUMN IF EXISTS "prioriteRegle",
  DROP COLUMN IF EXISTS "prioriteNiveau";

-- Contraintes d'avant.
ALTER TABLE "propositions_teledetection" ADD CONSTRAINT "pt_statut" CHECK ("statut" IN ('A_VERIFIER', 'CONFIRMEE', 'INFIRMEE'));
ALTER TABLE "propositions_teledetection" ADD CONSTRAINT "pt_verdict_complet" CHECK (
  ("statut" = 'A_VERIFIER' AND "verifieeParId" IS NULL AND "verifieeLe" IS NULL AND "motifVerdict" IS NULL AND "constatRef" IS NULL)
  OR ("statut" <> 'A_VERIFIER' AND "verifieeParId" IS NOT NULL AND "verifieeLe" IS NOT NULL
      AND length(btrim(coalesce("motifVerdict", ''))) > 0 AND length(btrim(coalesce("constatRef", ''))) > 0)
);

-- Et la ligne de `_prisma_migrations` :
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261028110000_eo_propositions_workflow';

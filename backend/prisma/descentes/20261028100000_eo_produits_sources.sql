-- RETOUR ARRIERE de `20261028100000_eo_produits_sources`.
--
-- CE QUI EST PERDU : le registre des sources (etats, historique, messages des tests) et, pour chaque produit,
-- l'identifiant fournisseur, la collection, le capteur, l'orbite, la scene, le niveau de traitement, la resolution
-- native, l'empreinte, le chemin de stockage, le cycle de vie, la licence structuree, le lien vers la source et le
-- drapeau `synthetique`.
--
-- GARDE : la descente REFUSE de s'executer si une source a quitte son etat d'amorce (etat change, verification
-- ou acquisition datee, configuration, source ajoutee ou retiree, historique complete) ou si un produit porte l'une
-- des colonnes ci-dessus. Les quatre sources amorcees par la migration, intactes, ne comptent pas. Pour passer outre,
-- apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261028100000_eo_produits_sources.sql
--
-- On descend d'abord 20261028110000 (les propositions) : elle ne depend pas de ces colonnes, mais la descente
-- suit l'ordre inverse de l'application.
--
-- GARDE-TEST: UPDATE "sources_observation" SET "etat" = 'CONFIGUREE' WHERE "code" = 'SENTINEL2';
-- GARDE-TEST: INSERT INTO "users" ("id","email","nomComplet","passwordHash","role","updatedAt") VALUES ('g-u','g@local.invalid','x','x','GESTIONNAIRE',now()); INSERT INTO "earth_observation_products" ("id","code","palier","source","nature","dateAcquisition","resolutionM","incertitude","provenance","licence","versionTraitement","emprise","enregistreParId","fournisseur","identifiantFournisseur") VALUES ('g-p','g-p',0,'s','RADAR',now(),10,'i','p','l','v',ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))',4326),'g-u','COPERNICUS','S1A_TEST');

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "sources_observation" s
           WHERE s."code" NOT IN ('SENTINEL2', 'LANDSAT89', 'PLANETSCOPE', 'SPOT')
              OR s."derniereVerificationLe" IS NOT NULL OR s."derniereAcquisitionLe" IS NOT NULL
              OR s."configJson" <> '{}'::jsonb OR s."deletedAt" IS NOT NULL
              OR s."etat" NOT IN ('NON_CONFIGUREE', 'EN_ATTENTE_CONFIGURATION')
              OR (SELECT count(*) FROM "sources_observation_etats" e WHERE e."sourceId" = s."id") <> 1)
       + (SELECT count(*) FROM "earth_observation_products"
           WHERE "sourceCode" IS NOT NULL OR "fournisseur" IS NOT NULL OR "collection" IS NOT NULL OR "capteur" IS NOT NULL
              OR "orbite" IS NOT NULL OR "scene" IS NOT NULL OR "niveauTraitement" IS NOT NULL OR "resolutionNativeM" IS NOT NULL
              OR "empreinteSha256" IS NOT NULL OR "stockageChemin" IS NOT NULL OR "cycleVie" <> 'CATALOGUE'
              OR "licenceCode" IS NOT NULL OR "licenceAttribution" IS NOT NULL OR "synthetique")
    INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % ligne(s) portent des donnees des sources ou de la tracabilite des produits. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

-- Sources (historique d'abord) et leurs fonctions.
DROP TABLE IF EXISTS "sources_observation_etats";
DROP TABLE IF EXISTS "sources_observation" CASCADE;
DROP FUNCTION IF EXISTS sources_observation_exige_journal();
DROP FUNCTION IF EXISTS sources_observation_garde();
DROP FUNCTION IF EXISTS sources_observation_etats_ajout_seul();

-- Produits : index, contraintes, colonnes.
DROP INDEX IF EXISTS "earth_observation_products_source_code_idx";
DROP INDEX IF EXISTS "earth_observation_products_nature_idx";
DROP INDEX IF EXISTS "earth_observation_products_source_idx";
DROP INDEX IF EXISTS "earth_observation_products_date_idx";
DROP INDEX IF EXISTS "earth_observation_products_fournisseur_identifiant_key";

ALTER TABLE "earth_observation_products"
  DROP CONSTRAINT IF EXISTS "eo_stockage_sans_secret",
  DROP CONSTRAINT IF EXISTS "eo_tracabilite_non_vide",
  DROP CONSTRAINT IF EXISTS "eo_licence_structuree",
  DROP CONSTRAINT IF EXISTS "eo_resolution_native",
  DROP CONSTRAINT IF EXISTS "eo_cycle_vie_coherent",
  DROP CONSTRAINT IF EXISTS "eo_cycle_vie",
  DROP CONSTRAINT IF EXISTS "eo_empreinte_sha256",
  DROP CONSTRAINT IF EXISTS "eo_fournisseur_coherent";

ALTER TABLE "earth_observation_products"
  DROP COLUMN IF EXISTS "synthetique",
  DROP COLUMN IF EXISTS "licenceAttribution",
  DROP COLUMN IF EXISTS "licenceCode",
  DROP COLUMN IF EXISTS "cycleVie",
  DROP COLUMN IF EXISTS "stockageChemin",
  DROP COLUMN IF EXISTS "empreinteSha256",
  DROP COLUMN IF EXISTS "resolutionNativeM",
  DROP COLUMN IF EXISTS "niveauTraitement",
  DROP COLUMN IF EXISTS "scene",
  DROP COLUMN IF EXISTS "orbite",
  DROP COLUMN IF EXISTS "capteur",
  DROP COLUMN IF EXISTS "collection",
  DROP COLUMN IF EXISTS "identifiantFournisseur",
  DROP COLUMN IF EXISTS "fournisseur",
  DROP COLUMN IF EXISTS "sourceCode";

-- Et la ligne de `_prisma_migrations` :
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261028100000_eo_produits_sources';

-- OBSERVATION DE LA TERRE, LOT 1 (EO-DB) : PRODUITS TRACABLES ET REGISTRE DES SOURCES
--
-- Les audits du Lot 0 ont releve que le registre des produits ne portait ni identifiant fournisseur,
-- ni collection, ni capteur, ni orbite ou scene, ni niveau de traitement, ni empreinte, ni statut de
-- cycle de vie : un produit ne se retrouvait pas chez son fournisseur et deux imports du meme produit
-- faisaient deux lignes. Et rien en base ne disait si une SOURCE (Sentinel-2, Landsat, PlanetScope,
-- SPOT) etait configuree, joignable ou operationnelle : un nom de fournisseur ne prouve rien.
--
-- CE QUE CETTE MIGRATION FAIT
--
--   1. `earth_observation_products` : colonnes de tracabilite (fournisseur + identifiant fournisseur,
--      collection, capteur, orbite, scene, niveau de traitement), resolution NATIVE distincte de la
--      resolution du produit, empreinte SHA-256, chemin de stockage, statut de cycle de vie, licence
--      structuree (code + attribution), lien vers la source, drapeau `synthetique`. Unicite
--      (fournisseur, identifiant fournisseur) : un meme produit n'entre qu'une fois.
--   2. `sources_observation` : une ligne par source, avec un ETAT lu en base (echelle du contrat
--      CONTRAT-API-UI.md, section 4). `sources_observation_etats` : l'historique, ajout seul.
--      Un changement d'etat sans ligne d'historique DANS LA MEME TRANSACTION est refuse a la
--      validation (declencheur differe).
--   3. AMORCE : les quatre sources du produit, UNIQUEMENT a l'etat NON_CONFIGUREE ou
--      EN_ATTENTE_CONFIGURATION. Aucune n'est « active » : aucune verification n'a eu lieu, et une
--      contrainte interdit tout etat avance sans date de verification.
--
-- POURQUOI L'AMORCE EST UNE MIGRATION DE DONNEES (et non un script `peupler`)
--
--   La page « Sources » doit montrer les quatre sources dans tous les environnements, dans l'etat
--   honnete « non configuree », sans qu'un humain ait a se souvenir de lancer un script. L'insertion
--   est idempotente (ON CONFLICT DO NOTHING sur le code, historique ajoute seulement aux sources qui
--   n'en ont aucun) : la rejouer ne reecrit jamais un etat deja change. Un script a part laisserait
--   un environnement sans ligne, et l'interface afficherait « aucune source » comme si le produit
--   n'en avait pas. La descente refuse si une source a ete modifiee depuis l'amorce.
--
-- CE QU'ELLE NE FAIT PAS
--
--   Elle ne contacte aucun fournisseur, ne stocke aucun identifiant de connexion (la colonne
--   `configJson` refuse les cles d'apparence secrete au premier niveau ; les secrets restent cote
--   serveur, dans l'environnement), et ne deduit aucun etat d'un nom.
--
-- NATURE : additive. Colonnes nullables ou a defaut, deux tables, des declencheurs, des index.
-- Aucune ligne existante modifiee. Idempotente (IF NOT EXISTS, contraintes ajoutees seulement si
-- absentes, amorce ON CONFLICT DO NOTHING).

-- ===== 1. Registre des sources =====

CREATE TABLE IF NOT EXISTS "sources_observation" (
  "id"          TEXT PRIMARY KEY,
  -- Code stable, cite par les produits (« SENTINEL2 »...).
  "code"        TEXT NOT NULL,
  "nom"         TEXT NOT NULL,
  -- Code du fournisseur tel que les produits le portent (cle de deduplication, avec l'identifiant fournisseur).
  "fournisseur" TEXT NOT NULL,
  -- Nul tant qu'il n'a pas ete releve a la source : on n'ecrit pas ce qu'on ne sait pas.
  "capteur"     TEXT,
  -- Resolution native, en metres. Nulle tant qu'elle n'est pas relevee.
  "resolutionM" DOUBLE PRECISION,
  -- Echelle du contrat : NON_CONFIGUREE < CONFIGUREE < AUTHENTIFIEE < ACCESSIBLE < PRODUIT_DISPONIBLE
  -- < TRAITEMENT_OPERATIONNEL, plus EN_ERREUR et EN_ATTENTE_CONFIGURATION. « Active » = TRAITEMENT_OPERATIONNEL.
  "etat"        TEXT NOT NULL DEFAULT 'NON_CONFIGUREE',
  -- Message du dernier test.
  "dernierMessage" TEXT,
  "derniereVerificationLe" TIMESTAMP(3),
  -- Date d'acquisition du produit le plus recent enregistre pour cette source.
  "derniereAcquisitionLe" TIMESTAMP(3),
  -- Vrai si le fournisseur exige des identifiants pour la recherche au catalogue.
  "requiertIdentifiants" BOOLEAN NOT NULL DEFAULT false,
  -- Parametres NON secrets (fenetre par defaut, collection...). Jamais d'identifiant ni de cle.
  "configJson"  JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Suppression logique (regle 2 d'AGENTS.md) : une source retiree reste lisible pour ses produits.
  "deletedAt"   TIMESTAMP(3),

  CONSTRAINT "src_obs_etat" CHECK ("etat" IN (
    'NON_CONFIGUREE', 'CONFIGUREE', 'AUTHENTIFIEE', 'ACCESSIBLE', 'PRODUIT_DISPONIBLE', 'TRAITEMENT_OPERATIONNEL',
    'EN_ERREUR', 'EN_ATTENTE_CONFIGURATION')),
  CONSTRAINT "src_obs_champs" CHECK (
    length(btrim("code")) > 0 AND length(btrim("nom")) > 0 AND length(btrim("fournisseur")) > 0
    AND ("capteur" IS NULL OR length(btrim("capteur")) > 0)),
  CONSTRAINT "src_obs_resolution" CHECK ("resolutionM" IS NULL OR "resolutionM" > 0),
  -- Un etat avance est le resultat d'un test date et commente : jamais « active » sans verification.
  CONSTRAINT "src_obs_verification_requise" CHECK (
    "etat" IN ('NON_CONFIGUREE', 'CONFIGUREE', 'EN_ATTENTE_CONFIGURATION')
    OR ("derniereVerificationLe" IS NOT NULL AND length(btrim(coalesce("dernierMessage", ''))) > 0)),
  -- Les etats « identifiants » n'ont de sens que pour une source qui en exige.
  CONSTRAINT "src_obs_identifiants_coherents" CHECK (
    "requiertIdentifiants" OR "etat" NOT IN ('AUTHENTIFIEE', 'EN_ATTENTE_CONFIGURATION')),
  CONSTRAINT "src_obs_config_objet" CHECK (jsonb_typeof("configJson") = 'object'),
  -- Garde-fou de meilleure effort (premier niveau seulement) : pas de secret en base.
  CONSTRAINT "src_obs_config_sans_secret" CHECK (
    NOT ("configJson" ?| ARRAY['password', 'motDePasse', 'mot_de_passe', 'secret', 'token', 'jeton', 'apiKey', 'api_key',
                               'cle', 'clientSecret', 'client_secret', 'authorization']))
);
CREATE UNIQUE INDEX IF NOT EXISTS "sources_observation_code_key" ON "sources_observation" ("code");
CREATE INDEX IF NOT EXISTS "sources_observation_etat_idx" ON "sources_observation" ("etat");

CREATE TABLE IF NOT EXISTS "sources_observation_etats" (
  "id"        TEXT PRIMARY KEY,
  "sourceId"  TEXT NOT NULL REFERENCES "sources_observation"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Nul pour la ligne de creation.
  "de"        TEXT,
  "vers"      TEXT NOT NULL,
  "creeLe"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "message"   TEXT NOT NULL,
  -- Nul seulement pour la ligne de creation (amorce par migration).
  "auteurId"  TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Transaction qui a ecrit la ligne : le declencheur differe exige qu'un changement d'etat ait SA
  -- ligne dans la meme transaction.
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),

  CONSTRAINT "src_etats_vers" CHECK ("vers" IN (
    'NON_CONFIGUREE', 'CONFIGUREE', 'AUTHENTIFIEE', 'ACCESSIBLE', 'PRODUIT_DISPONIBLE', 'TRAITEMENT_OPERATIONNEL',
    'EN_ERREUR', 'EN_ATTENTE_CONFIGURATION')),
  CONSTRAINT "src_etats_de" CHECK ("de" IS NULL OR "de" IN (
    'NON_CONFIGUREE', 'CONFIGUREE', 'AUTHENTIFIEE', 'ACCESSIBLE', 'PRODUIT_DISPONIBLE', 'TRAITEMENT_OPERATIONNEL',
    'EN_ERREUR', 'EN_ATTENTE_CONFIGURATION')),
  CONSTRAINT "src_etats_message" CHECK (length(btrim("message")) > 0),
  CONSTRAINT "src_etats_auteur" CHECK ("auteurId" IS NOT NULL OR "de" IS NULL)
);
CREATE INDEX IF NOT EXISTS "sources_observation_etats_source_idx" ON "sources_observation_etats" ("sourceId", "creeLe");

-- L'historique est un journal : on y ajoute, on n'y corrige ni n'y retire rien.
CREATE OR REPLACE FUNCTION sources_observation_etats_ajout_seul() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'sources_observation_etats : journal en ajout seul (% refuse)', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$fn$;
DROP TRIGGER IF EXISTS sources_observation_etats_ajout_seul ON "sources_observation_etats";
CREATE TRIGGER sources_observation_etats_ajout_seul
  BEFORE UPDATE OR DELETE ON "sources_observation_etats"
  FOR EACH ROW EXECUTE FUNCTION sources_observation_etats_ajout_seul();

-- Une source ne se supprime pas (suppression logique) et son code ne change pas.
CREATE OR REPLACE FUNCTION sources_observation_garde() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sources_observation : suppression refusee (suppression logique par deletedAt)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."code" IS DISTINCT FROM OLD."code" THEN
    RAISE EXCEPTION 'sources_observation : le code d''une source ne change pas'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS sources_observation_garde ON "sources_observation";
CREATE TRIGGER sources_observation_garde
  BEFORE UPDATE OR DELETE ON "sources_observation"
  FOR EACH ROW EXECUTE FUNCTION sources_observation_garde();

-- Un changement d'etat porte sa ligne d'historique, ecrite dans la MEME transaction. Verifie a la
-- validation (declencheur de contrainte differe) : l'ordre des ecritures dans la transaction est libre.
CREATE OR REPLACE FUNCTION sources_observation_exige_journal() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "sources_observation_etats" e
     WHERE e."sourceId" = NEW."id" AND e."de" IS NOT DISTINCT FROM OLD."etat" AND e."vers" = NEW."etat"
       AND e."transactionId" = txid_current()) THEN
    RAISE EXCEPTION 'sources_observation : le changement d''etat % -> % de la source % n''a pas de ligne d''historique dans la meme transaction',
      OLD."etat", NEW."etat", NEW."code"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$fn$;
DROP TRIGGER IF EXISTS sources_observation_journal_exige ON "sources_observation";
CREATE CONSTRAINT TRIGGER sources_observation_journal_exige
  AFTER UPDATE ON "sources_observation"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD."etat" IS DISTINCT FROM NEW."etat")
  EXECUTE FUNCTION sources_observation_exige_journal();

-- ===== 2. Produits : tracabilite fournisseur =====

ALTER TABLE "earth_observation_products"
  ADD COLUMN IF NOT EXISTS "sourceCode"             TEXT REFERENCES "sources_observation"("code") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS "fournisseur"            TEXT,
  ADD COLUMN IF NOT EXISTS "identifiantFournisseur" TEXT,
  ADD COLUMN IF NOT EXISTS "collection"             TEXT,
  ADD COLUMN IF NOT EXISTS "capteur"                TEXT,
  ADD COLUMN IF NOT EXISTS "orbite"                 TEXT,
  ADD COLUMN IF NOT EXISTS "scene"                  TEXT,
  ADD COLUMN IF NOT EXISTS "niveauTraitement"       TEXT,
  -- Resolution native du capteur, distincte de `resolutionM` (celle du produit livre, reechantillonne ou non).
  ADD COLUMN IF NOT EXISTS "resolutionNativeM"      DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "empreinteSha256"        TEXT,
  ADD COLUMN IF NOT EXISTS "stockageChemin"         TEXT,
  -- CATALOGUE : reference au catalogue du fournisseur, aucun pixel chez nous. Les lignes d'avant la migration
  -- sont des references de ce genre : le defaut est le seul etat que l'on puisse affirmer.
  ADD COLUMN IF NOT EXISTS "cycleVie"               TEXT NOT NULL DEFAULT 'CATALOGUE',
  ADD COLUMN IF NOT EXISTS "licenceCode"            TEXT,
  ADD COLUMN IF NOT EXISTS "licenceAttribution"     TEXT,
  ADD COLUMN IF NOT EXISTS "synthetique"            BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'eo_fournisseur_coherent' AND conrelid = '"earth_observation_products"'::regclass) THEN
    ALTER TABLE "earth_observation_products" ADD CONSTRAINT "eo_fournisseur_coherent" CHECK (
      ("fournisseur" IS NULL) = ("identifiantFournisseur" IS NULL)
      AND ("fournisseur" IS NULL OR (length(btrim("fournisseur")) > 0 AND length(btrim("identifiantFournisseur")) > 0)));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'eo_empreinte_sha256' AND conrelid = '"earth_observation_products"'::regclass) THEN
    ALTER TABLE "earth_observation_products" ADD CONSTRAINT "eo_empreinte_sha256" CHECK (
      "empreinteSha256" IS NULL OR "empreinteSha256" ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'eo_cycle_vie' AND conrelid = '"earth_observation_products"'::regclass) THEN
    ALTER TABLE "earth_observation_products" ADD CONSTRAINT "eo_cycle_vie" CHECK (
      "cycleVie" IN ('CATALOGUE', 'TELECHARGE', 'TRAITE', 'ARCHIVE', 'PURGE', 'EN_ECHEC'));
  END IF;
  -- Un produit ne se dit pas telecharge, traite ou archive sans empreinte ni chemin ; une simple reference
  -- de catalogue n'en porte aucun.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'eo_cycle_vie_coherent' AND conrelid = '"earth_observation_products"'::regclass) THEN
    ALTER TABLE "earth_observation_products" ADD CONSTRAINT "eo_cycle_vie_coherent" CHECK (
      ("cycleVie" NOT IN ('TELECHARGE', 'TRAITE', 'ARCHIVE') OR ("empreinteSha256" IS NOT NULL AND "stockageChemin" IS NOT NULL))
      AND ("cycleVie" <> 'CATALOGUE' OR ("empreinteSha256" IS NULL AND "stockageChemin" IS NULL)));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'eo_resolution_native' AND conrelid = '"earth_observation_products"'::regclass) THEN
    ALTER TABLE "earth_observation_products" ADD CONSTRAINT "eo_resolution_native" CHECK (
      "resolutionNativeM" IS NULL OR "resolutionNativeM" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'eo_licence_structuree' AND conrelid = '"earth_observation_products"'::regclass) THEN
    ALTER TABLE "earth_observation_products" ADD CONSTRAINT "eo_licence_structuree" CHECK (
      ("licenceCode" IS NULL OR length(btrim("licenceCode")) > 0)
      AND ("licenceAttribution" IS NULL OR length(btrim("licenceAttribution")) > 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'eo_tracabilite_non_vide' AND conrelid = '"earth_observation_products"'::regclass) THEN
    ALTER TABLE "earth_observation_products" ADD CONSTRAINT "eo_tracabilite_non_vide" CHECK (
      ("collection" IS NULL OR length(btrim("collection")) > 0) AND ("capteur" IS NULL OR length(btrim("capteur")) > 0)
      AND ("orbite" IS NULL OR length(btrim("orbite")) > 0) AND ("scene" IS NULL OR length(btrim("scene")) > 0)
      AND ("niveauTraitement" IS NULL OR length(btrim("niveauTraitement")) > 0)
      AND ("stockageChemin" IS NULL OR length(btrim("stockageChemin")) > 0));
  END IF;
  -- Un chemin de stockage est un identifiant interne, jamais une adresse qui porte des identifiants de connexion.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'eo_stockage_sans_secret' AND conrelid = '"earth_observation_products"'::regclass) THEN
    ALTER TABLE "earth_observation_products" ADD CONSTRAINT "eo_stockage_sans_secret" CHECK (
      "stockageChemin" IS NULL OR "stockageChemin" !~* '^[a-z][a-z0-9+.-]*://[^/@]*@');
  END IF;
END
$$;

-- Deduplication : un meme produit chez un meme fournisseur n'entre qu'une fois. Les valeurs nulles (produits
-- saisis a la main, d'avant la migration) ne se comparent pas entre elles.
CREATE UNIQUE INDEX IF NOT EXISTS "earth_observation_products_fournisseur_identifiant_key"
  ON "earth_observation_products" ("fournisseur", "identifiantFournisseur");
CREATE INDEX IF NOT EXISTS "earth_observation_products_date_idx" ON "earth_observation_products" ("dateAcquisition");
CREATE INDEX IF NOT EXISTS "earth_observation_products_source_idx" ON "earth_observation_products" ("source");
CREATE INDEX IF NOT EXISTS "earth_observation_products_nature_idx" ON "earth_observation_products" ("nature");
CREATE INDEX IF NOT EXISTS "earth_observation_products_source_code_idx" ON "earth_observation_products" ("sourceCode");

-- ===== 3. Amorce des quatre sources du produit =====
--
-- Etats d'amorce : NON_CONFIGUREE pour les deux sources dont le catalogue se recherche sans compte,
-- EN_ATTENTE_CONFIGURATION pour les deux sources commerciales, qui exigent des identifiants que nous
-- n'avons pas. AUCUNE n'est « active ». Resolution : seule celle de Sentinel-2 (10 m) est fixee par le
-- contrat ; les autres restent nulles tant qu'elles ne sont pas relevees a la source. Capteur : seuls
-- ceux dont le nom est sans ambiguite sont poses.

INSERT INTO "sources_observation" ("id", "code", "nom", "fournisseur", "capteur", "resolutionM", "etat", "dernierMessage", "requiertIdentifiants")
VALUES
  (gen_random_uuid()::text, 'SENTINEL2', 'Sentinel-2', 'COPERNICUS', 'MSI', 10, 'NON_CONFIGUREE',
   'Source amorcee par la migration : aucune configuration ni verification effectuee.', false),
  (gen_random_uuid()::text, 'LANDSAT89', 'Landsat 8/9', 'USGS', 'OLI/OLI-2', NULL, 'NON_CONFIGUREE',
   'Source amorcee par la migration : aucune configuration ni verification effectuee.', false),
  (gen_random_uuid()::text, 'PLANETSCOPE', 'PlanetScope', 'PLANET', NULL, NULL, 'EN_ATTENTE_CONFIGURATION',
   'Source amorcee par la migration : identifiants du fournisseur requis, non configures. Aucune verification effectuee.', true),
  (gen_random_uuid()::text, 'SPOT', 'SPOT', 'AIRBUS', NULL, NULL, 'EN_ATTENTE_CONFIGURATION',
   'Source amorcee par la migration : identifiants du fournisseur requis, non configures. Aucune verification effectuee.', true)
ON CONFLICT ("code") DO NOTHING;

-- Ligne de creation de l'historique, seulement pour une source qui n'en a aucune.
INSERT INTO "sources_observation_etats" ("id", "sourceId", "de", "vers", "message", "auteurId")
SELECT gen_random_uuid()::text, s."id", NULL, s."etat", 'Creation de la source par la migration d''amorce (aucune verification).', NULL
  FROM "sources_observation" s
 WHERE s."code" IN ('SENTINEL2', 'LANDSAT89', 'PLANETSCOPE', 'SPOT')
   AND NOT EXISTS (SELECT 1 FROM "sources_observation_etats" e WHERE e."sourceId" = s."id");

COMMENT ON TABLE "sources_observation" IS
  'Registre des sources d''observation de la Terre. L''etat est lu ici, jamais deduit d''un nom de fournisseur ; '
  '« active » = TRAITEMENT_OPERATIONNEL. Amorce : aucune source active.';
COMMENT ON TABLE "sources_observation_etats" IS
  'Historique des changements d''etat des sources (ajout seul). Chaque changement d''etat a sa ligne dans la meme transaction.';
COMMENT ON COLUMN "earth_observation_products"."resolutionNativeM" IS
  'Resolution native du capteur (m), distincte de resolutionM (produit livre).';
COMMENT ON COLUMN "earth_observation_products"."cycleVie" IS
  'CATALOGUE (reference au catalogue du fournisseur, aucun pixel chez nous), TELECHARGE, TRAITE, ARCHIVE, PURGE, EN_ECHEC.';
COMMENT ON COLUMN "earth_observation_products"."synthetique" IS
  'Vrai pour un jeu de demonstration ou de test : exclu de toute vue de production.';

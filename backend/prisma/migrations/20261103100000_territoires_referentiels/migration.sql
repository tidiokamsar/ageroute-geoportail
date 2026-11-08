-- PROJETS DE VOIRIE ET RESEAUX, LOT T1 : TERRITOIRES HIERARCHIQUES, REFERENTIELS CONFIGURABLES, CONFIGURATION NATIONALE
--
-- Contrat : docs/projets-voirie/CONTRAT-TERRITOIRES.md. Decision architecturale 2 (08/11/2026) : aucune ville, aucun CRS, aucun type de
-- reseau code en dur ; une ville s'ajoute par administration. Les seuls noms de lieux de cette migration sont des DONNEES : la nation et la
-- chaine du pilote (Faranah > Kissidougou > Kissidougou). Rien d'autre (les villes de demonstration viennent d'une graine, jamais d'ici).
--
-- CE QUE CETTE MIGRATION FAIT
--
--   1. `territoires_voirie` : referentiel territorial hierarchique (parentId, niveau NATION..ZONE, code unique, emprise WGS 84 facultative,
--      CRS metrique facultatif, region du referentiel administratif pour le perimetre des comptes). Chemin materialise, profondeur et region
--      effective calcules PAR LA BASE ; parent, niveau et code immuables ; coherence parent/niveau par declencheur ; suppression logique seule.
--   2. `referentiels_voirie` : valeurs configurables par domaine (TYPE_RESEAU, CATEGORIE_PROJET, TYPE_DOCUMENT, METHODE_ACQUISITION,
--      STATUT_QUALITE), parametres JSON (valides par zod dans le service ; la base verifie la famille d'un type de reseau et les largeurs
--      d'une categorie), version, approbation.
--   3. `configuration_voirie` : configuration nationale (emprise de plausibilite, bandes de CRS metrique, liste blanche des CRS d'import,
--      protections administrables), versionnee.
--   4. Trois historiques en AJOUT SEUL (UPDATE et DELETE refuses).
--   5. Colonnes ajoutees au socle : `projets_voirie.territoireId` et `categorieCode`, `projets_voirie_jeux.typeReseauCode`,
--      `concessionnaires_reseau.typeReseauCode` (codes verifies contre le referentiel a l'ecriture ; une valeur retiree reste portee).
--   6. Donnees : nation GN, region Faranah, prefecture et commune de Kissidougou (emprise APPROXIMATIVE) ; territoire des projets existants
--      (depuis commune / prefecture, sinon NON_RENSEIGNE) ; valeurs de depart des referentiels (= valeurs actuelles du code) ;
--      configuration aux defauts actuels.
--
-- NATURE : additive, idempotente (IF NOT EXISTS, ON CONFLICT DO NOTHING, remplissage conditionnel). Aucune ligne existante n'est alteree
-- hors les colonnes nouvelles (territoireId, typeReseauCode). REVERSIBILITE : descentes/20261103100000_territoires_referentiels.sql.

-- ===== 1. Types =====

DO $$ BEGIN CREATE TYPE "NiveauTerritoireVoirie" AS ENUM ('NATION', 'REGION', 'PREFECTURE', 'COMMUNE', 'QUARTIER', 'SECTEUR', 'ZONE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "DomaineReferentielVoirie" AS ENUM ('TYPE_RESEAU', 'CATEGORIE_PROJET', 'TYPE_DOCUMENT', 'METHODE_ACQUISITION', 'STATUT_QUALITE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ===== 2. Territoires =====

CREATE TABLE IF NOT EXISTS "territoires_voirie" (
  "id"                TEXT PRIMARY KEY,
  "parentId"          TEXT REFERENCES "territoires_voirie"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "niveau"            "NiveauTerritoireVoirie" NOT NULL,
  "code"              TEXT NOT NULL,
  "nom"               TEXT NOT NULL,
  -- Chemin materialise des identifiants (`/id_nation/.../id/`), calcule par la base : les descendants sont les lignes dont le chemin commence par le sien.
  "chemin"            TEXT NOT NULL,
  "profondeur"        INTEGER NOT NULL,
  -- Emprise APPROXIMATIVE sauf mention contraire dans `source` : polygone ou multipolygone WGS 84 valide.
  "emprise"           geometry(Geometry, 4326),
  -- CRS metrique impose aux calculs des projets du territoire (liste blanche de la configuration) ; nul = regle nationale par bandes.
  "crsMetriqueEpsg"   INTEGER,
  "regionId"          INTEGER REFERENCES "regions"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Region effective pour le perimetre des comptes : la sienne, sinon celle du parent (calculee et propagee par la base).
  "regionEffectiveId" INTEGER REFERENCES "regions"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "source"            TEXT,
  "actif"             BOOLEAN NOT NULL DEFAULT true,
  "version"           INTEGER NOT NULL DEFAULT 1,
  "creeParId"         TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt"         TIMESTAMP(3),

  CONSTRAINT "tv_code" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{1,63}$'),
  CONSTRAINT "tv_nom" CHECK (length(btrim("nom")) BETWEEN 1 AND 200),
  CONSTRAINT "tv_source" CHECK ("source" IS NULL OR length("source") <= 500),
  CONSTRAINT "tv_nation_racine" CHECK (("niveau" = 'NATION') = ("parentId" IS NULL)),
  CONSTRAINT "tv_emprise" CHECK ("emprise" IS NULL OR (GeometryType("emprise") IN ('POLYGON', 'MULTIPOLYGON') AND ST_IsValid("emprise") AND NOT ST_IsEmpty("emprise"))),
  CONSTRAINT "tv_crs" CHECK ("crsMetriqueEpsg" IS NULL OR ("crsMetriqueEpsg" BETWEEN 1024 AND 32767 AND "crsMetriqueEpsg" <> 4326)),
  CONSTRAINT "tv_version" CHECK ("version" >= 1),
  CONSTRAINT "tv_profondeur" CHECK ("profondeur" >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "territoires_voirie_code_key" ON "territoires_voirie" ("code");
CREATE INDEX IF NOT EXISTS "territoires_voirie_parentId_idx" ON "territoires_voirie" ("parentId");
CREATE INDEX IF NOT EXISTS "territoires_voirie_chemin_idx" ON "territoires_voirie" ("chemin");
CREATE INDEX IF NOT EXISTS "territoires_voirie_regionEffectiveId_idx" ON "territoires_voirie" ("regionEffectiveId");
CREATE INDEX IF NOT EXISTS "territoires_voirie_niveau_deletedAt_idx" ON "territoires_voirie" ("niveau", "deletedAt");
CREATE INDEX IF NOT EXISTS "territoires_voirie_emprise_gist" ON "territoires_voirie" USING GIST ("emprise");

CREATE TABLE IF NOT EXISTS "territoires_voirie_historique" (
  "id"           BIGSERIAL PRIMARY KEY,
  "territoireId" TEXT NOT NULL REFERENCES "territoires_voirie"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "action"       TEXT NOT NULL,
  "version"      INTEGER NOT NULL,
  -- La ligne sans sa geometrie : l'emprise y figure par sa boite englobante et son empreinte MD5.
  "avant"        JSONB,
  "apres"        JSONB,
  "acteurId"     TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tvh_action" CHECK ("action" IN ('CREATION', 'MODIFICATION', 'RETRAIT', 'MIGRATION')),
  CONSTRAINT "tvh_json" CHECK (("avant" IS NULL OR jsonb_typeof("avant") = 'object') AND ("apres" IS NULL OR jsonb_typeof("apres") = 'object'))
);
CREATE INDEX IF NOT EXISTS "territoires_voirie_historique_territoireId_idx" ON "territoires_voirie_historique" ("territoireId", "createdAt");

-- Rang d'un niveau : le parent est de rang strictement inferieur (un niveau peut etre saute).
CREATE OR REPLACE FUNCTION territoires_voirie_rang(p_niveau "NiveauTerritoireVoirie") RETURNS integer
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE p_niveau
    WHEN 'NATION' THEN 0 WHEN 'REGION' THEN 1 WHEN 'PREFECTURE' THEN 2 WHEN 'COMMUNE' THEN 3
    WHEN 'QUARTIER' THEN 4 WHEN 'SECTEUR' THEN 5 WHEN 'ZONE' THEN 6 END
$fn$;

CREATE OR REPLACE FUNCTION territoires_voirie_avant_ecriture() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE parent "territoires_voirie"%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."parentId" IS DISTINCT FROM OLD."parentId" OR NEW."niveau" IS DISTINCT FROM OLD."niveau" OR NEW."code" IS DISTINCT FROM OLD."code" THEN
      RAISE EXCEPTION 'territoires_voirie : parent, niveau et code sont immuables (creez un autre territoire)' USING ERRCODE = 'restrict_violation';
    END IF;
    NEW."chemin" := OLD."chemin";
    NEW."profondeur" := OLD."profondeur";
    NEW."updatedAt" := CURRENT_TIMESTAMP;
  END IF;
  IF NEW."parentId" IS NULL THEN
    IF TG_OP = 'INSERT' THEN NEW."chemin" := '/' || NEW."id" || '/'; NEW."profondeur" := 0; END IF;
    NEW."regionEffectiveId" := NEW."regionId";
    RETURN NEW;
  END IF;
  SELECT * INTO parent FROM "territoires_voirie" WHERE "id" = NEW."parentId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'territoires_voirie : parent % introuvable', NEW."parentId" USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF parent."deletedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'territoires_voirie : le parent % est retire', NEW."parentId" USING ERRCODE = 'check_violation';
    END IF;
    IF territoires_voirie_rang(parent."niveau") >= territoires_voirie_rang(NEW."niveau") THEN
      RAISE EXCEPTION 'territoires_voirie : niveau % incompatible avec un parent de niveau %', NEW."niveau", parent."niveau" USING ERRCODE = 'check_violation';
    END IF;
    NEW."chemin" := parent."chemin" || NEW."id" || '/';
    NEW."profondeur" := parent."profondeur" + 1;
  END IF;
  NEW."regionEffectiveId" := COALESCE(NEW."regionId", parent."regionEffectiveId");
  RETURN NEW;
END
$fn$;

-- Propagation de la region effective aux descendants directs sans region propre (leur propre declencheur poursuit la descente).
CREATE OR REPLACE FUNCTION territoires_voirie_apres_region() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."regionEffectiveId" IS DISTINCT FROM OLD."regionEffectiveId" THEN
    UPDATE "territoires_voirie" SET "regionEffectiveId" = NEW."regionEffectiveId" WHERE "parentId" = NEW."id" AND "regionId" IS NULL;
  END IF;
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION territoires_voirie_refuse_suppression() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '% : suppression physique interdite (suppression logique par deletedAt)', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END
$fn$;

CREATE OR REPLACE FUNCTION territoires_voirie_ajout_seul() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '% : ajout seul (un historique ne se modifie ni ne se supprime)', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END
$fn$;

DROP TRIGGER IF EXISTS territoires_voirie_avant_ecriture ON "territoires_voirie";
CREATE TRIGGER territoires_voirie_avant_ecriture BEFORE INSERT OR UPDATE ON "territoires_voirie" FOR EACH ROW EXECUTE FUNCTION territoires_voirie_avant_ecriture();
DROP TRIGGER IF EXISTS territoires_voirie_apres_region ON "territoires_voirie";
CREATE TRIGGER territoires_voirie_apres_region AFTER UPDATE ON "territoires_voirie" FOR EACH ROW EXECUTE FUNCTION territoires_voirie_apres_region();
DROP TRIGGER IF EXISTS territoires_voirie_suppression ON "territoires_voirie";
CREATE TRIGGER territoires_voirie_suppression BEFORE DELETE ON "territoires_voirie" FOR EACH ROW EXECUTE FUNCTION territoires_voirie_refuse_suppression();
DROP TRIGGER IF EXISTS territoires_voirie_troncature ON "territoires_voirie";
CREATE TRIGGER territoires_voirie_troncature BEFORE TRUNCATE ON "territoires_voirie" FOR EACH STATEMENT EXECUTE FUNCTION territoires_voirie_refuse_suppression();
DROP TRIGGER IF EXISTS territoires_voirie_historique_ajout_seul ON "territoires_voirie_historique";
CREATE TRIGGER territoires_voirie_historique_ajout_seul BEFORE UPDATE OR DELETE ON "territoires_voirie_historique" FOR EACH ROW EXECUTE FUNCTION territoires_voirie_ajout_seul();
DROP TRIGGER IF EXISTS territoires_voirie_historique_troncature ON "territoires_voirie_historique";
CREATE TRIGGER territoires_voirie_historique_troncature BEFORE TRUNCATE ON "territoires_voirie_historique" FOR EACH STATEMENT EXECUTE FUNCTION territoires_voirie_refuse_suppression();

-- ===== 3. Referentiels configurables =====

CREATE TABLE IF NOT EXISTS "referentiels_voirie" (
  "id"            TEXT PRIMARY KEY,
  "domaine"       "DomaineReferentielVoirie" NOT NULL,
  "code"          TEXT NOT NULL,
  "libelle"       TEXT NOT NULL,
  "ordre"         INTEGER NOT NULL DEFAULT 0,
  "actif"         BOOLEAN NOT NULL DEFAULT true,
  -- Parametres propres au domaine, valides par le schema zod du service (CONTRAT-TERRITOIRES.md section 5).
  "parametres"    JSONB NOT NULL DEFAULT '{}'::jsonb,
  "version"       INTEGER NOT NULL DEFAULT 1,
  "approuveParId" TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "approuveLe"    TIMESTAMP(3),
  "creeParId"     TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt"     TIMESTAMP(3),

  CONSTRAINT "rv_code" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{1,63}$'),
  CONSTRAINT "rv_libelle" CHECK (length(btrim("libelle")) BETWEEN 1 AND 200),
  CONSTRAINT "rv_ordre" CHECK ("ordre" BETWEEN 0 AND 100000),
  CONSTRAINT "rv_parametres_objet" CHECK (jsonb_typeof("parametres") = 'object'),
  CONSTRAINT "rv_version" CHECK ("version" >= 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS "referentiels_voirie_domaine_code_key" ON "referentiels_voirie" ("domaine", "code");
CREATE INDEX IF NOT EXISTS "referentiels_voirie_domaine_actif_idx" ON "referentiels_voirie" ("domaine", "actif", "deletedAt");

CREATE TABLE IF NOT EXISTS "referentiels_voirie_historique" (
  "id"             BIGSERIAL PRIMARY KEY,
  "referentielId"  TEXT NOT NULL REFERENCES "referentiels_voirie"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "action"         TEXT NOT NULL,
  "version"        INTEGER NOT NULL,
  "avant"          JSONB,
  "apres"          JSONB,
  "acteurId"       TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "rvh_action" CHECK ("action" IN ('CREATION', 'MODIFICATION', 'RETRAIT', 'MIGRATION')),
  CONSTRAINT "rvh_json" CHECK (("avant" IS NULL OR jsonb_typeof("avant") = 'object') AND ("apres" IS NULL OR jsonb_typeof("apres") = 'object'))
);
CREATE INDEX IF NOT EXISTS "referentiels_voirie_historique_referentielId_idx" ON "referentiels_voirie_historique" ("referentielId", "createdAt");

-- La base verifie ce qu'elle peut sans dupliquer zod : la famille d'un type de reseau est une valeur de l'enumeration, les largeurs d'une
-- categorie sont coherentes (0 < chaussee <= emprise <= 200), le code est immuable.
CREATE OR REPLACE FUNCTION referentiels_voirie_avant_ecriture() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_famille text; v_emprise numeric; v_chaussee numeric;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."code" IS DISTINCT FROM OLD."code" OR NEW."domaine" IS DISTINCT FROM OLD."domaine" THEN
      RAISE EXCEPTION 'referentiels_voirie : domaine et code sont immuables' USING ERRCODE = 'restrict_violation';
    END IF;
    NEW."updatedAt" := CURRENT_TIMESTAMP;
  END IF;
  IF NEW."domaine" = 'TYPE_RESEAU' THEN
    v_famille := NEW."parametres"->>'famille';
    IF v_famille IS NULL OR NOT (v_famille = ANY (enum_range(NULL::"TypeReseauTiers")::text[])) THEN
      RAISE EXCEPTION 'referentiels_voirie : un type de reseau porte une famille de l''enumeration TypeReseauTiers' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."domaine" = 'CATEGORIE_PROJET' THEN
    BEGIN
      v_emprise := (NEW."parametres"->>'largeurEmpriseM')::numeric;
      v_chaussee := (NEW."parametres"->>'largeurChausseeM')::numeric;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'referentiels_voirie : largeurs d''une categorie illisibles' USING ERRCODE = 'check_violation';
    END;
    IF v_emprise IS NULL OR v_chaussee IS NULL OR NOT (v_chaussee > 0 AND v_chaussee <= v_emprise AND v_emprise <= 200) THEN
      RAISE EXCEPTION 'referentiels_voirie : 0 < largeurChausseeM <= largeurEmpriseM <= 200 attendu' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS referentiels_voirie_avant_ecriture ON "referentiels_voirie";
CREATE TRIGGER referentiels_voirie_avant_ecriture BEFORE INSERT OR UPDATE ON "referentiels_voirie" FOR EACH ROW EXECUTE FUNCTION referentiels_voirie_avant_ecriture();
DROP TRIGGER IF EXISTS referentiels_voirie_suppression ON "referentiels_voirie";
CREATE TRIGGER referentiels_voirie_suppression BEFORE DELETE ON "referentiels_voirie" FOR EACH ROW EXECUTE FUNCTION territoires_voirie_refuse_suppression();
DROP TRIGGER IF EXISTS referentiels_voirie_troncature ON "referentiels_voirie";
CREATE TRIGGER referentiels_voirie_troncature BEFORE TRUNCATE ON "referentiels_voirie" FOR EACH STATEMENT EXECUTE FUNCTION territoires_voirie_refuse_suppression();
DROP TRIGGER IF EXISTS referentiels_voirie_historique_ajout_seul ON "referentiels_voirie_historique";
CREATE TRIGGER referentiels_voirie_historique_ajout_seul BEFORE UPDATE OR DELETE ON "referentiels_voirie_historique" FOR EACH ROW EXECUTE FUNCTION territoires_voirie_ajout_seul();
DROP TRIGGER IF EXISTS referentiels_voirie_historique_troncature ON "referentiels_voirie_historique";
CREATE TRIGGER referentiels_voirie_historique_troncature BEFORE TRUNCATE ON "referentiels_voirie_historique" FOR EACH STATEMENT EXECUTE FUNCTION territoires_voirie_refuse_suppression();

-- Un code de referentiel porte par un objet du socle doit exister, actif ou non, mais NON RETIRE au moment de l'ecriture ; une valeur retiree
-- apres coup reste portee (le declencheur ne se declenche qu'au changement de la colonne).
CREATE OR REPLACE FUNCTION referentiels_voirie_exige(p_domaine "DomaineReferentielVoirie", p_code text) RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  IF p_code IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM "referentiels_voirie" WHERE "domaine" = p_domaine AND "code" = p_code AND "deletedAt" IS NULL) THEN
    RAISE EXCEPTION 'referentiels_voirie : le code % du domaine % est inconnu ou retire', p_code, p_domaine USING ERRCODE = 'foreign_key_violation';
  END IF;
END
$fn$;

-- ===== 4. Configuration nationale =====

CREATE TABLE IF NOT EXISTS "configuration_voirie" (
  "cle"           TEXT PRIMARY KEY,
  "valeur"        JSONB NOT NULL,
  "version"       INTEGER NOT NULL DEFAULT 1,
  "approuveParId" TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "approuveLe"    TIMESTAMP(3),
  "justification" TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cv_cle" CHECK ("cle" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT "cv_valeur_objet" CHECK (jsonb_typeof("valeur") = 'object'),
  CONSTRAINT "cv_version" CHECK ("version" >= 1)
);

CREATE TABLE IF NOT EXISTS "configuration_voirie_historique" (
  "id"            BIGSERIAL PRIMARY KEY,
  "cle"           TEXT NOT NULL REFERENCES "configuration_voirie"("cle") ON UPDATE CASCADE ON DELETE RESTRICT,
  "version"       INTEGER NOT NULL,
  "avant"         JSONB,
  "apres"         JSONB NOT NULL,
  "acteurId"      TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "justification" TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cvh_json" CHECK (("avant" IS NULL OR jsonb_typeof("avant") = 'object') AND jsonb_typeof("apres") = 'object')
);
CREATE INDEX IF NOT EXISTS "configuration_voirie_historique_cle_idx" ON "configuration_voirie_historique" ("cle", "createdAt");

DROP TRIGGER IF EXISTS configuration_voirie_suppression ON "configuration_voirie";
CREATE TRIGGER configuration_voirie_suppression BEFORE DELETE ON "configuration_voirie" FOR EACH ROW EXECUTE FUNCTION territoires_voirie_refuse_suppression();
DROP TRIGGER IF EXISTS configuration_voirie_troncature ON "configuration_voirie";
CREATE TRIGGER configuration_voirie_troncature BEFORE TRUNCATE ON "configuration_voirie" FOR EACH STATEMENT EXECUTE FUNCTION territoires_voirie_refuse_suppression();
DROP TRIGGER IF EXISTS configuration_voirie_historique_ajout_seul ON "configuration_voirie_historique";
CREATE TRIGGER configuration_voirie_historique_ajout_seul BEFORE UPDATE OR DELETE ON "configuration_voirie_historique" FOR EACH ROW EXECUTE FUNCTION territoires_voirie_ajout_seul();
DROP TRIGGER IF EXISTS configuration_voirie_historique_troncature ON "configuration_voirie_historique";
CREATE TRIGGER configuration_voirie_historique_troncature BEFORE TRUNCATE ON "configuration_voirie_historique" FOR EACH STATEMENT EXECUTE FUNCTION territoires_voirie_refuse_suppression();

-- ===== 5. Colonnes ajoutees au socle =====

ALTER TABLE "projets_voirie" ADD COLUMN IF NOT EXISTS "territoireId" TEXT REFERENCES "territoires_voirie"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "projets_voirie" ADD COLUMN IF NOT EXISTS "categorieCode" TEXT;
CREATE INDEX IF NOT EXISTS "projets_voirie_territoireId_idx" ON "projets_voirie" ("territoireId");
ALTER TABLE "projets_voirie_jeux" ADD COLUMN IF NOT EXISTS "typeReseauCode" TEXT;
ALTER TABLE "concessionnaires_reseau" ADD COLUMN IF NOT EXISTS "typeReseauCode" TEXT;

CREATE OR REPLACE FUNCTION projets_voirie_codes_referentiel() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'INSERT' OR NEW."categorieCode" IS DISTINCT FROM OLD."categorieCode" THEN
    PERFORM referentiels_voirie_exige('CATEGORIE_PROJET', NEW."categorieCode");
  END IF;
  RETURN NEW;
END
$fn$;
CREATE OR REPLACE FUNCTION projets_voirie_type_reseau_code() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'INSERT' OR NEW."typeReseauCode" IS DISTINCT FROM OLD."typeReseauCode" THEN
    PERFORM referentiels_voirie_exige('TYPE_RESEAU', NEW."typeReseauCode");
  END IF;
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS projets_voirie_codes_referentiel ON "projets_voirie";
CREATE TRIGGER projets_voirie_codes_referentiel BEFORE INSERT OR UPDATE ON "projets_voirie" FOR EACH ROW EXECUTE FUNCTION projets_voirie_codes_referentiel();
DROP TRIGGER IF EXISTS projets_voirie_jeux_type_reseau_code ON "projets_voirie_jeux";
CREATE TRIGGER projets_voirie_jeux_type_reseau_code BEFORE INSERT OR UPDATE ON "projets_voirie_jeux" FOR EACH ROW EXECUTE FUNCTION projets_voirie_type_reseau_code();
DROP TRIGGER IF EXISTS concessionnaires_reseau_type_reseau_code ON "concessionnaires_reseau";
CREATE TRIGGER concessionnaires_reseau_type_reseau_code BEFORE INSERT OR UPDATE ON "concessionnaires_reseau" FOR EACH ROW EXECUTE FUNCTION projets_voirie_type_reseau_code();

-- ===== 6. Donnees : referentiels (valeurs actuelles du code), configuration (defauts actuels) =====

INSERT INTO "referentiels_voirie" ("id", "domaine", "code", "libelle", "ordre", "parametres") VALUES
  (gen_random_uuid()::text, 'TYPE_RESEAU', 'TELECOM',           'Télécommunications',      10, '{"famille":"TELECOM","couleur":"#ff7900"}'),
  (gen_random_uuid()::text, 'TYPE_RESEAU', 'EAU_POTABLE',       'Eau potable',             20, '{"famille":"EAU_POTABLE","couleur":"#1e66f5"}'),
  (gen_random_uuid()::text, 'TYPE_RESEAU', 'ELECTRICITE',       'Électricité',             30, '{"famille":"ELECTRICITE","couleur":"#d32f2f"}'),
  (gen_random_uuid()::text, 'TYPE_RESEAU', 'ASSAINISSEMENT',    'Assainissement',          40, '{"famille":"ASSAINISSEMENT","couleur":"#2e7d32"}'),
  (gen_random_uuid()::text, 'TYPE_RESEAU', 'GAZ_HYDROCARBURES', 'Gaz et hydrocarbures',    50, '{"famille":"GAZ_HYDROCARBURES","couleur":"#f9a825"}'),
  (gen_random_uuid()::text, 'TYPE_RESEAU', 'AUTRE',             'Autre réseau',            60, '{"famille":"AUTRE","couleur":"#6b7f99"}'),
  (gen_random_uuid()::text, 'CATEGORIE_PROJET', 'VOIRIE_URBAINE', 'Voirie urbaine',        10, '{"largeurEmpriseM":15,"largeurChausseeM":7}'),
  (gen_random_uuid()::text, 'TYPE_DOCUMENT', 'PLAN_AXES',               'Plan des axes de travaux',          10, '{"obligatoire":true,"fonctionsDebloquees":["ANALYSE_2D","CONFLITS"]}'),
  (gen_random_uuid()::text, 'TYPE_DOCUMENT', 'RESEAU_CONCESSIONNAIRE',  'Réseau de concessionnaire',         20, '{"obligatoire":true,"fonctionsDebloquees":["ANALYSE_2D","CONFLITS","COMPARAISON_SOURCES"]}'),
  (gen_random_uuid()::text, 'TYPE_DOCUMENT', 'LIMITES_ROUTE',           'Limites de route',                  30, '{"obligatoire":false,"fonctionsDebloquees":[]}'),
  (gen_random_uuid()::text, 'TYPE_DOCUMENT', 'AUTRE',                   'Autre document',                    90, '{"obligatoire":false,"fonctionsDebloquees":[]}'),
  (gen_random_uuid()::text, 'METHODE_ACQUISITION', 'INCONNUE',            'Méthode inconnue',                10, '{"precisionTypiqueM":null}'),
  (gen_random_uuid()::text, 'METHODE_ACQUISITION', 'LEVE_TOPOGRAPHIQUE',  'Levé topographique',              20, '{"precisionTypiqueM":null}'),
  (gen_random_uuid()::text, 'METHODE_ACQUISITION', 'GNSS',                'Relevé GNSS',                     30, '{"precisionTypiqueM":null}'),
  (gen_random_uuid()::text, 'METHODE_ACQUISITION', 'NUMERISATION_PLAN',   'Numérisation d''un plan',         40, '{"precisionTypiqueM":null}'),
  (gen_random_uuid()::text, 'METHODE_ACQUISITION', 'RELEVE_TERRAIN',      'Relevé de terrain',               50, '{"precisionTypiqueM":null}'),
  (gen_random_uuid()::text, 'STATUT_QUALITE', 'INCONNUE',         'Qualité inconnue (précision non déclarée)',   10, '{}'),
  (gen_random_uuid()::text, 'STATUT_QUALITE', 'DECLAREE',         'Précision déclarée par le fournisseur',        20, '{}'),
  (gen_random_uuid()::text, 'STATUT_QUALITE', 'VERIFIEE_TERRAIN', 'Vérifiée sur le terrain (récolement)',         30, '{}')
ON CONFLICT ("domaine", "code") DO NOTHING;

INSERT INTO "referentiels_voirie_historique" ("referentielId", "action", "version", "apres")
  SELECT r."id", 'MIGRATION', 1, to_jsonb(r) FROM "referentiels_voirie" r
   WHERE NOT EXISTS (SELECT 1 FROM "referentiels_voirie_historique" h WHERE h."referentielId" = r."id");

UPDATE "projets_voirie_jeux" SET "typeReseauCode" = "typeReseau"::text WHERE "typeReseau" IS NOT NULL AND "typeReseauCode" IS NULL;
UPDATE "concessionnaires_reseau" SET "typeReseauCode" = "typeReseau"::text WHERE "typeReseauCode" IS NULL;

INSERT INTO "configuration_voirie" ("cle", "valeur") VALUES
  ('EMPRISE_PLAUSIBILITE',    '{"nom":"Guinee","bbox":[-15.2,7.1,-7.5,12.8]}'),
  ('CRS_METRIQUE_BANDES',     '{"bandes":[{"jusquaLongitude":-12,"epsg":32628}],"epsgDefaut":32629}'),
  ('CRS_IMPORT_LISTE_BLANCHE','{"epsg":[4326,32628,32629]}'),
  ('PROTECTIONS',             '{}')
ON CONFLICT ("cle") DO NOTHING;
INSERT INTO "configuration_voirie_historique" ("cle", "version", "apres")
  SELECT c."cle", 1, c."valeur" FROM "configuration_voirie" c WHERE NOT EXISTS (SELECT 1 FROM "configuration_voirie_historique" h WHERE h."cle" = c."cle");

-- ===== 7. Donnees : nation, chaine du pilote, territoire des projets existants =====

DO $$
DECLARE
  v_nation text; v_region text; v_pref text; v_com text; v_region_admin integer; v_nr text;
  p record; v_pref_id text; v_t_id text; v_code text; v_nom_norm text;
  v_source constant text := 'migration 20261103100000, emprise approximative';
BEGIN
  SELECT "id" INTO v_nation FROM "territoires_voirie" WHERE "niveau" = 'NATION' AND "deletedAt" IS NULL ORDER BY "createdAt" LIMIT 1;
  IF v_nation IS NULL THEN
    v_nation := gen_random_uuid()::text;
    INSERT INTO "territoires_voirie" ("id", "niveau", "code", "nom", "chemin", "profondeur", "source") VALUES (v_nation, 'NATION', 'GN', 'Guinée', '', 0, 'migration 20261103100000');
    INSERT INTO "territoires_voirie_historique" ("territoireId", "action", "version", "apres") SELECT v_nation, 'MIGRATION', 1, to_jsonb(t) - 'emprise' FROM "territoires_voirie" t WHERE t."id" = v_nation;
  END IF;

  SELECT "id" INTO v_region_admin FROM "regions" WHERE lower(unaccent("nom")) = 'faranah' ORDER BY "id" LIMIT 1;
  SELECT "id" INTO v_region FROM "territoires_voirie" WHERE "code" = 'GN-REG-FARANAH';
  IF v_region IS NULL THEN
    v_region := gen_random_uuid()::text;
    INSERT INTO "territoires_voirie" ("id", "parentId", "niveau", "code", "nom", "chemin", "profondeur", "regionId", "source") VALUES (v_region, v_nation, 'REGION', 'GN-REG-FARANAH', 'Faranah', '', 0, v_region_admin, 'migration 20261103100000');
    INSERT INTO "territoires_voirie_historique" ("territoireId", "action", "version", "apres") SELECT v_region, 'MIGRATION', 1, to_jsonb(t) - 'emprise' FROM "territoires_voirie" t WHERE t."id" = v_region;
  END IF;

  SELECT "id" INTO v_pref FROM "territoires_voirie" WHERE "code" = 'GN-PREF-KISSIDOUGOU';
  IF v_pref IS NULL THEN
    v_pref := gen_random_uuid()::text;
    INSERT INTO "territoires_voirie" ("id", "parentId", "niveau", "code", "nom", "chemin", "profondeur", "source") VALUES (v_pref, v_region, 'PREFECTURE', 'GN-PREF-KISSIDOUGOU', 'Kissidougou', '', 0, 'migration 20261103100000');
    INSERT INTO "territoires_voirie_historique" ("territoireId", "action", "version", "apres") SELECT v_pref, 'MIGRATION', 1, to_jsonb(t) - 'emprise' FROM "territoires_voirie" t WHERE t."id" = v_pref;
  END IF;

  SELECT "id" INTO v_com FROM "territoires_voirie" WHERE "code" = 'GN-COM-KISSIDOUGOU';
  IF v_com IS NULL THEN
    v_com := gen_random_uuid()::text;
    -- Emprise APPROXIMATIVE : rectangle d'environ 13 km autour du centre de la ville (WGS 84). Ce n'est pas une limite administrative.
    INSERT INTO "territoires_voirie" ("id", "parentId", "niveau", "code", "nom", "chemin", "profondeur", "emprise", "source")
      VALUES (v_com, v_pref, 'COMMUNE', 'GN-COM-KISSIDOUGOU', 'Kissidougou', '', 0, ST_SetSRID(ST_MakeEnvelope(-10.16, 9.13, -10.04, 9.25), 4326), v_source);
    INSERT INTO "territoires_voirie_historique" ("territoireId", "action", "version", "apres")
      SELECT v_com, 'MIGRATION', 1, (to_jsonb(t) - 'emprise') || jsonb_build_object('bbox', ARRAY[ST_XMin(t."emprise"), ST_YMin(t."emprise"), ST_XMax(t."emprise"), ST_YMax(t."emprise")], 'empriseMd5', md5(ST_AsEWKB(t."emprise")::text))
        FROM "territoires_voirie" t WHERE t."id" = v_com;
  END IF;

  -- Projets existants sans territoire : commune retrouvee par le nom (sans accents ni casse), sinon creee ; sinon prefecture ; sinon NON_RENSEIGNE.
  FOR p IN SELECT "id", "commune", "prefecture", "regionId" FROM "projets_voirie" WHERE "territoireId" IS NULL ORDER BY "createdAt", "id" LOOP
    v_t_id := NULL;
    v_pref_id := NULL;
    IF p."prefecture" IS NOT NULL AND btrim(p."prefecture") <> '' THEN
      v_nom_norm := lower(unaccent(btrim(p."prefecture")));
      SELECT "id" INTO v_pref_id FROM "territoires_voirie" WHERE "niveau" = 'PREFECTURE' AND "deletedAt" IS NULL AND lower(unaccent("nom")) = v_nom_norm ORDER BY "createdAt" LIMIT 1;
      IF v_pref_id IS NULL THEN
        v_pref_id := gen_random_uuid()::text;
        v_code := left('MIG-PREF-' || upper(regexp_replace(unaccent(btrim(p."prefecture")), '[^A-Za-z0-9]+', '-', 'g')), 64);
        v_code := regexp_replace(v_code, '-+$', '');
        IF EXISTS (SELECT 1 FROM "territoires_voirie" WHERE "code" = v_code) THEN v_code := left(v_code, 56) || '-' || upper(left(md5(v_pref_id), 6)); END IF;
        INSERT INTO "territoires_voirie" ("id", "parentId", "niveau", "code", "nom", "chemin", "profondeur", "regionId", "source")
          VALUES (v_pref_id, v_nation, 'PREFECTURE', v_code, btrim(p."prefecture"), '', 0, p."regionId", 'migration 20261103100000, cree depuis la prefecture du projet ' || p."id");
        INSERT INTO "territoires_voirie_historique" ("territoireId", "action", "version", "apres") SELECT v_pref_id, 'MIGRATION', 1, to_jsonb(t) - 'emprise' FROM "territoires_voirie" t WHERE t."id" = v_pref_id;
      END IF;
    END IF;
    IF p."commune" IS NOT NULL AND btrim(p."commune") <> '' THEN
      v_nom_norm := lower(unaccent(btrim(p."commune")));
      SELECT "id" INTO v_t_id FROM "territoires_voirie" WHERE "niveau" = 'COMMUNE' AND "deletedAt" IS NULL AND lower(unaccent("nom")) = v_nom_norm
        ORDER BY ("parentId" = v_pref_id) DESC NULLS LAST, "createdAt" LIMIT 1;
      IF v_t_id IS NULL THEN
        v_t_id := gen_random_uuid()::text;
        v_code := left('MIG-COM-' || upper(regexp_replace(unaccent(btrim(p."commune")), '[^A-Za-z0-9]+', '-', 'g')), 64);
        v_code := regexp_replace(v_code, '-+$', '');
        IF EXISTS (SELECT 1 FROM "territoires_voirie" WHERE "code" = v_code) THEN v_code := left(v_code, 56) || '-' || upper(left(md5(v_t_id), 6)); END IF;
        INSERT INTO "territoires_voirie" ("id", "parentId", "niveau", "code", "nom", "chemin", "profondeur", "regionId", "source")
          VALUES (v_t_id, COALESCE(v_pref_id, v_nation), 'COMMUNE', v_code, btrim(p."commune"), '', 0, p."regionId", 'migration 20261103100000, cree depuis la commune du projet ' || p."id");
        INSERT INTO "territoires_voirie_historique" ("territoireId", "action", "version", "apres") SELECT v_t_id, 'MIGRATION', 1, to_jsonb(t) - 'emprise' FROM "territoires_voirie" t WHERE t."id" = v_t_id;
      END IF;
    ELSIF v_pref_id IS NOT NULL THEN
      v_t_id := v_pref_id;
    END IF;
    IF v_t_id IS NULL THEN
      SELECT "id" INTO v_nr FROM "territoires_voirie" WHERE "code" = 'NON_RENSEIGNE';
      IF v_nr IS NULL THEN
        v_nr := gen_random_uuid()::text;
        INSERT INTO "territoires_voirie" ("id", "parentId", "niveau", "code", "nom", "chemin", "profondeur", "source")
          VALUES (v_nr, v_nation, 'ZONE', 'NON_RENSEIGNE', 'Territoire non renseigné', '', 0, 'migration 20261103100000 : projets sans commune ni prefecture');
        INSERT INTO "territoires_voirie_historique" ("territoireId", "action", "version", "apres") SELECT v_nr, 'MIGRATION', 1, to_jsonb(t) - 'emprise' FROM "territoires_voirie" t WHERE t."id" = v_nr;
      END IF;
      v_t_id := v_nr;
    END IF;
    UPDATE "projets_voirie" SET "territoireId" = v_t_id WHERE "id" = p."id";
  END LOOP;
END $$;

COMMENT ON TABLE "territoires_voirie" IS 'Referentiel territorial hierarchique des projets de voirie (nation, region, prefecture, commune, quartier, secteur, zone). Emprises approximatives sauf mention contraire (source). Contrat : docs/projets-voirie/CONTRAT-TERRITOIRES.md';
COMMENT ON TABLE "referentiels_voirie" IS 'Valeurs configurables par domaine (types de reseau, categories de projet, types de document, methodes d''acquisition, statuts de qualite), parametres JSON valides par domaine, versionnees. Contrat : CONTRAT-TERRITOIRES.md section 5';
COMMENT ON TABLE "configuration_voirie" IS 'Configuration nationale du module (emprise de plausibilite, bandes de CRS metrique, liste blanche des CRS d''import, protections). Variables d''environnement prioritaires. Contrat : CONTRAT-TERRITOIRES.md section 6';

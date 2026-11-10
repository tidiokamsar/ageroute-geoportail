-- PROJETS DE VOIRIE ET RESEAUX, LOT X1 : EXPORT DU DOSSIER TECHNIQUE ET DEROGATIONS DE CONFIDENTIALITE
--
-- Contrat : docs/projets-voirie/CONTRAT-EXPORTS.md (section 3). Decision architecturale 2 (08/11/2026), section 8.
--
-- CE QUE CETTE MIGRATION FAIT (ADDITIVE : aucune table, colonne ni type existant n'est modifie ni supprime)
--
--   1. `exports_dossier_projet_voirie` : journal des archives REMISES (projet, compte, empreinte SHA-256 de l'archive, taille, nombre de fichiers et
--      de jeux exportes en GeoJSON, manifeste sans geometrie). AJOUT SEUL : UPDATE, DELETE et TRUNCATE refuses. Sert aussi a la cadence par compte.
--   2. `derogations_export_projet_voirie` : derogation ADMIN, justifiee, nominative (beneficiaire), bornee dans le temps (7 jours au plus) et A USAGE
--      UNIQUE, qui seule permet d'exporter en GeoJSON un jeu CONFIDENTIEL_CONCESSIONNAIRE ou INFRASTRUCTURE_SENSIBLE. Tout est immuable sauf le couple
--      (utiliseeLe, exportId), qui passe UNE fois de nul a renseigne, avant l'expiration (declencheur) ; DELETE et TRUNCATE refuses.
--
-- Les tableaux de bord (lot X1) n'ecrivent rien et n'ont besoin d'aucun objet de base.
-- Idempotente (IF NOT EXISTS, CREATE OR REPLACE, DROP TRIGGER IF EXISTS). Exige les migrations 20261030100000 (socle : projets, users).
-- Horodatages en TIMESTAMP(3) sans fuseau, ecrits en UTC par le serveur (comme le reste du schema) ; la base compare a `now() AT TIME ZONE 'UTC'`.
-- REVERSIBILITE : descentes/20261104200000_exports_tableaux_de_bord.sql.

-- ===== 1. Journal des exports (ajout seul) =====

CREATE TABLE IF NOT EXISTS "exports_dossier_projet_voirie" (
  "id"             TEXT PRIMARY KEY,
  "projetId"       TEXT NOT NULL REFERENCES "projets_voirie"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "acteurId"       TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "sha256"         TEXT NOT NULL,
  "tailleOctets"   INTEGER NOT NULL,
  "nbFichiers"     INTEGER NOT NULL,
  "nbJeuxGeojson"  INTEGER NOT NULL DEFAULT 0,
  -- Manifeste : chemins, tailles, empreintes, jeux exportes et ecartes avec leur raison. Jamais de geometrie.
  "manifeste"      JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "edpv_sha256" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "edpv_taille" CHECK ("tailleOctets" > 0),
  CONSTRAINT "edpv_fichiers" CHECK ("nbFichiers" >= 1),
  CONSTRAINT "edpv_geojson" CHECK ("nbJeuxGeojson" >= 0),
  CONSTRAINT "edpv_manifeste" CHECK (jsonb_typeof("manifeste") = 'object')
);
CREATE INDEX IF NOT EXISTS "exports_dossier_projet_voirie_acteurId_createdAt_idx" ON "exports_dossier_projet_voirie" ("acteurId", "createdAt");
CREATE INDEX IF NOT EXISTS "exports_dossier_projet_voirie_projetId_createdAt_idx" ON "exports_dossier_projet_voirie" ("projetId", "createdAt");

-- ===== 2. Derogations de confidentialite (usage unique) =====

CREATE TABLE IF NOT EXISTS "derogations_export_projet_voirie" (
  "id"              TEXT PRIMARY KEY,
  "projetId"        TEXT NOT NULL REFERENCES "projets_voirie"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Jeux couverts (du projet, controles par le service a la creation) : 1 a 20, distincts.
  "jeuxIds"         TEXT[] NOT NULL,
  "beneficiaireId"  TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "accordeeParId"   TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "justification"   TEXT NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expireLe"        TIMESTAMP(3) NOT NULL,
  "utiliseeLe"      TIMESTAMP(3),
  "exportId"        TEXT REFERENCES "exports_dossier_projet_voirie"("id") ON UPDATE CASCADE ON DELETE RESTRICT,

  CONSTRAINT "dxpv_jeux" CHECK (cardinality("jeuxIds") BETWEEN 1 AND 20 AND array_position("jeuxIds", NULL) IS NULL),
  CONSTRAINT "dxpv_justification" CHECK (length(btrim("justification")) BETWEEN 20 AND 2000),
  CONSTRAINT "dxpv_duree" CHECK ("expireLe" > "createdAt" AND "expireLe" <= "createdAt" + interval '7 days'),
  -- Usage unique : la date d'utilisation et l'export qui l'a consommee sont poses ensemble.
  CONSTRAINT "dxpv_usage" CHECK (("utiliseeLe" IS NULL) = ("exportId" IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS "derogations_export_projet_voirie_exportId_key" ON "derogations_export_projet_voirie" ("exportId");
CREATE INDEX IF NOT EXISTS "derogations_export_projet_voirie_projetId_createdAt_idx" ON "derogations_export_projet_voirie" ("projetId", "createdAt");
CREATE INDEX IF NOT EXISTS "derogations_export_projet_voirie_beneficiaireId_idx" ON "derogations_export_projet_voirie" ("beneficiaireId");

-- ===== 3. Declencheurs =====

CREATE OR REPLACE FUNCTION derogations_export_projet_voirie_controle() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."utiliseeLe" IS NOT NULL OR NEW."exportId" IS NOT NULL THEN
      RAISE EXCEPTION 'derogations_export_projet_voirie : une derogation nait inutilisee' USING ERRCODE = 'check_violation';
    END IF;
    IF (SELECT count(DISTINCT x) FROM unnest(NEW."jeuxIds") AS x) <> cardinality(NEW."jeuxIds") THEN
      RAISE EXCEPTION 'derogations_export_projet_voirie : jeux en double' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE : seule la consommation, une fois, avant l'expiration.
  IF NEW."id" <> OLD."id" OR NEW."projetId" <> OLD."projetId" OR NEW."jeuxIds" <> OLD."jeuxIds" OR NEW."beneficiaireId" <> OLD."beneficiaireId"
     OR NEW."accordeeParId" <> OLD."accordeeParId" OR NEW."justification" <> OLD."justification" OR NEW."createdAt" <> OLD."createdAt"
     OR NEW."expireLe" <> OLD."expireLe" THEN
    RAISE EXCEPTION 'derogations_export_projet_voirie : une derogation est immuable (seule sa consommation s''ecrit)' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."utiliseeLe" IS NOT NULL OR OLD."exportId" IS NOT NULL THEN
    RAISE EXCEPTION 'derogations_export_projet_voirie : derogation deja utilisee (usage unique)' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."utiliseeLe" IS NULL OR NEW."exportId" IS NULL THEN
    RAISE EXCEPTION 'derogations_export_projet_voirie : seule la consommation (date et export) modifie une derogation' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."expireLe" <= (now() AT TIME ZONE 'UTC') THEN
    RAISE EXCEPTION 'derogations_export_projet_voirie : derogation expiree' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION exports_tableaux_refuse() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '% : ajout seul (un journal ne se modifie pas)', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  RAISE EXCEPTION '% : suppression interdite (journal et derogations sont des archives)', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END
$fn$;

DROP TRIGGER IF EXISTS exports_dossier_projet_voirie_ajout_seul ON "exports_dossier_projet_voirie";
CREATE TRIGGER exports_dossier_projet_voirie_ajout_seul BEFORE UPDATE OR DELETE ON "exports_dossier_projet_voirie" FOR EACH ROW EXECUTE FUNCTION exports_tableaux_refuse();
DROP TRIGGER IF EXISTS exports_dossier_projet_voirie_troncature ON "exports_dossier_projet_voirie";
CREATE TRIGGER exports_dossier_projet_voirie_troncature BEFORE TRUNCATE ON "exports_dossier_projet_voirie" FOR EACH STATEMENT EXECUTE FUNCTION exports_tableaux_refuse();
DROP TRIGGER IF EXISTS derogations_export_projet_voirie_controle ON "derogations_export_projet_voirie";
CREATE TRIGGER derogations_export_projet_voirie_controle BEFORE INSERT OR UPDATE ON "derogations_export_projet_voirie" FOR EACH ROW EXECUTE FUNCTION derogations_export_projet_voirie_controle();
DROP TRIGGER IF EXISTS derogations_export_projet_voirie_suppression ON "derogations_export_projet_voirie";
CREATE TRIGGER derogations_export_projet_voirie_suppression BEFORE DELETE ON "derogations_export_projet_voirie" FOR EACH ROW EXECUTE FUNCTION exports_tableaux_refuse();
DROP TRIGGER IF EXISTS derogations_export_projet_voirie_troncature ON "derogations_export_projet_voirie";
CREATE TRIGGER derogations_export_projet_voirie_troncature BEFORE TRUNCATE ON "derogations_export_projet_voirie" FOR EACH STATEMENT EXECUTE FUNCTION exports_tableaux_refuse();

COMMENT ON TABLE "exports_dossier_projet_voirie" IS 'Journal en ajout seul des dossiers techniques de projet de voirie remis (empreinte, taille, manifeste sans geometrie). Contrat : docs/projets-voirie/CONTRAT-EXPORTS.md';
COMMENT ON TABLE "derogations_export_projet_voirie" IS 'Derogations ADMIN, justifiees, nominatives et a usage unique pour exporter en GeoJSON un jeu CONFIDENTIEL_CONCESSIONNAIRE ou INFRASTRUCTURE_SENSIBLE.';

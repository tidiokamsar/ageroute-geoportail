-- PROJETS DE VOIRIE ET RESEAUX, LOT B2 : JOBS DE CONVERSION GDAL (GeoPackage, Shapefile ZIP, DXF), TRAITEMENT ASYNCHRONE
--
-- Contrat : docs/projets-voirie/CONTRAT-IMPORT.md (section 13), docs/projets-voirie/CHAINE-GDAL.md (spool), docs/projets-voirie/API.md.
--
-- CE QUE CETTE MIGRATION FAIT
--
--   1. `FormatJeuProjet` : trois valeurs ajoutees (GPKG, SHAPEFILE, DXF). Un jeu issu d'une conversion GDAL entre dans le MEME pipeline que
--      les formats simples et porte le format du fichier d'origine.
--   2. `projets_voirie_import_jobs` : un job de conversion par ligne (statuts EN_ATTENTE, EN_COURS, TERMINE, ECHEC, ANNULE, EXPIRE),
--      tentatives bornees, delai d'expiration, resume SANS geometrie. Les fichiers eux-memes vivent dans le spool (volume partage avec le
--      conteneur de conversion), jamais dans la base.
--   3. Declencheurs : machine a etats imposee PAR LA BASE (un statut final ne change plus ; seules la purge et le lien vers le jeu peuvent
--      encore etre notes), aucune suppression physique, aucun TRUNCATE.
--
-- ETATS INCOHERENTS REFUSES PAR LA BASE : progression hors de 0 a 100, tentatives au-dela du maximum, statut final sans date de fin, code d'erreur
-- hors ECHEC et EXPIRE, format qui n'est pas GPKG, SHAPEFILE ou DXF, empreinte mal formee, resume ou parametres qui ne sont pas des objets, retour
-- d'un statut final a un statut actif, saut EN_ATTENTE vers TERMINE.
--
-- NATURE : additive. Une table, un type, trois valeurs d'enumeration, des index, des declencheurs. Aucune ligne existante touchee. Les cles
-- etrangeres n'existent qu'en SQL (le schema Prisma ne declare pas les relations, comme pour le lot A1). Idempotente.
-- REVERSIBILITE : descentes/20261102200000_import_jobs_gdal.sql (refusee si un job existe ; reconstruction du type, refusee si un jeu porte une
-- des trois valeurs).

-- ===== 1. Formats =====

ALTER TYPE "FormatJeuProjet" ADD VALUE IF NOT EXISTS 'GPKG';
ALTER TYPE "FormatJeuProjet" ADD VALUE IF NOT EXISTS 'SHAPEFILE';
ALTER TYPE "FormatJeuProjet" ADD VALUE IF NOT EXISTS 'DXF';

-- ===== 2. Jobs =====

DO $$ BEGIN CREATE TYPE "StatutJobImportProjet" AS ENUM ('EN_ATTENTE', 'EN_COURS', 'TERMINE', 'ECHEC', 'ANNULE', 'EXPIRE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "projets_voirie_import_jobs" (
  "id"            TEXT PRIMARY KEY,
  "projetId"      TEXT NOT NULL REFERENCES "projets_voirie"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "creeParId"     TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "format"        "FormatJeuProjet" NOT NULL,
  "statut"        "StatutJobImportProjet" NOT NULL DEFAULT 'EN_ATTENTE',
  "nomFichier"    TEXT NOT NULL,
  "sha256"        TEXT NOT NULL,
  "tailleOctets"  INTEGER NOT NULL,
  -- Choix de l'utilisateur au depot du fichier (epsgSource, unitesDxf). Jamais de geometrie.
  "parametres"    JSONB NOT NULL DEFAULT '{}'::jsonb,
  "etape"         TEXT,
  "progression"   INTEGER NOT NULL DEFAULT 0,
  "codeErreur"    TEXT,
  "messageErreur" TEXT,
  "tentatives"    INTEGER NOT NULL DEFAULT 0,
  "tentativesMax" INTEGER NOT NULL DEFAULT 3,
  -- Identifiant du dossier du spool pour la tentative courante (`<id>-t<n>`) ; nul tant qu'aucune tentative n'a commence.
  "spoolId"       TEXT,
  "reclameLe"     TIMESTAMP(3),
  "finLe"         TIMESTAMP(3),
  "expireLe"      TIMESTAMP(3) NOT NULL,
  -- Date a laquelle les fichiers du spool ont ete retires (apres depot, annulation, echec ou expiration).
  "purgeLe"       TIMESTAMP(3),
  -- Inventaire du resultat VALIDE (couches, comptes, CRS, calques DXF, avertissements) : jamais de coordonnees d'objet.
  "resume"        JSONB,
  -- Jeu cree a partir de ce job (un seul depot par job).
  "jeuId"         TEXT REFERENCES "projets_voirie_jeux"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "annuleParId"   TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "pvij_format" CHECK ("format"::text IN ('GPKG', 'SHAPEFILE', 'DXF')),
  CONSTRAINT "pvij_sha256" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pvij_taille" CHECK ("tailleOctets" > 0 AND "tailleOctets" <= 26214400),
  CONSTRAINT "pvij_progression" CHECK ("progression" BETWEEN 0 AND 100),
  CONSTRAINT "pvij_tentatives" CHECK ("tentatives" >= 0 AND "tentativesMax" BETWEEN 1 AND 10 AND "tentatives" <= "tentativesMax"),
  CONSTRAINT "pvij_parametres_objet" CHECK (jsonb_typeof("parametres") = 'object'),
  CONSTRAINT "pvij_resume_objet" CHECK ("resume" IS NULL OR jsonb_typeof("resume") = 'object'),
  CONSTRAINT "pvij_fin_si_final" CHECK (("statut" IN ('EN_ATTENTE', 'EN_COURS')) = ("finLe" IS NULL)),
  CONSTRAINT "pvij_code_si_echec" CHECK ("codeErreur" IS NULL OR "statut" IN ('ECHEC', 'EXPIRE')),
  CONSTRAINT "pvij_annule_par" CHECK ("annuleParId" IS NULL OR "statut" = 'ANNULE'),
  CONSTRAINT "pvij_jeu_si_termine" CHECK ("jeuId" IS NULL OR "statut" = 'TERMINE')
);
CREATE INDEX IF NOT EXISTS "projets_voirie_import_jobs_projetId_createdAt_idx" ON "projets_voirie_import_jobs" ("projetId", "createdAt");
CREATE INDEX IF NOT EXISTS "projets_voirie_import_jobs_statut_expireLe_idx" ON "projets_voirie_import_jobs" ("statut", "expireLe");
CREATE INDEX IF NOT EXISTS "projets_voirie_import_jobs_creeParId_statut_idx" ON "projets_voirie_import_jobs" ("creeParId", "statut");
CREATE INDEX IF NOT EXISTS "projets_voirie_import_jobs_jeuId_idx" ON "projets_voirie_import_jobs" ("jeuId");
-- Un seul job ACTIF par projet, empreinte et parametres : relancer le meme envoi ne cree pas de doublon.
CREATE UNIQUE INDEX IF NOT EXISTS "projets_voirie_import_jobs_actif_unique" ON "projets_voirie_import_jobs" ("projetId", "sha256", md5("parametres"::text))
  WHERE "statut" IN ('EN_ATTENTE', 'EN_COURS');

-- ===== 3. Declencheurs : machine a etats, aucune suppression physique =====

CREATE OR REPLACE FUNCTION projets_voirie_import_jobs_transition() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."statut" IS DISTINCT FROM OLD."statut" THEN
    IF NOT (
      (OLD."statut" = 'EN_ATTENTE' AND NEW."statut" IN ('EN_COURS', 'ANNULE', 'EXPIRE', 'ECHEC')) OR
      (OLD."statut" = 'EN_COURS'   AND NEW."statut" IN ('TERMINE', 'ECHEC', 'ANNULE', 'EN_ATTENTE', 'EXPIRE')) OR
      (OLD."statut" = 'TERMINE'    AND NEW."statut" = 'EXPIRE')
    ) THEN
      RAISE EXCEPTION 'projets_voirie_import_jobs : transition % vers % interdite', OLD."statut", NEW."statut" USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF OLD."statut" IN ('ECHEC', 'ANNULE', 'EXPIRE') THEN
    -- Statut final : seule la purge des fichiers peut encore etre notee.
    IF (to_jsonb(NEW) - 'purgeLe' - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'purgeLe' - 'updatedAt') THEN
      RAISE EXCEPTION 'projets_voirie_import_jobs : un job % ne change plus', OLD."statut" USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF OLD."statut" = 'TERMINE' THEN
    -- TERMINE : le resultat est fige ; seuls la purge, le lien vers le jeu et la date de mise a jour peuvent changer.
    IF (to_jsonb(NEW) - 'purgeLe' - 'jeuId' - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'purgeLe' - 'jeuId' - 'updatedAt') THEN
      RAISE EXCEPTION 'projets_voirie_import_jobs : le resultat d''un job TERMINE est fige' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION projets_voirie_import_jobs_refuse_suppression() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '% : suppression physique interdite (journal des conversions)', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END
$fn$;

DROP TRIGGER IF EXISTS projets_voirie_import_jobs_transition ON "projets_voirie_import_jobs";
CREATE TRIGGER projets_voirie_import_jobs_transition BEFORE UPDATE ON "projets_voirie_import_jobs" FOR EACH ROW EXECUTE FUNCTION projets_voirie_import_jobs_transition();
DROP TRIGGER IF EXISTS projets_voirie_import_jobs_suppression ON "projets_voirie_import_jobs";
CREATE TRIGGER projets_voirie_import_jobs_suppression BEFORE DELETE ON "projets_voirie_import_jobs" FOR EACH ROW EXECUTE FUNCTION projets_voirie_import_jobs_refuse_suppression();
DROP TRIGGER IF EXISTS projets_voirie_import_jobs_troncature ON "projets_voirie_import_jobs";
CREATE TRIGGER projets_voirie_import_jobs_troncature BEFORE TRUNCATE ON "projets_voirie_import_jobs" FOR EACH STATEMENT EXECUTE FUNCTION projets_voirie_import_jobs_refuse_suppression();

COMMENT ON TABLE "projets_voirie_import_jobs" IS 'Jobs de conversion GDAL (GeoPackage, Shapefile ZIP, DXF) : etat, tentatives, resume sans geometrie. Les fichiers vivent dans le spool, purges a l''expiration. Contrat : docs/projets-voirie/CONTRAT-IMPORT.md section 13.';

-- PROJETS DE VOIRIE ET RESEAUX, LOT A1 : FORMATS D'IMPORT OUVERTS, REVUE DES SUPPRESSIONS, RETOUR ARRIERE, ORIGINAL FACULTATIF
--
-- Contrat : docs/projets-voirie/CONTRAT-IMPORT.md.
--
-- CE QUE CETTE MIGRATION FAIT
--
--   1. `FormatJeuProjet` : trois valeurs ajoutees (KMZ, GPX, CSV). TSV et TXT sont des CSV (le delimiteur est dans `resume`).
--   2. `projets_voirie_import_evenements` : decisions humaines sur un jeu, EN AJOUT SEUL (aucune modification ni suppression) :
--      revue des SUPPRESSIONS d'une nouvelle version (acceptees ou refusees) et RETOUR ARRIERE d'une version. Chaque ligne porte l'acteur,
--      la justification (10 caracteres au moins) et des details JSON sans geometrie. C'est ce qui rend le statut des suppressions
--      (A_REVOIR, ACCEPTEES, REFUSEES) lisible a part du statut du jeu.
--   3. `projets_voirie_fichiers_origine` : fichier d'origine d'un jeu, ecrit SEULEMENT si PROJETS_VOIRIE_CONSERVER_ORIGINAL=oui
--      (decision de retention non prise : par defaut la table reste vide, comme le socle qui ne conserve que l'empreinte). Un jeu a au plus
--      un fichier ; ni modification ni suppression physique.
--
-- ETATS INCOHERENTS REFUSES PAR LA BASE : justification trop courte ; evenement de retour arriere sans jeu lie (et inversement) ;
-- fichier d'origine dont la taille ou l'empreinte ne correspond pas ; TRUNCATE, UPDATE ou DELETE sur ces deux tables.
--
-- NATURE : additive. Deux tables, un type, trois valeurs d'enumeration, des index, des declencheurs. Aucune ligne existante touchee.
-- Les cles etrangeres n'existent qu'en SQL (le schema Prisma ne declare pas les relations : voir schema.prisma, lot A1).
-- Idempotente. REVERSIBILITE : descentes/20261101100000_import_formats_versions.sql (reconstruction du type, refusee si un jeu porte une
-- des trois valeurs).

-- ===== 1. Formats =====

ALTER TYPE "FormatJeuProjet" ADD VALUE IF NOT EXISTS 'KMZ';
ALTER TYPE "FormatJeuProjet" ADD VALUE IF NOT EXISTS 'GPX';
ALTER TYPE "FormatJeuProjet" ADD VALUE IF NOT EXISTS 'CSV';

-- ===== 2. Evenements d'import =====

DO $$ BEGIN CREATE TYPE "TypeEvenementImportProjet" AS ENUM ('SUPPRESSIONS_ACCEPTEES', 'SUPPRESSIONS_REFUSEES', 'RETOUR_ARRIERE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "projets_voirie_import_evenements" (
  "id"            TEXT PRIMARY KEY,
  "projetId"      TEXT NOT NULL REFERENCES "projets_voirie"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Le jeu concerne : celui dont les suppressions sont revues, ou celui qui est RETIRE DU SERVICE par un retour arriere.
  "jeuId"         TEXT NOT NULL REFERENCES "projets_voirie_jeux"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Retour arriere seulement : le jeu RESTAURE (la version precedente).
  "jeuLieId"      TEXT REFERENCES "projets_voirie_jeux"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "type"          "TypeEvenementImportProjet" NOT NULL,
  "acteurId"      TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "justification" TEXT NOT NULL,
  -- Revue : nb d'objets retires, empreinte de l'ensemble retire. Retour arriere : versions. Jamais de geometrie.
  "details"       JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "pvie_justification" CHECK (length(btrim("justification")) >= 10),
  CONSTRAINT "pvie_details_objet" CHECK (jsonb_typeof("details") = 'object'),
  CONSTRAINT "pvie_retour_lie" CHECK (("type" = 'RETOUR_ARRIERE') = ("jeuLieId" IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS "projets_voirie_import_evenements_jeuId_createdAt_idx" ON "projets_voirie_import_evenements" ("jeuId", "createdAt");
CREATE INDEX IF NOT EXISTS "projets_voirie_import_evenements_jeuLieId_idx" ON "projets_voirie_import_evenements" ("jeuLieId");
CREATE INDEX IF NOT EXISTS "projets_voirie_import_evenements_projetId_idx" ON "projets_voirie_import_evenements" ("projetId");

-- ===== 3. Fichiers d'origine (facultatifs) =====

CREATE TABLE IF NOT EXISTS "projets_voirie_fichiers_origine" (
  "jeuId"        TEXT PRIMARY KEY REFERENCES "projets_voirie_jeux"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "sha256"       TEXT NOT NULL,
  "tailleOctets" INTEGER NOT NULL,
  "contenu"      BYTEA NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "pvfo_sha256" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pvfo_taille" CHECK ("tailleOctets" > 0 AND "tailleOctets" <= 26214400 AND octet_length("contenu") = "tailleOctets")
);

-- ===== 4. Declencheurs : ajout seul, jamais de suppression physique ni de TRUNCATE =====

CREATE OR REPLACE FUNCTION projets_voirie_import_ajout_seul() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '% : ajout seul (aucune modification ni suppression physique)', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END
$fn$;

CREATE OR REPLACE FUNCTION projets_voirie_import_refuse_troncature() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '% : TRUNCATE interdit', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END
$fn$;

DROP TRIGGER IF EXISTS projets_voirie_import_evenements_ajout_seul ON "projets_voirie_import_evenements";
CREATE TRIGGER projets_voirie_import_evenements_ajout_seul BEFORE UPDATE OR DELETE ON "projets_voirie_import_evenements" FOR EACH ROW EXECUTE FUNCTION projets_voirie_import_ajout_seul();
DROP TRIGGER IF EXISTS projets_voirie_import_evenements_troncature ON "projets_voirie_import_evenements";
CREATE TRIGGER projets_voirie_import_evenements_troncature BEFORE TRUNCATE ON "projets_voirie_import_evenements" FOR EACH STATEMENT EXECUTE FUNCTION projets_voirie_import_refuse_troncature();

DROP TRIGGER IF EXISTS projets_voirie_fichiers_origine_ajout_seul ON "projets_voirie_fichiers_origine";
CREATE TRIGGER projets_voirie_fichiers_origine_ajout_seul BEFORE UPDATE OR DELETE ON "projets_voirie_fichiers_origine" FOR EACH ROW EXECUTE FUNCTION projets_voirie_import_ajout_seul();
DROP TRIGGER IF EXISTS projets_voirie_fichiers_origine_troncature ON "projets_voirie_fichiers_origine";
CREATE TRIGGER projets_voirie_fichiers_origine_troncature BEFORE TRUNCATE ON "projets_voirie_fichiers_origine" FOR EACH STATEMENT EXECUTE FUNCTION projets_voirie_import_refuse_troncature();

COMMENT ON TABLE "projets_voirie_import_evenements" IS 'Decisions humaines sur un jeu : revue des suppressions d''une nouvelle version, retour arriere. Ajout seul. Contrat : docs/projets-voirie/CONTRAT-IMPORT.md';
COMMENT ON TABLE "projets_voirie_fichiers_origine" IS 'Fichier d''origine d''un jeu, seulement si PROJETS_VOIRIE_CONSERVER_ORIGINAL=oui (retention a decider). Jamais relu par une route : ce serait un export de geometrie.';

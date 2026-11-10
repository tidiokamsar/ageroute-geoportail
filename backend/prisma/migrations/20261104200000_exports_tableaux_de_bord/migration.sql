-- PROJETS DE VOIRIE ET RESEAUX, LOT X1 : EXPORT DU DOSSIER TECHNIQUE ET DEROGATIONS DE CONFIDENTIALITE
--
-- Contrat : docs/projets-voirie/CONTRAT-EXPORTS.md (section 3). Decision architecturale 2 (08/11/2026), section 8.
--
-- CE QUE CETTE MIGRATION FAIT (ADDITIVE : aucune table, colonne ni type existant n'est modifie ni supprime)
--
--   1. `exports_dossier_projet_voirie` : journal des TENTATIVES d'export (revue du lot X1, M3 et M4) : une ligne EN_COURS des que la cadence est passee,
--      puis UNE seule issue (REMIS apres l'ecriture complete de la reponse, ECHEC, ECHEC_ENVOI) avec l'empreinte de l'archive, sa taille et le manifeste
--      sans geometrie. Rien d'autre ne change ; DELETE et TRUNCATE refuses. Toutes les tentatives comptent dans la cadence par compte.
--   2. `derogations_export_projet_voirie` : derogation ADMIN, justifiee, nominative (beneficiaire DIFFERENT de l'ADMIN qui l'accorde : separation des
--      taches, revue du lot X1, M2), bornee dans le temps (7 jours au plus) et A USAGE UNIQUE, qui seule permet d'exporter en GeoJSON un jeu
--      CONFIDENTIEL_CONCESSIONNAIRE ou INFRASTRUCTURE_SENSIBLE. Tout est immuable sauf la RESERVATION (`exportId`, posee par une tentative EN_COURS du
--      beneficiaire sur ce projet, avant l'expiration selon l'horloge de la base, levee si la tentative echoue) et la CONSOMMATION (`utiliseeLe`, une
--      seule fois, par la tentative qui la reserve, apres l'ecriture complete de l'archive) ; DELETE et TRUNCATE refuses.
--
-- Les tableaux de bord (lot X1) n'ecrivent rien et n'ont besoin d'aucun objet de base.
-- Idempotente (IF NOT EXISTS, CREATE OR REPLACE, DROP TRIGGER IF EXISTS). Exige les migrations 20261030100000 (socle : projets, users).
-- Horodatages en TIMESTAMP(3) sans fuseau, ecrits en UTC par le serveur (comme le reste du schema) ; la base compare a `now() AT TIME ZONE 'UTC'`.
-- REVERSIBILITE : descentes/20261104200000_exports_tableaux_de_bord.sql.

-- ===== 1. Journal des tentatives d'export (une issue unique) =====

CREATE TABLE IF NOT EXISTS "exports_dossier_projet_voirie" (
  "id"             TEXT PRIMARY KEY,
  "projetId"       TEXT NOT NULL REFERENCES "projets_voirie"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "acteurId"       TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "statut"         TEXT NOT NULL DEFAULT 'EN_COURS',
  -- Derogation citee par la tentative (information ; la reservation et la consommation sont portees par la derogation).
  "derogationId"   TEXT,
  "codeEchec"      TEXT,
  "sha256"         TEXT,
  "tailleOctets"   INTEGER,
  "nbFichiers"     INTEGER,
  "nbJeuxGeojson"  INTEGER NOT NULL DEFAULT 0,
  -- Manifeste : chemins, tailles, empreintes, jeux exportes et ecartes avec leur raison. Jamais de geometrie.
  "manifeste"      JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "termineLe"      TIMESTAMP(3),

  CONSTRAINT "edpv_statut" CHECK ("statut" IN ('EN_COURS', 'REMIS', 'ECHEC', 'ECHEC_ENVOI')),
  CONSTRAINT "edpv_sha256" CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "edpv_taille" CHECK ("tailleOctets" IS NULL OR "tailleOctets" > 0),
  CONSTRAINT "edpv_fichiers" CHECK ("nbFichiers" IS NULL OR "nbFichiers" >= 1),
  CONSTRAINT "edpv_geojson" CHECK ("nbJeuxGeojson" >= 0),
  CONSTRAINT "edpv_manifeste" CHECK (jsonb_typeof("manifeste") = 'object'),
  CONSTRAINT "edpv_remis" CHECK ("statut" <> 'REMIS' OR ("sha256" IS NOT NULL AND "tailleOctets" IS NOT NULL AND "nbFichiers" IS NOT NULL)),
  CONSTRAINT "edpv_issue" CHECK (("statut" = 'EN_COURS') = ("termineLe" IS NULL)),
  CONSTRAINT "edpv_code_echec" CHECK ("codeEchec" IS NULL OR ("statut" IN ('ECHEC', 'ECHEC_ENVOI') AND "codeEchec" ~ '^[A-Z][A-Z0-9_]{1,63}$'))
);
CREATE INDEX IF NOT EXISTS "exports_dossier_projet_voirie_acteurId_createdAt_idx" ON "exports_dossier_projet_voirie" ("acteurId", "createdAt");
CREATE INDEX IF NOT EXISTS "exports_dossier_projet_voirie_projetId_createdAt_idx" ON "exports_dossier_projet_voirie" ("projetId", "createdAt");

-- ===== 2. Derogations de confidentialite (separation des taches, reservation, usage unique) =====

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
  -- Tentative d'export qui RESERVE la derogation (puis la consomme si l'archive est entierement ecrite) ; nulle quand elle est libre.
  "exportId"        TEXT REFERENCES "exports_dossier_projet_voirie"("id") ON UPDATE CASCADE ON DELETE RESTRICT,

  CONSTRAINT "dxpv_jeux" CHECK (cardinality("jeuxIds") BETWEEN 1 AND 20 AND array_position("jeuxIds", NULL) IS NULL),
  CONSTRAINT "dxpv_justification" CHECK (length(btrim("justification")) BETWEEN 20 AND 2000),
  CONSTRAINT "dxpv_duree" CHECK ("expireLe" > "createdAt" AND "expireLe" <= "createdAt" + interval '7 days'),
  -- Separation des taches (revue du lot X1, M2) : l'ADMIN qui accorde n'est jamais le beneficiaire.
  CONSTRAINT "dxpv_separation" CHECK ("beneficiaireId" <> "accordeeParId"),
  -- Une derogation consommee l'a ete par une tentative (celle qui la reservait).
  CONSTRAINT "dxpv_usage" CHECK ("utiliseeLe" IS NULL OR "exportId" IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS "derogations_export_projet_voirie_exportId_key" ON "derogations_export_projet_voirie" ("exportId");
CREATE INDEX IF NOT EXISTS "derogations_export_projet_voirie_projetId_createdAt_idx" ON "derogations_export_projet_voirie" ("projetId", "createdAt");
CREATE INDEX IF NOT EXISTS "derogations_export_projet_voirie_beneficiaireId_idx" ON "derogations_export_projet_voirie" ("beneficiaireId");

-- ===== 3. Declencheurs =====

-- Journal : naissance EN_COURS, puis une seule issue ; identite, projet, compte, derogation citee et date de creation immuables.
CREATE OR REPLACE FUNCTION exports_dossier_projet_voirie_controle() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."statut" <> 'EN_COURS' THEN
      RAISE EXCEPTION 'exports_dossier_projet_voirie : une tentative nait EN_COURS' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."statut" <> 'EN_COURS' THEN
    RAISE EXCEPTION 'exports_dossier_projet_voirie : une tentative terminee est figee (ajout seul)' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."projetId" <> OLD."projetId" OR NEW."acteurId" <> OLD."acteurId" OR NEW."derogationId" IS DISTINCT FROM OLD."derogationId"
     OR NEW."createdAt" <> OLD."createdAt" OR NEW."statut" = 'EN_COURS' THEN
    RAISE EXCEPTION 'exports_dossier_projet_voirie : seule l''issue d''une tentative s''ecrit, une fois' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION derogations_export_projet_voirie_controle() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_export record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."utiliseeLe" IS NOT NULL OR NEW."exportId" IS NOT NULL THEN
      RAISE EXCEPTION 'derogations_export_projet_voirie : une derogation nait libre et inutilisee' USING ERRCODE = 'check_violation';
    END IF;
    -- Revue du lot X1, m3 : la date de creation est celle de la base (a 5 minutes pres), jamais une date choisie qui prolongerait la validite.
    IF abs(extract(epoch FROM (NEW."createdAt" - (now() AT TIME ZONE 'UTC')))) > 300 THEN
      RAISE EXCEPTION 'derogations_export_projet_voirie : createdAt doit etre l''heure de la base' USING ERRCODE = 'check_violation';
    END IF;
    IF (SELECT count(DISTINCT x) FROM unnest(NEW."jeuxIds") AS x) <> cardinality(NEW."jeuxIds") THEN
      RAISE EXCEPTION 'derogations_export_projet_voirie : jeux en double' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."projetId" <> OLD."projetId" OR NEW."jeuxIds" <> OLD."jeuxIds" OR NEW."beneficiaireId" <> OLD."beneficiaireId"
     OR NEW."accordeeParId" <> OLD."accordeeParId" OR NEW."justification" <> OLD."justification" OR NEW."createdAt" <> OLD."createdAt"
     OR NEW."expireLe" <> OLD."expireLe" THEN
    RAISE EXCEPTION 'derogations_export_projet_voirie : une derogation est immuable (seules sa reservation et sa consommation s''ecrivent)' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."utiliseeLe" IS NOT NULL THEN
    RAISE EXCEPTION 'derogations_export_projet_voirie : derogation deja utilisee (usage unique)' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."utiliseeLe" IS NOT NULL THEN
    -- Consommation : par la tentative qui la reserve, sans changer de tentative.
    IF OLD."exportId" IS NULL OR NEW."exportId" IS DISTINCT FROM OLD."exportId" THEN
      RAISE EXCEPTION 'derogations_export_projet_voirie : seule la tentative qui la reserve consomme la derogation' USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF NEW."exportId" IS NOT NULL AND NEW."exportId" IS DISTINCT FROM OLD."exportId" THEN
    -- Reservation : avant l'expiration (horloge de la base), par une tentative EN_COURS du beneficiaire sur ce projet (revue du lot X1, m3 et m4).
    IF OLD."expireLe" <= (now() AT TIME ZONE 'UTC') THEN
      RAISE EXCEPTION 'derogations_export_projet_voirie : derogation expiree' USING ERRCODE = 'check_violation';
    END IF;
    SELECT "projetId", "acteurId", "statut" INTO v_export FROM "exports_dossier_projet_voirie" WHERE "id" = NEW."exportId";
    IF NOT FOUND OR v_export."projetId" <> NEW."projetId" OR v_export."acteurId" <> NEW."beneficiaireId" OR v_export."statut" <> 'EN_COURS' THEN
      RAISE EXCEPTION 'derogations_export_projet_voirie : la reservation exige une tentative EN_COURS du beneficiaire sur ce projet' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION exports_tableaux_refuse() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '% : suppression interdite (journal et derogations sont des archives)', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END
$fn$;

DROP TRIGGER IF EXISTS exports_dossier_projet_voirie_ajout_seul ON "exports_dossier_projet_voirie";
DROP TRIGGER IF EXISTS exports_dossier_projet_voirie_controle ON "exports_dossier_projet_voirie";
CREATE TRIGGER exports_dossier_projet_voirie_controle BEFORE INSERT OR UPDATE ON "exports_dossier_projet_voirie" FOR EACH ROW EXECUTE FUNCTION exports_dossier_projet_voirie_controle();
DROP TRIGGER IF EXISTS exports_dossier_projet_voirie_suppression ON "exports_dossier_projet_voirie";
CREATE TRIGGER exports_dossier_projet_voirie_suppression BEFORE DELETE ON "exports_dossier_projet_voirie" FOR EACH ROW EXECUTE FUNCTION exports_tableaux_refuse();
DROP TRIGGER IF EXISTS exports_dossier_projet_voirie_troncature ON "exports_dossier_projet_voirie";
CREATE TRIGGER exports_dossier_projet_voirie_troncature BEFORE TRUNCATE ON "exports_dossier_projet_voirie" FOR EACH STATEMENT EXECUTE FUNCTION exports_tableaux_refuse();
DROP TRIGGER IF EXISTS derogations_export_projet_voirie_controle ON "derogations_export_projet_voirie";
CREATE TRIGGER derogations_export_projet_voirie_controle BEFORE INSERT OR UPDATE ON "derogations_export_projet_voirie" FOR EACH ROW EXECUTE FUNCTION derogations_export_projet_voirie_controle();
DROP TRIGGER IF EXISTS derogations_export_projet_voirie_suppression ON "derogations_export_projet_voirie";
CREATE TRIGGER derogations_export_projet_voirie_suppression BEFORE DELETE ON "derogations_export_projet_voirie" FOR EACH ROW EXECUTE FUNCTION exports_tableaux_refuse();
DROP TRIGGER IF EXISTS derogations_export_projet_voirie_troncature ON "derogations_export_projet_voirie";
CREATE TRIGGER derogations_export_projet_voirie_troncature BEFORE TRUNCATE ON "derogations_export_projet_voirie" FOR EACH STATEMENT EXECUTE FUNCTION exports_tableaux_refuse();

COMMENT ON TABLE "exports_dossier_projet_voirie" IS 'Journal des tentatives d''export du dossier technique d''un projet de voirie (EN_COURS puis une seule issue : REMIS, ECHEC, ECHEC_ENVOI ; empreinte, taille, manifeste sans geometrie). Contrat : docs/projets-voirie/CONTRAT-EXPORTS.md';
COMMENT ON TABLE "derogations_export_projet_voirie" IS 'Derogations ADMIN, justifiees, nominatives (beneficiaire autre que l''auteur), reservees par une tentative puis consommees une fois, pour exporter en GeoJSON un jeu CONFIDENTIEL_CONCESSIONNAIRE ou INFRASTRUCTURE_SENSIBLE.';

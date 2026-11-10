-- PROJETS DE VOIRIE ET RESEAUX, LOT D1 : COMPLETUDE DOCUMENTAIRE ET FORMATS D'INGENIERIE
--
-- Contrat : docs/projets-voirie/CONTRAT-DOCUMENTS.md. Decision architecturale 2 (08/11/2026), sections 6 et 7.
--
-- CE QUE CETTE MIGRATION FAIT (ADDITIVE : aucune colonne ni table existante n'est supprimee ; seules trois lignes systeme du referentiel
-- TYPE_DOCUMENT du lot T1 recoivent un parametre de plus)
--
--   1. `FormatJeuProjet` : valeur LANDXML (axes en plan et points lus par le lecteur XML du module, sans GDAL).
--   2. `documents_projet_voirie` : une ligne par VERSION d'un document du dossier (type du referentiel T1, statut controle, piece referencee par
--      reference et empreinte, ou lien vers un jeu du meme projet). AUCUN fichier binaire : ni colonne bytea, ni chemin de fichier.
--   3. `documents_projet_voirie_historique` : historique en AJOUT SEUL, ecrit par le declencheur de la table des documents (le service ne peut pas
--      l'oublier) ; UPDATE, DELETE et TRUNCATE refuses.
--   4. Declencheurs : matrice des transitions (identique a documents/etats.noyau.ts), champs immuables, piece fixee une fois, lignee de versions
--      coherente, jeu du meme projet, code TYPE_DOCUMENT existant et non retire, suppression physique et troncature refusees.
--   5. Contraintes CHECK : piece presente hors ATTENDU, DWG jamais EXPLOITABLE ni VALIDE, separation des taches de la validation (le deposant ne
--      valide pas), justifications ; index uniques partiels (une version en cours, une version VALIDE par lignee).
--   6. Referentiel TYPE_DOCUMENT : parametre `roleJeu` sur PLAN_AXES, RESEAU_CONCESSIONNAIRE et LIMITES_ROUTE (version 2 systeme, sans acteur,
--      ligne d'historique MIGRATION) ; seulement si la ligne n'a jamais ete modifiee par un administrateur.
--
-- Idempotente (IF NOT EXISTS, ADD VALUE IF NOT EXISTS, CREATE OR REPLACE, mise a jour conditionnelle). La valeur LANDXML n'est jamais employee
-- comme litteral type dans cette migration : le script reste applicable dans une seule transaction (PostgreSQL 12+).
-- Exige les migrations 20261030100000 (socle), 20261031100000 (conflits) et 20261103100000 (territoires et referentiels).
-- REVERSIBILITE : descentes/20261104100000_completude_documentaire.sql.

-- ===== 1. Types =====

ALTER TYPE "FormatJeuProjet" ADD VALUE IF NOT EXISTS 'LANDXML';
DO $$ BEGIN
  CREATE TYPE "StatutDocumentProjetVoirie" AS ENUM ('ATTENDU', 'RECU', 'EN_ANALYSE', 'EXPLOITABLE', 'INCOMPLET', 'A_CORRIGER', 'REMPLACE', 'VALIDE', 'REJETE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ===== 2. Documents du projet (une ligne par version) =====

CREATE TABLE IF NOT EXISTS "documents_projet_voirie" (
  "id"                    TEXT PRIMARY KEY,
  "projetId"              TEXT NOT NULL REFERENCES "projets_voirie"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Lignee de versions : identifiant de la version 1 ; version n > 1 remplace la version n-1 de la meme lignee.
  "ligneeId"              TEXT NOT NULL,
  "version"               INTEGER NOT NULL DEFAULT 1,
  "remplaceId"            TEXT REFERENCES "documents_projet_voirie"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Code du domaine TYPE_DOCUMENT du referentiel du lot T1 (verifie par referentiels_voirie_exige a l'insertion).
  "typeCode"              TEXT NOT NULL,
  "titre"                 TEXT NOT NULL,
  "description"           TEXT,
  "dateDocument"          DATE,
  "concessionnaireId"     TEXT REFERENCES "concessionnaires_reseau"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "statut"                "StatutDocumentProjetVoirie" NOT NULL,
  -- La PIECE : reference externe et/ou empreinte d'un fichier televerse (jamais son contenu), ou lien vers un jeu importe du meme projet.
  "reference"             TEXT,
  "nomFichier"            TEXT,
  "format"                TEXT,
  "sha256"                TEXT,
  "tailleOctets"          INTEGER,
  "jeuId"                 TEXT REFERENCES "projets_voirie_jeux"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "creeParId"             TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deposeParId"           TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "deposeLe"              TIMESTAMP(3),
  "valideParId"           TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "valideLe"              TIMESTAMP(3),
  -- Dernier geste (creation, depot, statut, remplacement, retrait) : lu par le declencheur d'historique.
  "derniereActionParId"   TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "derniereActionLe"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "derniereJustification" TEXT,
  "updatedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt"             TIMESTAMP(3),

  CONSTRAINT "dpv_titre" CHECK (length(btrim("titre")) BETWEEN 1 AND 200),
  CONSTRAINT "dpv_description" CHECK ("description" IS NULL OR length("description") <= 2000),
  CONSTRAINT "dpv_type_forme" CHECK ("typeCode" ~ '^[A-Z0-9][A-Z0-9_-]{1,63}$'),
  CONSTRAINT "dpv_version" CHECK ("version" >= 1),
  CONSTRAINT "dpv_lignee" CHECK (("version" = 1 AND "remplaceId" IS NULL AND "ligneeId" = "id") OR ("version" > 1 AND "remplaceId" IS NOT NULL AND "ligneeId" <> "id")),
  CONSTRAINT "dpv_reference" CHECK ("reference" IS NULL OR length(btrim("reference")) BETWEEN 1 AND 300),
  CONSTRAINT "dpv_nom_fichier" CHECK ("nomFichier" IS NULL OR length("nomFichier") BETWEEN 1 AND 255),
  CONSTRAINT "dpv_format" CHECK ("format" IS NULL OR "format" IN ('PDF', 'DWG', 'KML', 'KMZ', 'GEOJSON', 'GPX', 'CSV', 'GPKG', 'SHAPEFILE', 'DXF', 'LANDXML')),
  CONSTRAINT "dpv_sha256" CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "dpv_empreinte_taille" CHECK (("sha256" IS NULL) = ("tailleOctets" IS NULL) AND ("tailleOctets" IS NULL OR "tailleOctets" >= 1)),
  -- Un fichier televerse (empreinte) et un jeu importe ne designent pas la meme piece.
  CONSTRAINT "dpv_piece_exclusive" CHECK ("sha256" IS NULL OR "jeuId" IS NULL),
  -- ATTENDU si et seulement si aucune piece.
  CONSTRAINT "dpv_attendu_sans_piece" CHECK (("statut" = 'ATTENDU') = ("reference" IS NULL AND "sha256" IS NULL AND "jeuId" IS NULL)),
  CONSTRAINT "dpv_depot" CHECK ("statut" = 'ATTENDU' OR ("deposeParId" IS NOT NULL AND "deposeLe" IS NOT NULL)),
  -- Aucun convertisseur DWG : un DWG reste une piece RECUE, jamais exploitable ni validee.
  CONSTRAINT "dpv_dwg_non_exploitable" CHECK ("format" IS DISTINCT FROM 'DWG' OR "statut" NOT IN ('EXPLOITABLE', 'VALIDE')),
  -- Separation des taches : la personne qui a depose la piece ne la valide pas.
  CONSTRAINT "dpv_separation_validation" CHECK ("statut" <> 'VALIDE' OR ("valideParId" IS NOT NULL AND "valideLe" IS NOT NULL AND "deposeParId" IS NOT NULL AND "valideParId" <> "deposeParId")),
  CONSTRAINT "dpv_justification" CHECK (("statut" NOT IN ('INCOMPLET', 'A_CORRIGER', 'VALIDE', 'REJETE') AND "deletedAt" IS NULL)
                                        OR length(btrim(coalesce("derniereJustification", ''))) >= 10),
  CONSTRAINT "dpv_justification_longueur" CHECK ("derniereJustification" IS NULL OR length("derniereJustification") <= 2000)
);
CREATE UNIQUE INDEX IF NOT EXISTS "documents_projet_voirie_lignee_version_key" ON "documents_projet_voirie" ("ligneeId", "version");
-- Une seule version EN COURS et une seule version VALIDE par lignee (lignes non retirees).
CREATE UNIQUE INDEX IF NOT EXISTS "documents_projet_voirie_en_cours_key" ON "documents_projet_voirie" ("ligneeId")
  WHERE "deletedAt" IS NULL AND "statut" IN ('ATTENDU', 'RECU', 'EN_ANALYSE', 'INCOMPLET', 'A_CORRIGER', 'EXPLOITABLE');
CREATE UNIQUE INDEX IF NOT EXISTS "documents_projet_voirie_valide_key" ON "documents_projet_voirie" ("ligneeId")
  WHERE "deletedAt" IS NULL AND "statut" = 'VALIDE';
CREATE INDEX IF NOT EXISTS "documents_projet_voirie_projetId_statut_idx" ON "documents_projet_voirie" ("projetId", "statut");
CREATE INDEX IF NOT EXISTS "documents_projet_voirie_projetId_typeCode_idx" ON "documents_projet_voirie" ("projetId", "typeCode");
CREATE INDEX IF NOT EXISTS "documents_projet_voirie_jeuId_idx" ON "documents_projet_voirie" ("jeuId");
CREATE INDEX IF NOT EXISTS "documents_projet_voirie_remplaceId_idx" ON "documents_projet_voirie" ("remplaceId");

CREATE TABLE IF NOT EXISTS "documents_projet_voirie_historique" (
  "id"            BIGSERIAL PRIMARY KEY,
  "documentId"    TEXT NOT NULL REFERENCES "documents_projet_voirie"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "projetId"      TEXT NOT NULL,
  "ligneeId"      TEXT NOT NULL,
  "version"       INTEGER NOT NULL,
  "action"        TEXT NOT NULL,
  "statutAvant"   "StatutDocumentProjetVoirie",
  "statutApres"   "StatutDocumentProjetVoirie" NOT NULL,
  "acteurId"      TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "justification" TEXT,
  -- Format, empreinte, taille, nom du fichier, reference, jeu lie : jamais de contenu de fichier ni de geometrie.
  "details"       JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dpvh_action" CHECK ("action" IN ('CREATION', 'DEPOT', 'STATUT', 'REMPLACEMENT', 'RETRAIT')),
  CONSTRAINT "dpvh_details" CHECK (jsonb_typeof("details") = 'object')
);
CREATE INDEX IF NOT EXISTS "documents_projet_voirie_historique_documentId_idx" ON "documents_projet_voirie_historique" ("documentId", "id");
CREATE INDEX IF NOT EXISTS "documents_projet_voirie_historique_projetId_idx" ON "documents_projet_voirie_historique" ("projetId", "id");

-- ===== 3. Declencheurs =====

-- Matrice des transitions demandees par une personne (route `statut`) ou posees par le serveur (depot, remplacement). Meme matrice que le noyau
-- `backend/src/projets-voirie/documents/etats.noyau.ts` (un test unitaire compare les deux textes).
CREATE OR REPLACE FUNCTION documents_projet_voirie_transition_admise(p_de text, p_vers text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT (p_de, p_vers) IN (
    ('ATTENDU', 'RECU'),
    ('RECU', 'EN_ANALYSE'), ('RECU', 'REJETE'), ('RECU', 'REMPLACE'),
    ('EN_ANALYSE', 'EXPLOITABLE'), ('EN_ANALYSE', 'INCOMPLET'), ('EN_ANALYSE', 'A_CORRIGER'), ('EN_ANALYSE', 'REJETE'), ('EN_ANALYSE', 'REMPLACE'),
    ('INCOMPLET', 'EN_ANALYSE'), ('INCOMPLET', 'REJETE'), ('INCOMPLET', 'REMPLACE'),
    ('A_CORRIGER', 'EN_ANALYSE'), ('A_CORRIGER', 'REJETE'), ('A_CORRIGER', 'REMPLACE'),
    ('EXPLOITABLE', 'VALIDE'), ('EXPLOITABLE', 'A_CORRIGER'), ('EXPLOITABLE', 'REJETE'), ('EXPLOITABLE', 'REMPLACE'),
    ('VALIDE', 'REMPLACE')
  )
$fn$;

CREATE OR REPLACE FUNCTION documents_projet_voirie_controle() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  precedente "documents_projet_voirie"%ROWTYPE;
  v_projet_jeu text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."statut" NOT IN ('ATTENDU', 'RECU') THEN
      RAISE EXCEPTION 'documents_projet_voirie : un document nait ATTENDU ou RECU (recu : %)', NEW."statut" USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."deletedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'documents_projet_voirie : un document ne nait pas retire' USING ERRCODE = 'check_violation';
    END IF;
    PERFORM referentiels_voirie_exige('TYPE_DOCUMENT', NEW."typeCode");
    IF NEW."version" > 1 THEN
      -- La version n remplace la DERNIERE version NON RETIREE de la meme lignee, du meme projet et du meme type, et porte le numero qui suit le plus
      -- grand de la lignee (versions retirees comprises) : un retrait ne fige pas la lignee (revue D1, M1).
      SELECT * INTO precedente FROM "documents_projet_voirie" WHERE "id" = NEW."remplaceId";
      IF NOT FOUND OR precedente."ligneeId" <> NEW."ligneeId" OR precedente."projetId" <> NEW."projetId" OR precedente."typeCode" <> NEW."typeCode"
         OR precedente."deletedAt" IS NOT NULL OR precedente."version" >= NEW."version"
         OR NEW."version" <> (SELECT max("version") FROM "documents_projet_voirie" WHERE "ligneeId" = NEW."ligneeId") + 1
         OR EXISTS (SELECT 1 FROM "documents_projet_voirie" WHERE "ligneeId" = NEW."ligneeId" AND "deletedAt" IS NULL AND "version" > precedente."version") THEN
        RAISE EXCEPTION 'documents_projet_voirie : la version % doit remplacer la derniere version non retiree de la meme lignee, du meme projet et du meme type, et suivre le plus grand numero de la lignee', NEW."version"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    IF OLD."deletedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'documents_projet_voirie : un document retire est fige' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."projetId" <> OLD."projetId" OR NEW."ligneeId" <> OLD."ligneeId" OR NEW."version" <> OLD."version"
       OR NEW."remplaceId" IS DISTINCT FROM OLD."remplaceId" OR NEW."typeCode" <> OLD."typeCode" OR NEW."titre" <> OLD."titre"
       OR NEW."description" IS DISTINCT FROM OLD."description" OR NEW."dateDocument" IS DISTINCT FROM OLD."dateDocument"
       OR NEW."concessionnaireId" IS DISTINCT FROM OLD."concessionnaireId" OR NEW."creeParId" <> OLD."creeParId" OR NEW."createdAt" <> OLD."createdAt" THEN
      RAISE EXCEPTION 'documents_projet_voirie : identite, lignee, type, titre, description, date, concessionnaire et createur sont immuables'
        USING ERRCODE = 'restrict_violation';
    END IF;
    -- La piece se fixe une seule fois : a la creation, ou au depot sur un document ATTENDU.
    IF NOT (OLD."statut" = 'ATTENDU' AND NEW."statut" = 'RECU') AND (
         NEW."reference" IS DISTINCT FROM OLD."reference" OR NEW."nomFichier" IS DISTINCT FROM OLD."nomFichier" OR NEW."format" IS DISTINCT FROM OLD."format"
         OR NEW."sha256" IS DISTINCT FROM OLD."sha256" OR NEW."tailleOctets" IS DISTINCT FROM OLD."tailleOctets" OR NEW."jeuId" IS DISTINCT FROM OLD."jeuId"
         OR NEW."deposeParId" IS DISTINCT FROM OLD."deposeParId" OR NEW."deposeLe" IS DISTINCT FROM OLD."deposeLe") THEN
      RAISE EXCEPTION 'documents_projet_voirie : la piece d''une version est figee apres son depot (deposez une nouvelle version)' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."deletedAt" IS NOT NULL THEN
      IF NEW."statut" <> OLD."statut" THEN
        RAISE EXCEPTION 'documents_projet_voirie : un retrait ne change pas le statut' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."statut" = OLD."statut" THEN
      RAISE EXCEPTION 'documents_projet_voirie : seuls le statut (transition admise) et le retrait changent un document' USING ERRCODE = 'restrict_violation';
    ELSE
      IF NOT documents_projet_voirie_transition_admise(OLD."statut"::text, NEW."statut"::text) THEN
        RAISE EXCEPTION 'documents_projet_voirie : transition % -> % interdite', OLD."statut", NEW."statut" USING ERRCODE = 'check_violation';
      END IF;
      -- REMPLACE : l'existence d'une version plus recente est verifiee a la fin de la transaction (declencheur differe ci-dessous), parce que
      -- la version precedente en cours doit quitter l'index « une version en cours » AVANT l'insertion de la suivante.
      IF NEW."valideParId" IS DISTINCT FROM OLD."valideParId" AND NEW."statut" <> 'VALIDE' THEN
        RAISE EXCEPTION 'documents_projet_voirie : le valideur ne se pose qu''avec le statut VALIDE' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    NEW."updatedAt" := CURRENT_TIMESTAMP;
  END IF;
  IF NEW."jeuId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."jeuId" IS DISTINCT FROM OLD."jeuId") THEN
    SELECT "projetId" INTO v_projet_jeu FROM "projets_voirie_jeux" WHERE "id" = NEW."jeuId";
    IF v_projet_jeu IS DISTINCT FROM NEW."projetId" THEN
      RAISE EXCEPTION 'documents_projet_voirie : le jeu lie doit appartenir au projet du document' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

-- Historique ecrit PAR LA BASE apres chaque insertion et chaque changement (acteur et justification : dernier geste porte par la ligne).
CREATE OR REPLACE FUNCTION documents_projet_voirie_historiser() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_action text; v_avant "StatutDocumentProjetVoirie";
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'CREATION'; v_avant := NULL;
  ELSIF NEW."deletedAt" IS NOT NULL AND OLD."deletedAt" IS NULL THEN
    v_action := 'RETRAIT'; v_avant := OLD."statut";
  ELSIF OLD."statut" = 'ATTENDU' AND NEW."statut" = 'RECU' THEN
    v_action := 'DEPOT'; v_avant := OLD."statut";
  ELSIF NEW."statut" = 'REMPLACE' THEN
    v_action := 'REMPLACEMENT'; v_avant := OLD."statut";
  ELSE
    v_action := 'STATUT'; v_avant := OLD."statut";
  END IF;
  INSERT INTO "documents_projet_voirie_historique" ("documentId", "projetId", "ligneeId", "version", "action", "statutAvant", "statutApres", "acteurId", "justification", "details")
  VALUES (NEW."id", NEW."projetId", NEW."ligneeId", NEW."version", v_action, v_avant, NEW."statut", NEW."derniereActionParId", NEW."derniereJustification",
          jsonb_strip_nulls(jsonb_build_object('format', NEW."format", 'sha256', NEW."sha256", 'tailleOctets', NEW."tailleOctets", 'nomFichier', NEW."nomFichier",
                                               'reference', NEW."reference", 'jeuId', NEW."jeuId", 'remplaceId', NEW."remplaceId")));
  RETURN NULL;
END
$fn$;

-- Verifie A LA FIN DE LA TRANSACTION qu'une version REMPLACE a bien une version plus recente dans sa lignee.
CREATE OR REPLACE FUNCTION documents_projet_voirie_remplacement_verifie() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "documents_projet_voirie" WHERE "ligneeId" = NEW."ligneeId" AND "version" > NEW."version") THEN
    RAISE EXCEPTION 'documents_projet_voirie : REMPLACE exige une version plus recente de la meme lignee' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION documents_projet_voirie_refuse() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_TABLE_NAME = 'documents_projet_voirie_historique' AND TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '% : ajout seul (un historique ne se modifie pas)', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  RAISE EXCEPTION '% : suppression physique interdite (suppression logique par deletedAt ; un historique ne se supprime pas)', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END
$fn$;

DROP TRIGGER IF EXISTS documents_projet_voirie_controle ON "documents_projet_voirie";
CREATE TRIGGER documents_projet_voirie_controle BEFORE INSERT OR UPDATE ON "documents_projet_voirie" FOR EACH ROW EXECUTE FUNCTION documents_projet_voirie_controle();
DROP TRIGGER IF EXISTS documents_projet_voirie_historiser ON "documents_projet_voirie";
CREATE TRIGGER documents_projet_voirie_historiser AFTER INSERT OR UPDATE ON "documents_projet_voirie" FOR EACH ROW EXECUTE FUNCTION documents_projet_voirie_historiser();
DROP TRIGGER IF EXISTS documents_projet_voirie_remplacement_verifie ON "documents_projet_voirie";
CREATE CONSTRAINT TRIGGER documents_projet_voirie_remplacement_verifie AFTER UPDATE ON "documents_projet_voirie" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."statut" = 'REMPLACE' AND OLD."statut" <> 'REMPLACE') EXECUTE FUNCTION documents_projet_voirie_remplacement_verifie();
DROP TRIGGER IF EXISTS documents_projet_voirie_suppression ON "documents_projet_voirie";
CREATE TRIGGER documents_projet_voirie_suppression BEFORE DELETE ON "documents_projet_voirie" FOR EACH ROW EXECUTE FUNCTION documents_projet_voirie_refuse();
DROP TRIGGER IF EXISTS documents_projet_voirie_troncature ON "documents_projet_voirie";
CREATE TRIGGER documents_projet_voirie_troncature BEFORE TRUNCATE ON "documents_projet_voirie" FOR EACH STATEMENT EXECUTE FUNCTION documents_projet_voirie_refuse();
DROP TRIGGER IF EXISTS documents_projet_voirie_historique_ajout_seul ON "documents_projet_voirie_historique";
CREATE TRIGGER documents_projet_voirie_historique_ajout_seul BEFORE UPDATE OR DELETE ON "documents_projet_voirie_historique" FOR EACH ROW EXECUTE FUNCTION documents_projet_voirie_refuse();
DROP TRIGGER IF EXISTS documents_projet_voirie_historique_troncature ON "documents_projet_voirie_historique";
CREATE TRIGGER documents_projet_voirie_historique_troncature BEFORE TRUNCATE ON "documents_projet_voirie_historique" FOR EACH STATEMENT EXECUTE FUNCTION documents_projet_voirie_refuse();

-- ===== 4. Referentiel TYPE_DOCUMENT : role de jeu qui fournit la piece (lot T1, valeurs systeme jamais modifiees seulement) =====

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT v."id", v."code", v."parametres", x.role
      FROM "referentiels_voirie" v
      JOIN (VALUES ('PLAN_AXES', 'AXES_TRAVAUX'), ('RESEAU_CONCESSIONNAIRE', 'RESEAU_TIERS'), ('LIMITES_ROUTE', 'LIMITES_ROUTE')) AS x(code, role) ON x.code = v."code"
     WHERE v."domaine" = 'TYPE_DOCUMENT' AND v."creeParId" IS NULL AND v."approuveParId" IS NULL AND v."version" = 1 AND v."deletedAt" IS NULL
       AND NOT (v."parametres" ? 'roleJeu')
  LOOP
    UPDATE "referentiels_voirie" SET "parametres" = r."parametres" || jsonb_build_object('roleJeu', r.role), "version" = 2 WHERE "id" = r."id";
    INSERT INTO "referentiels_voirie_historique" ("referentielId", "action", "version", "avant", "apres")
      SELECT v."id", 'MIGRATION', 2, jsonb_build_object('code', v."code", 'parametres', r."parametres", 'version', 1),
             jsonb_build_object('code', v."code", 'parametres', v."parametres", 'version', 2, 'source', 'migration 20261104100000 : roleJeu')
        FROM "referentiels_voirie" v WHERE v."id" = r."id";
  END LOOP;
END $$;

COMMENT ON TABLE "documents_projet_voirie" IS 'Documents du dossier d''un projet de voirie, une ligne par version : type (referentiel TYPE_DOCUMENT), statut controle, piece referencee (reference, empreinte) ou jeu lie ; aucun fichier binaire. Contrat : docs/projets-voirie/CONTRAT-DOCUMENTS.md';
COMMENT ON TABLE "documents_projet_voirie_historique" IS 'Historique en ajout seul des documents d''un projet de voirie, ecrit par le declencheur documents_projet_voirie_historiser.';

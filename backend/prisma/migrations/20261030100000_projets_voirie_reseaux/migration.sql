-- PROJETS DE VOIRIE ET RESEAUX : PROJETS, CONCESSIONNAIRES, JEUX DE DONNEES VERSIONNES (QUARANTAINE), OBJETS GEOGRAPHIQUES
--
-- Contrat : docs/projets-voirie/CONTRAT.md, version 2 (sections 2 et 3).
--
-- CE QUE CETTE MIGRATION FAIT
--
--   1. `projets_voirie` : un projet de voirie urbaine (code unique, commune, region facultative, largeurs
--      d'emprise et de chaussee THEORIQUES tant qu'elles ne sont pas validees).
--   2. `concessionnaires_reseau` : les exploitants de reseaux tiers (telecom, eau, electricite...).
--   3. `projets_voirie_jeux` : un fichier charge (plan d'axes, reseau d'un concessionnaire, limites de route), VERSIONNE
--      et mis en QUARANTAINE : un depot cree un jeu CONTROLE, qui n'entre dans l'analyse qu'une fois AUTORISE par une
--      personne identifiee, avec justification. Un remplacement cree une version ; l'ancienne reste AUTORISE jusqu'a
--      l'autorisation de la nouvelle, puis passe REMPLACE. Confidentialite a cinq niveaux ; qualite (classe de precision,
--      precisions, methode, date de constat) NULLE tant que le fournisseur ne l'a pas dite ; nature des objets.
--   4. `projets_voirie_objets` : les objets geographiques du jeu (point, ligne, polygone), index GiST, empreinte de
--      geometrie normalisee (delta de versions).
--
-- ETATS INCOHERENTS REFUSES PAR LA BASE (et non par le seul service)
--
--   - un jeu RESEAU_TIERS sans concessionnaire ni type de reseau, ou un autre role avec l'un des deux ;
--   - une nature d'objets incompatible avec le role (AXES_TRAVAUX => AXE, LIMITES_ROUTE => EMPRISE, reseau jamais AXE/EMPRISE) ;
--   - un jeu qui en remplace un autre avec une version égale à 1 (un jeu peut avoir une version > 1 sans remplacement,
--     par exemple apres un rejet) ;
--   - un jeu AUTORISE ou REJETE sans auteur, sans date ni justification d'au moins 10 caracteres ;
--   - un jeu RETIRE sans date de retrait, ou une date de retrait sans statut RETIRE ;
--   - un objet vide, invalide, hors de l'emprise de la Guinee, ou dont le type declare ne correspond pas a sa geometrie ;
--   - deux jeux vivants (RECU, CONTROLE, AUTORISE) du meme fichier (SHA-256) dans un projet ; deux jeux AUTORISE, ou deux
--     depots en attente, de meme role et de meme concessionnaire (hors role AUTRE) ;
--   - une largeur de chaussee superieure a la largeur d'emprise.
--
-- SUPPRESSION LOGIQUE UNIQUEMENT (AGENTS.md, regle 2) : un declencheur refuse tout DELETE physique sur les quatre tables, et
-- tout UPDATE d'un objet (un objet ne change pas : le remplacement est une nouvelle version du jeu). TRUNCATE n'est pas
-- intercepte (outillage de banc d'essai).
--
-- NATURE : additive. Quatre tables, neuf types enumeres, des index, des declencheurs. Aucune ligne existante touchee.
-- Idempotente (IF NOT EXISTS, types crees seulement s'ils sont absents).

-- ===== 1. Types =====

DO $$ BEGIN CREATE TYPE "TypeReseauTiers" AS ENUM ('TELECOM', 'EAU_POTABLE', 'ELECTRICITE', 'ASSAINISSEMENT', 'GAZ_HYDROCARBURES', 'AUTRE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "RoleJeuProjet" AS ENUM ('AXES_TRAVAUX', 'RESEAU_TIERS', 'LIMITES_ROUTE', 'AUTRE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "StatutParametresProjet" AS ENUM ('THEORIQUE', 'VALIDE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "FormatJeuProjet" AS ENUM ('KML', 'GEOJSON'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "NiveauConfidentialite" AS ENUM ('PUBLIC', 'INTERNE', 'RESTREINT_PROJET', 'CONFIDENTIEL_CONCESSIONNAIRE', 'INFRASTRUCTURE_SENSIBLE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "StatutJeuProjet" AS ENUM ('RECU', 'CONTROLE', 'AUTORISE', 'REJETE', 'REMPLACE', 'RETIRE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "ClassePrecision" AS ENUM ('A', 'B', 'C', 'D', 'E'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "NatureObjetReseau" AS ENUM ('ACTIF_PHYSIQUE', 'CIRCUIT_LOGIQUE', 'EQUIPEMENT', 'AXE', 'EMPRISE', 'INCONNUE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "TypeGeomObjet" AS ENUM ('LIGNE', 'POINT', 'POLYGONE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ===== 2. Projets =====

CREATE TABLE IF NOT EXISTS "projets_voirie" (
  "id"               TEXT PRIMARY KEY,
  -- Code stable et lisible (ex. KISSI-VOIRIE-2026), toujours en majuscules ; unique, y compris retire (archive).
  "code"             TEXT NOT NULL,
  "nom"              TEXT NOT NULL,
  "commune"          TEXT,
  "prefecture"       TEXT,
  -- Region de rattachement (perimetre territorial des comptes regionaux). Nulle : visible des seuls comptes nationaux.
  "regionId"         INTEGER REFERENCES "regions"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "description"      TEXT,
  -- Largeurs appliquees de part et d'autre de chaque axe (demi-largeurs). THEORIQUES tant que statutParametres vaut THEORIQUE.
  "largeurEmpriseM"  DECIMAL(6,2) NOT NULL DEFAULT 15,
  "largeurChausseeM" DECIMAL(6,2) NOT NULL DEFAULT 7,
  "statutParametres" "StatutParametresProjet" NOT NULL DEFAULT 'THEORIQUE',
  "creeParId"        TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt"        TIMESTAMP(3),

  CONSTRAINT "pv_code_format" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{1,63}$'),
  CONSTRAINT "pv_nom_non_vide" CHECK (length(btrim("nom")) BETWEEN 1 AND 200),
  CONSTRAINT "pv_largeurs" CHECK ("largeurChausseeM" > 0 AND "largeurEmpriseM" >= "largeurChausseeM" AND "largeurEmpriseM" <= 200)
);
CREATE UNIQUE INDEX IF NOT EXISTS "projets_voirie_code_key" ON "projets_voirie" ("code");
CREATE INDEX IF NOT EXISTS "projets_voirie_regionId_idx" ON "projets_voirie" ("regionId");
CREATE INDEX IF NOT EXISTS "projets_voirie_deletedAt_idx" ON "projets_voirie" ("deletedAt");

-- ===== 3. Concessionnaires =====

CREATE TABLE IF NOT EXISTS "concessionnaires_reseau" (
  "id"          TEXT PRIMARY KEY,
  "nom"         TEXT NOT NULL,
  "typeReseau"  "TypeReseauTiers" NOT NULL,
  "contact"     TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt"   TIMESTAMP(3),

  CONSTRAINT "cr_nom_non_vide" CHECK (length(btrim("nom")) BETWEEN 1 AND 200)
);
-- Nom unique sans distinction de casse (index d'expression : non representable dans schema.prisma, voir DERIVE-SCHEMA.md).
CREATE UNIQUE INDEX IF NOT EXISTS "concessionnaires_reseau_nom_lower_key" ON "concessionnaires_reseau" (lower("nom"));

-- ===== 4. Jeux de donnees (versionnes, en quarantaine) =====

CREATE TABLE IF NOT EXISTS "projets_voirie_jeux" (
  "id"                  TEXT PRIMARY KEY,
  "projetId"            TEXT NOT NULL REFERENCES "projets_voirie"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "role"                "RoleJeuProjet" NOT NULL,
  -- Obligatoire si et seulement si role = RESEAU_TIERS.
  "concessionnaireId"   TEXT REFERENCES "concessionnaires_reseau"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Renseigne si et seulement si role = RESEAU_TIERS (par defaut celui du concessionnaire).
  "typeReseau"          "TypeReseauTiers",
  "nomFichier"          TEXT NOT NULL,
  "format"              "FormatJeuProjet" NOT NULL,
  "sha256"              TEXT NOT NULL,
  "tailleOctets"        INTEGER NOT NULL,
  -- « Circuits ou objets du fichier » : jamais un nombre de cables physiques.
  "nbObjets"            INTEGER NOT NULL,
  -- Somme des longueurs des objets lineaires (geographie, metres).
  "longueurTotaleM"     DOUBLE PRECISION NOT NULL DEFAULT 0,
  -- Longueur de l'union des trace (un meme trace repete compte une fois), memes unites. PAS un nombre de cables.
  "longueurTraceFusionneM" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "dateDonnees"         DATE,
  -- Texte libre, FACULTATIF, ne bloque jamais un depot (ex. « recu d'Orange le 24/10/2026 par ... »). Decision DSI du 28/10/2026 :
  -- les fichiers viennent directement de l'operateur, l'autorisation d'exploitation est consideree acquise, sans ecrit.
  "origineFichier"      TEXT,
  -- Qualite : NULLE tant que le fournisseur ne l'a pas declaree (aucune precision n'est inventee).
  "classePrecision"     "ClassePrecision",
  "precisionHorizontaleM" DECIMAL(8,2),
  "precisionVerticaleM" DECIMAL(8,2),
  "methode"             TEXT,
  "dateConstat"         DATE,
  "natureObjets"        "NatureObjetReseau" NOT NULL DEFAULT 'INCONNUE',
  "confidentialite"     "NiveauConfidentialite" NOT NULL DEFAULT 'CONFIDENTIEL_CONCESSIONNAIRE',
  "statut"              "StatutJeuProjet" NOT NULL DEFAULT 'CONTROLE',
  "version"             INTEGER NOT NULL DEFAULT 1,
  -- Le jeu AUTORISE que ce depot remplacera lorsqu'il sera lui-meme autorise.
  "remplaceId"          TEXT REFERENCES "projets_voirie_jeux"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Avertissements de lecture : [{ code, message, nb? }].
  "avertissements"      JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Resume de l'import : nbObjets, parTypeGeom, longueurs, bbox, attributsDetectes, crs, delta.
  "resume"              JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Decision d'autorisation ou de rejet : qui, quand, pourquoi.
  "decideParId"         TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "decideLe"            TIMESTAMP(3),
  "justificationDecision" TEXT,
  "creeParId"           TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt"           TIMESTAMP(3),

  CONSTRAINT "pvj_concessionnaire_coherent" CHECK (("role" = 'RESEAU_TIERS') = ("concessionnaireId" IS NOT NULL)),
  CONSTRAINT "pvj_type_reseau_coherent" CHECK (("role" = 'RESEAU_TIERS') = ("typeReseau" IS NOT NULL)),
  CONSTRAINT "pvj_nature_coherente" CHECK (
    ("role" = 'AXES_TRAVAUX' AND "natureObjets" = 'AXE')
    OR ("role" = 'LIMITES_ROUTE' AND "natureObjets" = 'EMPRISE')
    OR ("role" IN ('RESEAU_TIERS', 'AUTRE') AND "natureObjets" NOT IN ('AXE', 'EMPRISE'))),
  CONSTRAINT "pvj_version_coherente" CHECK ("version" >= 1 AND ("remplaceId" IS NULL OR "version" > 1)),
  CONSTRAINT "pvj_retrait_coherent" CHECK (("statut" = 'RETIRE') = ("deletedAt" IS NOT NULL)),
  CONSTRAINT "pvj_decision_coherente" CHECK (
    "statut" NOT IN ('AUTORISE', 'REJETE')
    OR ("decideParId" IS NOT NULL AND "decideLe" IS NOT NULL AND length(btrim(coalesce("justificationDecision", ''))) >= 10)),
  CONSTRAINT "pvj_mesures" CHECK ("nbObjets" BETWEEN 0 AND 50000 AND "tailleOctets" >= 0 AND "longueurTotaleM" >= 0 AND "longueurTraceFusionneM" >= 0),
  CONSTRAINT "pvj_precisions" CHECK (("precisionHorizontaleM" IS NULL OR "precisionHorizontaleM" > 0) AND ("precisionVerticaleM" IS NULL OR "precisionVerticaleM" > 0)),
  CONSTRAINT "pvj_methode" CHECK ("methode" IS NULL OR length("methode") <= 200),
  CONSTRAINT "pvj_sha256" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pvj_nom_fichier" CHECK (length(btrim("nomFichier")) > 0),
  CONSTRAINT "pvj_json_formes" CHECK (jsonb_typeof("avertissements") = 'array' AND jsonb_typeof("resume") = 'object')
);
CREATE INDEX IF NOT EXISTS "projets_voirie_jeux_projetId_statut_idx" ON "projets_voirie_jeux" ("projetId", "statut");
CREATE INDEX IF NOT EXISTS "projets_voirie_jeux_concessionnaireId_idx" ON "projets_voirie_jeux" ("concessionnaireId");
CREATE INDEX IF NOT EXISTS "projets_voirie_jeux_remplaceId_idx" ON "projets_voirie_jeux" ("remplaceId");
-- Idempotence : un meme fichier ne peut etre vivant (RECU, CONTROLE, AUTORISE) qu'une fois par projet (409 JEU_DEJA_CHARGE).
-- Un fichier REMPLACE, REJETE ou RETIRE peut etre recharge : retour a une version anterieure, qui devient une nouvelle version.
CREATE UNIQUE INDEX IF NOT EXISTS "projets_voirie_jeux_projet_sha256_vivant_key" ON "projets_voirie_jeux" ("projetId", "sha256") WHERE "statut" IN ('RECU', 'CONTROLE', 'AUTORISE');
-- Un seul jeu AUTORISE, et un seul depot en attente, par (projet, role, concessionnaire), sauf le role AUTRE (plusieurs fichiers libres).
CREATE UNIQUE INDEX IF NOT EXISTS "projets_voirie_jeux_cle_autorise_key" ON "projets_voirie_jeux" ("projetId", "role", COALESCE("concessionnaireId", '')) WHERE "statut" = 'AUTORISE' AND "role" <> 'AUTRE';
CREATE UNIQUE INDEX IF NOT EXISTS "projets_voirie_jeux_cle_attente_key" ON "projets_voirie_jeux" ("projetId", "role", COALESCE("concessionnaireId", '')) WHERE "statut" IN ('RECU', 'CONTROLE') AND "role" <> 'AUTRE';

-- ===== 5. Objets =====

CREATE TABLE IF NOT EXISTS "projets_voirie_objets" (
  "id"        BIGSERIAL PRIMARY KEY,
  "jeuId"     TEXT NOT NULL REFERENCES "projets_voirie_jeux"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "nom"       TEXT,
  "typeGeom"  "TypeGeomObjet" NOT NULL,
  "geom"      geometry(Geometry, 4326) NOT NULL,
  -- ST_Length(geom::geography), pour les lignes seulement.
  "longueurM" DOUBLE PRECISION,
  -- Tous les champs d'origine, tels quels (jamais interpretes comme du HTML).
  "attributs" JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- SHA-1 de la geometrie normalisee (arrondie, sens de lecture d'une ligne indifferent) et du nom : delta de versions.
  "empreinte" TEXT NOT NULL,
  "ordre"     INTEGER NOT NULL,

  CONSTRAINT "pvo_geom_valide" CHECK (NOT ST_IsEmpty("geom") AND ST_IsValid("geom")),
  CONSTRAINT "pvo_type_coherent" CHECK (
    ("typeGeom" = 'LIGNE' AND GeometryType("geom") IN ('LINESTRING', 'MULTILINESTRING'))
    OR ("typeGeom" = 'POINT' AND GeometryType("geom") IN ('POINT', 'MULTIPOINT'))
    OR ("typeGeom" = 'POLYGONE' AND GeometryType("geom") IN ('POLYGON', 'MULTIPOLYGON'))),
  -- Emprise de la Guinee (longitude -15,2 a -7,5 ; latitude 7,1 a 12,8) : test sur la boite englobante.
  CONSTRAINT "pvo_en_guinee" CHECK (ST_XMin("geom") >= -15.2 AND ST_XMax("geom") <= -7.5 AND ST_YMin("geom") >= 7.1 AND ST_YMax("geom") <= 12.8),
  CONSTRAINT "pvo_longueur" CHECK (("typeGeom" = 'LIGNE' AND "longueurM" IS NOT NULL AND "longueurM" >= 0) OR ("typeGeom" <> 'LIGNE' AND "longueurM" IS NULL)),
  CONSTRAINT "pvo_attributs_objet" CHECK (jsonb_typeof("attributs") = 'object'),
  CONSTRAINT "pvo_empreinte" CHECK ("empreinte" ~ '^[0-9a-f]{40}$')
);
CREATE INDEX IF NOT EXISTS "projets_voirie_objets_geom_gist" ON "projets_voirie_objets" USING GIST ("geom");
CREATE INDEX IF NOT EXISTS "projets_voirie_objets_jeuId_ordre_idx" ON "projets_voirie_objets" ("jeuId", "ordre");

-- ===== 6. Declencheurs : suppression logique uniquement, objets immuables =====

CREATE OR REPLACE FUNCTION projets_voirie_refuse_suppression() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '% : suppression physique interdite (suppression logique uniquement, AGENTS.md regle 2)', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$fn$;

CREATE OR REPLACE FUNCTION projets_voirie_objets_immuables() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'projets_voirie_objets : un objet ne se modifie pas (le remplacement est une nouvelle version du jeu)'
    USING ERRCODE = 'restrict_violation';
END
$fn$;

DROP TRIGGER IF EXISTS projets_voirie_suppression ON "projets_voirie";
CREATE TRIGGER projets_voirie_suppression BEFORE DELETE ON "projets_voirie" FOR EACH ROW EXECUTE FUNCTION projets_voirie_refuse_suppression();
DROP TRIGGER IF EXISTS concessionnaires_reseau_suppression ON "concessionnaires_reseau";
CREATE TRIGGER concessionnaires_reseau_suppression BEFORE DELETE ON "concessionnaires_reseau" FOR EACH ROW EXECUTE FUNCTION projets_voirie_refuse_suppression();
DROP TRIGGER IF EXISTS projets_voirie_jeux_suppression ON "projets_voirie_jeux";
CREATE TRIGGER projets_voirie_jeux_suppression BEFORE DELETE ON "projets_voirie_jeux" FOR EACH ROW EXECUTE FUNCTION projets_voirie_refuse_suppression();
DROP TRIGGER IF EXISTS projets_voirie_objets_suppression ON "projets_voirie_objets";
CREATE TRIGGER projets_voirie_objets_suppression BEFORE DELETE ON "projets_voirie_objets" FOR EACH ROW EXECUTE FUNCTION projets_voirie_refuse_suppression();
DROP TRIGGER IF EXISTS projets_voirie_objets_modification ON "projets_voirie_objets";
CREATE TRIGGER projets_voirie_objets_modification BEFORE UPDATE ON "projets_voirie_objets" FOR EACH ROW EXECUTE FUNCTION projets_voirie_objets_immuables();

COMMENT ON TABLE "projets_voirie" IS 'Projets de voirie et reseaux. Suppression logique (deletedAt). Contrat : docs/projets-voirie/CONTRAT.md';
COMMENT ON TABLE "projets_voirie_jeux" IS 'Fichiers charges, versionnes, en quarantaine (CONTROLE) jusqu''a autorisation. Confidentialite a cinq niveaux : jamais dans l''API publique.';
COMMENT ON TABLE "projets_voirie_objets" IS 'Objets geographiques des jeux. Immuables : un remplacement cree une nouvelle version du jeu.';

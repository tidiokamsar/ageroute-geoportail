-- RESEAUX PHYSIQUES ET CIRCUITS LOGIQUES DES PROJETS DE VOIRIE (lot B1) : DESCRIPTEURS D'OBJETS (NATURE, QUALITE, VERTICAL) ET RELATIONS
--
-- Contrat : docs/projets-voirie/CONTRAT-RESEAUX.md. Cahier des charges v2, sections 5.2, 5.3, 20.1, 20.2 et 22.3 (KIS-LOGIC-01).
--
-- LE PROBLEME. Le nombre de lignes d'un fichier n'est pas un nombre d'equipements physiques : plusieurs circuits logiques peuvent suivre le
-- meme support physique. Le socle ne connait la nature (actif physique, circuit logique, equipement) qu'AU NIVEAU DU JEU, sans relation entre
-- objets, sans qualite ni profondeur par objet.
--
-- CE QUE CETTE MIGRATION FAIT (ADDITIVE : deux tables nouvelles, aucune table existante n'est modifiee)
--
--   1. `reseau_objets_descripteurs` : au plus UN descripteur par objet de `projets_voirie_objets` (qui reste immuable). Il PRECISE l'objet ;
--      ce qu'il ne dit pas est herite du jeu (nature, classe de precision, precisions), jamais invente :
--        - nature (actif physique, circuit logique, equipement) et type d'objet ;
--        - qualite : classe de precision A a E DECLAREE par la source (nulle = inconnue), precisions horizontale et verticale, methode de
--          collecte, date de constat, niveau de confiance, statut de qualite ;
--        - profondeur, altitude et reference verticale SEULEMENT si elles sont fournies (nullables, jamais deduites).
--      La source de l'objet (jeu, version) et sa confidentialite sont celles de son jeu : aucune colonne ne les duplique.
--   2. `reseau_relations` : relation entre deux objets du MEME projet : un circuit logique PORTE PAR une infrastructure physique (PORTE_PAR),
--      un equipement CONTENU DANS une infrastructure (CONTENU_DANS). Une relation AUTOMATIQUE (superposition geometrique) nait PROPOSEE et
--      n'a d'effet qu'une fois VALIDEE par une personne identifiee, avec justification (10 caracteres au moins) ; une relation MANUELLE est
--      deja une decision humaine. Une proposition REFUSEE reste en base : elle n'est plus jamais reproposee.
--
-- ETATS INCOHERENTS REFUSES PAR LA BASE (et non par le seul service)
--
--   - un descripteur sur un objet d'un plan d'axes ou de limites de route (seuls RESEAU_TIERS et AUTRE sont qualifiables) ;
--   - un circuit logique non lineaire, un equipement non ponctuel, un type d'objet sans nature connue ;
--   - une nature declaree autre que ACTIF_PHYSIQUE, CIRCUIT_LOGIQUE ou EQUIPEMENT (AXE, EMPRISE et INCONNUE ne se declarent pas) ;
--   - une precision nulle ou negative, une profondeur negative, une reference verticale sans profondeur ni altitude ;
--   - une relation d'un objet a lui-meme, entre deux projets, ou dont les natures ou geometries ne conviennent pas au type de relation ;
--   - une relation validee, refusee ou revoquee sans auteur, sans date ni justification d'au moins 10 caracteres ; une proposition decidee ;
--     une relation manuelle encore « proposee » ;
--   - le changement de nature d'un objet qui porte une relation proposee ou validee ;
--   - la modification des extremites, du type ou de la proposition calculee d'une relation (on en cree une autre, ou on la revoque).
--
-- SUPPRESSION LOGIQUE UNIQUEMENT (AGENTS.md, regle 2) : DELETE et TRUNCATE sont refuses sur les deux tables. Un descripteur se corrige
-- (PUT) ; une relation se revoque. L'historique des actes est dans `audit_logs`.
--
-- NATURE : additive. Deux tables, cinq types enumeres, des index, des declencheurs, des fonctions de controle. Idempotente (IF NOT EXISTS,
-- types crees seulement s'ils sont absents). Exige la migration 20261030100000 (socle) et PostGIS.

-- ===== 1. Types =====

DO $$ BEGIN CREATE TYPE "TypeRelationReseau" AS ENUM ('PORTE_PAR', 'CONTENU_DANS'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "StatutRelationReseau" AS ENUM ('PROPOSEE', 'VALIDEE', 'REFUSEE', 'REVOQUEE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "OrigineRelationReseau" AS ENUM ('AUTOMATIQUE', 'MANUELLE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "NiveauConfianceObjet" AS ENUM ('ELEVE', 'MOYEN', 'FAIBLE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "StatutQualiteObjet" AS ENUM ('OBSERVE', 'IMPORTE_NON_VERIFIE', 'DERIVE', 'CONTREDIT', 'INCONNU'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ===== 2. Descripteurs d'objets =====

CREATE TABLE IF NOT EXISTS "reseau_objets_descripteurs" (
  "objetId"               BIGINT PRIMARY KEY REFERENCES "projets_voirie_objets"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Jeu de l'objet : renseigne par le declencheur (la source de verite est l'objet). Sert aux filtres et a la lisibilite.
  "jeuId"                 TEXT NOT NULL REFERENCES "projets_voirie_jeux"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Nulle : herite de la nature du jeu (`natureObjets`). INCONNUE, AXE et EMPRISE ne se declarent pas.
  "nature"                "NatureObjetReseau",
  -- Code de type (CONDUITE, CABLE, CHAMBRE, LIAISON, VANNE...) : la forme est verifiee ici, la liste par nature par le service (extensible sans migration).
  "typeObjet"             TEXT,
  -- Qualite DECLAREE : nulle = inconnue. Aucune precision n'est jamais inventee ni deduite.
  "classePrecision"       "ClassePrecision",
  "precisionHorizontaleM" DECIMAL(8,2),
  "precisionVerticaleM"   DECIMAL(8,2),
  "methodeCollecte"       TEXT,
  "dateConstat"           DATE,
  "niveauConfiance"       "NiveauConfianceObjet",
  "statutQualite"         "StatutQualiteObjet" NOT NULL DEFAULT 'INCONNU',
  -- Profondeur (m, positive vers le bas) et altitude (m) : SEULEMENT si fournies, jamais deduites. La reference dit de quoi elles sont mesurees.
  "profondeurM"           DECIMAL(8,2),
  "altitudeM"             DECIMAL(9,2),
  "referenceVerticale"    TEXT,
  -- Motif de la declaration (« inconnus autorises avec motif », cahier 20.1) ; le dernier motif, l'historique est dans l'audit.
  "justification"         TEXT NOT NULL,
  "declareParId"          TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "declareLe"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "modifieParId"          TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "updatedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "rod_nature_declarable" CHECK ("nature" IS NULL OR "nature" IN ('ACTIF_PHYSIQUE', 'CIRCUIT_LOGIQUE', 'EQUIPEMENT')),
  CONSTRAINT "rod_type_objet_forme" CHECK ("typeObjet" IS NULL OR "typeObjet" ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  CONSTRAINT "rod_precisions" CHECK (("precisionHorizontaleM" IS NULL OR ("precisionHorizontaleM" > 0 AND "precisionHorizontaleM" <= 100000))
                                 AND ("precisionVerticaleM" IS NULL OR ("precisionVerticaleM" > 0 AND "precisionVerticaleM" <= 100000))),
  CONSTRAINT "rod_profondeur" CHECK ("profondeurM" IS NULL OR ("profondeurM" >= 0 AND "profondeurM" <= 10000)),
  CONSTRAINT "rod_altitude" CHECK ("altitudeM" IS NULL OR ("altitudeM" >= -500 AND "altitudeM" <= 9000)),
  CONSTRAINT "rod_reference_verticale" CHECK ("referenceVerticale" IS NULL OR (length(btrim("referenceVerticale")) BETWEEN 1 AND 120 AND ("profondeurM" IS NOT NULL OR "altitudeM" IS NOT NULL))),
  CONSTRAINT "rod_methode" CHECK ("methodeCollecte" IS NULL OR length(btrim("methodeCollecte")) BETWEEN 1 AND 200),
  CONSTRAINT "rod_justification" CHECK (length(btrim("justification")) BETWEEN 10 AND 2000)
);
CREATE INDEX IF NOT EXISTS "reseau_objets_descripteurs_jeuId_idx" ON "reseau_objets_descripteurs" ("jeuId");
CREATE INDEX IF NOT EXISTS "reseau_objets_descripteurs_nature_idx" ON "reseau_objets_descripteurs" ("nature");

-- ===== 3. Relations entre objets =====

CREATE TABLE IF NOT EXISTS "reseau_relations" (
  "id"                    TEXT PRIMARY KEY,
  "projetId"              TEXT NOT NULL REFERENCES "projets_voirie"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "typeRelation"          "TypeRelationReseau" NOT NULL,
  -- Le circuit (PORTE_PAR) ou l'equipement (CONTENU_DANS) ...
  "sourceObjetId"         BIGINT NOT NULL REFERENCES "projets_voirie_objets"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- ... et l'infrastructure physique qui le porte ou le contient.
  "cibleObjetId"          BIGINT NOT NULL REFERENCES "projets_voirie_objets"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "statut"                "StatutRelationReseau" NOT NULL DEFAULT 'PROPOSEE',
  "origine"               "OrigineRelationReseau" NOT NULL,
  -- Parametres et mesure de la proposition automatique (methode, tolerance, composantes, couverture, seuil) : immuable, sans geometrie.
  "proposition"           JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Dernier acte humain : validation, refus ou revocation. Les actes precedents sont dans audit_logs.
  "decideParId"           TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "decideLe"              TIMESTAMP(3),
  "justificationDecision" TEXT,
  -- Qui a lance la proposition automatique, ou declare la relation manuelle.
  "creeParId"             TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "rr_pas_sur_soi" CHECK ("sourceObjetId" <> "cibleObjetId"),
  CONSTRAINT "rr_decision_coherente" CHECK (
    ("statut" = 'PROPOSEE' AND "decideParId" IS NULL AND "decideLe" IS NULL AND "justificationDecision" IS NULL)
    OR ("statut" <> 'PROPOSEE' AND "decideParId" IS NOT NULL AND "decideLe" IS NOT NULL AND length(btrim(coalesce("justificationDecision", ''))) >= 10)),
  CONSTRAINT "rr_manuelle_decidee" CHECK ("origine" <> 'MANUELLE' OR "statut" <> 'PROPOSEE'),
  CONSTRAINT "rr_proposition_forme" CHECK (jsonb_typeof("proposition") = 'object')
);
-- Une seule relation par couple (type, source, cible), quel que soit son statut : une proposition refusee n'est jamais reproposee.
CREATE UNIQUE INDEX IF NOT EXISTS "reseau_relations_couple_key" ON "reseau_relations" ("typeRelation", "sourceObjetId", "cibleObjetId");
CREATE INDEX IF NOT EXISTS "reseau_relations_projetId_statut_idx" ON "reseau_relations" ("projetId", "statut");
CREATE INDEX IF NOT EXISTS "reseau_relations_sourceObjetId_idx" ON "reseau_relations" ("sourceObjetId");
CREATE INDEX IF NOT EXISTS "reseau_relations_cibleObjetId_idx" ON "reseau_relations" ("cibleObjetId");

-- ===== 4. Fonctions et declencheurs =====

-- Nature effective d'un objet : celle de son descripteur, sinon celle de son jeu (meme regle que le service, `natureEffective`).
CREATE OR REPLACE FUNCTION reseau_nature_effective(p_objet BIGINT) RETURNS "NatureObjetReseau"
LANGUAGE sql STABLE AS $fn$
  SELECT COALESCE(d."nature", j."natureObjets")
    FROM "projets_voirie_objets" o
    JOIN "projets_voirie_jeux" j ON j."id" = o."jeuId"
    LEFT JOIN "reseau_objets_descripteurs" d ON d."objetId" = o."id"
   WHERE o."id" = p_objet
$fn$;

CREATE OR REPLACE FUNCTION reseau_descripteur_controle() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  o RECORD;
  nat_jeu "NatureObjetReseau";
  nat_new "NatureObjetReseau";
  nat_old "NatureObjetReseau";
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."objetId" <> OLD."objetId" THEN
    RAISE EXCEPTION 'reseau_objets_descripteurs : l''objet d''un descripteur ne change pas' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT ob."typeGeom", ob."jeuId", j."role", j."natureObjets" INTO o
    FROM "projets_voirie_objets" ob JOIN "projets_voirie_jeux" j ON j."id" = ob."jeuId" WHERE ob."id" = NEW."objetId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reseau_objets_descripteurs : objet % inconnu', NEW."objetId" USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW."jeuId" := o."jeuId";
  IF o."role" NOT IN ('RESEAU_TIERS', 'AUTRE') THEN
    RAISE EXCEPTION 'reseau_objets_descripteurs : seuls les objets d''un reseau de concessionnaire (ou d''un jeu autre) sont qualifiables, pas ceux d''un plan d''axes ni de limites de route'
      USING ERRCODE = 'check_violation';
  END IF;
  nat_jeu := o."natureObjets";
  nat_new := COALESCE(NEW."nature", nat_jeu);
  IF nat_new = 'CIRCUIT_LOGIQUE' AND o."typeGeom" <> 'LIGNE' THEN
    RAISE EXCEPTION 'reseau_objets_descripteurs : un circuit logique est une ligne (geometrie % refusee)', o."typeGeom" USING ERRCODE = 'check_violation';
  END IF;
  IF nat_new = 'EQUIPEMENT' AND o."typeGeom" <> 'POINT' THEN
    RAISE EXCEPTION 'reseau_objets_descripteurs : un equipement est un point (geometrie % refusee)', o."typeGeom" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."typeObjet" IS NOT NULL AND nat_new NOT IN ('ACTIF_PHYSIQUE', 'CIRCUIT_LOGIQUE', 'EQUIPEMENT') THEN
    RAISE EXCEPTION 'reseau_objets_descripteurs : un type d''objet exige une nature connue' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    nat_old := COALESCE(OLD."nature", nat_jeu);
    IF nat_new IS DISTINCT FROM nat_old AND EXISTS (
      SELECT 1 FROM "reseau_relations" r
       WHERE r."statut" IN ('PROPOSEE', 'VALIDEE') AND (r."sourceObjetId" = NEW."objetId" OR r."cibleObjetId" = NEW."objetId")) THEN
      RAISE EXCEPTION 'reseau_objets_descripteurs : la nature d''un objet qui porte une relation proposee ou validee ne change pas (revoquez ou refusez la relation d''abord)'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW."declareParId" := OLD."declareParId";
    NEW."declareLe" := OLD."declareLe";
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION reseau_relation_controle() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  s RECORD;
  c RECORD;
  ns "NatureObjetReseau";
  nc "NatureObjetReseau";
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."projetId" <> OLD."projetId" OR NEW."typeRelation" <> OLD."typeRelation" OR NEW."sourceObjetId" <> OLD."sourceObjetId"
       OR NEW."cibleObjetId" <> OLD."cibleObjetId" OR NEW."origine" <> OLD."origine" OR NEW."creeParId" <> OLD."creeParId"
       OR NEW."createdAt" <> OLD."createdAt" OR NEW."proposition" IS DISTINCT FROM OLD."proposition" THEN
      RAISE EXCEPTION 'reseau_relations : seuls le statut et la decision d''une relation changent (extremites, type, origine et proposition sont figes)'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT ob."typeGeom", j."projetId" INTO s FROM "projets_voirie_objets" ob JOIN "projets_voirie_jeux" j ON j."id" = ob."jeuId" WHERE ob."id" = NEW."sourceObjetId";
  IF NOT FOUND THEN RAISE EXCEPTION 'reseau_relations : objet source % inconnu', NEW."sourceObjetId" USING ERRCODE = 'foreign_key_violation'; END IF;
  SELECT ob."typeGeom", j."projetId" INTO c FROM "projets_voirie_objets" ob JOIN "projets_voirie_jeux" j ON j."id" = ob."jeuId" WHERE ob."id" = NEW."cibleObjetId";
  IF NOT FOUND THEN RAISE EXCEPTION 'reseau_relations : objet cible % inconnu', NEW."cibleObjetId" USING ERRCODE = 'foreign_key_violation'; END IF;
  IF s."projetId" <> NEW."projetId" OR c."projetId" <> NEW."projetId" THEN
    RAISE EXCEPTION 'reseau_relations : les deux objets doivent appartenir au projet de la relation' USING ERRCODE = 'check_violation';
  END IF;
  ns := reseau_nature_effective(NEW."sourceObjetId");
  nc := reseau_nature_effective(NEW."cibleObjetId");
  IF NEW."typeRelation" = 'PORTE_PAR' THEN
    IF ns <> 'CIRCUIT_LOGIQUE' OR nc <> 'ACTIF_PHYSIQUE' THEN
      RAISE EXCEPTION 'reseau_relations : PORTE_PAR relie un circuit logique a une infrastructure physique (recu : % -> %)', ns, nc USING ERRCODE = 'check_violation';
    END IF;
    IF s."typeGeom" <> 'LIGNE' OR c."typeGeom" <> 'LIGNE' THEN
      RAISE EXCEPTION 'reseau_relations : PORTE_PAR relie deux lignes' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF ns <> 'EQUIPEMENT' OR nc <> 'ACTIF_PHYSIQUE' THEN
      RAISE EXCEPTION 'reseau_relations : CONTENU_DANS relie un equipement a une infrastructure physique (recu : % -> %)', ns, nc USING ERRCODE = 'check_violation';
    END IF;
    IF s."typeGeom" <> 'POINT' OR c."typeGeom" NOT IN ('POINT', 'POLYGONE') THEN
      RAISE EXCEPTION 'reseau_relations : CONTENU_DANS relie un point a un point ou a un polygone' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION reseau_refuse_suppression() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '% : suppression physique interdite (un descripteur se corrige, une relation se revoque ; AGENTS.md regle 2)', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$fn$;

CREATE OR REPLACE FUNCTION reseau_refuse_troncature() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '% : TRUNCATE interdit (suppression logique uniquement ; AGENTS.md regle 2)', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$fn$;

DROP TRIGGER IF EXISTS reseau_objets_descripteurs_controle ON "reseau_objets_descripteurs";
CREATE TRIGGER reseau_objets_descripteurs_controle BEFORE INSERT OR UPDATE ON "reseau_objets_descripteurs"
  FOR EACH ROW EXECUTE FUNCTION reseau_descripteur_controle();
DROP TRIGGER IF EXISTS reseau_objets_descripteurs_suppression ON "reseau_objets_descripteurs";
CREATE TRIGGER reseau_objets_descripteurs_suppression BEFORE DELETE ON "reseau_objets_descripteurs"
  FOR EACH ROW EXECUTE FUNCTION reseau_refuse_suppression();
DROP TRIGGER IF EXISTS reseau_objets_descripteurs_troncature ON "reseau_objets_descripteurs";
CREATE TRIGGER reseau_objets_descripteurs_troncature BEFORE TRUNCATE ON "reseau_objets_descripteurs"
  FOR EACH STATEMENT EXECUTE FUNCTION reseau_refuse_troncature();

DROP TRIGGER IF EXISTS reseau_relations_controle ON "reseau_relations";
CREATE TRIGGER reseau_relations_controle BEFORE INSERT OR UPDATE ON "reseau_relations"
  FOR EACH ROW EXECUTE FUNCTION reseau_relation_controle();
DROP TRIGGER IF EXISTS reseau_relations_suppression ON "reseau_relations";
CREATE TRIGGER reseau_relations_suppression BEFORE DELETE ON "reseau_relations"
  FOR EACH ROW EXECUTE FUNCTION reseau_refuse_suppression();
DROP TRIGGER IF EXISTS reseau_relations_troncature ON "reseau_relations";
CREATE TRIGGER reseau_relations_troncature BEFORE TRUNCATE ON "reseau_relations"
  FOR EACH STATEMENT EXECUTE FUNCTION reseau_refuse_troncature();

COMMENT ON TABLE "reseau_objets_descripteurs" IS 'Descripteur d''un objet de reseau : nature, type, qualite declaree (jamais inventee), profondeur et altitude SEULEMENT si fournies. Herite du jeu ce qu''il ne dit pas. Suppression logique : un descripteur se corrige.';
COMMENT ON TABLE "reseau_relations" IS 'Relation entre objets (circuit porte par infrastructure, equipement dans chambre). Une proposition automatique n''a d''effet qu''une fois validee par une personne ; une refusee n''est jamais reproposee.';

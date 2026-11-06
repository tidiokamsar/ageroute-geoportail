-- DOSSIERS DE CONFLIT DES PROJETS DE VOIRIE (lot RC-3) : REGLES VERSIONNEES, ANALYSES PERSISTEES, CONFLITS, HISTORIQUE, PREUVES, DECISIONS
--
-- Contrat : docs/projets-voirie/CONTRAT-CONFLITS.md (sections 2 a 5).
--
-- CE QUE CETTE MIGRATION FAIT
--
--   1. `regles_conflit_projet` : regles de detection VERSIONNEES (tolerance de proximite, marge d'incertitude), par projet et
--      par famille de reseau, ou generale. Une regle APPROUVEE est IMMUABLE (un declencheur le garantit : on cree une nouvelle
--      version). La regle par defaut `RC-2D-0.1` (version 0, APPROUVEE, tolerance 0, aucun seuil invente) est creee ICI, par la
--      migration : une base neuve a toujours une regle applicable, sans amorcage a l'execution (choix documente dans
--      docs/projets-voirie/API.md, section « Dossiers de conflit »). Elle est la seule ligne sans auteur (creeParId nul).
--   2. `analyses_conflit_projet` : une analyse PERSISTEE est reproductible (empreintes et versions des jeux, versions des regles,
--      largeurs, version de l'algorithme) et IMMUABLE (UPDATE et DELETE refuses). `instantane` garde, pour chaque conflit trouve,
--      la cle et l'empreinte de sa mesure : c'est ce qui permet de comparer deux analyses passees.
--   3. `conflits_projet` : un dossier par conflit, identifie par une cle stable (unique par projet). Jamais supprime (DELETE
--      refuse). Un RECALCUL ne peut JAMAIS changer le statut, le responsable, l'echeance, le risque ni l'action proposee : le
--      declencheur `conflits_projet_recalcul` l'interdit des que la transaction a pose `bdri.conflit_recalcul = 'oui'`.
--   4. `conflits_projet_historique` et `conflits_projet_preuves` : journaux AJOUT SEUL (UPDATE et DELETE refuses).
--   5. `conflits_projet_decisions` : decisions proposees puis approuvees ou refusees ; une decision tranchee ne change plus ; une
--      decision approuvee par la personne qui l'a proposee exige une derogation motivee (contrainte de la base).
--
-- ETATS INCOHERENTS REFUSES PAR LA BASE (et non par le seul service)
--
--   - une regle approuvee sans date (ni approbateur, sauf la regle systeme), une regle brouillon deja approuvee, une regle
--     systeme autre que la regle par defaut, une tolerance ou une marge negative ;
--   - un conflit marque « a reexaminer » sans motif (ou l'inverse), une cle qui n'est pas une empreinte SHA-256 ;
--   - une ligne d'historique de statut sans ancien et nouveau statut distincts, ou sans justification d'au moins 10 caracteres ;
--   - une ligne d'historique ni d'un acteur ni d'une analyse ;
--   - une decision sans justification, avec un cout sans devise, un cout negatif, des dates inversees, un deplacement de reseau
--     sans planning, une decision tranchee sans decideur, sans date ni motif.
--
-- NATURE : additive. Six tables, dix types enumeres, des index, des declencheurs, une ligne (regle par defaut). Aucune table
-- existante n'est modifiee. Idempotente (IF NOT EXISTS, types crees seulement s'ils sont absents, regle par defaut ON CONFLICT).
-- Exige PostgreSQL 15 ou plus (UNIQUE ... NULLS NOT DISTINCT) et PostGIS.

-- ===== 1. Types =====

DO $$ BEGIN CREATE TYPE "TypeConflit" AS ENUM ('INTERSECTION_CHAUSSEE', 'INTERSECTION_EMPRISE', 'PROXIMITE', 'TRAVERSEE', 'COUVERTURE_INSUFFISANTE', 'DIVERGENCE_SOURCES'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "StatutConflit" AS ENUM ('A_INVESTIGUER', 'POTENTIEL', 'CONFIRME', 'INFIRME', 'TRAITEMENT_DECIDE', 'CLOTURE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "RisqueConflit" AS ENUM ('FAIBLE', 'MOYEN', 'ELEVE', 'INCONNU'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "MotifReexamenConflit" AS ENUM ('NON_RETROUVE', 'MESURE_MODIFIEE', 'NOUVELLE_VERSION_DONNEES'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "StatutRegleConflit" AS ENUM ('BROUILLON', 'APPROUVEE', 'RETIREE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "StatutAnalyseConflit" AS ENUM ('TERMINEE', 'ECHEC'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "ActionHistoriqueConflit" AS ENUM ('CREATION', 'RETROUVE', 'MESURE_MODIFIEE', 'STATUT', 'ATTRIBUTION', 'PREUVE', 'DECISION_PROPOSEE', 'DECISION_APPROUVEE', 'DECISION_REFUSEE', 'REEXAMEN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "TypePreuveConflit" AS ENUM ('NOTE', 'REFERENCE_DOCUMENT', 'CONTACT_CONCESSIONNAIRE', 'RELEVE_TERRAIN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "OptionDecisionConflit" AS ENUM ('PROTEGER', 'ADAPTER_PROJET', 'DEPLACER_RESEAU', 'SANS_INTERVENTION', 'A_ETUDIER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "StatutDecisionConflit" AS ENUM ('PROPOSEE', 'APPROUVEE', 'REFUSEE', 'ANNULEE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ===== 2. Regles de conflit (versionnees) =====

CREATE TABLE IF NOT EXISTS "regles_conflit_projet" (
  "id"                  TEXT PRIMARY KEY,
  -- Nul : regle generale (tous les projets). Une regle creee par la route est toujours rattachee a son projet.
  "projetId"            TEXT REFERENCES "projets_voirie"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Nulle : toutes les familles de reseau.
  "famille"             "TypeReseauTiers",
  "code"                TEXT NOT NULL,
  -- Croissante par (projetId, famille, code). 0 : la regle par defaut du socle.
  "version"             INTEGER NOT NULL,
  -- Bande de proximite a verifier, AU-DELA de l'emprise, en metres. 0 tant que personne n'a approuve de seuil.
  "toleranceProximiteM" DECIMAL(8,2) NOT NULL DEFAULT 0,
  -- Facteur applique a la precision horizontale DECLAREE du jeu (jamais inventee) pour elargir la zone a verifier.
  "margeIncertitude"    DECIMAL(6,2) NOT NULL DEFAULT 1,
  "statut"              "StatutRegleConflit" NOT NULL DEFAULT 'BROUILLON',
  "justification"       TEXT NOT NULL,
  -- Nul seulement pour la regle systeme (RC-2D-0.1, version 0).
  "creeParId"           TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "approuveParId"       TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "approuveLe"          TIMESTAMP(3),
  "motifApprobation"    TEXT,
  -- Motif de l'approbation par l'auteur lui-meme (derogation de separation des taches), trace aussi dans l'audit.
  "derogationApprobation" TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "rcp_code_format" CHECK ("code" ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$'),
  CONSTRAINT "rcp_version" CHECK ("version" >= 0),
  CONSTRAINT "rcp_tolerance" CHECK ("toleranceProximiteM" >= 0 AND "toleranceProximiteM" <= 1000),
  CONSTRAINT "rcp_marge" CHECK ("margeIncertitude" >= 0 AND "margeIncertitude" <= 100),
  CONSTRAINT "rcp_justification" CHECK (length(btrim("justification")) >= 10),
  CONSTRAINT "rcp_systeme" CHECK ("creeParId" IS NOT NULL OR ("projetId" IS NULL AND "famille" IS NULL AND "version" = 0 AND "statut" = 'APPROUVEE')),
  CONSTRAINT "rcp_version_utilisateur" CHECK ("creeParId" IS NULL OR "version" >= 1),
  CONSTRAINT "rcp_approbation" CHECK (
    ("statut" = 'BROUILLON' AND "approuveParId" IS NULL AND "approuveLe" IS NULL)
    OR ("statut" = 'APPROUVEE' AND "approuveLe" IS NOT NULL AND ("approuveParId" IS NOT NULL OR "creeParId" IS NULL))
    OR "statut" = 'RETIREE'),
  CONSTRAINT "rcp_derogation" CHECK ("derogationApprobation" IS NULL OR length(btrim("derogationApprobation")) >= 10)
);
-- Une version par (projet, famille, code), les NULL comptant comme des valeurs (index non representable dans schema.prisma).
CREATE UNIQUE INDEX IF NOT EXISTS "regles_conflit_projet_version_key" ON "regles_conflit_projet" ("projetId", "famille", "code", "version") NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS "regles_conflit_projet_projetId_statut_idx" ON "regles_conflit_projet" ("projetId", "statut");

-- ===== 3. Analyses persistees (immuables) =====

CREATE TABLE IF NOT EXISTS "analyses_conflit_projet" (
  "id"                TEXT PRIMARY KEY,
  "projetId"          TEXT NOT NULL REFERENCES "projets_voirie"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Sequence par projet (1, 2, 3...).
  "numero"            INTEGER NOT NULL,
  "statut"            "StatutAnalyseConflit" NOT NULL,
  -- Valeurs UTILISEES par ce calcul (celles du projet au moment de l'analyse).
  "largeurEmpriseM"   DECIMAL(6,2) NOT NULL,
  "largeurChausseeM"  DECIMAL(6,2) NOT NULL,
  -- [{ regleId, code, version, famille, toleranceProximiteM, margeIncertitude, portee }] : une entree par famille appliquee.
  "regles"            JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- [{ jeuId, sha256, version, role, statut, ... }] : les jeux pris en compte (empreintes et versions).
  "jeux"              JSONB NOT NULL DEFAULT '[]'::jsonb,
  "versionAlgorithme" TEXT NOT NULL,
  -- Totaux, comptes par type et par statut, nouveaux, retrouves, disparus, modifies, limites.
  "resume"            JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- { <cle du conflit> : <empreinte de sa mesure> } pour chaque conflit trouve par cette analyse (comparaison de deux analyses).
  "instantane"        JSONB NOT NULL DEFAULT '{}'::jsonb,
  "declencheParId"    TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Duree du calcul, en millisecondes.
  "duree"             INTEGER NOT NULL DEFAULT 0,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "acp_numero" CHECK ("numero" >= 1),
  CONSTRAINT "acp_largeurs" CHECK ("largeurChausseeM" > 0 AND "largeurEmpriseM" >= "largeurChausseeM" AND "largeurEmpriseM" <= 200),
  CONSTRAINT "acp_duree" CHECK ("duree" >= 0),
  CONSTRAINT "acp_json_formes" CHECK (jsonb_typeof("regles") = 'array' AND jsonb_typeof("jeux") = 'array' AND jsonb_typeof("resume") = 'object' AND jsonb_typeof("instantane") = 'object')
);
CREATE UNIQUE INDEX IF NOT EXISTS "analyses_conflit_projet_projetId_numero_key" ON "analyses_conflit_projet" ("projetId", "numero");
CREATE INDEX IF NOT EXISTS "analyses_conflit_projet_declencheParId_idx" ON "analyses_conflit_projet" ("declencheParId");

-- ===== 4. Conflits =====

CREATE TABLE IF NOT EXISTS "conflits_projet" (
  "id"                TEXT PRIMARY KEY,
  "projetId"          TEXT NOT NULL REFERENCES "projets_voirie"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Empreinte SHA-256 STABLE : projet, axe, objet reseau, type, cellule de localisation arrondie.
  "cle"               TEXT NOT NULL,
  "type"              "TypeConflit" NOT NULL,
  -- Nom de l'axe de travaux (ou « Axe n » sans nom).
  "axe"               TEXT NOT NULL,
  "jeuReseauId"       TEXT REFERENCES "projets_voirie_jeux"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "objetId"           BIGINT REFERENCES "projets_voirie_objets"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "concessionnaireId" TEXT REFERENCES "concessionnaires_reseau"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- { longueurChausseeM, longueurEmpriseM, distanceMinM, nbCroisements, ... }
  "mesure"            JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Troncon de reseau en conflit, points de croisement, ou axe (couverture). Donnee SENSIBLE : meme regime que les jeux.
  "geom"              geometry(Geometry, 4326) NOT NULL,
  "statut"            "StatutConflit" NOT NULL,
  "risque"            "RisqueConflit",
  "responsableId"     TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "echeance"          DATE,
  "actionProposee"    TEXT,
  -- Copie de la classe de precision DECLAREE du jeu (nulle : inconnue).
  "classePrecision"   "ClassePrecision",
  -- Faux tant que profondeur et altitude manquent (toujours faux dans ce lot).
  "verticalEvalue"    BOOLEAN NOT NULL DEFAULT false,
  "premiereAnalyseId" TEXT NOT NULL REFERENCES "analyses_conflit_projet"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "derniereAnalyseId" TEXT NOT NULL REFERENCES "analyses_conflit_projet"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "aReexaminer"       BOOLEAN NOT NULL DEFAULT false,
  "motifReexamen"     "MotifReexamenConflit",
  -- [{ code, nom }] : troncons du referentiel a moins de la demi-largeur d'emprise (lecture seule, jamais ecrits).
  "tronconsProches"   JSONB NOT NULL DEFAULT '[]'::jsonb,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cp_cle_format" CHECK ("cle" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "cp_axe" CHECK (length(btrim("axe")) BETWEEN 1 AND 300),
  CONSTRAINT "cp_geom_non_vide" CHECK (NOT ST_IsEmpty("geom")),
  CONSTRAINT "cp_reexamen_coherent" CHECK ("aReexaminer" = ("motifReexamen" IS NOT NULL)),
  CONSTRAINT "cp_json_formes" CHECK (jsonb_typeof("mesure") = 'object' AND jsonb_typeof("tronconsProches") = 'array'),
  CONSTRAINT "cp_action_proposee" CHECK ("actionProposee" IS NULL OR length("actionProposee") <= 2000)
);
CREATE UNIQUE INDEX IF NOT EXISTS "conflits_projet_projetId_cle_key" ON "conflits_projet" ("projetId", "cle");
CREATE INDEX IF NOT EXISTS "conflits_projet_projetId_statut_idx" ON "conflits_projet" ("projetId", "statut");
CREATE INDEX IF NOT EXISTS "conflits_projet_projetId_type_idx" ON "conflits_projet" ("projetId", "type");
CREATE INDEX IF NOT EXISTS "conflits_projet_responsableId_idx" ON "conflits_projet" ("responsableId");
CREATE INDEX IF NOT EXISTS "conflits_projet_jeuReseauId_idx" ON "conflits_projet" ("jeuReseauId");
CREATE INDEX IF NOT EXISTS "conflits_projet_premiereAnalyseId_idx" ON "conflits_projet" ("premiereAnalyseId");
CREATE INDEX IF NOT EXISTS "conflits_projet_derniereAnalyseId_idx" ON "conflits_projet" ("derniereAnalyseId");
CREATE INDEX IF NOT EXISTS "conflits_projet_geom_gist" ON "conflits_projet" USING GIST ("geom");

-- ===== 5. Historique, preuves (ajout seul) et decisions =====

CREATE TABLE IF NOT EXISTS "conflits_projet_historique" (
  "id"            TEXT PRIMARY KEY,
  "conflitId"     TEXT NOT NULL REFERENCES "conflits_projet"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "action"        "ActionHistoriqueConflit" NOT NULL,
  "ancienStatut"  "StatutConflit",
  "nouveauStatut" "StatutConflit",
  "justification" TEXT,
  -- Nul pour un calcul (alors `analyseId` est renseigne).
  "acteurId"      TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "analyseId"     TEXT REFERENCES "analyses_conflit_projet"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "donnees"       JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cph_acteur_ou_analyse" CHECK ("acteurId" IS NOT NULL OR "analyseId" IS NOT NULL),
  CONSTRAINT "cph_statut_coherent" CHECK ("action" <> 'STATUT' OR ("ancienStatut" IS NOT NULL AND "nouveauStatut" IS NOT NULL AND "ancienStatut" <> "nouveauStatut")),
  CONSTRAINT "cph_justification_statut" CHECK ("action" <> 'STATUT' OR length(btrim(coalesce("justification", ''))) >= 10),
  CONSTRAINT "cph_donnees" CHECK (jsonb_typeof("donnees") = 'object')
);
CREATE INDEX IF NOT EXISTS "conflits_projet_historique_conflitId_createdAt_idx" ON "conflits_projet_historique" ("conflitId", "createdAt");
CREATE INDEX IF NOT EXISTS "conflits_projet_historique_analyseId_idx" ON "conflits_projet_historique" ("analyseId");

CREATE TABLE IF NOT EXISTS "conflits_projet_preuves" (
  "id"        TEXT PRIMARY KEY,
  "conflitId" TEXT NOT NULL REFERENCES "conflits_projet"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "type"      "TypePreuveConflit" NOT NULL,
  "texte"     TEXT NOT NULL,
  -- Texte libre (numero de courrier, nom de plan) : aucun fichier dans ce lot.
  "reference" TEXT,
  "auteurId"  TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cpp_texte" CHECK (length(btrim("texte")) BETWEEN 1 AND 4000),
  CONSTRAINT "cpp_reference" CHECK ("reference" IS NULL OR length("reference") <= 500)
);
CREATE INDEX IF NOT EXISTS "conflits_projet_preuves_conflitId_idx" ON "conflits_projet_preuves" ("conflitId");

CREATE TABLE IF NOT EXISTS "conflits_projet_decisions" (
  "id"                    TEXT PRIMARY KEY,
  "conflitId"             TEXT NOT NULL REFERENCES "conflits_projet"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "option"                "OptionDecisionConflit" NOT NULL,
  "justification"         TEXT NOT NULL,
  "contraintes"           TEXT,
  -- Couts ESTIME et REEL : champs distincts, saisis, jamais calcules ni deduits.
  "coutEstime"            DECIMAL(18,2),
  "deviseCout"            TEXT,
  "coutReel"              DECIMAL(18,2),
  "dateDebutPrevue"       DATE,
  "dateFinPrevue"         DATE,
  "statut"                "StatutDecisionConflit" NOT NULL DEFAULT 'PROPOSEE',
  "proposeParId"          TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Auteur de l'approbation OU du refus (la personne qui a tranche).
  "approuveParId"         TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "approuveLe"            TIMESTAMP(3),
  "motifDecision"         TEXT,
  -- Derogation a la separation des taches (meme personne a la proposition et a l'approbation), motivee.
  "derogationSeparation"  TEXT,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cpd_justification" CHECK (length(btrim("justification")) >= 10),
  CONSTRAINT "cpd_couts" CHECK (("coutEstime" IS NULL OR "coutEstime" >= 0) AND ("coutReel" IS NULL OR "coutReel" >= 0)),
  CONSTRAINT "cpd_devise" CHECK (("deviseCout" IS NULL OR "deviseCout" ~ '^[A-Z]{3}$') AND (("coutEstime" IS NULL AND "coutReel" IS NULL) OR "deviseCout" IS NOT NULL)),
  CONSTRAINT "cpd_dates" CHECK ("dateDebutPrevue" IS NULL OR "dateFinPrevue" IS NULL OR "dateFinPrevue" >= "dateDebutPrevue"),
  CONSTRAINT "cpd_deplacement_planifie" CHECK ("option" <> 'DEPLACER_RESEAU' OR ("dateDebutPrevue" IS NOT NULL AND "dateFinPrevue" IS NOT NULL)),
  CONSTRAINT "cpd_tranchee" CHECK (
    ("statut" IN ('PROPOSEE', 'ANNULEE') AND "approuveParId" IS NULL AND "approuveLe" IS NULL)
    OR ("statut" IN ('APPROUVEE', 'REFUSEE') AND "approuveParId" IS NOT NULL AND "approuveLe" IS NOT NULL AND length(btrim(coalesce("motifDecision", ''))) >= 10)),
  -- Separation des taches : la personne qui tranche une decision qu'elle a elle-meme proposee doit avoir une derogation motivee.
  CONSTRAINT "cpd_separation" CHECK ("approuveParId" IS NULL OR "approuveParId" <> "proposeParId" OR length(btrim(coalesce("derogationSeparation", ''))) >= 10),
  CONSTRAINT "cpd_textes" CHECK (("contraintes" IS NULL OR length("contraintes") <= 4000) AND ("derogationSeparation" IS NULL OR length("derogationSeparation") <= 2000))
);
CREATE INDEX IF NOT EXISTS "conflits_projet_decisions_conflitId_statut_idx" ON "conflits_projet_decisions" ("conflitId", "statut");

-- ===== 6. Declencheurs =====

CREATE OR REPLACE FUNCTION conflits_projet_refuse_suppression() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '% : suppression physique interdite (suppression logique uniquement, AGENTS.md regle 2)', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$fn$;

CREATE OR REPLACE FUNCTION conflits_projet_ajout_seul() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '% : ajout seul (un journal ou une analyse ne se modifie ni ne se supprime)', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$fn$;

-- Une regle approuvee est immuable : seule la retirer (APPROUVEE -> RETIREE) est possible, et rien d'autre ne change alors.
-- Un brouillon ne se modifie pas non plus : il est approuve (ou retire), jamais reecrit (les colonnes d'approbation sont les
-- seules a changer, et seulement par le passage a APPROUVEE).
CREATE OR REPLACE FUNCTION regles_conflit_projet_immuable() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."projetId" IS DISTINCT FROM OLD."projetId" OR NEW."famille" IS DISTINCT FROM OLD."famille" OR NEW."code" IS DISTINCT FROM OLD."code"
     OR NEW."version" IS DISTINCT FROM OLD."version" OR NEW."toleranceProximiteM" IS DISTINCT FROM OLD."toleranceProximiteM"
     OR NEW."margeIncertitude" IS DISTINCT FROM OLD."margeIncertitude" OR NEW."justification" IS DISTINCT FROM OLD."justification"
     OR NEW."creeParId" IS DISTINCT FROM OLD."creeParId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'regles_conflit_projet : une regle ne se modifie pas (creez une nouvelle version)' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."statut" <> 'BROUILLON' THEN
    IF NOT (OLD."statut" = 'APPROUVEE' AND NEW."statut" = 'RETIREE'
            AND NEW."approuveParId" IS NOT DISTINCT FROM OLD."approuveParId" AND NEW."approuveLe" IS NOT DISTINCT FROM OLD."approuveLe"
            AND NEW."motifApprobation" IS NOT DISTINCT FROM OLD."motifApprobation" AND NEW."derogationApprobation" IS NOT DISTINCT FROM OLD."derogationApprobation") THEN
      RAISE EXCEPTION 'regles_conflit_projet : une regle approuvee est immuable (nouvelle version pour la changer)' USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF NEW."statut" = 'BROUILLON' THEN
    RAISE EXCEPTION 'regles_conflit_projet : un brouillon se modifie en etant approuve ou retire, jamais reecrit' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$fn$;

-- Un RECALCUL ne change jamais un verdict ni un champ humain : la transaction d'analyse pose `bdri.conflit_recalcul = 'oui'`.
CREATE OR REPLACE FUNCTION conflits_projet_garde_modification() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."cle" IS DISTINCT FROM OLD."cle" OR NEW."projetId" IS DISTINCT FROM OLD."projetId" OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."axe" IS DISTINCT FROM OLD."axe" OR NEW."premiereAnalyseId" IS DISTINCT FROM OLD."premiereAnalyseId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'conflits_projet : identite du conflit immuable (cle, projet, type, axe, premiere analyse)' USING ERRCODE = 'restrict_violation';
  END IF;
  IF coalesce(current_setting('bdri.conflit_recalcul', true), '') = 'oui' THEN
    IF NEW."statut" IS DISTINCT FROM OLD."statut" OR NEW."risque" IS DISTINCT FROM OLD."risque"
       OR NEW."responsableId" IS DISTINCT FROM OLD."responsableId" OR NEW."echeance" IS DISTINCT FROM OLD."echeance"
       OR NEW."actionProposee" IS DISTINCT FROM OLD."actionProposee" THEN
      RAISE EXCEPTION 'conflits_projet : un recalcul ne modifie jamais le statut, le risque, le responsable, l''echeance ni l''action proposee' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

-- Une decision tranchee (approuvee, refusee, annulee) ne change plus ; une proposition ne change que par la decision.
CREATE OR REPLACE FUNCTION conflits_projet_decision_garde() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD."statut" <> 'PROPOSEE' THEN
    RAISE EXCEPTION 'conflits_projet_decisions : une decision tranchee ne se modifie plus' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."conflitId" IS DISTINCT FROM OLD."conflitId" OR NEW."option" IS DISTINCT FROM OLD."option" OR NEW."justification" IS DISTINCT FROM OLD."justification"
     OR NEW."contraintes" IS DISTINCT FROM OLD."contraintes" OR NEW."coutEstime" IS DISTINCT FROM OLD."coutEstime"
     OR NEW."deviseCout" IS DISTINCT FROM OLD."deviseCout" OR NEW."coutReel" IS DISTINCT FROM OLD."coutReel"
     OR NEW."dateDebutPrevue" IS DISTINCT FROM OLD."dateDebutPrevue" OR NEW."dateFinPrevue" IS DISTINCT FROM OLD."dateFinPrevue"
     OR NEW."proposeParId" IS DISTINCT FROM OLD."proposeParId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'conflits_projet_decisions : seule la decision (statut, auteur, date, motif, derogation) change sur une proposition' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS regles_conflit_projet_suppression ON "regles_conflit_projet";
CREATE TRIGGER regles_conflit_projet_suppression BEFORE DELETE ON "regles_conflit_projet" FOR EACH ROW EXECUTE FUNCTION conflits_projet_refuse_suppression();
DROP TRIGGER IF EXISTS regles_conflit_projet_modification ON "regles_conflit_projet";
CREATE TRIGGER regles_conflit_projet_modification BEFORE UPDATE ON "regles_conflit_projet" FOR EACH ROW EXECUTE FUNCTION regles_conflit_projet_immuable();

DROP TRIGGER IF EXISTS analyses_conflit_projet_ajout_seul ON "analyses_conflit_projet";
CREATE TRIGGER analyses_conflit_projet_ajout_seul BEFORE UPDATE OR DELETE ON "analyses_conflit_projet" FOR EACH ROW EXECUTE FUNCTION conflits_projet_ajout_seul();

DROP TRIGGER IF EXISTS conflits_projet_suppression ON "conflits_projet";
CREATE TRIGGER conflits_projet_suppression BEFORE DELETE ON "conflits_projet" FOR EACH ROW EXECUTE FUNCTION conflits_projet_refuse_suppression();
DROP TRIGGER IF EXISTS conflits_projet_recalcul ON "conflits_projet";
CREATE TRIGGER conflits_projet_recalcul BEFORE UPDATE ON "conflits_projet" FOR EACH ROW EXECUTE FUNCTION conflits_projet_garde_modification();

DROP TRIGGER IF EXISTS conflits_projet_historique_ajout_seul ON "conflits_projet_historique";
CREATE TRIGGER conflits_projet_historique_ajout_seul BEFORE UPDATE OR DELETE ON "conflits_projet_historique" FOR EACH ROW EXECUTE FUNCTION conflits_projet_ajout_seul();
DROP TRIGGER IF EXISTS conflits_projet_preuves_ajout_seul ON "conflits_projet_preuves";
CREATE TRIGGER conflits_projet_preuves_ajout_seul BEFORE UPDATE OR DELETE ON "conflits_projet_preuves" FOR EACH ROW EXECUTE FUNCTION conflits_projet_ajout_seul();

DROP TRIGGER IF EXISTS conflits_projet_decisions_suppression ON "conflits_projet_decisions";
CREATE TRIGGER conflits_projet_decisions_suppression BEFORE DELETE ON "conflits_projet_decisions" FOR EACH ROW EXECUTE FUNCTION conflits_projet_refuse_suppression();
DROP TRIGGER IF EXISTS conflits_projet_decisions_garde ON "conflits_projet_decisions";
CREATE TRIGGER conflits_projet_decisions_garde BEFORE UPDATE ON "conflits_projet_decisions" FOR EACH ROW EXECUTE FUNCTION conflits_projet_decision_garde();

-- ===== 7. Regle par defaut RC-2D-0.1 =====
-- Celle du socle (analyse 2D indicative) : version 0, APPROUVEE par construction, SANS seuil invente (tolerance 0, marge 1).
-- Identifiant fixe pour que le rejeu de la migration ne la duplique jamais.

INSERT INTO "regles_conflit_projet" ("id", "projetId", "famille", "code", "version", "toleranceProximiteM", "margeIncertitude", "statut", "justification", "creeParId", "approuveParId", "approuveLe", "motifApprobation")
VALUES ('00000000-0000-4000-8000-00000000c301', NULL, NULL, 'RC-2D-0.1', 0, 0, 1, 'APPROUVEE',
        'Regle par defaut du socle (analyse 2D indicative) : bandes de chaussee et d''emprise centrees sur l''axe, aucune tolerance de proximite, aucun seuil invente.',
        NULL, NULL, CURRENT_TIMESTAMP, 'Regle systeme creee par la migration 20261031100000 : version 0, approuvee par construction.')
ON CONFLICT DO NOTHING;

COMMENT ON TABLE "regles_conflit_projet" IS 'Regles de detection de conflit, versionnees. Une regle approuvee est immuable. Regle par defaut RC-2D-0.1 (version 0). Contrat : docs/projets-voirie/CONTRAT-CONFLITS.md';
COMMENT ON TABLE "analyses_conflit_projet" IS 'Analyses de conflit persistees et reproductibles (versions des jeux, des regles, de l''algorithme). Immuables.';
COMMENT ON TABLE "conflits_projet" IS 'Dossiers de conflit : un signal de verification, jamais un ordre. Cle stable, jamais supprimes. Un recalcul ne change jamais un verdict humain.';
COMMENT ON TABLE "conflits_projet_historique" IS 'Historique des dossiers de conflit : ajout seul.';
COMMENT ON TABLE "conflits_projet_preuves" IS 'Preuves rattachees a un dossier de conflit : ajout seul.';
COMMENT ON TABLE "conflits_projet_decisions" IS 'Decisions proposees puis approuvees ou refusees sur un conflit. Couts estime et reel distincts, jamais calcules. Aucun ordre n''est cree.';

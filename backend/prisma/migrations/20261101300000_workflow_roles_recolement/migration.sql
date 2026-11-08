-- WORKFLOW CONCESSIONNAIRE, RATTACHEMENT DES REFERENTS, TACHES, PREUVES ET RECOLEMENT DES PROJETS DE VOIRIE (lot B3)
--
-- Contrat : docs/projets-voirie/CONTRAT-WORKFLOW.md.
--
-- CE QUE CETTE MIGRATION FAIT
--
--   1. `referents_concessionnaire` : le rattachement d'un COMPTE a un concessionnaire pour un projet. C'est un ATTRIBUT DE COMPTE, pas un role :
--      un referent est un compte LECTEUR qui porte la cle de module `projets-voirie` et ce rattachement (pose par un ADMIN). Il ne se supprime
--      pas : il se revoque (une fois, motif de 10 caracteres).
--   2. `demandes_concessionnaire` : demande de donnees a un concessionnaire (BROUILLON, ENVOYEE, RECUE, CLOTUREE, ANNULEE). L'ENVOI SE FAIT HORS
--      APPLICATION : la table enregistre l'envoi fait par une personne (date, canal, reference, interlocuteur), elle n'envoie rien.
--   3. `taches_projet_voirie` : taches liees a un projet, un conflit ou une demande (responsable, echeance, statut, priorite).
--   4. `recolements_projet_voirie` : recolement (as-built) lie a un conflit dont un deplacement est decide, ou a un jeu, valide par un TIERS.
--   5. `preuves_workflow_projet` : preuves REFERENCEES (texte, reference libre, nom de fichier, empreinte SHA-256) : AUCUN fichier n'est stocke
--      (le stockage de pieces jointes n'est pas decide). Ajout seul.
--   6. `workflow_projet_historique` : historique (avant/apres, auteur, profil, justification). Ajout seul.
--
-- ETATS INCOHERENTS REFUSES PAR LA BASE (et non par le seul service)
--
--   - une demande envoyee sans canal, date ou auteur d'envoi ; recue sans date ni auteur de reception ; close ou annulee sans motif de 10 caracteres ;
--     une reception avant l'envoi ; un jeu recu lie a une demande non recue ;
--   - une tache liee a la fois a un conflit et a une demande ; terminee sans date ; a valider sans validation requise ;
--   - un recolement sans conflit ni jeu ; soumis sans soumissionnaire ; valide ou rejete sans decideur ni motif ; VALIDE par son createur ou par
--     la personne qui l'a soumis sans derogation motivee (separation des taches) ;
--   - une preuve dont l'empreinte n'est pas un SHA-256 en hexadecimal minuscule ;
--   - une modification de l'identite d'un objet (projet, concessionnaire, liens, createur) et toute modification d'un objet terminal
--     (demande close ou annulee, tache terminee ou annulee, recolement valide, rattachement revoque).
--
-- AUCUNE SUPPRESSION : DELETE et TRUNCATE sont refuses sur les six tables (suppression logique uniquement : AGENTS.md regle 2).
--
-- NATURE : additive. Six tables, sept types enumeres, des index (dont des index uniques partiels), des declencheurs. Aucune table existante n'est
-- modifiee, aucune ligne n'est inseree. Idempotente (IF NOT EXISTS, types crees seulement s'ils sont absents).

-- ===== 1. Types =====

DO $$ BEGIN CREATE TYPE "StatutDemandeConcessionnaire" AS ENUM ('BROUILLON', 'ENVOYEE', 'RECUE', 'CLOTUREE', 'ANNULEE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "StatutTacheProjet" AS ENUM ('A_FAIRE', 'EN_COURS', 'A_VALIDER', 'TERMINEE', 'ANNULEE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "PrioriteTacheProjet" AS ENUM ('BASSE', 'NORMALE', 'HAUTE', 'URGENTE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "StatutRecolementProjet" AS ENUM ('BROUILLON', 'SOUMIS', 'VALIDE', 'REJETE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "TypeObjetWorkflow" AS ENUM ('DEMANDE', 'TACHE', 'RECOLEMENT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "ActionHistoriqueWorkflow" AS ENUM ('CREATION', 'MODIFICATION', 'STATUT', 'PREUVE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "TypePreuveWorkflow" AS ENUM ('NOTE', 'REFERENCE_DOCUMENT', 'COURRIER', 'REPONSE_CONCESSIONNAIRE', 'PLAN_RECOLEMENT', 'RELEVE_TERRAIN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ===== 2. Rattachement des referents concessionnaires (attribut de compte) =====

CREATE TABLE IF NOT EXISTS "referents_concessionnaire" (
  "id"                TEXT PRIMARY KEY,
  "userId"            TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "concessionnaireId" TEXT NOT NULL REFERENCES "concessionnaires_reseau"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "projetId"          TEXT NOT NULL REFERENCES "projets_voirie"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "creeParId"         TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "motif"             TEXT NOT NULL,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoqueLe"         TIMESTAMP(3),
  "revoqueParId"      TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "motifRevocation"   TEXT,

  CONSTRAINT "rfc_motif" CHECK (length(btrim("motif")) >= 10 AND length("motif") <= 2000),
  CONSTRAINT "rfc_revocation" CHECK (
    ("revoqueLe" IS NULL AND "revoqueParId" IS NULL AND "motifRevocation" IS NULL)
    OR ("revoqueLe" IS NOT NULL AND "revoqueParId" IS NOT NULL AND length(btrim(coalesce("motifRevocation", ''))) >= 10 AND length("motifRevocation") <= 2000))
);
-- Un rattachement ACTIF par (compte, projet, concessionnaire) : index unique partiel, non representable dans schema.prisma.
CREATE UNIQUE INDEX IF NOT EXISTS "referents_concessionnaire_actif_key" ON "referents_concessionnaire" ("userId", "projetId", "concessionnaireId") WHERE "revoqueLe" IS NULL;
-- Lu a CHAQUE requete d'un compte qui n'est pas ADMIN (garde du referent) : index partiel sur les rattachements actifs d'un compte.
CREATE INDEX IF NOT EXISTS "referents_concessionnaire_userId_actif_idx" ON "referents_concessionnaire" ("userId") WHERE "revoqueLe" IS NULL;
CREATE INDEX IF NOT EXISTS "referents_concessionnaire_projetId_idx" ON "referents_concessionnaire" ("projetId", "concessionnaireId");

-- ===== 3. Demandes de donnees aux concessionnaires =====

CREATE TABLE IF NOT EXISTS "demandes_concessionnaire" (
  "id"                TEXT PRIMARY KEY,
  "projetId"          TEXT NOT NULL REFERENCES "projets_voirie"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "concessionnaireId" TEXT NOT NULL REFERENCES "concessionnaires_reseau"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "objet"             TEXT NOT NULL,
  "description"       TEXT,
  "echeance"          DATE,
  "statut"            "StatutDemandeConcessionnaire" NOT NULL DEFAULT 'BROUILLON',
  -- Envoi FAIT HORS APPLICATION et enregistre par une personne : l'application n'envoie ni courriel ni message.
  "canalEnvoi"        TEXT,
  "dateEnvoi"         DATE,
  "referenceEnvoi"    TEXT,
  "interlocuteur"     TEXT,
  "envoyeParId"       TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "envoyeLe"          TIMESTAMP(3),
  "dateReception"     DATE,
  "recueParId"        TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "recueLe"           TIMESTAMP(3),
  -- Lien facultatif vers le jeu reçu : une information, la reception ne modifie pas le jeu (il reste en quarantaine).
  "jeuRecuId"         TEXT REFERENCES "projets_voirie_jeux"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "finParId"          TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "finLe"             TIMESTAMP(3),
  "motifFin"          TEXT,
  "creeParId"         TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "dcn_objet" CHECK (length(btrim("objet")) BETWEEN 1 AND 200),
  CONSTRAINT "dcn_textes" CHECK (
    ("description" IS NULL OR length("description") <= 4000) AND ("referenceEnvoi" IS NULL OR length("referenceEnvoi") <= 200)
    AND ("interlocuteur" IS NULL OR length("interlocuteur") <= 200) AND ("canalEnvoi" IS NULL OR length(btrim("canalEnvoi")) BETWEEN 1 AND 100)
    AND ("motifFin" IS NULL OR length("motifFin") <= 2000)),
  CONSTRAINT "dcn_envoi" CHECK (
    ("statut" = 'BROUILLON' AND "canalEnvoi" IS NULL AND "dateEnvoi" IS NULL AND "envoyeParId" IS NULL AND "envoyeLe" IS NULL)
    OR ("statut" IN ('ENVOYEE', 'RECUE', 'CLOTUREE') AND "canalEnvoi" IS NOT NULL AND "dateEnvoi" IS NOT NULL AND "envoyeParId" IS NOT NULL AND "envoyeLe" IS NOT NULL)
    OR "statut" = 'ANNULEE'),
  CONSTRAINT "dcn_reception" CHECK (
    ("statut" IN ('BROUILLON', 'ENVOYEE', 'ANNULEE') AND "dateReception" IS NULL AND "recueParId" IS NULL AND "recueLe" IS NULL AND "jeuRecuId" IS NULL)
    OR ("statut" = 'RECUE' AND "dateReception" IS NOT NULL AND "recueParId" IS NOT NULL AND "recueLe" IS NOT NULL)
    OR "statut" = 'CLOTUREE'),
  CONSTRAINT "dcn_fin" CHECK (
    ("statut" IN ('CLOTUREE', 'ANNULEE') AND "finParId" IS NOT NULL AND "finLe" IS NOT NULL AND length(btrim(coalesce("motifFin", ''))) >= 10)
    OR ("statut" NOT IN ('CLOTUREE', 'ANNULEE') AND "finParId" IS NULL AND "finLe" IS NULL AND "motifFin" IS NULL)),
  CONSTRAINT "dcn_dates" CHECK ("dateReception" IS NULL OR "dateEnvoi" IS NULL OR "dateReception" >= "dateEnvoi")
);
CREATE INDEX IF NOT EXISTS "demandes_concessionnaire_projet_idx" ON "demandes_concessionnaire" ("projetId", "createdAt", "id");
CREATE INDEX IF NOT EXISTS "demandes_concessionnaire_projet_statut_idx" ON "demandes_concessionnaire" ("projetId", "statut");
CREATE INDEX IF NOT EXISTS "demandes_concessionnaire_concessionnaire_idx" ON "demandes_concessionnaire" ("projetId", "concessionnaireId");
CREATE INDEX IF NOT EXISTS "demandes_concessionnaire_jeuRecuId_idx" ON "demandes_concessionnaire" ("jeuRecuId");

-- ===== 4. Taches =====

CREATE TABLE IF NOT EXISTS "taches_projet_voirie" (
  "id"                TEXT PRIMARY KEY,
  "projetId"          TEXT NOT NULL REFERENCES "projets_voirie"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "titre"             TEXT NOT NULL,
  "description"       TEXT,
  "conflitId"         TEXT REFERENCES "conflits_projet"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "demandeId"         TEXT REFERENCES "demandes_concessionnaire"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Deduit du lien, immuable. Il ne partage RIEN a lui seul : c'est `partagee` qui rend la tache visible des referents de ce concessionnaire.
  "concessionnaireId" TEXT REFERENCES "concessionnaires_reseau"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "partagee"          BOOLEAN NOT NULL DEFAULT false,
  "responsableId"     TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "echeance"          DATE,
  "statut"            "StatutTacheProjet" NOT NULL DEFAULT 'A_FAIRE',
  "priorite"          "PrioriteTacheProjet" NOT NULL DEFAULT 'NORMALE',
  "validationRequise" BOOLEAN NOT NULL DEFAULT false,
  "termineLe"         TIMESTAMP(3),
  "creeParId"         TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "tpv_titre" CHECK (length(btrim("titre")) BETWEEN 1 AND 200),
  CONSTRAINT "tpv_description" CHECK ("description" IS NULL OR length("description") <= 4000),
  CONSTRAINT "tpv_un_lien" CHECK ("conflitId" IS NULL OR "demandeId" IS NULL),
  CONSTRAINT "tpv_termine" CHECK (("statut" = 'TERMINEE') = ("termineLe" IS NOT NULL)),
  CONSTRAINT "tpv_validation" CHECK ("statut" <> 'A_VALIDER' OR "validationRequise"),
  CONSTRAINT "tpv_partage" CHECK (NOT "partagee" OR "concessionnaireId" IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS "taches_projet_voirie_projet_idx" ON "taches_projet_voirie" ("projetId", "createdAt", "id");
CREATE INDEX IF NOT EXISTS "taches_projet_voirie_projet_statut_idx" ON "taches_projet_voirie" ("projetId", "statut");
CREATE INDEX IF NOT EXISTS "taches_projet_voirie_concessionnaire_idx" ON "taches_projet_voirie" ("projetId", "concessionnaireId");
CREATE INDEX IF NOT EXISTS "taches_projet_voirie_responsableId_idx" ON "taches_projet_voirie" ("responsableId");
CREATE INDEX IF NOT EXISTS "taches_projet_voirie_conflitId_idx" ON "taches_projet_voirie" ("conflitId");
CREATE INDEX IF NOT EXISTS "taches_projet_voirie_demandeId_idx" ON "taches_projet_voirie" ("demandeId");

-- ===== 5. Recolements (as-built) =====

CREATE TABLE IF NOT EXISTS "recolements_projet_voirie" (
  "id"                    TEXT PRIMARY KEY,
  "projetId"              TEXT NOT NULL REFERENCES "projets_voirie"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Conflit dont un deplacement est decide, et/ou jeu (plan de recolement depose par le socle). Immuables.
  "conflitId"             TEXT REFERENCES "conflits_projet"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "jeuId"                 TEXT REFERENCES "projets_voirie_jeux"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "concessionnaireId"     TEXT REFERENCES "concessionnaires_reseau"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "objet"                 TEXT NOT NULL,
  "constat"               TEXT,
  "ecarts"                TEXT,
  "dateRecolement"        DATE,
  "statut"                "StatutRecolementProjet" NOT NULL DEFAULT 'BROUILLON',
  -- +1 a chaque modification ; l'avant/apres de chaque revision est dans workflow_projet_historique.
  "revision"              INTEGER NOT NULL DEFAULT 1,
  "soumisParId"           TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "soumisLe"              TIMESTAMP(3),
  "decideParId"           TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "decideLe"              TIMESTAMP(3),
  "motifDecision"         TEXT,
  -- Derogation motivee a la separation des taches (le valideur est le createur ou le soumissionnaire), reservee a un ADMIN par le service.
  "derogationSeparation"  TEXT,
  "creeParId"             TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "rpv_lien" CHECK ("conflitId" IS NOT NULL OR "jeuId" IS NOT NULL),
  CONSTRAINT "rpv_objet" CHECK (length(btrim("objet")) BETWEEN 1 AND 200),
  CONSTRAINT "rpv_textes" CHECK (("constat" IS NULL OR length("constat") <= 4000) AND ("ecarts" IS NULL OR length("ecarts") <= 4000)
    AND ("motifDecision" IS NULL OR length("motifDecision") <= 2000) AND ("derogationSeparation" IS NULL OR length("derogationSeparation") <= 2000)),
  CONSTRAINT "rpv_revision" CHECK ("revision" >= 1),
  CONSTRAINT "rpv_soumission" CHECK ("statut" IN ('BROUILLON') OR ("soumisParId" IS NOT NULL AND "soumisLe" IS NOT NULL)),
  CONSTRAINT "rpv_decision" CHECK (
    ("statut" IN ('VALIDE', 'REJETE') AND "decideParId" IS NOT NULL AND "decideLe" IS NOT NULL AND length(btrim(coalesce("motifDecision", ''))) >= 10)
    OR ("statut" IN ('BROUILLON', 'SOUMIS') AND "decideParId" IS NULL AND "decideLe" IS NULL AND "motifDecision" IS NULL AND "derogationSeparation" IS NULL)),
  -- Validation par un TIERS : le valideur n'est ni le createur ni le soumissionnaire, sauf derogation motivee.
  CONSTRAINT "rpv_separation" CHECK ("statut" <> 'VALIDE' OR ("decideParId" <> "creeParId" AND "decideParId" <> "soumisParId")
    OR length(btrim(coalesce("derogationSeparation", ''))) >= 10)
);
CREATE UNIQUE INDEX IF NOT EXISTS "recolements_projet_voirie_conflit_actif_key" ON "recolements_projet_voirie" ("conflitId") WHERE "conflitId" IS NOT NULL AND "statut" IN ('BROUILLON', 'SOUMIS');
CREATE UNIQUE INDEX IF NOT EXISTS "recolements_projet_voirie_jeu_actif_key" ON "recolements_projet_voirie" ("jeuId") WHERE "jeuId" IS NOT NULL AND "statut" IN ('BROUILLON', 'SOUMIS');
CREATE INDEX IF NOT EXISTS "recolements_projet_voirie_projet_idx" ON "recolements_projet_voirie" ("projetId", "createdAt", "id");
CREATE INDEX IF NOT EXISTS "recolements_projet_voirie_projet_statut_idx" ON "recolements_projet_voirie" ("projetId", "statut");
CREATE INDEX IF NOT EXISTS "recolements_projet_voirie_concessionnaire_idx" ON "recolements_projet_voirie" ("projetId", "concessionnaireId");
CREATE INDEX IF NOT EXISTS "recolements_projet_voirie_conflitId_idx" ON "recolements_projet_voirie" ("conflitId");
CREATE INDEX IF NOT EXISTS "recolements_projet_voirie_jeuId_idx" ON "recolements_projet_voirie" ("jeuId");

-- ===== 6. Preuves referencees et historique (ajout seul) =====

CREATE TABLE IF NOT EXISTS "preuves_workflow_projet" (
  "id"           TEXT PRIMARY KEY,
  "projetId"     TEXT NOT NULL REFERENCES "projets_voirie"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "objetType"    "TypeObjetWorkflow" NOT NULL,
  -- Demande, tache ou recolement selon `objetType` (pas de cle etrangere : lien polymorphe, verifie par le service).
  "objetId"      TEXT NOT NULL,
  "type"         "TypePreuveWorkflow" NOT NULL,
  "texte"        TEXT NOT NULL,
  -- REFERENCES et EMPREINTES seulement : aucun fichier n'est stocke (stockage de pieces jointes non decide).
  "reference"    TEXT,
  "nomFichier"   TEXT,
  "sha256"       TEXT,
  "tailleOctets" INTEGER,
  -- Visible du referent concessionnaire de l'objet (faux : note interne d'AGEROUTE).
  "partagee"     BOOLEAN NOT NULL DEFAULT false,
  "auteurId"     TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "auteurProfil" TEXT NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "pwp_texte" CHECK (length(btrim("texte")) BETWEEN 1 AND 4000),
  CONSTRAINT "pwp_reference" CHECK ("reference" IS NULL OR length("reference") <= 500),
  CONSTRAINT "pwp_nom" CHECK ("nomFichier" IS NULL OR length("nomFichier") <= 255),
  CONSTRAINT "pwp_sha256" CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pwp_taille" CHECK ("tailleOctets" IS NULL OR "tailleOctets" >= 0),
  CONSTRAINT "pwp_profil" CHECK ("auteurProfil" IN ('ADMIN', 'GESTIONNAIRE', 'INSPECTEUR', 'LECTEUR', 'REFERENT'))
);
CREATE INDEX IF NOT EXISTS "preuves_workflow_projet_objet_idx" ON "preuves_workflow_projet" ("objetType", "objetId", "createdAt");
CREATE INDEX IF NOT EXISTS "preuves_workflow_projet_projetId_idx" ON "preuves_workflow_projet" ("projetId");

CREATE TABLE IF NOT EXISTS "workflow_projet_historique" (
  "id"            TEXT PRIMARY KEY,
  "projetId"      TEXT NOT NULL REFERENCES "projets_voirie"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "objetType"     "TypeObjetWorkflow" NOT NULL,
  "objetId"       TEXT NOT NULL,
  "action"        "ActionHistoriqueWorkflow" NOT NULL,
  "ancienStatut"  TEXT,
  "nouveauStatut" TEXT,
  "justification" TEXT,
  "acteurId"      TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "acteurProfil"  TEXT NOT NULL,
  -- { avant, apres } des champs modifies, ou les champs de la transition. Aucune geometrie.
  "donnees"       JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "wph_donnees" CHECK (jsonb_typeof("donnees") = 'object'),
  CONSTRAINT "wph_statut" CHECK ("action" <> 'STATUT' OR ("ancienStatut" IS NOT NULL AND "nouveauStatut" IS NOT NULL AND "ancienStatut" <> "nouveauStatut")),
  CONSTRAINT "wph_profil" CHECK ("acteurProfil" IN ('ADMIN', 'GESTIONNAIRE', 'INSPECTEUR', 'LECTEUR', 'REFERENT'))
);
CREATE INDEX IF NOT EXISTS "workflow_projet_historique_objet_idx" ON "workflow_projet_historique" ("objetType", "objetId", "createdAt");
CREATE INDEX IF NOT EXISTS "workflow_projet_historique_projetId_idx" ON "workflow_projet_historique" ("projetId");

-- ===== 7. Declencheurs =====

CREATE OR REPLACE FUNCTION workflow_projet_refuse_suppression() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '% : suppression physique interdite (suppression logique uniquement, AGENTS.md regle 2)', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$fn$;

CREATE OR REPLACE FUNCTION workflow_projet_refuse_troncature() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '% : TRUNCATE interdit (le workflow des projets de voirie ne se vide pas)', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$fn$;

CREATE OR REPLACE FUNCTION workflow_projet_ajout_seul() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '% : ajout seul (un journal ou une preuve ne se modifie ni ne se supprime)', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$fn$;

-- Rattachement : seule la revocation (une fois) modifie la ligne.
CREATE OR REPLACE FUNCTION referents_concessionnaire_garde() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."concessionnaireId" IS DISTINCT FROM OLD."concessionnaireId"
     OR NEW."projetId" IS DISTINCT FROM OLD."projetId" OR NEW."creeParId" IS DISTINCT FROM OLD."creeParId"
     OR NEW."motif" IS DISTINCT FROM OLD."motif" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'referents_concessionnaire : l''identite d''un rattachement ne change pas (revoquez-le et creez-en un autre)' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."revoqueLe" IS NOT NULL THEN
    RAISE EXCEPTION 'referents_concessionnaire : un rattachement revoque ne change plus' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION demandes_concessionnaire_garde() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."projetId" IS DISTINCT FROM OLD."projetId" OR NEW."concessionnaireId" IS DISTINCT FROM OLD."concessionnaireId"
     OR NEW."creeParId" IS DISTINCT FROM OLD."creeParId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'demandes_concessionnaire : identite de la demande immuable (projet, concessionnaire, createur)' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."statut" IN ('CLOTUREE', 'ANNULEE') THEN
    RAISE EXCEPTION 'demandes_concessionnaire : une demande close ou annulee ne change plus' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION taches_projet_voirie_garde() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."projetId" IS DISTINCT FROM OLD."projetId" OR NEW."conflitId" IS DISTINCT FROM OLD."conflitId" OR NEW."demandeId" IS DISTINCT FROM OLD."demandeId"
     OR NEW."concessionnaireId" IS DISTINCT FROM OLD."concessionnaireId" OR NEW."validationRequise" IS DISTINCT FROM OLD."validationRequise"
     OR NEW."creeParId" IS DISTINCT FROM OLD."creeParId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'taches_projet_voirie : identite de la tache immuable (projet, liens, concessionnaire, validation requise, createur)' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."statut" IN ('TERMINEE', 'ANNULEE') THEN
    RAISE EXCEPTION 'taches_projet_voirie : une tache terminee ou annulee ne change plus' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION recolements_projet_voirie_garde() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."projetId" IS DISTINCT FROM OLD."projetId" OR NEW."conflitId" IS DISTINCT FROM OLD."conflitId" OR NEW."jeuId" IS DISTINCT FROM OLD."jeuId"
     OR NEW."concessionnaireId" IS DISTINCT FROM OLD."concessionnaireId" OR NEW."creeParId" IS DISTINCT FROM OLD."creeParId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'recolements_projet_voirie : identite du recolement immuable (projet, liens, concessionnaire, createur)' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."statut" = 'VALIDE' THEN
    RAISE EXCEPTION 'recolements_projet_voirie : un recolement valide ne change plus (creez un nouveau recolement)' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS referents_concessionnaire_suppression ON "referents_concessionnaire";
CREATE TRIGGER referents_concessionnaire_suppression BEFORE DELETE ON "referents_concessionnaire" FOR EACH ROW EXECUTE FUNCTION workflow_projet_refuse_suppression();
DROP TRIGGER IF EXISTS referents_concessionnaire_modification ON "referents_concessionnaire";
CREATE TRIGGER referents_concessionnaire_modification BEFORE UPDATE ON "referents_concessionnaire" FOR EACH ROW EXECUTE FUNCTION referents_concessionnaire_garde();

DROP TRIGGER IF EXISTS demandes_concessionnaire_suppression ON "demandes_concessionnaire";
CREATE TRIGGER demandes_concessionnaire_suppression BEFORE DELETE ON "demandes_concessionnaire" FOR EACH ROW EXECUTE FUNCTION workflow_projet_refuse_suppression();
DROP TRIGGER IF EXISTS demandes_concessionnaire_modification ON "demandes_concessionnaire";
CREATE TRIGGER demandes_concessionnaire_modification BEFORE UPDATE ON "demandes_concessionnaire" FOR EACH ROW EXECUTE FUNCTION demandes_concessionnaire_garde();

DROP TRIGGER IF EXISTS taches_projet_voirie_suppression ON "taches_projet_voirie";
CREATE TRIGGER taches_projet_voirie_suppression BEFORE DELETE ON "taches_projet_voirie" FOR EACH ROW EXECUTE FUNCTION workflow_projet_refuse_suppression();
DROP TRIGGER IF EXISTS taches_projet_voirie_modification ON "taches_projet_voirie";
CREATE TRIGGER taches_projet_voirie_modification BEFORE UPDATE ON "taches_projet_voirie" FOR EACH ROW EXECUTE FUNCTION taches_projet_voirie_garde();

DROP TRIGGER IF EXISTS recolements_projet_voirie_suppression ON "recolements_projet_voirie";
CREATE TRIGGER recolements_projet_voirie_suppression BEFORE DELETE ON "recolements_projet_voirie" FOR EACH ROW EXECUTE FUNCTION workflow_projet_refuse_suppression();
DROP TRIGGER IF EXISTS recolements_projet_voirie_modification ON "recolements_projet_voirie";
CREATE TRIGGER recolements_projet_voirie_modification BEFORE UPDATE ON "recolements_projet_voirie" FOR EACH ROW EXECUTE FUNCTION recolements_projet_voirie_garde();

DROP TRIGGER IF EXISTS preuves_workflow_projet_ajout_seul ON "preuves_workflow_projet";
CREATE TRIGGER preuves_workflow_projet_ajout_seul BEFORE UPDATE OR DELETE ON "preuves_workflow_projet" FOR EACH ROW EXECUTE FUNCTION workflow_projet_ajout_seul();
DROP TRIGGER IF EXISTS workflow_projet_historique_ajout_seul ON "workflow_projet_historique";
CREATE TRIGGER workflow_projet_historique_ajout_seul BEFORE UPDATE OR DELETE ON "workflow_projet_historique" FOR EACH ROW EXECUTE FUNCTION workflow_projet_ajout_seul();

DO $tr$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['referents_concessionnaire', 'demandes_concessionnaire', 'taches_projet_voirie', 'recolements_projet_voirie', 'preuves_workflow_projet', 'workflow_projet_historique'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_troncature', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION workflow_projet_refuse_troncature()', t || '_troncature', t);
  END LOOP;
END
$tr$;

COMMENT ON TABLE "referents_concessionnaire" IS 'Rattachement d''un compte LECTEUR a un concessionnaire pour un projet (attribut de compte, pas un role). Se revoque, ne se supprime pas. Contrat : docs/projets-voirie/CONTRAT-WORKFLOW.md';
COMMENT ON TABLE "demandes_concessionnaire" IS 'Demandes de donnees aux concessionnaires. L''envoi se fait HORS application : la table l''enregistre, elle n''envoie rien.';
COMMENT ON TABLE "taches_projet_voirie" IS 'Taches liees a un projet, un conflit ou une demande (responsable, echeance, statut, priorite).';
COMMENT ON TABLE "recolements_projet_voirie" IS 'Recolements (as-built) valides par un tiers. Valider ne modifie ni le referentiel, ni un jeu, ni un conflit.';
COMMENT ON TABLE "preuves_workflow_projet" IS 'Preuves REFERENCEES (texte, reference, nom, SHA-256) : aucun fichier n''est stocke. Ajout seul.';
COMMENT ON TABLE "workflow_projet_historique" IS 'Historique du workflow (avant/apres, auteur, profil, justification) : ajout seul.';

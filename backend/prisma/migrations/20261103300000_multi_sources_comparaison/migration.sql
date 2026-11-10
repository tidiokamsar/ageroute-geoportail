-- SOURCES MULTIPLES D'UN RESEAU, COMPARAISON ENTRE SOURCES ET CONNECTIVITE DECLARATIVE (lot S1)
--
-- Contrat : docs/projets-voirie/CONTRAT-SOURCES.md. Decision architecturale 2 (08/11/2026), sections 4 et 5. Cahier v2 : 6.1 (conflit de
-- donnees : plusieurs sources, chaque source preservee), 20.3 (la proximite ne prouve pas une connexion), 21.1 (ne pas additionner les precisions).
--
-- CE QUE CETTE MIGRATION FAIT (ADDITIVE : aucune colonne ni table existante n'est supprimee, aucune ligne n'est modifiee)
--
--   1. `projets_voirie_jeux.methodeAcquisition` : code court (forme verifiee ici, liste verifiee par le service, reliable au referentiel du lot T1).
--      Les deux index uniques partiels du socle (un seul AUTORISE, un seul depot en attente par projet, role, concessionnaire) sont RECREES avec la
--      methode d'acquisition en quatrieme composante POUR LES RESEAUX DE CONCESSIONNAIRE SEULEMENT : un second fichier du meme concessionnaire avec
--      une autre methode est une SECONDE SOURCE (version 1, aucun remplacement) ; avec la meme methode (ou sans), c'est une nouvelle VERSION. Pour
--      les autres roles (plan d'axes, limites de route), la methode est enregistree mais ne separe pas les lignees : un nouveau plan d'axes reste
--      une version (deux plans d'axes autorises a la fois doubleraient les axes de l'analyse). Les jeux existants gardent le comportement du socle.
--   2. `regles_rapprochement_sources` : regles de rapprochement VERSIONNEES et APPROUVEES (marge, rayon d'appariement, part hors corridor toleree,
--      precision attribuee par classe), par projet et par famille ou generales ; regle approuvee immuable ; regle par defaut S1-CORRIDOR-0.1 creee ici.
--   3. `comparaisons_sources_projet` (immuable) et `comparaisons_sources_resultats` (ajout seul, sauf le lien vers un dossier de conflit, ecrit une fois) :
--      une comparaison est reproductible (empreintes et versions des deux jeux, regle, algorithme, instantane) ; un resultat par objet ; aucune geometrie.
--   4. Relations (lot B1) : valeur `CONNECTE_A` du type de relation, valeur `IMPORT_DECLARATIF` de l'origine, colonne `preuve` (CONFIRMEE_PAR_FOURNISSEUR,
--      INCONNUE) obligatoire pour CONNECTE_A et interdite pour les autres types. Le declencheur de controle des relations est remplace pour admettre
--      CONNECTE_A entre deux objets PHYSIQUES (infrastructure ou equipement) du meme projet. AUCUNE connexion n'est calculee par la base ni par le code.
--   5. Dossiers de conflit (lot RC-3) : `premiereAnalyseId` et `derniereAnalyseId` deviennent nullables, colonne `comparaisonId` ajoutee ; une
--      contrainte impose : un dossier DIVERGENCE_SOURCES porte une comparaison et aucune analyse ; tout autre type porte ses deux analyses et aucune
--      comparaison. Un dossier de divergence n'est cree que par une action humaine justifiee.
--
-- Idempotente (IF NOT EXISTS, ADD VALUE IF NOT EXISTS, regle par defaut ON CONFLICT). Les nouvelles valeurs d'enumeration ne sont jamais employees
-- comme litteral type dans cette migration (comparaisons sur ::text) : le script reste applicable dans une seule transaction (PostgreSQL 12+).
-- Exige les migrations 20261030100000 (socle), 20261031100000 (conflits) et 20261101200000 (reseaux B1) et PostGIS.

-- ===== 1. Methode d'acquisition et cle de version des jeux =====

ALTER TABLE "projets_voirie_jeux" ADD COLUMN IF NOT EXISTS "methodeAcquisition" TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pvj_methode_acquisition_forme') THEN
    ALTER TABLE "projets_voirie_jeux" ADD CONSTRAINT "pvj_methode_acquisition_forme" CHECK ("methodeAcquisition" IS NULL OR "methodeAcquisition" ~ '^[A-Z][A-Z0-9_]{1,39}$');
  END IF;
END $$;
COMMENT ON COLUMN "projets_voirie_jeux"."methodeAcquisition" IS 'Code de la methode d''acquisition (GNSS_RTK, GEORADAR, NUMERISATION_PLAN...) : liste du service (config.ts), reliable au referentiel METHODE_ACQUISITION (lot T1). Nul = non renseignee. Composante de la cle de version : deux methodes = deux sources du meme reseau.';

-- Cle de version etendue : (projet, role, concessionnaire, methode). Les index du socle ne representent pas une colonne nullable autrement que par COALESCE.
DROP INDEX IF EXISTS "projets_voirie_jeux_cle_autorise_key";
CREATE UNIQUE INDEX IF NOT EXISTS "projets_voirie_jeux_cle_autorise_key" ON "projets_voirie_jeux" ("projetId", "role", COALESCE("concessionnaireId", ''), (CASE WHEN "role" = 'RESEAU_TIERS' THEN COALESCE("methodeAcquisition", '') ELSE '' END))
  WHERE "statut" = 'AUTORISE' AND "role" <> 'AUTRE';
DROP INDEX IF EXISTS "projets_voirie_jeux_cle_attente_key";
CREATE UNIQUE INDEX IF NOT EXISTS "projets_voirie_jeux_cle_attente_key" ON "projets_voirie_jeux" ("projetId", "role", COALESCE("concessionnaireId", ''), (CASE WHEN "role" = 'RESEAU_TIERS' THEN COALESCE("methodeAcquisition", '') ELSE '' END))
  WHERE "statut" IN ('RECU', 'CONTROLE') AND "role" <> 'AUTRE';

-- ===== 2. Types =====

DO $$ BEGIN CREATE TYPE "StatutResultatComparaison" AS ENUM ('CONCORDANCE', 'DIVERGENCE', 'RAPPROCHEMENT_INCERTAIN', 'SANS_CORRESPONDANCE_A', 'SANS_CORRESPONDANCE_B'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "PreuveConnexionReseau" AS ENUM ('CONFIRMEE_PAR_FOURNISSEUR', 'INCONNUE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TYPE "TypeRelationReseau" ADD VALUE IF NOT EXISTS 'CONNECTE_A';
ALTER TYPE "OrigineRelationReseau" ADD VALUE IF NOT EXISTS 'IMPORT_DECLARATIF';

-- ===== 3. Regles de rapprochement (versionnees, approuvees) =====

CREATE TABLE IF NOT EXISTS "regles_rapprochement_sources" (
  "id"                    TEXT PRIMARY KEY,
  -- Nul : regle generale (tous les projets). Une regle creee par la route est toujours rattachee a son projet.
  "projetId"              TEXT REFERENCES "projets_voirie"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Nulle : toutes les familles de reseau.
  "famille"               "TypeReseauTiers",
  "code"                  TEXT NOT NULL,
  -- Croissante par (projetId, famille, code). 0 : la regle par defaut.
  "version"               INTEGER NOT NULL,
  -- Marge ajoutee au maximum des deux precisions declarees : corridor = max(pA, pB) + marge (decision 2 : 1 m par defaut).
  "margeM"                DECIMAL(6,2) NOT NULL DEFAULT 1,
  -- Au-dela de cette distance, deux objets ne sont meme plus candidats a l'appariement (PROVISOIRE, a valider).
  "rayonAppariementM"     DECIMAL(8,2) NOT NULL DEFAULT 10,
  -- Part de la longueur de A hors du corridor de B toleree pour une concordance (0 = stricte).
  "partHorsCorridorMax"   DECIMAL(5,4) NOT NULL DEFAULT 0,
  -- Precision (m) attribuee a un objet qui declare une classe SANS precision metrique ; E : aucune (inconnue). PROVISOIRE (valeurs de B1).
  "precisionParClasseM"   JSONB NOT NULL DEFAULT '{"A": 0.5, "B": 1, "C": 2, "D": 5}'::jsonb,
  "statut"                "StatutRegleConflit" NOT NULL DEFAULT 'BROUILLON',
  "justification"         TEXT NOT NULL,
  -- Nul seulement pour la regle systeme (S1-CORRIDOR-0.1, version 0).
  "creeParId"             TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "approuveParId"         TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "approuveLe"            TIMESTAMP(3),
  "motifApprobation"      TEXT,
  "derogationApprobation" TEXT,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "rrs_code_format" CHECK ("code" ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$'),
  CONSTRAINT "rrs_version" CHECK ("version" >= 0),
  CONSTRAINT "rrs_marge" CHECK ("margeM" >= 0 AND "margeM" <= 100),
  CONSTRAINT "rrs_rayon" CHECK ("rayonAppariementM" >= 0.01 AND "rayonAppariementM" <= 1000),
  CONSTRAINT "rrs_part" CHECK ("partHorsCorridorMax" >= 0 AND "partHorsCorridorMax" <= 1),
  CONSTRAINT "rrs_precisions_classe" CHECK (jsonb_typeof("precisionParClasseM") = 'object'),
  CONSTRAINT "rrs_justification" CHECK (length(btrim("justification")) >= 10),
  CONSTRAINT "rrs_systeme" CHECK ("creeParId" IS NOT NULL OR ("projetId" IS NULL AND "famille" IS NULL AND "version" = 0 AND "statut" = 'APPROUVEE')),
  CONSTRAINT "rrs_version_utilisateur" CHECK ("creeParId" IS NULL OR "version" >= 1),
  CONSTRAINT "rrs_approbation" CHECK (
    ("statut" = 'BROUILLON' AND "approuveParId" IS NULL AND "approuveLe" IS NULL)
    OR ("statut" = 'APPROUVEE' AND "approuveLe" IS NOT NULL AND ("approuveParId" IS NOT NULL OR "creeParId" IS NULL))
    OR "statut" = 'RETIREE'),
  CONSTRAINT "rrs_derogation" CHECK ("derogationApprobation" IS NULL OR length(btrim("derogationApprobation")) >= 10)
);
CREATE UNIQUE INDEX IF NOT EXISTS "regles_rapprochement_sources_version_key" ON "regles_rapprochement_sources" ("projetId", "famille", "code", "version") NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS "regles_rapprochement_sources_projetId_statut_idx" ON "regles_rapprochement_sources" ("projetId", "statut");

-- ===== 4. Comparaisons persistees (immuables) et resultats par objet (ajout seul) =====

CREATE TABLE IF NOT EXISTS "comparaisons_sources_projet" (
  "id"                TEXT PRIMARY KEY,
  "projetId"          TEXT NOT NULL REFERENCES "projets_voirie"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "numero"            INTEGER NOT NULL,
  "statut"            "StatutAnalyseConflit" NOT NULL,
  -- SOURCES : deux jeux AUTORISE d'un meme reseau ; VERSION_CANDIDATE : un jeu en controle face au jeu AUTORISE qu'il remplacera (comparer avant d'autoriser).
  "mode"              TEXT NOT NULL DEFAULT 'SOURCES',
  -- Role commun des deux jeux : RESEAU_TIERS (reseau de concessionnaire) ou AXES_TRAVAUX (plan d'axes du projet).
  "role"              "RoleJeuProjet" NOT NULL DEFAULT 'RESEAU_TIERS',
  -- Les deux sources, ordonnees par le serveur : A = la reference (le jeu autorise, ou le depot le plus ancien), B = l'autre.
  "jeuAId"            TEXT NOT NULL REFERENCES "projets_voirie_jeux"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "jeuBId"            TEXT NOT NULL REFERENCES "projets_voirie_jeux"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "concessionnaireId" TEXT REFERENCES "concessionnaires_reseau"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "typeReseau"        "TypeReseauTiers",
  -- { regleId, code, version, portee, margeM, rayonAppariementM, partHorsCorridorMax, precisionParClasseM }
  "regle"             JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- [{ role: 'A'|'B', jeuId, sha256, version, methodeAcquisition, dateDonnees, classePrecision, precisionHorizontaleM, nbObjets, nomFichier }]
  "jeux"              JSONB NOT NULL DEFAULT '[]'::jsonb,
  "versionAlgorithme" TEXT NOT NULL,
  "epsg"              INTEGER,
  "resume"            JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- { <cle du resultat> : '<statut>|<empreinte de mesure>' } : rejeu et comparaison de deux comparaisons.
  "instantane"        JSONB NOT NULL DEFAULT '{}'::jsonb,
  "declencheParId"    TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "duree"             INTEGER NOT NULL DEFAULT 0,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "csp_numero" CHECK ("numero" >= 1),
  CONSTRAINT "csp_jeux_distincts" CHECK ("jeuAId" <> "jeuBId"),
  CONSTRAINT "csp_mode" CHECK ("mode" IN ('SOURCES', 'VERSION_CANDIDATE')),
  CONSTRAINT "csp_role" CHECK ("role" IN ('RESEAU_TIERS', 'AXES_TRAVAUX')),
  CONSTRAINT "csp_duree" CHECK ("duree" >= 0),
  CONSTRAINT "csp_json_formes" CHECK (jsonb_typeof("regle") = 'object' AND jsonb_typeof("jeux") = 'array' AND jsonb_typeof("resume") = 'object' AND jsonb_typeof("instantane") = 'object')
);
CREATE UNIQUE INDEX IF NOT EXISTS "comparaisons_sources_projet_projetId_numero_key" ON "comparaisons_sources_projet" ("projetId", "numero");
CREATE INDEX IF NOT EXISTS "comparaisons_sources_projet_jeuAId_idx" ON "comparaisons_sources_projet" ("jeuAId");
CREATE INDEX IF NOT EXISTS "comparaisons_sources_projet_jeuBId_idx" ON "comparaisons_sources_projet" ("jeuBId");

CREATE TABLE IF NOT EXISTS "comparaisons_sources_resultats" (
  "id"             TEXT PRIMARY KEY,
  "comparaisonId"  TEXT NOT NULL REFERENCES "comparaisons_sources_projet"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "projetId"       TEXT NOT NULL REFERENCES "projets_voirie"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Rang deterministe dans la comparaison (1, 2, 3...) : support du curseur de pagination.
  "ordre"          INTEGER NOT NULL,
  -- Empreinte SHA-256 stable : projet, identite de l'objet A et de l'objet B (nom normalise, sinon empreinte de geometrie), jamais les identifiants.
  "cle"            TEXT NOT NULL,
  "statut"         "StatutResultatComparaison" NOT NULL,
  "objetAId"       BIGINT REFERENCES "projets_voirie_objets"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "objetBId"       BIGINT REFERENCES "projets_voirie_objets"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "nomA"           TEXT,
  "nomB"           TEXT,
  "precisionAM"    DECIMAL(8,2),
  "precisionBM"    DECIMAL(8,2),
  -- OBJET (descripteur), JEU, CLASSE (precision attribuee par la regle a la classe declaree), INCONNUE.
  "origineA"       TEXT NOT NULL DEFAULT 'INCONNUE',
  "origineB"       TEXT NOT NULL DEFAULT 'INCONNUE',
  -- Nul : corridor inconnu (une precision manque) : aucune mesure de divergence.
  "corridorM"      DECIMAL(8,2),
  -- { hausdorffM, longueurAM, longueurBM, longueurRecouvrementM, longueurHorsCorridorM, partHorsCorridor, distanceMinM } ; nulle si incertain.
  "mesure"         JSONB,
  -- Dossier de conflit DIVERGENCE_SOURCES ouvert depuis ce resultat par une action humaine : ecrit UNE fois (de nul vers une valeur).
  "conflitId"      TEXT REFERENCES "conflits_projet"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "csr_ordre" CHECK ("ordre" >= 1),
  CONSTRAINT "csr_cle_format" CHECK ("cle" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "csr_origines" CHECK ("origineA" IN ('OBJET', 'JEU', 'CLASSE', 'INCONNUE') AND "origineB" IN ('OBJET', 'JEU', 'CLASSE', 'INCONNUE')),
  CONSTRAINT "csr_objets" CHECK (
    ("statut" = 'SANS_CORRESPONDANCE_A' AND "objetAId" IS NOT NULL AND "objetBId" IS NULL)
    OR ("statut" = 'SANS_CORRESPONDANCE_B' AND "objetAId" IS NULL AND "objetBId" IS NOT NULL)
    OR ("statut" IN ('CONCORDANCE', 'DIVERGENCE', 'RAPPROCHEMENT_INCERTAIN') AND "objetAId" IS NOT NULL AND "objetBId" IS NOT NULL)),
  CONSTRAINT "csr_corridor_mesure" CHECK (
    ("statut" IN ('CONCORDANCE', 'DIVERGENCE') AND "corridorM" IS NOT NULL AND "mesure" IS NOT NULL)
    OR ("statut" = 'RAPPROCHEMENT_INCERTAIN' AND "corridorM" IS NULL)
    OR "statut" IN ('SANS_CORRESPONDANCE_A', 'SANS_CORRESPONDANCE_B')),
  CONSTRAINT "csr_mesure_forme" CHECK ("mesure" IS NULL OR jsonb_typeof("mesure") = 'object')
);
CREATE UNIQUE INDEX IF NOT EXISTS "comparaisons_sources_resultats_ordre_key" ON "comparaisons_sources_resultats" ("comparaisonId", "ordre");
CREATE UNIQUE INDEX IF NOT EXISTS "comparaisons_sources_resultats_cle_key" ON "comparaisons_sources_resultats" ("comparaisonId", "cle");
CREATE INDEX IF NOT EXISTS "comparaisons_sources_resultats_statut_idx" ON "comparaisons_sources_resultats" ("comparaisonId", "statut", "ordre");
CREATE INDEX IF NOT EXISTS "comparaisons_sources_resultats_conflitId_idx" ON "comparaisons_sources_resultats" ("conflitId");

-- ===== 5. Relations : preuve de connexion =====

ALTER TABLE "reseau_relations" ADD COLUMN IF NOT EXISTS "preuve" "PreuveConnexionReseau";
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rr_preuve_connexion') THEN
    -- Comparaison sur le texte : la valeur CONNECTE_A vient d'etre ajoutee au type et ne peut pas encore servir de litteral dans cette transaction.
    ALTER TABLE "reseau_relations" ADD CONSTRAINT "rr_preuve_connexion" CHECK (("typeRelation"::text = 'CONNECTE_A') = ("preuve" IS NOT NULL));
  END IF;
END $$;
-- Une relation declaree (a la main ou par un fichier importe) est une decision : elle n'est jamais « proposee ».
ALTER TABLE "reseau_relations" DROP CONSTRAINT IF EXISTS "rr_manuelle_decidee";
ALTER TABLE "reseau_relations" ADD CONSTRAINT "rr_manuelle_decidee" CHECK ("origine"::text NOT IN ('MANUELLE', 'IMPORT_DECLARATIF') OR "statut" <> 'PROPOSEE');
COMMENT ON COLUMN "reseau_relations"."preuve" IS 'Preuve d''une connexion declaree (CONNECTE_A seulement) : CONFIRMEE_PAR_FOURNISSEUR ou INCONNUE. Jamais deduite d''une proximite.';

-- Declencheur de controle des relations (B1), remplace : CONNECTE_A relie deux objets PHYSIQUES (infrastructure ou equipement) du meme projet ;
-- la preuve est figee. Le reste est inchange (PORTE_PAR, CONTENU_DANS, extremites figees).
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
       OR NEW."createdAt" <> OLD."createdAt" OR NEW."proposition" IS DISTINCT FROM OLD."proposition" OR NEW."preuve" IS DISTINCT FROM OLD."preuve" THEN
      RAISE EXCEPTION 'reseau_relations : seuls le statut et la decision d''une relation changent (extremites, type, origine, proposition et preuve sont figes)'
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
  IF NEW."typeRelation"::text = 'CONNECTE_A' THEN
    -- Lot S1 : une connexion DECLAREE entre deux objets physiques. Un circuit logique ne se connecte pas : il est porte (PORTE_PAR).
    IF ns NOT IN ('ACTIF_PHYSIQUE', 'EQUIPEMENT') OR nc NOT IN ('ACTIF_PHYSIQUE', 'EQUIPEMENT') THEN
      RAISE EXCEPTION 'reseau_relations : CONNECTE_A relie deux objets physiques (infrastructure ou equipement ; recu : % -> %)', ns, nc USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."typeRelation"::text = 'PORTE_PAR' THEN
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

-- ===== 6. Dossiers de conflit : origine « comparaison de sources » =====

ALTER TABLE "conflits_projet" ALTER COLUMN "premiereAnalyseId" DROP NOT NULL;
ALTER TABLE "conflits_projet" ALTER COLUMN "derniereAnalyseId" DROP NOT NULL;
ALTER TABLE "conflits_projet" ADD COLUMN IF NOT EXISTS "comparaisonId" TEXT REFERENCES "comparaisons_sources_projet"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS "conflits_projet_comparaisonId_idx" ON "conflits_projet" ("comparaisonId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cp_origine_coherente') THEN
    ALTER TABLE "conflits_projet" ADD CONSTRAINT "cp_origine_coherente" CHECK (
      ("type" = 'DIVERGENCE_SOURCES' AND "comparaisonId" IS NOT NULL AND "premiereAnalyseId" IS NULL AND "derniereAnalyseId" IS NULL)
      OR ("type" <> 'DIVERGENCE_SOURCES' AND "comparaisonId" IS NULL AND "premiereAnalyseId" IS NOT NULL AND "derniereAnalyseId" IS NOT NULL));
  END IF;
END $$;
COMMENT ON COLUMN "conflits_projet"."comparaisonId" IS 'Comparaison de sources (lot S1) dont est issu un dossier DIVERGENCE_SOURCES, ouvert par une action humaine justifiee ; nul pour les dossiers calcules par une analyse.';

-- ===== 7. Declencheurs des tables du lot =====

CREATE OR REPLACE FUNCTION sources_refuse_suppression() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '% : suppression physique interdite (suppression logique uniquement, AGENTS.md regle 2)', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END
$fn$;

CREATE OR REPLACE FUNCTION sources_refuse_troncature() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '% : TRUNCATE interdit (regles, comparaisons et resultats ne se vident pas)', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END
$fn$;

CREATE OR REPLACE FUNCTION sources_ajout_seul() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '% : ajout seul (une comparaison ne se modifie ni ne se supprime)', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END
$fn$;

-- Une regle approuvee est immuable ; un brouillon ne change que par son approbation (ou son retrait) : meme regle que RC-3.
CREATE OR REPLACE FUNCTION regles_rapprochement_immuable() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."projetId" IS DISTINCT FROM OLD."projetId" OR NEW."famille" IS DISTINCT FROM OLD."famille" OR NEW."code" IS DISTINCT FROM OLD."code"
     OR NEW."version" IS DISTINCT FROM OLD."version" OR NEW."margeM" IS DISTINCT FROM OLD."margeM" OR NEW."rayonAppariementM" IS DISTINCT FROM OLD."rayonAppariementM"
     OR NEW."partHorsCorridorMax" IS DISTINCT FROM OLD."partHorsCorridorMax" OR NEW."precisionParClasseM" IS DISTINCT FROM OLD."precisionParClasseM"
     OR NEW."justification" IS DISTINCT FROM OLD."justification" OR NEW."creeParId" IS DISTINCT FROM OLD."creeParId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'regles_rapprochement_sources : une regle ne se modifie pas (creez une nouvelle version)' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."statut" <> 'BROUILLON' THEN
    IF NOT (OLD."statut" = 'APPROUVEE' AND NEW."statut" = 'RETIREE'
            AND NEW."approuveParId" IS NOT DISTINCT FROM OLD."approuveParId" AND NEW."approuveLe" IS NOT DISTINCT FROM OLD."approuveLe"
            AND NEW."motifApprobation" IS NOT DISTINCT FROM OLD."motifApprobation" AND NEW."derogationApprobation" IS NOT DISTINCT FROM OLD."derogationApprobation") THEN
      RAISE EXCEPTION 'regles_rapprochement_sources : une regle approuvee est immuable (nouvelle version pour la changer)' USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF NEW."statut" = 'BROUILLON' THEN
    RAISE EXCEPTION 'regles_rapprochement_sources : un brouillon se modifie en etant approuve ou retire, jamais reecrit' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$fn$;

-- Un resultat est fige ; seul le lien vers un dossier de conflit s'ecrit, une fois (de nul vers une valeur), par une action humaine.
CREATE OR REPLACE FUNCTION comparaisons_sources_resultats_garde() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."comparaisonId" IS DISTINCT FROM OLD."comparaisonId" OR NEW."projetId" IS DISTINCT FROM OLD."projetId" OR NEW."ordre" IS DISTINCT FROM OLD."ordre"
     OR NEW."cle" IS DISTINCT FROM OLD."cle" OR NEW."statut" IS DISTINCT FROM OLD."statut" OR NEW."objetAId" IS DISTINCT FROM OLD."objetAId" OR NEW."objetBId" IS DISTINCT FROM OLD."objetBId"
     OR NEW."nomA" IS DISTINCT FROM OLD."nomA" OR NEW."nomB" IS DISTINCT FROM OLD."nomB" OR NEW."precisionAM" IS DISTINCT FROM OLD."precisionAM" OR NEW."precisionBM" IS DISTINCT FROM OLD."precisionBM"
     OR NEW."origineA" IS DISTINCT FROM OLD."origineA" OR NEW."origineB" IS DISTINCT FROM OLD."origineB" OR NEW."corridorM" IS DISTINCT FROM OLD."corridorM"
     OR NEW."mesure" IS DISTINCT FROM OLD."mesure" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'comparaisons_sources_resultats : un resultat de comparaison est fige (seul le lien vers un dossier de conflit s''ecrit, une fois)' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."conflitId" IS NOT NULL AND NEW."conflitId" IS DISTINCT FROM OLD."conflitId" THEN
    RAISE EXCEPTION 'comparaisons_sources_resultats : le dossier de conflit d''un resultat ne change plus' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS regles_rapprochement_sources_suppression ON "regles_rapprochement_sources";
CREATE TRIGGER regles_rapprochement_sources_suppression BEFORE DELETE ON "regles_rapprochement_sources" FOR EACH ROW EXECUTE FUNCTION sources_refuse_suppression();
DROP TRIGGER IF EXISTS regles_rapprochement_sources_modification ON "regles_rapprochement_sources";
CREATE TRIGGER regles_rapprochement_sources_modification BEFORE UPDATE ON "regles_rapprochement_sources" FOR EACH ROW EXECUTE FUNCTION regles_rapprochement_immuable();
DROP TRIGGER IF EXISTS comparaisons_sources_projet_ajout_seul ON "comparaisons_sources_projet";
CREATE TRIGGER comparaisons_sources_projet_ajout_seul BEFORE UPDATE OR DELETE ON "comparaisons_sources_projet" FOR EACH ROW EXECUTE FUNCTION sources_ajout_seul();
DROP TRIGGER IF EXISTS comparaisons_sources_resultats_suppression ON "comparaisons_sources_resultats";
CREATE TRIGGER comparaisons_sources_resultats_suppression BEFORE DELETE ON "comparaisons_sources_resultats" FOR EACH ROW EXECUTE FUNCTION sources_refuse_suppression();
DROP TRIGGER IF EXISTS comparaisons_sources_resultats_garde ON "comparaisons_sources_resultats";
CREATE TRIGGER comparaisons_sources_resultats_garde BEFORE UPDATE ON "comparaisons_sources_resultats" FOR EACH ROW EXECUTE FUNCTION comparaisons_sources_resultats_garde();
DO $tr$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['regles_rapprochement_sources', 'comparaisons_sources_projet', 'comparaisons_sources_resultats'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_troncature', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION sources_refuse_troncature()', t || '_troncature', t);
  END LOOP;
END
$tr$;

-- ===== 8. Regle par defaut S1-CORRIDOR-0.1 =====
-- Version 0, APPROUVEE par construction, sans auteur. Marge 1 m (decision architecturale 2) ; rayon, part et precisions par classe PROVISOIRES (a valider).
INSERT INTO "regles_rapprochement_sources" ("id", "projetId", "famille", "code", "version", "margeM", "rayonAppariementM", "partHorsCorridorMax", "precisionParClasseM", "statut", "justification", "creeParId", "approuveParId", "approuveLe", "motifApprobation")
VALUES ('00000000-0000-4000-8000-00000000c501', NULL, NULL, 'S1-CORRIDOR-0.1', 0, 1, 10, 0, '{"A": 0.5, "B": 1, "C": 2, "D": 5}'::jsonb, 'APPROUVEE',
        'Regle par defaut du lot S1 : corridor = max(precision A, precision B) + 1 m, applicable seulement quand les deux precisions sont connues ; rayon d''appariement 10 m, concordance stricte, precisions par classe reprises des tolerances provisoires du lot B1.',
        NULL, NULL, CURRENT_TIMESTAMP, 'Regle systeme creee par la migration 20261103300000 : version 0, approuvee par construction ; valeurs provisoires a valider par le DSI.')
ON CONFLICT DO NOTHING;

COMMENT ON TABLE "regles_rapprochement_sources" IS 'Regles de rapprochement entre deux sources d''un meme reseau, versionnees et approuvees (corridor = max des precisions declarees + marge). Contrat : docs/projets-voirie/CONTRAT-SOURCES.md';
COMMENT ON TABLE "comparaisons_sources_projet" IS 'Comparaisons persistees entre deux sources d''un reseau : reproductibles (jeux, regle, algorithme, instantane), immuables. Un resultat n''est jamais une decision.';
COMMENT ON TABLE "comparaisons_sources_resultats" IS 'Resultat d''une comparaison par objet : concordance, divergence mesuree, rapprochement incertain, sans correspondance. Aucune geometrie. Fige, sauf le lien vers un dossier de conflit ouvert par une personne.';

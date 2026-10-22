-- MOTEUR DE RISQUE ET DE PROGRAMMATION (paragraphe 7.7, scenario d'acceptation A22)
--
-- « Programmation reproductible, justifiee, fiche figee. » Cette migration pose les quatre tables
-- qui permettent de GARDER ce que le moteur calcule, sans rien presenter comme officiel :
--
--   parametres_programmation       ponderations et seuils, VERSIONNES, administrables, PROVISOIRES
--   scenarios_programmation        un scenario annuel calcule : entrees et resultat canoniques, scelles
--   fiches_intervention            la fiche FIGEE : texte canonique + empreinte SHA-256, immuable
--   fiches_intervention_statuts    le cycle de vie de la fiche, en ajout seul
--
-- RIEN N'EST OFFICIEL ICI
--
-- Les valeurs d'amorcage semees ci-dessous n'ont AUCUNE source : ce sont des valeurs de simulation,
-- etiquetees `amorcage_provisoire`, jamais approuvees (`approuveeLe` nul). Le meme jeu vit dans
-- `backend/src/programmation/parametres.noyau.ts`, et un test compare les deux. Les approuver est
-- une decision d'AGEROUTE (D-01 pour l'etat, D-07 pour les couts, aucune decision encore pour les
-- quatre autres facteurs du risque), pas une livraison.
--
-- LES TROIS REGLES D'IMMUTABILITE, ET POURQUOI ELLES SONT DES DECLENCHEURS
--
-- Comme `main_courante` et `bulletins_routiers`, ces tables tiennent leur invariant par un
-- declencheur, parce qu'une contrainte CHECK ne regarde qu'une ligne a la fois et qu'une absence de
-- route UPDATE ne protege pas d'un acces direct. Chacun ne fait qu'une chose : lever une exception.
--
--   parametres_programmation   seules `approuveeLe`, `approuveeParId` et `deletedAt` changent ;
--                              modifier une valeur = creer une NOUVELLE version (comme regles_condition)
--   scenarios_programmation    seule `deletedAt` passe de NULL a une date (suppression LOGIQUE) ;
--                              jamais de DELETE
--   fiches_intervention        ni UPDATE ni DELETE, aucune exception : une fiche figee ne change pas
--   fiches_intervention_statuts  ajout seul ; la chaine est verifiee (de = statut precedent)
--
-- L'EMPREINTE EST VERIFIEE PAR LA BASE. Comme `bulletins_routiers`, une contrainte CHECK exige que
-- l'empreinte soit le SHA-256 du texte stocke : un texte retouche ne s'insere pas. D'autres
-- contraintes exigent que les colonnes denormalisees (troncon, annee, version des parametres,
-- budget, montant engage) disent la meme chose que le texte canonique.
--
-- LA FRONTIERE DIGITALROAD TIENT AUSSI EN BASE. `cycle-vie.noyau.ts` refuse en code toute saisie
-- de TRANSMIS, EN_EXECUTION, ACHEVE ou EVALUE depuis le Geoportail. Les CHECK de
-- `fiches_intervention_statuts` posent la meme regle : un statut recu exige l'origine qui le
-- porte et l'identifiant du message ou de l'inspection ; un statut saisi exige l'origine
-- GEOPORTAIL. TRANSMIS exige en outre l'empreinte de la version figee.
--
-- NATURE : additive. Quatre tables, deux fonctions de declencheur supplementaires, une vue, une
-- ligne semee. Aucune table existante n'est touchee. Reversible (voir descentes/).

CREATE TABLE IF NOT EXISTS "parametres_programmation" (
  "id"             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "version"        TEXT NOT NULL,
  "source"         TEXT NOT NULL,
  -- Toutes les valeurs du moteur : poids du risque, correspondance etat vers risque, plafonds de
  -- normalisation, seuils de classe de trafic, minimums, horizon. Voir parametres.noyau.ts.
  "valeurs"        JSONB NOT NULL,
  "motif"          TEXT,
  "creeParId"      TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- NUL = PROVISOIRE, non approuve. Le seul interrupteur qui rend un resultat publiable.
  "approuveeLe"    TIMESTAMP(3),
  "approuveeParId" TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "deletedAt"      TIMESTAMP(3),

  CONSTRAINT "pp_version_format" CHECK ("version" ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  CONSTRAINT "pp_source_connue" CHECK ("source" IN ('amorcage_provisoire', 'saisie')),
  -- Une version saisie a un auteur ; seule la valeur d'amorcage de la migration n'en a pas.
  CONSTRAINT "pp_auteur_si_saisie" CHECK ("source" = 'amorcage_provisoire' OR "creeParId" IS NOT NULL),
  -- Approuvee sans approbateur, ou l'inverse, n'a pas de sens : meme regle que les regles de
  -- condition, les baremes et le catalogue des traitements.
  CONSTRAINT "pp_approbation_signee" CHECK (("approuveeLe" IS NULL) = ("approuveeParId" IS NULL)),
  CONSTRAINT "pp_valeurs_completes" CHECK (
    jsonb_typeof("valeurs") = 'object'
    AND "valeurs" ?& ARRAY['poidsRisque', 'etatVersRisque', 'traficPlafondJma', 'pointsNoirsPlafond', 'populationPlafond',
                           'seuilsClasseTrafic', 'facteursMinimum', 'couvertureMinimale', 'horizonAnnees', 'seuilRisqueMinimal']
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS "parametres_programmation_version_key" ON "parametres_programmation" ("version");

CREATE OR REPLACE FUNCTION parametres_programmation_immuable() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'parametres_programmation : DELETE refuse. Une version ne se supprime pas ; creez une nouvelle version.'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['approuveeLe', 'approuveeParId', 'deletedAt'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['approuveeLe', 'approuveeParId', 'deletedAt']) THEN
    RAISE EXCEPTION 'parametres_programmation : une version est immuable (seules l''approbation et la suppression logique changent). Creez une nouvelle version.'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS parametres_programmation_immuable ON "parametres_programmation";
CREATE TRIGGER parametres_programmation_immuable
  BEFORE UPDATE OR DELETE ON "parametres_programmation"
  FOR EACH ROW EXECUTE FUNCTION parametres_programmation_immuable();

CREATE TABLE IF NOT EXISTS "scenarios_programmation" (
  "id"                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "annee"             INTEGER NOT NULL,
  "intitule"          TEXT NOT NULL,
  "parametresId"      TEXT NOT NULL REFERENCES "parametres_programmation"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "parametresVersion" TEXT NOT NULL,
  "budgetGnf"         BIGINT NOT NULL,
  -- Les filtres demandes (region, classe, plafonds regionaux) : de l'information pour le lecteur,
  -- les ENTREES FAISANT FOI sont le texte canonique ci-dessous.
  "perimetre"         JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Tout ce que le calcul a lu, sous forme canonique (cles triees, montants en chaines) : de quoi
  -- REJOUER le scenario sans toucher a la base.
  "entreesCanoniques" TEXT NOT NULL,
  "empreinteEntrees"  TEXT NOT NULL,
  -- Ce que le calcul a rendu, sous forme canonique.
  "resultatCanonique" TEXT NOT NULL,
  "empreinteResultat" TEXT NOT NULL,
  "nbRetenues"        INTEGER NOT NULL,
  "nbEcartees"        INTEGER NOT NULL,
  "montantEngageGnf"  BIGINT NOT NULL,
  "provisoire"        BOOLEAN NOT NULL,
  "creeParId"         TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Horloge du serveur de base de donnees, posee par le declencheur.
  "creeLe"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt"         TIMESTAMP(3),

  CONSTRAINT "sp_annee_plausible" CHECK ("annee" BETWEEN 2000 AND 2100),
  CONSTRAINT "sp_intitule_non_vide" CHECK (length(btrim("intitule")) > 0),
  CONSTRAINT "sp_budget_positif" CHECK ("budgetGnf" >= 0),
  CONSTRAINT "sp_engage_borne" CHECK ("montantEngageGnf" >= 0 AND "montantEngageGnf" <= "budgetGnf"),
  CONSTRAINT "sp_compteurs_positifs" CHECK ("nbRetenues" >= 0 AND "nbEcartees" >= 0),
  CONSTRAINT "sp_empreintes_hex" CHECK ("empreinteEntrees" ~ '^[0-9a-f]{64}$' AND "empreinteResultat" ~ '^[0-9a-f]{64}$'),
  -- Les empreintes sont celles des textes stockes, verifiees en base : un texte retouche ne passerait pas.
  CONSTRAINT "sp_empreinte_entrees_exacte" CHECK ("empreinteEntrees" = encode(sha256(convert_to("entreesCanoniques", 'UTF8')), 'hex')),
  CONSTRAINT "sp_empreinte_resultat_exacte" CHECK ("empreinteResultat" = encode(sha256(convert_to("resultatCanonique", 'UTF8')), 'hex')),
  -- Les colonnes denormalisees disent la meme chose que le texte : budget, annee, parametres, engage.
  -- coalesce(..., false) : un CHECK qui vaut NULL PASSE en SQL ; une cle absente du texte ne doit pas passer.
  CONSTRAINT "sp_coherence_entrees" CHECK (coalesce(
    ("entreesCanoniques"::jsonb ->> 'budgetGnf')::bigint = "budgetGnf"
    AND ("entreesCanoniques"::jsonb ->> 'annee')::integer = "annee"
    AND ("entreesCanoniques"::jsonb -> 'parametres' ->> 'version') = "parametresVersion", false)
  ),
  CONSTRAINT "sp_coherence_resultat" CHECK (coalesce(
    ("resultatCanonique"::jsonb ->> 'annee')::integer = "annee"
    AND ("resultatCanonique"::jsonb -> 'parametres' ->> 'version') = "parametresVersion"
    AND ("resultatCanonique"::jsonb -> 'totaux' ->> 'engageGnf')::bigint = "montantEngageGnf"
    AND ("resultatCanonique"::jsonb -> 'totaux' ->> 'retenues')::integer = "nbRetenues"
    AND ("resultatCanonique"::jsonb -> 'totaux' ->> 'ecartees')::integer = "nbEcartees"
    AND ("resultatCanonique"::jsonb ->> 'provisoire')::boolean = "provisoire", false)
  )
);
CREATE INDEX IF NOT EXISTS "scenarios_programmation_annee_idx" ON "scenarios_programmation" ("annee", "creeLe" DESC) WHERE "deletedAt" IS NULL;

CREATE OR REPLACE FUNCTION scenarios_programmation_fige() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'scenarios_programmation : DELETE refuse. Un scenario se retire par suppression logique (deletedAt).'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'deletedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'deletedAt')
       OR OLD."deletedAt" IS NOT NULL OR NEW."deletedAt" IS NULL THEN
      RAISE EXCEPTION 'scenarios_programmation : un scenario est fige ; seule la suppression logique (deletedAt NULL vers une date) est permise. Calculez un nouveau scenario.'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  NEW."creeLe" := CURRENT_TIMESTAMP(3);
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS scenarios_programmation_fige ON "scenarios_programmation";
CREATE TRIGGER scenarios_programmation_fige
  BEFORE INSERT OR UPDATE OR DELETE ON "scenarios_programmation"
  FOR EACH ROW EXECUTE FUNCTION scenarios_programmation_fige();

CREATE TABLE IF NOT EXISTS "fiches_intervention" (
  "id"                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "reference"         TEXT NOT NULL,
  "scenarioId"        TEXT NOT NULL REFERENCES "scenarios_programmation"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "tronconId"         TEXT NOT NULL REFERENCES "troncons"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "annee"             INTEGER NOT NULL,
  "parametresVersion" TEXT NOT NULL,
  -- La fiche telle que figee : JSON canonique, sans horodatage. C'est elle que l'on transmet.
  "contenuCanonique"  TEXT NOT NULL,
  -- SHA-256 du texte ci-dessus : la « version figee » exigee a la transmission (cycle-vie.noyau.ts).
  "empreinteSha256"   TEXT NOT NULL,
  -- Instant du gel, pose par le serveur de base de donnees (declencheur), hors du contenu.
  "figeLe"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "figeParId"         TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,

  CONSTRAINT "fi_annee_plausible" CHECK ("annee" BETWEEN 2000 AND 2100),
  CONSTRAINT "fi_empreinte_hex" CHECK ("empreinteSha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "fi_empreinte_exacte" CHECK ("empreinteSha256" = encode(sha256(convert_to("contenuCanonique", 'UTF8')), 'hex')),
  CONSTRAINT "fi_schema_connu" CHECK (coalesce(("contenuCanonique"::jsonb ->> 'schema') = 'fiche-intervention/1', false)),
  CONSTRAINT "fi_coherence_contenu" CHECK (coalesce(
    ("contenuCanonique"::jsonb -> 'patrimoine' ->> 'tronconId') = "tronconId"
    AND ("contenuCanonique"::jsonb ->> 'annee')::integer = "annee"
    AND ("contenuCanonique"::jsonb -> 'parametres' ->> 'version') = "parametresVersion"
    AND ("contenuCanonique"::jsonb -> 'scenario' ->> 'id') = "scenarioId", false)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS "fiches_intervention_reference_key" ON "fiches_intervention" ("reference");
CREATE UNIQUE INDEX IF NOT EXISTS "fiches_intervention_empreinte_key" ON "fiches_intervention" ("empreinteSha256");
-- Une intervention par troncon et par scenario : figer deux fois la meme ligne est un doublon.
CREATE UNIQUE INDEX IF NOT EXISTS "fiches_intervention_scenario_troncon_key" ON "fiches_intervention" ("scenarioId", "tronconId");
CREATE INDEX IF NOT EXISTS "fiches_intervention_troncon_idx" ON "fiches_intervention" ("tronconId");
CREATE INDEX IF NOT EXISTS "fiches_intervention_annee_idx" ON "fiches_intervention" ("annee");

CREATE OR REPLACE FUNCTION fiches_intervention_figee() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'fiches_intervention est figee : % refuse. Une fiche transmise ne change pas ; creez-en une nouvelle.', TG_OP
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW."figeLe" := CURRENT_TIMESTAMP(3);
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS fiches_intervention_figee ON "fiches_intervention";
CREATE TRIGGER fiches_intervention_figee
  BEFORE INSERT OR UPDATE OR DELETE ON "fiches_intervention"
  FOR EACH ROW EXECUTE FUNCTION fiches_intervention_figee();

CREATE TABLE IF NOT EXISTS "fiches_intervention_statuts" (
  "id"                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "ficheId"              TEXT NOT NULL REFERENCES "fiches_intervention"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Numero d'ordre dans la chaine de la fiche, a partir de 1. UNIQUE(ficheId, rang) rend deux
  -- ecritures concurrentes incompatibles : la seconde echoue au lieu de bifurquer.
  "rang"                 INTEGER NOT NULL,
  "de"                   TEXT,
  "vers"                 TEXT NOT NULL,
  "origine"              TEXT NOT NULL,
  "motif"                TEXT,
  "messageDigitalRoadId" TEXT,
  "inspectionId"         TEXT,
  "versionFigee"         TEXT,
  "auteurId"             TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "enregistreLe"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "fis_rang_positif" CHECK ("rang" >= 1),
  CONSTRAINT "fis_statuts_connus" CHECK (
    "vers" IN ('BROUILLON', 'PROPOSE', 'ARBITRE', 'APPROUVE', 'TRANSMIS', 'EN_EXECUTION', 'ACHEVE', 'EVALUE')
    AND ("de" IS NULL OR "de" IN ('BROUILLON', 'PROPOSE', 'ARBITRE', 'APPROUVE', 'TRANSMIS', 'EN_EXECUTION', 'ACHEVE', 'EVALUE'))
  ),
  -- La premiere entree ouvre la chaine a BROUILLON, sans statut precedent ; aucune autre n'en est dispensee.
  CONSTRAINT "fis_premiere_entree" CHECK (("rang" = 1) = ("de" IS NULL) AND ("rang" > 1 OR "vers" = 'BROUILLON')),
  CONSTRAINT "fis_origine_connue" CHECK ("origine" IN ('GEOPORTAIL', 'DIGITALROAD', 'INSPECTION_POST_TRAVAUX')),
  -- La frontiere DigitalRoad, tenue en base : qui a le droit de produire chaque statut.
  CONSTRAINT "fis_origine_selon_statut" CHECK (
    ("vers" IN ('BROUILLON', 'PROPOSE', 'ARBITRE', 'APPROUVE') AND "origine" = 'GEOPORTAIL')
    OR ("vers" IN ('TRANSMIS', 'EN_EXECUTION', 'ACHEVE') AND "origine" = 'DIGITALROAD')
    OR ("vers" = 'EVALUE' AND "origine" = 'INSPECTION_POST_TRAVAUX')
  ),
  -- Un statut recu cite le fait qui le porte ; un statut saisi cite son auteur.
  CONSTRAINT "fis_fait_identifie" CHECK (
    ("origine" = 'GEOPORTAIL' AND "auteurId" IS NOT NULL)
    OR ("origine" = 'DIGITALROAD' AND length(btrim(coalesce("messageDigitalRoadId", ''))) > 0)
    OR ("origine" = 'INSPECTION_POST_TRAVAUX' AND length(btrim(coalesce("inspectionId", ''))) > 0)
  ),
  -- Entrer en TRANSMIS exige l'empreinte de la fiche telle que transmise.
  -- coalesce : « NULL ~ motif » vaut NULL, et un CHECK qui vaut NULL PASSE. Trouve par le banc d'integration.
  CONSTRAINT "fis_version_figee_a_la_transmission" CHECK ("vers" <> 'TRANSMIS' OR coalesce("versionFigee" ~ '^[0-9a-f]{64}$', false))
);
CREATE UNIQUE INDEX IF NOT EXISTS "fiches_intervention_statuts_fiche_rang_key" ON "fiches_intervention_statuts" ("ficheId", "rang");

CREATE OR REPLACE FUNCTION fiches_intervention_statuts_ajout_seul() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE precedent TEXT;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'fiches_intervention_statuts est en ajout seul : % refuse.', TG_OP
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."rang" > 1 THEN
    SELECT "vers" INTO precedent FROM "fiches_intervention_statuts" WHERE "ficheId" = NEW."ficheId" AND "rang" = NEW."rang" - 1;
    IF precedent IS DISTINCT FROM NEW."de" THEN
      RAISE EXCEPTION 'fiches_intervention_statuts : la chaine est rompue (statut precedent %, "de" recu %)', precedent, NEW."de"
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  NEW."enregistreLe" := CURRENT_TIMESTAMP(3);
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS fiches_intervention_statuts_ajout_seul ON "fiches_intervention_statuts";
CREATE TRIGGER fiches_intervention_statuts_ajout_seul
  BEFORE INSERT OR UPDATE OR DELETE ON "fiches_intervention_statuts"
  FOR EACH ROW EXECUTE FUNCTION fiches_intervention_statuts_ajout_seul();

-- L'etat courant d'une fiche : une vue, jamais une colonne (la chaine est en ajout seul).
CREATE OR REPLACE VIEW "fiches_intervention_courantes" AS
SELECT f."id", f."reference", f."scenarioId", f."tronconId", f."annee", f."parametresVersion", f."empreinteSha256", f."figeLe", f."figeParId",
       s."vers" AS "statut", s."rang" AS "rangStatut", s."enregistreLe" AS "statutDepuis"
  FROM "fiches_intervention" f
  JOIN LATERAL (
    SELECT x."vers", x."rang", x."enregistreLe" FROM "fiches_intervention_statuts" x
     WHERE x."ficheId" = f."id" ORDER BY x."rang" DESC LIMIT 1
  ) s ON true;

-- ===== Semis : le jeu d'amorcage, PROVISOIRE, non approuve =====
--
-- Reproduit VALEURS_AMORCAGE_PROVISOIRES de backend/src/programmation/parametres.noyau.ts (un test
-- compare les deux). Aucune de ces valeurs n'a de source ; aucune n'est approuvee.

INSERT INTO "parametres_programmation" ("version", "source", "valeurs", "motif")
VALUES (
  'prog-provisoire-1',
  'amorcage_provisoire',
  -- DEBUT-VALEURS-AMORCAGE
  $valeurs${
    "poidsRisque": { "ETAT": 40, "TRAFIC_IMPORTANCE": 25, "SECURITE": 15, "CLIMAT": 10, "POPULATION": 10 },
    "etatVersRisque": { "BON": 10, "MOYEN": 35, "MAUVAIS": 65, "CRITIQUE": 90 },
    "traficPlafondJma": 5000,
    "pointsNoirsPlafond": 3,
    "populationPlafond": 100000,
    "seuilsClasseTrafic": { "t1MaxJma": 500, "t2MaxJma": 2000 },
    "facteursMinimum": 3,
    "couvertureMinimale": 0.5,
    "horizonAnnees": 1,
    "seuilRisqueMinimal": null
  }$valeurs$::jsonb,
  -- FIN-VALEURS-AMORCAGE
  'Valeurs d''amorcage de simulation, SANS SOURCE. PROVISOIRE, non approuve. Seule la correspondance etat vers risque derive d''une decision (complement a 100 de la correspondance etat vers score du RCI, D-01, elle-meme desapprouvee).'
)
ON CONFLICT ("version") DO NOTHING;

COMMENT ON TABLE "parametres_programmation" IS
  'Parametres du moteur de risque et de programmation (paragraphe 7.7). Une version est immuable ; modifier une valeur cree une nouvelle version. approuveeLe NUL = PROVISOIRE, non approuve. Le jeu seme est un amorcage de simulation sans source.';
COMMENT ON TABLE "scenarios_programmation" IS
  'Scenario annuel de programmation (PAE) calcule : entrees et resultat sous forme canonique, empreintes SHA-256 verifiees en base. Fige : seule la suppression logique est permise. Rejouable octet pour octet.';
COMMENT ON TABLE "fiches_intervention" IS
  'Fiche d''intervention FIGEE (paragraphe 7.7) : texte canonique et empreinte SHA-256 verifiee en base, jamais modifiee ni supprimee. Aucune fiche ne cree de marche, contrat, ordre de travaux, chantier, decompte ni engagement.';
COMMENT ON TABLE "fiches_intervention_statuts" IS
  'Cycle de vie d''une fiche, en ajout seul. TRANSMIS, EN_EXECUTION, ACHEVE, EVALUE exigent l''origine externe et le fait identifie : ils ne se saisissent pas dans le Geoportail.';

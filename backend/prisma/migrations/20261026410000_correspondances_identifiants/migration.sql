-- CORRESPONDANCE EDITABLE ENTRE IDENTIFIANTS EXTERNES ET IDENTIFIANTS DU GEOPORTAIL (A23, B12)
--
-- Livre BDR_ID_CROSSWALK_SPEC.md (§ 2 a 4). La table rapproche un identifiant tel que RECU d'un systeme
-- externe (ONR / BDR, ANASUR Collect, L2R...) d'un objet du Geoportail (troncon, portion, ouvrage, defaut).
--
-- CE QUE CETTE MIGRATION NE FAIT PAS, ET C'EST VOLONTAIRE
--   * AUCUNE ligne n'est semee. Aucun code de l'ONR, de L2R ni d'ANASUR n'est connu du depot (D-06, G-1) ; en
--     inventer un reviendrait a fabriquer une correspondance qui aurait l'air officielle. La table est VIDE
--     tant qu'une personne habilitee n'a rien saisi.
--   * Aucun format d'echange n'est suppose : `systemeSource` est un TEXTE LIBRE de forme controlee (majuscules,
--     chiffres, tiret bas), pas une enumeration (lecon D-06 : un vocabulaire fige ici deviendrait une norme).
--   * Pas de type « route » : le depot n'a aucune entite de route nationale a laquelle une correspondance
--     pourrait pointer (D-06). Les quatre types ci-dessous sont ceux dont la cible existe.
--
-- « A CONFIRMER » PAR CONSTRUCTION. Toute correspondance entre `A_CONFIRMER` et ne devient `CONFIRMEE` que par la
-- decision nominative d'une personne qui n'est PAS celle qui l'a proposee (contrainte en base), sauf la methode
-- REVUE_HUMAINE, qui EST la decision d'une personne. Une correspondance fondee sur la geometrie ou la
-- corroboration reste un candidat (score strictement inferieur a 1, jamais une certitude).
--
-- VERSIONNEMENT (critere B12). Une ligne ne se modifie JAMAIS : le declencheur refuse tout UPDATE sauf la pose
-- de `versionFermeture`, et tout DELETE. Corriger, confirmer ou clore = fermer la ligne (versionFermeture) et, le
-- cas echeant, en ouvrir une nouvelle, dans une nouvelle VERSION de la table (`versions_correspondance`, serie
-- sans trou). Les lignes en vigueur a la version n sont celles ouvertes a n ou avant et non fermees a n ou
-- avant : un export « tel qu'a la version n » se regenere donc OCTET POUR OCTET, quoi qu'il se soit passe depuis.
--
-- UN IDENTIFIANT SOURCE NE POINTE QU'UNE CIBLE A LA FOIS : contrainte d'exclusion sur les lignes en vigueur,
-- periode de validite semi-ouverte [valideDu, valideAu) comme `portions`. Plusieurs sources peuvent en revanche
-- pointer la meme cible (un troncon decoupe en plusieurs identifiants source).
--
-- NATURE : additive, deux tables, trois fonctions de declencheur. Aucune donnee lue ni ecrite ailleurs.
-- REVERSIBILITE : voir backend/prisma/descentes/20261026410000_correspondances_identifiants.sql.

CREATE TABLE IF NOT EXISTS "versions_correspondance" (
  "version"   INTEGER NOT NULL,
  "creeLe"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "auteurId"  TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "motif"     TEXT NOT NULL,
  CONSTRAINT "versions_correspondance_pkey" PRIMARY KEY ("version"),
  CONSTRAINT "version_correspondance_positive" CHECK ("version" >= 1),
  CONSTRAINT "version_correspondance_motif_non_vide" CHECK (length(btrim("motif")) > 0)
);

CREATE TABLE IF NOT EXISTS "correspondances_identifiants" (
  "id"                    TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "systemeSource"         TEXT NOT NULL,
  "typeObjet"             TEXT NOT NULL,
  "identifiantSource"     TEXT NOT NULL,
  "identifiantCible"      TEXT NOT NULL,
  "methode"               TEXT NOT NULL,
  "score"                 NUMERIC(4,3) NOT NULL,
  "tolerancesM"           JSONB,
  "attributsCorroborants" JSONB,
  "statut"                TEXT NOT NULL DEFAULT 'A_CONFIRMER',
  "proposeParId"          TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "decisionReviseurId"    TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "decisionLe"            TIMESTAMP(3),
  "decisionMotif"         TEXT,
  "valideDu"              DATE NOT NULL,
  "valideAu"              DATE,
  "versionOuverture"      INTEGER NOT NULL REFERENCES "versions_correspondance"("version") ON UPDATE CASCADE ON DELETE RESTRICT,
  "versionFermeture"      INTEGER REFERENCES "versions_correspondance"("version") ON UPDATE CASCADE ON DELETE RESTRICT,
  "lotImportId"           TEXT REFERENCES "lots_import"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "commentaire"           TEXT,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "correspondances_identifiants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "correspondance_systeme_forme" CHECK ("systemeSource" ~ '^[A-Z0-9_]{2,40}$'),
  CONSTRAINT "correspondance_type_connu" CHECK ("typeObjet" IN ('TRONCON', 'PORTION', 'OUVRAGE', 'DEFAUT')),
  CONSTRAINT "correspondance_source_non_vide" CHECK (length("identifiantSource") > 0),
  CONSTRAINT "correspondance_cible_non_vide" CHECK (length("identifiantCible") > 0),
  CONSTRAINT "correspondance_methode_connue" CHECK ("methode" IN
    ('IDENTIFIANT_OFFICIEL', 'CODE_ROUTE_NOMENCLATURE', 'GEOMETRIE_CALCULEE', 'CORROBORATION', 'REVUE_HUMAINE')),
  CONSTRAINT "correspondance_score_borne" CHECK ("score" >= 0 AND "score" <= 1),
  -- 1 n'est atteint que par l'etape 1 (identifiant institutionnel officiel), et elle l'atteint toujours.
  CONSTRAINT "correspondance_score_un_reserve" CHECK (("methode" = 'IDENTIFIANT_OFFICIEL') = ("score" = 1)),
  CONSTRAINT "correspondance_tolerances_etape_3" CHECK ("methode" <> 'GEOMETRIE_CALCULEE' OR "tolerancesM" IS NOT NULL),
  CONSTRAINT "correspondance_attributs_etape_4" CHECK ("methode" <> 'CORROBORATION' OR "attributsCorroborants" IS NOT NULL),
  CONSTRAINT "correspondance_statut_connu" CHECK ("statut" IN ('A_CONFIRMER', 'CONFIRMEE')),
  -- CONFIRMEE = une decision nominative, datee et motivee ; A_CONFIRMER = aucune decision.
  CONSTRAINT "correspondance_decision_coherente" CHECK (
    ("statut" = 'CONFIRMEE') = ("decisionReviseurId" IS NOT NULL AND "decisionLe" IS NOT NULL AND length(btrim(coalesce("decisionMotif", ''))) > 0)
    AND ("statut" = 'CONFIRMEE' OR ("decisionReviseurId" IS NULL AND "decisionLe" IS NULL AND "decisionMotif" IS NULL))
  ),
  -- La revue humaine est elle-meme la decision : elle nait confirmee.
  CONSTRAINT "correspondance_revue_humaine_decidee" CHECK ("methode" <> 'REVUE_HUMAINE' OR "statut" = 'CONFIRMEE'),
  -- Sauf revue humaine, on ne confirme pas sa propre proposition.
  CONSTRAINT "correspondance_pas_d_auto_confirmation" CHECK ("statut" = 'A_CONFIRMER' OR "methode" = 'REVUE_HUMAINE' OR "decisionReviseurId" <> "proposeParId"),
  CONSTRAINT "correspondance_periode_non_vide" CHECK ("valideAu" IS NULL OR "valideAu" > "valideDu"),
  CONSTRAINT "correspondance_fermeture_apres_ouverture" CHECK ("versionFermeture" IS NULL OR "versionFermeture" > "versionOuverture")
);

-- Un identifiant source ne pointe qu'une cible a la fois, sur les lignes EN VIGUEUR (non fermees).
ALTER TABLE "correspondances_identifiants"
  ADD CONSTRAINT "correspondance_source_une_cible"
  EXCLUDE USING GIST (
    "systemeSource" WITH =,
    "typeObjet" WITH =,
    "identifiantSource" WITH =,
    daterange("valideDu", "valideAu", '[)') WITH &&
  ) WHERE ("versionFermeture" IS NULL);

CREATE INDEX IF NOT EXISTS "correspondances_cible_idx" ON "correspondances_identifiants" ("typeObjet", "identifiantCible");
CREATE INDEX IF NOT EXISTS "correspondances_source_idx" ON "correspondances_identifiants" ("systemeSource", "typeObjet", "identifiantSource");
CREATE INDEX IF NOT EXISTS "correspondances_versions_idx" ON "correspondances_identifiants" ("versionOuverture", "versionFermeture");

-- La cible doit exister (la table est polymorphe : pas de cle etrangere possible, donc un declencheur).
CREATE OR REPLACE FUNCTION correspondance_cible_existe() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE trouvee boolean;
BEGIN
  IF NEW."typeObjet" = 'TRONCON' THEN SELECT EXISTS (SELECT 1 FROM "troncons" WHERE "id" = NEW."identifiantCible") INTO trouvee;
  ELSIF NEW."typeObjet" = 'PORTION' THEN SELECT EXISTS (SELECT 1 FROM "portions" WHERE "id" = NEW."identifiantCible") INTO trouvee;
  ELSIF NEW."typeObjet" = 'OUVRAGE' THEN SELECT EXISTS (SELECT 1 FROM "ouvrages" WHERE "id" = NEW."identifiantCible") INTO trouvee;
  ELSIF NEW."typeObjet" = 'DEFAUT' THEN SELECT EXISTS (SELECT 1 FROM "defauts" WHERE "id" = NEW."identifiantCible") INTO trouvee;
  ELSE trouvee := false;
  END IF;
  IF NOT trouvee THEN
    RAISE EXCEPTION 'correspondances_identifiants : la cible % % n''existe pas', NEW."typeObjet", NEW."identifiantCible"
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END
$f$;

CREATE TRIGGER "correspondances_cible_existe"
  BEFORE INSERT ON "correspondances_identifiants"
  FOR EACH ROW EXECUTE FUNCTION correspondance_cible_existe();

-- Ajout seul : seule la pose de `versionFermeture` (NULL -> valeur) est un UPDATE permis.
CREATE OR REPLACE FUNCTION correspondance_ajout_seul() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'correspondances_identifiants : aucune suppression (une correspondance se ferme, elle ne s''efface pas)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."versionFermeture" IS NULL AND NEW."versionFermeture" IS NOT NULL
     AND (to_jsonb(NEW) - 'versionFermeture') = (to_jsonb(OLD) - 'versionFermeture') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'correspondances_identifiants : une ligne ne se modifie pas, seule sa fermeture se pose (versionFermeture)'
    USING ERRCODE = 'restrict_violation';
END
$f$;

CREATE TRIGGER "correspondances_ajout_seul"
  BEFORE UPDATE OR DELETE ON "correspondances_identifiants"
  FOR EACH ROW EXECUTE FUNCTION correspondance_ajout_seul();

CREATE OR REPLACE FUNCTION version_correspondance_ajout_seul() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  RAISE EXCEPTION 'versions_correspondance : ajout seul (le journal des versions ne se modifie pas)'
    USING ERRCODE = 'restrict_violation';
END
$f$;

CREATE TRIGGER "versions_correspondance_ajout_seul"
  BEFORE UPDATE OR DELETE ON "versions_correspondance"
  FOR EACH ROW EXECUTE FUNCTION version_correspondance_ajout_seul();

COMMENT ON TABLE "correspondances_identifiants" IS
  'Correspondance identifiant externe -> objet du Geoportail (A23, B12). Jamais semee ; A_CONFIRMER jusqu''a decision nominative ; ajout seul, versionnee.';
COMMENT ON TABLE "versions_correspondance" IS
  'Journal des versions de la table de correspondance (serie sans trou, ajout seul). Un export « a la version n » se regenere a l''identique.';

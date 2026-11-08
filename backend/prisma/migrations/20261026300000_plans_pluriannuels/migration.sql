-- PROGRAMMATION PLURIANNUELLE (PPE) MINIMALE (MAINTENANCE_PROGRAMMING_DESIGN.md, paragraphe 5.1)
--
-- Une table : `plans_pluriannuels`, un plan de N annees (2 a 5) calcule en chainant les scenarios annuels du
-- moteur (backend/src/programmation/ppe.noyau.ts). Comme `scenarios_programmation`, elle GARDE ce qui a ete
-- calcule, scelle, sans rien presenter comme officiel :
--
--   - entrees (enveloppes ANNUELLES SAISIES par l'utilisateur, parametres, candidats, baremes de chaque annee,
--     catalogue, conditions, matrices) et resultat, sous forme canonique (cles triees, montants en chaines,
--     aucun horodatage) : de quoi REJOUER le plan octet pour octet sans toucher a la base ;
--   - empreintes SHA-256 des deux textes, VERIFIEES PAR LA BASE (CHECK) ;
--   - colonnes denormalisees (annee de debut, nombre d'annees, version des parametres, enveloppe totale, montant
--     engage, compteurs, etiquette provisoire) dont une CHECK exige qu'elles disent la meme chose que les textes.
--
-- AUCUNE ENVELOPPE INVENTEE : la table ne seme rien. Aucun parametre n'est ajoute : le plan cite une version de
-- `parametres_programmation` (provisoire tant que non approuvee, voir 20261023100000_moteur_programmation).
--
-- IMMUTABILITE, PAR DECLENCHEUR. Meme regle que `scenarios_programmation` : un plan est FIGE a l'insertion ; seule la
-- suppression LOGIQUE (deletedAt de NULL vers une date) est permise, jamais de DELETE, jamais de retouche d'un
-- texte, d'une empreinte ou d'un compteur. Une contrainte CHECK ne regarde qu'une ligne a la fois et l'absence de
-- route PUT ne protege pas d'un acces direct a la base : c'est le declencheur qui tient l'invariant.
--
-- UN PLAN NE CREE AUCUN ENGAGEMENT : ni marche, ni contrat, ni ordre de travaux, ni chantier, ni fiche
-- d'intervention. Les fiches se figent depuis un scenario ANNUEL (fiches_intervention.scenarioId), pas depuis un plan.
--
-- NATURE : additive. Une table, une fonction de declencheur. Aucune table existante n'est touchee. Reversible
-- (voir descentes/20261026300000_plans_pluriannuels.sql).

CREATE TABLE IF NOT EXISTS "plans_pluriannuels" (
  "id"                 TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "intitule"           TEXT NOT NULL,
  "anneeDebut"         INTEGER NOT NULL,
  "nbAnnees"           INTEGER NOT NULL,
  "parametresId"       TEXT NOT NULL REFERENCES "parametres_programmation"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "parametresVersion"  TEXT NOT NULL,
  -- Somme des enveloppes SAISIES, une par annee. Jamais calculee a partir d'un total reparti par le moteur.
  "enveloppeTotaleGnf" BIGINT NOT NULL,
  -- Les filtres demandes (region, classe) : de l'information pour le lecteur ; les ENTREES FAISANT FOI sont le
  -- texte canonique ci-dessous.
  "perimetre"          JSONB NOT NULL DEFAULT '{}'::jsonb,
  "entreesCanoniques"  TEXT NOT NULL,
  "empreinteEntrees"   TEXT NOT NULL,
  "resultatCanonique"  TEXT NOT NULL,
  "empreinteResultat"  TEXT NOT NULL,
  "nbRetenus"          INTEGER NOT NULL,
  "nbNonRetenus"       INTEGER NOT NULL,
  "montantEngageGnf"   BIGINT NOT NULL,
  "provisoire"         BOOLEAN NOT NULL,
  "creeParId"          TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Horloge du serveur de base de donnees, posee par le declencheur.
  "creeLe"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt"          TIMESTAMP(3),

  CONSTRAINT "ppe_horizon_borne" CHECK ("nbAnnees" BETWEEN 2 AND 5 AND "anneeDebut" BETWEEN 2000 AND 2100 AND "anneeDebut" + "nbAnnees" - 1 <= 2100),
  CONSTRAINT "ppe_intitule_non_vide" CHECK (length(btrim("intitule")) > 0),
  CONSTRAINT "ppe_enveloppe_positive" CHECK ("enveloppeTotaleGnf" >= 0),
  CONSTRAINT "ppe_engage_borne" CHECK ("montantEngageGnf" >= 0 AND "montantEngageGnf" <= "enveloppeTotaleGnf"),
  CONSTRAINT "ppe_compteurs_positifs" CHECK ("nbRetenus" >= 0 AND "nbNonRetenus" >= 0),
  CONSTRAINT "ppe_empreintes_hex" CHECK ("empreinteEntrees" ~ '^[0-9a-f]{64}$' AND "empreinteResultat" ~ '^[0-9a-f]{64}$'),
  -- Les empreintes sont celles des textes stockes, verifiees en base : un texte retouche ne passerait pas.
  CONSTRAINT "ppe_empreinte_entrees_exacte" CHECK ("empreinteEntrees" = encode(sha256(convert_to("entreesCanoniques", 'UTF8')), 'hex')),
  CONSTRAINT "ppe_empreinte_resultat_exacte" CHECK ("empreinteResultat" = encode(sha256(convert_to("resultatCanonique", 'UTF8')), 'hex')),
  -- Les colonnes denormalisees disent la meme chose que les textes. coalesce(..., false) : un CHECK qui vaut NULL
  -- PASSE en SQL ; une cle absente du texte ne doit pas passer.
  CONSTRAINT "ppe_coherence_entrees" CHECK (coalesce(
    ("entreesCanoniques"::jsonb ->> 'anneeDebut')::integer = "anneeDebut"
    AND ("entreesCanoniques"::jsonb ->> 'nbAnnees')::integer = "nbAnnees"
    AND jsonb_array_length("entreesCanoniques"::jsonb -> 'enveloppes') = "nbAnnees"
    AND ("entreesCanoniques"::jsonb -> 'parametres' ->> 'version') = "parametresVersion", false)
  ),
  CONSTRAINT "ppe_coherence_resultat" CHECK (coalesce(
    ("resultatCanonique"::jsonb ->> 'anneeDebut')::integer = "anneeDebut"
    AND ("resultatCanonique"::jsonb ->> 'nbAnnees')::integer = "nbAnnees"
    AND ("resultatCanonique"::jsonb -> 'parametres' ->> 'version') = "parametresVersion"
    AND ("resultatCanonique"::jsonb -> 'synthese' ->> 'enveloppeTotaleGnf')::bigint = "enveloppeTotaleGnf"
    AND ("resultatCanonique"::jsonb -> 'synthese' ->> 'engageTotalGnf')::bigint = "montantEngageGnf"
    AND ("resultatCanonique"::jsonb -> 'synthese' ->> 'retenus')::integer = "nbRetenus"
    AND ("resultatCanonique"::jsonb -> 'synthese' ->> 'nonRetenus')::integer = "nbNonRetenus"
    AND ("resultatCanonique"::jsonb ->> 'provisoire')::boolean = "provisoire", false)
  )
);
CREATE INDEX IF NOT EXISTS "plans_pluriannuels_debut_idx" ON "plans_pluriannuels" ("anneeDebut", "creeLe" DESC) WHERE "deletedAt" IS NULL;

CREATE OR REPLACE FUNCTION plans_pluriannuels_fige() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'plans_pluriannuels : DELETE refuse. Un plan se retire par suppression logique (deletedAt).'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'deletedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'deletedAt')
       OR OLD."deletedAt" IS NOT NULL OR NEW."deletedAt" IS NULL THEN
      RAISE EXCEPTION 'plans_pluriannuels : un plan est fige ; seule la suppression logique (deletedAt NULL vers une date) est permise. Calculez un nouveau plan.'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  NEW."creeLe" := CURRENT_TIMESTAMP(3);
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS plans_pluriannuels_fige ON "plans_pluriannuels";
CREATE TRIGGER plans_pluriannuels_fige
  BEFORE INSERT OR UPDATE OR DELETE ON "plans_pluriannuels"
  FOR EACH ROW EXECUTE FUNCTION plans_pluriannuels_fige();

COMMENT ON TABLE "plans_pluriannuels" IS
  'Plan pluriannuel (PPE) minimal : 2 a 5 annees, une enveloppe SAISIE par annee, scenarios annuels chaines par une methode gloutonne deterministe (aucune optimisation). Entrees et resultat sous forme canonique, empreintes SHA-256 verifiees en base. Fige : seule la suppression logique est permise. PROVISOIRE tant que les parametres ne sont pas approuves. Ne cree aucun engagement.';

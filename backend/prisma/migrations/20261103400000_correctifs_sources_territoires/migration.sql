-- CORRECTIFS APRES LA REVUE INDEPENDANTE DES LOTS T1 (territoires, referentiels) ET S1 (sources multiples, comparaison) du 09/11/2026
--
-- Rapport de revue : REVUE-VAGUE3-T1S1.md (hors depot). Rapport des correctifs : docs/reports/CORRECTIFS-REVUE-T1S1.md. Contrats mis a jour :
-- docs/projets-voirie/CONTRAT-SOURCES.md, CONTRAT-TERRITOIRES.md, API.md.
--
-- CE QUE CETTE MIGRATION FAIT (ADDITIVE : aucune colonne ni table existante n'est supprimee, aucune valeur existante n'est perdue ; une seule ligne
-- existante change, la regle systeme S1-CORRIDOR-0.1 qui passe RETIREE, transition admise par son declencheur d'immuabilite)
--
--   B1. `conflits_projet.jeuSourceBId` : le jeu B de la comparaison d'un dossier DIVERGENCE_SOURCES, renseigne pour les dossiers existants depuis leur
--       comparaison ; son statut entre dans la lisibilite du dossier (un lecteur ne voit rien d'un jeu B non AUTORISE, personne ne voit rien d'un jeu B
--       RETIRE). Fige, et egal au jeu B de la comparaison (declencheur).
--   M2. Le referentiel METHODE_ACQUISITION (lot T1) devient la seule source de verite : les codes du lot S1 y entrent (aucune valeur retiree), et la
--       base refuse au depot un code inconnu ou retire (declencheur).
--   M3. Le type de reseau (code configurable, sinon famille) entre dans la cle de version d'un reseau : les deux index uniques partiels sont recrees.
--   M6. Une classe de precision n'est pas une precision en metres : la regle systeme S1-CORRIDOR-0.1 (bareme provisoire) passe RETIREE, la regle
--       systeme S1-CORRIDOR-0.2 n'a aucun bareme ; un bareme n'est admis que dans une regle approuvee par un ADMIN autre que l'auteur.
--
-- Idempotente (IF NOT EXISTS, ON CONFLICT DO NOTHING, gardes par pg_constraint). Exige les migrations 20261103100000 (T1) et 20261103300000 (S1).
-- REVERSIBILITE : descentes/20261103400000_correctifs_sources_territoires.sql.

-- ===== B1. Dossier DIVERGENCE_SOURCES : le jeu B entre dans la lisibilite =====

ALTER TABLE "conflits_projet" ADD COLUMN IF NOT EXISTS "jeuSourceBId" TEXT REFERENCES "projets_voirie_jeux"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS "conflits_projet_jeuSourceBId_idx" ON "conflits_projet" ("jeuSourceBId");
-- Dossiers deja ouverts : le jeu B est celui de leur comparaison (la colonne n'est pas une colonne d'identite : le declencheur de recalcul l'admet).
UPDATE "conflits_projet" c SET "jeuSourceBId" = cmp."jeuBId"
  FROM "comparaisons_sources_projet" cmp
 WHERE c."comparaisonId" = cmp."id" AND c."jeuSourceBId" IS NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cp_jeu_source_b') THEN
    ALTER TABLE "conflits_projet" ADD CONSTRAINT "cp_jeu_source_b" CHECK (("comparaisonId" IS NULL) = ("jeuSourceBId" IS NULL));
  END IF;
END $$;
COMMENT ON COLUMN "conflits_projet"."jeuSourceBId" IS 'Jeu B de la comparaison d''un dossier DIVERGENCE_SOURCES (correctifs T1+S1, B1) : son statut entre dans la lisibilite du dossier. Fige, egal au jeu B de la comparaison.';

-- Le jeu B d'un dossier est celui de sa comparaison, et ne change plus.
CREATE OR REPLACE FUNCTION conflits_projet_jeu_source_b() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_b text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."jeuSourceBId" IS NOT NULL AND NEW."jeuSourceBId" IS DISTINCT FROM OLD."jeuSourceBId" THEN
    RAISE EXCEPTION 'conflits_projet : le jeu B d''un dossier de divergence est fige' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."comparaisonId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."jeuSourceBId" IS DISTINCT FROM OLD."jeuSourceBId") THEN
    SELECT "jeuBId" INTO v_b FROM "comparaisons_sources_projet" WHERE "id" = NEW."comparaisonId";
    IF v_b IS DISTINCT FROM NEW."jeuSourceBId" THEN
      RAISE EXCEPTION 'conflits_projet : le jeu B d''un dossier de divergence doit etre le jeu B de sa comparaison' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS conflits_projet_jeu_source_b ON "conflits_projet";
CREATE TRIGGER conflits_projet_jeu_source_b BEFORE INSERT OR UPDATE ON "conflits_projet" FOR EACH ROW EXECUTE FUNCTION conflits_projet_jeu_source_b();

-- ===== M2. Une seule source de verite pour la methode d'acquisition : le referentiel METHODE_ACQUISITION (lot T1) =====
-- Les codes du lot S1 (liste du service, deja portes par des jeux) entrent au referentiel ; aucune valeur existante n'est retiree ni modifiee.
-- Correspondance documentee (CONTRAT-SOURCES.md, 3.1) : LEVE_TOPOGRAPHIQUE (T1) et TOPOGRAPHIE (S1) designent la meme methode ; GNSS (T1) est un
-- releve GNSS dont le mode (RTK, differentiel, autonome) n'est pas precise. Les deux restent actifs : le DSI desactive celui qu'il ne veut plus proposer.
INSERT INTO "referentiels_voirie" ("id", "domaine", "code", "libelle", "ordre", "parametres") VALUES
  (gen_random_uuid()::text, 'METHODE_ACQUISITION', 'GNSS_RTK',                    'Relevé GNSS RTK',                         31, '{"precisionTypiqueM":null}'),
  (gen_random_uuid()::text, 'METHODE_ACQUISITION', 'GNSS_DIFFERENTIEL',           'Relevé GNSS différentiel',                32, '{"precisionTypiqueM":null}'),
  (gen_random_uuid()::text, 'METHODE_ACQUISITION', 'GNSS_AUTONOME',               'Relevé GNSS autonome',                    33, '{"precisionTypiqueM":null}'),
  (gen_random_uuid()::text, 'METHODE_ACQUISITION', 'TOPOGRAPHIE',                 'Topographie',                             21, '{"precisionTypiqueM":null}'),
  (gen_random_uuid()::text, 'METHODE_ACQUISITION', 'DETECTION_ELECTROMAGNETIQUE', 'Détection électromagnétique',             60, '{"precisionTypiqueM":null}'),
  (gen_random_uuid()::text, 'METHODE_ACQUISITION', 'GEORADAR',                    'Géoradar',                                61, '{"precisionTypiqueM":null}'),
  (gen_random_uuid()::text, 'METHODE_ACQUISITION', 'PLAN_CAO',                    'Plan de conception livré en DAO/CAO',     41, '{"precisionTypiqueM":null}'),
  (gen_random_uuid()::text, 'METHODE_ACQUISITION', 'RECOLEMENT_TRAVAUX',          'Récolement de travaux',                   70, '{"precisionTypiqueM":null}'),
  (gen_random_uuid()::text, 'METHODE_ACQUISITION', 'DECLARATIF_FOURNISSEUR',      'Déclaratif du fournisseur',               80, '{"precisionTypiqueM":null}')
ON CONFLICT ("domaine", "code") DO NOTHING;
INSERT INTO "referentiels_voirie_historique" ("referentielId", "action", "version", "apres")
  SELECT r."id", 'MIGRATION', r."version", to_jsonb(r) FROM "referentiels_voirie" r
   WHERE NOT EXISTS (SELECT 1 FROM "referentiels_voirie_historique" h WHERE h."referentielId" = r."id");

-- Un jeu ne porte qu'un code du referentiel, existant et non retire au moment de l'ecriture (une valeur retiree ou desactivee apres coup reste portee :
-- le declencheur ne se declenche qu'au changement de la colonne). Le service exige en plus une valeur ACTIVE pour un nouveau depot.
CREATE OR REPLACE FUNCTION projets_voirie_jeux_methode_acquisition() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'INSERT' OR NEW."methodeAcquisition" IS DISTINCT FROM OLD."methodeAcquisition" THEN
    PERFORM referentiels_voirie_exige('METHODE_ACQUISITION', NEW."methodeAcquisition");
  END IF;
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS projets_voirie_jeux_methode_acquisition ON "projets_voirie_jeux";
CREATE TRIGGER projets_voirie_jeux_methode_acquisition BEFORE INSERT OR UPDATE ON "projets_voirie_jeux" FOR EACH ROW EXECUTE FUNCTION projets_voirie_jeux_methode_acquisition();
COMMENT ON COLUMN "projets_voirie_jeux"."methodeAcquisition" IS 'Code du referentiel METHODE_ACQUISITION (lot T1 ; correctifs T1+S1, M2 : seule source de verite). Nul = non renseignee. Composante de la cle de version d''un reseau : deux methodes = deux sources du meme reseau.';

-- ===== M3. L'identite d'un reseau inclut son type configurable (code du referentiel TYPE_RESEAU, sinon la famille) =====
-- Deux types d'un meme concessionnaire, meme de la meme famille, sont deux reseaux : ni compares, ni versions l'un de l'autre. Les deux index uniques
-- partiels (un seul AUTORISE, un seul depot en attente par cle) sont recrees avec le type en cinquieme composante, pour le role RESEAU_TIERS seulement.
-- La conversion d'une valeur d'enumeration en texte n'est pas IMMUTABLE pour PostgreSQL (un libelle peut etre renomme) : la fonction ci-dessous
-- l'est par declaration. Les libelles de TypeReseauTiers ne se renomment pas (une famille nouvelle s'ajoute ; renommer exigerait de reconstruire ces index).
CREATE OR REPLACE FUNCTION pv_identite_type_reseau(p_code text, p_famille "TypeReseauTiers") RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$ SELECT COALESCE(p_code, p_famille::text, '') $fn$;
COMMENT ON FUNCTION pv_identite_type_reseau(text, "TypeReseauTiers") IS 'Identite du type d''un reseau (correctifs T1+S1, M3) : code du referentiel TYPE_RESEAU, sinon famille. Meme regle que identiteTypeReseau (sources/cle-version.noyau.ts).';
DROP INDEX IF EXISTS "projets_voirie_jeux_cle_autorise_key";
CREATE UNIQUE INDEX IF NOT EXISTS "projets_voirie_jeux_cle_autorise_key" ON "projets_voirie_jeux" ("projetId", "role", COALESCE("concessionnaireId", ''),
  (CASE WHEN "role" = 'RESEAU_TIERS' THEN COALESCE("methodeAcquisition", '') ELSE '' END),
  (CASE WHEN "role" = 'RESEAU_TIERS' THEN pv_identite_type_reseau("typeReseauCode", "typeReseau") ELSE '' END))
  WHERE "statut" = 'AUTORISE' AND "role" <> 'AUTRE';
DROP INDEX IF EXISTS "projets_voirie_jeux_cle_attente_key";
CREATE UNIQUE INDEX IF NOT EXISTS "projets_voirie_jeux_cle_attente_key" ON "projets_voirie_jeux" ("projetId", "role", COALESCE("concessionnaireId", ''),
  (CASE WHEN "role" = 'RESEAU_TIERS' THEN COALESCE("methodeAcquisition", '') ELSE '' END),
  (CASE WHEN "role" = 'RESEAU_TIERS' THEN pv_identite_type_reseau("typeReseauCode", "typeReseau") ELSE '' END))
  WHERE "statut" IN ('RECU', 'CONTROLE') AND "role" <> 'AUTRE';

-- ===== M6. Une classe de precision n'est pas une precision en metres (decision de l'architecte du 09/11/2026) =====
-- La regle systeme ne porte AUCUN bareme par classe : sans deux precisions connues en metres horizontaux, le resultat est RAPPROCHEMENT_INCERTAIN.
-- Les regles sont versionnees et immuables : l'historique n'est pas modifie. La regle S1-CORRIDOR-0.1 (bareme provisoire) passe RETIREE (seule
-- transition admise par son declencheur) et une nouvelle regle systeme S1-CORRIDOR-0.2, sans bareme, la remplace. Un bareme n'est admis que dans une
-- regle creee par une personne et approuvee par un ADMIN autre que l'auteur (service, et contrainte ci-dessous pour les regles approuvees desormais).
ALTER TABLE "regles_rapprochement_sources" DROP CONSTRAINT IF EXISTS "rrs_systeme";
ALTER TABLE "regles_rapprochement_sources" ADD CONSTRAINT "rrs_systeme" CHECK ("creeParId" IS NOT NULL OR ("projetId" IS NULL AND "famille" IS NULL AND "version" = 0 AND "statut" IN ('APPROUVEE', 'RETIREE')));
UPDATE "regles_rapprochement_sources" SET "statut" = 'RETIREE'
 WHERE "creeParId" IS NULL AND "code" = 'S1-CORRIDOR-0.1' AND "version" = 0 AND "statut" = 'APPROUVEE';
INSERT INTO "regles_rapprochement_sources" ("id", "projetId", "famille", "code", "version", "margeM", "rayonAppariementM", "partHorsCorridorMax", "precisionParClasseM", "statut", "justification", "creeParId", "approuveParId", "approuveLe", "motifApprobation")
VALUES ('00000000-0000-4000-8000-00000000c502', NULL, NULL, 'S1-CORRIDOR-0.2', 0, 1, 10, 0, '{}'::jsonb, 'APPROUVEE',
        'Regle systeme apres la revue T1+S1 : corridor = max(precision A, precision B) + 1 m, seulement quand les deux precisions sont connues en metres horizontaux ; aucun bareme par classe (une classe n''est pas une precision mesuree).',
        NULL, NULL, CURRENT_TIMESTAMP, 'Regle systeme creee par la migration 20261103400000 (decision de l''architecte du 09/11/2026) : remplace S1-CORRIDOR-0.1, retiree.')
ON CONFLICT DO NOTHING;
ALTER TABLE "regles_rapprochement_sources" ALTER COLUMN "precisionParClasseM" SET DEFAULT '{}'::jsonb;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rrs_bareme_personne') THEN
    -- Une regle systeme en vigueur ne porte aucun bareme. La ligne d'origine S1-CORRIDOR-0.1 version 0 est nommee : elle est RETIREE et ne redevient
    -- jamais APPROUVEE (declencheur d'immuabilite), mais la migration 20261103300000 doit rester rejouable (son INSERT ... ON CONFLICT DO NOTHING
    -- evalue les contraintes avant de constater le conflit).
    ALTER TABLE "regles_rapprochement_sources" ADD CONSTRAINT "rrs_bareme_personne" CHECK ("creeParId" IS NOT NULL OR "statut" = 'RETIREE' OR "precisionParClasseM" = '{}'::jsonb
      OR ("code" = 'S1-CORRIDOR-0.1' AND "version" = 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rrs_bareme_separation') THEN
    -- Une regle approuvee qui porte un bareme l'a ete par une autre personne que son auteur. NOT VALID : les regles deja approuvees sont immuables (le
    -- service n'applique pas le bareme d'une regle auto-approuvee) ; la contrainte vaut pour toute ligne ecrite desormais.
    -- Les regles systeme (sans auteur) relevent de rrs_bareme_personne.
    ALTER TABLE "regles_rapprochement_sources" ADD CONSTRAINT "rrs_bareme_separation" CHECK ("statut" <> 'APPROUVEE' OR "precisionParClasseM" = '{}'::jsonb OR "creeParId" IS NULL
      OR ("approuveParId" IS NOT NULL AND "approuveParId" <> "creeParId")) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rrs_auteur_approbateur') THEN
    -- Decision de l'architecte (10/11/2026) : l'auteur d'une regle de rapprochement ne l'approuve jamais, derogation ou non. NOT VALID pour la meme raison.
    ALTER TABLE "regles_rapprochement_sources" ADD CONSTRAINT "rrs_auteur_approbateur" CHECK ("statut" <> 'APPROUVEE' OR "creeParId" IS NULL OR "approuveParId" IS DISTINCT FROM "creeParId") NOT VALID;
  END IF;
END $$;

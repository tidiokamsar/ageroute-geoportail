-- OBSERVATION DE LA TERRE, LOT 1 (EO-DB) : WORKFLOW DES PROPOSITIONS
--
-- Les audits du Lot 0 ont releve, sur `propositions_teledetection` :
--   - trois statuts seulement (A_VERIFIER, CONFIRMEE, INFIRMEE) : rien pour « en attente d'information » ni
--     « non concluante », donc un terrain qui ne peut pas conclure n'avait d'autre issue que de mentir ;
--   - aucune trace de ce qui a ete decide : un verdict ecrasait l'etat, sans journal des transitions ;
--   - aucun lien entre un verdict et les observations de terrain qui le fondent (une chaine libre `constatRef`) ;
--   - une confiance unique, melangeant la detection, la qualite de l'image, le rattachement au troncon et la
--     priorite d'inspection ;
--   - un rattachement au troncon sans confiance ni candidats concurrents, une methode en une seule chaine,
--     aucune limite de resolution, aucun drapeau de donnee de demonstration, aucune region.
--
-- CE QUE CETTE MIGRATION FAIT
--
--   1. Colonnes : priorite (niveau + regle), confiance de detection (valeur + `confianceCalibree`, toujours faux
--      aujourd'hui), qualite de l'image (nuages + note), rattachement (confiance, algorithme, candidats
--      concurrents en JSONB), methode en deux champs, `limites` (texte[]), `synthetique`, `centre` (colonne
--      CALCULEE, point garanti sur la geometrie), `regionId` (denormalisee depuis le troncon), `motifAttente`.
--      Les produits avant et apres sont `produitReferenceId` (avant) et `produitId` (apres) : deja en place.
--   2. Statuts : A_VERIFIER, EN_ATTENTE, NON_CONCLUANTE, CONFIRMEE, INFIRMEE. Un verdict (CONFIRMEE, INFIRMEE)
--      est DEFINITIF ; les trois autres s'echangent librement et menent a un verdict.
--   3. `propositions_teledetection_transitions` : le journal (de, vers, auteur, date, motif, commentaire,
--      motif d'attente). Ajout seul. Un changement de statut sans sa ligne de journal dans la MEME transaction
--      est refuse a la validation (declencheur de contrainte differe).
--   4. `propositions_teledetection_preuves` : les observations de terrain qui fondent une decision, par
--      cle etrangere, sans copier leur contenu. Ajout seul.
--   5. Le declencheur de garde reecrit : detection figee (geometrie, score, rattachement, limites...),
--      verdict irreversible, transitions ci-dessus. Le declencheur d'insertion exige en plus qu'une
--      proposition entre A_VERIFIER (avant : un verdict pouvait etre insere directement), pose la region depuis
--      le troncon, et refuse de melanger donnees synthetiques et reelles.
--   6. La vue historique `precision_teledetection` est conservee, corrigee pour les nouveaux statuts (une
--      proposition en attente n'est pas jugee) et privee des donnees synthetiques.
--
-- CE QU'ELLE NE FAIT PAS
--
--   Elle ne reecrit aucune proposition existante, sauf la region (derivee du troncon, a l'identique de ce que
--   l'insertion ecrira desormais). `confianceDetection` n'est PAS remplie depuis `score` : le score est ce que la
--   methode rend, et le presenter comme confiance serait une affirmation que rien ne fonde. Les colonnes
--   d'avant (limites, rattachement, priorite) restent NULL sur les lignes d'avant : NULL veut dire « non evalue ».
--
-- NATURE : additive. Idempotente (IF NOT EXISTS, contraintes ajoutees seulement si absentes ; les
-- contraintes MODIFIEES -- pt_statut, pt_verdict_complet -- sont retirees puis reposees).

-- ===== 1. Colonnes =====

ALTER TABLE "propositions_teledetection"
  ADD COLUMN IF NOT EXISTS "prioriteNiveau"           TEXT,
  ADD COLUMN IF NOT EXISTS "prioriteRegle"            TEXT,
  ADD COLUMN IF NOT EXISTS "confianceDetection"       DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "confianceCalibree"        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "imageCouvertureNuagesPct" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "imageNote"                TEXT,
  ADD COLUMN IF NOT EXISTS "rattachementConfiance"    TEXT,
  ADD COLUMN IF NOT EXISTS "rattachementAlgorithme"   TEXT,
  ADD COLUMN IF NOT EXISTS "rattachementCandidats"    JSONB,
  ADD COLUMN IF NOT EXISTS "methodeNom"               TEXT,
  ADD COLUMN IF NOT EXISTS "methodeVersion"           TEXT,
  ADD COLUMN IF NOT EXISTS "limites"                  TEXT[],
  ADD COLUMN IF NOT EXISTS "synthetique"              BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "regionId"                 INTEGER REFERENCES "regions"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS "motifAttente"             TEXT;

-- Centre : colonne calculee par la base, donc toujours juste et jamais ecrite a la main. ST_PointOnSurface
-- (et non le centroide) : le point est GARANTI sur la geometrie, y compris pour une ligne ou un polygone concave.
ALTER TABLE "propositions_teledetection"
  ADD COLUMN IF NOT EXISTS "centre" geometry(Point, 4326) GENERATED ALWAYS AS (ST_PointOnSurface("geom")) STORED;

-- Region denormalisee depuis le troncon : les lignes d'avant la recoivent ici. Le declencheur d'insertion
-- (plus bas) fait de meme pour les suivantes. La condition EXISTS rend la reprise sans effet.
UPDATE "propositions_teledetection" pt
   SET "regionId" = t."regionId"
  FROM "troncons" t
 WHERE t."id" = pt."tronconId" AND pt."regionId" IS NULL AND t."regionId" IS NOT NULL;

-- ===== 2. Contraintes =====

ALTER TABLE "propositions_teledetection" DROP CONSTRAINT IF EXISTS "pt_statut";
ALTER TABLE "propositions_teledetection" ADD CONSTRAINT "pt_statut"
  CHECK ("statut" IN ('A_VERIFIER', 'EN_ATTENTE', 'NON_CONCLUANTE', 'CONFIRMEE', 'INFIRMEE'));

-- Seul un verdict porte auteur, heure, motif et constat ; les trois autres statuts n'en portent aucun
-- (la raison d'une attente ou d'une non-conclusion est dans le journal, pas dans le verdict).
ALTER TABLE "propositions_teledetection" DROP CONSTRAINT IF EXISTS "pt_verdict_complet";
ALTER TABLE "propositions_teledetection" ADD CONSTRAINT "pt_verdict_complet" CHECK (
  ("statut" IN ('A_VERIFIER', 'EN_ATTENTE', 'NON_CONCLUANTE')
     AND "verifieeParId" IS NULL AND "verifieeLe" IS NULL AND "motifVerdict" IS NULL AND "constatRef" IS NULL)
  OR ("statut" IN ('CONFIRMEE', 'INFIRMEE') AND "verifieeParId" IS NOT NULL AND "verifieeLe" IS NOT NULL
      AND length(btrim(coalesce("motifVerdict", ''))) > 0 AND length(btrim(coalesce("constatRef", ''))) > 0)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pt_priorite' AND conrelid = '"propositions_teledetection"'::regclass) THEN
    ALTER TABLE "propositions_teledetection" ADD CONSTRAINT "pt_priorite" CHECK (
      ("prioriteNiveau" IS NULL OR "prioriteNiveau" IN ('HAUTE', 'MOYENNE', 'FAIBLE'))
      AND (("prioriteNiveau" IS NULL) = ("prioriteRegle" IS NULL))
      AND ("prioriteRegle" IS NULL OR length(btrim("prioriteRegle")) > 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pt_confiance_detection' AND conrelid = '"propositions_teledetection"'::regclass) THEN
    ALTER TABLE "propositions_teledetection" ADD CONSTRAINT "pt_confiance_detection" CHECK (
      ("confianceDetection" IS NULL OR "confianceDetection" BETWEEN 0 AND 1)
      AND (NOT "confianceCalibree" OR "confianceDetection" IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pt_image' AND conrelid = '"propositions_teledetection"'::regclass) THEN
    ALTER TABLE "propositions_teledetection" ADD CONSTRAINT "pt_image" CHECK (
      ("imageCouvertureNuagesPct" IS NULL OR "imageCouvertureNuagesPct" BETWEEN 0 AND 100)
      AND ("imageNote" IS NULL OR length(btrim("imageNote")) > 0));
  END IF;
  -- Confiance du rattachement : « AUCUN » si et seulement si aucun troncon n'est retenu ; NULL = non evalue
  -- (ligne d'avant la migration). L'algorithme accompagne toute confiance evaluee.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pt_rattachement_confiance' AND conrelid = '"propositions_teledetection"'::regclass) THEN
    ALTER TABLE "propositions_teledetection" ADD CONSTRAINT "pt_rattachement_confiance" CHECK (
      ("rattachementConfiance" IS NULL OR "rattachementConfiance" IN ('HAUTE', 'MOYENNE', 'FAIBLE', 'AUCUN'))
      AND (("rattachementConfiance" IS NULL) = ("rattachementAlgorithme" IS NULL))
      AND ("rattachementAlgorithme" IS NULL OR length(btrim("rattachementAlgorithme")) > 0)
      AND ("rattachementConfiance" IS NULL OR ("rattachementConfiance" = 'AUCUN') = ("tronconId" IS NULL))
      AND ("rattachementCandidats" IS NULL OR jsonb_typeof("rattachementCandidats") = 'array'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pt_methode_separee' AND conrelid = '"propositions_teledetection"'::regclass) THEN
    ALTER TABLE "propositions_teledetection" ADD CONSTRAINT "pt_methode_separee" CHECK (
      (("methodeNom" IS NULL) = ("methodeVersion" IS NULL))
      AND ("methodeNom" IS NULL OR (length(btrim("methodeNom")) > 0 AND length(btrim("methodeVersion")) > 0)));
  END IF;
  -- Limites : NULL = non renseignees (ligne d'avant) ; renseignees, elles ne sont ni vides ni blanches.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pt_limites' AND conrelid = '"propositions_teledetection"'::regclass) THEN
    ALTER TABLE "propositions_teledetection" ADD CONSTRAINT "pt_limites" CHECK (
      "limites" IS NULL OR (cardinality("limites") > 0 AND NOT ("limites" && ARRAY['']::text[])));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pt_attente' AND conrelid = '"propositions_teledetection"'::regclass) THEN
    ALTER TABLE "propositions_teledetection" ADD CONSTRAINT "pt_attente" CHECK (
      ("motifAttente" IS NULL OR "motifAttente" IN ('INFO_DEMANDEE', 'AUTRE'))
      AND (("statut" = 'EN_ATTENTE') = ("motifAttente" IS NOT NULL)));
  END IF;
  -- La region n'est qu'un reflet du troncon : sans troncon, pas de region.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pt_region_depuis_troncon' AND conrelid = '"propositions_teledetection"'::regclass) THEN
    ALTER TABLE "propositions_teledetection" ADD CONSTRAINT "pt_region_depuis_troncon" CHECK (
      "tronconId" IS NOT NULL OR "regionId" IS NULL);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "propositions_teledetection_region_idx" ON "propositions_teledetection" ("regionId");
CREATE INDEX IF NOT EXISTS "propositions_teledetection_priorite_idx" ON "propositions_teledetection" ("prioriteNiveau");
CREATE INDEX IF NOT EXISTS "propositions_teledetection_produit_idx" ON "propositions_teledetection" ("produitId");
CREATE INDEX IF NOT EXISTS "propositions_teledetection_centre_gist" ON "propositions_teledetection" USING gist ("centre");

-- ===== 3. Journal des transitions =====

CREATE TABLE IF NOT EXISTS "propositions_teledetection_transitions" (
  "id"            TEXT PRIMARY KEY,
  "propositionId" TEXT NOT NULL REFERENCES "propositions_teledetection"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "de"            TEXT NOT NULL,
  "vers"          TEXT NOT NULL,
  "auteurId"      TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "creeLe"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "motif"         TEXT NOT NULL,
  "commentaire"   TEXT,
  -- INFO_DEMANDEE ou AUTRE ; seulement quand la proposition entre (ou reste) EN_ATTENTE.
  "motifAttente"  TEXT,
  -- Transaction qui a ecrit la ligne (voir le declencheur differe plus bas).
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),

  CONSTRAINT "pt_trans_statuts" CHECK (
    "de" IN ('A_VERIFIER', 'EN_ATTENTE', 'NON_CONCLUANTE', 'CONFIRMEE', 'INFIRMEE')
    AND "vers" IN ('A_VERIFIER', 'EN_ATTENTE', 'NON_CONCLUANTE', 'CONFIRMEE', 'INFIRMEE')),
  -- Rien ne sort d'un verdict ; et le seul « surplace » admis est une nouvelle demande sur une proposition deja en attente.
  CONSTRAINT "pt_trans_sens" CHECK (
    "de" NOT IN ('CONFIRMEE', 'INFIRMEE') AND ("de" <> "vers" OR ("de" = 'EN_ATTENTE' AND "vers" = 'EN_ATTENTE'))),
  CONSTRAINT "pt_trans_motif" CHECK (length(btrim("motif")) > 0 AND ("commentaire" IS NULL OR length(btrim("commentaire")) > 0)),
  CONSTRAINT "pt_trans_attente" CHECK (
    ("motifAttente" IS NULL OR "motifAttente" IN ('INFO_DEMANDEE', 'AUTRE')) AND (("vers" = 'EN_ATTENTE') = ("motifAttente" IS NOT NULL)))
);
CREATE INDEX IF NOT EXISTS "pt_transitions_proposition_idx" ON "propositions_teledetection_transitions" ("propositionId", "creeLe");

-- ===== 4. Preuves de terrain =====

CREATE TABLE IF NOT EXISTS "propositions_teledetection_preuves" (
  "id"            TEXT PRIMARY KEY,
  "propositionId" TEXT NOT NULL REFERENCES "propositions_teledetection"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- L'observation reste ou elle est : on la cite, on ne la copie pas.
  "observationId" TEXT NOT NULL REFERENCES "observations"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- La transition qui l'a citee, s'il y en a une (une preuve peut etre ajoutee avant toute decision).
  "transitionId"  TEXT REFERENCES "propositions_teledetection_transitions"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "ajouteeParId"  TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "ajouteeLe"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "pt_preuves_proposition_observation_key" ON "propositions_teledetection_preuves" ("propositionId", "observationId");
CREATE INDEX IF NOT EXISTS "pt_preuves_observation_idx" ON "propositions_teledetection_preuves" ("observationId");

-- Journal et preuves : ajout seul.
CREATE OR REPLACE FUNCTION propositions_teledetection_journaux_ajout_seul() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '% : journal en ajout seul (% refuse)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$fn$;
DROP TRIGGER IF EXISTS pt_transitions_ajout_seul ON "propositions_teledetection_transitions";
CREATE TRIGGER pt_transitions_ajout_seul
  BEFORE UPDATE OR DELETE ON "propositions_teledetection_transitions"
  FOR EACH ROW EXECUTE FUNCTION propositions_teledetection_journaux_ajout_seul();
DROP TRIGGER IF EXISTS pt_preuves_ajout_seul ON "propositions_teledetection_preuves";
CREATE TRIGGER pt_preuves_ajout_seul
  BEFORE UPDATE OR DELETE ON "propositions_teledetection_preuves"
  FOR EACH ROW EXECUTE FUNCTION propositions_teledetection_journaux_ajout_seul();

-- ===== 5. Declencheur de garde (reecrit) =====
--
-- Figee a l'insertion : tout ce qui decrit la detection (produits, type, methode, score, confiance, image,
-- geometrie, rattachement, limites, priorite, region, drapeau synthetique, auteur, date de depot).
-- Peuvent changer : le statut (voir ci-dessous), le motif d'attente, la mission (une seule fois), et le
-- verdict lorsqu'on entre dans CONFIRMEE ou INFIRMEE. Un verdict ne se reprend pas.
CREATE OR REPLACE FUNCTION propositions_teledetection_garde() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'propositions_teledetection : suppression refusee, la mesure de qualite en depend'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."produitId" IS DISTINCT FROM OLD."produitId" OR NEW."produitReferenceId" IS DISTINCT FROM OLD."produitReferenceId"
     OR NEW."type" IS DISTINCT FROM OLD."type" OR NEW."methode" IS DISTINCT FROM OLD."methode"
     OR NEW."methodeNom" IS DISTINCT FROM OLD."methodeNom" OR NEW."methodeVersion" IS DISTINCT FROM OLD."methodeVersion"
     OR NEW."score" IS DISTINCT FROM OLD."score"
     OR NEW."confianceDetection" IS DISTINCT FROM OLD."confianceDetection" OR NEW."confianceCalibree" IS DISTINCT FROM OLD."confianceCalibree"
     OR NEW."imageCouvertureNuagesPct" IS DISTINCT FROM OLD."imageCouvertureNuagesPct" OR NEW."imageNote" IS DISTINCT FROM OLD."imageNote"
     OR NEW."prioriteNiveau" IS DISTINCT FROM OLD."prioriteNiveau" OR NEW."prioriteRegle" IS DISTINCT FROM OLD."prioriteRegle"
     OR NEW."limites" IS DISTINCT FROM OLD."limites" OR NEW."synthetique" IS DISTINCT FROM OLD."synthetique"
     OR NOT ST_Equals(NEW."geom", OLD."geom")
     OR NEW."tronconId" IS DISTINCT FROM OLD."tronconId" OR NEW."distanceTronconM" IS DISTINCT FROM OLD."distanceTronconM"
     OR NEW."rattachementConfiance" IS DISTINCT FROM OLD."rattachementConfiance"
     OR NEW."rattachementAlgorithme" IS DISTINCT FROM OLD."rattachementAlgorithme"
     OR NEW."rattachementCandidats" IS DISTINCT FROM OLD."rattachementCandidats"
     OR NEW."creeParId" IS DISTINCT FROM OLD."creeParId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'propositions_teledetection : la detection est figee ; seuls le statut, le verdict, le motif d''attente et la mission changent'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- La region est un reflet du troncon : elle ne se corrige pas, elle se complete (NULL -> valeur).
  IF OLD."regionId" IS NOT NULL AND NEW."regionId" IS DISTINCT FROM OLD."regionId" THEN
    RAISE EXCEPTION 'propositions_teledetection : la region de la proposition est figee'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Un verdict (CONFIRMEE, INFIRMEE) est definitif : ni statut, ni verdict, ni motif d'attente ne bougent.
  IF OLD."statut" IN ('CONFIRMEE', 'INFIRMEE') AND (
       NEW."statut" IS DISTINCT FROM OLD."statut" OR NEW."verifieeParId" IS DISTINCT FROM OLD."verifieeParId"
       OR NEW."verifieeLe" IS DISTINCT FROM OLD."verifieeLe" OR NEW."motifVerdict" IS DISTINCT FROM OLD."motifVerdict"
       OR NEW."constatRef" IS DISTINCT FROM OLD."constatRef" OR NEW."motifAttente" IS DISTINCT FROM OLD."motifAttente") THEN
    RAISE EXCEPTION 'propositions_teledetection : le verdict du terrain (%) ne se reprend pas', OLD."statut"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Transitions admises depuis A_VERIFIER, EN_ATTENTE ou NON_CONCLUANTE : vers l'un quelconque des quatre autres
  -- statuts. Depuis un verdict : aucune (ci-dessus). Le journal est tenu par le declencheur differe.
  IF NEW."statut" IS DISTINCT FROM OLD."statut" AND NOT (
       OLD."statut" IN ('A_VERIFIER', 'EN_ATTENTE', 'NON_CONCLUANTE')
       AND NEW."statut" IN ('A_VERIFIER', 'EN_ATTENTE', 'NON_CONCLUANTE', 'CONFIRMEE', 'INFIRMEE')) THEN
    RAISE EXCEPTION 'propositions_teledetection : transition de statut interdite (% -> %)', OLD."statut", NEW."statut"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."missionId" IS NOT NULL AND NEW."missionId" IS DISTINCT FROM OLD."missionId" THEN
    RAISE EXCEPTION 'propositions_teledetection : la mission de verification est deja rattachee'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."statut" IN ('CONFIRMEE', 'INFIRMEE') AND OLD."statut" NOT IN ('CONFIRMEE', 'INFIRMEE') THEN
    NEW."verifieeLe" := CURRENT_TIMESTAMP(3);
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS propositions_teledetection_garde ON "propositions_teledetection";
CREATE TRIGGER propositions_teledetection_garde
  BEFORE UPDATE OR DELETE ON "propositions_teledetection"
  FOR EACH ROW EXECUTE FUNCTION propositions_teledetection_garde();

-- Un changement de statut porte sa ligne de journal, ecrite dans la MEME transaction. Verifie a la
-- validation : l'ordre des ecritures dans la transaction est libre. Un contournement par acces direct a la
-- base echoue ici.
CREATE OR REPLACE FUNCTION propositions_teledetection_exige_journal() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "propositions_teledetection_transitions" t
     WHERE t."propositionId" = NEW."id" AND t."de" = OLD."statut" AND t."vers" = NEW."statut"
       AND t."transactionId" = txid_current()) THEN
    RAISE EXCEPTION 'propositions_teledetection : le changement de statut % -> % de la proposition % n''a pas de ligne de journal dans la meme transaction',
      OLD."statut", NEW."statut", NEW."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$fn$;
DROP TRIGGER IF EXISTS propositions_teledetection_journal_exige ON "propositions_teledetection";
CREATE CONSTRAINT TRIGGER propositions_teledetection_journal_exige
  AFTER UPDATE ON "propositions_teledetection"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD."statut" IS DISTINCT FROM NEW."statut")
  EXECUTE FUNCTION propositions_teledetection_exige_journal();

-- ===== 6. Declencheur d'insertion (reecrit) =====
--
-- S'ajoutent aux controles d'emprise et de dates : la proposition entre A_VERIFIER (jamais directement avec un
-- verdict) ; la region est celle du troncon ; une donnee synthetique n'a pour produit qu'un produit synthetique,
-- et inversement.
CREATE OR REPLACE FUNCTION propositions_teledetection_coherence() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  p_emprise geometry; p_date timestamp(3); p_synth boolean;
  r_emprise geometry; r_date timestamp(3); r_synth boolean;
  t_region integer;
BEGIN
  IF NEW."statut" <> 'A_VERIFIER' THEN
    RAISE EXCEPTION 'propositions_teledetection : une proposition entre A_VERIFIER (statut % refuse a l''insertion)', NEW."statut"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "emprise", "dateAcquisition", "synthetique" INTO p_emprise, p_date, p_synth
    FROM "earth_observation_products" WHERE "id" = NEW."produitId";
  -- Produit inexistant : la cle etrangere le refuse ensuite, avec son propre message.
  IF p_emprise IS NOT NULL AND NOT ST_Intersects(p_emprise, NEW."geom") THEN
    RAISE EXCEPTION 'propositions_teledetection : la detection est hors de l''emprise du produit %', NEW."produitId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_emprise IS NOT NULL AND p_synth IS DISTINCT FROM NEW."synthetique" THEN
    RAISE EXCEPTION 'propositions_teledetection : donnee synthetique et produit reel (ou l''inverse) ne se melangent pas (produit %)', NEW."produitId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."produitReferenceId" IS NOT NULL THEN
    SELECT "emprise", "dateAcquisition", "synthetique" INTO r_emprise, r_date, r_synth
      FROM "earth_observation_products" WHERE "id" = NEW."produitReferenceId";
    IF r_date IS NOT NULL AND r_date >= p_date THEN
      RAISE EXCEPTION 'propositions_teledetection : le produit de reference (%) doit etre acquis avant le produit analyse (%)', r_date, p_date
        USING ERRCODE = 'check_violation';
    END IF;
    IF r_emprise IS NOT NULL AND NOT ST_Intersects(r_emprise, NEW."geom") THEN
      RAISE EXCEPTION 'propositions_teledetection : la detection est hors de l''emprise du produit de reference %', NEW."produitReferenceId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF r_emprise IS NOT NULL AND r_synth IS DISTINCT FROM NEW."synthetique" THEN
      RAISE EXCEPTION 'propositions_teledetection : donnee synthetique et produit de reference reel (ou l''inverse) ne se melangent pas (produit %)', NEW."produitReferenceId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."tronconId" IS NOT NULL THEN
    SELECT "regionId" INTO t_region FROM "troncons" WHERE "id" = NEW."tronconId";
    IF NEW."regionId" IS NULL THEN
      NEW."regionId" := t_region;
    ELSIF t_region IS NOT NULL AND NEW."regionId" <> t_region THEN
      RAISE EXCEPTION 'propositions_teledetection : la region (%) n''est pas celle du troncon (%)', NEW."regionId", t_region
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS propositions_teledetection_coherence ON "propositions_teledetection";
CREATE TRIGGER propositions_teledetection_coherence
  BEFORE INSERT ON "propositions_teledetection"
  FOR EACH ROW EXECUTE FUNCTION propositions_teledetection_coherence();

-- ===== 7. Vue historique conservee, corrigee =====
--
-- Memes colonnes qu'avant (compatibilite). Corrections : « juge » = CONFIRMEE ou INFIRMEE (avant : tout ce qui
-- n'etait pas A_VERIFIER, ce qui compterait une proposition EN_ATTENTE comme jugee) ; donnees synthetiques exclues.
CREATE OR REPLACE VIEW "precision_teledetection" AS
SELECT "type", "methode",
       count(*)::integer AS "total",
       count(*) FILTER (WHERE "statut" = 'A_VERIFIER')::integer AS "aVerifier",
       count(*) FILTER (WHERE "statut" = 'CONFIRMEE')::integer AS "confirmees",
       count(*) FILTER (WHERE "statut" = 'INFIRMEE')::integer AS "infirmees",
       CASE WHEN count(*) FILTER (WHERE "statut" IN ('CONFIRMEE', 'INFIRMEE')) = 0 THEN NULL
            ELSE (count(*) FILTER (WHERE "statut" = 'CONFIRMEE'))::double precision
                 / (count(*) FILTER (WHERE "statut" IN ('CONFIRMEE', 'INFIRMEE'))) END AS "precision"
  FROM "propositions_teledetection"
 WHERE NOT "synthetique"
 GROUP BY "type", "methode";

COMMENT ON TABLE "propositions_teledetection_transitions" IS
  'Journal des transitions de statut des propositions (ajout seul) : de, vers, auteur, date, motif, commentaire, motif d''attente.';
COMMENT ON TABLE "propositions_teledetection_preuves" IS
  'Observations de terrain citees a l''appui d''une proposition (cle etrangere, aucune copie de contenu ; ajout seul).';
COMMENT ON COLUMN "propositions_teledetection"."confianceDetection" IS
  'Indice de detection rendu par la methode (0 a 1). Ce n''est une probabilite que si confianceCalibree est vrai (aujourd''hui jamais).';
COMMENT ON COLUMN "propositions_teledetection"."limites" IS
  'Limites de la detection, en texte (resolution native, nuages...). NULL = non renseignees (ligne d''avant la migration).';
COMMENT ON COLUMN "propositions_teledetection"."centre" IS
  'Point garanti sur la geometrie (ST_PointOnSurface), calcule par la base.';
COMMENT ON COLUMN "propositions_teledetection"."regionId" IS
  'Region du troncon de rattachement, denormalisee au depot (NULL sans troncon).';
COMMENT ON COLUMN "propositions_teledetection"."synthetique" IS
  'Vrai pour un jeu de demonstration ou de test : exclu de toute vue de production.';

-- OUTBOX TRANSACTIONNELLE DES INTEGRATIONS SORTANTES
-- (critere A13, paragraphes 7.10 et 7.15 : « seules les donnees VALIDEES sont emises, rejeu
-- sans effet de bord »)
--
-- CE QUE CETTE MIGRATION POSE, ET CE QU'ELLE NE PROUVE PAS
--
-- Elle pose le journal des evenements a emettre vers DigitalRoad, SharePoint et la BDR / L2R, et
-- les garanties que LA BASE peut tenir seule. Elle ne prouve rien sur ces systemes : aucun acces
-- n'existe (B-11, B-12) et aucun format L2R n'est publie. Les contrats d'echange sont des
-- hypotheses de travail, testees contre des simulateurs ecrits par AGEROUTE (docs/integrations/
-- SORTANTS.md).
--
-- CE QUE LA BASE TIENT ELLE-MEME
--
-- 1. SEULES LES DONNEES VALIDEES ENTRENT. Le declencheur `outbox_garde` interroge la source a
--    l'insertion (`outbox_source_refus`) : un troncon, un ouvrage ou une portion qui n'est pas au
--    statut VALIDE, ou qui est supprime logiquement (ou, pour une portion, remplacee), ne peut
--    pas etre inscrit, QUEL QUE SOIT le code qui essaie. Le service applicatif fait le meme
--    controle ; celui-ci est le filet.
--    Aucune table de fiches d'intervention n'existe (moteur de programmation absent, D-07) : une
--    fiche ne peut donc pas entrer, et le declencheur le dit.
--
-- 2. LA CLE D'IDEMPOTENCE EST DETERMINISTE ET VERIFIEE. `cleIdempotence` est le SHA-256 de
--    (destination, type, source, empreinte de la charge) : le meme contenu donne la meme cle, et
--    la base refuse une cle qui ne serait pas celle-la. UNIQUE par destination : un meme contenu
--    ne s'inscrit qu'une fois, meme sous concurrence.
--
-- 3. LA CHARGE EST FIGEE ET SON EMPREINTE VERIFIEE. `chargeCanonique` est le JSON canonique
--    (cles triees) tel qu'il sera emis ; `empreinteCharge` est son SHA-256, verifie en base
--    comme celui des bulletins routiers. Un declencheur interdit de modifier la charge, la cle,
--    la source ou la destination apres coup.
--
-- 4. LA MACHINE A ETATS EST DANS LA BASE. EN_ATTENTE > EN_COURS > ENVOYE | ECHEC | ABANDONNE ;
--    ECHEC > EN_COURS | EN_ATTENTE | ABANDONNE ; ABANDONNE > EN_ATTENTE (relance humaine). Une
--    transition hors de cette liste est refusee par le declencheur. ENVOYE est TERMINAL ET
--    IMMUABLE : un evenement envoye ne se modifie plus, c'est ce qui rend le rejeu sans effet.
--
-- 5. AUCUNE SUPPRESSION. Le journal n'a pas de DELETE : un evenement qu'on ne veut plus
--    emettre est ABANDONNE avec son motif, et reste lisible.
--
-- 6. CHAQUE TENTATIVE EST ARCHIVEE EN AJOUT SEUL (`outbox_tentatives`).
--
-- STATUTS EN TEXTE CONTRAINT ET NON EN ENUMERATION : un ALTER TYPE ADD VALUE serait irreversible
-- (lecon D-06). Etendre un vocabulaire = une migration qui etend le CHECK, reversible.
--
-- LES HEURES SONT FOURNIES PAR L'APPLICATION (horloge injectable, UTC) : les declencheurs
-- n'utilisent pas l'heure de session, qui depend du fuseau du serveur.
--
-- NATURE : additive. Deux tables, deux fonctions, deux declencheurs. Aucune table existante
-- touchee, aucune ligne semee.

CREATE TABLE IF NOT EXISTS "outbox_evenements" (
  "id"            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,

  "destination"   TEXT NOT NULL,
  "typeEvenement" TEXT NOT NULL,
  -- La source de l'evenement : ce qui est emis, jamais copie ailleurs.
  "sourceType"    TEXT NOT NULL,
  "sourceId"      TEXT NOT NULL,
  -- Rang de l'evenement pour cette (destination, type, source). Affecte par le declencheur,
  -- sous verrou : 1 pour la premiere emission, +1 chaque fois que le contenu a change.
  "version"       INTEGER NOT NULL DEFAULT 0,

  "cleIdempotence"  TEXT NOT NULL,
  -- JSON canonique (cles triees), exactement ce qui sera emis.
  "chargeCanonique" TEXT NOT NULL,
  "empreinteCharge" TEXT NOT NULL,

  "statut"        TEXT NOT NULL DEFAULT 'EN_ATTENTE',
  "tentatives"    INTEGER NOT NULL DEFAULT 0,
  "tentativesMax" INTEGER NOT NULL DEFAULT 8,
  -- Combien de fois un humain a relance un evenement ECHEC ou ABANDONNE.
  "relances"      INTEGER NOT NULL DEFAULT 0,
  "prochaineTentativeLe" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),

  -- VERROU ANTI-DOUBLE-ENVOI : un evenement EN_COURS appartient a un travailleur jusqu'a
  -- `verrouJusqua`. Passe cette heure (travailleur mort), un autre peut le reprendre ; la cle
  -- d'idempotence rend la reprise sure cote destinataire.
  "verrouPar"     TEXT,
  "verrouJusqua"  TIMESTAMP(3),

  "dernierCode"    TEXT,
  "dernierMessage" TEXT,
  "accuseReference" TEXT,
  "envoyeLe"       TIMESTAMP(3),
  "abandonneLe"    TIMESTAMP(3),
  "motifAbandon"   TEXT,

  "creeParId" TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),

  CONSTRAINT "outbox_destination_connue" CHECK ("destination" IN ('DIGITALROAD', 'SHAREPOINT', 'BDR_L2R')),
  CONSTRAINT "outbox_type_connu" CHECK ("typeEvenement" IN
    ('FICHE_INTERVENTION_PROGRAMMEE', 'DEPOT_BULLETIN_ROUTIER', 'PIVOT_OBJET_VALIDE')),
  -- Chaque destination ne recoit que ce que les documents du depot lui destinent, de sources
  -- connues. Rien d'autre n'est emis.
  CONSTRAINT "outbox_route_coherente" CHECK (
    ("destination" = 'DIGITALROAD' AND "typeEvenement" = 'FICHE_INTERVENTION_PROGRAMMEE' AND "sourceType" = 'FicheIntervention')
    OR ("destination" = 'SHAREPOINT' AND "typeEvenement" = 'DEPOT_BULLETIN_ROUTIER' AND "sourceType" = 'BulletinRoutier')
    OR ("destination" = 'BDR_L2R' AND "typeEvenement" = 'PIVOT_OBJET_VALIDE' AND "sourceType" IN ('Troncon', 'Ouvrage', 'Portion'))
  ),
  CONSTRAINT "outbox_source_non_vide" CHECK (length(btrim("sourceId")) > 0),
  CONSTRAINT "outbox_version_positive" CHECK ("version" >= 1),
  CONSTRAINT "outbox_charge_bornee" CHECK (length("chargeCanonique") <= 1048576),
  CONSTRAINT "outbox_charge_objet" CHECK (jsonb_typeof("chargeCanonique"::jsonb) = 'object'),
  -- L'empreinte est celle de la charge archivee, verifiee en base : une charge retouchee ne passerait pas.
  CONSTRAINT "outbox_empreinte_exacte" CHECK (
    "empreinteCharge" = encode(sha256(convert_to("chargeCanonique", 'UTF8')), 'hex')
  ),
  -- La cle est DETERMINISTE : elle ne peut etre que celle-ci.
  CONSTRAINT "outbox_cle_deterministe" CHECK (
    "cleIdempotence" = encode(sha256(convert_to(
      "destination" || '|' || "typeEvenement" || '|' || "sourceType" || '|' || "sourceId" || '|' || "empreinteCharge",
      'UTF8')), 'hex')
  ),
  CONSTRAINT "outbox_statut_connu" CHECK ("statut" IN ('EN_ATTENTE', 'EN_COURS', 'ENVOYE', 'ECHEC', 'ABANDONNE')),
  CONSTRAINT "outbox_compteurs" CHECK (
    "tentativesMax" >= 1 AND "tentatives" >= 0 AND "tentatives" <= "tentativesMax" AND "relances" >= 0
  ),
  -- Le verrou n'existe que le temps d'une tentative.
  CONSTRAINT "outbox_verrou_coherent" CHECK (
    ("statut" = 'EN_COURS') = ("verrouPar" IS NOT NULL AND "verrouJusqua" IS NOT NULL)
    AND ("verrouPar" IS NOT NULL) = ("verrouJusqua" IS NOT NULL)
  ),
  -- ENVOYE porte l'accuse de reception du destinataire ; rien d'autre n'en porte.
  CONSTRAINT "outbox_envoye_accuse" CHECK (
    ("statut" = 'ENVOYE') = ("envoyeLe" IS NOT NULL)
    AND ("statut" <> 'ENVOYE' OR length(btrim(coalesce("accuseReference", ''))) > 0)
  ),
  -- Un abandon se motive.
  CONSTRAINT "outbox_abandon_motive" CHECK (
    ("statut" = 'ABANDONNE') = ("abandonneLe" IS NOT NULL)
    AND ("statut" <> 'ABANDONNE' OR length(btrim(coalesce("motifAbandon", ''))) > 0)
  ),
  CONSTRAINT "outbox_message_court" CHECK ("dernierMessage" IS NULL OR length("dernierMessage") <= 500)
);

-- IDEMPOTENCE : le meme contenu, pour la meme destination, ne s'inscrit qu'une fois.
CREATE UNIQUE INDEX IF NOT EXISTS "outbox_evenements_cle_key"
  ON "outbox_evenements" ("destination", "cleIdempotence");
-- Le rang d'une source est unique : deux inscriptions simultanees ne peuvent pas se partager un numero.
CREATE UNIQUE INDEX IF NOT EXISTS "outbox_evenements_version_key"
  ON "outbox_evenements" ("destination", "typeEvenement", "sourceType", "sourceId", "version");
-- Ce que le travailleur cherche : ce qui est du.
CREATE INDEX IF NOT EXISTS "outbox_evenements_du_idx"
  ON "outbox_evenements" ("prochaineTentativeLe") WHERE "statut" IN ('EN_ATTENTE', 'ECHEC');
CREATE INDEX IF NOT EXISTS "outbox_evenements_statut_idx" ON "outbox_evenements" ("statut", "destination");
CREATE INDEX IF NOT EXISTS "outbox_evenements_source_idx" ON "outbox_evenements" ("sourceType", "sourceId");

CREATE TABLE IF NOT EXISTS "outbox_tentatives" (
  "id"          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "evenementId" TEXT NOT NULL REFERENCES "outbox_evenements"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "numero"      INTEGER NOT NULL,
  "debutLe"     TIMESTAMP(3) NOT NULL,
  "finLe"       TIMESTAMP(3) NOT NULL,
  "issue"       TEXT NOT NULL,
  "codeHttp"    INTEGER,
  "codeErreur"  TEXT,
  -- Jamais le corps de la reponse ni un en-tete : seulement un message assaini et borne.
  "message"     TEXT,
  "accuseReference" TEXT,
  "travailleur" TEXT,

  CONSTRAINT "outbox_tentative_numero" CHECK ("numero" >= 1),
  CONSTRAINT "outbox_tentative_periode" CHECK ("finLe" >= "debutLe"),
  CONSTRAINT "outbox_tentative_issue" CHECK ("issue" IN
    ('ACCEPTE', 'DOUBLON_RECONNU', 'ECHEC_TEMPORAIRE', 'ECHEC_DEFINITIF', 'ACCUSE_INVALIDE')),
  CONSTRAINT "outbox_tentative_message_court" CHECK ("message" IS NULL OR length("message") <= 500)
);
CREATE UNIQUE INDEX IF NOT EXISTS "outbox_tentatives_numero_key" ON "outbox_tentatives" ("evenementId", "numero");

-- ===== La source est-elle emissible ? NULL si oui, sinon la raison du refus =====

CREATE OR REPLACE FUNCTION outbox_source_refus(p_type TEXT, p_id TEXT) RETURNS TEXT
LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  st    "StatutValidation";
  supp  TIMESTAMP;
  rempl TIMESTAMP;
BEGIN
  IF p_type = 'Troncon' THEN
    SELECT "statutValidation", "deletedAt" INTO st, supp FROM "troncons" WHERE "id" = p_id;
    IF NOT FOUND THEN RETURN 'troncon ' || p_id || ' introuvable'; END IF;
    IF supp IS NOT NULL THEN RETURN 'troncon ' || p_id || ' supprime logiquement'; END IF;
    IF st IS DISTINCT FROM 'VALIDE' THEN RETURN 'troncon ' || p_id || ' au statut ' || coalesce(st::text, 'NUL') || ' : seul VALIDE est emis'; END IF;
    RETURN NULL;
  ELSIF p_type = 'Ouvrage' THEN
    SELECT "statutValidation", "deletedAt" INTO st, supp FROM "ouvrages" WHERE "id" = p_id;
    IF NOT FOUND THEN RETURN 'ouvrage ' || p_id || ' introuvable'; END IF;
    IF supp IS NOT NULL THEN RETURN 'ouvrage ' || p_id || ' supprime logiquement'; END IF;
    IF st IS DISTINCT FROM 'VALIDE' THEN RETURN 'ouvrage ' || p_id || ' au statut ' || coalesce(st::text, 'NUL') || ' : seul VALIDE est emis'; END IF;
    RETURN NULL;
  ELSIF p_type = 'Portion' THEN
    SELECT "statutValidation", "deletedAt", "remplaceeLe" INTO st, supp, rempl FROM "portions" WHERE "id" = p_id;
    IF NOT FOUND THEN RETURN 'portion ' || p_id || ' introuvable'; END IF;
    IF supp IS NOT NULL THEN RETURN 'portion ' || p_id || ' supprimee logiquement'; END IF;
    IF rempl IS NOT NULL THEN RETURN 'portion ' || p_id || ' remplacee : une version close n''est pas emise'; END IF;
    IF st IS DISTINCT FROM 'VALIDE' THEN RETURN 'portion ' || p_id || ' au statut ' || coalesce(st::text, 'NUL') || ' : seul VALIDE est emis'; END IF;
    RETURN NULL;
  ELSIF p_type = 'BulletinRoutier' THEN
    -- Un bulletin est archive et fige, genere des seules publications validees par l'exploitant :
    -- il n'a pas de statut de validation propre.
    IF NOT EXISTS (SELECT 1 FROM "bulletins_routiers" WHERE "id" = p_id) THEN RETURN 'bulletin ' || p_id || ' introuvable'; END IF;
    RETURN NULL;
  ELSIF p_type = 'FicheIntervention' THEN
    RETURN 'aucune table de fiches d''intervention : le moteur de programmation n''existe pas (D-07), rien ne peut etre emis';
  END IF;
  RETURN 'type de source inconnu : ' || coalesce(p_type, 'NUL');
END;
$fn$;

-- ===== La garde du journal =====

CREATE OR REPLACE FUNCTION outbox_garde() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  refus TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'outbox_evenements est un journal : DELETE refuse. Abandonnez l''evenement (ABANDONNE), ne l''effacez pas.'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."statut" <> 'EN_ATTENTE' OR NEW."tentatives" <> 0 OR NEW."relances" <> 0
       OR NEW."envoyeLe" IS NOT NULL OR NEW."abandonneLe" IS NOT NULL THEN
      RAISE EXCEPTION 'outbox_evenements : un evenement nait EN_ATTENTE, sans tentative ni accuse'
        USING ERRCODE = 'check_violation';
    END IF;
    -- SEULES LES DONNEES VALIDEES ENTRENT.
    refus := outbox_source_refus(NEW."sourceType", NEW."sourceId");
    IF refus IS NOT NULL THEN
      RAISE EXCEPTION 'outbox_evenements : source refusee : %', refus USING ERRCODE = 'check_violation';
    END IF;
    -- Rang de la source, sous verrou : deux inscriptions simultanees se sequencent.
    PERFORM pg_advisory_xact_lock(hashtext('outbox:' || NEW."destination" || '|' || NEW."typeEvenement" || '|' || NEW."sourceType" || '|' || NEW."sourceId"));
    SELECT coalesce(max(o."version"), 0) + 1 INTO NEW."version" FROM "outbox_evenements" o
     WHERE o."destination" = NEW."destination" AND o."typeEvenement" = NEW."typeEvenement"
       AND o."sourceType" = NEW."sourceType" AND o."sourceId" = NEW."sourceId";
    RETURN NEW;
  END IF;

  -- UPDATE
  IF OLD."statut" = 'ENVOYE' THEN
    RAISE EXCEPTION 'outbox_evenements : evenement % ENVOYE, immuable : UPDATE refuse (rejeu sans effet de bord)', OLD."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW."destination", NEW."typeEvenement", NEW."sourceType", NEW."sourceId", NEW."version",
      NEW."cleIdempotence", NEW."chargeCanonique", NEW."empreinteCharge", NEW."creeParId", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."destination", OLD."typeEvenement", OLD."sourceType", OLD."sourceId", OLD."version",
      OLD."cleIdempotence", OLD."chargeCanonique", OLD."empreinteCharge", OLD."creeParId", OLD."createdAt") THEN
    RAISE EXCEPTION 'outbox_evenements : la source, la destination, la cle et la charge sont figees'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT ((OLD."statut", NEW."statut") IN (
        ('EN_ATTENTE', 'EN_COURS'), ('EN_ATTENTE', 'ABANDONNE'),
        ('EN_COURS', 'EN_COURS'), ('EN_COURS', 'ENVOYE'), ('EN_COURS', 'ECHEC'), ('EN_COURS', 'ABANDONNE'),
        ('ECHEC', 'EN_COURS'), ('ECHEC', 'EN_ATTENTE'), ('ECHEC', 'ABANDONNE'),
        ('ABANDONNE', 'EN_ATTENTE'))) THEN
    RAISE EXCEPTION 'outbox_evenements : transition % > % interdite', OLD."statut", NEW."statut"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS outbox_garde ON "outbox_evenements";
CREATE TRIGGER outbox_garde
  BEFORE INSERT OR UPDATE OR DELETE ON "outbox_evenements"
  FOR EACH ROW EXECUTE FUNCTION outbox_garde();

-- ===== Les tentatives : ajout seul =====

CREATE OR REPLACE FUNCTION outbox_tentatives_ajout_seul() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'outbox_tentatives est en ajout seul : % refuse.', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$fn$;

DROP TRIGGER IF EXISTS outbox_tentatives_ajout_seul ON "outbox_tentatives";
CREATE TRIGGER outbox_tentatives_ajout_seul
  BEFORE UPDATE OR DELETE ON "outbox_tentatives"
  FOR EACH ROW EXECUTE FUNCTION outbox_tentatives_ajout_seul();

COMMENT ON TABLE "outbox_evenements" IS
  'Outbox des integrations sortantes (A13, paragraphes 7.10 et 7.15). Seules les donnees VALIDEES '
  'entrent (declencheur outbox_garde) ; machine a etats dans la base ; ENVOYE immuable ; jamais de '
  'suppression. Les contrats d''echange sont des hypotheses testees contre des simulateurs : aucun '
  'systeme reel n''a ete atteint.';
COMMENT ON TABLE "outbox_tentatives" IS
  'Journal en ajout seul des tentatives d''emission : issue, code HTTP, message assaini. Jamais de corps de reponse ni d''en-tete.';

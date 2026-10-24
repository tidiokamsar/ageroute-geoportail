-- INFO ROUTE ET BULLETIN ROUTIER QUOTIDIEN (paragraphe 7.17, EX-05 et EX-06)
--
-- « Info Route (public, temps reel) : page et flux des coupures, restrictions, deviations et
-- travaux en cours ; bulletin routier quotidien genere automatiquement en texte simple [...].
-- Seules les informations validees par l'exploitant sont publiees ; chaque publication est
-- journalisee. »
--
-- CE QUI EST PUBLIE N'EST PAS LA MAIN COURANTE. La main courante est le journal interne : textes
-- d'agents, pieces, auteurs. L'Info Route est une DECLARATION PUBLIQUE redigee pour l'usager, qui
-- cite l'evenement dont elle parle. Rien de la main courante ne sort sans qu'un exploitant ait
-- ecrit, pour le public, ce qui doit en sortir : c'est cela, « validee par l'exploitant ».
--
-- EN AJOUT SEUL, COMME LA MAIN COURANTE. Une publication n'est jamais modifiee ni effacee : la
-- mettre a jour, c'est publier une nouvelle ligne MISE_A_JOUR ; la retirer, une ligne RETRAIT.
-- L'etat public courant est une VUE (`info_route_courante`) : la derniere ligne de chaque
-- evenement, si elle n'est pas un retrait et si sa validite court. Ainsi « chaque publication est
-- journalisee » n'est pas une consigne, c'est la forme de la table.
--
-- LE NIVEAU DE PRATICABILITE est cite par son code (P1-P4), et SEULEMENT S'IL EST APPROUVE.
-- AGEROUTE a demande le 13/10/2026 de « faire approuver les valeurs avant leur utilisation
-- officielle » ; une annonce publique en est une. Les quatre niveaux semes le 15/10 sont des
-- propositions (`approuveeLe` nul, D-02) : le declencheur refuse donc toute publication qui en
-- cite un. L'Info Route fonctionne sans niveau -- categorie, texte, localisation -- et le portera
-- des que D-02 sera tranchee, sans migration. La vue garde `niveauApprouve` pour le cas d'une
-- approbation retiree apres coup.
--
-- LE BULLETIN est archive, fige, avec l'empreinte SHA-256 de son texte et la liste des
-- publications qu'il reprend. Il n'est envoye NULLE PART : aucune radio, aucun fournisseur SMS ni
-- WhatsApp n'est raccorde, aucune autorisation n'existe. Il est genere, archive et telechargeable.
--
-- NATURE : additive. Deux tables, une vue, un declencheur. Aucune ligne existante touchee.

CREATE TABLE IF NOT EXISTS "publications_info_route" (
  "id"          TEXT PRIMARY KEY,
  -- L'evenement de la main courante dont parle la publication. Pas de cle etrangere possible :
  -- `evenementId` n'est pas une cle de `main_courante` (c'est l'identifiant partage de la chaine).
  -- L'existence de la DECLARATION est verifiee par le declencheur ci-dessous.
  "evenementId" TEXT NOT NULL,
  "action"      TEXT NOT NULL,
  "categorie"   TEXT,
  "praticabiliteCode" TEXT REFERENCES "referentiel_praticabilites"("code") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Redige POUR LE PUBLIC. Aucune donnee personnelle : c'est l'exploitant qui l'ecrit.
  "titre"            TEXT,
  "textePublic"      TEXT,
  "localisationPublique" TEXT,
  "deviation"        TEXT,
  "debutValidite"    TIMESTAMP(3),
  "finValidite"      TIMESTAMP(3),

  "publieParId" TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Heure du SERVEUR, posee par le declencheur.
  "publieLe"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Ordre d'insertion, strictement croissant. L'heure ne suffit pas : deux lignes de la meme
  -- transaction portent le meme CURRENT_TIMESTAMP.
  "rang"        BIGSERIAL NOT NULL,
  "clientOperationId" TEXT,

  CONSTRAINT "ir_action_valide" CHECK ("action" IN ('PUBLICATION', 'MISE_A_JOUR', 'RETRAIT')),
  CONSTRAINT "ir_categorie_valide" CHECK ("categorie" IS NULL OR "categorie" IN ('COUPURE', 'RESTRICTION', 'DEVIATION', 'TRAVAUX')),
  -- Une publication ou une mise a jour dit quoi et ou ; un retrait ne dit rien d'autre.
  CONSTRAINT "ir_contenu_selon_action" CHECK (
    ("action" = 'RETRAIT' AND "categorie" IS NULL AND "titre" IS NULL AND "textePublic" IS NULL)
    OR ("action" <> 'RETRAIT' AND "categorie" IS NOT NULL
        AND length(btrim(coalesce("titre", ''))) > 0
        AND length(btrim(coalesce("textePublic", ''))) > 0
        AND length(btrim(coalesce("localisationPublique", ''))) > 0)
  ),
  CONSTRAINT "ir_titre_court" CHECK ("titre" IS NULL OR length("titre") <= 120),
  CONSTRAINT "ir_texte_borne" CHECK ("textePublic" IS NULL OR length("textePublic") <= 1000),
  CONSTRAINT "ir_validite_ordonnee" CHECK ("finValidite" IS NULL OR "debutValidite" IS NULL OR "finValidite" > "debutValidite"),
  -- Une deviation se publie avec son itineraire.
  CONSTRAINT "ir_deviation_decrite" CHECK ("categorie" IS DISTINCT FROM 'DEVIATION' OR length(btrim(coalesce("deviation", ''))) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "publications_info_route_clientOperationId_key" ON "publications_info_route" ("clientOperationId");
CREATE INDEX IF NOT EXISTS "publications_info_route_evenement_idx" ON "publications_info_route" ("evenementId", "publieLe");
CREATE INDEX IF NOT EXISTS "publications_info_route_publie_idx" ON "publications_info_route" ("publieLe");

-- ===== Ajout seul, heure serveur, evenement existant, sequence coherente =====

CREATE OR REPLACE FUNCTION info_route_ajout_seul() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  derniere TEXT;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'publications_info_route est en ajout seul : % refuse. Publiez une MISE_A_JOUR ou un RETRAIT.', TG_OP
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW."publieLe" := CURRENT_TIMESTAMP(3);

  IF NOT EXISTS (SELECT 1 FROM "main_courante" WHERE "evenementId" = NEW."evenementId" AND "nature" = 'DECLARATION') THEN
    RAISE EXCEPTION 'publications_info_route : evenement % inconnu de la main courante', NEW."evenementId"
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW."praticabiliteCode" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "referentiel_praticabilites" WHERE "code" = NEW."praticabiliteCode" AND "approuveeLe" IS NOT NULL) THEN
    RAISE EXCEPTION 'publications_info_route : le niveau % n''est pas approuve, il ne peut pas etre publie (D-02)', NEW."praticabiliteCode"
      USING ERRCODE = 'check_violation';
  END IF;

  -- Verrou par evenement : deux publications simultanees du meme evenement se sequencent.
  PERFORM pg_advisory_xact_lock(hashtext('info_route:' || NEW."evenementId"));
  SELECT p."action" INTO derniere FROM "publications_info_route" p
   WHERE p."evenementId" = NEW."evenementId" ORDER BY p."rang" DESC LIMIT 1;

  -- PUBLICATION ouvre (ou rouvre apres un retrait) ; MISE_A_JOUR et RETRAIT exigent une
  -- publication en cours.
  IF NEW."action" = 'PUBLICATION' AND derniere IS NOT NULL AND derniere <> 'RETRAIT' THEN
    RAISE EXCEPTION 'evenement % deja publie : publiez une MISE_A_JOUR', NEW."evenementId" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."action" IN ('MISE_A_JOUR', 'RETRAIT') AND (derniere IS NULL OR derniere = 'RETRAIT') THEN
    RAISE EXCEPTION 'evenement % non publie : % impossible', NEW."evenementId", NEW."action" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS info_route_ajout_seul ON "publications_info_route";
CREATE TRIGGER info_route_ajout_seul
  BEFORE INSERT OR UPDATE OR DELETE ON "publications_info_route"
  FOR EACH ROW EXECUTE FUNCTION info_route_ajout_seul();

-- ===== L'etat public courant =====
--
-- La derniere ligne de chaque evenement, si ce n'est pas un retrait et si sa validite court a
-- l'instant de la lecture. Rien d'interne n'est expose : ni auteur, ni texte d'agent, ni piece.
CREATE OR REPLACE VIEW "info_route_courante" AS
WITH dernieres AS (
  SELECT DISTINCT ON ("evenementId") *
    FROM "publications_info_route"
   ORDER BY "evenementId", "rang" DESC
),
premieres AS (
  SELECT "evenementId", min("publieLe") AS "publieDepuis"
    FROM "publications_info_route" WHERE "action" = 'PUBLICATION' GROUP BY "evenementId"
)
SELECT d."id" AS "publicationId", d."evenementId", d."categorie", d."praticabiliteCode",
       rp."libelle" AS "praticabiliteLibelle", (rp."approuveeLe" IS NOT NULL) AS "niveauApprouve",
       d."titre", d."textePublic", d."localisationPublique", d."deviation",
       d."debutValidite", d."finValidite", d."publieLe" AS "misAJourLe", pr."publieDepuis",
       mc."tronconId",
       t."code" AS "tronconCode",
       CASE WHEN mc."geom" IS NOT NULL THEN ST_AsGeoJSON(mc."geom")::json END AS "point"
  FROM dernieres d
  JOIN premieres pr ON pr."evenementId" = d."evenementId"
  JOIN "main_courante" mc ON mc."evenementId" = d."evenementId" AND mc."nature" = 'DECLARATION'
  LEFT JOIN "troncons" t ON t."id" = mc."tronconId"
  LEFT JOIN "referentiel_praticabilites" rp ON rp."code" = d."praticabiliteCode"
 WHERE d."action" <> 'RETRAIT'
   AND (d."debutValidite" IS NULL OR d."debutValidite" <= CURRENT_TIMESTAMP)
   AND (d."finValidite" IS NULL OR d."finValidite" > CURRENT_TIMESTAMP);

-- ===== Bulletins routiers =====

CREATE TABLE IF NOT EXISTS "bulletins_routiers" (
  "id"            TEXT PRIMARY KEY,
  "numero"        TEXT NOT NULL,
  -- Jour civil du bulletin (Guinee : UTC+0).
  "jour"          DATE NOT NULL,
  -- Instant de la situation decrite : les publications en cours a cet instant.
  "situationA"    TIMESTAMP(3) NOT NULL,
  "genereLe"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "genereParId"   TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "gabarit"       TEXT NOT NULL,
  "texte"         TEXT NOT NULL,
  "empreinteSha256" TEXT NOT NULL,
  "publicationsIds" TEXT[] NOT NULL DEFAULT '{}',

  CONSTRAINT "br_texte_non_vide" CHECK (length(btrim("texte")) > 0),
  CONSTRAINT "br_empreinte_hex" CHECK ("empreinteSha256" ~ '^[0-9a-f]{64}$'),
  -- L'empreinte est celle du texte archive, verifiee en base : un texte retouche ne passerait pas.
  CONSTRAINT "br_empreinte_exacte" CHECK ("empreinteSha256" = encode(sha256(convert_to("texte", 'UTF8')), 'hex'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "bulletins_routiers_numero_key" ON "bulletins_routiers" ("numero");
CREATE INDEX IF NOT EXISTS "bulletins_routiers_jour_idx" ON "bulletins_routiers" ("jour");

-- Un bulletin diffuse ne se corrige pas : on en genere un nouveau, qui porte le numero suivant.
CREATE OR REPLACE FUNCTION bulletins_routiers_fige() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'bulletins_routiers est archive : % refuse. Generez un nouveau bulletin.', TG_OP
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW."genereLe" := CURRENT_TIMESTAMP(3);
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS bulletins_routiers_fige ON "bulletins_routiers";
CREATE TRIGGER bulletins_routiers_fige
  BEFORE INSERT OR UPDATE OR DELETE ON "bulletins_routiers"
  FOR EACH ROW EXECUTE FUNCTION bulletins_routiers_fige();

COMMENT ON TABLE "publications_info_route" IS
  'Info Route (paragraphe 7.17, EX-05) : declarations publiques redigees par l''exploitant, en '
  'ajout seul (declencheur info_route_ajout_seul). Etat public courant : vue info_route_courante.';
COMMENT ON TABLE "bulletins_routiers" IS
  'Bulletins routiers quotidiens (EX-06), archives et figes, empreinte SHA-256 verifiee en base. '
  'Generes et telechargeables ; envoyes nulle part (aucun canal raccorde ni autorise).';

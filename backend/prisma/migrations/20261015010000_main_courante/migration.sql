-- MAIN COURANTE DU RESEAU -- journal d'exploitation EN AJOUT SEUL (paragraphe 7.17, EX-01)
--
-- « Journal d'exploitation en ajout seul, horodate par le serveur (horodatage client conserve a
-- part), IMMUABLE apres enregistrement, corrections par entrees rectificatives. [...] Valeur
-- probatoire : la main courante etablit ce qu'AGEROUTE savait et a quel moment. »
--
-- LE MODELE : UN EVENEMENT EST UNE CHAINE D'ENTREES, PAS UNE LIGNE QU'ON MODIFIE
--
-- Si l'evenement etait une ligne dont on change le statut, la main courante ne serait plus en
-- ajout seul, et sa valeur probatoire tomberait : on ne saurait plus QUAND il est passe en
-- PRIS_EN_COMPTE. Chaque fait est donc une ENTREE immuable ; l'evenement est l'ensemble des
-- entrees qui partagent son identifiant ; son statut courant est celui de sa derniere entree
-- de statut, rendu par une vue. Une erreur se corrige par une entree RECTIFICATION qui cite
-- l'entree fautive -- les deux restent.
--
-- LE PREMIER DECLENCHEUR DE CE DEPOT, ET POURQUOI ICI ET PAS AILLEURS
--
-- Jusqu'ici chaque invariant tenait par une contrainte, une absence de colonne ou une absence
-- de route. L'immutabilite ne se tient par aucun des trois : une contrainte ne regarde qu'une
-- ligne a la fois, et « aucune route UPDATE » protege du code, pas d'un acces direct. Un
-- REVOKE UPDATE serait la bonne reponse si le role applicatif n'etait pas superuser en
-- production (alerte de securite ouverte) : il l'est, donc le REVOKE ne vaudrait rien.
--
-- Reste le declencheur, que ce depot a evite partout parce qu'il est invisible a Prisma et au
-- lecteur. Il est admis ici, UNE FOIS, pour la table dont la valeur est precisement de ne
-- jamais changer -- et il est nomme, commente, et eprouve par un banc d'essai qui tente
-- l'UPDATE et le DELETE. Il ne fait qu'une chose : lever une exception.
--
-- HORODATAGE SERVEUR : `enregistreLe` a DEFAULT CURRENT_TIMESTAMP et le declencheur refuse
-- aussi toute insertion qui le fournirait : l'heure du serveur ne se declare pas, elle se
-- constate. `horodatageClient` est conserve A PART, tel que l'appareil l'a donne.
--
-- VOCABULAIRES EN TABLES : types d'evenement et sources sont administrables (lecon D-06), semes
-- depuis le paragraphe 7.17 avec source = mandat_v10. Le statut, lui, est une machine a etats :
-- enumeration.
--
-- NATURE : additive. Un type, trois tables, une vue, une fonction, un declencheur, vingt lignes
-- de referentiel. Aucune table existante touchee.

CREATE TABLE IF NOT EXISTS "referentiel_types_evenement" (
  "code"      TEXT PRIMARY KEY,
  "libelle"   TEXT NOT NULL,
  "ordre"     INTEGER NOT NULL,
  "actif"     BOOLEAN NOT NULL DEFAULT true,
  "source"    TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "referentiel_types_evenement" ("code", "libelle", "ordre", "source") VALUES
  ('COUPURE',             'Coupure de la route',                    1, 'mandat_v10'),
  ('INONDATION',          'Inondation',                              2, 'mandat_v10'),
  ('GLISSEMENT',          'Glissement de terrain',                   3, 'mandat_v10'),
  ('EFFONDREMENT_OUVRAGE','Effondrement d''ouvrage',                 4, 'mandat_v10'),
  ('ACCIDENT',            'Accident',                                5, 'mandat_v10'),
  ('OBSTACLE',            'Obstacle (arbre, vehicule, eboulement)',  6, 'mandat_v10'),
  ('ANIMAUX',             'Animaux sur la chaussee',                 7, 'mandat_v10'),
  ('MANIFESTATION',       'Manifestation',                           8, 'mandat_v10'),
  ('TRAVAUX_SIGNALES',    'Travaux signales par DigitalRoad',        9, 'mandat_v10'),
  ('DECISION',            'Decision prise (fermeture, deviation, alerte)', 10, 'mandat_v10')
ON CONFLICT ("code") DO NOTHING;

CREATE TABLE IF NOT EXISTS "referentiel_sources_evenement" (
  "code"      TEXT PRIMARY KEY,
  "libelle"   TEXT NOT NULL,
  "ordre"     INTEGER NOT NULL,
  "actif"     BOOLEAN NOT NULL DEFAULT true,
  "source"    TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "referentiel_sources_evenement" ("code", "libelle", "ordre", "source") VALUES
  ('PATROUILLE', 'Patrouille AGEROUTE', 1, 'mandat_v10'),
  ('CITOYEN',    'Signalement citoyen', 2, 'mandat_v10'),
  ('CAPTEUR',    'Capteur',             3, 'mandat_v10'),
  ('PARTENAIRE', 'Partenaire',          4, 'mandat_v10')
ON CONFLICT ("code") DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'StatutEvenement') THEN
    CREATE TYPE "StatutEvenement" AS ENUM ('OUVERT', 'PRIS_EN_COMPTE', 'EN_COURS', 'CLOS');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'NatureEntreeMainCourante') THEN
    -- DECLARATION ouvre un evenement ; STATUT le fait avancer ; COMPLEMENT ajoute un fait sans
    -- changer le statut ; RECTIFICATION corrige une entree anterieure en la citant.
    CREATE TYPE "NatureEntreeMainCourante" AS ENUM ('DECLARATION', 'STATUT', 'COMPLEMENT', 'RECTIFICATION');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "main_courante" (
  "id"          TEXT PRIMARY KEY,
  -- L'evenement est l'ensemble des entrees qui partagent cet identifiant. La DECLARATION le
  -- cree ; les autres entrees le citent.
  "evenementId" TEXT NOT NULL,
  "nature"      "NatureEntreeMainCourante" NOT NULL,

  -- HORODATAGE SERVEUR, jamais fourni par l'appelant (declencheur). Et le client a part.
  "enregistreLe"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "horodatageClient" TIMESTAMP(3),

  "auteurId"    TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "sourceCode"  TEXT REFERENCES "referentiel_sources_evenement"("code") ON UPDATE CASCADE ON DELETE RESTRICT,

  -- Portes par la DECLARATION ; nuls sur les autres natures sauf si rectifies.
  "typeCode"    TEXT REFERENCES "referentiel_types_evenement"("code") ON UPDATE CASCADE ON DELETE RESTRICT,
  "statut"      "StatutEvenement",
  "texte"       TEXT NOT NULL,

  -- Rattachement lineaire : troncon + emprise ou point. Memes regles que les taches internes.
  "tronconId"   TEXT REFERENCES "troncons"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "debutM"      DOUBLE PRECISION,
  "finM"        DOUBLE PRECISION,
  "geom"        geometry(Point, 4326),

  -- Pieces : liste de {chemin, sha256, type}. Les fichiers vivent ailleurs ; ici leur empreinte.
  "pieces"      JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Pour une RECTIFICATION : l'entree corrigee, qui RESTE.
  "rectifieId"  TEXT REFERENCES "main_courante"("id") ON UPDATE CASCADE ON DELETE RESTRICT,

  -- Lien vers ce qui a declenche l'entree, si c'est un objet du depot.
  "signalementId" TEXT,
  "missionId"     TEXT,

  "clientOperationId" TEXT,

  CONSTRAINT "mc_texte_non_vide" CHECK (length(btrim("texte")) > 0),
  CONSTRAINT "mc_pieces_tableau" CHECK (jsonb_typeof("pieces") = 'array'),
  -- Une declaration dit quoi, d'ou, et ouvre l'evenement.
  CONSTRAINT "mc_declaration_complete" CHECK (
    "nature" <> 'DECLARATION'
    OR ("typeCode" IS NOT NULL AND "sourceCode" IS NOT NULL AND "statut" = 'OUVERT')
  ),
  -- Une entree de statut porte un statut ; les autres natures n'en portent pas, sauf la
  -- declaration (OUVERT).
  CONSTRAINT "mc_statut_selon_nature" CHECK (
    ("nature" = 'STATUT' AND "statut" IS NOT NULL AND "statut" <> 'OUVERT')
    OR ("nature" = 'DECLARATION')
    OR ("nature" IN ('COMPLEMENT', 'RECTIFICATION') AND "statut" IS NULL)
  ),
  -- Une rectification cite ce qu'elle corrige ; rien d'autre ne le fait.
  CONSTRAINT "mc_rectification_cite" CHECK (
    ("nature" = 'RECTIFICATION') = ("rectifieId" IS NOT NULL)
  ),
  CONSTRAINT "mc_emprise_coherente" CHECK (
    ("debutM" IS NULL AND "finM" IS NULL)
    OR ("debutM" IS NOT NULL AND "finM" IS NOT NULL AND "finM" > "debutM" AND "debutM" >= 0 AND "tronconId" IS NOT NULL)
  ),
  -- Une declaration est localisee : troncon ou point. Le reste herite de l'evenement.
  CONSTRAINT "mc_declaration_localisee" CHECK (
    "nature" <> 'DECLARATION' OR "tronconId" IS NOT NULL OR "geom" IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "main_courante_clientOperationId_key" ON "main_courante" ("clientOperationId");
-- Un evenement n'a qu'une declaration.
CREATE UNIQUE INDEX IF NOT EXISTS "main_courante_une_declaration_par_evenement"
  ON "main_courante" ("evenementId") WHERE "nature" = 'DECLARATION';
CREATE INDEX IF NOT EXISTS "main_courante_evenement_idx" ON "main_courante" ("evenementId", "enregistreLe");
CREATE INDEX IF NOT EXISTS "main_courante_troncon_idx" ON "main_courante" ("tronconId");
CREATE INDEX IF NOT EXISTS "main_courante_enregistre_idx" ON "main_courante" ("enregistreLe");
CREATE INDEX IF NOT EXISTS "main_courante_geom_gist" ON "main_courante" USING gist ("geom");

-- ===== Immutabilite : le declencheur =====

CREATE OR REPLACE FUNCTION main_courante_immuable() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'main_courante est en ajout seul : % refuse. Corrigez par une entree RECTIFICATION.', TG_OP
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- INSERT : l'heure du serveur se constate, elle ne se declare pas.
  IF NEW."enregistreLe" IS DISTINCT FROM CURRENT_TIMESTAMP(3)
     AND abs(extract(epoch from (NEW."enregistreLe" - CURRENT_TIMESTAMP(3)))) > 2 THEN
    RAISE EXCEPTION 'main_courante : enregistreLe est pose par le serveur, pas par l''appelant (recu %)', NEW."enregistreLe"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW."enregistreLe" := CURRENT_TIMESTAMP(3);
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS main_courante_ajout_seul ON "main_courante";
CREATE TRIGGER main_courante_ajout_seul
  BEFORE INSERT OR UPDATE OR DELETE ON "main_courante"
  FOR EACH ROW EXECUTE FUNCTION main_courante_immuable();

-- ===== L'etat courant de chaque evenement : une vue, jamais une colonne =====

CREATE OR REPLACE VIEW "evenements_exploitation" AS
WITH declarations AS (
  SELECT "evenementId", "id" AS "declarationId", "enregistreLe" AS "ouvertLe", "typeCode", "sourceCode",
         "texte", "tronconId", "debutM", "finM", "geom", "auteurId" AS "declarantId"
    FROM "main_courante" WHERE "nature" = 'DECLARATION'
),
derniers_statuts AS (
  SELECT DISTINCT ON ("evenementId") "evenementId", "statut", "enregistreLe" AS "statutDepuis", "auteurId" AS "statutParId"
    FROM "main_courante"
   WHERE "nature" IN ('DECLARATION', 'STATUT')
   ORDER BY "evenementId", "enregistreLe" DESC, "id" DESC
),
comptes AS (
  SELECT "evenementId", count(*)::integer AS "nbEntrees",
         count(*) FILTER (WHERE "nature" = 'RECTIFICATION')::integer AS "nbRectifications",
         max("enregistreLe") AS "derniereEntreeLe"
    FROM "main_courante" GROUP BY "evenementId"
)
SELECT d.*, s."statut", s."statutDepuis", s."statutParId", c."nbEntrees", c."nbRectifications", c."derniereEntreeLe",
       -- Delai de prise en compte (EX-08) : premiere entree PRIS_EN_COMPTE moins ouverture.
       (SELECT min(m."enregistreLe") FROM "main_courante" m
         WHERE m."evenementId" = d."evenementId" AND m."nature" = 'STATUT' AND m."statut" = 'PRIS_EN_COMPTE') - d."ouvertLe" AS "delaiPriseEnCompte",
       (SELECT min(m."enregistreLe") FROM "main_courante" m
         WHERE m."evenementId" = d."evenementId" AND m."nature" = 'STATUT' AND m."statut" = 'CLOS') - d."ouvertLe" AS "dureeTotale"
  FROM declarations d
  JOIN derniers_statuts s ON s."evenementId" = d."evenementId"
  JOIN comptes c ON c."evenementId" = d."evenementId";

COMMENT ON TABLE "main_courante" IS
  'Main courante du reseau (paragraphe 7.17, EX-01) : journal d''exploitation EN AJOUT SEUL. '
  'Immutabilite tenue par le declencheur main_courante_ajout_seul -- le premier de ce depot, '
  'admis une fois pour la table dont la valeur est de ne jamais changer. enregistreLe est '
  'l''heure du SERVEUR ; horodatageClient est conserve a part. Un evenement est une chaine '
  'd''entrees ; son statut courant est dans la vue evenements_exploitation.';

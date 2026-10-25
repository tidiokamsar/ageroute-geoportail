-- UN CHANTIER SUR PLUSIEURS TRONCONS OU SECTIONS (BDRI, lot G)
--
-- Un chantier ne portait qu'UN `tronconId`. Une rehabilitation de Coyah a Kindia couvre pourtant plusieurs
-- troncons, et souvent une partie seulement de chacun. Cette table relie un chantier a autant de troncons qu'il en
-- touche, avec, au besoin, la SECTION concernee : une portion existante (`portionId`) ou un intervalle d'abscisses
-- en metres le long du trace (`debutM`, `finM`), la convention des portions.
--
-- CE QUE CETTE MIGRATION NE FAIT PAS, ET C'EST VOLONTAIRE
--   * `chantiers.tronconId` n'est ni lu, ni copie, ni supprime : il reste le troncon principal, et les ecrans qui le
--     lisent continuent de fonctionner. Aucune ligne n'est semee ici.
--   * Aucune quantite, aucun montant, aucun statut contractuel n'est porte par le lien : ils restent au chantier et a
--     ses marches (le BDRI affiche, il ne se substitue pas au module des travaux).
--   * Un lien ne s'efface pas : il se RETIRE (`retireLe`, auteur, motif). Le declencheur refuse DELETE ; l'historique
--     d'un troncon garde les chantiers qui l'ont touche, meme retires.
--
-- NATURE : additive, une table, une fonction de declencheur. Aucune donnee lue ni ecrite ailleurs.
-- REVERSIBILITE : voir backend/prisma/descentes/20261027110000_chantier_sections.sql.

CREATE TABLE IF NOT EXISTS "chantier_sections" (
  "id"           TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "chantierId"   TEXT NOT NULL REFERENCES "chantiers"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "tronconId"    TEXT NOT NULL REFERENCES "troncons"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "portionId"    TEXT REFERENCES "portions"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "debutM"       DOUBLE PRECISION,
  "finM"         DOUBLE PRECISION,
  "commentaire"  TEXT,
  "creeParId"    TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "creeLe"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "retireLe"     TIMESTAMP(3),
  "retireParId"  TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "motifRetrait" TEXT,
  CONSTRAINT "chantier_sections_pkey" PRIMARY KEY ("id"),
  -- Un intervalle est entier ou absent : une borne seule ne dit rien.
  CONSTRAINT "chantier_section_bornes" CHECK (("debutM" IS NULL) = ("finM" IS NULL)),
  CONSTRAINT "chantier_section_ordre" CHECK ("debutM" IS NULL OR ("debutM" >= 0 AND "finM" > "debutM")),
  -- Une portion OU un intervalle, pas les deux : deux definitions de la meme section divergeraient.
  CONSTRAINT "chantier_section_une_definition" CHECK ("portionId" IS NULL OR "debutM" IS NULL),
  CONSTRAINT "chantier_section_retrait_complet" CHECK (("retireLe" IS NULL) = ("retireParId" IS NULL) AND ("retireLe" IS NULL OR length(btrim(coalesce("motifRetrait", ''))) >= 3))
);

CREATE INDEX IF NOT EXISTS "chantier_sections_chantier_idx" ON "chantier_sections" ("chantierId");
CREATE INDEX IF NOT EXISTS "chantier_sections_troncon_idx" ON "chantier_sections" ("tronconId");
-- Le meme lien ne s'enregistre pas deux fois tant qu'il est en vigueur.
CREATE UNIQUE INDEX IF NOT EXISTS "chantier_sections_en_vigueur_key"
  ON "chantier_sections" ("chantierId", "tronconId", coalesce("portionId", ''), coalesce("debutM", -1), coalesce("finM", -1))
  WHERE "retireLe" IS NULL;

CREATE OR REPLACE FUNCTION chantier_section_sans_suppression() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  RAISE EXCEPTION 'chantier_sections : un lien ne s''efface pas, il se retire (retireLe, auteur, motif)'
    USING ERRCODE = 'restrict_violation';
END
$f$;

DROP TRIGGER IF EXISTS "chantier_sections_sans_suppression" ON "chantier_sections";
CREATE TRIGGER "chantier_sections_sans_suppression"
  BEFORE DELETE ON "chantier_sections"
  FOR EACH ROW EXECUTE FUNCTION chantier_section_sans_suppression();

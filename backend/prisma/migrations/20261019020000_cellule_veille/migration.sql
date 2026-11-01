-- CELLULE DE VEILLE / CENTRE D'EXPLOITATION (paragraphe 7.17, EX-04)
--
-- « Vue temps reel murale et mobile, mode saison des pluies, astreintes, escalade. »
--
-- QUATRE OBJETS, ET AUCUNE VALEUR SEMEE
--
--   - `astreintes` : qui est joignable, de quand a quand, a quel niveau d'escalade, sur quel
--     perimetre (une region, ou national si nul). Saisies par AGEROUTE.
--   - `regles_escalade` : apres combien de minutes un evenement encore OUVERT (pris en compte par
--     personne) monte au niveau N. AUCUNE REGLE N'EST SEMEE : un delai d'escalade est une decision
--     d'organisation, et le mandat n'en donne aucun. Sans regle, il n'y a pas d'escalade -- et la
--     vue murale le dit.
--   - `escalades` : le journal de ce qui a ete escalade, a qui, quand. En ajout seul, une ligne par
--     (evenement, niveau) : evaluer deux fois ne double rien.
--   - `modes_veille` : le mode de la cellule (NORMAL ou SAISON_PLUIES), declare par une personne a
--     une heure. En ajout seul : le mode courant est la derniere declaration. Les SAISONS NE SONT
--     PAS CALCULEES depuis un calendrier : elles different selon les regions, et c'est la cellule
--     qui declare entrer en saison des pluies. Une regle d'escalade peut viser un mode.
--
-- AUCUNE NOTIFICATION N'EST ENVOYEE. Ni courriel, ni SMS, ni appel : le canal est une decision
-- d'AGEROUTE. L'escalade est inscrite, auditee, et affichee sur la vue murale ; la personne
-- d'astreinte designee est nommee. S'il n'y a personne d'astreinte au niveau voulu, l'escalade est
-- inscrite SANS destinataire, et la vue le montre comme un trou de permanence.
--
-- NATURE : additive. Quatre tables, deux declencheurs. Aucune ligne existante touchee.

CREATE TABLE IF NOT EXISTS "astreintes" (
  "id"        TEXT PRIMARY KEY,
  "userId"    TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "niveau"    INTEGER NOT NULL,
  -- Perimetre : une region, ou NUL pour une astreinte nationale.
  "regionId"  INTEGER REFERENCES "regions"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "debut"     TIMESTAMP(3) NOT NULL,
  "fin"       TIMESTAMP(3) NOT NULL,
  "creeParId" TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "astreinte_niveau" CHECK ("niveau" BETWEEN 1 AND 9),
  CONSTRAINT "astreinte_periode" CHECK ("fin" > "debut")
);
CREATE INDEX IF NOT EXISTS "astreintes_periode_idx" ON "astreintes" ("debut", "fin") WHERE "deletedAt" IS NULL;

CREATE TABLE IF NOT EXISTS "regles_escalade" (
  "id"           TEXT PRIMARY KEY,
  -- Type d'evenement vise ; NUL : tous les types.
  "typeCode"     TEXT REFERENCES "referentiel_types_evenement"("code") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Mode de la cellule ou la regle s'applique.
  "mode"         TEXT NOT NULL,
  "niveau"       INTEGER NOT NULL,
  -- Saisi par AGEROUTE, jamais par defaut.
  "delaiMinutes" INTEGER NOT NULL,
  "actif"        BOOLEAN NOT NULL DEFAULT true,
  "creeParId"    TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "regle_mode" CHECK ("mode" IN ('NORMAL', 'SAISON_PLUIES', 'TOUS')),
  CONSTRAINT "regle_niveau" CHECK ("niveau" BETWEEN 1 AND 9),
  CONSTRAINT "regle_delai" CHECK ("delaiMinutes" BETWEEN 1 AND 10080)
);
-- Une seule regle active par (type, mode, niveau) : deux delais pour le meme cas seraient une
-- contradiction que le code devrait trancher en silence.
CREATE UNIQUE INDEX IF NOT EXISTS "regles_escalade_unique_active"
  ON "regles_escalade" (COALESCE("typeCode", '*'), "mode", "niveau") WHERE "actif";

CREATE TABLE IF NOT EXISTS "escalades" (
  "id"            TEXT PRIMARY KEY,
  "evenementId"   TEXT NOT NULL,
  "niveau"        INTEGER NOT NULL,
  "regleId"       TEXT NOT NULL REFERENCES "regles_escalade"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "astreinteId"   TEXT REFERENCES "astreintes"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Personne d'astreinte designee ; NUL : personne n'etait d'astreinte a ce niveau.
  "destinataireId" TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "modeVeille"    TEXT NOT NULL,
  "declencheeLe"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "evalueeParId"  TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "escalade_niveau" CHECK ("niveau" BETWEEN 1 AND 9),
  CONSTRAINT "escalade_mode" CHECK ("modeVeille" IN ('NORMAL', 'SAISON_PLUIES'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "escalades_evenement_niveau_key" ON "escalades" ("evenementId", "niveau");

CREATE TABLE IF NOT EXISTS "modes_veille" (
  "id"         TEXT PRIMARY KEY,
  "mode"       TEXT NOT NULL,
  "motif"      TEXT NOT NULL,
  "declareParId" TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "declareLe"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rang"       BIGSERIAL NOT NULL,
  CONSTRAINT "mode_valide" CHECK ("mode" IN ('NORMAL', 'SAISON_PLUIES')),
  CONSTRAINT "mode_motif" CHECK (length(btrim("motif")) > 0)
);

-- ===== Ajout seul : escalades et modes =====

CREATE OR REPLACE FUNCTION veille_ajout_seul() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION '% est en ajout seul : % refuse.', TG_TABLE_NAME, TG_OP
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_TABLE_NAME = 'escalades' THEN
    NEW."declencheeLe" := CURRENT_TIMESTAMP(3);
    IF NOT EXISTS (SELECT 1 FROM "main_courante" WHERE "evenementId" = NEW."evenementId" AND "nature" = 'DECLARATION') THEN
      RAISE EXCEPTION 'escalades : evenement % inconnu de la main courante', NEW."evenementId" USING ERRCODE = 'foreign_key_violation';
    END IF;
  ELSE
    NEW."declareLe" := CURRENT_TIMESTAMP(3);
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS escalades_ajout_seul ON "escalades";
CREATE TRIGGER escalades_ajout_seul BEFORE INSERT OR UPDATE OR DELETE ON "escalades"
  FOR EACH ROW EXECUTE FUNCTION veille_ajout_seul();
DROP TRIGGER IF EXISTS modes_veille_ajout_seul ON "modes_veille";
CREATE TRIGGER modes_veille_ajout_seul BEFORE INSERT OR UPDATE OR DELETE ON "modes_veille"
  FOR EACH ROW EXECUTE FUNCTION veille_ajout_seul();

COMMENT ON TABLE "regles_escalade" IS
  'Regles d''escalade de la cellule de veille (EX-04). Aucune semee : les delais sont saisis par AGEROUTE.';
COMMENT ON TABLE "escalades" IS
  'Journal des escalades, en ajout seul, une ligne par (evenement, niveau). Aucune notification envoyee.';
COMMENT ON TABLE "modes_veille" IS
  'Mode de la cellule (NORMAL / SAISON_PLUIES), declare et non calcule. Ajout seul ; le courant est le dernier.';

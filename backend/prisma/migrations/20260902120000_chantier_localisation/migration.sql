-- Niveau de localisation des chantiers, et propositions issues des intitules (T5, T6).
--
-- POURQUOI
--
-- Mesure du 01/09/2026 sur les 488 chantiers :
--
--     PRECISE      (geometrie propre)             6    1,2 %
--     LINEAIRE     (troncon + PK, sans geometrie) 0    0,0 %
--     APPROX       (region reelle)              432   88,5 %
--     AUCUNE       (region « Non renseigne »)     50   10,2 %
--
-- Deux enseignements. Le niveau LINEAIRE, pourtant le plus realiste a alimenter, n'est
-- utilise par personne : les 4 chantiers portant un tronconId sont les memes que ceux
-- qui ont deja une geometrie. Et il existe un niveau SOUS l'approximatif : 50
-- chantiers sont rattaches a une entree nommee « Non renseigne », qui n'est pas une
-- region mais un contournement de la contrainte d'obligation.
--
-- Sans `statutLocalisation`, la carte ne pouvait pas distinguer ces cas, et placer les
-- 50 au centre d'une region aurait invente une position la ou il n'y en a aucune.
--
-- LES PROPOSITIONS
--
-- 36 intitules portent a la fois la route et les PK de debut et de fin :
--
--     « lot 12 : travaux de cantonnage manuel de la route PK24 - PK66 RN5 (42 km) »
--
-- La projection par ST_LineSubstring est calculable, mais deux reserves pesent.
--
-- D'abord les PK de la cible. Ils sont renseignes sur les 1 690 troncons et exploitables
-- sur 551 seulement : 1 069 portent pkDebut = pkFin = 0 (toutes les RR, toutes les RU,
-- et les 70 RN venues d'OSM, qui ne porte pas de PK). Pour ceux-la, deriveChantierGeom
-- retombe sur un repli qui lit le PK comme un kilometrage depuis le debut du trace —
-- hypothese plus faible, que la proposition doit signaler a l'agent.
--
-- Ensuite les intitules, qui sont du texte libre et piegent une extraction naive :
-- « PK50-Marela (PK103) » mele un PK et une localite dans la meme expression.
--
-- D'ou une table SEPAREE. Une proposition n'est pas une localisation : elle attend la
-- decision d'un agent, et `chantiers.geom` n'est ecrit qu'a la validation. Aucune
-- position deduite d'un texte n'entre en base sans que quelqu'un l'ait regardee.
--
-- LE CONTROLE DE COHERENCE
--
-- 221 intitules portent une longueur (« 42 km », « 1543 ml »). L'ecart entre cette
-- longueur citee et celle de l'emprise calculee dit si l'extraction a vu juste, et
-- c'est ce que l'agent regarde en premier. D'ou longueurCiteeKm / longueurCalculeeKm
-- / ecartPct portes par la proposition.
--
-- REVERSIBILITE
--
--     DROP TABLE "propositions_localisation";
--     ALTER TABLE "chantiers" DROP COLUMN "statutLocalisation";
--     DROP TYPE "StatutProposition"; DROP TYPE "StatutLocalisation";

DO $$ BEGIN
  CREATE TYPE "StatutLocalisation" AS ENUM ('NONE', 'APPROXIMATIVE', 'LINEAIRE', 'PRECISE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "StatutProposition" AS ENUM ('PROPOSED', 'VALIDATED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- NONE par defaut : un chantier n'est repute localise que si quelque chose l'etablit.
-- La valeur reelle est recalculee par scripts/reclasser-localisation.ts, jamais saisie.
ALTER TABLE "chantiers"
  ADD COLUMN IF NOT EXISTS "statutLocalisation" "StatutLocalisation" NOT NULL DEFAULT 'NONE';

CREATE INDEX IF NOT EXISTS "chantiers_statutLocalisation_idx"
  ON "chantiers" ("statutLocalisation");

CREATE TABLE IF NOT EXISTS "propositions_localisation" (
  "id"                 TEXT                NOT NULL,
  "chantierId"         TEXT                NOT NULL,
  "statut"             "StatutProposition" NOT NULL DEFAULT 'PROPOSED',
  "methode"            TEXT                NOT NULL,
  "sourceTexte"        TEXT                NOT NULL,
  "confiance"          "NiveauConfiance"   NOT NULL,
  "tronconId"          TEXT,
  "pkDebut"            DOUBLE PRECISION,
  "pkFin"              DOUBLE PRECISION,
  "longueurCiteeKm"    DOUBLE PRECISION,
  "longueurCalculeeKm" DOUBLE PRECISION,
  "ecartPct"           DOUBLE PRECISION,
  "createdAt"          TIMESTAMP(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt"          TIMESTAMP(3),
  "decidedById"        TEXT,
  "motifRejet"         TEXT,

  CONSTRAINT "propositions_localisation_pkey" PRIMARY KEY ("id")
);

-- Geometrie proposee, ajoutee hors de la definition de table parce que Prisma ne gere
-- pas le type geometry. Meme SRID que le reste de la base : 4326, verifie sur les
-- 1 690 troncons sans exception.
DO $$ BEGIN
  PERFORM AddGeometryColumn('public', 'propositions_localisation', 'geom', 4326, 'LINESTRING', 2);
EXCEPTION WHEN OTHERS THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "propositions_localisation_chantierId_idx"
  ON "propositions_localisation" ("chantierId");

CREATE INDEX IF NOT EXISTS "propositions_localisation_statut_idx"
  ON "propositions_localisation" ("statut");

DO $$ BEGIN
  ALTER TABLE "propositions_localisation"
    ADD CONSTRAINT "propositions_localisation_chantierId_fkey"
    FOREIGN KEY ("chantierId") REFERENCES "chantiers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "propositions_localisation"
    ADD CONSTRAINT "propositions_localisation_tronconId_fkey"
    FOREIGN KEY ("tronconId") REFERENCES "troncons"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "propositions_localisation"
    ADD CONSTRAINT "propositions_localisation_decidedById_fkey"
    FOREIGN KEY ("decidedById") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

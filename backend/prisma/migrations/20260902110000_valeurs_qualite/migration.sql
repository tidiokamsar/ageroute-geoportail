-- Qualite d'une valeur : statut, source, methode, date du constat (T3, T4).
--
-- POURQUOI
--
-- Deux mesures du 01/09/2026 fondent cette table.
--
-- 1. `revetement` vaut BITUME sur les 1 690 troncons, sans une seule exception,
--    regionales comprises. Une valeur unique sur 1 690 lignes n'est pas une
--    observation : c'est un defaut d'import. Et la base se contredit elle-meme —
--    29 intitules de chantiers decrivent des routes « en terre », « piste » ou
--    « laterite », dont « Route Prefectorale en terre Pita-Maci-Sangareah ».
--
-- 2. Trois dates metier sont renseignees sur 4 970 attendues. Les 647 troncons dont
--    l'etat est connu ne sont donc pas comparables : un « BON » de cette annee et un
--    « BON » d'il y a dix ans occupent la meme case.
--
-- Sans cette table, l'interface presentait BITUME comme une caracteristique du reseau
-- et un etat non date comme un constat.
--
-- POURQUOI UNE TABLE, PAS DES COLONNES
--
-- Six champs alimentent une decision : etat, longueur, revetement, trafic, criticite,
-- cout. Leur attacher statut, source, methode, date, auteur et confiance en colonnes
-- ferait trente-six colonnes sur `troncons`, puis autant sur `ouvrages`.
--
-- Une table separee porte la meme information sans toucher UNE SEULE colonne
-- existante. C'est ce qui rend cette migration integralement non destructive : elle
-- n'ecrit rien dans les donnees metier, et son retrait se reduit a un DROP TABLE.
--
-- POURQUOI PAR CHAMP ET NON PAR ENREGISTREMENT
--
-- Un troncon typique a aujourd'hui une geometrie VERIFIEE, une longueur ABSENTE et un
-- revetement CONTREDIT. Un statut unique porte par l'objet devrait choisir entre ces
-- trois niveaux, et perdrait exactement ce qui est utile.
--
-- LA DATE N'EST PAS DECORATIVE
--
-- `observedAt` est la date du CONSTAT ; `createdAt` est la date d'ecriture de la
-- ligne. Les confondre est l'erreur que cette table existe pour empecher — c'est
-- pourquoi `updatedAt` de l'enregistrement metier ne peut pas en tenir lieu.
--
-- CONFLICTING N'EST PAS UNE ERREUR
--
-- C'est un signalement : deux sources internes se contredisent, et quelqu'un doit
-- trancher avec une source externe. Marquer n'est pas corriger — aucune valeur n'est
-- remplacee, faute de source pour le faire.
--
-- REVERSIBILITE
--
--     DROP TABLE "valeurs_qualite"; DROP TYPE "StatutValeur";

DO $$ BEGIN
  CREATE TYPE "StatutValeur" AS ENUM (
    'OBSERVED',
    'IMPORTED_UNVERIFIED',
    'DERIVED',
    'CONFLICTING',
    'UNKNOWN'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "valeurs_qualite" (
  "id"           TEXT           NOT NULL,
  "entityType"   TEXT           NOT NULL,
  "entityId"     TEXT           NOT NULL,
  "champ"        TEXT           NOT NULL,
  "statut"       "StatutValeur" NOT NULL,
  "source"       TEXT,
  "methode"      TEXT,
  "observedAt"   TIMESTAMP(3),
  "observedById" TEXT,
  "confiance"    "NiveauConfiance",
  "note"         TEXT,
  "createdAt"    TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3)   NOT NULL,

  CONSTRAINT "valeurs_qualite_pkey" PRIMARY KEY ("id")
);

-- Une seule ligne de qualite par (entite, enregistrement, champ). Sans cette
-- contrainte, un script rejoue deux fois empilerait des statuts contradictoires sur
-- le meme champ.
CREATE UNIQUE INDEX IF NOT EXISTS "valeurs_qualite_entityType_entityId_champ_key"
  ON "valeurs_qualite" ("entityType", "entityId", "champ");

-- Sert la question posee par le tableau de bord qualite : « combien de valeurs de ce
-- champ sont importees non verifiees ? »
CREATE INDEX IF NOT EXISTS "valeurs_qualite_entityType_champ_statut_idx"
  ON "valeurs_qualite" ("entityType", "champ", "statut");

CREATE INDEX IF NOT EXISTS "valeurs_qualite_statut_idx"
  ON "valeurs_qualite" ("statut");

DO $$ BEGIN
  ALTER TABLE "valeurs_qualite"
    ADD CONSTRAINT "valeurs_qualite_observedById_fkey"
    FOREIGN KEY ("observedById") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Aucune valeur n'est ecrite ici : le marquage retroactif est un script separe et
-- rejouable (scripts/backfill-qualite.ts).

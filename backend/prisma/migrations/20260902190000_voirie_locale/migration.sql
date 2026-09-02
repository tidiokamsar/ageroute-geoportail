-- Voirie locale issue d'une source cartographique externe (P4).
--
-- POURQUOI UNE TABLE, ET PAS DES LIGNES DANS `troncons`
--
-- Trois raisons mesurees.
--
-- Ce n'est pas un actif AGEROUTE. Une voie OpenStreetMap n'appartient au patrimoine
-- que si AGEROUTE l'a validee. Les melanger rendrait la distinction intenable.
--
-- Les comptages exploseraient. `troncons` porte 1 690 lignes ; y verser 262 656
-- objets multiplierait par 156 tous les indicateurs, tableaux de bord et exports.
--
-- Les contraintes ne correspondent pas. `Troncon` exige regionId, longueurKm,
-- revetement, etat, pkDebut et pkFin — non nuls. Aucun n'est disponible cote OSM.
-- Les remplir par defaut fabriquerait exactement la donnee fictive que les phases
-- precedentes ont passe du temps a demasquer.
--
-- CE QUE LA SOURCE PORTE, ET CE QU'ELLE NE PORTE PAS
--
-- Audit du 02/09/2026 sur ROUTE.shp — 262 656 objets, 15 champs. Le vide y est code
-- « NC », pas par une chaine vide : un comptage naif annonce 100 % sur les quinze
-- champs. Taux reels apres exclusion de « NC » :
--
--     NATURE, SOURCE, DATE_MAJ    100 %
--     NUMERO                        0,6 %
--     NOM                           0,4 %
--     GESTION, POID_MAX               0 %
--     CL_ADMIN                    100 % — mais UNE seule valeur : « Autre »
--
-- CL_ADMIN etant constant, cette source ne porte AUCUN rattachement administratif.
-- C'est pourquoi il n'y a ici ni prefectureId, ni communeId, ni locality : quatre
-- colonnes vides sur un quart de million de lignes n'aideraient personne. `regionId`
-- existe, nullable, avec `regionMethode` pour dire comment il a ete obtenu — jamais
-- pour faire passer une intersection geometrique pour une donnee source.
--
-- VALIDEE N'EST PAS « ACTIF AGEROUTE »
--
-- Le statut porte la validation CARTOGRAPHIQUE : le trace est juge correct. Le
-- classement institutionnel est une decision distincte, materialisee par
-- `tronconId`. Une rue de quartier bien cartographiee n'est pas une route
-- nationale, et une voie VALIDEE sans tronconId est un etat parfaitement legitime —
-- le plus frequent attendu.
--
-- L'INDEX, ET LA LECON APPLIQUEE A L'ENVERS
--
-- La phase 3 avait etabli qu'un index doit porter LA FORME QUE LA REQUETE UTILISE :
-- sur `troncons`, un index sur geom etait ignore la ou (geom::geography) divisait le
-- temps par quarante, parce que ces requetes-la raisonnent en metres.
--
-- Ici c'est l'inverse, et la premiere version de cette migration s'est trompee. Le
-- service de la voirie filtre par emprise — `geom && ST_MakeEnvelope(...)` — un
-- operateur qui travaille sur `geometry`. Un index sur (geom::geography) ne lui sert
-- a rien.
--
-- Mesure sur les 262 656 lignes, emprise de Conakry :
--
--     GIST ((geom::geography))   Parallel Seq Scan    175 ms
--     GIST (geom)                Bitmap Index Scan      7 ms
--
-- Vingt-cinq fois plus rapide, et c'est la requete que la carte emet a chaque
-- deplacement. Un seul index : en ajouter un second, inutilise, couterait a chaque
-- ecriture sur un quart de million de lignes.
--
-- REVERSIBILITE
--
--     DROP TABLE "voirie_locale";
--     DROP TYPE "StatutVoirie"; DROP TYPE "CategorieVoirie"; DROP TYPE "SourceVoirie";

DO $$ BEGIN
  CREATE TYPE "SourceVoirie" AS ENUM ('OSM', 'IMPORT_AGEROUTE', 'SAISIE_APPLICATIVE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CategorieVoirie" AS ENUM (
    'VOIE_RAPIDE', 'PRINCIPALE', 'SECONDAIRE', 'TERTIAIRE',
    'VOIE_LOCALE', 'RESIDENTIELLE', 'ACCES',
    'CHEMIN', 'SENTIER', 'PIETON', 'INCONNU'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "StatutVoirie" AS ENUM (
    'SOURCE_EXTERNE', 'CANDIDATE', 'VALIDEE', 'REJETEE', 'ARCHIVEE'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "voirie_locale" (
  "id"                 TEXT              NOT NULL,
  "source"             "SourceVoirie"    NOT NULL,
  "sourceId"           TEXT              NOT NULL,
  "sourceDate"         TIMESTAMP(3),
  "importedAt"         TIMESTAMP(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "importLot"          TEXT              NOT NULL,
  "nature"             TEXT              NOT NULL,
  "nom"                TEXT,
  "reference"          TEXT,
  "sens"               TEXT,
  "categorie"          "CategorieVoirie" NOT NULL,
  "longueurCalculeeKm" DOUBLE PRECISION  NOT NULL,
  "regionId"           INTEGER,
  "regionMethode"      TEXT,
  "statut"             "StatutVoirie"    NOT NULL DEFAULT 'SOURCE_EXTERNE',
  "tronconId"          TEXT,
  "createdAt"          TIMESTAMP(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "voirie_locale_pkey" PRIMARY KEY ("id")
);

-- Geometrie hors definition de table : Prisma ne gere pas le type geometry.
-- SRID 4326, identique au reste de la base et aux fichiers source (WGS 84).
DO $$ BEGIN
  PERFORM AddGeometryColumn('public', 'voirie_locale', 'geom', 4326, 'LINESTRING', 2);
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- Un objet source ne peut entrer deux fois. L'audit n'a mesure aucun doublon de
-- geometrie dans ROUTE.shp, mais rien ne garantit qu'une extraction ulterieure n'en
-- produise, ni qu'un import soit rejoue par megarde.
CREATE UNIQUE INDEX IF NOT EXISTS "voirie_locale_source_sourceId_key"
  ON "voirie_locale" ("source", "sourceId");

CREATE INDEX IF NOT EXISTS "voirie_locale_categorie_idx" ON "voirie_locale" ("categorie");
CREATE INDEX IF NOT EXISTS "voirie_locale_statut_idx"    ON "voirie_locale" ("statut");

-- L'index qui porte tout l'affichage : chaque requete de la carte est cadree par
-- emprise, avec l'operateur && sur la geometrie.
CREATE INDEX IF NOT EXISTS "voirie_locale_geom_idx"
  ON "voirie_locale" USING GIST ("geom");

DO $$ BEGIN
  ALTER TABLE "voirie_locale"
    ADD CONSTRAINT "voirie_locale_regionId_fkey"
    FOREIGN KEY ("regionId") REFERENCES "regions"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "voirie_locale"
    ADD CONSTRAINT "voirie_locale_tronconId_fkey"
    FOREIGN KEY ("tronconId") REFERENCES "troncons"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Aucune donnee n'est ecrite ici. L'import est un script separe et rejouable
-- (scripts/import-voirie-osm.ts), pour que la migration reste une modification de
-- structure et que le chargement puisse etre verifie, rejoue ou annule seul.

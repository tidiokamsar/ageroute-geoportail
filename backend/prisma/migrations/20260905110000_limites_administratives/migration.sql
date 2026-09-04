-- Limites administratives officielles (P5).
--
-- LE MANQUE QUE CETTE TABLE COMBLE
--
-- Signale depuis l'audit de phase 4 et jamais comble : aucun decoupage administratif
-- geographique n'existait en base. Consequences mesurees :
--
--   254 550 troncons rattaches a une region « Non renseigne » — qui n'est pas une
--   region mais un contournement de la contrainte NOT NULL ;
--
--   299 chantiers non geolocalisables, parce que l'appariement par nom de localite
--   n'a aucune cible ;
--
--   les « zones urbaines » qu'il a fallu designer ville par ville, faute de limites.
--
-- LA SOURCE
--
-- Guinea - Subnational Administrative Boundaries (COD-AB), publie par OCHA Field
-- Information Services Section sur HDX, mis a jour le 26/01/2026. Trois niveaux :
-- 8 regions, 34 prefectures, 340 sous-prefectures. Les geometries portent
-- `valid_on = 2016-03-04`.
--
-- Chaque entite porte un P-CODE, identifiant stable concu pour l'appariement entre
-- jeux humanitaires. C'est ce qui manquait le plus : « Nzerekore », « N'Zerekore » et
-- « Nzérékoré » sont trois chaines et une seule region — une apostrophe a d'ailleurs
-- fait declarer a tort un marche public manquant le 04/09/2026.
--
-- CE QUE CETTE SOURCE NE PORTE PAS
--
-- Le decoupage d'AVANT la reforme du 20 aout 2026. Elle ignore donc Siguiri et Beyla,
-- devenues regions, et les onze prefectures creees. `validOn` et `validTo` sont
-- conserves tels quels pour que cette limite reste lisible, plutot que d'etre corrigee
-- en silence.
--
-- Les P-codes OCHA (GN001…) sont un systeme DISTINCT des codes du decret D/2025/055
-- (01…) deja portes par `regions.code`. Les deux sont legitimes et cohabitent ; les
-- confondre serait une erreur d'appariement.
--
-- POURQUOI UNE TABLE SEPAREE PLUTOT QU'UNE GEOMETRIE SUR `regions`
--
-- `regions` porte 11 lignes issues du decoupage ACTUEL, dont deux sans geometrie
-- possible ici. Cette table porte une SOURCE EXTERNE datee, a trois niveaux, avec sa
-- propre validite. Les melanger ferait perdre la distinction entre ce que l'Etat a
-- decide et ce qu'un jeu de donnees represente.
--
-- REVERSIBILITE
--
--     DROP TABLE "limites_admin";

CREATE TABLE IF NOT EXISTS "limites_admin" (
  "pcode"       TEXT NOT NULL,
  "niveau"      INTEGER NOT NULL,
  "nom"         TEXT NOT NULL,
  "parentPcode" TEXT,
  "validOn"     DATE,
  "validTo"     DATE,
  "source"      TEXT NOT NULL,
  "sourceDate"  DATE,
  "importedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "limites_admin_pkey" PRIMARY KEY ("pcode")
);

-- Geometrie hors definition de table : Prisma ne gere pas le type geometry.
-- MULTIPOLYGON et non POLYGON : Boke, Conakry et Kindia sont multi-parties (iles).
DO $$ BEGIN
  PERFORM AddGeometryColumn('public', 'limites_admin', 'geom', 4326, 'MULTIPOLYGON', 2);
EXCEPTION WHEN OTHERS THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "limites_admin_niveau_idx" ON "limites_admin" ("niveau");
CREATE INDEX IF NOT EXISTS "limites_admin_parent_idx" ON "limites_admin" ("parentPcode");

-- L'index qui porte tout l'usage : « dans quelle region tombe ce troncon » est une
-- intersection, et 254 550 troncons vont la poser. Sur `geometry`, la forme que
-- l'operateur && utilise — la lecon de l'index de la voirie locale, ou un index sur
-- (geom::geography) laissait passer un Parallel Seq Scan de 175 ms.
CREATE INDEX IF NOT EXISTS "limites_admin_geom_idx" ON "limites_admin" USING GIST ("geom");

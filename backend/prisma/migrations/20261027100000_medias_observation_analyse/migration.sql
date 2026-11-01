-- COLONNES D'ANALYSE DES PHOTOS D'OBSERVATION : LA DERIVE ENTRE schema.prisma ET LES MIGRATIONS
--
-- LE CONSTAT (25/10/2026, audit de la base) : `schema.prisma` declare sur `MediaObservation` les cinq colonnes
-- d'analyse (`analyseeLe`, `analyseModele`, `analyseVersion`, `analyseResultat`, `analyseConfiance`, architecture
-- prete pour la vision, T-03), mais la migration 20261014170000 ne les a ajoutees qu'a `medias_defaut`. Sur une base
-- construite par les seules migrations, `medias_observation` ne les porte pas : toute ecriture par le client Prisma
-- (`prisma.mediaObservation.create`, route `POST /v2/observations/:id/photos`) echoue, puisque Prisma nomme TOUTES les
-- colonnes du modele dans son INSERT ... RETURNING.
--
-- CE QUE FAIT CETTE MIGRATION : elle aligne `medias_observation` sur `medias_defaut`, a l'identique (memes colonnes,
-- memes contraintes, memes sens : « nulle = personne n'a regarde », jamais « analyse sans detection »).
--
-- IDEMPOTENTE ET SANS DANGER SI LES COLONNES EXISTENT DEJA : la production a ete construite par `db push` (descentes/README.md),
-- donc elle les porte peut-etre deja. `ADD COLUMN IF NOT EXISTS`, contraintes et index crees seulement s'ils manquent : dans ce
-- cas la migration ne change RIEN. Aucune donnee lue ni ecrite ; les lignes existantes gardent des colonnes nulles
-- (coherent : personne n'a regarde).
--
-- NATURE : additive. REVERSIBILITE : voir descentes/20261027100000_medias_observation_analyse.sql.

ALTER TABLE "medias_observation"
  ADD COLUMN IF NOT EXISTS "analyseeLe"       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "analyseModele"    TEXT,
  ADD COLUMN IF NOT EXISTS "analyseVersion"   TEXT,
  ADD COLUMN IF NOT EXISTS "analyseResultat"  JSONB,
  ADD COLUMN IF NOT EXISTS "analyseConfiance" DECIMAL(4,3);

COMMENT ON COLUMN "medias_observation"."analyseeLe" IS
  'Quand un modele a examine ce media. NULLE signifie PERSONNE N''A REGARDE, ce qui est distinct d''une analyse sans detection.';

COMMENT ON COLUMN "medias_observation"."analyseResultat" IS
  'Propositions du modele. Un tableau VIDE signifie analyse sans detection. Ces propositions ne sont jamais des donnees officielles : elles passent par le workflow de validation.';

DO $contraintes$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'media_obs_analyse_coherente' AND conrelid = '"medias_observation"'::regclass) THEN
    ALTER TABLE "medias_observation" ADD CONSTRAINT "media_obs_analyse_coherente" CHECK (
      ("analyseeLe" IS NULL AND "analyseModele" IS NULL AND "analyseResultat" IS NULL)
      OR ("analyseeLe" IS NOT NULL AND "analyseModele" IS NOT NULL)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'media_obs_analyse_resultat_est_un_tableau' AND conrelid = '"medias_observation"'::regclass) THEN
    ALTER TABLE "medias_observation" ADD CONSTRAINT "media_obs_analyse_resultat_est_un_tableau" CHECK (
      "analyseResultat" IS NULL OR jsonb_typeof("analyseResultat") = 'array'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'media_obs_analyse_confiance_bornee' AND conrelid = '"medias_observation"'::regclass) THEN
    ALTER TABLE "medias_observation" ADD CONSTRAINT "media_obs_analyse_confiance_bornee" CHECK (
      "analyseConfiance" IS NULL OR ("analyseConfiance" >= 0 AND "analyseConfiance" <= 1)
    );
  END IF;
END
$contraintes$;

CREATE INDEX IF NOT EXISTS "medias_observation_analyseeLe_idx" ON "medias_observation" ("analyseeLe");

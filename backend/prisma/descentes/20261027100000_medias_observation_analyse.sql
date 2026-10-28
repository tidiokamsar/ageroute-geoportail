-- RETOUR ARRIERE de `20261027100000_medias_observation_analyse`.
--
-- CE QUI EST PERDU : le resultat d'analyse (modele, version, propositions, confiance) de toute photo d'observation deja
-- analysee. Une analyse ne se reconstitue pas sans rejouer le modele.
--
-- GARDE : la descente REFUSE de s'executer si une photo d'observation porte une analyse. Pour passer outre, apres
-- sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- ATTENTION : si la production portait DEJA ces colonnes avant cette migration (construite par `db push`), cette descente les
-- retirerait aussi : le schema Prisma les declare, le client les nomme, et la route des photos d'observation cesserait de
-- fonctionner. Ne l'executer qu'en connaissance de cause.
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261027100000_medias_observation_analyse.sql
--
-- GARDE-TEST: INSERT INTO "users" ("id","email","nomComplet","passwordHash","role","updatedAt") VALUES ('g-u2','g2@local.invalid','x','x','GESTIONNAIRE',now()); INSERT INTO "observations" ("id","clientOperationId","agentId","type","observeA","updatedAt") VALUES ('g-o2','g-op2','g-u2','DEGRADATION',now(),now()); INSERT INTO "medias_observation" ("id","observationId","type","chemin","sha256","mimeType","tailleOctets","analyseeLe","analyseModele") VALUES ('g-m2','g-o2','PHOTO','g.jpg','g-sha2','image/jpeg',1,now(),'modele-essai');

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "medias_observation" WHERE "analyseeLe" IS NOT NULL OR "analyseResultat" IS NOT NULL;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % photo(s) d''observation portent une analyse. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

DROP INDEX IF EXISTS "medias_observation_analyseeLe_idx";

ALTER TABLE "medias_observation"
  DROP CONSTRAINT IF EXISTS "media_obs_analyse_confiance_bornee",
  DROP CONSTRAINT IF EXISTS "media_obs_analyse_resultat_est_un_tableau",
  DROP CONSTRAINT IF EXISTS "media_obs_analyse_coherente";

ALTER TABLE "medias_observation"
  DROP COLUMN IF EXISTS "analyseConfiance",
  DROP COLUMN IF EXISTS "analyseResultat",
  DROP COLUMN IF EXISTS "analyseVersion",
  DROP COLUMN IF EXISTS "analyseModele",
  DROP COLUMN IF EXISTS "analyseeLe";

-- RETOUR ARRIERE de `20261024100000_sessions_roulage`.
--
-- CE QUI EST PERDU : les sessions de roulage, leurs traces GNSS brutes, leurs marqueurs, leurs
-- evenements lineaires et le LIEN entre chaque evenement et les portions qu'il a produites. Les
-- PORTIONS elles-memes restent : elles vivent dans `portions` (statut A_VALIDER ou valide), avec
-- leur audit, et leur colonne `source` cite la session. Compter avant :
--
--   SELECT (SELECT count(*) FROM sessions_roulage) AS sessions,
--          (SELECT count(*) FROM marqueurs_roulage) AS marqueurs,
--          (SELECT count(*) FROM evenements_roulage) AS evenements,
--          (SELECT count(*) FROM evenements_roulage_portions) AS liens_portions;
--
-- La trace brute d'une session n'est stockee QUE dans `sessions_roulage.points` : la perdre, c'est
-- perdre la seule copie serveur d'une collecte faite sur le terrain (le telephone peut l'avoir
-- supprimee apres synchronisation). Sauvegarde verifiee et autorisation explicite (paragraphe A.5.2).
--
-- GARDE : la descente REFUSE de s'executer si une session existe. Pour passer outre :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261024100000_sessions_roulage.sql
--
-- GARDE-TEST: INSERT INTO "sessions_roulage" ("id","clientOperationId","userId","appareilId","debutA","finA","versionContrat","provenanceParametres","parametres","nbPoints","points","trous","interruptions","pauses","compteurs","analyse") VALUES ('g1','g1','g-u','g-a',now(),now(),1,'PROVISOIRE_NON_CALIBRE','{}',2,'[]','[]','[]','[]','{}','{}');

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "sessions_roulage";
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % session(s) de roulage (traces brutes comprises). Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

DROP TABLE IF EXISTS "evenements_roulage_portions";
DROP TABLE IF EXISTS "evenements_roulage";
DROP TABLE IF EXISTS "marqueurs_roulage";
DROP TABLE IF EXISTS "sessions_roulage";

-- Et la ligne de `_prisma_migrations` :
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261024100000_sessions_roulage';

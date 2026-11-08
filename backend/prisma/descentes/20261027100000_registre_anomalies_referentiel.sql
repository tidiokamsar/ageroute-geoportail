-- RETOUR ARRIERE de `20261027100000_registre_anomalies_referentiel`.
--
-- CE QUI EST PERDU : les anomalies enregistrees et TOUT le journal des decisions (qui a examine, propose, valide,
-- rejete ou applique quelle correction, et pourquoi). Les corrections deja APPLIQUEES aux troncons restent en
-- place, et leur trace reste dans `audit_logs` ; seul le registre disparait.
--
-- GARDE : la descente REFUSE de s'executer si une anomalie ou une decision existe. Pour passer outre, apres
-- sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261027100000_registre_anomalies_referentiel.sql
--
-- GARDE-TEST: INSERT INTO "troncons" ("id","code","nom","classe","regionId","longueurKm","revetement","pkDebut","pkFin","updatedAt") VALUES ('g1','G1','x','RN',1,1,'BITUME',0,0,now()); INSERT INTO "anomalies_referentiel" ("tronconId","regle","empreinte","gravite","valeurs","source") VALUES ('g1','PK_NON_RENSEIGNES','e','MAJEURE','{}','essai de garde');

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "anomalies_referentiel") + (SELECT count(*) FROM "decisions_anomalie") INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % anomalie(s) ou decision(s) enregistrees. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

DROP TABLE IF EXISTS "decisions_anomalie";
DROP TABLE IF EXISTS "anomalies_referentiel";
DROP FUNCTION IF EXISTS decision_anomalie_ajout_seul();

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261027100000_registre_anomalies_referentiel';

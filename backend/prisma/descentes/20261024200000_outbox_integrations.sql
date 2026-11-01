-- RETOUR ARRIERE de `20261024200000_outbox_integrations`.
--
-- CE QUI EST PERDU : le journal des evenements prepares ou emis vers DigitalRoad, SharePoint et
-- la BDR / L2R, et l'archive de chaque tentative (issue, code HTTP, accuse de reception). Un
-- evenement ENVOYE est la seule preuve, cote AGEROUTE, de ce qui a ete remis a un tiers ; l'effacer
-- rendrait un rejeu possible a l'insu de tous. Compter avant :
--
--   SELECT statut, count(*) FROM outbox_evenements GROUP BY 1;
--   SELECT count(*) FROM outbox_tentatives;
--
-- GARDE : la descente REFUSE de s'executer si l'une des deux tables porte des lignes. Pour passer
-- outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261024200000_outbox_integrations.sql
--
-- Les lignes d'audit (`audit_logs`, entityType OutboxEvenement) ne sont PAS touchees : elles
-- gardent la trace des transitions meme si la table disparait.
--
-- GARDE-TEST: INSERT INTO "outbox_evenements" ("id","destination","typeEvenement","sourceType","sourceId","version","cleIdempotence","chargeCanonique","empreinteCharge","creeParId") SELECT 'g1','BDR_L2R','PIVOT_OBJET_VALIDE','Troncon','t-g1',1, encode(sha256(convert_to('BDR_L2R|PIVOT_OBJET_VALIDE|Troncon|t-g1|' || encode(sha256(convert_to('{"a":1}','UTF8')),'hex'),'UTF8')),'hex'), '{"a":1}', encode(sha256(convert_to('{"a":1}','UTF8')),'hex'), 'u-g1';
--
-- EXECUTEE ET VERIFIEE par le banc `verifier.sh` (aller-retour et garde) : voir TEST_EVIDENCE.md.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "outbox_evenements") + (SELECT count(*) FROM "outbox_tentatives") INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % ligne(s) dans l''outbox et son journal de tentatives. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

-- Les declencheurs d'abord : ils interdisent le DELETE que la garde vient d'autoriser.
DROP TRIGGER IF EXISTS outbox_tentatives_ajout_seul ON "outbox_tentatives";
DROP TRIGGER IF EXISTS outbox_garde ON "outbox_evenements";
DROP TABLE IF EXISTS "outbox_tentatives";
DROP TABLE IF EXISTS "outbox_evenements";
DROP FUNCTION IF EXISTS outbox_tentatives_ajout_seul();
DROP FUNCTION IF EXISTS outbox_garde();
DROP FUNCTION IF EXISTS outbox_source_refus(TEXT, TEXT);

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261024200000_outbox_integrations';
--
-- Volontairement absente : ce geste doit etre conscient, pas un effet de bord.

-- RETOUR ARRIERE de `20261026100000_conflit_sync_verification`.
--
-- CE QUI EST PERDU : l'historique des demandes de verification posees sur des conflits de
-- synchronisation (qui, quand, motif). Les conflits eux-memes, leurs deux versions et leur resolution
-- ne sont PAS touches. La trace d'audit (`audit_logs`, entityType ConflitSync) garde la demande meme
-- apres la descente.
--
-- GARDE : la descente REFUSE de s'executer si une demande de verification existe. Pour passer outre,
-- apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261026100000_conflit_sync_verification.sql
--
-- GARDE-TEST: INSERT INTO "conflits_sync" ("id","operationId","entityType","entityId","payloadLocal","payloadServeur","verificationDemandeeA","verificationDemandeeParId","verificationMotif") VALUES ('g-cv1','op-g-cv1','Observation','e-g-cv1','{}','{}', now(), 'u-g-cv1', 'a verifier');
--
-- EXECUTEE ET VERIFIEE par le banc `verifier.sh` (aller-retour et garde) : voir docs/scenarios/SYNC-A7-A8.md.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "conflits_sync" WHERE "verificationDemandeeA" IS NOT NULL;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % demande(s) de verification de conflit de synchronisation. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

ALTER TABLE "conflits_sync" DROP CONSTRAINT IF EXISTS "conflit_verification_porte_son_auteur";
ALTER TABLE "conflits_sync"
  DROP COLUMN IF EXISTS "verificationMotif",
  DROP COLUMN IF EXISTS "verificationDemandeeParId",
  DROP COLUMN IF EXISTS "verificationDemandeeA";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261026100000_conflit_sync_verification';
--
-- Volontairement absente : ce geste doit etre conscient, pas un effet de bord.

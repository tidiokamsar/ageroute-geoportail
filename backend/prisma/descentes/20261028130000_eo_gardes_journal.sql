-- RETOUR ARRIERE de `20261028130000_eo_gardes_journal`.
--
-- CE QUI EST PERDU : des GARDES, aucune donnee. Apres la descente, le declencheur differe du journal des propositions redevient celui de
-- 20261028110000 (il apparie un changement de statut a une ligne de meme couple, sans compter, et ne voit pas un changement de motif
-- d'attente ni l'auteur du verdict) et les produits ne sont plus proteges contre une modification de leur provenance, de leurs dates ou de
-- leur emprise. Les lignes `audit_logs` des corrections de produits deja faites restent (le journal d'audit est conserve).
--
-- AUCUNE GARDE DE DONNEES : la descente ne supprime ni colonne, ni table, ni ligne ; elle n'a donc rien a refuser. Elle est idempotente
-- (IF EXISTS, CREATE OR REPLACE).
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261028130000_eo_gardes_journal.sql

DROP TRIGGER IF EXISTS earth_observation_products_garde ON "earth_observation_products";
DROP FUNCTION IF EXISTS earth_observation_products_garde();

DROP TRIGGER IF EXISTS propositions_teledetection_journal_exige ON "propositions_teledetection";
DROP TRIGGER IF EXISTS propositions_teledetection_a_note_changement ON "propositions_teledetection";
DROP FUNCTION IF EXISTS propositions_teledetection_note_changement();

-- La version d'avant de la fonction et du declencheur (migration 20261028110000, section 5).
CREATE OR REPLACE FUNCTION propositions_teledetection_exige_journal() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "propositions_teledetection_transitions" t
     WHERE t."propositionId" = NEW."id" AND t."de" = OLD."statut" AND t."vers" = NEW."statut"
       AND t."transactionId" = txid_current()) THEN
    RAISE EXCEPTION 'propositions_teledetection : le changement de statut % -> % de la proposition % n''a pas de ligne de journal dans la meme transaction',
      OLD."statut", NEW."statut", NEW."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$fn$;

COMMENT ON FUNCTION propositions_teledetection_exige_journal() IS NULL;

CREATE CONSTRAINT TRIGGER propositions_teledetection_journal_exige
  AFTER UPDATE ON "propositions_teledetection"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD."statut" IS DISTINCT FROM NEW."statut")
  EXECUTE FUNCTION propositions_teledetection_exige_journal();

-- Et la ligne de `_prisma_migrations` :
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261028130000_eo_gardes_journal';

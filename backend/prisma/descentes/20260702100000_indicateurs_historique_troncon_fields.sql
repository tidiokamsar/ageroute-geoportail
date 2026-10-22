-- RETOUR ARRIERE de `20260702100000_indicateurs_historique_troncon_fields`.
--
-- Ajoute quatre colonnes a troncons (trafic, criticite, cout de rehabilitation, derniere evaluation) et cree indicateurs_reseau_historique.
--
-- CE QUI EST PERDU : les quatre valeurs sur les troncons et l'historique mensuel des indicateurs du reseau.
--
-- GARDE : la descente REFUSE de s'executer si des donnees seraient detruites. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20260702100000_indicateurs_historique_troncon_fields.sql
--
-- GARDE-TEST: INSERT INTO "indicateurs_reseau_historique" ("periode") VALUES (now());
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique. Garde eprouvee avec une donnee fabriquee.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "troncons" WHERE num_nonnulls("traficDateComptage", "criticiteStrategique", "coutRehabEstime", "dateDerniereEvaluation") > 0) + (SELECT count(*) FROM "indicateurs_reseau_historique") INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % ligne(s) portent ces valeurs ou cet historique. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

DROP TABLE IF EXISTS "indicateurs_reseau_historique";
ALTER TABLE "troncons"
  DROP COLUMN IF EXISTS "traficDateComptage",
  DROP COLUMN IF EXISTS "criticiteStrategique",
  DROP COLUMN IF EXISTS "coutRehabEstime",
  DROP COLUMN IF EXISTS "dateDerniereEvaluation";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260702100000_indicateurs_historique_troncon_fields';

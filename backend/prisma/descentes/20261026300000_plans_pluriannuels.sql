-- RETOUR ARRIERE de `20261026300000_plans_pluriannuels`.
--
-- Supprime la table `plans_pluriannuels`, son declencheur et sa fonction.
--
-- CE QUI EST PERDU : tous les plans pluriannuels calcules et scelles (entrees et resultat canoniques, empreintes).
-- Un plan se REJOUE depuis ses entrees stockees tant que le code du moteur est le meme ; une fois la table
-- supprimee, ni les enveloppes saisies ni les resultats ne se reconstituent (les parametres, les baremes et le
-- catalogue ont pu changer depuis). Compter avant :
--
--   SELECT count(*) AS plans, count(*) FILTER (WHERE "deletedAt" IS NULL) AS plans_actifs FROM plans_pluriannuels;
--
-- La migration ne seme aucune ligne : toute ligne est donc une perte. La descente REFUSE de s'executer s'il en
-- existe, et exige une sauvegarde verifiee et une autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- Le declencheur refuse les DELETE ligne a ligne ; DROP TABLE n'est pas un DELETE et passe.
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261026300000_plans_pluriannuels.sql
--
-- GARDE-TEST: INSERT INTO "plans_pluriannuels" ("id","intitule","anneeDebut","nbAnnees","parametresId","parametresVersion","enveloppeTotaleGnf","entreesCanoniques","empreinteEntrees","resultatCanonique","empreinteResultat","nbRetenus","nbNonRetenus","montantEngageGnf","provisoire","creeParId") SELECT 'ppe-garde', 'garde', 2027, 2, 'p-garde', 'prog-provisoire-1', 100, e.t, encode(sha256(convert_to(e.t,'UTF8')),'hex'), r.t, encode(sha256(convert_to(r.t,'UTF8')),'hex'), 0, 0, 0, true, 'u-garde' FROM (SELECT '{"anneeDebut":2027,"nbAnnees":2,"enveloppes":[{},{}],"parametres":{"version":"prog-provisoire-1"}}'::text AS t) e, (SELECT '{"anneeDebut":2027,"nbAnnees":2,"parametres":{"version":"prog-provisoire-1"},"provisoire":true,"synthese":{"enveloppeTotaleGnf":"100","engageTotalGnf":"0","retenus":0,"nonRetenus":0}}'::text AS t) r;
--
-- Verifiee par le banc `verifier.sh` : schema identique a celui d'avant la migration, migration reappliquee a
-- l'identique, garde eprouvee avec une donnee fabriquee.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "plans_pluriannuels";
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % plan(s) pluriannuel(s) seraient detruits. Les enveloppes saisies et les resultats scelles ne se reconstituent pas. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

DROP TRIGGER IF EXISTS plans_pluriannuels_fige ON "plans_pluriannuels";
DROP TABLE IF EXISTS "plans_pluriannuels";
DROP FUNCTION IF EXISTS plans_pluriannuels_fige();

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261026300000_plans_pluriannuels';

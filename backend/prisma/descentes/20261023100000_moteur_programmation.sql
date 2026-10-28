-- RETOUR ARRIERE de `20261023100000_moteur_programmation`.
--
-- Supprime la vue `fiches_intervention_courantes`, les quatre tables du moteur de programmation
-- (statuts, fiches, scenarios, parametres), leurs declencheurs et leurs quatre fonctions.
--
-- CE QUI EST PERDU : les parametres saisis ou approuves, tous les scenarios calcules, TOUTES LES
-- FICHES D'INTERVENTION FIGEES et leur cycle de vie. Une fiche figee est un instantane probatoire de
-- ce qui a ete decide et sous quels parametres : elle ne se reconstitue pas, puisque les parametres,
-- les baremes et le catalogue ont pu changer depuis. Compter avant :
--
--   SELECT (SELECT count(*) FROM parametres_programmation) AS parametres,
--          (SELECT count(*) FROM scenarios_programmation) AS scenarios,
--          (SELECT count(*) FROM fiches_intervention) AS fiches,
--          (SELECT count(*) FROM fiches_intervention_statuts) AS statuts;
--
-- La seule ligne que la migration seme est la version d'amorcage `prog-provisoire-1`, intacte (non
-- approuvee, non supprimee) : elle n'est pas comptee. Tout le reste est une perte : la descente
-- REFUSE de s'executer s'il en existe, et exige une sauvegarde verifiee et une autorisation explicite
-- (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- Les declencheurs refusent les DELETE ligne a ligne ; DROP TABLE n'est pas un DELETE et passe.
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261023100000_moteur_programmation.sql
--
-- GARDE-TEST: INSERT INTO "parametres_programmation" ("version","source","valeurs") VALUES ('garde-test-1','amorcage_provisoire','{"poidsRisque":{},"etatVersRisque":{},"traficPlafondJma":1,"pointsNoirsPlafond":1,"populationPlafond":1,"seuilsClasseTrafic":{},"facteursMinimum":1,"couvertureMinimale":1,"horizonAnnees":1,"seuilRisqueMinimal":null}'::jsonb);
-- GARDE-TEST: UPDATE "parametres_programmation" SET "approuveeLe" = now(), "approuveeParId" = 'u-garde' WHERE "version" = 'prog-provisoire-1';
-- GARDE-TEST: INSERT INTO "scenarios_programmation" ("id","annee","intitule","parametresId","parametresVersion","budgetGnf","entreesCanoniques","empreinteEntrees","resultatCanonique","empreinteResultat","nbRetenues","nbEcartees","montantEngageGnf","provisoire","creeParId") SELECT 'scn-garde', 2027, 'garde', p."id", 'prog-provisoire-1', 100, e.t, encode(sha256(convert_to(e.t,'UTF8')),'hex'), r.t, encode(sha256(convert_to(r.t,'UTF8')),'hex'), 0, 0, 0, true, 'u-garde' FROM (SELECT '{"annee":2027,"budgetGnf":"100","parametres":{"version":"prog-provisoire-1"}}'::text AS t) e, (SELECT '{"annee":2027,"parametres":{"version":"prog-provisoire-1"},"provisoire":true,"totaux":{"engageGnf":"0","retenues":0,"ecartees":0}}'::text AS t) r, "parametres_programmation" p WHERE p."version" = 'prog-provisoire-1';
-- GARDE-TEST: INSERT INTO "scenarios_programmation" ("id","annee","intitule","parametresId","parametresVersion","budgetGnf","entreesCanoniques","empreinteEntrees","resultatCanonique","empreinteResultat","nbRetenues","nbEcartees","montantEngageGnf","provisoire","creeParId") SELECT 'scn-garde', 2027, 'garde', p."id", 'prog-provisoire-1', 100, e.t, encode(sha256(convert_to(e.t,'UTF8')),'hex'), r.t, encode(sha256(convert_to(r.t,'UTF8')),'hex'), 0, 0, 0, true, 'u-garde' FROM (SELECT '{"annee":2027,"budgetGnf":"100","parametres":{"version":"prog-provisoire-1"}}'::text AS t) e, (SELECT '{"annee":2027,"parametres":{"version":"prog-provisoire-1"},"provisoire":true,"totaux":{"engageGnf":"0","retenues":0,"ecartees":0}}'::text AS t) r, "parametres_programmation" p WHERE p."version" = 'prog-provisoire-1'; INSERT INTO "fiches_intervention" ("id","reference","scenarioId","tronconId","annee","parametresVersion","contenuCanonique","empreinteSha256","figeParId") SELECT 'fi-garde', 'FI-2027-GARDE', 'scn-garde', 't-garde', 2027, 'prog-provisoire-1', c.t, encode(sha256(convert_to(c.t,'UTF8')),'hex'), 'u-garde' FROM (SELECT '{"annee":2027,"parametres":{"version":"prog-provisoire-1"},"patrimoine":{"tronconId":"t-garde"},"schema":"fiche-intervention/1","scenario":{"id":"scn-garde"}}'::text AS t) c;
-- GARDE-TEST: INSERT INTO "scenarios_programmation" ("id","annee","intitule","parametresId","parametresVersion","budgetGnf","entreesCanoniques","empreinteEntrees","resultatCanonique","empreinteResultat","nbRetenues","nbEcartees","montantEngageGnf","provisoire","creeParId") SELECT 'scn-garde', 2027, 'garde', p."id", 'prog-provisoire-1', 100, e.t, encode(sha256(convert_to(e.t,'UTF8')),'hex'), r.t, encode(sha256(convert_to(r.t,'UTF8')),'hex'), 0, 0, 0, true, 'u-garde' FROM (SELECT '{"annee":2027,"budgetGnf":"100","parametres":{"version":"prog-provisoire-1"}}'::text AS t) e, (SELECT '{"annee":2027,"parametres":{"version":"prog-provisoire-1"},"provisoire":true,"totaux":{"engageGnf":"0","retenues":0,"ecartees":0}}'::text AS t) r, "parametres_programmation" p WHERE p."version" = 'prog-provisoire-1'; INSERT INTO "fiches_intervention" ("id","reference","scenarioId","tronconId","annee","parametresVersion","contenuCanonique","empreinteSha256","figeParId") SELECT 'fi-garde', 'FI-2027-GARDE', 'scn-garde', 't-garde', 2027, 'prog-provisoire-1', c.t, encode(sha256(convert_to(c.t,'UTF8')),'hex'), 'u-garde' FROM (SELECT '{"annee":2027,"parametres":{"version":"prog-provisoire-1"},"patrimoine":{"tronconId":"t-garde"},"schema":"fiche-intervention/1","scenario":{"id":"scn-garde"}}'::text AS t) c; INSERT INTO "fiches_intervention_statuts" ("ficheId","rang","de","vers","origine","auteurId") VALUES ('fi-garde', 1, NULL, 'BROUILLON', 'GEOPORTAIL', 'u-garde');
--
-- Verifiee par le banc `verifier.sh` : schema identique a celui d'avant la migration, migration
-- reappliquee a l'identique, cinq gardes eprouvees avec des donnees fabriquees (la garde 5 fait
-- porter la perte sur le seul cycle de vie, qui ne peut etre cree qu'avec sa fiche).

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "parametres_programmation"
           WHERE "version" <> 'prog-provisoire-1' OR "source" <> 'amorcage_provisoire'
              OR "approuveeLe" IS NOT NULL OR "approuveeParId" IS NOT NULL OR "deletedAt" IS NOT NULL)
       + (SELECT count(*) FROM "scenarios_programmation")
       + (SELECT count(*) FROM "fiches_intervention")
       + (SELECT count(*) FROM "fiches_intervention_statuts") INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % ligne(s) du moteur de programmation (parametres saisis ou approuves, scenarios, fiches figees, statuts) seraient detruites. Une fiche figee ne se reconstitue pas. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

DROP VIEW IF EXISTS "fiches_intervention_courantes";

DROP TRIGGER IF EXISTS fiches_intervention_statuts_ajout_seul ON "fiches_intervention_statuts";
DROP TABLE IF EXISTS "fiches_intervention_statuts";
DROP FUNCTION IF EXISTS fiches_intervention_statuts_ajout_seul();

DROP TRIGGER IF EXISTS fiches_intervention_figee ON "fiches_intervention";
DROP TABLE IF EXISTS "fiches_intervention";
DROP FUNCTION IF EXISTS fiches_intervention_figee();

DROP TRIGGER IF EXISTS scenarios_programmation_fige ON "scenarios_programmation";
DROP TABLE IF EXISTS "scenarios_programmation";
DROP FUNCTION IF EXISTS scenarios_programmation_fige();

DROP TRIGGER IF EXISTS parametres_programmation_immuable ON "parametres_programmation";
DROP TABLE IF EXISTS "parametres_programmation";
DROP FUNCTION IF EXISTS parametres_programmation_immuable();

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261023100000_moteur_programmation';

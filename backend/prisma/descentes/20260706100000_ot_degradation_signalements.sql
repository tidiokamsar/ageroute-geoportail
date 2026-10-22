-- RETOUR ARRIERE de `20260706100000_ot_degradation_signalements`.
--
-- Cree sept types enumeres, les tables signalements_citoyens, ordres_travaux, ot_photos, ot_historique, et les tables matrices_degradation et baremes_intervention avec neuf lignes semees chacune.
--
-- CE QUI EST PERDU : les signalements citoyens, les ordres de travaux, leurs photos et leur historique, et toute matrice ou bareme modifie ou ajoute depuis le semis.
--
-- GARDE : la descente REFUSE de s'executer si des donnees seraient detruites. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20260706100000_ot_degradation_signalements.sql
--
-- GARDE-TEST: INSERT INTO "signalements_citoyens" ("numeroPublic","typeProbleme") VALUES ('S-1','NID_DE_POULE');
-- GARDE-TEST: UPDATE "matrices_degradation" SET "pBonVersMoyen" = 0.5 WHERE "familleRevetement" = 'bitume' AND "classeTrafic" = 'T1_faible';
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique. Garde eprouvee avec une donnee fabriquee.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "signalements_citoyens") + (SELECT count(*) FROM "ordres_travaux") + (SELECT count(*) FROM "ot_photos") + (SELECT count(*) FROM "ot_historique")
    + (SELECT count(*) FROM "matrices_degradation" m WHERE NOT EXISTS (SELECT 1 FROM (VALUES ('bitume','T1_faible',0.08,0.12,0.18), ('bitume','T2_moyen',0.12,0.18,0.25), ('bitume','T3_fort',0.18,0.28,0.38),
    ('terre_laterite','T1_faible',0.25,0.35,0.45), ('terre_laterite','T2_moyen',0.35,0.50,0.60), ('terre_laterite','T3_fort',0.50,0.65,0.75),
    ('pave','T1_faible',0.06,0.10,0.15), ('pave','T2_moyen',0.09,0.14,0.20), ('pave','T3_fort',0.14,0.22,0.30)) s(f, c, a, b, d)
         WHERE s.f = m."familleRevetement" AND s.c = m."classeTrafic" AND s.a::float8 = m."pBonVersMoyen" AND s.b::float8 = m."pMoyenVersMauvais" AND s.d::float8 = m."pMauvaisVersCritique"))
    + (SELECT count(*) FROM "baremes_intervention" b WHERE NOT EXISTS (SELECT 1 FROM (VALUES ('bitume','MOYEN','entretien_periodique',350000000), ('bitume','MAUVAIS','rehabilitation',1100000000), ('bitume','CRITIQUE','reconstruction',3500000000),
    ('terre_laterite','MOYEN','entretien_periodique',80000000), ('terre_laterite','MAUVAIS','rehabilitation',250000000), ('terre_laterite','CRITIQUE','reconstruction',700000000),
    ('pave','MOYEN','entretien_periodique',300000000), ('pave','MAUVAIS','rehabilitation',900000000), ('pave','CRITIQUE','reconstruction',2800000000)) s(f, e, t, c)
         WHERE s.f = b."familleRevetement" AND s.e = b."etatDepart" AND s.t = b."typeIntervention" AND s.c = b."coutKmGnf")) INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % ligne(s) de signalements, d''ordres de travaux, de photos, d''historique, ou de matrices et baremes differents du semis. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

DROP TABLE IF EXISTS "ot_historique";
DROP TABLE IF EXISTS "ot_photos";
DROP TABLE IF EXISTS "ordres_travaux";
DROP TABLE IF EXISTS "signalements_citoyens";
DROP TABLE IF EXISTS "baremes_intervention";
DROP TABLE IF EXISTS "matrices_degradation";
DROP TYPE IF EXISTS "StatutSignalement";
DROP TYPE IF EXISTS "TypeProbleme";
DROP TYPE IF EXISTS "CanalSignalement";
DROP TYPE IF EXISTS "TypePhotoOT";
DROP TYPE IF EXISTS "StatutOT";
DROP TYPE IF EXISTS "PrioriteOT";
DROP TYPE IF EXISTS "TypeInterventionOT";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260706100000_ot_degradation_signalements';

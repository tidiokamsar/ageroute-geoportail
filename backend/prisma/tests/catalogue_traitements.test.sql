-- BANC D'ESSAI du catalogue des traitements (paragraphe 7.7, etape 2).
--
-- Ce qu'il prouve : que le catalogue DERIVE des barèmes sans rien ajouter, que ses trois
-- attributs normatifs sont nuls, qu'aucune ligne n'est approuvee, et que les invariants
-- refusent ce qu'ils doivent refuser -- chaque refus double de sa contre-epreuve.
--
--   docker exec -i bdri-dev-db psql -U bdri_dev -d <base> -v ON_ERROR_STOP=1 \
--     -f - < backend/prisma/tests/catalogue_traitements.test.sql
--
-- Transaction ANNULEE a la fin : rien de durable n'est ecrit.

BEGIN;

DO $t$
DECLARE
  nb integer;
  nb2 integer;
BEGIN
  -- ---------- Derivation : chaque typeIntervention des barèmes a sa ligne ----------
  SELECT count(*) INTO nb
    FROM (SELECT DISTINCT "typeIntervention" FROM baremes_intervention WHERE actif) b
   WHERE NOT EXISTS (SELECT 1 FROM catalogue_traitements c WHERE c.code = b."typeIntervention");
  IF nb <> 0 THEN
    RAISE EXCEPTION '% typeIntervention des barèmes sans ligne de catalogue', nb;
  END IF;

  -- Et aucun traitement qui ne vienne pas des barèmes : le catalogue n'invente rien.
  SELECT count(*) INTO nb FROM catalogue_traitements c
   WHERE NOT EXISTS (SELECT 1 FROM baremes_intervention b WHERE b."typeIntervention" = c.code);
  IF nb <> 0 THEN
    RAISE EXCEPTION '% traitements semes sans source dans les barèmes', nb;
  END IF;
  RAISE NOTICE 'Derivation : 3 traitements, tous releves dans les barèmes, aucun invente';

  -- ---------- Les neuf conditions sont les neuf couples (famille, etat) des barèmes ----------
  SELECT count(*) INTO nb FROM conditions_traitement;
  SELECT count(DISTINCT ("familleRevetement", "etatDepart")) INTO nb2 FROM baremes_intervention WHERE actif;
  IF nb <> nb2 THEN
    RAISE EXCEPTION 'Conditions : % semees contre % couples distincts dans les barèmes', nb, nb2;
  END IF;
  SELECT count(*) INTO nb FROM conditions_traitement ct
   WHERE NOT EXISTS (
     SELECT 1 FROM baremes_intervention b
      WHERE b."familleRevetement" = ct."familleRevetement"
        AND b."etatDepart" = ct."etatDepart"
        AND b."typeIntervention" = ct."traitementCode");
  IF nb <> 0 THEN
    RAISE EXCEPTION '% conditions ne correspondent a aucun bareme', nb;
  END IF;
  RAISE NOTICE 'Conditions : % couples (famille, etat), chacun copie d''un bareme, classe de trafic nulle', nb2;

  -- ---------- Rien d'invente : les trois attributs normatifs sont NULS ----------
  SELECT count(*) INTO nb FROM catalogue_traitements
   WHERE "dureeVieAttendueAns" IS NOT NULL OR "effetSurIndice" IS NOT NULL OR "fenetreRealisation" IS NOT NULL;
  IF nb <> 0 THEN
    RAISE EXCEPTION '% traitements portent une duree, un effet ou une fenetre que personne n''a arretes', nb;
  END IF;
  SELECT count(*) INTO nb FROM conditions_traitement WHERE "classeTrafic" IS NOT NULL;
  IF nb <> 0 THEN
    RAISE EXCEPTION '% conditions portent une classe de trafic que les barèmes ne distinguent pas', nb;
  END IF;
  RAISE NOTICE 'Aucune duree de vie, aucun effet, aucune fenetre, aucune classe de trafic : rien d''invente';

  -- ---------- Aucune approbation ----------
  SELECT count(*) INTO nb FROM catalogue_traitements WHERE "approuveLe" IS NOT NULL OR "approuveParId" IS NOT NULL;
  IF nb <> 0 THEN RAISE EXCEPTION '% traitements approuves au semis', nb; END IF;
  SELECT count(*) INTO nb FROM catalogue_traitements WHERE source <> 'standard_initial';
  IF nb <> 0 THEN RAISE EXCEPTION '% traitements sans source standard_initial', nb; END IF;
  RAISE NOTICE 'Aucun traitement approuve, tous en standard_initial';

  -- ---------- Invariants : refus et contre-epreuves ----------

  BEGIN
    UPDATE catalogue_traitements SET "dureeVieAttendueAns" = 0 WHERE code = 'rehabilitation';
    RAISE EXCEPTION 'Une duree de vie nulle a ete acceptee';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'Duree de vie de 0 an REFUSEE';
  END;

  BEGIN
    UPDATE catalogue_traitements SET "effetSurIndice" = -5 WHERE code = 'rehabilitation';
    RAISE EXCEPTION 'Un effet negatif sur l''indice a ete accepte';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'Effet negatif REFUSE : un traitement qui degrade n''est pas un traitement';
  END;

  BEGIN
    UPDATE catalogue_traitements SET "approuveLe" = CURRENT_TIMESTAMP WHERE code = 'rehabilitation';
    RAISE EXCEPTION 'Une approbation sans approbateur a ete acceptee';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'Approbation sans approbateur REFUSEE';
  END;

  -- Contre-epreuve : une saisie correcte passe. Elle restera dans la transaction annulee.
  UPDATE catalogue_traitements SET "dureeVieAttendueAns" = 8, "effetSurIndice" = 25.5,
         "fenetreRealisation" = 'novembre-mai'
   WHERE code = 'rehabilitation';
  RAISE NOTICE 'Contre-epreuve : duree 8 ans, effet +25,5, fenetre novembre-mai acceptes (puis annules)';

  -- Une condition ne designe qu'un traitement.
  BEGIN
    INSERT INTO conditions_traitement ("traitementCode", "familleRevetement", "etatDepart")
    VALUES ('reconstruction', 'bitume', 'MOYEN');
    RAISE EXCEPTION 'Deux traitements pour (bitume, MOYEN) ont ete acceptes';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'Second traitement pour un meme (famille, etat) REFUSE : la matrice est une fonction';
  END;

  -- Une condition vers un traitement inconnu est refusee.
  BEGIN
    INSERT INTO conditions_traitement ("traitementCode", "familleRevetement", "etatDepart")
    VALUES ('renforcement', 'bitume', 'BON');
    RAISE EXCEPTION 'Une condition vers un traitement inconnu a ete acceptee';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'Traitement inconnu REFUSE -- il s''ajoute par une ligne de catalogue, pas par un ALTER TYPE';
  END;

  RAISE NOTICE '--- TOUTES LES ASSERTIONS PASSENT ---';
END;
$t$;

ROLLBACK;

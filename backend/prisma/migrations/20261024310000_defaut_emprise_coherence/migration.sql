-- COHERENCE « EMPRISE_UTM => UNE EMPRISE » (paragraphe 7.1, scenario A5)
--
-- Une quantite dont la methode est EMPRISE_UTM affirme avoir ete MESUREE sur le contour GPS du defaut.
-- Sans contour, cette affirmation serait invérifiable : on ne pourrait plus rejouer la mesure. La base
-- le tient elle-meme, comme elle tient « une tache cloturee a ses preuves » (A29) : un defaut ne peut
-- pas porter la methode sans porter l'emprise.
--
-- Migration separee de l'ajout de la valeur d'enumeration (20261024300000) : PostgreSQL refuse
-- d'utiliser une valeur d'enumeration dans la transaction qui vient de l'ajouter.
--
-- NATURE : additive. Une contrainte CHECK ; aucune ligne existante ne porte la valeur.

ALTER TABLE "defauts"
  ADD CONSTRAINT "defaut_methode_emprise_exige_emprise"
  CHECK ("methodeQuantite" IS DISTINCT FROM 'EMPRISE_UTM' OR "emprise" IS NOT NULL);

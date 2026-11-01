-- AGEROUTE ROAD : convertir un comptage en quantite, par une convention declaree.
--
-- CE QUI MANQUAIT
--
-- `21_TABLEAU_CONFORMITE.md` notait l'ecart depuis le 13/10 : « coefficient multiplicateur
-- absent — ajouter quantite = nombre x coefficient ».
--
-- Concretement, douze nids-de-poule de taille standard ne pouvaient pas s'exprimer. En
-- METRE_CARRE, le moteur exigeait une longueur ET une largeur ; un agent qui compte douze
-- occurrences sans sortir le decametre n'obtenait aucune quantite, donc aucun cout.
--
-- POURQUOI LE COEFFICIENT EST UNE DONNEE DE CATALOGUE ET NON UNE CONSTANTE
--
-- Dire qu'un nid-de-poule standard fait 0,5 m2 est une CONVENTION DE METRE, donc une
-- decision d'AGEROUTE. Ecrite en dur dans le code, personne ne pourrait dire qui l'a prise,
-- et la changer demanderait une livraison. Meme raisonnement que pour les coefficients du
-- RCI, la normalisation etat-vers-score et les referentiels de revetement : le mecanisme
-- attend la valeur, il ne la devance pas.
--
-- LA COLONNE EST NULLE PAR DEFAUT, ET AUCUNE LIGNE N'EST ECRITE
--
-- Les 13 types du catalogue restent sans coefficient. Le moteur REFUSE alors de convertir un
-- comptage, avec MESURES_INSUFFISANTES, plutot que de multiplier par un — ce qui confondrait
-- « douze occurrences » avec « douze metres carres », faux dans l'unite du type et invisible
-- dans le resultat.
--
-- UNE VALEUR NULLE OU NEGATIVE FAIT REFUSER, ELLE N'EST PAS IGNOREE
--
-- Un catalogue portant `coefficientUnitaire = 0` rendrait une quantite nulle pour douze
-- nids-de-poule bien reels, et ce zero traverserait tout le calcul de cout sans alerter. La
-- contrainte l'interdit en base, et le moteur rend COEFFICIENT_ABERRANT s'il en voit un.
--
-- `ALTER TYPE ADD VALUE` EST IRREVERSIBLE
--
-- PostgreSQL ne sait pas retirer une valeur d'un type enumere. `COMPTAGE_COEFFICIENT`
-- survivra donc a tout retour arriere de cette migration. Sans consequence : une valeur
-- d'enum que rien n'ecrit ne se voit pas.
--
-- CETTE MIGRATION EST ADDITIVE ET N'ECRIT AUCUNE LIGNE.

ALTER TYPE "MethodeQuantite" ADD VALUE 'COMPTAGE_COEFFICIENT';

ALTER TABLE "catalogue_defauts"
  ADD COLUMN "coefficientUnitaire" DECIMAL(12,4);

-- Strictement positif, ou absent. Jamais zero, jamais negatif.
ALTER TABLE "catalogue_defauts"
  ADD CONSTRAINT "catalogue_coefficient_strictement_positif"
  CHECK ("coefficientUnitaire" IS NULL OR "coefficientUnitaire" > 0);

-- AGEROUTE ROAD : les classes de score du RCI, dans la regle versionnee.
--
-- CE QUI DEBLOQUE
--
-- `12_ADR_CONDITION_ENGINE.md` notait, dans ses ecarts au modele propose : « Pas de
-- `classe`. Traduire un score en bon / moyen / mauvais demande des seuils que personne n'a
-- arbitres. Une colonne nulle que rien ne remplit serait une promesse vide. »
--
-- AGEROUTE les a donnes le 13/10/2026 :
--
--   90-100  Excellent
--   75-89   Bon
--   60-74   Acceptable
--   40-59   Degrade
--   20-39   Mauvais
--   0-19    Critique
--
-- POURQUOI ELLES VIVENT DANS LA REGLE
--
-- Un seuil deplace fait changer de classe une partie du reseau SANS QUE SON SCORE BOUGE. Un
-- troncon a 74 est « acceptable », a 75 il est « bon » : la frontiere est une decision, et
-- elle doit porter la version sous laquelle elle a ete prise. Sinon un rapport de 2026 et un
-- rapport de 2029 compareraient des classes qui n'ont plus le meme sens.
--
-- C'est le meme raisonnement que pour les poids et la normalisation, et le meme
-- interrupteur : une regle non approuvee produit des scores non publiables, classes comprises.
--
-- UN SCORE HORS DE TOUTE CLASSE N'EN RECOIT AUCUNE
--
-- Jamais la plus proche. Une table de classes mal formee doit se voir, pas se rattraper en
-- silence — un score classe « bon » par approximation serait pire qu'un score sans classe.
--
-- CETTE MIGRATION EST ADDITIVE ET N'ECRIT AUCUNE LIGNE.
-- `regles_condition` est vide en production.

ALTER TABLE "regles_condition"
  ADD COLUMN "classes" JSONB NOT NULL DEFAULT '[]';

-- Un TABLEAU, pas un objet ni un scalaire. Meme raison que pour `poids` et
-- `normalisation` : une regle corrigee a la main ne doit pas pouvoir porter
-- `classes: "six classes"`, que le moteur lirait comme une liste vide sans rien dire.
ALTER TABLE "regles_condition"
  ADD CONSTRAINT "regle_classes_est_un_tableau"
  CHECK (jsonb_typeof("classes") = 'array');

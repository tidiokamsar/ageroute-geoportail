-- Descente de 20261021160000 : la table des previsions budgetaires et ses index.
-- Aucune autre table ne la reference ; la descente est une suppression pure,
-- a executer seulement si l'on accepte de perdre les previsions saisies.

DROP TABLE IF EXISTS "programmes_budgetaires";

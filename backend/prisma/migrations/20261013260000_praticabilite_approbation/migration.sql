-- AGEROUTE ROAD : approbation des valeurs de praticabilite.
--
-- LA CONSIGNE
--
-- AGEROUTE, le 13/10/2026 : « Construire un referentiel explicite avec des codes stables,
-- des definitions metier et une distinction entre etat de chaussee et possibilite de
-- circulation. Faire approuver les valeurs AVANT LEUR UTILISATION OFFICIELLE. »
--
-- CE QUE « UTILISATION OFFICIELLE » VEUT DIRE ICI
--
-- Pour une portion, officiel veut dire VALIDE. Une valeur non approuvee peut donc etre
-- portee par une PROPOSITION de terrain, mais elle empeche sa validation.
--
-- C'est le seul sens tenable de la consigne. Interdire la saisie aurait rendu le
-- referentiel inutilisable jusqu'a son approbation, donc impossible a eprouver sur le
-- terrain AVANT de l'approuver : on aurait demande d'approuver a l'aveugle.
--
-- Interdire seulement la publication aurait ete trop faible : une portion validee entre au
-- referentiel officiel, et c'est la qu'elle cesse d'etre une hypothese.
--
-- APPROUVEE PAR QUELQU'UN OU PAS APPROUVEE DU TOUT
--
-- Meme regle que pour les regles du RCI : une approbation sans approbateur ne serait
-- imputable a personne, ce que le paragraphe 26 du cahier ne permet pas. La contrainte
-- ci-dessous le garantit en base, pas seulement dans le code.
--
-- CETTE MIGRATION EST ADDITIVE ET N'ECRIT AUCUNE LIGNE.
-- La table est vide : aucune valeur n'existe encore, approuvee ou non.

ALTER TABLE "referentiel_praticabilites"
  ADD COLUMN "approuveeLe"    TIMESTAMP(3),
  ADD COLUMN "approuveeParId" TEXT,
  -- NOT NULL sans defaut : possible parce que la table est VIDE. Sur une table peuplee,
  -- il aurait fallu une valeur de repli, et aucune n'aurait eu de sens — une definition
  -- metier inventee serait pire qu'absente.
  ALTER COLUMN "description" SET NOT NULL;

ALTER TABLE "referentiel_praticabilites"
  ADD CONSTRAINT "referentiel_praticabilites_approuveeParId_fkey"
  FOREIGN KEY ("approuveeParId") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "referentiel_praticabilites"
  ADD CONSTRAINT "praticabilite_approbation_imputable"
  CHECK (("approuveeLe" IS NULL) = ("approuveeParId" IS NULL));

-- UNE DEFINITION METIER EST EXIGEE, et c'est la seule des trois tables de referentiel ou
-- elle l'est.
--
-- AGEROUTE a demande des « definitions metier » explicitement pour la praticabilite, et la
-- raison se comprend : « difficile » ne veut rien dire sans dire pour qui et dans quelles
-- conditions. Un revetement se reconnait a l'oeil, une praticabilite se juge, et deux
-- agents sans definition commune jugeront differemment.
--
-- Les valeurs deja saisies ne sont pas concernees : la table est vide.
-- Vingt caracteres au minimum : `NOT NULL` laisse passer « ok », qui n'est pas une
-- definition. Le seuil est arbitraire et ne pretend pas juger la qualite d'un texte ; il
-- ecarte seulement le champ rempli pour passer le controle.
ALTER TABLE "referentiel_praticabilites"
  ADD CONSTRAINT "praticabilite_definition_substantielle"
  CHECK (length(btrim("description")) >= 20);

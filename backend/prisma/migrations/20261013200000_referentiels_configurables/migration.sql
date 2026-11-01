-- AGEROUTE ROAD : referentiels configurables du revetement, de l'etat et de la
-- praticabilite.
--
-- POURQUOI DES TABLES ET NON DES ENUMS
--
-- `Revetement` est un enum de cinq valeurs. L'etendre demande une migration, donc un
-- deploiement, pour ajouter un mot. Le cahier en demande huit et, surtout, demande que la
-- liste soit ADMINISTRABLE. Les trois revetements que `BITUME` recouvre aujourd'hui, beton
-- bitumineux, enduit superficiel et beton, n'ont pas les memes couts de rehabilitation :
-- c'est une distinction metier, pas un detail de vocabulaire.
--
-- POURQUOI TROIS TABLES ET NON UNE TABLE GENERIQUE
--
-- Une table unique avec une colonne `domaine` aurait une cle primaire `(domaine, code)`,
-- et une cle etrangere depuis `portions` ne pourrait pas garantir que le code pointe sur le
-- BON domaine sans colonne generee ni declencheur. Trois tables donnent trois cles
-- etrangeres triviales, verifiees par la base.
--
-- Et les trois ne portent pas les memes attributs : un revetement est bitumineux ou non,
-- un etat est critique ou non, une praticabilite est franchissable ou non. Une table
-- generique les aurait ranges dans un JSON que rien ne contraint.
--
-- POURQUOI TROIS ET PAS LES SEPT DU CAHIER
--
-- Le cahier demande aussi des referentiels pour les accotements, l'assainissement, la
-- signalisation et les risques de securite. Rien ne les consomme : les creer produirait
-- quatre tables vides que rien ne lit, meme defaut qu'une colonne nulle que rien ne
-- remplit. Elles viendront avec ce qui les utilise.
--
-- POURQUOI DES DRAPEAUX `bitumineux`, `critique` ET `franchissable`
--
-- Le paragraphe 13 demande « longueur bitumee et non bitumee » et « longueur critique ».
-- Avec un vocabulaire administrable, cela NE SE DEDUIT PAS DU CODE : un libelle que
-- quelqu'un ajoutera demain ne dira pas au programme s'il est bitumineux. La propriete est
-- donc DECLAREE sur la valeur, et celui qui ajoute un revetement doit la trancher.
--
-- ALTER COLUMN TYPE PLUTOT QUE DROP PUIS ADD
--
-- `prisma migrate diff` propose `DROP COLUMN` puis `ADD COLUMN`. Sur une table vide les
-- deux formes se valent. Si quelqu'un a applique `20261013180000` et insere une ligne
-- d'essai, en revanche, `DROP` la perd en silence alors que le cast ci-dessous la conserve
-- et fait echouer bruyamment la cle etrangere si son code n'existe pas au referentiel.
-- Un echec bruyant vaut mieux qu'une perte muette.
--
-- CETTE MIGRATION N'ECRIT AUCUNE LIGNE
--
-- Les trois tables sortent VIDES. `scripts/peupler-referentiels.ts` remplit le revetement
-- et l'etat, dont les vocabulaires existent (le cahier liste les huit revetements, et les
-- cinq etats sont en usage sur 261 387 troncons).
--
-- La PRATICABILITE reste vide : le cahier demande son referentiel sans enoncer une seule
-- valeur. Ecrire ici « PRATICABLE / DIFFICILE / IMPRATICABLE » en ferait la norme
-- d'AGEROUTE par defaut, alors que personne ne l'a decidee. Meme regle que pour les
-- coefficients du RCI. Consequence assumee : aucune portion ne portera de praticabilite
-- avant qu'AGEROUTE n'ait rempli la table.

-- Le cast conserve les valeurs si la table n'est pas vide. Les cles etrangeres posees plus
-- bas refuseront alors tout code absent du referentiel, ce qui est le comportement voulu.
ALTER TABLE "portions"
  ALTER COLUMN "revetement" TYPE TEXT USING "revetement"::TEXT,
  ALTER COLUMN "etat"       TYPE TEXT USING "etat"::TEXT;

CREATE TABLE "referentiel_revetements" (
  "code"        TEXT NOT NULL,
  "libelle"     TEXT NOT NULL,
  "description" TEXT,
  -- Ordre d'AFFICHAGE, du plus structurant au moins structurant. Sert aux listes, pas aux
  -- calculs.
  "ordre"       INTEGER NOT NULL,
  -- `false` retire la valeur des nouveaux choix SANS invalider les portions qui la portent
  -- deja. Supprimer la ligne casserait leur cle etrangere, et une portion dont on ne sait
  -- plus le revetement n'est plus explicable.
  "actif"       BOOLEAN NOT NULL DEFAULT true,
  -- Compte dans la longueur bitumee. Declare, voir l'en-tete.
  "bitumineux"  BOOLEAN NOT NULL,
  "source"      TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "referentiel_revetements_pkey" PRIMARY KEY ("code")
);

CREATE TABLE "referentiel_etats_chaussee" (
  "code"        TEXT NOT NULL,
  "libelle"     TEXT NOT NULL,
  "description" TEXT,
  -- Du MEILLEUR au PIRE. Contrairement a l'ordre d'un revetement, celui-ci a un sens
  -- metier : il permet de dire lequel de deux etats est le plus degrade.
  "ordre"       INTEGER NOT NULL,
  "actif"       BOOLEAN NOT NULL DEFAULT true,
  -- Compte dans la longueur critique du paragraphe 13. Declare, voir l'en-tete.
  "critique"    BOOLEAN NOT NULL DEFAULT false,
  "source"      TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "referentiel_etats_chaussee_pkey" PRIMARY KEY ("code")
);

CREATE TABLE "referentiel_praticabilites" (
  "code"          TEXT NOT NULL,
  "libelle"       TEXT NOT NULL,
  "description"   TEXT,
  "ordre"         INTEGER NOT NULL,
  "actif"         BOOLEAN NOT NULL DEFAULT true,
  -- La route est-elle franchissable dans cet etat ?
  "franchissable" BOOLEAN NOT NULL,
  -- Une piste franchissable en saison seche ne l'est plus en saison des pluies. Vrai quand
  -- la valeur ne vaut que pour une periode.
  "saisonniere"   BOOLEAN NOT NULL DEFAULT false,
  "source"        TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,

  CONSTRAINT "referentiel_praticabilites_pkey" PRIMARY KEY ("code")
);

CREATE INDEX "referentiel_revetements_actif_ordre_idx"
  ON "referentiel_revetements"("actif", "ordre");
CREATE INDEX "referentiel_etats_chaussee_actif_ordre_idx"
  ON "referentiel_etats_chaussee"("actif", "ordre");
CREATE INDEX "referentiel_praticabilites_actif_ordre_idx"
  ON "referentiel_praticabilites"("actif", "ordre");

-- Un libelle vide passerait les types et ne dirait rien a l'agent qui choisit dans la
-- liste.
ALTER TABLE "referentiel_revetements"
  ADD CONSTRAINT "revetement_libelle_non_vide" CHECK (length(btrim("libelle")) > 0);
ALTER TABLE "referentiel_etats_chaussee"
  ADD CONSTRAINT "etat_libelle_non_vide" CHECK (length(btrim("libelle")) > 0);
ALTER TABLE "referentiel_praticabilites"
  ADD CONSTRAINT "praticabilite_libelle_non_vide" CHECK (length(btrim("libelle")) > 0);

-- SET NULL et non RESTRICT : si AGEROUTE retire une valeur du vocabulaire, les portions
-- qui la portaient perdent leur qualification au lieu de bloquer la suppression. C'est le
-- comportement que Prisma declare pour une relation optionnelle, et il est tenable ici
-- parce que `actif = false` est la voie normale pour retirer une valeur sans rien perdre.
--
-- COMPORTEMENT EPROUVE le 13/10/2026, dans un conteneur jetable, et non suppose :
--
--   ACCEPTE  un code declare au referentiel
--   ACCEPTE  NULL, c'est-a-dire une portion pas encore qualifiee
--   REFUSE   un code INVENTE
--   `actif = false`  laisse les portions intactes  <- la voie normale pour retirer
--   `DELETE` du code  met la qualification a NUL   <- la portion survit, l'attribut non
ALTER TABLE "portions"
  ADD CONSTRAINT "portions_revetement_fkey"
  FOREIGN KEY ("revetement") REFERENCES "referentiel_revetements"("code")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "portions"
  ADD CONSTRAINT "portions_etat_fkey"
  FOREIGN KEY ("etat") REFERENCES "referentiel_etats_chaussee"("code")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "portions"
  ADD CONSTRAINT "portions_praticabilite_fkey"
  FOREIGN KEY ("praticabilite") REFERENCES "referentiel_praticabilites"("code")
  ON DELETE SET NULL ON UPDATE CASCADE;

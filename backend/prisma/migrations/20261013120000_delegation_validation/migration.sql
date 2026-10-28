-- AGEROUTE ROAD : delegation de validation.
--
-- POURQUOI
--
-- Le paragraphe 5 du cahier RAI V3.1 decrit le Coordonnateur comme faisant « validation
-- selon delegation ». Pris seul, cela ne dit pas ce qu'est une delegation. La reponse est
-- au paragraphe 35, « Gouvernance des donnees » :
--
--     « Un validateur est designe pour chaque domaine. »
--
-- Une delegation n'est donc pas une permission generique : c'est une DESIGNATION, par
-- domaine, et le paragraphe 26 ajoute « controle de separation des roles pour validation ».
--
-- L'ETAT AVANT
--
-- `ROLES_VALIDATEURS` admet ADMIN et GESTIONNAIRE. Tout gestionnaire pouvait donc valider
-- n'importe quel defaut, n'importe quelle observation, partout dans le pays. Il n'y avait
-- ni domaine, ni perimetre, ni terme, ni delegant. « Selon delegation » n'avait aucun
-- equivalent dans le code.
--
-- CETTE MIGRATION NE CHANGE AUCUN COMPORTEMENT
--
-- Une table et un type crees, rien d'autre. Aucune table existante modifiee, aucune
-- donnee touchee.
--
-- Et la table est VIDE a la sortie. La regle implementee est un RESSERREMENT PAR
-- DOMAINE : tant qu'aucun validateur n'est designe sur un domaine, la regle d'avant
-- s'applique et tout ADMIN ou GESTIONNAIRE y valide. Des qu'un seul est designe, le
-- domaine devient reserve aux designes.
--
-- Exiger une delegation des le premier jour aurait ARRETE la validation : les releves de
-- terrain se seraient accumules en A_VALIDER, et la chaine de decision — defaut, etat,
-- traitement, cout — serait restee vide. Designer des validateurs est un acte
-- d'organisation qui prend des semaines, pas une soiree de deploiement.
--
-- LA RESSEMBLANCE AVEC UN DEFAUT DEJA PAYE, ET LA DIFFERENCE
--
-- Ce depot a corrige le 05/09/2026 un defaut de cette forme : `modulesAutorises` vide
-- valait « aucune restriction », si bien qu'un compte dont la configuration avait ete
-- oubliee obtenait tous les modules, pendant que l'interface affirmait l'inverse.
--
-- La difference tient en un mot : VISIBLE. Ce defaut etait silencieux. Ici,
-- `domainesSansValidateur()` compte les domaines non designes pour que l'etat de la
-- gouvernance se lise au lieu de se deviner.
--
-- RIEN N'EST SUPPRIME
--
-- Une delegation expiree ou revoquee reste en base : des validations ont ete rendues sous
-- son autorite, et les retirer les rendrait inexplicables. `revoqueeLe` est une date, pas
-- une suppression — regle 2 d'AGENTS.md appliquee a un objet de gouvernance.

CREATE TYPE "DomaineValidation" AS ENUM ('TRONCON', 'OUVRAGE', 'DEFAUT', 'OBSERVATION', 'POINT_NOIR', 'POSTE', 'CHANTIER');

-- AUCUNE CONTRAINTE D'UNICITE, volontairement. Une meme personne peut etre designee
-- plusieurs fois sur un domaine : une region puis une autre, ou une periode puis la
-- suivante. Une cle unique sur (domaine, validateur) interdirait l'historique que cette
-- table existe pour conserver.
CREATE TABLE "delegations_validation" (
    "id" TEXT NOT NULL,
    "domaine" "DomaineValidation" NOT NULL,
    "validateurId" TEXT NOT NULL,
    "regionId" INTEGER,
    "delegueParId" TEXT NOT NULL,
    "debutLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finLe" TIMESTAMP(3),
    "revoqueeLe" TIMESTAMP(3),
    "revoqueeParId" TEXT,
    "motif" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delegations_validation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "delegations_validation_domaine_idx" ON "delegations_validation"("domaine");
CREATE INDEX "delegations_validation_validateurId_idx" ON "delegations_validation"("validateurId");
CREATE INDEX "delegations_validation_regionId_idx" ON "delegations_validation"("regionId");

-- RESTRICT sur le validateur et le delegant : ce depot ne pratique que la suppression
-- logique, et un compte qui a delegue ou recu une delegation ne doit pas pouvoir
-- disparaitre physiquement en laissant une designation sans titulaire.
ALTER TABLE "delegations_validation" ADD CONSTRAINT "delegations_validation_validateurId_fkey"
    FOREIGN KEY ("validateurId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delegations_validation" ADD CONSTRAINT "delegations_validation_delegueParId_fkey"
    FOREIGN KEY ("delegueParId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- SET NULL sur le revocateur : la revocation reste vraie meme si le compte qui l'a
-- prononcee disparait du referentiel. Perdre l'auteur est moins grave que perdre le fait.
ALTER TABLE "delegations_validation" ADD CONSTRAINT "delegations_validation_revoqueeParId_fkey"
    FOREIGN KEY ("revoqueeParId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "delegations_validation" ADD CONSTRAINT "delegations_validation_regionId_fkey"
    FOREIGN KEY ("regionId") REFERENCES "regions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

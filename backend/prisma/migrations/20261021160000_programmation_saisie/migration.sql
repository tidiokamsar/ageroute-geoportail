-- PROGRAMMATION BUDGETAIRE EN SAISIE (paragraphe 7.9, avant D-07)
--
-- « Programmant ses interventions » : la Console savait AGREGER les chantiers existants
-- (dashboard/programmation, 488 lignes) mais ne savait pas DIRE ce qui est prevu. Le
-- gestionnaire n'avait aucun outil pour poser « 2027 : rehabilitation du troncon X,
-- 2,4 Md GNF, bailleur AFD » AVANT que cela ne devienne un chantier.
--
-- CETTE TABLE EST UNE PREVISION, PAS UN CHANTIER. Un chantier est un fait (une entreprise,
-- des dates reelles, un avancement) ; une prevision est une intentionREVISEE en cours
-- d'exercice : d'ou UPDATE autorise (audite) et suppression LOGIQUE seule. Elle ne
-- portera jamais de dates reelles ni d'avancement — le jour ou la prevision se realise,
-- le chantier existant la remplace ; la liaison chantierId sera posee par une migration
-- le jour ou ce flux existera, comme interventionRef avant elle.
--
-- bailleur est un TEXTE LIBRE, pas une cle etrangere : c'est le choix fait pour les
-- chantiers (50 chantiers a bailleur non renseigne) ; lier les previsions aux bailleurs
-- refere et les chantiers au texte libre empecherait de les comparer dans les memes
-- agrégats. Le jour ou les chantiers migrent vers la reference, les deux migreront.
--
-- source distingue ce qui est SAISI a la main de ce qu'un futur moteur de cout produira
-- (apres D-07) : une prevision moteur devra citer sa ligne de bareme, une prevision saisie
-- cite son auteur. Aucune confusion possible entre un chiffre calcule et un chiffre pose.
--
-- statut : PROPOSE (la saisie), RETENU (arbitrage), REPORTE, ANNULE, REALISE (un chantier
-- existe). Texte contraint, pas enumeration : un statut s'ajoute par migration qui etend
-- le CHECK, reversible (lecon D-06).
--
-- AUCUN MONTANT N'EST SEME. La table neait vide ; rien n'y sera importe ni devine.

CREATE TABLE "programmes_budgetaires" (
    "id"                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    "annee"             int         NOT NULL CHECK ("annee" BETWEEN 2000 AND 2100),
    "intitule"          text        NOT NULL CHECK (length(trim("intitule")) > 0),
    "tronconId"         text        NULL REFERENCES "troncons"("id"),
    "bailleur"          text        NULL,
    "typeIntervention"  text        NULL,
    "montantPrevuGnf"   bigint      NOT NULL CHECK ("montantPrevuGnf" >= 0),
    "priorite"          int         NULL CHECK ("priorite" >= 1),
    "statut"            text        NOT NULL DEFAULT 'PROPOSE'
                                    CHECK ("statut" IN ('PROPOSE','RETENU','REPORTE','ANNULE','REALISE')),
    "source"            text        NOT NULL DEFAULT 'SAISIE'
                                    CHECK ("source" IN ('SAISIE','MOTEUR')),
    "commentaire"       text        NULL,
    "createdById"       text        NOT NULL REFERENCES "users"("id"),
    "createdAt"         timestamptz NOT NULL DEFAULT now(),
    "updatedAt"         timestamptz NOT NULL DEFAULT now(),
    "deletedAt"         timestamptz NULL
);

CREATE INDEX "programmes_budgetaires_annee_idx"  ON "programmes_budgetaires"("annee")  WHERE "deletedAt" IS NULL;
CREATE INDEX "programmes_budgetaires_statut_idx" ON "programmes_budgetaires"("statut") WHERE "deletedAt" IS NULL;
CREATE INDEX "programmes_budgetaires_troncon_idx" ON "programmes_budgetaires"("tronconId");

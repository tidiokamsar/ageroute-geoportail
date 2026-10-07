-- AGEROUTE ROAD : gouvernance de la validation, et modele de defauts.
--
-- POURQUOI
--
-- Deux manques mesures sur la production du 07/10/2026 :
--
--   1. RIEN NE DISTINGUE UNE DONNEE IMPORTEE D'UNE DONNEE OFFICIELLE. 81 ouvrages issus
--      du document DTOAA sont publics, 78 en confiance HIGH, et aucun ne porte de
--      marqueur de validation. Pour qui les consulte, un ouvrage releve sur le terrain
--      et un ouvrage lu dans un PDF se presentent a l'identique.
--
--   2. LE PERIMETRE NATIONAL REPOSE SUR UN PREFIXE DE CHAINE. 7 troncons hors du
--      territoire guineen, 72 km, sont comptes dans les 21 157 km publies. Leur
--      exclusion s'ecrit `sourceReference LIKE 'hors_territoire:%'` : un prefixe ne
--      porte ni pays, ni motif, ni date, ni validateur, et une faute de frappe le rend
--      muet sans que rien ne le signale.
--
--   3. UNE DEGRADATION NE SE NOTE QU'EN TEXTE LIBRE. `inspections.defautsConstates` est
--      une colonne TEXT ou l'on ecrit « nids de poule importants sur 2 km ». On n'en
--      tire ni surface, ni cout, ni priorite, et c'est pour cela que les phases
--      suivantes — etat, risque, traitement, quantite, cout, programmation — n'avaient
--      rien a mordre.
--
-- CETTE MIGRATION NE CHANGE AUCUN CHIFFRE PUBLIE
--
-- Quatre tables creees, huit types crees, et des colonnes AJOUTEES a cinq tables
-- existantes. Aucun DROP, aucune colonne modifiee, aucune donnee touchee.
--
-- Le point delicat est le defaut de `statutValidation` : il n'y en a PAS. La colonne est
-- nullable et sans valeur par defaut. Un `DEFAULT 'A_VALIDER'` aurait fait basculer d'un
-- seul coup les 261 387 troncons et les 1 691 du reseau classe en « non officiels », et
-- toute requete filtrant sur VALIDE n'aurait plus rien rendu. NULL dit « pas encore
-- soumis au circuit », ce qui n'est pas A_VALIDER qui dit « en attente d'une decision ».
--
-- La consequence doit etre dite franchement : apres cette migration, AUCUN objet du
-- patrimoine n'est marque valide. Basculer les indicateurs publies sur « valide
-- seulement » reduirait le reseau affiche a zero. Ce basculement est une decision
-- separee, qui suppose une campagne de validation, et cette migration ne la prend pas.
--
-- `defauts.statutValidation` porte en revanche bien `DEFAULT 'A_VALIDER'` : la table est
-- vide, et tout defaut nait proposition. La regle est ainsi tenue par la colonne et non
-- par la bonne volonte de l'appelant.
--
-- LES INDEX GEOMETRIQUES NE VIENNENT PAS DE PRISMA
--
-- Prisma declare les colonnes `geometry(...)` mais ne cree jamais d'index dessus. La
-- forme compte : `GIST (geom)` sert les operateurs && et <-> ; `GIST ((geom::geography))`
-- sert ST_DWithin en metres. Se tromper de forme ne produit pas d'erreur, seulement un
-- Seq Scan — la lecon de l'index de la voirie locale.

-- ===================== TYPES =====================

CREATE TYPE "StatutValidation" AS ENUM ('A_VALIDER', 'VALIDE', 'REJETE', 'A_CORRIGER');

CREATE TYPE "PerimetreReseau" AS ENUM ('NATIONAL', 'HORS_TERRITOIRE_NATIONAL', 'VOIRIE_LOCALE');

CREATE TYPE "UniteDefaut" AS ENUM ('UNITE', 'METRE', 'METRE_CARRE', 'METRE_CUBE');

CREATE TYPE "MesureDefaut" AS ENUM ('NOMBRE', 'LONGUEUR', 'LARGEUR', 'PROFONDEUR', 'QUANTITE');

CREATE TYPE "FamilleDefaut" AS ENUM ('CHAUSSEE', 'ACCOTEMENT', 'ASSAINISSEMENT', 'OUVRAGE', 'SIGNALISATION', 'SECURITE', 'ENVIRONNEMENT');

CREATE TYPE "MethodeQuantite" AS ENUM ('SAISIE', 'COMPTAGE', 'LONGUEUR', 'LONGUEUR_LARGEUR', 'LONGUEUR_LARGEUR_PROFONDEUR');

CREATE TYPE "EtendueDefaut" AS ENUM ('PONCTUEL', 'LOCALISE', 'ETENDU', 'GENERALISE');

CREATE TYPE "EtatDefaut" AS ENUM ('ACTIF', 'TRAITE', 'DISPARU');

-- ===================== HISTORIQUE DES VALIDATIONS =====================

-- Table polymorphe, comme `audit_logs` et `valeurs_qualite` qui suivent deja ce motif
-- ici. Elle conserve l'HISTORIQUE et non l'etat courant : un objet peut etre renvoye en
-- correction puis represente plusieurs fois, et des colonnes « validePar / valideA » ne
-- retiendraient que la derniere decision. La chaine qui dit comment une donnee est
-- devenue officielle est precisement ce qu'un audit demande a voir.
CREATE TABLE "validations" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "statutAvant" "StatutValidation",
    "statutApres" "StatutValidation" NOT NULL,
    "decideParId" TEXT,
    "decideA" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "auteurId" TEXT,
    "source" TEXT,
    "commentaire" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "validations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "validations_entityType_entityId_idx" ON "validations"("entityType", "entityId");
CREATE INDEX "validations_statutApres_idx" ON "validations"("statutApres");
CREATE INDEX "validations_decideParId_idx" ON "validations"("decideParId");

ALTER TABLE "validations" ADD CONSTRAINT "validations_decideParId_fkey"
    FOREIGN KEY ("decideParId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===================== CATALOGUE DES DEGRADATIONS =====================

-- Administrable et non code dans l'application : les types, leurs unites et leurs
-- mesures obligatoires evoluent avec le referentiel metier, et les coder en dur
-- obligerait a livrer une version du logiciel a chaque evolution.
--
-- `seuils` reste NULL : les seuils de gravite sont NORMATIFS. « A partir de quelle
-- profondeur une orniere est grave » se tranche dans un catalogue officiel, pas dans une
-- migration. Leur absence est l'information : elle dit que la gravite saisie par un
-- agent est un jugement et non une mesure.
CREATE TABLE "catalogue_defauts" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "libelle" TEXT NOT NULL,
    "famille" "FamilleDefaut" NOT NULL,
    "parentId" INTEGER,
    "unite" "UniteDefaut" NOT NULL,
    "mesuresRequises" "MesureDefaut"[],
    "graviteMax" INTEGER DEFAULT 4,
    "seuils" JSONB,
    "description" TEXT,
    "source" TEXT NOT NULL DEFAULT 'vocabulaire_courant_a_valider',
    "version" INTEGER NOT NULL DEFAULT 1,
    "actif" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalogue_defauts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "catalogue_defauts_code_key" ON "catalogue_defauts"("code");
CREATE INDEX "catalogue_defauts_famille_idx" ON "catalogue_defauts"("famille");
CREATE INDEX "catalogue_defauts_actif_idx" ON "catalogue_defauts"("actif");
CREATE INDEX "catalogue_defauts_parentId_idx" ON "catalogue_defauts"("parentId");

ALTER TABLE "catalogue_defauts" ADD CONSTRAINT "catalogue_defauts_parentId_fkey"
    FOREIGN KEY ("parentId") REFERENCES "catalogue_defauts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===================== DEFAUTS =====================

-- LE PK N'EST PAS UNE COLONNE OBLIGATOIRE, ET C'EST LE POINT CENTRAL.
--
-- Un defaut est d'abord un objet geospatial : `lat`/`lon`/`geom` pour la position,
-- `tronconId` pour le rattachement, `abscisseM` pour l'abscisse locale. `pk` est derive
-- et nullable. Mesure du 07/10/2026 : 552 des 1 691 troncons du reseau classe portent
-- des PK exploitables, et les 1 029 regionales n'ont meme pas de structure de route a
-- laquelle rapporter un PK. Un `pk NOT NULL` rendrait le terrain impossible sur les deux
-- tiers du reseau.
--
-- `abscisseM` n'est PAS un PK et ne doit jamais etre presentee comme tel : elle ne vaut
-- que sur un segment identifie.
--
-- LES MESURES BRUTES SONT CONSERVEES A COTE DE LA QUANTITE. Une surface de 12 m2 dont on
-- a perdu le 4 par 3 ne se verifie plus et ne se corrige plus.
CREATE TABLE "defauts" (
    "id" TEXT NOT NULL,
    "code" TEXT,
    "clientOperationId" TEXT,
    "catalogueId" INTEGER NOT NULL,
    "observationId" TEXT,
    "missionId" TEXT,
    "tronconId" TEXT,
    "ouvrageId" TEXT,
    "lat" DOUBLE PRECISION,
    "lon" DOUBLE PRECISION,
    "precisionM" DOUBLE PRECISION,
    "geom" geometry(Point,4326),
    "abscisseM" DOUBLE PRECISION,
    "confianceAppariement" DOUBLE PRECISION,
    "pk" DOUBLE PRECISION,
    "emprise" geometry(Geometry,4326),
    "nombre" INTEGER,
    "longueurM" DOUBLE PRECISION,
    "largeurM" DOUBLE PRECISION,
    "profondeurM" DOUBLE PRECISION,
    "quantiteSaisie" DOUBLE PRECISION,
    "quantite" DOUBLE PRECISION,
    "uniteQuantite" "UniteDefaut",
    "methodeQuantite" "MethodeQuantite",
    "gravite" INTEGER,
    "etendue" "EtendueDefaut",
    "etat" "EtatDefaut" NOT NULL DEFAULT 'ACTIF',
    "statutValidation" "StatutValidation" NOT NULL DEFAULT 'A_VALIDER',
    "description" TEXT,
    "constateA" TIMESTAMP(3) NOT NULL,
    "constateParId" TEXT NOT NULL,
    "traiteA" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "defauts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "defauts_code_key" ON "defauts"("code");
CREATE UNIQUE INDEX "defauts_clientOperationId_key" ON "defauts"("clientOperationId");
CREATE INDEX "defauts_catalogueId_idx" ON "defauts"("catalogueId");
CREATE INDEX "defauts_tronconId_idx" ON "defauts"("tronconId");
CREATE INDEX "defauts_ouvrageId_idx" ON "defauts"("ouvrageId");
CREATE INDEX "defauts_observationId_idx" ON "defauts"("observationId");
CREATE INDEX "defauts_missionId_idx" ON "defauts"("missionId");
CREATE INDEX "defauts_statutValidation_idx" ON "defauts"("statutValidation");
CREATE INDEX "defauts_etat_idx" ON "defauts"("etat");
CREATE INDEX "defauts_deletedAt_idx" ON "defauts"("deletedAt");

-- Les deux formes, pour les deux usages. `GIST (geom)` sert l'affichage par emprise de
-- carte (&&) et le plus-proche-voisin (<->) ; `GIST ((geom::geography))` sert les
-- recherches en metres (ST_DWithin), celles d'un ecran de terrain qui demande « les
-- defauts a moins de 200 m d'ici ».
CREATE INDEX "defauts_geom_gist" ON "defauts" USING GIST ("geom");
CREATE INDEX "defauts_geom_geog_gist" ON "defauts" USING GIST (("geom"::geography));
CREATE INDEX "defauts_emprise_gist" ON "defauts" USING GIST ("emprise");

ALTER TABLE "defauts" ADD CONSTRAINT "defauts_catalogueId_fkey"
    FOREIGN KEY ("catalogueId") REFERENCES "catalogue_defauts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "defauts" ADD CONSTRAINT "defauts_observationId_fkey"
    FOREIGN KEY ("observationId") REFERENCES "observations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "defauts" ADD CONSTRAINT "defauts_missionId_fkey"
    FOREIGN KEY ("missionId") REFERENCES "missions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "defauts" ADD CONSTRAINT "defauts_tronconId_fkey"
    FOREIGN KEY ("tronconId") REFERENCES "troncons"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "defauts" ADD CONSTRAINT "defauts_ouvrageId_fkey"
    FOREIGN KEY ("ouvrageId") REFERENCES "ouvrages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "defauts" ADD CONSTRAINT "defauts_constateParId_fkey"
    FOREIGN KEY ("constateParId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===================== PREUVES =====================

-- Table distincte de `medias_observation` plutot qu'une colonne nullable ajoutee a
-- celle-ci : les deux rattachements deviendraient alors facultatifs et une ligne pourrait
-- n'etre attachee a rien. Le cout est une structure proche ; le gain est une contrainte
-- qui tient.
CREATE TABLE "medias_defaut" (
    "id" TEXT NOT NULL,
    "defautId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "chemin" TEXT NOT NULL,
    "cheminVignette" TEXT,
    "sha256" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "tailleOctets" INTEGER NOT NULL,
    "lat" DOUBLE PRECISION,
    "lon" DOUBLE PRECISION,
    "precisionM" DOUBLE PRECISION,
    "cap" DOUBLE PRECISION,
    "capturedA" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "medias_defaut_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "medias_defaut_sha256_key" ON "medias_defaut"("sha256");
CREATE INDEX "medias_defaut_defautId_idx" ON "medias_defaut"("defautId");

ALTER TABLE "medias_defaut" ADD CONSTRAINT "medias_defaut_defautId_fkey"
    FOREIGN KEY ("defautId") REFERENCES "defauts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===================== GOUVERNANCE SUR LES ENTITES EXISTANTES =====================

-- NULLABLE ET SANS DEFAUT, deliberement. Voir l'en-tete : un DEFAULT aurait fait
-- basculer tout le patrimoine en « non officiel » d'un seul coup.
ALTER TABLE "troncons" ADD COLUMN "statutValidation" "StatutValidation";
ALTER TABLE "ouvrages" ADD COLUMN "statutValidation" "StatutValidation";
ALTER TABLE "points_noirs" ADD COLUMN "statutValidation" "StatutValidation";
ALTER TABLE "postes" ADD COLUMN "statutValidation" "StatutValidation";
ALTER TABLE "chantiers" ADD COLUMN "statutValidation" "StatutValidation";

CREATE INDEX "troncons_statutValidation_idx" ON "troncons"("statutValidation");
CREATE INDEX "ouvrages_statutValidation_idx" ON "ouvrages"("statutValidation");
CREATE INDEX "points_noirs_statutValidation_idx" ON "points_noirs"("statutValidation");
CREATE INDEX "postes_statutValidation_idx" ON "postes"("statutValidation");
CREATE INDEX "chantiers_statutValidation_idx" ON "chantiers"("statutValidation");

-- Le perimetre ne concerne que les troncons : c'est eux qu'on additionne en kilometres.
--
-- Ici NULL vaut NATIONAL, a l'inverse du statut de validation, et pour une raison
-- opposee : l'omission est une absence de CLASSEMENT, pas une absence de DECISION.
-- Exclure par defaut effacerait les 1 691 troncons du reseau classe, qui existaient
-- avant ce champ.
ALTER TABLE "troncons" ADD COLUMN "perimetre" "PerimetreReseau";
ALTER TABLE "troncons" ADD COLUMN "paysTerritoire" TEXT;
ALTER TABLE "troncons" ADD COLUMN "motifPerimetre" TEXT;
ALTER TABLE "troncons" ADD COLUMN "perimetreClasseA" TIMESTAMP(3);

CREATE INDEX "troncons_perimetre_idx" ON "troncons"("perimetre");

-- Rien n'est RENSEIGNE par cette migration. Le classement des 7 troncons hors
-- territoire et la mise en A_VALIDER des 81 ouvrages DTOAA passent par des scripts
-- dedies, auditables et reversibles, et non par un UPDATE noye dans une migration de
-- schema.

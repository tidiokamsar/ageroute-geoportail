-- AGEROUTE ROAD : portions homogenes d'un troncon.
--
-- CE QUE CETTE TABLE RESOUT
--
-- Un troncon porte UN revetement et UN etat pour toute sa longueur. Le terrain ne s'y plie
-- pas : 8 km de bitume en bon etat, 5 km de bitume degrade, 4 km de laterite, 3 km
-- critiques, et c'est le meme troncon. Une PORTION decrit une partie homogene, bornee par
-- deux abscisses le long de la geometrie de reference.
--
-- L'ABSCISSE LOCALE FAIT AUTORITE, PAS LE PK
--
-- `debutM` et `finM` sont mesures depuis le debut de la geometrie de reference, ce que
-- `ST_LineLocatePoint` rend et que `geo/appariement.ts` produit deja. Aucun PK n'est porte
-- ici : les 1 029 troncons regionaux n'en ont pas de calculable, et faire dependre la
-- qualification du PK les aurait rendus inqualifiables.
--
-- CETTE MIGRATION EST ADDITIVE ET N'ECRIT AUCUNE LIGNE
--
-- Deux tables neuves, un enum neuf, une extension, et trois relations inverses. Aucune
-- colonne existante n'est touchee. La table sort VIDE, et c'est delibere :
--
-- Mesure du 13/10/2026 en production : `troncons.revetement` vaut NON_RENSEIGNE sur
-- 258 961 lignes et BITUME sur 2 426, sans une seule laterite sur un reseau ou elle
-- domine ; `troncons.etat` vaut NON_EVALUE sur 254 547 des 261 387. Peupler les portions
-- depuis ces colonnes fabriquerait 261 387 observations que personne n'a faites.
--
-- Un troncon sans portion est donc NON QUALIFIE, et `reseau/portions.ts` le rend comme un
-- trou nomme par ses abscisses, jamais comme un etat herite.
--
-- POURQUOI btree_gist
--
-- La contrainte d'exclusion ci-dessous compare un `tronconId` avec `=` et un intervalle
-- d'abscisses avec `&&` dans le MEME index GiST. L'operateur `=` sur du texte n'est pas
-- disponible en GiST sans cette extension. Elle est marquee `trusted`, donc installable
-- sans superuser sur PostgreSQL 13 et au-dela.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Sans cela, un decoupage et un releve de terrain se ressemblent en base, et l'historique
-- du reseau devient illisible.
CREATE TYPE "OriginePortion" AS ENUM (
  'SAISIE_TERRAIN', 'DECOUPE', 'FUSION', 'REQUALIFICATION', 'IMPORT'
);

CREATE TABLE "portions" (
  "id"               TEXT NOT NULL,
  "tronconId"        TEXT NOT NULL,
  "debutM"           DOUBLE PRECISION NOT NULL,
  "finM"             DOUBLE PRECISION NOT NULL,
  "revetement"       "Revetement",
  "etat"             "EtatPatrimoine",
  -- TEXTE ET NON ENUM, volontairement. Le cahier demande un referentiel configurable pour
  -- la praticabilite et n'en enonce AUCUNE valeur, contrairement au revetement dont il
  -- liste les huit. Figer ici un vocabulaire que personne n'a arrete en ferait une norme.
  -- La colonne recevra sa contrainte en meme temps que son referentiel.
  "praticabilite"    TEXT,
  "largeurM"         DOUBLE PRECISION,
  "source"           TEXT,
  -- Date du CONSTAT, pas de la saisie. Nulle quand elle est inconnue : une date absente
  -- n'est pas une date ancienne.
  "observeeLe"       TIMESTAMP(3),
  "confiance"        "NiveauConfiance",
  "origine"          "OriginePortion" NOT NULL,
  "observationId"    TEXT,
  -- Une portion de terrain est une PROPOSITION jusqu'a validation par un tiers.
  "statutValidation" "StatutValidation" NOT NULL DEFAULT 'A_VALIDER',
  -- `remplaceeLe` dit « ceci etait vrai et ne l'est plus » ; `deletedAt` dit « ceci
  -- n'aurait jamais du etre saisi ». Les confondre rendrait l'historique inexplicable.
  "remplaceeLe"      TIMESTAMP(3),
  "deletedAt"        TIMESTAMP(3),
  "creeParId"        TEXT NOT NULL,
  -- Geometrie DERIVEE de debutM/finM par ST_LineSubstring, conservee pour que la carte
  -- n'ait pas a la recalculer. ELLE NE FAIT PAS AUTORITE : si le trace de reference est
  -- corrige, elle devient perimee et se recalcule depuis les abscisses, jamais l'inverse.
  "geom"             geometry(LineString,4326),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,

  CONSTRAINT "portions_pkey" PRIMARY KEY ("id")
);

-- Un decoupage donne UN parent et DEUX enfants ; une fusion donne DEUX parents et UN
-- enfant. Une colonne `remplaceeParId` ne sait exprimer ni l'un ni l'autre sans mentir sur
-- le second. Le lien est donc plusieurs-a-plusieurs.
CREATE TABLE "portions_lignage" (
  "parentId"  TEXT NOT NULL,
  "enfantId"  TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "portions_lignage_pkey" PRIMARY KEY ("parentId","enfantId")
);

CREATE INDEX "portions_tronconId_debutM_idx" ON "portions"("tronconId", "debutM");
CREATE INDEX "portions_tronconId_remplaceeLe_idx" ON "portions"("tronconId", "remplaceeLe");
CREATE INDEX "portions_statutValidation_idx" ON "portions"("statutValidation");
CREATE INDEX "portions_deletedAt_idx" ON "portions"("deletedAt");
CREATE INDEX "portions_observationId_idx" ON "portions"("observationId");
CREATE INDEX "portions_lignage_enfantId_idx" ON "portions_lignage"("enfantId");

-- Index spatial, que Prisma ne sait pas declarer. Meme raison que `defauts_geom_gist` :
-- sans lui, afficher les portions de l'emprise visible balaie la table.
CREATE INDEX "portions_geom_gist" ON "portions" USING GIST ("geom");

ALTER TABLE "portions"
  ADD CONSTRAINT "portion_bornes_ordonnees"
  CHECK ("finM" > "debutM");

ALTER TABLE "portions"
  ADD CONSTRAINT "portion_debut_non_negatif"
  CHECK ("debutM" >= 0);

ALTER TABLE "portions"
  ADD CONSTRAINT "portion_largeur_positive"
  CHECK ("largeurM" IS NULL OR "largeurM" > 0);

-- PAS de plancher de longueur ici. Les 10 m de `reseau/portions.ts` sont un garde-fou de
-- BRUIT GPS, pas une norme, et le seuil metier appartient a AGEROUTE. Le figer dans une
-- contrainte obligerait a une migration pour changer une valeur de reglage.

ALTER TABLE "portions_lignage"
  ADD CONSTRAINT "lignage_non_reflexif"
  CHECK ("parentId" <> "enfantId");

-- LA CONTRAINTE QUI DEMANDE LE PLUS D'EXPLICATION
--
-- Le REFERENTIEL VALIDE ne doit pas affirmer deux choses du meme metre de route. Deux
-- portions validees qui se recouvrent rendraient toute statistique indefendable : on ne
-- saurait plus laquelle compter.
--
-- Mais la contrainte ne porte QUE sur `VALIDE`. Les propositions, elles, DOIVENT pouvoir
-- se contredire : c'est ainsi qu'arrive une observation de terrain qui dit autre chose que
-- la precedente, et le paragraphe 11 du cahier interdit tout ecrasement silencieux.
-- Interdire le chevauchement des propositions empecherait de SAISIR la contradiction, donc
-- de l'arbitrer. `reseau/portions.ts` la signale, un humain la tranche, et seule la version
-- retenue devient officielle.
--
-- `numrange` et non `float` : l'operateur `&&` d'intervalle demande un type de plage, et
-- `[debut, fin)` ferme a gauche rend deux portions adjacentes NON chevauchantes.
--
-- COMPORTEMENT EPROUVE le 13/10/2026, dans un conteneur jetable, et non suppose :
--
--   ACCEPTE  deux PROPOSITIONS qui se contredisent      <- la contradiction peut etre saisie
--   ACCEPTE  deux validees ADJACENTES                   <- le `[)` fait son office
--   ACCEPTE  une validee et son ancienne version        <- l'historique se recouvre
--   ACCEPTE  la meme emprise sur un AUTRE troncon
--   REFUSE   deux validees qui se CHEVAUCHENT           <- le seul cas vise
ALTER TABLE "portions"
  ADD CONSTRAINT "portion_validee_sans_chevauchement"
  EXCLUDE USING GIST (
    "tronconId" WITH =,
    numrange("debutM"::numeric, "finM"::numeric, '[)') WITH &&
  ) WHERE ("statutValidation" = 'VALIDE' AND "remplaceeLe" IS NULL AND "deletedAt" IS NULL);

ALTER TABLE "portions"
  ADD CONSTRAINT "portions_tronconId_fkey"
  FOREIGN KEY ("tronconId") REFERENCES "troncons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "portions"
  ADD CONSTRAINT "portions_observationId_fkey"
  FOREIGN KEY ("observationId") REFERENCES "observations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "portions"
  ADD CONSTRAINT "portions_creeParId_fkey"
  FOREIGN KEY ("creeParId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RESTRICT des deux cotes : une portion citee dans un lignage ne se supprime pas, sinon
-- l'historique d'un decoupage perdrait une de ses branches.
ALTER TABLE "portions_lignage"
  ADD CONSTRAINT "portions_lignage_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "portions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "portions_lignage"
  ADD CONSTRAINT "portions_lignage_enfantId_fkey"
  FOREIGN KEY ("enfantId") REFERENCES "portions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

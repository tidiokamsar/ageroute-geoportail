-- AGEROUTE ROAD : Condition Engine / RCI (paragraphe 13 du cahier).
--
-- POURQUOI LES COEFFICIENTS SONT DES LIGNES ET NON DU CODE
--
-- Le paragraphe 13 enonce ses ponderations — chaussee 30 %, drainage 15 %, ouvrages 15 %,
-- signalisation 10 %, securite 10 %, trafic 10 %, historique 5 %, incidents 5 % — en les
-- qualifiant explicitement de « base indicative A CALIBRER ».
--
-- Les ecrire dans le code produirait un score qui a l'air officiel et que personne n'a
-- valide : exactement ce que la regle imperative du paragraphe 39 interdit. Cette
-- migration cree donc le MECANISME ; les nombres restent une decision d'AGEROUTE, prise
-- en inserant une ligne et en l'approuvant.
--
-- Tant qu'aucune regle n'est approuvee, le moteur calcule et l'interne consulte, mais
-- `publiable` reste false sur chaque score. C'est le seul interrupteur.
--
-- CETTE MIGRATION EST ADDITIVE ET NE CHANGE AUCUN COMPORTEMENT
--
-- Trois tables neuves, deux enums neufs, deux relations inverses. Aucune colonne
-- existante n'est touchee, aucune ligne n'est ecrite : les trois tables sortent vides, et
-- aucune regle n'existe donc aucun score n'est calculable avant qu'AGEROUTE n'en cree une.
--
-- CE QUE LES CONTRAINTES DEFENDENT
--
-- `evaluation_score_ou_refus` : un score et un motif de refus s'excluent. Sans elle, une
-- evaluation pourrait porter les deux — un nombre ET la raison de ne pas en avoir — et
-- plus rien ne dirait laquelle des deux lire.
--
-- `composante_valeur_ou_exclusion` : une composante retenue a une valeur, une composante
-- exclue n'en a pas. Une valeur sur une ligne exclue serait un chiffre qui n'a pas
-- participe au calcul et que quelqu'un finirait par lire comme s'il y avait participe.
--
-- `couverture` et `couvertureMinimale` sont bornees a [0,1], le score a [0,100] : les
-- bornes du domaine, pas une preference.

CREATE TYPE "ComposanteRci" AS ENUM (
  'CHAUSSEE', 'DRAINAGE', 'OUVRAGES', 'SIGNALISATION',
  'SECURITE', 'TRAFIC', 'HISTORIQUE', 'INCIDENTS'
);

-- PERIMEE et ABSENTE ne se confondent pas : un etat releve il y a dix ans demande une
-- reinspection, un etat jamais releve demande un inventaire. Les deux sortent du calcul,
-- mais on ne va pas chercher la meme chose.
CREATE TYPE "MotifExclusionRci" AS ENUM (
  'ABSENTE', 'PERIMEE', 'CONFIANCE_INSUFFISANTE', 'POIDS_NUL'
);

CREATE TABLE "regles_condition" (
  "id"                  TEXT NOT NULL,
  "version"             TEXT NOT NULL,
  "poids"               JSONB NOT NULL,
  "fraicheurMaxJours"   INTEGER NOT NULL,
  "confiancesAcceptees" TEXT[],
  "couvertureMinimale"  DOUBLE PRECISION NOT NULL,
  "sensCroissant"       BOOLEAN NOT NULL DEFAULT true,
  "motif"               TEXT,
  "creeParId"           TEXT NOT NULL,
  "approuveeLe"         TIMESTAMP(3),
  "approuveeParId"      TEXT,
  "retireeLe"           TIMESTAMP(3),
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,

  CONSTRAINT "regles_condition_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "regles_condition_version_key" ON "regles_condition"("version");
CREATE INDEX "regles_condition_approuveeLe_idx" ON "regles_condition"("approuveeLe");

ALTER TABLE "regles_condition"
  ADD CONSTRAINT "regle_couverture_minimale_bornee"
  CHECK ("couvertureMinimale" >= 0 AND "couvertureMinimale" <= 1);

ALTER TABLE "regles_condition"
  ADD CONSTRAINT "regle_fraicheur_positive"
  CHECK ("fraicheurMaxJours" > 0);

-- Approuvee PAR quelqu'un ou pas approuvee du tout : une approbation sans approbateur ne
-- serait imputable a personne, ce que le paragraphe 26 ne permet pas.
ALTER TABLE "regles_condition"
  ADD CONSTRAINT "regle_approbation_imputable"
  CHECK (("approuveeLe" IS NULL) = ("approuveeParId" IS NULL));

CREATE TABLE "evaluations_condition" (
  "id"           TEXT NOT NULL,
  "tronconId"    TEXT NOT NULL,
  "regleId"      TEXT NOT NULL,
  "regleVersion" TEXT NOT NULL,
  "score"        DOUBLE PRECISION,
  "motifRefus"   TEXT,
  "couverture"   DOUBLE PRECISION NOT NULL,
  "confiance"    "NiveauConfiance",
  "publiable"    BOOLEAN NOT NULL DEFAULT false,
  "explication"  TEXT NOT NULL,
  "entrees"      JSONB NOT NULL,
  "calculeLe"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "evaluations_condition_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "evaluations_condition_tronconId_calculeLe_idx"
  ON "evaluations_condition"("tronconId", "calculeLe");
CREATE INDEX "evaluations_condition_regleId_idx" ON "evaluations_condition"("regleId");
CREATE INDEX "evaluations_condition_publiable_idx" ON "evaluations_condition"("publiable");

ALTER TABLE "evaluations_condition"
  ADD CONSTRAINT "evaluation_score_borne"
  CHECK ("score" IS NULL OR ("score" >= 0 AND "score" <= 100));

ALTER TABLE "evaluations_condition"
  ADD CONSTRAINT "evaluation_couverture_bornee"
  CHECK ("couverture" >= 0 AND "couverture" <= 1);

ALTER TABLE "evaluations_condition"
  ADD CONSTRAINT "evaluation_score_ou_refus"
  CHECK (("score" IS NULL) <> ("motifRefus" IS NULL));

-- Un refus n'est pas publiable : il n'y a rien a publier.
ALTER TABLE "evaluations_condition"
  ADD CONSTRAINT "evaluation_refus_non_publiable"
  CHECK ("score" IS NOT NULL OR "publiable" = false);

-- La confiance accompagne un score et rien d'autre. Un refus n'a pas de confiance
-- « faible » : il n'a pas de confiance du tout, et ecrire LOW serait porter un jugement de
-- qualite sur un chiffre qui n'existe pas.
ALTER TABLE "evaluations_condition"
  ADD CONSTRAINT "evaluation_confiance_avec_score"
  CHECK (("score" IS NULL) = ("confiance" IS NULL));

CREATE TABLE "composantes_evaluation" (
  "id"            TEXT NOT NULL,
  "evaluationId"  TEXT NOT NULL,
  "composante"    "ComposanteRci" NOT NULL,
  "valeur"        DOUBLE PRECISION,
  "poidsDeclare"  DOUBLE PRECISION NOT NULL,
  "poidsEffectif" DOUBLE PRECISION NOT NULL,
  "contribution"  DOUBLE PRECISION NOT NULL,
  "exclue"        "MotifExclusionRci",
  "source"        TEXT,
  "observeeLe"    TIMESTAMP(3),

  CONSTRAINT "composantes_evaluation_pkey" PRIMARY KEY ("id")
);

-- « Combien de troncons manquent de donnee de trafic » est la question qu'on posera en
-- premier : c'est elle qui dit ou envoyer les equipes.
CREATE INDEX "composantes_evaluation_composante_exclue_idx"
  ON "composantes_evaluation"("composante", "exclue");

-- Une composante figure UNE fois par evaluation : deux lignes compteraient son poids deux
-- fois. Cet index sert aussi les recherches par evaluation seule, puisque `evaluationId`
-- en est la colonne de tete — un index separe sur elle serait du travail d'ecriture pour
-- rien.
CREATE UNIQUE INDEX "composantes_evaluation_evaluationId_composante_key"
  ON "composantes_evaluation"("evaluationId", "composante");

ALTER TABLE "composantes_evaluation"
  ADD CONSTRAINT "composante_valeur_ou_exclusion"
  CHECK (("valeur" IS NULL) = ("exclue" IS NOT NULL));

ALTER TABLE "composantes_evaluation"
  ADD CONSTRAINT "composante_valeur_bornee"
  CHECK ("valeur" IS NULL OR ("valeur" >= 0 AND "valeur" <= 100));

-- Une composante exclue ne contribue pas, et son poids effectif est nul : c'est la
-- renormalisation qui l'a mise de cote.
ALTER TABLE "composantes_evaluation"
  ADD CONSTRAINT "composante_exclue_sans_contribution"
  CHECK ("exclue" IS NULL OR ("contribution" = 0 AND "poidsEffectif" = 0));

ALTER TABLE "regles_condition"
  ADD CONSTRAINT "regles_condition_creeParId_fkey"
  FOREIGN KEY ("creeParId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "regles_condition"
  ADD CONSTRAINT "regles_condition_approuveeParId_fkey"
  FOREIGN KEY ("approuveeParId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "evaluations_condition"
  ADD CONSTRAINT "evaluations_condition_tronconId_fkey"
  FOREIGN KEY ("tronconId") REFERENCES "troncons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "evaluations_condition"
  ADD CONSTRAINT "evaluations_condition_regleId_fkey"
  FOREIGN KEY ("regleId") REFERENCES "regles_condition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CASCADE ici, et nulle part ailleurs : les composantes n'existent que comme detail d'une
-- evaluation. Les garder orphelines ne dirait plus de quel score elles sont le detail.
-- L'evaluation elle-meme, en revanche, ne se supprime pas.
ALTER TABLE "composantes_evaluation"
  ADD CONSTRAINT "composantes_evaluation_evaluationId_fkey"
  FOREIGN KEY ("evaluationId") REFERENCES "evaluations_condition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

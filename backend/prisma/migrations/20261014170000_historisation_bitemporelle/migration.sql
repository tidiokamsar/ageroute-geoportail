-- AGEROUTE ROAD : l'historisation bitemporelle, et l'anticipation exigee au lot 2.
--
-- ------------------------------------------------------------------------------------------
-- A. CE QUI MANQUAIT : UNE DATE D'EFFET DE FIN
-- ------------------------------------------------------------------------------------------
--
-- Le paragraphe 7.2 du mandat v2.1 exige « `valide_du` / `valide_au` (date d'effet terrain) +
-- `enregistre_le` (date systeme) ».
--
-- `portions` portait deja trois dates : `observeeLe` (constat), `createdAt` (systeme) et
-- `remplaceeLe` (cloture systeme). Il manquait la date d'effet de FIN.
--
-- La difference n'est pas une subtilite. Une route est reprise le 15 mars ; un agent le releve
-- le 2 avril. `remplaceeLe` dit quand on a ENREGISTRE le remplacement, pas quand la realite a
-- change : au 2 avril, la base ne pouvait pas dire que l'ancienne portion avait cesse d'etre
-- vraie le 15 mars.
--
-- Deux questions deviennent donc repondables :
--
--   « Quel etait l'etat au 20 mars ? »        axe TERRAIN   -> valideDu / valideAu
--   « Que savait-on le 25 mars de l'etat ? »  axe SYSTEME   -> createdAt / remplaceeLe
--
-- La seconde est celle qu'un bailleur pose en demandant sur quelles donnees une programmation
-- a ete decidee. Sans elle, un programme arrete en mars paraitrait avoir ignore une
-- information qui n'existait pas encore.
--
-- POURQUOI `observeeLe` N'EST PAS RENOMME EN `valideDu`
--
-- Ce sont deux choses. Un agent peut constater le 2 avril qu'une piste est en laterite DEPUIS
-- l'an dernier. `observeeLe` dit quand on a regarde, `valideDu` depuis quand c'est vrai. Les
-- fusionner perdrait la provenance de l'information.
--
-- L'INTERVALLE EST SEMI-OUVERT : [valideDu, valideAu)
--
-- Ferme des deux cotes, deux versions successives seraient toutes deux valides a l'instant de
-- la bascule, et toute requete a cette date rendrait deux reponses. La contrainte ci-dessous
-- interdit donc l'egalite, qui produirait un intervalle VIDE — une version vraie a aucune
-- date, et la perte serait silencieuse.
--
-- ------------------------------------------------------------------------------------------
-- B. ANTICIPATION EXIGEE PAR LE PARAGRAPHE 14
-- ------------------------------------------------------------------------------------------
--
-- « Meme les fonctions C doivent etre prevues dans le modele de donnees des le lot 2, pour
-- eviter des migrations lourdes ulterieures. »
--
-- Cette migration anticipe donc deux fonctions, en COLONNES SUR TABLES EXISTANTES et non en
-- tables nouvelles : c'est l'ajout tardif d'une colonne a une table peuplee qui coute cher,
-- alors qu'une table nouvelle s'ajoute aussi bien dans six mois. Les tables que T-09 (points
-- de calibration du PK) et le gazetier demanderont ne sont donc PAS creees ici.
--
-- ------------------------------------------------------------------------------------------
-- CETTE MIGRATION EST ADDITIVE. Aucune ligne n'est ecrite, aucune colonne retiree.
-- `portions` et `medias_defaut` sont vides en production au 14/10/2026.
--
-- RETOUR ARRIERE : voir `20261014170000_historisation_bitemporelle/descente.sql`.
-- Il n'a PAS ete execute : aucune base de developpement n'existe (B-13), et le garde-fou 2.1
-- interdit la production. Le paragraphe 9.4 demande une migration « testee en montee ET en
-- descente sur une base de developpement » : cette exigence n'est pas tenue, et je ne la
-- declare pas tenue.
-- ------------------------------------------------------------------------------------------

-- ===== A. Axe terrain sur les portions =====

ALTER TABLE "portions"
  ADD COLUMN "valideDu" DATE,
  ADD COLUMN "valideAu" DATE;

COMMENT ON COLUMN "portions"."valideDu" IS
  'Depuis quand le contenu de cette version est VRAI SUR LE TERRAIN. Distinct de observeeLe, qui dit quand on a regarde, et de createdAt, qui dit quand le systeme a enregistre.';

COMMENT ON COLUMN "portions"."valideAu" IS
  'Jusqu''a quand, EXCLU (intervalle semi-ouvert). Nulle quand la version est encore vraie. Distinct de remplaceeLe, qui dit quand le remplacement a ete ENREGISTRE.';

-- Une fin anterieure ou egale au debut produirait une version vraie a aucune date.
ALTER TABLE "portions"
  ADD CONSTRAINT "portion_intervalle_effet_non_vide"
  CHECK ("valideDu" IS NULL OR "valideAu" IS NULL OR "valideAu" > "valideDu");

-- Les requetes temporelles portent toutes sur (troncon, fenetre d'effet).
CREATE INDEX "portions_tronconId_valideDu_idx" ON "portions" ("tronconId", "valideDu");
CREATE INDEX "portions_valideAu_idx" ON "portions" ("valideAu") WHERE "valideAu" IS NULL;

-- ===== B.1 Praticabilite saisonniere (T-07, priorite M) =====
--
-- `portions.praticabilite` existait deja, en texte libre rattache a un referentiel
-- VOLONTAIREMENT VIDE : le cahier demande ce referentiel sans enoncer une seule valeur, et en
-- figer une en ferait la norme d'AGEROUTE par defaut (B-01).
--
-- Ce qui manquait est le CONTEXTE de la praticabilite, que le paragraphe 14.1 enumere :
-- « statut ouvert / limite (tonnage, 4x4) / coupe, cause, date, duree estimee ».

ALTER TABLE "portions"
  ADD COLUMN "praticabiliteCause"         TEXT,
  ADD COLUMN "praticabiliteDepuis"        DATE,
  ADD COLUMN "praticabiliteDureeJours"    INTEGER,
  ADD COLUMN "praticabiliteTonnageMaxT"   DECIMAL(6,2);

COMMENT ON COLUMN "portions"."praticabiliteCause" IS
  'Pourquoi la praticabilite est degradee : inondation, bourbier, ouvrage coupe, glissement. Texte libre tant que le referentiel de causes n''est pas arrete.';

COMMENT ON COLUMN "portions"."praticabiliteTonnageMaxT" IS
  'Tonnage maximal admis quand la praticabilite est LIMITEE. Nul quand la limite n''est pas un tonnage (4x4 uniquement, par exemple).';

ALTER TABLE "portions"
  ADD CONSTRAINT "portion_praticabilite_duree_positive"
  CHECK ("praticabiliteDureeJours" IS NULL OR "praticabiliteDureeJours" > 0);

ALTER TABLE "portions"
  ADD CONSTRAINT "portion_praticabilite_tonnage_positif"
  CHECK ("praticabiliteTonnageMaxT" IS NULL OR "praticabiliteTonnageMaxT" > 0);

-- ===== B.2 Architecture prete pour la vision par ordinateur (T-03) =====
--
-- Le point 9 de l'exigence « vision nationale » demandait que l'architecture y soit PRETE,
-- sans demander la vision elle-meme. `medias_defaut` portait un `sha256`, ce qui rend une
-- photo identifiable et dedoublonnable : c'etait le bon debut, et il manquait la suite.
--
-- LA DISTINCTION QUI PORTE TOUT : « non analyse » n'est pas « analyse sans detection ».
--
-- Une seule colonne de resultat les confondrait, et un tableau de bord afficherait « aucun
-- defaut detecte » sur des photos que rien n'a jamais regardees. C'est exactement le mensonge
-- que le moteur de condition refuse en distinguant une composante ABSENTE d'un zero.
--
-- `analyseeLe` nulle  ->  personne n'a regarde
-- `analyseeLe` posee, `analyseResultat` vide  ->  analyse, rien trouve
--
-- Et le MODELE est versionne : une detection faite par une version ancienne n'a pas la meme
-- valeur qu'une detection recente, et le paragraphe 14 l'exige — « les modeles et methodes
-- sont versionnes et leurs limites documentees ».

ALTER TABLE "medias_defaut"
  ADD COLUMN "analyseeLe"       TIMESTAMP(3),
  ADD COLUMN "analyseModele"    TEXT,
  ADD COLUMN "analyseVersion"   TEXT,
  ADD COLUMN "analyseResultat"  JSONB,
  ADD COLUMN "analyseConfiance" DECIMAL(4,3);

COMMENT ON COLUMN "medias_defaut"."analyseeLe" IS
  'Quand un modele a examine ce media. NULLE signifie PERSONNE N''A REGARDE, ce qui est distinct d''une analyse sans detection.';

COMMENT ON COLUMN "medias_defaut"."analyseResultat" IS
  'Propositions du modele. Un tableau VIDE signifie analyse sans detection. Ces propositions ne sont jamais des donnees officielles : paragraphe 14, regle generale, elles passent par le workflow de validation.';

-- Un resultat sans date d'analyse, ou une date sans modele, rendrait le resultat
-- inexploitable : on ne saurait ni quand ni par quoi il a ete produit.
ALTER TABLE "medias_defaut"
  ADD CONSTRAINT "media_analyse_coherente"
  CHECK (
    ("analyseeLe" IS NULL AND "analyseModele" IS NULL AND "analyseResultat" IS NULL)
    OR ("analyseeLe" IS NOT NULL AND "analyseModele" IS NOT NULL)
  );

-- Un resultat doit etre un TABLEAU de propositions, pas un objet ni un scalaire. Meme
-- raisonnement que pour `regles_condition.classes` : une valeur mal formee serait lue comme
-- une liste vide, donc comme « analyse sans detection », sans rien dire.
ALTER TABLE "medias_defaut"
  ADD CONSTRAINT "media_analyse_resultat_est_un_tableau"
  CHECK ("analyseResultat" IS NULL OR jsonb_typeof("analyseResultat") = 'array');

ALTER TABLE "medias_defaut"
  ADD CONSTRAINT "media_analyse_confiance_bornee"
  CHECK ("analyseConfiance" IS NULL OR ("analyseConfiance" >= 0 AND "analyseConfiance" <= 1));

CREATE INDEX "medias_defaut_analyseeLe_idx" ON "medias_defaut" ("analyseeLe");

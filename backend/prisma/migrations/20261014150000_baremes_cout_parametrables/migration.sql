-- AGEROUTE ROAD : les baremes de cout cessent d'etre anonymes, et deviennent parametrables.
--
-- CE QUE J'AI TROUVE LE 14/10/2026, ET QUE J'AVAIS NIE
--
-- J'ai ecrit dans PROJECT_STATUS.md, dans le tableau de conformite et dans le plan qu'il
-- n'existait « aucune table de prix ». C'etait faux : `baremes_intervention` porte NEUF
-- lignes peuplees, reliant famille de revetement et etat de depart a un type d'intervention
-- et a un COUT AU KILOMETRE EN GNF, de 350 millions a 3,5 milliards.
--
-- Le defaut n'etait donc pas l'absence de la table. Il etait sa forme : CINQ colonnes —
-- identifiant, famille, etat, intervention, cout — et ni source, ni version, ni approbation,
-- ni date, la ou `matrices_degradation` trace deja source et version.
--
-- Un cout de 3,5 milliards GNF au kilometre que personne ne peut attribuer est exactement le
-- nombre qui finit dans un rapport bailleur sans qu'on puisse dire qui l'a fixe, ni quand, ni
-- pour quelle largeur de chaussee. Cette migration le rend imputable.
--
-- LES VALEURS NE CHANGENT PAS. Les neuf couts restent ce qu'ils sont ; ils deviennent
-- seulement traçables, datables, approuvables et modifiables. Le script qui les complete les
-- laisse en `source = standard_initial` et NON APPROUVEES, parce qu'un prix est une decision.
--
-- ------------------------------------------------------------------------------------------
-- A. UN PRIX AU KILOMETRE EST SOUS-SPECIFIE, ET TROIS COLONNES MANQUAIENT POUR LE LIRE
-- ------------------------------------------------------------------------------------------
--
-- « 3 500 000 000 GNF/km » ne se compare a rien et ne s'indexe pas :
--
--   anneeReference    un prix sans millesime ne peut etre ni compare ni actualise. Deux
--                     baremes de 2024 et 2026 ne disent pas la meme chose.
--   largeurChausseeM  un cout au kilometre depend de la largeur reconstruite. Sans elle,
--                     3,5 Md/km peut designer une 2x2 voies ou une piste de 5 m.
--   devise            GNF aujourd'hui, mais un financement bailleur se chiffre en devise.
--
-- Les trois sont NULLES sur les lignes existantes, et c'est volontaire : personne ne sait
-- pour quelle annee ni quelle largeur ces neuf couts ont ete poses. Les deviner serait
-- inventer la donnee que cette migration cherche precisement a rendre verifiable.
--
-- ------------------------------------------------------------------------------------------
-- B. LA CLE D'UNICITE INTERDISAIT LA COMPARAISON DE SCENARIOS
-- ------------------------------------------------------------------------------------------
--
-- `UNIQUE (familleRevetement, etatDepart)` imposait UN SEUL type d'intervention par etat :
-- une chaussee bitumee en etat MAUVAIS ne pouvait couter qu'une rehabilitation, jamais une
-- reconstruction anticipee ni un entretien de survie.
--
-- Or le paragraphe 11 du cahier demande « une comparaison entre scenarios de maintenance ».
-- Avec l'ancienne cle, il n'y a rien a comparer.
--
-- La nouvelle cle porte donc le TYPE et la VERSION : plusieurs interventions possibles pour
-- un meme etat, et l'historique des revisions conserve plutot qu'ecrase.
--
-- ------------------------------------------------------------------------------------------
-- C. LA FAMILLE DE COUT N'EST PAS UN REVETEMENT, ET LE LIEN MANQUAIT
-- ------------------------------------------------------------------------------------------
--
-- Les baremes connaissent trois familles — bitume, terre_laterite, pave — la ou
-- `referentiel_revetements` porte HUIT codes. Ce ne sont pas deux listes du meme objet :
-- `bitume` recouvre BETON_BITUMINEUX et ENDUIT_SUPERFICIEL, `terre_laterite` recouvre TERRE
-- et LATERITE. La famille de cout est donc plus GROSSIERE que le revetement.
--
-- Transformer `familleRevetement` en cle etrangere vers les revetements serait faux : cela
-- forcerait a scinder un prix en plusieurs, donc a inventer des distinctions que personne
-- n'a decidees.
--
-- Le lien est pose dans l'autre sens, sur la table deja administrable : chaque revetement
-- DECLARE sa famille de cout. L'administrateur gere les revetements, et dit a quelle famille
-- chacun appartient.
--
-- ET CELA FAIT APPARAITRE UN TROU QU'IL NE FAUT PAS COMBLER PAR DEFAUT
--
--   BETON_BITUMINEUX, ENDUIT_SUPERFICIEL  ->  bitume
--   LATERITE, TERRE                       ->  terre_laterite
--   PAVE                                  ->  pave
--   BETON                                 ->  AUCUNE famille
--   AUTRE, NON_RENSEIGNE                  ->  AUCUNE famille
--
-- `BETON` designe le beton de ciment : revetu mais non bitumineux, et aucun bareme ne le
-- chiffre. Le rattacher a `bitume` lui donnerait un prix qui n'est pas le sien ; a `pave`,
-- un prix arbitraire. La colonne reste donc NULLE, et un moteur de couts devra REFUSER
-- d'estimer une chaussee en beton plutot que deviner — le meme refus que le RCI oppose a une
-- composante sans correspondance.
--
-- ------------------------------------------------------------------------------------------
-- CETTE MIGRATION EST ADDITIVE. Aucune ligne n'est ecrite, aucun cout modifie.
-- ------------------------------------------------------------------------------------------

-- ===== A. Provenance, economie et cycle de vie des baremes =====

ALTER TABLE "baremes_intervention"
  ADD COLUMN "code"             TEXT,
  ADD COLUMN "libelle"          TEXT,
  ADD COLUMN "source"           TEXT    NOT NULL DEFAULT 'standard_initial',
  ADD COLUMN "version"          INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "approuveLe"       TIMESTAMP(3),
  ADD COLUMN "approuveParId"    TEXT,
  ADD COLUMN "anneeReference"   INTEGER,
  ADD COLUMN "devise"           TEXT    NOT NULL DEFAULT 'GNF',
  ADD COLUMN "largeurChausseeM" DECIMAL(6,2),
  ADD COLUMN "uniteCout"        TEXT    NOT NULL DEFAULT 'KM',
  ADD COLUMN "actif"            BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "ordre"            INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "commentaire"      TEXT,
  ADD COLUMN "validDe"          DATE,
  ADD COLUMN "validA"           DATE,
  ADD COLUMN "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- L'approbateur est une personne, et la ligne survit a la suppression de son compte :
-- ON DELETE SET NULL plutot que CASCADE. Perdre la trace de qui a approuve est deja
-- regrettable ; perdre le prix lui-meme serait une perte de patrimoine.
ALTER TABLE "baremes_intervention"
  ADD CONSTRAINT "baremes_intervention_approuveParId_fkey"
  FOREIGN KEY ("approuveParId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Un cout nul ou negatif n'est pas un prix. Sans cette borne, un 0 saisi par erreur rendrait
-- une estimation gratuite, ce qui passerait pour une bonne nouvelle.
ALTER TABLE "baremes_intervention"
  ADD CONSTRAINT "bareme_cout_strictement_positif" CHECK ("coutKmGnf" > 0);

ALTER TABLE "baremes_intervention"
  ADD CONSTRAINT "bareme_version_positive" CHECK ("version" > 0);

-- Une annee de reference hors de cet intervalle est une faute de saisie, pas un millesime.
ALTER TABLE "baremes_intervention"
  ADD CONSTRAINT "bareme_annee_plausible"
  CHECK ("anneeReference" IS NULL OR ("anneeReference" BETWEEN 1990 AND 2100));

ALTER TABLE "baremes_intervention"
  ADD CONSTRAINT "bareme_largeur_positive"
  CHECK ("largeurChausseeM" IS NULL OR "largeurChausseeM" > 0);

-- Une fenetre de validite inversee rendrait la ligne inapplicable sans jamais le dire.
ALTER TABLE "baremes_intervention"
  ADD CONSTRAINT "bareme_fenetre_coherente"
  CHECK ("validDe" IS NULL OR "validA" IS NULL OR "validA" >= "validDe");

ALTER TABLE "baremes_intervention"
  ADD CONSTRAINT "bareme_unite_connue" CHECK ("uniteCout" IN ('KM', 'M2', 'M3', 'UNITE'));

ALTER TABLE "baremes_intervention"
  ADD CONSTRAINT "bareme_devise_non_vide" CHECK (length(btrim("devise")) > 0);

-- ===== B. La cle d'unicite s'ouvre aux scenarios et aux revisions =====

ALTER TABLE "baremes_intervention"
  DROP CONSTRAINT "baremes_intervention_familleRevetement_etatDepart_key";

ALTER TABLE "baremes_intervention"
  ADD CONSTRAINT "baremes_intervention_famille_etat_type_version_key"
  UNIQUE ("familleRevetement", "etatDepart", "typeIntervention", "version");

CREATE UNIQUE INDEX "baremes_intervention_code_key"
  ON "baremes_intervention" ("code") WHERE "code" IS NOT NULL;

CREATE INDEX "baremes_intervention_actif_famille_idx"
  ON "baremes_intervention" ("actif", "familleRevetement", "etatDepart");

-- ===== C. Les matrices de degradation recoivent le meme interrupteur d'approbation =====
--
-- Elles tracent deja source et version, mais une probabilite de transition est tout autant
-- une decision qu'un prix : « une chaussee bitumee a faible trafic se degrade de BON a MOYEN
-- avec une probabilite de 0,08 par an » est une hypothese de modele, pas une mesure.

ALTER TABLE "matrices_degradation"
  ADD COLUMN "approuveLe"    TIMESTAMP(3),
  ADD COLUMN "approuveParId" TEXT,
  ADD COLUMN "commentaire"   TEXT,
  ADD COLUMN "actif"         BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "matrices_degradation"
  ADD CONSTRAINT "matrices_degradation_approuveParId_fkey"
  FOREIGN KEY ("approuveParId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Une probabilite est dans [0, 1]. La contrainte manquait : 1,8 passait.
ALTER TABLE "matrices_degradation"
  ADD CONSTRAINT "matrice_probabilites_bornees"
  CHECK ("pBonVersMoyen" BETWEEN 0 AND 1
     AND "pMoyenVersMauvais" BETWEEN 0 AND 1
     AND "pMauvaisVersCritique" BETWEEN 0 AND 1);

-- ===== D. Le revetement declare sa famille de cout =====

ALTER TABLE "referentiel_revetements"
  ADD COLUMN "familleCout" TEXT;

COMMENT ON COLUMN "referentiel_revetements"."familleCout" IS
  'Famille de bareme de cout. NULLE quand aucun bareme ne chiffre ce revetement : un moteur de couts doit alors REFUSER d''estimer, pas deviner.';

-- CATALOGUE DES TRAITEMENTS ET CONDITIONS D'APPLICATION (paragraphe 7.7, Treatment Engine)
--
-- ETAPE 2 de l'ordre de construction de MAINTENANCE_PROGRAMMING_DESIGN.md -- la seule du
-- paragraphe 7.7 qui ne depende pas de la decision D-07 sur les barèmes.
--
-- D'OU VIENNENT LES LIGNES, ET POURQUOI RIEN N'EST INVENTE
--
-- Le depot ne possedait aucun catalogue des traitements : il possedait neuf barèmes
-- (`baremes_intervention`) qui relient une famille de revetement et un etat de depart a un
-- `typeIntervention` texte libre. Trois valeurs distinctes y vivent : `entretien_periodique`,
-- `rehabilitation`, `reconstruction`. Ce sont les trois traitements semes ci-dessous, et les
-- neuf conditions d'application sont les neuf couples (famille, etat) des barèmes. Rien de plus.
--
-- Le paragraphe 7.7 attend davantage pour chaque traitement : duree de vie attendue, effet sur
-- l'indice, fenetre de realisation hors saison des pluies par region. CES COLONNES EXISTENT ET
-- SONT NULLES. Les remplir demanderait des valeurs que personne n'a arretees ; le garde-fou
-- « aucune norme inventee » l'interdit, et une duree de vie devinee entrerait dans les lois
-- d'effet, donc dans la programmation, donc dans un chiffre presente au FER.
--
-- La classe de trafic des conditions est NULLE aussi : les barèmes ne la distinguent pas, et la
-- fabriquer en recopiant les trois classes des matrices de degradation donnerait vingt-sept
-- conditions dont dix-huit seraient des copies sans source.
--
-- POURQUOI AUCUNE CLE ETRANGERE DEPUIS `baremes_intervention`
--
-- Il serait tentant de contraindre `baremes_intervention.typeIntervention` vers ce catalogue.
-- Mais cette table est PEUPLEE EN PRODUCTION, ou ses valeurs ne sont plus verifiables depuis le
-- gel du 14/10 : un `ADD CONSTRAINT` y echouerait sur une valeur inattendue, et ferait echouer
-- tout `migrate deploy`. Le lien vit donc en sens inverse -- le catalogue est cle par le code du
-- traitement -- et un banc d'essai verifie que chaque `typeIntervention` des barèmes a sa ligne.
-- C'est le meme raisonnement que `BaremeIntervention.familleRevetement`, volontairement sans
-- cle etrangere vers les revetements.
--
-- TABLES ET NON ENUMERATIONS : `famille` et `code` sont administrables. `ALTER TYPE ADD VALUE`
-- est irreversible (lecon D-06).
--
-- NATURE : additive. Deux tables creees, douze lignes semees avec `source = 'standard_initial'`
-- et AUCUNE APPROUVEE. Aucune table existante touchee.

CREATE TABLE IF NOT EXISTS "catalogue_traitements" (
  "code"     TEXT PRIMARY KEY,
  "libelle"  TEXT NOT NULL,
  -- Famille du paragraphe 7.7 : entretien courant, entretien periodique, rehabilitation,
  -- reconstruction, ouvrages, drainage. Texte administrable.
  "famille"  TEXT NOT NULL,

  -- Les trois attributs que le paragraphe 7.7 exige, VOLONTAIREMENT NULS au semis.
  "dureeVieAttendueAns"    INTEGER,
  "effetSurIndice"         NUMERIC(6, 2),
  "fenetreRealisation"     TEXT,

  "source"        TEXT NOT NULL DEFAULT 'standard_initial',
  "version"       INTEGER NOT NULL DEFAULT 1,
  "approuveLe"    TIMESTAMP(3),
  "approuveParId" TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE SET NULL,
  "commentaire"   TEXT,
  "actif"         BOOLEAN NOT NULL DEFAULT true,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "traitement_duree_vie_positive" CHECK (
    "dureeVieAttendueAns" IS NULL OR "dureeVieAttendueAns" > 0
  ),
  -- Un traitement qui degraderait l'indice n'est pas un traitement.
  CONSTRAINT "traitement_effet_positif" CHECK (
    "effetSurIndice" IS NULL OR "effetSurIndice" > 0
  ),
  -- Approuve sans approbateur, ou l'inverse, n'a pas de sens : meme regle que les regles de
  -- condition et les barèmes.
  CONSTRAINT "traitement_approbation_signee" CHECK (
    ("approuveLe" IS NULL) = ("approuveParId" IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS "conditions_traitement" (
  "id"                SERIAL PRIMARY KEY,
  "traitementCode"    TEXT NOT NULL REFERENCES "catalogue_traitements"("code")
                        ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Memes conventions que `baremes_intervention` : famille de cout, plus grossiere que le
  -- revetement ; etat de depart en code d'etat patrimonial.
  "familleRevetement" TEXT NOT NULL,
  "etatDepart"        TEXT NOT NULL,
  -- NULLE au semis : les barèmes ne distinguent pas le trafic. Voir l'en-tete.
  "classeTrafic"      TEXT,
  "source"            TEXT NOT NULL DEFAULT 'standard_initial',
  "actif"             BOOLEAN NOT NULL DEFAULT true,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Une condition ne designe qu'un traitement : la matrice d'orientation est une fonction,
  -- pas une relation. Deux traitements pour le meme (famille, etat, trafic) obligeraient le
  -- moteur a choisir, donc a inventer un critere.
  --
  -- NULLS NOT DISTINCT, ET C'EST UNE CORRECTION TROUVEE PAR LE BANC D'ESSAI. En SQL, deux NULL
  -- sont distincts dans une contrainte UNIQUE ordinaire : avec `classeTrafic` nulle -- l'etat
  -- seme, puisque les baremes ne distinguent pas le trafic -- la contrainte ne jouait PAS, et
  -- (bitume, MOYEN) acceptait deux traitements. La matrice n'etait une fonction que sur le
  -- papier. PostgreSQL 15+ sait traiter les NULL comme egaux ; la production est en 17.
  CONSTRAINT "condition_traitement_unique"
    UNIQUE NULLS NOT DISTINCT ("familleRevetement", "etatDepart", "classeTrafic")
);

CREATE INDEX IF NOT EXISTS "conditions_traitement_code_idx"
  ON "conditions_traitement" ("traitementCode");

-- ===== Semis : les trois traitements que les barèmes connaissent =====

INSERT INTO "catalogue_traitements" ("code", "libelle", "famille", "commentaire") VALUES
  ('entretien_periodique', 'Entretien periodique', 'ENTRETIEN_PERIODIQUE',
   'Code releve dans baremes_intervention (3 lignes). Duree de vie, effet et fenetre non arretes.'),
  ('rehabilitation',       'Rehabilitation',       'REHABILITATION',
   'Code releve dans baremes_intervention (3 lignes). Duree de vie, effet et fenetre non arretes.'),
  ('reconstruction',       'Reconstruction',       'RECONSTRUCTION',
   'Code releve dans baremes_intervention (3 lignes). Duree de vie, effet et fenetre non arretes.')
ON CONFLICT ("code") DO NOTHING;

-- ===== Semis : les neuf conditions, copiees des neuf barèmes =====
--
-- Copie et non saisie : la requete lit `baremes_intervention` plutot que de recopier neuf
-- lignes a la main, pour que la provenance soit litterale. Si un bareme a ete ajoute en
-- production depuis le 14/10, sa condition est semee avec lui.

INSERT INTO "conditions_traitement" ("traitementCode", "familleRevetement", "etatDepart", "source")
SELECT DISTINCT b."typeIntervention", b."familleRevetement", b."etatDepart", 'baremes_intervention'
  FROM "baremes_intervention" b
  JOIN "catalogue_traitements" c ON c."code" = b."typeIntervention"
 WHERE b."actif"
ON CONFLICT ("familleRevetement", "etatDepart", "classeTrafic") DO NOTHING;

COMMENT ON TABLE "catalogue_traitements" IS
  'Catalogue des traitements (paragraphe 7.7, Treatment Engine). Trois codes releves dans '
  'baremes_intervention, aucun approuve. dureeVieAttendueAns, effetSurIndice et '
  'fenetreRealisation sont NULS a dessein : personne ne les a arretes, et les deviner '
  'entrerait dans la programmation. Non approuve, le catalogue sert a simuler, pas a '
  'programmer officiellement.';

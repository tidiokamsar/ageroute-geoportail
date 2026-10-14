-- LOTS ET LIGNES D'IMPORT : LE CONTRAT D'IMPORT UNIQUE (ROAD_SURVEY_IMPORT_SPEC.md)
--
-- Paragraphe E.3 du prompt maitre V10 : « Toute donnee importee conserve source,
-- auteur/importateur, date, methode, format, lot, validations, erreurs et transformations
-- appliquees ». Critere A28 : « import idempotent, 100 % des lignes dans un statut ».
--
-- UN SEUL CONTRAT POUR TOUTES LES SOURCES -- ONR, ANASUR Collect, comptages, pesage, satellite
-- -- parce que la question est toujours la meme : d'ou vient cette ligne, qui l'a fait entrer,
-- qu'a-t-on change, qu'est-elle devenue ? Un importateur par source y repondrait differemment
-- a chaque fois, et c'est la que la provenance se perd.
--
-- CE QUE LA BASE TIENT ELLE-MEME, ET POURQUOI
--
-- 1. 100 % DES LIGNES DANS UN STATUT (A28). La contrainte `lot_compteurs_complets` impose
--    lues = importees + rejetees + en_conflit + ignorees. Un importateur qui perdrait une ligne
--    ne pourrait pas clore son lot. Ce n'est pas le rapport qui le dit, c'est la table.
--
-- 2. IDEMPOTENCE (A28). L'empreinte SHA-256 du fichier est UNIQUE par systeme source : le meme
--    fichier importe deux fois est refuse par la base avant toute ecriture, et l'importateur
--    rend le lot existant. La cle (lot, numero de ligne) est unique aussi : une ligne ne peut
--    pas etre comptee deux fois.
--
-- 3. LA CHARGE ORIGINALE EST CONSERVEE. `chargeOriginale` est la ligne brute telle que recue,
--    avant toute transformation. Cela coute de l'espace et rend l'import CONTESTABLE : si un
--    rapprochement est faux, on repart de ce qui a ete recu, pas de ce qu'on en a fait.
--
-- 4. UN REJET PORTE SON MOTIF, UN IMPORT PORTE SA CIBLE. Une ligne REJETEE sans motif ou une
--    ligne IMPORTEE sans objet cible seraient des statuts sans contenu.
--
-- 5. AUCUNE OPERATION DE SUPPRESSION. L'importateur ne possede aucun chemin qui supprime ou
--    fusionne : « jamais de fusion ou suppression automatique » (paragraphe B.4) est tenu par
--    l'absence du geste, comme la frontiere DigitalRoad l'est par l'absence des colonnes.
--
-- CE QUE LA BASE NE TIENT PAS : que l'objet cible soit en `A_VALIDER`. C'est la table cible qui
-- le garantit par defaut (`statutValidation`), et un test de l'importateur le verifie.
--
-- NATURE : additive. Deux types, deux tables. Aucune table existante touchee, aucune donnee.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'StatutLotImport') THEN
    CREATE TYPE "StatutLotImport" AS ENUM
      ('RECU', 'VALIDE_SCHEMA', 'IMPORTE_TEST', 'IMPORTE', 'REJETE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'StatutLigneImport') THEN
    CREATE TYPE "StatutLigneImport" AS ENUM
      ('IMPORTEE', 'REJETEE', 'EN_CONFLIT', 'IGNOREE');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "lots_import" (
  "id"        TEXT PRIMARY KEY,
  -- Identifiant stable lisible : IMP-2026-000012.
  "reference" TEXT NOT NULL,

  -- Vocabulaire administrable, pas une enumeration (lecon D-06).
  "systemeSource"    TEXT NOT NULL,
  -- Tel que recu, JAMAIS presume : 'csv', 'geojson', 'gpkg', ou ce que la source declare.
  "format"           TEXT NOT NULL,
  "empreinteFichier" TEXT NOT NULL,
  "nomFichier"       TEXT NOT NULL,
  "tailleOctets"     BIGINT NOT NULL,

  -- L'importateur, pas l'auteur.
  "importeParId" TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "importeLe"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- L'auteur chez la source et la date du releve, tels que declares, si connus.
  "auteurSource" TEXT,
  "dateSource"   TIMESTAMP(3),
  "methodeSource" TEXT NOT NULL,

  "versionMapping"  TEXT NOT NULL,
  -- Reference de l'autorisation ecrite (paragraphe B.4). Obligatoire : aucun import sans elle.
  "autorisationRef" TEXT NOT NULL,

  "statut" "StatutLotImport" NOT NULL DEFAULT 'RECU',

  -- Compteurs, dont la somme est contrainte.
  "lignesLues"       INTEGER NOT NULL DEFAULT 0,
  "lignesImportees"  INTEGER NOT NULL DEFAULT 0,
  "lignesRejetees"   INTEGER NOT NULL DEFAULT 0,
  "lignesEnConflit"  INTEGER NOT NULL DEFAULT 0,
  "lignesIgnorees"   INTEGER NOT NULL DEFAULT 0,

  "rapport"   JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- A28 : 100 % des lignes dans exactement un statut.
  CONSTRAINT "lot_compteurs_complets" CHECK (
    "lignesLues" = "lignesImportees" + "lignesRejetees" + "lignesEnConflit" + "lignesIgnorees"
  ),
  CONSTRAINT "lot_compteurs_positifs" CHECK (
    "lignesLues" >= 0 AND "lignesImportees" >= 0 AND "lignesRejetees" >= 0
    AND "lignesEnConflit" >= 0 AND "lignesIgnorees" >= 0
  ),
  -- Un SHA-256 hexadecimal fait 64 caracteres. Une empreinte d'une autre forme serait un
  -- identifiant choisi par l'appelant, et l'idempotence reposerait sur sa bonne foi.
  CONSTRAINT "lot_empreinte_sha256" CHECK ("empreinteFichier" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "lot_autorisation_non_vide" CHECK (length(btrim("autorisationRef")) > 0),
  -- Un lot REJETE n'a importe aucune ligne ; un lot IMPORTE en a lu au moins une.
  CONSTRAINT "lot_statut_coherent" CHECK (
    ("statut" <> 'REJETE' OR "lignesImportees" = 0)
    AND ("statut" NOT IN ('IMPORTE', 'IMPORTE_TEST') OR "lignesLues" > 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "lots_import_reference_key" ON "lots_import" ("reference");
-- IDEMPOTENCE : le meme fichier, pour la meme source, n'entre qu'une fois.
CREATE UNIQUE INDEX IF NOT EXISTS "lots_import_source_empreinte_key"
  ON "lots_import" ("systemeSource", "empreinteFichier");
CREATE INDEX IF NOT EXISTS "lots_import_statut_idx" ON "lots_import" ("statut");
CREATE INDEX IF NOT EXISTS "lots_import_importeParId_idx" ON "lots_import" ("importeParId");

CREATE TABLE IF NOT EXISTS "lignes_import" (
  "id"          TEXT PRIMARY KEY,
  "lotId"       TEXT NOT NULL REFERENCES "lots_import"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Position dans le fichier source, pour retrouver l'original. Commence a 1.
  "numeroLigne" INTEGER NOT NULL,

  "identifiantSource" TEXT,
  -- La ligne brute, AVANT toute transformation.
  "chargeOriginale"   JSONB NOT NULL,
  -- Liste ordonnee des transformations appliquees : conversion d'unite, de SRID, de code.
  -- Jamais une valeur inventee.
  "transformations"   JSONB NOT NULL DEFAULT '[]'::jsonb,

  "statut"     "StatutLigneImport" NOT NULL,
  "motifRejet" TEXT,

  "correspondanceId" TEXT,
  "objetCibleType"   TEXT,
  "objetCibleId"     TEXT,

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ligne_numero_positif" CHECK ("numeroLigne" >= 1),
  -- Un rejet sans motif n'explique rien a la source.
  CONSTRAINT "ligne_rejet_motive" CHECK (
    "statut" <> 'REJETEE' OR ("motifRejet" IS NOT NULL AND length(btrim("motifRejet")) > 0)
  ),
  -- Une ligne importee a cree quelque chose, et dit quoi ; une ligne non importee n'a rien cree.
  CONSTRAINT "ligne_cible_coherente" CHECK (
    ("statut" = 'IMPORTEE') = ("objetCibleId" IS NOT NULL AND "objetCibleType" IS NOT NULL)
  ),
  CONSTRAINT "ligne_transformations_tableau" CHECK (jsonb_typeof("transformations") = 'array')
);

-- Une ligne du fichier n'est comptee qu'une fois.
CREATE UNIQUE INDEX IF NOT EXISTS "lignes_import_lot_numero_key"
  ON "lignes_import" ("lotId", "numeroLigne");
CREATE INDEX IF NOT EXISTS "lignes_import_statut_idx" ON "lignes_import" ("lotId", "statut");
CREATE INDEX IF NOT EXISTS "lignes_import_cible_idx" ON "lignes_import" ("objetCibleType", "objetCibleId");

COMMENT ON TABLE "lots_import" IS
  'Contrat d''import unique (ROAD_SURVEY_IMPORT_SPEC.md, paragraphe E.3). Idempotence par '
  'empreinte SHA-256 unique par source ; 100 % des lignes dans un statut par contrainte '
  '(critere A28). Aucun chemin de suppression : « jamais de fusion ou suppression '
  'automatique » est tenu par l''absence du geste.';

-- TACHES D'INTERVENTION INTERNES, NON CONTRACTUELLES (TI-01)
--
-- L'arbitrage D1 du prompt maitre V10 maintient la frontiere DigitalRoad, et fait entrer trois
-- objets dans la plateforme. Celui-ci est le premier : « petites interventions en regie,
-- cantonnage, verifications, nettoyage d'ouvrages, inspections periodiques -- identifiant
-- stable, perimetre geographique, defaut ou actif d'origine, responsable, echeance, preuves
-- avant/apres, quantites constatees, cloture. AUCUNE ENTREPRISE, AUCUN MARCHE, AUCUN MONTANT
-- CONTRACTUEL : des qu'un prestataire ou un marche intervient, l'objet vit dans DigitalRoad ».
--
-- LA DISTINCTION EST FINE ET ELLE PORTE TOUT. Une tache de regie n'est pas un marche. L'exclure
-- au motif qu'elle ressemble a des travaux priverait AGEROUTE de la trace de ce qu'elle execute
-- elle-meme -- or c'est son quotidien.
--
-- COMMENT LA FRONTIERE EST TENUE : PAR L'ABSENCE DES COLONNES
--
-- Cette table n'a AUCUNE colonne de montant, de prix, de marche, d'entreprise, de decompte ni
-- de paiement, et aucune cle etrangere vers `marches`. Ce n'est pas un oubli, c'est le
-- mecanisme : une interdiction tenue par l'absence de l'objet vaut mieux qu'une interdiction
-- tenue par une consigne. Un test de garde-fou balaie `schema.prisma` et fait echouer la suite
-- si une telle colonne apparait un jour par commodite.
--
-- Les QUANTITES CONSTATEES sont autorisees, les montants non, et la nuance est le coeur de
-- TI-01 : « 40 m3 de laterite reprise » est un constat de terrain, « 12 millions GNF » est un
-- engagement. Le premier appartient au patrimoine, le second a DigitalRoad.
--
-- POURQUOI LA NATURE EST UN REFERENTIEL ET NON UNE ENUMERATION
--
-- Les cinq natures que le paragraphe 14.12 nomme ne sont pas inventees, mais les figer dans un
-- type PostgreSQL le serait presque : `ALTER TYPE ... ADD VALUE` est IRREVERSIBLE, et la
-- decision D-06 montre ce que cela coute -- l'enumeration `ClasseRoute` n'a aucune valeur pour
-- les 19 846 km de routes communautaires, et il n'existe pas de geste propre pour l'ajouter.
-- Le vocabulaire d'exploitation est administrable ; il vit donc dans une table, comme
-- `portions.etat` l'a appris avant lui.
--
-- Les lignes semees portent `source = 'mandat_v10'` et ne sont PAS declarees approuvees : ce
-- sont les natures que le mandat enonce, pas une nomenclature officielle d'AGEROUTE.
--
-- NATURE DE LA MIGRATION : additive. Deux objets crees, un type, une table, un referentiel
-- seme. Aucune table existante modifiee, aucune donnee patrimoniale touchee.

-- ===== Vocabulaire administrable des natures =====

CREATE TABLE IF NOT EXISTS "referentiel_natures_tache" (
  "code"      TEXT PRIMARY KEY,
  "libelle"   TEXT NOT NULL,
  "ordre"     INTEGER NOT NULL,
  "actif"     BOOLEAN NOT NULL DEFAULT true,
  -- D'ou vient cette valeur, pour ne jamais confondre « enonce par le mandat » et « arrete par
  -- AGEROUTE ». Meme exigence que pour les baremes et les regles de condition.
  "source"    TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "referentiel_natures_tache" ("code", "libelle", "ordre", "source") VALUES
  ('CANTONNAGE',            'Cantonnage',                      1, 'mandat_v10'),
  ('PETITE_REPARATION',     'Petite reparation en regie',      2, 'mandat_v10'),
  ('VERIFICATION',          'Verification',                    3, 'mandat_v10'),
  ('NETTOYAGE_OUVRAGE',     'Nettoyage d''ouvrage',            4, 'mandat_v10'),
  ('INSPECTION_PERIODIQUE', 'Inspection periodique',           5, 'mandat_v10')
ON CONFLICT ("code") DO NOTHING;

-- ===== Etats de la tache =====
--
-- ENUMERATION ici, et non referentiel, parce qu'un statut n'est pas un vocabulaire : c'est une
-- machine a etats dont chaque valeur est citee par une contrainte et par du code. L'ajouter
-- librement n'aurait aucun sens -- il faudrait de toute facon decider ce qu'elle implique.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'StatutTacheInterne') THEN
    CREATE TYPE "StatutTacheInterne" AS ENUM ('OUVERTE', 'EN_COURS', 'CLOTUREE', 'ABANDONNEE');
  END IF;
END $$;

-- ===== La table =====

CREATE TABLE IF NOT EXISTS "taches_internes" (
  "id"        TEXT PRIMARY KEY,

  -- IDENTIFIANT STABLE exige par TI-01. Lisible par un agent au telephone, et il ne change
  -- jamais -- c'est ce qui le distingue de `id`, qui est technique.
  "reference" TEXT NOT NULL,

  "nature"    TEXT NOT NULL REFERENCES "referentiel_natures_tache"("code")
                ON UPDATE CASCADE ON DELETE RESTRICT,
  "intitule"  TEXT NOT NULL,
  "description" TEXT,

  -- PERIMETRE GEOGRAPHIQUE. Trois rattachements possibles, aucun obligatoire seul, mais au
  -- moins un exige : une tache qui ne designe rien ne se retrouve pas sur le terrain.
  "tronconId" TEXT REFERENCES "troncons"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "debutM"    DOUBLE PRECISION,
  "finM"      DOUBLE PRECISION,
  "ouvrageId" TEXT REFERENCES "ouvrages"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "defautId"  TEXT REFERENCES "defauts"("id")  ON UPDATE CASCADE ON DELETE RESTRICT,
  "geom"      geometry(Point, 4326),

  "responsableId" TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "echeanceLe"    DATE,

  "statut" "StatutTacheInterne" NOT NULL DEFAULT 'OUVERTE',

  -- QUANTITES CONSTATEES, et rien qui ressemble a un montant. Voir l'en-tete.
  "quantiteConstatee" NUMERIC(12, 3),
  "quantiteUnite"     TEXT,

  -- PREUVES AVANT/APRES, portees par la tache elle-meme et non par une table de medias.
  --
  -- CE CHOIX EST CE QUI REND LE CRITERE A29 VERIFIABLE PAR LA BASE. « Une tache interne
  -- cloturee possede des preuves avant/apres » est un invariant qui croise deux tables si les
  -- preuves vivent ailleurs, et un tel invariant ne s'exprime pas en `CHECK` : il faudrait un
  -- declencheur, le premier de ce depot, invisible a Prisma et au lecteur.
  --
  -- En placant la paire sur la ligne, l'invariant devient LOCAL et declaratif. Et c'est aussi
  -- plus juste du point de vue du metier : avant/apres est une PAIRE, pas un album.
  "preuveAvantChemin"  TEXT,
  "preuveAvantPriseLe" TIMESTAMP(3),
  "preuveApresChemin"  TEXT,
  "preuveApresPriseLe" TIMESTAMP(3),

  "clotureeLe"   TIMESTAMP(3),
  "clotureeParId" TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "abandonMotif" TEXT,

  -- Cle d'idempotence generee par l'appareil avant tout envoi, comme pour les portions et les
  -- observations. Sans elle, une reponse perdue en zone blanche fait renvoyer l'operation et
  -- cree une tache en double.
  "clientOperationId" TEXT,

  "creeParId" TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,

  -- SUPPRESSION LOGIQUE UNIQUEMENT, comme toute entite de ce depot.
  "deletedAt" TIMESTAMP(3),

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- ===== Invariants =====

  -- A29, premiere moitie. Tenue par la base et non par une consigne de service.
  CONSTRAINT "tache_cloturee_avec_preuves" CHECK (
    "statut" <> 'CLOTUREE'
    OR (
      "preuveAvantChemin"  IS NOT NULL AND "preuveAvantPriseLe" IS NOT NULL
      AND "preuveApresChemin" IS NOT NULL AND "preuveApresPriseLe" IS NOT NULL
    )
  ),

  -- Une preuve « apres » qui precede la preuve « avant » decrit l'inverse de ce qu'elle pretend.
  -- C'est le controle qui attrape l'inversion de deux fichiers, et la photo prise d'avance.
  CONSTRAINT "tache_preuves_dans_l_ordre" CHECK (
    "preuveAvantPriseLe" IS NULL
    OR "preuveApresPriseLe" IS NULL
    OR "preuveApresPriseLe" >= "preuveAvantPriseLe"
  ),

  -- Une cloture sans auteur ni date ne serait pas auditable.
  CONSTRAINT "tache_cloture_signee" CHECK (
    "statut" <> 'CLOTUREE' OR ("clotureeLe" IS NOT NULL AND "clotureeParId" IS NOT NULL)
  ),

  -- Un abandon est une decision : il se motive. Sans cela, l'abandon deviendrait la sortie
  -- facile pour toute tache dont on ne veut pas produire les preuves.
  CONSTRAINT "tache_abandon_motive" CHECK (
    "statut" <> 'ABANDONNEE' OR ("abandonMotif" IS NOT NULL AND length(btrim("abandonMotif")) > 0)
  ),

  -- Une quantite sans unite ne veut rien dire, et une unite sans quantite non plus.
  CONSTRAINT "tache_quantite_avec_unite" CHECK (
    ("quantiteConstatee" IS NULL) = ("quantiteUnite" IS NULL)
  ),
  CONSTRAINT "tache_quantite_positive" CHECK (
    "quantiteConstatee" IS NULL OR "quantiteConstatee" > 0
  ),

  -- Emprise lineaire : les deux bornes ou aucune, et dans le bon sens.
  CONSTRAINT "tache_emprise_coherente" CHECK (
    ("debutM" IS NULL AND "finM" IS NULL)
    OR ("debutM" IS NOT NULL AND "finM" IS NOT NULL AND "finM" > "debutM" AND "debutM" >= 0)
  ),

  -- Une emprise lineaire sans troncon n'a pas de systeme d'abscisses, donc aucun sens.
  CONSTRAINT "tache_emprise_exige_un_troncon" CHECK (
    "debutM" IS NULL OR "tronconId" IS NOT NULL
  ),

  -- AU MOINS UN RATTACHEMENT. Une tache qui ne designe ni troncon, ni ouvrage, ni defaut, ni
  -- point ne se retrouve pas sur le terrain : elle serait une note, pas une tache.
  CONSTRAINT "tache_rattachee" CHECK (
    "tronconId" IS NOT NULL OR "ouvrageId" IS NOT NULL
    OR "defautId" IS NOT NULL OR "geom" IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "taches_internes_reference_key"
  ON "taches_internes" ("reference");
CREATE UNIQUE INDEX IF NOT EXISTS "taches_internes_clientOperationId_key"
  ON "taches_internes" ("clientOperationId");

CREATE INDEX IF NOT EXISTS "taches_internes_tronconId_idx"     ON "taches_internes" ("tronconId");
CREATE INDEX IF NOT EXISTS "taches_internes_ouvrageId_idx"     ON "taches_internes" ("ouvrageId");
CREATE INDEX IF NOT EXISTS "taches_internes_defautId_idx"      ON "taches_internes" ("defautId");
CREATE INDEX IF NOT EXISTS "taches_internes_responsableId_idx" ON "taches_internes" ("responsableId");
CREATE INDEX IF NOT EXISTS "taches_internes_deletedAt_idx"     ON "taches_internes" ("deletedAt");

-- Index partiel : les ecrans de suivi ne listent que ce qui reste a faire, et cette liste est
-- petite devant l'historique. Un index sur tout le statut vieillirait mal.
CREATE INDEX IF NOT EXISTS "taches_internes_a_faire_idx"
  ON "taches_internes" ("echeanceLe", "responsableId")
  WHERE "statut" IN ('OUVERTE', 'EN_COURS') AND "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "taches_internes_geom_gist"
  ON "taches_internes" USING gist ("geom");

COMMENT ON TABLE "taches_internes" IS
  'Taches d''intervention INTERNES, non contractuelles (TI-01, arbitrage D1). Aucune colonne de '
  'montant, de marche, d''entreprise, de decompte ni de paiement, et c''est le mecanisme qui '
  'tient la frontiere DigitalRoad : des qu''un prestataire ou un marche intervient, l''objet '
  'n''est plus representable ici. Un test de garde-fou le verifie.';

COMMENT ON COLUMN "taches_internes"."quantiteConstatee" IS
  'Quantite CONSTATEE sur le terrain, jamais un montant : « 40 m3 de laterite reprise » est un '
  'constat, « 12 millions GNF » est un engagement et appartient a DigitalRoad.';

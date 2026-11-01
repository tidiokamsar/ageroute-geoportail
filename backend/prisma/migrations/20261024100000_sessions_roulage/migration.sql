-- COLLECTE EN ROULAGE (paragraphe 7.13, criteres A16, A17, A18, A19) : sessions, marqueurs, evenements lineaires.
--
-- UNE SESSION EST ENVOYEE PAR LE TELEPHONE EN UNE OPERATION du protocole de synchronisation existant
-- (entityType SessionRoulage). Le serveur y trouve une trace GNSS a 1 Hz, des marqueurs d'evenements
-- ponctuels et des evenements lineaires Debut/Fin, les rattache au reseau par l'analyseur de trace
-- existant (HMM), et fait aboutir chaque evenement lineaire a une ou plusieurs PORTIONS de troncon
-- avec leurs abscisses. Voir docs/roulage/COLLECTE-ROULAGE.md.
--
-- CE QUI EST CONSERVE, ET POURQUOI
--
-- La trace est gardee telle que l'appareil l'a rendue (colonne `points`, JSONB compact) et non
-- re-echantillonnee : une analyse ulterieure, avec un graphe ou des seuils meilleurs, doit pouvoir
-- repartir de la donnee d'origine. Les seuils que l'appareil a appliques sont gardes avec elle
-- (`parametres`, `provenanceParametres`), car ils sont PROVISOIRES et non calibres.
--
-- L'IDEMPOTENCE : `id` est genere par l'appareil, `clientOperationId` est unique. Rejouer une
-- session ne cree aucune ligne. Les marqueurs et evenements sont cles par (session, id appareil).
--
-- AUCUN IRI n'est stocke : il n'existe pas d'etalonnage approuve (voir le module iri du noyau).
-- Aucune ligne n'est semee. Suppression logique seule (`deletedAt`) sur la session ; les portions
-- creees sont des PROPOSITIONS (statut A_VALIDER) que les ecrans existants valident.
--
-- NATURE : additive. Quatre tables, aucune table existante modifiee.

CREATE TABLE IF NOT EXISTS "sessions_roulage" (
  "id"                   TEXT PRIMARY KEY,
  "clientOperationId"    TEXT NOT NULL,
  "userId"               TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "appareilId"           TEXT NOT NULL REFERENCES "appareils"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "missionId"            TEXT REFERENCES "missions"("id") ON UPDATE CASCADE ON DELETE SET NULL,
  "debutA"               TIMESTAMP(3) NOT NULL,
  "finA"                 TIMESTAMP(3) NOT NULL,
  "versionContrat"       INTEGER NOT NULL,
  "provenanceParametres" TEXT NOT NULL,
  "parametres"           JSONB NOT NULL,
  "nbPoints"             INTEGER NOT NULL,
  "points"               JSONB NOT NULL,
  "trous"                JSONB NOT NULL,
  "interruptions"        JSONB NOT NULL,
  "pauses"               JSONB NOT NULL,
  "compteurs"            JSONB NOT NULL,
  "analyse"              JSONB NOT NULL,
  "tauxRattachement"     DOUBLE PRECISION,
  "geom"                 geometry(MultiLineString, 4326),
  "deletedAt"            TIMESTAMP(3),
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sessions_roulage_clientOperationId_key" UNIQUE ("clientOperationId"),
  CONSTRAINT "sessions_roulage_duree_ck" CHECK ("finA" >= "debutA"),
  CONSTRAINT "sessions_roulage_points_ck" CHECK ("nbPoints" >= 2),
  CONSTRAINT "sessions_roulage_taux_ck" CHECK ("tauxRattachement" IS NULL OR ("tauxRattachement" >= 0 AND "tauxRattachement" <= 1))
);
CREATE INDEX IF NOT EXISTS "sessions_roulage_userId_idx" ON "sessions_roulage" ("userId");
CREATE INDEX IF NOT EXISTS "sessions_roulage_appareilId_idx" ON "sessions_roulage" ("appareilId");
CREATE INDEX IF NOT EXISTS "sessions_roulage_missionId_idx" ON "sessions_roulage" ("missionId");
CREATE INDEX IF NOT EXISTS "sessions_roulage_geom_gist" ON "sessions_roulage" USING GIST ("geom");

CREATE TABLE IF NOT EXISTS "marqueurs_roulage" (
  "sessionId"           TEXT NOT NULL REFERENCES "sessions_roulage"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "id"                  TEXT NOT NULL,
  "code"                TEXT NOT NULL,
  "note"                TEXT,
  "poseA"               TIMESTAMP(3) NOT NULL,
  "lat"                 DOUBLE PRECISION,
  "lon"                 DOUBLE PRECISION,
  "precisionM"          DOUBLE PRECISION,
  "ageFixMs"            INTEGER,
  "positionPerimee"     BOOLEAN NOT NULL,
  "latenceLogicielleMs" DOUBLE PRECISION,
  "statut"              TEXT NOT NULL,
  "motif"               TEXT,
  "tronconId"           TEXT REFERENCES "troncons"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "abscisseM"           DOUBLE PRECISION,
  "distanceM"           DOUBLE PRECISION,
  "positionTraceLat"    DOUBLE PRECISION,
  "positionTraceLon"    DOUBLE PRECISION,
  "geom"                geometry(Point, 4326),
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "marqueurs_roulage_pkey" PRIMARY KEY ("sessionId", "id"),
  CONSTRAINT "marqueurs_roulage_statut_ck" CHECK ("statut" IN ('RATTACHE', 'NON_RATTACHE')),
  CONSTRAINT "marqueurs_roulage_rattache_ck" CHECK ("statut" <> 'RATTACHE' OR ("tronconId" IS NOT NULL AND "abscisseM" IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS "marqueurs_roulage_tronconId_idx" ON "marqueurs_roulage" ("tronconId");
CREATE INDEX IF NOT EXISTS "marqueurs_roulage_geom_gist" ON "marqueurs_roulage" USING GIST ("geom");

CREATE TABLE IF NOT EXISTS "evenements_roulage" (
  "sessionId"          TEXT NOT NULL REFERENCES "sessions_roulage"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "id"                 TEXT NOT NULL,
  "code"               TEXT NOT NULL,
  "note"               TEXT,
  "statutAppareil"     TEXT NOT NULL,
  "qualification"      JSONB,
  "debutA"             TIMESTAMP(3) NOT NULL,
  "finA"               TIMESTAMP(3),
  "debut"              JSONB NOT NULL,
  "fin"                JSONB,
  "couvertureGnss"     DOUBLE PRECISION,
  "distanceDirecteM"   DOUBLE PRECISION,
  "avertissements"     JSONB NOT NULL,
  "motifAbandon"       TEXT,
  "statutRattachement" TEXT NOT NULL,
  "motif"              TEXT,
  "troncons"           JSONB NOT NULL,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "evenements_roulage_pkey" PRIMARY KEY ("sessionId", "id"),
  CONSTRAINT "evenements_roulage_statutAppareil_ck" CHECK ("statutAppareil" IN ('CLOS', 'CLOS_PAR_ARRET', 'ABANDONNE')),
  CONSTRAINT "evenements_roulage_statutRattachement_ck" CHECK ("statutRattachement" IN ('PORTIONS_CREEES', 'PORTIONS_PARTIELLES', 'PORTIONS_REFUSEES', 'NON_RATTACHE', 'ABANDONNE')),
  CONSTRAINT "evenements_roulage_ordre_ck" CHECK ("finA" IS NULL OR "finA" > "debutA")
);

CREATE TABLE IF NOT EXISTS "evenements_roulage_portions" (
  "sessionId"   TEXT NOT NULL,
  "evenementId" TEXT NOT NULL,
  "rang"        INTEGER NOT NULL,
  "portionId"   TEXT NOT NULL REFERENCES "portions"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "tronconId"   TEXT NOT NULL REFERENCES "troncons"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "debutM"      DOUBLE PRECISION NOT NULL,
  "finM"        DOUBLE PRECISION NOT NULL,
  "sens"        TEXT NOT NULL,
  CONSTRAINT "evenements_roulage_portions_pkey" PRIMARY KEY ("sessionId", "evenementId", "rang"),
  CONSTRAINT "evenements_roulage_portions_evenement_fkey" FOREIGN KEY ("sessionId", "evenementId") REFERENCES "evenements_roulage"("sessionId", "id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "evenements_roulage_portions_bornes_ck" CHECK ("finM" > "debutM" AND "rang" >= 0),
  CONSTRAINT "evenements_roulage_portions_sens_ck" CHECK ("sens" IN ('CROISSANT', 'DECROISSANT'))
);
CREATE INDEX IF NOT EXISTS "evenements_roulage_portions_portionId_idx" ON "evenements_roulage_portions" ("portionId");
CREATE INDEX IF NOT EXISTS "evenements_roulage_portions_tronconId_idx" ON "evenements_roulage_portions" ("tronconId");

COMMENT ON TABLE "sessions_roulage" IS
  'Session de collecte en roulage (7.13) : trace GNSS 1 Hz brute et analyse serveur. Idempotente par clientOperationId. Aucun IRI.';
COMMENT ON TABLE "marqueurs_roulage" IS
  'Marqueur d''evenement ponctuel pose en roulage, rattache a un troncon par la trace. Proposition, pas une observation validee.';
COMMENT ON TABLE "evenements_roulage" IS
  'Evenement lineaire Debut/Fin de la session. Les portions creees sont des propositions A_VALIDER (table evenements_roulage_portions).';

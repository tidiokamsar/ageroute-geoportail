-- AGEROUTE ROAD : socle terrain (mission, appareil, trace, observation, sync).
--
-- POURQUOI
--
-- La collecte terrain existe, mais sous une forme qui ne porte pas le besoin : une
-- Inspection est attachee a UN troncon ou UN ouvrage, sans notion de deplacement ni
-- de campagne. Le terrain reel est une MISSION, au cours de laquelle des observations
-- tombent la ou elles tombent. Mesure du 07/10/2026 : aucun de ces concepts n'existe
-- parmi les 27 modeles.
--
-- CETTE MIGRATION EST PUREMENT ADDITIVE
--
-- Huit tables creees, aucune table existante modifiee, aucune donnee touchee.
-- Verifie avant ecriture : le delta ne contient ni DROP ni ALTER TABLE sur une table
-- de la V1. La V1 continue de fonctionner a l'identique, conformement a la regle du
-- depot qui interdit de la casser.
--
-- LES INDEX GEOMETRIQUES NE VIENNENT PAS DE PRISMA
--
-- Prisma declare les colonnes `geometry(...)` mais ne cree jamais d'index dessus. Sans
-- eux, chaque appariement GPS devient un parcours sequentiel. La forme compte :
-- `GIST (geom)` sert les operateurs && et <-> ; `GIST ((geom::geography))` sert
-- ST_DWithin en metres. Se tromper de forme ne produit pas d'erreur, seulement un
-- Seq Scan — la lecon de l'index de la voirie locale.
--
-- Mesure du 07/10/2026 sur la production : l'appariement d'un point GPS contre le
-- reseau classe indexe prend 19 ms ; contre les 261 387 troncons, 2,5 s. L'index ne
-- suffit donc pas a lui seul, le perimetre doit etre borne a la zone de mission —
-- mais sans index, meme la zone de mission serait lente.
--
-- REVERSIBILITE
--
--   DROP TABLE "conflits_sync", "operations_sync", "medias_observation",
--              "observations", "points_trace", "traces", "missions", "appareils";
--   DROP TYPE "StatutSync", "StatutObservation", "TypeObservation",
--             "StatutMission", "TypeMission";

-- CreateEnum
CREATE TYPE "TypeMission" AS ENUM ('INSPECTION', 'INVENTAIRE', 'SURVEILLANCE', 'CONTROLE_CHANTIER', 'RECEPTION', 'SECURITE', 'URGENCE', 'RELEVE_SIG');

-- CreateEnum
CREATE TYPE "StatutMission" AS ENUM ('BROUILLON', 'PLANIFIEE', 'TELECHARGEE', 'EN_COURS', 'SUSPENDUE', 'TERMINEE', 'SYNC_EN_ATTENTE', 'ANNULEE');

-- CreateEnum
CREATE TYPE "TypeObservation" AS ENUM ('DEGRADATION', 'CHAUSSEE', 'ASSAINISSEMENT', 'SIGNALISATION', 'OUVRAGE', 'SECURITE', 'TRAFIC', 'ENVIRONNEMENT', 'CHANTIER', 'INCIDENT', 'AUTRE');

-- CreateEnum
CREATE TYPE "StatutObservation" AS ENUM ('BROUILLON', 'PROPOSEE', 'VALIDEE', 'REJETEE', 'CONVERTIE');

-- CreateEnum
CREATE TYPE "StatutSync" AS ENUM ('EN_ATTENTE', 'EN_COURS', 'SYNCHRONISE', 'CONFLIT', 'REJETE');

-- CreateTable
CREATE TABLE "appareils" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nom" TEXT,
    "plateforme" TEXT NOT NULL,
    "modele" TEXT,
    "versionOs" TEXT,
    "versionApp" TEXT,
    "dernierVuA" TIMESTAMP(3),
    "revoqueA" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appareils_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "missions" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "intitule" TEXT NOT NULL,
    "type" "TypeMission" NOT NULL,
    "statut" "StatutMission" NOT NULL DEFAULT 'BROUILLON',
    "createurId" TEXT NOT NULL,
    "assigneId" TEXT,
    "appareilId" TEXT,
    "regionId" INTEGER,
    "chantierId" TEXT,
    "vehicule" TEXT,
    "equipe" TEXT,
    "debutPrevu" TIMESTAMP(3),
    "finPrevue" TIMESTAMP(3),
    "debutReel" TIMESTAMP(3),
    "finReelle" TIMESTAMP(3),
    "emprise" geometry(Polygon,4326),
    "itineraire" geometry(LineString,4326),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "missions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "traces" (
    "id" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "appareilId" TEXT,
    "debutA" TIMESTAMP(3) NOT NULL,
    "finA" TIMESTAMP(3),
    "distanceKm" DOUBLE PRECISION,
    "dureeSec" INTEGER,
    "vitesseMoyenne" DOUBLE PRECISION,
    "vitesseMax" DOUBLE PRECISION,
    "geom" geometry(LineString,4326),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "traces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "points_trace" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "horodatage" TIMESTAMP(3) NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,
    "altitude" DOUBLE PRECISION,
    "vitesse" DOUBLE PRECISION,
    "cap" DOUBLE PRECISION,
    "precisionM" DOUBLE PRECISION,
    "satellites" INTEGER,
    "hdop" DOUBLE PRECISION,
    "geom" geometry(Point,4326),

    CONSTRAINT "points_trace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "observations" (
    "id" TEXT NOT NULL,
    "clientOperationId" TEXT NOT NULL,
    "missionId" TEXT,
    "agentId" TEXT NOT NULL,
    "type" "TypeObservation" NOT NULL,
    "statut" "StatutObservation" NOT NULL DEFAULT 'PROPOSEE',
    "gravite" "Gravite",
    "description" TEXT,
    "tronconId" TEXT,
    "ouvrageId" TEXT,
    "chantierId" TEXT,
    "pk" DOUBLE PRECISION,
    "lat" DOUBLE PRECISION,
    "lon" DOUBLE PRECISION,
    "precisionM" DOUBLE PRECISION,
    "geom" geometry(Point,4326),
    "confianceAppariement" DOUBLE PRECISION,
    "observeA" TIMESTAMP(3) NOT NULL,
    "valideeA" TIMESTAMP(3),
    "validateurId" TEXT,
    "motifRejet" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medias_observation" (
    "id" TEXT NOT NULL,
    "observationId" TEXT NOT NULL,
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

    CONSTRAINT "medias_observation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operations_sync" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "appareilId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "baseVersion" INTEGER,
    "statut" "StatutSync" NOT NULL DEFAULT 'EN_ATTENTE',
    "tentatives" INTEGER NOT NULL DEFAULT 0,
    "derniereErreur" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "traiteeA" TIMESTAMP(3),

    CONSTRAINT "operations_sync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conflits_sync" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "payloadLocal" JSONB NOT NULL,
    "payloadServeur" JSONB NOT NULL,
    "resolution" TEXT,
    "resoluParId" TEXT,
    "resoluA" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conflits_sync_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "appareils_userId_idx" ON "appareils"("userId");

-- CreateIndex
CREATE INDEX "appareils_revoqueA_idx" ON "appareils"("revoqueA");

-- CreateIndex
CREATE UNIQUE INDEX "missions_code_key" ON "missions"("code");

-- CreateIndex
CREATE INDEX "missions_statut_idx" ON "missions"("statut");

-- CreateIndex
CREATE INDEX "missions_assigneId_idx" ON "missions"("assigneId");

-- CreateIndex
CREATE INDEX "missions_regionId_idx" ON "missions"("regionId");

-- CreateIndex
CREATE INDEX "missions_deletedAt_idx" ON "missions"("deletedAt");

-- CreateIndex
CREATE INDEX "traces_missionId_idx" ON "traces"("missionId");

-- CreateIndex
CREATE INDEX "traces_userId_idx" ON "traces"("userId");

-- CreateIndex
CREATE INDEX "points_trace_traceId_horodatage_idx" ON "points_trace"("traceId", "horodatage");

-- CreateIndex
CREATE UNIQUE INDEX "observations_clientOperationId_key" ON "observations"("clientOperationId");

-- CreateIndex
CREATE INDEX "observations_missionId_idx" ON "observations"("missionId");

-- CreateIndex
CREATE INDEX "observations_tronconId_idx" ON "observations"("tronconId");

-- CreateIndex
CREATE INDEX "observations_statut_idx" ON "observations"("statut");

-- CreateIndex
CREATE INDEX "observations_deletedAt_idx" ON "observations"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "medias_observation_sha256_key" ON "medias_observation"("sha256");

-- CreateIndex
CREATE INDEX "medias_observation_observationId_idx" ON "medias_observation"("observationId");

-- CreateIndex
CREATE UNIQUE INDEX "operations_sync_operationId_key" ON "operations_sync"("operationId");

-- CreateIndex
CREATE INDEX "operations_sync_appareilId_statut_idx" ON "operations_sync"("appareilId", "statut");

-- CreateIndex
CREATE INDEX "operations_sync_entityType_entityId_idx" ON "operations_sync"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "conflits_sync_entityType_entityId_idx" ON "conflits_sync"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "appareils" ADD CONSTRAINT "appareils_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "missions" ADD CONSTRAINT "missions_createurId_fkey" FOREIGN KEY ("createurId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "missions" ADD CONSTRAINT "missions_assigneId_fkey" FOREIGN KEY ("assigneId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "missions" ADD CONSTRAINT "missions_appareilId_fkey" FOREIGN KEY ("appareilId") REFERENCES "appareils"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "missions" ADD CONSTRAINT "missions_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "regions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "missions" ADD CONSTRAINT "missions_chantierId_fkey" FOREIGN KEY ("chantierId") REFERENCES "chantiers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "traces" ADD CONSTRAINT "traces_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "missions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "traces" ADD CONSTRAINT "traces_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "traces" ADD CONSTRAINT "traces_appareilId_fkey" FOREIGN KEY ("appareilId") REFERENCES "appareils"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "points_trace" ADD CONSTRAINT "points_trace_traceId_fkey" FOREIGN KEY ("traceId") REFERENCES "traces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "observations" ADD CONSTRAINT "observations_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "missions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "observations" ADD CONSTRAINT "observations_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "observations" ADD CONSTRAINT "observations_tronconId_fkey" FOREIGN KEY ("tronconId") REFERENCES "troncons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "observations" ADD CONSTRAINT "observations_ouvrageId_fkey" FOREIGN KEY ("ouvrageId") REFERENCES "ouvrages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "observations" ADD CONSTRAINT "observations_chantierId_fkey" FOREIGN KEY ("chantierId") REFERENCES "chantiers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "observations" ADD CONSTRAINT "observations_validateurId_fkey" FOREIGN KEY ("validateurId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medias_observation" ADD CONSTRAINT "medias_observation_observationId_fkey" FOREIGN KEY ("observationId") REFERENCES "observations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operations_sync" ADD CONSTRAINT "operations_sync_appareilId_fkey" FOREIGN KEY ("appareilId") REFERENCES "appareils"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operations_sync" ADD CONSTRAINT "operations_sync_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Index geometriques, absents de la sortie Prisma ────────────────────────────

-- Appariement d'un point GPS sur le reseau : operateur <-> (plus proche voisin).
CREATE INDEX IF NOT EXISTS "points_trace_geom_idx"  ON "points_trace"  USING GIST ("geom");
CREATE INDEX IF NOT EXISTS "observations_geom_idx"  ON "observations"  USING GIST ("geom");
CREATE INDEX IF NOT EXISTS "traces_geom_idx"        ON "traces"        USING GIST ("geom");

-- Emprise de mission : « quelles missions couvrent ce point » est une intersection.
CREATE INDEX IF NOT EXISTS "missions_emprise_idx"   ON "missions"      USING GIST ("emprise");

-- « Quelles observations a moins de N metres » se pose en METRES, pas en degres :
-- ST_DWithin sur geography n'utilise pas l'index geometry, il lui faut cette forme.
CREATE INDEX IF NOT EXISTS "observations_geog_idx"
  ON "observations" USING GIST (("geom"::geography));

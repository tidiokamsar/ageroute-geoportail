-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "postgis";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'GESTIONNAIRE', 'INSPECTEUR', 'LECTEUR');

-- CreateEnum
CREATE TYPE "ClasseRoute" AS ENUM ('RN', 'RR', 'RU', 'PISTE');

-- CreateEnum
CREATE TYPE "Revetement" AS ENUM ('BITUME', 'TERRE', 'LATERITE', 'PAVE');

-- CreateEnum
CREATE TYPE "EtatPatrimoine" AS ENUM ('BON', 'MOYEN', 'MAUVAIS', 'CRITIQUE', 'NON_EVALUE');

-- CreateEnum
CREATE TYPE "TypeOuvrage" AS ENUM ('PONT', 'DALOT', 'BUSE', 'RADIER', 'PONCEAU', 'MUR_SOUTENEMENT', 'TUNNEL', 'PASSERELLE', 'VIADUC');

-- CreateEnum
CREATE TYPE "Gravite" AS ENUM ('FAIBLE', 'MOYENNE', 'FORTE');

-- CreateEnum
CREATE TYPE "TypePoste" AS ENUM ('PEAGE', 'PESAGE');

-- CreateEnum
CREATE TYPE "StatutPoste" AS ENUM ('EN_SERVICE', 'HORS_SERVICE', 'EN_CONSTRUCTION');

-- CreateEnum
CREATE TYPE "StatutChantier" AS ENUM ('PLANIFIE', 'EN_COURS', 'SUSPENDU', 'TERMINE');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'RESTORE', 'LOGIN', 'LOGIN_FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "nomComplet" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'LECTEUR',
    "actif" BOOLEAN NOT NULL DEFAULT true,
    "derniereConnexion" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regions" (
    "id" SERIAL NOT NULL,
    "nom" TEXT NOT NULL,

    CONSTRAINT "regions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "troncons" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "classe" "ClasseRoute" NOT NULL,
    "regionId" INTEGER NOT NULL,
    "longueurKm" DOUBLE PRECISION NOT NULL,
    "revetement" "Revetement" NOT NULL,
    "etat" "EtatPatrimoine" NOT NULL DEFAULT 'NON_EVALUE',
    "pkDebut" DOUBLE PRECISION NOT NULL,
    "pkFin" DOUBLE PRECISION NOT NULL,
    "traficMoyenJma" INTEGER,
    "geom" geometry(LineString,4326),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "troncons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ouvrages" (
    "id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "type" "TypeOuvrage" NOT NULL,
    "etat" "EtatPatrimoine" NOT NULL DEFAULT 'NON_EVALUE',
    "regionId" INTEGER NOT NULL,
    "tronconId" TEXT,
    "pk" DOUBLE PRECISION,
    "longueurM" DOUBLE PRECISION,
    "gabaritT" DOUBLE PRECISION,
    "anneeConstruction" INTEGER,
    "materiau" TEXT,
    "derniereInspectionDate" TIMESTAMP(3),
    "geom" geometry(Point,4326),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ouvrages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "points_noirs" (
    "id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "regionId" INTEGER NOT NULL,
    "tronconId" TEXT,
    "gravite" "Gravite" NOT NULL,
    "nbAccidents" INTEGER NOT NULL DEFAULT 0,
    "causes" TEXT,
    "mesuresCorrectives" TEXT,
    "geom" geometry(Point,4326),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "points_noirs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "postes" (
    "id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "type" "TypePoste" NOT NULL,
    "regionId" INTEGER NOT NULL,
    "tronconId" TEXT,
    "statut" "StatutPoste" NOT NULL DEFAULT 'EN_SERVICE',
    "recettesMensuellesGnf" BIGINT,
    "traficJma" INTEGER,
    "geom" geometry(Point,4326),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "postes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chantiers" (
    "id" TEXT NOT NULL,
    "intitule" TEXT NOT NULL,
    "entreprise" TEXT NOT NULL,
    "bailleur" TEXT,
    "montantGnf" BIGINT,
    "regionId" INTEGER NOT NULL,
    "tronconId" TEXT,
    "avancementPct" INTEGER NOT NULL DEFAULT 0,
    "statut" "StatutChantier" NOT NULL DEFAULT 'PLANIFIE',
    "dateDebutPrevue" TIMESTAMP(3),
    "dateFinPrevue" TIMESTAMP(3),
    "dateDebutReelle" TIMESTAMP(3),
    "dateFinReelle" TIMESTAMP(3),
    "geom" geometry(LineString,4326),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chantiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inspections" (
    "id" TEXT NOT NULL,
    "tronconId" TEXT,
    "ouvrageId" TEXT,
    "inspecteurId" TEXT NOT NULL,
    "dateInspection" TIMESTAMP(3) NOT NULL,
    "etatObserve" "EtatPatrimoine" NOT NULL,
    "defautsConstates" TEXT,
    "recommandations" TEXT,
    "photos" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" "AuditAction" NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_key" ON "refresh_tokens"("token");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "regions_nom_key" ON "regions"("nom");

-- CreateIndex
CREATE UNIQUE INDEX "troncons_code_key" ON "troncons"("code");

-- CreateIndex
CREATE INDEX "troncons_regionId_idx" ON "troncons"("regionId");

-- CreateIndex
CREATE INDEX "troncons_etat_idx" ON "troncons"("etat");

-- CreateIndex
CREATE INDEX "troncons_deletedAt_idx" ON "troncons"("deletedAt");

-- CreateIndex
CREATE INDEX "ouvrages_regionId_idx" ON "ouvrages"("regionId");

-- CreateIndex
CREATE INDEX "ouvrages_etat_idx" ON "ouvrages"("etat");

-- CreateIndex
CREATE INDEX "ouvrages_deletedAt_idx" ON "ouvrages"("deletedAt");

-- CreateIndex
CREATE INDEX "points_noirs_regionId_idx" ON "points_noirs"("regionId");

-- CreateIndex
CREATE INDEX "points_noirs_deletedAt_idx" ON "points_noirs"("deletedAt");

-- CreateIndex
CREATE INDEX "postes_regionId_idx" ON "postes"("regionId");

-- CreateIndex
CREATE INDEX "postes_deletedAt_idx" ON "postes"("deletedAt");

-- CreateIndex
CREATE INDEX "chantiers_regionId_idx" ON "chantiers"("regionId");

-- CreateIndex
CREATE INDEX "chantiers_deletedAt_idx" ON "chantiers"("deletedAt");

-- CreateIndex
CREATE INDEX "inspections_tronconId_idx" ON "inspections"("tronconId");

-- CreateIndex
CREATE INDEX "inspections_ouvrageId_idx" ON "inspections"("ouvrageId");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_userId_idx" ON "audit_logs"("userId");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "troncons" ADD CONSTRAINT "troncons_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "regions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ouvrages" ADD CONSTRAINT "ouvrages_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "regions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ouvrages" ADD CONSTRAINT "ouvrages_tronconId_fkey" FOREIGN KEY ("tronconId") REFERENCES "troncons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "points_noirs" ADD CONSTRAINT "points_noirs_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "regions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "points_noirs" ADD CONSTRAINT "points_noirs_tronconId_fkey" FOREIGN KEY ("tronconId") REFERENCES "troncons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "postes" ADD CONSTRAINT "postes_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "regions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "postes" ADD CONSTRAINT "postes_tronconId_fkey" FOREIGN KEY ("tronconId") REFERENCES "troncons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chantiers" ADD CONSTRAINT "chantiers_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "regions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chantiers" ADD CONSTRAINT "chantiers_tronconId_fkey" FOREIGN KEY ("tronconId") REFERENCES "troncons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_tronconId_fkey" FOREIGN KEY ("tronconId") REFERENCES "troncons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_ouvrageId_fkey" FOREIGN KEY ("ouvrageId") REFERENCES "ouvrages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_inspecteurId_fkey" FOREIGN KEY ("inspecteurId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


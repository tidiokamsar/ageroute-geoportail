-- P3-A : securite des refresh tokens — hash au repos, familles, revocation fine.
--
-- Avant : le JWT brut etait la cle de recherche (token TEXT UNIQUE en clair),
-- un booléen revoked, aucune famille, aucune detection de reutilisation.
-- Apres : tokenHash SHA-256 (cle de recherche), familyId (racine issuee au
-- login), revokedAt (date), replacedById (chaine de rotation),
-- reuseDetectedAt (preuve de rejeu).
--
-- SESSIONS EXISTANTES : leur empreinte est calculee depuis la colonne claire
-- AVANT sa suppression — un utilisateur connecte garde sa session. La date de
-- revocation des tokens deja revoques est approximee a l'instant de la
-- migration (le booleen n'en conservait pas) : documente dans le rapport P3-A.
--
-- ROLLBACK (documente, teste) : la colonne claire ne peut pas etre reconstituee
-- depuis les empreintes — un rollback invalide toutes les sessions refresh et
-- force une reconnexion generale. Coût assume d'une migration de securite.

ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "tokenHash" TEXT;
ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "familyId" TEXT;
ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "revokedAt" TIMESTAMP(3);
ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "replacedById" TEXT;
ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "reuseDetectedAt" TIMESTAMP(3);

-- Empreinte des tokens existants : les sessions en cours survivent.
UPDATE "refresh_tokens"
   SET "tokenHash" = encode(sha256("token"::bytea), 'hex')
 WHERE "token" IS NOT NULL;

-- Chaque token existant fonde sa propre famille (racine = lui-meme).
UPDATE "refresh_tokens" SET "familyId" = "id" WHERE "familyId" IS NULL;

-- Mapping du booleen revoked vers une date (approximation documentee).
UPDATE "refresh_tokens" SET "revokedAt" = now() WHERE "revoked" = true AND "revokedAt" IS NULL;

ALTER TABLE "refresh_tokens" ALTER COLUMN "tokenHash" SET NOT NULL;
ALTER TABLE "refresh_tokens" ALTER COLUMN "familyId" SET NOT NULL;

-- Unicite des empreintes (remplace l'ancienne unicite des tokens bruts).
DROP INDEX IF EXISTS "refresh_tokens_token_key";
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");
CREATE INDEX IF NOT EXISTS "refresh_tokens_familyId_idx" ON "refresh_tokens"("familyId");

-- Le token brut quitte la base.
ALTER TABLE "refresh_tokens" DROP COLUMN IF EXISTS "token";
ALTER TABLE "refresh_tokens" DROP COLUMN IF EXISTS "revoked";

-- Journalisation des evenements de securite (reutilisation de token, etc.).
-- PG >= 12 : ADD VALUE est autorise dans une transaction tant que la valeur
-- n'y est pas utilisee ensuite — ce qui est le cas ici.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SECURITY_EVENT';

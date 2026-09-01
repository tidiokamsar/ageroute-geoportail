-- 2FA (TOTP) + verrouillage de compte après échecs de connexion répétés
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "totpSecret"          TEXT,
  ADD COLUMN IF NOT EXISTS "totpEnabled"         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lockedUntil"         TIMESTAMP(3);

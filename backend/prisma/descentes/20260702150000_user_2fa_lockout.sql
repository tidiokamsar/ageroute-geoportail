-- RETOUR ARRIERE de `20260702150000_user_2fa_lockout`.
--
-- Ajoute a users le secret TOTP, l'indicateur 2FA, le compteur d'echecs de connexion et la date de verrouillage.
--
-- CE QUI EST PERDU : l'inscription A LA DOUBLE AUTHENTIFICATION des comptes : ils reviendraient a un seul facteur, sans que personne ne soit prevenu.
--
-- GARDE : la descente REFUSE de s'executer si des donnees seraient detruites. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20260702150000_user_2fa_lockout.sql
--
-- GARDE-TEST: INSERT INTO "users" ("id","email","nomComplet","passwordHash","updatedAt","totpEnabled") VALUES ('g1','g1@x.invalid','x','x',now(),true);
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique. Garde eprouvee avec une donnee fabriquee.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "users" WHERE "totpEnabled" OR "totpSecret" IS NOT NULL OR "failedLoginAttempts" > 0 OR "lockedUntil" IS NOT NULL) INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % compte(s) portent une inscription 2FA, des echecs ou un verrouillage. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

ALTER TABLE "users"
  DROP COLUMN IF EXISTS "totpSecret",
  DROP COLUMN IF EXISTS "totpEnabled",
  DROP COLUMN IF EXISTS "failedLoginAttempts",
  DROP COLUMN IF EXISTS "lockedUntil";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260702150000_user_2fa_lockout';

-- S-4 : retirer SUPERUSER et CREATEROLE au role applicatif (SECURITY_REMEDIATION.md § S-4).
--
-- A EXECUTER CONNECTE AVEC LE ROLE DE SECOURS, jamais avec le role reduit : un role ne se rend pas
-- un privilege qu'il vient de perdre. Le script REFUSE s'il est lance autrement, ou s'il n'existe
-- aucun autre role SUPERUSER capable de se connecter (le retour arriere serait alors impossible).
--
--   psql -v ON_ERROR_STOP=1 -v app_role=bdri_app -U <role_de_secours> -d <base> -f s4-reduire-bdri-app.sql
--
-- CREATEDB est garde : le banc des migrations clone des bases. Le role reste PROPRIETAIRE de ses
-- objets : migrations (DDL), index, fonctions et declencheurs continuent de passer. Retour arriere :
-- s4-retour-bdri-app.sql, avec le meme role de secours.
--
-- Eprouve sur une base jetable par s4-epreuve.sh, jamais sur la production sans autorisation.

\if :{?app_role}
\else
  \set app_role bdri_app
\endif

SELECT set_config('s4.app_role', :'app_role', false);

DO $s4$
DECLARE
  app text := current_setting('s4.app_role');
  secours integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app) THEN
    RAISE EXCEPTION 'S-4 REFUSE : le role % n''existe pas', app;
  END IF;
  IF current_user = app THEN
    RAISE EXCEPTION 'S-4 REFUSE : connecte en tant que % ; se connecter avec le role de secours', app;
  END IF;
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'S-4 REFUSE : % n''est pas SUPERUSER, il ne pourrait pas rendre le privilege', current_user;
  END IF;
  SELECT count(*) INTO secours FROM pg_roles WHERE rolsuper AND rolcanlogin AND rolname <> app;
  IF secours = 0 THEN
    RAISE EXCEPTION 'S-4 REFUSE : aucun autre role SUPERUSER ne peut se connecter : le retour serait impossible';
  END IF;
  EXECUTE format('ALTER ROLE %I NOSUPERUSER NOCREATEROLE', app);
  RAISE NOTICE 'S-4 : % reduit (NOSUPERUSER NOCREATEROLE, CREATEDB garde) ; % role(s) de secours SUPERUSER', app, secours;
END
$s4$;

SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin FROM pg_roles WHERE rolname = :'app_role';

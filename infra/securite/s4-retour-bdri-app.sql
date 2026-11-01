-- S-4, RETOUR ARRIERE : rendre SUPERUSER et CREATEROLE au role applicatif.
--
-- A executer avec le role de secours (seul un SUPERUSER peut accorder SUPERUSER) :
--
--   psql -v ON_ERROR_STOP=1 -v app_role=bdri_app -U <role_de_secours> -d <base> -f s4-retour-bdri-app.sql

\if :{?app_role}
\else
  \set app_role bdri_app
\endif

SELECT set_config('s4.app_role', :'app_role', false);

DO $s4$
DECLARE app text := current_setting('s4.app_role');
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'S-4 RETOUR REFUSE : % n''est pas SUPERUSER', current_user;
  END IF;
  EXECUTE format('ALTER ROLE %I SUPERUSER CREATEROLE', app);
  RAISE NOTICE 'S-4 RETOUR : % de nouveau SUPERUSER CREATEROLE', app;
END
$s4$;

SELECT rolname, rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = :'app_role';

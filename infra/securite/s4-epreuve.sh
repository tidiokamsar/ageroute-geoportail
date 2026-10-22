#!/usr/bin/env bash
#
# EPREUVE de S-4 sur une base JETABLE : prouve, avant tout geste en production, que le role
# applicatif reduit (NOSUPERUSER NOCREATEROLE) fait encore tout ce que l'application et les
# migrations demandent, ne peut plus administrer l'instance, et que le retour arriere rend l'etat
# d'avant.
#
# Tout se passe dans le conteneur de developpement : roles s4_app (le « bdri_app » d'epreuve) et
# s4_secours, bases s4_epreuve (schema complet de la base de rejeu, objets possedes par s4_app) et
# s4_extension. Rien n'est garde : roles et bases sont supprimes a la sortie, quoi qu'il arrive.
# Aucune donnee de production, aucun mot de passe (socket local du conteneur).
#
#   MSYS_NO_PATHCONV=1 bash infra/securite/s4-epreuve.sh [conteneur] [base_de_reference]

set -euo pipefail
CONTENEUR="${1:-bdri-dev-db}"
REFERENCE="${2:-replay}"
ICI="$(cd "$(dirname "$0")" && pwd)"
ECHECS=0

admin() { docker exec -i "$CONTENEUR" psql -X -q -U bdri_dev -d "${1:-postgres}" -v ON_ERROR_STOP=1; }
en() { local role="$1" base="$2"; shift 2; docker exec -i "$CONTENEUR" psql -X -q -U "$role" -d "$base" -v ON_ERROR_STOP=1 "$@"; }
ok() { echo "  ok     $*"; }
ko() { echo "  ECHEC  $*"; ECHECS=$((ECHECS + 1)); }

nettoyer() {
  admin <<'SQL' >/dev/null 2>&1 || true
DROP DATABASE IF EXISTS s4_epreuve;
DROP DATABASE IF EXISTS s4_extension;
DROP ROLE IF EXISTS s4_app;
DROP ROLE IF EXISTS s4_secours;
SQL
}
trap nettoyer EXIT
nettoyer

echo "S-4 : epreuve sur base jetable ($CONTENEUR, schema de $REFERENCE)"
admin <<'SQL'
CREATE ROLE s4_app SUPERUSER CREATEDB CREATEROLE LOGIN;
CREATE ROLE s4_secours SUPERUSER LOGIN;
CREATE DATABASE s4_epreuve OWNER s4_app;
CREATE DATABASE s4_extension OWNER s4_app;
SQL
# Schema complet, cree PAR s4_app : il en possede tout, comme bdri_app en production.
docker exec "$CONTENEUR" pg_dump -U bdri_dev -s -O -x "$REFERENCE" | en s4_app s4_epreuve >/dev/null
ok "schema de $REFERENCE reconstruit, objets possedes par s4_app"

# 1. Le script refuse d'etre lance par le role qu'il reduit.
SORTIE="$(en s4_app s4_epreuve -v app_role=s4_app < "$ICI/s4-reduire-bdri-app.sql" 2>&1 || true)"
case "$SORTIE" in *"connecte en tant que s4_app"*) ok "reduction lancee par le role lui-meme REFUSEE (motif : connecte en tant que s4_app)";; *) ko "reduction par le role lui-meme : refus attendu, obtenu : $SORTIE";; esac

# 2. Reduction par le role de secours.
en s4_secours s4_epreuve -v app_role=s4_app < "$ICI/s4-reduire-bdri-app.sql" >/dev/null
ETAT="$(docker exec "$CONTENEUR" psql -X -At -U bdri_dev -d postgres -c "SELECT rolsuper || '/' || rolcreaterole || '/' || rolcreatedb FROM pg_roles WHERE rolname = 's4_app'")"
[ "$ETAT" = "false/false/true" ] && ok "s4_app reduit : NOSUPERUSER NOCREATEROLE, CREATEDB garde" || ko "etat inattendu de s4_app : $ETAT"

# 3. Ce que l'application et les migrations font encore (transaction annulee).
if en s4_app s4_epreuve <<'SQL' >/dev/null 2>&1
BEGIN;
INSERT INTO regions (nom) VALUES ('Region epreuve S-4');
SELECT count(*) FROM troncons;
CREATE TABLE s4_table (id integer PRIMARY KEY, geom geometry(Point, 4326));
CREATE INDEX s4_table_gist ON s4_table USING gist (geom);
ALTER TABLE troncons ADD COLUMN s4_colonne integer;
CREATE OR REPLACE FUNCTION s4_fonction() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END $f$;
CREATE TRIGGER s4_declencheur BEFORE INSERT ON s4_table FOR EACH ROW EXECUTE FUNCTION s4_fonction();
CREATE OR REPLACE VIEW s4_vue AS SELECT id FROM s4_table;
SELECT ST_Area(ST_Transform(ST_MakeEnvelope(-13.7, 9.5, -13.6, 9.6, 4326), 32628));
ROLLBACK;
SQL
then ok "DML, DDL (table, index GiST, colonne, fonction, declencheur, vue), PostGIS : permis"; else ko "une operation applicative ou de migration est refusee au role reduit"; fi

# 4. btree_gist (installee par une migration) : extension « trusted », installable sans SUPERUSER.
if en s4_app s4_extension <<< "CREATE EXTENSION btree_gist;" >/dev/null 2>&1; then ok "CREATE EXTENSION btree_gist (trusted) : permis"; else ko "btree_gist refusee au role reduit"; fi
# PostGIS n'est pas « trusted » : une future migration qui installerait une extension non trusted
# passerait par le role de secours. Constat, pas un echec.
if en s4_app s4_extension <<< "CREATE EXTENSION postgis;" >/dev/null 2>&1; then echo "  info   CREATE EXTENSION postgis permis"; else echo "  info   CREATE EXTENSION postgis REFUSE au role reduit (non trusted) : une telle migration passe par le role de secours"; fi

# 5. Ce qu'il ne peut plus faire.
refuse() { if en s4_app s4_epreuve <<< "$2" >/dev/null 2>&1; then ko "$1 encore permis"; else ok "$1 REFUSE"; fi; }
refuse "CREATE ROLE" "CREATE ROLE s4_intrus LOGIN;"
refuse "ALTER SYSTEM" "ALTER SYSTEM SET work_mem = '8MB';"
refuse "COPY ... TO PROGRAM" "COPY (SELECT 1) TO PROGRAM 'true';"
refuse "pg_read_file" "SELECT pg_read_file('/etc/passwd');"
refuse "lecture de pg_authid" "SELECT rolpassword FROM pg_authid;"
refuse "ALTER ROLE ... SUPERUSER sur lui-meme" "ALTER ROLE s4_app SUPERUSER;"

# 6. Retour arriere par le role de secours.
en s4_secours s4_epreuve -v app_role=s4_app < "$ICI/s4-retour-bdri-app.sql" >/dev/null
ETAT="$(docker exec "$CONTENEUR" psql -X -At -U bdri_dev -d postgres -c "SELECT rolsuper || '/' || rolcreaterole || '/' || rolcreatedb FROM pg_roles WHERE rolname = 's4_app'")"
[ "$ETAT" = "true/true/true" ] && ok "retour arriere : s4_app de nouveau SUPERUSER CREATEROLE" || ko "retour arriere incomplet : $ETAT"

echo
if [ "$ECHECS" -eq 0 ]; then echo "Bilan S-4 : epreuve reussie, 0 echec"; else echo "Bilan S-4 : $ECHECS echec(s)"; exit 1; fi

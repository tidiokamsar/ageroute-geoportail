#!/usr/bin/env bash
#
# Preuve de restauration REPRODUCTIBLE, sur le poste local uniquement.
#
# Une sauvegarde jamais restauree n'est pas une sauvegarde. `infra/backup/verifier-restauration-bdri.sh`
# le dit pour le serveur ; celui-ci le prouve sur un poste de developpement, SANS serveur, sans cle de
# production et sans acces au reseau, avec une comparaison de CONTENU et pas seulement de comptes :
#
#   1. source      : une base jetable `essai_source_restauration`, clone de `replay` (schema complet
#                    des migrations) remplie d'un jeu SYNTHETIQUE deterministe qui contient des
#                    geometries PostGIS (lignes, points, multipolygones, valeurs nulles), des accents
#                    et des enumerations ;
#   2. sauvegarde  : pg_dump -Fc --no-owner --no-acl, memes options que `sauvegarde-bdri.sh` ;
#   3. chiffrement : aller-retour AES-256-CBC pbkdf2 200000, memes options que la production, avec une
#                    cle TEMPORAIRE tiree au hasard (jamais la cle de production), puis empreinte
#                    SHA-256 du dump avant chiffrement et apres dechiffrement ;
#   4. restauration: pg_restore dans `essai_restauration`, creee depuis template0, donc l'extension
#                    PostGIS est recreee PAR le dump (comme sur un serveur neuf) ;
#   5. comparaison : (a) schema complet identique (descentes/instantane-schema.sql : colonnes, types,
#                    contraintes, index, declencheurs, fonctions) ; (b) pour CHAQUE table : nombre de
#                    lignes et somme de controle MD5 de toutes les lignes (geometrie en EWKB incluse) ;
#                    (c) pour CHAQUE colonne geometry : lignes renseignees, SRID, validite, nombre de
#                    sommets, etendue, somme de controle des octets EWKB ; (d) sequences ; (e) contraintes
#                    validees et declencheurs actifs ; (f) index GiST utilisable : le meme nombre de
#                    resultats avec et sans l'index.
#
# TOUT EST LOCAL : le conteneur doit s'appeler `bdri-dev-db` (ou CONTENEUR=...) et publier son port sur
# 127.0.0.1 seulement ; les bases manipulees sont `essai_source_restauration` et `essai_restauration`,
# jamais une autre. Rien n'est lu ni ecrit sur un serveur. Les deux bases et tous les fichiers
# temporaires (dump, version chiffree, cle) sont supprimes a la sortie, quoi qu'il arrive, sauf --garder.
#
# POURQUOI BASH ET PAS POWERSHELL. Le reste de `infra/` est en bash, ce script reprend les memes
# commandes que la sauvegarde de production (pg_dump, openssl, pg_restore) et doit pouvoir etre lance
# sur le serveur ou sur n'importe quel poste avec Git Bash, WSL ou Linux. Un .ps1 ne tournerait que sous
# Windows.
#
# CE QUE CE SCRIPT NE PROUVE PAS : que les sauvegardes de PRODUCTION existent, sont chiffrees avec la bonne
# cle, ou se restaurent ; ni la duree d'une restauration de 261 000 troncons. Voir
# docs/securite/SAUVEGARDE-RESTAURATION.md (liste des verifications reservees a la DSI).
#
# Usage : bash infra/verifier-restauration.sh [--garder] [--contre-epreuve] [--lignes N]
#   --contre-epreuve  altere VOLONTAIREMENT la base restauree (une geometrie decalee, une ligne
#                     supprimee) et exige que la comparaison le DETECTE : le code de sortie est 0 si
#                     et seulement si la comparaison a vu les deux alterations.
#   --lignes N        nombre de troncons synthetiques (defaut 2000)
# Sorties : 0 restauration identique (ou contre-epreuve reussie), 1 difference, 2 erreur technique,
#           3 cible refusee.

set -euo pipefail

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTANTANE="$RACINE/backend/prisma/descentes/instantane-schema.sql"
CONTENEUR="${CONTENEUR:-bdri-dev-db}"
PGUSER_LOCAL="${PGUSER_LOCAL:-bdri_dev}"
SOURCE="essai_source_restauration"
CIBLE="essai_restauration"
GARDER=0
CONTRE_EPREUVE=0
LIGNES=2000

while [ $# -gt 0 ]; do
  case "$1" in
    --garder) GARDER=1; shift ;;
    --contre-epreuve) CONTRE_EPREUVE=1; shift ;;
    --lignes) LIGNES="${2:?--lignes attend un nombre}"; shift 2 ;;
    *) echo "option inconnue : $1" >&2; exit 2 ;;
  esac
done
[[ "$LIGNES" =~ ^[0-9]+$ ]] && [ "$LIGNES" -ge 10 ] || { echo "--lignes : entier >= 10 attendu" >&2; exit 2; }

rouge() { printf '\033[31m%s\033[0m\n' "$*"; }
vert()  { printf '\033[32m%s\033[0m\n' "$*"; }
etape() { printf '\n== %s ==\n' "$*"; }
arret() { rouge "ARRET : $*"; exit "${2:-2}"; }

# ---------------------------------------------------------------------------------------------
etape "0. Garde : poste local uniquement"
[[ "$CONTENEUR" =~ ^[A-Za-z0-9_.-]+$ ]] || arret "nom de conteneur illisible" 3
command -v docker >/dev/null || arret "docker introuvable" 2
[ "$(docker inspect -f '{{.State.Running}}' "$CONTENEUR" 2>/dev/null || true)" = "true" ] || arret "le conteneur $CONTENEUR ne tourne pas" 2
PORTS="$(docker port "$CONTENEUR" 5432/tcp 2>/dev/null || true)"
[ -n "$PORTS" ] || arret "le conteneur $CONTENEUR ne publie pas 5432 : cible non reconnue comme base locale de developpement" 3
# Toute adresse publiee autre que la boucle locale est un refus : une base joignable du reseau n'est pas un poste de test.
if printf '%s\n' "$PORTS" | grep -vE '^(127\.0\.0\.1|\[::1\]):[0-9]+$' | grep -q .; then
  arret "le conteneur $CONTENEUR publie son port ailleurs que sur 127.0.0.1 ($PORTS)" 3
fi
[ -r "$INSTANTANE" ] || arret "instantane de schema introuvable : $INSTANTANE" 2
for b in "$SOURCE" "$CIBLE"; do [[ "$b" =~ ^essai_[a-z0-9_]+$ ]] || arret "base $b refusee" 3; done
vert "conteneur $CONTENEUR, port publie sur la boucle locale seulement"

# $1 : base ; les arguments suivants (ex. -v n=2000) sont passes a psql.
psql_db() { local base="$1"; shift; docker exec -i "$CONTENEUR" psql -U "$PGUSER_LOCAL" -X -At -v ON_ERROR_STOP=1 -d "$base" "$@"; }

TRAV="$(mktemp -d)"
chmod 700 "$TRAV"
nettoyer() {
  local code=$?
  if [ "$GARDER" -eq 0 ]; then
    for b in "$CIBLE" "$SOURCE"; do
      docker exec "$CONTENEUR" psql -U "$PGUSER_LOCAL" -X -d postgres -c "DROP DATABASE IF EXISTS $b WITH (FORCE)" >/dev/null 2>&1 || true
    done
    # La cle temporaire est ecrasee avant suppression ; le reste est supprime.
    [ -f "$TRAV/cle" ] && { shred -u "$TRAV/cle" 2>/dev/null || rm -f "$TRAV/cle"; }
    rm -rf "$TRAV"
  else
    echo "Conserve (--garder) : bases $SOURCE et $CIBLE, fichiers dans $TRAV"
  fi
  exit "$code"
}
trap nettoyer EXIT

# Sous Git Bash, openssl est un programme Windows natif : il ne comprend pas les chemins /tmp ou /c/... du
# shell. cygpath les convertit ; sur Linux il n'existe pas et le chemin est laisse tel quel.
natif() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

horloge() { date +%s.%N; }
duree() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.1f s", b - a }'; }

# ---------------------------------------------------------------------------------------------
etape "1. Base source synthetique ($LIGNES troncons)"
docker exec "$CONTENEUR" psql -U "$PGUSER_LOCAL" -X -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $SOURCE WITH (FORCE)" -c "DROP DATABASE IF EXISTS $CIBLE WITH (FORCE)" >/dev/null
docker exec "$CONTENEUR" psql -U "$PGUSER_LOCAL" -X -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $SOURCE TEMPLATE replay" >/dev/null \
  || arret "clone de replay impossible (la base replay existe-t-elle, sans session ouverte ?)"

psql_db "$SOURCE" -v n="$LIGNES" >/dev/null <<'SQL'
-- Jeu SYNTHETIQUE et deterministe : aucune donnee reelle, aucun secret (le hachage de mot de passe est une
-- chaine factice qui n'est le hachage de rien).
INSERT INTO regions ("nom")
SELECT 'Région d''essai ' || g FROM generate_series(1, 8) g;

INSERT INTO users ("id", "email", "nomComplet", "passwordHash", "updatedAt")
SELECT 'u' || g, 'essai' || g || '@exemple.invalid', 'Utilisateur d''essai éàç ' || g, 'FACTICE-NON-UN-HACHAGE', timestamp '2026-01-01 00:00:00'
FROM generate_series(1, 3) g;

INSERT INTO troncons ("id", "code", "nom", "classe", "regionId", "longueurKm", "revetement", "pkDebut", "pkFin", "geom", "updatedAt")
SELECT 't' || g,
       'ESSAI-' || lpad(g::text, 6, '0'),
       'Tronçon d''essai « ' || g || ' » - Kankan/Kindia',
       (ARRAY['RN','RR','RU','PISTE'])[1 + g % 4]::"ClasseRoute",
       (SELECT min(id) FROM regions) + g % 8,
       round((1 + (g % 97) / 3.0)::numeric, 3)::float8,
       'BITUME',
       g % 500, g % 500 + 1.5,
       -- une geometrie sur vingt est NULL : un NULL doit rester un NULL, pas devenir une geometrie vide
       CASE WHEN g % 20 = 0 THEN NULL ELSE
         ST_SetSRID(ST_MakeLine(ARRAY[
           ST_MakePoint(-13.7 + (g % 100) * 0.011,     9.5 + (g / 100) * 0.0107),
           ST_MakePoint(-13.7 + (g % 100) * 0.011 + 0.004 * sin(g), 9.5 + (g / 100) * 0.0107 + 0.003),
           ST_MakePoint(-13.7 + (g % 100) * 0.011 + 0.009, 9.5 + (g / 100) * 0.0107 + 0.002 * cos(g))
         ]), 4326) END,
       timestamp '2026-01-01 00:00:00'
FROM generate_series(1, :n) g;

INSERT INTO ouvrages ("id", "nom", "type", "regionId", "tronconId", "geom", "geomLigne", "updatedAt")
SELECT 'o' || g, 'Ouvrage d''essai ' || g,
       (ARRAY['PONT','DALOT','BUSE','RADIER'])[1 + g % 4]::"TypeOuvrage",
       (SELECT min(id) FROM regions) + g % 8,
       't' || (1 + g % :n),
       ST_SetSRID(ST_MakePoint(-13.7 + (g % 100) * 0.011, 9.5 + (g / 100) * 0.0107), 4326),
       CASE WHEN g % 3 = 0 THEN ST_SetSRID(ST_MakeLine(ST_MakePoint(-13.7 + (g % 100) * 0.011, 9.5), ST_MakePoint(-13.699 + (g % 100) * 0.011, 9.5005)), 4326) END,
       timestamp '2026-01-01 00:00:00'
FROM generate_series(1, GREATEST(:n / 5, 5)) g;

INSERT INTO chantiers ("id", "intitule", "entreprise", "regionId", "geom", "updatedAt")
SELECT 'c' || g, 'Réhabilitation d''essai ' || g, 'Entreprise Ñandú & Fils ' || g,
       (SELECT min(id) FROM regions) + g % 8,
       ST_SetSRID(ST_MakeLine(ST_MakePoint(-12.1 + (g % 30) * 0.02, 10.2 + (g / 30) * 0.02), ST_MakePoint(-12.09 + (g % 30) * 0.02, 10.21 + (g / 30) * 0.02)), 4326),
       timestamp '2026-01-01 00:00:00'
FROM generate_series(1, GREATEST(:n / 20, 5)) g;

INSERT INTO limites_admin ("pcode", "niveau", "nom", "source", "geom")
SELECT 'GN' || lpad(g::text, 4, '0'), 1, 'Limite d''essai ' || g, 'SYNTHETIQUE',
       ST_Multi(ST_SetSRID(ST_MakeEnvelope(-14 + g * 0.5, 9 + g * 0.2, -13.6 + g * 0.5, 9.3 + g * 0.2), 4326))
FROM generate_series(1, 10) g;

INSERT INTO audit_logs ("id", "action", "entityType")
SELECT 'a' || g, (SELECT enumlabel::"AuditAction" FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'AuditAction' ORDER BY enumsortorder LIMIT 1), 'Troncon'
FROM generate_series(1, 300) g;
SQL
RESUME_SOURCE="$(psql_db "$SOURCE" <<'SQL'
SELECT (SELECT count(*) FROM troncons) || ' troncons (' || (SELECT count(geom) FROM troncons) || ' avec geometrie), '
    || (SELECT count(*) FROM ouvrages) || ' ouvrages, ' || (SELECT count(*) FROM chantiers) || ' chantiers, '
    || (SELECT count(*) FROM limites_admin) || ' limites, ' || (SELECT count(*) FROM audit_logs) || ' audits';
SQL
)"
vert "source remplie : $RESUME_SOURCE"

# ---------------------------------------------------------------------------------------------
etape "2. Sauvegarde (pg_dump -Fc --no-owner --no-acl)"
T0="$(horloge)"
docker exec "$CONTENEUR" pg_dump -U "$PGUSER_LOCAL" -d "$SOURCE" -Fc --no-owner --no-acl > "$TRAV/essai.dump" \
  || arret "pg_dump a echoue"
T1="$(horloge)"
docker exec -i "$CONTENEUR" pg_restore --list < "$TRAV/essai.dump" > "$TRAV/sommaire.txt" || arret "l'archive est illisible"
ENTREES="$(grep -c '^[0-9]' "$TRAV/sommaire.txt" || true)"
TAILLE="$(wc -c < "$TRAV/essai.dump" | tr -d ' ')"
[ "$TAILLE" -gt 10000 ] || arret "archive anormalement petite ($TAILLE octets)"
vert "archive de $TAILLE octets, $ENTREES entrees lisibles par pg_restore, produite en $(duree "$T0" "$T1")"

# ---------------------------------------------------------------------------------------------
etape "3. Chiffrement : aller-retour avec une cle TEMPORAIRE"
openssl rand -hex 32 > "$TRAV/cle"
chmod 600 "$TRAV/cle"
SHA_AVANT="$(sha256sum "$TRAV/essai.dump" | cut -d' ' -f1)"
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -in "$(natif "$TRAV/essai.dump")" -out "$(natif "$TRAV/essai.dump.enc")" -pass "file:$(natif "$TRAV/cle")" || arret "chiffrement impossible"
[ "$(sha256sum "$TRAV/essai.dump.enc" | cut -d' ' -f1)" != "$SHA_AVANT" ] || arret "le fichier chiffre est identique au clair"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$(natif "$TRAV/essai.dump.enc")" -out "$(natif "$TRAV/restaure.dump")" -pass "file:$(natif "$TRAV/cle")" || arret "dechiffrement impossible"
SHA_APRES="$(sha256sum "$TRAV/restaure.dump" | cut -d' ' -f1)"
[ "$SHA_AVANT" = "$SHA_APRES" ] || arret "le dump dechiffre differe du dump d'origine ($SHA_AVANT / $SHA_APRES)" 1
vert "dump identique avant chiffrement et apres dechiffrement (SHA-256 ${SHA_AVANT:0:16}...)"
# Contre-epreuve du chiffrement : une mauvaise cle doit etre refusee, pas rendre un dump corrompu.
openssl rand -hex 32 > "$TRAV/mauvaise-cle"
if openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$(natif "$TRAV/essai.dump.enc")" -out "$(natif "$TRAV/faux.dump")" -pass "file:$(natif "$TRAV/mauvaise-cle")" 2>/dev/null \
   && [ "$(sha256sum "$TRAV/faux.dump" | cut -d' ' -f1)" = "$SHA_AVANT" ]; then
  arret "une mauvaise cle a rendu le dump d'origine : chiffrement sans effet" 1
fi
rm -f "$TRAV/mauvaise-cle" "$TRAV/faux.dump"
vert "une mauvaise cle ne redonne pas le dump"

# ---------------------------------------------------------------------------------------------
etape "4. Restauration dans $CIBLE (creee depuis template0 : PostGIS recree par le dump)"
docker exec "$CONTENEUR" psql -U "$PGUSER_LOCAL" -X -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $CIBLE TEMPLATE template0" >/dev/null || arret "creation de $CIBLE impossible"
T2="$(horloge)"
docker exec -i "$CONTENEUR" pg_restore -U "$PGUSER_LOCAL" -d "$CIBLE" --no-owner --no-acl --exit-on-error < "$TRAV/restaure.dump" 2> "$TRAV/restauration.err" \
  || { sed -n '1,15p' "$TRAV/restauration.err"; arret "pg_restore a echoue (voir ci-dessus)"; }
T3="$(horloge)"
[ ! -s "$TRAV/restauration.err" ] || { echo "messages de pg_restore :"; sed -n '1,10p' "$TRAV/restauration.err"; }
vert "restauration terminee en $(duree "$T2" "$T3"), sans erreur (--exit-on-error)"

if [ "$CONTRE_EPREUVE" -eq 1 ]; then
  etape "4b. CONTRE-EPREUVE : alteration volontaire de la base restauree"
  psql_db "$CIBLE" >/dev/null <<'SQL'
UPDATE troncons SET geom = ST_Translate(geom, 0.000001, 0) WHERE id = 't7';
DELETE FROM ouvrages WHERE id = 'o5';
SQL
  echo "t7 : geometrie decalee de 0,000001 degre ; o5 : ligne supprimee"
fi

# ---------------------------------------------------------------------------------------------
etape "5. Comparaison source / restauration"

# 5a. empreintes, une ligne par objet, pour chaque base.
empreintes() {
  psql_db "$1" <<'SQL'
-- (b) chaque table : lignes et somme de controle de TOUTES les lignes (ordre sur le texte de la ligne)
SELECT format($f$SELECT 'table|' || %L || '|' || count(*) || '|' || md5(coalesce(string_agg(x::text, E'\n' ORDER BY x::text), '')) FROM public.%I x$f$, c.relname, c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
   AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
 ORDER BY c.relname
\gexec

-- (c) chaque colonne geometry
SELECT format($f$SELECT 'geom|' || %L || '.' || %L || '|renseignees=' || count(%I) || '|srid=' || coalesce(string_agg(DISTINCT ST_SRID(%I)::text, ','), '-')
                   || '|invalides=' || count(*) FILTER (WHERE %I IS NOT NULL AND NOT ST_IsValid(%I))
                   || '|sommets=' || coalesce(sum(ST_NPoints(%I)), 0)
                   || '|etendue=' || coalesce(ST_AsText(ST_Extent(%I)::geometry), '-')
                   || '|ewkb=' || md5(coalesce(string_agg(encode(ST_AsEWKB(%I), 'hex'), ',' ORDER BY encode(ST_AsEWKB(%I), 'hex')), ''))
                FROM public.%I$f$,
              f_table_name, f_geometry_column, f_geometry_column, f_geometry_column, f_geometry_column, f_geometry_column,
              f_geometry_column, f_geometry_column, f_geometry_column, f_geometry_column, f_table_name)
  FROM geometry_columns
 WHERE f_table_schema = 'public' AND f_table_name NOT IN ('spatial_ref_sys')
 ORDER BY f_table_name, f_geometry_column
\gexec

-- (d) sequences
SELECT 'sequence|' || sequencename || '|' || coalesce(last_value::text, 'jamais') FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename;

-- (e) contraintes validees, declencheurs actifs
SELECT 'contraintes_non_validees|' || count(*) FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace WHERE n.nspname = 'public' AND NOT k.convalidated;
SELECT 'declencheurs|' || tgenabled::text || '|' || count(*) FROM pg_trigger g JOIN pg_class t ON t.oid = g.tgrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = 'public' AND NOT g.tgisinternal GROUP BY tgenabled ORDER BY tgenabled;
SQL
}

empreintes "$SOURCE" > "$TRAV/empreintes-source.txt" || arret "empreintes de la source impossibles"
empreintes "$CIBLE"  > "$TRAV/empreintes-cible.txt"  || arret "empreintes de la restauration impossibles"
NB_TABLES="$(grep -c '^table|' "$TRAV/empreintes-source.txt" || true)"
NB_GEOM="$(grep -c '^geom|' "$TRAV/empreintes-source.txt" || true)"
[ "$NB_TABLES" -gt 20 ] || arret "seulement $NB_TABLES tables comparees : la comparaison ne serait pas fiable"
[ "$NB_GEOM" -gt 5 ] || arret "seulement $NB_GEOM colonnes geometry comparees : la comparaison ne serait pas fiable"

ECHECS=0
if diff "$TRAV/empreintes-source.txt" "$TRAV/empreintes-cible.txt" > "$TRAV/diff-empreintes.txt"; then
  vert "(b)(c)(d)(e) $NB_TABLES tables (lignes + somme de controle), $NB_GEOM colonnes geometry, sequences, contraintes, declencheurs : identiques"
  echo "   exemples (source = restauration) :"
  grep -E '^table\|(troncons|ouvrages|chantiers|limites_admin|audit_logs)\|' "$TRAV/empreintes-cible.txt" | cut -d'|' -f2-3 | sed 's/|/ : /; s/$/ lignes/; s/^/      /'
  grep -E '^geom\|(troncons\.geom|ouvrages\.geom|limites_admin\.geom)\|' "$TRAV/empreintes-cible.txt" | sed 's/^geom|/      geometrie /; s/|etendue=[^|]*//; s/|ewkb=\(.\{12\}\).*/|ewkb=\1.../' | cut -c1-200
else
  ECHECS=$((ECHECS + 1)); rouge "DIFFERENCE d'empreintes (source < / restauration >) :"; sed -n '1,20p' "$TRAV/diff-empreintes.txt" | cut -c1-200
fi

# 5b. schema complet
# Un CHECK dont le texte change a la restauration n'est pas forcement une difference : pg_restore RELIT le
# texte que pg_dump a ecrit, et PostgreSQL re-associe alors les AND imbriques ((a AND b) AND (c AND d)
# devient (a AND b AND (c AND d))). C'est le meme predicat. Pour ne pas le TOLERER sur la foi d'une
# regle de parentheses, on le PROUVE : le texte de la source est relu par PostgreSQL sur la base
# restauree (contrainte d'essai ajoutee puis retiree dans une transaction annulee) et doit redonner
# EXACTEMENT le texte restaure. Retourne 0 si toutes les differences sont dans ce cas.
checks_equivalents() {
  local diff="$1" ligne t n expr
  # Toute ligne differente doit etre une contrainte CHECK : tout autre ecart est une vraie difference.
  if grep -E '^[<>] ' "$diff" | grep -vE '^[<>] con\|[^|]+\|CHECK ' | grep -q .; then return 1; fi
  : > "$TRAV/sonde.sql"
  echo "BEGIN;" >> "$TRAV/sonde.sql"
  while IFS= read -r ligne; do
    ligne="${ligne#< con|}"; ligne="${ligne%%|*}"   # table.contrainte
    t="${ligne%%.*}"; n="${ligne#*.}"
    # < /dev/null : docker exec -i lirait sinon la suite de la boucle (entree standard du while).
    expr="$(psql_db "$SOURCE" -c "SELECT pg_get_expr(conbin, conrelid) FROM pg_constraint WHERE conrelid = 'public.\"$t\"'::regclass AND conname = '$n' AND contype = 'c'" < /dev/null)"
    [ -n "$expr" ] || return 1
    {
      echo "ALTER TABLE public.\"$t\" ADD CONSTRAINT zz_sonde_restauration CHECK ($expr) NOT VALID;"
      echo "SELECT 'sonde|$t.$n|' || regexp_replace(pg_get_constraintdef(oid), ' NOT VALID\$', '') FROM pg_constraint WHERE conname = 'zz_sonde_restauration' AND conrelid = 'public.\"$t\"'::regclass;"
      echo "ALTER TABLE public.\"$t\" DROP CONSTRAINT zz_sonde_restauration;"
    } >> "$TRAV/sonde.sql"
  done < <(grep -E '^< con\|' "$diff")
  echo "ROLLBACK;" >> "$TRAV/sonde.sql"
  psql_db "$CIBLE" < "$TRAV/sonde.sql" 2>/dev/null | grep '^sonde|' | sed 's/^sonde|/con|/' | sort > "$TRAV/sonde-relue.txt" || return 1
  grep -E '^> con\|' "$diff" | sed 's/^> //' | sort > "$TRAV/sonde-restauree.txt"
  [ -s "$TRAV/sonde-relue.txt" ] && cmp -s "$TRAV/sonde-relue.txt" "$TRAV/sonde-restauree.txt"
}

psql_db "$SOURCE" < "$INSTANTANE" > "$TRAV/schema-source.txt" || arret "instantane de la source impossible"
psql_db "$CIBLE"  < "$INSTANTANE" > "$TRAV/schema-cible.txt"  || arret "instantane de la restauration impossible"
NB_OBJETS="$(wc -l < "$TRAV/schema-source.txt" | tr -d ' ')"
[ "$NB_OBJETS" -gt 1000 ] || arret "instantane de schema trop court ($NB_OBJETS lignes)"
if diff "$TRAV/schema-source.txt" "$TRAV/schema-cible.txt" > "$TRAV/diff-schema.txt"; then
  vert "(a) schema identique : $NB_OBJETS objets (colonnes, types, contraintes, index, declencheurs, fonctions)"
elif checks_equivalents "$TRAV/diff-schema.txt"; then
  NB_RE="$(grep -c '^< con|' "$TRAV/diff-schema.txt" || true)"
  vert "(a) schema identique : $NB_OBJETS objets ; $NB_RE CHECK re-parenthese(s) par PostgreSQL au rechargement, equivalence PROUVEE (le texte source relu donne exactement le texte restaure) :"
  grep -E '^< con\|' "$TRAV/diff-schema.txt" | cut -d'|' -f2 | sed 's/^/      /'
else
  ECHECS=$((ECHECS + 1)); rouge "DIFFERENCE de schema (source < / restauration >) :"; sed -n '1,20p' "$TRAV/diff-schema.txt" | cut -c1-200
fi

# 5c. index GiST utilisable : le meme resultat avec et sans l'index
INDEX_SQL="
SET enable_seqscan = off; SELECT count(*) FROM troncons WHERE geom && ST_MakeEnvelope(-13.5, 9.5, -13.0, 9.9, 4326);
"
SEQ_SQL="
SET enable_indexscan = off; SET enable_bitmapscan = off; SELECT count(*) FROM troncons WHERE geom && ST_MakeEnvelope(-13.5, 9.5, -13.0, 9.9, 4326);
"
# SET seul n'imprime rien en mode -At : la derniere ligne est le compte.
AVEC_INDEX="$(printf '%s' "$INDEX_SQL" | psql_db "$CIBLE" | tail -1)"
SANS_INDEX="$(printf '%s' "$SEQ_SQL" | psql_db "$CIBLE" | tail -1)"
PLAN="$(printf 'SET enable_seqscan = off; EXPLAIN SELECT 1 FROM troncons WHERE geom && ST_MakeEnvelope(-13.5, 9.5, -13.0, 9.9, 4326);' | psql_db "$CIBLE" | tr '\n' ' ')"
if [ -n "$AVEC_INDEX" ] && [ "$AVEC_INDEX" = "$SANS_INDEX" ] && [ "$AVEC_INDEX" -gt 0 ] && printf '%s' "$PLAN" | grep -qi 'index'; then
  vert "(f) index GiST des troncons utilisable apres restauration : $AVEC_INDEX resultats avec l'index, $SANS_INDEX sans"
else
  ECHECS=$((ECHECS + 1)); rouge "(f) index GiST : avec=$AVEC_INDEX sans=$SANS_INDEX plan=${PLAN:0:120}"
fi

# ---------------------------------------------------------------------------------------------
etape "Resultat"
echo "Durees LOCALES sur un jeu synthetique de $LIGNES troncons : sauvegarde $(duree "$T0" "$T1"), restauration $(duree "$T2" "$T3")."
echo "Elles ne sont PAS une mesure du temps de restauration de la production."
if [ "$CONTRE_EPREUVE" -eq 1 ]; then
  # Deux alterations ont ete posees (une geometrie, une ligne) : la comparaison doit les voir TOUTES LES DEUX.
  VU_GEOM=0; VU_LIGNE=0
  grep -q '^> table|troncons|'  "$TRAV/diff-empreintes.txt" && VU_GEOM=1
  grep -q '^> table|ouvrages|'  "$TRAV/diff-empreintes.txt" && VU_LIGNE=1
  grep -q '^> geom|troncons.geom|' "$TRAV/diff-empreintes.txt" || VU_GEOM=0
  if [ "$VU_GEOM" -eq 1 ] && [ "$VU_LIGNE" -eq 1 ]; then
    vert "CONTRE-EPREUVE REUSSIE : la geometrie decalee ET la ligne supprimee sont detectees."
    exit 0
  fi
  arret "CONTRE-EPREUVE ECHOUEE : la comparaison n'a pas vu les deux alterations (geometrie=$VU_GEOM, ligne=$VU_LIGNE)" 1
fi
if [ "$ECHECS" -eq 0 ]; then
  vert "RESTAURATION IDENTIQUE : la base restauree est indiscernable de la source."
  exit 0
fi
arret "$ECHECS comparaison(s) en echec : la restauration n'est PAS identique" 1

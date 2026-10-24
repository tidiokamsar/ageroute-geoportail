#!/usr/bin/env bash
# Banc des descentes : prouve, migration par migration, que le retour arriere rend le schema d'avant.
#
# POURQUOI CE BANC EXISTE
#
# Le paragraphe 9.4 du mandat v2.1 exige des migrations « testees en montee ET en descente ». Un
# script de retour arriere relu mais jamais execute est une hypothese. Ce banc l'execute, et compare
# le schema complet avant et apres, objet par objet (voir instantane-schema.sql).
#
# CE QU'IL FAIT, POUR CHAQUE MIGRATION, SUR UN CLONE JETABLE
#
#   1. applique la migration sur la base de reference et prend un instantane du schema ;
#   2. descente reversible : l'execute sur un clone, et exige un schema IDENTIQUE a celui d'avant la
#      migration (a quelques residus pres, declares dans le fichier par `-- RESIDU-ACCEPTE: <regex>`,
#      une expression reguliere ancree en debut de ligne de l'instantane) ;
#   3. reapplique la migration sur ce clone et exige le schema d'apres : un aller-retour complet ;
#   4. gardes : pour chaque `-- GARDE-TEST: <sql>`, insere la donnee que la descente detruirait,
#      exige que la descente REFUSE et ne change rien, puis qu'elle passe avec l'autorisation
#      explicite (`SET LOCAL bdri.perte_autorisee = 'OUI'`) et rende le schema d'avant. Un
#      `-- GARDE-TEST-SANS-DEROGATION:` doit refuser MEME avec l'autorisation ;
#   5. descente irreversible (`-- IRREVERSIBLE`) : exige qu'elle REFUSE et ne change rien.
#
# LE PONT DE DERIVE. La chaine de migrations ne se rejoue pas depuis une base vide : la production a
# ete construite avec `prisma db push` (docs/phase5/MIGRATIONS-NON-REJOUABLES.md). Un fichier
# `ponts/<migration>.sql` amene la base de reference de l'etat que cette migration produit vers
# celui de production, APRES le test de sa descente. Il ne corrige pas l'historique.
#
# CE QU'IL NE PROUVE PAS : le comportement sur les donnees reelles de production (volumes, verrous,
# durees) ni la conservation des donnees que la descente ne detruit pas par construction. La base de
# developpement est vide : seules les gardes sont eprouvees avec des lignes fabriquees. Il prouve
# la descente sur le schema que la CHAINE de migrations produit, pas sur celui de la production.
#
# USAGE (depuis la racine du depot, base de developpement Docker) :
#
#   docker cp backend/prisma bdri-dev-db:/tmp/prisma-verif
#   docker exec bdri-dev-db bash /tmp/prisma-verif/descentes/verifier.sh
#
# Options : --seulement <migration>  ne teste que cette descente (les migrations d'avant sont
#                                    quand meme appliquees, pour atteindre son etat)
#           --jusqua <migration>     s'arrete apres cette migration
#           --garder                 ne supprime pas les bases de travail (rt_*)
#           --strict                 une migration SANS descente compte comme un echec (usage de la CI)
#
# Ne touche JAMAIS une base existante : il cree et supprime ses propres bases `rt_<pid>_*`.

set -uo pipefail

PRISMA="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS="$PRISMA/migrations"
DESCENTES="$PRISMA/descentes"
SNAP="$DESCENTES/instantane-schema.sql"

export PGUSER="${PGUSER:-bdri_dev}"
PRE="rt_$$"
TRAV="$(mktemp -d)"
SEULEMENT=""
JUSQUA=""
GARDER=0
STRICT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --seulement) SEULEMENT="$2"; shift 2 ;;
    --jusqua)    JUSQUA="$2"; shift 2 ;;
    --garder)    GARDER=1; shift ;;
    --strict)    STRICT=1; shift ;;
    *) echo "option inconnue : $1" >&2; exit 2 ;;
  esac
done

psql_adm() { psql -X -q -v ON_ERROR_STOP=1 -d postgres "$@" < /dev/null; }

nettoyer() {
  if [ "$GARDER" -eq 0 ]; then
    for d in $(psql -X -At -d postgres -c "SELECT datname FROM pg_database WHERE datname LIKE '${PRE}_%'" < /dev/null); do
      psql -X -q -d postgres -c "DROP DATABASE IF EXISTS \"$d\" WITH (FORCE)" < /dev/null >/dev/null 2>&1
    done
  fi
  rm -rf "$TRAV"
}
trap nettoyer EXIT

vert()  { printf '\033[32m%s\033[0m\n' "$*"; }
rouge() { printf '\033[31m%s\033[0m\n' "$*"; }

cloner() { psql_adm -c "CREATE DATABASE \"$2\" TEMPLATE \"$1\"" >/dev/null; }

# Un instantane qui echoue arrete le banc : comparer deux fichiers vides rendrait un « ok » faux.
instantane() {
  if ! psql -X -At -v ON_ERROR_STOP=1 -d "$1" -f "$SNAP" > "$2" 2> "$TRAV/instantane.err" < /dev/null; then
    rouge "INSTANTANE IMPOSSIBLE sur $1 :"; sed -n '1,8p' "$TRAV/instantane.err"; exit 2
  fi
}

# Applique un fichier SQL dans UNE transaction ; garde la sortie dans $TRAV/sortie.log.
appliquer() { psql -X -q -v ON_ERROR_STOP=1 -1 -d "$1" -f "$2" > "$TRAV/sortie.log" 2>&1 < /dev/null; }

# Compare deux instantanes en ignorant les residus declares ($3 = fichier de la descente).
comparer() {
  local a="$1" b="$2" desc="$3" fa="$TRAV/cmp_a" fb="$TRAV/cmp_b"
  cp "$a" "$fa"; cp "$b" "$fb"
  if [ -n "$desc" ] && [ -f "$desc" ]; then
    while IFS= read -r p; do
      [ -z "$p" ] && continue
      grep -Ev -e "^($p)" "$fa" > "$fa.t"; mv "$fa.t" "$fa"
      grep -Ev -e "^($p)" "$fb" > "$fb.t"; mv "$fb.t" "$fb"
    done < <(sed -n 's/^-- RESIDU-ACCEPTE: *//p' "$desc")
  fi
  diff "$fa" "$fb" > "$TRAV/diff.txt"
}

ok=0; ko=0; sans=0; echec_detail=()
note_ko() { ko=$((ko + 1)); rouge "  ECHEC  $1"; echec_detail+=("$1"); [ -n "${2:-}" ] && sed -n "1,${3:-12}p" "$2" | sed 's/^/           /'; }
note_ok() { ok=$((ok + 1)); vert  "  ok     $1"; }

base="${PRE}_base"
psql_adm -c "CREATE DATABASE \"$base\" TEMPLATE template0" >/dev/null || { rouge "creation de la base impossible"; exit 2; }
instantane "$base" "$TRAV/prev.snap"

total=$(ls -1 "$MIGRATIONS" | grep -cE '^[0-9]{14}_')
n=0
echo "Banc des descentes : $total migrations, base de reference ${base}"

for dir in $(ls -1 "$MIGRATIONS" | grep -E '^[0-9]{14}_' | sort); do
  n=$((n + 1))
  m="$dir"
  fichier="$MIGRATIONS/$m/migration.sql"
  desc="$DESCENTES/$m.sql"

  if ! appliquer "$base" "$fichier"; then
    rouge "[$n/$total] $m : la MIGRATION ne s'applique pas sur la base precedente"
    sed -n '1,15p' "$TRAV/sortie.log"
    ko=$((ko + 1)); echec_detail+=("$m : migration non applicable")
    break
  fi
  instantane "$base" "$TRAV/cur.snap"
  if [ ! -s "$TRAV/cur.snap" ]; then
    rouge "[$n/$total] $m : instantane vide apres une migration, le banc n'est pas fiable"; exit 2
  fi

  testable=1
  [ -n "$SEULEMENT" ] && [ "$SEULEMENT" != "$m" ] && testable=0
  if [ "$testable" -eq 1 ]; then
    if [ ! -f "$desc" ]; then
      sans=$((sans + 1)); echo "[$n/$total] $m : PAS DE DESCENTE"
    else
      echo "[$n/$total] $m"

      if grep -q '^-- IRREVERSIBLE' "$desc"; then
        # --- descente irreversible : doit refuser, et ne rien changer
        cloner "$base" "${PRE}_t"
        if appliquer "${PRE}_t" "$desc"; then
          note_ko "$m : la descente irreversible S'EST EXECUTEE" "$TRAV/sortie.log"
        elif ! grep -q 'DESCENTE REFUSEE' "$TRAV/sortie.log"; then
          note_ko "$m : refus sans le message DESCENTE REFUSEE" "$TRAV/sortie.log"
        else
          instantane "${PRE}_t" "$TRAV/apres.snap"
          comparer "$TRAV/cur.snap" "$TRAV/apres.snap" ""
          if [ ! -s "$TRAV/diff.txt" ]; then
            note_ok "irreversible : refuse, schema inchange"
          else
            note_ko "$m : le refus a laisse une trace dans le schema" "$TRAV/diff.txt"
          fi
        fi
        psql_adm -c "DROP DATABASE IF EXISTS \"${PRE}_t\" WITH (FORCE)" >/dev/null
      else
        # --- A : descente, schema identique a celui d'avant la migration
        cloner "$base" "${PRE}_t"
        if ! appliquer "${PRE}_t" "$desc"; then
          note_ko "$m : la descente echoue" "$TRAV/sortie.log"
        else
          instantane "${PRE}_t" "$TRAV/apres.snap"
          comparer "$TRAV/prev.snap" "$TRAV/apres.snap" "$desc"
          if [ -s "$TRAV/diff.txt" ]; then
            note_ko "$m : le schema apres descente differe de celui d'avant" "$TRAV/diff.txt" 14
          else
            note_ok "descente : schema identique a celui d'avant la migration"
            # --- B : reapplication, schema identique a celui d'apres la migration
            if ! appliquer "${PRE}_t" "$fichier"; then
              note_ko "$m : la migration ne se reapplique pas apres la descente" "$TRAV/sortie.log"
            else
              instantane "${PRE}_t" "$TRAV/re.snap"
              comparer "$TRAV/cur.snap" "$TRAV/re.snap" "$desc"
              if [ -s "$TRAV/diff.txt" ]; then
                note_ko "$m : aller-retour incomplet (schema different apres reapplication)" "$TRAV/diff.txt" 14
              else
                note_ok "aller-retour : montee, descente, remontee identiques"
              fi
            fi
          fi
        fi
        psql_adm -c "DROP DATABASE IF EXISTS \"${PRE}_t\" WITH (FORCE)" >/dev/null

        # --- C : gardes, une donnee fabriquee par scenario
        k=0
        while IFS= read -r l; do
          [ -z "$l" ] && continue
          k=$((k + 1))
          sans_derog=0
          case "$l" in
            "-- GARDE-TEST-SANS-DEROGATION: "*) sans_derog=1; fixture="${l#-- GARDE-TEST-SANS-DEROGATION: }" ;;
            *)                                  fixture="${l#-- GARDE-TEST: }" ;;
          esac
          etiq="garde $k"
          { echo "SET session_replication_role = replica;"; echo "$fixture"; } > "$TRAV/fixture.sql"
          cloner "$base" "${PRE}_g"
          if ! psql -X -q -v ON_ERROR_STOP=1 -d "${PRE}_g" -f "$TRAV/fixture.sql" > "$TRAV/sortie.log" 2>&1 < /dev/null; then
            note_ko "$m : $etiq : la donnee de test ne s'insere pas" "$TRAV/sortie.log"
          else
            instantane "${PRE}_g" "$TRAV/avant_g.snap"
            if appliquer "${PRE}_g" "$desc"; then
              note_ko "$m : $etiq : la descente S'EST EXECUTEE malgre des donnees" "$TRAV/sortie.log"
            elif ! grep -q 'DESCENTE REFUSEE' "$TRAV/sortie.log"; then
              note_ko "$m : $etiq : echec sans le message DESCENTE REFUSEE" "$TRAV/sortie.log"
            else
              instantane "${PRE}_g" "$TRAV/apres_g.snap"
              comparer "$TRAV/avant_g.snap" "$TRAV/apres_g.snap" ""
              if [ -s "$TRAV/diff.txt" ]; then
                note_ko "$m : $etiq : la garde a refuse mais le schema a bouge" "$TRAV/diff.txt"
              else
                note_ok "$etiq : refuse avec donnees, schema inchange"
                { echo "SET LOCAL bdri.perte_autorisee = 'OUI';"; cat "$desc"; } > "$TRAV/forcee.sql"
                if [ "$sans_derog" -eq 1 ]; then
                  if appliquer "${PRE}_g" "$TRAV/forcee.sql"; then
                    note_ko "$m : $etiq : la derogation a passe alors qu'elle ne doit pas" "$TRAV/sortie.log"
                  else
                    note_ok "$etiq : l'autorisation n'y change rien (aucune valeur de remplacement inventee)"
                  fi
                else
                  if ! appliquer "${PRE}_g" "$TRAV/forcee.sql"; then
                    note_ko "$m : $etiq : la descente autorisee echoue" "$TRAV/sortie.log"
                  else
                    instantane "${PRE}_g" "$TRAV/forcee.snap"
                    comparer "$TRAV/prev.snap" "$TRAV/forcee.snap" "$desc"
                    if [ -s "$TRAV/diff.txt" ]; then
                      note_ko "$m : $etiq : descente autorisee, schema different de celui d'avant" "$TRAV/diff.txt"
                    else
                      note_ok "$etiq : avec autorisation explicite, la descente passe et rend le schema d'avant"
                    fi
                  fi
                fi
              fi
            fi
          fi
          psql_adm -c "DROP DATABASE IF EXISTS \"${PRE}_g\" WITH (FORCE)" >/dev/null
        done < <(grep -E '^-- GARDE-TEST(-SANS-DEROGATION)?: ' "$desc")
      fi
    fi
  fi

  # Pont de derive : voir ponts/*.sql. Il s'execute apres le test de la descente de `$m`, et
  # l'instantane de reference suivant le prend en compte.
  if [ -f "$DESCENTES/ponts/$m.sql" ]; then
    if appliquer "$base" "$DESCENTES/ponts/$m.sql"; then
      instantane "$base" "$TRAV/cur.snap"
      echo "  pont   derive de production appliquee apres $m (ponts/$m.sql)"
    else
      rouge "[$n/$total] $m : le PONT de derive ne s'applique pas"; sed -n '1,15p' "$TRAV/sortie.log"
      ko=$((ko + 1)); echec_detail+=("$m : pont non applicable"); break
    fi
  fi

  cp "$TRAV/cur.snap" "$TRAV/prev.snap"
  [ -n "$JUSQUA" ] && [ "$JUSQUA" = "$m" ] && break
done

echo
if [ "$STRICT" -eq 1 ] && [ "$sans" -gt 0 ]; then
  ko=$((ko + sans)); echec_detail+=("$sans migration(s) sans descente (mode --strict)")
fi
echo "Bilan : $ok verifications reussies, $ko echec(s), $sans migration(s) sans descente."
if [ "$ko" -gt 0 ]; then
  rouge "Echecs :"; printf '  - %s\n' "${echec_detail[@]}"
  exit 1
fi
exit 0

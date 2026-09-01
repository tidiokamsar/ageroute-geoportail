#!/usr/bin/env bash
#
# Verification avant livraison de la Console BDRI.
#
# A executer AVANT tout transfert vers le serveur. Un echec interrompt : mieux vaut
# ne pas livrer que livrer et decouvrir.
#
# Chacun des controles ci-dessous correspond a un defaut REELLEMENT rencontre le
# 01/09/2026, et qui a ete decouvert trop tard :
#
#   - verrou npm desynchronise    -> "npm ci" a echoue A LA CONSTRUCTION de l'image,
#                                    apres transfert, sur deux lots successifs
#   - await de premier niveau     -> Vitest l'accepte, tsc le refuse : les tests
#                                    passaient au vert TOUT EN cassant la construction
#   - syntaxe nginx               -> une erreur y empeche le frontend de demarrer,
#                                    donc met le site hors ligne
#
# Usage : verification-avant-livraison.sh [racine_du_depot]

set -uo pipefail   # pas de -e : on veut ENCHAINER tous les controles et rendre un
                   # bilan complet, plutot que de s'arreter au premier echec.

RACINE="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ECHECS=0
IGNORES=0

titre()   { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()      { printf '  \033[32mOK\033[0m    %s\n' "$*"; }
echec()   { printf '  \033[31mECHEC\033[0m %s\n' "$*"; ECHECS=$((ECHECS+1)); }
ignore()  { printf '  \033[33mIGNORE\033[0m %s\n' "$*"; IGNORES=$((IGNORES+1)); }

# ─────────────────────────────────────────────────────────────
# 1. Coherence package.json / package-lock.json
# ─────────────────────────────────────────────────────────────
# C'est le controle le plus rentable du lot : il coute une seconde et il a manque
# deux fois. "npm ci" refuse par conception un verrou desynchronise, mais il ne le
# dit qu'au moment de construire l'image — c'est-a-dire apres le transfert.
verifier_verrou() {
    local partie="$1" dossier="$RACINE/$1"
    [ -f "$dossier/package.json" ] || { ignore "$partie : pas de package.json"; return; }
    [ -f "$dossier/package-lock.json" ] || { echec "$partie : package-lock.json absent"; return; }

    local manquants
    manquants=$(node -e "
        const fs=require('fs');
        const pkg=JSON.parse(fs.readFileSync('$dossier/package.json','utf8'));
        const lock=JSON.parse(fs.readFileSync('$dossier/package-lock.json','utf8'));
        const racine=lock.packages && lock.packages[''] ? lock.packages[''] : {};
        const verrouilles={...(racine.dependencies||{}),...(racine.devDependencies||{})};
        const declares={...(pkg.dependencies||{}),...(pkg.devDependencies||{})};
        const absents=Object.keys(declares).filter(d=>!(d in verrouilles));
        process.stdout.write(absents.join(', '));
    " 2>/dev/null)

    if [ -n "$manquants" ]; then
        echec "$partie : declare mais absent du verrou -> $manquants"
        printf '        npm install --package-lock-only dans %s\n' "$dossier"
    else
        ok "$partie : package.json et package-lock.json coherents"
    fi
}

# ─────────────────────────────────────────────────────────────
# 2. Compilation TypeScript
# ─────────────────────────────────────────────────────────────
# tsc est plus strict que Vitest : c'est lui qui tourne dans le Dockerfile, et lui
# seul qui dira non a un "await" de premier niveau.
verifier_tsc() {
    local partie="$1" dossier="$RACINE/$1"
    [ -d "$dossier/node_modules" ] || { ignore "$partie : node_modules absent, compilation non verifiee"; return; }

    local sortie
    if [ "$partie" = "backend" ]; then
        sortie=$(cd "$dossier" && npx --no-install tsc -p tsconfig.json --noEmit 2>&1)
    else
        sortie=$(cd "$dossier" && npx --no-install tsc --noEmit 2>&1)
    fi

    if [ -z "$sortie" ]; then
        ok "$partie : compilation TypeScript sans erreur"
    else
        echec "$partie : compilation TypeScript en echec"
        echo "$sortie" | head -5 | sed 's/^/        /'
    fi
}

# ─────────────────────────────────────────────────────────────
# 3. Tests
# ─────────────────────────────────────────────────────────────
verifier_tests() {
    local partie="$1" dossier="$RACINE/$1"
    [ -d "$dossier/node_modules" ] || { ignore "$partie : node_modules absent, tests non joues"; return; }
    grep -q '"test"' "$dossier/package.json" 2>/dev/null || { ignore "$partie : aucun script de test"; return; }

    local sortie
    sortie=$(cd "$dossier" && npx --no-install vitest run 2>&1)
    if echo "$sortie" | grep -q "failed"; then
        echec "$partie : des tests echouent"
        echo "$sortie" | grep -E "FAIL|×" | head -5 | sed 's/^/        /'
    else
        local nb
        nb=$(echo "$sortie" | grep -oE "Tests[^)]*passed" | tail -1 | grep -oE "[0-9]+" | tail -1)
        ok "$partie : ${nb:-?} tests au vert"
    fi
}

# ─────────────────────────────────────────────────────────────
# 4. Migrations Prisma
# ─────────────────────────────────────────────────────────────
# Controle de FORME seulement : chaque dossier de migration porte un migration.sql.
# L'etat applique en base ne peut se verifier que contre la base elle-meme, ce qui
# n'a pas sa place dans un controle local.
verifier_migrations() {
    local dossier="$RACINE/backend/prisma/migrations"
    [ -d "$dossier" ] || { ignore "migrations : dossier absent"; return; }

    local incompletes=0
    for m in "$dossier"/*/; do
        [ -d "$m" ] || continue
        [ -f "$m/migration.sql" ] || { echec "migration sans migration.sql : $(basename "$m")"; incompletes=$((incompletes+1)); }
    done
    [ "$incompletes" -eq 0 ] && ok "migrations : $(find "$dossier" -mindepth 1 -maxdepth 1 -type d | wc -l) dossiers, tous complets"
}

# ─────────────────────────────────────────────────────────────
# 5. Configuration Nginx
# ─────────────────────────────────────────────────────────────
# Une erreur de syntaxe empeche le frontend de demarrer, donc met le site hors ligne.
# Docker est indispensable : nginx n'est pas installe sur un poste de developpement.
verifier_nginx() {
    local conf="$RACINE/frontend/nginx.conf"
    [ -f "$conf" ] || { ignore "nginx.conf absent"; return; }
    command -v docker >/dev/null 2>&1 || { ignore "nginx : docker indisponible, syntaxe non verifiee"; return; }

    # "host not found in upstream" est ATTENDU hors du reseau Compose : le service
    # backend n'y est pas resolvable. Ce n'est pas une erreur de syntaxe.
    local sortie
    sortie=$(docker run --rm -v "$conf:/etc/nginx/conf.d/default.conf:ro" nginx:1.27-alpine nginx -t 2>&1)

    if echo "$sortie" | grep -q "syntax is ok"; then
        ok "nginx : syntaxe valide"
    elif echo "$sortie" | grep -q "host not found in upstream"; then
        ok "nginx : syntaxe valide (resolution du backend attendue hors reseau Compose)"
    elif echo "$sortie" | grep -qE "failed to resolve reference|Unable to find image|Cannot connect to the Docker daemon|dial tcp"; then
        # Ne pas confondre « je ne peux pas verifier » et « c'est invalide ».
        # Rencontre le 01/09/2026 : Docker present mais sans acces au registre, et le
        # script refusait la livraison pour un motif d'ENVIRONNEMENT. Un garde-fou qui
        # crie au loup apprend a le contourner — le meme raisonnement que pour le test
        # instable trouve le meme jour.
        ignore "nginx : image indisponible, syntaxe non verifiee"
    else
        echec "nginx : configuration refusee"
        echo "$sortie" | grep -E "emerg|error" | head -3 | sed 's/^/        /'
    fi
}

# ─────────────────────────────────────────────────────────────
# 6. Secrets
# ─────────────────────────────────────────────────────────────
# Un secret parti dans Git y reste, meme retire au commit suivant.
verifier_secrets() {
    local suspects
    suspects=$(cd "$RACINE" && git ls-files 2>/dev/null | grep -E '(^|/)\.env$|\.pem$|\.key$|cle-sauvegarde' || true)
    if [ -n "$suspects" ]; then
        echec "fichiers sensibles suivis par Git :"
        echo "$suspects" | sed 's/^/        /'
    else
        ok "secrets : aucun fichier sensible suivi par Git"
    fi
}

# ─────────────────────────────────────────────────────────────

printf '\033[1mVerification avant livraison — %s\033[0m\n' "$RACINE"

titre "Dependances"
verifier_verrou backend
verifier_verrou frontend

titre "Compilation"
verifier_tsc backend
verifier_tsc frontend

titre "Tests"
verifier_tests backend
verifier_tests frontend

titre "Base de donnees"
verifier_migrations

titre "Infrastructure"
verifier_nginx

titre "Securite"
verifier_secrets

printf '\n'
if [ "$ECHECS" -gt 0 ]; then
    printf '\033[31m%d controle(s) en echec — NE PAS LIVRER\033[0m\n' "$ECHECS"
    [ "$IGNORES" -gt 0 ] && printf '\033[33m%d controle(s) ignore(s)\033[0m\n' "$IGNORES"
    exit 1
fi

if [ "$IGNORES" -gt 0 ]; then
    # Un controle ignore n'est pas un controle reussi : le signaler evite de prendre
    # un environnement incomplet pour une validation.
    printf '\033[33mTous les controles executes passent, mais %d ont ete ignores.\033[0m\n' "$IGNORES"
    printf '\033[33mLa livraison n'"'"'est PAS entierement verifiee.\033[0m\n'
    exit 0
fi

printf '\033[32mTous les controles passent — livraison possible\033[0m\n'

#!/usr/bin/env bash
#
# Diagnostic topologique du reseau routier BDRI (T10).
#
# POURQUOI CE SCRIPT EXISTE
#
# Le §26 du cahier des charges demande de comparer pgRouting, OSRM et GraphHopper puis
# de recommander. Cette comparaison n'a pas de sens sur l'etat actuel : aucun moteur
# ne route sur un graphe dont les composantes ne se touchent pas.
#
# Ce script MESURE, il ne corrige rien. Il ne cree aucune jonction, ne deplace aucun
# sommet, n'ecrit rien. Raccorder deux troncons qui se croisent sans se toucher est
# une modification de geometrie, irreversible sans sauvegarde : c'est une decision, et
# elle demande d'abord ces chiffres.
#
# LECTURE SEULE, sur la base indiquee.
#
# Usage : diagnostic-topologie.sh [conteneur] [base] [utilisateur]

set -uo pipefail

CONTENEUR="${1:-console-bdri-db-1}"
BASE="${2:-console_bdri}"
UTILISATEUR="${3:-bdri_app}"

q() { docker exec "$CONTENEUR" psql -U "$UTILISATEUR" -d "$BASE" -tAc "$1" 2>/dev/null; }
tableau() { docker exec "$CONTENEUR" psql -U "$UTILISATEUR" -d "$BASE" -c "$1" 2>/dev/null; }
titre() { printf '\n\033[1m%s\033[0m\n' "$*"; }

printf '\033[1mDiagnostic topologique — reseau routier BDRI\033[0m\n'
printf 'Base : %s   %s\n' "$BASE" "$(date '+%Y-%m-%d %H:%M')"

# ─────────────────────────────────────────────────────────────
titre "1. Volume et validite"
tableau "
SELECT classe,
       count(*)                                                   AS troncons,
       count(*) FILTER (WHERE geom IS NULL)                       AS sans_geometrie,
       count(*) FILTER (WHERE NOT ST_IsValid(geom))               AS invalides,
       count(*) FILTER (WHERE NOT ST_IsSimple(geom))              AS auto_intersectees,
       count(DISTINCT ST_SRID(geom))                              AS srid_distincts,
       ROUND(SUM(ST_Length(geom::geography)/1000)::numeric, 0)    AS km
FROM troncons WHERE \"deletedAt\" IS NULL
GROUP BY classe ORDER BY classe;"

# ─────────────────────────────────────────────────────────────
titre "2. Noeuds : combien d'extremites distinctes ?"
q "
WITH ext AS (
  SELECT ST_StartPoint(geom) p FROM troncons WHERE \"deletedAt\" IS NULL AND geom IS NOT NULL
  UNION ALL
  SELECT ST_EndPoint(geom)   FROM troncons WHERE \"deletedAt\" IS NULL AND geom IS NOT NULL
)
SELECT '  extremites totales      : '||count(*) FROM ext
UNION ALL
SELECT '  positions distinctes    : '||count(DISTINCT ST_AsBinary(p)) FROM ext;"

# ─────────────────────────────────────────────────────────────
titre "3. Connectivite selon la tolerance"
#
# Elargir la tolerance distingue deux situations tres differentes : des extremites
# qui se ratent de peu (la tolerance les rattrape) et de vraies extremites libres
# (elle ne change rien). C'est ce que ce tableau tranche.
tableau "
WITH ext AS (
  SELECT id, ST_StartPoint(geom) p FROM troncons WHERE \"deletedAt\" IS NULL AND geom IS NOT NULL
  UNION ALL
  SELECT id, ST_EndPoint(geom)    FROM troncons WHERE \"deletedAt\" IS NULL AND geom IS NOT NULL
)
SELECT tol.m AS tolerance_m,
       count(*) FILTER (WHERE q.voisins > 0) AS connectees,
       count(*)                              AS total,
       ROUND(100.0*count(*) FILTER (WHERE q.voisins > 0)/count(*), 1) AS pct
FROM (VALUES (1),(5),(10),(50)) AS tol(m),
LATERAL (
  SELECT (SELECT count(*) FROM ext e2
          WHERE e2.id <> e.id AND ST_DWithin(e.p::geography, e2.p::geography, tol.m)) AS voisins
  FROM ext e
) q
GROUP BY tol.m ORDER BY tol.m;"

# ─────────────────────────────────────────────────────────────
titre "4. Connexions ENTRE classes — la question qui decide"
#
# Un reseau national se parcourt en passant d'une nationale a une regionale. Si
# aucune extremite ne relie deux classes, ce ne sont pas trois parties d'un reseau :
# ce sont trois reseaux.
tableau "
WITH ext AS (
  SELECT id, classe, ST_StartPoint(geom) p FROM troncons WHERE \"deletedAt\" IS NULL AND geom IS NOT NULL
  UNION ALL
  SELECT id, classe, ST_EndPoint(geom)    FROM troncons WHERE \"deletedAt\" IS NULL AND geom IS NOT NULL
)
SELECT e.classe,
       count(*) AS extremites,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM ext e2 WHERE e2.id<>e.id AND e2.classe = e.classe
           AND ST_DWithin(e.p::geography, e2.p::geography, 1))) AS vers_meme_classe,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM ext e2 WHERE e2.id<>e.id AND e2.classe <> e.classe
           AND ST_DWithin(e.p::geography, e2.p::geography, 1))) AS vers_autre_classe
FROM ext e GROUP BY e.classe ORDER BY e.classe;"

# ─────────────────────────────────────────────────────────────
titre "5. Croisements geometriques sans jonction"
#
# Deux troncons peuvent se croiser sur la carte sans partager de sommet. Ce sont les
# candidats a un raccordement — et le compte dit l'ampleur du travail.
q "
SELECT '  paires de classes differentes qui se croisent : '||count(*)
FROM (
  SELECT DISTINCT a.id, b.id
  FROM troncons a JOIN troncons b
    ON a.id < b.id AND a.classe <> b.classe
   AND a.geom && b.geom AND ST_Intersects(a.geom, b.geom)
  WHERE a.\"deletedAt\" IS NULL AND b.\"deletedAt\" IS NULL
) x;"

# ─────────────────────────────────────────────────────────────
titre "6. Degre des noeuds"
tableau "
WITH ext AS (
  SELECT ST_AsBinary(ST_StartPoint(geom)) p FROM troncons WHERE \"deletedAt\" IS NULL AND geom IS NOT NULL
  UNION ALL
  SELECT ST_AsBinary(ST_EndPoint(geom))    FROM troncons WHERE \"deletedAt\" IS NULL AND geom IS NOT NULL
),
degres AS (SELECT p, count(*) d FROM ext GROUP BY p)
SELECT CASE
         WHEN d = 1 THEN 'a. degre 1 — extremite libre'
         WHEN d = 2 THEN 'b. degre 2 — continuite'
         WHEN d = 3 THEN 'c. degre 3 — intersection'
         ELSE            'd. degre 4 et plus'
       END AS type_noeud,
       count(*) AS noeuds
FROM degres GROUP BY 1 ORDER BY 1;"

# ─────────────────────────────────────────────────────────────
titre "7. Referencement lineaire — les PK sont-ils exploitables ?"
#
# Le routage n'a pas besoin des PK, mais toute analyse de reseau et toute
# localisation de chantier en depend.
tableau "
SELECT classe,
       count(*)                                              AS troncons,
       count(*) FILTER (WHERE \"pkDebut\" = 0 AND \"pkFin\" = 0) AS pk_nuls,
       count(*) FILTER (WHERE \"pkFin\" > \"pkDebut\")           AS pk_exploitables
FROM troncons WHERE \"deletedAt\" IS NULL GROUP BY classe ORDER BY classe;"

q "
WITH doublons AS (
  SELECT nom FROM troncons
  WHERE \"deletedAt\" IS NULL AND \"pkFin\" > \"pkDebut\"
  GROUP BY nom, \"pkDebut\" HAVING count(*) > 1
)
SELECT '  designations dont un PK de depart est duplique : '||count(DISTINCT nom)
       ||' sur '||(SELECT count(DISTINCT nom) FROM troncons
                   WHERE \"deletedAt\" IS NULL AND \"pkFin\" > \"pkDebut\")
FROM doublons;"

# ─────────────────────────────────────────────────────────────
printf '\n'
printf 'Aucune geometrie n a ete modifiee. Ce diagnostic est en lecture seule.\n'

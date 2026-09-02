# Benchmark des index spatiaux GiST — P1-03

**Date** : 2 septembre 2026
**Script reproductible** : `infra/phase5/benchmark-gist.sh` (copie de production restaurée propre, sauvegarde `bdri_20260902_030001`, conteneur détruit en sortie)
**Règle du cadrage appliquée** : ne pas créer un index uniquement parce qu'une colonne est géométrique — le test doit démontrer son utilité.

---

## 1. Recensement des requêtes réellement exécutées (revue du code backend)

| Requête | Fichier | Prédicat spatial | Candidate à un index ? |
|---|---|---|---|
| Itinéraire | `troncons.service.ts:58` | `ST_DWithin(t.geom::geography, corridor, 20000)` | **oui** |
| Couches carte (tronçons, ouvrages, points noirs, postes, chantiers) | `*/…service.ts listGeo` + API publique | aucun — rendu **pleine table** (`ST_AsGeoJSON` de tout) | non (seq scan = bon plan) |
| Référencement linéaire (`deriveChantierGeom`, `deriveGeomFromTroncon`) | `lib/geo.ts` | jointures par **clés primales** (`c.id`, `t.id`) | non |
| KNN `geom <-> point` | scripts d'import batch uniquement (`import-rural-osm.ts`) | hors application | non (aujourd'hui) |

**Un seul prédicat spatial à l'exécution** : l'itinéraire, sur `troncons`.

## 2. Inventaire des index existants (mesuré sur copie restaurée)

| Table | Index GiST existant en production | Utilisé par |
|---|---|---|
| `troncons` | `troncons_geom_geography_idx` — GIST `((geom::geography))` | itinéraire (voir plan §3) |
| `ouvrages` | **aucun** | — |
| `points_noirs` | **aucun** | — |
| `postes` | **aucun** | — |
| `chantiers` | **aucun** | — |

Les quatre tables sans index ne sont l'objet d'**aucun** prédicat spatial à
l'exécution : leur rendre un index ne servirait aucune requête réelle.

## 3. Mesure avant/après (corridor entre les deux RN les plus longues)

Requête exacte de l'itinéraire, `EXPLAIN (ANALYZE, BUFFERS)`, 3 passes.

| Configuration | Temps d'exécution (3 passes) | Plan |
|---|---|---|
| **Sans nouvel index** (index production existant) | 89,5 / 89,2 / 88,6 ms | `Index Scan using troncons_geom_geography_idx` — 144 tronçons retenus, filtre `deletedAt + ST_DWithin` |
| **Avec index candidat supplémentaire** `troncons_geog_gist_idx` (136 kB) | 88,8 / 88,7 / 88,8 ms | même plan, même index choisi |

**Le candidat n'apporte rien** : la base possède déjà exactement l'index utile,
et le planificateur le préfère. Un doublon ne coûterait que de l'espace et de
l'écriture à chaque modification de géométrie.

**Contre-témoin (rendu pleine table, listGeo)** : `Seq Scan` 1 690 lignes en
36,6 ms — l'index ne change rien, comme attendu.

**Véracité** : le compte du corridor (144) est identique avant/après — l'index
n'a pas altéré le résultat.

## 4. Conclusion par table

| Table | Décision | Justification mesurée |
|---|---|---|
| `troncons` | **aucune création** — l'index existant suffit | plan mesuré §3 ; doublon sans gain |
| `ouvrages` | **aucune création** | aucun prédicat spatial à l'exécution |
| `points_noirs` | **aucune création** | idem |
| `postes` | **aucune création** | idem |
| `chantiers` | **aucune création** | idem |

**Verdict global : MESURÉ — NON CONCLUANT pour toute création.** La
recommandation de la revue initiale (« index GiST ×5 tables ») est **corrigée
par la mesure** : l'index utile existe déjà sur la seule table qui en a l'usage.
Si demain une requête par fenêtre (bbox) ou un vrai KNN apparaît sur les tables
de points, le présent benchmark est le gabarit à rejouer (`benchmark-gist.sh`)
— création seulement sur gain démontré.

**Statut** : MEASURED (plans et temps dans `~/phase5-resultats/gist-benchmark.txt` sur le serveur).

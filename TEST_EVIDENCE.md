# Tests exécutés

> Exigé par le § 4 du mandat v2.1. Le § 2.7 impose que toute affirmation de réussite cite la
> commande lancée et son résultat. Aucune ligne de ce fichier n'est écrite sans l'avoir vue.

## 22/10/2026 — lot 2, contrôle d'accès territorial (DT-3)

Après fusion de `lot/03-map-matching` (T-26, T-28, T-29 de la session GEOPORTAIL) dans cette branche.

| Commande | Résultat |
|---|---|
| `npx vitest run src/governance/perimetre*.test.ts src/api-v2/perimetres.routes.test.ts` | **73 passés** (noyau 13, middleware et synchronisation 13, garde-fou de couverture 43, routes 4) |
| garde-fou de couverture, garde retirée d'une route de `postes` (contre-épreuve) | 1re version : **ne détectait pas** (défaut du garde-fou) ; corrigée : **1 échec** nommant `PUT /:id` |
| `psql -f backend/prisma/tests/perimetres_territoriaux.test.sql` (base migrée) | **toutes les assertions passent** ; sur `replay` sans la migration : échoue |
| `verifier.sh --seulement 20261022010000_perimetres_territoriaux` | **4 vérifications, 0 échec** (garde comprise) |
| `verifier.sh --strict` (chaîne complète) | **71 migrations, 246 vérifications, 0 échec, 0 sans descente** |
| résolution des régions et refus de synchronisation contre `dt_bench` (script jetable) | hors périmètre refusé, dans le périmètre permis, auto-attribution refusée par la base |
| `npx vitest run` (backend) | **1 812 passés**, 121 fichiers |
| `npx vitest run` (frontend, seul) | **476 passés**, 36 fichiers |
| `npm run lint` (frontend) | **0 erreur**, 4 avertissements `exhaustive-deps` préexistants |
| `npx tsc --noEmit` (backend, frontend) | aucune erreur |

## 22/10/2026 — lot 1, surfaces en UTM et géométries de référence (DT-2)

| Commande | Résultat |
|---|---|
| `npx vitest run src/geo/utm.noyau.test.ts` | **36 passés** |
| la même, facteur d'échelle 0,99961 au lieu de 0,9996 (contre-épreuve) | **18 échecs** |
| la même, terme α3 de la série retiré (contre-épreuve) | **1 échec** (sommet à plus d'un millimètre) |
| `psql -f backend/prisma/tests/metre_reference.test.sql` (base `dt_bench`) | **9 géométries, toutes les assertions passent** |
| `npx vitest run src/geo/geometries-reference.banc.test.ts` | banc SQL à jour avec le jeu |
| `verifier.sh --seulement 20261022003000_metre_emprise_utm` | **4 vérifications, 0 échec** |
| `npx vitest run src/field/defauts.emprise.test.ts src/api-v2/defauts.routes.test.ts` | **78 passés** |
| service `mesurerGeometrie` + `quantiteParEmprise` contre `dt_bench` (script jetable) | carré 10 000 m², ligne 1 000 m, polygone à cheval 7 998 955,189 m² en 29N = noyau TS ; papillon refusé « Self-intersection » |
| `npx vitest run` (backend) | **1 609 passés**, 110 fichiers, 0 échec |

## 22/10/2026 — partie E (A30), cohérence et banc de la base (DT-1)

Base privée `dt_bench`, clone de `replay` (PostGIS 3.5.2, GEOS 3.9.0), conteneur `bdri-dev-db`.

| Commande | Résultat |
|---|---|
| `psql -f backend/prisma/tests/teledetection_coherence.test.sql` (base migrée) | **16 assertions passent** |
| la même sur `replay`, **sans** la migration (contre-épreuve) | échoue à la première : « Proposition hors emprise acceptee » |
| `psql -f backend/prisma/tests/observation_terre.test.sql` (base migrée) | **15 assertions passent** (non-régression) |
| `psql -f backend/prisma/tests/teledetection.bench.sql` | plan et exactitude asserts ; durées dans `EARTH_OBSERVATION_PLAN.md` § 7 |
| `verifier.sh --seulement 20261022000000_teledetection_coherence` | **2 vérifications, 0 échec** |
| `npx vitest run src/teledetection src/api-v2/teledetection.routes.test.ts` | **37 passés** (noyau 24, routes 13) |
| `npx vitest run` (backend) | **1 555 passés**, 107 fichiers, 0 échec |
| `npx tsc --noEmit` (backend, frontend) | aucune erreur |
| `npx vitest run src/pages/TeledetectionPage.test.tsx src/pages/Accessibilite.test.tsx` | **16 passés** |
| `npx vitest run` (frontend, seul) | **374 passés**, 32 fichiers, 0 échec |
| service `deposerPropositions` / `coherence` contre `dt_bench` (script jetable, non commité) | hors emprise → 400 `HORS_EMPRISE` (rang 2) ; référence postérieure → 400 ; lot cohérent déposé ; 0 anomalie |

## 14/10/2026 — lot 3, map-matching (premier incrément)

| Commande | Résultat |
|---|---|
| `npx tsc -p tsconfig.json --noEmit` | aucune erreur |
| `npx vitest run src/geo/appariement.noyau.test.ts` | **29 passés** |
| `npx vitest run src/geo/appariement.a2.test.ts` | **11 passés** |
| `npx vitest run src/geo` | **56 passés** — les 16 tests d''appariement antérieurs tiennent |
| `npx vitest run` (backend) | **1 145 passés**, 0 échec |

### Critère A2, mesuré

| Volet | Exigence | Résultat |
|---|---|---|
| Bon candidat en tête quand la confiance est haute | ≥ 95 % | **100 %** sur les cas présélectionnés |
| Rattachement automatique sous le seuil | **0** | **0** |
| Bon candidat en tête sur tous les cas rattachables | — | **100 %** |
| Bon candidat en tête même quand il faut s''abstenir | — | **100 %** |

Jeu annoté : **23 cas**, couvrant les cinq situations que le § 7.3.5 exige nommément.

**Ce que cette mesure ne prouve pas** : les distances et orientations du jeu sont **données**,
non calculées. La géométrie est le travail de PostGIS et s''éprouve ailleurs. Le jeu mesure la
**décision**, qui est ce que le critère A2 nomme — et il est synthétique, donc il ne dit rien
du comportement du bruit GPS réel.

**Trois échecs au premier lancement**, dont un défaut de conception réel : voir le compte rendu
de lot. La séquence rouge puis verte du § 9.2 est respectée.

## 14/10/2026 — lot 2, référentiel linéaire

| Commande | Résultat |
|---|---|
| `npx tsc -p tsconfig.json --noEmit` (backend) | aucune erreur |
| `npx vitest run src/reseau/bitemporel.test.ts` | **32 passés** |
| `npx vitest run` (backend) | **1 105 passés**, 0 échec, 26,0 s |
| `npx prisma generate` | client généré, schéma valide |
| Contrôle « chaque dossier de migration porte un migration.sql » | **51 dossiers, 0 manquant** |

**Séquence rouge puis verte** (§ 9.2) : les 32 tests bitemporels ont été écrits avant le
module et ont d''abord échoué.

### Ce qui n''est PAS testé, et que je ne déclare pas testé

**La migration `20261014170000_historisation_bitemporelle` n''a été éprouvée ni en montée ni
en descente.** Le § 9.4 l''exige « sur une base de développement » ; il n''en existe aucune.
Mesuré le 14/10 : aucun `psql`, aucun service PostgreSQL, aucune installation PostgreSQL,
Docker Desktop injoignable et absent du chemin standard. C''est le blocage B-13, et le garde-fou
§ 2.1 interdit par ailleurs d''utiliser la production.

Le script de descente est écrit, relu et commenté — pas exécuté.

## 14/10/2026 — lot 1, socle

| Commande | Résultat |
|---|---|
| `npx tsc -p tsconfig.json --noEmit` (backend) | aucune erreur |
| `npx vitest run` (backend) | **1 073 passés**, 0 échec, 31,7 s |
| `npx tsc --noEmit` (frontend, via `npm run build`) | aucune erreur |
| `npx vitest run` (frontend) | **294 passés**, 0 échec, 29,3 s |
| `python -c "yaml.safe_load(ci.yml)"` | YAML valide, 3 jobs : backend, frontend, migrations |
| Contrôle « chaque dossier de migration porte un migration.sql » | **50 dossiers, 0 manquant** |
| Contrôle « aucun secret évident » | **51 fichiers scannés, 0 ligne suspecte** |

Total : **1 367 tests**, soit +18 sur le lot 0 (12 pour le formateur de PK, 6 pour la garde SQL).

**Séquence rouge puis verte, comme l''exige le § 9.2.** Les 12 tests du formateur de PK ont
d''abord échoué faute de module (`Test Files 1 failed, Tests no tests`), puis sont passés après
écriture de `lib/pk.ts`.

**La garde SQL a échoué à son premier lancement, et c''était son utilité.** Elle a signalé deux
fichiers que je n''avais pas examinés : `lib/geo.ts`, légitime et gardé par une liste blanche,
et `reseau/couverture.reseau.ts`, qui ne faisait que **citer** `$queryRawUnsafe` dans un
commentaire — un test qui confond une mention et un usage interdirait d''expliquer ses propres
corrections. Détection corrigée pour ignorer les commentaires.

## 14/10/2026 — lot 0, après la correction du § 7.1 (ADR-005)

| Commande | Résultat |
|---|---|
| `npx tsc -p tsconfig.json --noEmit` (backend) | aucune erreur |
| `npx vitest run` (backend) | **1 067 passés**, 77 fichiers, 0 échec, 22,3 s |
| `npx vitest run` (frontend) | **282 passés**, 22 fichiers, 0 échec |

Total : **1 349 tests**.

## 14/10/2026 — vérifications en base, avant le gel de production (ADR-001)

Ces mesures ne seront plus reproductibles : le § 2.1 coupe l'accès à la production.

| Vérification | Commande | Résultat |
|---|---|---|
| Migrations | `prisma migrate status` | 50 trouvées, « Database schema is up to date! » |
| Fusion des recouvrements de portions | SQL sur 8 cas littéraux, attendus calculés à la main | **8 OK** : disjoints 300 m, chevauchants 250 m, jointifs à 3 cm 200 m, séparés de 1 m 200 m, imbriqués 300 m, débordant borné 500 m, négatif borné 100 m, vide 0 |
| Couverture du réseau classé | SQL, `\timing on` | 1 691 tronçons, 21 156,6 km, **212 ms** |
| Couverture du registre complet | idem | 261 387 tronçons, 185 264,4 km, **3 286 ms** |
| Détecteur hors territoire, ancienne forme | `EXPLAIN (ANALYZE)` | **58 243 ms** |
| Détecteur hors territoire, forme déployée | `\timing on` | **14 229 ms**, même verdict (6 573 / 261 387) |
| Écart entre les deux formes | SQL comparatif | **1 tronçon** : `GNL-OSM-w321375684`, sentier de 55,8 m, 0 degré en planaire contre 3,247 m en géodésique |
| Santé après déploiement | `curl /api/health` | `status: ok`, base 8 ms, stockage 5 ms, `echecsDepuisDemarrage: 0` |
| Erreurs au journal backend | `docker logs … | grep -icE "error|unhandled"` | **0** |

## Ce qui n'est pas testé, et doit l'être

| Exigence | Manque |
|---|---|
| A2 identification du tronçon à ≥ 95 % | **aucun jeu de points GPS annotés** (B-26) |
| A5 métré, écart < 1 % | ~~aucune géométrie de test de référence~~ : jeu figé depuis le 22/10 (`geo/geometries-reference.ts`), voir la section du 22/10 |
| A7 hors ligne, 50 observations sans doublon | testé unitairement, jamais sur un appareil |
| A10 sécurité, 403 par appel direct | partiellement : les gardes de rôle sont testées, pas l'ABAC par zone |
| A15 performance, rattachement < 300 ms p95 | **jamais mesuré** |
| A16 à A19 roulage | sans objet : les fonctions n'existent pas |
| A18 trace HMM à ≥ 97 % | sans objet |
| A20 Géoportail, premier rendu < 3 s en 3G | **jamais mesuré** |
| Montée **et descente** des migrations (§ 9.4) | les migrations n'ont été éprouvées qu'en montée |

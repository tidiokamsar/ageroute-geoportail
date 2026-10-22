# Tests exécutés

> Exigé par le § 4 du mandat v2.1. Le § 2.7 impose que toute affirmation de réussite cite la
> commande lancée et son résultat. Aucune ligne de ce fichier n'est écrite sans l'avoir vue.

## 22/10/2026 — CI exécutée en local et S-4 éprouvé (T-29)

**Aucune exécution GitHub** : le compte est verrouillé pour facturation. Ces commandes sont celles
des jobs, lancées dans le conteneur de développement.

| Commande | Résultat |
|---|---|
| `verifier.sh --strict --garder` (job « descentes », toutes les migrations) | **242 vérifications, 0 échec, 0 migration sans descente** |
| `infra/ci/bancs-sql.sh` (nouvelle étape du job, sur la base de référence bâtie par la chaîne) | **14 bancs, 0 échec** |
| `infra/securite/s4-epreuve.sh` | **0 échec** : rôle réduit garde DML, DDL, PostGIS, `btree_gist` ; perd `CREATE ROLE`, `ALTER SYSTEM`, `COPY TO PROGRAM`, `pg_read_file`, `pg_authid`, l'auto-promotion ; retour arrière rétabli ; `CREATE EXTENSION postgis` refusé (non trusted) |

## 22/10/2026 — contrôle d'accès territorial des huit domaines (A10, T-28)

Branche `lot/14-observation-terre`, base `replay`.

| Commande | Résultat |
|---|---|
| `npx vitest run src/territoire` | **18 passés** : règle pure (national, régional, région inconnue) ; fabrique CRUD (création, modification avant/après, archivage en masse par ligne, restauration, compte introuvable) ; garde `requireTerritoire` (403 `HORS_PERIMETRE`, `REGION_INCONNUE`, aucune lecture pour un compte national) ; synchronisation par opération |
| `npx vitest run src/api-v2/perimetres.routes.test.ts` | **4 passés** : ADMIN seul, ADMIN non restreignable, région inconnue refusée, remplacement audité, compte national par défaut compté |
| `psql … -f backend/prisma/tests/perimetres_comptes.test.sql` | **5 assertions** : rien de semé, double rattachement refusé, auteur obligatoire, région rattachée non supprimable, cascade à la suppression du compte |
| `verifier.sh --seulement 20261022030000_perimetres_territoriaux` | **4 vérifications, 0 échec** : descente, aller-retour, garde refuse avec données, passe avec autorisation |
| `npx vitest run` (backend complet) | **110 fichiers, 1 574 passés**, 0 échec (avant correction : 92 échecs dans 6 fichiers de routes dont le faux `prisma` ne connaissait pas le périmètre ; corrigé en y déclarant le compte national) |
| `npx tsc -p tsconfig.json --noEmit` | aucune erreur |

## 22/10/2026 — partie E (A30) : cohérence et banc de performance (T-27)

Branche `lot/14-observation-terre`, base `replay` (PostGIS 3.5.2, GEOS 3.9).

| Commande | Résultat |
|---|---|
| `psql … -f backend/prisma/tests/teledetection_coherence.test.sql` | **7 assertions** : hors emprise du produit refusée, hors emprise de la référence refusée, référence postérieure refusée, comparaison antérieure acceptée, vue vide sur données cohérentes, quatre anomalies nommées sur une ligne ancienne |
| `psql … -f backend/prisma/tests/observation_terre.test.sql` | **15 assertions**, toutes passent après la migration |
| `psql … -f backend/prisma/tests/observation_terre.bench.sql` | 261 387 segments **synthétiques** ; plan sur `troncons_geom_geography_idx` ; dépôt de 1 000 propositions 3 485 ms (3,49 ms chacune), sans contrôle 3 105 ms (0,38 ms de déclencheur) ; 1 042 rattachées sur 2 000 ; précision 28,6 ms (0,667, juste) ; compteur A_VERIFIER 1,6 ms ; cohérence 79,9 ms, 0 anomalie. Durées de ce poste, pas de la production |
| `verifier.sh --seulement 20261022020000_teledetection_coherence` | **2 vérifications, 0 échec** : descente au schéma d'avant, aller-retour identique |
| `npx vitest run src/teledetection src/api-v2/teledetection.routes.test.ts` | **34 passés** (dont 6 nouveaux : deux dates, `REFERENCE_INEXISTANTE`, `HORS_EMPRISE` en 400) |
| `npx tsc -p tsconfig.json --noEmit` (backend) | aucune erreur |

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
| A5 métré, écart < 1 % | aucune géométrie de test de référence |
| A7 hors ligne, 50 observations sans doublon | testé unitairement, jamais sur un appareil |
| A10 sécurité, 403 par appel direct | partiellement : les gardes de rôle sont testées, pas l'ABAC par zone |
| A15 performance, rattachement < 300 ms p95 | **jamais mesuré** |
| A16 à A19 roulage | sans objet : les fonctions n'existent pas |
| A18 trace HMM à ≥ 97 % | sans objet |
| A20 Géoportail, premier rendu < 3 s en 3G | **jamais mesuré** |
| Montée **et descente** des migrations (§ 9.4) | les migrations n'ont été éprouvées qu'en montée |

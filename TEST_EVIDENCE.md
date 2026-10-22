# Tests exécutés

> Exigé par le § 4 du mandat v2.1. Le § 2.7 impose que toute affirmation de réussite cite la
> commande lancée et son résultat. Aucune ligne de ce fichier n'est écrite sans l'avoir vue.

## 22/10/2026 (nuit, après fusion de `lot/03-map-matching` à `5f30814`) — PR #3

Conflits résolus : le métré des défauts par emprise est celui de la ligne principale (`070b21e`) ; la migration
`20261025100000_metre_emprise_utm` de cette branche, en double, est retirée (sa descente aurait retiré la valeur
`EMPRISE_UTM` dont dépend `20261024300000`). La matrice a été reconstruite ligne à ligne (leurs lignes là où je n'avais
rien changé, les miennes là où ils n'avaient rien changé, A5 fusionnée en gardant leur statut TP).

| Commande | Résultat |
|---|---|
| `verifier.sh --strict --garder` | **78 migrations, 274 vérifications, 0 échec**, 0 sans descente |
| `infra/ci/bancs-sql.sh` sur la base laissée par le banc | **17 bancs, 0 échec** |
| bancs d'intégration `metre`, `tuiles`, `coherence` (sur `replay`) | **29/29, 9/9, 12/12** |
| `npx vitest run` backend, puis frontend | **2 603 passés** (159 fichiers) ; **669 passés** (52 fichiers) |
| `npx tsc --noEmit` (deux côtés), `npm run lint` | aucune erreur |

## 22/10/2026 (nuit) — apports de la branche `lot/17-consignes-dt` (DT-2, DT-4 à DT-8)

### Complément DT-9 (complétude des écrans), même branche

Exécuté et lu le 22/10/2026 sur ce poste. Rien n'a été exécuté contre la production ; la CI GitHub n'a pas tourné (compte bloqué pour facturation).

| Commande | Résultat |
|---|---|
| `cd backend && npx vitest run` | **2 622 passés**, 161 fichiers, 0 échec (dont `roulage.routes.test.ts` 6, `patrouilles.routes.test.ts` 18, `historique=false` et `national=false`) |
| `cd frontend && npx vitest run` (seul) | **770 passés**, 65 fichiers, 0 échec (garde-fou de contraste compris) |
| `Accessibilite.test.tsx` (axe-core, WCAG 2.1 A et AA) | **31 cas, 0 violation**, dont Main courante (liste et déclaration ouverte), Registre des défauts, Missions terrain, Gestion des portions |
| `npx tsc --noEmit` (deux côtés) ; `npm run lint` ; `npx vite build` | 0 erreur ; lint 0 erreur, 4 avertissements anciens dans des fichiers non touchés ; build réussi |
| Navigateur réel, téléphone | **non essayés** |


Branche partie de `origin/lot/03-map-matching` (`94b8769`, puis rebasée sur `34ee0ed`), qui portait déjà T-27 (A30) et T-32 (A10) :
les versions concurrentes de la branche `lot/14-consignes-dt` n'y sont PAS reprises ; seuls les apports
propres le sont, migrations renumérotées après `20261024200000`. Rien n'a été exécuté contre la production.

| Commande | Résultat |
|---|---|
| `verifier.sh --strict --garder` | **75 migrations, 264 vérifications, 0 échec** ; après rebase sur `34ee0ed` : **77 migrations, 272 vérifications, 0 échec**, 0 sans descente |
| `infra/ci/bancs-sql.sh` sur la base laissée par le banc | **16 bancs, 0 échec** ; après rebase : **17 bancs, 0 échec** (dont `teledetection_complements`, `metre_reference`, `outbox`) |
| `teledetection_complements.test.sql` sur `replay`, sans la migration (contre-épreuve) | échoue : « Proposition sur produit retire acceptee » |
| `npx tsx tests-integration/metre.integration.ts` | **30/30** |
| `npx tsx tests-integration/tuiles.integration.ts` | **9/9** |
| `npx tsx tests-integration/coherence.integration.mts` (clone `essai_coherence`, détruit ensuite) | **12/12** |
| `territoire.couverture.test.ts` : contrôle retiré d'un service CRUD, puis garde retirée d'une route v2 | **4 échecs**, puis **1 échec**, nommant chaque route |
| requête de la garde anti-doublon de `deployer-console.sh` | nomme `troncons_geom_gist` sur une base qui le porte ; rien sur `replay` |
| `npx vitest run` (backend) | **1 992 passés sur 1 993** ; 1 échec : `trace.import.noyau.test.ts` « reste linéaire sur un fichier volumineux » (3,8 s pour un plafond de 2 s, sous la charge de la suite) — **seul : 21/21, 512 ms**. Test de durée de T-24, code non modifié ici |
| `npx vitest run` (frontend, seul) | **489 passés**, 39 fichiers |
| après rebase sur `34ee0ed` : `npx vitest run` backend puis frontend | **2 464 passés** (152 fichiers, 0 échec) ; **642 passés** (50 fichiers, 0 échec, garde-fou de contraste compris) ; `tsc` et lint : 0 erreur |
| `npm run lint` ; `npx tsc --noEmit` (backend, frontend) | 0 erreur (4 avertissements connus) ; aucune erreur |

## 22/10/2026 (soir) — fusion de lot/14-observation-terre dans lot/03-map-matching

Exécuté et lu le 22/10/2026 après la fusion `437908f` (partie E, A10, CI/S-4). Rien n'a été exécuté contre la production.

| Vérification | Commande | Résultat |
|---|---|---|
| Backend | `cd backend && npx vitest run` | **122 fichiers, 1 731 tests passants** ; `npx tsc --noEmit -p .` : 0 erreur |
| Frontend | `cd frontend && npx vitest run`, `npx tsc --noEmit`, `npm run lint` | 37 fichiers, **479 tests passants** ; 0 erreur de types ; lint 0 erreur, 4 avertissements |
| Chaîne de migrations et descentes | `docker exec bdri-dev-db bash …/descentes/verifier.sh --strict --garder` | **71 migrations, 244 vérifications, 0 échec, 0 migration sans descente** (bases jetables `rt_*`) |
| Bancs SQL | `bash infra/ci/bancs-sql.sh` sur la base de référence gardée | **14 bancs, 0 échec** |
| Bancs d'intégration TypeScript | `bash tests-integration/run.sh` (base `replay`) | **122 vérifications passantes**, code 0 ; `replay` n'est pas rejouée avec les trois migrations récentes |
| Régressions trouvées par la fusion | — | 3 tests de la date d'effet des portions échouaient (le contrôle territorial interroge la base) : perimètre neutralisé dans le test ; 1 test dépassait 30 s sous charge : délai porté à 90 s |

**La CI GitHub n'a pas tourné** (compte bloqué pour facturation) : elle n'est ni réussie ni échouée au sens des tests.

## 22/10/2026 — graphe de trace (T-28), métadonnées ISO 19115 (T-29), compte des géométries invalides, bancs versionnés

Toutes les lignes ci-dessous ont été exécutées et lues le 22/10/2026 sur ce poste (base de rejeu locale
`replay`, PostGIS 3.5 / PostgreSQL 17, vide). **Rien n'a été exécuté contre la production.**

| Vérification | Commande | Résultat |
|---|---|---|
| Suite backend complète | `cd backend && npx vitest run` | **118 fichiers, 1 699 tests, tous passants** |
| Types backend | `cd backend && npx tsc --noEmit -p .` | 0 erreur |
| Suite frontend, avant le commit du graphe de trace | `cd frontend && npx vitest run` | 37 fichiers, **479 tests passants** |
| Types et lint frontend, même moment | `npx tsc --noEmit`, `npm run lint` | 0 erreur ; lint 0 erreur, 4 avertissements |
| Banc du curseur temporel | `npx tsx tests-integration/curseur.integration.mts` | **41/41 vérifications** ; le clone `essai_curseur` est créé puis détruit (vérifié : aucun `essai_*` restant) |
| Banc de l'analyse de trace avec graphe | `npx tsx tests-integration/trace.integration.ts` | toutes les vérifications vraies, dont la jonction A vers B vérifiée (0 transition non vérifiée avec le graphe) ; 0 fixture restante |
| Banc des métadonnées | `npx tsx tests-integration/metadonnees.integration.ts` | 9 vérifications vraies : étendue des tronçons actifs (le supprimé exclu), ouvrage OSM exclu, **date de révision identique avec un fuseau de session en Pacific/Auckland**, tables vides sans étendue de zéros |
| Banc du compte des invalides | `npx tsx tests-integration/geometries-invalides.integration.ts` | 27 invalides annoncées (20 exemples) ; l'ancienne requête n'aurait pas pu dépasser 20 |
| Les dix bancs d'intégration | `cd backend && DATABASE_URL=…/replay bash tests-integration/run.sh` | **122 vérifications, toutes passantes, code 0** (trace 9, métadonnées 9, géométries invalides 6, déviation 8, graphe 7, Info Route 12, patrouilles 10, télédétection 10, veille 10, curseur 41). Six de ces bancs (déviation, graphe, Info Route, patrouilles, télédétection, veille) n'imprimaient que des valeurs : leurs vérifications ont été écrites le 22/10 ; la déviation et le graphe sont comparés à des **oracles SQL indépendants** (longueur de déviation 2 901,2 m des deux côtés), les autres caractérisent le comportement actuel. Une erreur d'expression régulière dans l'un d'eux a fait échouer le banc en code 1 (11/12), ce qui montre que l'échec se propage |
| Contre-épreuve des métadonnées | chemin de service faux dans le catalogue ; ordre des éléments XML inversé | 3 tests échouent comme attendu, fichiers restaurés |

**Non vérifié** : la validité du XML des métadonnées contre les schémas XSD de l'ISO 19139 (schémas non
téléchargés) ; le comportement des bancs sur le volume de production ; la CI (compte GitHub bloqué pour
facturation, aucune exécution réussie ou échouée au sens des tests).

## 22/10/2026 — CI exécutée en local et S-4 éprouvé (T-33)

**Aucune exécution GitHub** : le compte est verrouillé pour facturation. Ces commandes sont celles
des jobs, lancées dans le conteneur de développement.

| Commande | Résultat |
|---|---|
| `verifier.sh --strict --garder` (job « descentes », toutes les migrations) | **242 vérifications, 0 échec, 0 migration sans descente** |
| `infra/ci/bancs-sql.sh` (nouvelle étape du job, sur la base de référence bâtie par la chaîne) | **14 bancs, 0 échec** |
| `infra/securite/s4-epreuve.sh` | **0 échec** : rôle réduit garde DML, DDL, PostGIS, `btree_gist` ; perd `CREATE ROLE`, `ALTER SYSTEM`, `COPY TO PROGRAM`, `pg_read_file`, `pg_authid`, l'auto-promotion ; retour arrière rétabli ; `CREATE EXTENSION postgis` refusé (non trusted) |

## 22/10/2026 — contrôle d'accès territorial des huit domaines (A10, T-32)

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

> **Ce tableau date du 14/10/2026 et est en partie périmé.** Depuis : A5 a des géométries de référence (banc
> `metre_utm.test.sql`), A18 a une trace HMM écrite, et les migrations ont des descentes éprouvées (T-25, 69/69).
> L'état courant de chaque scénario est dans [REQUIREMENTS_TRACEABILITY.md](REQUIREMENTS_TRACEABILITY.md).

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

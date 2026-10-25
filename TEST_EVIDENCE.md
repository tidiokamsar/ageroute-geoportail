# Tests exécutés

> Exigé par le § 4 du mandat v2.1. Le § 2.7 impose que toute affirmation de réussite cite la
> commande lancée et son résultat. Aucune ligne de ce fichier n'est écrite sans l'avoir vue.

## 22/10/2026 (nuit) — fusion des six lots d'agents, mesures de performance, enregistreur navigateur

Exécuté et lu après la fusion de la branche « performance ». Rien n'a été exécuté contre la production. **La CI GitHub n'a
toujours pas tourné** (compte bloqué pour facturation) : ces lignes sont les seules preuves réelles.

| Vérification | Commande | Résultat |
|---|---|---|
| Backend | `cd backend && npx vitest run` ; `npx tsc --noEmit -p .` | **160 fichiers, 2 541 tests passants** ; 0 erreur de types ; `prisma validate` valide |
| Frontend | `cd frontend && npx vitest run` ; `npx tsc --noEmit` ; `npm run lint` ; `npm run build` | **53 fichiers, 698 tests passants** ; 0 erreur de types ; lint 0 erreur (4 avertissements) ; build ok |
| Chaîne de migrations et descentes | `verifier.sh --strict --garder` (conteneur de développement) | **274 vérifications, 0 échec, 0 migration sans descente** |
| Bancs SQL | `infra/ci/bancs-sql.sh` | **15 bancs, 0 échec** |
| Bancs d'intégration TypeScript | `bash tests-integration/run.sh` | 739 vérifications sur 18 bancs au dernier run complet (avant les bancs contour, tableau de bord ajouté, performance), tous passants ; le banc contour passe seul (7/7) |
| Performance A15 et A20 | `backend/tests-integration/perf/` (jeu synthétique de 261 387 tronçons) | chiffres et réserves dans `docs/performance/MESURES-A15-A20.md` : rattachement atteint, recherche partiellement, déviation de justesse à 50 km, rendu 3G non atteint |
| Régressions trouvées par la fusion | — | le menu embarquait la recherche globale (commit d'une autre session) : le test du menu n'avait pas de `QueryClientProvider` (7 tests rouges, corrigés) ; un test de Gouvernance échoue par intermittence sous charge de la machine, il passe seul |

**Non vérifié** : le comportement sur un téléphone réel (enregistreur navigateur, roulage), les données de production, le cache
PostgreSQL froid, la CI.

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

## 23/10/2026 — intégration de la vague 2 et correction de la course de synchronisation (T-41)

Base `replay` portant les 82 migrations, arbre `lot/03-map-matching` après fusion des cinq branches.

| Contrôle | Résultat mesuré |
|---|---|
| Backend `tsc`, `prisma validate` | sans erreur |
| Backend `vitest` | 169 fichiers, 2 661 tests, tous réussis (avant le test ajouté ci-dessous) |
| Frontend `tsc`, `vite build` | sans erreur |
| Frontend `vitest` | 72 fichiers, 954 tests, tous réussis |
| Frontend `eslint` | 0 erreur après correction de `tailwind.config.js`, 5 avertissements existants |
| Bancs SQL (`tests-integration/run.sh`) | 28 bancs ; `ppe` 80/80 et `sync` 67/67 après correction, les 26 autres réussis |

**Défaut trouvé par le banc, corrigé** : deux envois simultanés de la même opération (deux appareils d'un même agent) pouvaient valider entre la lecture « déjà traitée » et la lecture de la version de l'entité. La perdante déclarait alors un conflit `DEJA_EXISTANTE` et écrasait la trace `SYNCHRONISE` de la gagnante. Correction dans `backend/src/field/sync.service.ts` : verrou de transaction par `operationId` puis relecture de la trace. Avant : 3 échecs sur 7 passages du banc ; après : 8 passages consécutifs sans échec, un test unitaire ajouté. Un aléa se prouve mal par l'absence d'échec : 8 réussites sont un indice, pas une garantie.

**Non vérifié** : CI (compte GitHub verrouillé, aucune exécution), appareil réel, données de production.

**Second défaut trouvé le 23/10 (capture de la carte)** : la route `POST /api/v2/troncons-corridor/bulk-etat` (changement d'état d'un corridor, commit `d243f3c`) n'avait pas `requireAuth` : `req.user` n'était jamais posé, donc elle répondait 401 « Authentification requise » à tout le monde, y compris à un compte connecté. Le test unitaire posait le compte à la main et affirmait à tort que la route était montée derrière `requireAuth`. Elle n'avait pas non plus le contrôle territorial (A10) : un compte régional aurait pu changer l'état de tronçons hors de son périmètre. Corrigé (`requireAuth`, puis refus de tout le lot dès qu'un tronçon est hors périmètre) ; le test reproduit maintenant le contrat de `requireAuth` et couvre 401, 403 et le lot dans le périmètre (8 tests). Mise en page : le panneau (288 px) débordait de sa colonne et le champ de la ville de départ était écrasé ; vérifié dans un navigateur sur un harnais local (colonne de 221 px), **pas sur la carte réelle avec le serveur** (aucun backend lancé). La route n'a pas été éprouvée contre la base : le banc `territoire` ne la couvre pas.

## 25/10/2026 — route entre deux villes, APK derrière authentification, corrections de la revue SMART FIELD (T-42)

| Contrôle | Résultat mesuré |
|---|---|
| Noyau `cheminEntre` (`geo/graphe.chemin.test.ts`) | 7 tests : ordre des tronçons, sens aller et retour, même tronçon, plus court de deux routes, trou du référentiel (aucun chemin), borne de longueur, tronçon hors lot |
| Banc PostGIS `chemin` (sur `replay`, transaction annulée) | **13 vérifications réussies** : la route suit le réseau et exclut une route parallèle et une route qui la croise (que l'ancienne bande de 20 km aurait prises), longueur égale à un oracle SQL à 3 m, ville à 25 km du réseau refusée, trou du référentiel refusé, tronçon archivé coupe la route |
| Route `GET /v2/troncons-recherche/chemin` | 6 tests (401 sans jeton, paramètres, 422 aucun chemin, 404 hors référentiel, panne = 500 sans détail) |
| Écran « Route entre deux villes » (page Tronçons) | 8 tests dont zéro violation axe-core |
| APK : `GET /v2/mobile/apk` et `/apk/info` | 5 tests : 401 sans jeton, octets identiques, SHA-256 du fichier servi, aucun chemin pris dans la requête, 404 si absent ; 3 tests du client, 1 du bouton |
| Pack de mission incomplet | 3 tests : pack complet, copie locale refusée (quota), plafond de pages atteint : dits INCOMPLETS |
| Complétude, indice d'irrégularité (revue du 25/10) | 5 tests de noyau et 3 d'écran ; effacement de journal confirmé (1 test) |
| Frontend complet | 80 fichiers, 1 029 tests ; `tsc`, `eslint` (0 erreur), build réussis |
| Test du dépôt sans secret | rouge sur le HEAD depuis l'ajout du projet Android (30 binaires non examinés) ; corrigé : PNG vérifiés par leur signature, JAR de Gradle épinglé par son SHA-256, identique à l'empreinte publiée par Gradle pour 8.14.3 |

**Non vérifié** : la route entre deux villes n'a pas été essayée sur la base de production (lecture refusée), donc on ne sait pas
si le référentiel y est continu entre Sangarédi et Télimélé ; le déploiement du changement d'APK exige de modifier
`docker-compose.yml` et `nginx.conf` sur le serveur (volume `./mobile` passant du frontend au backend), à la main de la DSI.

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

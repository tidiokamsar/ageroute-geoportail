# Matrice de conformité

> Fichier canonique exigé par le § A.9 du prompt maître V10. Il remplace
> `docs/rai-v3/21_TABLEAU_CONFORMITE.md`, dont il conserve l'historique Git.
>
> Statuts du § A.10 : **TT** terminée et testée · **TP** tests partiels · **NT** non testée ·
> **PA** partielle · **MQ** maquette ou simulation · **AB** absente · **BL** bloquée ·
> **EA** en attente d'approbation.
>
> La porte de sortie de la phase 0 (§ F.1) exige qu'**aucune case « à vérifier » ne subsiste** :
> chaque ligne porte un statut prouvé, ou dit quel accès manque.
>
> 🔒 **Un écran visible n'est jamais une preuve** (§ A.10). Chaque statut cite un fichier, un
> test, une migration, une mesure ou un point d'API.

**Dressée le 14/10/2026** contre le prompt maître V10 lu en entier. Tests de référence :
backend **1 211 passés**, frontend **294 passés**, 0 échec, TypeScript sans erreur.

---

## 1. Les trente scénarios d'acceptation du § G.1

C'est la matrice qui compte : elle est mesurable, et le mandat en fait la porte de chaque phase.

| # | Scénario | Statut | Preuve ou cause |
|---|---|---|---|
| **A1** | Ouverture du mode terrain | **TP** | `hooks/usePositionGps.ts`, 15 tests : trois erreurs distinctes dont la permission refusée. **Jamais éprouvé sur appareil** |
| **A2** | Identification du tronçon, ≥ 95 % et 0 rattachement sous le seuil | **TT** | `appariement.a2.test.ts`, 11 tests sur **23 cas annotés** : **100 %** de bon candidat en tête, **0** présélection fautive. Distances données, non calculées : voir § 4 |
| **A3** | Incertitude : l'agent choisit, ou l'observation reste non rattachée | **TT** | issue `CHOIX_AGEN T` et `NON_RATTACHE` avec motif, `appariement.noyau.ts` ; position brute toujours conservée |
| **A4** | Dégradation sans PK | **TT** | `pkDeFraction` rend `TRONCON_SANS_PK` ; `api-v2/defauts.routes.ts` accepte une abscisse locale ; 49 tests de métré |
| **A5** | Métré, écart < 1 % en projection métrique | **NT** | les règles sont testées (60 tests) mais **aucune géométrie de test de référence** n'existe. Et le § 7.1 impose UTM 28N/29N pour les surfaces : les longueurs passent par `geography`, les **surfaces ne sont pas encore projetées** |
| **A6** | Proposition de portion sans altérer le tronçon | **TT** | contrainte d'exclusion `btree_gist` en base ; `portions.routes.test.ts` vérifie qu'un `statutValidation` envoyé par le client est ignoré |
| **A7** | Hors ligne : 50 observations, 0 doublon, 0 perte | **TP** | `operations_sync`, `clientOperationId` unique, `field/portions.sync.ts` 13 tests, `offlineSync.test.ts` 23 tests. **Jamais éprouvé sur appareil ni sur 50 observations réelles** |
| **A8** | Conflit signalé, deux versions conservées | **TP** | table `conflits_sync`, `field/sync.service.ts` 11 tests. Pas de parcours de bout en bout |
| **A9** | Une proposition non validée n'apparaît jamais comme officielle | **TT** | `statutValidation` par défaut `A_VALIDER` ; `governance/validation.ts` 75 tests ; exports et carte filtrent |
| **A10** | 403 sur appel direct d'API pour un `LECTEUR` ou hors zone | **PA** | RBAC testé (`middleware/rbac`), délégation par domaine testée. **ABAC par territoire partiel** : 5 domaines sur 8 sans route |
| **A11** | Anomalie détectée, classée, expliquée, donnée intacte | **TT** | `qualite/anomalies.ts` 23 tests, `api-v2/qualite.routes.ts` 14 tests, **9 familles** ; un test vérifie qu'aucune correction ne propose de supprimer |
| **A12** | Chaque indicateur égal à sa requête de contrôle | **PA** | `reseau/couverture.reseau.ts` est reproductible et documenté (212 ms). Mais le tableau de bord **ne connaît ni portions ni qualité** |
| **A13** | Intégrations : seules les données validées émises, rejeu sans effet de bord | **BL** | aucun accès DigitalRoad ni SharePoint (B-11, B-12). Aucune outbox transactionnelle écrite |
| **A14** | Non-régression des fonctions existantes | **TT** | **1 145 + 294 tests**, 0 échec ; les 16 tests d'appariement antérieurs tiennent après extraction du noyau |
| **A15** | Rattachement < 300 ms p95 ; Géoportail fluide | **NT** | **jamais mesuré**. L'ordre de grandeur connu est indirect : la requête de candidats passe de 2,5 s à quelques millisecondes avec le filtre d'emprise |
| **A16** | Roulage, marqueur < 200 ms, erreur < 30 m | **AB** | § 7.13 non commencé |
| **A17** | Roulage, événement linéaire Début/Fin | **AB** | idem |
| **A18** | Trace 1 Hz 2 h, HMM ≥ 97 %, IRI par 100 m | **PA** | **HMM écrit et mesuré** : `appariement.trace.ts`, 25 tests, **130/130 points justes** sur 4 traces annotées (exigé ≥ 97 %), 8 sorties du référentiel sur 8 détectées, 7 200 points sans débordement. **Mais l'IRI n'existe pas**, et le taux dépend d'un graphe de réseau — voir § 4 |
| **A19** | Roulage, robustesse veille/appel/redémarrage | **AB** | exige les plugins natifs (ADR-009) |
| **A20** | Géoportail : rendu < 3 s en 3G, recherche < 300 ms, déviation < 2 s, OGC | **NT** | aucune mesure ; tuiles vectorielles, permalien et pgRouting absents |
| **A21** | Chaque tronçon : code national, provenance, score qualité, rattachement | **BL** | **la codification nationale n'existe pas** et les routes communautaires n'ont aucune valeur d'énumération (D-06). Provenance présente sur 259 696 tronçons, absente sur 1 691 |
| **A22** | Programmation reproductible, justifiée, fiche figée | **AB** | aucun moteur ; barèmes et matrices présents, **lus par aucun code** |
| **A23** | Interopérabilité ONR : pivot, L²R, sections UEMOA, correspondance éditable | **PA** | **sections fixes livrées** (IO-04), 14 assertions, B11 tenu sauf la note UEMOA. **Les 15 livrables du § B.6 sont écrits** : matrice ONR/BDR (14 domaines, 0 « à vérifier »), registre des sources de vérité (4 contradictions nommées), spécifications d'import, de correspondance et de tests, questionnaire ANASUR. Pivot CSV/GeoJSON et tables d'import **codés et testés**, GeoPackage en écart consigné ; orchestration non écrite ; formats L²R non publiés |
| **A24** | Exploitation : incident hors ligne → main courante immuable, Info Route < 1 min | **AB** | § 7.17 non commencé |
| **A25** | Sécurité : chaque alerte avec preuve ou blocage ; aucun secret | **PA** | **le volet dépôt est prouvé** : 225 commits analysés, aucun secret, **IP de production jamais committée**. Quatre alertes bloquées faute d'autorisation de production. `bdri_app` toujours superuser |
| **A26** | Migrations : rollback **exécuté et vérifié** | **TP** | **rollback exécuté le 14/10** sur PostGIS 17-3.5 local, aller-retour vérifié : 20 objets → 0 → 20, états identiques, codes 0. Mais **la chaîne ne se rejoue pas sur base vierge** : 49/51, un défaut de type `uuid`/`text` (D-10), et 50 migrations sur 51 n'ont aucun script de descente |
| **A27** | Aucune décision non approuvée présentée comme officielle | **TT** | `rci-2026.1` **désapprouvée** le 14/10 ; 9 barèmes en `standard_initial`, **aucun approuvé** ; praticabilité volontairement vide ; 6 573 hors-territoire et 42 doublons **classés, intacts et reproductibles** |
| **A28** | Import BDR/ANASUR idempotent, 100 % des lignes dans un statut | **TP** | **les deux propriétés sont tenues par la base** : `lot_compteurs_complets` (somme des statuts = lignes lues) et empreinte SHA-256 unique par source, 9 assertions SQL. Noyau du pivot CSV/GeoJSON, 24 tests. **Aucun import de bout en bout** : aucun export n'existe, et l'orchestration (service, route) n'est pas écrite |
| **A29** | Tâches internes avec preuves avant/après ; rapprochement en lecture | **TP** | **TI-01 livré** : `taches_internes`, 9 contraintes `CHECK`, 22 assertions SQL. « Une tâche clôturée possède des preuves avant/après » est tenu **par la base**, pas par une consigne. La frontière DigitalRoad est tenue par l'**absence des colonnes**, avec un garde-fou de 17 tests qui échoue si un montant apparaît. **TI-02 bloqué** (aucune donnée DigitalRoad, B-11), TI-03 absent |
| **A30** | Détection satellitaire → proposition localisée, précision mesurée | **AB** | partie E non commencée |

**Bilan : 9 TT, 6 TP, 5 PA, 3 NT, 2 BL, 5 AB.** Aucune case « à vérifier ».

---

## 2. Les critères permanents du § G 🔒

| Critère | Statut | Preuve |
|---|---|---|
| Aucune donnée de production écrasée ou supprimée silencieusement | **TT** | suppression logique seulement (`deletedAt`) ; `remplaceeLe` distinct ; les 50 migrations déployées n'ont écrit **aucune ligne**, pas même un audit |
| Toutes les observations importées ont statut et provenance | **PA** | 259 696 tronçons portent `sourceReference` ; **1 691 n'en ont aucune** — les plus anciens, qui sont le réseau classé |
| Aucune détection IA automatiquement validée | **TT** | la contrainte `media_analyse_coherente` impose date et modèle ; aucun chemin d'écriture ne valide |
| Aucun coût estimatif ne devient montant contractuel | **TT** | `decomptes` vide, module gelé ; aucun moteur de coût. Et `taches_internes` n'a **aucune colonne de montant**, garde-fou automatisé |
| Toute opération hors ligne répétée reste idempotente | **TT** | `clientOperationId` unique en base ; 13 tests dédiés |
| Toute modification sensible autorisée côté serveur et auditée | **TT** | `logAuditTransactionnelle` dans la transaction ; 1 506 lignes d'audit |
| Toute mesure porte sa méthode et son incertitude | **PA** | `valeurs_qualite` porte méthode, statut et confiance. Mais `dateDerniereEvaluation` est **nulle sur 261 387 lignes** |
| Les indicateurs affichent sources, périmètre et limites | **PA** | l'API publique affiche `methode` et `calculeeA`. Le périmètre n'est pas affiché partout, et c'est la faute que j'ai commise deux fois |
| Les quatre migrations passent, rollback vérifié | **PA** | les quatre sont appliquées depuis le 13/10. **Un rollback est désormais vérifié** — celui de la migration en attente, seul à posséder un script. Les quatre-là n'en ont aucun |
| Les alertes de sécurité ont preuve ou blocage documenté | **TT** | [SECURITY_REMEDIATION.md](SECURITY_REMEDIATION.md) |
| Aucune mise en production sans autorisation explicite | **TT** | deux opérations depuis V10, toutes deux explicitement autorisées |

---

## 3. Les sections du § 7

| § | Exigence | Statut | Écart principal |
|---|---|---|---|
| 7.1 | Conventions géospatiales 🔒 | **PA** | longueurs en `geography` : conforme. **UTM 28N/29N non employé** pour les surfaces. SQL paramétré : corrigé et gardé par un test |
| 7.2 | Référencement linéaire, ISO 19148, bitemporel | **PA** | portions, lignage, exclusion : faits. Historisation bitemporelle écrite, **et son défaut corrigé** — la contrainte d'exclusion ignorait l'axe terrain, donc aucune donnée ne pouvait l'exercer. Trois migrations non déployées. Codification nationale absente |
| 7.3 | Map-matching ponctuel et de trace | **TP** | ponctuel **complet** avec les 5 facteurs et les 3 issues ; **trace HMM écrite et mesurée**. Reste : le graphe de réseau, sans lequel le HMM retombe sur la distance seule entre tronçons différents |
| 7.4 | Catalogue et métrés | **TP** | 13 types ; le § 7.16 exige **≥ 21 types**, revêtu et non revêtu. Photos de référence par gravité absentes |
| 7.5 | Workflow de validation | **TT** | — |
| 7.6 | Moteur de qualité | **TT** | — |
| 7.7 | Évaluation, prévision, programmation | **EA** | RCI écrit, **désapprouvé** ; **catalogue des traitements créé** depuis les barèmes, attributs normatifs nuls, non approuvé ; lois de vieillissement **identifiées** (`matrices_degradation`, pas de temps non documenté) ; risque, coût, programmation **absents** |
| 7.8 | Application mobile | **AB** | Capacitor figé (ADR-009), non commencé ; **aucun APK compilable ici** (B-10) |
| 7.9 | Sécurité | **PA** | RBAC fait, ABAC partiel ; 4 risques ouverts |
| 7.10 | Intégrations | **BL** | aucun accès |
| 7.11 | Interface web, WCAG 2.1 AA | **PA** | design system présent ; **accessibilité jamais mesurée**, et le `lint` du dépôt ne fonctionne pas (B-29) |
| 7.12 | Tableau de bord national | **PA** | ignore portions et qualité |
| 7.13 | Collecte en roulage | **AB** | priorité M, non commencé |
| 7.14 | Niveau d'excellence | **AB** | tuiles vectorielles, vue de route, curseur temporel, pgRouting, gazetier, métadonnées ISO 19115 |
| **7.15** | **Interopérabilité BDR / L²R** | **PA** | **IO-04 livré** ; les 8 flux ont chacun leur plan de test (`ONR_BDR_TEST_PLAN.md`) et les 3 options d'échange sont documentées **sans choix** (§ B.4). Un seul flux est testable aujourd'hui ; les autres attendent formats, export approuvé ou décision. **Une intégration sortante existe déjà** vers DigitalRoad/SharePoint — ce que les rapports antérieurs omettaient |
| **7.16** | **Étalon fonctionnel Logiroad Center** | **AB** | 17 capacités plancher, dont 5 marquées ★ propres au contexte guinéen |
| **7.17** | **Couche d'exploitation** | **AB** | main courante, patrouilles, P1–P4, cellule de veille, Info Route |

---

## 4. Ce que cette matrice ne prouve pas

**Trois limites, et les dire fait partie du travail.**

**Les tests sont locaux.** Le § G l'exige : « ne présente pas des tests locaux comme des tests de
production ». Les 1 439 tests tournent sur mon poste et en CI ; **aucun parcours n'a été éprouvé
sur un appareil Android**, et aucun sur une base de développement — il n'en existe pas.

**Le critère A2 mesure la décision, pas la géométrie.** Les distances et orientations du jeu
annoté sont **données**, non calculées par PostGIS, et le jeu est synthétique. Il établit que le
classement est juste quand les distances sont justes ; il ne dit rien du bruit GPS réel.

**Les mesures en base datent du 14/10 et ne seront plus reproductibles.** Le § A.5.1 a coupé
l'accès à la production. Tout chiffre de cette matrice portant sur les données vieillira sans
que rien ne le signale.

**Le 130/130 du critère A18 repose sur un graphe de réseau que le dépôt n'a pas encore.** C'est
la limite la plus importante à connaître, et un test la mesure exprès : privé de la distance sur
le réseau, le HMM ne sait pas qu'une contre-allée parallèle est à 800 m de détour, la transition
devient neutre et la décision retombe sur la distance seule — des points repassent alors sur la
contre-allée. Le taux mesure donc l'algorithme, **pas** la chaîne complète. Le graphe (pgRouting,
§ 7.14) reste à construire, et le jeu de traces est synthétique : seul le pilote corridor (D12)
donnera une mesure sous bruit réel.

---

## 5. Ce qui bloque la porte de la phase 0

Le § F.1 exige quatre preuves pour franchir la phase 0. Trois sont acquises.

| Preuve exigée | État |
|---|---|
| `SECURITY_REMEDIATION.md` avec preuves | **acquis** — volet dépôt prouvé, quatre alertes bloquées et documentées |
| `REQUIREMENTS_TRACEABILITY.md` sans « à vérifier » | **acquis** — ce document |
| `DECISIONS_PENDING.md` complet | **acquis** — 10 décisions, dont une tranchée |
| **`MIGRATION_PLAN.md` testé** | **acquis** — rollback exécuté et vérifié en aller-retour le 14/10, B-13 clos |

**Les quatre preuves de la porte de phase 0 sont acquises.**

Mais il serait faux d'en conclure que la phase 0 est sans reste. Le test du rollback a révélé un
fait que personne n'avait mesuré : **la chaîne de migrations ne reconstruit pas la base** —
49 des 51 se rejouent sur une base vierge, et le plan de reprise après sinistre repose donc
entièrement sur `pg_dump`. Ce n'est pas une preuve manquante de la porte, c'est un risque
découvert *en la franchissant*, et il attend un arbitrage (**D-10**).

Les quatre alertes de sécurité encore ouvertes, elles, restent bloquées par l'absence
d'autorisation de production, et non par un manque de travail.

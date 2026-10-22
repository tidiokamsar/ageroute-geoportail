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
backend **1 246 passés**, frontend **304 passés**, 0 échec, TypeScript sans erreur.

---

## 1. Les trente scénarios d'acceptation du § G.1

C'est la matrice qui compte : elle est mesurable, et le mandat en fait la porte de chaque phase.

| # | Scénario | Statut | Preuve ou cause |
|---|---|---|---|
| **A1** | Ouverture du mode terrain | **TP** | `hooks/usePositionGps.ts`, 15 tests : trois erreurs distinctes dont la permission refusée. **Jamais éprouvé sur appareil** |
| **A2** | Identification du tronçon, ≥ 95 % et 0 rattachement sous le seuil | **TT** | `appariement.a2.test.ts`, 11 tests sur **23 cas annotés** : **100 %** de bon candidat en tête, **0** présélection fautive. Distances données, non calculées : voir § 4 |
| **A3** | Incertitude : l'agent choisit, ou l'observation reste non rattachée | **TT** | issue `CHOIX_AGEN T` et `NON_RATTACHE` avec motif, `appariement.noyau.ts` ; position brute toujours conservée |
| **A4** | Dégradation sans PK | **TT** | `pkDeFraction` rend `TRONCON_SANS_PK` ; `api-v2/defauts.routes.ts` accepte une abscisse locale ; 49 tests de métré |
| **A5** | Métré, écart < 1 % en projection métrique | **TT** | **fonctions `epsg_utm` et `metre_utm`** (migration `20261020010000`) : fuseau 28N à l'ouest de 12° O, 29N au-delà, choisi au point intérieur. **Jeu de géométries de référence figé** (`backend/src/geo/geometries-reference.ts`, 22/10) : 9 géométries **définies en UTM** (surface et longueur connues exactement : carrés, triangle, polygone troué, L concave, lignes, deux polygones à cheval sur 12° O), coordonnées 4326 obtenues une fois par PROJ 7.2.1. **Deux implémentations indépendantes éprouvées dessus** : PostGIS (`metre_reference.test.sql`, **engendré** depuis le jeu, 9/9) et un noyau TypeScript sans base (`geo/utm.noyau.ts`, Krüger n³ ; `utm.noyau.test.ts`, 36 tests, **exécutable en CI**, contre-épreuve : facteur d'échelle faussé → 18 échecs) : valeur de définition retrouvée **au millionième**, les deux implémentations identiques au millième de m², écart à l'ellipsoïde 0,01 à 0,19 % (≤ 1 % exigé). **Branché sur la saisie des défauts** (`POST /api/v2/defauts`, champ `emprise`) : ligne → mètres, polygone → m², méthode `EMPRISE_UTM` (DÉRIVÉE), les mesures passent avant, la profondeur n'est jamais remplacée, géométrie invalide refusée avec sa raison (migration `20261022003000`, descente vérifiée ; 17 tests ; éprouvé contre PostGIS réel). **Reste** : aucun écran ne permet encore de tracer l'emprise, et la synchronisation hors ligne (`field/defauts.sync.ts`) ne la transporte pas |
| **A6** | Proposition de portion sans altérer le tronçon | **TT** | contrainte d'exclusion `btree_gist` en base ; `portions.routes.test.ts` vérifie qu'un `statutValidation` envoyé par le client est ignoré |
| **A7** | Hors ligne : 50 observations, 0 doublon, 0 perte | **TP** | `operations_sync`, `clientOperationId` unique, `field/portions.sync.ts` 13 tests, `offlineSync.test.ts` 23 tests. **Jamais éprouvé sur appareil ni sur 50 observations réelles** |
| **A8** | Conflit signalé, deux versions conservées | **TP** | table `conflits_sync`, `field/sync.service.ts` 11 tests. Pas de parcours de bout en bout |
| **A9** | Une proposition non validée n'apparaît jamais comme officielle | **TT** | `statutValidation` par défaut `A_VALIDER` ; `governance/validation.ts` 75 tests ; exports et carte filtrent |
| **A10** | 403 sur appel direct d'API pour un `LECTEUR` ou hors zone | **TP** | RBAC testé (`middleware/rbac`), délégation par domaine testée. **Hors zone, depuis le 22/10 (DT-3)** : périmètres territoriaux d'écriture par compte (migration `20261022010000`, table `perimetres_territoriaux`, une attribution non révoquée par compte et région, personne ne s'attribue un territoire à soi-même — **tenu en base**), appliqués par `requireTerritoire` à **toutes les écritures des huit domaines** (tronçons, ouvrages, points noirs, postes, chantiers, défauts, observations, portions : 40 routes) **et à la synchronisation hors ligne** ; la région d'un objet existant se lit **en base**, un déplacement exige les deux régions, un objet de région inconnue est refusé, un import en masse aussi. **Garde-fou** : un test échoue si une route d'écriture de ces domaines n'a pas la garde (contre-épreuve faite, et défaut du garde-fou lui-même trouvé par elle). Tests : noyau 13, middleware et synchronisation 13, routes d'administration 4, garde-fou 43, écran 3 ; banc SQL `perimetres_territoriaux.test.sql` ; éprouvé contre PostGIS réel. **Reste TP parce que la règle est provisoire** : un compte **sans** périmètre écrit partout (aucun n'est attribué : la liste des comptes et de leur territoire est attendue d'AGEROUTE, D-11) ; la **lecture** n'est pas restreinte ; tronçons, ouvrages, points noirs, postes toujours **sans fiche soumise à validation** (D-11, options A/B/C) |
| **A11** | Anomalie détectée, classée, expliquée, donnée intacte | **TT** | `qualite/anomalies.ts` 23 tests, `api-v2/qualite.routes.ts` 14 tests, **9 familles** ; un test vérifie qu'aucune correction ne propose de supprimer |
| **A12** | Chaque indicateur égal à sa requête de contrôle | **PA** | `reseau/couverture.reseau.ts` est reproductible et documenté (212 ms). Le tableau de bord affiche **depuis le 15/10 le périmètre, les portions validées et la qualité par statut** (`/kpis`). Reste : aucune requête de contrôle n'est rapprochée automatiquement de chaque indicateur affiché |
| **A13** | Intégrations : seules les données validées émises, rejeu sans effet de bord | **BL** | aucun accès DigitalRoad ni SharePoint (B-11, B-12). Aucune outbox transactionnelle écrite |
| **A14** | Non-régression des fonctions existantes | **TT** | **1 145 + 294 tests**, 0 échec ; les 16 tests d'appariement antérieurs tiennent après extraction du noyau |
| **A15** | Rattachement < 300 ms p95 ; Géoportail fluide | **TP** | **Rattachement mesuré le 22/10 au volume de la production** (`prisma/tests/appariement.bench.sql`, 261 387 tronçons, 300 positions, requête du service recopiée) : réseau classé avec emprise de 2 km (saisie d'un défaut) **p95 3,54 ms** ; **tout le réseau sans emprise p95 831,9 ms : A15 échouait**, parce que le tri `geom <-> point` et le filtre `geom && emprise` sont planaires et que `troncons` n'avait qu'un index sur `geom::geography`. **Corrigé** par la migration `20261022020000_index_geom_troncons` (index GiST planaire, additif, descente vérifiée) : **p95 0,85 ms**, premier candidat identique avec et sans index sur les 300 positions (asserté). **Reste** : durée réseau d'un aller-retour et serveur de production non mesurés ; « Géoportail fluide » non mesuré (aucun navigateur sur ce poste) |
| **A16** | Roulage, marqueur < 200 ms, erreur < 30 m | **AB** | § 7.13 non commencé |
| **A17** | Roulage, événement linéaire Début/Fin | **AB** | idem |
| **A18** | Trace 1 Hz 2 h, HMM ≥ 97 %, IRI par 100 m | **PA** | **HMM écrit et mesuré** : `appariement.trace.ts`, 25 tests, **130/130 points justes** sur 4 traces annotées (exigé ≥ 97 %), 8 sorties du référentiel sur 8 détectées, 7 200 points sans débordement. **Le graphe de réseau existe depuis le 20/10** : le même taux est obtenu avec des distances calculées depuis la géométrie (`graphe.noyau.test.ts`), et il est branché à l'analyse de trace (T-28). **Mais l'IRI n'existe pas**, et aucune trace réelle n'a été mesurée — voir § 4 |
| **A19** | Roulage, robustesse veille/appel/redémarrage | **AB** | exige les plugins natifs (ADR-009) |
| **A20** | Géoportail : rendu < 3 s en 3G, recherche < 300 ms, déviation < 2 s, OGC | **NT** | aucune mesure de rendu ni en 3G. Depuis le 22/10, **tuiles vectorielles servies** (`GET /api/public/tuiles/{z}/{x}/{y}.mvt`, MVT v2 par `ST_AsMVT`) : génération mesurée à 261 387 tronçons, **9 à 13 ms de z10 à z14**, médiane 121 ms à z6 ; contenu décodé et recompté. Mais **aucun écran ne les affiche** (dépendance d'affichage à autoriser, B-30) : le critère de rendu reste non mesuré. Permaliens faits (T-23), déviation faite (T-22) sans mesure de durée ; OGC absent |
| **A21** | Chaque tronçon : code national, provenance, score qualité, rattachement | **BL** | **la codification nationale n'existe pas** et les routes communautaires n'ont aucune valeur d'énumération (D-06). Provenance présente sur 259 696 tronçons, absente sur 1 691 |
| **A22** | Programmation reproductible, justifiée, fiche figée | **PA** | aucun moteur ; mais le **cycle de vie est écrit et gardé** (cycle-vie.noyau.ts, 18 tests) : version figée exigée à la transmission, statuts post-TRANSMIS **impossibles à saisir** depuis le Géoportail, balayage de tout le code ; catalogue des traitements créé, lois de vieillissement identifiées. Risque, coût, optimisation **absents** |
| **A23** | Interopérabilité ONR : pivot, L²R, sections UEMOA, correspondance éditable | **PA** | **sections fixes livrées** (IO-04), 14 assertions, B11 tenu sauf la note UEMOA. **Les 15 livrables du § B.6 sont écrits** : matrice ONR/BDR (14 domaines, 0 « à vérifier »), registre des sources de vérité (4 contradictions nommées), spécifications d'import, de correspondance et de tests, questionnaire ANASUR. Pivot CSV/GeoJSON et tables d'import **codés et testés**, GeoPackage en écart consigné ; orchestration non écrite ; formats L²R non publiés |
| **A24** | Exploitation : incident hors ligne → main courante immuable, Info Route < 1 min | **PA** | main courante immuable à heure serveur **éprouvée en base** ; Info Route publiée dès la validation (lecture par la vue, sans délai de propagation) ; bulletin qui reprend les publications en cours. **Manquent** : parcours hors ligne de bout en bout (lot 7 bloqué, B-10), mise à jour de la praticabilité (niveaux non approuvés, D-02), flux CIFS (aucun compte partenaire). Le délai < 1 min n'a pas été mesuré |
| **A25** | Sécurité : chaque alerte avec preuve ou blocage ; aucun secret | **PA** | **le volet dépôt est prouvé** : 225 commits analysés, aucun secret, **IP de production jamais committée**. Quatre alertes bloquées faute d'autorisation de production. `bdri_app` toujours superuser |
| **A26** | Migrations : rollback **exécuté et vérifié** | **TP** | **rollback exécuté le 14/10** sur PostGIS 17-3.5 local, aller-retour vérifié : 20 objets → 0 → 20, états identiques, codes 0. **Depuis le 22/10 : 69 descentes pour 69 migrations** (67 réversibles, 2 irréversibles par principe), exécutées par le banc `backend/prisma/descentes/verifier.sh` : **238 vérifications, 0 échec**, schéma comparé avant et après, migration réappliquée à l'identique, gardes éprouvées ; banc éprouvé par contre-épreuve. **Reste TP** : base vide, schéma rejoué par la chaîne et non celui de la production, aucun essai sur données ni volumes réels. Et **la chaîne ne se rejoue pas sur base vierge** (D-10) : un défaut `uuid`/`text` sur `marches`, seul obstacle mesuré, que le banc franchit par un pont sans toucher à l'historique |
| **A27** | Aucune décision non approuvée présentée comme officielle | **TT** | `rci-2026.1` **désapprouvée** le 14/10 ; 9 barèmes en `standard_initial`, **aucun approuvé** ; praticabilité volontairement vide ; 6 573 hors-territoire et 42 doublons **classés, intacts et reproductibles** |
| **A28** | Import BDR/ANASUR idempotent, 100 % des lignes dans un statut | **TP** | **les deux propriétés sont tenues par la base** (15 assertions SQL) **et par l'orchestration** : `/api/v2/imports` reçoit un fichier, l'empreinte **sur les octets reçus**, le vérifie ligne à ligne, enregistre le lot et toutes ses lignes dans un statut en une transaction auditée ; le même fichier renvoyé rend le lot existant **sans aucune écriture** ; erreurs exportables en CSV avec motif. 14 tests. **Reste l'étape 2, l'application** — aucune proposition n'est encore créée dans le référentiel, faute de rapprochement des identifiants et d'échantillon approuvé |
| **A29** | Tâches internes avec preuves avant/après ; rapprochement en lecture | **TP** | **TI-01 livré** : `taches_internes`, 9 contraintes `CHECK`, 22 assertions SQL. « Une tâche clôturée possède des preuves avant/après » est tenu **par la base**, pas par une consigne. La frontière DigitalRoad est tenue par l'**absence des colonnes**, avec un garde-fou de 17 tests qui échoue si un montant apparaît. **TI-02 bloqué** (aucune donnée DigitalRoad, B-11), TI-03 fait (`DATA_SOURCE_OF_TRUTH.md`) |
| **A30** | Détection satellitaire → proposition localisée, précision mesurée | **TP** | **la chaîne aval est faite et éprouvée en base** : registre des produits (licence, provenance, incertitude obligatoires), propositions localisées et figées, rattachement au tronçon à tolérance explicite (11,1 m rattaché, ~555 m non, à 50 m), verdict du terrain unique, précision par méthode **nulle sans verdict** (`observation_terre.test.sql`, 15 assertions). **Depuis le 22/10, cohérence tenue en base** (migration `20261022000000_teledetection_coherence`) : proposition hors emprise, référence non antérieure ou non couvrante, distance au tronçon saisie, produit cité modifié ou supprimé physiquement **refusés** ; vue et route `GET /teledetection/coherence` pour ce qui survient après (`teledetection_coherence.test.sql`, 16 assertions, contre-épreuve sans la migration). **Mesuré au volume de la production** (`teledetection.bench.sql`, 261 387 tronçons, 8 000 propositions) : rattachement médiane 1,6–4,7 ms, p95 ≤ 15,7 ms jusqu'à 5 km, index employé et résultats identiques à un balayage complet (asserts). Tests : noyau 24, routes 13, écran 5 ; service éprouvé contre PostGIS réel. **Manque l'amont** : aucune image, aucun moteur de changement, sources à choisir (`EARTH_OBSERVATION_PLAN.md`) |

**Bilan au 22/10/2026 (recompté sur le tableau) : 9 TT, 9 TP, 6 PA, 1 NT, 2 BL, 3 AB.** Aucune case « à vérifier ». (Le bilan précédent annonçait 9 TT et 6 PA : le tableau portait en réalité 8 TT, 8 TP et 7 PA ; le 22/10, A5 est passé de TP à TT, A10 de PA à TP, A15 de NT à TP.)

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
| 7.1 | Conventions géospatiales 🔒 | **PA** | longueurs en `geography` : conforme. **UTM 28N/29N employé** par `metre_utm` (20/10), banc à 0,04–0,18 % de l'ellipsoïde ; **jeu de géométries de référence et noyau TypeScript concordant** (22/10, A5) ; métré des défauts par emprise en UTM. SQL paramétré : corrigé et gardé par un test. **Index GiST sur toutes les colonnes géométriques** : 6 manquaient (constat du 20/10), posés sur l'expression `::geography` que le dépôt interroge (migration `20261020020000`), emploi par le planificateur vérifié ; garde-fou `index_gist.test.sql` qui échoue si une colonne en manque (21/21). Reste : contrôle `ST_IsValid` par le moteur qualité |
| 7.2 | Référencement linéaire, ISO 19148, bitemporel | **PA** | portions, lignage, exclusion : faits. Historisation bitemporelle écrite, **et son défaut corrigé** — la contrainte d'exclusion ignorait l'axe terrain, donc aucune donnée ne pouvait l'exercer. Migrations déployées le 21/10. **Date d'effet saisissable depuis le 22/10** (API, formulaire terrain, synchronisation) : avant, aucun code n'écrivait `valideDu`, donc l'axe terrain n'avait aucune donnée à exercer ; requalifier avec une date clôt l'ancienne version, une fusion de périodes différentes est refusée (code non déployé). Codification nationale absente |
| 7.3 | Map-matching ponctuel et de trace | **TP** | ponctuel **complet** avec les 5 facteurs et les 3 issues ; **trace HMM écrite et mesurée** ; **graphe du réseau fait** (20/10) : jonctions en T, tolérance explicite, Dijkstra borné — le jeu annoté passe avec des distances **calculées** et non plus écrites à la main (130/130, 0 transition non vérifiée). **Route** `POST /api/v2/geo/trace` (T-24), et le graphe y est **branché sur demande** (T-28) : tolérance de fusion fournie par l'appelant, jamais supposée ; épreuve décisive (une contre-allée parallèle attire le HMM sans graphe, plus avec) et jonction vérifiée contre PostGIS réel. Reste : sens uniques absents du référentiel ; tolérance de fusion réelle et calibration sur trace réelle (pilote) ; aucune mesure de performance sur le réseau national |
| 7.4 | Catalogue et métrés | **TP** | **31 types** en référentiel pur (22 tests), revêtu / non revêtu par colonne `applicabilite`, semés par le script idempotent (31 → 0 au rejeu) ; le plancher ≥ 21 du § 7.16 est tenu. Photos de référence par gravité absentes |
| 7.5 | Workflow de validation | **TT** | — |
| 7.6 | Moteur de qualité | **TT** | — |
| 7.7 | Évaluation, prévision, programmation | **EA** | RCI écrit, **désapprouvé** ; **catalogue des traitements créé** depuis les barèmes, attributs normatifs nuls, non approuvé ; lois de vieillissement **identifiées** (`matrices_degradation`, pas de temps non documenté) ; risque, coût, programmation **absents** |
| 7.8 | Application mobile | **AB** | Capacitor figé (ADR-009), non commencé ; **aucun APK compilable ici** (B-10) |
| 7.9 | Sécurité | **PA** | RBAC fait ; **ABAC territorial en écriture fait** sur les huit domaines et la synchronisation (22/10, A10), règle provisoire tant qu'aucun périmètre n'est attribué (D-11) ; lecture non restreinte ; 4 risques ouverts |
| 7.10 | Intégrations | **BL** | aucun accès |
| 7.11 | Interface web, WCAG 2.1 AA | **PA** | **lint opérationnel** (B-29 levé le 20/10) avec les règles d'accessibilité `jsx-a11y` : 0 erreur sur 139 fichiers après correction de 60 défauts, ajouté à la CI. **Accessibilité mesurée** par axe-core (WCAG 2.1 A et AA) sur 8 écrans, **0 violation**, avec contre-épreuve prouvant que l'instrument détecte (`Accessibilite.test.tsx`). **Contraste mesuré depuis le 22/10 (DT-6)**, statiquement faute de navigateur (`frontend/src/test/contraste.ts` : classes Tailwind du code source, palette réelle installée et variables de la charte, pire des deux fonds de page) : **511 échecs sur 1 250 paires** au premier relevé, dont 174 `text-gray-400` (2,34:1) et 206 `text-gray-500` sur le fond `#f4f6f8` (4,46:1). Corrigés : fond de page `#f8f9fb`, 238 nuances de texte assombries, 9 paires sur fond coloré ; **0 échec sur 1 293 paires** hors 2 fichiers en cours chez une autre session (21 défauts **comptés** par le garde-fou `contraste.test.ts`, qui échoue si ce nombre change ; contre-épreuve faite). **Non mesurés** : le fond hérité d'un parent et les couleurs en `style` (hors de portée de l'analyse statique), le géoportail et le tableau de bord sous axe-core (cartes et graphiques), l'usage réel au lecteur d'écran |
| 7.12 | Tableau de bord national | **PA** | périmètre, portions validées et qualité affichés (15/10) ; Control Tower et Fiche 360° absents |
| 7.13 | Collecte en roulage | **PA** | **côté serveur seulement** : analyse d'une trace GPX ou CSV importée (`POST /api/v2/geo/trace`, `geo/trace.service.ts`, écran « Relevé en véhicule »), vérifiée contre PostGIS réel le 21/10. **L'enregistrement en roulage sur le téléphone (service de premier plan, GNSS 1 Hz, IMU, photos cadencées) n'est pas commencé** : A16 et A17 restent AB, et aucun APK n'est compilable ici (B-10) |
| 7.14 | Niveau d'excellence | **PA** | **faits** : **tuiles vectorielles côté serveur** (22/10, DT-5 : `/api/public/tuiles`, couches réseau classé dès z5 et voirie locale dès z12, filtre sur l'index geography, cache et empreinte ; affichage bloqué par B-30) ; déviation routée sur le graphe (T-22), permaliens de la carte (T-23), **curseur temporel** (T-26 : deux axes, 41 vérifications contre PostGIS réel, `GET /api/v2/portions/a-la-date`, panneau « Temps » du géoportail). **métadonnées ISO 19115** (T-29 : 5 jeux publics, `GET /api/public/metadonnees` et `/:id.xml`, étendue et date de révision calculées sur les données, vérifiées contre PostGIS réel ; **le XML n'est pas validé contre les XSD de l'ISO 19139**, et la licence, le courriel de contact et l'adresse publique restent déclarés comme lacunes). **Absents** : tuiles vectorielles (écartées par la mesure, 263 Ko par emprise de Conakry), vue de route, pgRouting (le graphe est maison, T-20), gazetier, carte des années futures (suppose des scénarios de programmation). Rien de cela n'est déployé |
| **7.15** | **Interopérabilité BDR / L²R** | **PA** | **IO-04 livré** ; les 8 flux ont chacun leur plan de test (`ONR_BDR_TEST_PLAN.md`) et les 3 options d'échange sont documentées **sans choix** (§ B.4). Un seul flux est testable aujourd'hui ; les autres attendent formats, export approuvé ou décision. **Une intégration sortante existe déjà** vers DigitalRoad/SharePoint — ce que les rapports antérieurs omettaient |
| **7.16** | **Étalon fonctionnel Logiroad Center** | **PA** | confrontation ligne par ligne faite le 20/10 ([LOGIROAD_BENCHMARK.md](LOGIROAD_BENCHMARK.md)) : **1 faite** (exploitation, sauf tiers), 9 partielles, 5 absentes, 3 bloquées par un accès, sur 18. Plancher **non atteint** ; trois verrous : mobile (B-10), décisions état / coûts (RCI, D-02, D-07), accès tiers |
| **7.17** | **Couche d'exploitation** | **PA** | **faits** : main courante en ajout seul (EX-01), P1–P4 **provisoires non approuvés** (EX-02), patrouilles programmées avec couverture mesurée et dispatch de vérification sur signalement (EX-03), Info Route publique en ajout seul (EX-05), bulletin quotidien généré et archivé avec empreinte (EX-06), statistiques d'exploitation sans cible ni seuil (EX-08), cellule de veille avec astreintes, escalade à délais saisis et vue murale (EX-04). **Bloqué aussi** : notification des escalades (canal non choisi). **Bloqués** : alerte capteur (aucun capteur raccordé), Waze/CIFS et DATEX II (aucun compte partenaire), diffusion du bulletin (aucun canal autorisé), niveaux P1–P4 publics (non approuvés, D-02) |

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

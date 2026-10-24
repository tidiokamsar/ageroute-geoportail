# Mesures de performance A15 et A20

Premieres mesures des objectifs de performance du cahier : **A15** (« rattachement < 300 ms p95 ;
Geoportail fluide ») et **A20** (« Geoportail : rendu < 3 s en 3G, recherche < 300 ms, deviation < 2 s »).
Avant le 23/10/2026, aucune de ces valeurs n'avait ete mesuree (statut NT).

Tous les chiffres de ce document viennent d'executions du banc `backend/tests-integration/perf/`, lues dans
les fichiers JSON de ce dossier. Aucun n'est estime, sauf les durees de transfert 3G theoriques, signalees comme
telles. **Aucune mesure n'a ete faite sur la production.**

## 1. Verdicts

| Objectif | Seuil | Mesure (261 387 troncons, apres correctifs) | Verdict |
|---|---|---|---|
| A15 rattachement | p95 < 300 ms | chemin du terrain (`GET /api/v2/field/current-context`), HTTP : p95 **51 ms** (points a 5 m ; **126 ms** a la repetition), 44 ms (15 m), 60 ms (hors route) ; fonction de service : p95 32 ms ; 10 clients simultanes : p95 107 ms (160 ms a la repetition) ; reseau complet (`reseau=tout`) : p95 24 ms (46 ms a la repetition) | **Atteint** sur le jeu synthetique, dans deux executions a des moments differents. **Etat d'origine : non atteint** pour `reseau=tout` (p95 1 196 ms) a 261 387 troncons ; atteint a 20 000. Premier appel d'un processus neuf : 100 a 350 ms (8 processus), 394 ms au pire a la repetition |
| A15 « Geoportail fluide » | non defini | aucune metrique de fluidite (images par seconde, latence de deplacement ou de zoom) n'existe au cahier ni dans le code | **Non mesurable ici** |
| A20 recherche | < 300 ms | HTTP `GET /api/search`, p95 : 29 a 52 ms (code exact), 24 a 26 ms (mot frequent), 12 a 33 ms (motif absent), **162 ms puis 427 ms** (mot d'un nom, deux executions ; p99 452 puis 1 479 ms). Motif de 2 caracteres sans resultat : p95 1 279 ms puis 4 221 ms | **Atteint au p95 pour code exact, mot frequent et motif absent** (3 caracteres et plus). **Non atteint de facon reproductible pour « mot d'un nom »** (un nom de village rare) : le banc a echoue sur ce scenario a la repetition (44 verifications sur 45). Motif de 1 a 2 caracteres sans resultat : **non atteint**. Etat d'origine : non atteint (p95 2,4 a 5,1 s) |
| A20 deviation | < 2 s | detour admissible de 50 km (verdict du banc) : p95 **1 580 ms** puis **1 878 ms** (service), **1 704 ms** puis **1 725 ms** (HTTP) ; p99 2,1 a 2,7 s. Detour de 100 km (informatif, n = 20) : p95 3 300 ms puis 2 517 ms | **Atteint a 50 km, avec une marge de 6 a 21 %**, le p99 depasse 2 s ; **non atteint a 100 km**. 163 coupures sur 200 n'ont aucun detour dans le jeu (reponse legitime) et 4 sur 200 sont refusees (emprise trop large) |
| A20 rendu en 3G | < 3 s | **mesure en navigateur**, cache vide, avec un limiteur de debit : 4,9 a 6,9 s a 1,6 Mbit/s, 150 ms ; 11,6 a 12,1 s a 400 kbit/s, 400 ms (apres correctif du bundle ; 7,4 a 8,2 s et 16,3 a 16,6 s avant) | **Non atteint** a la premiere visite. Visite suivante (cache plein) : 2,5 s au profil pessimiste. Le rendu des traces n'est pas mesure directement (voir 6) |
| A20 OGC, tuiles vectorielles, permalien | -- | hors perimetre de cette mesure | Non traite |

**Lecture honnete.** Le rattachement est tenu apres un index (et l'etait deja pour le chemin reel du terrain) ; la
recherche l'est pour les motifs courants et absents mais **pas pour les noms rares**, et deux index n'ont pas suffi ;
la deviation est tenue de justesse et seulement pour un detour de 50 km ; le rendu en 3G ne l'est pas, et la cause
principale n'est pas le serveur. **Le banc echoue sur une execution des deux** (44 verifications sur 45 a la repetition) :
c'est le resultat, pas un defaut du banc. A 20 000 troncons, l'etat d'origine passe les 45 verifications : les seuils ne
sont depasses qu'au volume du registre (section 14). La machine de mesure etait partagee et chargee (section 3) : les valeurs absolues
sont pessimistes, mais **les rapports avant/apres ne se lisent que la ou le plan d'execution change** (section 8).

## 2. Methode

**Le jeu.** Un reseau synthetique deterministe (graine `20261023`, generateur `lib/reseau-synthetique.ts`), charge
dans un **clone jetable** `essai_perf` de la base `replay` (PostgreSQL 17.5, PostGIS 3.5.2, 73 migrations dont les
deux de ce lot). Le banc supprime le clone a la fin ; `replay` n'est jamais ecrit.

**Les scenarios.** Chaque scenario fait 20 appels d'echauffement (10 pour la trace, le graphe, la deviation et la
carte, 2 pour la deviation a 100 km) puis **200 mesures** (20 pour la deviation a 100 km, 12 pour la comparaison de construction du
graphe : ces trois sont signales « informatif », sans seuil). Percentile par **rang le plus proche** (le p95 est une
valeur observee, pas une interpolation). Chaque scenario releve aussi la **charge CPU de la machine** pendant qu'il
tourne (`os.cpus()` toutes les secondes).

**Deux niveaux, distingues dans chaque identifiant** :
- `service` : appel direct de la fonction du depot (`apparier`, `contexteTerrain`, `calculerDeviation`,
  `chargerGraphe`, `carteGeoHandler`, requete Prisma de la recherche). Ni HTTP, ni JSON de reponse, ni gzip, ni authentification.
- `http` : la vraie application Express (`createApp()` : helmet, CORS, compression, limiteurs, JWT, controle
  d'acces aux modules, morgan) sur une socket de boucle locale, connexion persistante, `Accept-Encoding: gzip`, jeton d'un
  compte GESTIONNAIRE (donc avec la lecture de `modulesAutorises` a chaque requete). Les lignes de journal de morgan sont
  ecartees de la sortie du banc, pas desactivees.

**A chaud et a froid.**
- *A chaud* : les 200 mesures apres echauffement, dans un processus qui a deja servi des requetes.
- *A froid* : la **premiere** requete de chaque famille dans un **processus Node neuf**, 8 processus, plus le temps de
  connexion Prisma. Ce froid est celui du processus (pool vide, JIT, premiere planification de chaque requete). **Le cache
  de PostgreSQL n'est pas vide** : le faire demanderait de redemarrer le conteneur partage `bdri-dev-db`, ce que d'autres
  travaux sur le poste interdisent.

**Chemin reel du terrain.** `TerrainPortionsPage` appelle `GET /api/v2/field/current-context` avec seulement
`lat`, `lon`, `precisionM` : **ni emprise ni `reseau`**. Le perimetre par defaut est donc le reseau classe, sans borne
spatiale. Les variantes avec emprise de mission et `reseau=tout` sont mesurees a part, parce que l'API les accepte.

**Points GPS.** 300 par groupe (graine `GRAINE+2`), tires sur les troncons avec un bruit gaussien isotrope de 5 m ou
15 m, annonce comme `precisionM`. Groupes : `classe-5m`, `classe-15m`, `urbain-5m`, `urbain-15m`, `hors-route`. La
verite terrain est gardee ; le taux de rattachement est rapporte mais n'entre pas dans les seuils.

**Verdict.** `perf.integration.ts` echoue (code 1) si, dans l'etat final : un scenario avec seuil du cahier a un p95
>= seuil ou moins de 200 mesures ; une reponse HTTP est un 4xx/5xx inattendu (un chiffre mesure sur une 401 ne prouve
rien : c'est ce qui a ete corrige apres un premier essai, le jeton JWT expirant au bout de 15 minutes) ; le transfert
theorique de la carte publique (zoom 7) depasse 3 s meme sous le profil 3G optimiste ; plus de 5 % des coupures sont
refusees pour emprise trop large (**ce dernier critere est de ce banc, pas du cahier**). `--sans-correctifs` saute les
migrations pour verifier que le banc echoue dans l'etat d'origine.

## 3. Materiel, volumes, conditions

| Element | Valeur |
|---|---|
| Poste | Intel Core i7-8650U 1,90 GHz, 4 coeurs / 8 threads, 15,8 Go, Windows 11 Pro 10.0.26300 |
| Docker | Docker Desktop 29.6.2, machine virtuelle de 8 CPU et 7,7 Gio ; conteneur `bdri-dev-db` |
| PostgreSQL | 17.5, PostGIS 3.5.2 ; `shared_buffers` 128 Mo, `work_mem` 4 Mo, `effective_cache_size` 4 Go, `max_parallel_workers_per_gather` 2, `jit` on, `random_page_cost` 4 |
| Node | 24.18.1 ; priorite du processus du banc au-dessus de la normale |
| Reseau de test, grand | **261 387 troncons** (volume du registre releve en production) : 1 772 classes + 259 615 de voirie promue (`voirie_locale:`), 126 ouvrages |
| Reseau de test, minimal | **20 000 troncons** : 1 772 classes + 18 228 de voirie |
| Taille de la table `troncons` | 62 Mo, 112 Mo avec ses index (avant les deux index de ce lot) |

**Charge de la machine.** Le poste est partage avec d'autres agents et outils : d'apres le banc, la charge CPU moyenne
pendant les scenarios va de **32 % a 100 %**. La phase « avant » du 261 387 a tourne a 76-100 %, la phase « apres » a
32-99 %. Un meme scenario peut donc varier d'un facteur 5 d'une execution a l'autre sans que rien ne change : le
chemin classe (`apparier`, sans index modifie) a donne p50 92 ms puis 17 ms sur le 20 000, et 6,6 ms avec 32 % de
charge sur le 261 387. **Aucune mesure n'est une garantie de service** ; les valeurs servent a verifier qu'un seuil est
tenu *malgre* la charge, et a comparer des plans.

## 4. Le jeu de donnees, tel que mesure

Mesure par `decrire()` sur le jeu genere (voir `lib/reseau-synthetique.ts`). Le registre reel : 1 691 troncons classes,
21 156 km, 12,0 points/km sur les nationales et 2,2 sur les regionales.

| | Troncons | km | Longueur moyenne | Longueur max | Points par km |
|---|---|---|---|---|---|
| Classe (RN, RR) | 1 772 | 19 415 | 10 957 m | 44 811 m | 2,3 |
| Voirie (261 387) | 259 615 | 27 074 | 104 m | 214 m | 24,0 |

- Reseau classe : axes entre 34 chefs-lieux et 260 villages (positions **approchees**), arbre couvrant minimal plus les
  4 plus proches voisins, decoupes en troncons de 1,5 a 45 km (log-normale), a meandres, extremites **identiques** aux jonctions.
- Voirie : trames de rues irregulieres de 70 a 140 m de maille autour de 94 agglomerations, orientees au hasard, avec 12 %
  de rues manquantes et des courbes legeres ; la densite est celle d'un disque (le centre est plein).
- Le reseau classe et la voirie ne sont **pas connectes** entre eux. Ni sens uniques, ni PK realistes, ni praticabilite.
- Empreintes SHA-256 : voir `backend/tests-integration/perf/README.md`.

**Ce que ce jeu n'est pas.** Il n'est pas la geometrie reelle d'une route. Les mesures dependent du **volume** et de la
**forme generale** du reseau (densite urbaine concentree, axes longs). Un reseau reel plus dense autour de Conakry, ou des
troncons classes plus longs, changerait surtout la deviation et le chargement du graphe.

## 5. A15 : le rattachement

### 5.1 Chiffres (p50 / p95 / p99, en ms)

261 387 troncons. Colonnes « avant » : etat d'origine de la base (sans les deux migrations), le code de ce depot en
revanche inclut deja les correctifs de code (voir section 9). Charge CPU moyenne entre parentheses.

| Scenario | Avant | Apres |
|---|---|---|
| `terrain.classe-5m.http` | 83,9 / 246 / 321 (100 %) | 18,7 / **51,3** / 76,1 (69 %) |
| `terrain.classe-15m.http` | 46,9 / 95,7 / 155 (99 %) | 16,9 / 44,0 / 58,7 (64 %) |
| `terrain.hors-route.http` | 68,5 / 181 / 290 (100 %) | 18,0 / 60,0 / 99,9 (79 %) |
| `terrain.classe-5m.service` (`contexteTerrain`) | 103 / 339 / 631 (100 %) | 13,2 / 31,9 / 46,9 (71 %) |
| `apparier.classe-5m.service` | 43,4 / 104 / 129 (100 %) | 6,6 / 8,1 / 9,8 (32 %) |
| `match.classe-5m.http` (`POST /geo/match`) | 24,9 / 39,3 / 52,2 (86 %) | 11,9 / 16,6 / 30,4 (38 %) |
| **`terrain.urbain-5m.tout.http`** | 834 / **1 196** / 1 339 (99 %) | 14,0 / **24,0** / 45,5 (69 %) |
| **`terrain.urbain-15m.tout.http`** | 761 / **1 197** / 1 337 (98 %) | 12,0 / 23,3 / 44,3 (70 %) |
| `apparier.urbain-5m.tout.service` | 788 / 1 099 / 1 196 (99 %) | 4,5 / 12,7 / 28,3 (96 %) |
| `apparier.classe-5m.emprise 10 km` | 5,5 / 15,9 / 20,3 (94 %) | 3,7 / 7,2 / 12,5 |
| `apparier.urbain-5m.tout.emprise 4 km` | 193 / 399 / 494 (92 %) | 2,8 / 3,4 / 3,9 |
| 10 clients simultanes, `terrain.classe-5m.http` | 91,5 / 249 / 404 | 56,4 / 107 / 176 |

Taux de rattachement des 200 points (le moteur refuse de conclure quand il doute, par construction) : 194 sur 200
a 5 m, 193 sur 200 a 15 m (reseau classe) ; 187 sur 200 a 5 m et 160 sur 200 a 15 m en voirie (`reseau=tout`).

Sur le 20 000 troncons (`resultats-20000.json`), meme lecture : `terrain.classe-5m.http` apres p95 64 ms,
`terrain.urbain-5m.tout.http` avant p95 773 ms, apres 17 ms.

### 5.2 Lecture

- **Le chemin reel du terrain (reseau classe, sans emprise) tient largement** : p95 51 ms apres, et 246 ms deja a l'origine,
  sous 100 % de charge. Il passe par l'index partiel `troncons_reseau_reference_idx` (1 772 lignes) : le plan est le meme
  avant et apres (section 8). La difference avant/apres sur ces lignes **est la charge de la machine**, pas un correctif.
- **Le reseau complet (`reseau=tout`) ne tenait pas** : le plan faisait un parcours sequentiel parallele des 261 387
  troncons (761 ms en `EXPLAIN ANALYZE`). L'index GiST planaire sur `troncons.geom` le ramene a 0,46 ms. C'est le cas de la
  voirie urbaine, que le terrain demandera des qu'il passera `reseau=tout`.
- **`contexteTerrain` ajoute 5 a 10 ms** a `apparier` seul (portions, longueur, ouvrages proches), sans surprise.
- **Concurrence** : a 10 clients, le p95 reste a 107 ms apres (249 ms avant) ; debit mesure 154 requetes par seconde
  apres, 87 avant (400 requetes dans chaque cas).
- **Premier appel d'un processus neuf** (HTTP, `current-context`, 8 processus, apres correctifs) : p50 116 ms, max 346 ms ;
  le deuxieme appel : p50 32 ms. Le premier appel d'une connexion paie la planification et l'initialisation de PostGIS
  (geography) : **deux premiers appels sur huit ont depasse 300 ms** (346 et 309 ms). Avant : p50 391 ms, max 1 168 ms, cinq sur huit
  au-dela de 300 ms.
- **Ce qui n'est pas mesure** : le temps cote appareil (GPS, reseau mobile, application), le mode hors ligne, et l'appariement
  d'une **trace** hors indicateurs ci-dessous.

### 5.3 Analyse de trace (informatif, aucun seuil au cahier)

60 points (3 km a 50 m, bruit 5 m), reseau classe : p50 / p95 en ms.

| | Avant | Apres |
|---|---|---|
| `analyserTrace` sans graphe | 1 056 / 1 942 | 39,5 / 109 |
| `analyserTrace` avec graphe (tolerance 5 m) | 2 934 / 4 062 | 58,7 / 426 |

La requete de candidats par point (`LATERAL ... ORDER BY geom <-> point`) faisait un parcours sequentiel. Le taux de
rattachement est de 80 % ou plus sur les 200 traces.

## 6. A20 : recherche

Route `GET /api/search?q=...` : cinq `findMany` Prisma en parallele (troncons, ouvrages, points noirs, postes, chantiers),
`ILIKE '%q%'` sur code et nom pour les troncons, `LIMIT 5`. Les quatre autres tables sont **vides ou presque** dans le clone
(126 ouvrages) : leur cout est negligeable ici et non mesure a l'echelle de la production.

Les requetes sont tirees du jeu : `code-exact` (code complet d'un troncon), `mot-de-nom` (mot d'au moins 4 lettres d'un nom),
`mot-frequent` (rue, avenue, route, voie, boulevard, impasse), `absent` (chaine inconnue de 7 a 10 caracteres),
`court-absent-2car` (deux lettres dont la seconde est `q`, absente du jeu). **Distinguer ces classes est necessaire** : un `LIMIT 5`
s'arrete des cinq premieres lignes trouvees, donc un mot frequent est rapide meme sans index et ne prouve rien.

261 387 troncons, HTTP, p50 / p95 / p99 en ms :

| Classe | Avant | Apres, execution 1 | Apres, repetition (autre moment) |
|---|---|---|---|
| `code-exact` | 1 536 / **5 020** / 5 100 | 15,9 / **29,1** / 38,1 | 23,7 / **52,3** / 70,5 |
| `mot-de-nom` | 117 / **2 448** / 4 323 | 9,8 / **162** / **452** | 16,6 / **427** / **1 479** |
| `mot-frequent` | 16,2 / 31,2 / 40,0 | 12,0 / 23,9 / 39,3 | 14,9 / 25,7 / 34,8 |
| `absent` | 2 292 / **5 119** / 5 517 | 9,5 / 12,1 / 14,3 | 13,9 / 32,9 / 54,0 |
| `court-absent-2car` (informatif) | 2 397 / 4 593 / 4 805 | 557 / **1 279** / 2 215 | 896 / **4 221** / 4 565 |

Niveau service (requete Prisma de la route sur les troncons) : `absent` 1 410 / 3 208 / 4 839 avant, 4,3 / 6,3 / 6,8 apres ;
`mot-de-nom` 37 / 3 081 / 4 404 avant, 6,5 / **235** / 515 apres (execution 1).

**Cause** (plan, section 8) : `ILIKE '%q%'` ne se sert d'aucun index btree. **Correctif applique** : deux index GIN `pg_trgm` partiels.

**Ce qui reste hors seuil, et pourquoi.**
- **« Mot d'un nom » : p95 de 162 ms puis 427 ms selon l'execution.** Diagnostic fait a la main sur 110 mots distincts du jeu :
  le planificateur ignore la frequence reelle d'un motif `ILIKE '%q%'`. Pour un nom rare (un village) il estime a tort qu'il
  trouvera cinq lignes presque tout de suite et choisit le **parcours sequentiel**, qui lit la table jusqu'au bout malgre l'index
  (1,2 a 1,6 s pour `sindisin`). Pour un mot tres frequent
  (`conakry`, 32 % des troncons) le plan par defaut a pris 1,45 s (plan non releve) ; le `BitmapOr` trigramme force, lui, prend
  112 ms parce qu'il construit le bitmap de tous les troncons avant de lire cinq lignes. Un seul plan ne convient pas a tous les mots.
- **Un correctif essaye puis ecarte.** Imposer le bitmap trigramme a cette requete (`SET LOCAL enable_seqscan = off` puis aussi
  `enable_indexscan = off`, dans la meme transaction) ramenait le plan de `sindisin` a 6 ms, de `kankan` a 27 ms, de `conakry` a
  112 ms en `EXPLAIN ANALYZE` (0,7 ms pour un motif absent). **Mesure par le banc complet** (`resultats-261387-essai-recherche-bitmap-force.json`,
  charge CPU de 34 a 95 %) : `mot-de-nom` p50 70 ms / **p95 698 ms** / p99 899 ms, **`mot-frequent` p50 83 ms / p95 193 ms** (12 / 24 ms
  sans le reglage), `code-exact` p95 98 ms. Les mots frequents paient le bitmap complet, et la queue de `mot-de-nom` ne baisse pas. Le correctif
  a ete **retire du code** ; il n'est dans aucun fichier du depot.
- Un motif de **1 a 2 caracteres sans resultat** ne produit aucun trigramme : retour au parcours sequentiel complet (p95 1,3 a 4,2 s).
  La recherche globale de l'en-tete part de 2 caracteres ; la recherche du geoportail n'interroge le serveur qu'a partir de 3.
  Un motif de 2 caracteres frequent est rapide (le `LIMIT` s'arrete tot).
- **Les noms du jeu sont repetes** (« Voie sans nom Kankan 12345 », « Rue Xyz Conakry ») : une part des « mots d'un nom » sont des noms
  de ville portes par des dizaines de milliers de troncons. La distribution reelle des noms au registre n'est pas connue ; les
  chiffres de cette classe dependent d'elle.
- **Pistes non essayees** : une recherche par prefixe pour les motifs courts, un index `gist_trgm_ops` avec tri par distance,
  une table de recherche denormalisee.
- **Le temps de recherche vu par l'utilisateur du geoportail** inclut aussi un filtre en memoire sur les donnees deja chargees
  dans la page (`GeoportailPage.tsx`, `searchResults`), **non mesure** ici (il se fait dans le navigateur).

## 7. A20 : deviation routee et graphe

Parametres : coupure de 500 m au milieu d'un troncon classe de 3 km ou plus (choisi au hasard), `distanceMaxM` 50 000 m,
`toleranceFusionM` 5 m. **Rien dans le frontend n'appelle encore cette route** : ces parametres sont ceux du banc, pas d'un usage.
Le cahier ne dit pas quelle borne de detour le « < 2 s » suppose.

261 387 troncons, p50 / p95 / p99 en ms :

| Scenario | Avant | Apres, execution 1 | Apres, repetition |
|---|---|---|---|
| `graphe.requete-sql` (troncons de l'emprise, GeoJSON) | 550 / 1 645 / 2 498 | 43,9 / 254 / 463 | n/d |
| `graphe.chargement` (`chargerGraphe` complet) | 2 043 / 4 797 / 5 824 | 472 / 2 602 / 3 635 | n/d |
| `deviation.calcul.service` | 1 896 / 4 691 / 5 661 | 302 / **1 580** / 2 072 | 296 / **1 878** / 2 741 |
| `deviation.calcul.http` | 2 005 / 4 733 / 5 812 | 327 / **1 704** / 2 121 | 307 / **1 725** / 2 524 |
| `deviation 100 km` (informatif, n = 20) | 3 044 / 5 420 / 6 036 | 1 257 / **3 300** / 4 063 | 1 099 / **2 517** / 3 647 |

Issue des 200 coupures a 50 km : 33 deviations trouvees, 163 `AUCUNE_DEVIATION`, 4 `EMPRISE_TROP_LARGE`. Le sous-reseau charge
compte 2 077 troncons en mediane, 20 001 au maximum (le plafond), pour 1 304 noeuds en mediane.

**Trois causes, dans l'ordre ou elles ont ete trouvees.**
1. **`construireGraphe` etait quadratique** : l'etape des jonctions en T comparait chaque troncon a toutes les extremites du
   lot. Sur le **code d'origine** (essai exploratoire, 30 coupures, `resultats-261387-exploration-code-origine.json`) :
   `chargerGraphe` p50 1,5 s, **p95 34 s** ; `calculerDeviation` p50 1,8 s, **p95 27,9 s**. Correctif : index spatial des
   extremites ; resultat strictement identique (test d'equivalence contre la construction d'origine, section 9).
   Sur les **memes entrees** (12 emprises, jusqu'a 5 642 troncons), construction seule, au pire des 12 : origine 11 546 ms, 7 953 ms
   et 4 578 ms (trois executions), indexee 1 055 ms, 580 ms et 354 ms ; soit un rapport de 11 a 14.
2. **Le chargement du graphe faisait un parcours sequentiel** (`t.geom && enveloppe`). L'index GiST planaire le ramene de
   344 ms a 21,5 ms en `EXPLAIN ANALYZE` pour une emprise de 473 troncons.
3. **Le volume charge est celui de tout ce qui se trouve dans l'emprise**, voirie comprise, plafonne a 20 000 : pres d'une grande
   agglomeration l'emprise de 50 km depasse le plafond (4 coupures sur 200, `EMPRISE_TROP_LARGE`). **Non corrige** : restreindre le
   graphe au reseau classe changerait le contrat de la route (decision a prendre) ; l'option n'est pas ajoutee.

**Verdict.** A 50 km, p95 1,58 puis 1,88 s (service) et 1,70 puis 1,73 s (HTTP) : sous 2 s, avec 6 a 21 % de marge sur une machine
chargee a 81-88 %. A 100 km, p95 3,3 puis 2,5 s : au-dela. Le p99 du 50 km (2,07 a 2,74 s) depasse 2 s. 82 % des coupures n'ont aucun detour
dans le jeu : le chargement et la construction du graphe sont les memes que pour une deviation trouvee, mais **la recherche de chemin
et la geometrie de retour ne sont mesurees que sur 33 cas sur 200**. Sur le 20 000, 34 sur 200.

## 8. Plans d'execution (extraits de `EXPLAIN (ANALYZE, BUFFERS)`, 261 387 troncons)

Les plans completes sont dans les fichiers JSON (`phases[].plans`). Le SQL de l'appariement est **capture** a l'appel reel de
`apparier()` ; celui de la recherche et du graphe est recopie des sources.

| Requete | Avant | Apres |
|---|---|---|
| Candidats, reseau classe, sans emprise | Bitmap Heap Scan via `troncons_reseau_reference_idx`, 1 772 lignes, tri top-N : **20,3 ms** | identique : **21,4 ms** |
| Candidats, reseau complet, sans emprise | Gather Merge, **Parallel Seq Scan** (87 129 lignes par worker x 3) : **761 ms** | **Index Scan using troncons_geom_gist**, 5 lignes : **0,46 ms** |
| Candidats, reseau complet, emprise de 4 km | Parallel Seq Scan : **332 ms** | Bitmap Index Scan sur `troncons_geom_gist`, 418 lignes : **1,9 ms** |
| Chargement du graphe, emprise 50 km (rural) | Parallel Seq Scan : **344 ms** | Bitmap Index Scan sur `troncons_geom_gist`, 473 lignes : **21,5 ms** |
| Recherche, motif absent | Seq Scan, 0 ligne : **2 535 ms** | BitmapOr de `troncons_code_trgm_idx` et `troncons_nom_trgm_idx` : **0,11 ms** |
| Recherche, mot d'un nom | Seq Scan, 5 lignes : **3 067 ms** | BitmapOr, 17 lignes dans l'index du nom : **0,65 ms** |

Un plan se lit a une charge donnee ; ces durees ont ete prises a la suite, sur la meme base, et le **rapport** entre avant et
apres est celui qui compte (de 16 a plus de 20 000 fois selon la requete), pas la valeur absolue. Le plan du chemin reel du terrain ne
change pas.

## 9. Corrections apportees

| Correction | Fichiers | Preuve |
|---|---|---|
| Index GiST planaire `troncons_geom_gist` | migration `20261023200000_index_troncons_geom_planaire` + descente | section 8 ; descente verifiee par `verifier.sh` : 2 verifications, 0 echec (schema identique a l'avant, aller-retour identique) |
| Index trigramme `troncons_code_trgm_idx`, `troncons_nom_trgm_idx` + extension `pg_trgm` | migration `20261023210000_recherche_troncons_trigramme` + descente (l'extension reste, residu declare) | section 8 ; `verifier.sh` : 2 verifications, 0 echec |
| `construireGraphe` : index spatial des extremites | `src/geo/graphe.noyau.ts` | `graphe.noyau.equivalence.test.ts` : 6 tests, la version indexee rend **exactement** le meme graphe que la construction d'origine (`graphe.noyau.reference.ts`, recopiee du commit 2943e22) sur des reseaux tires au hasard avec jonctions en T ; section 7 pour le gain |
| Carte publique : coordonnees arrondies selon la simplification (4, 5, 6 chiffres ; 9 au zoom 16) | `troncons.service.ts` (`decimales`), `public.controller.ts` (`decimalesSelonZoom`) | 3 tests ; octets gzip du zoom 7 : **102 718 -> 88 626 (-13,7 %)**, zoom 11 : 167 132 -> 151 155 (-9,6 %), zooms 14 et 16 : inchanges (le jeu synthetique est a 6 decimales : **le gain sur les donnees reelles n'est pas mesure**) |
| Frontend : plus de chunks manuels `charts` et `pdf` | `frontend/vite.config.ts` | le point d'entree prechargeait 278 Ko gzip de graphiques et de PDF ; transfert total de `/carte` : **600 663 -> 323 306 octets** ; section 10 |

**Ce qui n'a pas ete corrige** : la deviation a 100 km, l'emprise trop large pres des agglomerations, les motifs de 1 a 2 caracteres, le
p99 de la recherche, le cout de `ST_SimplifyPreserveTopology` et de la serialisation de la carte (voir 10).

## 10. A20 : carte publique et rendu en 3G

### 10.1 Octets et temps serveur (jeu de 261 387 troncons ; le public ne recoit que les 1 772 troncons classes)

| Zoom | Octets gzip | Octets bruts | Transfert theorique 1,6 Mbit/s, 150 ms | Transfert theorique 400 kbit/s, 400 ms | HTTP p50 / p95 (ms, apres) |
|---|---|---|---|---|---|
| 7 (ouverture) | 88 626 | 559 209 | 893 ms | 2 973 ms | 290 / 585 |
| 11 | 151 155 | 731 168 | 1 206 ms | 4 223 ms | 314 / 521 |
| 14 | 292 683 | 1 115 014 | 1 913 ms | 7 054 ms | 434 / 645 |
| 16 | 392 767 | 1 405 478 | 2 414 ms | 9 055 ms | 247 / 405 |

Transfert theorique = 3 RTT avant les donnees (TCP, TLS 1.3, requete) + octets x 8 / debit. **C'est une borne basse** : sans demarrage lent
de TCP, sans perte, sans les autres fichiers de la page. **Ce n'est pas le rendu.** Les deux profils sont ceux de Chrome DevTools et de
Lighthouse : « Slow 4G » (anciennement « Fast 3G ») 1,6 Mbit/s et 150 ms de RTT cible ; « 3G » 400 kbit/s et 400 ms de RTT cible
(DevTools applique 2 000 ms de latence de requete a ce dernier ; le banc n'applique que 400 ms). Le cahier ne dit pas quel profil
« 3G » il entend.

Temps serveur de `/api/public/carte/geo` : 190 a 430 ms au p50 selon le zoom (la charge de la machine est de 80 %). Il n'y a ni
`Cache-Control` ni cache serveur : chaque visiteur redemande 4 requetes SQL (la longueur du reseau est en cache 5 minutes), la serialisation et la compression gzip de 0,56 a 1,4 Mo.
La requete des troncons seule a pris 75 ms en `EXPLAIN ANALYZE` a charge faible sur le jeu de 20 000 (`ST_SimplifyPreserveTopology` :
environ 60 ms de plus que sans simplification, 11 ms) ; sur le 261 387, sous charge, 320 a 570 ms.

### 10.2 Rendu en navigateur, cache vide

Instrument : `perf/serveur-3g.ts`. Il sert le frontend compile (`frontend/dist`, gzip niveau 6 comme `nginx.conf`) et l'API (branchee sur
le clone) sur une origine, derriere un limiteur applicatif : chaque requete attend le RTT (3 RTT sur une connexion neuve), un seau commun
distribue le debit. Navigateur : celui du volet integre, **sans limitation CPU**. Mesure : `performance.now()` depuis le debut de la
navigation, instrument injecte dans `index.html` (le bundle n'est pas modifie). **`interfaceMs`** = premier instant ou la legende affiche
« N km de routes classees » avec N non nul, c'est-a-dire l'interface mise a jour avec les donnees, dans le meme cycle de rendu React que les
traces. **C'est un proxy du rendu des traces** : le canvas Leaflet n'etait pas lisible dans ce navigateur, le dessin lui-meme n'est donc pas
chronometre. Chaque configuration a ete mesuree deux fois, dans deux origines distinctes (`127.0.0.1` et `localhost`), donc sans cache commun.

| Frontend | Profil | Octets transferes | Fin des donnees | `interfaceMs` |
|---|---|---|---|---|
| Avant (chunks `charts` et `pdf`) | 1,6 Mbit/s, 150 ms | 600 663 | 6,8 s ; 7,4 s | **7,4 s ; 8,2 s** |
| Avant | 400 kbit/s, 400 ms | 600 663 | 16,2 s ; 16,1 s | **16,6 s ; 16,3 s** |
| **Apres** | 1,6 Mbit/s, 150 ms | 323 306 | 4,7 s ; 6,7 s | **4,9 s ; 6,9 s** |
| **Apres** | 400 kbit/s, 400 ms | 323 306 | 11,5 s ; 11,9 s | **11,6 s ; 12,1 s** |
| Apres, visite suivante (rechargement, cache plein, 304) | 400 kbit/s, 400 ms | 2 528 | 2,3 s | **2,5 s** |

**Lecture.**
- **A20 « rendu < 3 s en 3G » n'est pas atteint a la premiere visite**, sous aucun des deux profils, meme apres le correctif. Le
  transfert seul de 323 Ko prend 1,6 s au profil optimiste (3 RTT compris : 2,1 s) ; le reste est la cascade de requetes
  (le point d'entree, puis la page, puis ses 14 petits chunks, puis l'API) et l'execution du JavaScript.
- **Le correctif du bundle retire 46 % des octets** et 1,3 a 5,0 s selon le profil et l'echantillon. Il laisse 323 Ko, dont
  222 Ko de JavaScript et l'API (86 466 octets).
- **Les mesures de navigateur portent la charge du poste** (80 a 100 %) sur l'execution JavaScript : les ecarts entre deux
  echantillons d'une meme configuration (4,9 et 6,9 s) en sont le signe. Pas de limitation CPU (un telephone d'entree de gamme est plus lent).
- **Hors de ce qui est mesure** : `leaflet.css` est charge depuis `unpkg.com` (service tiers, feuille de style bloquante pour le rendu),
  non limite ici ; les tuiles OpenStreetMap, tiers, ne passent pas par le limiteur.
- **Piste non mise en oeuvre** : `ExportControl` importe `jspdf` et `html2canvas` statiquement ; ils sont maintenant dans le chunk de la
  page Geoportail (199 Ko gzip). Un `import()` dynamique au clic les en sortirait.

## 11. Constats hors du perimetre, a traiter par qui de droit

1. **`unaccent` n'est cree par aucune migration.** `GET /api/public/carte/geo` repond **500** sur une base reconstruite depuis les
   migrations (`chantiers.service.ts` appelle `unaccent(...)`), alors que la production l'a recue hors chaine. Le banc cree l'extension dans
   son clone.
2. **Le complement serveur de la recherche du geoportail ne montre jamais rien** : `GeoportailPage.tsx` lit `.data.troncons`, alors que
   `/api/search` rend un tableau. Le defaut est independant des performances ; il masque l'effet de l'index sur la recherche de la page.
3. **`TerrainPortionsPage` n'envoie aucune emprise** a `current-context` : le rattachement terrain balaie toujours le reseau classe entier.
   Tenable aujourd'hui (1 772 troncons), pas si le reseau classe grandit de plusieurs ordres de grandeur.
4. **`/api/public/carte/geo` n'a ni cache ni `Cache-Control`.**
5. **`leaflet.css` est charge depuis `unpkg.com`** par `index.html`.

## 12. Limites

- **Jeu synthetique** : voir section 4. Les chiffres de deviation et de chargement du graphe en dependent beaucoup.
- **Machine locale, partagee et chargee** (section 3) : les valeurs absolues sont pessimistes et irreproductibles a l'identique.
  Les seuils ont ete verifies *malgre* la charge ; un seuil non tenu sous charge n'est pas prouve non tenu a vide, et inversement un seuil tenu
  ici peut ne pas l'etre sur un serveur plus lent. Les rapports avant/apres n'ont de sens que la ou le plan change.
- **Pas la production** : base `replay` sans donnees reelles ; statistiques du planificateur (`ANALYZE`) sur le jeu synthetique ;
  `shared_buffers` de 128 Mo ; pas de Traefik, pas de TLS, pas de reseau.
- **Pas de charge concurrente**, sauf le scenario a 10 clients du rattachement. La recherche, la deviation et la carte ont ete mesurees
  un client a la fois.
- **Froid partiel** : processus neuf, mais cache PostgreSQL chaud.
- **Les autres tables** (ouvrages, points noirs, postes, chantiers) sont vides ou presque ; la couche chantiers de la carte publique n'a pas de donnees.
- **Rendu navigateur** : proxy `interfaceMs`, pas de limitation CPU, limiteur applicatif et non de paquets, tuiles tierces et `leaflet.css`
  hors mesure, deux echantillons par configuration.
- **« Geoportail fluide »** : aucune mesure.
- **Le verdict de la deviation** repose sur 33 deviations trouvees ; un jeu plus maille donnerait d'autres chiffres.
- Le critere « moins de 5 % de refus pour emprise trop large » est celui du banc, pas du cahier.

## 13. Rejouer

Voir `backend/tests-integration/perf/README.md`. Fichiers de resultats de ce dossier :

| Fichier | Contenu |
|---|---|
| `resultats-261387.json` | banc complet, 200 iterations, 261 387 troncons, avant et apres (45 verifications sur 45 apres) |
| `resultats-261387-repetition.json` | meme banc, phase apres seule, **une heure plus tard** (44 verifications sur 45 : `recherche.mot-de-nom.http`) |
| `resultats-20000.json` | banc complet, 200 iterations, 20 000 troncons, avant et apres (45 sur 45) |
| `resultats-261387-sans-correctifs.json` | contre-epreuve : 261 387 troncons, **sans** les migrations, code de ce lot (11 verifications en echec, code de sortie 1) |
| `resultats-20000-sans-correctifs.json` | contre-epreuve a 20 000 troncons : **45 sur 45, le banc n echoue pas** (section 14) |
| `resultats-261387-essai-recherche-bitmap-force.json` | essai **ecarte** : recherche avec `enable_seqscan` et `enable_indexscan` coupes (section 6). Ne decrit pas l'etat du depot |
| `resultats-261387-exploration-code-origine.json` | exploration du 261 387 sur le **code d'origine**, 30 iterations, sans migrations. **Defauts connus** : le jeton JWT avait expire pour les scenarios HTTP de la fin (401), seuls les scenarios de service sont valides ; sert de reference pour la construction quadratique du graphe |

## 14. Contre-epreuve : le banc echoue-t-il quand il le doit ?

Un banc qui ne peut pas echouer ne prouve rien. `--sans-correctifs` saute les deux migrations ; le code de ce lot (index du graphe,
arrondi de la carte) reste en place.

- **261 387 troncons : le banc echoue** (code de sortie 1, 11 verifications en echec) : `urbain-5m.tout` p95 1 094 ms (service) et 1 241 ms (HTTP),
  `urbain-15m.tout` 1 013 et 918 ms, `urbain-5m.tout.emprise4km` 368 ms, `recherche.code-exact.http` 4 854 ms, `mot-de-nom` 1 081 ms,
  `absent` 948 ms, `deviation.calcul.service` 2 095 ms. Le chemin du terrain par defaut (`reseau` classe) **passe** a l'origine
  (p95 69 ms en HTTP) : c'est le plan du reseau classe, inchange par les migrations.
- **20 000 troncons : le banc n'echoue pas** (45 verifications sur 45, charge de la machine 29 a 86 %). Au volume minimal du cahier, l'etat
  d'origine tient tous les seuils. **Les seuils ne sont depasses qu'au volume du registre complet**, et le parcours sequentiel de 261 387
  troncons en est la cause. A retenir : une mesure a 20 000 troncons n'aurait rien revele.

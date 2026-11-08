# Scénarios d'acceptation à tests partiels : ce qui a été comblé, et ce qui ne peut pas l'être ici

Établi le 22/10/2026 sur la base du commit `2943e22` (branche `lot/03-map-matching`). Périmètre : les
scénarios **A1, A5, A7, A8, A25, A28, A29** de `REQUIREMENTS_TRACEABILITY.md`. **A23 n'a pas été traité** (voir
la dernière section).

> Méthode. Pour chaque scénario : lire ce que la matrice dit qui **reste**, inspecter le code et les tests,
> écrire d'abord un banc qui exerce le comportement attendu **contre le code réel et une vraie base PostGIS**,
> constater ce qui est rouge, corriger, constater le vert. Les bancs passent par les routes réelles (jetons
> signés, rôle et module lus en base, contrôle territorial, audit transactionnel) dans un clone jetable de
> `replay`. Rien n'est simulé côté serveur.
>
> **Aucune de ces preuves n'est une preuve sur appareil.** Un double de `navigator.geolocation`, une file
> locale en `Map` et des coupures simulées ne remplacent ni un téléphone, ni IndexedDB, ni le service worker,
> ni un vrai réseau guinéen. Ce fichier dit, scénario par scénario, ce que cela laisse non vérifié.

## 1. Vue d'ensemble

| Scénario | Ce qui manquait | Ce qui a été ajouté | Preuve | Reste non vérifié |
|---|---|---|---|---|
| **A1** ouverture du mode terrain | parcours d'écran : seul le hook GPS était testé | 18 tests d'écran, 2 de hook, **un défaut corrigé** (refus d'autorisation : plus de moyen de réessayer) | `vitest` frontend : 506 passés | tout ce qui exige un appareil |
| **A5** métré < 1 % | métré géométrique branché sur aucune saisie | contour GPS (`emprise`) accepté à la saisie, en synchronisation et à la resoumission ; méthode `EMPRISE_UTM` ; 2 migrations | banc `metre-defaut` : **73/73**, 37 figures, pire écart **0,142 %** | aucun écran ne produit de contour ; resoumission avec contour non éprouvée en base |
| **A7** hors ligne, 50 saisies | aucun test contre une base, aucune file de 50 | banc `sync` (section A7), 7 tests de file de 50, **5 défauts corrigés** | banc `sync` : **67/67** (A7 et A8) | appareil réel ; **il n'existe pas de file locale d'« observations »** |
| **A8** conflit signalé | aucun parcours de bout en bout | banc `sync` (section A8), audit de l'écriture arbitrée | idem | **aucun écran ne signale ni ne tranche un conflit** |
| **A25** aucun secret | mesure faite une fois à la main | balayage automatisé rejoué par `npm test` ; script d'historique | `src/securite` : 21 tests ; injection détectée | **l'historique contient l'adresse d'un serveur** (voir §3.5) |
| **A28** import idempotent | rejeu, lot modifié, lignes invalides non éprouvés en base | banc `import` : **39/39**, **4 défauts corrigés** | banc `import` | étape 2 (application au référentiel) : n'existe pas |
| **A29** tâches internes | table seule : ni service, ni route, ni parcours | service, route, 76 vérifications | banc `taches-internes` : **76/76** | rapprochement financier TI-02 : bloqué (B-11) |

## 2. Les défauts réels trouvés par les bancs

Chacun était **rouge avant correction** et **vert après** (les sorties rouges sont citées dans les sections).
Classés par gravité pour la donnée de terrain.

| # | Défaut | Conséquence | Corrigé |
|---|---|---|---|
| 1 | `sync` : une opération **refusée** puis renvoyée sous la même clé était rendue `REJOUEE`, donc comme un **succès** | le téléphone retirait la saisie de sa file : **perte sans erreur** (cas de l'ordre inversé : une modification arrivée avant sa création) | oui |
| 2 | `sync` : une opération **en conflit** renvoyée était rendue `REJOUEE` | le téléphone croyait sa version retenue alors qu'un responsable devait trancher | oui |
| 3 | `sync` : deux envois simultanés de la même opération faisaient échouer **tout le lot** (409) | lot perdu pour la requête perdante | oui |
| 4 | `sync/resolve` LOCAL : l'écriture de l'observation n'était **pas auditée** | violation de la règle 3 d'`AGENTS.md` | oui |
| 5 | file locale : cinq retours d'« online » **sans connexion utilisable** marquaient les 50 saisies `abandonnee` | la synchronisation s'arrêtait, sans que le réseau soit en cause | oui |
| 6 | import : un saut de ligne dans un champ cité coupait une ligne en deux | 130 lignes lues pour 100 envoyées | oui |
| 7 | import : un champ **en trop** était jeté, un champ **en moins** complété par du vide | ligne `VALIDEE` avec des données décalées ou tronquées | oui |
| 8 | import : deux envois simultanés (même fichier, ou fichiers différents) répondaient 409 | import refusé pour une course | oui |
| 9 | import : un lot de **20 000 lignes** dépassait le délai de transaction de 5 s | erreur 500, rien d'enregistré | oui |
| 10 | GPS : après un refus d'autorisation, l'écran gardait « Arrêter le suivi » et n'offrait plus « Me localiser » | l'agent n'avait aucun geste évident pour réessayer | oui |
| 11 | tâches internes (code neuf, trouvé avant le commit) : course sur la référence | 500 sous six créations simultanées | oui |
| 12 | `sync` : une **référence inconnue** (revêtement absent du référentiel, tronçon inexistant) faisait répondre **500 à tout le lot** | les opérations suivantes du lot n'étaient pas traitées, le téléphone réessayait à l'identique | oui |

Constatés et **non corrigés** (décision ou périmètre d'autrui) :

- **L'historique Git contient l'adresse d'un serveur distant** (6 commits). La matrice dit « IP de production
  jamais committée » : c'est inexact pour l'historique (voir §3.5).
- **Divergence frontend / backend sur les modules vides.** Le backend refuse tout module à un compte dont
  `modulesAutorises` est vide (correction du 05/09/2026) ; `frontend/src/lib/modules.ts` le traite encore comme
  « aucune restriction », et un test l'affirme (« comportement historique »). Le compte ouvre donc l'écran
  terrain, puis chaque appel répond 403. À arbitrer.
- **`observations.geom` n'est jamais alimentée** (ni par la route, ni par la synchronisation) ; aucun lecteur ne
  l'utilise aujourd'hui. Les coordonnées restent dans `lat` et `lon`.
- **Aucune file locale d'observations, aucun écran de conflit** (voir A7 et A8).
- **La route en ligne `POST /api/v2/portions` répond encore 500** pour un revêtement, un état ou une praticabilité absents du
  référentiel (violation de clé étrangère non traduite). La synchronisation, elle, refuse proprement (n° 12).

## 3. Par scénario

### 3.1 A1 : ouverture du mode terrain

**Manquait.** `usePositionGps` avait 15 tests (le hook seul). Rien n'éprouvait ce que l'agent *voit et peut
faire* en ouvrant l'écran : chaque cause d'échec de position, la reprise, l'ouverture sans réseau, le moment où
le contexte est demandé.

**Ajouté.**

- `frontend/src/pages/TerrainOuverture.test.tsx` : 18 tests sur `TerrainPortionsPage`. Ouverture sans rien
  demander à l'appareil ; appareil sans géolocalisation ; autorisation refusée **puis accordée puis relancée** ;
  signal introuvable (la veille reste active) ; précision et sa tendance ; contexte demandé 2 s après le premier
  point avec position **et** précision, pas pour une oscillation de moins de 15 m, une seule requête pour une
  rafale ; ouverture hors ligne (le GPS fonctionne, le contexte indisponible est annoncé, aucun tronçon n'est
  affiché sans réponse du serveur, le contexte revient au point suivant) ; arrêt du GPS au démontage.
- **Défaut corrigé** (`hooks/usePositionGps.ts`) : un refus d'autorisation termine la veille. Avant, le bouton
  restait « Arrêter le suivi » et « Me localiser » avait disparu. Le signal « indéterminé », lui, laisse la
  veille ouverte.
- 2 tests de hook pour ce comportement.

**Preuve.** `cd frontend && npx vitest run` : **39 fichiers, 506 tests, 0 échec**. Rouge avant la correction :
2 tests sur 18 (« autorisation REFUSEE… » et la reprise après refus).

**Non vérifié, et pourquoi.** Tout ce qui exige un appareil : la fenêtre d'autorisation du navigateur, la puce
GPS, la perte de signal réelle, la consommation de batterie, le service worker. **A1 reste « jamais éprouvé sur
appareil ».** Le garde-fou de route par module est celui de `ProtectedRoute` (voir la divergence ci-dessus).

**Statut proposé.** TP inchangé ; la preuve d'écran est consignée.

### 3.2 A5 : métré, écart < 1 % en projection métrique

**Manquait.** Les fonctions `epsg_utm` et `metre_utm` et `POST /api/v2/geo/metre` existaient, mais « les défauts
sont saisis par mesures, pas par géométrie ; le métré géométrique n'est branché sur aucun écran ».

**Ajouté.**

- **Branchement à la saisie du défaut** : `emprise` (GeoJSON 4326, `LineString`, `MultiLineString`, `Polygon`,
  `MultiPolygon`) accepté par `POST /api/v2/defauts`, `POST /api/v2/defauts/:id/resoumettre` et la
  synchronisation hors ligne (`Defaut`/`CREATE`). Le serveur mesure le contour dans son fuseau UTM
  (`metre_utm`) et en tire la quantité, méthode `EMPRISE_UTM`, provenance `DERIVED`.
- **Règles** (`field/defauts.regles.ts`, pures) : le constat saisi l'emporte sur le contour, qui l'emporte sur le
  rectangle longueur x largeur et sur le comptage conventionnel. METRE : longueur de la ligne ; METRE_CARRE :
  surface du polygone, ou longueur de la ligne x largeur saisie ; METRE_CUBE : surface x profondeur. Un contour
  remplace les mesures requises `LONGUEUR` et `LARGEUR` d'une surface, **jamais** `PROFONDEUR` ni `NOMBRE`. Un
  contour qui ne donne rien dans l'unité du type n'est pas une erreur (il reste une localisation).
- **Refus** : contour invalide refusé avec la raison de PostGIS (`EMPRISE_INVALIDE`), **jamais réparé** ;
  coordonnées hors de l'étendue WGS 84 (`EMPRISE_ILLISIBLE`, un contour en mètres envoyé comme du 4326 n'est pas
  mesuré « dans l'Atlantique ») ; plus de 20 000 positions ; ligne plus longue que le tronçon.
- **Migrations** `20261024300000_defaut_methode_emprise_utm` (valeur d'énumération) et
  `20261024310000_defaut_emprise_coherence` (contrainte `CHECK` : la méthode `EMPRISE_UTM` exige une emprise,
  tenue par la base). Descentes écrites et **vérifiées** par `verifier.sh` (4 puis 2 vérifications, 0 échec).
- Oracle **indépendant de PostGIS et de PROJ** (`tests-integration/lib/geodesie.ts`) : projection Transverse de
  Mercator par les séries de Krüger, distance de Vincenty, aire authalique d'un rectangle de graticule. Il est
  lui-même confronté à PROJ (< 1 mm en 3 points, dont près de 12° O), à Vincenty 1975 (Flinders Peak -
  Buninyong) et à `ST_Distance`/`ST_Area` (`geodesie.test.ts`, 10 tests).

**Preuve.**

```bash
cd backend && DATABASE_URL=postgresql://<utilisateur>:<motdepasse>@127.0.0.1:5434/replay npx tsx tests-integration/metre-defaut.integration.mts
# 73/73 verifications reussies ; Pire ecart relatif sur 37 figures : 0.1422 % (seuil A5 : 1 %)
```

Figures : 8 carrés construits en mètres UTM (10 à 2 000 m de côté, fuseaux 28N et 29N) dont l'écart est **0,0000 %
(sous le ppm)** ; 2 lignes construites ; 21 rectangles de graticule dans 7 villes (Conakry, Boké, Labé près de
12° O, Kankan, Siguiri, Nzérékoré, Faranah) contre l'aire ellipsoïdale, écart 0,009 à 0,142 % ; 6 lignes contre
Vincenty dont **790 km traversant le pays**, écart 0,008 à 0,108 %. Le fuseau suit le point intérieur de part et
d'autre de 12° O. Tests unitaires : `defauts.regles.emprise.test.ts` (18), `defauts.emprise.test.ts` (18),
compléments dans `defauts.routes.test.ts` et `defauts.sync.test.ts`.

**Non vérifié, et pourquoi.**

- **Aucun écran ne produit de contour.** Le type `PendingDefaut` accepte désormais `emprise`, le contrat est
  prêt ; l'outil de tracé GPS reste à écrire et ne s'éprouve que sur appareil.
- **La resoumission avec contour n'est éprouvée que par des tests à base simulée.** Le client Prisma généré sur ce
  poste ne connaît pas la nouvelle valeur d'énumération et ne sait pas relire ces lignes : le banc relit en SQL.
  **`prisma generate` est nécessaire après la fusion** (comme pour toute valeur d'énumération ajoutée).
- La précision du GPS lui-même (un contour tracé à 5 m près) n'est pas dans A5 : l'écart mesuré est celui du
  *calcul*, pas celui du relevé.

**Statut proposé.** Le critère « longueur et surface calculées en projection métrique, écart < 1 % sur
géométries connues » est **tenu** et branché à la saisie serveur. Proposition : **TT pour le calcul et la saisie
serveur, avec la réserve écrite « aucun écran de tracé »**.

### 3.3 A7 : hors ligne, 50 observations, 0 doublon, 0 perte

**Manquait.** Les tests de `sync.service` étaient à base simulée ; `offlineSync` avait 23 tests unitaires. Aucune
file de 50, aucune coupure au milieu, aucun ordre inversé, aucune vérification en base.

**Ajouté.**

- **Banc `sync.integration.mts`, section A7** (comparée à un **modèle tenu par le banc** :
  les opérations émises, pas seulement les réponses du serveur). 50 observations en un lot, rejouées trois fois
  (dont depuis un autre appareil du même agent et en ordre inverse) : 0 écriture de plus. Lot tronqué après 20
  opérations, réponse « perdue » et renvoi de 35 : 20 `REJOUEE` + 15 `SYNCHRONISE`. **Ordre inversé** : 25
  modifications avant leur création, puis renvoi : elles sont **appliquées**. Une opération invalide sur 50 : 49
  passent, 50 réponses. **Quatre envois simultanés** du même lot : 0 doublon, 0 erreur. **Coupure au milieu de la
  transaction** (déclencheur qui échoue à l'écriture de la trace) : ni observation, ni opération, ni audit, et la
  reprise aboutit. 20 défauts hors ligne : 20 points PostGIS non nuls, égaux au point émis à 1e-9 degré. 5
  portions, dont le cas d'un **revêtement absent du référentiel** : refus retentable, puis les mêmes opérations
  **appliquées** quand le vocabulaire arrive ; une portion aux bornes inversées reste refusée au renvoi. Une clé connue d'un autre compte n'est pas un oracle. Bilan : 195 observations émises, 0 manquante, 0
  en trop dans la base.
- **Cinq défauts corrigés** dans `field/sync.service.ts` : rejeu fidèle (un refus reste un refus, un conflit
  reste un conflit), refus temporaire **réévalué** au renvoi (`rejetRetentable`, la trace passe en `upsert`),
  course absorbée par un seul réessai, référence inconnue rendue en refus (`REFERENCE_INCONNUE:<champ>`), voir §2
  n°1, 2, 3 et 12.
- **File locale** : `offlineSync.cinquante.test.ts`, 7 tests. 50 défauts, coupure au milieu, réponses perdues, 30
  défauts + 20 portions sur réseau intermittent : 50 créations exactement, aucune clé nouvelle pendant les
  reprises. **Défaut corrigé** : six coupures d'affilée n'abandonnent plus les saisies (une erreur *sans réponse*
  ne compte pas dans le plafond de tentatives ; une erreur du serveur compte toujours).

**Preuve.** Avant correction : `53/64 verifications reussies` (11 rouges ; le 12e défaut a été trouvé ensuite par l'ajout des portions). Après :

```bash
cd backend && DATABASE_URL=...replay npx tsx tests-integration/sync.integration.mts      # 67/67
cd frontend && npx vitest run src/lib/offlineSync                                        # 30 tests, dont les 7 de la file de 50
cd backend && npx vitest run src/field/sync.service.test.ts src/api-v2/sync.routes.test.ts   # 27 + 26 tests
```

**Non vérifié, et pourquoi.**

- **La preuve sur appareil.** IndexedDB, le service worker, l'évènement `online` d'un vrai téléphone, la perte
  de réseau réelle, un navigateur tué en cours d'envoi : hors de portée sans téléphone. Le magasin local est ici un `Map`.
- **Il n'existe pas de file locale pour le type « Observation ».** La file terrain remonte des **inspections, des
  défauts et des portions** (`offlineDb.ts`) ; le serveur sait recevoir des observations, aucun écran ne les met en
  file. Les « 50 observations » sont donc éprouvées côté serveur, et côté client avec des défauts et des portions,
  qui passent par le même protocole.
- Les photos (envoi pas à pas) ne sont pas dans le banc du serveur.

**Statut proposé.** TP inchangé : la preuve **serveur** est complète (50, rejeux, coupures, ordre inversé,
concurrence, atomicité, PostGIS) ; la preuve **appareil** manque, et la file d'observations n'existe pas.

### 3.4 A8 : conflit signalé, deux versions conservées

**Manquait.** « Pas de parcours de bout en bout. »

**Ajouté** (banc `sync.integration.mts`, section A8) : deux appareils, même objet, versions
successives ; le second reçoit un `CONFLIT` avec l'identifiant du conflit ; l'observation garde la version du
premier **intacte** ; le conflit porte la version locale **et** l'état du serveur ; `/status` compte le conflit à
part des échecs ; le **renvoi rend le même conflit**, pas un second ; résolution `SERVEUR` (l'opération devient
`REJETE`) et `LOCAL` (version suivante, l'ancienne version reste dans `conflits_sync`) ; **trois appareils** :
trancher le second en `LOCAL` est refusé (409) sans rien écraser ; **deux arbitres simultanés** : un seul gagne,
état final cohérent ; modification contre suppression dans les deux sens, **la suppression reste logique** ;
création collisionnée (409 `NOUVEL_IDENTIFIANT_REQUIS`) ; conflit de défaut réservé aux gestionnaires, `LOCAL`
refusé ; un autre agent ne tranche ni ne lit ; aucune ligne supprimée physiquement ; audit complet.
**Défaut corrigé** : l'arbitrage `LOCAL` n'auditait pas l'écriture de l'observation (avant et après).

**Preuve.** Même banc que A7 (rouge : renvoi rendu `REJOUEE`, audit manquant ; vert après).

**Non vérifié, et pourquoi.** **Aucun écran** n'appelle `/v2/sync/resolve` et aucun ne montre un conflit : le
client traite un `CONFLIT` de défaut comme une erreur (nouvel essai, puis abandon avec le motif). Le signal
existe dans la réponse de l'API et dans `/status` ; l'agent ou le responsable ne le voit pas.

**Statut proposé.** TT pour le protocole serveur (signalé, deux versions conservées, arbitrage audité) ;
**réserve écrite : aucune interface de signalement ni d'arbitrage**.

### 3.5 A25 : aucun secret

**Manquait.** « Le volet dépôt est prouvé » par une mesure unique (225 commits, une fois). Rien ne la rejouait,
et le seul contrôle automatique de la CI (`grep` sur les migrations et `.env.example`) ne voit pas le reste.

**Ajouté.** `backend/src/securite/` : `balayage-secrets.ts` (six règles : clé privée, nom de fichier secret,
jeton connu AWS/GitHub/Slack/Google/Stripe/npm/JWT, mot de passe dans une URL, affectation secrète, adresse IPv4
publique), `exceptions-secrets.ts` (5 exceptions, **chacune justifiée**), `depot-sans-secret.test.ts` (21 tests).
Le balayage lit les fichiers **suivis par git**, rapporte *où* et jamais *quoi* (la valeur est masquée), et ses
fixtures sont assemblées à l'exécution (le fichier de test ne contient pas ce qu'il cherche).

Le test échoue : sur une clé, un fichier secret, un jeton, un mot de passe, une adresse publique non justifiée ;
sur une **exception périmée** ou sans justification ; sur une exception qui couvrirait une clé, un fichier secret
ou un jeton (on les retire, on ne les excuse pas). **Éprouvé par injection** : un fichier fautif ajouté à l'index
(un mot de passe en affectation et une adresse publique) fait échouer la suite avec les deux lignes, valeurs
masquées ; retiré ensuite.

Script manuel : `npm run securite:balayer` (arbre) et `npx tsx scripts/balayer-secrets.ts --historique`
(chaque ligne ajoutée de chaque commit de toutes les branches).

**Preuve.**

```text
npx tsx scripts/balayer-secrets.ts --historique
Arbre : 929 fichiers lus, 1 ignores, 9 trouvaille(s), 0 non excusee(s).
Historique : 314 commits parcourus, 17 trouvaille(s), 8 non excusee(s).
```

Les 9 trouvailles de l'arbre sont les 5 faux positifs justifiés (adresse factice de tests, URL factices d'un test
de garde, secrets JWT d'un script de base jetable, empreinte SHA-256 d'un jeton d'essai dans une sortie
`EXPLAIN`). Les **8 trouvailles de l'historique sont réelles** : l'adresse d'un serveur de sauvegarde distant,
avec le nom du compte de service, dans 6 commits anciens (`e976949b`, `9b3aae75`, `5093da04`, `087ef5c7`,
`6be857fa`, `99aa2dff`). Elle a été retirée de l'arbre le 13/10/2026 (`docs/rai-v3/AUDIT_SECURITE_DEPOT_PUBLIC.md`)
mais **reste lisible dans l'historique**. La valeur n'est volontairement pas reproduite ici.

**Non vérifié, et pourquoi.** Aucun mot de passe, aucune clé privée ni aucun jeton de format connu dans
l'historique de ce clone. Le balayage ne comprend pas le sens : un secret aléatoire sans mot-clé devant lui lui
échappe. Les quatre alertes de sécurité **bloquées faute d'autorisation de production** et `bdri_app` toujours
superutilisateur ne sont pas du ressort d'un test de dépôt. Cet historique est celui du clone local, pas
nécessairement celui du dépôt public.

**Statut proposé.** Corriger la phrase de la matrice : le volet *arbre* est maintenant rejoué par `npm test` ;
le volet *historique* contient une adresse de serveur (6 commits), **non « jamais committée »**. PA inchangé.

### 3.6 A28 : import BDR/ANASUR idempotent, 100 % des lignes dans un statut

**Manquait.** Les deux propriétés étaient tenues par la base (contrainte sur les compteurs) et par 14 tests à base
simulée ; ni le rejeu, ni le lot partiellement modifié, ni les lignes invalides n'étaient éprouvés en base.

**Ajouté.** Banc `import.integration.mts` (39 vérifications) par la route multipart réelle. Le CSV est fabriqué
depuis un **modèle du banc qui connaît le statut de chaque ligne** (80 valides, 10 invalides de 10 sortes, 10
doublons internes) : chaque ligne est comparée à son statut attendu et à son motif, numérotée 1..100 sans trou ;
somme des statuts = `lignesLues` = compteurs ; charge originale conservée ; empreinte = SHA-256 des octets reçus
calculé indépendamment. **Rejeu** (renommé, par un autre importateur) : 200, même lot, **aucune écriture** (lots,
lignes, audits identiques) ; même fichier d'une autre source : autre lot. **Lot partiellement modifié** : nouveau
lot de 105 lignes, premier lot intact, ligne modifiée conservée sous ses deux états, **aucune écriture dans le
référentiel**. Export d'erreurs : exactement les 20 lignes. Fichiers sans ligne exploitable (colonne obligatoire
absente, CRS refusé, tout rejeté) : lot `REJETE` avec son motif. GeoJSON de 50 entités. **Concurrence** : même
fichier x4 et quatre fichiers différents. **Atomicité** : une coupure à l'écriture des lignes n'en laisse aucune.
Volume : 20 000 lignes. Accès : LECTEUR 403, sans autorisation écrite 400. Bilan sur les 15 lots du banc.
**Quatre défauts corrigés** (§2 n°6 à 9) dans `import/pivot.noyau.ts` (lecteur CSV conforme à la RFC 4180, un
guillemet ouvert n'avale pas le fichier, nombre de champs vérifié) et `import/import.service.ts`.

**Preuve.** Avant correction : `21/39`. Après : `39/39 verifications reussies`. Tests : `pivot.csv.formes.test.ts`
(9), `import.service.test.ts` (4).

**Non vérifié, et pourquoi.** **L'étape 2 (application au référentiel) n'existe pas** : aucun rapprochement
d'identifiants, aucun échantillon approuvé (`BDR_ID_CROSSWALK_SPEC.md`). Le statut `IMPORTEE` n'est donc jamais
atteint et la déduplication *contre le référentiel* n'existe pas. Un lot de 20 000 lignes prend ~16 s sur ce
poste (une seule requête) : à confirmer derrière le délai du reverse proxy.

**Statut proposé.** TT pour l'étape 1 (réception, empreinte, statut par ligne, idempotence), mise à jour de la
ligne : « le rejeu, le lot modifié et les lignes invalides sont éprouvés en base ». L'étape 2 reste absente.

### 3.7 A29 : tâches internes avec preuves avant/après, rapprochement en lecture

**Manquait.** TI-01 était **une table** (9 contraintes, 22 assertions SQL) et un garde-fou de modèle. Il n'y avait
ni service, ni route, ni parcours : « une tâche clôturée possède des preuves » n'était tenu que par la base, qui
refuse sans dire pourquoi.

**Ajouté.**

- `field/taches-internes.regles.ts` (pur, 22 tests) : transitions (`CLOTUREE` et `ABANDONNEE` terminales, une
  intervention courte se clôture depuis `OUVERTE`), ce qui manque pour clôturer, retard, alertes de
  rapprochement, détection des champs contractuels.
- `api-v2/taches-internes.routes.ts` : création idempotente par `clientOperationId` (rattachement troncon /
  emprise / ouvrage / défaut / point GPS, contrôle territorial A10), démarrage, **preuves avant/après**
  (photo + date de prise ; « après » ne précède pas « avant » ; la même photo en « avant » et « après » est
  refusée), clôture (dit *ce qui manque*, quantité constatée avec son unité), abandon motivé, lecture, liste
  paginée, `GET /rapprochement`.
- **La frontière DigitalRoad est tenue deux fois** : la table n'a aucune colonne contractuelle (lu dans
  `information_schema`), et la route refuse en le disant tout champ `montant`, `coût`, `marché`, `entreprise`...
- **Le rapprochement est en lecture seule** : `ECHUE_NON_CLOTUREE`, `CLOTUREE_DEFAUT_ENCORE_ACTIF`,
  `DEFAUT_TRAITE_TACHE_NON_CLOTUREE`, `RESPONSABLE_INACTIF`. Deux appels ne changent ni les tâches, ni le journal,
  ni les opérations. La réponse déclare `financier.disponible: false` (B-11).

**Preuve.**

```bash
cd backend && DATABASE_URL=...replay npx tsx tests-integration/taches-internes.integration.mts   # 76/76
cd backend && npx vitest run src/field/taches-internes src/api-v2/taches-internes                 # 61 tests (17 garde-fou + 22 + 22)
```

Le banc couvre : le parcours complet (5 lignes de journal), les cas limites des preuves (sans date, dans le
futur, moment inconnu, photo identique, ordre inversé, remplacement avant clôture, refus après clôture, **aucun
fichier orphelin après 8 refus**), de la clôture (sans preuve, quantité sans unité, deux clôtures simultanées, re-clôture), de l'abandon, de la frontière
(champ contractuel refusé, aucun marché/décompte/OT/chantier touché), l'idempotence (dont **6 créations
simultanées**), le rattachement et le périmètre, la visibilité, la pagination, le **contournement du service par
SQL direct** (la base refuse encore), le rapprochement.

**Non vérifié, et pourquoi.** **Le rapprochement physique / financier de TI-02** : il oppose les travaux
constatés aux décomptes de DigitalRoad, qui n'existent pas ici (blocage B-11). Ce qui est fait compare des faits
que la plateforme possède. Aucun écran de tâches internes. Les photos sont stockées par le même dispositif que
les photos de défauts (disque local) ; le plafond de stockage global s'applique.

**Statut proposé.** TT pour TI-01 (parcours serveur complet, preuves tenues par la base *et* dites par le
service) ; TI-02 financier reste bloqué. Le critère A29 « aucun paiement, décompte ou marché n'est créé ni
modifié par la plateforme » est éprouvé (compteurs avant/après).

### 3.8 A23 : non traité

Aucune action. Les points restants (formats L²R non publiés, orchestration complète du pivot, correspondance
éditable des identifiants) dépendent d'échantillons ou d'accès externes, ou de l'étape 2 de l'import (A28).

## 4. Commandes et résultats

À lancer depuis la racine du dépôt. Les bancs exigent une base **locale** nommée `replay` (la garde refuse tout
autre cible), créent leur clone `essai_<nom>` et le détruisent.

| Commande | Résultat |
|---|---|
| `cd backend && npx tsc --noEmit -p .` | aucune erreur |
| `cd backend && npx vitest run` | 130 fichiers, 1 887 tests, 0 échec |
| `cd frontend && npx tsc --noEmit` | aucune erreur |
| `cd frontend && npm run lint` | 0 erreur, 4 avertissements préexistants |
| `cd frontend && npx vitest run` | 39 fichiers, 506 tests, 0 échec |
| `bash tests-integration/run.sh` | 14 bancs, 377 vérifications, code 0 |
| `verifier.sh --seulement 20261024300000_defaut_methode_emprise_utm` | 4 vérifications, 0 échec |
| `verifier.sh --seulement 20261024310000_defaut_emprise_coherence` | 2 vérifications, 0 échec |

**Bilan du 22/10/2026** (poste de développement, base PostGIS locale) :

- `cd backend && npx vitest run` : **130 fichiers, 1 887 tests, 0 échec**.
- `cd frontend && npx vitest run` : **39 fichiers, 506 tests, 0 échec**.
- `bash tests-integration/run.sh` : **14 bancs, 377 vérifications, code 0** (dont `sync` 67, `import` 39, `metre-defaut` 73, `taches-internes` 76).
- Le banc `sync` a été rejoué deux fois de suite, `taches-internes` trois fois : même résultat (les courses sont absorbées, pas évitées par chance).

## 5. À savoir avant de fusionner

- **`prisma generate`** est nécessaire (nouvelle valeur d'énumération `EMPRISE_UTM`). Le code évite d'en
  dépendre pour compiler, mais le client généré doit la connaître pour relire ces lignes.
- **Deux migrations** (`20261024300000`, `20261024310000`) et leurs descentes. Le banc `metre-defaut` les applique
  à son clone si `replay` ne les contient pas encore. La liste « 69 migrations, 69 descentes » de
  `prisma/descentes/README.md` n'a pas été modifiée.
- `src/api-v2/index.ts` monte `/taches-internes` (3 lignes). `schema.prisma` : une valeur d'énumération.
  Aucune modification de `GeoportailPage.tsx`, `App.tsx`, ni des fichiers de suivi.
- Le banc `taches-internes` écrit des photos dans `backend/uploads/photos` et les retire à la fin.

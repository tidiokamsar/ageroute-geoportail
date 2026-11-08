# Tests de bout en bout (Playwright, navigateur reel)

Ces tests ouvrent un **vrai Chromium** sur une **vraie pile locale** : API Express, base PostgreSQL/PostGIS, interface servie par Vite
(projet `dev`) ou par un **build de production** derriere un serveur statique qui reproduit `nginx.conf` (projet `build`), et le **vrai
IndexedDB** du navigateur. Ils ne remplacent ni Vitest (jsdom) ni les bancs `backend/tests-integration` : ils verifient que l'ecran, le
navigateur, le reseau, le service worker et la base disent la meme chose.

Code : `e2e/` (specs, fixtures, lanceurs). **Aucun fichier de `frontend/src` ni de `backend/src` n'est modifie par ce harnais.** Un defaut
constate est consigne en test `test.fail` (echec attendu) ou en test d'API avec sa reproduction, jamais contourne.

## Prerequis

| Element | Detail |
|---|---|
| Node | 24.x (celui du poste) |
| Dependances | `npm install` fait dans `frontend/` et dans `backend/` (le harnais reutilise `pg`, `argon2`, `tsx` et `typescript` du backend) |
| Playwright | `@playwright/test` **1.63.0**, epingle dans `frontend/package.json`. Cette version attend Chromium **1243**, deja present dans `%LOCALAPPDATA%\ms-playwright` : aucun navigateur n'est telecharge. Sur un autre poste : `cd frontend && npx playwright install chromium` (telechargement). |
| Docker | Docker Desktop lance, conteneur `bdri-dev-db` demarre (PostGIS, `127.0.0.1:5434`). |
| Base modele | Une base `replay` (schema complet, sans donnee) dans ce conteneur, la meme que celle des bancs PostGIS. Elle n'est **jamais modifiee** : seulement lue comme modele de `CREATE DATABASE essai_e2e TEMPLATE replay`. |
| Ports libres | 3101 (API), 3102 (port de controle de l'API de test, voir plus bas), 5201 (Vite), 5301 (build). Jamais 4000 ni 5173 : un serveur de developpement peut rester ouvert. |
| Disque | Le depot doit etre sur un disque stable : une execution complete dure de 20 a 40 minutes. Un disque externe qui se demonte pendant l'execution (portable sur batterie, veille) l'interrompt. Garder le portable sur secteur, veille interdite. |

## Lancer

Depuis `frontend/` :

```bash
npm run test:e2e                                    # tout : projet dev, puis projet build
npm run test:e2e -- --reporter=list                 # idem, une ligne par test (recommande, sortie qui progresse)
npm run test:e2e -- --project=dev                   # seulement le projet dev (n'ouvre ni build ni serveur statique)
npm run test:e2e -- --project=build                 # seulement le projet build (n'ouvre pas Vite)
npm run test:e2e -- specs/03                        # un fichier
npm run test:e2e -- -g "reponse perdue"             # un test par son titre
```

`npm run test:e2e` equivaut a `playwright test --config ../e2e/playwright.config.ts`. Une seule commande fait tout : creation de la base,
semis, demarrage de l'API, de Vite et du build, prechauffage, tests, arret des serveurs, suppression de la base. **Commande longue :
la lancer en arriere-plan avec un fichier de journal** (`... > journal.log 2>&1`) et surveiller le fichier.

Lecture de la sortie : `ok` reussi, `-` ignore, `x` echec. Les tests marques `test.fail` (voir « Defauts reveles ») s'affichent avec un
`x` : c'est un **echec attendu**, le bilan final les compte parmi les reussis. Une vraie regression apparait sous « failed ». Un test qui
devait echouer et reussit est signale en echec : retirer alors son `test.fail`.

### Variables d'environnement (toutes facultatives)

| Variable | Effet |
|---|---|
| `E2E_REUTILISER=1` | Reutilise une API, un Vite et un build **deja lances** (ports 3101, 5201, 5301) au lieu d'en demarrer. Evite ~4 minutes de demarrage a chaque essai pendant la mise au point. Attention : la base n'est alors pas recreee, certains tests supposent une base neuve (voir limites). |
| `E2E_SANS_BUILD=1` | N'ouvre pas le projet build (pas de construction de production). |
| `E2E_CONSERVER=1` | Garde la base `essai_e2e` et les identifiants a la fin, pour inspecter. A nettoyer ensuite (voir « Nettoyage »). |
| `E2E_FACTEUR_DELAI=2` | Multiplie tous les plafonds d'attente (test, `expect`, action, navigation, attente de synchronisation) quand la machine est chargee. Les tests attendent des **conditions** (ligne en base, ecran affiche), jamais une duree : ce coefficient ne rallonge que le plafond. Defaut 1. |
| `E2E_AVEC_FENETRE=1` | Navigateur visible. |
| `E2E_LOGS=1` | Affiche les journaux de l'API et de Vite (une ligne par requete), masques par defaut. |
| `E2E_PG_URL=postgresql://utilisateur:motdepasse@127.0.0.1:5434/postgres` | Fournit la connexion a PostgreSQL au lieu de la lire dans le conteneur. Hote local obligatoire. |
| `E2E_PG_CONTENEUR`, `E2E_PG_PORT` | Autre nom de conteneur (defaut `bdri-dev-db`), autre port (defaut 5434). |

Sans `E2E_PG_URL`, le harnais lit `POSTGRES_USER` et `POSTGRES_PASSWORD` dans le conteneur par `docker inspect`, sans les afficher ni les
ecrire dans le depot. Il n'existe pas de variable pour tester un autre commit : l'arbre de travail est toujours ce qui est teste.

## Ce que fait le lancement

1. `playwright.config.ts` declare deux projets et trois `webServer` (API, Vite, build). Un seul worker, dans l'ordre : projet `dev`, puis `build`.
2. **API** (`e2e/scripts/lancer-api.ts`, port 3101) : recree `essai_e2e` depuis `replay`, y seme le jeu minimal, fixe l'environnement, puis
   charge `backend/src/server.ts` tel quel, dans le meme processus. Le repertoire de travail de l'API est un dossier temporaire (les photos
   televersees n'atterrissent pas dans `backend/uploads/`). **Port de controle 3102** (127.0.0.1, ce processus seulement) : `POST
   /reinitialiser-limites` remet a zero le plafond serveur des evenements de session locale (5 lots par 15 minutes **et par compte**,
   `backend/src/modules/auth/evenements-locaux.ts`). Sans lui, les comptes partages par toute la batterie atteignent le plafond au milieu de
   la suite (reponse 429, evenement garde par le telephone mais depose seulement au prochain declencheur) et un test qui attend un evenement
   dependrait de ceux qui le precedent. Chaque test (fixture `ouvrirProfil`) remet le compteur a zero ; le code du serveur n'est pas modifie.
3. **Vite** (`e2e/vite.e2e.config.ts`, port 5201, projet dev) : la configuration du frontend avec port, proxy `/api` vers 3101, cache hors du
   depot, rechargement a chaud desactive (sa websocket tombe avec la coupure reseau simulee).
4. **Build** (`e2e/scripts/lancer-build.ts`, port 5301, projet build) : `vite build` vers un dossier temporaire (~25 s), puis un serveur
   statique (`serveur-statique.ts`) qui reproduit `frontend/nginx.conf` : cache des fichiers hashes, `sw.js` et `index.html` sans cache,
   retour a `index.html` pour les routes, proxy `/api`. Le **service worker est actif** (enregistre seulement en production). Le fichier
   `serveur-coupe` (voir `coupureServeurStatique`) fait refuser toute connexion : avec `context.setOffline(true)`, c'est un telephone sans
   aucun reseau, le service worker est la seule source de l'application.
5. `global-setup.ts` prechauffe Vite (premiere transformation des modules) : sans cela, le premier test echouait au hasard sur un chargement de 30 s.
6. `global-teardown.ts` detruit `essai_e2e` et les identifiants. Playwright arrete ensuite les serveurs.

### Jeu de donnees (genere a chaque lancement, jamais ecrit dans le depot)

| Element | Detail |
|---|---|
| Comptes | `admin` (ADMIN), `gestionnaire` (GESTIONNAIRE), `agentA` a `agentE` (INSPECTEUR, modules du profil metier `AGENT_TERRAIN` ; A et B sont les agents ordinaires, C, D, E sont reserves a un scenario chacun : compte desactive, appareil revoque, droits retires). Adresses `*@e2e.test.invalid`. **Mot de passe et code PIN de chaque compte tires au hasard a chaque lancement.** |
| Troncons | 3, avec geometrie PostGIS (`E2E-RN1-01`, `E2E-RN1-02`, `E2E-RN2-01`), 2 regions. |
| Identifiants | `%TEMP%\bdri-e2e\run.json` (droits du seul utilisateur), hors du depot. Les specs les lisent par la fixture `run`. Aucun identifiant dans le depot. |

## Comment un test est construit

- **Profil persistant** (`ouvrirProfil`, `e2e/lib/fixtures.ts`) : chaque test ouvre `launchPersistentContext` sur un dossier jetable. IndexedDB,
  localStorage, cookies et service worker sont ecrits sur disque, donc `profil.redemarrer()` (fermeture du navigateur puis reouverture sur le
  meme dossier) rejoue un redemarrage de telephone, et deux comptes qui se connectent tour a tour partagent un appareil.
  `ouvrirProfil({ horloge })` installe l'horloge simulee de Playwright : inactivite, arriere-plan, expiration et delais de PIN se pilotent par
  `page.clock`, jamais par des attentes reelles.
- **Session locale** : `ouvrirObservations` / `ouvrirEcranTerrain` connectent par l'interface, creent le **code PIN** a la premiere ouverture d'un
  ecran de terrain (`creerPin`), puis deverrouillent (`deverrouiller`, `essayerPin`). Chaque compte a sa **base IndexedDB**
  (`bdri-offline-<sha256(idCompte)[0:16]>`) ; `e2e/lib/idb.ts` lit les files, les noms de bases et le stockage brut, et `contientEnClair`
  verifie qu'aucune saisie n'est lisible dans le stockage.
- **Adresse annoncee** : `/api/auth/login` plafonne a 10 par 15 min et par adresse, plafond fixe dans le code (`backend/src/app.ts`). Chaque
  profil envoie son propre `X-Forwarded-For`. Les plafonds reglables (`/auth/refresh`, `/api/v2`) sont mis a 0 par le lanceur.
- **Reseau** : `coupureReseau` / `retablirReseau` (`context.setOffline`) ; `apiInjoignable` (seules les requetes `/api/` echouent) ;
  `sonderSync(context, "abandonner-avant-serveur" | "perdre-la-reponse", fois)` (faute ciblee sur `POST /api/v2/sync/push`, la seconde est le cas
  qui produit des doublons sans idempotence) ; `modeAvion` (projet build : navigateur hors ligne ET serveur statique muet).
  **On ouvre toujours l'ecran EN LIGNE, puis on coupe** (une page ne se charge pas sans reseau en mode dev).
- **Verification cote serveur** (`e2e/lib/base.ts`) : lecture directe de `essai_e2e` (observations, medias, inspections, audit, appareils, sessions
  de rafraichissement, evenements locaux, lots d'import). On ne croit pas l'ecran quand il dit « envoye ». Les photos se verifient par SHA-256.
  Chaque test saisit un **marqueur unique** (fixture `marqueur`) et le retrouve en base.
- **Nettoyage entre tests** : les appareils enregistres par un profil sont revoques apres chaque test (le serveur plafonne a 10 appareils actifs par
  compte), ecriture sur la base jetable seulement ; la date de revocation est reculee d'un jour pour ne pas declencher le refus de 15 minutes
  qui suit une revocation.

## Parcours couverts

Projet `dev` : tout ce qui n'est pas marque `@froid`. Projet `build` : seulement les titres marques `@froid` (reouverture a froid).

| Fichier | Parcours |
|---|---|
| `specs/01-connexion.spec.ts` | Connexion par l'interface, cookie de session (HttpOnly, SameSite=Strict, chemin `/api/auth`), aucun jeton dans le stockage, mauvais mot de passe (401, aucune session, message visible : E2E-1 corrige), session apres rechargement, deconnexion avec confirmation, ecran protege, etiquettes accessibles (E2E-3, `test.fail`) |
| `specs/02-saisie-en-ligne.spec.ts` | PIN demande a la premiere ouverture d'un ecran de terrain et jamais ailleurs ; observation en ligne (une ligne, file vide, audit) ; inspection en ligne par un ADMIN puis par un INSPECTEUR (E2E-2 corrige), et 201 de l'API par appel direct |
| `specs/03-hors-ligne.spec.ts` | Observation hors ligne : file IndexedDB chiffree puis une seule ligne ; plusieurs saisies ; coupure en plein envoi (abort) ; reponse perdue + rejeu : toujours une seule ligne. **Scenario (m)** |
| `specs/04-photos-hors-ligne.spec.ts` | Observation rapide en roulant avec photo hors ligne (position GPS emulee, SHA-256 en base) ; inspection avec photo hors ligne (SHA-256 du fichier sur le disque de l'API) |
| `specs/05-file-survit.spec.ts` | La file survit au rechargement et a la fermeture puis reouverture du navigateur (le PIN est redemande) |
| `specs/06-comptes-partages.spec.ts` | Deux comptes sur le meme profil : cloisonnement des files, envoi sous le bon compte |
| `specs/08-imports.spec.ts` | Lots d'import (ADMIN/GESTIONNAIRE) : liste vide distincte d'une erreur d'API ; lot CSV et GeoJSON valides (ligne, audit, empreinte, etapes 3 et 4 non disponibles, referentiel inchange) ; lots rejetes (CRS, colonne) ; fichier vide ; meme fichier deux fois (« deja recu ») ; meme nom, contenu different ; BOM et CRLF ; format declare incoherent (400) ; non UTF-8 (400) ; fichier trop gros ; coupure reseau et reponse perdue sans doublon ; filtres et lot choisi dans l'adresse (rechargement) ; telechargement du CSV d'erreurs (aucune cellule ne commence par `=`, `+`, `-`, `@`) ; contenu hostile rendu comme texte ; 375 et 768 px sans debordement (captures hors depot) ; INSPECTEUR refuse (menu, URL, API 403) ; ADMIN et GESTIONNAIRE autorises |
| `session-hors-ligne.cible.spec.ts` | Session hors ligne, scenarios (a) a (l), (o) ci-dessous |

### Scenarios de session hors ligne (`session-hors-ligne.cible.spec.ts`)

| Ref | Scenario | Projet |
|---|---|---|
| (a) | Le service worker precache toute l'application (autant d'entrees que `precache-manifest.json`), aucune reponse d'API en cache ; connexion, PIN, saisie en file, mode avion total, rechargement (document servi par le service worker, ecran du PIN, « vous etes hors ligne »), **redemarrage du navigateur hors ligne**, mauvais code, bon code **hors ligne** (la file se rouvre : E2E-5 corrige), nouvelle saisie, retour du reseau, chaque saisie une seule fois, rien en clair | build |
| (b) | Code faux : message, 5 essais libres, puis attentes croissantes (30 s, 1 min), aucune perte, le bon code rouvre | dev |
| (c) | Expiration (8 jours) et horloge reculee de 30 min : ouverture hors ligne refusee, coffre intact ; reconnexion en ligne puis PIN : memes donnees | dev |
| (d), (e) | Verrou apres 5 min d'inactivite (contenu inerte et masque, saisie en cours conservee) ; 2 min en arriere-plan verrouillent, moins non | dev |
| (f) | Deux comptes sur le meme appareil : B ne voit rien de A, le code de A n'ouvre pas la file de B, deux bases, rien en clair | dev |
| (g) | Deconnexion avec saisies en attente (message du reste, rien d'efface, reconnexion du meme compte les envoie) ; hors ligne : verrou immediat, deconnexion rejouee au retour | dev |
| (h) | Reinitialisation du PIN en deux temps, perte annoncee, base du compte detruite, evenement `PIN_REINITIALISE` depose | dev |
| (i) | Effacement local refuse tant qu'une saisie attend, accepte ensuite, ne touche jamais un autre compte | dev |
| (j) | Compte desactive hors ligne : a la reconnexion la session se ferme avec message, file conservee, repart apres reactivation | dev |
| (k) | Appareil revoque : synchronisation arretee, aucun reenregistrement automatique (0 `POST /v2/devices`), bandeau, saisies conservees | dev |
| (l) | Droits retires : saisie refusee en quarantaine `refus_droits`, non rejouee, comptee dans la decision d'effacement | dev |
| (m) | Coupure reseau en plein envoi et synchronisations repetees : une seule ligne serveur (preuve dans `specs/03`) | dev |
| (n) | Mauvais mot de passe visible (E2E-1), INSPECTEUR peut creer une inspection (E2E-2), etiquettes de la page de connexion (E2E-3, corrige) : `specs/01` et `specs/02` | dev |
| (o) | Rafraichissement dont la reponse est perdue (E2E-4), au niveau de l'API | dev |

### Defauts reveles par ce harnais

| Ref | Etat | Detail |
|---|---|---|
| E2E-1 | **Corrige** | Un mauvais mot de passe ne montrait aucun message (le 401 de `/auth/login` etait pris pour un jeton expire). Le test passe sans `test.fail`. |
| E2E-2 | **Corrige** | Un INSPECTEUR recevait 403 sur `POST /api/inspections`. Les deux tests (ecran et API) passent sans `test.fail`. |
| E2E-5 | **Corrige** | Hors ligne, le bon code PIN renvoyait vers `/login` sans requete d'API (l'utilisateur etait pose apres l'emission de l'instantane « ouvert »). Test (a) et test `@froid E2E-5` passent. |
| E2E-3 | **Corrige** le 27/10/2026 (`aria-label` et `autoComplete` sur les deux champs de `LoginPage.tsx`), `test.fail` retire | Les champs de la page de connexion n'avaient ni etiquette ni `aria-label` (placeholder seulement). |
| E2E-4 | **Ouvert** (test d'API en (o), constat consigne, pas un `test.fail`) | Le serveur fait tourner le jeton de rafraichissement a chaque appel ; si la reponse est perdue (page rechargee ou fermee a cet instant), le jeton presente ensuite est l'ancien : le serveur y voit une reutilisation et **ferme toute la famille**, y compris le nouveau jeton. Reproduction par l'API : connexion -> cookie c0 ; refresh avec c0 : 200 et c1 ; refresh avec c0 : 401 ; refresh avec c1 : 401. En pratique : recharger la page juste au retour du reseau (un rafraichissement part sur l'evenement `online`) deconnecte l'agent. Les tests du harnais attendent le calme (`attendreCalme`) avant de recharger ou de fermer le navigateur. Decision d'architecture : fenetre de grace sur l'ancien jeton, ou accepter. |

## Parcours non couverts

| Non couvert | Raison |
|---|---|
| Android (WebView de l'APK), Safari/WebKit, Firefox | Un seul moteur : Chromium 1243, 1280x800 (375 et 768 px seulement dans `08-imports`). Pas de mobile emule pour la saisie. |
| nginx reel, TLS, en-tetes de securite du proxy | Le serveur statique du projet build reproduit les regles de `nginx.conf` mais n'est pas nginx. |
| Mise a jour du service worker en production, quota de stockage, eviction du navigateur | Un seul build, profil neuf. |
| Trajet GPS, camera reelle | Position fixe emulee, photo generee. |
| Reseau lent, portail captif, coupure intermittente longue | `setOffline` et les coupures ciblees seulement. |
| Ecrans autres que le terrain, la connexion et les imports (carte, tableaux, validation, gouvernance...) | Couverts par Vitest et les bancs, pas par ce harnais. |
| Deuxieme onglet, canal inter-onglets | Un seul onglet par profil. |
| Rafraichissement du jeton pendant une inactivite longue (15 min) | Non reproduit en temps reel ; l'horloge simulee ne pilote pas le serveur. |

## Durees mesurees

Poste de developpement, un worker, `npm run test:e2e -- --reporter=list` complet (sans `E2E_REUTILISER`), le 27/10/2026, deux passages consecutifs :

| | Passage 1 | Passage 2 |
|---|---|---|
| Resultat | 57 passed, 0 failed, 0 flaky | 57 passed, 0 failed, 0 flaky |
| Projet `dev` (54 tests, somme des durees des tests) | 1 011 s (16,9 min) | 1 084 s (18,1 min) |
| Projet `build` (3 tests) | 54 s | 41 s |
| Duree murale totale (demarrage de l'API, prechauffage de Vite 40 s / 29 s, build, tests, arret) | 1 262 s (21,0 min) | 1 277 s (21,3 min) |
| Echec attendu (`x`) | 1 : E2E-3 (`specs/01-connexion.spec.ts`), mesure avant sa correction du 27/10 | 1 : E2E-3, idem (aujourd'hui 0 : le test passe sans `test.fail`) |

Le demarrage (API, Vite, build de production) coute environ 3 minutes avant le premier test. Les durees dependent de la charge de la machine :
sous charge, monter `E2E_FACTEUR_DELAI`.

## Nettoyage

A la fin d'un lancement normal, la base `essai_e2e` et `run.json` sont supprimes et les serveurs arretes. Restent dans `%TEMP%\bdri-e2e\` : le
dossier de l'API, les sorties de test (`sorties\resultats`, traces des echecs), le cache de Vite, le build.

Apres un lancement interrompu, ou avec `E2E_CONSERVER=1` (depuis `frontend/`) :

```bash
node ../backend/node_modules/tsx/dist/cli.mjs --tsconfig ../e2e/tsconfig.json ../e2e/scripts/nettoyer.ts          # base + identifiants
node ../backend/node_modules/tsx/dist/cli.mjs --tsconfig ../e2e/tsconfig.json ../e2e/scripts/nettoyer.ts --tout   # + tout le dossier temporaire
```

Verifier ensuite : aucun processus `node` ni `chrome-headless-shell` du harnais, ports 3101, 3102, 5201, 5301 libres, aucune base `essai_e2e*`
(les bases `essai_eo_*` et `essai_roulage_*` appartiennent a d'autres travaux : ne pas y toucher). Un echec laisse ses traces dans
`%TEMP%\bdri-e2e\sorties\resultats\<test>\trace.zip` : `npx playwright show-trace <chemin>`. Aucun rapport HTML n'est produit dans le depot.

## Limites connues

- Mode `E2E_REUTILISER` : la base n'est pas recreee. Le premier test de `08-imports` (« liste vide ») suppose qu'aucun lot n'existe : il echoue
  sur une base deja utilisee. Vider `lots_import` (`TRUNCATE lots_import CASCADE` sur `essai_e2e` uniquement) ou relancer sans ce mode.
- Un seul worker : toutes les specs partagent la base `essai_e2e` et les comptes. L'ordre des fichiers et le port de controle isolent les tests
  les uns des autres pour le plafond des evenements locaux ; les autres etats partages (appareils, sessions) sont nettoyes apres chaque test.
- Le service worker est bloque dans le projet `dev` (il rendrait les coupures dependantes de l'historique du profil) : l'enveloppe en cache n'est
  testee que dans le projet `build`, et seulement pour les scenarios `@froid`.
- La coupure `setOffline` est celle de Chromium ; les selecteurs sont des roles et des libelles accessibles : un changement de libelle casse un test (volontairement).
- Un disque externe qui se demonte pendant l'execution l'interrompt ; la base `essai_e2e` et les serveurs doivent alors etre nettoyes a la main.

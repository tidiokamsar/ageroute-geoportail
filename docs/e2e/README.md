# Tests de bout en bout (Playwright, navigateur reel)

Ces tests ouvrent un **vrai Chromium** sur une **vraie pile locale** : API Express, base PostgreSQL/PostGIS, interface servie
par Vite, et le **vrai IndexedDB** du navigateur. Avant eux, le mode hors ligne n'etait prouve que sous jsdom et par les bancs
PostGIS cote serveur (`docs/reports/LOT-00-RAPPORT.md`, E.2). Ils ne remplacent ni Vitest ni les bancs `backend/tests-integration` :
ils verifient que l'ecran, le navigateur, le reseau et la base disent la meme chose.

Code : `e2e/` (specs, fixtures, lanceur). Aucun fichier de `frontend/src` ni de `backend/src` n'est modifie par ce harnais.

## Prerequis

| Element | Detail |
|---|---|
| Node | 24.x (celui du poste) |
| Dependances | `npm install` fait dans `frontend/` et dans `backend/` (le harnais reutilise `pg`, `argon2` et `tsx` du backend) |
| Playwright | `@playwright/test` **1.63.0**, epingle dans `frontend/package.json`. Cette version attend Chromium **1243**, deja present dans `%LOCALAPPDATA%\ms-playwright` : **aucun navigateur n'est telecharge**. Sur un autre poste : `cd frontend && npx playwright install chromium` (telechargement). |
| Docker | Docker Desktop lance, conteneur `bdri-dev-db` demarre (PostGIS, `127.0.0.1:5434`). Voir la note memoire « docker dev apres redemarrage ». |
| Base modele | Une base `replay` (schema complet, sans donnee) dans ce conteneur, la meme que celle des bancs PostGIS. Elle n'est **jamais modifiee** : seulement lue comme modele de `CREATE DATABASE ... TEMPLATE replay`. |
| Ports libres | 3101 (API) et 5201 (Vite). Les tests n'utilisent jamais 4000 ni 5173 (developpement) : un serveur de developpement peut rester ouvert. |

## Lancer

Depuis `frontend/` :

```bash
npm run test:e2e                              # tout (equivaut a : npx playwright test --config ../e2e/playwright.config.ts)
npm run test:e2e -- specs/03                  # un fichier
npm run test:e2e -- -g "reponse perdue"       # un test par son titre
npm run test:e2e -- session-hors-ligne        # le fichier du comportement cible
```

Une seule commande fait tout : creation de la base, semis, demarrage de l'API et de Vite, prechauffage, tests, arret des serveurs,
suppression de la base. Duree mesuree sur ce poste : 7 minutes quand il est calme, jusqu'a 25 minutes quand d'autres travaux saturent le CPU
(chargement de Vite en mode developpement, un profil de navigateur neuf par test). Les delais sont larges pour cette raison.

Lecture de la sortie : `ok` reussi, `-` ignore (`test.fixme`, le comportement cible), `x` en echec. Les deux tests marques `test.fail` (voir
« Defauts reels reveles ») s'affichent avec un `x` : c'est un **echec attendu**, le bilan final les compte parmi les reussis (« 18 passed »).
Une vraie regression apparait sous « failed » dans ce bilan.

Variables d'environnement (toutes facultatives) :

| Variable | Effet |
|---|---|
| `E2E_SOURCE=head` | Teste le **dernier commit** (extrait par `git archive` dans le dossier temporaire) au lieu de l'arbre de travail. A utiliser quand l'arbre contient un travail en cours qui n'est pas le sujet. Defaut : `arbre` (le code tel qu'il est, non commite compris). |
| `E2E_AVEC_FENETRE=1` | Navigateur visible (utile pour regarder un test). |
| `E2E_LOGS=1` | Affiche les journaux de l'API et de Vite (une ligne par requete), masques par defaut. |
| `E2E_CONSERVER=1` | Garde la base `essai_e2e` et les identifiants a la fin, pour inspecter. |
| `E2E_PG_URL=postgresql://utilisateur:motdepasse@127.0.0.1:5434/postgres` | Fournit la connexion a PostgreSQL au lieu de la lire dans le conteneur. Hote local obligatoire. |
| `E2E_PG_CONTENEUR`, `E2E_PG_PORT` | Autre nom de conteneur (defaut `bdri-dev-db`), autre port (defaut 5434). |

Sans `E2E_PG_URL`, le harnais lit `POSTGRES_USER` et `POSTGRES_PASSWORD` dans le conteneur par `docker inspect`, sans les afficher
ni les ecrire dans le depot.

## Ce que fait le lancement

1. `playwright.config.ts` choisit la racine du code (arbre ou HEAD) et declare deux `webServer`.
2. **API** (`e2e/scripts/lancer-api.ts`, port 3101), un seul processus : recree `essai_e2e` depuis `replay`, y seme le jeu minimal,
   fixe l'environnement, puis charge `backend/src/server.ts` tel quel. Le repertoire de travail de l'API est un dossier temporaire :
   les photos televersees n'atterrissent pas dans `backend/uploads/`.
3. **Vite** (`e2e/vite.e2e.config.ts`, port 5201) : la configuration du frontend, avec le port, l'adresse, le proxy `/api` vers 3101
   et un dossier de cache hors du depot. Rechargement a chaud desactive (sa websocket tombe avec la coupure reseau simulee).
4. `global-setup.ts` prechauffe Vite (premiere transformation des modules, optimisation des dependances) : sans cela, le premier
   test echouait au hasard sur un chargement de 30 s.
5. Les specs, un seul worker, dans l'ordre des fichiers.
6. `global-teardown.ts` detruit `essai_e2e` et les identifiants. Playwright arrete ensuite les deux serveurs.

### Jeu de donnees (genere a chaque lancement, jamais ecrit dans le depot)

| Element | Detail |
|---|---|
| Comptes | `admin` (ADMIN), `agentA` et `agentB` (INSPECTEUR, modules du profil metier `AGENT_TERRAIN` de `backend/src/lib/profils.ts`). Adresses `*@e2e.test.invalid`. Mots de passe tires au hasard. |
| Troncons | 3, avec geometrie PostGIS (`E2E-RN1-01`, `E2E-RN1-02`, `E2E-RN2-01`), 2 regions. |
| Ou sont les identifiants | `%TEMP%\bdri-e2e\run.json` (droits du seul utilisateur), hors du depot. Les specs les lisent par la fixture `run`. |

## Comment un test est construit

- **Profil persistant** (`ouvrirProfil`, `e2e/lib/fixtures.ts`) : chaque test ouvre `launchPersistentContext` sur un dossier jetable.
  IndexedDB, localStorage et cookies sont ecrits sur disque, donc `profil.redemarrer()` (fermeture du navigateur puis reouverture sur
  le meme dossier) rejoue un redemarrage de telephone, et deux comptes qui se connectent tour a tour partagent un appareil.
- **Adresse annoncee** : `/api/auth/login` plafonne a 10 par 15 min et par adresse, plafond **fixe dans le code** (`backend/src/app.ts`).
  Chaque profil envoie son propre `X-Forwarded-For` (le serveur fait confiance au premier proxy). Les deux plafonds reglables
  (`/auth/refresh`, `/api/v2`) sont mis a 0 par le lanceur.
- **Connexion par l'interface** (`seConnecter`) : le chemin de l'agent, pas un jeton injecte.
- **Reseau** (`e2e/lib/fixtures.ts`, `e2e/lib/reseau.ts`) :
  - `coupureReseau` / `retablirReseau` : `context.setOffline`, `navigator.onLine` change et l'evenement `online` declenche la synchronisation.
    **On ouvre toujours l'ecran EN LIGNE, puis on coupe** : une page ne se charge pas sans reseau (le serveur de developpement est coupe aussi).
  - `sonderSync(context, "abandonner-avant-serveur" | "perdre-la-reponse", fois)` : faute ciblee sur `POST /api/v2/sync/push`.
    `perdre-la-reponse` laisse le serveur traiter la requete puis coupe la reponse : c'est le cas qui produit des doublons si l'idempotence manque.
  - `apiInjoignable` : seules les requetes `/api/` echouent, l'enveloppe reste servie (telephone dont le service worker l'a en cache).
- **Verification cote serveur** (`e2e/lib/base.ts`) : lecture directe de `essai_e2e` (observations, medias, inspections, audit). On ne croit
  pas l'ecran quand il dit « envoye ». Les photos se verifient par **SHA-256** (en base pour les observations, sur le disque de l'API pour
  les inspections). Chaque test saisit un **marqueur unique** (fixture `marqueur`) et le retrouve en base.
- **IndexedDB reel** (`e2e/lib/idb.ts`, `lireFile`) : lit la file locale du navigateur (proprietaire, statut, tentatives, tailles de photos).
- **Service worker bloque** (`serviceWorkers: "block"`) : en mode developpement il mettrait en cache des modules et rendrait les coupures
  dependantes de l'historique du profil. Consequence : **l'enveloppe en cache n'est pas testee**.
- **Nettoyage entre tests** : les appareils enregistres par un profil sont revoques apres chaque test (le serveur plafonne a 10 appareils
  actifs par compte), ecriture sur la base jetable seulement.

## Parcours couverts

| Fichier | Parcours |
|---|---|
| `specs/01-connexion.spec.ts` | Connexion par l'interface, attributs du cookie de session (HttpOnly, SameSite=Strict, chemin `/api/auth`), aucun jeton dans le stockage, mauvais mot de passe (401, aucune session), session apres rechargement, deconnexion, ecran protege |
| `specs/02-saisie-en-ligne.spec.ts` | Observation en ligne (une ligne en base, file vide, audit), inspection en ligne par un ADMIN |
| `specs/03-hors-ligne.spec.ts` | Observation hors ligne : file IndexedDB puis une seule ligne en base ; plusieurs saisies ; coupure en plein envoi (abort), reseau muet qui ne fait pas abandonner (6 coupures) ; reponse perdue, rejeu (`REJOUEE`), troisieme rejeu manuel, toujours une seule ligne |
| `specs/04-photos-hors-ligne.spec.ts` | Observation rapide en roulant avec photo hors ligne (position GPS emulee, SHA-256 en base) ; inspection avec photo hors ligne (SHA-256 du fichier sur le disque de l'API) |
| `specs/05-file-survit.spec.ts` | La file survit au rechargement de la page et a la fermeture puis reouverture du navigateur |
| `specs/06-comptes-partages.spec.ts` | Deux comptes sur le meme profil : cloisonnement des files, envoi sous le bon compte |
| `specs/07-etat-actuel-reouverture.spec.ts` | **Caracterisation** : API injoignable au redemarrage, l'agent est renvoye a la connexion, file intacte dans IndexedDB mais inaccessible. A retirer quand la session hors ligne existera |
| `session-hors-ligne.cible.spec.ts` | **Comportement cible**, 6 scenarios `test.fixme` (voir ci-dessous) |

### Defauts reels reveles (tests `test.fail`, ils previennent quand le defaut est corrige)

| Ref | Test | Defaut |
|---|---|---|
| E2E-1 | `01-connexion`, « affiche un message a l'agent » | Un mauvais mot de passe ne montre aucun message : le 401 de `/auth/login` est pris pour un jeton expire par l'intercepteur de `frontend/src/lib/api.ts`, qui tente `/auth/refresh` puis recharge `/login` |
| E2E-2 | `02-saisie-en-ligne`, « par un INSPECTEUR » | Un INSPECTEUR recoit 403 sur `POST /api/inspections` (et photos, `PUT`) : `backend/src/modules/inspections/inspections.routes.ts` pose `use(requireRole("ADMIN","GESTIONNAIRE"), ...)` avant les routes qui annoncent INSPECTEUR |

Quand un defaut est corrige, Playwright signale « le test devait echouer et a reussi » : retirer alors la ligne `test.fail(...)`.

### Activer le comportement cible

`session-hors-ligne.cible.spec.ts` decrit six scenarios (ouverture hors ligne autorisee, session expiree, verrouillage sur inactivite, deux comptes,
deconnexion avec operations en attente, compte revoque a la reconnexion). Ils sont `test.fixme` : ils ne s'executent pas. Pour activer :
remplacer `test.fixme` par `test`, completer les points marques « A COMPLETER » avec les libelles reels de l'interface livree, lancer
`npm run test:e2e -- session-hors-ligne`, et retirer `specs/07-etat-actuel-reouverture.spec.ts`.

## Nettoyage

A la fin d'un lancement normal, la base `essai_e2e` et `run.json` sont supprimes et les deux serveurs arretes. Restent dans `%TEMP%\bdri-e2e\` : le dossier
de l'API (vide au lancement suivant), les sorties de test (`sorties\resultats`, traces des echecs), le cache de Vite, l'extraction de HEAD.

Apres un lancement interrompu, ou avec `E2E_CONSERVER=1` :

```bash
cd frontend
node ../backend/node_modules/tsx/dist/cli.mjs --tsconfig ../e2e/tsconfig.json ../e2e/scripts/nettoyer.ts          # base + identifiants
node ../backend/node_modules/tsx/dist/cli.mjs --tsconfig ../e2e/tsconfig.json ../e2e/scripts/nettoyer.ts --tout   # + tout le dossier temporaire
```

Un echec laisse ses traces dans `%TEMP%\bdri-e2e\sorties\resultats\<test>\trace.zip` : `npx playwright show-trace <chemin>`.
Aucun rapport HTML n'est produit dans le depot. `e2e/.gitignore` ecarte `test-results/` et `playwright-report/` si un lancement les ecrivait ici.

## Limites connues

- Un seul navigateur (Chromium, 1280x800). Pas de mobile emule, pas de Firefox ni de WebKit.
- Pas de service worker, pas d'enveloppe en cache, pas de vrai mode avion au chargement de page : voir `session-hors-ligne.cible.spec.ts` pour la marche a suivre (build de production).
- Le GPS est emule par le navigateur (une position fixe), pas un trajet.
- La coupure `setOffline` est celle de Chromium ; elle ne reproduit ni un reseau lent ni un portail captif.
- Un seul worker : toutes les specs partagent la base `essai_e2e`.
- Les ecrans valides sont ceux de l'etat du depot au moment de l'ecriture ; un changement de libelle casse un selecteur (volontairement : les selecteurs sont des roles et des libelles accessibles).

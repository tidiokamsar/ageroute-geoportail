# Service worker et démarrage à froid hors ligne (Lot 1, chantier D5)

Date : 25/10/2026. Statut : implémenté et essayé dans Chromium de bureau (voir 6). Rien de ce document n'est déployé. Complète `SESSION-HORS-LIGNE.md` (section 11, étape 7).

## 1. Pourquoi

La session hors ligne chiffrée (coffre, PIN, files locales) ne sert à rien si l'application elle-même ne s'ouvre pas sans réseau. Avant ce chantier, `public/sw.js` faisait « réseau d'abord, repli sur `caches.match("/")` » mais ne **précachait rien** : seuls les fichiers déjà lus étaient gardés. Conséquences constatées à la lecture du code :

- une page chargée en `lazy()` mais jamais ouverte en ligne manquait hors ligne (le morceau JS n'était pas en cache) ;
- rien ne garantissait que `/` soit en cache après la première visite (il n'y entrait qu'après une navigation réussie traitée par le worker) ;
- l'index mis en cache sous `/` pouvait venir d'un build plus récent que les morceaux en cache : index et fichiers hachés incohérents.

## 2. Conception

### 2.1 Le manifeste de précache (construction)

Le plugin `frontend/vite-plugin-precache.ts` (déclaré dans `vite.config.ts`, actif à la construction seulement, `apply: "build"`) agit dans `closeBundle`, quand `dist/` est complet :

1. il liste **tous les fichiers de `dist/`** (index, JS dont les morceaux `lazy()`, CSS, icônes, manifeste web, `osm-routes.geojson`, `data/ponts-osm.geojson`), sauf `sw.js`, `sw-policy.js`, `precache-manifest.json` et les `.map`. Il lit le dossier et non le paquet Rollup, parce que les fichiers de `public/` n'apparaissent pas dans le paquet ;
2. il calcule l'empreinte **SRI** (`sha256-<base64>`) de chaque fichier ;
3. il calcule la **révision du build** (16 caractères hexadécimaux) : empreinte de la liste (URL et empreintes), de `sw-policy.js` et de `sw.js` avant gravure ;
4. il **grave la révision dans `dist/sw.js`** (remplacement de la ligne `const REVISION_BUILD = "__REVISION_BUILD__";`). C'est indispensable : le navigateur ne réinstalle un worker que si les octets de `sw.js` (ou d'un script importé) changent. Sans gravure, un déploiement qui ne change que l'application laisserait l'ancien précache en place indéfiniment ;
5. il écrit `dist/precache-manifest.json` : `{ version: 1, revision, tailleTotale, entrees: [{ url, integrite, taille }] }`.

La construction **échoue** (plutôt que de produire un précache faux) si `index.html`, `sw.js` ou `sw-policy.js` manquent, si la ligne de révision n'apparaît pas exactement une fois, si aucun script n'existe sous `/assets/`, ou si un nom de fichier sort de l'alphabet fermé (lettres, chiffres, `. _ ~ - /`). Le plugin charge `sw-policy.js` lui-même pour appliquer la même règle (`cheminPrecachable`) : une seule source.

### 2.2 La politique pure (`public/sw-policy.js`)

Toutes les décisions sont dans des fonctions pures, testées par `src/lib/swPolicy.test.ts` sans API Cache : `aLaisserPasser`, `cachePour`, `cheminNormalise`, `cheminPrecachable`, `validerManifeste`, `nomCachePrecache`, `cachesAPurger`, `navigationUtilisable`, `decouperEnLots`, `aMettreEnCache`, `aEvincer`. `sw.js` ne contient que les événements.

Trois familles de caches :

| Cache | Nom | Contenu | Cycle de vie |
|---|---|---|---|
| Précache | `bdri-precache-<révision>` | toute l'application du build | créé à l'installation, supprimé à l'activation de la révision suivante |
| Exécution | `bdri-runtime-v1` | fichiers du même domaine absents du précache (filet, normalement presque vide) | conservé |
| Tuiles | `bdri-tuiles-v1` | tuiles OSM et ArcGIS, plafond de 600 entrées | conservé (politique inchangée) |

L'ancien `bdri-shell-v2` est supprimé à l'activation.

### 2.3 Installation atomique

À l'événement `install`, le worker : (1) lit `/precache-manifest.json` sans cache HTTP (`cache: "no-store"`) ; (2) le fait valider par `validerManifeste` (version, révision identique à celle gravée dans `sw.js`, chemins autorisés, empreintes, pas de doublon, index présent) ; (3) télécharge les fichiers par vagues de 6, chacun avec `integrity` (le navigateur vérifie l'empreinte) et `cache: "no-cache"` (revalidation auprès du serveur). **Un seul échec rejette la promesse** : l'installation échoue, l'ancien worker reste actif avec son précache complet, et le cache à moitié rempli de la nouvelle révision est supprimé. Le navigateur retentera à la prochaine vérification de `sw.js`.

Cas couverts : fichier du manifeste absent du serveur (404), fichier modifié après la génération du manifeste (empreinte fausse), worker et manifeste de deux déploiements différents (révisions différentes), manifeste altéré ou illisible.

### 2.4 Navigation

Toute navigation (hors `/api/`) : **réseau d'abord**, avec un délai de 5 s (`DELAI_NAVIGATION_MS`, PROVISOIRE), puis repli sur le précache : le fichier exact s'il y est, sinon `/index.html`. C'est le comportement d'origine (réseau d'abord, parce qu'une application servie depuis le cache ne se met jamais à jour), avec deux changements motivés :

- **la réponse du réseau n'est plus rangée en cache.** Elle l'était sous `/` et pouvait appartenir à un build plus récent que le précache. Hors ligne, la seule page servie est l'index du précache : cohérent avec ses morceaux hachés ;
- **le délai.** Hors couverture franche l'échec est immédiat, mais sur un réseau dégradé (portail captif, une barre de signal) la requête peut rester pendante des dizaines de secondes. Au bout de 5 s on sert l'application déjà présente. Un index un peu ancien reste cohérent avec ses fichiers.

Une réponse de passerelle (statut 500 et plus : 502 d'un proxy dont l'amont est arrêté) n'est pas utilisée : le repli joue.

Les navigations vers `/api/` ne passent pas par le worker.

### 2.5 Les URL `/api/` ne sont jamais mises en cache

Quatre protections superposées :

1. `aLaisserPasser` rend `true` (le worker ne répond pas) pour tout chemin d'API. Le test porte sur le chemin **normalisé comme le fera nginx** : barres fusionnées, pourcentages décodés, majuscules ignorées. `//api/x`, `/%61pi/x`, `/API/x`, `/./api/x`, `/a/../api/x`, `/api` sont tous refusés (tests `it.each`). La version d'origine ne testait que le préfixe brut `/api/` : `//api/v2/...` serait passé, puis aurait été rangé dans le cache d'exécution. C'était un trou réel, comblé ici ;
2. une méthode autre que GET passe toujours ;
3. `cheminPrecachable` refuse tout chemin d'API sous toutes ses formes, et `validerManifeste` refuse le manifeste **entier** s'il en contient une ;
4. le plugin de construction ne lit que `dist/`, où aucune URL d'API n'existe, et applique la même règle.

Le worker n'a donc aucun moyen de copier une réponse authentifiée dans le stockage du navigateur, hors du coffre chiffré.

### 2.6 Enregistrement (`src/main.tsx`)

- Enregistrement **en production seulement** (`import.meta.env.PROD`) : le serveur de développement n'a ni manifeste ni révision gravée. Les essais de bout en bout (`e2e/`) bloquent déjà les workers.
- `updateViaCache: "none"` : par défaut le navigateur relit `sw.js` hors du cache HTTP mais **pas** les scripts importés (`sw-policy.js`), qui pourraient rester périmés sous l'en-tête heuristique d'un serveur sans `Cache-Control` (voir 7).
- Un worker qui devient `redundant` pendant son installation (échec du précache) écrit un avertissement dans la console. L'enregistrement lui-même réussit même quand l'installation échoue : sans cette écoute l'échec serait muet.

## 3. Cycle de mise à jour

Question : un nouveau déploiement arrive pendant qu'un agent est hors ligne ?

**Hors ligne, rien ne se passe, et c'est voulu.** Le navigateur ne peut pas relire `sw.js` ni le manifeste. L'agent continue avec le build installé, complet et cohérent. La mise à jour est tentée à la prochaine navigation en ligne (le navigateur compare les octets de `sw.js` et de `sw-policy.js`).

Une fois en ligne, dans l'ordre :

1. le navigateur trouve un `sw.js` différent (la révision gravée a changé) et lance l'**installation** du nouveau worker, en parallèle de l'ancien qui reste actif ;
2. le nouveau worker télécharge son précache **complet** dans `bdri-precache-<nouvelle révision>`. Pendant ce temps le stockage contient les deux précaches (environ 2 fois 5,8 Mo, voir 6) ;
3. si tout réussit, il passe à l'état « en attente ». **Il n'appelle pas `skipWaiting()`** : il attend que toutes les fenêtres de l'ancienne version soient fermées. Raison : une page ouverte a chargé l'index et les morceaux de l'ancien build. Si le nouveau worker prenait la main et supprimait l'ancien précache, le prochain `import()` d'une page (morceau `lazy()` de l'ancien build) demanderait un fichier absent du cache et absent du serveur : l'écran casserait en cours de saisie. Le comportement d'origine (`skipWaiting` à l'installation) exposait à ce risque ; avec un précache complet qui remplace l'ancien à l'activation, le garder aurait fait disparaître d'un coup tous les morceaux de l'ancien build ;
4. à la fermeture de toutes les fenêtres (ou au redémarrage de l'application), le nouveau worker s'active : il supprime les précaches des révisions précédentes et l'ancien `bdri-shell-v2`, **garde les tuiles et le cache d'exécution**, et prend le contrôle (`clients.claim()`).

En attendant l'activation, une page rechargée en ligne reçoit l'index du **réseau** (réseau d'abord) : si le build est plus récent, ses morceaux hachés ne sont pas dans l'ancien précache et partent au réseau (pas d'échec en ligne). Rechargée hors ligne, elle reçoit l'index de l'ancien précache : toujours cohérente.

Un message `"activer-maintenant"` (`postMessage`) fait sauter l'attente, pour qu'une interface future puisse proposer « Mettre à jour maintenant » à un moment sûr (page qui accepte de se recharger aussitôt). Aucune page ne l'envoie aujourd'hui.

Conséquence à accepter : un agent qui ne ferme jamais l'application garde l'ancien build. Le worker n'a pas de mécanisme pour forcer la mise à jour ; compatibilité du serveur avec les anciens clients (API) à prévoir côté déploiement. Fermer toutes les fenêtres de l'application suffit (essayé sur Chromium de bureau ; comportement de la WebView Android non vérifié).

## 4. Ce que le worker ne fait pas

- Aucun précachage de zone de carte : la politique d'usage d'OpenStreetMap interdit le téléchargement en masse. Le cache des tuiles se remplit de ce que l'agent consulte (comportement d'origine).
- Aucune mise en cache de l'API, de `sw.js`, de `sw-policy.js`, ni du manifeste de précache.
- Aucune demande de stockage persistant (`navigator.storage.persist()`) : voir limites.

## 5. Contrat entre les fichiers

| Fichier | Rôle |
|---|---|
| `frontend/vite-plugin-precache.ts` | génère `precache-manifest.json`, grave la révision dans `dist/sw.js` |
| `frontend/vite.config.ts` | déclare le plugin |
| `frontend/public/sw.js` | événements (`install`, `activate`, `fetch`, `message`) |
| `frontend/public/sw-policy.js` | décisions pures, source unique des règles (le plugin la charge) |
| `frontend/src/lib/swPolicy.test.ts` | politique, contrat de `sw.js` (ligne de révision, pas de `skipWaiting` à l'installation, navigation qui ne range rien), plugin (fichier temporaire) |
| `frontend/src/main.tsx` | enregistrement |

Si `sw.js` perd la ligne `const REVISION_BUILD = "__REVISION_BUILD__";`, le test et la construction échouent.

## 6. Vérifications réelles (25/10/2026)

Environnement : Windows 11, Node 24, Vite 5.4.21, Chromium 153 headless (Playwright 1.63.0), serveur statique d'essai imitant `nginx.conf` (repli SPA, `Cache-Control` des assets et de l'index, gzip avec `Vary: Accept-Encoding`, `/api/` répondant 401), port 5301, **réseau local sans limitation de débit**.

**Tests unitaires** : `npx vitest run src/lib/swPolicy.test.ts` : 83 réussis, 0 échoué (politique, contrat de `sw.js`, plugin sur un faux `dist/`).

**Construction** : `npm run build` réussi (`tsc --noEmit` puis `vite build`), message `[precache] 133 fichiers, 5805 Ko, revision b05641ece2d7ad7d`.

**Manifeste généré** : 133 entrées, 5 944 745 octets soit **5 805 Ko** (5,67 Mo) :

| Famille | Fichiers | Taille |
|---|---|---|
| JavaScript (dont 44 morceaux de pages `lazy()`, 122 JS au total) | 122 | 2 709 Ko |
| CSS | 2 | 69 Ko |
| GeoJSON (`osm-routes.geojson` 1 945 Ko, `data/ponts-osm.geojson` 1 028 Ko) | 2 | 2 974 Ko |
| Index, icônes, logo, manifeste web, favicon | 7 | 54 Ko |

Taille transférée estimée : environ 1 593 Ko si tout est compressé en gzip niveau 6 (calcul local, **estimation** : non mesuré à travers nginx et Traefik ; PNG et ICO ne se compressent pas en pratique, donc l'estimation est un peu basse).

**Essai navigateur** (Chromium réel, scripts jetables, résultats bruts conservés hors dépôt) :

| Étape | Résultat |
|---|---|
| Première visite en ligne : précache complet | 133 entrées en cache en 6,8 s (localhost, sans limitation) ; état du worker `activated` ; aucune clé `/api` dans aucun cache |
| Chunks `lazy()` demandés en ligne avant la coupure | seulement `PublicCartePage` (`/` redirige vers `/carte`) |
| Réseau coupé, rechargement | l'application s'affiche (carte, panneaux, 18 tuiles) |
| Route `lazy()` jamais visitée en ligne : `/embed/carte` ouverte hors ligne | s'ouvre ; `EmbedCartePage-*.js`, `maps-*.js`, `maps-*.css` servis par le worker (`fromServiceWorker`) |
| Lien profond `/geoportail` hors ligne | document servi par le worker, l'application s'ouvre et redirige vers `/login` (route protégée) |
| Route inconnue hors ligne | l'application s'ouvre, affiche sa propre page 404 |
| Navigation directe vers `/api/v2/test` hors ligne | échec réseau franc (non interceptée) |
| **Redémarrage du navigateur** (profil conservé), réseau coupé dès le départ | `/` et `/embed/carte` s'ouvrent |
| Mise à jour v2 pendant que la page est ouverte | nouveau worker installé et **en attente** ; deux précaches de 133 entrées ; l'ancien worker continue de servir l'ancien morceau |
| Rechargement hors ligne avec un worker en attente | ancien build, cohérent |
| Fermeture de toutes les pages puis réouverture | nouveau worker actif ; ancien précache supprimé ; **tuiles conservées** (39 entrées) ; nouveau morceau servi ; hors ligne avec la nouvelle version : fonctionne |
| Installation qui échoue : fichier du manifeste en 404 | worker `redundant`, ancien worker actif, mêmes caches et mêmes nombres d'entrées qu'avant, avertissement en console |
| Installation qui échoue : fichier altéré après le manifeste (empreinte fausse) | idem |
| Hors ligne après ces deux échecs | l'application s'ouvre |

Écarts à ne pas masquer :

- le premier essai a **échoué** (« Failed to execute 'open' on 'CacheStorage': Unexpected internal error », installation impossible) parce que le profil du navigateur d'essai était placé dans un chemin trop long (limite de 260 caractères de Windows). Le même essai avec un profil à chemin court réussit. Ce n'est pas un défaut du worker, mais un navigateur sur un poste dont le chemin de profil est très long pourrait y être exposé ; non observé ailleurs ;
- les tuiles arcgisonline échouent hors ligne quand elles n'ont pas été vues en ligne (comportement attendu : cache de tuiles = ce que l'agent a consulté) ;
- la simulation de mise à jour réutilise les noms de fichiers hachés (contenu modifié sans renommage) : elle prouve le cycle d'installation, d'attente, d'activation et de purge, pas la résolution des morceaux d'un build réellement renommé.

## 7. Limites et risques

- **Première visite hors ligne : impossible par construction.** Le précache est téléchargé en ligne, après le chargement (événement `load`). Un téléphone qui n'a jamais ouvert l'application en ligne, ou dont le précache a été évincé, ne peut pas démarrer.
- **Coût de la première visite : environ 5,8 Mo à stocker, 1,6 Mo à transférer (estimation).** Il est payé aussi par un visiteur de la **carte publique** (`/carte`, public 3G) : le worker précharge toute l'application après le chargement, y compris les pages de la console qu'il n'ouvrira jamais, et les deux GeoJSON (2 974 Ko, 51 % du total). Options si c'est trop : retarder l'enregistrement (inactivité du navigateur), ne précacher les GeoJSON qu'après connexion, ou retirer `data/ponts-osm.geojson` du précache. Décision à prendre, non tranchée ici.
- **Quota et éviction.** Pendant une mise à jour, le stockage porte deux précaches (2 fois 5,8 Mo environ) plus les tuiles (plafond de 600). Le navigateur peut évincer le stockage d'une origine sous pression sans prévenir, sauf si elle est marquée « persistante » (`navigator.storage.persist()`, non demandé ici : sujet à traiter avec le stockage du coffre IndexedDB, qui subit la même éviction). Un précache évincé donne `Response.error()` hors ligne ; il est reconstitué au prochain passage en ligne si le worker se réinstalle, ce qui n'est **pas** garanti pour une révision déjà active (pas d'auto-réparation implémentée).
- **`leaflet.css` vient de `unpkg.com`** (`index.html`, ligne 11), un tiers : le worker ne met pas en cache les tiers. L'essai hors ligne a fonctionné parce que le **cache HTTP du navigateur** contenait la feuille (`transferSize` 0 au redémarrage), pas grâce au worker. Si ce cache est vidé ou évincé, la carte s'affichera sans mise en forme (tuiles mal positionnées) hors ligne. Voir 8 pour le correctif.
- **Pas d'auto-réparation** si le précache actif est incomplet (éviction partielle) : le worker retombe sur le réseau, donc échoue hors ligne.
- **Safari / iOS : non vérifié, non essayé.** WebKit applique sa propre politique de quota et d'éviction du stockage des sites (à lire dans la documentation WebKit avant de s'y fier : rien n'en est affirmé ici), et le comportement de ce worker (installation, mise à jour, éviction) n'a pas été observé sur WebKit. À essayer avant d'annoncer la prise en charge d'iOS.
- **WebView de l'APK : non vérifiée.** L'APK charge le site distant (`capacitor.config.json`, `server.url`). Le comportement du service worker dans la WebView Android (disponibilité, démarrage à froid, persistance du stockage, mise à jour à la fermeture de l'activité) n'a pas été essayé : aucun appareil. Chromium de bureau ne la représente pas. Une application embarquée (`webDir` servi localement) est un chantier distinct et rendrait ce worker inutile pour l'APK.
- **Un seul navigateur essayé** (Chromium 153 headless). Firefox et WebKit non essayés.
- **Délai de navigation de 5 s** : PROVISOIRE, à mesurer sur le terrain.
- **Le worker n'est pas essayé sous le vrai nginx ni Traefik** : seulement un serveur d'essai qui reproduit leurs en-têtes tels qu'ils sont lus dans `nginx.conf`.
- **Build Docker non essayé** (Node 20 alpine : `npm ci` puis `npm run build`). Le plugin n'utilise que `node:fs`, `node:path`, `node:crypto`.

## 8. En-têtes HTTP : écart avec `frontend/nginx.conf` (à corriger côté serveur, non modifié ici)

Lecture de `frontend/nginx.conf` (25/10/2026) :

| Chemin | En-tête actuel | Écart |
|---|---|---|
| `/assets/*` | `expires 1y`, `Cache-Control: public, immutable` | conforme (noms hachés ; le worker les revalide de toute façon par `cache: "no-cache"`) |
| `/index.html` | `Cache-Control: no-cache` | conforme |
| `/sw.js`, `/sw-policy.js` | **aucun `Cache-Control`** (servis par `location /` : `ETag` et `Last-Modified` seulement) | **à corriger** : `Cache-Control: no-cache`. Le navigateur relit `sw.js` hors cache HTTP, mais `sw-policy.js` est un script importé : sans `updateViaCache: "none"` (ajouté dans `main.tsx`) il pouvait rester périmé. L'en-tête le garantit aussi pour d'autres clients |
| `/precache-manifest.json` | **aucun `Cache-Control`** | **à corriger** : `no-cache`. Le worker le lit en `no-store`, mais un intermédiaire (Traefik, proxy d'opérateur) ne doit jamais le servir périmé : il ferait échouer l'installation (révision différente de celle du `sw.js` reçu) |
| `/manifest.webmanifest` | aucun `Cache-Control` | recommandé : `no-cache` (il est aussi dans le précache) |
| Types gzip | `application/geo+json` présent | `application/manifest+json` absent (négligeable, 689 octets) |

Bloc à ajouter (exemple, à valider) :

```
    location = /sw.js                  { add_header Cache-Control "no-cache"; }
    location = /sw-policy.js           { add_header Cache-Control "no-cache"; }
    location = /precache-manifest.json { add_header Cache-Control "no-cache"; }
    location = /manifest.webmanifest   { add_header Cache-Control "no-cache"; }
```

Attention, propre à nginx : un `add_header` dans une `location` **remplace** tous les `add_header` hérités du `server` (la configuration le constate déjà pour `/index.html` et `/assets/`). Ces quatre fichiers perdraient `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy` et la CSP ; les répéter dans chaque bloc ou passer à `include`.

Autres points relevés dans `nginx.conf`, hors sujet direct :

- la CSP du serveur (`script-src 'self'`) autorise le worker (`worker-src` retombe sur `script-src`). Elle **n'atteint pas** les pages HTML (constat consigné dans le fichier). Si elle le devient, `style-src` ne contient pas `unpkg.com` : la feuille `leaflet.css` serait bloquée. Raison supplémentaire de la rapatrier (voir 7) ;
- `img-src` de la CSP principale ne contient pas `server.arcgisonline.com` (présent seulement pour `/embed/`) : sans effet tant que la CSP ne s'applique pas, mais à corriger dans le même temps ;
- aucune de ces modifications n'est déployée.

### Changement proposé hors du périmètre de ce chantier : `leaflet.css`

Remplacer le `<link>` de `index.html` (unpkg) par une importation dans le code (`import "leaflet/dist/leaflet.css"` dans `src/main.tsx`) : Vite émet alors la feuille et ses images dans `dist/assets/`, donc dans le précache, sans tiers. À essayer pour vérifier que les chemins `images/*.png` de la feuille (marqueurs, couches) se résolvent bien dans le build.

## 9. Diagnostic

- Console de la page (production) : « Installation du service worker échouée : la nouvelle version n'est pas disponible hors ligne. » : l'installation du précache a échoué ; ouvrir `/precache-manifest.json` et `/sw.js` sur le serveur et comparer la révision (`const REVISION_BUILD` dans `sw.js` doit être égale à `revision` du manifeste).
- Outils de développement, onglet Application : « Service workers » (état, en attente) et « Cache storage » (`bdri-precache-<révision>` doit compter autant d'entrées que le manifeste).
- Révision incohérente après un déploiement : un cache intermédiaire a servi un `sw.js` ou un manifeste périmé ; voir les en-têtes en 8.

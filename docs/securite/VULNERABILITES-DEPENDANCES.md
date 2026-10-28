# Vulnerabilites des dependances : classement et plan de montee

Chantier C2 du Lot 1. Document du 26/10/2026. **Aucune montee n'a ete executee** : ni `npm install`, ni `npm update`,
ni `npm audit fix` (meme en simulation). Seuls `npm audit --json`, `npm ls`, `npm view` ont ete lances (lecture).

## 1. Methode

- `npm audit --json` et `npm audit --omit=dev --json`, dans `backend/` et `frontend/`, npm 11.16.0, base d'avis du
  26/10/2026. Les resultats changent avec la base d'avis : refaire la mesure avant toute decision.
- Versions installees lues dans `node_modules` et `npm ls --all` ; versions publiees par `npm view`.
- "Exploitable dans CE depot" : j'ai lu le code qui appelle le paquet (fichier:ligne) avant d'affirmer. Le **texte
  complet des avis n'a pas ete lu** : je ne m'appuie que sur leurs titres et plages de versions, rapportes par npm. Quand
  le titre ne suffit pas a conclure, c'est ecrit "non etabli".
- "Prod" = atteignable depuis `dependencies` selon npm ; le backend est livre avec `npm ci --omit=dev`
  (`backend/Dockerfile`), le frontend est livre sous forme de bundle Vite (seules les `dependencies` utilisees y entrent).

## 2. Comptes

| Perimetre | Total | Critique | Haute | Moyenne | Dont "prod" (`--omit=dev`) |
|---|---|---|---|---|---|
| Backend | **20** | 3 | 9 | 8 | 13 (1 / 7 / 5) |
| Frontend | **22** | 3 | 7 | 12 | 10 (1 / 4 / 5) |

Le Lot 0 consignait 13 pour le backend (concordant) et 11 pour le frontend en `--omit=dev` ; j'en compte 10 aujourd'hui.
Les trois "critiques" du backend sont `proxy-addr`, `vitest`, `tinypool` ; celles du frontend `jspdf`, `vitest`, `tinypool`.

**Lecture d'ensemble** : sur les 13 vulnerabilites "prod" du backend, **cinq sont atteignables** par un client
(`compression`, `body-parser`, `qs`/`express`, `morgan`, plus `multer` apres authentification) ; elles se corrigent toutes
par des montees **mineures**. Les "critiques" annoncees sont, dans ce depot, soit non atteintes (`proxy-addr`), soit des
outils de test (`vitest`, `tinypool`). Cote frontend, rien de "prod" n'est atteignable par une entree que controle un tiers
tel que le code l'emploie, mais `jspdf` demande une montee majeure.

## 3. Backend : classement de chacune des 20 vulnerabilites

| Paquet (installe) | Gravite npm | Chemin | Env. | Exploitable ici ? | Correctif disponible | Risque de la montee |
|---|---|---|---|---|---|---|
| `proxy-addr` 2.0.7 | critique | express > proxy-addr | prod | **Non, d'apres le titre** ("usurpation d'IP via le sous-reseau IPv4-mappe de confiance"). `app.ts:52` fixe `trust proxy` a **1** (nombre de sauts), pas une liste de sous-reseaux. A reverifier si cette valeur devient une liste. | 2.0.8, dans la plage `~2.0.7` d'express : mineur | faible |
| `body-parser` 1.20.6 | haute | express > body-parser | prod | **Oui, sans authentification** : `express.json({limit:"5mb"})` global (`app.ts:90`), avant tout controle d'acces ; DoS par octets apres un corps compresse. | 1.20.9 (`~1.20.5` d'express 4.22.3) : mineur | faible |
| `compression` 1.8.1 | haute | **directe** | prod | **Oui, sans authentification** : `app.use(compression())` global (`app.ts:79`), y compris `/api/public/carte/geo` (2,8 Mo). Fuite de memoire si le client coupe pendant la reponse. | 1.8.2, dans `^1.7.4` : mineur | faible |
| `multer` 2.2.0 | haute (6 avis) | **directe** | prod | **Oui, apres authentification** : les 13 sites d'appel de multer (photos d'inspection, d'observation, de defaut, d'OT, d'ouvrage, de tache ; documents ; 5 imports Excel v1 et l'import v2) sont derriere `requireAuth`, lu au niveau du routeur ou de la route. Un compte valide peut saturer le serveur. | 2.5.0 (dernier avis : `<2.5.0`), dans `^2.0.0` : mineur | moyen : touche tout le televersement |
| `nodemailer` 9.0.3 | haute (11 avis) | **directe** | prod | **Non par un tiers.** `lib/mailer.ts` n'envoie qu'aux adresses internes (alertes contractuelles, `jobs/alertes-contractuelles.ts:98`) et le test d'envoi est reserve a l'administration. Les avis (analyse d'adresse, contournement de liste d'autorisation) exigent une adresse hostile ; aucune liste d'autorisation n'est utilisee. | **>= 10.1.4** (dernier avis) : majeur 9 vers 10 (derniere publiee 10.2.1). npm dit `fixAvailable: true` alors que `^9.0.3` n'atteint pas 10.x : **contradiction a lever** avant montee. | moyen : lire le journal des changements 10.x ; 2 usages (envoi, test d'envoi) |
| `zod` 3.25.76 | haute | **directe** | prod | **Non etabli.** L'avis vise le gonflement memoire sur de grandes collections contraintes ; la plage publiee (`<4.6.6`) inclut la 3.x sans qu'on sache si le chemin existe en 3.x. Mitigation en place : corps limite a 5 Mo, tableaux bornes (`.max(...)`, p. ex. `defauts.routes.ts:71`, `export.routes.ts:42`). | 4.6.7 : **majeur** 3 vers 4 | **eleve** : 59 fichiers importent zod |
| `express` 4.22.2 | moyenne | **directe** | prod | via `qs` (voir ci-dessous) | 4.22.3 (depend de `qs ~6.16.0`, `body-parser ~1.20.5`) : mineur | faible a moyen : couvre tout le serveur |
| `qs` 6.15.2 | moyenne (2 avis) | express > qs | prod | **Oui** : express 4 analyse la chaine de requete avec `qs` pour toutes les routes, authentifiees ou non. Effet : DoS (limite de tableaux contournee, `isBuffer` controle par l'attaquant). Gravite publiee : moyenne. | 6.16.x, atteint via express 4.22.3 | faible |
| `morgan` 1.11.0 | moyenne (2 avis) | **directe** | prod | **Oui, sans authentification** : `morgan("combined")` (`app.ts:91`) ecrit la ligne de requete, le referent et l'agent utilisateur, que le client controle : un separateur de ligne Unicode ou un guillemet permet de **falsifier une ligne du journal d'acces**. N'atteint pas `audit_logs` (base). | 1.12.1, dans `^1.10.0` : mineur | faible |
| `brace-expansion` 5.0.9 (+ 4 copies) | haute | swagger-jsdoc > glob > minimatch ; exceljs > archiver-utils, readdir-glob, zip-stream ; rimraf | prod | **Non** : ReDoS et recursion sur des motifs que fournit l'appelant ; ici les motifs sont fixes (`apis: ["./src/modules/**/*.routes.ts"]`, `app.ts`) ou internes a exceljs. | versions corrigees dans les plages des parents : mineur (fichier de verrou) | faible |
| `fast-uri` 3.1.6 | haute (7 avis) | swagger-jsdoc > swagger-parser > ajv > fast-uri | prod | **Non** : analyse de la specification OpenAPI du depot, jamais d'une URL fournie par un client. | 3.1.9 ou plus (plages `<3.1.9`) : mineur | faible |
| `exceljs` 4.4.0 | moyenne | **directe** | prod | via `uuid` : **non** (voir ci-dessous) | npm propose `exceljs@3.4.0` : c'est un **retour en arriere** de 4.4.0 vers 3.4.0, **a ne pas suivre** | - |
| `uuid` 8.3.2 | moyenne | exceljs > uuid | prod | **Non** : le defaut concerne `v3/v5/v6` appeles avec un tampon ; `exceljs` n'emploie que `v4()` sans argument (`cf-rule-ext-xform.js`, verifie). | attendre une version d'exceljs sur uuid >= 11, ou `overrides` (a tester sur l'import/export Excel) | moyen si override |
| `vitest` 2.1.9 | critique | **directe** | dev | **Non** : `npm test` = `vitest run`, jamais le serveur d'interface (`--ui`) que vise l'avis critique (`<3.2.6`). N'est pas dans l'image (`--omit=dev`). | npm : 5.0.5 (majeur) ; 3.2.7 corrige le seul critique | moyen (voir plan) |
| `tinypool` 1.1.1 | critique | vitest > tinypool | dev | **Non** : gadget de pollution de prototype via les options de worker, que seul le code de test peut fournir. | avec vitest | - |
| `vite` 5.4.21, `vite-node` 2.1.9, `@vitest/mocker` 2.1.9, `esbuild` (copie sous vite) | haute / moyennes | vitest > ... | dev | **Non etabli**, plausiblement non : ce sont les avis du serveur de developpement de Vite (contournement de `server.fs.deny` sous Windows, `launch-editor`) ; le backend n'en lance pas. Non verifie dans le code de vite. | avec vitest | - |
| `source-map-js` 1.2.1 | haute | vitest > vite > postcss | dev | **Non** | 1.2.2 : mineur (verrou) | nul |

## 4. Frontend : classement de chacune des 22 vulnerabilites

| Paquet (installe) | Gravite npm | Chemin | Env. | Exploitable ici ? | Correctif disponible | Risque de la montee |
|---|---|---|---|---|---|---|
| `jspdf` 2.5.2 | **critique** (12 avis) | **directe** | prod (bundle) | **Tres peu probable.** Un seul usage : `ExportControl.tsx:3,34-35`, `new jsPDF(...)` puis `addImage(canvas.toDataURL("image/png"), "PNG", ...)` d'une capture de la carte (`html2canvas`). Aucun appel a `html()`, `addJS`, formulaires ou metadonnees ; l'image vient du canevas de l'application, pas d'un tiers. L'avis critique (inclusion locale de fichier) concerne la version Node. | 4.2.1 : **majeur** 2 vers 4 (3.0.4 ne suffit pas) | moyen : 1 point d'usage ; a essayer dans un navigateur |
| `dompurify` 2.5.9 | haute | jspdf > dompurify | prod (bundle) | **Non** : `jspdf.es.js` ne le charge que par `import('dompurify')` dynamique, dans le chemin `html()` avec une source texte (verifie dans le fichier) ; `ExportControl.tsx` n'appelle que `addImage`. Vite peut quand meme produire un fragment de bundle inutilise (non inspecte). | avec jspdf 4.2.1 | - |
| `axios` 1.18.1 | haute (12 avis) | **directe** (8 fichiers) | prod | **Faible.** Navigateur seulement : le champ `browser` de `axios/package.json` remplace l'adaptateur Node (`./lib/adapters/http.js`) par un module nul, donc ReDoS de `fromDataURI`, proxy et HTTP/2 (Node) ne sont pas empruntes ; les "gadgets" de pollution de prototype exigent une pollution prealable ailleurs. | 1.20.0, dans `^1.7.7` : mineur | faible a moyen : login, rafraichissement, synchronisation hors ligne (`api.ts`, `offlineSync.ts`) |
| `follow-redirects` 1.16.0 | haute | axios > follow-redirects | prod | **Non** : sert l'adaptateur Node d'axios, exclu du bundle par le champ `browser` (bundle non inspecte). | 1.16.1, dans la plage : mineur | nul |
| `react-router-dom` / `react-router` 6.30.6 | moyenne | **directe** | prod | **Non**, au vu des avis : redirection ouverte par une barre oblique inverse dans `<Link>` / `useNavigate` (exige une destination fournie par un tiers) et injection a l'hydratation SSR (le depot ne fait pas de SSR). Aucune navigation construite depuis un parametre d'URL n'a ete trouvee (recherche de `navigate(` avec `search`/`param`/`redirect` : aucun resultat). | 7.18.4 : **majeur** | eleve : 49 usages, a grouper avec React 19 |
| `tailwindcss` 3.4.19, `postcss-nested`, `postcss-selector-parser` | moyenne | tailwindcss > ... | npm dit prod ; **outil de build** | **Non** : ReDoS quadratique a l'analyse de selecteurs CSS lors de la compilation de nos propres sources. Classe "prod" par npm parce que `tailwindcss-animate` (dependance) le tire en pair ; rien n'entre dans le bundle. | tailwindcss 4.3.3 : majeur | eleve (migration de configuration) : reporter |
| `source-map-js` 1.2.1 | haute | postcss > source-map-js | outil de build | **Non** | 1.2.2 : mineur (verrou) | nul |
| `browserslist` 4.28.4, `baseline-browser-mapping` 2.10.38 | haute / moyenne | autoprefixer > ... | dev | **Non** (outil de build, fichiers de statistiques qu'on ne fournit pas) | mineur (verrou) | nul |
| `vite` 5.4.21 | haute | **directe** | dev | **Possible, sur le poste du developpeur** : `npm run dev` lance le serveur de developpement de Vite, que visent les avis (contournement de `server.fs.deny` **sous Windows**, `launch-editor`). Ce poste est sous Windows. Reste limite a `localhost` par defaut ; pas d'effet en production (build statique). | npm : 8.3.5 (majeur) ; la 6.x a des versions plus recentes que 6.4.3 (6.4.5 publiee) | moyen : 5 vers 6 touche `@vitejs/plugin-react`, la config, vitest |
| `esbuild` 0.21.5 | moyenne | vite > esbuild | dev | **Non etabli** : avis sur le **serveur** d'esbuild, que Vite n'emploie pas comme serveur HTTP (non verifie dans Vite). | avec vite | - |
| `vitest` 2.1.9, `tinypool`, `@vitest/mocker`, `vite-node` | critique / moyennes | **directe** (vitest) | dev | **Non** : memes raisons que cote backend ; `npm test` = `vitest run` | 5.0.5 (npm) ; 3.2.7 corrige l'avis critique | moyen |
| `zod` 3.25.76 | haute | **directe, devDependency** | dev | **Non** : ne sert que dans 4 fichiers de test. | 4.6.7 majeur, ou **retirer** la dependance si elle n'est utile qu'a ces tests | faible |
| `@capacitor/cli` 8.5.3, `xcode` 3.0.1, `uuid` 7.0.3 | moyenne | @capacitor/cli > xcode > uuid | dev | **Non** : outillage de construction de l'application Android, aucune entree externe. | npm propose `@capacitor/cli@8.4.3` : **retour en arriere**, a ne pas suivre | - |

## 5. Plan de montee sequence

Principes : une PR par lot ; jamais `npm audit fix --force` (il proposerait ici deux retours en arriere,
`exceljs@3.4.0` et `@capacitor/cli@8.4.3`) ; pour chaque lot, comparer `git diff package-lock.json` ligne a ligne et
refaire `npm audit` avant/apres ; un lot ne melange pas mineur et majeur.

### Lot V1 : backend, montees mineures atteignables (priorite 1, environ 1 jour)

Pourquoi en premier : ce sont les seules vulnerabilites **atteignables sans compte** (`compression`, `body-parser`,
`qs`, `morgan`), et elles se corrigent sans changer de version majeure.

1. `express` 4.22.2 vers 4.22.3 (entraine `body-parser` 1.20.9, `qs` 6.16.x, `proxy-addr` 2.0.8 via le verrou).
2. `compression` vers 1.8.2.
3. `morgan` vers 1.12.1.
4. `multer` 2.2.0 vers 2.5.0.
5. Mise a jour du verrou seul : `brace-expansion`, `fast-uri` (sans effet fonctionnel attendu).

Commandes indicatives (non executees) : `npm update express compression morgan multer` puis `npm update body-parser qs
proxy-addr brace-expansion fast-uri` ; verifier que `package.json` n'a pas change de plage.

A tester :
- `npx vitest run` (backend entier) et `tsc --noEmit` ;
- bancs PostGIS qui passent par les routes reelles : `photos-observation`, `import`, `sync`, `taches-internes`,
  `territoire` (`tests-integration/run.sh` et bancs a clone) ;
- **a ajouter** : un test de non-regression de la compression (reponse `Content-Encoding: gzip` sur
  `/api/public/carte/geo`, puis coupure client en cours de reponse) et un de televersement multipart limite en taille ;
- un televersement reel de chaque type dans un navigateur (photo, document, import Excel) ;
- construire l'image (`docker build`) et lancer `npm audit --omit=dev` dans le conteneur : attendu, il ne reste que
  `zod`, `nodemailer`, `exceljs` et `uuid`.

### Lot V2 : frontend, montees mineures (priorite 2, environ 0,5 jour)

`axios` vers 1.20.0, `follow-redirects` vers 1.16.1, verrou de `source-map-js`, `browserslist`,
`baseline-browser-mapping`. A tester : `vitest run` (1 203 tests), `vite build`, et a la main la connexion, le
rafraichissement de jeton et la synchronisation hors ligne (aucun test de bout en bout navigateur n'existe : constat du
Lot 0, E2).

### Lot V3 : outillage de test et de developpement (priorite 3, environ 1 jour, backend et frontend)

Aucun effet en production ; reduit le bruit de l'audit et le risque sur les postes de developpement.
1. `vitest` 2.1.9 vers 3.2.7 (supprime le critique de l'interface web ; `tinypool` et `@vitest/mocker` demandent
   probablement une version plus recente, jusqu'a 5.0.5 selon npm : **verifier les `peerDependencies` de vite et de
   Node** au moment de la montee, non verifie ici). Suite de tests entiere a refaire : durees, `jsdom`, mocks.
2. `vite` (frontend) 5.4.21 vers 6.4.5 ; verifier `@vitejs/plugin-react` et `vite.config.ts` (proxy `/api`).
3. Ne pas migrer vers vite 8 ni vitest 5 dans le meme lot.

### Lot V4 : montees majeures, une par lot dedie (plus tard)

A ne lancer qu'avec des tests de bout en bout (action 1 du backlog du Lot 0).

| Ordre | Montee | Pourquoi | Risque | Preuve exigee |
|---|---|---|---|---|
| 1 | `jspdf` 2.5.2 vers 4.2.1 | seule "critique prod" du frontend, un seul point d'usage | moyen | export PDF de la carte, essai navigateur, taille du bundle |
| 2 | `nodemailer` 9 vers >= 10.1.4 | 11 avis, mais non atteignables par un tiers | moyen | test d'envoi depuis l'administration, tache d'alertes contractuelles |
| 3 | `zod` 3 vers 4 (backend) | 1 avis a l'atteinte non etablie ; touche 59 fichiers | **eleve** | toute la suite backend ; plus gros chantier ; retirer `zod` du frontend s'il ne sert qu'aux tests |
| 4 | `react-router-dom` 6 vers 7, `tailwindcss` 3 vers 4 | avis non atteignables | eleve | a grouper avec React 19 et Vite : aucune urgence d'apres l'audit |

### Ce qu'on accepte explicitement, avec date de revue

`uuid` (via `exceljs`), `esbuild` et `vite` du backend, `@capacitor/cli` : non atteignables. Les consigner comme
acceptes dans la revue de securite et refaire l'audit apres le lot V3.

## 6. Non verifie

- Le texte complet de chaque avis (seuls titres et plages npm). Les conclusions "non atteignable" reposent donc sur le code
  d'usage lu et sur ces titres.
- Le bundle Vite de production (je n'ai pas construit le frontend) : l'absence de `follow-redirects` et de `dompurify`
  dans le bundle est deduite de `package.json` d'axios et de l'usage de `jspdf`, pas d'une inspection.
- Les `peerDependencies` des versions cibles (vitest 3/4/5, vite 6, jspdf 4) et les journaux de changements : a lire au moment
  de chaque montee.
- Les versions cibles "mineures" ont ete lues dans les plages de dependances d'`express` 4.22.3 (`npm view`) et dans les
  versions publiees ; aucune n'a ete installee ni testee.
- Les gains attendus apres chaque lot (comptes d'`npm audit`) sont des previsions.

# AUDIT BDRI 2026 — Diagnostic général

**Application auditée** : Console BDRI — https://carte.ageroute.gov.gn
**Dépôt** : `github.com/tidiokamsar/ageroute-geoportail`
**Commit audité** : `432b593` — branche d'audit : `audit/bdri-2.0`
**Date** : 1er septembre 2026
**Périmètre** : architecture, code, base, modules, sécurité, performance, SIG, données

---

## Avertissement sur la portée

Ce document est le **premier tour d'audit**. Chaque constat qu'il énonce a été
**mesuré ou lu dans le code**, jamais déduit de la documentation. Les points que je
n'ai pas pu vérifier sont signalés comme tels plutôt que supposés acquis.

**Ce que je n'ai pas pu vérifier à ce stade :**

| Sujet | Raison |
|---|---|
| Contenu réel des tables, volumétrie, valeurs nulles | Accès `psql` au conteneur de production refusé par le garde-fou de session |
| Plan d'exécution des requêtes (`EXPLAIN`) | Idem |
| Existence et fraîcheur des sauvegardes de base | Non vérifiable sans accès base |
| Comportement réel de la géolocalisation | Permission refusée dans le navigateur de test |
| Rendu de l'application sur un vrai téléphone | Émulation uniquement (360×640, 375×812) |

Ces points doivent être couverts au second tour, avec un accès base en lecture seule.

---

## 1. Synthèse

La BDRI est une application **saine dans ses fondations** : séparation frontend/backend
nette, ORM typé, migrations versionnées, journal d'audit systématique, suppression
logique sur le patrimoine, en-têtes de sécurité posés par Helmet, authentification
solide (Argon2id, JWT rotatif, TOTP, verrouillage).

Elle n'est en revanche **pas encore un géoportail** au sens SIG du terme : il n'existe
aucun index spatial, aucune analyse spatiale exploitable, aucun service OGC, et la
donnée cartographique est servie brute, non compressée, en un seul bloc de 2,8 Mo.

Trois défauts appellent une correction avant toute autre évolution :

1. **Les fichiers téléversés sont détruits à chaque déploiement.**
2. **La donnée publique est servie sans compression** — 2,8 Mo sur un réseau guinéen.
3. **Aucun index spatial** sur les cinq colonnes géométriques.

---

## 2. Constats — classés par gravité

### P0-1 — Les documents et photos sont perdus à chaque reconstruction

**Constat mesuré.** Le service `backend` de `docker-compose.yml` ne déclare aucun
volume. Seule la base en possède un (`bdri_pgdata`). Les téléversements atterrissent
dans `/app/uploads` **à l'intérieur du conteneur**.

```
$ docker exec console-bdri-backend-1 find /app/uploads -type f | wc -l
0
```

**Conséquence.** Chaque `docker compose up -d` recrée le conteneur et efface les
fichiers. Aujourd'hui sans effet — le dossier est vide — mais les pages Base
documentaire, Inspection terrain et Ordres de travaux sont **en production** et
servent précisément à téléverser. Le premier fichier déposé sera perdu.

**Correction.** Monter `bdri_uploads:/app/uploads` sur le service backend. Sans
risque aujourd'hui puisqu'il n'y a rien à migrer ; coûteux dès qu'il y aura des
fichiers.

---

### P0-2 — Aucune compression sur les réponses

**Constat mesuré**, en production, le 01/09/2026 :

| Ressource | Sans `Accept-Encoding` | Avec `gzip, br` |
|---|---|---|
| `/api/public/carte/geo` | 2 825 507 o | **2 825 507 o** |
| `/assets/index-*.js` | 152 262 o | **152 262 o** |

Aucun en-tête `Content-Encoding` n'est renvoyé. Ni Express (pas de middleware
`compression`) ni Nginx (`frontend/nginx.conf` ne contient aucune directive `gzip`)
ne compressent quoi que ce soit.

**Conséquence.** Le GeoJSON est du texte très répétitif : gzip y gagne
habituellement 85 à 90 %. On sert donc environ **huit fois plus d'octets que
nécessaire**, à un public que la page vise explicitement — des citoyens guinéens en
3G. À 200 kbit/s effectifs, 2,8 Mo demandent près de deux minutes ; 350 Ko en
demandent une quinzaine de secondes.

**Correction.** `compression` côté Express pour l'API, `gzip on` côté Nginx pour les
assets. Deux modifications indépendantes, sans effet fonctionnel.

---

### P0-3 — Aucun index spatial

**Constat mesuré.** Cinq colonnes géométriques sont déclarées au schéma
(`Troncon.geom`, `Ouvrage.geom`, `PointNoir.geom`, `Poste.geom`, `Chantier.geom`).
Les migrations comptent 36 index, **aucun de type GIST** :

```
$ grep -rn "GIST\|gist" backend/prisma/migrations/
(aucun résultat)
```

**Conséquence.** L'unique requête spatiale actuelle (`ST_DWithin` dans `itineraire`)
balaie les 1 690 tronçons. Cela passe à ce volume. Mais toutes les analyses visées
par la mission — « quels ouvrages sont proches de ce chantier », « quels tronçons
dégradés dans cette région » — sont des requêtes spatiales : sans index, elles
seront inutilisables. C'est un **prérequis d'architecture**, pas une optimisation.

**Correction.** `CREATE INDEX ... USING GIST (geom)` sur les cinq tables, par
migration versionnée. Prisma ne gère pas les colonnes `Unsupported` : l'index doit
être écrit en SQL dans la migration.

---

### P1-1 — La recherche globale contourne les droits par module

**Constat lu dans le code.** `backend/src/modules/search/search.routes.ts` :

```ts
searchRouter.get("/", requireAuth, async (req, res, next) => {
```

Seul `requireAuth` est appliqué. La requête interroge ensuite **tronçons, ouvrages,
points noirs, postes et chantiers** sans considérer `modulesAutorises`. Le
middleware `requireModuleAccess` existe et est correctement branché sur 10 des 18
fichiers de routes — mais pas sur celui-ci.

**Conséquence.** Un utilisateur restreint au seul module « Tronçons » obtient malgré
tout, via `/api/search?q=...`, l'identifiant et le libellé des ouvrages, postes et
chantiers. La fuite reste limitée (id + libellé, 5 résultats par type), mais elle
répond par l'affirmative à la question posée par la mission : *oui*, on contourne
les droits en appelant l'API directement.

**Correction.** Filtrer les entités interrogées selon `modulesAutorises` de
l'appelant. La réponse porte déjà la clé `module` par résultat : la structure s'y
prête.

---

### P1-2 — Le journal d'audit est lisible par tout compte authentifié

**Constat lu dans le code.** `backend/src/modules/audit/audit.routes.ts` :

```ts
auditRouter.get("/", requireAuth, async (req, res, next) => {
```

Aucun contrôle de rôle ni de module. La réponse inclut `before` et `after`, soit
**l'état complet de l'entité avant et après modification**.

**Conséquence.** Un compte LECTEUR peut lire l'historique de n'importe quelle entité,
`Marche` comprise, et donc les montants, devises et statuts contractuels — alors même
que le module Marchés lui serait refusé. La fuite est ici bien plus large qu'en P1-1,
puisqu'elle porte sur les valeurs et non sur des libellés.

**Correction.** Réserver la consultation au rôle ADMIN, ou l'aligner sur le module de
l'entité consultée (`entityType` est déjà un paramètre obligatoire).

---

### P1-3 — Aucune donnée d'origine et de destination

**Constat lu dans le schéma et le code.** Le modèle `Troncon` porte `prefecture` et
`commune`, ajoutés par la migration `20260701150000_troncon_draw_fields`. **Rien ne
les remplit** : aucun import, aucun service, aucun écran ne les écrit.

```
$ grep -rn "prefecture" backend/src
backend/src/modules/troncons/troncons.schema.ts:19:  prefecture: z.string().optional(),
```

Le seul répertoire de lieux disponible est celui des **huit régions**. Kissidougou,
Tokounou et les autres préfectures et sous-préfectures sont absentes.

**Conséquence.** Une recherche du type « Kankan–Kissidougou » est impossible. C'est
une limite de **données**, pas de code.

**Correction.** Voir §29 de la mission : construire le référentiel administratif
(régions → préfectures → sous-préfectures → communes → localités) et rattacher les
tronçons. C'est un chantier de données à part entière.

---

### P1-4 — La fonction « itinéraire » n'en est pas une

**Constat lu dans le code.** `troncons.service.ts`, fonction `itineraire` :

```sql
ligne AS (SELECT ST_MakeLine((SELECT g FROM a), (SELECT g FROM b)) AS g)
ST_Distance((SELECT g FROM a)::geography, (SELECT g FROM b)::geography) / 1000
```

Elle trace une **droite entre les centroïdes** de deux tronçons et renvoie la
distance à vol d'oiseau, plus les régions situées à moins de 20 km de cette droite.
Elle ne suit à aucun moment le réseau routier.

**Conséquence.** Le résultat affiché à l'utilisateur sous le nom « itinéraire » est
trompeur : la distance annoncée n'est pas une distance routière.

**Correction.** Soit renommer honnêtement la fonction (« distance à vol d'oiseau »),
soit installer pgRouting et construire une topologie sur les géométries. Le second
choix conditionne l'ambition « calcul d'itinéraire » de la BDRI 2.0.

---

### P2-1 — Couverture de tests quasi nulle

**Constat mesuré.** Trois fichiers de test dans tout le dépôt, **aucun côté
frontend** :

```
backend/src/lib/crud-factory.test.ts
backend/src/modules/users/users.service.test.ts
backend/src/utils/password.test.ts
```

Aucun test sur les routes, les permissions, l'authentification, les imports, les
uploads ou la couche spatiale. Le frontend n'a pas de lanceur de test configuré
(`package.json` ne déclare que `dev`, `build`, `preview`, `lint`).

**Conséquence.** Toute évolution de la BDRI 2.0 se fera sans filet. C'est le
principal risque de la feuille de route : le volume de changement prévu est sans
commune mesure avec la couverture actuelle.

---

### P2-2 — Aucune intégration continue active

Un fichier `.github/workflows/ci.yml` a été rédigé (compilation + tests, sans job de
déploiement) mais **n'est pas commité** : l'ajout d'un fichier de workflow a été
refusé par le garde-fou de la session d'audit. À committer manuellement.

---

### P2-3 — Le frontend ne pose aucun en-tête de sécurité

**Constat mesuré.** L'API renvoie un jeu Helmet complet (CSP, HSTS, `nosniff`,
`frame-ancestors 'none'`). Les réponses du frontend, servies par Nginx, n'en portent
**aucun** :

```
$ curl -D - -o /dev/null https://carte.ageroute.gov.gn/embed/carte
Content-Length: 881
```

**Deux lectures.** Côté risque, la page HTML n'est protégée ni par CSP ni par HSTS.
Côté fonctionnel, c'est ce qui **permet** l'intégration SharePoint de `/embed/carte` :
si l'on ajoute `X-Frame-Options` ou `frame-ancestors` au frontend sans exception, on
casse la mini-carte de l'intranet (§36 de la mission).

**Correction.** Poser les en-têtes au niveau Nginx, avec une directive
`frame-ancestors` autorisant explicitement le domaine SharePoint d'AGEROUTE sur la
seule route `/embed/`.

---

### P2-4 — Aucune politique de cache

Les assets sont pourtant nommés par empreinte (`index-D1qFbNRm.js`), donc
immuables : ils pourraient être mis en cache un an. Aucun `Cache-Control` n'est
renvoyé, ni sur les assets, ni sur l'API publique. Chaque visite retélécharge tout.

---

### P3-1 — Anomalies de données constatées

Relevées en consultant les données réelles de production via l'API publique :

| Anomalie | Exemple | Effet |
|---|---|---|
| Tronçons de longueur nulle | `RES-782`, `RES-802` — `longueurKm = 0` | Faussent tout classement par longueur et le calcul du linéaire |
| Classe incohérente avec le numéro | `RN2` est classée `RR` | La fiche affiche « Route régionale » pour une route nationale |
| `code` identique à `nom` | `RES-782` | La référence n'apporte aucune information |

Ces trois anomalies plaident pour le **centre de qualité des données** prévu au §28
de la mission.

---

## 3. Ce qui fonctionne bien

Ces points ont été vérifiés et ne demandent pas d'intervention :

- **Authentification.** Argon2id, JWT d'accès 15 min, rafraîchissement rotatif
  révocable, TOTP, verrouillage après 5 échecs. La vérification 2FA est désormais
  plafonnée par challenge et limitée par IP — testé en production : 401 jusqu'au
  10ᵉ essai, puis 429.
- **Traversée de répertoire.** `photoAbsolutePath` applique `path.basename()` : la
  remontée de répertoire est effectivement bloquée, et commentée comme telle.
- **En-têtes de sécurité de l'API.** Jeu Helmet complet et cohérent.
- **Limitation de débit.** L'API publique est plafonnée à 60 requêtes/minute par IP,
  en-têtes `X-Ratelimit-*` à l'appui.
- **Séparation public/privé.** L'endpoint public expose trois couches en champs
  réduits : ni entreprise, ni bailleur, ni montant, ni contrat, ni PK, ni trafic.
  La réduction est faite explicitement dans le contrôleur, pas par omission.
- **Journal d'audit.** Toute écriture y passe ; le contournement demanderait un accès
  direct à la base.
- **Migrations.** 16 migrations versionnées, identiques entre le dépôt et le serveur.
- **Suppression logique.** `deletedAt` sur les entités patrimoniales, respectée dans
  les requêtes.

---

## 4. Réponses aux questions posées par la mission

**« Un utilisateur peut-il contourner les droits en appelant directement l'API ? »**
Oui, sur deux routes : `/api/search` et `/api/audit` (P1-1 et P1-2). Les seize autres
routes sont correctement gardées.

> ### ⚠️ CORRECTION — cette réponse était fausse
>
> Le second tour a établi qu'une **troisième** route fuyait, et plus largement que les
> deux autres : **treize routes de lecture du module Marchés** n'avaient aucune garde
> de module. Liste des marchés, montants, décomptes, bailleurs et décaissements par
> bailleur étaient lisibles par tout compte authentifié.
>
> **Pourquoi je l'ai manquée.** J'avais vérifié la présence de `requireModuleAccess`
> **fichier par fichier**. `marches.routes.ts` la mentionne dix fois : le fichier a
> donc passé le contrôle. Or il compte 25 routes — les neuf routes d'écriture étaient
> gardées, les treize routes de lecture ne l'étaient pas. Un contrôle au niveau du
> fichier ne dit rien du niveau de la route.
>
> La phrase « les seize autres routes sont correctement gardées » est conservée
> ci-dessus telle qu'écrite, plutôt qu'effacée. Voir `SECOND-AUDIT-BDRI-2026.md` §2.3
> et §3 pour l'audit refait route par route.

**« Le stockage des photos sur disque du conteneur est-il risqué ? »**
Oui, et de la pire manière : la perte est **certaine** au prochain déploiement, pas
seulement probable (P0-1).

**« La journalisation est-elle impossible à contourner ? »**
Oui par l'application. Mais elle est **lisible** par n'importe quel compte (P1-2), ce
qui est un problème distinct et réel.

**« Faut-il aller vers GeoServer ? »**
La question est prématurée. Sans index spatial (P0-3) ni compression (P0-2),
l'architecture actuelle n'est pas encore exploitée à la moitié de ses capacités.
Poser GeoServer par-dessus reviendrait à masquer le problème par une couche
supplémentaire. Réévaluer une fois ces deux points corrigés et mesurés.

---

## 5. Suite

Voir `BACKLOG-BDRI-2.md` pour les tickets et `ROADMAP-BDRI-2.md` pour le séquencement.
Le second tour d'audit doit porter sur les points listés en tête de document, et
exige un accès en lecture seule à la base de production.

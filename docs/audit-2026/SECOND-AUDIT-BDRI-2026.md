# SECOND AUDIT BDRI 2026 — Sécurisation et préparation du déploiement

**Application** : Console BDRI — https://carte.ageroute.gov.gn
**Branche** : `audit/bdri-2.0` · **Base** : `432b593`
**Date** : 1er septembre 2026
**Statut de déploiement** : **RIEN N'EST DÉPLOYÉ.** Tout est commité sur la branche.

---

## Convention de niveau de preuve

Chaque affirmation de ce document porte l'un de ces quatre niveaux. Ils ne sont pas
interchangeables.

| Niveau | Signification |
|---|---|
| **VÉRIFIÉ** | Exécuté et observé : test passé, mesure prise, commande lancée |
| **OBSERVÉ DANS LE CODE** | Lu dans les sources, non exécuté |
| **NON VÉRIFIÉ** | Demande un accès dont je ne dispose pas |
| **RECOMMANDÉ** | Proposition ; n'est pas un constat |

---

## 1. Résumé exécutif

Le second tour a corrigé **trois** vulnérabilités de contrôle d'accès, pas deux.

La troisième — la plus large — **n'avait pas été vue au premier tour**. Elle est
décrite en §2.3, avec l'explication de pourquoi je l'ai manquée.

Vingt-huit tests de non-régression ont été ajoutés. **Dix d'entre eux ont été
exécutés contre le code vulnérable et ont échoué**, ce qui établit qu'ils détectent
réellement les failles et ne se contentent pas de passer.

Trois éléments restent préparés mais non appliqués : les index spatiaux, le
référentiel administratif et le routage réel. Ils demandent des mesures ou des
données dont je ne dispose pas.

---

## 2. Vulnérabilités corrigées

### 2.1 P0-SEC-01 — `/api/search` ignorait les modules autorisés

**Constat — OBSERVÉ DANS LE CODE puis VÉRIFIÉ par test.** La route n'appliquait que
`requireAuth` et interrogeait cinq types d'entités sans consulter `modulesAutorises`.

**Correction.** Chaque type n'est interrogé que si le compte a droit au module
correspondant. Le cloisonnement est fait **avant la requête**, pas par filtrage du
résultat : la donnée interdite ne transite plus du tout.

**Pourquoi `requireModuleAccess` ne suffisait pas.** Ce middleware garde *une* clé de
module par routeur. Cette route couvre cinq modules à la fois. J'ai donc extrait la
règle dans `lib/access.ts`, dont `requireModuleAccess` dépend désormais aussi — deux
implémentations séparées auraient fini par diverger, et c'est exactement ainsi que la
faille est née.

**VÉRIFIÉ** — 8 tests, dont un qui compte les appels à la base pour établir que les
tables interdites ne sont pas même interrogées.

---

### 2.2 P0-SEC-02 — `/api/audit` exposait `before`/`after` à tout compte

**Constat — OBSERVÉ DANS LE CODE puis VÉRIFIÉ.** `requireAuth` seul, et la réponse
inclut l'état complet de l'entité avant et après modification. Un compte LECTEUR
lisait les montants et statuts contractuels des marchés.

**Décision de politique, et sa justification.** Trois options étaient possibles.

| Option | Écartée / retenue |
|---|---|
| Réserver à ADMIN | **Écartée.** La route alimente l'historique affiché dans les fiches — `AuditHistoryModal` et `geoportail/DetailPanel`. La réserver à ADMIN aurait cassé la consultation de l'historique pour GESTIONNAIRE, INSPECTEUR et LECTEUR sur des entités auxquelles ils ont déjà droit. |
| Masquer `before`/`after` selon le rôle | **Écartée.** Une fois l'accès cloisonné par module, ces champs n'ajoutent aucune fuite : ils ne contiennent que les champs de l'entité, que l'appelant peut déjà lire via l'API du module. Masquer aurait dégradé la fonctionnalité sans gain. |
| Aligner sur le module de l'entité consultée | **Retenue.** Cohérent avec le modèle existant, préserve la fonctionnalité, ferme la fuite. |

**Traitement des cas hors module.** `User` et `AppSetting` ne relèvent d'aucun module
configurable — `lib/modules.ts` indique explicitement que « utilisateurs » et
« administration » restent réservés au rôle ADMIN. Leur journal l'est donc aussi. Un
`entityType` **inconnu de la table est refusé** : on échoue fermé, pour qu'un nouveau
type journalisé ne soit pas exposé par oubli.

**VÉRIFIÉ** — 12 tests couvrant ADMIN, GESTIONNAIRE, INSPECTEUR et LECTEUR.

---

### 2.3 P0-SEC-03 — Les routes Marchés en lecture n'étaient pas cloisonnées

**Cette vulnérabilité n'apparaissait pas dans le premier audit. C'est une erreur de
ma part, et voici laquelle.**

Au premier tour, j'ai déterminé quelles routes étaient gardées en cherchant la
présence de `requireModuleAccess` **fichier par fichier**. `marches.routes.ts` la
mentionne dix fois : le fichier a donc passé mon contrôle. J'ai écrit dans
`AUDIT-BDRI-2026.md` que « les seize autres routes sont correctement gardées ».
**C'était faux.**

Le contrôle au niveau du fichier ne dit rien du niveau de la route. En comptant cette
fois route par route, `marches.routes.ts` montre 25 routes pour 10 gardes.

**Constat — OBSERVÉ DANS LE CODE.** Le partage est net et révélateur : **les neuf
routes d'écriture portent toutes `requireModuleAccess("marches")`, les treize routes
de lecture n'en avaient aucune.** L'auteur a protégé l'écriture et oublié la lecture.

Étaient donc lisibles par **tout compte authentifié**, LECTEUR restreint aux tronçons
compris — et le routeur est monté sur `/api`, pas `/api/marches` :

| Route | Donnée exposée |
|---|---|
| `GET /api/marches` | Liste complète des marchés |
| `GET /api/marches/:id` | Montant, devise, statut d'un marché |
| `GET /api/marches/:id/decomptes` | Décomptes |
| `GET /api/marches/:id/avancement` · `/courbe-s` | Avancement financier |
| `GET /api/marches/alertes` | Marchés en alerte |
| `GET /api/bailleurs` | Bailleurs |
| `GET /api/decaissements/par-bailleur` | **Décaissements par bailleur** |
| `GET /api/priorisation/scores` | Scores de priorisation |
| `POST /api/simulateur/budget` | Simulateur budgétaire |

S'y ajoutaient trois routes d'écriture sur les bailleurs, gardées par rôle mais pas
par module : un GESTIONNAIRE sans le module Marchés pouvait créer ou modifier un
bailleur.

**Portée réelle.** Plus large que P0-SEC-01 et P0-SEC-02 réunies. Les deux premières
fuyaient des identifiants, des libellés et l'historique d'entités ciblées ; celle-ci
livrait **l'intégralité du volet contractuel et financier** à n'importe quel compte.

**Correction.** Les treize routes reçoivent une garde de module. Deux d'entre elles ne
relèvent pas de Marchés et sont rattachées au module qui leur correspond, comme le
fait déjà `dashboard.routes.ts` :

- `/priorisation/scores` → module `decision`
- `/simulateur/budget` → module `programmation`

Reste sans garde de module : `POST /marches/alertes/notifier`, gardée par
`requireRole("ADMIN")`. C'est **volontaire et sans effet** — un ADMIN n'est jamais
restreint par les modules.

**VÉRIFIÉ** — 8 tests.

**Correction apportée au premier audit.** La phrase « les seize autres routes sont
correctement gardées » de `AUDIT-BDRI-2026.md` est erronée. Elle n'a pas été effacée :
un renvoi vers le présent document y a été ajouté.

---

## 3. Routes API auditées

Les 18 fichiers de routes, route par route et non fichier par fichier.

| Module | Routes | Auth | Rôle | Module | Risque résiduel |
|---|---|---|---|---|---|
| `auth` | 8 | Partiel (login/refresh publics) | — | — | Aucun — limite de débit sur login et 2FA |
| `public` | 1 | **Aucune, par conception** | — | — | Aucun — champs réduits, 60 req/min |
| `regions` | 1 | requireAuth | — | — | **Faible** — 8 noms de régions, aucune donnée sensible |
| `search` | 1 | requireAuth | — | **Corrigé** | Aucun |
| `audit` | 1 | requireAuth | ADMIN si `User`/`AppSetting` | **Corrigé** (par entité) | Aucun |
| `photos` | 1 | requireAuth | — | — | **Faible** — voir §3.1 |
| `documents` | 5 | requireAuth | ADMIN, GESTIONNAIRE | `documents` | Aucun |
| `troncons` | 11 | router-level | ADMIN, GESTIONNAIRE | `troncons` | Aucun |
| `ouvrages` | 11 | router-level | ADMIN, GESTIONNAIRE | `ouvrages` | Aucun |
| `points-noirs` | 9 | router-level | ADMIN, GESTIONNAIRE | `points-noirs` | Aucun |
| `postes` | 9 | router-level | ADMIN, GESTIONNAIRE | `postes` | Aucun |
| `chantiers` | 9 | router-level | ADMIN, GESTIONNAIRE | `chantiers` | Aucun |
| `inspections` | 7 | router-level | ADMIN, GESTIONNAIRE | `inspections` | Aucun |
| `ordres-travaux` | 12 | **router.use** | ADMIN, GEST., INSPECTEUR | `ordres-travaux` | Aucun — garde au niveau routeur, aucune route ne peut échapper |
| `dashboard` | 8 | Par route | — | **8/8**, clé adaptée à chacune | Aucun — le module le plus rigoureux du dépôt |
| `marches` | 25 | Par route | ADMIN, GESTIONNAIRE | **Corrigé — 13 routes ajoutées** | Aucun |
| `users` | 5 | router-level | **ADMIN** | — | Aucun |
| `admin` | 3 | router-level | **ADMIN** | — | Aucun |

**Enseignement d'architecture.** Les modules qui posent la garde au **niveau du
routeur** (`router.use(requireAuth, requireModuleAccess(...))`) n'ont présenté aucun
défaut. Les trois failles se trouvent toutes dans des modules où la garde est posée
**route par route** — où il suffit d'un oubli. `ordres-travaux` montre la bonne
pratique.

### 3.1 Route `photos` — risque résiduel documenté

**OBSERVÉ DANS LE CODE.** `GET /api/photos/:filename` n'applique que `requireAuth` :
aucun contrôle du module ni de l'entité propriétaire.

Trois éléments **atténuent** ce risque sans l'annuler :

1. Les noms de fichiers sont des `crypto.randomUUID()` — 122 bits d'entropie,
   l'énumération est irréaliste.
2. La traversée de répertoire est bloquée : `photoAbsolutePath` applique
   `path.basename()`. **VÉRIFIÉ par lecture du code.**
3. Il faut donc déjà connaître un nom de fichier pour l'exploiter.

Reste qu'un compte ayant perdu l'accès à un module conserve l'accès aux photos dont il
connaît le nom. Classé **P2** : la correction demande de remonter à l'entité
propriétaire, ce qui n'est pas trivial (`photos String[]` sur `Ouvrage` et
`Inspection`).

---

## 4. Tests ajoutés

**VÉRIFIÉ** — exécution complète : **40 tests, 6 fichiers, tous au vert.**
`tsc` sans erreur.

| Fichier | Tests | Couvre |
|---|---|---|
| `search.routes.test.ts` | 8 | P0-SEC-01 |
| `audit.routes.test.ts` | 12 | P0-SEC-02, 4 rôles |
| `marches.routes.test.ts` | 8 | P0-SEC-03 |
| *(existants)* | 12 | mots de passe, fabrique CRUD, service utilisateurs |

**Les tests ont été éprouvés contre le code vulnérable.** Après restauration
temporaire des versions d'origine de `search.routes.ts` et `audit.routes.ts` :

```
Test Files  2 failed (2)
     Tests  10 failed | 10 passed (20)
```

L'échec le plus parlant montrait exactement la fuite :

```
  Array [
    "chantier",
+   "ouvrage",
+   "pointNoir",
+   "poste",
    "troncon",
  ]
```

Un test qui n'échoue jamais ne prouve rien. Ces dix-là échouent.

**Choix de méthode.** Les tests passent par la vraie chaîne HTTP — Express,
`requireAuth`, le routeur — via supertest. Seules la vérification cryptographique du
jeton et la base sont simulées. Appeler le gestionnaire directement aurait contourné
les middlewares, c'est-à-dire précisément l'endroit où le contrôle se joue.

**Un piège évité.** Ma première version utilisait `await import()` au niveau racine.
Vitest l'accepte, `tsc` non — et c'est `npm run build` qui tourne dans le Dockerfile.
Les tests passaient au vert **tout en cassant la construction de l'image**. Détecté en
compilant avant de committer.

---

## 5. Stockage des fichiers

**Configuration — OBSERVÉ DANS LE CODE et validée syntaxiquement.**

- Volume `bdri_uploads` déclaré, monté sur `/app/uploads` du service backend.
- `WORKDIR /app` dans le Dockerfile ; `UPLOAD_DIR = process.cwd()/uploads/documents`
  et `.../uploads/photos`. Le montage couvre donc les deux. **VÉRIFIÉ par lecture.**
- YAML validé localement : montage et déclaration corrects.

**NON VÉRIFIÉ — et ce sont les points décisifs :**

| À vérifier | Comment |
|---|---|
| Propriété et permissions dans le conteneur | L'image tourne-t-elle en root ou en `node` ? Un volume vide est créé root ; si le processus n'est pas root, l'écriture échouera |
| Écriture, lecture, suppression réelles | Téléverser un document, le relire, le supprimer |
| Persistance après recréation | Téléverser → `docker compose up -d --force-recreate backend` → le fichier est-il toujours là |
| Comportement au premier montage | Docker copie le contenu de l'image dans un volume vide au premier montage ; ici le dossier est vide, donc sans effet — mais à confirmer |

**Le test de persistance ne peut pas être fait hors production**, faute
d'environnement de recette. Il doit être exécuté **immédiatement après le
déploiement**, avec un fichier jetable, avant toute utilisation réelle.

### Stratégie de sauvegarde

**AUCUNE SAUVEGARDE N'EXISTE AUJOURD'HUI, ni pour les fichiers ni pour la base.**
Je ne l'ai pas constaté par accès au serveur de sauvegarde — je n'en ai trouvé
**aucune trace** : ni tâche planifiée, ni script, ni service, ni documentation.
**NON VÉRIFIÉ au sens strict, mais aucun élément ne suggère le contraire.**

**Un volume Docker n'est pas une sauvegarde.** Il protège d'une recréation de
conteneur. Il ne protège ni d'une suppression accidentelle du volume, ni d'une panne
disque, ni d'un chiffrement par rançongiciel, ni d'une erreur applicative.

**RECOMMANDÉ** — à arbitrer par AGEROUTE :

| Point | Proposition |
|---|---|
| Emplacement | Volume Docker `bdri_uploads` + copie hors machine |
| Fréquence | Quotidienne pour la base, quotidienne pour les fichiers |
| Rétention | 7 quotidiennes, 4 hebdomadaires, 12 mensuelles |
| Chiffrement | Requis si la copie sort du réseau AGEROUTE |
| Restauration | À tester **une fois par trimestre** — une sauvegarde jamais restaurée n'est pas une sauvegarde |
| Responsable | À désigner |

---

## 6. Compression

**Mesure d'origine — VÉRIFIÉE le 01/09/2026 en production :**

| Ressource | Sans `Accept-Encoding` | Avec `gzip, br` | `Content-Encoding` |
|---|---|---|---|
| `/api/public/carte/geo` | 2 825 507 o | 2 825 507 o | absent |
| `/assets/index-*.js` | 152 262 o | 152 262 o | absent |

**Correction — OBSERVÉE DANS LE CODE, NON VÉRIFIÉE en exécution :**

- `compression()` monté sur Express **avant toute route**, donc couvrant aussi les
  réponses d'erreur.
- `gzip on` dans Nginx avec `gzip_proxied any` — nécessaire car les réponses passent
  par Traefik, dont les en-têtes de proxy feraient sinon renoncer Nginx à compresser.
- `gzip_types` couvre `application/json`, `application/geo+json`, JS, CSS et SVG.
- `gzip_min_length 1024` : les petites réponses ne sont pas compressées inutilement.

**Double compression.** Le risque existe si Nginx et Express compressaient la même
réponse. **Il n'y a pas lieu ici** : Nginx sert les fichiers statiques, Express sert
`/api`, et le `location /api/` de Nginx est un `proxy_pass` — Nginx ne recompresse pas
une réponse déjà porteuse d'un `Content-Encoding`. **OBSERVÉ DANS LE CODE, à
confirmer par mesure.**

**Ce que je n'ai pas pu faire.** Il n'existe pas d'environnement de recette. Je n'ai
donc pas mesuré l'effet réel. **À exécuter après déploiement :**

```bash
curl -s -o /dev/null -H "Accept-Encoding: gzip" \
  -w "%{size_download} o — encodage: %{content_type}\n" \
  https://carte.ageroute.gov.gn/api/public/carte/geo
curl -sD - -o /dev/null -H "Accept-Encoding: gzip" \
  https://carte.ageroute.gov.gn/api/public/carte/geo | grep -i content-encoding
```

**Attendu** : `Content-Encoding: gzip` et une taille sous 500 Ko. Si la taille reste
à 2,8 Mo, la compression n'est pas active — le correctif aura échoué et devra être
repris, sans que rien d'autre ne soit cassé.

---

## 7. PostGIS

**Constat — VÉRIFIÉ par lecture des 16 migrations.** Aucun index GIST.

**Colonnes concernées — OBSERVÉES DANS `schema.prisma` :**

| Table | Colonne | Type |
|---|---|---|
| `troncons` | `geom` | `geometry(LineString,4326)` |
| `ouvrages` | `geom` | `geometry(Point,4326)` |
| `points_noirs` | `geom` | `geometry(Point,4326)` |
| `postes` | `geom` | `geometry(Point,4326)` |
| `chantiers` | `geom` | `geometry(LineString,4326)` |

**Requêtes spatiales existantes — OBSERVÉES.** Une seule, dans `troncons.service.ts` :
`ST_DWithin(t.geom::geography, ligne::geography, 20000)` sur l'ensemble des tronçons.

**AUCUNE MIGRATION N'A ÉTÉ CRÉÉE.** C'est délibéré, et conforme à ta consigne : « ne
crée pas des index aveuglément ». Créer un index GIST sur une table dont j'ignore la
volumétrie et sans plan d'exécution de référence serait un geste non mesuré.

**Ce qu'il faut mesurer d'abord** — cf. §8, demande d'accès :

1. Nombre de lignes et lignes à géométrie non nulle, par table.
2. `EXPLAIN (ANALYZE, BUFFERS)` sur la requête `ST_DWithin` existante — état actuel.
3. Taille des tables et des géométries (`pg_total_relation_size`, `ST_NPoints`).
4. Extensions installées (`postgis`, et `pgrouting` le cas échéant).

**RECOMMANDÉ pour la migration**, une fois ces mesures prises :
`CREATE INDEX CONCURRENTLY` pour éviter tout verrou en production. Attention : cette
forme **ne peut pas s'exécuter dans une transaction**, ce que Prisma applique par
défaut — la migration devra être marquée en conséquence, sans quoi elle échouera.

---

## 8. Demande d'accès à la base — lecture seule

**Ce qui est demandé** : un rôle PostgreSQL **en lecture seule** sur `console_bdri`.
Aucune écriture, aucune suppression, aucune modification de schéma.

```sql
CREATE ROLE bdri_audit LOGIN PASSWORD '<défini par AGEROUTE>';
GRANT CONNECT ON DATABASE console_bdri TO bdri_audit;
GRANT USAGE ON SCHEMA public TO bdri_audit;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO bdri_audit;
```

**Requêtes qui seront exécutées** — toutes en lecture :

| Objectif | Requête |
|---|---|
| Volumétrie | `SELECT count(*), count(geom) FROM troncons;` *(idem 4 autres tables)* |
| Plans avant index | `EXPLAIN (ANALYZE, BUFFERS) SELECT ... ST_DWithin ...` |
| Taille | `SELECT pg_size_pretty(pg_total_relation_size('troncons'));` |
| Extensions | `SELECT extname, extversion FROM pg_extension;` |
| Qualité géométrique | `SELECT count(*) FROM troncons WHERE NOT ST_IsValid(geom);` |
| Champs vides | `SELECT count(*) FROM troncons WHERE prefecture IS NULL;` |
| Données d'aide à la décision | `SELECT count("traficMoyenJma"), count("coutRehabEstime") FROM troncons;` |
| Index existants | `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public';` |

La dernière ligne conditionne le §22 de la mission : un score de priorité n'a de sens
que si le trafic et le coût sont renseignés. **Je ne le sais pas aujourd'hui.**

---

## 9. Données administratives

**Constat — VÉRIFIÉ par lecture.** `prefecture` et `commune` existent au schéma,
ajoutées par `20260701150000_troncon_draw_fields`. Seule `troncons.schema.ts` les
mentionne, pour la validation. **Aucun code ne les écrit.**

**Aucune donnée n'a été remplie.** Ta consigne est explicite et je m'y tiens : ne rien
inventer.

**Sources à obtenir — RECOMMANDÉ**, par ordre de fiabilité :

| Source | Nature | Remarque |
|---|---|---|
| Institut National de la Statistique (Guinée) | Découpage administratif officiel | Référence de droit ; à demander formellement |
| Direction Nationale de la Cartographie | Limites géographiques | Complète l'INS par les géométries |
| OpenStreetMap / GADM / geoBoundaries | Limites administratives ouvertes | Immédiatement disponibles, **non officielles** — utilisables pour préparer, pas pour faire foi |

**Méthode de rattachement — RECOMMANDÉE.** Une fois les limites en base :
`ST_Intersects` entre chaque tronçon et les polygones administratifs, ce qui **exige
les index GIST du §7**. Un tronçon traversant plusieurs préfectures doit être rattaché
à **toutes**, via une table de liaison — écraser dans une colonne unique perdrait de
l'information.

**Traçabilité — RECOMMANDÉE.** Chaque rattachement automatique doit porter sa source,
sa date et son statut de validation. Un rattachement calculé n'est pas un
rattachement validé, et la distinction doit rester lisible.

**Sans cela, « Kankan–Kissidougou » reste impossible.** C'est un chantier de données,
pas de code.

---

## 10. Itinéraire

**Constat — VÉRIFIÉ par lecture du SQL.** `ST_MakeLine` entre deux centroïdes,
`ST_Distance` en geography. C'est une **distance à vol d'oiseau**, présentée à
l'utilisateur sous le nom « itinéraire ».

**Aucune modification apportée**, conformément à ta consigne.

**Comparaison — RECOMMANDÉE, aucune option retenue à ce stade :**

| Solution | Précision | Coût | Performance | Maintenance | Dépendance | Compatibilité BDRI |
|---|---|---|---|---|---|---|
| **pgRouting** | Bonne sur le réseau BDRI | Nul (extension libre) | Bonne si topologie indexée | Moyenne — topologie à construire et entretenir | Aucune : reste dans PostGIS | **Excellente** — travaille sur les géométries existantes |
| **OSRM** | Excellente sur données OSM | Nul, mais serveur à héberger | Très bonne | Élevée — service séparé, données à rafraîchir | Service supplémentaire | Faible — route sur OSM, **pas sur le réseau BDRI** |
| **GraphHopper** | Excellente | Libre ou payant selon l'usage | Très bonne | Élevée | Service séparé, ou API tierce | Faible — même limite qu'OSRM |
| **Renommer** | Sans objet | Nul | Sans objet | Nulle | Aucune | Immédiate |

**Le point qui tranche.** OSRM et GraphHopper routent sur OpenStreetMap. La BDRI est
le **référentiel du patrimoine d'AGEROUTE** : un itinéraire calculé sur OSM ne
refléterait ni l'état des chaussées, ni les tronçons, ni les chantiers de la BDRI. Il
donnerait un trajet, pas une information patrimoniale — et créerait deux vérités
concurrentes sur le même réseau.

**RECOMMANDÉ, en deux temps :**

1. **Immédiat, sans risque** — renommer honnêtement dans l'interface (« distance à vol
   d'oiseau »). Ce qui est affiché aujourd'hui est trompeur.
2. **À terme** — pgRouting sur une topologie construite à partir des tronçons BDRI.
   Prérequis : géométries valides et connectées, ce que le §7 doit d'abord mesurer.
   Un réseau dont les tronçons ne se touchent pas ne se route pas.

---

## 11. Couverture de tests

| | Avant | Après |
|---|---|---|
| Fichiers | 3 | **6** |
| Tests | 12 | **40** |
| Routes couvertes | 0 | 3 modules |
| Permissions couvertes | 0 | 4 rôles × modules |
| Frontend | 0 | **0 — inchangé** |

**Ce qui reste sans aucun test — NON COUVERT :**

- Téléversements — le module qui vient d'être modifié
- Couche spatiale
- Imports Excel — récemment migrés de `xlsx` vers `exceljs`
- Authentification de bout en bout, TOTP, rotation des jetons
- Frontend, entièrement
- Bout en bout

**RECOMMANDÉ**, dans cet ordre : téléversements (module modifié), imports Excel
(dépendance récemment changée), authentification, spatial, frontend, E2E.

---

## 12. Risques restants

| Risque | Gravité | Statut |
|---|---|---|
| Aucune sauvegarde, ni base ni fichiers | **Élevée** | Non traité — hors de mon périmètre technique |
| Aucune vérification réelle de la persistance des fichiers | **Élevée** | Testable seulement après déploiement |
| Compression non mesurée en exécution | Moyenne | Mesurable après déploiement |
| Aucun index spatial | Moyenne | Mesures préalables requises |
| Route `photos` sans cloisonnement | Faible | Documenté, atténué par UUID |
| Route `regions` sans cloisonnement | Très faible | Accepté — 8 noms de régions |
| Frontend sans en-tête de sécurité | Moyenne | Ticket P1-3, non traité — risque de casser SharePoint |
| Aucun test frontend | Moyenne | Non traité |
| Anomalies de données (0 km, `RN2` en `RR`) | Faible | Documenté |
| Volume F: en panne sur le poste de développement | Faible | Contourné — compilation depuis E: |

---

## 13. Recommandations

1. **Autoriser le déploiement des correctifs de sécurité en premier**, séparément du
   reste. Ils sont testés, sans effet fonctionnel pour les comptes légitimes.
2. **Immédiatement après le déploiement du volume**, exécuter le test de persistance
   avec un fichier jetable. Ne pas attendre un vrai document.
3. **Traiter la sauvegarde comme un sujet à part entière.** C'est le risque le plus
   élevé du dossier, et il n'est pas d'ordre technique mais organisationnel.
4. **Généraliser la garde au niveau du routeur.** Les trois failles viennent toutes de
   modules gardés route par route. `ordres-travaux` montre la forme à suivre.
5. **Obtenir l'accès en lecture seule** avant d'aller plus loin sur PostGIS, l'aide à
   la décision et la qualité des données.
6. **Ne pas lancer le référentiel administratif** avant d'avoir la source officielle.

---

## 14. Plan de déploiement

**Rien de tout ceci n'a été exécuté.** En attente d'autorisation explicite.

### Découpage en trois lots

Trois lots plutôt qu'un seul, pour que chacun soit vérifiable isolément et qu'un
retour arrière n'annule pas ce qui fonctionne.

**Lot 1 — Sécurité** *(risque : faible)*
Les trois correctifs de contrôle d'accès et leurs tests.
Rien d'autre. Aucun changement d'infrastructure.

**Lot 2 — Persistance et compression** *(risque : moyen)*
Volume `bdri_uploads`, compression Express et Nginx, cache des assets.
Touche l'infrastructure : un redémarrage du backend, une image frontend reconstruite.

**Lot 3 — Index spatiaux** *(risque : à établir)*
**Non préparé.** Conditionné aux mesures du §7.

### Déroulé pour les lots 1 et 2

| # | Étape | Vérification |
|---|---|---|
| 1 | Étiqueter les images en service `:rollback-<commit>` | `docker images` les liste |
| 2 | Sauvegarder la source déployée et `backend/.env` | Archives présentes dans `~` |
| 3 | **Sauvegarder la base** — `pg_dump` hors du conteneur | Fichier présent, taille non nulle |
| 4 | Exporter le commit (`git archive`), transférer, comparer les empreintes | md5 identiques |
| 5 | Synchroniser vers `/opt/console-bdri` en excluant `.env` | `.env` intact, horodatage inchangé |
| 6 | `docker compose build` | Sortie « Built », `tsc` passé dans l'image |
| 7 | `docker compose up -d` | Conteneurs démarrés, base intacte |
| 8 | Vérifier la compression | `Content-Encoding: gzip`, taille < 500 Ko |
| 9 | Vérifier la persistance des fichiers | Téléverser → `--force-recreate` → relire |
| 10 | Vérifier les droits | Un compte restreint reçoit 403 sur `/api/marches` |
| 11 | Vérifier la carte publique | Se charge, données affichées, aucune erreur console |

**L'étape 3 n'est pas facultative.** Aucune sauvegarde n'existe aujourd'hui ; les lots
1 et 2 ne touchent pas au schéma, mais déployer sans point de restauration sur une
base de production reste indéfendable.

---

## 15. Plan de retour arrière

**Lot 1 et Lot 2 — retour en une commande.** Les images précédentes sont étiquetées ;
aucune migration n'est appliquée, donc **la base n'a pas à être restaurée**.

```bash
ssh gec "docker tag console-bdri-backend:rollback-432b593 console-bdri-backend:latest \
  && docker tag console-bdri-frontend:rollback-432b593 console-bdri-frontend:latest \
  && cd /opt/console-bdri && docker compose up -d"
```

**Un point de vigilance sur le volume.** Le retour arrière des images ne démonte pas
`bdri_uploads`. Un conteneur revenu à l'ancienne image continuera d'écrire dans le
volume — ce qui est **sans danger** : l'ancienne version écrit au même chemin
`/app/uploads`, et les fichiers y survivront. Il n'y a donc rien à défaire.

**Critères déclenchant le retour arrière** — à décider sans délibération :

- La carte publique ne se charge plus, ou l'API publique ne répond plus.
- Un compte légitime se voit refuser un module auquel il a droit.
- Le backend ne démarre pas, ou redémarre en boucle.
- Un téléversement échoue avec une erreur de permission sur le volume.

**Lot 3** — non planifié. Un index créé se supprime par `DROP INDEX`, mais la
procédure sera écrite avec la migration, pas avant.

---

## 16. Tableau de décision

| Élément | État | Testé | Production | Action |
|---|---|---|---|---|
| `/api/search` | **Corrigé** | Oui — 8 tests, échec vérifié sur code vulnérable | **NON** | Lot 1 |
| `/api/audit` | **Corrigé** | Oui — 12 tests, 4 rôles | **NON** | Lot 1 |
| `/api/marches` *(non vu au 1er tour)* | **Corrigé** — 13 routes | Oui — 8 tests | **NON** | Lot 1 |
| Routes API | **18/18 auditées route par route** | Sans objet | **NON** | 2 risques résiduels documentés |
| Upload persistant | Configuré, YAML validé | **Non — impossible hors production** | **NON** | Lot 2, puis test immédiat |
| Compression | Codée, non mesurée | **Non — pas d'environnement de recette** | **NON** | Lot 2, puis mesure |
| Index GIST | **Non préparé — délibérément** | Non | **NON** | Mesurer d'abord (§7, §8) |
| Données administratives | **Non touchées** | Sans objet | **NON** | Obtenir la source officielle |
| Routage | **Non modifié** | Sans objet | **NON** | Renommer, puis étudier pgRouting |
| Tests | 12 → **40**, tous au vert | Oui | **NON** | Étendre : uploads, Excel, frontend |
| Sauvegardes | **Aucune trouvée** | Sans objet | **NON** | À arbitrer par AGEROUTE |

---

## 17. Conditions de déploiement — état

| Condition posée | État |
|---|---|
| Corriger les deux vulnérabilités critiques | **Fait — trois, la troisième découverte au second tour** |
| Ajouter les tests de permissions | **Fait — 28 tests, échec vérifié contre le code vulnérable** |
| Auditer les autres routes API | **Fait — 18 fichiers, route par route** |
| Vérifier la configuration des uploads | **Partiel** — configuration validée, persistance non testable hors production |
| Vérifier la compression | **Partiel** — code en place, mesure impossible sans recette |
| Préparer les migrations spatiales | **Non — délibérément.** Mesures requises d'abord |
| Exécuter les tests | **Fait — 40 au vert, `tsc` propre** |
| Vérifier l'absence de régression | **Partiel** — tests et compilation au vert ; aucun test frontend n'existe |
| Préparer un rollback | **Fait — §15** |

**Deux conditions ne sont pas pleinement remplies**, et aucune ne peut l'être sans un
environnement de recette ou un accès base. Elles sont signalées plutôt que présentées
comme acquises.

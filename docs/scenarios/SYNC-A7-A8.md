# A7 et A8 : file locale d'observations, signalement et arbitrage des conflits

Établi le 23/10/2026 sur la base du commit `f35aff7` (branche `lot/03-map-matching`). Complète
`SCENARIOS-PARTIELS.md` §3.3 (A7) et §3.4 (A8), qui laissaient deux réserves écrites :

- **A7** : « il n'existe pas de file locale pour le type Observation » ;
- **A8** : « aucun écran ne signale ni ne tranche un conflit ».

> **Aucune des preuves ci-dessous n'est une preuve sur appareil.** La file est éprouvée contre un serveur
> **simulé** écrit dans le test, avec un magasin local en `Map` (ou une imitation minimale d'IndexedDB pour la
> migration). Le serveur réel est éprouvé contre PostGIS, mais l'écran, lui, ne l'est que sous jsdom. Voir §5.

## 1. Livré

### Côté téléphone (A7 et signalement de A8)

| Élément | Fichier |
|---|---|
| Magasin IndexedDB `pending_observations`, **migration additive v3 vers v4** (aucun magasin existant recréé) | `frontend/src/lib/offlineDb.ts` |
| Synchronisation des observations (`syncOneObservation`), compteurs `conflitCount` et `abandonCount`, `relancerObservation` | `frontend/src/lib/offlineSync.ts` |
| Construction et validation d'une saisie (miroir du schéma serveur strict), identifiant UUID | `frontend/src/lib/observationsTerrain.ts` |
| Écran « Observations terrain » (`/inspections/terrain/observations`) : saisie, liste de la file avec statut et motif, alerte de conflit | `frontend/src/pages/ObservationsTerrainPage.tsx` |
| Badge d'en-tête : « dont N en conflit » | `frontend/src/components/layout/SyncStatusBadge.tsx` |

Règles de la file d'observations (les mêmes que celles des portions et des défauts) :

- **Clé d'idempotence stable** : `localId` (UUID généré une fois à la saisie) sert d'`operationId` **et**
  d'`entityId`. Il ne change jamais d'une tentative à l'autre.
- **Une observation ne quitte la file que sur `SYNCHRONISE` ou `REJOUEE`.** Refus, conflit, erreur HTTP, réseau muet,
  échec du retrait local : elle reste.
- **Refus définitif ou temporaire : c'est le serveur qui le dit.** `REJETE` sans `reessayerDansMs` : statut
  `abandonnee`, `refusDefinitif`, motif conservé, **visible** ; plus retentée seule. Avec `reessayerDansMs` : `error`,
  réessai, plafond de 5 échecs **consécutifs**.
- **Un réseau muet ne compte pas** dans le plafond (même règle que `estErreurReseau` pour les portions).
- **Compteur** : `pendingCount` (tout ce que la file porte pour le compte), dont `conflitCount` et `abandonCount`.
- **Aucun champ de protocole inventé** : le payload est exactement celui du schéma `creationObservation`
  (`backend/src/field/observation-sync-payload.ts`) ; un test lit ce fichier et échoue si les listes de `type` et de
  `gravite` ou les noms de champs divergent.

Signalement d'un conflit (A8, côté téléphone) :

- Le serveur rend `CONFLIT` : la saisie **reste en file**, statut `conflit`, avec `conflitId` et `motifConflit`. Elle
  n'est **pas** comptée comme un échec, et elle est **renvoyée à chaque synchronisation** (le serveur rend le même
  conflit, jamais un second) : c'est ainsi que l'appareil apprend la décision.
- Un reseau qui coupe pendant ce renvoi ne fait **pas** redevenir `error` une saisie en conflit.
- Quand un responsable retient la version du serveur, le renvoi rend `REJETE / CONFLIT_RESOLU_VERSION_SERVEUR` : la
  saisie passe `abandonnee` avec ce motif, et reste visible.
- Même traitement pour les **défauts** (modification localisée de `syncOneDefaut`) : avant, un `CONFLIT` de défaut
  était traité comme une erreur ordinaire, retentée cinq fois puis abandonnée.
- L'écran affiche en haut de page, en `role="alert"` : « N saisie(s) en conflit de synchronisation. Le serveur porte
  déjà une version différente : un responsable doit trancher. Vos saisies sont conservées sur ce téléphone, réessayer
  n'y change rien. »

### Côté responsable (A8, arbitrage)

| Élément | Fichier |
|---|---|
| `GET /api/v2/sync/conflits` : conflits **ouverts**, deux versions, agent, appareil, ce que l'arbitrage permet ; réservé ADMIN et GESTIONNAIRE, limité au périmètre territorial | `backend/src/api-v2/sync.routes.ts` |
| `POST /api/v2/sync/conflits/:id/verification` : demande de vérification, **ne tranche pas** | idem |
| Règles « LOCAL possible ? » | `backend/src/field/conflits.ts` |
| Migration `20261026100000_conflit_sync_verification` (3 colonnes nulles et une contrainte), **descente** avec garde | `backend/prisma/migrations/...`, `backend/prisma/descentes/...` |
| Page « Conflits de synchronisation » (`/inspections/conflits`, menu ADMIN et GESTIONNAIRE) | `frontend/src/pages/ConflitsSyncPage.tsx`, `frontend/src/lib/conflitsSync.ts` |

L'arbitrage passe par la **route existante** `POST /api/v2/sync/resolve` (`SERVEUR` ou `LOCAL`), inchangée. Deux routes
ont été ajoutées, car aucune route ne listait les conflits ni ne permettait de dire « je ne sais pas encore » :

- la liste est une **lecture** ; elle rend `payloadLocal` (ce que le téléphone a envoyé, tel quel) et `payloadServeur`
  (ce que le serveur portait au moment du conflit) ;
- la demande de vérification pose `verificationDemandeeA`, `verificationDemandeeParId`, `verificationMotif`,
  **sans toucher `resolution`** : le conflit reste ouvert, les deux versions restent conservées, l'opération du
  téléphone reste en `CONFLIT`. Une seule demande par conflit (revendication atomique, 409 sinon). **Auditée**
  (`audit_logs`, `ConflitSync`, motif). Zod strict (une clé inconnue est refusée), `requireAuth`, `requireModuleAccess`.
- **Rien n'est supprimé physiquement** : trancher en `SERVEUR` laisse la version du téléphone dans le conflit ; trancher
  en `LOCAL` une suppression est une suppression **logique** (`deletedAt`).

Ce que l'écran dit **avant** le clic : « retenir la version du téléphone » est **désactivé, avec la raison**, pour une
création et pour un défaut (la route répond 409 `NOUVEL_IDENTIFIANT_REQUIS` dans ces cas). Toute décision
se **confirme** (aucune requête avant la confirmation) ; la demande de vérification exige un motif.

## 2. Preuves

Commandes lancées dans le worktree, depuis `backend/` puis `frontend/`.

| Commande | Résultat |
|---|---|
| `cd backend && npx tsc --noEmit -p .` | 0 erreur |
| `cd backend && npx vitest run` | **163 fichiers, 2 565 tests passés** (dont 13 tests des routes de conflits et 6 de `field/conflits.ts`, nouveaux) |
| `cd backend && DATABASE_URL=...replay npx tsx tests-integration/conflits-sync.integration.mts` | **43/43** vérifications (clone jetable `essai_conflits_sync`, migration appliquée au clone, clone supprimé) |
| `cd backend && DATABASE_URL=...replay npx tsx tests-integration/sync.integration.mts` | **67/67** (non-régression du banc existant) |
| `docker exec bdri-dev-db bash .../descentes/verifier.sh --seulement 20261026100000_conflit_sync_verification` | **4 vérifications, 0 échec** : descente = schéma d'avant ; aller-retour identique ; garde refuse avec une demande en base ; garde passe avec dérogation explicite |
| `cd frontend && npx tsc --noEmit` | 0 erreur |
| `cd frontend && npm run lint` | 0 erreur, 5 avertissements `react-hooks/exhaustive-deps` **déjà présents** (aucun dans les fichiers livrés) |
| `cd frontend && npx vitest run` | **60 fichiers, 776 tests passés** ; puis 3 tests de conflit de défaut ajoutés à `offlineSync.test.ts` (26/26 en isolé, `tsc` propre), suite complète non relancée après cet ajout |

Tests frontend ajoutés (76, dont 3 dans `offlineSync.test.ts` pour le conflit de **défaut**) : `offlineSync.observations.test.ts` (19, A7 et A8 côté téléphone),
`observationsTerrain.test.ts` (12, dont 3 gardes d'accord avec le schéma serveur), `offlineDb.migration.test.ts` (4),
`ConflitsSyncPage.test.tsx` (21, dont 3 axe-core), `ObservationsTerrainPage.test.tsx` (13, dont 3 axe-core),
`Sidebar.conflits.test.tsx` (4). **axe-core : 0 violation** sur les deux pages, dans leurs états chargé, vide, erreur,
confirmation ouverte, formulaire de vérification ouvert, file avec conflit et abandon.

### Mesure de la file, étape par étape (A7, serveur simulé)

Sortie du test `offlineSync.observations.test.ts` (consignée par `console.info`) :

```
etape                                                      file      statut                   serveur  doublons
depart : 50 en file                                        file=50   {"pending":50}           serveur= 0 doublons=0
reseau sain, une passe                                     file= 0   {}                       serveur=50 doublons=0
coupure appels 21-25, passe 1                              file= 5   {"error":5}              serveur=45 doublons=0
reprise, passe 2                                           file= 0   {}                       serveur=50 doublons=0
5 reponses perdues, passe 1                                file= 5   {"error":5}              serveur=50 doublons=0
rejeu des 5 (REJOUEE), passe 2                             file= 0   {}                       serveur=50 doublons=0
3 retraits de file en echec, passe 1                       file= 3   {"error":3}              serveur=50 doublons=0
rejeu, passe 2                                             file= 0   {}                       serveur=50 doublons=0
file saisie a l'envers, une passe                          file= 0   {}                       serveur=50 doublons=0
rejeu 1 / 2 / 3 depuis l'instantane                        file= 0   {}                       serveur=50 doublons=0
chaos (coupures, reponses perdues, 500), passes 1 a 6      file=17,7,3,2,1,0  (jamais plus)   serveur=40..50 doublons=0
1 refus definitif parmi 50                                 file= 1   {"abandonnee":1}         serveur=49 doublons=0
30 passes sans reseau                                      file=50   {"error":50}             serveur= 0 doublons=0
le reseau revient                                          file= 0   {}                       serveur=50 doublons=0
1 conflit parmi 5                                          file= 1   {"conflit":1}            serveur= 4 doublons=0
```

Lecture : « 5 réponses perdues » montre le cas qui produit des doublons sans clé d'idempotence : le serveur a écrit
**50** lignes alors que le téléphone n'en croit que 45 remontées ; le rejeu des 5 restantes rend `REJOUEE` et le total
reste **50**. Un réseau muet n'abandonne jamais rien (30 passes sans réseau : 50 saisies toujours en file, statut
`error`, aucune tentative comptée).

## 3. Contre-épreuves (le test doit attraper le défaut)

Trois défauts ont été **introduits volontairement** dans `offlineSync.ts`, un à la fois, pour constater que
`offlineSync.observations.test.ts` devient rouge, puis retirés (le dépôt a été vérifié propre après chaque retrait) :

| Défaut introduit | Effet | Tests rouges |
|---|---|---|
| `CONFLIT` traité comme un succès (l'observation quitte la file) | l'agent croit sa version retenue | **5 sur 19** (tous ceux de la section A8 côté téléphone) |
| refus **définitif** : l'observation est **retirée** au lieu d'être marquée `abandonnee` | perte silencieuse sur refus | **2 sur 19** (refus parmi 50, cle en trop) |
| un réseau muet **compte** dans le plafond de tentatives | 5 retours du réseau abandonnent la file | **2 sur 19** (coupure au milieu, 30 coupures de suite) |

Revenus au vert après retrait de chaque défaut.

**Non fait, faute d'autorisation** : trois contre-épreuves de plus ont été **refusées par le contrôle des permissions de
la session** (modification volontairement destructive ou affaiblissante du code de production) : migration IndexedDB non
additive (`deleteObjectStore`), retrait du filtre territorial de la liste des conflits, demande de vérification qui
poserait `resolution`. Elles **n'ont donc pas été jouées**. Le banc serveur porte à la place des contrôles **appariés**
(le même appel rend 4 conflits au gestionnaire de la région et 0 à celui d'une autre région ; une demande de vérification
laisse `resolution` nulle, et un arbitrage la pose), de sorte qu'une route qui ne rendrait rien ou qui trancherait
échouerait. Ce n'est pas une mutation, et le dire vaut mieux que de l'omettre.

## 4. Défauts trouvés en écrivant les tests

| # | Défaut | Conséquence | Trouvé par | Corrigé |
|---|---|---|---|---|
| 1 | `sync` côté téléphone : un `CONFLIT` de **défaut** était traité comme une erreur ordinaire | retenté cinq fois, puis « abandonné » avec un message d'erreur, sans que l'agent sache qu'un responsable doit trancher | lecture de `syncOneDefaut` pendant la conception | oui (statut `conflit`) |
| 2 | Écran des observations : liste d'erreurs de validation posée sur `<ul role="alert">` | le rôle remplace la sémantique de liste : `<li>` hors liste (axe `listitem`, sérieux) | axe-core | oui (rôle sur un conteneur) |
| 3 | Écran des observations : `required` natif sur le type | le navigateur bloque l'envoi et affiche une bulle propre à chaque navigateur ; la liste d'erreurs de l'écran (et son `role="alert"`) n'apparaissait jamais | test d'écran | oui (`noValidate`, erreurs affichées par l'écran) |

Constaté, **non corrigé** (voir §5) : un rejet territorial est rendu sans `reessayerDansMs` par `/sync/push`.

## 5. Ce qui reste NON vérifié

- **Jamais sur un appareil réel.** IndexedDB réel (Safari iOS, Chrome Android, mode privé, quota), service worker,
  évènement `online` d'un téléphone, perte de réseau réelle, navigateur tué pendant un envoi ou pendant une migration.
  Le magasin local est ici un `Map` ; la migration v3 vers v4 est éprouvée contre une **imitation minimale
  d'IndexedDB écrite dans le test** (`fake-indexeddb` n'est pas installé), pas contre un navigateur.
- **Jamais avec 50 observations réelles.** Les 50 observations sont fabriquées par le test. Aucune saisie réelle d'agent n'a
  été remontée par ce chemin.
- **Le serveur simulé du test client est une copie de règles lues dans `sync.service.ts`**, pas ce code. L'accord entre
  la copie et le serveur réel n'est pas mécanisé (le serveur réel est éprouvé séparément contre PostGIS).
- **Les écrans ne sont éprouvés que sous jsdom** : pas de rendu réel, pas de contraste (axe-core, règle
  `color-contrast` désactivée : jsdom ne le calcule pas), pas d'essai au lecteur d'écran, pas d'essai sur petit écran.
- **Le parcours complet téléphone vers serveur vers écran du responsable n'a jamais été joué d'un seul tenant** : le banc
  serveur (PostGIS) et les tests client (serveur simulé) se rejoignent sur le protocole (`CONFLIT`, `conflitId`,
  `CONFLIT_RESOLU_VERSION_SERVEUR`), pas dans un même test.
- **Le téléphone ne remonte que des CREATE d'observations.** La modification et la suppression hors ligne d'une
  observation existante exigeraient de connaître sa `baseVersion` (une redescente préalable) : non faites. Conséquence :
  un conflit venu de la file d'observations est toujours un conflit de **création** (`DEJA_EXISTANTE`), que le
  responsable ne peut pas trancher en `LOCAL` (la route l'interdit). Les conflits de modification et de suppression
  existent côté serveur (banc) et s'affichent à l'écran, mais aucun téléphone ne les produit aujourd'hui.
- **Pas de suppression locale d'une saisie abandonnée.** L'écran propose « Relancer l'envoi », pas « Supprimer » : une
  saisie de terrain ne se supprime pas en un clic. Conséquence : une saisie définitivement refusée reste dans la liste
  et dans `pendingCount` tant qu'un humain ne décide pas de son sort. À arbitrer.
- **Un rejet territorial (`HORS_PERIMETRE`) est rendu sans `reessayerDansMs`** par `/sync/push`, alors que le commentaire de
  la route dit qu'un réessai peut aboutir si le périmètre change. Le client suit la règle du protocole (absence de
  `reessayerDansMs` = définitif) : la saisie passe `abandonnee`, et l'agent doit la relancer à la main. Incohérence
  serveur à trancher, non corrigée ici.
- **L'écran ne propose ni mission ni tronçon** à la saisie (aucun sélecteur) : il n'envoie que type, gravité,
  description et position. `tronconId` et `missionId` sont acceptés par `construireObservation` mais aucun écran ne les
  renseigne.
- **Le nom de l'auteur d'une demande de vérification n'est pas affiché** (seul le motif et la date le sont).
- **Le cloisonnement territorial de la liste** est éprouvé en base avec deux régions et quatre comptes fabriqués par le
  banc, pas avec les profils réels d'AGEROUTE.

## 6. Statut proposé

- **A7** : **TT pour la file locale et le protocole**, sous la réserve écrite « aucun appareil, aucune observation
  réelle ». La réserve « il n'existe pas de file locale d'observations » est levée.
- **A8** : **TT pour le signalement, l'écran et l'arbitrage**, sous la réserve écrite « jamais joué d'un seul tenant
  téléphone vers écran, jamais sur appareil ; aucun téléphone ne produit encore de conflit de modification ».

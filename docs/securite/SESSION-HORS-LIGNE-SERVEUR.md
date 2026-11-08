# Session hors ligne : ce que le serveur garantit et dit au client (chantier D4)

Date : 25/10/2026. Branche `lot/03-map-matching`. Statut : correctifs écrits et testés **sur le poste de développement uniquement** ; rien n'est déployé, rien n'est commité par l'auteur de ce document. L'état de la production se vérifie au déploiement (`AGENTS.md`).

**Mise à jour du 25/10/2026 (relecture indépendante, chantier D9)** : la course révocation/rotation, la fenêtre résiduelle après révocation, les limites des événements locaux, le plafond des refus de droits tracés, l'oracle d'existence, le délai de la lecture du compte et le comportement de `/revoke` pour un appareil d'autrui sont traités ; le contrat correspondant est dans la section 10, et les sections 2, 3, 5 et 8 sont mises à jour. Rien n'est déployé.

Ce document est la contrepartie serveur de `SESSION-HORS-LIGNE.md` (sections 5, 7 et 8) et le contrat que le client (autre agent) doit lire avant d'être corrigé. Les défauts 7(a) à 7(c) de ce document sont ici **reproduits par test avant correction, puis corrigés**.

## 1. Défauts traités

| Id | Défaut (confirmé par lecture du code) | Reproduit | Corrigé par | Preuve |
|---|---|---|---|---|
| D4-1 | `requireAuth` ne relisait pas la base : le rôle venait du jeton (15 min), `actif` et `lockedUntil` n'étaient pas vérifiés. Un compte désactivé ou rétrogradé gardait ses droits, `sync/push` compris | oui (12 tests sur 14 échouaient ; 6 vérifications du banc échouaient sur le code de `HEAD`) | `middleware/auth.middleware.ts` : une lecture du compte par requête, 401 `COMPTE_INACTIF`, rôle de la base | `securite/compte-courant.test.ts`, banc `session-appareil` section D1 |
| D4-2 | Révoquer un appareil ne coupait pas la session de rafraîchissement du porteur (`Appareil` non lié à `RefreshToken`) | oui (banc : sessions restées actives) | `api-v2/devices.routes.ts` : la révocation coupe **toutes** les familles du **propriétaire** de l'appareil, dans la transaction de la trace `SECURITY_EVENT` | `securite/appareil-revoque.test.ts`, banc D2 |
| D4-3 | `sync/push` rendait le même 403 pour un appareil inconnu et un appareil révoqué ; le client se ré-enregistrait seul | oui | codes `APPAREIL_INCONNU` / `APPAREIL_REVOQUE` ; `POST /devices` accepte l'identifiant d'un appareil déjà connu et refuse un identifiant révoqué | idem, banc D3 |
| D4-4 | Un refus de périmètre au rejeu ne laissait **aucune trace** (« rejetée seule, non enregistrée ») ; le retrait du module donnait un 403 muet pour tout le lot ; rien ne disait au client que le refus était définitif | oui (banc : aucune ligne `operations_sync`) | motif `DROITS_MODIFIES` + `cause`, trace durable sans contenu, champ `definitif` | `securite/droits-modifies.test.ts`, banc D4 |
| D4-5 | Aucune route pour déposer les événements de la session locale | (nouvelle fonction) | `POST /api/auth/evenements-locaux` | `securite/evenements-locaux.test.ts`, banc D5 |
| D4-6 | `GET /auth/me` ne rendait pas les régions ; le rôle venait du jeton | oui | rôle de la base (via D4-1), `regions` et `perimetreNational` ajoutés | `compte-courant.test.ts`, banc D6 |

## 2. Contrat serveur pour le client : qui répond quoi

Règle de lecture : le client ferme sa session locale sur un **refus** (401 ou 403 porteur d'un code ci-dessous), **jamais** sur une indisponibilité (réseau coupé, 502, 503, 504, délai dépassé, 500). La file chiffrée n'est jamais effacée par un refus (`SESSION-HORS-LIGNE.md` section 7).

### 2.1 Authentification (toutes les routes derrière `requireAuth`)

| HTTP | `code` | Sens | Action du client |
|---|---|---|---|
| 401 | `NON_AUTHENTIFIE` | pas d'en-tête `Authorization: Bearer` | tenter un rafraîchissement ; s'il échoue, fermer la session locale |
| 401 | `JETON_INVALIDE` | jeton d'accès invalide ou expiré | idem (cas normal toutes les 15 minutes) |
| 401 | `COMPTE_INACTIF` | le compte est **désactivé, verrouillé ou supprimé** (trois cas, un seul code : on ne révèle pas l'existence d'un compte) | **fermer la session locale sans tenter de rafraîchir** (le rafraîchissement refusera aussi) ; conserver la file ; message « votre compte est désactivé ou verrouillé, contactez un administrateur » |
| 503 | `SERVICE_INDISPONIBLE` | la base n'a pas pu être lue, **ou n'a pas répondu en 3 secondes** (`DELAI_RESOLVEUR_COMPTE_MS`, valeur provisoire) : le serveur refuse par prudence mais ne sait pas si le compte est valide | **indisponibilité** : ne pas fermer la session, réessayer plus tard |
| 403 | (aucun code, corps `{ error }`) | module non autorisé (`requireModuleAccess`) ou rôle insuffisant (`requireRole`) sur une route autre que `sync/push` | refus de droits : ne pas rejouer |
| 403 | `HORS_PERIMETRE`, `REGION_INCONNUE` | écriture hors du périmètre territorial (routes d'écriture hors `sync/push`) | refus de droits : ne pas rejouer |
| 429 | `TROP_DE_REQUETES` (seulement sur `evenements-locaux`) ou `{ error }` | débit | réessayer plus tard (en-têtes `RateLimit-*`) |
| 429 | `PLAFOND_JOURNALIER_ATTEINT` (seulement sur `evenements-locaux`) | plafond de lignes par compte sur 24 heures glissantes, voir §2.4 | **garder** le journal local (rien n'est écrit) et réessayer plus tard, pas en boucle : le plafond se libère à mesure que les lignes de plus de 24 heures sortent de la fenêtre |

Le champ `error` (texte) existe toujours et reste lisible par les clients déjà déployés ; **le client doit s'appuyer sur `code`**, pas sur le texte.

Ordre des contrôles : jeton, puis compte (base), puis rôle, module, périmètre. Un compte désactivé reçoit donc `COMPTE_INACTIF` avant tout refus de module.

### 2.2 Appareils (`/api/v2/devices`, `/api/v2/sync/push`, `/api/v2/sync/status`)

| HTTP | `code` | Où | Sens | Action du client |
|---|---|---|---|---|
| 403 | `APPAREIL_INCONNU` | `sync/push`, `POST /devices` avec `appareilId` | l'identifiant n'existe pas **ou appartient à un autre compte** (indiscernable : rien n'est révélé sur autrui). Le texte historique « Appareil inconnu, révoqué ou non autorisé » est conservé tel quel pour les clients déployés | s'enregistrer **de nouveau** (`POST /devices` **sans** `appareilId`) est légitime |
| 403 | `APPAREIL_REVOQUE` | `sync/push`, `sync/status`, `POST /devices` avec `appareilId` | l'appareil est celui du compte et **a été révoqué** (texte : « Appareil révoqué : il ne peut plus synchroniser. Contactez un administrateur. ») | **cesser de pousser et de s'enregistrer seul.** Mettre la file en quarantaine, informer l'agent. Seule une décision humaine y met fin |
| 409 | `APPAREIL_DEJA_REVOQUE` | `POST /devices/:id/revoke` | révocation répétée | aucune |
| 403 | `APPAREIL_REVOCATION_RECENTE` | `POST /devices` **sans** `appareilId` | un appareil **du même compte** a été révoqué depuis moins de `JWT_ACCESS_EXPIRES_IN` (15 minutes par défaut) ; le corps porte `reessayerDansMs` (millisecondes jusqu'à la fin de la fenêtre, au moins 1 000) | **ne pas insister** : afficher « un appareil de votre compte vient d'être révoqué, réessayez dans N minutes », **conserver la file**, **ne pas fermer la session** (ce n'est pas un refus d'authentification), réessayer l'enregistrement après le délai. Voir §10.2 |

`POST /api/v2/devices`

* sans `appareilId` : crée un appareil (201), **sauf** 403 `APPAREIL_REVOCATION_RECENTE` (voir ci-dessus) et 409 si le plafond de 10 appareils actifs est atteint. L'identifiant est **toujours généré par le serveur** ;
* avec `appareilId` (UUID) : re-déclare un appareil déjà enregistré par ce compte (200, même ligne, métadonnées mises à jour, aucun doublon) ; révoqué : 403 `APPAREIL_REVOQUE` ; inconnu ou d'autrui : 403 `APPAREIL_INCONNU`.

Un appareil révoqué **ne se ré-enregistre donc pas sous le même identifiant** : le client qui essaie reçoit `APPAREIL_REVOQUE`. Il peut en revanche enregistrer un appareil **neuf** (sans identifiant), mais **plus** pendant la durée d'un jeton d'accès qui suit une révocation d'un appareil du compte (403 `APPAREIL_REVOCATION_RECENTE`) : voir §5 et §10.2.

`POST /api/v2/devices/:id/revoke` (propriétaire ou ADMIN). **Pour un non-ADMIN, un appareil inconnu et un appareil d'un autre compte rendent la même réponse : 404 `{ "message": "Appareil introuvable" }`** (avant : 403 pour l'appareil d'autrui, qui disait quels identifiants existent chez les autres comptes). Un ADMIN voit tout. La réponse 200 porte, en plus des champs historiques :

```json
{ "id": "...", "revoqueA": "2026-10-25T...", "rafraichissement": { "revoque": true, "portee": "TOUTES_LES_SESSIONS_DU_PROPRIETAIRE", "sessions": 2 } }
```

**Portée, dite sans détour** : le schéma ne lie pas un appareil à une session de rafraîchissement. Faute de lien, la révocation coupe **toutes** les familles de rafraîchissement du **propriétaire** de l'appareil (pas celles de l'acteur : un ADMIN qui révoque le téléphone d'un agent ne se déconnecte pas). Conséquence visible : l'agent doit se reconnecter sur ses autres appareils et sur la console web. La trace (`audit_logs`, `SECURITY_EVENT`, `Appareil`) porte `after.sessionsRefreshRevoquees` et `after.porteeSessions`. La coupure et la trace sont **atomiques** (prouvé : un déclencheur de base qui refuse la trace annule la révocation et laisse les sessions vivantes).

### 2.3 `POST /api/v2/sync/push`

Le lot est toujours rendu en 200 avec un résultat **par opération** quand l'appareil est valide, y compris quand les droits sont retirés. Compteurs additifs : `refusDroits` (nombre de refus de la famille droits, voir ci-dessous) et `refusNonTraces` (nombre de ces refus rendus **sans trace durable**, voir §10.5) en plus de `total`, `synchronisees`, `rejouees`, `conflits`, `rejetees`.

Résultat d'une opération refusée pour une raison de **droits** :

```json
{ "operationId": "...", "statut": "REJETE", "motif": "DROITS_MODIFIES", "cause": "HORS_PERIMETRE", "definitif": true }
```

| `motif` | `cause` | Sens | Reessai automatique ? |
|---|---|---|---|
| `DROITS_MODIFIES` | `MODULE_RETIRE` | le module `inspections` a été retiré au compte | **non** |
| `DROITS_MODIFIES` | `HORS_PERIMETRE` | la région de l'opération est hors du périmètre du compte | **non** |
| `DROITS_MODIFIES` | `REGION_INCONNUE` | la région n'est pas déterminable (compte régional) | **non** |
| `MISSION_NON_AUTORISEE` | (aucune) | la mission n'est ni assignée au compte ni créée par lui ; **motif historique conservé** (contrat de la collecte de roulage) mais **de la même famille** | **non** |

Règles pour le client :

1. **Un refus de droits n'est jamais rejoué en boucle.** `definitif: true` (ou `MISSION_NON_AUTORISEE`) et l'absence de `reessayerDansMs` le disent. Le client met l'opération en **quarantaine** (visible de l'agent, motif affiché, contenu conservé localement) et ne la renvoie pas de lui-même.
2. **Un renvoi explicite est réévalué** : si l'agent (ou un administrateur) a fait rendre les droits, la même opération, renvoyée **avec la même clé `operationId`**, est jugée sur les droits d'aujourd'hui et appliquée. Le serveur a conservé la ligne du refus (motif, essais), pas le contenu.
3. **Un refus de donnée** (`PAYLOAD_INVALIDE:*`, `REFERENCE_INCONNUE:*`, `TYPE_NON_SUPPORTE:*`, `OPERATION_NON_SUPPORTEE:*`, `OPERATION_NON_AUTORISEE`, `SESSION_DEJA_ENREGISTREE`, `VERSION_MANQUANTE`...) est **autre chose** : l'agent doit corriger sa saisie ou la perdre. Ne pas l'afficher comme « droits modifiés ».
4. **Un rejeu d'une opération déjà appliquée rend son résultat précédent** (`REJOUEE`), même si les droits ont changé depuis : l'idempotence passe avant les droits. Le client ne doit donc pas interpréter `REJOUEE` comme « droits intacts ».
5. Dans le lot, un refus de droits ne perturbe pas les autres opérations (elles sont jugées une à une).

Compte désactivé ou verrouillé : le lot entier est refusé en 401 `COMPTE_INACTIF` **avant** tout traitement : rien n'est écrit, aucune ligne `operations_sync`. Le client conserve la file et ferme la session.

Ce qui est stocké pour un refus de droits (`operations_sync`) : `statut = REJETE`, `derniereErreur = DROITS_MODIFIES:<cause>`, `payload = {"redacted":true}`, type, identifiant d'entité, opération, appareil, compte, nombre d'essais. **Le contenu de l'opération refusée n'est pas conservé.** Au plus **20 refus de droits sont tracés par appel** (`REFUS_DROITS_TRACES_MAX_PAR_LOT`, valeur provisoire) : les suivants sont rendus avec le même motif, la même cause et `definitif: true`, comptés dans `refusNonTraces`, sans ligne `operations_sync`. Une opération dont le **type d'entité est inconnu** n'est jamais tracée : elle rend `TYPE_NON_SUPPORTE:<type>` sans aucune écriture (le type libre du client n'atteint pas la base).

### 2.4 `POST /api/auth/evenements-locaux`

Authentifiée (même `requireAuth`). Monté dans le routeur d'authentification. Dépose les événements de la session locale à la reconnexion.

```json
POST /api/auth/evenements-locaux
{
  "appareilId": "uuid (facultatif)",
  "evenements": [
    { "id": "uuid choisi par le client", "evenement": "ECHEC_DEVERROUILLAGE",
      "horodatageClient": "2026-10-24T08:15:00.000Z", "occurrences": 4 }
  ]
}
→ 200 { "recus": 1, "enregistres": 1, "dejaConnus": 0 }
```

| Contrainte | Valeur |
|---|---|
| `evenement` | liste fermée : `OUVERTURE_HORS_LIGNE`, `DEVERROUILLAGE`, `ECHEC_DEVERROUILLAGE`, `VERROU_INACTIVITE`, `SESSION_LOCALE_FERMEE`, `SESSION_LOCALE_EXPIREE`, `PIN_REINITIALISE`, `EFFACEMENT_LOCAL` |
| lot | 1 à 50 événements |
| `id` | UUID obligatoire, **clé d'idempotence** (propre au compte) |
| `horodatageClient` | chaîne de 40 caractères au plus, **ISO 8601 stricte** (`2026-10-24T08:15:00.000Z`, ou avec un décalage `+01:00` ; ce que `Date.prototype.toISOString` produit) ; une date « lâche » (`<img ...> 1`, `Oct 24 2026`, un nombre) est refusée en 400 ; **non fiable** |
| `occurrences` | entier 1 à 1000, facultatif (défaut 1) : pour regrouper plusieurs échecs en un événement |
| champs inconnus | **refusés** (400 pour tout le lot, rien n'est écrit) : ni PIN, ni payload, ni texte libre |
| débit | **5 lots** par 15 minutes **par compte** (429 `TROP_DE_REQUETES`) **et** un plafond de **500 lignes par 24 heures glissantes et par compte** (429 `PLAFOND_JOURNALIER_ATTEINT`, avec `plafondJournalier` et `restantSurLes24Heures` ; le lot qui ferait dépasser est refusé en entier, un rejeu entièrement connu passe toujours). Valeurs **provisoires**, réglables dans `modules/auth/evenements-locaux.ts`. Avant : 30 lots de 50 = 144 000 lignes par jour et par compte |

Ce que la route écrit dans `audit_logs` (une ligne par événement) : `action = SECURITY_EVENT`, `entityType = EvenementLocal`, `entityId = id de l'événement`, `userId`, `ipAddress` (vue par le serveur), `createdAt` (**horloge du serveur : c'est elle qui fait foi**), et `after` limité à : `evenement`, `horodatageClient`, `horodatageClientFiable: false`, `appareilId`, `appareilReconnu`, `appareilRevoque`, `occurrences`. L'appareil n'est attribué que s'il appartient au compte (`appareilId: null` et `appareilReconnu: false` sinon) ; un appareil révoqué du compte peut encore remonter ses événements (ce sont des faits d'audit, pas des droits), marqués `appareilRevoque: true`.

Idempotence : rejouer un lot (réponse perdue) n'ajoute **aucune** ligne ; un lot partiellement connu n'ajoute que ce qui manque ; six rejeux simultanés du même lot de cinq événements produisent exactement cinq lignes (prouvé sur le banc : verrou de transaction par compte). Le lot s'écrit en entier ou pas du tout.

À envoyer **après** la reconnexion (jeton d'accès valide), jamais en cas d'effacement local imminent : les événements détruits par un effacement local ne partent pas (limite connue de `SESSION-HORS-LIGNE.md` section 5).

### 2.5 `GET /api/auth/me`

Rend toujours `user.id`, `email`, `role`, `totpEnabled`, `nomComplet`, `modulesAutorises`, `peutDeleguerValidation` (inchangés) et, **ajoutés** :

* `perimetreNational` (booléen) : vrai pour un ADMIN et pour un compte sans rattachement ;
* `regions` (entiers triés) : régions du périmètre ; **vide pour un compte national** (ne pas lire « vide » comme « aucune région »).

Tout est lu en base à la requête, y compris `role` (via `requireAuth`). C'est la comparaison à faire à la reconnexion pour invalider une session locale dont les droits ont changé. Pour un ADMIN, `modulesAutorises` peut être vide sans que l'accès soit restreint (ADMIN n'est jamais restreint).

## 3. Couverture de `requireAuth`, dite exactement

La relecture du compte s'applique à **toute route montée derrière `requireAuth`**, c'est-à-dire à toutes les routes authentifiées : `securite/routes-authentifiees.test.ts` prouve, par la vraie application, que chaque route non publique répond 401 sans jeton, et `securite/inventaire-acces.test.ts` recense les routes (323 au 25/10/2026, `CONTROLE-ACCES.md` §5, recomptées par `inventaire-acces.test.ts`).

**Non couvertes, par conception** (pas de jeton d'accès) : `/api/public/*`, `/api/health`, `POST /api/auth/login`, `/api/auth/2fa/login-verify`, `/api/auth/refresh`, `/api/auth/logout`. `refresh` vérifie `actif` et `lockedUntil` lui-même ; `login` aussi.

**Non couverts, hors de portée** : les fichiers qu'un proxy servirait directement (APK, tuiles, voir `CONTROLE-ACCES.md` §6.4) ; un jeton d'accès déjà émis pour une route qui ne passerait pas par Express.

Ce qu'elle ne couvre **pas** : voir le défaut résiduel du §5 (jeton d'accès d'un appareil révoqué dont le compte reste actif).

## 4. Coût

Une lecture de `users` par clé primaire, quatre colonnes (`actif`, `lockedUntil`, `role`, `email`), par requête authentifiée. `requireModuleAccess` en fait déjà une autre pour les comptes non ADMIN : une requête authentifiée sur une route à module coûte désormais **deux lectures de `users`** (voir l'optimisation proposée plus bas).

**Mesuré** (banc `session-appareil`, quatre exécutions du 25/10/2026, clone PostGIS dans Docker Desktop sous Windows, poste chargé, 2 000 lectures puis 400 appels `GET /api/v2/devices` alternés avec et sans lecture) :

| Exécution | Lecture seule, médiane (p95) | `GET /api/v2/devices` sans lecture, médiane | avec lecture, médiane | Surcoût médian |
|---|---|---|---|---|
| 1 | 11,5 ms (50 ms) | 44,7 ms | 58,6 ms | 13,9 ms |
| 2 | 11,1 ms (128 ms) | 47,4 ms | 62,2 ms | 14,8 ms |
| 3 | 8,5 ms (40 ms) | 27,9 ms | 35,1 ms | 7,3 ms |
| 4 | 12,9 ms (145 ms) | 66,8 ms | 80,6 ms | 13,9 ms |

**Ce que ces chiffres valent** : un ordre de grandeur du poste de développement (la base est atteinte par un port publié par Docker Desktop, d'où des latences élevées par rapport à une base sur le même réseau). Ils **ne sont pas** ceux de la production, que je n'ai pas mesurée. La variation entre exécutions (de 7 à 15 ms de surcoût sur quatre exécutions) montre que le bruit du poste est du même ordre que la mesure.

**Pas de cache.** Un cache, même d'une seconde, rouvrirait une fenêtre où un compte désactivé agit encore, ce que ce correctif ferme. Si la charge l'exigeait, `middleware/auth.middleware.ts` expose `_installerResolveurCompte` : un résolveur de compte injectable. La durée d'un cache devrait alors être écrite en toutes lettres ici, avec ce qu'elle réautorise.

**Optimisation proposée, non faite (fichiers hors périmètre)** : faire lire à `requireAuth` aussi `modulesAutorises` et le poser sur la requête (`req.user.modulesAutorises`), puis faire servir `lib/access.ts:modulesAutorisesDe` depuis cette valeur quand elle existe. Cela ramène deux lectures à une.

**Constat de la relecture D9 (lectures de `users` par appel, mesurées par le relecteur sur la base de développement)** : une lecture de plus que l'avant-D4 par appel authentifié non ADMIN (celle de `requireAuth`) ; **trois** sur `POST /v2/sync/push` pour un non-ADMIN (`requireAuth`, `modulesAutorisesDe` dans la garde `controlerPush`, puis `requireModuleAccess`). **Changement proposé, non fait (suivi)** : (1) `requireAuth` ajoute `modulesAutorises` à son `select` et le pose sur `req.user` ; (2) `lib/access.ts:modulesAutorisesDe(user)` lit cette valeur quand elle est présente et ne relit la base qu'en son absence ; (3) `controlerPush` et `requireModuleAccess` appellent `modulesAutorisesDe(req.user)` et ne font donc plus de lecture. Aucune valeur n'est conservée d'une requête à l'autre : la fraîcheur d'un module retiré reste celle de la requête, et la lecture unique garde l'atomicité d'instantané entre l'état du compte et ses modules. Il faut alors adapter les tests qui simulent `user.findUnique` pour `lib/access` et `module-access.middleware`. Fichiers : `middleware/auth.middleware.ts`, `lib/access.ts`, `middleware/module-access.middleware.ts`, `api-v2/sync.routes.ts`, `types/` de `req.user`.

**Délai de la lecture (D9, point 7b)** : la lecture du compte est bornée à `DELAI_RESOLVEUR_COMPTE_MS` = **3 secondes** (provisoire, sans mesure de production), puis 503 `SERVICE_INDISPONIBLE` : une base qui accepte la connexion mais ne répond plus ne laisse plus les requêtes pendantes.

## 5. Défaut résiduel : le jeton d'accès d'un appareil révoqué

Constaté par le banc (vérification « CONSTAT ») : la révocation coupe les sessions de **rafraîchissement** du propriétaire, mais le **jeton d'accès** déjà émis (15 minutes) reste valable tant que le compte est actif. Pendant ce délai, le porteur du téléphone volé peut encore appeler les routes, **y compris enregistrer un appareil neuf** (201) ; `sync/push` depuis l'appareil révoqué, lui, est refusé (`APPAREIL_REVOQUE`). La fenêtre est bornée par `JWT_ACCESS_EXPIRES_IN`.

**État après la relecture D9** : l'enregistrement d'un appareil **neuf** pendant cette fenêtre est refusé (403 `APPAREIL_REVOCATION_RECENTE`, §10.2) ; le chemin « jeton volé, appareil neuf, puis push » est fermé sans migration. Le jeton d'accès reste valable pour les autres routes (lectures, écritures des modules du compte) jusqu'à son expiration : seul le lien appareil-session ci-dessous le ferme tout à fait. Le constat « enregistrer un appareil neuf (201) » de ce paragraphe est celui d'avant D9. Le jeton d'accès ne porte aucun identifiant d'appareil ni de session : le serveur ne peut pas savoir de quel appareil il vient.

### Lien appareil-session exact proposé (non implémenté, migration nécessaire)

1. **Champ** : `RefreshToken.appareilId String?`, clé étrangère vers `appareils.id` (`ON DELETE SET NULL`), index. Migration idempotente (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, contrainte ajoutée dans un bloc `DO $$ ... EXCEPTION WHEN duplicate_object`), descente dans `backend/prisma/descentes/` (supprimer contrainte, index, colonne) avec son banc de descente, sur le modèle de `20261027100000`.
2. **Écriture** : `login` et `verifyTwoFaLogin` acceptent un `appareilId` facultatif ; le serveur vérifie qu'il appartient au compte et n'est pas révoqué (sinon 403 `APPAREIL_REVOQUE`), le stocke sur le jeton racine de la famille ; la rotation (`refresh`) le recopie sur le jeton suivant. Une session web n'a pas d'appareil (`null`).
3. **Révocation ciblée** : `updateMany({ where: { userId, appareilId, revokedAt: null } })` au lieu de tous les jetons du propriétaire. La réponse passerait de `portee: TOUTES_LES_SESSIONS_DU_PROPRIETAIRE` à `portee: SESSIONS_DE_L_APPAREIL`.
4. **Fermer la fenêtre du jeton d'accès** : ajouter au jeton d'accès une revendication `fid` (identifiant de famille). `requireAuth` ajoute, dans la même requête, la lecture de la révocation de la famille (jointure ou second `select` par clé) et refuse (401 `SESSION_REVOQUEE`) un jeton dont la famille est révoquée. Coût : une jointure sur la même lecture.
5. **Transition** : les jetons existants ont `appareilId = null`. Décision à prendre : pendant la transition, une révocation d'appareil continue-t-elle de couper aussi les jetons sans appareil du propriétaire (comportement actuel, plus large) ou seulement ceux de l'appareil (plus étroit, mais les sessions antérieures à la migration deviennent non révocables par appareil jusqu'à leur expiration, 7 jours) ?

## 6. Autres constats en passant

* **Deux jetons de rafraîchissement identiques dans la même seconde** (`utils/jwt.ts:signRefreshToken`, hors périmètre) : le JWT n'a pas d'identifiant unique (`jti`). Deux connexions du même compte, ou une rotation, dans la **même seconde** produisent la même chaîne, donc la même empreinte `tokenHash` (unique) : la seconde opération échoue en **409** (« Une entrée avec cette valeur unique existe déjà »). Observé pendant l'écriture du banc : une seconde connexion du même compte, et un rafraîchissement immédiatement après une connexion, ont répondu 409 dans 2 des 3 exécutions faites avant que le banc espace ses connexions de plus d'une seconde. Effet réel : un client qui rafraîchit dans la seconde d'une connexion ou d'un rafraîchissement échoue sans raison. Correctif minimal : `jwt.sign(..., { jwtid: randomUUID() })` dans `signRefreshToken`. **Corrigé** (`utils/jwt.ts` porte désormais `jwtid`) ; un jeton émis avant le déploiement, sans `jti`, reste vérifiable (vérifié par la relecture D9).
* **Le plafond de taille du corps** de `evenements-locaux` est celui du serveur (5 Mo, `express.json`) : un corps énorme est lu avant d'être refusé par la validation. Sans conséquence ici (la validation est stricte) ; un `limit` plus bas sur cette route demanderait de la monter avant le parseur global.
* **Trace d'un refus de droits puis donnée invalide** : une opération refusée pour droits, puis renvoyée après retour des droits avec une donnée invalide, repasse par les chemins de trace en `create` de `field/sync.service.ts` (`OPERATION_NON_SUPPORTEE`, `PAYLOAD_INVALIDE`, `creeParLaMemeOperation`, `SESSION_DEJA_ENREGISTREE`), qui n'utilisent pas `upsert` : l'unicité de `operationId` ferait échouer la requête. Même classe de défaut qu'avant ce chantier pour les refus `REFERENCE_INCONNUE` retentables. Non corrigé (rare) ; la correction est de passer ces quatre écritures en `upsert`.

## 7. Modifications que ce chantier impose hors de son périmètre

Aucune n'est faite ; chacune est une **conséquence voulue** du correctif.

1. `backend/tests-integration/controle-acces.integration.mts`, section L (« Limites ») : la vérification « CONSTAT (limite documentée) : un compte DÉSACTIVÉ garde l'accès… » échoue désormais (`[200, 401, 403]`) parce que la limite est corrigée. À réécrire en : compte désactivé, 401 `COMPTE_INACTIF` ; compte rétrogradé, 403 sur l'écriture (le banc écrit `retrograde.status === 200` aujourd'hui).
2. `backend/tests-integration/territoire.integration.mts`, section 4 : deux vérifications échouent (`motif === "HORS_PERIMETRE"`, puis « l'opération rejetée n'est PAS enregistrée »). Le contrat est maintenant `motif: "DROITS_MODIFIES"`, `cause: "HORS_PERIMETRE"`, et une ligne `operations_sync` existe (`derniereErreur = DROITS_MODIFIES:HORS_PERIMETRE`, payload caviardé, aucun défaut créé).
3. `docs/securite/CONTROLE-ACCES.md` : §4.2 D-C1-10 et §6 limite 1 (« le rôle et l'identité viennent du jeton ») ne sont plus vraies ; §7 D-C1-10 : l'option C est réalisée. Le §3 et la matrice (`sync/push` : « opération hors périmètre rejetée seule et non enregistrée ») sont à corriger.
4. `docs/scenarios/SYNC-A7-A8.md` et `docs/roulage/COLLECTE-ROULAGE.md` : ils citent `HORS_PERIMETRE` / `REGION_INCONNUE` comme motifs de rejet de `sync/push`.
5. `docs/securite/SESSION-HORS-LIGNE.md` §7 : les défauts (a), (b), (c) sont corrigés côté serveur (le client reste à corriger).
6. `backend/src/utils/jwt.ts` : `jwtid` (voir §6).
7. Tests de routes qui utilisent le **vrai** `requireAuth` avec une base simulée : leur simulation de `user.findUnique` doit rendre un compte actif (`actif`, `lockedUntil`, `role`, `email`). Adaptés dans ce chantier : `modules/audit/audit.routes.test.ts`, `modules/search/search.routes.test.ts`, `modules/marches/marches.routes.test.ts`. Tout nouveau test de ce genre doit le faire.

## 8. Décisions attendues de l'architecte

| Id | Question | Recommandation |
|---|---|---|
| D4-A | Garder la portée large de la révocation (toutes les sessions du propriétaire) en attendant le lien appareil-session (§5) | oui à court terme : elle est dite dans la réponse et la trace. Décider ensuite de la migration du §5 |
| D4-B | `MISSION_NON_AUTORISEE` reste-t-il distinct de `DROITS_MODIFIES` ? Le fusionner (cause `MISSION_NON_AUTORISEE`) cohérentise la famille mais change le contrat de la collecte de roulage (`session.service.ts`, `COLLECTE-ROULAGE.md`, `roulage.integration.mts`, tests du client) | garder le motif historique tant que le client n'est pas corrigé ; la famille est déjà identifiable par `refusDroits` et `estRefusDeDroits` |
| D4-C | Cache du compte : non, tant que la charge ne l'impose pas (§4) | non |
| D4-D | Réduire `JWT_ACCESS_EXPIRES_IN` pour resserrer la fenêtre du §5 sans migration | 5 minutes coûte trois fois plus de rafraîchissements ; à arbitrer avec la migration `fid`. **Depuis D9, cette durée est aussi celle du refus `APPAREIL_REVOCATION_RECENTE`** (403, `reessayerDansMs` ≤ `JWT_ACCESS_EXPIRES_IN`) : la réduire raccourcit à la fois la fenêtre de l'attaque et l'attente d'un agent légitime dont un autre appareil vient d'être retiré. Affinement sans migration, non fait : ne refuser que les jetons d'accès émis AVANT la révocation (comparer le `iat` du jeton à `revoqueA`), ce qui supprime l'attente de l'agent légitime qui s'est reconnecté après la révocation ; il demande de porter `iat` sur `req.user` |
| D4-E | Un appareil révoqué doit-il pouvoir encore déposer ses événements locaux ? Aujourd'hui oui (faits d'audit, marqués) | oui |

## 9. Rejouer

```bash
# Tests unitaires et structurels (aucune base)
cd backend && npx vitest run src/securite src/api-v2/devices.routes.test.ts src/api-v2/sync.routes.test.ts src/api-v2/sync.roulage.routes.test.ts src/field src/modules/auth

# Banc PostGIS (clone jetable essai_session_appareil ; DATABASE_URL pointe sur `replay`, jamais écrite)
DATABASE_URL="postgresql://<utilisateur>:<mot de passe>@127.0.0.1:5434/replay" npx tsx tests-integration/session-appareil.integration.mts
```

Fichiers du chantier : `backend/src/middleware/auth.middleware.ts`, `backend/src/modules/auth/auth.controller.ts`, `auth.routes.ts`, `evenements-locaux.ts`, `backend/src/api-v2/devices.routes.ts`, `sync.routes.ts`, `backend/src/field/sync.service.ts`, `backend/src/securite/compte-courant.test.ts`, `appareil-revoque.test.ts`, `evenements-locaux.test.ts`, `droits-modifies.test.ts`, `backend/tests-integration/session-appareil.integration.mts`.

## 10. Relecture indépendante D9 : ce qui a changé (25/10/2026)

Chaque point a été reproduit par exécution avant correction (script du relecteur, clone `essai_*` de `replay`), puis corrigé et rejoué. Rien n'est déployé.

### 10.1 Course révocation d'appareil / rotation du rafraîchissement (élevé)

**Défaut** : une rotation (`refresh`) en vol a consommé le jeton A et inséré le jeton B sans avoir commité ; la révocation (`UPDATE refresh_tokens ... WHERE userId = ... AND revokedAt IS NULL`, READ COMMITTED) attend le verrou de A, ignore A à la reprise, **ne voit pas B** (absent de l'instantané de son instruction) et répond 200 `sessions: 0` : B reste vivant sept jours. Reproduit : transaction PostgreSQL tenue ouverte (une révocation 200, un jeton vivant) et répétition HTTP parallèle (25 essais sur 40, puis 21 sur 40).

**Correctif retenu** : verrou de ligne sur le compte propriétaire, pris EN PREMIER. `refresh()` lit `FOR SHARE`, la révocation (d'appareil, et la révocation globale `revokeAllForUser` : logout-all, changement de mot de passe, désactivation, verrouillage) lit `FOR UPDATE` (`modules/auth/session-verrou.ts`). Les deux se contredisent : la rotation et la révocation d'un même compte se **sérialisent**. Si la rotation est en vol, la révocation attend sa fin puis, avec un nouvel instantané, voit B et le révoque. Si la révocation passe la première, la rotation attend, relit son jeton A, le trouve révoqué et suit le chemin de réutilisation (401). Pourquoi pas « rejouer la révocation en fin de transaction » : cela ne fait que rétrécir la fenêtre (un client qui reçoit B et le présente aussitôt ouvre une nouvelle rotation entre les deux instructions). Pourquoi le verrou de la rotation est indispensable : sans lui, la rotation prendrait `FOR KEY SHARE` sur le compte à l'insertion de B (clé étrangère) alors que la révocation tient `FOR UPDATE` et attend A : interblocage, donc un 500.

**Ce qui ne change pas** : deux rafraîchissements du MÊME jeton restent réglés par la mise à jour conditionnelle (un gagne, l'autre est une réutilisation 401 et la famille est coupée) ; deux familles du même compte tournent en parallèle (`FOR SHARE` est compatible avec `FOR SHARE`). Coût : une lecture de ligne par rotation et par révocation, rien sur les requêtes ordinaires.

**Limites dites** : la connexion (`login`) ne prend pas le verrou ; son insertion de jeton prend `FOR KEY SHARE` et se sérialise donc de toute façon avec une révocation en cours (mesuré), et une connexion qui commence après la révocation ouvre légitimement une nouvelle famille (le mot de passe vient d'être vérifié). La coupure de famille par réutilisation détectée (`revoquerFamilleCompromise`) ne prend pas le verrou ; elle ne crée aucun jeton.

**Preuves** : `tests-integration/session-appareil.integration.mts` section D7 : banc déterministe n°1 (rotation en vol tenue par un verrou consultatif pris par le banc : la révocation attend, puis 200 et 0 jeton vivant), n°2 (ordre inverse, pas d'interblocage), non-régression de la rotation, et 100 essais HTTP parallèles à ordres et décalages variés, 0 jeton vivant, 0 erreur 5xx. Tests unitaires : `refresh.security.test.ts`, `auth.audit.test.ts`, `devices.routes.test.ts`, `appareil-revoque.test.ts`.

### 10.2 Fenêtre résiduelle après révocation : `APPAREIL_REVOCATION_RECENTE` (changement de comportement)

`POST /api/v2/devices` **sans** `appareilId` répond désormais :

```json
403 { "code": "APPAREIL_REVOCATION_RECENTE",
      "message": "Un appareil de ce compte vient d'être révoqué : l'enregistrement d'un nouvel appareil est suspendu quelques minutes.",
      "reessayerDansMs": 540000 }
```

tant qu'un appareil du compte a été révoqué depuis moins de `JWT_ACCESS_EXPIRES_IN` (15 minutes par défaut ; la valeur illisible retombe sur 15 minutes). `reessayerDansMs` est le temps restant, **au moins 1 000**. Le contrôle passe avant le plafond de 10 appareils actifs. Ne sont pas concernés : la re-déclaration d'un appareil actif du compte (`appareilId`, 200), `sync/push`, les autres comptes.

**Ce que le client doit faire** (`obtenirAppareil` de la page de roulage et la synchronisation) : traiter ce 403 comme un **refus temporaire**, jamais comme `APPAREIL_REVOQUE` : ne pas fermer la session, ne pas mettre la file en quarantaine, afficher le délai, réessayer l'enregistrement après `reessayerDansMs` (et non en boucle). Un client qui ne connaît pas ce code et traite tout 403 de `POST /devices` comme un refus définitif doit être corrigé.

**Ce que le client fait désormais** (`frontend/src/lib/offlineSync.ts`, `BandeauSynchronisation`) : la synchronisation suit ce contrat.

- **Arrêt** : le 403 `APPAREIL_REVOCATION_RECENTE` n'est jamais traité comme `APPAREIL_REVOQUE` (`appareilRevoque` n'est pas posé, la session reste ouverte, la file n'est ni arrêtée ni mise en quarantaine, aucune saisie ne change de statut ni ne compte de tentative). Un cycle automatique (retour du réseau, onglet visible, saisie enregistrée, ouverture de l'application, déverrouillage) qui devrait enregistrer un appareil neuf s'arrête **avant toute requête** tant que le délai court ; les inspections, qui n'ont pas d'appareil, partent normalement.
- **Minuteur borné** : le délai de `reessayerDansMs` est borné entre **5 s** et **30 min** (le serveur garantit au moins 1 s ; un délai absurde ne fige pas l'envoi), **5 min** sans délai lisible dans la réponse. Un seul minuteur, posé par `offlineSync` et jamais par l'interface, déclenche **un** réessai automatique à l'échéance ; si le serveur redit non, un nouveau délai court, soit au plus une requête par délai, jamais une boucle. La suspension vit en mémoire de la page (non persistée : après un rechargement, une requête la constate de nouveau) et tombe au changement de compte.
- **Geste manuel** : les boutons de l'agent (« Synchroniser » / « Envoyer maintenant » / « Reprendre les photos » / « Relancer l'envoi » / « Réessayer maintenant ») appellent `syncPendingOfflineData({ manuel: true })` (`synchroniserManuellement`), qui réessaie l'enregistrement tout de suite, délai ou non. Les appels automatiques restent en mode automatique.
- **Affichage** : `BandeauSynchronisation` montre, tant que `getSyncState().enregistrementSuspendu` est vrai et que l'envoi n'est pas arrêté, un bandeau `role="status"` (pas une alerte) qui reprend le message du serveur, l'heure du prochain essai automatique si elle est connue, la phrase « Vos saisies sont conservées » et le bouton « Réessayer maintenant ». Il ne dit jamais que l'appareil est retiré et se distingue du bandeau d'arrêt (rouge, `role="alert"`). Le bandeau disparaît quand le geste aboutit ou à l'échéance.

**Compromis** : un agent légitime dont un AUTRE appareil vient d'être retiré (perdu, remplacé, ou retiré par un administrateur) attend au plus `JWT_ACCESS_EXPIRES_IN` avant d'enregistrer son nouveau téléphone, **même s'il s'est reconnecté entre-temps**. C'est le prix d'une fermeture sans migration ; l'affinement par `iat` (§8, D4-D) le supprimerait. Ne ferme pas la fenêtre pour les autres routes (§5).

### 10.3 `/revoke` d'un appareil d'autrui

Pour un non-ADMIN, appareil inconnu et appareil d'un autre compte rendent la même réponse (404, même corps) ; aucune trace, aucune coupure. Même règle recherchée pour `PUT /api/inspections/:id` : **non appliquée**, parce que le contrat « 403 sur l'inspection d'autrui » est testé (`inspections.authorization.test.ts`) ; un INSPECTEUR peut donc deviner l'existence d'une inspection d'autrui par PUT (la lecture, elle, rend 404). Écart documenté, non corrigé.

### 10.4 Événements locaux

Voir §2.4 (débit, plafond, horodatage strict). Écarts constatés du côté client (`frontend/src/session/journalEvenementsLocaux.ts`, non modifié) : (a) l'horodatage émis est `new Date(ms).toISOString()`, conforme à la nouvelle règle ; (b) la validation des entrées relues du stockage local se fait avec `Date.parse`, plus lâche que le serveur : une entrée corrompue passerait le contrôle local et ferait refuser son lot en entier (400), que le client retire alors du journal (il traite tout 4xx hors 401, 403, 408, 429 comme un lot illisible), perdant les entrées valides du même lot ; (c) la constante `LOTS_MAX_PAR_PASSAGE` et son commentaire annoncent « 30 lots par 15 minutes » : le serveur accepte 5 lots, et le client doit traiter le nouveau 429 `PLAFOND_JOURNALIER_ATTEINT` comme `TROP_DE_REQUETES` (conserver et réessayer plus tard).

### 10.5 Refus de droits tracés

Voir §2.3. Auparavant, un compte sans le module écrivait 100 lignes `operations_sync` par appel avec le `entityType` libre du client (64 caractères, balises comprises). Maintenant : type inconnu sans écriture, au plus 20 traces par appel (module retiré ET périmètre), `refusNonTraces`. Un refus rendu sans trace est renvoyable après rétablissement des droits comme une opération neuve (prouvé par le banc).

### 10.6 Oracle d'existence

Pour un compte régional, une ressource inexistante répond comme une ressource d'une autre région (même statut, même corps) : OT (statut, assigner, modification, conversion, photos, suppression, lecture), prévisions, scénarios, fiches, plans. Pour un INSPECTEUR, un OT qui n'est ni assigné ni créé par lui répond comme un OT inconnu (404, au lieu de 403) sur la modification, les photos et le changement de statut ; la règle plus fine du service (statut : assigné seulement, 403) reste pour SES OT. Les missions n'ont pas d'oracle (corps validé avant la recherche, recherche filtrée par périmètre). Les écritures d'observations et de défauts restent en 403 (`requireTerritoire`), non masquées : voir `CONTROLE-ACCES.md` §4.1.

### 10.7 Choix assumé : une panne d'audit empêche la révocation

La révocation, la coupure des sessions et la trace `SECURITY_EVENT` sont **atomiques** : si `audit_logs` refuse l'écriture, la révocation entière est annulée (500) et le téléphone reste actif. C'est un choix : on ne coupe pas un accès sans pouvoir dire qui l'a fait. Conséquence honnête : pendant une panne d'`audit_logs`, personne ne peut révoquer un appareil par cette route ; le recours est la désactivation du compte (`revokeAllForUser`, qui est atomique de la même façon) ou une intervention sur la base. Le contraire (révoquer d'abord, tracer ensuite, en échec silencieux) est le comportement de `login`, volontairement fail-soft pour ne pas fermer les connexions des administrateurs ; il n'a pas été retenu ici parce que la trace d'une révocation est ce qu'on relit après un incident. Cet arbitrage est à confirmer par l'architecte.

# Audit du transport des sessions — P3-B étape 1

**Date** : 2 septembre 2026 · **Branche** : `phase5` · **Production** : NON TOUCHÉE

---

## 1. Cartographie mesurée du cycle actuel

| Étape | Comportement actuel (code lu) |
|---|---|
| `POST /api/auth/login` | renvoie `{ accessToken, refreshToken, user }` — **refresh en clair dans le body** |
| `POST /api/auth/2fa/login-verify` | idem |
| `POST /api/auth/refresh` | lit `{ refreshToken }` du body ; depuis P3-A : rotation atomique, familles, détection de réutilisation |
| `POST /api/auth/logout` | révoque le token passé dans le body |
| `POST /api/auth/logout-all` (P3-A) | révoque toutes les sessions — **aucun appelant frontend à ce jour** |
| Access token | mémoire JS seulement (`lib/api.ts`, portée module) — ✓ correct, jamais persisté |
| Refresh token | **`localStorage["bdri_refresh_token"]`** (`setRefreshToken`) — lisible par tout script de la page (XSS) |
| Interceptor axios | 401 → un seul refresh par onglet (partage de promesse `refreshing`) → retry UNE fois (`_retried`) → sinon `/login`. Pas de boucle par requête ✓ |
| Multi-tab | **aucun mécanisme inter-onglets** : trois onglets dont l'access token expire ensemble émettent trois refresh simultanés |
| Multi-device | chaque login crée sa famille (P3-A) ; logout d'un appareil ne touche pas les autres ✓ |
| Cookies actuels | aucun |
| Rechargement navigateur | access token perdu → refresh au démarrage via `AuthProvider` ✓ |
| CORS | `origin: env.CORS_ORIGIN` explicite + `credentials: true` — jamais `*` ✓ |
| HTTPS | Traefik en production (`carte.ageroute.gov.gn`) ; dev : proxy Vite (`/api` → `localhost:4000`), same-origin du point de vue du navigateur |
| SharePoint | `/embed/carte` = page servie par le **frontend nginx** ; l'API porte `frame-ancestors 'none'` ; `frontend/nginx.conf` n'envoie aucun en-tête de sécurité (écart relevé dès la revue P0) |

## 2. Pourquoi c'est un problème maintenant

1. **Vol XSS local** : un seul script malveillant lit le localStorage et repart
   avec 7 jours de session. P3-A borne le risque (réutilisation détectée →
   famille révoquée) mais ne l'élimine pas : le voleur qui utilise le token
   *avant* son propriétaire ne déclenche rien.
2. **Multi-tab devenu critique** : depuis P3-A, deux refresh concurrents du
   même token → le perdant décrète la famille compromise → **quarantaine**.
   Trois onglets qui expirent ensemble tueraient la session d'eux-mêmes.
   Le verrou inter-onglets n'est plus un confort : c'est un prérequis.
3. `logout-all` existe côté API mais n'est exposé nulle part côté UI.

## 3. Architecture cible (décision)

```text
Navigateur                    API
   │
   ├── access token ──────────> Authorization: Bearer (mémoire JS, 15 min)
   │
   └── cookie bdri_rt ────────> HttpOnly + Secure(prod) + SameSite=Strict
        (refresh, 7 j)             + Path=/api/auth   ← seuls login/refresh/logout le portent
```

- **HttpOnly** : le JavaScript n'a plus accès au refresh token — la surface XSS
  sur la session tombe à « voler l'access de 15 min en mémoire ».
- **Path=/api/auth** : le cookie n'est même pas transmis aux endpoints métier.
- **SameSite=Strict** : le cookie n'est jamais envoyé sur une requête
  cross-site — la prime au CSRF sur `/auth/*` disparaît avant toute validation
  d'origine (§5 du rapport final).
- **Secure** en production uniquement (Traefik termine le TLS ; en dev, le proxy
  Vite rend la navigation same-origin `http://localhost` — un cookie `Secure` y
  serait silencieusement ignoré).

## 4. Migration des sessions existantes (stratégie douce)

Le backend accepte **les deux transports** pendant la transition :

| Client | Refresh envoyé | Réponse | Effet |
|---|---|---|---|
| ancien (localStorage) | body `{refreshToken}` | body `{refreshToken}` **+ cookie posé** | la session **migre en cookie** au premier refresh |
| nouveau (cookie) | cookie seul (body vide) | `{accessToken}` **sans refresh dans le body** | le brut n'est plus jamais exposé au JS |

Le nouveau frontend, au démarrage : si un ancien token dort en localStorage, il
sert **une seule fois** à migrer la session (refresh → cookie), puis la clé est
purgée. **Aucune reconnexion générale n'est nécessaire** ; aucun ancien client
n'est cassé (il continue en body jusqu'à sa prochaine mise à jour).

## 5. Points analysés pour ne pas casser l'existant

| Sujet | Analyse |
|---|---|
| Vite dev | proxy `/api` → same-origin pour le navigateur → `SameSite=Strict` fonctionne en dev ; `Secure` omis hors production |
| Traefik prod | TLS terminé en amont ; Express voit du HTTP — `secure` du cookie est un attribut de réponse, pas une détection : piloté par `NODE_ENV` |
| CORS | déjà origine unique + credentials — aucun `*` : conforme au passage cookie (§17) |
| SharePoint embed | page frontend seule ; l'API reste `frame-ancestors 'none'` ; en-têtes à ajouter côté nginx frontend (§18 du rapport final) |
| Multi-device | familles indépendantes (P3-A) ; le cookie est par navigateur — inchangé |
| Fermeture/réouverture | le cookie survit (7 j) → session restaurée sans saisiser à nouveau — amélioration |

**Statut** : comportement actuel MEASURED (code cité) ; cible et migration définies, implémentées dans la suite de P3-B.

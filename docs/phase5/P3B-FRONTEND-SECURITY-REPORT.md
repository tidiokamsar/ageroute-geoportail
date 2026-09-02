# Rapport P3-B — Sécurité du transport des sessions + consolidation frontend

**Branche** : `phase5` · **Base** : P3-A `5e3fead` · **Date** : 2 septembre 2026
**Production** : NON TOUCHÉE · **Aucune migration de base nécessaire** (transport uniquement)
**Audit préalable** : `P3B-TRANSPORT-AUDIT.md`

---

## Transport avant → après

| | Avant | Après |
|---|---|---|
| Refresh chez le client | `localStorage["bdri_refresh_token"]` (lisible par tout script) | **cookie `bdri_rt` HttpOnly** — invisible du JavaScript |
| Refresh vers l'API | body JSON | cookie (Path=/api/auth) ; body accepté pour les anciens clients |
| Access token | mémoire JS (15 min) | inchangé |
| Attributs | — | `HttpOnly; Secure (prod); SameSite=Strict; Path=/api/auth; Max-Age=7 j` |
| Réponse du refresh | `{accessToken, refreshToken}` | flux cookie : `{accessToken}` **seulement** — le brut ne repasse jamais par le JS |

## CSRF

`HttpOnly` n'est **pas** une protection CSRF. Défense en profondeur :
1. **SameSite=Strict** : un navigateur sollicité cross-site n'envoie pas le cookie — la prime au CSRF sur `/auth/*` disparaît à la source ;
2. **Validation d'origine** (`middleware/origin.middleware.ts`) sur tout `/api/auth` : `Origin` présent et ≠ origine autorisée → **403** ; `Origin` absent (clients non-navigateurs, tests) → autorisé ;
3. Rate-limit login/refresh déjà en place (P0/P3-A).

Testé : origine autorisée → passe ; origine inconnue → 403 sans exécution ; `Origin` absent → passe ; liste CORS multi-origines gérée.

## Cookies — choix argumentés

- `Secure` **seulement en production** : en dev, le proxy Vite rend la navigation same-origin en `http://localhost`, où un cookie `Secure` serait silencieusement ignoré (piloté par `NODE_ENV`, documenté) ;
- `Path=/api/auth` : le cookie n'est même pas transmis aux endpoints métier ;
- `SameSite=Strict` (et non `Lax`) : le refresh ne doit jamais partir d'une navigation entrante ;
- un **marqueur non sensible** (`bdri_sess=1`, lisible) évite les refresh condamnés au démarrage pour les visiteurs anonymes.

## CORS (§17)

`origin: env.CORS_ORIGIN` explicite (jamais `*`) + `credentials: true` — inchangé et conforme au cookie. Frontend en `withCredentials: true` explicite. Origines testées via la validation d'origine (voir CSRF).

## Sessions — migration douce (§6)

| Client | Comportement |
|---|---|
| ancien (localStorage) | refresh en body → réponse complète **+ cookie posé** : la session **migre** au premier refresh, puis la clé localStorage est purgée par le nouveau client |
| nouveau (cookie) | cookie seul ; réponse sans refresh dans le body |
| navigateur fermé/réouvert | le cookie (7 j) restaure la session sans ressaisie — amélioration |

**Aucune reconnexion générale.** Le token reste dans le body de `/login` pendant la transition (visible une fois au login, jamais stocké) — son retrait complet est une décision post-transition, documentée au §Risques.

## Multi-tab (§9)

Devenu **critique** depuis P3-A (deux refresh concurrents = famille révoquée). Le verrou est la **Web Locks API** (`navigator.locks.request('bdri-refresh')`) : partagé entre onglets du même navigateur — trois onglets qui expirent ensemble produisent **un seul** refresh ; les autres attendent le verrou, retrouvent l'access token déjà frais (double-check) et ne relancent rien. Repli sans Web Locks : verrou par onglet (partage de promesse). Testé : sérialisation (jamais deux refresh parallèles), double-check (zéro appel réseau superflu), délégation et repli.

## Interceptors (§8)

Réécrits (`lib/api.ts` + logique pure `lib/session.ts`) : un seul refresh par onglet (partage de promesse), verrou inter-onglets autour, **retry strictement unique** par requête (`_retried` — pas de boucle 401→refresh→401), déconnexion vers `/login` si le refresh échoue, `withCredentials`. Le code métier ne voit jamais le refresh token (aucune fonction ne l'expose).

## localStorage refresh token (§10)

**0 occurrence d'écriture** après migration (grep produit dans le rapport d'exécution) : `session.ts` ne fait que lire/purger `bdri_refresh_token` pour la migration. Aucune nouvelle écriture en localStorage/sessionStorage/IndexedDB.

## EntityListPage (§11) — REPORTÉ, décision argumentée

**Audit (mesuré)** : le composant générique (380 l., jamais importé) duplique le pattern de 9 pages de listes (~3 500 lignes : pagination, tri, filtres, modale CRUD, bulk, audit, import/export). Les invariants SONT réels.

**Décision de reporter la migration** : (1) aucune suite E2E n'existe pour garantir la non-régression de 9 pages métier rewritées d'un coup ; (2) la P3-B touche déjà la couche d'authentification de toutes les pages — mélanger les deux rendrait un éventuel défaut indiagnosticsable ; (3) les pages fonctionnent (le composant mort n'ajoute aucun risque d'exécution). **Plan** : migration page pilote (PostesPage, la plus simple) en P4 avec E2E Playwright sur liste+filtre+CRUD, puis déroulé progressif. La suppression du composant si la consolidation est refusée reste l'alternative documentée.

## Anti-perte de saisie (§12) — OK

`Modal` accepte `sale()` (formulaire modifié) : fermeture par Esc/clic extérieur déclenche « Des modifications n'ont pas été enregistrées… ». Branché sur `EntityListPage` via `EntityForm.onDirtyChange` (react-hook-form `isDirty`, reset async des selects inclus). `window.confirm` assumé dans `Modal` (base de `useConfirm` — une confirmation stylée y serait récursive).

## Quick edits (§13) — OK

Les 4 quick-edits du `DetailPanel` géoportail (état tronçon, statut/avancement chantier, signaler un chantier, édition tronçon) : **try/catch + toast d'erreur explicite**, succès confirmé, **saisie conservée en cas d'échec** (récupération claire). Champs simples et non ambigus uniquement ; permissions et audit côté serveur (déjà en place). Les quick-edits restants (drafts non purgés au changement de sélection) sont notés au §Risques.

## Tests (§15)

- **Backend 244/244** (13 nouveaux : attributs exacts du cookie, flux cookie sans brut au body, flux body de transition + migration, 401 sans cookie, cookie effacé sur refus/logout/logout-all, Origin permise/interdite/absente, 2FA) ;
- **Frontend 57/57** — 7 nouveaux (`session.test.ts` : retry unique, payload de migration, dégradé sans stockage, sérialisation du verrou, double-check inter-onglets, délégation/repli Web Locks) **+ 50 tests préexistants (Phase 4) exécutés pour la première fois** : vitest n'était pas installé côté frontend — il l'est désormais, script `npm test` + CI ;
- navigation/listes : couverture par typecheck + tests logique ; E2E : **aucune infra existante — non créée** (règle §16), planifiée avec la consolidation EntityListPage ;
- régression : 231/231 backend avant → 244/244 ; 0 test supprimé/modifié pour passer.

## Headers (§18)

`frontend/nginx.conf` : `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` (géolocation conservée pour l'inspection terrain), **CSP** (script-src 'self' ; style-src 'unsafe-inline' requis par le bundle actuel — levée future documentée), `frame-ancestors 'none'` partout **sauf `/embed/`** restreint à `https://*.ageroute.gov.gn` (embed SharePoint préservé — domaine exact à confirmer par AGEROUTE). Syntaxe validée (`nginx -t` en conteneur). L'API garde helmet (P0) — inchangée.

## Risques résiduels

1. `refreshToken` encore présent dans le body de `/login` (transition) — retrait quand tous les clients sont à jour ;
2. `style-src 'unsafe-inline'` (CSP) — levée = chantier bundle, post-P3 ;
3. drafts du `DetailPanel` non réinitialisés au changement d'objet sélectionné (contamination A→B possible) — détecté en revue, fix trivial mais UI : P4 avec les quick-edits restants ;
4. sans Web Locks (très vieux navigateurs), le verrou retombe par onglet — le serveur (P3-A) contient alors le doublon par la quarantaine de famille.

## Déploiement / rollback (aucun effectué)

**Déploiement** (après validation) : déployer backend puis frontend (cet ordre : le backend accepte les deux transports, donc aucun ordre ne casse — mais backend d'abord garantit le cookie dès la première connexion du nouveau frontend). Aucune migration de base.
**Rollback** : redéployer les images précédentes ; les sessions créées en cookie deviennent inutilisables pour l'ancien frontend (reconnexion des sessions ouvertes pendant la période) — les sessions antérieures (body/localStorage) n'ont jamais cessé de fonctionner.

## Tableau de sortie

| Élément | Résultat |
|---|---|
| Refresh token HttpOnly | **OK** |
| Secure/SameSite | **OK** (Strict ; Secure en production — dév documenté) |
| CSRF | **OK** (SameSite=Strict + validation Origin testée) |
| CORS | **OK** (origine explicite + credentials, jamais `*`) |
| Multi-tab | **OK** (Web Locks + double-check, testé) |
| Interceptor | **OK** (refresh unique, retry unique, pas de boucle) |
| localStorage refresh token | **0 écriture** (lecture/purge de migration uniquement) |
| EntityListPage | **REPORTÉ** (audit mesuré + plan P4 argumentés) |
| Anti-perte saisie | **OK** (Modal + EntityForm, branché sur les listes) |
| Quick edits | **OK** (4 fixes toast/récupération ; résidus documentés) |
| Backend tests | **244/244** |
| Frontend tests | **57/57** (dont 50 préexistants désormais exécutés) |
| Build | **VERT** (backend + frontend) |
| CI | **VERT** (tests frontend ajoutés au workflow) |
| Production | **NON TOUCHÉE** |

> **P3-B SÉCURITÉ TRANSPORT + FRONTEND PRÊT POUR VALIDATION — PRODUCTION NON TOUCHÉE**

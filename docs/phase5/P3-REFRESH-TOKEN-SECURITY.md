# Sécurité des refresh tokens — P3-A

**Branche** : `phase5` · **Date** : 2 septembre 2026
**Production** : NON TOUCHÉE · **Migration** : `20260902150000_p3a_refresh_token_security`, testée sur copie de production avec preuve de survie des sessions et rollback validé, NON DÉPLOYÉE.
**Sorties brutes** : `donnees/p3a-integrity-check.txt`

---

## Architecture actuelle (audit avant code)

Le cycle était : login → JWT access 15 min + refresh JWT 7 j stocké **en clair**
(`token TEXT UNIQUE`, le brut étant la clé de recherche) ; rotation = transaction
[update `revoked:true` + create nouveau] ; rejeu d'un token révoqué → simple 401
**sans conséquence** ; logout → updateMany par token ; reset password → updateMany
par utilisateur ; **verrouillage et désactivation ne révoquaient rien** ; refresh
et logout n'étaient **jamais journalisés** ; transport : body JSON, stockage
`localStorage` côté frontend.

Faiblesses : (1) une lecture de base livre des sessions utilisables ; (2) un vol
de token est indétectable — l'ancien token rejeuée n'invalide pas sa descendance ;
(3) rotation non verrouillée : deux requêtes concurrentes sur le même token
produisent toutes deux un nouveau token ; (4) compte verrouillé/désactivé = sessions
refresh vivantes jusqu'à 7 jours.

## Architecture finale

```text
LOGIN → access JWT (15 min, mémoire client) + refresh JWT brut (7 j)
                          │ le brut ne vit QUE chez le client
                          ▼
        base : tokenHash = SHA-256(brut)  [clé de recherche, unique]
               familyId  = racine émise au login
               revokedAt, replacedById, reuseDetectedAt

REFRESH(brut) ── transaction ────────────────────────────────
  1. vérifier signature JWT
  2. retrouver la ligne par empreinte          (Index Scan unique, mesuré)
  3. revoquee ?  → REUSE: révocation de la FAMILLE + SECURITY_EVENT + 401
  4. expirée ?   → 401 (famille intacte : vieillir n'est pas voler)
  5. userId ≠ sub déclaré ? → REUSE (falsification) → famille + 401
  6. compte inactif / verrouillé ? → famille révoquée + 401
  7. VERROU : updateMany { id, revokedAt: NULL } → { revokedAt, replacedById }
       count=0 → une requête concurrente vient de gagner → REUSE → famille + 401
  8. créer le nouveau token (même famille)     ← strictement un seul gagnant
```

## Hash

**SHA-256, sans sel, sans Argon2** — justification (`utils/tokens.ts`) : le
refresh token est un JWT signé à haute entropie (>256 bits), pas un secret
humain ; le dictionnaire n'existe pas contre lui, la lookup par empreinte doit
être rapide (Argon2 est lent par conception), et des tokens uniques ne se
croisent pas entre lignes (le salage n'apporte rien). Traitement standard des
bearer tokens au repos. Le brut n'apparaît ni en base, ni en logs, ni en audit,
ni dans les réponses autres que le transport vers son propriétaire (§19 vérifié).

## Familles

`familyId` = identifiant du token racine émis au login. Toute la chaîne de
rotation d'une session partage cette famille. Question du cadrage : « quel token
a été présenté / de quelle famille / déjà remplacé / révoqué / réutilisation ? »
→ `id`, `familyId`, `replacedById`, `revokedAt`, `reuseDetectedAt` répondent
directement en base.

## Réutilisation

Un token **révoqué** qui se représente = signature de vol (le client légitime
l'a remplacé) **ou** de course légitime (double-clic, retry réseau) — les deux
sont indiscernables, donc les deux subissent le même traitement : **révocation
de la famille entière** + audit `SECURITY_EVENT` (`evenement: REFRESH_TOKEN_REUSE`,
avec userId, familyId, tokenId, IP) + 401 uniforme.
Portée précise : **la famille, jamais le compte** — les autres sessions (autres
appareils) survivent. Le frontend déduplique déjà ses refresh concurrents
(partage de promesse), le coût usager d'une course est donc rare et borné à une
reconnexion.

## Révocation — matrice documentée et implémentée

| Événement | Token | Famille | Autres sessions de l'utilisateur |
|---|---|---|---|
| Logout (`/logout`) | révoqué | intactes | intactes |
| Logout all (`/logout-all`, nouveau) | toutes | toutes | toutes |
| Réutilisation détectée | — | **révoquée** | intactes (autres familles) |
| Mot de passe changé (`resetPassword`) | toutes | toutes | toutes (inchangé depuis l'origine, désormais journalisé) |
| Compte verrouillé (5 échecs login) | toutes | toutes | toutes — **nouveau** |
| Compte désactivé (`actif:false`) | toutes | toutes | toutes — **nouveau** (au moment de la désactivation ET au refresh) |

## Concurrence

Le verrou est la mise à jour conditionnelle (`UPDATE … WHERE id = X AND
revokedAt IS NULL`) : sous READ COMMITTED, exactement une des requêtes
concurrentes obtient `count=1` et le nouveau token ; l'autre obtient `count=0`,
est traitée comme réutilisation, et **révoque la famille — y compris le token
frais du gagnant** : le prochain refresh impose une reconnexion. Déterministe,
vérifié par TEST 9 (`Promise.allSettled` → exactement un gagnant). Choix assumé :
mieux vaut une reconnexion qu'un token volé actif.

## Cookies / transport (audit §12)

Transport inchangé : refresh dans le **corps JSON**, côté client en
`localStorage`. Un cookie `HttpOnly; Secure; SameSite=Strict` posé par l'API
éliminerait la surface XSS locale — mais exige des changements frontend (CORS
credentials déjà prêt, `credentials: true`) que l'environnement local actuel ne
permet pas d'éprouver (node_modules verrouillé). **Risque résiduel documenté,
chantier P3-B** : le vol XSS du refresh reste possible, désormais **borné** par
la détection de réutilisation (un token volé utilisé après son propriétaire tue
la famille). Vite dev proxy, Traefik et l'API publique sont sans impact (le
cookie n'existe pas encore).

## Migration (§16)

`20260902150000_p3a_refresh_token_security` — éprouvée sur copie de production
(`bdri_20260902_030001`, 646 tokens dont 49 actifs) :
- empreintes calculées depuis la colonne claire **avant** sa suppression →
  **preuve de survie** : l'empreinte du token témoin est retrouvée, aucun
  changement d'état (49 actifs avant/après) ;
- intégrité métier : tronçons/chantiers/ouvrages/users identiques ;
- perf (§18) : lookup `tokenHash` = **Index Scan unique** ; révocation de
  famille = parcours indexé (`familyId_idx`) — indexes démontrés par EXPLAIN
  ANALYZE, créés par la migration qui les justifie ;
- **rollback testé** : il invalide toutes les sessions (la colonne claire est
  irrécupérable depuis les empreintes) → reconnexion générale. Coût assumé et
  documenté d'une migration de sécurité. La valeur d'enum `SECURITY_EVENT`
  reste en base après rollback (PostgreSQL ne retire pas une valeur d'enum) —
  inerte pour l'ancien code.

## Compatibilité (§17)

- Frontend : contrat `/refresh` et `/logout` inchangé ; `/logout-all` est un
  ajout. Le champ `refreshToken` renvoyé au login/refresh est identique.
- **Aucune invalidation de session au déploiement** (preuve de survie ci-dessus).
- Multi-device : chaque login crée sa famille ; le logout d'un appareil ne
  touche pas les autres (TEST 7/8).
- Purge (§11) : non codée — table aujourd'hui 646 lignes ; les tokens révoqués
  expirés deviennent purgeables après la période d'audit d'incident (à définir
  avec la politique de rétention P2-05).

## Tests (§14) — 14 tests couvrant les 16 scénarios

TEST 1 à 16 (certains fusionnés) dans `src/modules/auth/refresh.security.test.ts`,
dont : cycle complet, rotation, réutilisation détectée, famille révoquée, token
B compromis refusé, expiration sans fausse alerte, logout ciblé, **concurrence à
exactement un gagnant**, falsification inter-utilisateur, **base compromise
inutilisable** (l'empreinte n'est pas un token), **aucun brut en logs ni en
audit**, révocation administrative, mot de passe, verrouillage (au login ET au
refresh), désactivation. Suite totale : **231/231** (217 avant + 14).

## Risques résiduels

1. `localStorage` côté client (→ P3-B cookie HttpOnly) ;
2. pas de purge automatique des tokens expirés révoqués (volumétrie faible) ;
3. concurrence gagnant-perdant : le gagnant voit sa famille quarantaine par le
   perdant — reconnexion requise (choix de sécurité documenté) ;
4. `reuseDetectedAt` posé à NULL dans la migration ; la colonne sera peuplée par
   la première détection réelle (les rejeux avant P3-A n'étaient pas détectables).

> **P3-A REFRESH TOKENS PRÊT POUR VALIDATION — PRODUCTION NON TOUCHÉE**

# LOT 1 : session hors ligne, qualité des données, contrôles d'accès, sauvegardes et dérive

Date : 27/10/2026. Branche : `lot/03-map-matching`. Commit de départ : `dad9695`. Commits du lot : `65bb346` (session hors ligne côté client), `a98252c` (serveur : accès, appareils, droits), `c846fdf` (qualité, dérive, restauration, migration), `d8f092b` (lots d'import, voir `LOT-UX-IMPORTS-RAPPORT.md`), `e9fd62c` (jeton de test), `1af3e6e` (relevés envoyés, autre session, hors de ce lot), `ada84d4` (tests de bout en bout et rapports), `4ca04f4` (correctifs E2E-5 et effacement local), puis le commit des corrections finales (E2E-3, README e2e, rapports). Rapport destiné à la revue de l'architecte de supervision (ChatGPT).
Les chiffres viennent de commandes exécutées les 25 et 26/10/2026 ; ce qui n'a pas été exécuté est dit « non vérifié ». **Rien n'est déployé.** Le parcours de bout en bout (Playwright, navigateur réel) est en section D.5.

## A. Résumé exécutif

**Objectif (validation architecturale du 25/10).** Décision 1 : une session locale préalablement authentifiée, chiffrée, liée à l'appareil et au compte, de durée limitée, sans jeton réseau longue durée. Décision 2 : comptes séparés sur téléphone partagé, aucune suppression des données d'un autre compte, vérification des saisies en attente avant toute suppression locale. Décision 3 : auditer et corriger les contrôles d'accès côté serveur. Décision 4 : trois chantiers parallèles (A tests de bout en bout, B qualité des données, C accès, sauvegardes, dérive).

**Résultat.**
- La **session hors ligne** est conçue (`docs/securite/SESSION-HORS-LIGNE.md`), implémentée (noyau pur, coffre WebCrypto, bases IndexedDB par compte chiffrées, écrans de PIN, de déverrouillage, de déconnexion, de réinitialisation et d'effacement, service worker avec précache) et relue deux fois par des agents indépendants (cryptographie, intégration client), puis corrigée.
- Les **défauts serveur** de l'analyse de sécurité sont corrigés : compte désactivé refusé immédiatement, rôle lu en base, appareil révoqué sans ré-enregistrement automatique, **course révocation/rotation fermée** (48 jetons vivants sur 100 essais avant, 0 sur 100 après), refus de droits tracés et mis en quarantaine, journal d'événements locaux borné et idempotent.
- Les **contrôles d'accès** (ordres de travaux, missions, programmation, moteur, observations, défauts, `sync/pull`) sont corrigés et prouvés par un banc PostGIS qui a échoué sur le code d'avant (35/74) et passe après (81/81).
- La **qualité des données** : 26 détecteurs en lecture seule avec banc PostGIS (98/98) et audit de 29 scripts d'écriture sans journal (le Lot 0 en annonçait 11).
- **Dérive du schéma et sauvegardes** : un outil de dérive, une preuve de restauration reproductible (83 tables identiques, 24 colonnes géométriques identiques), un plan de montée des dépendances.

**État global : terminé sur ce qui est vérifiable ici, ouvert sur le reste.** Les critères de sortie de l'architecte sont tenus dans l'environnement de développement : parcours terrain reproductibles (deux passages complets consécutifs verts), coupures réseau et synchronisations répétées, comptes partagés, expiration et horloge, compte désactivé et appareil révoqué, conservation des données au verrou et à la déconnexion, détecteurs en lecture seule, scripts audités, contrôles d'accès documentés. **Non vérifié et non vérifiable ici** : WebView Android de l'APK, appareil réel, Safari, Firefox, vrai nginx, production (section E). Défaut produit ouvert : E2E-4 (réponse perdue d'un rafraîchissement rotatif).

## B. Travail des agents

Aucun résultat d'agent n'est tenu pour acquis : chaque rapport a été recoupé par les suites complètes (D.1 à D.4) et, pour les changements sensibles, par un second agent indépendant.

| Rôle | Tâche | Fichiers principaux | Vérification |
|---|---|---|---|
| Analyse sécurité, frontend, stockage et tests (3, lecture seule) | Architecture existante de la session, menaces, stockage local, stratégie de tests | aucun | rapports recoupés dans la conception |
| Orchestrateur | Conception arrêtée (`SESSION-HORS-LIGNE.md`), arbitrages, intégration, suites complètes, bancs, rapports | docs, petits correctifs | D |
| A | Harnais Playwright (clone de base, API et Vite, profils persistants) puis seconde phase : session, imports | `e2e/`, `docs/e2e/` | D.5 |
| B | 26 détecteurs de qualité en lecture seule, audit des scripts d'écriture | `backend/src/qualite/`, `docs/qualite/`, `scripts/lib/audit-script.ts` | 163 tests Vitest ; banc 98/98 ; 3 mutations tuées |
| C1 | Contrôles d'accès serveur, matrice de 323 routes | `middleware/territoire*`, OT, missions, programmation, moteur, observations, défauts, `sync` | banc 35/74 avant, 81/81 après |
| C2 | Dérive schéma, sauvegarde/restauration, vulnérabilités | `scripts/verifier-derive-schema.ts`, `infra/verifier-restauration.sh`, `docs/securite/*` | 40 tests ; restauration exécutée |
| D1, D1b | Noyau de session, coffre AES-GCM/PBKDF2, issue typée du rafraîchissement ; correctifs après revue | `frontend/src/session/*`, `lib/api.ts` | 281 tests de session ; 60 mutations sur 60 tuées |
| Relecteur cryptographique (indépendant) | Dérivation, nonces, métadonnées, concurrence, 15 mutations | lecture | 3 défauts élevés trouvés (concurrence) |
| D2 | Bases par compte, chiffrement des files, quarantaine, migration de l'héritage | `offlineDb.ts`, `roulageHote.ts`, `compteCourant.ts`, `migrationHeritage.ts` | 519 tests ; rien en clair dans le stockage brut |
| D3a, D3b | Intégration (auth, route protégée, écrans) ; pages de terrain | `useSessionLocale.tsx`, `auth.tsx`, `components/session/*`, pages terrain | 540 puis 730 tests |
| D5 | Service worker avec précache (133 fichiers, 5 805 Ko) | `sw.js`, `sw-policy.js`, plugin Vite | 83 tests ; essai Chromium réel hors ligne |
| D4, D4b, D9 | Défauts serveur de compte et d'appareil ; alignement des bancs ; correctifs de revue | `auth.middleware.ts`, `devices.routes.ts`, `sync.*`, `evenements-locaux.ts` | bancs session-appareil 75/75 |
| Relecteurs indépendants serveur et client | Contournements, régressions, attaques exécutées | lecture | serveur : 1 défaut élevé (course) ; client : 4 défauts élevés |
| D6, D7, D8, D8c, D8d | Client de synchronisation, interface des états, correctifs de revue client | `offlineSync.ts`, `BandeauSynchronisation.tsx`, pages | 201 puis 359 puis 767 tests ciblés |

Un agent d'une autre session a modifié en parallèle des pages que traitait D8 ; ses modifications ont été réconciliées par D8, aucun fichier d'agent arrêté n'est resté orphelin.

## C. Changements réalisés

**Session hors ligne (client).** États `DECONNECTE`, `EN_LIGNE`, `HORS_LIGNE_OUVERT`, `HORS_LIGNE_VERROUILLE`, `EXPIRE`, `FERME` calculés par un noyau pur à horloge injectée. Coffre : clé de données AES-GCM 256 enveloppée par une clé PBKDF2-SHA256 dérivée du PIN, verrou par compte (Web Locks, repli en mémoire), compteur d'essais persistant, aucune destruction automatique. Paramètres PROVISOIRES : 7 jours de validité, 5 minutes d'inactivité, 2 minutes d'arrière-plan, 600 000 itérations, plafond de 30 minutes pour l'activité d'un relevé en roulant. Files (4) et journal de roulage chiffrés, une base par compte, migration de l'héritage sans attribution automatique (quarantaine). La déconnexion n'efface rien ; la réinitialisation du PIN et l'effacement local sont des actes distincts, confirmés et journalisés ; l'effacement est refusé tant qu'une saisie, un relevé en cours ou une saisie refusée pour droits existe. Canal inter-onglets, cache React Query vidé à chaque sortie de session.

**Hors ligne à froid.** Service worker avec précache généré à la construction, installation atomique, pas de `skipWaiting`, jamais d'`/api/` en cache ; manifeste de précache servi sans cache (`nginx.conf` : `Cache-Control: no-cache` sur quatre fichiers).

**Serveur.** `requireAuth` relit le compte en base (une lecture par appel authentifié, 7 à 15 ms mesurées sur le poste de développement) : `COMPTE_INACTIF`, rôle courant, 503 si la base ne répond pas sous 3 s. Révocation d'appareil : coupe toutes les familles de rafraîchissement du propriétaire, atomique, verrou de ligne ; refus d'un appareil neuf pendant la durée du jeton d'accès (`APPAREIL_REVOCATION_RECENTE`). Synchronisation : `DROITS_MODIFIES` avec cause, trace durable caviardée (au plus 20 par appel), quarantaine côté client. Route `POST /api/auth/evenements-locaux` (5 lots par 15 minutes, 500 lignes par jour par compte). `GET /auth/me` renvoie régions et périmètre. Jeton de rafraîchissement avec `jti`.

**Accès.** Territoire masqué (404 indiscernable, statut et corps) sur OT, missions, programmation, moteur ; lectures filtrées ; garde de rôle des inspections corrigée (défaut révélé par le test de bout en bout : un INSPECTEUR recevait 403 sur sa propre saisie).

**Qualité et dérive.** Voir A. **Migration** `20261027110000_composante_rci_valeurs` (valeurs `ENVIRONNEMENT` et `AUTRES` de `ComposanteRci`, idempotente, descente testée 4/4) ; `deployer-console.sh` attend 2 migrations.

**Corrections diverses.** `national=false` lu comme vrai (3 routes) ; 401 de connexion traité comme jeton expiré (le message d'erreur du formulaire disparaissait) ; marqueur de déplacement d'ouvrage sans icône explicite avec la feuille Leaflet locale ; Dabola corrigé (10,75).

## D. Vérifications (exécutées le 26/10/2026 sur l'arbre courant)

| Contrôle | Résultat |
|---|---|
| Backend, suite complète (état commité `ada84d4`, y compris le balayage de secrets qui ne lit que les fichiers suivis) | 191 fichiers, **3 308 tests réussis** |
| Frontend, suite complète (27/10, après les derniers correctifs) | 153 fichiers, **3 067 tests réussis**, 1 sauté (mesure de débit, optionnelle) |
| `tsc --noEmit` backend et frontend | aucune erreur |
| ESLint frontend | 0 erreur, 5 avertissements d'hooks React préexistants |
| Build de production frontend | réussi (précache 133 fichiers) |
| Bancs PostGIS | 34 sur 36 verts ; voir D.4 |

**D.4 Bancs.** Tous verts : trace, métadonnées, géométries invalides, contour, déviation, graphe, info-route, patrouilles, veille, chemin, historique, photos-observation, qualité-détecteurs (98/98), curseur, programmation (106), ppe (80), outbox (90), roulage (50), sync (67), conflits-sync (43), import (39), imports-api (72), métré-défaut (73), contour-terrain, tâches internes, unaccent, qualité-géométries, territoire (97), controle-acces (81), session-appareil (75), info-route-délai, incident-hors-ligne, correspondances. **Deux bancs échouent pour une cause externe identifiée, non pour une régression** : `teledetection` et `tableau-de-bord` lèvent `column earth_observation_products.sourceCode does not exist`. Le client Prisma partagé (`node_modules/.prisma/client`) a été régénéré par l'autre session (chantier Observation de la Terre) à partir d'un schéma sur-ensemble ; la base `replay` ne porte pas cette colonne. Ces deux bancs passaient lors du Lot 0 ; ils seront rejoués après régénération du client depuis le schéma de ce dépôt (concertation avec l'autre session requise, je n'ai pas régénéré).

**D.5 Parcours de bout en bout (Playwright, Chromium 1243, un worker, pile et base neuves à chaque passage).** Deux passages complets consécutifs de `npm run test:e2e`, sans mode réutilisation : passage 1 : **57 passés, 0 échec, 0 instable** (21,0 min murales : projet dev 54 tests en 16,9 min, projet build avec service worker 3 tests en 54 s) ; passage 2 : **57 passés, 0 échec, 0 instable** (21,3 min). Un seul test en échec attendu dans ces passages (E2E-3), corrigé depuis et vérifié seul (1 passé). Couverture : connexion et cookie de session, saisie en ligne, observation et inspection hors ligne puis synchronisation sans doublon, idempotence (réponse perdue, rejeu), coupure en plein envoi, photo (empreinte vérifiée en base), file qui survit au rechargement et au redémarrage, deux comptes sur un appareil, fichiers chiffrés (rien de lisible en clair dans IndexedDB), ouverture hors ligne à froid avec service worker (rechargement, redémarrage du navigateur, mauvais PIN, bon PIN hors ligne, retour du réseau, une seule ligne en base), PIN faux et délais, expiration à 7 jours et horloge reculée, verrou d'inactivité et d'arrière-plan, déconnexion qui n'efface rien, réinitialisation du PIN, effacement local refusé tant que la file n'est pas vide, compte désactivé pendant que l'agent est hors ligne, appareil révoqué (aucun ré-enregistrement), droits retirés (quarantaine), parcours Lots d'import (voir l'autre rapport). **Défauts révélés par ces tests** : E2E-1 (mauvais mot de passe sans message), E2E-2 (INSPECTEUR refusé sur sa propre inspection), E2E-3 (champs de connexion sans étiquette), E2E-5 (bon PIN hors ligne renvoyé vers `/login`) : **tous corrigés** ; E2E-4 (réponse perdue d'un rafraîchissement rotatif ferme la famille de jetons) : **ouvert**. L'agent de recette a aussi trouvé que le test de réinitialisation du PIN échouait par un état partagé (plafond de 5 lots par 15 minutes et par compte atteint au milieu de la batterie), pas par un défaut du produit : réglé par une remise à zéro du compteur sur un port de contrôle réservé au processus de test. **Non testé** : WebView Android, Safari et WebKit, Firefox, nginx réel (un serveur statique en reproduit les règles), GPS réel, réseau lent ou portail captif, mise à jour du service worker en production, plusieurs onglets réels.

## E. Risques et limites

1. **Rien n'a été éprouvé sur un appareil réel ni dans la WebView Android de l'APK** (service worker, démarrage à froid, `CryptoKey` après arrêt du processus, quota, persistance, performance PBKDF2). L'APK charge le site distant (`server.url`), réglage que Capacitor décrit comme destiné au développement.
2. **Le chiffrement local ne protège pas** contre une XSS, un appareil compromis, une copie de la base avec du temps de calcul ; un PIN de 6 chiffres représente environ 14 jours de calcul sur un cœur du poste de mesure (ordre de grandeur, non représentatif d'un GPU ni d'un téléphone). Un PIN oublié fait perdre les saisies non synchronisées (réinitialisation confirmée).
3. **Fenêtre résiduelle** de 15 minutes : le jeton d'accès d'un téléphone révoqué reste valable ; fermée seulement par un lien appareil-session (migration non faite) ou par un jeton plus court.
4. Le verrou **masque** l'interface (inert) ; il ne purge pas le DOM ni la mémoire JavaScript.
5. Pas de contrôle territorial ni de module sur les routes d'import (décision DSI) ; contrôles V1 de lecture voulus pour le patrimoine ; champs financiers des chantiers lisibles par tout compte connecté (D-C1-1).
6. 29 scripts d'écriture sans audit ; 8 écrivent dès qu'on les lance ; 3 importent `xlsx`, retiré du projet. Propositions de diffs dans `docs/qualite/AUDIT-SCRIPTS-ECRITURE.md`, non appliquées.
7. Dérive : 87 écarts connus entre schéma et chaîne de migrations (modèle `LimiteAdmin` absent, 8 clés étrangères RESTRICT, etc.), CI jamais exécutée.
8. Sauvegardes : clé de chiffrement en un seul exemplaire ; alertes sans destinataire ; RPO, RTO, rétention « à décider » ; production non vérifiée.
9. Dépendances : 20 vulnérabilités backend, 22 frontend (aucune montée exécutée).
10. Deux bancs rouges pour cause d'environnement (D.4).
11. **E2E-4 ouvert** : si la réponse d'un rafraîchissement rotatif est perdue (rechargement juste au retour du réseau), le cookie tourné est perdu, le rafraîchissement suivant est refusé et la famille de jetons est fermée : l'agent est déconnecté. Défaut produit réel, touchera surtout les utilisateurs mobiles.
12. Le plafond du journal d'événements locaux (5 lots par 15 minutes) laisse un événement en attente jusqu'au prochain déclencheur (connexion, rafraîchissement en ligne, retour du réseau) quand le serveur répond 429 ; il n'y a pas de reprise temporisée.
13. Le disque externe F: du poste de développement s'est démonté trois fois (14/10, 15/10, 26/10) pendant des exécutions longues ; aucun fichier commité n'a été perdu, mais les exécutions de bout en bout complètes ne sont fiables que sur secteur, veille interdite.
14. Une autre session a livré en parallèle la consultation « Relevés envoyés » (commit `1af3e6e`) ; elle ne fait pas partie de ce lot.

## F. Mesures

PBKDF2 600 000 itérations : médiane 1 199 ms sur Core i7-8650U (28 mesures de 574 à 2 290 ms, poste en usage), pas un téléphone. Précache : 133 fichiers, 5 805 Ko (2 GeoJSON = 51 %), environ 1 593 Ko transférés (estimation locale). Lot de 20 000 lignes d'import : 45 s avant, 13 s après. Événements locaux : 144 000 lignes par jour et par compte avant, 500 après. Course de révocation : 48/100 avant, 0/100 après. Coût de la relecture du compte : 7 à 15 ms par appel, base locale sous Docker, poste chargé.

## G. Recommandations et décisions à prendre (DSI et architecte)

1. **PIN** : valeurs provisoires (7 jours, 5 minutes, 2 minutes, 600 000 itérations) ; phrase de passe ou PIN plus long ; liste de PIN triviaux (le client en refuse déjà quelques-uns) ; rotation de la clé de données non implémentée.
2. **Compromis `APPAREIL_REVOCATION_RECENTE`** : un agent légitime peut attendre jusqu'à 15 minutes pour enregistrer un nouvel appareil.
3. **Lien appareil-session** (champ, migration, claim) pour fermer la fenêtre résiduelle ; ou jeton d'accès plus court.
4. Rôle LECTEUR autorisé à écrire en collecte V2 (D-C1-6) ; extension territoriale ; politique d'accès à l'APK.
5. Approuver ou non les modifications des 29 scripts (audit obligatoire, simulation par défaut) et le retrait de `xlsx`.
6. Dérive : trancher `programmes_budgetaires`, `onDelete` des 8 clés, adoption de `LimiteAdmin`, référence d'écarts connus pour la CI.
7. Sauvegardes : clé, détenteurs, RPO, RTO, rétention, destinataire des alertes, exercice de restauration.
8. Séquencement des montées majeures de dépendances (jspdf, nodemailer, zod, react-router, tailwind).
9. **E2E-4** : fenêtre de grâce courte sur l'ancien jeton de rafraîchissement (compromis de sécurité à décider) ou déconnexion assumée ; **horloge avancée puis corrigée** : l'écran « Session locale expirée » apparaît puis la connexion en ligne renouvelle (le bon PIN seul ne suffit pas selon le test de bout en bout) ; reprise temporisée du journal après un 429.
10. **Prochain lot recommandé** : essai sur appareil réel et WebView Android de l'APK (ou embarquement de l'application), puis lot qualité des données v2 (appliquer les détecteurs sur une copie de production par la DSI), puis contrôle de dérive en CI.

## H. Demande de revue ChatGPT

Revoir : (1) la politique de session hors ligne (durées, absence de destruction automatique, réinitialisation distincte) ; (2) le compromis de la fenêtre de 15 minutes et la décision de lien appareil-session ; (3) la règle « un refus de droits est mis en quarantaine côté téléphone et n'est jamais rejoué sans geste de l'agent » ; (4) le choix de relire le compte en base à chaque requête sans cache ; (5) le plafond de 30 minutes du pont d'activité du relevé en roulant ; (6) les risques E.1 à E.4 comme conditions d'un premier déploiement terrain.

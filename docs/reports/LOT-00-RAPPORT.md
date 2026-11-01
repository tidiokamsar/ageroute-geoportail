# LOT 0 : audit initial et première stabilisation

Date : 25/10/2026. Branche : `lot/03-map-matching`. Commit de départ : `89cb869`. Rapport destiné à la revue de l'architecte de supervision (ChatGPT).
Les chiffres de ce rapport viennent de commandes exécutées le 25/10/2026 ; ceux qui ne le sont pas sont dits « non vérifié ».

## A. Résumé exécutif

**Objectif.** Établir l'état réel du dépôt par un audit mené en parallèle par six agents spécialisés (lecture seule), puis corriger les défauts
sûrs et à forte valeur qu'il a révélés, avec quatre agents d'implémentation sur des périmètres de fichiers disjoints.

**Résultat.** Audit consolidé (section E et backlog en section G), 33 correctifs dans le code et une migration, tous vérifiés par les suites complètes (section D).
L'audit a trouvé **un défaut que j'avais moi-même introduit** la veille : la route des photos d'observation échouait sur toute base construite par les
migrations (colonnes d'analyse absentes de `medias_observation`). Il est corrigé par la migration `20261027100000` et couvert par un banc PostGIS.

**Valeur métier.** Le téléphone ne perd plus sa file de synchronisation au retour du réseau (jeton périmé jamais rafraîchi : prouvé par exécution,
corrigé) ; la carte ne présente plus un état « déclaré » comme « constaté » ; un changement d'état en masse demande confirmation ; la 2FA ne peut plus être
désactivée sans mot de passe ; toute route non publique est éprouvée sans jeton par un test.

**État global : partiel.** Les corrections sûres sont faites. Les risques qui demandent une décision (réouverture hors ligne sans jeton, compte partagé,
contrôles de module sur les lectures V1, extension territoriale, séquencement des montées majeures de dépendances) sont posés en section G. **Rien n'est déployé.**

## B. Travail des agents

| Rôle | Tâche | Conclusions principales | Fichiers touchés | Vérification |
|---|---|---|---|---|
| Architecte et audit | Architecture, dette, contrats, exigences A1-A30, intégrations | 2 styles d'API (v1 `modules/*`, v2 `api-v2/*`), 27 noyaux purs sans import d'infrastructure, haversine dupliquée 9 fois, 1 module mort, bilan A1-A30 du tableau de traçabilité faux, DigitalRoad et SharePoint testés contre des simulateurs seulement | aucun (lecture) | rapport relu, points clés recoupés (voir E) |
| Sécurité | Garde d'authentification, rôle, module, territoire sur chaque route | aucune route non publique sans `requireAuth` (hors `GET /api/v2`), 2FA désactivable sans mot de passe, 3 écritures non auditées, 43 tests qui mockent `requireAuth` | aucun (lecture) | correctifs vérifiés ensuite par les tests |
| Terrain et mobilité | Parcours en 10 étapes, hors ligne | aucun test sur un vrai IndexedDB ni un navigateur ; jeton périmé jamais rafraîchi (vérifié par exécution) ; 10 risques classés | aucun (lecture) | 123 tests ciblés relancés par l'agent |
| Base de données et qualité | Détections attendues contre existant, schéma, suppressions, migrations | dérive `medias_observation`, aucune détection de PK, 11 scripts d'écriture sans audit, `ordres_travaux.chantierId` sans clé étrangère | aucun (lecture) | requêtes lues sur `replay` en lecture seule |
| UX/UI et cartographie | Navigation, modals, formulaires, carte | gouvernance inaccessible à ses destinataires, état déclaré peint comme constaté, carte inutilisable sur téléphone, 7 tableaux rognés | aucun (lecture) | non vérifié visuellement |
| QA et DevOps | Tests, CI, déploiement, sauvegardes, `npm audit` | aucun test de bout en bout navigateur ; CI jamais exécutée ; retour arrière non automatique ; clé de sauvegarde en un seul exemplaire ; 2 vulnérabilités critiques `npm audit` | aucun (lecture) | `npm audit` réellement exécuté |
| Implémentation terrain | 8 correctifs du hors ligne | voir C | `lib/api.ts`, `offlineSync.ts`, `offlineDb.ts`, `EnregistrementRoulagePage.tsx`, `DefautTerrainPage.tsx` + 8 fichiers de test | 280 tests ciblés, puis suite complète |
| Implémentation sécurité | 6 correctifs backend | voir C | `auth.service.ts`, `propositions.routes.ts`, `ot.service.ts`, `lib/geo.ts`, `app.ts`, `marches.*`, `mobile.routes.ts`, `api-v2/index.ts`, nouveau `rate-limit.middleware.ts` + 6 tests | 685 tests ciblés, puis suite complète |
| Implémentation UX et carte | 9 correctifs | voir C | `GeoportailPage.tsx`, `DetailPanel.tsx`, `ChangerEtatCorridor.tsx`, `Modal.tsx`, `EntityForm.tsx`, `ProtectedRoute.tsx`, `Sidebar.tsx`, `App.tsx`, 9 pages + 11 fichiers créés | 259 tests ciblés, puis suite complète |
| Documentation et dette | 10 nettoyages | voir C | `AGENTS.md`, `PROJECT_STATUS.md`, `SECURITY_REMEDIATION.md`, `REQUIREMENTS_TRACEABILITY.md`, `BLOCKERS.md`, `deployer-console.sh`, Dockerfiles, `zod` | tests ciblés |
| Orchestrateur (moi) | Migration de la dérive, revue des diffs sensibles, intégration, suites complètes, bancs, rapports | voir C et D | migration `20261027100000`, descente, banc `photos-observation`, script de déploiement, `.env.example`, `perf/lib/serveur.ts` | descente éprouvée (4 vérifications), banc 8/8 |

Aucune tâche n'est tenue pour terminée sur la seule annonce d'un agent : chaque rapport a été recoupé par les suites complètes et par la relecture des différences sensibles
(2FA, authentification de `GET /api/v2`, limiteurs de débit, rafraîchissement du jeton). Une première intégration a échoué sur deux points que j'ai corrigés moi-même :
le balayage de secrets signalait un identifiant factice dans l'URL d'un nouveau test, et signalait des fichiers supprimés non encore indexés.

## C. Changements réalisés

**Données.** Migration additive `20261027100000_medias_observation_analyse` : cinq colonnes d'analyse, trois contraintes, un index sur `medias_observation`, à l'identique de
`medias_defaut`. Idempotente (`IF NOT EXISTS`) : sans effet si la production, construite par `db push`, les porte déjà. Descente avec garde (refuse si une analyse existe).

**Sécurité (backend).** 2FA : `POST /auth/2fa/setup` refuse (409) si elle est déjà active. Audit transactionnel ajouté : rejet d'une proposition de localisation, assignation d'un OT,
géolocalisation des actifs. `GET /api/v2` exige un jeton. Limitation de débit : `/auth/refresh` (60 par 15 min) et `/api/v2` (1 200 par minute et par adresse), configurables
(`RATE_LIMIT_*`). Corps du simulateur de budget validé par zod. Téléchargement de l'APK journalisé. Test d'introspection `securite/routes-authentifiees.test.ts`.

**Terrain.** Rafraîchissement du jeton sur 401 (un seul en vol, rejeu, pas de boucle). 401, 408, 429, 502, 503, 504 comptent comme « réseau muet » et n'abandonnent plus la file.
Échec d'écriture du journal de roulage : alerte bloquante. « Démarrer » attend la lecture du journal. Session d'un autre compte : gardée, jamais envoyée ni supprimée. Badge global
compte la session de roulage non confirmée. Relance des défauts abandonnés qui ont un identifiant serveur. `onabort` sur toutes les écritures IndexedDB.

**Interface et carte.** Gouvernance : route alignée sur la règle du serveur (ADMIN ou délégant). État « déclaré » distingué sur la carte (pointillé, légende, fiche). Changement d'état en masse en
deux temps, retiré pour une ville seule. Carte mobile (panneau replié, fiche pleine largeur). Échap, `role="dialog"`, attributs ARIA, confirmation avant de perdre un brouillon. Garde de saisie sur les
modals à formulaire. Tableaux défilants. Erreurs de formulaire accessibles. Entrée de menu « Validation des portions ».

**Documents et dette.** `AGENTS.md`, `PROJECT_STATUS.md`, `SECURITY_REMEDIATION.md`, bilan A1-A30 recomptés, `BLOCKERS.md` B-25, en-tête de `deployer-console.sh`, commentaires périmés, module mort supprimé,
`zod` déplacé en devDependencies, `HEALTHCHECK` backend, `npm ci` côté frontend.

**Décisions techniques prises (réversibles).** `SECURITY_EVENT` porte le journal de téléchargement de l'APK (pas d'enum nouveau). `USER node` non ajouté : le volume des téléversements est possédé par root et le
démarrage écrit dedans. Le garde du `Modal` utilise un dialogue interne plutôt que `useConfirm` (import circulaire). `noValidate` ajouté à `EntityForm` pour que les nouveaux messages s'affichent.

## D. Vérifications

| Contrôle | Résultat réel du 25/10/2026 |
|---|---|
| Backend `tsc --noEmit` | sans erreur |
| Backend `vitest` complet | 180 fichiers, 2 773 tests, tous réussis |
| Frontend `tsc --noEmit` | sans erreur |
| Frontend `eslint .` | 0 erreur, 5 avertissements préexistants |
| Frontend `vitest` complet | 100 fichiers, 1 203 tests, tous réussis |
| Frontend `vite build` | réussi |
| Bancs PostGIS `tests-integration/run.sh` (base `replay`) | 31 bancs, tous réussis (dont `photos-observation` 8/8, `chemin` 13/13, `historique` 19/19, `sync` 67/67, `territoire` 93/93) |
| Banc des descentes (`verifier.sh --seulement 20261027100000_medias_observation_analyse`) | 4 vérifications réussies, 0 échec : descente identique, aller-retour, garde refusant avec données, garde levée par l'autorisation explicite |
| Migration appliquée deux fois à `replay` | idempotente, sans erreur |
| `bash -n infra/deployer-console.sh` | syntaxe correcte, constantes mises à `ATTENDUES_EN_ATTENTE=1` et `PREMIERE_EN_ATTENTE=20261027100000_medias_observation_analyse` |

**Non exécuté, et pourquoi.** Aucun rendu visuel ni essai sur téléphone (pas de téléphone, aucun navigateur piloté pour ce lot) ; CI GitHub (compte verrouillé) ; images Docker non construites ;
aucune requête sur la production (lecture de la base refusée, accès serveur réservé à la DSI).

**Écart développement et production.** Dernier relevé de la production (23/10) : 82 migrations appliquées. Depuis, le dépôt a gagné `20261027100000` ; la production n'a ni la route des photos d'observation,
ni le rattachement des observations, ni la route entre deux villes, ni l'APK authentifié, ni ces correctifs. L'état exact se vérifie au déploiement.

## E. Risques et problèmes

**Défauts restants (par gravité, preuves dans les rapports d'agents conservés dans la session).**

1. Réouverture hors ligne impossible : le jeton d'accès est en mémoire, au redémarrage le rafraîchissement échoue sans réseau et l'utilisateur est renvoyé vers la connexion ; les données IndexedDB restent mais inaccessibles (lecture du code, non exécuté).
2. Aucun test de bout en bout dans un navigateur, ni sur un vrai IndexedDB (`fake-indexeddb` absent) : le mode hors ligne n'est prouvé que par simulation et par les bancs PostGIS côté serveur.
3. Session d'un autre compte sur le téléphone : plus personne ne peut démarrer tant qu'elle n'est pas résolue (conséquence de la correction du compte partagé).
4. Lectures V1 (chantiers, ouvrages, points noirs, postes, documents) sans contrôle de module : les montants et entreprises des chantiers sont lisibles par un compte sans le module des marchés.
5. Contrôle territorial absent sur OT, programmation, missions, main courante, patrouilles : sans effet tant qu'aucun compte n'a de périmètre régional (D-11).
6. 11 scripts d'écriture sur le patrimoine sans audit (règle 3 d'AGENTS.md) : non traité, exige d'abord un choix (audit obligatoire ou option `--audit`).
7. PK 0/0 utilisé comme valeur absente (1 029 tronçons d'après les documents), aucun détecteur ; zéro `CHECK` sur `troncons`.
8. Géométrie : `/troncons/geo` sans emprise ni simplification ; icônes de marqueurs recréées à chaque rendu (inférence non mesurée) ; la `key` de la couche des tronçons ne contient pas l'état (redessin à vérifier).
9. `npm audit` : backend 13 vulnérabilités (1 critique transitive, 7 hautes), frontend 11 (1 critique `jspdf`, 5 hautes) ; exploitabilité non évaluée.
10. Sauvegardes : la clé de chiffrement n'existe qu'en un exemplaire sur le serveur sauvegardé (décision P5-13) ; aucune preuve de restauration complète depuis le 02/09/2026 ; installation du crontab non prouvée.

**Risques de régression introduits.** Limiteur `/api/v2` : plafond par adresse, un NAT d'opérateur partagé par beaucoup d'agents pourrait l'atteindre (configurable, 0 le désactive). `GET /api/v2` exige maintenant un jeton : aucun client du dépôt ne l'appelle,
un client externe le pourrait. `EntityForm` en `noValidate` change le comportement de validation des champs texte. Le repli mobile de la carte est écrit sans rendu.

## F. Mesures et résultats

- Tests : backend 2 773 (2 661 consignés le 23/10 : +112), frontend 1 203 (1 029 consignés le 25/10 avant ce lot : +174).
- Bancs PostGIS : 31 (28 consignés le 23/10 : +3 : `chemin`, `historique`, `photos-observation`) ; vérifications totales non additionnées ici.
- Audit `npm audit --omit=dev` : backend 13 vulnérabilités (1 critique, 7 hautes, 5 moyennes), frontend 11 (1 critique, 5 hautes, 5 moyennes) ; **non corrigées dans ce lot**.
- Dette (comptes de l'agent architecte) : 40 996 lignes backend et 34 713 frontend hors tests ; 0 TODO ; 0 `: any` hors tests ; 37 `as never` backend ; haversine dupliquée 9 fois ; plus gros fichier `GeoportailPage.tsx` 1 747 lignes.
- Exigences A1-A30 recomptées sur le tableau : 8 terminées et testées, 10 terminées avec réserves, 10 partielles, 1 bloquée, 1 en attente (aucun statut modifié).
- Anomalies relevées par l'audit : 1 critique sécurité transitive et 1 critique `jspdf` (dépendances), 1 élevée applicative (2FA, corrigée), 1 route sans authentification (corrigée), 1 dérive de schéma (corrigée).

## G. Recommandations à l'architecte

**Backlog priorisé (valeur, risque, effort).**

| # | Action | Valeur | Risque | Effort | Décision requise |
|---|---|---|---|---|---|
| 1 | Parcours Playwright contre la pile locale (connexion, inspection, validation, carte) et IndexedDB réel | haute | faible | 2 à 3 j | non |
| 2 | Auditer les 11 scripts d'écriture ou les interdire sans option d'audit | haute | faible | 0,5 j | oui (règle) |
| 3 | Détecteurs de qualité v2 : PK 0/0, longueur par tronçon, géométrie nulle, région discordante, ouvrage loin de son tronçon ; banc PostGIS des doublons et du hors-territoire | haute | faible | 2 j | non |
| 4 | Contrôle de dérive en CI (`migrate diff`) et rejeu reproductible de `replay` | haute | faible | 0,5 j | trancher D-10 |
| 5 | Mémoïser les icônes de marqueurs, simplifier `/troncons/geo` selon le zoom (mesurer avant et après) | moyenne | moyen | 1 à 2 j | non |
| 6 | Dépendances : mises à jour mineures (multer, nodemailer, compression, axios), `jspdf` et `zod` en lot dédié | haute | moyen | 1 j | séquencement |
| 7 | Retour arrière automatisable déclenché à la main, testé sur copie jetable | haute | faible | 1 j | non |
| 8 | Installer une CI exécutable (exécuteur local) ou débloquer GitHub | haute | faible | selon accès | oui (DSI) |
| 9 | Réouverture hors ligne par session locale (profil en cache) | très haute pour le terrain | sécurité | 3 j | **oui, arbitrage de sécurité** |
| 10 | Contrôle de module sur les lectures V1, extension territoriale | moyenne | casse possible de la carte | 1 j | oui |

**Décisions architecturales attendues.** (1) Réouverture hors ligne sans jeton réseau : option A, session locale chiffrée liée à l'appareil et au compte (recommandée, périmètre limité à la file et au journal) ; option B, statu quo (la
file reste inaccessible hors couverture au redémarrage) ; option C, jeton d'accès de longue durée (écartée : élargit l'exposition). (2) Compte partagé : option A, autoriser un responsable à supprimer avec confirmation (recommandée) ; option B, file de sessions
par compte (plus coûteux, exige un changement de schéma IndexedDB). (3) Règle de couche pour `api-v2` (routes minces) et découpage de `GeoportailPage.tsx` (1 747 lignes) : ne pas le faire avant d'avoir des tests de bout en bout.
(4) Séquencement des montées majeures (Prisma 5 vers 7, Express 4 vers 5, zod 3 vers 4, React 18 vers 19, Vite) : un lot dédié chacune, aucune n'est urgente d'après l'audit.

## H. Demande de revue ChatGPT

**À examiner.** La méthode de test d'authentification par énumération des routes (est-elle suffisante contre les routes montées dynamiquement ?) ; le choix de journaliser le téléchargement de l'APK sous `SECURITY_EVENT` ; les plafonds de débit ;
la règle « un défaut vit dans une observation conteneur, donc l'observation qui porte un défaut est lue par le défaut » (double compte évité dans l'historique et le classement) ; la migration idempotente face à une production construite par `db push`.
**Décisions attendues.** Les points (1) à (4) de la section G. **Recommandation technique de Claude.** Faire d'abord les tests de bout en bout (action 1), car trois défauts de ce lot (route sans authentification, jeton non rafraîchi, dérive de schéma) ont échappé
à tous les tests existants faute de parcours réel. **Prochain lot suggéré.** Lot 3 (terrain, GPS, hors ligne) : parcours réels et réouverture hors ligne, après décision sur le point (1).

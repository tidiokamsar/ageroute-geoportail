# Synthèse de tout ce qui a été fait depuis vendredi 23/10/2026

Établie le 27/10/2026 à partir de l'historique git (toutes les branches, `git log --all --since=2026-10-23`) et des rapports de lot. **Rien de tout cela n'est vérifié comme déployé** : l'état de la production n'est pas lisible depuis ce poste (voir la section « Publication » plus bas). Les chiffres de tests cités viennent des rapports `LOT-00`, `LOT-01`, `LOT-UX-IMPORTS` et des journaux d'exécution du 27/10.

## 1. Les lignes de travail et leur état

| Ligne (branche) | Contenu | Dernier commit | Sur GitHub | Intégrée dans |
|---|---|---|---|---|
| `lot/03-map-matching` | Lots 0 et 1 : audit, session hors ligne, sécurité serveur, qualité, imports, bout en bout, SMART FIELD, relevés | `0b902e7` | oui | ligne principale |
| `fusion/observation-terre` (locale) | Aide à la décision + Observation de la Terre + relevés envoyés, par-dessus `lot/03` jusqu'à `ada84d4` | `23d227e` | **non** | worktree `integration/depuis-vendredi` (fusion avec les deux derniers commits de `lot/03` : propre) |
| `release/ad-eo` | Fusion Aide à la décision + Observation de la Terre (branche de livraison préparée par une autre session) | `fb2cfe4` | oui | `fusion/observation-terre` en est la suite |
| `feat/observation-terre`, `feat/aide-decision` | Modules d'origine | `f937b43`, `1e8c5a3` | oui | `release/ad-eo` |
| `lot/17-consignes-dt`, `lot/18-bdri-troncons` | Lots BDRI (page Tronçons, registre d'anomalies, fiche d'inspection, chantiers multi-tronçons, import XLSX, tracé contrôlé, décision D-12) | `7988101`, `99bd286` | oui | **en cours de fusion** (14 fichiers en conflit avec le module d'Observation de la Terre et la session hors ligne) |
| `fix/geoportail-tabulation-traces` (PR 4 et 5) | Ordre de tabulation des cartes, composant partagé | `e3ed073` | oui | en attente de fusion |

Une branche d'intégration unique, `integration/depuis-vendredi`, est en cours de construction dans un worktree isolé (`F:\ageroute-int`) : elle doit contenir toutes les lignes ci-dessus. Elle n'est pas encore testée.

## 2. Ce qui a été fait, par jour

**Vendredi 23/10.** Verrou par identifiant d'opération contre la course de synchronisation (bancs `ppe` et `sync` fiabilisés) ; qualification par segment et lien à une mission dans l'enregistreur de relevé ; contour GPS d'un défaut surfacique (A5) ; interface du moteur de programmation et PPE minimal (A22) ; contraste WCAG 2.1 AA mesuré en navigateur réel et corrigé à la source (A25) ; correspondance éditable d'identifiants, délai Info Route mesuré, bancs qualité et interopérabilité (A23, A24) ; changement d'état d'un corridor exigeant l'authentification et le périmètre territorial ; recherche d'un tronçon par GPS ou ville, coque Android Capacitor, icônes PWA ; lien de téléchargement de l'APK ; fermeture des modals (en-tête collant) ; conduite retenue sur délégation du DSI pour D-01, D-02, D-06, D-07, D-09, D-10, D-11 ; zéro migration en attente dans le script de déploiement.

**Samedi 24/10.** SMART FIELD, phases 1, 2, 3 et 5 : un journal injouable est dit (la reprise n'est plus silencieuse), pack de mission et liste de contrôle avant départ, complétude d'un relevé et indice d'irrégularité, accéléromètre optionnel ; écran d'enregistrement en roulant (session vide, carte, états, envoi retenu, rejeu au retour du réseau) ; bouton de l'application mobile dans la barre d'outils ; rotation des logs de conteneurs ; seuil de disque réglable du script de déploiement ; correction du gel des onglets sur les fiches.

**Dimanche 25/10.** Route entre deux villes (tous les tronçons dans l'ordre sur le réseau) ; APK servi derrière l'authentification ; pack incomplet dit ; complétude et indice d'irrégularité réellement affichés ; observation rapide en deux appuis, capacités de l'appareil ; photo rattachée à une observation, critères d'acceptation de vision, ordre du pilote ; historique par section, points à contrôler explicables, rattachement d'observation sur proposition (phase 6) ; lots BDRI B (page Tronçons professionnelle), C (registre persistant des anomalies du référentiel), F (fiche d'inspection terrain), G (chantier sur plusieurs tronçons), H (import XLSX simulé avant écriture), I (tracé contrôlé avant écriture) ; **Lot 0** : audit par six agents, 33 correctifs et une migration (2FA non désactivable sans mot de passe, authentification de `GET /api/v2`, jeton rafraîchi sur 401, état déclaré distingué sur la carte, changement d'état en masse confirmé, dérive `medias_observation` corrigée), rapport, état global.

**Lundi 26/10.** **Lot 1** : session hors ligne chiffrée (client), sécurité serveur (compte relu en base, appareil révoqué, course de révocation fermée, droits refusés tracés, territoire masqué), 26 détecteurs de qualité, outil de dérive, preuve de restauration, migration `ComposanteRci` ; **module Lots d'import** reconçu (interface, API additive, durcissement) ; consultation « Relevés envoyés » (autre session) ; module **Observation de la Terre** (API, sources, workflow, écran, carte).

**Mardi 27/10.** Harnais de bout en bout réel (Observation de la Terre : 48/48 sur deux exécutions ; Lot 1 : 57/57 sur deux exécutions) ; module **Aide à la décision** (synthèse, priorités, simulateur, contractuel, barèmes, exports, sécurité) ; fusion Aide à la décision + Observation de la Terre ; liste de modules vide = aucun module côté client, recherche sans accents, matrice d'accès ; défauts E2E-5 (ouverture hors ligne), E2E-3 (étiquettes de connexion), effacement local ; composant partagé de tabulation des cartes.

## 3. État des preuves (au 27/10/2026)

Lot 1 sur `lot/03-map-matching` : backend 191 fichiers et 3 308 tests ; frontend 153 fichiers et 3 067 tests ; `tsc` propre ; ESLint 0 erreur ; 57 tests de bout en bout (deux passages consécutifs verts) ; bancs PostGIS 34 sur 36 (deux rouges pour cause externe : client Prisma partagé). Les autres lignes ont leurs propres preuves dans leurs rapports ; **la branche d'intégration n'a pas encore de preuve** tant que l'agent d'intégration n'a pas rendu son rapport.

## 4. Publication : ce qui est fait et ce qui est bloqué

- **Fait** : `lot/03-map-matching` à `0b902e7` poussée ; archive reproductible `bdri-0b902e7.tar.gz` (SHA-256 `e221165746cfdf18ba1ba73ed12fcd7f2bdee5c1973acf0c7f0a5795cf3bb60e`) ; script `infra/deployer-console.sh` prêt.
- **Bloqué** : aucune connexion SSH n'a pu être établie depuis cette session. Une tentative de lecture en SSH vers le serveur applicatif (`gec`, 102.211.199.131, celui vers lequel pointe `carte.ageroute.gov.gn`) a été refusée par le classificateur d'autorisations de Claude Code (« dangerous »), avant toute connexion. Ce n'est pas une panne de clé ni de réseau : c'est une règle de permission. Pour la lever, l'utilisateur doit ajouter lui-même une règle de permission Bash pour les commandes `ssh` et `scp` vers ces hôtes dans les paramètres de Claude Code ; l'assistant ne modifie pas ses propres permissions. Autre voie : lancer soi-même les deux commandes de déploiement sur le serveur.
- **Domaine `astra.infranetgn.com`** : une résolution DNS publique montre qu'il pointe déjà vers `147.79.114.208` (le même VPS que `chantier360.infranetgn.com`). Rien n'a été créé ni modifié chez l'hébergeur. Le contenu à publier sous ce nom est le projet ASTRA, suivi par une autre session ; il n'est pas dans ce dépôt.

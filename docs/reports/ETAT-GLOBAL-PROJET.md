# État global du projet AGEROUTE ROAD / Géoportail routier

Mise à jour : 25/10/2026 (fin du Lot 0). Branche `lot/03-map-matching`. Commit de référence : `e99c5da` (le présent fichier est commité juste après).
Historique : chaque mise à jour ajoute une section datée en tête, sans effacer les précédentes. Rapports de lot : `docs/reports/LOT-XX-RAPPORT.md`.

## Mise à jour du 25/10/2026 : fin du Lot 0 (audit et première stabilisation)

### Progression par lot du mandat

| Lot | Sujet | État | Preuve ou limite |
|---|---|---|---|
| 0 | Audit initial et état des lieux | **Terminé** (audit) et **partiel** (stabilisation) | `LOT-00-RAPPORT.md` : six audits parallèles, 33 correctifs, 1 migration |
| 1 | Interface, UX/UI, modals | **Partiel** | correctifs d'accessibilité, de navigation et de garde de saisie livrés et testés sous jsdom ; **aucun rendu réel vérifié** ; 33 pages sur 55 environ n'ont pas de test axe |
| 2 | Carte et géoportail | **Partiel** | état déclaré distingué, couches par défaut, route entre deux villes, repli mobile écrit ; filtres axe, préfecture, projet absents (données absentes) ; performances non mesurées (`/troncons/geo` sans emprise) |
| 3 | Terrain, GPS, hors ligne | **Partiel, prioritaire** | 8 défauts du hors ligne corrigés ; **jamais éprouvé sur appareil ni sur un vrai IndexedDB** ; la réouverture hors ligne sans jeton est impossible (décision requise) |
| 4 | Qualité du réseau et référentiel | **Non commencé en correction** | audit fait : 6 familles de détection existent sur 8 attendues, PK 0/0 non détecté, 11 scripts d'écriture sans audit ; 10 requêtes de mesure prêtes (non exécutées sur la production) |
| 5 | Workflows, tableaux de bord, rapports | **Partiel** | historique par section, classement « à contrôler » explicable, rattachement d'observation sur proposition, export CSV ; rapport de campagne non rédigé automatiquement |
| 6 | Sécurité, sauvegardes, production | **Partiel** | 2FA, authentification de toutes les routes éprouvée, débit limité, audits ajoutés ; sauvegarde et restauration : preuves anciennes (02/09), clé en un exemplaire ; **rien déployé depuis le 23/10** |
| 7 | Innovations et intégrations | **Bloqué en partie** | banc d'évaluation de vision et critères provisoires livrés, aucun modèle ni corpus guinéen ; DigitalRoad, SharePoint, BDR/L²R testés contre des simulateurs seulement (B-11, B-12) |

### Tâches terminées, partielles, bloquées

- **Terminées (vérifiées par tests réels de la session).** Route entre deux villes sur le réseau ; photos rattachées aux observations (route, file locale, revue) ; APK derrière authentification ; observation rapide en roulant ; historique et classement « à contrôler » ; correctifs du Lot 0.
- **Partielles.** Mode hors ligne (simulation seulement) ; accessibilité (couverture axe incomplète) ; qualité des données (audit sans correction) ; SMART FIELD phases 2, 3, 5, 6 ; documentation de production (écart connu entre dépôt et production).
- **Bloquées.** Phase 4 SMART FIELD (corpus guinéen) ; intégrations réelles (accès et API) ; classification officielle des routes (D-06) ; fédération des comptes (D-09) ; CI GitHub (compte verrouillé) ; signature de l'APK (clé AGEROUTE) ; essais sur appareil réel.

### Risques ouverts

Voir `LOT-00-RAPPORT.md`, section E, dix risques classés. Les trois plus lourds : (1) réouverture hors ligne impossible et aucun test de bout en bout navigateur ; (2) sauvegardes dont la clé de chiffrement n'existe qu'en un exemplaire ;
(3) dérive possible entre le schéma Prisma, les migrations et la production (construite par `db push`) : un contrôle de dérive automatique manque.

### Tests et preuves disponibles (réellement exécutés le 25/10/2026)

Backend : 180 fichiers, 2 773 tests réussis. Frontend : 100 fichiers, 1 203 tests réussis, lint 0 erreur, build réussi. Bancs PostGIS : 31, tous réussis. Descente de la migration du jour : 4 vérifications réussies.
Non exécutés : CI GitHub, essais sur appareil, rendu navigateur, toute requête sur la production. Détail et commandes : `TEST_EVIDENCE.md`, `LOT-00-RAPPORT.md` section D.

### Décisions déjà prises

- Conduite par délégation du DSI pour D-01, D-02, D-06, D-07, D-09, D-10, D-11 (`docs/pilotage/DECISIONS-PRISES-SUR-DELEGATION.md`), toutes réversibles, aucune approbation officielle.
- Critères provisoires d'acceptation d'un modèle de vision, ordre du pilote (RN1 puis Boké), photo d'observation par extension du contrat (`docs/pilotage/CRITERES-VISION.md`).
- Dans le Lot 0 : `SECURITY_EVENT` pour tracer le téléchargement de l'APK ; migration idempotente pour la dérive ; observation conteneur d'un défaut non comptée deux fois.

### Décisions en attente de l'architecte de supervision

1. Réouverture hors ligne sans jeton réseau (option recommandée : session locale chiffrée liée à l'appareil et au compte).
2. Compte partagé sur un téléphone : qui peut supprimer la session d'un autre compte.
3. Contrôle de module des lectures V1 ; extension territoriale ; politique d'accès à l'APK.
4. Séquencement des montées majeures de dépendances ; règle de couche pour `api-v2` ; découpage de `GeoportailPage.tsx`.
5. CI exécutable (exécuteur local ou déblocage GitHub).

### Prochaines étapes (par priorité)

1. Tests de bout en bout navigateur et IndexedDB réel sur la pile locale (Playwright) : prérequis de tout lot terrain.
2. Lot 4 : détecteurs de qualité manquants (PK, longueurs, géométrie nulle, région discordante) avec bancs PostGIS ; audit des 11 scripts d'écriture.
3. Contrôle de dérive des migrations en CI et rejeu reproductible de `replay` (trancher D-10).
4. Mesure puis optimisation de la carte (icônes, `/troncons/geo` simplifié selon le zoom).
5. Déploiement : **commande humaine requise** (accès root, attestation). Contenu à déployer et procédure : voir `LOT-00-RAPPORT.md` et `infra/deployer-console.sh`.

## Mise à jour du 27/10/2026 : module Aide à la décision (branche `feat/aide-decision`)

Construit sur la chaîne v2 (moteur de programmation, registre d'indicateurs, détecteurs de qualité) ; les chaînes héritées ne sont pas retirées avant recette. **Non déployé, non poussé.** Détail, preuves, limites et décisions métier : `LOT-AD-00-RAPPORT.md` (audit) et `LOT-AD-01-07-RAPPORT.md` (construction et revues).

- **Livré** : shell de page à six onglets, synthèse et dictionnaire des indicateurs, carte et liste de priorités explicables (« score incomplet » jamais traité comme un score), simulateur avec contraintes et déficit, suivi contractuel, barèmes avec historique, exports gouvernés journalisés, séparation des tâches, droit sur les montants unifié.
- **Preuves rejouées** : backend 222 fichiers, 4505 tests verts, `tsc` propre ; frontend vert par répertoire, `tsc` propre ; bancs PostGIS (priorités, scénarios, programmation, PPE, sécurité, barèmes et exports, contractuel, KPI, contrôle d'accès) verts selon les agents ; migration `20261029300000` avec descente testée. Deux revues indépendantes (frontend, backend) ont trouvé des défauts critiques et élevés, tous corrigés avec tests.
- **Non vérifié** : aucune donnée réelle, aucun volume réel, aucun backend en marche derrière le frontend, pas de PDF, classement non mis en cache.
- **Décisions métier en attente** : listées en section 5 du rapport (définitions « dégradé » et « critique », source des longueurs, poids, barèmes, « budget engagé », droit sur les montants, rôles de validation, seuils).
- **Observation de la Terre** (branche `feat/observation-terre`, 4 commits locaux, non poussée) : bout en bout réel 48/48 sur deux exécutions ; trois défauts de l'E2E corrigés (lignes illisibles sur la carte, délai de transaction, recherche par région) ; restent `E2E-EO-3`, `E2E-EO-D`, `E2E-EO-5` hors module.
- **Suivis hors module** : règle de modules frontend/serveur divergente, tabulation des tracés Leaflet du Géoportail, régénération du client Prisma du dépôt principal, corps d'erreur du middleware pour JSON mal formé.

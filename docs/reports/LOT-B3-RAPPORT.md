# Lot B3 : workflow concessionnaire, rôles du cahier et récolement (RC-4, backend)

Date : 08/11/2026. Branche `feat/workflow-roles` (issue de `feat/rc3-integration`, `34b2d66`). Un seul agent (pas de sous-agents). Contrat écrit et commité en premier : `docs/projets-voirie/CONTRAT-WORKFLOW.md`. Aucun push, aucun déploiement, aucune donnée réelle.

## 1. Ce qui est fait

1. **Audit des rôles et de l'accès** : quatre rôles techniques (`ADMIN`, `GESTIONNAIRE`, `INSPECTEUR`, `LECTEUR`), clés de module par compte, périmètre par régions, profils métier (préréglages), `peutDeleguerValidation` (validation de données de terrain). **Aucune notion d'organisation ou de concessionnaire n'est attachée aux comptes.** Tableau de correspondance PROPOSÉ (provisoire, décision du DSI) dans le contrat (section 2) et rendu par `GET /workflow/mon-profil` : le référent concessionnaire est un compte `LECTEUR` + clé de module + **rattachement** `(compte, concessionnaire, projet)` posé par un ADMIN (attribut de compte, pas de rôle global) ; auditeur, observateur, agent terrain : rôles existants ; « responsable de validation » : `GESTIONNAIRE`/`ADMIN` selon l'acte, pas de nouvel attribut.
2. **Accès par organisation** : un compte qui a un rattachement actif n'ouvre que `/workflow/...` (403 `COMPTE_REFERENT_RESTREINT` sur tout le socle et les dossiers de conflit, et sur l'historique d'audit du module) ; il ne voit que ce qui porte le concessionnaire de son rattachement, dans les projets rattachés, et seulement ce qui est partagé ; 404 masqué (même réponse que l'inconnu). Le périmètre territorial et le 404 des projets retirés sont réutilisés.
3. **Demandes aux concessionnaires** : BROUILLON/ENVOYEE/RECUE/CLOTUREE/ANNULEE ; **l'envoi est fait hors application et seulement enregistré** (canal, date, référence, interlocuteur, personne) ; **aucun message n'est émis** (test statique + comptes de toutes les tables) ; lien optionnel vers un jeu reçu sans effet sur le jeu.
4. **Tâches et preuves** : tâches liées à un projet, un conflit ou une demande (responsable habilité, échéance, statut, priorité, partage explicite avec le concessionnaire) ; preuves **références et empreintes SHA-256 seulement** (aucun fichier, aucune colonne binaire) ; historique en ajout seul ; séparation des tâches pour valider une tâche, via un **noyau extrait de RC-3** (`separation.noyau.ts`, 46 tests de RC-3 inchangés).
5. **Récolement** : objet lié à un conflit à déplacement décidé et/ou à un jeu, avant/après/auteur/profil/date/justification historisés, révision, validation par un tiers (contrainte aussi dans la base), au moins une preuve qui n'est pas une note ; **valider ne modifie ni le conflit, ni les jeux, ni le référentiel** (empreintes du banc). **Clôture RC-3 branchée** par extension minimale rétrocompatible : `recolementId` (récolement validé du dossier) dispense de la mention ; réglage `PROJETS_VOIRIE_RECOLEMENT_OBLIGATOIRE=1` (désactivé). Documenté dans `CONTRAT-CONFLITS.md` section 9, points 35 et 36 (ajout).
6. **Droits de validation** : synthèse des droits actuels du socle et de RC-3 et matrice du workflow dans le contrat (section 3), configurable par `PROJETS_VOIRIE_WORKFLOW_MATRICE` dans des limites codées. **Aucun droit existant n'est modifié.**
7. **API** : 24 routes (voir `API.md`, section « Workflow »), mêmes gardes que le socle, écritures auditées dans la transaction, validations strictes et bornées, cadence (429) et plafonds (422), verrou consultatif du projet. Inventaire d'accès, `CONTROLE-ACCES.md` et `isolation.test.ts` à jour. Pas d'interface.
8. **Migration** `20261101300000_workflow_roles_recolement` (additive, idempotente, six tables, sept types, index uniques partiels, déclencheurs, contraintes) avec **descente gardée** (`backend/prisma/descentes/20261101300000_workflow_roles_recolement.sql`).

## 2. Fichiers

Nouveaux : `backend/prisma/migrations/20261101300000_workflow_roles_recolement/migration.sql`, `backend/prisma/descentes/20261101300000_workflow_roles_recolement.sql`, `backend/src/projets-voirie/separation.noyau.ts` (+ test), `backend/src/projets-voirie/workflow/` (noyaux : `profils`, `validation`, `demandes`, `taches`, `recolements`, `preuves`, `visibilite`, `cadence` ; `config.ts`, `communs.ts`, `filtres.ts`, `garde.ts`, `cloture.depot.ts` ; services : `referents`, `demandes`, `taches`, `recolements`, `preuves`, `vues-restreintes` ; tests unitaires et `aucun-envoi.test.ts`), `backend/src/api-v2/projets-voirie.workflow.routes.ts` (+ test), `backend/src/projets-voirie/conflits/etats.recolement.noyau.test.ts`, `backend/tests-integration/workflow-roles.integration.mts`, `docs/projets-voirie/CONTRAT-WORKFLOW.md`, ce rapport.

Modifiés (au plus petit) : `backend/prisma/schema.prisma` (bloc ajouté **en fin de fichier**, aucune relation Prisma, aucun modèle existant touché), `backend/src/api-v2/projets-voirie.routes.ts` (une ligne `use(gardeReferent)` après l'authentification et le module ; montage en fin de fichier), `backend/src/api-v2/projets-voirie.conflits.routes.ts` (`recolementId` dans le schéma de `statut`), `backend/src/projets-voirie/conflits/etats.noyau.ts` et `dossiers.service.ts` (délégation au noyau commun ; clôture avec récolement), `backend/src/projets-voirie/config.ts` (une ligne en fin : export de `borne`), `backend/src/lib/access.ts` (types d'entité d'audit ; `compteRattache`), `backend/src/modules/audit/audit.routes.ts` (refus du référent pour les entités du module) et son test, `backend/src/securite/inventaire-acces.test.ts` (section « Workflow », marque `actions`), `backend/src/projets-voirie/isolation.test.ts`, `backend/tests-integration/run.sh` et `README.md`, `docs/projets-voirie/API.md` et `CONTRAT-CONFLITS.md` (ajouts), `docs/securite/CONTROLE-ACCES.md` (section et 24 lignes d'inventaire).

## 3. Résultats (chiffres réels)

- `npx tsc --noEmit` (backend) : **0 erreur** (une erreur de type dans mon test de routes, corrigee).
- Tests unitaires du lot : noyaux et services (12 fichiers dans `projets-voirie/workflow` et `separation`, 191 tests), routes (`projets-voirie.workflow.routes.test.ts`, 28 tests), RC-3 `etats.noyau.test.ts` 46 tests inchangés, `etats.recolement.noyau.test.ts` 6, audit 16 (dont 4 du référent), inventaire d'accès 21 (section Workflow : 5), isolation du module verte.
- **Banc PostGIS `workflow-roles.integration.mts` : 131/131** (clone jetable `essai_workflow_pv`, conteneur `postgis/postgis:17-3.5` port 5473, base `replay` reconstruite par les 96 migrations avec le pont de dérive). Première exécution : 128/131, 3 erreurs de mes propres données de test (date de 2999 hors bornes zod, ordre des clés JSONB, mise à jour sans changement) corrigées dans le banc, pas dans le code.
- **Contre-épreuve (mutation)** : garde du référent neutralisée, filtre de concessionnaire retiré des demandes, séparation des tâches du récolement retirée, partage forcé des preuves retiré : **10 échecs des tests unitaires et 17 du banc** ; code restauré (`git checkout`).
- **Descente** : `verifier.sh --seulement 20261101300000_workflow_roles_recolement` : 4 vérifications, 0 échec (schéma identique après descente, aller-retour, garde refuse avec données puis passe avec autorisation).
- Performances mesurées : 100 créations de tâches via l'API en 38 s sur une machine chargée (environ 380 ms chacune, 9 requêtes), pagination par curseur de 100 tâches en 3 pages, page la plus lente 210 ms.

### 3 bis. Suite backend complète

`npx vitest run` (depuis `backend`) : **290 fichiers, 6147 tests, 0 échec** (489 s), exécutée avant la correction de type du test de routes (re-exécuté seul : 28/28).

## 4. Sécurité

- Référent confiné : socle fermé avant lecture, historique d'audit du module fermé, 404 masqué, partage explicite (demande envoyée, tâche `partagee`, récolement soumis hors brouillon, preuve partagée, dossier confirmé sur jeu autorisé), jamais de géométrie, de mesure, de coût, de responsable interne, de motif interne.
- Un jeu `RETIRE` n'est montré à personne ; un jeu non autorisé aux seuls décideurs ; un projet retiré répond 404 à tous (banc : 17 routes x 4 profils).
- Aucune écriture hors des six tables, de l'audit et des tables que le socle écrit déjà (banc : comptes de toutes les tables avant/après) ; aucune géométrie ni interlocuteur dans l'audit.
- Références de pièces : schémas `javascript:`, `data:`, `vbscript:`, `file:` refusés (y compris camouflés) ; texte affiché comme du texte.
- Constat de revue en cours de lot : `GET /api/audit` n'est pas sous le routeur du module ; un référent y aurait lu les noms d'agents et les motifs internes de ses propres objets. **Corrigé** (403 `COMPTE_REFERENT_RESTREINT` sur les entités du module).

## 5. Limites, risques, erreurs connues (honnêtes)

- **Client Prisma partagé** : j'ai changé `schema.prisma` ; un `prisma generate` a modifié le client partagé de `w-pv` (plusieurs agents l'écrasent tour à tour : mon premier `tsc` a échoué pour cette raison). J'ai ensuite **remplacé la jonction `node_modules` de mon worktree par un dossier à moi** (jonctions vers celui de `w-pv`, sauf `@prisma` et `.prisma` copiés) : mon client est privé, celui de `w-pv` ne contient pas mes modèles (il faudra régénérer après fusion). Non suivi par git.
- Les clés étrangères sont dans la migration seulement (pas de relation Prisma) : l'outil de dérive les signalera comme écarts documentés ; non exécuté ici.
- Un référent reste un `LECTEUR` : il garde les lectures ouvertes de la Console qui ne demandent aucune clé de module (patrimoine routier) ; le retrait de la clé de module à la révocation n'est pas automatique (avertissement dans la réponse).
- Pas de lecture du workflow pour observateurs et auditeurs par défaut (ouvrable par configuration, en vue de projet) ; la lecture du journal passe par `GET /api/audit`, **qui ne trace pas les lectures** (limite existante du dépôt : « consultation journalisée » de l'auditeur non réalisée).
- Séparation des tâches : une dérogation d'un ADMIN à lui-même reste possible (comme RC-3, point 34a).
- Les routes de liste n'ont pas de délai propre côté base (pagination bornée à 100 lignes), comme RC-3.
- Non exécuté : lint, build, suite frontend (hors périmètre), outil de dérive du schéma, déploiement, banc de charge dédié, `run.sh` complet (seul le banc du lot a été lancé), les autres bancs d'intégration.
- Le banc dure environ 6 minutes (dont 38 s de créations de volume) sur cette machine chargée.

## 6. Décisions que le DSI doit prendre

1. La correspondance des rôles du cahier (contrat, section 2), notamment l'absence d'un attribut « responsable de validation » distinct.
2. La matrice (section 3.2) : validation d'un récolement par ADMIN seul (défaut prudent) ou aussi GESTIONNAIRE ; lecture du workflow pour observateurs et auditeurs.
3. Autoriser un jeu : interdire au déposant de l'autoriser lui-même (aujourd'hui non bloquant, **non modifié**) ; qui approuve les règles de conflit (aujourd'hui ADMIN seul).
4. Récolement obligatoire à la clôture (`PROJETS_VOIRIE_RECOLEMENT_OBLIGATOIRE`, désactivé : l'activer change un comportement testé de RC-3).
5. Stockage de pièces jointes ; dépôt de jeux par un référent (non ouvert) ; retrait automatique de la clé de module à la révocation ; dérogation d'un ADMIN envers lui-même.
6. Plafonds et cadence par défaut (30 créations par minute et par compte et par projet, 2000 demandes, 5000 tâches, 500 récolements, 200 preuves) : aucun n'est un seuil métier.

## 7. Décisions hors contrat prises

Rattachement pour un compte `LECTEUR` seulement (échec fermé si le rôle change) ; tâche liée à un conflit ou à une demande **non partagée par défaut** (`partagee` explicite) ; un référent responsable d'une tâche impose qu'elle soit partagée ; récolement `BROUILLON` toujours interne (même rouvert après un rejet) ; motifs de rejet et de clôture internes ; dossiers vus du référent : confirmés par une personne seulement ; recolement lié à un dossier clos accepté (suivi de la mention) ; `recolementId` rejeté hors clôture.

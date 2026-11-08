# Workflow concessionnaire, rôles du cahier et récolement : contrat d'interface (lot B3)

Statut : contrat de départ du 07/11/2026, commun au backend et à un futur agent d'interface. Complète `CONTRAT.md` (socle), `CONTRAT-CONFLITS.md` (dossiers de conflit, RC-3) et `API.md`. Référence : cahier des charges v2.0, sections 2 (rôles), 2.1 (matrice), 3.1 (parcours, étape 9), 3.2 (états de la demande concessionnaire), 23 (sécurité), scénarios KIS-SEC-01 et KIS-REV-01. Base : `feat/rc3-integration`. Migration : `20261101300000_workflow_roles_recolement`. Ce lot est **backend seulement** : aucune interface.

**Provisoire.** La correspondance des rôles du cahier avec les rôles de la Console (section 2) et la matrice des droits (section 3) sont une **proposition prudente**, qui attend la décision du DSI. Elles sont codées derrière une configuration (section 3.3) pour qu'une décision différente ne demande pas de modification du code.

## 1. Principes

1. **L'application n'envoie aucun courriel, aucun message, aucune requête vers un tiers.** Une demande de données à un concessionnaire est envoyée **hors application** (courriel, courrier, remise en main propre) par une personne ; l'application **enregistre** cet envoi (date, canal, référence, interlocuteur) et l'identité de la personne qui l'enregistre. Aucun module du workflow n'importe `lib/mailer`, `nodemailer`, ni client HTTP (un test statique le garantit). Une référence de pièce est un texte : l'application ne l'ouvre ni ne la suit jamais.
2. **Aucune écriture dans le référentiel officiel** (tronçons, ouvrages...), aucune écriture dans les jeux de données : recevoir une réponse (lier un jeu reçu à une demande), valider un récolement ou clore une tâche **ne modifie ni le référentiel, ni un jeu, ni un conflit**. Un jeu reçu passe toujours par le dépôt, la quarantaine et l'autorisation du socle.
3. **Suppression logique seulement** : aucune table du lot ne supprime de ligne (déclencheur de refus, y compris `TRUNCATE`) ; une demande ou une tâche abandonnée passe en `ANNULEE`, un rattachement est révoqué.
4. **Historique en ajout seul** (déclencheurs refusant UPDATE et DELETE) pour les demandes, tâches et récolements (avant/après, auteur, profil, date, justification), et pour les preuves.
5. **Toute écriture est auditée** dans `audit_logs`, dans la transaction qui la porte, sans géométrie. Types d'entité : `ReferentConcessionnaire`, `DemandeConcessionnaire`, `TacheProjetVoirie`, `RecolementProjetVoirie` (les preuves sont auditées sous l'objet qui les porte). Lisibles par `GET /api/audit` pour un compte qui a la clé de module (c'est la voie de lecture de l'**auditeur**).
6. **Pas de rôle global parallèle** : aucun nouveau rôle technique, aucune seconde authentification. Un référent concessionnaire est un compte `LECTEUR` portant la clé de module `projets-voirie` et un **attribut de compte** (un rattachement à un concessionnaire pour un projet, posé par un `ADMIN`).
7. **Un jeu `RETIRE` n'est montré à personne ; un jeu autre que `AUTORISE` n'est montré qu'à ADMIN et GESTIONNAIRE** (règle du socle, reprise telle quelle). Un projet retiré ou inconnu répond 404 pour tous, nationaux compris.
8. **Aucun seuil métier inventé** : plafonds et cadences sont des variables d'environnement bornées (section 9), à valider.

## 2. Correspondance des rôles du cahier avec les rôles de la Console (PROPOSITION, décision du DSI)

Audit du dépôt (07/11/2026) : la Console connaît **quatre rôles techniques** (`ADMIN`, `GESTIONNAIRE`, `INSPECTEUR`, `LECTEUR`), des **clés de module** par compte (`modulesAutorises`, dont `projets-voirie`, jamais portée par un profil métier), un **périmètre territorial** par régions (`perimetres_comptes`), onze **profils métier** qui ne sont que des préréglages de rôle et de modules (`lib/profils.ts`), et le droit `peutDeleguerValidation` (désignation d'un validateur de **données de terrain**). **Aucune notion d'organisation ou de concessionnaire n'est attachée aux comptes.**

| Rôle du cahier | Compte proposé | Attribut ou clé | Ce qu'il fait par défaut | Nouveau ? |
|---|---|---|---|---|
| Administrateur BDRI | `ADMIN` | néant | tout, y compris poser et révoquer un rattachement de référent | non |
| Gestionnaire de projet AGEROUTE | `GESTIONNAIRE` | clé `projets-voirie` | écrit le workflow (demandes, tâches, récolements, preuves) ; ne valide pas un récolement | non |
| Ingénieur études / SIG | `GESTIONNAIRE` (profil `ADMIN_SIG` ou `INGENIEUR_RESEAU`) | clé `projets-voirie` | comme le gestionnaire | non |
| **Référent concessionnaire** | `LECTEUR` | clé `projets-voirie` **et** rattachement `(compte, concessionnaire, projet)` | lit et complète **uniquement** les éléments partagés de son concessionnaire dans les projets où il est rattaché ; **aucune route du socle** | **un attribut de compte** (table `referents_concessionnaire`), pas un rôle |
| **Responsable de validation AGEROUTE** | `GESTIONNAIRE` ou `ADMIN`, selon l'acte | clé `projets-voirie` | décisions : `ADMIN` ou `GESTIONNAIRE` (RC-3) ; clôture d'un dossier et approbation d'une règle : `ADMIN` (RC-3) ; validation d'un récolement : `ADMIN` par défaut, configurable ; séparation des tâches partout | non : pas de rôle « validateur » ; l'attribut `peutDeleguerValidation` concerne la validation de données de terrain et n'est **pas** réutilisé |
| **Auditeur** | `LECTEUR` (profil `AUDITEUR`) | clé `projets-voirie` | aucune écriture ; lit le socle comme un observateur ; **lit le journal** par `GET /api/audit` (types d'entité du module) ; lecture du workflow non ouverte par défaut (configurable) | non |
| **Agent terrain** | `INSPECTEUR` (profil `AGENT_TERRAIN`) | clé `projets-voirie` | exécute **ses propres tâches** et y ajoute des preuves de relevé ; aucune écriture du socle | non |
| **Observateur / lecture seule** | `LECTEUR` | clé `projets-voirie` | socle en lecture seule, inchangé ; lecture du workflow non ouverte par défaut (configurable) | non |

Choix prudents et pourquoi :
- Un référent est `LECTEUR` et **jamais** `GESTIONNAIRE` : un gestionnaire peut déposer, autoriser et lire tout le socle. Le rattachement n'est accepté que pour un compte `LECTEUR` actif qui a la clé de module (422 sinon) ; il est refusé à un `ADMIN`. Si le rôle du compte change ensuite, le rattachement **continue de restreindre** le compte (échec fermé).
- **Un compte qui a au moins un rattachement actif n'ouvre aucune route du socle ni des dossiers de conflit** (403 `COMPTE_REFERENT_RESTREINT`) : le socle donnerait à tout lecteur la carte et les analyses de tous les projets de son périmètre. Le référent n'a que les routes `/workflow/...`.
- Le rattachement est posé par un `ADMIN` seulement : il donne accès à des données de tiers.
- **Décision du DSI attendue** : cette correspondance, la création éventuelle d'un attribut « responsable de validation » (aujourd'hui absent), l'ouverture de la lecture du workflow aux observateurs et auditeurs, et l'ouverture du dépôt de jeux aux référents (non faite : la réception reste un acte d'AGEROUTE).

Un rattachement révoqué **ne retire pas** la clé de module du compte : le compte redevient un lecteur ordinaire (il lit les jeux `AUTORISE` du socle dans son périmètre). L'administrateur doit retirer la clé de module s'il veut couper l'accès (la réponse de révocation le rappelle dans `avertissements`).

## 3. Matrice des droits

### 3.1 Droits actuels du socle et de RC-3 (synthèse ; AUCUN n'est modifié par ce lot)

| Acte | Qui | Séparation des tâches | Source |
|---|---|---|---|
| Déposer un jeu, le retirer | ADMIN, GESTIONNAIRE | non | socle |
| **Autoriser** ou rejeter un jeu | ADMIN, GESTIONNAIRE, justification de 10 caractères | **non bloquante** : le déposant peut autoriser son propre dépôt, l'audit le note (`memePersonne: true`) | socle, `CONTRAT.md` 3 |
| **Retirer** un jeu (RETIRE) | ADMIN, GESTIONNAIRE | non | socle |
| Retirer un projet ; valider les largeurs (`statutParametres: VALIDE`) | ADMIN | non | socle |
| Créer une règle de conflit (brouillon) | ADMIN, GESTIONNAIRE | non | RC-3 |
| **Approuver une règle** | ADMIN | l'auteur n'approuve pas sa propre règle sans dérogation motivée | RC-3 |
| Lancer une analyse persistée | ADMIN, GESTIONNAIRE | cadence d'une analyse par minute et par projet | RC-3 |
| Transitions d'un conflit | ADMIN, GESTIONNAIRE ; infirmer un dossier confirmé, clôturer : ADMIN | clôture : le proposeur ne clôt pas sans dérogation d'un ADMIN | RC-3 tableau 4 |
| Proposer une décision | ADMIN, GESTIONNAIRE | non | RC-3 |
| **Approuver ou refuser une décision** | ADMIN, GESTIONNAIRE | le proposant ne tranche pas sa décision sans dérogation motivée (ADMIN pour un déplacement de réseau ou dès deux comptes habilités) | RC-3 |
| **Clore un dossier** | ADMIN | voir ci-dessus ; mention du récolement exigée si un déplacement est décidé (section 7) | RC-3 |

Points signalés au DSI, **non modifiés** : (a) le déposant d'un jeu peut l'autoriser lui-même (le cahier demande une séparation « lorsque possible ») ; proposition : refuser sauf dérogation d'un ADMIN, comme pour les décisions ; changement de droit, donc décision et test préalables ; (b) un ADMIN peut s'accorder à lui-même une dérogation (RC-3, point 34a) ; (c) **qui approuve les règles** reste une décision du DSI (aujourd'hui : ADMIN seul).

### 3.2 Droits du workflow (ce lot)

Profil effectif d'un compte : `REFERENT` s'il a un rattachement actif, sinon son rôle technique (`ADMIN`, `GESTIONNAIRE`, `INSPECTEUR`, `LECTEUR`).

| Action (identifiant) | Effet | ADMIN | GESTIONNAIRE | INSPECTEUR | LECTEUR | REFERENT | Configurable |
|---|---|---|---|---|---|---|---|
| `referent.gerer` | poser, révoquer un rattachement | oui | non | non | non | non | non |
| `referent.lire` | lister les rattachements d'un projet | oui | oui | non | non | non | non |
| `workflow.lire` | lire demandes, tâches, récolements, jeux (vue restreinte), dossiers (vue concessionnaire) | oui | oui | non | non | oui, **son périmètre** | `INSPECTEUR`, `LECTEUR` |
| `demande.ecrire` | créer, modifier, enregistrer envoi, réception, clôture, annulation | oui | oui | non | non | non | `GESTIONNAIRE` |
| `tache.gerer` | créer, modifier, réaffecter, annuler, valider | oui | oui | non | non | non | `GESTIONNAIRE` |
| `tache.executer` | faire avancer **sa propre** tâche | oui | oui | oui | non | oui | `GESTIONNAIRE`, `INSPECTEUR`, `REFERENT` |
| `preuve.ajouter` | ajouter une preuve | oui | oui | oui, sur **ses** tâches | non | oui, sur les éléments **de son concessionnaire** | `GESTIONNAIRE`, `INSPECTEUR`, `REFERENT` |
| `recolement.ecrire` | créer, modifier, soumettre, retirer | oui | oui | non | non | non | `GESTIONNAIRE` |
| `recolement.valider` | valider ou rejeter un récolement soumis | oui | **non** | non | non | non | `GESTIONNAIRE` |

`ADMIN` figure toujours dans toutes les actions (une configuration ne peut pas l'en retirer). `REFERENT` ne peut jamais recevoir `referent.*`, `demande.ecrire`, `tache.gerer`, `recolement.*`.

Actes du socle et de RC-3 repris pour mémoire dans la réponse de `GET /workflow/mon-profil` (clé `socle`, **non configurables**, appliqués par le socle) : autoriser et retirer un jeu, approuver une règle, approuver une décision, clore un dossier.

### 3.3 Configuration

Variable `PROJETS_VOIRIE_WORKFLOW_MATRICE` : objet JSON `{ "<action>": ["PROFIL", ...] }` qui **remplace** la liste d'une action configurable. Entrée ignorée (avec un avertissement lisible dans `mon-profil`) si l'action est inconnue ou non configurable, si un profil est inconnu ou n'est pas permis pour cette action, ou si le JSON est illisible ; `ADMIN` est ajouté d'office. Exemple : `{"recolement.valider":["GESTIONNAIRE"],"workflow.lire":["LECTEUR"]}`. Défaut : le tableau ci-dessus.

Lire le workflow avec `workflow.lire` accordé à `INSPECTEUR` ou `LECTEUR` donne une **vue de projet** : demandes (sans interlocuteur), tâches et récolements **non liés à un conflit** et sans lien vers un jeu non autorisé, jamais d'historique ni de preuves internes.

## 4. Modèle de données

Tables snake_case, colonnes camelCase, identifiants uuid (texte), dates de jour `AAAA-MM-JJ`. Aucune géométrie. Les clés étrangères sont dans la migration seulement (pas de relation Prisma : le schéma Prisma reste additif en fin de fichier).

- **`referents_concessionnaire`** (rattachement) : `id`, `userId`, `concessionnaireId`, `projetId`, `creeParId`, `motif` (10 caractères au moins), `createdAt`, `revoqueLe?`, `revoqueParId?`, `motifRevocation?`. Unique partiel : un rattachement actif par `(userId, projetId, concessionnaireId)`. Seule la révocation modifie la ligne (une fois).
- **`demandes_concessionnaire`** : `id`, `projetId`, `concessionnaireId` (immuable), `objet` (1 à 200), `description?` (4000), `echeance?`, `statut` (`BROUILLON`, `ENVOYEE`, `RECUE`, `CLOTUREE`, `ANNULEE`), `canalEnvoi?`, `dateEnvoi?`, `referenceEnvoi?`, `interlocuteur?`, `envoyeParId?`, `envoyeLe?`, `dateReception?`, `recueParId?`, `recueLe?`, `jeuRecuId?`, `finParId?`, `finLe?`, `motifFin?`, `creeParId`, `createdAt`, `updatedAt`.
- **`taches_projet_voirie`** : `id`, `projetId`, `titre` (1 à 200), `description?` (4000), `conflitId?` ou `demandeId?` (au plus un des deux), `concessionnaireId?` (déduit du lien, immuable ; **le renseigner partage la tâche avec les référents de ce concessionnaire**), `responsableId`, `echeance?`, `statut` (`A_FAIRE`, `EN_COURS`, `A_VALIDER`, `TERMINEE`, `ANNULEE`), `priorite` (`BASSE`, `NORMALE`, `HAUTE`, `URGENTE`), `validationRequise`, `termineLe?`, `creeParId`, `createdAt`, `updatedAt`.
- **`recolements_projet_voirie`** : `id`, `projetId`, `conflitId?`, `jeuId?` (au moins un des deux ; immuables), `concessionnaireId?` (déduit), `objet` (1 à 200), `constat?` (4000), `ecarts?` (4000), `dateRecolement?`, `statut` (`BROUILLON`, `SOUMIS`, `VALIDE`, `REJETE`), `revision` (entier, +1 à chaque modification), `soumisParId?`, `soumisLe?`, `decideParId?`, `decideLe?`, `motifDecision?`, `derogationSeparation?`, `creeParId`, `createdAt`, `updatedAt`. Unique partiel : un récolement `BROUILLON` ou `SOUMIS` au plus par conflit, et par jeu.
- **`preuves_workflow_projet`** (ajout seul) : `id`, `projetId`, `objetType` (`DEMANDE`, `TACHE`, `RECOLEMENT`), `objetId`, `type` (`NOTE`, `REFERENCE_DOCUMENT`, `COURRIER`, `REPONSE_CONCESSIONNAIRE`, `PLAN_RECOLEMENT`, `RELEVE_TERRAIN`), `texte` (1 à 4000), `reference?` (500), `nomFichier?` (255), `sha256?` (64 hexadécimaux), `tailleOctets?`, `partagee` (visible du référent), `auteurId`, `auteurProfil`, `createdAt`.
  **Le stockage de pièces jointes n'est pas décidé** : le socle n'en fournit pas pour ce module ; ce lot ne stocke **que des références et des empreintes** (nom, SHA-256, taille déclarée, texte libre de localisation). Aucun fichier, aucun système de fichiers. Une référence qui commence par `javascript:`, `data:`, `vbscript:` ou `file:` est refusée (400 `REFERENCE_INVALIDE`) ; elle est toujours affichée comme du texte.
- **`workflow_projet_historique`** (ajout seul) : `id`, `projetId`, `objetType`, `objetId`, `action` (`CREATION`, `MODIFICATION`, `STATUT`, `PREUVE`), `ancienStatut?`, `nouveauStatut?`, `justification?`, `acteurId`, `acteurProfil`, `donnees` (JSON : `avant` et `apres` des champs modifiés, ou les champs de la transition), `createdAt`.

## 5. États et règles

Toute transition écrit une ligne d'historique et une ligne d'audit, dans une seule transaction, sous un verrou du projet propre au workflow (sérialise les écritures, rend les plafonds exacts). Une transition non prévue : 409 `TRANSITION_INTERDITE`. Un état terminal ne change plus (409 `STATUT_INCOMPATIBLE`, et déclencheur de la base).

### 5.1 Demande de données

```
BROUILLON --envoi enregistré--> ENVOYEE --réception enregistrée--> RECUE --> CLOTUREE
    |                              |  \--clôture sans réponse (motif)--> CLOTUREE
    +--annulation (motif)--> ANNULEE <--+
```
- `ENVOYEE` : `canalEnvoi` (1 à 100, obligatoire), `dateEnvoi` (obligatoire, pas dans le futur), `referenceEnvoi?`, `interlocuteur?` (texte libre, minimiser les données personnelles : pas de courriel ni de téléphone exigés). **Aucun message n'est émis.**
- `RECUE` : `dateReception` (obligatoire, pas dans le futur, pas avant `dateEnvoi`), `jeuRecuId?` (lien facultatif vers un jeu du **même projet et du même concessionnaire**, rôle réseau tiers, jamais `RETIRE` : 422 `LIEN_INVALIDE` sinon). Le lien est une information : la réception ne modifie pas le jeu, il reste en quarantaine jusqu'à son autorisation. `PATCH` permet de lier ensuite un jeu reçu (état `RECUE`, historisé).
- `CLOTUREE`, `ANNULEE` : motif de 10 caractères au moins.
- Modifier : en `BROUILLON` `objet`, `description`, `echeance` ; en `ENVOYEE` `echeance` seule, avec justification (10 caractères) ; en `RECUE` `jeuRecuId` seul. Le concessionnaire ne change jamais.
- Le référent ne voit pas un `BROUILLON` (une demande n'est visible de lui qu'une fois envoyée, `envoyeLe` renseigné, y compris si elle est annulée ensuite).

### 5.2 Tâche

```
A_FAIRE --> EN_COURS --> TERMINEE                    (validationRequise = false)
A_FAIRE --> EN_COURS --> A_VALIDER --> TERMINEE      (validationRequise = true ; séparation des tâches)
A_VALIDER --refus motivé--> EN_COURS ;  A_FAIRE, EN_COURS, A_VALIDER --annulation motivée--> ANNULEE
```
- Création (`tache.gerer`) : `responsableId` obligatoire : compte **actif** avec la clé de module, et soit `ADMIN`, `GESTIONNAIRE`, `INSPECTEUR`, soit **référent rattaché au concessionnaire de la tâche** (422 `RESPONSABLE_NON_HABILITE` sinon ; un `LECTEUR` non rattaché ne peut pas être responsable : il ne modifie rien). Un référent d'un autre concessionnaire n'est jamais responsable.
- Lien : `conflitId` (même projet, 404 `CONFLIT_INTROUVABLE` sinon) ou `demandeId` (même projet, 404 `DEMANDE_INTROUVABLE`) ; pas les deux (422 `LIEN_INVALIDE`). Le concessionnaire de la tâche est celui du lien (celui du conflit ou de la demande) ; un `concessionnaireId` explicite incohérent : 422 `CONCESSIONNAIRE_INCOHERENT`.
- Qui avance : le **responsable** (quel que soit son rôle, si `tache.executer` le permet) fait `A_FAIRE -> EN_COURS`, `EN_COURS -> A_VALIDER` (ou `TERMINEE` si aucune validation n'est requise) ; `tache.gerer` fait toutes les transitions. **Valider (`A_VALIDER -> TERMINEE`) exige `tache.gerer`** et la **séparation des tâches** : le valideur n'est ni la personne qui a mis la tâche à `A_VALIDER`, ni son responsable, sauf dérogation motivée d'un `ADMIN` (409 `SEPARATION_DES_TACHES`, noyau commun avec RC-3).
- Justification de 10 caractères au moins pour toute transition sauf `A_FAIRE -> EN_COURS`.
- Modifier (`tache.gerer`) : `titre`, `description`, `echeance`, `priorite`, `responsableId` (justification exigée), tant que la tâche n'est pas terminale.
- Le référent voit les tâches dont `concessionnaireId` est celui de son rattachement, et fait avancer celles dont il est responsable.

### 5.3 Récolement (as-built)

```
BROUILLON --soumission--> SOUMIS --validation par un tiers--> VALIDE (terminal)
                            |--rejet motivé--> REJETE --réouverture--> BROUILLON
                            +--retrait--> BROUILLON
```
- Un récolement est lié à un **conflit dont un déplacement est décidé** (statut `TRAITEMENT_DECIDE` ou `CLOTURE`, avec une décision `DEPLACER_RESEAU` approuvée en vigueur : 422 `CONFLIT_NON_ELIGIBLE` sinon) **ou** à un **jeu** reçu (plan de récolement déposé par le socle, jamais `RETIRE`), ou aux deux (concessionnaires cohérents). Le lien est immuable. Un récolement `BROUILLON` ou `SOUMIS` au plus par conflit et par jeu (409 `RECOLEMENT_EN_COURS`).
- Historisation : toute modification (`PATCH`, `BROUILLON` seulement) exige une **justification** (10 caractères) et écrit une ligne `MODIFICATION` avec les champs **avant et après**, l'auteur, son profil et la date ; `revision` augmente.
- Soumettre exige un `objet` et un `constat` renseignés (422 `CHAMPS_INCOMPLETS`).
- **Valider exige un tiers** : le valideur n'est ni le créateur, ni la personne qui a soumis, sauf dérogation motivée d'un `ADMIN` (409 `SEPARATION_DES_TACHES`, noyau commun avec RC-3 ; contrainte de la base), au moins une preuve qui n'est pas une simple note (409 `PREUVE_REQUISE`), et le droit `recolement.valider`.
- **Valider un récolement ne met à jour ni le référentiel officiel, ni un jeu, ni le conflit** : il atteste le dossier et sert à la clôture (section 7). Un récolement validé ne se corrige pas : on en crée un nouveau.
- Le référent voit les récolements de son concessionnaire une fois soumis, sans historique, et peut y ajouter des preuves partagées tant qu'ils sont `SOUMIS` ou `REJETE`.

### 5.4 Preuves

Ajout seul. Interdit sur un objet terminal (demande `CLOTUREE` ou `ANNULEE`, tâche `TERMINEE` ou `ANNULEE`, récolement `VALIDE`) : 409 `STATUT_INCOMPATIBLE`. Plafond par objet (section 9).
- `ADMIN`, `GESTIONNAIRE` : tout objet du projet, `partagee` au choix (défaut `false` : note interne).
- `INSPECTEUR` : seulement une tâche **dont il est responsable** ; types `NOTE`, `REFERENCE_DOCUMENT`, `RELEVE_TERRAIN` ; `partagee: false` imposé.
- `REFERENT` : seulement un élément visible de lui et de son concessionnaire (demande `ENVOYEE` ou `RECUE`, tâche non terminale, récolement `SOUMIS` ou `REJETE`) ; types `NOTE`, `REFERENCE_DOCUMENT`, `REPONSE_CONCESSIONNAIRE`, `PLAN_RECOLEMENT` ; `partagee: true` imposé. Un référent ne lit que les preuves `partagee`.

## 6. Accès par organisation

- **Référent** : voit et écrit uniquement ce qui porte le `concessionnaireId` de l'un de ses rattachements actifs, dans les projets où il est rattaché. Un élément d'un autre concessionnaire, un projet où il n'est pas rattaché, ou un projet retiré répondent **404 masqué** (même réponse qu'un identifiant inconnu). Le périmètre territorial du compte s'applique en plus (même garde que le socle).
- **Jeux** (`GET /workflow/jeux`) : vue restreinte, sans géométrie ni empreinte ni auteur : identifiant, version, nom de fichier, format, date, nombre d'objets, classe de précision, statut ; pour le référent, jeux **`AUTORISE`** de **son** concessionnaire seulement.
- **Dossiers de conflit** (`GET /workflow/conflits`) : vue concessionnaire sans géométrie, sans mesure, sans responsable ; le référent ne voit que les dossiers de son concessionnaire, **confirmés par une personne** (`CONFIRME`, `TRAITEMENT_DECIDE`, `CLOTURE`), dont le jeu est `AUTORISE` : une proposition du système (`A_INVESTIGUER`, `POTENTIEL`, `INFIRME`) est un signal interne. Il voit la décision approuvée (option, dates prévues), jamais les coûts ni la justification.
- **Aucune route du socle ni des dossiers de conflit pour un référent** (403 `COMPTE_REFERENT_RESTREINT`, avant toute lecture).
- Tests d'isolation inter-concessionnaires et inter-projets : routes (`projets-voirie.workflow.routes.test.ts`) et banc PostGIS (`workflow-roles.integration.mts`).

## 7. Récolement et clôture d'un dossier (extension minimale de RC-3, section 9, point 35)

RC-3 exige, à la clôture d'un dossier dont un déplacement de réseau est décidé, la mention explicite `recolementAValider: true`. Extension, **rétrocompatible** :
- `POST /:id/conflits/:cid/statut` accepte en plus `recolementId` (UUID). Si un déplacement est décidé et que `recolementId` désigne un récolement **`VALIDE` de ce dossier**, la mention n'est plus exigée ; la ligne d'historique de la clôture porte `recolementId`. Un `recolementId` qui ne désigne pas un récolement de ce dossier : 404 `RECOLEMENT_INTROUVABLE` ; désigne un récolement non validé : 409 `RECOLEMENT_NON_VALIDE`.
- Sans `recolementId`, le comportement de RC-3 est **inchangé** (mention `recolementAValider: true`, 422 `MENTION_RECOLEMENT_REQUISE` sinon).
- Réglage `PROJETS_VOIRIE_RECOLEMENT_OBLIGATOIRE=1` (défaut : désactivé) : la clôture d'un dossier à déplacement décidé exige alors un récolement validé (409 `RECOLEMENT_NON_VALIDE`, la mention seule ne suffit plus). **Désactivé par défaut parce que l'activer change un comportement testé de RC-3** : décision du DSI.

## 8. API (préfixe `/api/v2/projets-voirie`)

Gardes, dans l'ordre : jeton, clé de module, octet NUL (400), identifiants d'URL en UUID (400 `IDENTIFIANT_INVALIDE`), **restriction du compte rattaché** (403 `COMPTE_REFERENT_RESTREINT` hors `/workflow/...`), projet désigné (404 masqué ; pour un référent : rattachement à ce projet, sinon la même 404), droit de la matrice (403 `ACTION_NON_AUTORISEE` avec le champ `action`), validation du corps (400), service. Réponses `Cache-Control: no-store`. Erreurs `{ error, code, ... }`.

| Route | Droit | Contenu |
|---|---|---|
| `GET /workflow/mon-profil` | tout compte du module | `{ role, referent, rattachements: [{ id, projet: {id, code, nom}, concessionnaire: {id, nom} }], droits: [action], matrice, socle, correspondanceCahier, provisoire: true, avertissements }` |
| `GET /:id/workflow/referents` | `referent.lire` | `{ rattachements: [...] }` (actifs et révoqués) |
| `POST /:id/workflow/referents` | `referent.gerer` | `{ userId, concessionnaireId, motif }` : 201 `{ rattachement }` ; 422 `COMPTE_NON_ELIGIBLE` (inactif, rôle autre que `LECTEUR`), 422 `COMPTE_SANS_MODULE`, 400 `COMPTE_INCONNU`, 404 `CONCESSIONNAIRE_INTROUVABLE`, 409 `RATTACHEMENT_DEJA_ACTIF` |
| `POST /:id/workflow/referents/:rattachementId/revoquer` | `referent.gerer` | `{ motif }` : `{ rattachement, avertissements }` ; 409 `RATTACHEMENT_DEJA_REVOQUE` |
| `GET /:id/workflow/jeux` | `workflow.lire` | `{ jeux: [vue restreinte] }` |
| `GET /:id/workflow/conflits` | `workflow.lire` | `?statut&type&limite&curseur` : `{ conflits: [...], curseurSuivant }` (vue concessionnaire, section 6) |
| `GET /:id/workflow/demandes` | `workflow.lire` | `?statut&concessionnaireId&echeanceDepassee&limite&curseur` : `{ demandes, compteurs, curseurSuivant }` |
| `POST /:id/workflow/demandes` | `demande.ecrire` | `{ concessionnaireId, objet, description?, echeance? }` : 201 `{ demande }` (`BROUILLON`) |
| `GET /:id/workflow/demandes/:demandeId` | `workflow.lire` | `{ demande, preuves, historique?, transitionsPossibles }` (historique : comptes qui décident) |
| `PATCH /:id/workflow/demandes/:demandeId` | `demande.ecrire` | `{ objet?, description?, echeance?, jeuRecuId?, justification? }` : `{ demande }` |
| `POST /:id/workflow/demandes/:demandeId/statut` | `demande.ecrire` | `{ vers: ENVOYEE, canalEnvoi, dateEnvoi, referenceEnvoi?, interlocuteur? }`, `{ vers: RECUE, dateReception, jeuRecuId?, note? }`, `{ vers: CLOTUREE or ANNULEE, justification }` : `{ demande }` |
| `POST /:id/workflow/demandes/:demandeId/preuves` | `preuve.ajouter` | `{ type, texte, reference?, nomFichier?, sha256?, tailleOctets?, partagee? }` : 201 `{ preuve }` |
| `GET /:id/workflow/taches` | `workflow.lire` | `?statut&responsableId&conflitId&demandeId&concessionnaireId&echeanceDepassee&limite&curseur` |
| `POST /:id/workflow/taches` | `tache.gerer` | `{ titre, description?, responsableId, echeance?, priorite?, validationRequise?, conflitId?, demandeId?, concessionnaireId? }` : 201 `{ tache }` |
| `GET /:id/workflow/taches/:tacheId` | `workflow.lire` | `{ tache, preuves, historique?, transitionsPossibles }` |
| `PATCH /:id/workflow/taches/:tacheId` | `tache.gerer` | `{ titre?, description?, echeance?, priorite?, responsableId?, justification? }` |
| `POST /:id/workflow/taches/:tacheId/statut` | `tache.executer` (le service exige `tache.gerer` hors responsable) | `{ vers, justification?, derogation? }` |
| `POST /:id/workflow/taches/:tacheId/preuves` | `preuve.ajouter` | comme pour une demande |
| `GET /:id/workflow/recolements` | `workflow.lire` | `?statut&conflitId&jeuId&limite&curseur` |
| `POST /:id/workflow/recolements` | `recolement.ecrire` | `{ conflitId?, jeuId?, objet, constat?, ecarts?, dateRecolement? }` : 201 `{ recolement }` |
| `GET /:id/workflow/recolements/:recolementId` | `workflow.lire` | `{ recolement, preuves, historique?, transitionsPossibles }` |
| `PATCH /:id/workflow/recolements/:recolementId` | `recolement.ecrire` | `{ objet?, constat?, ecarts?, dateRecolement?, justification }` |
| `POST /:id/workflow/recolements/:recolementId/statut` | `recolement.ecrire` (valider et rejeter : `recolement.valider`) | `{ vers: SOUMIS or BROUILLON or VALIDE or REJETE, justification, derogation? }` |
| `POST /:id/workflow/recolements/:recolementId/preuves` | `preuve.ajouter` | comme pour une demande |

Listes : `limite` de 1 à 100 (défaut 25), curseur opaque (mêmes règles que RC-3 : un curseur forgé est refusé en 400 `CURSEUR_INVALIDE`). Aucune route ne contient `ordre`, `déplacement` ni `ordonnancement`, et aucune route n'envoie de message.

### Codes d'erreur ajoutés

400 `COMPTE_INCONNU`, `REFERENCE_INVALIDE`, `CURSEUR_INVALIDE`, `CHAMPS_INVALIDES` ; 403 `COMPTE_REFERENT_RESTREINT`, `ACTION_NON_AUTORISEE` ; 404 `PROJET_INTROUVABLE`, `DEMANDE_INTROUVABLE`, `TACHE_INTROUVABLE`, `RECOLEMENT_INTROUVABLE`, `RATTACHEMENT_INTROUVABLE`, `CONCESSIONNAIRE_INTROUVABLE`, `CONFLIT_INTROUVABLE`, `JEU_INTROUVABLE` ; 409 `TRANSITION_INTERDITE`, `STATUT_INCOMPATIBLE`, `SEPARATION_DES_TACHES`, `PREUVE_REQUISE`, `RECOLEMENT_EN_COURS`, `RATTACHEMENT_DEJA_ACTIF`, `RATTACHEMENT_DEJA_REVOQUE`, `RECOLEMENT_NON_VALIDE` ; 422 `JUSTIFICATION_REQUISE`, `DATE_INVALIDE`, `RESPONSABLE_NON_HABILITE`, `COMPTE_NON_ELIGIBLE`, `COMPTE_SANS_MODULE`, `CONCESSIONNAIRE_INCOHERENT`, `LIEN_INVALIDE`, `CONFLIT_NON_ELIGIBLE`, `CHAMPS_INCOMPLETS`, `QUOTA_ATTEINT` ; 429 `CADENCE_CREATION` (avec `retryAfterS` et `Retry-After`) ; 503 `PROJET_OCCUPE`.

## 9. Bornes, cadence, réglages (variables d'environnement, bornées : une valeur illisible redonne le défaut)

| Variable | Défaut | Bornes | Effet |
|---|---|---|---|
| `PROJETS_VOIRIE_WORKFLOW_CREATIONS_PAR_MINUTE` | 30 | 1 à 600 | créations (demandes, tâches, récolements, preuves) par compte et par projet sur 60 s : 429 `CADENCE_CREATION` |
| `PROJETS_VOIRIE_WORKFLOW_DEMANDES_MAX` | 2000 | 100 à 100 000 | demandes par projet (422 `QUOTA_ATTEINT`) |
| `PROJETS_VOIRIE_WORKFLOW_TACHES_MAX` | 5000 | 100 à 100 000 | tâches par projet |
| `PROJETS_VOIRIE_WORKFLOW_RECOLEMENTS_MAX` | 500 | 10 à 10 000 | récolements par projet |
| `PROJETS_VOIRIE_WORKFLOW_PREUVES_MAX` | 200 | 10 à 5 000 | preuves par objet |
| `PROJETS_VOIRIE_WORKFLOW_MATRICE` | (défaut) | JSON | section 3.3 |
| `PROJETS_VOIRIE_RECOLEMENT_OBLIGATOIRE` | désactivé | `1` | section 7 |

Délais côté base : ceux du socle (`PROJETS_VOIRIE_DELAI_DEPOT_MS`, `PROJETS_VOIRIE_VERROU_MS`).

### 9 bis. Verrous du projet et nouvelle tentative du client (revue de la vague 1, m6)

Le verrou consultatif du workflow sérialise les écritures du workflow entre elles, mais **il n'est pas indépendant du verrou des dépôts** : le dépôt, l'autorisation, le rejet, le retrait, la revue des suppressions et le retour arrière (lot A1), les écritures du lot B1 (propositions d'association, descripteurs, relations) et les règles de conflit prennent `FOR UPDATE` sur la ligne du projet, et toute insertion dans une table du workflow (clé étrangère vers le projet) prend `FOR KEY SHARE` sur cette même ligne. Conséquence, mesurée par le banc `workflow-roles` (section 11 bis) : une écriture du workflow **attend** la fin du dépôt ou de la proposition en cours (jusqu'à 20 à 60 s pour les plus longues opérations), puis, passé `PROJETS_VOIRIE_VERROU_MS` (5 s par défaut), répond **503 `PROJET_OCCUPE` sans rien écrire**. Seule l'analyse de conflits (verrou consultatif propre) ne bloque pas le workflow.

**Le client doit réessayer** (après quelques secondes) sur 503 `PROJET_OCCUPE` ; aucune écriture n'a eu lieu, un réessai ne crée pas de doublon. Le même 503 est rendu par les écritures du socle et de B1 pendant un dépôt. Décision possible, non prise : un verrou de projet partagé plus fin (par table), ou une file d'attente côté serveur.

## 10. Décisions à prendre par le DSI

1. La correspondance de la section 2, notamment l'absence d'un attribut « responsable de validation » distinct du rôle.
2. La matrice de la section 3.2, en particulier : validation d'un récolement par `ADMIN` seul (défaut prudent) ou aussi par `GESTIONNAIRE` ; ouverture de la lecture du workflow aux observateurs et auditeurs.
3. Autoriser un jeu : interdire à son déposant de l'autoriser (section 3.1, point a). Qui approuve les règles de conflit (aujourd'hui `ADMIN` seul).
4. Récolement exigé ou non à la clôture (section 7).
5. Stockage de pièces jointes (références et empreintes seulement aujourd'hui) ; dépôt de jeux par un référent (non ouvert).
6. Dérogation à la séparation des tâches par un `ADMIN` pour lui-même (comme RC-3) : autoriser ou exiger un second `ADMIN`.
7. Révoquer un rattachement : faut-il retirer automatiquement la clé de module (non fait : geste d'administration séparé).

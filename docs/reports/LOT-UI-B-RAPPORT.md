# LOT UI-B : interface des réseaux (B1) et du workflow concessionnaire (B3)

Branche `feat/ui-reseaux-workflow` (worktree `C:\ageroute-secours\w-ui2`), FRONTEND seulement, aucun fichier de `backend/` modifié, aucun push. Base : assistant d'import A2 déjà fusionné, puis fusion de `feat/vague1-final` (vague 1 corrigée) avant tout commit de ce lot.

## 1. Livraison

| Commit | Contenu |
|---|---|
| fusion de `feat/vague1-final` | backend corrigé (M1, limites multer, support compté sur jeux `AUTORISE` seulement, consultations tracées, 409 `DEPOT_EN_ATTENTE` et `SUPPRESSIONS_REFUSEES`) ; aucun conflit |
| `84efbbc` feat(reseaux) | onglet « Réseaux » de la page projet (écran 1) |
| commit suivant | écran « Échanges avec les concessionnaires » (écran 2) |
| commit final | ce rapport |

Un commit « WIP » antérieur (87daaf3, non vérifié) a été remplacé par ces commits (copie de sécurité locale : branche `backup-ui-b-wip`, à supprimer après relecture).

### Écran 1, Réseaux (B1)
- Onglet « Réseaux » (4e onglet, monté à la première visite, état conservé) avec bandeau permanent : une association automatique n'est qu'une proposition sans effet ; « un fichier de N lignes n'est pas N câbles ».
- **Objets** : liste avec nature (mot et forme : infrastructure physique, circuit logique, équipement, nature inconnue), type, classe de précision DÉCLARÉE (A à E ou « Classe non renseignée », jamais inventée), qualité, profondeur et altitude affichées seulement si fournies (jamais « 0 m » pour une absence) ; filtres nature, jeu, type, recherche ; pagination par curseur.
- **Fiche** : source du jeu, confidentialité, qualité, vertical (aucune conclusion 3D, `evaluable` jamais présenté comme vrai), circuits superposés (« ils restent séparés, ce ne sont pas des câbles distincts »), descripteur, relations.
- **Descripteur** : édition avec justification obligatoire ; PUT du corps complet (valeur omise = nulle) ; formulaire d'un objet sans descripteur VIDE (rien repris du jeu) ; choix limités à la géométrie ; bornes du serveur contrôlées avant l'envoi.
- **Relations** : propositions automatiques présentées « Proposée », avec le calcul (couverture, tolérance, provisoire) ; valider, refuser, revoquer avec justification (boutons = `actionsPossibles` du serveur, aucun pour un lecteur) ; déclaration manuelle depuis la fiche.
- **Proposition automatique** : états d'attente, bilan, 429 (compte à rebours depuis `retryAfterS`), 503, 504, 422, 409 en clair, réessai.
- **Comptage** : nombre d'infrastructures déclarées, longueur de trace fusionnée, somme des longueurs de circuits, chacun dans sa carte avec le libellé du serveur, jamais additionnés (« aucun total tous objets »).
- **Carte** : l'objet choisi est surligné (trait bleu nuit, halo blanc, zoom) à partir de la géométrie DÉJÀ chargée par la carte ; aucune route de géométrie n'est appelée.
- **Dossiers de conflit (modification minimale)** : `cible` (nature, qualification, support physique) dans la liste et la fiche, `tracePartagee` dans la fiche, champs masqués dits masqués.

### Écran 2, Échanges avec les concessionnaires (B3)
Routes `/projets-voirie/:id/echanges` et `/projets-voirie/echanges` (choix du projet), lien depuis la page projet.
- **Mon profil** : rôle, profil, rattachements, droits RENVOYÉS par `mon-profil` (seules les actions permises sont listées), mention provisoire, avertissements.
- **Demandes** : brouillon, enregistrement de l'envoi (canal, date passée, référence, interlocuteur) sous le libellé « L'envoi se fait hors application, enregistrez-le ici » ; réception (date, jeu reçu lié du même concessionnaire), clôture, annulation, modification selon l'état. Aucun champ de message, de destinataire ni de pièce jointe, aucun bouton d'envoi.
- **Tâches** : statuts, priorité, échéance, « mes tâches », création (lien demande ou dossier), modification, transitions = `transitionsPossibles` du serveur ; validation par un tiers avec rappel de la séparation des tâches ; champ de dérogation réservé à l'administrateur.
- **Récolements** : brouillon, modification avec justification (historique AVANT et APRÈS en tableau), soumission (bloquée si objet ou constat manquent), validation et rejet par un tiers, lien à un dossier dont un déplacement est décidé ou à un jeu reçu ; mention « ne met à jour ni le référentiel, ni un jeu, ni le conflit ».
- **Preuves** : références et empreintes seulement ; référence rendue en texte, jamais en lien ; schémas `javascript:`, `data:`, `vbscript:`, `file:` refusés avant l'envoi ; types et visibilité imposés par profil.
- **Référents** (administrateur : poser, révoquer ; gestionnaire : lecture) ; **Dossiers et jeux** en vue concessionnaire, lecture seule, sans géométrie ni coût.
- **Compte REFERENT** : n'appelle que `/workflow/...` ; la liste et la page projet redirigent vers l'écran des échanges sur 403 `COMPTE_REFERENT_RESTREINT`, sans erreur brute ; message dédié ailleurs.
- Aucun bouton n'ordonne, ne déplace ni n'envoie un message (garde statique et test d'écran entier).

## 2. Tests (chiffres réels, voir section 3 pour la barrière complète)

Fichiers ajoutés : `lib/projetsVoirieReseaux{,Api,Hooks}.ts` et tests, `lib/projetsVoirieWorkflow{,Api,Hooks}.ts` et tests, `components/projets-voirie/reseaux/*`, `components/projets-voirie/workflow/*`, `CadreDialogue.tsx`, pages et tests `ProjetVoirieReseaux.test.tsx`, `ProjetVoirieWorkflow.test.tsx`, `ProjetVoirieWorkflowPage.tsx`, `Accessibilite.reseaux.test.tsx`, `Accessibilite.workflow.test.tsx`. Fixtures 100 % synthétiques, formes relevées dans le code du backend (`vues.ts`, `*.service.ts`).

- Chaque erreur typée des deux lots a son message en clair (tests paramétrés), le texte du serveur n'est jamais montré pour un code connu (sauf la précision de la séparation des tâches et de `INCOHERENCE_REFUSEE`).
- Rôles couverts : lecteur, gestionnaire, administrateur, agent de terrain, référent ; champs masqués (source, vertical, interlocuteur, auteurs, motifs, historique, jeu).
- axe-core : 0 violation sur chaque vue et chaque dialogue (dialogues mesurés sur tout le document).
- Non-stockage : scan statique étendu automatiquement aux nouveaux dossiers (compte de fichiers relevé), routes des deux clients vérifiées (aucun ordre, déplacement, géométrie, envoi, suppression), et deux parcours exécutés avec espions sur tous les stockages (Réseaux, Échanges) : zéro appel.
- Contraste : le test statique existant parcourt les nouveaux dossiers ; boutons à bascule à deux chaînes de classes distinctes (actif et inactif).
- Durcissements de tests existants : `ProjetVoirieConflits.test.tsx` attend 4 onglets ; `ProjetsVoirie.nonStockage.test.tsx` : `findByRole("dialog")` du dépôt a un délai de 15 s (échec observé deux fois, sous charge, sur le chargement paresseux de l'assistant ; réussi seul).

## 3. Barrière complète

Commandes lancées depuis `frontend/` sur HEAD `b582138` (sauf mention).

| Contrôle | Résultat |
|---|---|
| `npx tsc --noEmit` | code 0 (relancé après le dernier commit) |
| `npx eslint src` | 0 erreur, 5 avertissements antérieurs au lot (TronconPickerGeo, AppLayout, DefautTerrainPage x2, VoirieLocaleLayer) ; `ProjetVoirieDetailPage.test.tsx` relinté après le dernier commit : propre |
| `npm run build` | réussi (193 fichiers précachés) |
| Suite frontend complète `npx vitest run --poolOptions.forks.maxForks=3 --poolOptions.forks.minForks=1` | 252 fichiers, 5 708 tests : 5 703 réussis, 4 en échec, 1 ignoré ; 247 fichiers réussis, 5 en échec ; durée 8 743 s (machine très chargée) |

Mes fichiers dans cette exécution complète : `ProjetVoirieWorkflow` 100, `ProjetVoirieReseaux` 92, `ProjetsVoirie.nonStockage` 17, `projetsVoirieWorkflowApi` 38, `projetsVoirieWorkflow` 58, `projetsVoirieReseaux` 60, `projetsVoirieReseauxApi` 33, `Accessibilite.workflow` 8, `Accessibilite.reseaux` 10 : tous verts.

Les 5 fichiers en échec dans la suite complète, rejoués ensuite ensemble : **5 fichiers, 75 tests, tous réussis**.
- `ProjetVoirieDetailPage.test.tsx` : l'échec était réel et causé par ce lot (la page compte désormais 4 onglets) ; corrigé dans `b582138` après le démarrage de la suite complète, 42 tests verts au rejeu.
- `GouvernancePage.test.tsx` (12), `BoutonExportDecision.test.tsx` (8), `TronconsPage.test.tsx` (6) : fichiers que je n'ai pas modifiés, échec sur délai sous charge, verts au rejeu isolé (classés instables sous charge, pas causés par le lot).
- `UsersPage.profils.test.tsx` (7) : fichier non modifié ; échec de chargement du worker (`Timeout calling "fetch"`, infrastructure vitest sous charge), vert au rejeu.

Je n'ai pas relancé une seconde suite complète après `b582138` (une exécution complète dure environ 2 h 25 sur cette machine) : le seul fichier modifié depuis est `ProjetVoirieDetailPage.test.tsx`, rejoué seul.

## 4. Vérification visuelle
Navigateur intégré, API simulée écrite HORS dépôt (supprimée, serveurs arrêtés, émulation remise à « desktop »). Constaté : onglet Réseaux, liste, fiche, mise en évidence sur la carte à 1280 px ; comptage et dialogue d'enregistrement de l'envoi à 375 px sans défilement horizontal ; compte référent : redirection de `/projets-voirie` vers `/projets-voirie/p1/echanges`, 5 sections, récolement soumis sans motif ni valideur, aucune erreur affichée, 375 px sans débordement. Rôle administrateur vérifié aux deux largeurs.

## 5. Non exécuté, écarts et limites
- **Aucun essai contre le vrai backend** : toutes les formes viennent du code lu et de `API.md`. À rejouer sur un environnement de recette avec les bancs.
- **Mise en évidence sur la carte** : seulement si l'objet est dans la vue déjà chargée ; sinon message (centrer sur le projet). Aucune route de B1 ne rend de géométrie : un zoom direct sur un objet hors vue exigerait une emprise par objet.
- **Écart de contrat (pré-remplissage du descripteur)** : `GET objets/:id` rend la classe, les précisions, la méthode et la date EFFECTIVES (descripteur ou jeu) sans dire d'où vient la précision, la méthode ni la date. L'interface pré-remplit ces champs seulement si un descripteur existe (sinon formulaire vide) ; si un descripteur existe mais omet une valeur que le jeu fournit, le formulaire propose la valeur du jeu et l'enregistrer la déclarerait. Demande au backend : rendre les valeurs déclarées du descripteur séparément.
- Listes de comptes : le module n'en expose pas ; le rattachement d'un référent cherche les comptes lecteurs actifs par `GET /users` (administrateur seulement, hors contrat du module) ; le responsable d'une tâche se choisit parmi soi-même, les référents du projet, ou un identifiant UUID saisi.
- Les mutations des nouveaux hooks ont `networkMode: "always"` (une écriture n'est jamais mise en pause en silence hors ligne) ; les mutations existantes des conflits n'ont pas été modifiées.
- Pas de GET d'une relation seule ni de lot (contrat). Non faits car hors mission : dépôt de jeux par un référent, stockage de pièces jointes (décision DSI), création de tâche liée depuis la fiche d'une demande (le lien se choisit à la création de la tâche).
- 503 `PROJET_OCCUPE` (revue m6) : message « rien n'a été écrit, réessayez, sans risque de doublon » ; les dialogues restent ouverts avec la saisie.
- 5 avertissements ESLint existants (fichiers non touchés), 0 erreur.

## 6. Décisions pour le DSI
1. Valider la présentation « Proposée, sans effet » et l'obligation de justification (10 caractères) pour valider, refuser, révoquer, qualifier.
2. Droits du descripteur (O7 de la revue) : un seul gestionnaire peut modifier la classe effective d'un jeu autorisé ; double validation à décider (l'interface n'ajoute aucun contrôle).
3. Matrice des droits du workflow (provisoire) : validation du récolement par l'administrateur seul ou aussi le gestionnaire ; lecture ouverte aux observateurs (l'écran suit `droits` du serveur sans changement).
4. Liste des comptes pour désigner un responsable ou un référent : ouvrir une route de recherche de comptes au gestionnaire, ou garder l'identifiant saisi.
5. Mise en évidence d'un objet hors vue : exposer une emprise (sans géométrie) par objet.
6. Retrait de la clé de module à la révocation d'un rattachement (l'écran avertit seulement, comme le serveur).

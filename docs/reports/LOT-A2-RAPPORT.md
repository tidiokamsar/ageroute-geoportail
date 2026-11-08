# Lot A2 : assistant d'import (interface) du module « Projets de voirie et réseaux »

Date : 08/11/2026. Branche `feat/assistant-import-ui` (worktree `C:\ageroute-secours\w-a2-wizard`), issue de `feat/import-formats-simples` ; le backend A1 terminé (commits `b263bd6`, `b9a91f4`, `d6188b9`) a été fusionné (`git merge`, avance rapide) avant les tests finaux. Frontend seulement : aucun fichier de `backend/` n'est modifié. Sources : `docs/projets-voirie/CONTRAT-IMPORT.md` et le code réel des routes (`backend/src/api-v2/projets-voirie.import.routes.ts`, services `formats/`).

## Décision d'intégration (audit du dépôt de fichiers existant)

L'ancien dépôt était un dialogue unique (`DialogueDepot`) : un fichier KML ou GeoJSON, les métadonnées du jeu, une simulation (`?simuler=true`) puis « Confirmer l'écriture ». Il refusait localement KMZ, GPX, CSV et tout format projeté, et ses messages d'erreur (« format prévu au lot suivant », « WGS 84 seulement ») étaient devenus faux avec le lot A1.

**Remplacé proprement, pas doublé.** `DialogueDepot.tsx` et son test sont supprimés ; le bouton « Ajouter des données » de la page ouvre l'assistant (même titre de dialogue, même contrat `onVoirJeu` pour « Voir le jeu existant »). Les comportements de l'ancien parcours sont conservés et testés dans l'assistant : simulation d'abord, aucune écriture avant le geste explicite, jeu en quarantaine, champs envoyés (rôle, nature, confidentialité à cinq niveaux, qualité, origine facultative), création d'un concessionnaire annoncée comme geste à part, JEU_DEJA_CHARGE avec lien vers le jeu existant, DEPOT_EN_ATTENTE.

Ajout de la **reprise** : dans l'onglet Couches, un bouton « Versions » (jeu en quarantaine ou autorisé, comptes qui peuvent écrire seulement) ouvre l'assistant sur les deux dernières étapes pour un jeu déjà déposé. Sans cela, un jeu en quarantaine dont les suppressions sont à revoir n'aurait eu aucune voie dans l'interface (l'autorisation répond 409), et un retour arrière n'aurait été possible que pendant la session du dépôt.

## Les sept étapes

| Étape | Contenu | Appel serveur |
|---|---|---|
| 1 Dépôt | fichier, rôle, concessionnaire (création possible), type de réseau, nature, qualité, confidentialité, origine facultative ; formats, taille maximale et mode de conservation de l'original lus dans l'API ; avertissement de confidentialité | `GET import/options` (à l'ouverture), puis `POST import/inventaire` |
| 2 Format et couches | format détecté par le contenu, extension incohérente signalée, entrées d'archive KMZ, choix de l'entrée KML, couches (choix explicite, « toutes » explicite), options de lecture d'un tableau (délimiteur, encodage, séparateur décimal, mode points, lignes ou WKT, colonnes) | `POST import/inventaire` relancé si les options changent |
| 3 Système de coordonnées | liste blanche de l'API avec nom et unité ; CSV et GeoJSON déclarant un système projeté : choix obligatoire, champ vide au départ, jamais de valeur par défaut ; KML, KMZ, GPX : WGS 84 imposé et dit ; bloc source, cible, unités, méthode, version de PROJ, origine, emprise, plausibilité ; hors zone : alerte bloquante et confirmation explicite | `POST import/apercu` |
| 4 Correspondance des champs | champs cibles de l'API, trois exemples de valeurs au plus, proposition du serveur sous forme de bouton (jamais appliquée d'office), valeurs proposées au jeu annoncées | aperçu refait seulement si la correspondance a changé |
| 5 Contrôles | statistiques, doublons internes, validation géométrique (problèmes, éléments écartés, lignes rejetées du tableau), avertissements, échantillon borné sur tableau et sur carte Leaflet | aucun nouvel appel |
| 6 Comparaison | simulation (rien n'est écrit), delta ajoutés, modifiés, retirés (à revoir), identiques ; « Enregistrer en quarantaine » est un geste explicite ; après dépôt, delta détaillé et revue des suppressions (accepter ou refuser, justification de 10 caractères, dernière revue affichée) | `POST jeux?simuler=true`, `POST jeux`, `GET jeux/:id/delta`, `POST revue-suppressions` |
| 7 Approbation | autoriser ou rejeter avec justification ; autorisation bloquée (avec la raison) tant que les suppressions sont à revoir ou refusées ; retour arrière avec justification et confirmation, raison dite quand il est impossible | `POST autoriser`, `rejeter`, `retour-arriere` |

Stepper accessible (liste ordonnée, `aria-current="step"`, texte « Étape N sur M » visible à toute largeur), focus placé sur le titre de chaque étape, retour arrière possible avec état conservé en mémoire, et gelé après l'enregistrement en quarantaine (le fichier existe alors côté serveur).

## Règles tenues

- **Aucun stockage navigateur** : état dans un réducteur React, fichier gardé comme objet `File` jamais lu ni copié. Le test de non-stockage existant est étendu : il parcourt aussi le dossier `assistant/`, vérifie que les routes de `projetsVoirieImportApi.ts` sont exactement les six du contrat, que l'assistant n'emploie ni `FileReader`, ni `createObjectURL`, ni HTML injecté, et son parcours d'exécution traverse l'assistant complet (sept étapes) avec des espions sur tous les stockages : zéro appel.
- **Pas de session serveur** : le fichier est renvoyé à chaque étape, l'empreinte SHA-256 de l'aperçu part en `sha256Attendu` à la simulation et au dépôt.
- **Rien n'est deviné** : pas de CRS par défaut, pas de couche choisie à la place de l'utilisateur, pas de suppression appliquée sans revue, pas de concessionnaire créé par l'import.
- **Contenu de fichier en texte seulement** : noms d'objets, attributs, colonnes, entrées d'archive sont rendus comme texte React ; infobulles de carte construites par `textContent`, aucune popup. Test avec un nom d'objet piégé (`<img onerror>`).
- **Confidentialité** : l'assistant n'est proposé qu'à ADMIN et GESTIONNAIRE (le serveur l'impose aussi, y compris pour `options` et `delta`). L'aperçu ne montre que ce que l'utilisateur vient d'envoyer, borné par le serveur à 20 objets. Les 403, 404 masqués sont dits sans détail.
- **Texte français, sans emoji, sans tiret cadratin** dans les fichiers nouveaux.

## Gestion des erreurs et de la charge

Une cinquantaine de codes typés ont un message en clair (`projetsVoirieMessages.ts`, `MESSAGE_CODE` mis à jour : les anciens messages « prévu au lot suivant » sont corrigés), le texte du serveur n'étant jamais affiché pour un code connu. `classerErreur` gère désormais 429 et 503 (délai : `retryAfterS` du corps ou en-tête `Retry-After`), l'annulation et les compléments numériques (`nbElementsHorsZone`, `nbObjets`, `nb`). Chaque erreur désigne, quand c'est utile, l'étape où elle se corrige (bouton « Corriger à l'étape ... »). 409 CONFIRMATION_HORS_ZONE_REQUISE n'est pas une erreur affichée mais l'alerte bloquante de l'étape 3. Erreurs de lecture d'un tableau à l'inventaire (ENCODAGE_AMBIGU, DELIMITEUR_AMBIGU) : l'assistant ouvre les options de lecture, l'utilisateur déclare puis relance.

Fichiers volumineux : un seul envoi à la fois (verrou synchrone, double clic sans effet), barre de progression, message « lecture et contrôles en cours » à 100 %, annulation par `AbortController` (aussi par Échap pendant un envoi). L'annulation du dépôt dit honnêtement que le serveur a pu enregistrer avant l'interruption et que l'idempotence par empreinte évite un doublon. Un 429 ou un 503 avec délai désactive les boutons le temps dit.

## Écarts relevés entre le contrat et le code (à signaler au lot A1)

1. `GET import/options` : le code renvoie `crs.sourcesAutorises`, le contrat dit `crs.sourcesAutorisees`. Le lecteur accepte les deux.
2. L'inventaire renvoie en plus `suggestionsMapping` (et `archive.choixRequis`), absents du contrat : utilisés (proposition en bouton, entrée d'archive à choisir).
3. En simulation, `jeu.id` est `null` : `jeu` est donc nul côté interface ; la version prévue est lue séparément (`ReponseDepot.version`).

## Fichiers

Nouveaux : `frontend/src/lib/projetsVoirieImport.ts` (types, lecteurs, règles des étapes), `projetsVoirieImportApi.ts` (client), `projetsVoirieImportEtat.ts` (réducteur), `projetsVoirieImportHooks.ts` (options, envoi annulable), `projetsVoirieImportErreurs.ts`, `projetsVoirieMessages.ts` ; `frontend/src/components/projets-voirie/assistant/` (`AssistantImport`, `Stepper`, `EtapeDepot`, `EtapeFormat`, `EtapeCrs`, `EtapeMapping`, `EtapeControles`, `ApercuCarte`, `EtapeDelta`, `EtapeApprobation`, `commun`, fixtures de test). Modifiés : `projetsVoirie.ts` (formats, erreurs, `controlerFichier`), `projetsVoirieApi.ts` (lecteurs du CRS, du delta, des suppressions, signal d'annulation), `projetsVoirieHooks.ts` (hooks de dépôt retirés), `PanneauCouches.tsx` (bouton « Versions »), `ProjetVoirieDetailPage.tsx`. Supprimés : `DialogueDepot.tsx` et son test.

## Tests et vérifications (chiffres réels)

- `npx tsc --noEmit` : 0 erreur. `npx eslint src` : 0 erreur, 5 avertissements préexistants (fichiers non touchés). `npm run build` : réussi.
- Suite frontend complète (`npx vitest run --poolOptions.forks.maxForks=3 --poolOptions.forks.minForks=1`) : **244 fichiers passés, 5 311 tests passés, 1 ignoré (préexistant), 889 s**. Aucun test chronométré instable.

- Tests de lib : lecteurs, règles, champs envoyés, réducteur, client, crochet d'envoi (StrictMode compris), classement des erreurs.
- Tests de composants de l'assistant (`AssistantImport.test.tsx`) contre une API simulée : chaque étape, chaque erreur typée citée (409, 413, 415, 422, 429, 503, 504, 403, 404), progression, annulation, absence de double envoi, parcours clavier et focus, reprise, trois parcours axe-core (zéro violation à chaque étape).
- Contraste : `src/test/contraste.test.ts` passe ; les classes d'état du stepper sont des constantes séparées (une chaîne par état), sans faux positif.
- Vérification visuelle dans le navigateur intégré avec une API simulée hors dépôt (adaptateur axios dans un harnais temporaire, supprimé), à 1280 px et 375 px : étapes 1, 2, 3, 5 (carte réelle avec fond OpenStreetMap), 6 (simulation, delta détaillé, revue), 7 (autorisation, panneau de retour arrière) ; alerte hors zone avec un CSV simulé. Un débordement horizontal du dialogue à 375 px a été trouvé et corrigé (`grid-cols-[minmax(0,1fr)]`) ; il ne reste que le défilement interne des tableaux, voulu.

## Non exécuté, limites, risques

- **Aucun essai contre le vrai backend ni contre PostGIS** : l'interface n'a été vue qu'avec des réponses simulées au format du contrat et du code lu. Un essai de bout en bout reste à faire (banc A1 ou environnement de recette), surtout : transformation UTM 29N réelle, KMZ à plusieurs KML, revue et retour arrière.
- Les captures d'écran du navigateur intégré à 375 px sont rognées à droite par le volet (la mesure en JavaScript confirme que le dialogue tient dans 375 px) ; pas de capture archivée dans le dépôt.
- Pas de traitement asynchrone : l'API n'en expose pas (contrat, section 13) ; un fichier de 25 Mo est renvoyé jusqu'à cinq fois (inventaire, aperçu, simulation, dépôt, plus les relances), compromis assumé par le contrat.
- Le délai d'attente d'un 429 ne vaut que pour la session de l'assistant ouvert ; fermer et rouvrir ne le conserve pas.
- Le retour arrière n'est proposé qu'à partir d'un jeu autorisé (via l'assistant) ; la restauration d'une version plus ancienne que la précédente n'existe pas dans l'API.
- Hors périmètre, non fait : nouveau backend, formats non listés par l'API (GeoPackage, Shapefile, DXF), conversion GDAL, conflits.

## Décisions à prendre

1. Corriger le contrat (ou le code) pour `sourcesAutorises` / `sourcesAutorisees`.
2. Faut-il une séparation des tâches (le déposant ne peut pas autoriser son propre jeu) ? L'API ne la bloque pas ; l'audit enregistre seulement `memePersonne`.
3. Durée de conservation du fichier d'origine : l'interface affiche déjà le mode choisi par le serveur.

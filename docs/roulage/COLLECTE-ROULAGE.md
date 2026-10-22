# Collecte en roulage (paragraphe 7.13) : ce qui est livré, le contrat, ce qui reste à vérifier sur un téléphone

Auteur : agent « collecte en roulage », 22/10/2026. Base : commit `2943e22` (branche `lot/03-map-matching`).

## Lecture rapide, sans détour

**Les critères A16, A17 et A19 ne sont PAS terminés, et ils ne peuvent pas l'être avec ce qui est livré ici.**
Ils exigent une mesure sur un téléphone Android réel (latence du geste, GNSS réel, veille, appel entrant,
redémarrage, batterie). Il n'existe aucun appareil, aucune chaîne `adb`/`gradle`/`java`, aucun APK compilable
(blocage B-10). Tout ce qui est écrit ici est de la **logique indépendante de l'appareil, testée par
simulation**. Une simulation n'est pas une mesure : aucun chiffre de ce document ne doit être cité comme une
mesure sur appareil.

A18 reste partiel : le rattachement HMM d'une trace 1 Hz de 2 h est exercé en simulation de bout en bout, mais
**l'IRI n'existe pas** et aucune trace réelle n'a été mesurée.

## 1. Ce qui est livré

| Élément | Fichiers | Rôle |
|---|---|---|
| Noyau de collecte, sans dépendance au DOM | `frontend/src/roulage/` (`session.ts`, `etat.ts`, `journal.ts`, `filtre.ts`, `parametres.ts`, `horloge.ts`, `geodesie.ts`, `types.ts`, `contrat.ts`, `index.ts`) | Machine à états, journal rejouable, filtre de précision et de dérive, trous et segments, marqueur, événement linéaire Début/Fin, charge de synchronisation |
| Interface IRI (refus) | `frontend/src/roulage/iri.ts` | Types d'entrée et de sortie, et une fonction qui **refuse toujours** avec un motif |
| Support de test | `frontend/src/roulage/simulation.ts`, `aide-test.ts` | Simulateur GNSS déterministe, jamais importé par du code de production |
| Contrat serveur | `backend/src/roulage/contrat.ts` | Schéma zod de la charge ; refuse `iri` |
| Rattachement | `backend/src/roulage/rattachement.noyau.ts` | Noyau pur : troncon au temps t, position interpolée, découpage d'un événement en passages |
| Acceptation | `backend/src/roulage/session.service.ts`, `backend/src/field/sync.service.ts` (type `SessionRoulage`) | Analyse par le HMM de trace existant, écriture idempotente, portions par `creerPortion`, audit |
| Détail par point de l'analyse de trace | `backend/src/geo/trace.service.ts` (`analyserTraceDetaillee`) | Même analyse qu'avant, avec le rattachement point par point ; la réponse HTTP de `POST /geo/trace` est inchangée |
| Schéma | migration `backend/prisma/migrations/20261024100000_sessions_roulage/`, descente `backend/prisma/descentes/20261024100000_sessions_roulage.sql`, 4 modèles à la fin de `schema.prisma` | 4 tables additives, aucune table existante modifiée |
| Charge d'exemple partagée | `docs/roulage/exemple-session.json` | Écrite par le noyau de l'appareil, relue par le test du serveur |
| Banc PostGIS | `backend/tests-integration/roulage.integration.mts` | Simulation de 2 h à 1 Hz contre PostGIS, oracle SQL |

**Mise à jour du 22/10/2026 (soir) : un enregistreur dans le NAVIGATEUR est livré**, sans application native. Écran
`/inspections/releve/enregistrer` (`pages/EnregistrementRoulagePage.tsx`), couche hôte `lib/roulageHote.ts` (position du
navigateur vers le noyau, stockage du journal dans IndexedDB natif avec reprise après fermeture de la page, maintien de
l'écran allumé par l'API Screen Wake Lock, export GPX). Il pose des repères, ouvre et ferme des segments (un segment
ouvert empêche l'arrêt : clore ou abandonner, jamais de fin inventée), puis télécharge le GPX ou envoie la session au
serveur (`POST /v2/sync/push`, opération `SessionRoulage`). Il est couvert par 14 tests d'écran (position simulée, axe-core
0 violation) et 12 tests de la couche hôte.

**Ses limites, dites à l'écran :** page au premier plan et écran allumé (un navigateur ne lit pas la position écran
éteint ; la coupure est notée comme interruption, jamais comblée) ; un passager manipule le téléphone ; aucun IRI, aucune
photo ; la qualification de l'état de chaussée par segment n'est pas saisie sur cet écran. **Il n'a jamais tourné sur un
téléphone en roulant** : la précision, la tenue de l'écran, la reprise après fermeture et l'API Wake Lock selon le
navigateur sont à vérifier lors d'un premier essai, avant d'en tirer le moindre chiffre. Aucun adaptateur SQLite, plugin
natif ni branchement dans la file `offlineSync.ts` n'est livré : l'envoi se fait à la demande, pas en file automatique.

### Tests

| Suite | Commande | Résultat du 22/10/2026 |
|---|---|---|
| Noyau de l'appareil | `cd frontend && npx vitest run src/roulage` | 6 fichiers, 97 tests |
| Serveur (contrat, rattachement, service, route de synchronisation) | `cd backend && npx vitest run src/roulage src/api-v2/sync.roulage` | 4 fichiers, 72 tests |
| Banc PostGIS | `cd backend && DATABASE_URL=<replay> bash tests-integration/run.sh` ou `npx tsx tests-integration/roulage.integration.mts` | 50 vérifications |
| Descente de la migration | `docker cp backend/prisma ...` puis `verifier.sh --seulement 20261024100000_sessions_roulage` | 4 vérifications : descente, aller-retour, garde refusée avec données, garde autorisée |

## 2. Machine à états d'une session

```
EN_COURS --pause--> EN_PAUSE --reprise--> EN_COURS
EN_COURS | EN_PAUSE --arret--> ARRETEE        (état final)
```

- Un **appel entrant**, une **veille**, une **perte du GNSS**, une **permission retirée** ne changent pas l'état
  (le service de premier plan continue, c'est la thèse de l'ADR-009). Ils ouvrent une **interruption datée** ;
  les trous de trace qui en résultent sont enregistrés. Ils sont **injectés** par l'hôte : le noyau ne les
  détecte pas lui-même.
- Une **pause** coupe la trace en deux segments. Elle est refusée tant qu'un événement linéaire est ouvert.
- Un **redémarrage** se rejoue depuis le **journal** (une entrée par changement, numérotées). Les entrées non
  écrites avant la mort du processus sont perdues, et dites : `reprendreApresRedemarrage()` enregistre
  l'intervalle inconnu comme interruption `REDEMARRAGE`. Une trace n'est jamais « reliée » à travers un trou
  supérieur à `trouMs` qui suit une pause ou un redémarrage, ni à travers un trou supérieur à `coupureSegmentMs`.
- **Marqueur** (A16) : l'instant du geste est lu en premier, avant toute autre opération. La position est celle du
  dernier fix, avec son ancienneté ; au-delà de `ageFixMaxMarqueurMs`, ou sans fix, ou GNSS perdu, la position est
  marquée périmée et le marqueur est posé quand même. Le serveur retrouve la position exacte dans la trace.
- **Événement linéaire** (A17) : un seul événement ouvert par code. Refus de la fin si elle précède le début
  (`FIN_AVANT_DEBUT`), si la durée est nulle (`DUREE_NULLE`) ou inférieure au minimum (`DUREE_TROP_COURTE`) ;
  l'événement reste ouvert. Une couverture GNSS faible, une position périmée, un événement immobile ou qui traverse
  un redémarrage sont des **avertissements** : l'événement est clos, le serveur décide. **L'arrêt avec un événement
  ouvert est refusé par défaut** ; l'appelant choisit `CLORE` (fin = instant d'arrêt, `CLOS_PAR_ARRET`) ou
  `ABANDONNER`.

### Seuils : tous PROVISOIRES et non calibrés

Définis une seule fois dans `frontend/src/roulage/parametres.ts`, paramétrables à la création de la session,
recopiés dans la charge (`parametres` et `provenanceParametres = PROVISOIRE_NON_CALIBRE`) et conservés avec la trace.

| Paramètre | Défaut | Origine |
|---|---|---|
| `intervalleAttenduMs` | 1000 | critère A18 (1 Hz) |
| `precisionMaxM` | 50 | aligné sur le noyau serveur, non mesuré |
| `refuserSansPrecision` | faux | une précision absente n'est jamais inventée |
| `vitesseMaxKmH` (saut impossible) | 200 | choisi |
| `trouMs` / `coupureSegmentMs` | 5000 / 30 000 | choisis |
| `fixFigeEchantillons` / `vitesseMouvementMs` | 10 / 1 | choisis |
| `reancrageApresRejets` | 5 | choisi |
| `deriveHorlogeMs` | 2000 | choisi |
| `ageFixMaxMarqueurMs` | 2000 | choisi |
| `budgetLatenceLogicielleMs` | 200 | exigence A16 (mesure logicielle seulement) |
| `dureeMinEvenementMs` / `couvertureMinEvenement` / `distanceMinEvenementM` | 1000 / 0,8 / 10 | choisis ; 10 m aligné sur la portion minimale du serveur |

Côté serveur, également provisoires : `FENETRE_RATTACHEMENT_MS = 10 000`, `DISTANCE_MAX_PROJECTION_M = 50`,
`POINTS_PASSAGE_ABSORBE = 2`, pas de nettoyage adaptatif (15 m au minimum, plus pour qu'un segment tienne sous
`POINTS_MAX = 3000`).

## 3. Contrat de synchronisation

**Une session = une opération du protocole existant** (`POST /api/v2/sync/push`, section 15). Aucun point d'entrée
parallèle.

```json
{ "operationId": "<sessionId>", "entityType": "SessionRoulage", "entityId": "<sessionId>",
  "operation": "CREATE", "baseVersion": null, "payload": { "...": "voir ci-dessous" } }
```

La charge (`docs/roulage/exemple-session.json` en est un exemple réel) porte : `versionContrat` (1), `sessionId`
(uuid), `missionId` (uuid ou nul), `debutMs`, `finMs`, `provenanceParametres`, `parametres`, `points`
(`[tMs, lat, lon, precisionM, vitesseMs, segment]`), `marqueurs`, `evenements`, `trous`, `interruptions`,
`pauses`, `compteurs`. **Aucun champ `iri`** : sa présence est refusée.

Plafonds : 36 000 points (dix heures à 1 Hz), 2 000 marqueurs, 2 000 événements, 5 000 éléments par liste, requête
5 Mo. Deux heures à 1 Hz pèsent environ 0,5 Mo.

### Idempotence (le point qui compte)

| Situation | Résultat | Écriture |
|---|---|---|
| Première réception | `SYNCHRONISE`, `entityId` = identifiant de session | session, marqueurs, événements, portions, audit |
| Même `operationId` rejoué (réponse perdue) | `REJOUEE` | **aucune** |
| Même identifiant de session sous un `operationId` neuf | `REJETE` `SESSION_DEJA_ENREGISTREE` (définitif) | une trace de rejet |
| `operationId` connu, autre compte | `REJETE` `OPERATION_NON_AUTORISEE` | aucune |
| Charge invalide, `iri` présent | `REJETE` `PAYLOAD_INVALIDE` (définitif, charge non conservée) | une trace de rejet |
| `entityId` différent de `sessionId` | `REJETE` `ENTITE_INCOHERENTE` | une trace de rejet |
| Mission non assignée ni créée par l'agent | `REJETE` `MISSION_NON_AUTORISEE` | une trace de rejet |
| Échec d'écriture | HTTP 500, **transaction annulée**, aucune trace d'opération : le rejeu aboutira | aucune |

Un refus définitif n'a pas de `reessayerDansMs` ; `interpreterReponse` (côté appareil) en déduit « abandonner,
conserver la session localement, la montrer ». L'analyse (lecture seule, plusieurs secondes) précède la
transaction d'écriture.

### Ce que le serveur fait d'une session

1. Valide la charge (zod), vérifie l'unicité et l'appartenance.
2. Analyse la trace **segment par segment** par le HMM de `geo/trace.service.ts` (le même que `POST /geo/trace`),
   avec un pas de nettoyage adaptatif. Le graphe n'est **pas** demandé par défaut (sa tolérance de fusion n'est
   mesurée sur aucun réseau réel et ne doit pas être supposée) : les transitions non vérifiées sont comptées et
   signalées.
3. **Marqueur** : troncon du point rattaché le plus proche dans le temps (fenêtre de 10 s), position **de la trace
   interpolée à l'instant du geste** (pas le dernier fix, qui peut être périmé), abscisse par projection sur le
   troncon (fraction x longueur géodésique, même définition que partout). Au-delà de 50 m du troncon, ou dans un
   secteur que le HMM n'a rattaché à rien : `NON_RATTACHE` avec son motif. Un marqueur n'est jamais collé au
   troncon voisin.
4. **Événement linéaire** : découpé en passages sur des troncons successifs ; les bornes extrêmes viennent de la
   projection des positions de début et de fin, les bornes intérieures des points rattachés. Chaque passage devient
   une **portion** par `creerPortion` (le même service que la route en ligne : chevauchement d'une portion validée,
   portion trop courte, bornes, sens), statut `A_VALIDER`, origine `SAISIE_TERRAIN`, `source = roulage:<sessionId>`,
   `observeeLe` = début de l'événement, `clientOperationId = <operationId>:<evenementId>:<rang>`. **La validité
   (`valideDu`) n'est jamais déduite.**
5. **Territoire (A10)** : pour chaque troncon recevant une portion ; un compte régional hors de son périmètre voit la
   portion refusée (`HORS_PERIMETRE`, `REGION_INCONNUE`), sa session est enregistrée. Les marqueurs ne sont pas des
   écritures patrimoniales et ne sont pas contrôlés.
6. **Codes de référentiel** (état, revêtement, praticabilité) vérifiés actifs avant l'écriture : un code inconnu
   refuse les portions de l'événement au lieu de faire échouer la transaction par une clé étrangère.
7. **Audit** : une ligne `CREATE SessionRoulage` (identifiants de tout ce qui est écrit, sans la trace brute) et une
   ligne `CREATE Portion` par portion, toutes dans la transaction. Suppression logique seule (`deletedAt`).

### Ce qui n'est pas fait

Un marqueur n'est pas converti en observation ou en défaut : c'est une proposition à qualifier par les écrans
existants. Les événements ouverts à la clôture, abandonnés ou hors réseau sont conservés avec leur motif, sans portion.

## 4. Résultats de simulation (à ne pas confondre avec des mesures)

Banc `roulage.integration.mts`, 22/10/2026, base PostGIS de développement, clone jetable. Réseau de test : 17
troncons de 5 km (85 km), 3 leurres parallèles à 40 m, une route transversale, un troncon absent du référentiel.
Bruit GNSS : blanc, gaussien, 4 m par axe, précision annoncée 8 m. Incidents injectés : appel de 45 s, veille de 60 s
avec livraison du tampon, redémarrage (3 entrées de journal perdues, 20 s sans processus, 5 échantillons redonnés),
pause de 90 s.

| Quantité | Valeur |
|---|---|
| Points acceptés par le noyau | 7 047 sur 7 201 (écart = appel + pause + trou de redémarrage), 0 doublon, 0 perdu |
| Rejeu x5 de la même opération | `REJOUEE` 5 fois, **aucune table ne change** (sessions, marqueurs, événements, liens, portions, `operations_sync`, audit) |
| Taux de rattachement stocké | 94,00 % des points retenus (la part hors référentiel de la simulation est 6,11 %) |
| Bon troncon, points sur réseau | 99,94 % sans graphe, 99,97 % avec graphe (tolérance 2 m), 704/704 dans la zone à leurre |
| Points hors référentiel laissés sans troncon | 226 sur 231 |
| Marqueurs (25 sur réseau) | tous au bon troncon, erreur d'abscisse contre l'oracle SQL : médiane 1,8 m, max 7,2 m ; un fix périmé de 0,9 s aurait donné 13,4 m |
| Marqueurs hors référentiel | 3 sur 3 `NON_RATTACHE` |
| Événements (début, fin) | 0,3 à 4,5 m contre l'oracle SQL ; jonctions entre troncons à 11,7 et 15,2 m des extrémités |
| Temps | de 6 à 13 s pour 7 047 points selon la charge du poste, dont environ la moitié pour l'analyse seule (2,9 s sur la mesure la plus rapide), base à 24 troncons |

**Ce que ces chiffres ne disent pas** : l'erreur d'un vrai récepteur n'est pas blanche, ni gaussienne, ni de 4 m ;
la base de test compte 24 troncons, pas 261 387 ; les temps ne sont pas ceux d'un réseau national (A15 jamais
mesuré) ; le banc suppose que le plugin natif **redonne** ses derniers échantillons après un redémarrage et qu'il
livre un tampon après une veille, ce qui n'est vérifié nulle part.

## 5. À VÉRIFIER SUR UN VRAI TÉLÉPHONE

Statut de chaque ligne : **NON VÉRIFIÉ sur appareil**. Aucune ne peut être cochée par une simulation.
Appareil à choisir : un Android d'entrée de gamme représentatif du parc AGEROUTE (modèle à décider par AGEROUTE),
version du WebView et de l'OS notées avec chaque mesure.

| Réf. | Critère | À vérifier | Comment le mesurer | Statut |
|---|---|---|---|---|
| D-01 | A16 | Latence du geste : du toucher du bouton « marqueur » à l'enregistrement et au retour visuel, **inférieure à 200 ms** | Instrumentation `perfMs()` du WebView plus horodatage natif, ou caméra haute cadence ; GNSS 1 Hz et IMU actifs, écran allumé, véhicule roulant ; p50, p95, p99 sur un nombre de poses fixé par AGEROUTE | NON VÉRIFIÉ sur appareil |
| D-02 | A16 | Coût réel de l'écriture du journal natif (SQLite ou fichier) et durabilité (flush sur le stockage flash) | Chronométrer l'appel du rappel `journal` ; couper l'alimentation après N entrées et compter les entrées retrouvées | NON VÉRIFIÉ sur appareil |
| D-03 | A16 | Erreur de position du marqueur **inférieure à 30 m** sur le terrain | Marqueurs posés à des repères de coordonnées relevées (PK, bornes, ouvrages) à vitesse réelle ; comparaison avec la position serveur | NON VÉRIFIÉ sur appareil |
| D-04 | A16 | Écart entre l'horodatage GNSS du récepteur et l'horloge de l'appareil | Mesurer sur plusieurs appareils et en réseau mobile coupé ; valide `deriveHorlogeMs` et l'appariement marqueur / trace | NON VÉRIFIÉ sur appareil |
| D-05 | A18, A19 | Cadence GNSS réelle de 1 Hz tenue en arrière-plan écran éteint pendant 2 h | Nombre d'échantillons reçus sur 7 200, distribution des intervalles | NON VÉRIFIÉ sur appareil |
| D-06 | A16, A18 | Loi d'erreur réelle du récepteur (précision annoncée contre erreur réelle), en ville, sous couvert végétal, en zone dégagée | Tracés sur parcours de référence ; calibrage de `precisionMaxM`, `vitesseMaxKmH`, `fixFigeEchantillons` | NON VÉRIFIÉ sur appareil |
| D-07 | A16, A18 | Le plugin fournit bien la précision annoncée, la vitesse sol et un horodatage fiable (le filtre de fix figé en dépend) | Lire les champs du plugin natif sur appareil | NON VÉRIFIÉ sur appareil |
| D-08 | A19 | Le récepteur livre-t-il un tampon après une veille, avec quels horodatages ? (hypothèse du banc : oui, ordre croissant) | Verrouiller 60 s, relever les échantillons livrés au réveil | NON VÉRIFIÉ sur appareil |
| D-09 | A19 | Le service de premier plan survit à l'extinction de l'écran, à Doze et aux optimisations de batterie du constructeur pendant 2 h | Session de 2 h écran éteint sur chaque modèle du parc | NON VÉRIFIÉ sur appareil |
| D-10 | A19 | **Appel entrant** : l'enregistrement continue ; l'événement `APPEL_ENTRANT` est réellement émis par l'hôte (permission requise ?) ; ce qui manque dans la trace | Appeler l'appareil pendant une session, puis relire la charge | NON VÉRIFIÉ sur appareil |
| D-11 | A19 | **Veille profonde et verrouillage** : événements `VEILLE_DEBUT` et `VEILLE_FIN` émis, aucune perte | Laisser l'appareil en veille 10 min en roulant | NON VÉRIFIÉ sur appareil |
| D-12 | A19 | **Redémarrage** : processus tué par le système, balayé par l'utilisateur, redémarrage du téléphone ; le service repart-il seul ou l'agent doit-il rouvrir ? combien d'entrées de journal perdues ? **le plugin peut-il redonner ses derniers échantillons** (hypothèse du banc) ? | Tuer le processus et redémarrer le téléphone en cours de session ; compter trous et doublons dans la charge | NON VÉRIFIÉ sur appareil |
| D-13 | A19 | Retrait puis rétablissement de la permission de localisation (arrière-plan, Android 10 et plus), GPS désactivé par l'utilisateur | Manipulation pendant une session ; événements `PERMISSION_*` et `GNSS_*` | NON VÉRIFIÉ sur appareil |
| D-14 | A19 | Batterie : consommation sur 2 h (GNSS 1 Hz, service, IMU, écran), échauffement | Pourcentage consommé par modèle ; objectif à fixer par AGEROUTE | NON VÉRIFIÉ sur appareil |
| D-15 | A19 | Stockage : taille du journal sur disque pour 2 h, purge après synchronisation | Mesure sur appareil | NON VÉRIFIÉ sur appareil |
| D-16 | A19 | Synchronisation en réseau réel : charge d'environ 0,5 Mo en 2G ou 3G coupé, réponse perdue puis rejeu ; **le serveur met de 6 à 13 s à traiter 2 h** sur la base de test, à comparer aux délais d'expiration du client et du proxy (Traefik) | Envoi depuis l'appareil en réseau dégradé, avec coupure de la réponse | NON VÉRIFIÉ sur appareil |
| D-17 | A19 | Intégration à la file hors ligne : la session survit au redémarrage de l'application et ne produit aucun doublon | Après écriture de l'adaptateur de file | NON VÉRIFIÉ sur appareil |
| D-18 | A16, A17 | Utilisabilité en conduite : taille des boutons, retour sonore ou vibratoire, rôle du passager ; **décision de sécurité routière à prendre par AGEROUTE** (usage par le conducteur) | Essai sur route avec un opérateur | NON VÉRIFIÉ sur appareil |
| D-19 | A17 | Un événement Début/Fin posé par un agent réel aboutit à la bonne section de route | Relevé contradictoire par PK sur des sections connues | NON VÉRIFIÉ sur appareil |

Côté serveur, avec des **données réelles** (non couvert par la simulation) :

| Réf. | À vérifier | Statut |
|---|---|---|
| S-01 | Taux de rattachement et exactitude des abscisses d'événements sur de vraies traces et le réseau réel (géométries imparfaites, troncons longs, carrefours) | NON VÉRIFIÉ |
| S-02 | Performance de l'analyse sur le réseau national (261 387 troncons) ; la requête de candidats a été mesurée sur 24 troncons seulement | NON VÉRIFIÉ |
| S-03 | Tolérance de fusion du graphe sur le référentiel réel ; tant qu'elle n'est pas fournie, le graphe n'est pas utilisé | NON VÉRIFIÉ |
| S-04 | IRI par pas de 100 m : étalonnage approuvé et données d'accéléromètre réelles. Rien n'est calculé, rien n'est stocké | NON COMMENCÉ |

## 6. Ce qui reste à construire pour fermer A16, A17, A19

1. Les plugins natifs de l'ADR-009 : service de premier plan, GNSS en arrière-plan, accéléromètre à 100 Hz,
   capture cadencée. Aucun n'est écrit.
2. Un adaptateur de persistance du journal (SQLite de Capacitor) qui implémente `journal(entree)` et relit les
   entrées au démarrage.
3. Le branchement de la session arrêtée dans la file de `lib/offlineSync.ts` (`operationPourSynchronisation`,
   `interpreterReponse`), avec son état « abandonnée » visible.
4. L'écran de collecte : démarrer, pause, reprise, arrêt, marqueur, début et fin d'événement, résolution des
   événements ouverts à l'arrêt.
5. Les mesures de la section 5.

## 7. Limites connues du code livré

- **Passages intermédiaires** : pour un événement à cheval sur plus de deux troncons, la borne d'un passage
  intérieur est le premier et le dernier point rattaché, donc un trou d'au plus un pas de nettoyage (15 m ou plus
  selon la longueur de la trace) peut subsister entre deux portions. Mesuré en simulation : 11,7 et 15,2 m.
- **Chemin de synchronisation des portions existant** (`Portion` dans `sync.service.ts`) : un code de référentiel
  inconnu y provoque une violation de clé étrangère, donc une erreur 500 répétée. Le chemin `SessionRoulage`
  vérifie les codes avant d'écrire ; l'autre n'a pas été modifié.
- **Rejet par le serveur après analyse** : deux envois simultanés de la même opération analysent deux fois ; le
  second échoue à l'écriture (contrainte d'unicité, comportement attendu, non testé) et se rejoue en `REJOUEE`.
- Le lien portion - événement est tenu par la table `evenements_roulage_portions` ; une portion requalifiée ou
  fusionnée ensuite garde son lien vers la version d'origine (l'historique est conservé, rien n'est réécrit).

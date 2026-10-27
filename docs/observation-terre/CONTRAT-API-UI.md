# Observation de la Terre : contrat API et interface (Lot 1 EO)

Branche : `feat/observation-terre` (worktree `F:\ageroute-eo`, issu de `lot/03-map-matching` au commit `dad9695`). Ce document est le CONTRAT que le backend, le frontend et la carte respectent en parallèle. Toute évolution se fait ici d'abord. Les valeurs marquées PROVISOIRE sont des choix de conduite réversibles.

La capture de référence est une **cible visuelle**, jamais une source de données : aucun chiffre de la capture (86 %, 61, 24, 37...) n'est une constante du code.

## 1. Principes d'intégrité (non négociables)

1. Aucune valeur inventée. Pas de donnée : état vide explicite. Les données de démonstration n'existent que dans les tests et sont marquées `synthetique`.
2. Une proposition ne modifie jamais le référentiel officiel (`troncons`, `portions`, `ouvrages`). Elle n'écrit que dans les tables de télédétection, les missions et l'audit.
3. Taux de confirmation = confirmées / (confirmées + infirmées). Ce n'est PAS la précision statistique (il ne voit pas les changements non détectés). Le libellé est « Taux de confirmation terrain ». Sous le seuil d'échantillon (`SEUIL_ECHANTILLON_TAUX` = 30 verdicts, PROVISOIRE) l'interface affiche la valeur avec la mention « échantillon insuffisant (n = ...) » et jamais comme une performance fiable ; à 0 verdict : « Aucun verdict » (jamais 0 %). La précision et le rappel d'une méthode exigent un protocole de référence terrain : non définis, donc non affichés.
4. Une source est « active » seulement si son échelle d'état est atteinte : voir §4. Un nom de fournisseur en base ne suffit pas.
5. Confiance : quatre dimensions distinctes, jamais fusionnées : confiance de détection, qualité de l'image, confiance du rattachement au tronçon, priorité d'inspection. Un pourcentage n'est présenté comme probabilité que s'il est calibré (`calibree: true`, aujourd'hui toujours `false`) ; sinon le libellé est « indice non calibré ».
6. Résolution : rien n'est affirmé au-delà de la résolution native (Sentinel-2 : 10 m, nids-de-poule et fissures fines non détectables). Chaque proposition porte ses `limites` en texte.
7. Image manquante : afficher l'absence (`apercu: null`), jamais une image de remplacement.
8. Tout est contrôlé par le backend : module, rôle, périmètre territorial, audit des écritures.

## 2. Accès (PROVISOIRE, option B de D-C1-4)

- Nouvelle clé de module `teledetection` (backend `lib/modules.ts` et `frontend/src/lib/modules.ts`).
- Lecture : authentifié + module `teledetection`. Un compte régional ne voit que les propositions dont le tronçon est dans son périmètre (`territoire/territoire.lecture.ts`) ; les propositions non rattachées ne sont visibles que d'un compte national.
- Transitions de statut et affectation : ADMIN, GESTIONNAIRE (périmètre respecté). INSPECTEUR : lecture + ajout de preuves terrain sur une mission qui lui est affectée, sans décider.
- Gestion des sources : ADMIN seulement.

## 3. Statuts d'une proposition

`A_VERIFIER` (état d'arrivée), `EN_ATTENTE`, `NON_CONCLUANTE`, `CONFIRMEE`, `INFIRMEE`. « Affectée à une mission » est dérivée de `missionId` non nul ; « en cours d'inspection » de l'état de la mission ; « demande d'information » est une transition qui laisse la proposition `EN_ATTENTE` avec un motif `INFO_DEMANDEE`. « Clôturée » n'est pas implémenté (documenté). `CONFIRMEE` et `INFIRMEE` restent des verdicts définitifs (le déclencheur existant les fige). `EN_ATTENTE` et `NON_CONCLUANTE` peuvent revenir à `A_VERIFIER` ou aboutir à un verdict ; `EN_ATTENTE` vers `EN_ATTENTE` est permis (relancer l'attente avec un nouveau motif, ou demander des informations : l'écran offre « Mettre en attente » et « Demander des informations » depuis `EN_ATTENTE`). Chaque transition écrit une ligne de journal (auteur authentifié, heure, motif, commentaire, pièces).

## 4. Échelle d'état d'une source

`NON_CONFIGUREE` < `CONFIGUREE` < `AUTHENTIFIEE` < `ACCESSIBLE` < `PRODUIT_DISPONIBLE` < `TRAITEMENT_OPERATIONNEL`, plus les états latéraux `EN_ERREUR` et `EN_ATTENTE_CONFIGURATION` (identifiants requis). « Active » = `TRAITEMENT_OPERATIONNEL` uniquement. Chaque transition d'état est datée et porte le message du dernier test. Un test de connectivité réel (`POST /sources/:code/verifier`) fait monter jusqu'à `ACCESSIBLE` (recherche anonyme du catalogue) ou `PRODUIT_DISPONIBLE` (au moins un produit dans la fenêtre demandée) ; `AUTHENTIFIEE` et `TRAITEMENT_OPERATIONNEL` exigent des identifiants côté serveur (jamais exposés) et un traitement réel réussi.

## 5. Endpoints (préfixe `/api/v2/teledetection`)

Lecture (module `teledetection`) :

- `GET /synthese?regionId&depuis&jusqua` : `{ periode:{depuis,jusqua}, propositions:{ aVerifier, enAttente, nonConcluantes, confirmees, infirmees, prioritaires }, tauxConfirmation:{ confirmees, infirmees, jugees, valeur:number|null, echantillonSuffisant:boolean, seuil, definition:string }, sources:{ total, parEtat:Record<string,number>, actives }, derniereAcquisition:{ produitId, source, date, resolutionM }|null, fraicheur:{ dateCalcul, ageDerniereAcquisitionJours:number|null } }`.
- `GET /propositions?statut&type&source&methode&regionId&tronconId&priorite&rattachee&depuis&jusqua&q&curseur&limite` : `{ items:[Proposition], suivant:string|null, total:number }` (limite 1 à 100, défaut 25, tri date d'observation décroissante puis id).
- `GET /propositions.geojson?bbox=ouest,sud,est,nord&statut&type&limite` : FeatureCollection (emprise bornée à **10 degrés** de côté, `bbox` obligatoire ; zoom minimal **6** côté client : valeurs PROVISOIRES, voir §10 « Vue d'ouverture nationale »), propriétés minimales `{ id, type, statut, priorite, rattachee }`, plus les membres étrangers `tronque:boolean` et `total:number` (la carte recharge quand la réponse est tronquée et le dit à l'agent ; jamais de troncature silencieuse). Ordre de plafonnement : priorité haute, puis statut `A_VERIFIER`, puis identifiant.
- `GET /propositions/:id` : détail (voir §6).
- `GET /produits?source&nature&depuis&jusqua&bbox&curseur&limite` : registre paginé.
- `GET /produits/:id/apercu` : vignette servie par le serveur (jamais d'URL ni de clé de fournisseur dans le navigateur) ; 404 `APERCU_INDISPONIBLE` si absent.
- `GET /sources` : `[{ code, nom, fournisseur, capteur, resolutionM, etat, derniereVerification, derniereAcquisition, message, requiertIdentifiants }]` (état lu en base, jamais déduit du nom).
- `GET /precision` (existant, conservé) ; `GET /qualite-methodes` : verdicts par type et méthode avec effectif et indicateur `echantillonSuffisant`. **Ces deux routes sont des agrégats NATIONAUX : réservées aux comptes sans périmètre régional (403 `HORS_PERIMETRE` sinon).** Le widget « Taux de confirmation terrain » d'un compte régional se lit dans `GET /synthese` (`tauxConfirmation`, déjà filtré par région), jamais dans ces deux routes ; le détail par méthode n'est affiché qu'aux comptes nationaux, et un 403 y est un état « absence de permission » (§7), pas une erreur.

Écriture (rôles §2, audit transactionnel) :

- `POST /propositions/:id/transition` `{ vers: "CONFIRMEE"|"INFIRMEE"|"EN_ATTENTE"|"NON_CONCLUANTE"|"A_VERIFIER", motif (obligatoire, <= 1000), commentaire?, motifAttente?: "INFO_DEMANDEE"|"AUTRE", observationIds?: string[], constatRef?: string (<= 200) }`. **Un verdict (`CONFIRMEE`, `INFIRMEE`) cite son constat : au moins une observation (`observationIds`) OU une référence (`constatRef`), sinon 400 `CONSTAT_REQUIS`.** L'écran exige l'un des deux avant d'activer le bouton (champ « Référence du constat », borné comme le serveur) et envoie `constatRef` ; `EN_ATTENTE` et `NON_CONCLUANTE` n'exigent aucun constat.
- `POST /propositions/:id/verification` `{ commentaire?: string (<= 500) }` (existant, conservé) : crée la mission avec région, emprise et tronçon renseignés (correction de l'écart d'audit).
- `POST /sources/:code/verifier` (ADMIN) : test de connectivité réel, met l'état à jour.
- `POST /sources/:code/synchroniser-catalogue` (ADMIN, GESTIONNAIRE) `{ bbox | corridorId, depuis, jusqua, nuagesMax }` : interroge le catalogue, enregistre les produits (déduplication par identifiant fournisseur), rend `{ trouves, nouveaux, dejaConnus, ecartes:{raison:nombre} }`.

Corps d'erreur : `{ error: string, code: string }` (le champ `code` est celui de la liste ci-dessous ; l'interface se fonde sur `code`, pas sur le texte). Codes d'erreur stables : 400 `ENTREE_INVALIDE`, 401, 403 `ROLE_INSUFFISANT` / `HORS_PERIMETRE`, 404 (ressource inexistante ou hors périmètre, réponse identique ; `OBSERVATION_INEXISTANTE` : observation citée en preuve inexistante ou hors du périmètre du compte, réponse identique), 409 `TRANSITION_INTERDITE` / `VERDICT_DEFINITIF`, 429, 503 `SOURCE_INDISPONIBLE`. Aucune erreur serveur n'est présentée à l'écran comme un résultat vide.

## 6. Formes

`Proposition` (liste) : `{ id, type, statut, priorite:{ niveau:"HAUTE"|"MOYENNE"|"FAIBLE"|null, regle:string }, confianceDetection:{ valeur:number|null (échelle 0..1, indice NON calibré, affiché « indice 0,87 »), calibree:false, signification:string }, qualiteImage:{ couvertureNuagesPct:number|null, note:string|null }, rattachement:{ confiance:"HAUTE"|"MOYENNE"|"FAIBLE"|"AUCUN", distanceM:number|null, algorithme:string }, methode:{ nom, version }, source:{ code, nom, capteur, resolutionM }, dateObservation, dateReference, troncon:{ id, code, nom, regionId, regionNom }|null, rattachee:boolean, centre:{lat,lon}|null, apercuDisponible:boolean, synthetique:boolean, missionId:string|null }`.

Détail : Proposition + `{ produitApres, produitAvant, limites:string[]|null, limitesNonRenseignees:boolean, provenance:{ fournisseur, identifiantFournisseur, licence, attribution, versionTraitement, empreinteSha256|null }, geometrie:GeoJSON|null, historique:[{ de, vers, auteur:{id,nom}, date, motif, commentaire }], mission:{ id, statut, assigneNom }|null, terrain:{ observations:[{id, date, auteur, resume}], observationsMasquees:number }, apercus:{ avant:{ url:string|null, date }, apres:{ url:string|null, date } } }`.

`limites` vaut `null` (et `limitesNonRenseignees` `true`) pour une ligne d'avant la migration du workflow : « non renseignées » n'est pas « aucune limite » et s'affiche ainsi. `terrain.observationsMasquees` compte les observations du dossier que le périmètre du lecteur ne lui permet pas de voir (jamais omises en silence). `source` porte `resolutionOrigine` (`NATIVE_PRODUIT`, `PRODUIT_LIVRE`, `null`) et `capteurOrigine` (`PRODUIT`, `SOURCE`, `null`) : une valeur de repli est étiquetée.

## 7. États d'écran obligatoires

Pour chaque panneau (indicateurs, carte, liste, détail, sources, qualité) : chargement (`role="status"`), vide explicite, résultat, erreur API (`role="alert"`, jamais un vide), données périmées (`fraicheur`), absence de permission (message dédié, pas un vide), traitement en cours, données partielles. Aucun faux zéro : un compteur en erreur n'affiche pas `0`.

## 8. Découpage des fichiers (pas de modification concurrente)

| Chantier | Fichiers autorisés |
|---|---|
| EO-DB et workflow (migrations, états, journal, mission) | `backend/prisma/schema.prisma` (modèles de télédétection), `backend/prisma/migrations/2026102[89]*_eo_*`, `backend/prisma/descentes/*eo*`, `backend/src/teledetection/workflow.*`, bancs `backend/tests-integration/eo-workflow.integration.ts` |
| EO-API (lecture, synthèse, sources, module, territoire) | `backend/src/teledetection/api.*`, `backend/src/teledetection/sources.service.ts` (pont entre adaptateurs et base), `backend/src/api-v2/teledetection.*`, `backend/src/lib/modules.ts`, bancs `eo-api.integration.ts` ; consomme `backend/src/teledetection/sources/index.ts` sans le modifier |
| EO-SOURCES (adaptateurs) | `backend/src/teledetection/sources/adaptateurs/*`, fixtures `backend/src/teledetection/sources/__fixtures__/*` (réponses RÉELLES capturées, étiquetées) |
| EO-UI (page, panneaux) | `frontend/src/pages/TeledetectionPage.tsx`, `frontend/src/components/observation-terre/*` (sauf carte), `frontend/src/lib/teledetection*.ts` (hors `teledetectionCarte.ts`), `frontend/src/lib/modules.ts` |
| EO-CARTE | `frontend/src/components/observation-terre/CarteObservationTerre.tsx`, `ComparaisonAvantApres.tsx`, `frontend/src/lib/teledetectionCarte.ts` (noyau pur) |
| QA, doc | après intégration |

Migrations : horodatage `20261028*` et suivants, idempotentes, avec descente testée par `descentes/verifier.sh`. `prisma generate` dans le worktree fonctionne sur le client partagé : il doit rester un sur-ensemble du schéma de la branche principale.

## 9. Honnêteté des données en test

Les jeux synthétiques portent `synthetique: true` et n'apparaissent jamais dans les vues de production. Les fixtures de catalogue sont des réponses RÉELLES capturées (date, URL de requête, sans secret) ; un test qui n'a pas pu utiliser de réponse réelle le dit.

## 10. Décisions d'interface (EO-FIX-FRONT)

Ce paragraphe fixe ce que l'écran fait, au-delà des formes d'API. Chaque point est défendu par un test (frontend `npx vitest run src/pages/Teledetection src/components/observation-terre src/lib/teledetection`).

**Verdict et constat.** Confirmer et Infirmer exigent un constat : une observation liée OU une référence de constat (`constatRef`, 200 caractères au plus). Tant qu'aucun des deux n'est donné, le bouton « Enregistrer la décision » est inactif et le dit (`aria-describedby`). Le texte « sans preuve jointe » ne s'affiche plus que pour les décisions qui n'exigent pas de constat.

**Un seul envoi à la fois.** La transition, l'affectation à une inspection et le test de connectivité d'une source sont protégés par un verrou synchrone (`useRef`, posé avant tout état React) : un double clic ou plusieurs clics du même tick n'envoient qu'une requête. Le verrou est levé à la fin de la requête, succès ou échec.

**Honnêteté des valeurs de repli.** `limites: null` (avec `limitesNonRenseignees: true`) s'affiche « Limites non renseignées pour cette proposition », jamais « aucune limite ». `terrain.observationsMasquees` s'affiche « N observation(s) hors de votre périmètre ne sont pas affichées ». `source.resolutionOrigine = PRODUIT_LIVRE` change l'intitulé en « Résolution du produit livré » avec la mention « ce n'est pas la résolution native du capteur » ; `capteurOrigine = SOURCE` est dit (« capteur de la source, le produit n'en indique pas »). Un aperçu dont le serveur répond 404 `APERCU_INDISPONIBLE` s'affiche « Aperçu indisponible chez le fournisseur » (état distinct de l'erreur) ; en comparaison, l'image disponible reste affichée et le curseur est désactivé.

**Qualité par méthode.** Panneau national (`GET /qualite-methodes`) : verdicts par type et méthode, chaque pourcentage suivi de son effectif (« 60,7 % (n = 61) »), « échantillon insuffisant » sous le seuil, « Aucun verdict » à zéro verdict. Un compte régional reçoit 403 `HORS_PERIMETRE` : l'écran le rend comme une absence de permission (message dédié, ni erreur ni vide) et renvoie au taux régional des indicateurs.

**Sources.** « Sources actives N sur M enregistrées » : M est le total enregistré, dans la carte de synthèse comme dans le tableau (un seul dénominateur). Le bouton d'en-tête s'appelle « État des sources » : il mène au tableau, il ne configure rien (les identifiants se déclarent côté serveur).

**Ordre du DOM = ordre de lecture et de tabulation.** carte, liste, détail, taux et qualité par méthode, sources, à toute largeur. Aucun `order-*` ni `contents` ; à partir de 1280 px les panneaux sont placés dans la grille par leur colonne et leur ligne. Les noms accessibles des boutons de reprise sont uniques (« Réessayer : Indicateurs », « Réessayer : Sources »...).

**Plein écran de la carte.** Le reste de la page devient `inert` (clavier et lecteur d'écran) ; Échap et le bouton rendent la page et rendent le focus au bouton « Plein écran ».

**Cibles tactiles.** 44 px au moins en dessous de 1280 px (le point de rupture du bureau réel), pas à partir de 768 px. Restent sous 44 px, hors périmètre de l'écran : le champ de recherche de tronçon du composant partagé `TronconPicker` (36 px) ; les cases à cocher natives (16 à 20 px) dont le libellé cliquable, lui, fait 44 px.

**Vue d'ouverture nationale (constantes PROVISOIRES).** Zoom minimal 6 (`ZOOM_MINIMUM_PROPOSITIONS`, `frontend/src/lib/teledetectionCarte.ts`, seule source pour le zoom) ; emprise de 10 degrés de côté (`EMPRISE_MAX_DEGRES`, copie de `BBOX_COTE_MAX_DEG`, `backend/src/teledetection/api.noyau.ts`, qui fait foi : 9,99 passe, 10,01 est refusé). À l'ouverture, la carte se centre sur la Guinée au zoom le plus éloigné dont l'emprise visible reste admise (`zoomOuverture`) : la Guinée entière (environ 7,5 x 5,7 degrés) quand le conteneur est assez petit, sa partie centrale sur un grand écran. Elle affiche les 300 propositions les plus prioritaires (`PLAFOND_MARQUEURS`) et dit « N propositions au total, seules les M plus prioritaires sont affichées : zoomez ». La limite de 10 degrés reste un garde contre un balayage du globe.

**Mesure de fuite mémoire : piège de méthode.** `page.waitForSelector(...)` de Playwright rend un `ElementHandle` qui retient l'élément et, par `parentNode`, tout l'arbre détaché de la page quittée : une série « page avec carte / accueil » mesurée avec ce handle croît de la taille de la page à chaque cycle (1 005 nœuds et 36 écouteurs par aller-retour pour cet écran ; 23 nœuds et 22 écouteurs pour une page react-leaflet minimale sans aucun code de l'application), alors que la même série mesurée avec `page.locator(...).waitFor()` reste plate (279 nœuds, 0 par cycle). Le témoin « sans carte » de la relecture paraissait plat parce que l'élément attendu (`main`) vit dans la mise en page, qui n'est jamais détachée. Aucun code de l'application ne fuit : voir aussi les tests de nettoyage des écouteurs au démontage (`CarteObservationTerre.test.tsx`, `InfoBulle.test.tsx`).

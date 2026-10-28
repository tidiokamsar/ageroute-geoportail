# Consultation des relevés en roulage : contrat de l'API, accès, limites

Auteur : agent « consultation des relevés (côté serveur) », 26/10/2026. Branche `lot/03-map-matching`, arbre de travail non commité.

## 1. Le défaut, et ce que ce document couvre

Un agent envoyait son relevé en roulage (`POST /v2/sync/push`, `entityType: "SessionRoulage"`) : le serveur l'acceptait et l'écrivait
dans `sessions_roulage`, `marqueurs_roulage`, `evenements_roulage` et `evenements_roulage_portions`. **Aucune route ne relisait ces
tables et aucun écran ne les montrait** : le relevé existait en base, invisible. Ce document décrit le côté **serveur** de la
consultation : deux routes en lecture seule. L'écran qui les affiche est un autre chantier (frontend) qui consomme le contrat
ci-dessous tel quel.

| Fichier | Rôle |
|---|---|
| `backend/src/roulage/consultation.noyau.ts` | Règles pures : portée d'un compte, lecture stricte des paramètres, dates, curseur |
| `backend/src/roulage/consultation.service.ts` | Les requêtes SQL (paramétrées, `Prisma.sql`) et la mise en forme des réponses |
| `backend/src/api-v2/roulage.routes.ts` | Les deux routes, montées sous `/api/v2/roulage` (`api-v2/index.ts`) |
| `backend/src/roulage/consultation.noyau.test.ts`, `backend/src/api-v2/roulage.routes.test.ts` | Tests unitaires et de routes (vrai `requireAuth`, base simulée) |
| `backend/tests-integration/roulage-consultation.integration.mts` | Banc PostGIS : relevés écrits par le vrai service, relus par l'application réelle |

Aucune migration, aucun index créé, aucune écriture : tout est déjà en base.

## 2. Accès

Compte authentifié **et** module `inspections` (le même que la collecte : `sync/push`, `devices`, `missions`). Sans jeton : 401. Sans le
module : 403 (corps de `requireModuleAccess`, qui n'a pas de champ `code`). L'ADMIN passe sans module, comme partout.

Au-delà du module, la **visibilité dépend du compte**, relue en base à chaque requête (rôle, modules, périmètre) :

| Compte | Relevés visibles |
|---|---|
| ADMIN | tous |
| GESTIONNAIRE sans rattachement régional (compte national) | tous |
| GESTIONNAIRE rattaché à des régions | les siens, plus ceux dont **au moins une portion créée** (`evenements_roulage_portions.tronconId`) est sur un tronçon dont `troncons.regionId` est dans ses régions |
| INSPECTEUR, LECTEUR, et tout autre rôle | **les siens seulement** (périmètre régional ou non) |

Un relevé **sans aucun tronçon rattaché** (trace hors réseau, ou événements non rattachés) n'a pas de région : un compte régional ne le
voit que s'il en est l'auteur ; un compte national le voit. Un relevé supprimé logiquement (`deletedAt`) n'existe pour personne, ADMIN compris.
La règle est appliquée **dans la clause `WHERE`**, jamais après coup : le `total` d'une liste ne compte que ce que le compte voit.

Les **lectures ne sont pas auditées** (aucune ligne d'`audit_logs`, comme les autres lectures de l'API ; le banc le vérifie). La **création** du relevé l'est (action `CREATE`, `SessionRoulage`).
Les réponses portent `Cache-Control: private, no-store` (ce sont des positions d'agents).

## 3. `GET /api/v2/roulage/sessions`

Paramètres de requête (tous facultatifs, un seul texte chacun ; un paramètre répété ou imbriqué est un 400) :

| Paramètre | Règle |
|---|---|
| `limite` | entier de 1 à 100, défaut 25. `0`, `101`, `abc`, `1.5`, `1e2`, vide : 400 |
| `curseur` | opaque, tel que rendu par `suivant`. Relu strictement (voir plus bas) ; tout écart : 400 `CURSEUR_INVALIDE` |
| `userId` | identifiant de l'agent (caractères `A-Z a-z 0-9 _ -`, 64 au plus). Il **s'ajoute** à la visibilité : demander les relevés d'un autre agent rend une liste vide |
| `depuis`, `jusqua` | date ISO 8601 **réelle** sur `debutA`, en `AAAA-MM-JJ` ou `AAAA-MM-JJThh:mm[:ss[.mmm]]` **avec fuseau** (`Z` ou `+hh:mm`), années 2000 à 2099. `2026-02-30`, `2026-13-01`, une heure sans fuseau, `depuis` postérieur à `jusqua` : 400 |

`depuis` est inclusif. `jusqua` est inclusif à la milliseconde ; donné **sans heure** (`2026-10-25`), il vise la fin de ce jour entier (UTC).

Réponse :

```json
{
  "items": [
    {
      "id": "00000001-0000-4000-8000-000000000011",
      "debutA": "2026-10-20T08:00:00.000Z",
      "finA": "2026-10-20T14:56:39.000Z",
      "dureeS": 24999,
      "nbPoints": 25000,
      "nbMarqueurs": 0,
      "nbEvenements": 0,
      "tauxRattachement": 0,
      "longueurM": 18921,
      "missionId": null,
      "agent": { "id": "625643d1-1203-4a61-a80a-7a6008712e90", "nom": "Agent Alpha" },
      "nbTronconsTraverses": 0,
      "creeLe": "2026-10-26T11:52:11.784Z"
    }
  ],
  "suivant": "eyJkIjoiMjAyNi0xMC0yMFQwODowMDowMC4wMDBaIiwiaSI6IjAwMDAwMDAxLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAxMSJ9",
  "total": 8
}
```

(Extrait d'une exécution réelle du banc, 26/10/2026 ; les identifiants et dates sont ceux du jeu d'essai synthétique.)

Tri : `debutA` décroissant, puis `id` croissant. `suivant` est `null` à la dernière page. `total` compte tous les relevés visibles qui satisfont
les filtres, **curseur exclu** (il ne varie donc pas d'une page à l'autre).

**Le curseur** est la dernière ligne rendue (`debutA` en ISO UTC à la milliseconde, `id`), encodée en base64url. Il est relu comme une entrée
hostile : alphabet borné, JSON à deux clés exactement, date réelle au format canonique, identifiant au format UUID. La page suivante reprend
à « plus ancien, ou même instant et identifiant plus grand » : un relevé envoyé pendant qu'on feuillette s'insère au début sans décaler la
page suivante, et deux relevés du même instant ne sont ni sautés ni rendus deux fois (banc, section 5).

### Sens des champs du résumé

| Champ | Source et sens |
|---|---|
| `dureeS` | `finA - debutA`, en secondes entières |
| `nbPoints` | colonne `nbPoints` (la trace brute reste en base) |
| `nbMarqueurs`, `nbEvenements` | comptes des lignes de `marqueurs_roulage` et `evenements_roulage` |
| `tauxRattachement` | colonne `tauxRattachement`, **tel qu'écrit** (points retenus rattachés / retenus) ; `null` si aucun point retenu |
| `longueurM` | **distance parcourue de l'analyse serveur**, lue telle qu'écrite (`analyse.indicateurs.distanceParcourueM`, somme par segment des distances entre points retenus, arrondie au mètre). **Ce n'est pas la longueur de la polyligne dessinée** (voir §6 : choix de coût) ; `null` si l'indicateur manque |
| `nbTronconsTraverses` | tronçons **distincts** auxquels le relevé se rattache : ceux d'une portion créée et ceux d'un marqueur rattaché. L'analyse n'enregistre pas la liste des tronçons de la trace, seulement des compteurs |
| `agent` | `{ id, nom }` : `users.nomComplet` seulement, ni e-mail ni autre champ du compte |
| `creeLe` | `createdAt` : l'instant de réception par le serveur (distinct de `debutA`, qui vient de l'horloge de l'appareil) |

## 4. `GET /api/v2/roulage/sessions/:id`

Le résumé ci-dessus, plus :

| Champ | Contenu |
|---|---|
| `geometrie` | GeoJSON `MultiLineString` (`ST_AsGeoJSON(geom, 6)`, environ 0,1 m), ou `null` si le relevé n'a pas de géométrie |
| `simplifiee` | `true` si la géométrie a été **simplifiée pour l'affichage** : au-delà de 5 000 sommets, Douglas-Peucker (`ST_Simplify`, parties effondrées conservées) avec la plus fine des tolérances qui ramène sous 5 000 sommets (0,00001 degré, environ 1 m, doublé à chaque essai jusqu'à 0,00128 degré, environ 140 m). Aucun sommet de la trace n'est à plus de la tolérance de la ligne rendue. La trace brute n'est pas touchée |
| `marqueurs` | `{ id, code, note, poseA, lat, lon, precisionM, positionPerimee, statut }` par ordre de pose, plus `sourcePosition`, `motif`, `tronconId`, `tronconCode`, `abscisseM` (additifs) |
| `evenements` | `{ id, code, note, statutAppareil, qualification, debutA, finA, statutRattachement, portions }` par ordre chronologique, plus `motif` (additif) ; `portions` : `{ rang, tronconId, tronconCode, tronconNom, debutM, finM, sens }` plus `portionId` (additif) |
| `analyse` | `{ compteurs, trous, interruptions, pauses }` (colonnes de l'appareil, **telles qu'écrites**) plus `serveur` : la colonne `analyse` (paramètres de l'analyse, indicateurs, avertissements), telle qu'écrite |
| `parametres` | `{ provenance, versionContrat }` plus `seuils` : les seuils appliqués par l'appareil (colonne `parametres`). `provenance` vaut `PROVISOIRE_NON_CALIBRE` : **ces seuils ne sont pas calibrés** |
| `trace` | `{ nbPoints, pointsDisponibles }` ; avec `?avecPoints=1`, aussi `points` et `tronque` |

**Points bruts.** Ils ne sont **pas** renvoyés par défaut (environ 65 octets par point en JSON, mesuré sur 20 000 points : 1,3 Mo). `?avecPoints=1` les
renvoie, bornés aux **20 000 premiers** ; `trace.tronque` vaut alors `true` si la trace en compte davantage. Forme compacte du contrat de la
charge : `[tMs, lat, lon, precisionM, vitesseMs, segment]`. Valeurs acceptées : `1`, `true`, `0`, `false` ; tout autre : 400.

**Choix signalés** (additifs ou d'interprétation, à confirmer par le chantier frontend) :

- `marqueurs[].lat` et `lon` sont la **position sur la trace à l'instant de pose** (`positionTraceLat/Lon`, celle qui a servi au rattachement et à la
  géométrie du marqueur) ; à défaut, la position brute de l'appareil. `sourcePosition` dit laquelle (`TRACE`, `APPAREIL`, `null`). La position brute de
  l'appareil peut être périmée (`positionPerimee`) ; la position de la trace est interpolée à l'instant exact.
- `evenements[].portions` ne contient que les portions **créées** (table `evenements_roulage_portions`). Les tronçons refusés (territoire, code de référentiel
  inconnu, chevauchement d'une portion validée) ne sont pas listés ; leur motif global est dans `evenements[].motif` quand aucune portion n'a été créée.
- Les portions créées sont des **propositions `A_VALIDER`** : la consultation ne les valide pas (les écrans existants le font).

### Exemple de détail (extrait d'une exécution réelle, géométrie tronquée à 2 sommets pour la lecture)

```json
{
  "id": "00000001-0000-4000-8000-000000000001",
  "debutA": "2026-10-11T08:00:00.000Z", "finA": "2026-10-11T08:04:40.000Z", "dureeS": 280, "nbPoints": 281,
  "nbMarqueurs": 2, "nbEvenements": 2, "tauxRattachement": 1, "longueurM": 2797, "missionId": null,
  "agent": { "id": "625643d1-1203-4a61-a80a-7a6008712e90", "nom": "Agent Alpha" },
  "nbTronconsTraverses": 2, "creeLe": "2026-10-26T11:52:07.061Z",
  "geometrie": { "type": "MultiLineString", "coordinates": [[[-13.598178, 9.64], [-13.598086, 9.64], "... (281 sommets au total)"]] },
  "simplifiee": false,
  "marqueurs": [
    { "id": "00000161-0000-4000-8000-000000002811", "code": "NID_DE_POULE", "note": "premier marqueur", "poseA": "2026-10-11T08:00:40.000Z",
      "lat": 9.64, "lon": -13.594532909496058, "sourcePosition": "TRACE", "precisionM": 5, "positionPerimee": false,
      "statut": "RATTACHE", "motif": null, "tronconId": "t-cons-1", "tronconCode": "CONS-1", "abscisseM": 600.1 }
  ],
  "evenements": [
    { "id": "00000178-0000-4000-8000-000000002812", "code": "ETAT_CHAUSSEE", "note": null, "statutAppareil": "CLOS",
      "qualification": { "etat": "MAUVAIS" }, "debutA": "2026-10-11T08:01:50.000Z", "finA": "2026-10-11T08:02:40.000Z",
      "statutRattachement": "PORTIONS_CREEES", "motif": null,
      "portions": [
        { "rang": 0, "portionId": "0457ffd2-2bd1-4050-8239-95239c3bb3f4", "tronconId": "t-cons-1", "tronconCode": "CONS-1", "tronconNom": "Route CONS-1", "debutM": 1300.1, "finM": 1480.1, "sens": "CROISSANT" },
        { "rang": 1, "portionId": "3124ca9c-956a-483a-95d0-f497b4b0545f", "tronconId": "t-cons-2", "tronconCode": "CONS-2", "tronconNom": "Route CONS-2", "debutM": 0, "finM": 300, "sens": "CROISSANT" }
      ] }
  ],
  "analyse": { "compteurs": { "rejets": {}, "alertes": 0, "sansPrecision": 0 }, "trous": [], "interruptions": [], "pauses": [], "serveur": { "indicateurs": { "pointsRecus": 281, "pointsRetenus": 141, "pointsRattaches": 141, "distanceParcourueM": 2797 } } },
  "parametres": { "provenance": "PROVISOIRE_NON_CALIBRE", "versionContrat": 1, "seuils": { "trouMs": 5000, "precisionMaxM": 50 } },
  "trace": { "nbPoints": 281, "pointsDisponibles": true }
}
```

(`analyse.serveur` et `parametres.seuils` sont abrégés ici ; la réponse les porte en entier.)

## 5. Erreurs

Toutes de la forme `{ error, code }`, **sauf** le 403 de module, qui garde le corps de `requireModuleAccess` (`{ error }`).

| Statut | Code | Quand |
|---|---|---|
| 400 | `PARAMETRE_INVALIDE` | `limite`, `userId`, `depuis`, `jusqua` (liste) ou `avecPoints` (détail) invalide, répété ou imbriqué ; plage de dates inversée |
| 400 | `CURSEUR_INVALIDE` | curseur forgé, tronqué, ou de forme inattendue |
| 401 | `NON_AUTHENTIFIE`, `JETON_INVALIDE`, `COMPTE_INACTIF` | garde `requireAuth` |
| 403 | (sans code) | module `inspections` absent |
| 404 | `RELEVE_INTROUVABLE` | détail uniquement (voir ci-dessous) |

**Un seul 404, au même corps** (`{ "error": "Releve introuvable", "code": "RELEVE_INTROUVABLE" }`) pour : relevé inexistant, supprimé logiquement, hors de
la portée du compte, et identifiant mal formé (qui n'est pas un UUID). L'ordre des contrôles est voulu : **identifiant, puis portée, puis seulement les options**.
Une requête hostile sur un relevé qu'on ne peut pas voir (`?avecPoints=zzz`, paramètres répétés) rend donc le 404 et non un 400, et ne révèle rien de plus qu'une
requête correcte. Un paramètre invalide sur un relevé **visible** est un 400. Le banc compare les corps octet pour octet sur dix cas.

Entrées hostiles : toute valeur qui arrive en base passe par un paramètre lié (`Prisma.sql`), jamais par le texte de la requête, et est validée avant (`limite`, dates, curseur,
`userId`, identifiant). Le banc envoie seize entrées hostiles sur la liste (dont des tentatives d'injection dans `userId`, le curseur et l'identifiant) : toutes 400, aucune 500, et
`sessions_roulage`, `users` et `audit_logs` gardent le même effectif.

## 6. Coût mesuré, et choix qui en découlent

Mesures du 26/10/2026 sur le poste de développement (PostgreSQL 17 + PostGIS en conteneur, charge variable : plusieurs agents travaillent sur la même machine ; **ce
ne sont pas des chiffres de production**).

| Mesure | Résultat |
|---|---|
| `ST_Length(geom::geography)` sur une trace de 25 000 points | 100 à 200 ms **par relevé** (la seule lecture de `geom`, sans calcul, en coûte déjà plus du tiers : 70 ms) |
| Liste de 100 relevés de 25 000 points, avec `ST_Length` | **15,6 à 19,1 s** (mesuré avant de changer de méthode) |
| Même liste, `longueurM` lu dans `analyse` | **0,2 à 0,6 s** (trois appels, 110 relevés en base) |
| Détail d'un relevé de 7 200 points, sans points bruts | environ 0,3 s |
| Détail d'une trace de 25 000 points (géométrie simplifiée) | 0,5 à 1,5 s |
| Détail de la même trace avec `?avecPoints=1` (20 000 points, 1,3 Mo) | 0,8 à 2,8 s (une mesure isolée à 6 s a été vue sous charge, non reproduite) |
| `ST_SimplifyPreserveTopology` au lieu de `ST_Simplify` (trace de 25 000 points) | détail à 3,9 s au lieu de 1,6 s : écarté |

D'où deux choix : **`longueurM` est lu dans l'analyse enregistrée à l'écriture** au lieu d'être recalculé, et la géométrie utilise **`ST_Simplify`** (une trace GNSS se
recoupe naturellement, préserver une topologie n'y a pas de sens). La valeur lue est cohérente avec la polyligne (le banc vérifie un écart inférieur à 1 % sur la
trace synthétique) mais **n'est pas une mesure de la géométrie rendue**. Le banc mesure séparément la longueur du GeoJSON rendu, relue par PostGIS, contre `ST_Length`
de la géométrie stockée.

**Index.** Aucun n'a été créé. Existent : clés primaires `(sessionId, id)` sur les marqueurs et événements (utilisées par les comptes de la liste), `(sessionId, evenementId, rang)` sur
les portions (utilisée par la portée régionale, qui joint ensuite `troncons` par sa clé primaire), `userId`, `appareilId`, `missionId` sur les sessions. **Manquent** : un index sur
`sessions_roulage ("debutA" DESC, "id")` (le tri de la liste lit et trie toutes les lignes visibles ; sans importance au volume actuel, **non mesuré à grande échelle**) et sur `deletedAt`. Si le
volume atteint plusieurs milliers de relevés, un index partiel `("debutA" DESC, "id") WHERE "deletedAt" IS NULL` s'impose ; il demande une migration (hors de ce chantier).
Si la liste doit un jour afficher la longueur **géométrique**, la bonne voie est une colonne stockée à l'écriture (migration), pas un recalcul à chaque page.

## 7. Ce que les tests prouvent, et ce qu'ils ne prouvent pas

- `consultation.noyau.test.ts` : dates (années bissextiles, dates impossibles, fuseaux), curseur (aller-retour, quatorze formes forgées), bornes de `limite`, paramètres
  répétés ou imbriqués, portée par rôle (dont : liste de régions vide, rôle inconnu, rôle futur).
- `roulage.routes.test.ts` : vrai routeur, vrai `requireAuth` (jeton signé, compte injecté), vrai `requireModuleAccess`, vrai `regionsVisibles`, **base simulée**. Prouve le câblage :
  matrice anonyme / sans module / INSPECTEUR propriétaire et autre agent / LECTEUR / GESTIONNAIRE national, de la région 1, de la région 2 / ADMIN, sur la liste et le détail ;
  la clause de visibilité part à la base avec l'identifiant et les régions **en paramètres** ; 404 identique ; entrées hostiles arrêtées avant la base ; aucune requête d'écriture. Deux mutations
  (portée « siens » ouverte à tous, contrôle de portée du détail retiré) ont été introduites puis retirées : les tests les attrapent. **Ce fichier ne prouve pas le SQL.**
- `roulage-consultation.integration.mts` (PostGIS réel) : voir `backend/tests-integration/README.md`. Prouve le SQL, avec des relevés écrits par le vrai service d'écriture.

**Non couvert** : traces réelles (le banc utilise une droite à vitesse constante, et une trace bruitée de 25 000 points) ; aucun téléphone ; un volume de production ; la validation
des portions proposées (autre écran).

## 8. Intégration : l'écran « Relevés envoyés » contre l'API réelle (26/10/2026)

L'écran (`frontend/src/pages/ReleveEnvoyesPage.tsx`, `frontend/src/components/roulage/*`, `frontend/src/lib/roulageEnvoyes.ts` et `roulageEnvoyesVue.ts`) avait été écrit contre un
contrat simulé. Il a été confronté à l'API réelle, sans aucune interception, puis corrigé.

**Méthode.** Clone jetable `essai_roulage_ecran` de la base locale `replay` (migration `20261024100000_sessions_roulage` appliquée au clone) ; API du dépôt sur le port 3411 ;
Vite sur le port 5412 (configuration jetable hors dépôt, qui reprend celle du frontend et ne change que le port et la cible du proxy) ; trois relevés écrits par le vrai service
(`field/sync.service.appliquer`) pour un agent d'essai (ECR-1 sur le réseau, deux tronçons fabriqués, deux repères, deux segments ; ECR-2 hors réseau ; ECR-3 de 25 000 positions),
puis 24 relevés courts de septembre pour la pagination ; Chromium piloté par Playwright. Comptes d'essai créés dans le clone, mots de passe aléatoires, jamais écrits dans le dépôt.
Le clone, les serveurs et les fichiers temporaires ont été supprimés à la fin. Les réponses réelles servent de fixtures aux tests
(`frontend/src/lib/roulageEnvoyes.reel.fixture.ts` : seule modification, les coordonnées de la géométrie réduites à 4 sommets par ligne).

**Écarts tranchés** (constat sur le serveur réel, puis correction de l'écran) :

| Point | Constat réel | Décision côté écran |
|---|---|---|
| `depuis` / `jusqua` | L'écran envoie des instants `AAAA-MM-JJThh:mm:ss.mmmZ` : acceptés (200), fin de jour inclusive, bornes exactes sur le relevé du 24/10. Un instant dont l'année UTC n'est pas 2000 à 2099 : 400 | Format conservé. Une année que le serveur refuserait n'est plus envoyée : l'écran le dit (« Les dates acceptées vont de 2000 à 2099 ») et garde la dernière période valide |
| `tauxRattachement` | Échelle 0 à 1 confirmée (0 sur ECR-2 et ECR-3, 1 sur ECR-1). `0` est une valeur (0 point rattaché sur 45 retenus), `null` seulement sans point retenu | Inchangé (« 0 % », « non évalué »). L'écran montre en plus le dénominateur : positions retenues par l'analyse et dont rattachées, lues dans `analyse.serveur.indicateurs` |
| `analyse` | Blocs de l'appareil (`compteurs`, `trous`, `interruptions`, `pauses`) lus tels quels, plus `serveur` : `parametres`, `indicateurs`, `avertissements` | Le typage nomme `serveur` ; les avertissements du serveur sont montrés tels quels (sans doublon exact), ainsi que les points retenus et rattachés |
| `trace.pointsDisponibles` | Booléen (jamais un nombre) | Le type et le validateur sont stricts : un nombre est une réponse illisible. La phrase « seules N positions sur M » (contrat simulé) est supprimée |
| `longueurM` | Distance parcourue de l'analyse (2 797 m pour ECR-1, 18 921 m pour ECR-3 dont la géométrie rendue est simplifiée) | Libellé « Distance parcourue » (liste et détail), avec une phrase qui dit que ce n'est pas la longueur du tracé dessiné |
| `simplifiee` | Vrai pour ECR-3 (3 181 sommets rendus sur 25 000) | Le message le dit et rappelle que la distance vient de l'analyse |
| Champs additifs | `marqueurs[].sourcePosition, motif, tronconId, tronconCode, abscisseM`, `evenements[].motif`, `portions[].portionId`, `parametres.seuils` présents | Lus comme facultatifs (absent = `null`) ; affichés : tronçon et abscisse d'un repère rattaché, motif d'un repère ou d'un segment non rattaché (traduit s'il est connu, rendu tel quel sinon), seuils de l'appareil dans un bloc replié, provenance `PROVISOIRE_NON_CALIBRE` dite « seuils provisoires, non calibrés » |
| Position d'un repère | `lat`/`lon` sont la position sur la trace (`sourcePosition = TRACE`) ; `positionPerimee` concerne le point brut du téléphone | Un repère retrouvé sur la trace n'est plus dit « approximatif » ni dessiné en pointillé à tort ; seul un repère dont la position vient du téléphone avec un point ancien l'est |
| `nbTronconsTraverses` | Compte les tronçons des portions créées ET des repères rattachés ; ce n'est pas la liste des tronçons longés par la trace | La liste détaillée suit la même définition (le compte détaillé égale celui du serveur sur les trois relevés réels) et s'intitule « Tronçons rattachés » |
| Forme des repères et segments | Non validée auparavant (un champ de mauvais type pouvait faire planter la page) | Validée : un repère, un segment ou une portion de forme inattendue rend la réponse illisible (erreur dite, jamais une page à moitié fausse) |

**Résultats de la vérification de bout en bout** (Chromium, API réelle sur PostGIS) : connexion de l'agent par le formulaire ; « Relevés envoyés » ouvert par le menu ; liste de 3 relevés
dans l'ordre, distance parcourue et taux (0 %, 100 %, 0 %) conformes à l'API ; détail avec carte Leaflet (trace et repères), avertissements, repères avec tronçon et abscisse, portions, tronçons ;
pagination (25 puis 27, sans doublon ni saut) ; filtre de dates ; autre agent : liste vide honnête et détail « introuvable » (même 404) ; ADMIN : tous les relevés avec la colonne agent ;
relevé envoyé par l'application (GPS émulé) retrouvé dans la liste, et lien « Voir ce relevé sur le serveur » menant à son détail. Aucune erreur de console hors le 404 attendu du test « autre agent ».

**Ce que cela ne prouve pas** : le GPS émulé par Playwright n'est pas un téléphone (le relevé envoyé par l'application affiche 45 interruptions pour 46 positions : cause non élucidée, probablement la cadence
des événements émulés) ; les tuiles de fond OpenStreetMap ont chargé de façon partielle pendant les essais (réseau), la trace et les repères sont vectoriels et ne dépendent pas d'elles ; aucune trace réelle ni volume de production.

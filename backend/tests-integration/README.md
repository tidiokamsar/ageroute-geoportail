# Bancs d'integration PostGIS

Ces bancs exercent le code **contre une vraie base PostgreSQL/PostGIS**, là où les tests Vitest
simulent la base. Ils sont la preuve derrière les mentions « vérifié contre PostGIS réel » de
`REQUIREMENTS_TRACEABILITY.md` et de `AUTONOMOUS_EXECUTION_TRACKER.md`.

Ils ne sont **pas lancés par la CI** (la CI n'a pas de base PostGIS pour ces bancs) et ne sont pas
vérifiés par `tsc` (hors de `src/`). Ils ne font pas partie de `npm test`, sauf les tests de leurs deux
modules d'appui (`lib/garde.test.ts`, `lib/verdict.test.ts`).

## Prérequis

- Une base PostGIS **locale** dont les 69 migrations sont appliquées et qui s'appelle `replay`
  (rejeu des migrations, sans donnée). Sur ce poste : conteneur `bdri-dev-db`, port 5434. Les 69
  migrations ne s'appliquent de bout en bout sur une base vierge qu'avec le pont décrit dans
  `backend/prisma/descentes/README.md` (défaut D-10 sur `marches`). **La fabrication de `replay` n'est
  pas automatisée par ces bancs** : à scripter si la base doit être reconstruite sur un autre poste.
- `DATABASE_URL` pointant sur cette base. Les identifiants ne sont jamais écrits dans ces fichiers.
- Les dépendances du backend installées (`tsx` est une devDependency).

## La garde

`lib/garde.ts` est importé par chaque banc et **termine le processus (code 3)** si la cible n'est pas
à la fois :

- sur la machine locale (`127.0.0.1`, `localhost`, `::1`) ;
- une base nommée `replay` ou `essai_<nom>`.

Une variable `DATABASE_URL` laissée dans un terminal et pointant ailleurs ne peut donc pas être
atteinte. La garde est testée (`lib/garde.test.ts`, lancée par `npm test`).

## Lancer

```bash
DATABASE_URL="postgresql://utilisateur:motdepasse@127.0.0.1:5434/replay" bash tests-integration/run.sh
```

ou `npm run test:integration` avec la variable posée, ou un seul banc :
`npx tsx tests-integration/trace.integration.ts`.

## Ce que chaque banc affirme

Chaque banc nomme ses vérifications, les compte, et sort en **code 1** si une seule est fausse.
`lib/verdict.ts` fait aussi échouer un banc qui n'a fait **aucune** vérification (testé dans
`lib/verdict.test.ts`) ; le banc `curseur` tient son propre décompte (41 vérifications).

| Banc | Travaille dans | Vérifications | Couvre |
|---|---|---|---|
| `trace` | transaction annulée | 9 | analyse d'une trace contre un réseau réel, leurre parallèle, graphe branché |
| `metadonnees` | transaction annulée, fuseau de session NZ | 9 | étendue et date de révision des métadonnées ISO 19115 |
| `geometries-invalides` | transaction annulée | 6 | compte exact des géométries invalides |
| `deviation` | transaction annulée | 8 | déviation routée, longueur comparée à un **oracle SQL** |
| `chemin` | transaction annulée | 13 | route entre deux villes : troncons dans l'ordre sur le reseau, ni route parallele ni route qui traverse, longueur comparée à un **oracle SQL**, sens inverse au retour, ville hors référentiel, trou du référentiel (aucun chemin, jamais une ligne droite), troncon archivé |
| `historique` | transaction annulée | 19 | historique d'une section et classement « à contrôler » : constats par jour, récurrences, confirmés et proposés à part, rejeté et supprimé écartés, **observation conteneur d'un défaut non comptée deux fois**, score calculé à la main, périmètre régional |
| `graphe` | transaction annulée | 7 | graphe chargé depuis la base, jonction comparée à un oracle SQL |
| `info-route` | transaction annulée | 12 | publication, retrait, bulletin archivé immuable, absence de fuite de texte interne |
| `patrouilles` | transaction annulée | 10 | programmes, missions, couverture, vérification de signalement, audit |
| `teledetection` | transaction annulée | 10 | produits, propositions, tolérance, verdict unique, précision, audit |
| `veille` | transaction annulée | 10 | astreintes, escalades idempotentes, tableau de veille, audit |
| `contour` | transaction annulée | 7 | contour du pays du géoportail : frontière extérieure de l'union des régions de niveau 1 (limite commune disparue, niveau 2 exclu, absent sans limites) |
| `perf/` | clone jetable, jeu synthétique déterministe de 20 000 ou 261 387 tronçons | 45 | **seuils A15 et A20** mesurés (p50/p95/p99, service et HTTP) ; échoue si un seuil du cahier est dépassé ; `--sans-correctifs` rejoue l'origine pour la contre-épreuve. Méthode : `perf/README.md` ; lancé à part, pas par `run.sh` (durée et charge) |
| `curseur` | **clone `essai_curseur`**, créé puis détruit par le banc | 41 | curseur temporel à deux axes, requalification, découpe, fusion |
| `programmation` | **clone `essai_programmation`**, créé puis détruit par le banc ; applique au clone la migration `20261023100000` (absente de `replay` tant qu'elle n'y est pas rejouée) | 106 | moteur de risque et de programmation (§ 7.7, A22) : risque, coût et classement comparés à un **oracle SQL** (NUMERIC exact, glouton refait en BigInt), refus sans barème, étiquette PROVISOIRE, rejeu octet pour octet, fiche figée (empreinte recalculée par la base, UPDATE et DELETE refusés), frontière DigitalRoad tenue par les contraintes, audit |
| `outbox` | **clone `essai_outbox`**, créé puis détruit par le banc | 90 | outbox des intégrations sortantes (A13) : aucune donnée non validée n'entre (service et déclencheurs), idempotence, rejeu sans effet de bord, reprise, file morte, anti-double-envoi sous concurrence réelle, absence de fuite de champs internes. **Contre des simulateurs HTTP écrits par AGEROUTE sur 127.0.0.1, jamais contre DigitalRoad, SharePoint ou la BDR / L²R.** Applique la migration 20261024200000 au clone si `replay` ne la porte pas encore |
| `tableau-de-bord` | **clone `essai_tableau_de_bord`**, créé puis détruit par le banc | 116 | A12 : chacun des 31 indicateurs du registre, sur trois portées (national, région 1, région 2), est égal à sa requête de contrôle **et** à une valeur attendue calculée à la main (longueurs par intégrale du méridien WGS84) ; refus d'un indicateur non ventilé à un compte régional (A10) ; région vide ; échéances de patrouille à deux dates ; recoupement avec `longueurReseau` et `couvertureReseau` ; contre-épreuve ; Control Tower ; volets de la fiche 360 |
| `metre` | lecture seule | 29 | métré UTM (A5) : 9 géométries de référence, PostGIS = valeur de définition au millionième, PostGIS = noyau TypeScript (`geo/utm.noyau.ts`) au millionième, papillon refusé avec sa raison (le métré d'un défaut est le banc `metre-defaut`) |
| `tuiles` | transaction annulée | 9 | tuiles MVT (§ 7.14) **décodées** par un lecteur protobuf propre au banc : objets par couche comparés à un oracle SQL, propriétés publiées, voirie seulement dès z12, tuile hors Guinée vide |
| `coherence` | **clone `essai_coherence`**, créé puis détruit ; applique `20261025120000` | 12 | compléments de cohérence A30 par le service et par la base (produit et référence retirés, distance déclarée, registre figé, pas de suppression physique), vue lue avec sa gravité, **descente rendant la vue d'origine à l'identique** |
| `roulage` | **clone `essai_roulage`**, créé puis détruit par le banc (il y applique la migration `20261024100000` si `replay` ne l'a pas) | 50 | **simulation** d'une session de 2 h à 1 Hz produite par le vrai noyau de l'appareil : zéro doublon au rejeu, taux de rattachement mesuré, marqueurs et événements linéaires comparés à un **oracle SQL**, territoire, audit, refus |
| `sync` | **clone `essai_sync`** ; routes réelles (`/api/v2/sync`), jetons signés | 67 | A7 et A8 : 50 observations rejouées, coupures, ordre inversé, concurrence, atomicité, PostGIS ; conflits, deux versions conservées, arbitrage |
| `import` | **clone `essai_import`** ; route multipart réelle | 39 | A28 : statut par ligne, rejeu sans écriture, lot modifié, CSV hors norme, concurrence, 20 000 lignes |
| `metre-defaut` | **clone `essai_metre`** ; applique au clone les migrations `20261024300000` et `20261024310000` | 73 | A5 : contour GPS d'un défaut mesuré en UTM, 37 figures contre un oracle écrit sans PostGIS (`lib/geodesie.ts`) |
| `contour-terrain` | **clone `essai_contour_terrain`** ; applique au clone les migrations `20261024300000` et `20261024310000` ; importe le module PUR de l'appareil `frontend/src/lib/contourDefaut.ts` ; `CONTOUR_FUZZ=600` pour un lancement court | 49 (à 4 000 polygones) | A5, ecran de releve du contour : le client est une garde, le serveur l'arbitre. 15 contours nommes + 4 000 polygones tires au hasard (graine fixe) contre `ST_IsValid` : 0 fausse acceptation, 0 refus injustifie ; le contour du client mesure 10 000 m2 a 0,02 % par `/v2/defauts` et `/v2/sync/push` ; la regle des mesures exigees est celle du serveur, unité par unité. Dure environ 10 minutes sur un poste charge (non intégré à `npm test`) |
| `taches-internes` | **clone `essai_taches`** ; écrit puis retire des photos dans `uploads/photos` | 76 | A29 : preuves avant/après, clôture, abandon, frontière DigitalRoad, rapprochement en lecture seule |
| `extension-unaccent` | **clone `essai_unaccent`**, créé puis détruit par le banc (il y retire `unaccent`, applique le `migration.sql` du dépôt, puis le rejoue) | 8 | migration `20261026400000` : sur une base reconstruite sans l'extension, `GET /api/public/carte/geo` répond **500** (contre-épreuve), puis **200** avec la migration ; jointure sans accents « Boke » / « Boké » ; rejeu sans effet. **Ne prouve pas** la production ni les droits du rôle de migration |
| `qualite-geometries` | **clone `essai_qualgeom`**, créé puis détruit par le banc (migration unaccent appliquée au clone ; la contrainte `eo_emprise_valide` y est retirée pour fabriquer une emprise invalide) | 38 | § 7.1 : validité des géométries sur **six tables** (tronçons, chantiers, portions courantes, limites administratives, emprises de télédétection, actifs linéaires) avec des géométries réellement invalides (nœud papillon, trou hors coque, LineString dégénérée) ; compte exact au-delà du plafond, périmètre par région (descente de `parentPcode`, cycle), supprimées et remplacées ignorées ; **oracle TypeScript indépendant** de PostGIS ; boucle non fermée refusée par PostGIS ; contre-épreuve. Mutation du détecteur : 12 échecs |
| `territoire` | **clone `essai_territoire`**, créé puis détruit par le banc ; routes réelles (v1 et v2 montées comme en production), jetons signés par des secrets aléatoires | 93 | A10 : **vrais comptes à périmètre régional** (une région, deux régions, national sans rattachement, ADMIN, LECTEUR) : 403 hors zone pour création, modification (région d'avant ET d'après), archivage, restauration et lots ligne à ligne sur les cinq entités de la fabrique ; routes v1 hors fabrique (géométrie, géolocalisation, inspection, conversion d'OT) ; v2 (portions, défauts, décision) ; synchronisation (opération hors zone rejetée seule, non enregistrée) ; périmètre vide, région inconnue ; effet immédiat d'un rattachement sans nouveau jeton ; lecture refusée hors périmètre (fiche 360) et portée du tableau de bord ; contre-épreuve (même jeton, même requête, avec puis sans périmètre). Mutation de deux gardes : 17 échecs. **Non couvert** : imports Excel réels, photos d'ouvrage, validation d'une proposition de localisation, observations ; **constat** : les listes v1 ne sont pas filtrées par région ; retirer toutes les régions d'un compte le rend national |
| `info-route-delai` | **clone `essai_inforoute`**, routes réelles (main courante, Info Route, flux public), 8 lecteurs publics concurrents | 12 | A24 : **délai validation vers lisible par le public** mesuré sur 30 publications (p50 409 ms, max 716 ms le 26/10/2026), seuil 60 s ; disparition après retrait ; en-tête `max-age=30` pris dans la borne de bout en bout ; contre-épreuves (rien avant validation, seuil de 100 ms fait échouer). **Ne mesure pas** un relais, un CDN, un navigateur ni un consommateur réel du flux |
| `incident-hors-ligne` | **clone `essai_incident`**, routes réelles de la main courante | 16 | A24, **moitié serveur seulement** : incident daté 3 h plus tôt, heure serveur qui fait foi, rejeux et rafale de 12 envois de la même clé (1 création, 11 « déjà reçu » ; trouvait 10 erreurs 500 avant `cle-operation.ts`), chaîne dans l'ordre de réception, base en ajout seul. **Ne couvre pas la file locale de l'appareil**, absente |
| `correspondances` | **clone `essai_corresp`** (applique la migration `20261026410000`), routes réelles | 31 | A23, critère **B12** : table vide à l'arrivée, « à confirmer » jusqu'à la décision d'une autre personne, export de la version n **identique octet pour octet** après dix changements, règles tenues par la base, série de versions sans trou sous concurrence, audit. **Aucune correspondance réelle** (jetons de test) |

Soit **739 vérifications sur 18 bancs**, toutes passantes le 22/10/2026 après la fusion des six lots d'agents
(`bash tests-integration/run.sh`, code 0). Les bancs `roulage`, `outbox`, `programmation`, `tableau-de-bord`, `sync`,
`import`, `metre-defaut` et `taches-internes` créent leur propre clone de `replay` et y appliquent au besoin les
migrations récentes. `roulage` est une **simulation** (voir `docs/roulage/COLLECTE-ROULAGE.md`) ; les bancs `sync`
et `import` fabriquent leurs jetons avec des secrets tirés au hasard à chaque lancement : rien n'est écrit dans le dépôt.

Les bancs `metre`, `tuiles` et `coherence` (50 vérifications, branche `lot/17-consignes-dt`) s'y ajoutent : lancés un par un le 22/10/2026 (code 0), pas encore rejoués avec l'ensemble.

## Le banc de performance (hors `run.sh`)

`perf/` contient le banc des scenarios A15 et A20 : reseau synthetique deterministe de 20 000 a 261 387 troncons dans un
clone jetable `essai_perf`, 200 mesures par scenario (p50, p95, p99), verdict contre les seuils du cahier. Il dure de
dix minutes a deux heures et **n'est pas lance par `run.sh`**. Voir `perf/README.md` et
`docs/performance/MESURES-A15-A20.md`. Ses modules d'appui ont des tests Vitest (`perf/lib/*.test.ts`), lances par `npm test`.

## Limites

- Les bancs ci-dessus tournent sur une base **vide** : aucune mesure de performance ni de comportement sur le volume
  de production (261 387 tronçons au registre complet). Le banc `perf/` est le seul qui charge ce volume (synthetique).
- Les jeux de données sont des fixtures écrites pour le banc, pas des données réelles.
- Les bancs `deviation`, `graphe`, `info-route`, `patrouilles`, `teledetection` et `veille` existaient
  d'abord comme scripts qui imprimaient des valeurs sans rien affirmer ; leurs vérifications ont été
  écrites le 22/10/2026 à partir de ce qu'ils imprimaient **et de calculs indépendants** quand c'était
  possible (oracles SQL pour `deviation`, `graphe`). Les autres reposent sur des invariants lus dans le
  code : elles caractérisent le comportement actuel, elles ne prouvent pas qu'il est le bon au sens métier.
- Une vérification vraie prouve que le code fait ce que le banc attend, pas que le banc attend la bonne
  chose.

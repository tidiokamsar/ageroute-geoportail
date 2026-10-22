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
| `graphe` | transaction annulée | 7 | graphe chargé depuis la base, jonction comparée à un oracle SQL |
| `info-route` | transaction annulée | 12 | publication, retrait, bulletin archivé immuable, absence de fuite de texte interne |
| `patrouilles` | transaction annulée | 10 | programmes, missions, couverture, vérification de signalement, audit |
| `teledetection` | transaction annulée | 10 | produits, propositions, tolérance, verdict unique, précision, audit |
| `veille` | transaction annulée | 10 | astreintes, escalades idempotentes, tableau de veille, audit |
| `contour` | transaction annulée | 7 | contour du pays du géoportail : frontière extérieure de l'union des régions de niveau 1 (limite commune disparue, niveau 2 exclu, absent sans limites) |
| `curseur` | **clone `essai_curseur`**, créé puis détruit par le banc | 41 | curseur temporel à deux axes, requalification, découpe, fusion |
| `programmation` | **clone `essai_programmation`**, créé puis détruit par le banc ; applique au clone la migration `20261023100000` (absente de `replay` tant qu'elle n'y est pas rejouée) | 106 | moteur de risque et de programmation (§ 7.7, A22) : risque, coût et classement comparés à un **oracle SQL** (NUMERIC exact, glouton refait en BigInt), refus sans barème, étiquette PROVISOIRE, rejeu octet pour octet, fiche figée (empreinte recalculée par la base, UPDATE et DELETE refusés), frontière DigitalRoad tenue par les contraintes, audit |
| `outbox` | **clone `essai_outbox`**, créé puis détruit par le banc | 90 | outbox des intégrations sortantes (A13) : aucune donnée non validée n'entre (service et déclencheurs), idempotence, rejeu sans effet de bord, reprise, file morte, anti-double-envoi sous concurrence réelle, absence de fuite de champs internes. **Contre des simulateurs HTTP écrits par AGEROUTE sur 127.0.0.1, jamais contre DigitalRoad, SharePoint ou la BDR / L²R.** Applique la migration 20261024200000 au clone si `replay` ne la porte pas encore |
| `tableau-de-bord` | **clone `essai_tableau_de_bord`**, créé puis détruit par le banc | 116 | A12 : chacun des 31 indicateurs du registre, sur trois portées (national, région 1, région 2), est égal à sa requête de contrôle **et** à une valeur attendue calculée à la main (longueurs par intégrale du méridien WGS84) ; refus d'un indicateur non ventilé à un compte régional (A10) ; région vide ; échéances de patrouille à deux dates ; recoupement avec `longueurReseau` et `couvertureReseau` ; contre-épreuve ; Control Tower ; volets de la fiche 360 |
| `roulage` | **clone `essai_roulage`**, créé puis détruit par le banc (il y applique la migration `20261024100000` si `replay` ne l'a pas) | 50 | **simulation** d'une session de 2 h à 1 Hz produite par le vrai noyau de l'appareil : zéro doublon au rejeu, taux de rattachement mesuré, marqueurs et événements linéaires comparés à un **oracle SQL**, territoire, audit, refus |
| `sync` | **clone `essai_sync`** ; routes réelles (`/api/v2/sync`), jetons signés | 67 | A7 et A8 : 50 observations rejouées, coupures, ordre inversé, concurrence, atomicité, PostGIS ; conflits, deux versions conservées, arbitrage |
| `import` | **clone `essai_import`** ; route multipart réelle | 39 | A28 : statut par ligne, rejeu sans écriture, lot modifié, CSV hors norme, concurrence, 20 000 lignes |
| `metre-defaut` | **clone `essai_metre`** ; applique au clone les migrations `20261024300000` et `20261024310000` | 73 | A5 : contour GPS d'un défaut mesuré en UTM, 37 figures contre un oracle écrit sans PostGIS (`lib/geodesie.ts`) |
| `taches-internes` | **clone `essai_taches`** ; écrit puis retire des photos dans `uploads/photos` | 76 | A29 : preuves avant/après, clôture, abandon, frontière DigitalRoad, rapprochement en lecture seule |

Soit **739 vérifications sur 18 bancs**, toutes passantes le 22/10/2026 après la fusion des six lots d'agents
(`bash tests-integration/run.sh`, code 0). Les bancs `roulage`, `outbox`, `programmation`, `tableau-de-bord`, `sync`,
`import`, `metre-defaut` et `taches-internes` créent leur propre clone de `replay` et y appliquent au besoin les
migrations récentes. `roulage` est une **simulation** (voir `docs/roulage/COLLECTE-ROULAGE.md`) ; les bancs `sync`
et `import` fabriquent leurs jetons avec des secrets tirés au hasard à chaque lancement : rien n'est écrit dans le dépôt.

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

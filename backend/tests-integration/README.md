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
| `curseur` | **clone `essai_curseur`**, créé puis détruit par le banc | 41 | curseur temporel à deux axes, requalification, découpe, fusion |
| `tableau-de-bord` | **clone `essai_tableau_de_bord`**, créé puis détruit par le banc | 116 | A12 : chacun des 31 indicateurs du registre, sur trois portées (national, région 1, région 2), est égal à sa requête de contrôle **et** à une valeur attendue calculée à la main (longueurs par intégrale du méridien WGS84) ; refus d'un indicateur non ventilé à un compte régional (A10) ; région vide ; échéances de patrouille à deux dates ; recoupement avec `longueurReseau` et `couvertureReseau` ; contre-épreuve ; Control Tower ; volets de la fiche 360 |

Soit **122 vérifications**, toutes passantes le 22/10/2026 (`bash tests-integration/run.sh`, code 0).

## Limites

- Ils tournent sur une base **vide** : aucune mesure de performance ni de comportement sur le volume
  de production (261 387 tronçons au registre complet).
- Les jeux de données sont des fixtures écrites pour le banc, pas des données réelles.
- Les bancs `deviation`, `graphe`, `info-route`, `patrouilles`, `teledetection` et `veille` existaient
  d'abord comme scripts qui imprimaient des valeurs sans rien affirmer ; leurs vérifications ont été
  écrites le 22/10/2026 à partir de ce qu'ils imprimaient **et de calculs indépendants** quand c'était
  possible (oracles SQL pour `deviation`, `graphe`). Les autres reposent sur des invariants lus dans le
  code : elles caractérisent le comportement actuel, elles ne prouvent pas qu'il est le bon au sens métier.
- Une vérification vraie prouve que le code fait ce que le banc attend, pas que le banc attend la bonne
  chose.

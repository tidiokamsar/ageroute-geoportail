# Bancs d'integration PostGIS

Ces bancs exercent le code **contre une vraie base PostgreSQL/PostGIS**, là où les tests Vitest
simulent la base. Ils sont la preuve derrière les mentions « vérifié contre PostGIS réel » de
`REQUIREMENTS_TRACEABILITY.md` et de `AUTONOMOUS_EXECUTION_TRACKER.md`.

Ils ne sont **pas lancés par la CI** (la CI n'a pas de base PostGIS pour ces bancs) et ne sont pas
vérifiés par `tsc` (hors de `src/`). Ils ne font pas partie de `npm test`.

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

ou un seul banc : `npx tsx tests-integration/trace.integration.ts`.

## Ce que chaque banc affirme, et ce qu'il n'affirme pas

| Banc | Travaille dans | Verdict automatique | Couvre |
|---|---|---|---|
| `trace` | transaction annulée | **oui** (code de sortie 1 si une vérification échoue) | analyse d'une trace contre un réseau réel, leurre parallèle, graphe branché |
| `metadonnees` | transaction annulée, fuseau de session NZ | **oui** | étendue et date de révision des métadonnées ISO 19115 |
| `geometries-invalides` | transaction annulée | **oui** | compte exact des géométries invalides |
| `curseur` | **clone `essai_curseur`**, créé puis détruit par le banc | **oui** (41 vérifications) | curseur temporel à deux axes, requalification, découpe, fusion |
| `deviation` | transaction annulée | **non** : imprime des valeurs | déviation routée |
| `graphe` | transaction annulée | **non** : imprime des valeurs (une valeur « attendue » est affichée à côté) | graphe chargé depuis la base |
| `info-route` | transaction annulée | **non** | Info Route et bulletin |
| `patrouilles` | transaction annulée | **non** | programmes, missions, vérification de signalement |
| `teledetection` | transaction annulée | **non** | produits, propositions, précision |
| `veille` | transaction annulée | **non** | astreintes, escalades, tableau de veille |

Pour un banc sans verdict, **un code de sortie 0 veut dire « exécuté sans exception », pas
« vérifié »** : il faut lire la sortie. Les transformer en bancs à verdict (valeurs attendues en
code, exit 1 à l'écart) est du travail restant, consigné au suivi.

## Ce que ces bancs ne prouvent pas

- Ils tournent sur une base **vide** : aucune mesure de performance ni de comportement sur le volume
  de production (261 387 tronçons au registre complet).
- Les jeux de données sont des fixtures écrites pour le banc, pas des données réelles.
- Seuls `trace`, `metadonnees`, `geometries-invalides` et `curseur` ont été rejoués le 22/10/2026 depuis
  leur emplacement versionné ; les six autres ont été relancés sans erreur le même jour, sans verdict.

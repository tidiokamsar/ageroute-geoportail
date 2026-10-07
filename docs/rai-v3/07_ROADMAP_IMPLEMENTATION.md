# Feuille de route

Phase 0. L'ordre proposé ici s'écarte de celui du master prompt sur un point, et la
raison est mesurée.

## État des phases du master prompt

| Phase | État |
|---|---|
| 0 Audit | **ce document** |
| 1 Road Registry | `Troncon` existe, 261 387 lignes. PK exploitables sur **33 %** du réseau classé |
| 2 PostGIS, référencement linéaire | moteur écrit, mesuré, exposé |
| 3 Mobile | rien. Dépôt séparé |
| 4 Offline et sync | protocole complet côté serveur, 4 routes, idempotence et conflits testés |
| 5 Observations et défauts | `Observation` au schéma. **`Defect` absent. Validation absente** |
| 6 Condition Engine | rien |
| 7 Risk Engine | rien |
| 8 Treatment Engine | rien |
| 9 Quantity Engine | rien |
| 10 Cost Engine | rien |
| 11 Program Engine | rien |
| 12 Control Tower | tableau de bord v1 existant, à étendre |
| 13 DigitalRoad | carte embarquée et API publique en service |
| 14 IA | rien, et c'est voulu |

## L'écart que je propose

Le master prompt place le Road Registry en phase 1. **Je mettrais la calibration des PK
avant tout le reste**, et ce n'est pas un choix d'architecture.

Mesure : 551 tronçons sur 1 691 portent un intervalle PK exploitable, soit 33 %. Zéro
sur les 1 029 routes régionales. Or un défaut se localise par un PK de début et un PK
de fin, une quantité se calcule sur `PKfin - PKdébut`, et un coût découle de la
quantité. Les phases 5 à 10 reposent donc toutes sur une référence linéaire qui
n'existe pas sur deux tiers du réseau.

Construire un Cost Engine au-dessus de cela produirait des devis sur un linéaire
inconnu. Et c'est un chantier de donnée, pas de code : aucune ligne de TypeScript ne
le règle.

## Ordre proposé

**1. Validation des observations.** `/observations/{id}/validate`. Le point 13 pose
qu'une observation est une proposition jusqu'à validation. Le système sait produire,
remonter et arbitrer les conflits ; il ne sait pas valider. Tout ce qui remonte du
terrain reste donc au statut `PROPOSEE` et n'alimente rien. Une semaine.

**2. Calibration des PK.** Dériver les PK des 1 029 régionales depuis leur géométrie,
comme **propositions à valider** et jamais comme vérité, conformément au point 14. Sans
elle, les phases 5 à 10 travaillent dans le vide.

**3. Défauts.** `Defect`, avec PK début et fin, gravité, dimensions, photo, confiance.
Les défauts continus doivent être portés dès le modèle : les ajouter après coup
obligerait à migrer des données terrain déjà collectées.

**4. Condition Engine.** RCI versionné, coefficients **en base et non dans React**,
comme l'exige le point 18. Chaque calcul enregistre son score, sa version, ses
composantes et sa confiance.

**5 à 7. Traitement, quantités, coûts.** Dans cet ordre, chacun s'appuyant sur le
précédent. Les formules et les prix sont des données, pas du code.

**8. Programmation.** « J'ai 100 milliards GNF, que traiter ? » n'a de sens qu'une fois
les coûts calculables.

**9. Control Tower.** Il affiche ce que les moteurs produisent. Le construire avant
donnerait un tableau de bord qui additionne des cases vides.

**10. Mobile.** Le serveur l'attend déjà : appareil, mission, trace, observation,
synchronisation, appariement. Un dépôt séparé.

**11. IA.** En dernier, et le master prompt a raison de le dire : « une IA branchée sur
des données incohérentes donnera simplement de mauvaises réponses plus vite ».

## Trois dettes à solder en parallèle

Elles ne dépendent d'aucune phase et leur coût augmente avec le temps.

**La clé de sauvegarde hors serveur.** Risque le plus grave du système, solde en
copiant 65 octets vers deux emplacements désignés.

**La chaîne de migrations qui ne reconstruit pas une base vierge.** Tant qu'elle échoue
à `20260702140000_decomptes`, aucun environnement de recette propre n'est possible, et
toute migration future se teste contre une copie de production.

**Le déploiement par Git.** Trois builds cassés en une journée, tous dus au déploiement
fichier par fichier sur un serveur qui n'est pas un dépôt.

## Ce que je ne recommande pas

**Exécuter `INTEGRATION.md` du pack V3.** Son étape 2 crée 27 tables préfixées `rai_`,
dont onze redoublent des entités en service — `rai_roads` à côté de 261 387 tronçons,
`rai_audit_events` à côté de 1 484 lignes d'audit. Le master prompt l'interdit
lui-même. Voir `02_MATRICE_SCHEMA.md`.

**Ouvrir `/roads`, `/segments` et `/assets` en v2** avant d'avoir tranché le sort de
`Road` et `RoadAsset`. Ce serait deux API pour la même donnée.

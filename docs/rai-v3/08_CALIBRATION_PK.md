# Calibration des PK : pourquoi elle ne peut pas se faire en interne

Mesure du 07/10/2026. Ce document corrige la recommandation que je formulais au point 2
de `07_ROADMAP_IMPLEMENTATION.md`. Elle reposait sur un diagnostic incomplet.

## Ce que je croyais

« 551 tronçons sur 1 691 portent des PK exploitables, zéro sur les 1 029 régionales.
Dériver les PK des régionales depuis leur géométrie, comme propositions à valider. »

Le constat était juste, le remède ne l'est pas.

## Ce que la convention PK est réellement

Les PK existants ne comptent ni par route ni par tronçon : ils **s'enchaînent par
section**, identifiée par le code.

```
GN N000110        1,75 → 3,69      (1,94 km de tracé)
GN N000110-1263   3,69 → 25,09     (21,31 km)

GN N0001 1        5,80 → 15,23     (9,42 km)
GN N0001 1-1055  15,23 → 17,84     (2,60 km)
```

Le suffixe `-nnnn` désigne un sous-segment qui reprend le PK là où le précédent
s'arrête. Les 552 tronçons calibrés collent à leur géométrie **à 30 m près en moyenne,
100 m au pire** : la convention est géométrique et elle est tenue.

## Ce qui bloque, et qui n'est pas le PK

| Classe | Tronçons | Noms distincts | Nom = code | Sections |
|---|---|---|---|---|
| RN | 621 | **42** | 0 | 105 |
| RR | **1 029** | **1 029** | **1 028** | — |
| RU | 41 | 21 | 0 | — |

Les 621 nationales se regroupent en 42 routes réelles et 105 sections. Les 1 029
régionales se regroupent en **1 029 routes d'une seule pièce**, chacune nommée d'après
son propre code `RES-nnnn`.

**Il n'existe pas de réseau régional dans cette base.** Il existe 1 029 segments
anonymes dont la géométrie est connue et dont l'appartenance à une route ne l'est pas.

## Pourquoi je n'écris rien

Dériver `0 → longueur` sur chaque segment produirait un PK :

- cohérent avec sa géométrie, donc techniquement irréprochable ;
- utilisable pour situer un point **sur un segment connu** ;
- et **dépourvu de sens au niveau de la route**, puisque mille vingt-neuf segments
  commenceraient tous au PK 0.

« RR, PK 5+000 » désignerait alors un millier d'endroits différents. Or la promesse de
l'application de terrain est « RN4, PK 188+420 » : une référence qu'on peut dicter par
radio et retrouver sur le terrain. Un PK relatif au segment ne la tient pas, et
l'appeler PK le ferait croire.

C'est exactement ce que le point 14 du master prompt interdit : « ne jamais présenter
une donnée déduite comme une donnée officielle ».

## Ce qu'il faut, et d'où cela vient

Une seule information manque, et elle n'est pas dans la base :

> Quels segments `RES-nnnn` composent quelle route régionale, et dans quel ordre.

Elle existe nécessairement à AGEROUTE, sous forme d'un répertoire du réseau classé ou
des arrêtés de classement. Avec elle, la calibration devient mécanique : grouper,
ordonner, cumuler les longueurs, écrire les PK comme valeurs dérivées traçées. Sans
elle, aucune quantité de code ne la fabrique.

## Ce que je propose en attendant

**Ne pas bloquer la chaîne.** Les 621 nationales et 41 urbaines portent déjà de quoi
travailler : 552 tronçons calibrés, 42 routes, 105 sections. C'est le réseau
structurant, celui que les missions parcourent en premier.

Le moteur d'appariement rend déjà `pk: null` avec le motif `TRONCON_SANS_PK` sur les
régionales, et c'est la bonne réponse. Les phases suivantes — défauts, état,
traitement, quantité, coût — peuvent se construire et se valider sur les nationales,
puis s'étendre aux régionales le jour où leur répertoire arrive.

**Une quantité reste calculable sans PK de route.** `longueur × largeur` ne demande que
la géométrie, dont on dispose sur 100 % du réseau. Seule la localisation *dictée* d'un
défaut exige le PK, pas son métré.

## Décision demandée

Obtenir le répertoire des routes régionales — quels segments, quel ordre — ou acter que
la chaîne de décision se construit d'abord sur le réseau national.

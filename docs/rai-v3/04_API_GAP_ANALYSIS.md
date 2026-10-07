# Écart d'API : OpenAPI RAI V3 contre `/api/v2` existante

Phase 0. Les 24 chemins du fichier `openapi/ageroute-rai-v3.yaml` confrontés à ce qui
répond réellement en production au 07/10/2026.

## État au moment de l'audit

```
chemins declares par le pack V3 : 24
domaines montes sous /api/v2    : 4   (geo, sync, devices, missions)
```

| Chemin V3 | État | Remarque |
|---|---|---|
| `/health` | **existe** | sous `/api/health`, avec sondes base et stockage |
| `/geo/match` | **existe** | mesuré : 19 ms par point sur emprise bornée |
| `/geo/match/batch` | **existe** | plafonné à 200 points |
| `/sync/push` | **existe** | idempotent, conflits conservés |
| `/sync/pull` | **existe** | filigrane sur la dernière ligne, pas l'heure serveur |
| `/missions` | **existe** | avec contrôle de périmètre |
| `/missions/{id}` | **existe** | périmètre appliqué aussi à l'accès direct |
| `/missions/{id}/tracks` | manque | `Trace` est au schéma, la route non |
| `/observations` | manque | créées par `sync/push`, pas encore par API directe |
| `/observations/{id}` | manque | |
| `/observations/{id}/validate` | **manque, et c'est le plus important** | voir ci-dessous |
| `/roads`, `/roads/{id}`, `/roads/{id}/segments` | manque | `Troncon` existe et est servi par `/api/troncons` v1 |
| `/segments/{id}` | manque | idem |
| `/assets` | manque | `Ouvrage` servi par `/api/ouvrages` v1 |
| `/segments/{id}/condition` | manque | aucun moteur d'état |
| `/segments/{id}/condition/recalculate` | manque | idem |
| `/treatments/recommend` | manque | aucun catalogue |
| `/cost-estimates`, `/cost-estimates/{id}` | manque | aucun moteur de coût |
| `/cost-scenarios/optimize` | manque | idem |
| `/maintenance-programs`, `…/validate` | manque | aucune programmation |

Soit **7 chemins sur 24**, et les dix-sept absents se répartissent en deux familles très
différentes.

## Famille 1 : déjà servi par la V1, à migrer

`/roads`, `/segments`, `/assets` décrivent ce que `/api/troncons` et `/api/ouvrages`
servent depuis le premier jour, à 261 387 et 1 172 lignes. Ce ne sont pas des manques,
ce sont des doublons en attente. Les ouvrir en v2 avant d'avoir décidé du sort des
modèles `Road` et `RoadAsset` créerait deux API pour la même donnée.

**Rien à faire tant que la matrice de schéma n'est pas tranchée.**

## Famille 2 : la chaîne de décision, entièrement absente

```
condition  →  treatment  →  quantity  →  cost  →  program
```

Dix chemins, aucun équivalent nulle part. C'est ce qui permettrait de répondre aux
questions 6 et 7 du master prompt — combien cela coûte, que devons-nous faire — et le
système en est aujourd'hui incapable.

## Le manque le plus coûteux n'est pas dans cette liste

`/observations/{id}/validate`.

Le point 13 du master prompt pose la règle fondamentale : une observation est une
PROPOSITION, elle ne devient officielle qu'après validation. Le dépôt sait désormais
produire des observations, les remonter du terrain sans doublon et conserver les
conflits. Il ne sait pas les **valider**.

Tant que cette route n'existe pas, tout ce qui remonte du terrain reste au statut
`PROPOSEE` et n'alimente rien. La chaîne entière s'arrête là, et aucun des dix chemins
de la famille 2 ne servira à quoi que ce soit avant qu'elle soit ouverte.

C'est donc le prochain incrément, avant tout moteur.

## Ce que le pack V3 ne spécifie pas et qu'il faudra décider

**La pagination.** Le point 29 l'exige « lorsque nécessaire » sans dire où. Sur
`/roads` à 261 387 lignes, elle n'est pas optionnelle.

**Les rôles.** Le point 30 interdit qu'un utilisateur « valide sa propre opération
sensible si séparation de rôle requise ». Le système connaît quatre rôles, le cahier
des charges V2 en décrivait neuf. La séparation demandée n'est donc pas exprimable
aujourd'hui : il manque un modèle de portée, pas des valeurs d'énumération.

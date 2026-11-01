# Écart d'API : OpenAPI RAI V3 contre `/api/v2` existante

Phase 0. Les 24 chemins du fichier `openapi/ageroute-rai-v3.yaml` confrontés à ce qui
répond réellement en production au 07/10/2026.

Le fichier OpenAPI cité n'est pas présent dans le checkout courant. Le décompte et le
tableau qui suivent sont conservés comme compte-rendu historique du 07/10 ; ils ne
peuvent pas être revalidés contre cette source avant qu'elle soit fournie.

Le tableau ci-dessous est un **instantané historique de production au 07/10**. La mise
à jour du code local au 12/10 est séparée en fin de document ; elle ne prouve pas un
déploiement ni l'état de la base de production.

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

Constat historique au 07/10 : les dix chemins concernés n'avaient aucun équivalent
identifié. Le code local décrit plus bas ne couvre toujours pas ces moteurs ; ce constat
n'a pas été vérifié en production depuis l'audit.

## Le manque le plus coûteux au moment de l'audit de production du 07/10

`/observations/{id}/validate`.

Le point 13 du master prompt pose la règle fondamentale : une observation est une
PROPOSITION, elle ne devient officielle qu'après validation. Le dépôt sait désormais
produire des observations, les remonter du terrain sans doublon et conserver les
conflits. Au moment de cet audit, la route de validation n'était pas présente dans le
code observé en production. Le code local a depuis ajouté une route de décision ; cette
évolution locale ne modifie pas le constat historique et ne prouve pas un déploiement.

À la date de l'audit, tout ce qui remontait du terrain restait au statut `PROPOSEE`.
Ce constat décrit la production au 07/10 ; il ne décrit pas le code local au 12/10.

La validation était alors l'incrément prioritaire. Elle a depuis été ajoutée localement ;
elle reste à vérifier sur base de recette, appareil réel et production.

## Mise à jour du dépôt local — 12/10/2026

Le code local a depuis ajouté et testé au niveau du dépôt, sur la branche
`ageroute-road-socle` et le HEAD de base `365eba7` (arbre de travail modifié) :

- `/api/v2/observations`, `/api/v2/observations/{id}` et
  `/api/v2/observations/{id}/validate` ; les décisions écrivent dans `Validation` et
  sont protégées par comparaison de version ;
- `/api/v2/defauts` pour la saisie, la consultation, la décision, la resoumission et
  l'état physique du défaut ;
- `/api/v2/defauts/catalogue` pour le formulaire, ainsi que les opérations gestionnaires
  de création, modification versionnée et désactivation du catalogue ;
- `/api/v2/sync/pull` pour observations et défauts et `/api/v2/sync/push` avec contrôle
  du propriétaire de l'appareil.
- Le push d'observations applique une liste de champs autorisés, le contrôle de mission,
  le propriétaire et le statut avant écriture ; les mises à jour et arbitrages locaux
  utilisent un compare-et-échange sur la version.
- Les transitions d'état des défauts vérifient le périmètre auteur/mission, avancent la
  version et enregistrent l'audit dans la même transaction.
- L'accès aux photos de défauts respecte le périmètre auteur/mission ; l'ajout et le
  retrait d'une photo d'inspection vérifient aussi l'inspecteur propriétaire.
- La création d'un défaut accepte encore l'absence de `missionId` et `observationId`,
  alors que le tableau du cahier §7.1 les exige. La conformité de ce point reste ouverte.
- Le cahier §25 décrit `POST /defects/{id}/validate`; l'API locale expose
  `POST /api/v2/defauts/{id}/decision`. Aucun alias de compatibilité ni mapping OpenAPI
  n'est encore publié.

L'interface locale comprend la saisie hors ligne des défauts avec photos, une file de
validation pour les gestionnaires, l'affichage des preuves, l'appariement proposé depuis
la revue et l'administration du catalogue. Le parcours PWA sur appareil réel et le
déploiement ne sont pas vérifiés. Les phases Condition, Risk, Treatment, Cost et Program
restent absentes.

Le téléversement reste limité à 8 Mio par fichier ; aucun quota cumulé par compte ni
limiteur dédié aux photos n'a été ajouté. La politique de capacité et de conservation
des médias est à fixer avant un déploiement terrain à grande échelle. Les brouillons
hors ligne ne sont pas chiffrés au repos dans le navigateur.

La passe complète antérieure aux dernières modifications de continuité a rapporté
backend `npm test` (51 fichiers, 609 tests), frontend `npm test -- --minWorkers=1
--maxWorkers=1` (16 fichiers, 187 tests), typechecks et builds backend/frontend réussis.
Sur la dernière tranche, les tests ciblés ont passé : 41 tests backend et 16 tests
frontend. Les typechecks backend et frontend passent après correction du mock de test.
Le build frontend a été relancé hors sandbox après une erreur Windows `EPERM` dans le
bac à sable ; son résultat final est consigné dans le rapport de continuité.
`prisma validate` et `prisma generate` avaient réussi avec une URL de base factice ;
aucune base n'a été contactée. `npm run typecheck:scripts` reste en échec dans des scripts
hors application : export de provenance manquant, valeur d'enum incompatible et options
`timeout` sur trois transactions Prisma par lot.

Ces résultats prouvent le code et les tests locaux seulement. Ils ne prouvent ni le
rejeu des migrations, ni le fonctionnement sur appareil réel, ni une exécution CI ou un
déploiement en production.

## Ce que le pack V3 ne spécifie pas et qu'il faudra décider

**La pagination.** Le point 29 l'exige « lorsque nécessaire » sans dire où. Sur
`/roads` à 261 387 lignes, elle n'est pas optionnelle.

**Les rôles.** Le point 30 interdit qu'un utilisateur « valide sa propre opération
sensible si séparation de rôle requise ». Le système connaît quatre rôles, le cahier
des charges V2 en décrivait neuf. La séparation demandée n'est donc pas exprimable
aujourd'hui : il manque un modèle de portée, pas des valeurs d'énumération.

**Le mapping des profils V3.1.** Le cahier §5 décrit onze profils métier ; l'application
a quatre rôles techniques. Ces nombres ne prouvent pas une correspondance un-à-un.
Aucun mapping approuvé profil → rôle/permission n'est retrouvé dans le dépôt. La décision
locale qui limite la validation à `ADMIN` et `GESTIONNAIRE` doit être revue avec les
responsables métier avant d'affirmer que les onze profils sont couverts.

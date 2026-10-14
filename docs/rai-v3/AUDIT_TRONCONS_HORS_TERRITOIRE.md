# Audit des tronçons hors territoire

Mesuré le 13/10/2026 contre la base de production, en lecture seule. Livrable demandé par
l'addendum V4.1. Aucune géométrie n'a été modifiée, aucun tronçon supprimé, aucune
`sourceReference` écrite.

## 1. Le chiffre, et le seul qui compte

**6 573 tronçons sur 261 387 ne rencontrent aucune limite administrative guinéenne.** Mais
ce nombre, seul, est trompeur :

| Périmètre | Tronçons | Km | Effet sur les statistiques officielles |
|---|---|---|---|
| `voirie_locale:` — voies reprises d'OpenStreetMap | **6 566** | 5 967,8 | **aucun**, déjà hors réseau classé |
| **aucune `sourceReference`** | **7** | **72,0** | **comptés dans les 21 157 km publiés** |

Le réseau classé mesure **21 156,6 km**, le registre complet **185 264,4 km**. L'écart tient
aux 259 696 voies locales importées, qui sont au registre sans être du réseau classé.

**Le problème réel pèse donc 72,0 km, soit 0,340 % du réseau classé**, et non 6 039,9 km
comme le laisserait croire un décompte sur le registre entier.

> J'ai d'abord annoncé « 3,26 % du réseau » en divisant 6 039,9 par 185 264,4. C'était mêler
> deux périmètres : le registre complet au numérateur du dénominateur, et le réseau classé
> dans l'esprit du lecteur. `backend/src/lib/reseau.ts` distingue explicitement les trois
> périmètres `reference`, `voirie` et `tout` ; l'ignorer rendait le pourcentage inutilisable.

## 2. Le défaut a été trouvé le 07/10/2026, et il n'a jamais été corrigé

`backend/src/lib/reseau.ts` déclare un préfixe `hors_territoire:` exclu du réseau classé, et
son commentaire porte la mesure d'origine :

> « 7 tronçons, 72,0 km, dont 6 nommés RN4 vers Gabou et un RN1 au nord de la frontière. Leur
> `sourceReference` était nul, donc rien ne les distinguait de la donnée validée, et leurs
> 72 km entraient dans les 21 157 publiés sur la carte publique. »

**Mesure du 13/10/2026 : `sourceReference LIKE 'hors_territoire:%'` renvoie 0 ligne.**

Le mécanisme d'exclusion existe dans le code. Il n'a jamais été appliqué aux données. Les
7 tronçons portent toujours `sourceReference` nul, et leurs 72 km entrent toujours dans le
chiffre publié — six jours après le constat.

C'est le genre de dette qui ne se voit pas : le code *paraît* traiter le cas, la revue
*paraît* passer, et seule une requête sur la base montre que le prédicat n'a rien à filtrer.

## 3. Les 7 tronçons, nommés

| Code | Km géométriques | Distance au territoire | Centroïde | Région la plus proche |
|---|---|---|---|---|
| `RN4-OSM-5` | 15,314 | **4 282 m** | 11,5625 / -14,6247 | Boké |
| `RN4-OSM-6` | 0,778 | 4 160 m | 11,5368 / -14,5617 | Boké |
| `RN4-OSM-7` | **24,376** | 2 470 m | 11,5665 / -14,4614 | Boké |
| `RN4-OSM-1` | 1,050 | 2 394 m | 11,6118 / -14,3516 | Boké |
| `RN4-OSM-2` | 5,003 | 1 361 m | 11,6275 / -14,3295 | Boké |
| `RN1-OSM-26` | 12,972 | 1 026 m | 12,4005 / -13,7112 | Boké |
| `RN4-OSM-3` | 12,545 | **224 m** | 11,6753 / -14,2653 | Boké |

Les six RN4 se situent dans le corridor de Koundara vers **Gabú, en Guinée-Bissau**. La RN1
est plus au nord, vers le Sénégal. Ce sont des **routes nationales**, pas des rebuts
d'import : leur `longueurKm` déclarée égale leur longueur géométrique à moins de 4 m près.

**La fourchette de distance interdit une règle unique.** À 224 m, l'imprécision de la limite
administrative suffit à tout expliquer. À 4 282 m, non : ce tronçon est très probablement en
territoire étranger. Un seuil unique trancherait donc mal dans les deux sens.

## 4. Aucun tronçon n'est perdu au large

C'est le résultat rassurant de cet audit, et il écarte l'hypothèse d'une corruption de
géométrie :

| Bande de distance | Tronçons | Km cumulés |
|---|---|---|
| moins de 100 m | 359 | 262,1 |
| 100 m à 1 km | 2 320 | 2 267,3 |
| 1 à 10 km | 3 886 | 3 506,4 |
| 10 à 100 km | 8 | 4,1 |
| au-delà de 100 km | **0** | — |

**Le tronçon le plus éloigné du réseau entier est à 10,56 km** — un sentier de 466 m. Aucune
géométrie en pleine mer, aucune au centre du Mali, aucun décalage de projection. Les
6 573 tronçons longent la frontière.

Ce n'est donc pas un problème de qualité de donnée. **C'est une question de périmètre** : où
le réseau guinéen s'arrête-t-il, quand la limite administrative disponible a une précision de
l'ordre du kilomètre ?

## 5. Ce qui ne doit pas être fait, et pourquoi

L'addendum V4.1 l'écrit : « Ne supprime pas automatiquement ces tronçons et ne modifie pas
leurs géométries pour les faire rentrer artificiellement dans le territoire. » Trois raisons
tiennent indépendamment de la consigne :

**Supprimer effacerait de la donnée juste.** Une route nationale qui franchit la frontière est
une réalité de terrain, pas une erreur de saisie. La RN4 va vers Gabú parce que la route va
vers Gabú.

**Déplacer la géométrie serait pire.** Faire rentrer un tronçon dans le polygone en le
translatant fabriquerait une route qui n'existe pas, et la fabrication serait invisible après
coup. Le cahier des charges l'interdit déjà pour les géométries de référence.

**Et le polygone n'est pas une vérité.** `limites_admin` niveau 1 porte 10 régions et
7 899 sommets au total après union, soit une précision kilométrique. Traiter ses bords comme
exacts à 224 m près, c'est lui prêter une autorité qu'il n'a pas.

## 6. La décision qui revient à AGEROUTE

Votre règle du 13/10/2026 : « Conserver les données, classifier les anomalies et exclure des
statistiques officielles uniquement selon une règle de périmètre validée. » Les données sont
conservées et classifiées. Reste la règle de périmètre, qui est un arbitrage et pas un calcul.

Trois options, avec leur conséquence chiffrée :

| Option | Effet sur le réseau classé | Ce qu'elle suppose |
|---|---|---|
| **Ne rien exclure** | 21 156,6 km inchangés | 72 km de route étrangère comptés comme guinéens |
| **Exclure les 7** | 21 084,6 km, soit **-0,340 %** | 72 km de RN4 et RN1 réels retirés du réseau national |
| **Exclure au-delà d'un seuil** | selon le seuil | à 500 m : 6 tronçons, 59,5 km (-0,281 %) ; à 2 km : 4 tronçons, 41,5 km (-0,196 %) |

L'instrument existe déjà et n'a besoin d'aucun développement : marquer la `sourceReference`
avec le préfixe `hors_territoire:`, que `clauseSqlReseauClasse()` exclut automatiquement.
L'écriture est auditée, réversible, et ne touche ni la géométrie ni la ligne.

**Je ne l'ai pas appliqué.** Marquer un tronçon de RN4 comme hors réseau national est une
décision de périmètre sur le patrimoine routier, et elle change un chiffre publié.

## 7. Méthode, et ce qu'elle a coûté

Le territoire est l'union des 10 polygones de `limites_admin` niveau 1, découpée par
`ST_Subdivide(..., 64)` en 256 morceaux. Un tronçon est « hors territoire » quand
`ST_Intersects` est faux contre les 256 morceaux, donc quand il ne touche le territoire par
aucun point.

**Le découpage n'est pas une optimisation accessoire, c'est ce qui rend la mesure possible.**
L'index GiST de `troncons` porte sur `(geom)::geography`. L'union du pays en un seul morceau a
une boîte englobante qui couvre tout le territoire : l'index ne filtre alors rien et la
requête dégénère en balayage de 261 387 lignes. Découpée, chaque boîte est petite et le
filtrage redevient sélectif — Conakry seule se mesure en 2,2 s.

> **Première tentative échouée, et c'est la deuxième fois.** La distance au territoire était
> calculée comme `min(ST_Distance)` sur les 256 morceaux pour chacun des 6 573 tronçons, soit
> 1,68 million de distances géodésiques. À 9 min 55 s elle n'avait pas abouti et je l'ai
> annulée. C'était la même faute que le matin du 13/10 : une distance par ligne contre tout le
> réseau. La correction tient en un parcours KNN indexé (`<->`, planaire, très bon marché) qui
> ramène les cinq morceaux les plus proches, la distance géodésique exacte n'étant calculée
> que sur ceux-là — 32 865 calculs au lieu de 1,68 million. Cinq et non un, parce que le plus
> proche en planaire n'est pas forcément le plus proche en géodésique.

Un `statement_timeout` bornait chaque passage, et toutes les tables de travail étaient
temporaires : la session fermée, il ne reste rien en base.

## 8. Écarts avec les chiffres annoncés précédemment

| Source | Chiffre | Mesure du 13/10 |
|---|---|---|
| Addendum V4.1 | 6 565 tronçons | **6 573** |
| Mon estimation antérieure | 6 572 | **6 573** |
| Part du réseau, annoncée par moi | 3,26 % | **0,340 %** du réseau classé |

Les trois décomptes de tronçons concordent à huit unités près, ce qui est cohérent avec des
mesures prises à des dates différentes sur une base vivante. En revanche, la part du réseau
était fausse d'un facteur dix, pour avoir divisé par le mauvais périmètre.

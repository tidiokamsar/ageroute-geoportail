# Référentiel provisoire des axes régionaux

Mesuré le 14/10/2026 contre la production, en lecture seule. Livrable de votre décision du
13/10 : « Créer un référentiel provisoire des axes… Ne pas inventer les longueurs. »

**Ce document ne nomme aucun axe et n'écrit aucun PK.** Il mesure ce que la géométrie impose,
ce qui contraint les axes possibles sans les décider.

## 1. Pourquoi ce n'est pas un référentiel d'axes, et ne peut pas l'être

`08_CALIBRATION_PK.md` l'établit déjà : il n'existe pas de réseau régional dans cette base. Il
existe **1 029 segments** dont la géométrie est connue et dont l'appartenance à une route ne
l'est pas. 1 029 noms distincts, dont **1 028 identiques au code** du segment.

L'information manquante tient en une phrase, et elle n'est pas dans la base :

> Quels segments `RES-nnnn` composent quelle route régionale, et dans quel ordre.

Elle existe à AGEROUTE, dans le répertoire du réseau classé ou les arrêtés de classement.
Nommer des axes sans elle serait présenter une déduction comme une donnée officielle, ce que
le point 14 du prompt maître interdit.

**Ce que je peux mesurer sans rien inventer** : quels segments se touchent. C'est de la
géométrie, pas une interprétation.

## 2. L'inventaire

| Mesure | Valeur |
|---|---|
| Segments de classe `RR` | **1 029** |
| Linéaire total | **13 295,6 km** |
| Noms distincts | 1 029 |
| Dont le nom est le code | **1 028** |
| Segment le plus court | **104 m** |
| Segment le plus long | **76,54 km** |

| Région | Segments | Km |
|---|---|---|
| Labé | 233 | 2 320,8 |
| Kankan | 175 | 2 603,1 |
| Nzérékoré | 165 | 1 646,7 |
| Kindia | 115 | 1 575,5 |
| Faranah | 97 | 1 389,3 |
| Mamou | 94 | 1 036,8 |
| Boké | 89 | 1 352,9 |
| Siguiri | 36 | 839,9 |
| Beyla | 24 | 530,0 |
| Conakry | 1 | 0,6 |

## 3. La topologie est propre, et ce n'est pas un détail

Les extrémités des segments **coïncident au mètre près**. Mesuré à quatre tolérances :

| Tolérance | Paires adjacentes | Composantes connexes | Segments isolés |
|---|---|---|---|
| 1 m | 1 287 | **186** | 81 |
| 10 m | 1 287 | **186** | 81 |
| 50 m | 1 287 | **186** | 81 |
| 200 m | 1 313 | 180 | 81 |

**Le résultat est identique de 1 m à 50 m.** Le regroupement ne dépend donc pas d'un seuil que
j'aurais choisi : les segments ont été découpés depuis un réseau connexe, et le découpage a
conservé la topologie. C'est ce qui rend la suite utilisable.

Si le compte avait varié avec la tolérance, il aurait fallu vous faire arbitrer le seuil avant
toute chose. Il n'y a pas lieu.

## 4. Une composante connexe n'est PAS un axe

C'est le point qui empêche de livrer « 186 axes » et d'en rester là.

Une composante est l'ensemble des segments joignables entre eux. Un axe est un **chemin**. Une
composante de 65 segments sur 714 km contient nécessairement des embranchements, et l'appeler
une route serait faux.

Mesure des degrés des nœuds — un nœud étant une extrémité partagée :

| Degré | Nœuds | Lecture |
|---|---|---|
| 1 | 597 | extrémité de réseau |
| 2 | 255 | simple continuité |
| 3 | **269** | carrefour |
| 4 | 32 | carrefour |
| 5 | 2 | carrefour |
| 6 | 1 | carrefour |

**304 carrefours.** En séparant les composantes sans aucun carrefour de celles qui en portent :

| Nature | Composantes | Segments | Km |
|---|---|---|---|
| **Chemin** — axe candidat crédible | **116** | **171** | **2 752,0** |
| **Sous-réseau** — au moins un carrefour | **70** | **858** | **10 543,6** |

**Seuls 171 segments sur 1 029, soit 16,6 %, et 2 752 km sur 13 296, se trouvent dans des
chemins propres.** Les 79 % restants sont dans des sous-réseaux où découper des axes exige de
savoir lesquels, c'est-à-dire exige vos arrêtés.

Et sur les 116 chemins, **81 sont des segments isolés** : il reste **35 chemins de deux
segments ou plus**, qui sont les seuls regroupements que la géométrie autorise à proposer.

## 5. Les 20 plus longs chemins candidats

Ce sont des regroupements que la géométrie soutient, **pas des axes nommés**. À confirmer ou
rejeter par vos arrêtés.

| Segments | Km | Région | Codes |
|---|---|---|---|
| 5 | 132,48 | Faranah | `RES-857` + `RES-858` + `RES-859` + `RES-861` + `RES-862` |
| 5 | 129,01 | Boké | `RES-253` + `RES-255` + `RES-256` + `RES-257` + `RES-258` |
| 5 | 115,12 | Beyla | `RES-774` + `RES-776` + `RES-777` + `RES-779` + `RES-781` |
| 2 | 80,46 | Kindia | `RES-245` + `RES-248` |
| 2 | 68,58 | Faranah | `RES-798` + `RES-805` |
| 3 | 64,46 | Kankan | `RES-758` + `RES-759` + `RES-760` |
| 3 | 59,90 | Faranah | `RES-796` + `RES-806` + `RES-825` |
| 2 | 55,61 | Siguiri | `RES-1003` + `RES-966` |
| 2 | 38,35 | Kindia | `RES-81` + `RES-86` |
| 3 | 36,92 | Faranah | `RES-799` + `RES-800` + `RES-801` |
| 4 | 33,62 | Labé | `RES-476` + `RES-478` + `RES-481` + `RES-484` |
| 2 | 32,90 | Faranah | `RES-874` + `RES-875` |
| 2 | 31,73 | Nzérékoré | `RES-584` + `RES-602` |
| 2 | 31,30 | Faranah | `RES-242` + `RES-243` |
| 3 | 31,11 | Kindia | `RES-115` + `RES-132` + `RES-178` |
| 4 | 30,47 | Labé | `RES-339` + `RES-340` + `RES-341` + `RES-342` |
| 2 | 29,79 | Nzérékoré | `RES-611` + `RES-612` |
| 2 | 28,18 | Kankan | `RES-652` + `RES-761` |
| 2 | 27,91 | Kankan | `RES-908` + `RES-909` |
| 2 | 27,58 | Boké | `RES-61` + `RES-64` |

Les codes sont donnés par ordre alphabétique, **pas dans l'ordre de parcours de l'axe**.
L'ordre géométrique se calcule, mais le sens d'un axe — d'où il part, où il arrive — est une
convention administrative, pas une propriété de la ligne.

Un détail qui montre que la numérotation ne suit pas la géographie : le chemin
`RES-1003 + RES-966` joint un code de la série 1000 à un de la série 900. **Regrouper par
proximité de numéro produirait donc de faux axes**, et c'est une tentation qu'il faut écarter
explicitement.

## 6. Ce qu'il faut de vous, et ce que ça débloque

Une seule chose : **le rattachement de chaque `RES-nnnn` à une route et son rang dans
celle-ci.** Avec elle, la calibration devient mécanique — grouper, ordonner, cumuler les
longueurs géométriques, écrire les PK comme valeurs dérivées et tracées.

Sans elle, trois conséquences qui tiennent déjà :

**Aucun PK régional n'est calculable**, et c'est pourquoi aucun n'est écrit. Dériver
`0 → longueur` sur chaque segment donnerait un millier de routes commençant au PK 0 :
« RR, PK 5+000 » désignerait mille endroits. L'écran de terrain affiche donc « PK non
calculable » plutôt qu'un vide, et c'est délibéré.

**L'abscisse locale contourne le problème pour la qualification**, pas pour la restitution
officielle. Un agent peut relever une portion sur `RES-857` sans PK ; un rapport bailleur ne
peut pas citer un PK régional.

**Les 35 chemins ci-dessus réduisent votre travail de saisie** : si vos arrêtés les
confirment, 171 segments sont déjà groupés et il reste les 858 des sous-réseaux.

## 7. Une vérification que j'ai faite parce que j'en doutais

J'ai utilisé `limites_admin` niveau 1 comme territoire national dans
[AUDIT_TRONCONS_HORS_TERRITOIRE.md](AUDIT_TRONCONS_HORS_TERRITOIRE.md). En voyant **Siguiri**
et **Beyla** figurer parmi ses 10 entrées — qui sont des préfectures, alors que la Guinée
compte 8 régions — j'ai craint que ce niveau ne pave pas le pays, et donc que mon audit ait
compté comme hors territoire des routes situées en Guinée.

Mesuré : l'union du niveau 1 couvre **244 785 km²**, et celle du niveau 2 **exactement
autant**. La Guinée en fait environ 245 857. Le niveau 1 pave donc bien le territoire ; il
découpe simplement Siguiri et Beyla à part des huit régions. **L'audit hors territoire
tient.**

## 8. Ce qui n'a pas été écrit

Aucun axe nommé, aucun PK, aucune longueur déduite, aucun regroupement enregistré en base.
Tout ce qui précède est une mesure rendue dans ce document ; la base est inchangée.

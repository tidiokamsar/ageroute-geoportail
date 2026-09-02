# Évaluation de la source OSM — réseau routier, extraction 2023

**Date d'évaluation** : 1er septembre 2026
**Source** : `A_OSM_RESEAU_ROUTIER`, quatre couches shapefile fournies par AGEROUTE
**Date des données** : 8 mars 2023 (champ `DATE_MAJ` du DBF)
**Producteur déclaré** : `SOURCE = OpenStreetMap` sur 100 % des enregistrements
**Méthode** : lecture directe des en-têtes SHP et DBF, comptage en flux, longueurs calculées par haversine. Aucun import en base.

---

## 1. Ce que contiennent les quatre couches

| Couche | Géométrie | Enregistrements | Champs | Emprise |
|---|---|---:|---:|---|
| `ROUTE` | Polyligne | **262 656** | 15 | toute la Guinée |
| `CHEMIN` | Polyligne | 171 570 | 4 | toute la Guinée |
| `TOPONYME_COMMUNICATION` | Point | 30 | 5 | Conakry et axes |
| `SURFACE_ROUTE` | Polygone | 3 | 4 | Conakry–Kindia |

Toutes en **WGS 84**, soit le même système que la BDRI. Aucune reprojection ne serait
nécessaire.

L'emprise de `ROUTE` — longitude −15,07 à −7,63, latitude 7,17 à 12,74 — couvre la
totalité du territoire guinéen.

### `CHEMIN` est un doublon de `ROUTE`

À ne pas manquer avant tout traitement : les deux couches décrivent les mêmes objets
sous des étiquettes différentes.

| `CHEMIN` | Compte | `ROUTE` | Compte |
|---|---:|---|---:|
| Sentier | 102 100 | Chemin non carrossable | 102 100 |
| Chemin | 69 425 | Chemin carrossable | 69 425 |
| Escalier | 40 | Escaliers | 40 |
| Piste cyclable | 5 | Voie cyclable | 5 |

Les comptes coïncident exactement. **`ROUTE` contient tout** ; additionner les deux
couches doublerait 171 570 objets.

---

## 2. Le réseau OSM, par nature et par longueur

Longueurs calculées sur les 262 656 polylignes.

| Nature | Segments | km | Densité |
|---|---:|---:|---:|
| Route non classifiée | 41 083 | 58 248 | 27,0 pts/km |
| Chemin carrossable | 69 425 | 44 619 | 39,8 |
| Chemin non carrossable | 102 100 | 43 166 | 40,3 |
| **Route tertiaire** | 2 951 | **12 660** | 16,5 |
| Route résidentielle | 34 929 | 10 189 | 30,3 |
| **Voie rapide** | 1 007 | **3 287** | 13,4 |
| **Route secondaire** | 847 | **3 024** | 17,4 |
| **Route primaire** | 589 | **2 519** | 16,8 |
| Route d'accès | 5 806 | 1 182 | 33,8 |
| Voie piétonne | 3 672 | 1 015 | 48,9 |
| autres (11 natures) | 242 | 71 | — |
| **Total** | **262 656** | **179 980** | — |

---

## 3. La corroboration : 21 490 km contre 21 156 km

C'est le résultat le plus important de cette évaluation.

L'audit des tronçons a établi que le réseau BDRI mesure **21 156 km** calculés depuis
la géométrie, et non les 7 933 km affichés. Il portait une réserve explicite : cette
valeur n'avait été comparée à **aucun tracé de référence indépendant**.

Le réseau classé d'OSM — voie rapide, primaire, secondaire, tertiaire, à l'exclusion
des chemins, des routes résidentielles et des non classifiées — totalise :

| Source | Réseau classé | km |
|---|---|---:|
| BDRI | RN + RR + RU, longueur calculée | **21 156** |
| OSM 2023 | voie rapide + primaire + secondaire + tertiaire | **21 490** |
| | **Écart** | **1,6 %** |

Deux jeux de données constitués indépendamment, à trois ans d'intervalle, avec des
nomenclatures différentes, convergent à 1,6 % près.

**Cette conclusion a été corrigée le 2 septembre.** Le recouvrement spatial, mesuré
ensuite (`docs/phase4/OSM-BDRI-COVERAGE-PHASE4.md`), montre que les nationales se
superposent à 90,7 % mais que les régionales ne sont à moins de 250 m d'une route OSM
classée que dans 20,6 % des cas. L'accord des totaux est une coïncidence : deux
ensembles de routes différents, de longueur voisine. Le §14 du cadrage l'avait
anticipé, et je l'ai écrit trop tard. Le chiffre de 21 156 km reste exact comme
longueur de ce que la BDRI contient — il n'est pas corroboré comme « la » longueur du
réseau classé.

### La limite de cette corroboration

Les nomenclatures ne se correspondent pas terme à terme. « Route tertiaire » au sens
OSM n'est pas « route régionale » au sens AGEROUTE, et le choix d'exclure les 58 248 km
de « routes non classifiées » est un choix de ma part, défendable mais discutable.

L'accord porte donc sur **l'ordre de grandeur du réseau classé**, pas sur une
équivalence classe par classe. C'est déjà beaucoup : il exclut que 7 933 km soit le
bon chiffre.

---

## 4. Densité : un gain de huit fois sur les régionales

| Réseau | Densité |
|---|---:|
| BDRI — régionales `RES-*` | **2,1 pts/km** |
| BDRI — nationales | 11,2 à 18,1 pts/km |
| OSM — primaire | 16,8 pts/km |
| OSM — secondaire | 17,4 pts/km |
| OSM — tertiaire | 16,5 pts/km |

Les 1 028 tronçons régionaux de la BDRI sont décrits huit fois plus grossièrement que
le réseau classé d'OSM. Là où les corridors se correspondent, OSM offrirait un tracé
sensiblement plus fin.

**Mais ils ne se correspondent presque jamais** — mesure du 2 septembre : 20,6 % du
linéaire régional BDRI à moins de 250 m d'une route OSM classée, et 240 tronçons
régionaux, 2 358 km, sans aucune correspondance. Le gain de densité n'est accessible
que pour une régionale sur cinq. Ce que j'avais présenté comme la piste la plus
prometteuse est, pour l'essentiel, sans objet.

L'audit avait mesuré que cette grossièreté ne coûte qu'environ 1 % de longueur. Elle
coûte en revanche à l'affichage cartographique et à toute analyse de tracé.

---

## 5. Ce que cette source n'apporte pas

Il faut être aussi net sur les manques que sur les apports, car trois espoirs
raisonnables sont déçus.

### Les noms : 0,4 %

`NOM` paraît rempli à 100 %. Il ne l'est pas : la valeur `NC` — non communiqué —
occupe **261 610 enregistrements sur 262 656**.

| | |
|---|---:|
| Noms réellement renseignés | **1 046 (0,4 %)** |
| Noms distincts | 610 |

Ces 610 noms ont pourtant la forme exacte qui manque à la BDRI : `N'zérékoré-Macenta`,
`Lola - Danané`, `Péla - Diécké`, `Yomou - Nzérékoré`, `N'zérékoré-Kankan` — la même
convention origine-destination que les intitulés de chantiers.

C'est un pont réel, mais étroit. Il ne remplace pas un référentiel toponymique.

### La classification administrative : inexistante

| Champ | Valeurs distinctes | Contenu |
|---|---:|---|
| `CL_ADMIN` | **1** | « Autre » sur les 262 656 |
| `GESTION` | **1** | « NC » sur les 262 656 |

**Cette source ne débloque pas le référentiel administratif du §19.** Elle ne contient
ni région, ni préfecture, ni commune. Le blocage des 299 chantiers à localiser par nom
de lieu reste entier.

### Le revêtement : absent du modèle

Les 15 champs ne comportent **aucun attribut de revêtement ou de matériau**. `NATURE`
est une classification fonctionnelle — primaire, secondaire, chemin carrossable — et
non une nature de chaussée.

**La question `BITUME` reste donc ouverte.** Aucun élément ici ne permet de corriger
les 1 690 tronçons.

### Les numéros de route : partiels

| | |
|---|---:|
| Segments avec un numéro | **1 453 (0,6 %)** |
| Désignations distinctes | 60 |
| Kilomètres numérotés | 5 128 |

Principales désignations : N1 (1 202 km), N2 (712), N6 (402), N5 (323), N30 (296),
N3 (239).

À comparer aux **42 désignations RN et 7 840 km** de la BDRI : le numérotage d'OSM est
moins complet que celui d'AGEROUTE. La BDRI est ici la meilleure source.

Le champ contient par ailleurs des valeurs manifestement erronées — `Route principal
de bardou`, `Routes secondaires`, `D 509` — qui rappellent la nature contributive de
la donnée.

### Les toponymes : 22 ouvrages, pas des lieux

`TOPONYME_COMMUNICATION` ne contient pas de noms de localités. Ses 30 points sont :

| Nature | Points |
|---|---:|
| Pont | 16 |
| Tunnel | 6 |
| Parking | 7 |
| Échangeur | 1 |

Nommés : Pont Kaporo, Pont de Madina, Pont du 8 Novembre, Pont Taouyah, Pont Dixinn
Gare, Pont Oudiala, Pont tougnefili, tunnels Gbangban, Yesafe, Samou, Bankalan.

Avec des doublons — « Pont Kenien », « Pont de Kaka », « Pont du 8 Novembre » et
« Yesafe » apparaissent chacun deux fois — soit environ **16 structures distinctes**.

C'est peu, mais ce sont des ouvrages **nommés**, quand les 126 ouvrages de la BDRI
n'ont ni matériau ni année sur 92 % d'entre eux. Un recoupement a du sens.

`SURFACE_ROUTE` — 3 polygones « Place » datés de 2018 — est négligeable.

---

## 6. La topologie : la piste la plus prometteuse, et la moins vérifiée

La BDRI contient trois graphes disjoints : **zéro jonction** entre nationales,
régionales et urbaines. C'est ce qui interdit tout routage.

OSM est, par construction, un réseau routable : ses 262 656 segments sont saisis pour
être parcourus. Il pourrait donc fournir la connectivité qui manque.

**Je ne l'ai pas vérifié.** Établir que les corridors OSM recouvrent ceux de la BDRI
demande un recouvrement spatial, donc un import en base, que je n'ai pas fait. Le
chiffre de 1,6 % d'écart sur les longueurs est encourageant, il ne prouve pas que les
tracés se superposent.

C'est la mesure à faire ensuite, et elle conditionne tout usage sérieux de cette source.

---

## 7. Ce que cela implique, et la décision qui n'est pas technique

### Trois usages défendables

| Usage | Fondement | Risque |
|---|---|---|
| **Corroborer** la longueur du réseau | écart de 1,6 % sur le réseau classé | nul — aucune écriture |
| **Densifier** la géométrie régionale | 2,1 → ~17 pts/km | modéré — modifie des tracés |
| **Construire** la topologie | réseau routable par nature | modéré — à vérifier d'abord |

### Un usage à écarter

Remplacer le référentiel BDRI par OSM. Le numérotage d'AGEROUTE est plus complet
(42 désignations sur 7 840 km contre 60 sur 5 128 km), les PK de la BDRI sont
renseignés à 100 % et absents d'OSM, et la classification administrative d'OSM est
vide.

**La BDRI reste la meilleure source sur son périmètre.** OSM la complète, il ne la
remplace pas.

### La décision qui revient à AGEROUTE

OpenStreetMap est une donnée contributive, produite par des volontaires. Trois
conséquences à assumer avant tout import :

1. **La gouvernance.** Un référentiel national qui intègre de la donnée contributive
   doit le déclarer. La BDRI porte déjà 70 tronçons codés `*-OSM-*` : la question est
   donc déjà posée dans les faits, sans avoir été tranchée.
2. **La traçabilité.** Toute géométrie venue d'OSM doit rester identifiable comme
   telle, sans quoi elle deviendra indistinguable d'un levé AGEROUTE. C'est
   exactement l'objet du ticket T2.
3. **L'ancienneté.** Ces données datent du 8 mars 2023, soit trois ans avant l'import
   de juin 2026 qui a peuplé la BDRI. Une extraction plus récente serait préférable
   pour tout usage autre que la corroboration.

---

## 8. Effet sur les documents déjà produits

| Document | Modification |
|---|---|
| `TRONCONS-DATA-AUDIT.md` | La réserve du §3 — « pas de comparaison avec un tracé de référence indépendant » — est **levée** par l'écart de 1,6 %. |
| `BDRI-DATA-SOURCE-MATRIX.md` | Une source externe réelle entre dans la matrice, avec sa date et son producteur. |
| `BDRI-REFERENTIEL-NATIONAL.md` | Le lot topologie gagne une piste concrète ; le §19 reste bloqué, cette source n'apportant aucune donnée administrative. |
| `BDRI-2-TICKETS.md` | T1 gagne une corroboration externe. Un ticket de recouvrement spatial s'impose avant T10. |

---

## 9. Reproduire ces mesures

Les scripts de lecture — en Python sans dépendance, GDAL n'étant pas disponible sur le
poste — lisent les en-têtes SHP et DBF et parcourent les enregistrements en flux :

```
shp.py      en-tetes, structure des champs, echantillons
fill.py     taux de remplissage et distributions, en flux
lengths.py  longueurs par haversine, croisement SHP/DBF
```

Le piège principal est le codage du vide : dans ce jeu, un champ non renseigné vaut
`NC` et non une chaîne vide. Un taux de remplissage naïf annonce 100 % sur les quinze
champs, dont trois sont en réalité vides.

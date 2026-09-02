# Recouvrement spatial OSM 2023 / BDRI — Phase 4

**Mesure** : 2 septembre 2026
**Script** : `infra/recouvrement-osm-bdri.sh`, reproductible, conteneur jetable
**Source OSM** : réseau classé — voie rapide, primaire, secondaire, tertiaire — 5 394 polylignes extraites de la couche `ROUTE` du 8 mars 2023
**Méthode** : échantillonnage tous les 100 m le long de chaque tracé ; pour chaque point, existe-t-il un tracé de l'autre réseau à moins de 25, 100 ou 250 m ?
**Aucune écriture en production.**

---

## 1. Pourquoi cette mesure, et ce qu'elle a défait

Le §14 du cadrage disait : *« Ne pas conclure à une équivalence simplement parce que
21 156 km ≈ 21 490 km. La longueur commune ne prouve pas le recouvrement spatial. »*

J'avais pourtant écrit, dans `TRONCONS-DATA-AUDIT.md` et dans le rapport publié, que
cette concordance **levait la réserve** sur la longueur du réseau. C'était aller trop
vite. La mesure ci-dessous montre que les deux réseaux se recouvrent pour les
nationales et **ne se recouvrent pas** pour les régionales. L'accord des totaux tient
à ce que deux ensembles de routes largement différents pèsent à peu près le même
nombre de kilomètres.

Ce document corrige donc une affirmation que j'ai faite et publiée.

---

## 2. Les deux réseaux comparés

| BDRI | Tronçons | km | | OSM classé | Segments | km |
|---|---:|---:|---|---|---:|---:|
| RN | 621 | 7 824 | | Voie rapide | 1 007 | 3 280 |
| RR | 1 029 | 13 296 | | Primaire | 589 | 2 514 |
| RU | 40 | 36 | | Secondaire | 847 | 3 018 |
| | | | | Tertiaire | 2 951 | 12 635 |
| **Total** | **1 690** | **21 156** | | **Total** | **5 394** | **21 447** |

---

## 3. La BDRI est-elle couverte par OSM ?

Part du linéaire BDRI à moins de X mètres d'une route OSM classée.

| Classe BDRI | Points échantillonnés | à 25 m | à 100 m | à 250 m |
|---|---:|---:|---:|---:|
| RN | 139 606 | **90,7 %** | 93,9 % | 94,5 % |
| RU | 797 | **98,7 %** | 99,2 % | 100 % |
| **RR** | 193 670 | **2,5 %** | 8,8 % | **20,6 %** |

**Les nationales et les urbaines se superposent.** À 25 m — une tolérance qui ne
pardonne qu'aux tracés du même axe — 9 tronçons nationaux sur 10 sont couverts. C'est
la meilleure validation externe de la géométrie RN dont on dispose.

**Les régionales ne se superposent pas.** À 250 m, tolérance large qui rattrape les
tracés grossiers à 2,1 points/km, seul un cinquième du linéaire régional a une route
OSM classée à portée. Les 1 029 tronçons `RES-*` décrivent, pour l'essentiel, des
routes qu'OSM ne classe pas comme primaire, secondaire ou tertiaire.

---

## 4. OSM est-il couvert par la BDRI ?

Part du linéaire OSM classé à moins de X mètres d'un tronçon BDRI.

| Nature OSM | Points échantillonnés | à 25 m | à 100 m | à 250 m |
|---|---:|---:|---:|---:|
| Voie rapide | 62 570 | **95,3 %** | 98,3 % | 98,7 % |
| Primaire | 52 471 | **72,2 %** | 75,8 % | 78,7 % |
| Secondaire | 63 897 | 31,3 % | 38,3 % | 46,3 % |
| **Tertiaire** | 260 153 | **10,7 %** | 15,5 % | **23,9 %** |

Le miroir du tableau précédent. La BDRI contient les voies rapides et l'essentiel des
primaires. Elle contient moins de la moitié des secondaires et **un quart des
tertiaires** — les 12 635 km de tertiaires OSM sont, aux trois quarts, absents de la
BDRI.

---

## 5. Ce qui n'a aucune correspondance

Tronçons BDRI sans aucune route OSM classée à moins de 250 m :

| Classe | Tronçons | km |
|---|---:|---:|
| RN | 6 | 80 |
| **RR** | **240** | **2 358** |

Six nationales sans correspondance sur 621 : ce sont des cas à regarder un à un — une
route récente, un tracé OSM manquant, ou une erreur BDRI. Deux cent quarante
régionales, 2 358 km, sans aucune route OSM classée à portée : ce n'est pas une
anomalie, c'est la confirmation que les deux réseaux régionaux sont différents.

---

## 6. Distance entre tracés — une mesure mal posée, à ne pas interpréter

| Classe | Tronçons appariés | Hausdorff médian | moyen | p90 |
|---|---:|---:|---:|---:|
| RN | 615 | 8 827 m | 10 528 m | 20 185 m |
| RR | 789 | 9 185 m | 11 537 m | 23 593 m |
| RU | 40 | 864 m | 886 m | 2 033 m |

**Ces chiffres contredisent en apparence la section 3** — 8,8 km d'écart médian sur
des nationales dont 90,7 % du linéaire est à moins de 25 m d'OSM. La contradiction
vient de la requête, pas de la donnée.

La distance de Hausdorff mesure l'écart **maximal** entre deux géométries entières.
Or je l'ai calculée entre chaque tronçon BDRI et le **seul** segment OSM le plus
proche. Un tronçon national de 12 km est couvert par plusieurs segments OSM courts ;
Hausdorff vers un seul d'entre eux mesure la distance du bout du tronçon à ce court
segment — c'est-à-dire l'écart de **découpage** des deux réseaux, pas l'écart de
**tracé**. Le chiffre est ininterprétable pour la question posée.

La section 3, qui échantillonne point par point et demande pour chacun s'il existe
une route OSM à portée, est la mesure valable. Elle dit que les tracés nationaux
coïncident. Celle-ci ne dit rien de plus, et je ne la reformulerai pas en « écart de
8,8 km entre les tracés » : ce serait rapporter une erreur de méthode comme un fait.

La mesure correcte — Hausdorff vers l'**union** des segments OSM à portée, ou distance
moyenne point à ligne — reste à faire. Elle demande une requête différente, pas un
autre résultat.

Deux contrôles indépendants qui se contredisent doivent faire réexaminer la méthode,
pas se faire moyenner. C'est ce que j'ai fait ici, et le premier réflexe aurait été
de publier le tableau.

---

## 7. Ce que cela change

### Sur la longueur du réseau

Le chiffre de **21 156 km reste exact** : c'est la longueur de ce que la BDRI
contient, calculée depuis sa propre géométrie. Ce qui tombe, c'est l'idée que ce
chiffre serait corroboré par OSM comme « la longueur du réseau classé guinéen ».

Pris ensemble, les deux réseaux suggèrent au contraire que le réseau réel est **plus
grand que l'un ou l'autre** : la BDRI a 13 296 km de régionales qu'OSM ne classe pas,
et OSM a 9 500 km de tertiaires que la BDRI ne connaît pas. Ce qu'AGEROUTE considère
comme « le réseau » est une décision de périmètre, pas une mesure.

### Sur l'usage d'OSM

| Usage envisagé | Verdict mesuré |
|---|---|
| Valider la géométrie des **nationales** | **oui** — 90,7 % à 25 m |
| Densifier la géométrie des **régionales** | **non** — 20,6 % de recouvrement à 250 m : il n'y a rien à densifier depuis OSM pour 4 régionales sur 5 |
| Fournir la topologie manquante | **partiel** — utile sur les nationales, sans objet sur les régionales |
| Compléter le référentiel avec les tertiaires OSM | **décision AGEROUTE** — 9 500 km de routes non classées dans la BDRI, d'origine contributive |

J'avais écrit qu'OSM offrirait « un gain de huit fois » sur la densité des
régionales. C'est faux : ce gain n'est accessible que là où les tracés se
correspondent, soit un cinquième d'entre elles.

### Sur la provenance

Les 1 028 tronçons `RES-*` ne viennent pas d'OSM — le recouvrement l'exclut — et leur
grossièreté à 2,1 points/km ne s'explique donc pas par une extraction OSM simplifiée.
La question « que recouvre RES-* ? » reste entière et prend de l'importance : c'est
une source qui décrit 13 296 km de routes qu'aucun autre jeu disponible ne connaît.

---

## 8. Reproduire

```bash
python infra/osm/extraire-classe-wkt.py <dossier>/ROUTE osm-classe.tsv
bash infra/recouvrement-osm-bdri.sh osm-classe.tsv
```

Environ quarante minutes sur le serveur de production, dans un conteneur jetable,
sans toucher la base.

# Les routes OSM classées absentes de la BDRI

**Ticket** : P5-03
**Mesure** : 2 septembre 2026, conteneur d'analyse (lecture seule)
**Script reproductible** : `infra/phase5/osm-manquant.sh` (échantillonnage 100 m des 5 394 segments classés OSM, couverture BDRI à 25/250 m)
**Aucune catégorie ne devient une route BDRI sans décision humaine.**

---

## 1. La réponse mesurée à « que représentent les 9 500 km OSM absents ? »

Le chiffre Phase 4 (trois quarts des tertiaires absents ≈ 9 500 km) se décompose
maintenant, segment par segment, en :

| Catégorie (seuils en §3) | Segments | km | Nature dominante |
|---|---:|---:|---|
| **POTENTIAL_BDRI_MISSING** | 1 009 | **6 947** | tertiaire 5 491 + secondaire 1 061 + primaire 368 + voie rapide 27 |
| OUTSIDE_BDRI_SCOPE (tertiaire partiel) | 491 | 3 764 | tertiaire |
| LIKELY_LOCAL_ROAD | 1 129 | 802 | tertiaire court (< 3 km) |
| LIKELY_DUPLICATE (déjà représenté) | 2 650 | 8 165 | toutes |
| UNDETERMINED | 115 | 767 | — |

**Réconciliation avec l'estimation Phase 4** : tertiaires absents = 5 491
(POTENTIAL) + 3 764 (OUTSIDE_SCOPE) + 802 (LOCAL) ≈ 10 057 km — cohérent avec
l'estimation « ~9 500 km » (les OUTSIDE_SCOPE y entrent pour partie). La mesure
affine, elle ne contredit pas.

---

## 2. Les découvertes qui méritent l'attention de la Direction Technique

**Des routes numérotées absentes.** Le plus gros segment manquant est une
**Route primaire « A7 », 66,8 km, région Nzérékoré** — une route avec numéro,
donc identifiée par OSM comme axe majeur, sans aucune correspondance BDRI.
Viennent ensuite une primaire « A12 » (30,4 km, Nzérékoré), et des secondaires de
30–43 km en Faranah et Kankan. Sur 112 segments primaires manquants (368 km),
une route numérotée est un fait, pas un détail.

**La géographie du manque.** Les gros segments manquants se concentrent sur
Nzérékoré, Labé, Kindia, Kankan, Faranah — l'intérieur du pays, loin du réseau
national historiquement bien cartographié.

**Le contexte administratif n'existe pas.** La colonne « région proche » est une
indication (région du tronçon BDRI le plus proche), pas un rattachement —
référentiel administratif inexistant (P5-05).

---

## 3. Seuils de classification (explicites, ajustables)

Pour chaque segment OSM classé : `s250` = part du linéaire à moins de 250 m d'un
tronçon BDRI.

| Catégorie | Règle |
|---|---|
| LIKELY_DUPLICATE | s250 ≥ 0,5 (représenté) |
| POTENTIAL_BDRI_MISSING | s250 < 0,1 ET (nature ≠ tertiaire OU longueur ≥ 3 km) |
| LIKELY_LOCAL_ROAD | s250 < 0,1 ET tertiaire ET < 3 km |
| OUTSIDE_BDRI_SCOPE | 0,1 ≤ s250 < 0,5 ET tertiaire — statut INFERRE : réseau local probablement hors périmètre |
| UNDETERMINED | le reste |

**POURQUOI ces seuils** : 250 m est la tolérance maximale déjà retenue en
Phase 4 pour rattraper les tracés grossiers ; 3 km sépare le tertiaire
« corridor » du tertiaire « desserte locale » — coupure de jugement, assumée
comme telle, modifiable dans le script.

---

## 4. Ce que ces 6 947 km NE sont PAS

- ils **ne sont pas** automatiquement des routes AGEROUTE : OSM est une source
  externe qui ne fait pas autorité (statut EXTERNAL_SOURCE) ;
- ils **ne seront pas importés** : l'import OSM dans la BDRI sans validation est
  précisément ce qui a produit le lot RES-* — un réseau sans provenance ;
- ils **ne comblent pas** le lot RES-* : les RES ne suivent aucune nature OSM,
  ce sont deux ensembles disjints (P5-02).

---

## 5. La décision attendue

> **Les 6 947 km POTENTIAL_BDRI_MISSING — dont les primaires A7 et A12 —
> appartiennent-ils au réseau routier dont AGEROUTE a la charge ?**

Si oui : import ciblé, validé segment par segment, avec provenance documentée.
Si non : le constat « BDRI ≠ OSM » est normal et définitif — deux périmètres
différents. Dans les deux cas, la décision est métier, la mesure est prête.

**Fichiers** : `donnees/osm-manquant.tsv` (5 394 lignes, une par segment OSM
classé : nature, numéro, km, région proche, couvertures, catégorie).
**Statut** : classement MEASURED (seuils documentés) ; interprétation « hors
périmètre » INFERRED ; décision REQUIRES_BUSINESS_VALIDATION.

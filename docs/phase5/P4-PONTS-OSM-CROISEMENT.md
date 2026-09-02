# Croisement franchissements OSM × ouvrages BDRI — P4

**Date** : 2 septembre 2026 · **Lecture seule** sur copie restaurée (conteneur `phase5-analyse`, sauvegarde `bdri_20260902_030001`)
**Scripts reproductibles** : `infra/osm/extraire-franchissements-wkt.py` (extraction locale) + `infra/phase5/croiser-ponts-osm.sh` (croisement serveur)
**Données** : `donnees/ponts-osm-propositions.tsv` (3 178 lignes)
**Statut : propositions d'analyse — aucun ouvrage créé, aucune donnée modifiée (règle Phase 5).**

---

## 1. Le fait principal, mesuré

L'extraction OSM du 8 mars 2023 identifie **3 178 franchissements** (2 698 Pont, 441 Gué, 39 Tunnel — l'unique attribut réellement rempli de la couche ROUTE). La BDRI référence **126 ouvrages d'art** (124 localisés), hérités de la migration `ouvrages_art` de l'ancien SIG.

| Classement | Franchissement | Nombre | dont sur axe majeur* |
|---|---|---:|---:|
| `PONT_BDRI_PROCHE_25M` (ouvrage BDRI ≤ 25 m) | Pont | **6** | 4 |
| `PONT_BDRI_PROCHE_250M` (≤ 250 m) | Pont | **3** | 2 |
| `PONT_SANS_OUVRAGE` (rien à ≤ 250 m) | **Pont** | **2 689** | **570** |
| `PONT_SANS_OUVRAGE` | Gué | 441 | 8 |
| `PONT_SANS_OUVRAGE` | Tunnel | 39 | 0 |

*\* voie rapide / primaire / secondaire.*

**Seuls 9 ponts OSM sur 2 698 (0,3 %) trouvent un ouvrage BDRI à moins de 250 m.** Les 2 689 autres — dont **570 sur des axes majeurs** (voies rapides N1/N3/N6, primaires, secondaires) — ne correspondent à rien dans l'inventaire des ouvrages. À l'inverse, les 9 correspondances trouvées sont cohérentes (ex. « Pont PK 28.75 » sur la N4, « Kouété », région Kindia).

## 2. Géographie (région indicative = région du tronçon BDRI le plus proche)

| Région | Ponts sans ouvrage | Σ longueurs des ways** |
|---|---:|---:|
| Faranah | 924 | 47,3 km |
| Kankan | 509 | 23,8 km |
| Nzérékoré | 388 | 7,3 km |
| Kindia | 294 | 9,5 km |
| Boké | 182 | 8,9 km |
| Labé | 154 | 3,2 km |
| Mamou | 152 | 3,7 km |
| Conakry | 86 | 2,6 km |

**\* Caveat honnête** : l'attribut `FRANCHISST` est porté par le **way OSM entier** — la « longueur » mesurée est celle du tronçon de route étiqueté pont, pas de l'ouvrage seul (approches comprises). Les **comptes** (924, 509…) sont robustes ; les **kilomètres** sont des bornes supérieures.

## 3. Comment lire ce résultat sans se tromper

1. **Ce n'est pas « 2 689 ouvrages manquants »** : un tag OSM `bridge` couvre aussi de petits ouvrages que la BDRI classerait dalot/buse, et la qualité OSM est variable. Le chiffre robuste est l'**ordre de grandeur** : l'inventaire BDRI (126 ouvrages) ne couvre qu'une fraction mineure des franchissements cartographiés — cohérent avec sa provenance (reprise d'un ancien inventaire partiel, centré RN).
2. **Le signal le plus actionnable** : les **570 ponts sans ouvrage sur axes majeurs**, et nommément les voies rapides numérotées (N1, N3, N4, N6…) — un pont sur voie rapide sans ouvrage à l'inventeur mérite examen en priorité (sécurité, inspection, points noirs).
3. **Statut `EXTERNAL_SOURCE`** : OSM ne fait pas autorité. Chaque ligne du TSV est une **proposition** pour la Direction Technique — l'enquête terrain/institutionnelle tranche (même logique que les 6 947 km de routes D3).

## 4. Décision attendue (nouvelle entrée D9 au registre des décisions)

> **L'inventaire des ouvrages d'art doit-il être reconstitué ?** Si oui : campagne de validation des propositions (priorisation : axes majeurs d'abord, Faranah/Kankan ensuite), création **une par une, avec provenance documentée** — jamais d'import en masse (la leçon du lot RES-* s'applique). Si non : le registre de vérité acte que la BDRI ne prétend pas inventorier les ouvrages, et l'écart 126 ↔ 2 698 est documenté comme périmètre assumé.

## 5. Reproducibilité

```bash
# localement : extraction des franchissements
cd infra/osm && python extraire-franchissements-wkt.py <CHEMIN/ROUTE> osm-franchissements.tsv
# sur le serveur (conteneur phase5-analyse actif) :
./croiser-ponts-osm.sh ~/phase5/osm-franchissements.tsv
```

Les tables `osm_franchissement` et `ponts_classement` restent dans le conteneur d'analyse pour examen cartographique ultérieur ; la production n'a jamais été touchée.

**Statut** : comptages et distances MEASURED ; interprétations INFERRED ; création d'ouvrages REQUIRES_BUSINESS_VALIDATION.

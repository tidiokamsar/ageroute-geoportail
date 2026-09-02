# Autopsie du lot RES-* — ce que la mesure établit

**Ticket** : P5-01
**Mesure** : 2 septembre 2026, sur copie restaurée (conteneur d'analyse, lecture seule)
**Scripts reproductibles** : `infra/phase5/interroger-legacy.sh`, `infra/phase5/autopsie-res.sh`
**Données** : 1 028 tronçons `RES-*`, 13 296 km géométriques (mesure Phase 4, méthode identique) ; OSM 2023 classé (5 394 segments) + couches CHEMIN (171 570)
**Aucune donnée métier modifiée. Les typologies sont des résultats d'analyse, pas des changements de `classe`.**

---

## 1. La réponse à la question « que sont les RES-* ? » — en trois temps

### Ce qui est établi (MEASURED)

**1. Ils sont nés dans la migration legacy comme lignes sans identité.** Le code
`migrate-legacy-data.ts:127` crée `RES-<ogc_fid>` pour toute ligne de la table
`reseau_routier_import` (base `sig_routier`) sans `code_bdr` ni `troncon`. Sur
1 580 lignes sources : 551 codées (devenues RN « GN N* »), **1 028 sans code**.

**2. La source legacy ne savait RIEN d'elles.** Interrogation directe de
`sig_routier` (conteneur `sig_postgis`, lecture seule, 02/09/2026) : sur les
1 028 lignes — 0 nom, 0 région, 0 état, 0 longueur, 0 trafic, et colonnes de
provenance (`source`, `origine`, `date`, `type_route`, `info_bulle`) **toutes
vides**. Ces lignes sont entrées dans l'ancien SIG comme **géométrie pure**.
À titre de contraste, les 551 lignes codées portent une provenance : « Open Street
Map 2016 / Divers » (520), « DNER 2016 / Relevés Viziroad » (30), « OSM 2016 /
GPS-Télétection » (1).

**3. Ils ne décrivent ni les routes OSM classées, ni les pistes OSM.** Mesure par
échantillonnage 100 m (192 460 points) contre le réseau classé 2023 ET la couche
CHEMIN (pistes carrossables et sentiers) :

| Part du linéaire RES (majoritaire par tronçon) | Tronçons | % |
|---|---:|---:|
| aucune route OSM classée à 250 m | **844** | **82 %** |
| route classée à 100–250 m seulement | 159 | 15 % |
| route classée à 25–100 m | 22 | 2 % |
| route classée à moins de 25 m | **3** | 0,3 % |

Et contre les chemins/pistes OSM : **1 024 sur 1 028** ont moins de 20 % de leur
tracé à 25 m d'un chemin. La distance médiane du centroïde au chemin le plus
proche est de 296 m : les RES **croisent** le maillage des pistes sans le suivre.

### Ce qui est déduit (INFERRED)

**Les RES-* forment un réseau en soi, pas un doublon d'un réseau connu.**
- 96 % (993/1 028) croisent géométriquement au moins un autre tronçon BDRI ;
- 823 ont un autre RR à moins de 100 m : le lot se touche **lui-même** massivement ;
- la topologie BDRI entière forme **une seule composante par intersection
  géométrique** (les classes se croisent), alors que leurs extrémités ne se
  raccordent jamais entre classes (mesure Phase 4) ;
- morphologie homogène : longueur médiane ~13 km, densité 2,1 sommets/km
  (médiane 1,78) — un tracé très simplifié, typique d'une numérisation à petite
  échelle, pas d'un levé GPS.

**Ce n'est pas non plus du bruit** : 10 011 km (753 tronçons) en
`RES_UNDETERMINED` ne sont pas des erreurs — ce sont des tracés cohérents, simples,
longs, interconnectés, que les sources OSM 2023 ne connaissent pas.

### Ce qui reste inconnu (UNKNOWN)

**L'institution, le fichier et la date d'origine du lot.** Aucune trace nulle
part — ni dans la base legacy, ni dans les métadonnées de la table, ni dans le
dépôt. L'hypothèse la plus vraisemblable (un référentiel « routes rurales /
régionales » numérisé à petite échelle, antérieur à 2016, importé dans l'ancien
SIG sans attributs) **ne peut pas être confirmée par les données disponibles**.
C'est une enquête à mener auprès de la Direction Technique et des anciens
gestionnaires du SIG (question à poser : « quel fichier de routes régionales a
été importé dans sig_routier, et par qui ? »).

---

## 2. La typologie (seuils explicites, résultat d'analyse)

Règles (premier match gagnant), appliquées aux parts de linéaire :

| Catégorie | Règle | Tronçons | km |
|---|---|---:|---:|
| `RES_DUPLICATE_OR_OVERLAP` | ≥ 50 % à 25 m d'un **autre tronçon BDRI** | 8 | 1 |
| `RES_CONFIRMED_ROAD` | ≥ 80 % à 25 m d'une route OSM classée | **0** | 0 |
| `RES_OUTSIDE_REFERENCE_NETWORK` | < 10 % à 250 m d'OSM classé **et** < 10 % à 250 m de tout chemin | 245 | 3 144 |
| `RES_POSSIBLE_ROAD` | ≥ 50 % à 100 m d'OSM classé OU ≥ 50 % à 25 m d'un chemin | 22 | 83 |
| `RES_UNDETERMINED` | le reste | 753 | 10 011 |

**Lecture** : pas un seul RES n'est une route OSM classée confirmée. Huit
recouvrent un autre tronçon BDRI (déchets d'import probables, à examiner un par
un avant toute action). 245 tronçons (3 144 km) n'ont **rien** — ni route, ni
sentier — à moins de 250 m dans OSM 2023 : c'est le signal le plus fort que le
lot décrit un référentiel distinct, ou des routes disparues/erronées — la mesure
ne permet pas de trancher.

---

## 3. Géographie et morphologie du lot

**Par région BDRI** (héritée du tronçon le plus proche à l'importation — donc
approximative par construction, cf. `import-rural-osm.ts` ; aucune région
n'était connue de la source) :

| Région | Tronçons | km | dont `hors référence` |
|---|---:|---:|---:|
| Kankan | 203 | 3 357 | 65 |
| Labé | 210 | 2 123 | 67 |
| Kindia | 164 | 2 196 | 29 |
| Nzérékoré | 164 | 1 904 | 12 |
| Faranah | 129 | 1 692 | 31 |
| Boké | 70 | 1 064 | 15 |
| Mamou | 88 | 904 | 26 |

*(2 tronçons non listés dans l'arrondi — total 1 028.)* Répartition
significativement corrélée à la Haute et Moyenne-Guinée.

**Morphologie** : longueur moyenne 13,3 km (max ~60 km) ; densité 2,1
sommets/km en moyenne, 1,78 en médiane, 19 au maximum — un tracé schématique.
Distance médiane au plus proche RN : 2,4 km ; p90 : 18,5 km — le lot vit
loin des nationales.

**Intersections** : 96 % des RES croisent au moins un tronçon ; 30 en croisent
plus de cinq.

---

## 4. Ce qu'il faut maintenant que des humains fassent

| # | Action | Qui | Pourquoi |
|---|---|---|---|
| 1 | Identifier le fichier d'origine du lot (archives SIG, anciens prestataires, DNER) | Direction Technique | c'est LA question à laquelle les données ne répondent pas |
| 2 | Arbitrer le statut des 245 `RES_OUTSIDE_REFERENCE_NETWORK` (3 144 km) : réseau réel non cartographié par OSM, ou tracé obsolète/erroné | Direction Technique + terrain | 24 % du km régional est en jeu |
| 3 | Examiner les 8 `RES_DUPLICATE_OR_OVERLAP` | gestionnaire BDRI | doublons probables — mais toute suppression est logique et auditée, après décision |
| 4 | Décider si `RES-*` reste dans le KM régional officiel tant que non identifié | Direction Générale | 13 296 km sur 21 156 km du total BDRI |

**Aucune de ces actions n'est automatisable, et la Phase 5 n'en a exécuté aucune.**

---

## 5. Fichiers produits

| Fichier | Contenu |
|---|---|
| `donnees/res-autopsie.tsv` | 1 028 lignes × 33 colonnes (métriques par tronçon, typologie, attributs legacy) |
| `res-typologie.geojson` (serveur, 684 Ko) | tracés RES colorés par typologie (visualisation) |

**Statut** : §1.1–1.3 et §2–3 MEASURED (scripts reproductibles) ; hypothèse d'origine INFERRED ; identification du lot UNKNOWN ; actions §4 REQUIRES_BUSINESS_VALIDATION.

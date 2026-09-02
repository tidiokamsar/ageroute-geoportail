# Registre de vérité BDRI — Phase 5

**Ticket** : P5-12
**Date d'établissement** : 2 septembre 2026
**Objet** : une seule table où chaque élément du référentiel porte son état, sa
preuve, sa confiance et l'action à venir. Ce registre est la référence croisée
des livrables détaillés (`RES-LOT-ANALYSIS.md`, `OSM-BDRI-DEEP-COMPARISON.md`,
`OSM-MISSING-NETWORK.md`, `MATRICE-CONFIANCE-DONNEES.md`).

---

## 1. Le registre

| Élément | État | Preuve | Confiance | Action |
|---|---|---|---|---|
| **RN (621, « GN N* » + imports OSM)** | établi | mesure + provenance lue dans la source legacy (OSM 2016 / DNER 2016) | élevée | conserver |
| **RU (40)** | établi | mesure (recoupement 98,7 % à 25 m), imports tracés dans le code | élevée | conserver |
| **RR — lot RES-\* (1 028, 13 296 km)** | **non expliqué** | autopsie complète (P5-01) : aucune provenance nulle part, aucune correspondance OSM | faible | **enquête Direction Technique + arbitrage périmètre** |
| — dont 245 hors toute référence (3 144 km) | inexpliqué, rien OSM à 250 m | mesure | faible | arbitrage prioritaire |
| — dont 8 doublons probables | à examiner | mesure (≥ 50 % sous un autre tronçon) | moyenne | examen un par un, décision avant action |
| **Hypothèse RN=primary / RR=secondary / RU=tertiary** | **rejetée** | matrice par famille (P5-02) | élevée sur le rejet | ne plus jamais la supposer dans un import |
| **6 947 km OSM classés absents** | caractérisé | P5-03, dont primaire A7 (67 km) et A12 | élevée sur la mesure | décision : dans le périmètre AGEROUTE ou non ? |
| **8 165 km OSM déjà représentés (LIKELY_DUPLICATE)** | recoupement positif | P5-03 | élevée | rien à faire |
| **21 156 km** | longueur géométrique du contenu actuel | calcul `ST_Length` | élevée sur le calcul | **ne pas appeler « réseau officiel »** — 63 % du linéaire est de provenance inconnue |
| **7 933 km** | longueur métier saisie (essentiellement RN) | base | élevée sur la valeur saisie | conserver ; étendre après identification RES |
| **Revêtement BITUME (1 690/1 690)** | importé non vérifié (forcé par le code de migration) | lecture du code | faible | **ne pas corriger sans relevé terrain** |
| **État patrimonial** | mappé d'un shapefile 6 niveaux | code + source legacy | faible/moyenne | idem |
| **OSM 2023 (extraction 8 mars 2023)** | source externe de comparaison | extraction AGEROUTE | variable | comparaison seulement — **ne fait pas autorité** |
| **Régions (8)** | établi | BDRI + legacy concordants | élevée | conserver |
| **Préfectures / communes / localités** | **non établi** — 0 valeur sur 1 690 | constat | nulle | source officielle (P5-05) |
| **Topologie** | 1 composante géométrique, 0 jonction d'extrémités interclasses | Phase 5 + Phase 4 | élevée sur la mesure | TOPOLOGY_READY après périmètre (P5-11) |
| **Localisation chantiers** | 189/488 ; 299 sans localisation exploitable | Phase 4 | mixte | référentiel administratif + validation des 33 propositions (P5-06) |
| **Sauvegardes** | opérationnelles, éprouvées ; **clé en un seul exemplaire** | restauration réelle du 02/09/2026 | élevée sur la procédure / risque majeur sur la clé | décision de gestion de clé (P5-13) |
| **Ouvrages d'art (126)** | inventaire partiel — couvre 9 des 2 698 ponts cartographiés par OSM (0,3 % à 250 m) ; **positions non vérifiées** : 9/9 ponts posés par interpolation de PK (5/9 repliés au début du tronçon ; Kolenté/Konkouré/Fatala = repères régionaux arrondis à 1–2 décimales, soit 1 à 11 km de précision) | croisement P4 du 02/09/2026 + vérification terrain utilisateur (symbole pont sans pont visible) | élevée sur les écarts mesurés / nulle sur les positions | **D9 DÉCIDÉE (02/09/2026, propriétaire)** : inventaire reconstitué par mission de terrain — le géoportail affiche les 3 178 franchissements OSM en propositions et permet le repositionnement glisser-déposer audité ; la carte publique reste sans ouvrages jusqu'à validation |
| **Périmètre officiel du réseau** | **non défini nulle part** | audit documentaire complet | nulle | décision fondatrice D1 (P5-04) |

---

## 2. Règles de maintenance du registre

1. Toute nouvelle affirmation sur le référentiel entre dans ce registre avec son
   statut (`MEASURED / INFERRED / EXTERNAL_SOURCE / UNKNOWN /
   REQUIRES_BUSINESS_VALIDATION`) et sa preuve (script ou document).
2. Une ligne ne change d'état que sur preuve nouvelle — jamais par conviction.
3. `UNKNOWN` est un état **valable et stable** : il n'est pas honteux, il est
   honnête. Le registre ne vise pas 100 % d'établi (règle §20 du cadrage).
4. Le registre vit avec la base : à chaque migration ou import validé, relire
   les lignes concernées.

---

## 3. Lecture en une phrase

> Le socle national (RN, régions, géométries valides) est établi ; le gros du
> linéaire (RES-*, 63 %) est de provenance inconnue et sans correspondance
> externe ; 6 947 km de routes OSM classées sont absentes ; le périmètre
> officiel reste à décider par AGEROUTE — et désormais, chaque affirmation de
> ce registre peut être démontrée à un auditeur.

**Statut** : registre MEASURED dans son ensemble ; actions listées REQUIRES_BUSINESS_VALIDATION.

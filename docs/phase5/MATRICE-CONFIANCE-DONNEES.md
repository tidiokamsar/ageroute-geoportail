# Matrice de confiance des données BDRI

**Ticket** : P5-07
**Date** : 2 septembre 2026
**Objet** : permettre à tout lecteur — agent, Direction Technique, auditeur externe —
de comprendre immédiatement **ce que nous savons et pourquoi nous le savons**.

Conformément à P5-08 : **aucun score global**. Les dimensions restent séparées.
Une moyenne est interdite.

---

## 1. La matrice

| Donnée | Valeur | Source | Méthode | Date | Confiance | Statut |
|---|---|---|---|---|---|---|
| Géométrie RN | 621 tronçons, 7 824 km | BDRI (import legacy `reseau_routier_import`) | import + recoupement OSM 2023 : 90,7 % à 25 m | 02/09/2026 | **élevée** | MESURED |
| Géométrie RU | 40 tronçons, 36 km | BDRI (imports OSM directs) | import + recoupement : 98,7 % à 25 m | 02/09/2026 | **élevée** | MEASURED |
| Géométrie RR (RES-*) | 1 028 tronçons, 13 296 km | BDRI — lot sans identité d'origine | import legacy ; **aucune provenance nulle part, même dans la source** ; recoupement OSM classé : 2,5 % à 25 m | 02/09/2026 | **faible, à établir** | MEASURED (périmètre REQUIRES_VALIDATION) |
| Provenance RN « GN N* » | 551 tronçons | legacy `reseau_routier_import.source` | lecture directe source : « Open Street Map 2016 / Divers » (520), « DNER 2016 / Relevés Viziroad » (30), « OSM 2016 / GPS-Télétection » (1) | 02/09/2026 | élevée sur le rattachement | MEASURED |
| Longueur géométrique totale | 21 156 km | calcul `ST_Length(geography)` | calcul | 02/09/2026 | élevée **sur le calcul** | MEASURED — ne pas appeler « réseau officiel » |
| Longueur métier RN | 7 824 km (551/551 renseignées famille GN N*) | saisie legacy | reprise d'import | 23/06/2026 | moyenne | MEASURED |
| Longueur métier RR | **0 km sur 1 028** RES (l'unique RR avec longueur est l'enregistrement `test`, 56,4 km) | — | constat | 01/09/2026 | — (absence) | MEASURED |
| Revêtement `BITUME` | 1 690/1 690 | code de migration (`revetement: "BITUME"` forcé, non renseigné dans la source) | lecture du code `migrate-legacy-data.ts:143` | 23/06/2026 | **faible** | MEASURED (importé non vérifié — ne pas corriger sans relevé) |
| État des tronçons | 5 niveaux, mappé depuis 6 niveaux legacy | import shapefile `reseau_routier_import` | mapping `RESEAU_ETAT_MAP` | 23/06/2026 | faible/moyenne | MEASURED |
| PK RN (famille GN N*) | exploitables sur 551 ; défauts mesurés : PK dupliqués, 6 tronçons à PK 0 | saisie legacy | audit Phase 4 | 01/09/2026 | moyenne | MEASURED |
| Régions | 8 officielles, concordantes BDRI↔legacy | `regions` / `ref_regions` | comparaison | 02/09/2026 | **élevée** | MEASURED |
| Préfectures / communes | 0 valeur sur 1 690 | — | constat | 02/09/2026 | **nulle (inexistante)** | MEASURED |
| Continuité topologique | 0 jonction d'extrémités interclasses ; par contre 1 seule composante par **intersection géométrique** (mesure Phase 5) | copie restaurée | `ST_ClusterIntersecting` + analyse extrémités Phase 4 | 02/09/2026 | élevée sur la mesure | MEASURED |
| Localisation chantiers | 189/488 localisées ; 299 sans localisation exploitable | BDRI | audit Phase 4 T6 | 01/09/2026 | mixte | MEASURED |
| Propositions de localisation T5 | 33 propositions, 14 emprises probables | intitulés de chantiers | extraction + recoupement longueur | 01/09/2026 | **à valider une par une** | REQUIRES_BUSINESS_VALIDATION |
| OSM 2023 (comparaison) | réseau classé 5 394 segments / 21 447 km | extraction AGEROUTE `A_OSM_RESEAU_ROUTIER`, 8 mars 2023 | échantillonnage 100 m | 02/09/2026 | variable — **source externe, ne fait pas autorité** | EXTERNAL_SOURCE |
| Recouvrement RN↔OSM | 90,7 % à 25 m | calcul | échantillonnage 100 m | 02/09/2026 | élevée | MEASURED |
| Recouvrement RR↔OSM | 2,5 % à 25 m / 20,6 % à 250 m | calcul | échantillonnage 100 m | 02/09/2026 | élevée | MEASURED |
| Référentiel administratif fin | inexistant | — | — | — | nulle | UNKNOWN |
| Signification des préfixes KA/MA/DI/RO | vraisemblablement communes — **non établi** | déduction de forme de code | — | 01/09/2026 | faible | INFERRED |

---

## 2. Les dimensions, affichées séparément (règle P5-08)

| Dimension | RN | RU | RR hors RES | RES-* |
|---|---|---|---|---|
| géométrie | élevée | élevée | moyenne | à établir |
| localisation (PK) | moyenne | — | — | nulle (0 PK) |
| caractérisation (état, revêtement) | faible | faible | faible | faible |
| fraîcheur (dates de constat) | faible | faible | faible | nulle |
| provenance | **élevée** (lue dans la source) | élevée (imports tracés dans le code) | moyenne | **nulle** — aucune trace, nulle part |
| cohérence interne (longueur saisie vs calculée) | élevée (≤1 % sur 662 cas) | — | — | nulle (rien à comparer) |
| traçabilité (audit des écritures) | élevée (1 155 modifications journalisées) | élevée | élevée | élevée (aucune création journalisée, mais provenance Phase 4 rétro-déduite du code) |

---

## 3. Comment lire cette matrice

- **élevée** : recoupée par une seconde source ou tracée de bout en bout ;
- **moyenne** : présente mais datée ou partiellement vérifiée ;
- **faible** : entrée sans vérification (le revêtement BITUME en est l'exemple
  type — importé, contredit par le terrain, **non corrigé** faute de relevé) ;
- **nulle** : inexistante, et dite telle.

Le principe : une absence connue et affichée vaut mieux qu'une valeur invérifiable
qui habille un tableau de bord.

**Statut** : toutes les lignes marquées MEASURED proviennent de requêtes ou de
lectures de code reproductibles (scripts `infra/phase5/`, rapports Phase 4).
Les lignes INFERRED/REQUIRES_BUSINESS_VALIDATION sont signalées comme telles.

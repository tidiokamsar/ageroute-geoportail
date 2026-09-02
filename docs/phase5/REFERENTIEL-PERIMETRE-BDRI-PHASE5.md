# Périmètre du référentiel BDRI — état factuel et décision attendue

**Ticket** : P5-04
**Date** : 2 septembre 2026
**Objet** : répondre à « quel est le périmètre officiel du réseau BDRI ? » en
distinguant sans relâche ce qui est établi, déduit, mesuré, inconnu, et ce qui
demande une validation métier.

---

## 1. Ce qui est officiellement établi

| Élément | Preuve | Statut |
|---|---|---|
| Les 8 régions administratives | tables `regions` (BDRI) et `ref_regions` (legacy), concordantes, codes BOK/CKY/FAR/KAN/KIN/LAB/MAM/NZE | **établi** |
| Le classement RN/RR/RU existe comme nomenclature applicative | schéma Prisma, migration initiale | **établi** (la nomenclature, pas le périmètre) |
| Les 551 RN « GN N* » forment le réseau national de référence | longueurs 551/551, PK exploitables, recouvrement OSM 90,7 % à 25 m ; provenance lue dans la source legacy : OSM 2016 (520), DNER 2016 « Relevés Viziroad » (30), OSM 2016 GPS/Télétection (1) | **établi** — avec une conséquence : **le réseau national de la BDRI est lui-même en partie d'origine OSM 2016** |

## 2. Ce qui est mesuré (Phase 4 + Phase 5, scripts reproductibles)

| Mesure | Valeur | Script |
|---|---|---|
| Réseau BDRI total | 1 690 tronçons, 21 156 km géométriques, 7 933 km métier saisis | `preparer-analyse.sh` |
| Recouvrement RN ↔ OSM 2023 classé | 90,7 % à 25 m | Phase 4 |
| Recouvrement RR (RES-*) ↔ OSM classé | 2,5 % à 25 m, 20,6 % à 250 m | Phase 4 |
| RES-* ↔ pistes/sentiers OSM (CHEMIN) | < 20 % du tracé à 25 m pour 1 024/1 028 | Phase 5 `autopsie-res.sh` |
| Matrice par famille | RN ↔ voie rapide 36,3 % / primaire 23,7 % / secondaire 12,0 % / tertiaire 19,4 % ; RES-* ↔ toutes natures 0,1–1,5 % ; RU ↔ primaire 55,8 % / secondaire 39,9 % | Phase 5 `matrice-osm-bdri.sh` |
| Composante topologique (intersections géométriques) | 1 seule composante pour tout le réseau ; mais 0 jonction d'extrémités interclasses | Phase 5 + Phase 4 |
| Sources lisibles dans le code des imports | RN legacy (`reseau_routier_import`), OSM direct (`*-OSM-*`, 90), OSM rural (`KA/MA/DI/RO`, 20 RU) | revue de code |

## 3. Ce qui est déduit (INFERRED, à ne pas présenter comme des faits)

- Les RES-* décrivent **un référentiel distinct** des réseaux OSM 2023 connus
  (routes classées comme pistes) : réseau dense, interconnecté, schématique
  (2,1 sommets/km), corrélé à la Haute/Moyenne-Guinée.
- L'hypothèse RN=primary / RR=secondary / RU=tertiary est **fausse dans les deux
  sens** : les RN couvrent les quatre natures OSM, les RU suivent surtout
  primaires et secondaires, et les RR suivent… rien.
- Les préfixes `KA/MA/DI/RO` désignent vraisemblablement des communes — forme de
  code, jamais confirmée.

## 4. Ce qui est inconnu (UNKNOWN — et doit le rester jusqu'à preuve)

1. **Le périmètre officiel du réseau AGEROUTE** : aucun document du dépôt
   (audités : `docs/audit-2026/`, `docs/bdri-2/`, `docs/phase4/`, scripts,
   métadonnées legacy) ne définit ce que le réseau routier national guinéen
   *doit* contenir — ni liste officielle des RN, ni définition du réseau
   régional, ni périmètre urbain.
2. **L'origine du lot RES-*** (1 028 tronçons, 13 296 km, 63 % du linéaire
   BDRI) : aucune provenance, nulle part, même dans la base source.
3. **Le référentiel administratif fin** (préfectures, communes) : inexistant.

## 5. Ce qui nécessite validation métier (REQUIRES_BUSINESS_VALIDATION)

| # | Décision | Enjeu |
|---|---|---|
| D1 | Définir le périmètre officiel : que doit contenir la BDRI ? (RN seules ? RN+RR identifiées ? RN+RR+RU ?) | c'est la question fondatrice ; tout le reste en découle |
| D2 | Statut du lot RES-* : patrimoine à conserver / à vérifier terrain / à sortir du périmètre | 13 296 km, 63 % du linéaire |
| D3 | Les 9 500 km OSM classés absents (P5-03) appartiennent-ils au réseau AGEROUTE ? | cf. `OSM-MISSING-NETWORK.md` |
| D4 | Source officielle du référentiel administratif | cf. `REFERENTIEL-ADMINISTRATIF-SPEC.md` |
| D5 | Faut-il un identifiant patrimonial national stable (recommandé) | cf. `BDRI-REFERENTIEL-NATIONAL.md` §4 |

---

## 6. La réponse honnête à la Question 4 du cadrage

> **Quel est le périmètre officiel du réseau BDRI ?**

**Il n'est défini nulle part.** Ce que la BDRI contient aujourd'hui est la
superposition de quatre imports (legacy RN/RES, OSM direct, OSM rural,
enregistrements de test), dont le plus lourd — 63 % du linéaire — n'a aucune
provenance identifiable. Aucune fusion, correction ou complément ne doit être
entrepris avant que les décisions D1–D3 ci-dessus soient prises et documentées
par AGEROUTE.

Ce constat n'est pas un échec : c'est le résultat attendu d'une phase
d'établissement de vérité. Le périmètre ne se décrète pas à partir de données
incertaines ; il se décide à partir de mesures propres — qui sont désormais
disponibles, reproductibles et opposables.

**Statut** : §1–2 MEASURED ; §3 INFERRED ; §4 UNKNOWN ; §5 REQUIRES_BUSINESS_VALIDATION.

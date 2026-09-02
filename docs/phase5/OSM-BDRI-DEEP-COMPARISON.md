# Comparaison OSM ↔ BDRI approfondie — la matrice par famille

**Ticket** : P5-02
**Mesure** : 2 septembre 2026, conteneur d'analyse (lecture seule)
**Script reproductible** : `infra/phase5/matrice-osm-bdri.sh` (334 073 points échantillonnés à 100 m, un test par couple classe×nature à 25 m)
**Rappel de cadrage** : l'hypothèse RN=primary / RR=secondary / RU=tertiary est une hypothèse analytique — la matrice la teste.

---

## 1. La matrice mesurée

Part du linéaire BDRI de chaque famille à moins de **25 m** d'un segment OSM de
 chaque nature :

| Famille BDRI | Voie rapide | Primaire | Secondaire | Tertiaire |
|---|---:|---:|---:|---:|
| **RN** (621, hors RES) | **36,3 %** | **23,7 %** | 12,0 % | 19,4 % |
| **RR — le lot RES-\*** (1 028) | 0,1 % | 0,2 % | 0,4 % | **1,5 %** |
| RR — hors lot (1 : le tronçon `test`) | 0,0 % | 0,0 % | 42,3 % | 0,7 % |
| **RU** (40, hors RES) | 2,1 % | **55,8 %** | **39,9 %** | 17,4 % |

*(Les parts par nature se chevauchent : deux natures OSM peuvent être à 25 m du
même point. La somme n'est donc pas le recouvrement global.)*

---

## 2. Ce que la matrice établit

**1. L'hypothèse diagonale est fausse, dans les deux sens.**
- Les RN ne « sont » pas les primaires : elles suivent d'abord les voies rapides
  (36,3 %) puis les primaires (23,7 %) — et touchent secondaires et tertiaires
  dans des proportions significatives. C'est cohérent : une nationale desservie
  par OSM comme voie rapide sur ses meilleurs tronçons et primaire ailleurs.
- Les RU ne suivent pas les tertiaires d'abord : **primaire 55,8 % et secondaire
  39,9 %**. Le petit réseau urbain BDRI recouvre des axes OSM bien classés —
  cohérent avec sa provenance (imports OSM directs, cf. `merge-osm-routes.ts`).
- Les RR RES-* ne suivent **rien** (0,1–1,5 %) — cf. `RES-LOT-ANALYSIS.md`.

**2. Le miroir OSM→BDRI (Phase 4) se réinterprète proprement.** Voie rapide
couverte à 95,3 %, primaire 72,2 %, secondaire 31,3 %, tertiaire 10,7 % : la BDRI
contient l'ossature (voies rapides + primaires) mais ni le réseau intermédiaire
OSM ni — sauf exception — le lot RES.

**3. La ligne « RR hors lot » est un artefact à ne pas interpréter** : elle
mesure un unique tronçon d'essai (`test`, 56 km). Elle documente surtout le
danger de lire une famille d'effectif 1.

---

## 3. Conséquences pour le référentiel

| Conséquence | Détail |
|---|---|
| Aucune correspondance de classes ne peut être supposée dans un import | un Import OSM doit passer par une correspondance mesurée, pas par une table RN↔primary |
| Le lot RES-* ne peut pas être « complété » par OSM | il ne recouvre aucune nature : fusionner n'aurait aucun sens géométrique |
| La question du périmètre (P5-04) reste la clé | la matrice dit ce qui se superpose ; seule la Direction Technique peut dire ce qui DOIT être dans la BDRI |

**Fichier** : `donnees/matrice-osm-bdri.tsv` (16 lignes, les 16 couples mesurés).
**Statut** : MEASURED (méthode et seuils identiques Phase 4 ; hypothèse testée et rejetée).

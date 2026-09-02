# P4-02 — Audit des géodonnées BDRI existantes

**Date** : 2 septembre 2026
**Portée** : modèle Prisma, index PostGIS, endpoints cartographiques, couches Leaflet
**Méthode** : lecture du schéma et du code, mesures en lecture seule sur la base de production et sur l'API publique. **Production non modifiée.**

---

## 1. Les entités géographiques du modèle

Six colonnes de géométrie existent dans `schema.prisma`. Prisma ne gère pas le type
`geometry` : toutes sont déclarées `Unsupported(...)` et manipulées en SQL brut via
`lib/geo.ts`.

| Modèle | Type | Objets actifs | Avec géométrie |
|---|---|---:|---:|
| `Troncon` | `LineString, 4326` | 1 690 | **1 690** |
| `Ouvrage` | `Point, 4326` | 126 | 124 |
| `Chantier` | `LineString, 4326` | 487 | **5** |
| `PointNoir` | `Point, 4326` | 2 | — |
| `Poste` | `Point, 4326` | 0 | — |
| `PropositionLocalisation` | `LineString, 4326` | 0 | — |

**SRID 4326 partout**, identique aux couches OSM. Aucune reprojection ne sera
nécessaire.

### La classification institutionnelle actuelle

`Troncon.classe` est un enum `ClasseRoute` à **quatre valeurs** :

```
RN      Route Nationale       621 tronçons
RR      Route Régionale     1 029 tronçons
RU      Route Urbaine          40 tronçons
PISTE   (déclarée, non utilisée : 0 tronçon)
```

**Observation importante pour le cadrage.** La hiérarchie demandée place `RES` comme
une classe institutionnelle à part entière, au même rang que RN et RR. **Ce n'est pas
ce que porte le modèle** : `RES` n'est pas une valeur de `ClasseRoute`, c'est un
**préfixe de `code`**. Les 1 028 tronçons `RES-*` sont tous de classe `RR`.

| Famille de code | Classe réelle | Tronçons |
|---|---|---:|
| `GN N*` | RN | 551 |
| `*-OSM-*` | RN | 70 |
| `RES-*` | **RR** | **1 028** |
| autre | RU / RR | 41 |

**DÉCISION HUMAINE REQUISE** : faire de `RES` une classe distincte suppose de
modifier l'enum et de reclasser 1 028 tronçons. C'est un changement de nomenclature
institutionnelle, pas une évolution technique. La Phase 5 avait d'ailleurs laissé
ouverte la question de ce que recouvre exactement le lot `RES-*`.

---

## 2. Index spatiaux — un seul existe

```
troncons : troncons_geom_geography_idx — gist (((geom)::geography))
```

**FAIT MESURÉ** : c'est le **seul** index GiST de la base. `ouvrages`, `chantiers`,
`points_noirs`, `postes` n'en ont aucun.

C'était un choix mesuré : à 126 et 487 objets, un index spatial ne rapporte rien.
La forme retenue compte aussi — un index sur `geom` était ignoré par le planificateur
là où `(geom::geography)` divisait le temps par quarante, parce que les requêtes de
l'application castent en `geography` pour raisonner en mètres.

**Conséquence pour la voirie locale** : une table de ~262 000 lignes exigera son
index dès la création, et de la même forme.

---

## 3. Les endpoints cartographiques

Huit routes `/geo` existent : `troncons`, `ouvrages`, `chantiers`, `points-noirs`,
`postes`, `propositions`, et `public/carte/geo` pour la carte ouverte.

**Toutes livrent la couche entière, sans filtre spatial ni pagination.** Le
géoportail charge cinq de ces endpoints au montage.

### Le poids réel, mesuré sur la production

| | Octets |
|---|---:|
| `/api/public/carte/geo` — sans compression | **2 831 458** |
| — gzippée | **875 968** |

Pour 1 690 tronçons et environ 124 000 sommets, soit **22,8 octets par sommet**.

---

## 4. Ce que coûterait la voirie locale au même régime

**FAIT MESURÉ** puis **INFÉRENCE** — extrapolation du coût par sommet observé.

| | Objets | Sommets | Poids brut | Gzippé |
|---|---:|---:|---:|---:|
| BDRI aujourd'hui | 1 690 | 124 090 | 2,8 Mo | 876 Ko |
| **OSM `ROUTE` complet** | **262 656** | **5 836 667** | **≈ 133 Mo** | **≈ 41 Mo** |
| Rapport | ×155 | **×47** | ×47 | ×47 |

**Servir la voirie locale comme les couches actuelles est exclu.** Quarante mégaoctets
compressés à chaque ouverture de carte, sur des connexions guinéennes, rendrait
l'application inutilisable — y compris pour ce qui fonctionne aujourd'hui.

Ce chiffre n'est pas une estimation de principe : il vient du rapport octets/sommet
effectivement mesuré sur la production, appliqué au nombre de sommets effectivement
compté dans `ROUTE.shp`.

---

## 5. Ce que la carte fait aujourd'hui

`GeoportailPage.tsx` monte cinq couches en `useQuery`, sans seuil de zoom ni cadrage
spatial. Les tronçons sont rendus en `Polyline` React-Leaflet, les objets ponctuels
en `Marker` avec `MarkerClusterGroup`.

Un précédent utile : la couche des franchissements OSM (3 178 points) a nécessité
regroupement et filtre par catégorie pour rester lisible. À 262 656 polylignes, le
regroupement ne suffira pas — c'est le transport lui-même qui bloque.

---

## 6. Invariants à ne pas casser

| Invariant | Vérifié |
|---|---|
| SRID 4326 sur toutes les géométries | oui |
| `deletedAt IS NULL` filtre partout la suppression logique | oui |
| Écriture géométrique passe par `lib/geo.ts`, jamais par Prisma | oui |
| Toute écriture métier est tracée au journal d'audit | oui |
| Les routes `/geo` sont derrière `requireAuth` sauf `public/carte/geo` | oui |
| Compression gzip active (69 % mesurés) | oui |

---

## 7. Conclusions pour la conception

1. **`ROUTE` seule**, jamais `CHEMIN` — sous-ensemble à 100 %, moins attribué.
2. **Table séparée**, jamais `Troncon` : la voirie OSM n'est pas un actif AGEROUTE,
   et 262 000 lignes dans `troncons` casseraient tous les comptages existants.
3. **Index GiST sur `(geom::geography)`** dès la création.
4. **Le transport GeoJSON intégral est exclu** — 41 Mo gzippés mesurés par
   extrapolation. Il faut un cadrage spatial, un seuil de zoom, une simplification,
   ou des tuiles vectorielles. Le choix relève de la phase de conception.
5. **`RES` comme classe institutionnelle est une décision de nomenclature**, pas un
   changement de code : aujourd'hui c'est un préfixe, et les 1 028 objets concernés
   sont de classe `RR`.

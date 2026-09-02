# P4-05 — Architecture d'affichage multi-niveaux

**Date** : 2 septembre 2026
**Statut** : **PROPOSITION**, fondée sur mesure. Aucun code d'affichage écrit.

---

## 1. La contrainte, mesurée

Point de départ : la carte publique actuelle transporte **2 831 458 octets**
(875 968 gzippés) pour 1 690 tronçons et 124 090 sommets. Soit **22,8 octets par
sommet** une fois sérialisé en GeoJSON, et un ratio de compression de **0,31**.

Ces deux constantes viennent de la production, pas d'une estimation. Appliquées au
nombre de sommets réellement compté dans `ROUTE.shp`, elles donnent :

| Emprise | Objets | Sommets | GeoJSON | Gzippé |
|---|---:|---:|---:|---:|
| **Pays entier** | 262 656 | 5 836 917 | **133,1 Mo** | **41,2 Mo** |
| Région (Conakry élargie) | 19 501 | 165 308 | 3,8 Mo | 1,2 Mo |
| **Ville (Conakry)** | 6 155 | 37 341 | 851 Ko | **263 Ko** |
| Commune (Matoto) | 733 | 4 904 | 112 Ko | 35 Ko |
| Quartier | 60 | 335 | 8 Ko | **2 Ko** |

Emprises centrées sur Conakry, la zone la plus dense du pays : c'est le cas
défavorable. Script : `scripts/osm-comparison/poids_par_emprise.py`.

---

## 2. Ce que ces chiffres décident

**Servir la couche entière est exclu.** 41 Mo gzippés à chaque ouverture rendrait
l'application inutilisable, et dégraderait aussi ce qui fonctionne aujourd'hui.

**Mais un GeoJSON cadré sur la vue suffit largement.** Conakry entière pèse
**263 Ko gzippés — moins que les 876 Ko que la carte publique transporte déjà**. À
l'échelle d'une commune, 35 Ko. D'un quartier, 2 Ko.

**Conséquence : les tuiles vectorielles ne sont pas nécessaires.**

C'est le résultat qui compte, parce qu'il évite un chantier considérable. Le MVT
supposerait un endpoint de tuiles, un cache, et surtout un changement de moteur de
rendu — Leaflet ne lit pas nativement le MVT, il faudrait `leaflet.vectorgrid` ou
un passage à MapLibre GL. Introduire cela pour servir 263 Ko serait
disproportionné.

**INFÉRENCE, à confirmer** : ces poids sont calculés depuis le nombre de sommets.
Ils supposent que le coût par sommet observé sur la production vaut aussi pour la
voirie locale. Les géométries OSM étant plus denses mais plus courtes, l'écart
devrait être faible. À vérifier sur la première implémentation réelle.

---

## 3. Architecture proposée

### Un endpoint cadré, avec seuil de zoom

```
GET /api/voirie-locale/geo?bbox=<minLon,minLat,maxLon,maxLat>&categories=<liste>
```

Trois protections, dans cet ordre :

**1. Refus sous le seuil de zoom.** Le client n'appelle pas l'endpoint en dessous
du niveau ville. Le serveur refuse aussi, indépendamment du client : une emprise
plus large qu'un seuil convenu renvoie une erreur explicite plutôt qu'un
téléchargement de 41 Mo.

**2. Cadrage spatial obligatoire.** `bbox` n'est pas optionnel. La requête utilise
l'index GiST sur `(geom::geography)` — la forme mesurée efficace en phase 3.

**3. Plafond d'objets.** Au-delà d'un nombre convenu dans l'emprise, la réponse est
tronquée et le signale. Une carte qui dit « trop d'objets, zoomez » vaut mieux
qu'une carte qui se fige.

### Les paliers d'affichage

| Niveau | Zoom | Couches affichées | Poids attendu |
|---|---|---|---|
| National | < 10 | RN, RR, RU | inchangé, 876 Ko |
| Régional | 10 – 11 | + réseau classé OSM | ~1 Mo |
| **Ville** | 12 – 13 | + voirie locale, résidentielle | ~260 Ko par vue |
| Quartier | 14 – 15 | + accès, chemins | ~35 Ko par vue |
| Détail | ≥ 16 | + sentiers, piétons | ~2 Ko par vue |

Les chemins et sentiers — 175 283 objets, les deux tiers du volume — n'apparaissent
qu'au zoom le plus fin. C'est cohérent avec leur usage : on ne consulte pas un
sentier à l'échelle du pays.

### Simplification

`ST_Simplify` sur la géométrie servie, avec une tolérance liée au zoom. La mesure
de la phase 4 sur les tronçons BDRI est réutilisable ici : dégrader une géométrie
jusqu'à 1,6 point par kilomètre conservait **99,09 %** de la longueur. Aux zooms
intermédiaires, une simplification agressive est donc quasiment gratuite en
fidélité.

À ne pas appliquer au-delà du zoom 15 : à cette échelle, la forme exacte de la voie
est précisément ce qu'on regarde.

---

## 4. Le panneau de couches

```
RÉSEAU AGEROUTE
  ☑ Routes nationales (RN)          621
  ☑ Routes régionales (RR)        1 029
  ☑ Voiries urbaines (RU)            40

VOIRIE LOCALE — source OpenStreetMap
  ☐ Voies locales et résidentielles    disponible à partir du zoom ville
  ☐ Accès et dessertes
  ☐ Chemins et sentiers                zoom quartier

PATRIMOINE
  ☑ Ouvrages d'art                  126
  ☑ Franchissements OSM (D9)      3 178
  ☑ Chantiers                       487
  ☑ Points noirs                      2
  ☑ Péages / pesages                  0
```

Trois règles d'affichage, tirées de ce que les phases précédentes ont montré :

**La source apparaît dans le titre du groupe**, pas dans une note de bas de
panneau. « VOIRIE LOCALE — source OpenStreetMap » se lit avant les cases.

**Une case indisponible au zoom courant le dit**, au lieu d'être cochable sans
effet. L'utilisateur qui coche et ne voit rien conclut à une panne.

**Les compteurs disent ce qu'ils comptent.** La leçon du panneau des
franchissements : « Réseau classé · 990 » se lisait comme 990 routes alors que
c'étaient 990 ouvrages.

### Couleurs

Le réseau AGEROUTE garde sa sémantique actuelle : la couleur porte l'**état** de la
chaussée. La voirie locale n'a pas d'état — elle doit donc se distinguer par un
registre différent : **traits gris fins, hiérarchisés par épaisseur**, jamais par
la palette état. Sans quoi un sentier gris pourrait se lire comme une route en
mauvais état.

---

## 5. La fiche d'une voie locale

```
VOIE LOCALE
────────────────────────────
Nom                    (non renseigné)
Nature                 Route résidentielle
Catégorie              Résidentielle
Longueur               340 m
Région                 Conakry  ⓘ déduite de la géométrie
Source                 OpenStreetMap
Identifiant source     w123456789
Date de la source      2023-03-08
Statut                 Donnée externe, non validée

[Proposer pour validation]
```

**Ne jamais afficher « Route AGEROUTE »** sur un objet non validé. Et « Nom : (non
renseigné) » plutôt qu'une ligne absente : l'absence doit se voir, elle est
l'information dominante — 99,6 % des voies n'ont pas de nom.

Le ⓘ sur la région rappelle qu'elle est **déduite par intersection**, pas portée
par la source. `CL_ADMIN` vaut `Autre` sur les 262 656 objets.

---

## 6. Ce qui reste à trancher

| Question | Pourquoi elle n'est pas tranchée ici |
|---|---|
| Les seuils de zoom exacts | à caler sur des essais réels, pas sur le papier |
| Le plafond d'objets par requête | dépend du seuil retenu |
| Faut-il importer les 175 283 chemins ? | deux tiers du volume, usage le moins certain — **décision métier** |
| Cache HTTP des réponses cadrées | la donnée est figée (2023-03-08), donc très cachable ; à mesurer d'abord |

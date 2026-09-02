# Audit topologique du réseau routier — Phase 4

**Date de mesure** : 2 septembre 2026, 02:56
**Base** : `console_bdri` en production, lecture seule
**Script** : `infra/diagnostic-topologie.sh`, reproductible
**Aucune géométrie modifiée.**

---

## 1. Pourquoi ce diagnostic précède tout choix de moteur

Le §26 du cahier des charges demande de comparer pgRouting, OSRM et GraphHopper. Cette
comparaison n'a pas de sens sur l'état actuel du réseau, et ce document établit
pourquoi : aucun moteur ne route sur un graphe dont les composantes ne se touchent
pas. Les trois échoueraient de la même façon, et les comparer reviendrait à évaluer
des outils sur un problème qu'aucun ne résout.

**La décision sur le moteur est reportée.** Ce diagnostic est ce qu'il faut avoir en
main pour la prendre.

---

## 2. Volume et validité

| Classe | Tronçons | Sans géométrie | Invalides | Auto-intersectées | SRID | km |
|---|---:|---:|---:|---:|---:|---:|
| RN | 621 | 0 | 0 | 0 | 1 | 7 824 |
| RR | 1 029 | 0 | 0 | **1** | 1 | 13 296 |
| RU | 40 | 0 | 0 | 0 | 1 | 36 |

La géométrie est saine : 1 690 tronçons, tous en EPSG:4326, tous valides. Une seule
régionale s'auto-intersecte. Ce n'est pas la géométrie qui fait défaut, c'est la façon
dont les tronçons se rejoignent.

---

## 3. Nœuds

| Mesure | Valeur |
|---|---:|
| Extrémités de tronçons | 3 380 |
| Positions distinctes | **1 883** |
| Extrémités partagées | 1 497 |

Une extrémité sur deux environ est partagée avec un autre tronçon. La numérisation a
utilisé des nœuds communs — c'est une bonne nouvelle, et elle est confirmée par le
tableau suivant.

---

## 4. Connectivité selon la tolérance

| Tolérance | Extrémités connectées | Part |
|---|---:|---:|
| 1 m | 2 603 / 3 380 | **77,0 %** |
| 5 m | 2 605 / 3 380 | 77,1 % |
| 10 m | 2 615 / 3 380 | 77,4 % |
| 50 m | 2 668 / 3 380 | 78,9 % |

Élargir la tolérance cinquante fois ne gagne que 1,9 point. **Les 23 % restants sont
donc de vraies extrémités libres, non des quasi-jonctions ratées.** Un nettoyage par
accrochage à quelques mètres ne changerait presque rien.

---

## 5. Connexions entre classes — le résultat qui décide

| Classe | Extrémités | Vers la même classe | **Vers une autre classe** |
|---|---:|---:|---:|
| RN | 1 242 | 1 108 (89,2 %) | **0** |
| RR | 2 058 | 1 461 (71,0 %) | **0** |
| RU | 80 | 34 (42,5 %) | **0** |

**Zéro.** Pas une seule extrémité ne relie une nationale à une régionale, ni une
régionale à une urbaine. La BDRI contient trois graphes disjoints, pas un réseau. On ne
peut pas aller d'une régionale à une nationale : elles ne se touchent nulle part.

Ce résultat s'explique par la provenance. Les nationales viennent des lots `GN N*` et
OSM, les régionales du lot `RES-*`, les urbaines de lots à préfixe communal. Trois
imports indépendants, jamais raccordés entre eux.

---

## 6. Croisements sans jonction — les candidats au raccordement

| Mesure | Valeur |
|---|---:|
| Paires de tronçons de classes différentes qui se croisent géométriquement | **324** |

Ces 324 paires sont les endroits où deux routes de classes différentes passent l'une
sur l'autre sans partager de sommet. Ce sont les candidats naturels à un
raccordement, et leur nombre dit l'ampleur du travail : de l'ordre de quelques
centaines de jonctions à créer, pas de quelques milliers.

**Aucune n'a été créée.** Raccorder deux tronçons est une modification de géométrie,
irréversible sans sauvegarde, et chaque cas demande un examen : un croisement
géométrique n'est pas toujours une intersection réelle — un pont passe au-dessus
d'une route sans la rejoindre.

---

## 7. Degré des nœuds

| Type | Nœuds | Lecture |
|---|---:|---|
| Degré 1 — extrémité libre | **778** | fin de réseau, frontière, ou rupture |
| Degré 2 — continuité | 752 | deux tronçons bout à bout |
| Degré 3 — intersection | 318 | carrefour à trois branches |
| Degré 4 et plus | 35 | carrefour complexe |

778 extrémités libres pour 1 690 tronçons. Une part est légitime — le réseau a des
bouts, des frontières, des impasses — mais une part correspond aux 324 croisements sans
jonction. Distinguer les deux demande un examen cartographique, cas par cas.

---

## 8. Référencement linéaire

| Classe | Tronçons | PK nuls (0/0) | PK exploitables |
|---|---:|---:|---:|
| RN | 621 | 70 | **551** |
| RR | 1 029 | **1 029** | **0** |
| RU | 40 | 40 | 0 |

Et parmi les 42 désignations de route qui portent des PK : **24 ont un PK de départ
dupliqué**. Sur la RN5, six tronçons commencent à PK 0, et la somme des intervalles
vaut 433 km pour un PK maximum de 156.

Les PK ne forment donc pas un kilométrage continu par route. Ils sont locaux à des
branches d'import. Le routage n'en a pas besoin, mais toute localisation par PK en
dépend — c'est ce qui a bloqué T5.

---

## 9. Ce qui doit précéder tout moteur de routage

| Rang | Chantier | Fondement | Nature |
|---|---|---|---|
| 1 | Examiner les 324 croisements inter-classes | mesuré | cartographique, cas par cas |
| 2 | Créer les jonctions confirmées | après 1 | modification de géométrie, sauvegarde préalable |
| 3 | Mesurer les composantes connexes obtenues | après 2 | ce script, relancé |
| 4 | Traiter les extrémités libres restantes | après 3 | distinguer fin de réseau et rupture |
| 5 | **Alors** choisir un moteur | après 4 | sur des composantes réelles |

Une indication d'orientation, sans engagement : la donnée vivant déjà en PostGIS,
pgRouting travaillerait là où elle est, sans export ni synchronisation. OSRM et
GraphHopper sont bâtis pour le format OpenStreetMap et supposeraient une conversion
permanente. Cette préférence est à confirmer après le rang 4, pas avant.

---

## 10. Ce que ce diagnostic n'a pas fait

- Il n'a créé aucune jonction.
- Il n'a pas calculé les composantes connexes après raccordement, puisqu'aucun
  raccordement n'a eu lieu.
- Il n'a pas qualifié les 778 extrémités libres une à une.
- Il n'a pas choisi de moteur.

Tout cela demande des décisions qui ne sont pas techniques, ou des modifications de
géométrie qui ne se font pas sans validation.

---

## 11. Reproduire

```bash
bash infra/diagnostic-topologie.sh console-bdri-db-1 console_bdri bdri_app
```

Lecture seule. Durée : environ deux minutes sur la base de production.

# BDRI 2.0 — Feuille de route

**Révision du 1er septembre 2026.** Cette version remplace la précédente. Elle est
réécrite après l'inventaire complet des données en production, qui a produit quatre
résultats que la première version ne connaissait pas.

---

## 1. Ce que la mesure a changé depuis la première version

| Découverte | Effet sur la feuille de route |
|---|---|
| **Le réseau est composé de 3 graphes disjoints** — 0 jonction entre RN, RR et RU | Le routage sort de la feuille de route à court terme. Aucun moteur ne franchit un graphe disconnecté. |
| **La provenance est déductible des préfixes de code** — `GN N*`, `*-OSM-*`, `RES-*` | La traçabilité des sources devient un travail d'un jour, pas un chantier. |
| **6 postes de péage/pesage sont récupérables dans le journal d'audit** | Un module réputé vide a une donnée de départ identifiée. |
| **Les longueurs nulles coïncident exactement avec un lot d'import** — `RES-*`, 1 028 tronçons | Ce n'est pas une dégradation à corriger au cas par cas, c'est une étape d'import à rejouer. |

Et une confirmation qui aggrave le constat initial : la **fraîcheur** est la dimension
la plus dégradée de toutes, à 3 dates métier renseignées sur 4 970 attendues. Aucune
donnée de la BDRI ne dit quand le fait qu'elle décrit a été constaté.

---

## 2. La dépendance qui commande tout, inchangée

La première version posait que le terrain est le seul lot producteur de données et que
tous les autres en consomment. Les nouvelles mesures ne contredisent pas ce principe.
Elles ajoutent une nuance.

**Certaines données peuvent être produites sans terrain**, à partir de ce que la base
contient déjà et n'exploite pas :

| Donnée productible sans terrain | Volume | Origine |
|---|---:|---|
| Source d'import de chaque tronçon | 1 689 / 1 690 | préfixe du code |
| Longueur des régionales | 1 028 | géométrie, concordance déjà démontrée |
| Localisation de chantiers par route + PK | 36 | intitulés |
| Rattachement de chantiers à une route | 62 | intitulés |
| Postes de péage et pesage | 6 | journal d'audit |

Ce gisement est immédiat, sans dépendance externe, et sans risque : il ne crée aucune
donnée, il exploite celle qui dort. **Il passe devant tout le reste.**

---

## 3. Ordre révisé

| Lot | Contenu | Pourquoi ici | Dépend de |
|---|---|---|---|
| **2.0** | Clôture du socle | Dette de la Phase 3 | — |
| **2.1** | **Donnée dormante** | Gisement immédiat, sans dépendance | — |
| **2.2** | **Provenance et fraîcheur** | Conditionne la lecture de tout le reste | — |
| **2.3** | Terrain et inspections | Seul lot producteur de données neuves | 2.0 |
| **2.4** | Carte, recherche, fiches | A enfin quelque chose à afficher | 2.1, 2.3 |
| **2.5** | Référentiel administratif | Débloque 61 % de la géolocalisation | **source externe** |
| **2.6** | Qualité des données | Mesure ce que les lots précédents ont produit | 2.2 |
| **2.7** | Topologie du réseau | Raccorder 3 graphes disjoints | — (lourd) |
| **2.8** | Analyse, décision, routage | Exige données **et** topologie | 2.3, 2.6, 2.7 |
| **2.9** | Interopérabilité et design | En continu | — |

**Trois changements par rapport à la version précédente** : un lot « donnée dormante »
apparaît en tête ; la provenance et la fraîcheur passent avant le terrain ; le routage
recule derrière un lot de topologie qui n'existait pas.

---

## LOT 2.0 — Clôture du socle

| Élément | État |
|---|---|
| Sauvegardes planifiées, restauration vérifiée, rapport d'état | **fait** |
| Sonde d'état, compression, index spatial, contrôles d'accès | **fait** |
| Mettre la clé de chiffrement à l'abri hors serveur | **en attente de décision** |
| Déployer la migration `lat`/`lon`/`precisionM` et les correctifs de synchronisation | **en attente de validation** |
| Intégration continue (`ci.yml`) | bloqué par le garde-fou de session |

Le déploiement du correctif terrain bloque le lot 2.3 : sans les colonnes de position,
toute inspection saisie perd son GPS.

---

## LOT 2.1 — Donnée dormante

Le lot le plus rentable de toute la feuille de route : aucune collecte, aucune source
externe, aucun risque d'invention.

| Action | Effet mesuré |
|---|---|
| Renseigner la source depuis le préfixe de code | 1 689 tronçons tracés |
| Exposer une longueur calculée à côté de la longueur saisie | le réseau passe de 7 933 à ~21 156 km, ventilé et justifié |
| Publier la ventilation RN / RR / RU | l'indicateur cesse de mentir par omission |
| Extraire route + PK des intitulés de chantiers, **en proposition** | 6 → 42 chantiers localisés |
| Rattacher les chantiers citant une route | +62 chantiers |
| Restaurer les 6 postes, dédoublonnés | un module vide cesse de l'être |

**Règle absolue de ce lot** : rien n'est écrit automatiquement dans un champ métier.
Chaque valeur dérivée est proposée à un agent, ou stockée dans un champ distinct
marqué comme calculé.

---

## LOT 2.2 — Provenance et fraîcheur

C'est le lot qui rend tous les autres interprétables.

| Action | Justification mesurée |
|---|---|
| Ajouter source, date de constat et méthode aux champs de décision | 0 / 6 questions du §21 ont une réponse aujourd'hui |
| Ajouter un statut de fiabilité par champ, sur 6 champs seulement | un tronçon a une géométrie vérifiée, une longueur absente et un revêtement contredit |
| Requalifier `revetement` en valeur importée non vérifiée | `BITUME` sur 1 690, démenti par 29 intitulés |
| Tracer les créations dans le journal d'audit | 1 690 tronçons créés sans aucune trace |

Le statut est porté **par champ** et non par enregistrement — démonstration dans
`data/BDRI-REFERENTIEL-NATIONAL.md` §5. Six champs, pas vingt-deux.

---

## LOT 2.3 — Terrain et inspections

Inchangé dans son principe : c'est le seul lot qui crée de la donnée neuve.

| Action | État |
|---|---|
| Correctifs doublon et GPS | écrits, **non déployés** |
| Tests automatisés de la file de synchronisation | 9 tests, verts |
| **Test sur téléphone réel** | **non exécuté** — protocole dans `data/BDRI-TERRAIN-TEST.md` |
| Plan d'inspection | à définir — 1 690 tronçons, 5 comptes actifs, 1 inspection |

La dernière ligne est la vraie difficulté, et elle n'est pas technique. Le module
fonctionne ; il n'a pas d'utilisateurs.

---

## LOT 2.4 — Carte, recherche, fiches

À ouvrir seulement quand 2.1 et 2.3 ont produit de quoi remplir un écran. Les fiches
détaillées des §28 et §29 du brief comportent sept rubriques ; aujourd'hui cinq
seraient vides.

Priorité interne, conforme au §36 : carte, recherche, fiche, filtres, tableau de bord,
mobile.

Le §31 s'applique dès ce lot : chaque indicateur doit être calculé, daté, explicable et
cliquable. Un « 1 690 tronçons » qui ne mène nulle part est décoratif.

---

## LOT 2.5 — Référentiel administratif

**Bloqué sur une décision qui n'est pas technique** : quelle source officielle fait foi.

Ce lot ne débloque pas seulement la recherche Région → Préfecture → Commune. Il
débloque **299 chantiers**, soit 61 % du gisement de géolocalisation, parce que les
intitulés portent des noms de lieux et que la base n'a aucune cible à leur opposer :
zéro tronçon porte un nom de localité.

Si le référentiel arrive avec des géométries, le rattachement des 1 690 tronçons se
fait en une requête d'intersection spatiale.

---

## LOT 2.6 — Qualité des données

Le module `DATA QUALITY` du §20, alimenté par les statuts posés en 2.2. Les six
dimensions sont déjà mesurées et documentées dans `data/BDRI-DATA-QUALITY-REPORT.md` ;
ce lot les rend permanentes et visibles dans l'application.

Contrainte du §32 : aucune formule opaque, aucun score global agrégé. Une moyenne des
dimensions masquerait exactement ce que la mesure montre — une qualité excellente sur
la géométrie et nulle sur la provenance.

---

## LOT 2.7 — Topologie du réseau

Lot nouveau, imposé par la mesure.

| Étape | Objet |
|---|---|
| Identifier les nœuds réels du réseau | 77 % des extrémités coïncident déjà à 1 m |
| Raccorder les classes entre elles | **0 jonction RN ↔ RR ↔ RU aujourd'hui** |
| Mesurer les composantes connexes restantes | inconnu avant traitement |
| Traiter les 777 extrémités libres | distinguer fin de réseau et rupture |

C'est un lot lourd et il n'a aucune dépendance externe : il peut démarrer quand on veut.

---

## LOT 2.8 — Analyse, décision, routage

**Ne pas ouvrir avant 2.7.** Le §26 demande de comparer pgRouting, OSRM et GraphHopper
et de recommander. La recommandation ne peut pas être faite sur l'état actuel : les
trois échoueraient identiquement sur un graphe disjoint.

L'aide à la décision suit la même logique. Le §9 est catégorique et la mesure le
confirme : trois des quatre critères sont entièrement vides et le quatrième manque sur
62 % du réseau. Tant que c'est le cas, le module doit être présenté comme un moteur de
priorisation **transparent**, montrant chaque facteur et son absence, jamais comme une
aide à la décision fiable.

En attendant, la règle du §41 tient : une distance à vol d'oiseau ne s'appelle pas un
itinéraire.

---

## LOT 2.9 — Interopérabilité et design

Conforme au §36 : la modernisation de l'interface vient **après** la sécurisation des
données essentielles. Le socle technique n'est plus le facteur limitant ; l'interface
non plus.

---

## 4. Ce que cette feuille de route refuse de faire

| Refus | Motif |
|---|---|
| Remplir les modules vides avec des données de démonstration | §41 |
| Écraser une longueur saisie par une longueur calculée | fait passer un calcul pour une donnée métier |
| Remplacer `BITUME` par une autre supposition | aucune source ne le permet |
| Géocoder un nom de lieu sans référentiel ni validation | §18 |
| Choisir un moteur de routage avant d'avoir un graphe connecté | comparerait des outils sur un problème qu'aucun ne résout |
| Publier un score global de qualité | masquerait le seul enseignement utile |
| Appeler « itinéraire » une distance à vol d'oiseau | §41 |

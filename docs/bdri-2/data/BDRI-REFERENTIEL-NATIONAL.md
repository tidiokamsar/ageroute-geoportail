# Architecture du futur référentiel routier national

**Date** : 1er septembre 2026
**Objet** : ce que la BDRI doit devenir pour être une source de vérité, et ce que les mesures imposent avant d'y prétendre.

---

## 1. Le point de départ, mesuré

La BDRI a un socle géographique solide et une attribution presque vide.

| Acquis | Mesure |
|---|---|
| Géométrie valide | 1 690 / 1 690, SRID homogène, 0 doublon |
| Référencement linéaire | `pkDebut` / `pkFin` sur 1 690 / 1 690 |
| Ouvrages localisés | 124 / 126, dont 114 rattachés à un tronçon |
| Référentiels internes | régions, bailleurs, matrices, barèmes — peuplés |

| Manque | Mesure |
|---|---|
| Provenance | 0 champ, 0 trace d'audit sur les créations |
| Fraîcheur | 3 dates métier sur 4 970 attendues |
| Caractérisation des tronçons | 8,6 % |
| Continuité du réseau | **0 jonction entre classes** |

---

## 2. Le réseau n'est pas un réseau — la découverte qui commande l'architecture

Le §25 demande d'analyser connexions, nœuds, continuité et intersections. La mesure
donne un résultat sans ambiguïté.

**Connectivité globale** — extrémités de tronçons coïncidant avec l'extrémité d'un autre :

| Tolérance | Extrémités connectées | Part |
|---|---:|---:|
| 1 m | 2 603 / 3 380 | **77,0 %** |
| 10 m | 2 615 / 3 380 | 77,4 % |
| 50 m | 2 668 / 3 380 | 78,9 % |

Élargir la tolérance cinquante fois ne gagne que 1,9 point. Les 23 % restants sont donc
de véritables extrémités libres, non des quasi-jonctions ratées. La numérisation a été
faite avec des nœuds partagés — c'est une bonne nouvelle.

**Connectivité entre classes** — et c'est là que tout se joue :

| Classe | Extrémités | Connectées à la même classe | **Connectées à une autre classe** |
|---|---:|---:|---:|
| RN | 1 242 | 1 108 (89,2 %) | **0** |
| RR | 2 058 | 1 461 (71,0 %) | **0** |
| RU | 80 | 34 (42,5 %) | **0** |

**Zéro.** Pas une seule extrémité ne relie une nationale à une régionale, ni une
régionale à une urbaine.

La BDRI contient donc **trois graphes disjoints**, pas un réseau national. On ne peut
pas aller d'une régionale à une nationale : elles ne se touchent nulle part.

Ce résultat s'explique par la provenance. Les codes portent la marque de leur import :

| Famille de code | Classe | Tronçons | Densité | Longueur renseignée |
|---|---|---:|---:|---:|
| `GN N*` | RN | 551 | 11,2 pts/km | 551 / 551 |
| `*-OSM-*` | RN | 70 | 18,1 pts/km | 70 / 70 |
| `RES-*` | RR | **1 028** | **2,1 pts/km** | **0 / 1 028** |
| autre | RU | 40 | 26,4 pts/km | 40 / 40 |

Trois sources indépendantes, importées séparément, jamais raccordées entre elles. Et
le problème des longueurs nulles coïncide **exactement** avec la famille `RES-*` : un
seul lot, une seule étape d'import manquante.

---

## 3. Conséquence directe sur le routage (§26)

**Il ne faut pas choisir de moteur de routage maintenant.**

pgRouting, OSRM et GraphHopper échoueraient tous les trois de la même façon, parce
qu'aucun ne peut router sur un graphe où les composantes ne se touchent pas. Comparer
leurs mérites avant d'avoir un graphe connecté serait comparer des outils sur un
problème qu'aucun ne résout.

L'ordre correct est :

1. **Construire la topologie** — identifier les nœuds, raccorder les classes entre
   elles aux points d'intersection réels, mesurer les composantes connexes restantes.
2. **Mesurer** combien de composantes subsistent et quelle part du réseau la plus
   grande couvre.
3. **Alors seulement** choisir un moteur, sur des critères devenus concrets.

Une indication d'orientation, sans engagement : la donnée étant déjà en PostGIS avec
un référencement linéaire complet, **pgRouting** a l'avantage de travailler là où la
donnée vit, sans export ni synchronisation. OSRM et GraphHopper sont bâtis pour le
format OpenStreetMap et supposeraient une conversion permanente. Mais cette préférence
doit être confirmée après l'étape 1, pas avant.

**En attendant** : la règle du §41 s'applique sans exception. Une distance à vol
d'oiseau ne doit jamais être appelée « itinéraire ». La correction apportée au ticket
T3 — le bouton ne promet plus un itinéraire qu'il ne calcule pas — reste la bonne
posture tant que le graphe est disjoint.

---

## 4. Identifiants (§24)

| Identifiant | Nature | Stable ? |
|---|---|---|
| `id` | UUID technique | **oui** — ne dépend d'aucune source |
| `code` | dérivé de la source d'import | **non** |

Le `code` est aujourd'hui l'identifiant que lisent les humains, et c'est un artefact
d'import : `RES-972`, `GN N0003 2`, `RN6-OSM-10`. Un ré-import depuis une autre source
produirait d'autres codes pour les mêmes routes.

C'est exactement le risque que le §24 signale : un objet patrimonial ne doit pas changer
d'identité parce que la base a été migrée.

**Recommandation** :

- l'`id` UUID reste la clé technique, jamais affichée, jamais réutilisée ;
- un **identifiant patrimonial national** est introduit, attribué par AGEROUTE, stable
  par construction, indépendant de toute source ;
- le `code` d'import est conservé comme **référence externe**, à côté et non à la place,
  avec le nom de la source qui l'a produit.

Cette dernière colonne a un bénéfice immédiat : la source de 1 689 tronçons sur 1 690
est déjà déductible de leur préfixe de code. La provenance peut être renseignée
rétroactivement, sans enquête, dès aujourd'hui.

---

## 5. Provenance et statut de fiabilité (§21, §22)

Le §22 demande d'étudier un statut avant de l'introduire. L'étude donne ceci.

Statut proposé, porté **par champ** et non par enregistrement :

| Statut | Signification | Exemple mesuré |
|---|---|---|
| `NON_RENSEIGNE` | le champ est vide | trafic, criticité, coût — 0 / 1 690 |
| `IMPORTE` | valeur entrée sans vérification | `revetement` = `BITUME` sur 1 690 |
| `CALCULE` | dérivée d'une autre donnée | longueur issue de `ST_Length` |
| `CONTROLE` | recoupée avec une seconde source | longueur RN, concordante à ≤ 1 % |
| `VALIDE` | confirmée par un agent identifié, à une date | aucun cas aujourd'hui |
| `OBSOLETE` | dépassée par un constat plus récent | aucun cas aujourd'hui |

### Pourquoi par champ et non par enregistrement

C'est le point que l'étude tranche, et il est décisif. Un tronçon typique a
aujourd'hui une géométrie **vérifiée**, une longueur **absente**, et un revêtement
**contredit**. Un statut unique pour l'objet entier devrait choisir entre ces trois
niveaux et perdrait l'information utile.

### Le coût de cette décision, qu'il faut assumer

Un statut par champ multiplie les colonnes ou impose une table annexe. Ce n'est pas
gratuit et cela ne doit pas être généralisé d'un coup.

**Recommandation** : commencer par les champs qui alimentent une décision — état,
longueur, revêtement, trafic, criticité, coût — et laisser les autres sans statut.
Six champs sur les tronçons, pas vingt-deux.

### Le préalable de la fraîcheur

Un statut sans date ne vaut rien. `CONTROLE` sans date de contrôle ne dit pas si le
contrôle remonte à un mois ou à dix ans. Chaque statut doit donc porter :

- la **date** du constat ;
- la **source** ou l'auteur ;
- la **méthode** — relevé terrain, import, calcul, dire d'expert.

C'est ce triplet, et non le statut seul, qui répond aux six questions du §21.

---

## 6. Le référentiel administratif (§19) — le nœud du problème

`prefecture` et `commune` sont vides sur les 1 690 tronçons. Seule la région existe,
et l'une des neuf « régions » s'appelle « Non renseigné », ce qui fait passer une
absence pour une donnée.

**Ce que ce blocage empêche, au-delà de la recherche administrative** :

| Fonction bloquée | Ampleur |
|---|---|
| Recherche Région → Préfecture → Commune → Localité | totalité |
| Géolocalisation des chantiers par nom de lieu | **299 chantiers, 61 %** |
| Rattachement administratif des tronçons | 1 690 |
| Statistiques par préfecture | totalité |

Le §19 n'est pas une fonctionnalité de confort. Il est le préalable du plus gros
gisement de géolocalisation identifié — voir `BDRI-CHANTIERS-GEOLOCALISATION.md` §5.

**Ce que je ne peux pas faire** : désigner la source officielle. Le découpage
administratif guinéen relève de l'Institut national de la statistique et des services
compétents ; je n'ai pas accès à leurs référentiels et je n'inventerai pas une liste
de préfectures.

**Ce que la décision doit trancher** :

| Question | Pourquoi elle est bloquante |
|---|---|
| Quelle source fait foi ? | deux découpages concurrents produiraient deux vérités |
| Avec ou sans géométries ? | sans polygones, aucun rattachement automatique n'est possible |
| À quelle date de validité ? | les découpages évoluent, un référentiel non daté vieillit en silence |
| Qui le met à jour ? | sans propriétaire, il se figera comme le reste |

**Ce qui est faisable sans attendre** : si le référentiel arrive avec des géométries,
le rattachement des 1 690 tronçons est immédiat par intersection spatiale, sans saisie.
La géométrie étant complète et valide à 100 %, ce rattachement se ferait en une requête.

---

## 7. Architecture cible

```
                    SOURCES
   INS / DNC        Terrain          Marchés         Postes de
   (administratif)  (inspections)    (contrats)      comptage
        |                |               |               |
        +----------------+---------------+---------------+
                         |
                  [ VALIDATION ]
          source + date + méthode + auteur
                         |
                 REFERENTIEL NATIONAL
     +-------------------+--------------------+
     |                   |                    |
  Patrimoine        Topologie            Attribution
  id stable         noeuds, arcs         etat, trafic,
  geometrie         composantes          cout, criticite
  PK                                     + statut par champ
     |                   |                    |
     +-------------------+--------------------+
                         |
                       API
              publique  /  privee
                         |
        +----------------+----------------+
        |                |                |
      CARTE          ANALYSE          DECISION
                     routage,         priorisation
                     reseau           explicable
                         |
                 APPLICATIONS METIERS
```

Deux principes structurent ce schéma :

**La validation est un passage obligé, pas une étape optionnelle.** Aucune flèche ne
contourne le bloc validation. Une donnée qui entre sans source, sans date et sans
méthode entre comme `IMPORTE`, et l'interface doit le montrer.

**L'attribution est séparée du patrimoine.** L'identité et la géométrie d'un tronçon
changent rarement ; son état change à chaque inspection. Les mélanger dans une même
table oblige à réécrire l'objet patrimonial pour enregistrer un constat, ce qui est
précisément ce qui a fait perdre l'historique jusqu'ici.

---

## 8. Ce qui doit être fait dans l'ordre

| Rang | Chantier | Pourquoi à ce rang | Dépend de |
|---|---|---|---|
| 1 | Provenance rétroactive depuis les préfixes de code | déductible aujourd'hui, sans enquête, sur 1 689 / 1 690 | rien |
| 2 | Date et méthode sur les champs de décision | sans date, aucun statut n'a de sens | rien |
| 3 | Longueur calculée exposée à côté de la longueur saisie | concordance déjà démontrée sur 662 cas | rien |
| 4 | Référentiel administratif | débloque 61 % de la géolocalisation des chantiers | **source officielle** |
| 5 | Rattachement spatial des tronçons | une requête, si le référentiel a des géométries | 4 |
| 6 | Construction de la topologie | 3 graphes disjoints à raccorder | rien, mais lourd |
| 7 | Choix du moteur de routage | n'a pas de sens avant | 6 |
| 8 | Identifiant patrimonial national | décision de nommage AGEROUTE | arbitrage |

Les rangs 1, 2, 3 et 6 ne dépendent d'aucune donnée externe et peuvent commencer sans
attendre personne. Le rang 4 attend une décision qui n'est pas technique.

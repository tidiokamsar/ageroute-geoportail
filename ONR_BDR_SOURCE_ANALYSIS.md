# Analyse des sources ONR, BDR nationale et écosystème L²R

> Livrable 1 du § B.6 du prompt maître V10. Le § B.1 impose de **distinguer systématiquement**
> cinq natures d'énoncé, et ce document est organisé par cette distinction :
>
> 1. **exigences ou objectifs exprimés par la source** ;
> 2. **éléments présentés comme existants à la date du document** ;
> 3. **propositions commerciales de l'éditeur** ;
> 4. **état actuel vérifié** par inspection ou preuve ;
> 5. **mes recommandations**, toutes étiquetées **« proposition »**.
>
> 🔒 Interdits par le § B.1 : affirmer qu'AGEROUTE doit remplacer le Géoportail par L²R ;
> affirmer que les logiciels L²R sont actifs ; reprendre les chiffres 2020 du TDR comme
> situation actuelle.

**Rédigé le 14/10/2026.**

## 0. Ce que ce document a réellement lu, et ce qu'il n'a pas lu

**Lu** : la partie B du prompt maître V10, qui cite et résume les sources ; le dépôt et sa base
(mesures des 13 et 14/10).

**Non lu dans cette session** : les pages sources elles-mêmes —
`onrguinee.org/tdr-bdr-guinee/`, `onrguinee.org/connaitre-lonr/`,
`onrguinee.org/collecte-de-donnees-geographiques/`, `logiroad.fr/en/`. Tout ce qui est attribué
ci-dessous à ces pages l'est **par l'intermédiaire du mandat**, et doit être confronté aux pages
avant toute décision. C'est la première action du § 5. La directive 11/2009/CM/UEMOA n'est
connue que par des tableaux en images (cf. `RCI_METHOD_DECISION.md`).

---

## 1. Ce que les sources EXPRIMENT comme exigences ou objectifs

Attribué aux termes de référence de la BDR nationale (ONR, proposition technique Logiroad,
**mai 2023**), tels que le § B.1 les rapporte :

- une **base routière nationale** construite depuis la nomenclature des routes et des tracés GPS
  ou une base géographique existante, à **administrateur unique**, consultée en intranet ;
- un **relevé visuel en roulage** sur tablette Android, chaque touche valant un type de
  dégradation × gravité positionné par le GPS du véhicule, puis importé en base ;
- des **notes d'état structurel par sections de longueur fixe, 100 ou 200 m**, et des
  « stratégies » paramétrables produisant des **pré-programmes d'entretien à 2–3 ans** classés par
  priorité ;
- une **méthodologie régionale harmonisée** : directive 11/2009/CM/UEMOA, dont le programme étend
  la méthode à la Guinée bien qu'elle **ne soit pas membre** de l'UEMOA ;
- des comptages par analyse vidéo, une détection automatique de nids-de-poule, une cartographie
  des gisements de matériaux, des annuaires statistiques, le suivi des charges à l'essieu et de
  l'**agressivité moyenne** du trafic.

Et la mission de l'ONR telle que le § B.5 la décrit : collecte, traitement et diffusion ;
inspection périodique ; dégradations ; trafic ; pesée ; niveau de service ; mise à jour de la
BDR et du SIG ; annuaire statistique ; estimation des besoins et coûts ; programmes annuels et
pluriannuels.

**Ce qu'il faut retenir, et qui engage le Géoportail** : « parler ce langage » — sections fixes,
notes UEMOA, relevé en roulage — est la condition de la **comparabilité sous-régionale**. Le
dépôt a commencé à le parler le 14/10 avec la vue dérivée des sections fixes (IO-04), **sans la
note UEMOA**, faute du texte de la directive.

---

## 2. Ce que les sources PRÉSENTENT comme existant à leur date

| Élément | Date de la source | Statut à retenir |
|---|---|---|
| Chiffres du réseau : 7 576 km nationales, 15 879 km préfectorales, 19 846 km communautaires, ≈ 2 000 km urbaines, ≈ 45 300 km | **2020**, TDR | **historiques**. Le § B.1 interdit de les reprendre comme situation actuelle. Ils servent ici de **référence de complétude**, et la base mesurée en porte 48 % (D-06) |
| Suite L²R proposée pour la BDR | **mai 2023**, proposition technique | une **proposition**, pas un déploiement constaté |
| Atelier BDR, 46 agents formés et certifiés, 46 tablettes Android avec SIM, 8 protocoles régionaux, application **ANASUR Collect** | **8–9 juillet 2026**, ministère des Infrastructures | **annoncé**. Confirme l'initiative et l'équipement, ne documente ni éditeur, ni formats, ni API (voir `ANASUR_COLLECT_SOURCE_REVIEW.md`) |

**Le déploiement effectif des outils L²R à l'ONR n'est pas établi.** Le § B.1 le dit lui-même :
« à vérifier ». Rien dans ce que j'ai lu ne permet d'affirmer qu'une base L²R tourne aujourd'hui
à l'ONR, ni l'inverse.

---

## 3. Ce qui relève de l'offre COMMERCIALE de l'éditeur

Logiroad (France, une quinzaine de pays) commercialise aujourd'hui sa plateforme sous le nom
**Logiroad Center** : module **ROAD** (état de chaussée, **21 types de défauts**, images 360°
tous les 5 m, recommandations de travaux, priorisation sur 6 ans), module **CITY** (signalisation,
marquage, mobilier urbain), application **Miranda Track** (profil longitudinal par smartphone).

Deux conséquences, et aucune n'est une décision :

- **le nom et le format des produits peuvent différer** de ceux cités dans les TDR de 2023 (L²R
  Base / Mesure / Uni / Programme / Vidéo). Avant tout adaptateur, **confirmer avec l'ONR la
  génération réellement déployée** ;
- le § 7.16 du mandat retient Logiroad Center comme **plancher fonctionnel à égaler puis
  dépasser**, pas comme produit à acquérir. La supériorité « se mesure, ne se proclame pas »
  (arbitrage D13).

---

## 4. État actuel VÉRIFIÉ dans le dépôt

Mesuré les 13 et 14/10/2026, par inspection du code et requêtes en base.

| Capacité que les sources décrivent | Preuve dans le produit | Verdict |
|---|---|---|
| Base routière nationale, nomenclature | 261 387 tronçons dont 1 691 classés ; énumération `ClasseRoute` **sans valeur** pour les communautaires ; **aucun code national** | partiel, bloqué par D-06 |
| Relevé visuel en roulage | chaîne de collecte écrite et testée, **0 observation** ; roulage (§ 7.13) **non commencé** | absent sur le terrain |
| Sections fixes 100/200 m | `reseau_sections_fixes`, 14 assertions, somme = longueur, portion dominante | **livré le 14/10**, sans note UEMOA |
| Notes d'état structurel UEMOA | **aucune** : texte de la directive non disponible | absent, bloqué |
| Pré-programmes d'entretien | `baremes_intervention` 9 l., `matrices_degradation` 9 l., **lus par aucun code** | absent |
| Comptages, charges à l'essieu | **aucune table**, aucun flux | absent |
| Gisements de matériaux | **aucune table** | absent |
| Nids-de-poule automatiques | 13 types au catalogue, aucune détection ; corpus d'abord (D9) | absent |
| Annuaire statistique | API publique `/api/public/carte/geo` avec `methode` et `calculeeA` ; aucun extrait ONR (IO-08) | partiel |
| Alignement avec la BDR, échanges | **aucun flux entrant** ; une intégration **sortante** existe vers DigitalRoad/SharePoint (`DATA_SOURCE_OF_TRUTH.md` § 1) | absent côté ONR |

**Un point corrige ce que je pensais** : le dépôt n'est pas sans intégration. Il en a une, en
lecture, vers DigitalRoad. Elle prouve qu'une clé d'échange stable (`code Route-Type-PK`) peut
être conçue pour qu'un tiers **nomme sans copier** — le modèle à reprendre pour l'ONR.

---

## 5. Recommandations — toutes « proposition »

| # | Proposition | Pourquoi maintenant | Dépend de |
|---|---|---|---|
| P-1 | **Lire les quatre pages sources** et confronter ce document ligne à ligne | tout ce qui précède passe par le mandat | rien — pages publiques |
| P-2 | **Demander à l'ONR / Logiroad les formats L²R** : import Mesure, exports Base, entrées/sorties Programme, et **la génération déployée** | le § B.1 le demande « dès le lot 0 » ; sans cela, tout adaptateur est une hypothèse | courrier institutionnel |
| P-3 | **Demander le texte de la directive 11/2009** et ses neuf indices | bloque la note UEMOA (IO-03) et la réapprobation du RCI (D-01) | ONR ou Commission UEMOA |
| P-4 | **Format pivot ouvert d'abord** — CSV + GeoPackage + GeoJSON, SRID 4326, documentés — et adaptateurs L²R derrière des interfaces avec bouchons testés | le § B.1 l'impose ; le pivot ne dépend d'aucune réponse | rien |
| P-5 | **Consigner l'hypothèse d'architecture** du § B.1 (ONR dépositaire de la nomenclature et des statistiques, AGEROUTE gestionnaire opérationnel) **en D-08**, comme hypothèse à faire confirmer | elle conditionne IO-01 et la codification | décision institutionnelle |
| P-6 | **Ne rien construire qui dépende d'un outil L²R actif** | déploiement non établi (§ 2) | — |

**Ce que ce document ne recommande pas, et ne recommandera pas** : remplacer le Géoportail par
L²R, ou présumer que L²R est en service à l'ONR. Les deux sont interdits par le § B.1, et rien
dans les sources lues ne les justifierait.

# Étalon fonctionnel Logiroad Center (§ 7.16)

> Confrontation, ligne par ligne, du plancher fixé par le § 7.16 du prompt maître V10 avec ce qui
> **existe réellement** dans le dépôt au 20/10/2026. Chaque état cite sa preuve ou la cause du
> manque. ★ : point où BDRI doit dépasser l'éditeur.
>
> **Ce document ne compare pas BDRI à Logiroad Center tel qu'il fonctionne** : je n'ai pas accès au
> produit. Il compare BDRI à la colonne « équivalent exigé » du mandat, qui fait foi.

Légende : **FAIT** (implémenté et testé) · **PARTIEL** · **ABSENT** · **BLOQUÉ** (cause externe).

| # | Capacité de référence | État BDRI | Preuve, ou ce qui manque |
|---|---|---|---|
| 1 | Notation de l'état, 21 types de défauts | **PARTIEL** | catalogue **31 types**, revêtu / non revêtu ★ (`field/catalogue-defauts.referentiel.ts`, 22 tests) ; sections fixes faites (IO-04). **Manquent** : l'indice d'état (RCI écrit mais **désapprouvé**) et la note UEMOA sur sections fixes |
| 2 | Images 360° tous les 5 m, sur la carte | **BLOQUÉ** | vue de route et imagerie continue relèvent de la collecte en roulage (§ 7.13), qui attend l'application mobile (B-10) |
| 3 | Carte du réseau par année (passé, présent, futur) | **PARTIEL** | l'historisation **bitemporelle** existe en base (§ 7.2, exclusion corrigée sur l'axe terrain). **Manquent** : le curseur temporel à l'écran et la carte des années futures, qui suppose des scénarios de programmation |
| 4 | Recommandations de travaux, quantités, coûts | **PARTIEL / BLOQUÉ** | catalogue des traitements créé (non approuvé) ; moteur de coût qui **refuse** sans ligne de barème (`engines/cout.noyau.ts`). **Manquent** : la matrice d'orientation ; les barèmes attendent D-07, l'état attend la règle RCI |
| 5 | Priorisation sur 6 ans par lois de vieillissement et d'effet | **ABSENT** | lois de vieillissement **identifiées** (`matrices_degradation`) mais lues par aucun code ; cycle de vie des interventions gardé (`programmation/cycle-vie.noyau.ts`). PPE 3–6 ans, optimisation par source de financement ★ : absentes, et dépendantes de 1 et 4 |
| 6 | Suivi budgétaire par trimestre | **ABSENT / BLOQUÉ** | le réalisé doit remonter de DigitalRoad (B-11, aucun accès) |
| 7 | Export Excel des programmes (BPU, DQE) | **ABSENT** | aucun programme n'existe encore à exporter (dépend de 5) |
| 8 | Module CITY : signalisation, marquage, mobilier | **PARTIEL** | les **actifs linéaires** sont modélisés (`ouvrages.geomLigne`, migration `20261013240000`). **Manque** : l'inventaire et la notation en roulage (T-15), qui attendent le mobile |
| 9 | Profil longitudinal par smartphone (IRI) | **BLOQUÉ** | l'inspection porte un `iriEstime` saisi avec sa méthode (D8) ; l'estimation par capteurs du téléphone attend le mobile (B-10) et un étalonnage |
| 10 | Gestion documentaire, multi-réseaux | **PARTIEL** | base documentaire en service ; liens SharePoint **bloqués** (B-12) ; zones de responsabilité multi-gestionnaires : **décision D-11** (les comptes ne portent aucune région) |
| 11 | Partage et communication | **PARTIEL** | carte publique en service ; **Info Route publique** ★ (`/api/public/info-route`) et bulletin quotidien (20/10) ; rapport bailleur (non déployé). **Manquent** : permaliens, données ouvertes OGC |
| 12 | Décarbonation des techniques | **ABSENT** | l'empreinte carbone par traitement (PR-15) suppose des facteurs d'émission approuvés, qu'aucune source ne fournit au dépôt |
| 13 | ★ Praticabilité saisonnière, incidents, déviations routables | **PARTIEL** | niveaux P1–P4 **provisoires non approuvés** (D-02) ; incidents en main courante immuable ; déviations publiées en texte sur l'Info Route ; **graphe du réseau** et **déviation routée** faits (20/10, `POST /api/v2/geo/deviation`). **Manquent** : l'écran, les sens uniques (absents du référentiel), la praticabilité des routes empruntées (D-02) |
| 14 | ★ Collecte en roulage, événements Début / Fin | **BLOQUÉ** | § 7.13, application mobile (B-10) |
| 15 | ★ Référentiel ISO 19148 bitemporel, topologie routable, gazetier | **PARTIEL** | bitemporalité et portions faites ; **topologie** : graphe construit en mémoire depuis la géométrie (jonctions en T, `geo/graphe.noyau.ts`), non persisté ; **gazetier** absent, il attend la codification nationale (D-06) |
| 16 | ★ Interopérabilité BDR nationale, méthode UEMOA | **PARTIEL** | sections fixes, pivot CSV/GeoJSON, import étape 1 idempotent, 15 livrables du § B.6. **Manquent** : formats L²R (non publiés), étape 2 de l'import (échantillon approuvé) |
| 17 | PRISM : main courante, patrouilles, publication, niveaux de circulation | **FAIT** (sauf tiers) | main courante immuable, patrouilles programmées à couverture mesurée, Info Route, bulletin, cellule de veille ★ saison des pluies (EX-01 à EX-06, EX-08). **Bloqués** : Waze/CIFS, DATEX II, notification des escalades |
| 18 | Citylogix : jumeau numérique, cartes de chaleur, IRI continu par flottes | **ABSENT / BLOQUÉ** | cartes de chaleur (X-19) absentes ; ingestion télématique (T-16, T-17) sans convention ni accès ; LiDAR en import optionnel non commencé |

## Bilan

| État | Lignes |
|---|---|
| FAIT | 1 (17) |
| PARTIEL | 9 (1, 3, 4, 8, 10, 11, 13, 15, 16 — la 4 en partie bloquée) |
| ABSENT | 5 (5, 6, 7, 12, 18 — la 6 et la 18 aussi faute d'accès) |
| BLOQUÉ par un accès | 3 (2, 9, 14) |
| **Total** | **18** |

**Le plancher n'est pas atteint.** Ce qui l'en sépare tient en trois verrous, et aucun n'est un
développement manquant de ma part :

1. **L'application mobile** (B-10) : lignes 2, 8, 9, 14, et une part de 18.
2. **Les décisions sur l'état et les coûts** (règle RCI, D-02, D-07) : lignes 1, 4, 5, 7, et par
   ricochet 3 (années futures).
3. **Les accès tiers** (DigitalRoad, SharePoint, partenaires) : lignes 6, 10, 17, 18.

Restent exécutables sans eux : permaliens et données ouvertes OGC (11), calcul d'itinéraire de
déviation sur le graphe (13), curseur temporel à l'écran (3), persistance de la topologie (15).

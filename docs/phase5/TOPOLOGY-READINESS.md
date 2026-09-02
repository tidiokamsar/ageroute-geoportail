# Préparation du routage — conditions de sortie TOPOLOGY_READY

**Ticket** : P5-11
**Date** : 2 septembre 2026
**Décision Phase 4 maintenue** : ne pas choisir pgRouting / OSRM / GraphHopper maintenant.

---

## 1. Ce que la Phase 5 ajoute aux mesures topologiques

| Mesure | Valeur | Source | Statut |
|---|---|---|---|
| Composantes par **intersection géométrique** (croisement quelconque) | **1 seule composante pour les 1 690 tronçons** | Phase 5, `ST_ClusterIntersecting` | MEASURED |
| Jonctions d'**extrémités** interclasses | **0** (RN 0, RR 0, RU 0) | Phase 4, tolérances 1–50 m | MEASURED |
| Extrémités connectées (toutes classes) | 77,0 % à 1 m ; élargir à 50 m ne gagne que 1,9 pt | Phase 4 | MEASURED |
| RES-* croisant ≥ 1 autre tronçon | 993/1 028 (96 %) | Phase 5 `autopsie-res.sh` | MEASURED |

**La synthèse des deux mesures** est le résultat le plus important de la phase
pour le routage : le réseau BDRI est **un réseau « plat »** — les tracés se
croisent partout (une seule composante d'intersection), mais **aucune extrémité
ne raccorde les classes entre elles**. Les graphes ne sont pas disjoints au sens
géométrique ; ils sont disjoints au sens **topologique** : un moteur de routage,
qui construit ses nœuds sur les extrémités (ou sur un noding explicite des
croisements), verra trois réseaux non connectés — ou devra inventer des jonctions
aux croisements, ce qui est une modification de topologie, donc une décision.

---

## 2. Les conditions de sortie TOPOLOGY_READY (critères du cadrage)

`TOPOLOGY_READY` ne sera prononcé que lorsque **toutes** les lignes suivantes
seront vraies et mesurées :

| # | Condition | État au 02/09/2026 | Ce qui manque |
|---|---|---|---|
| 1 | Classes correctement périmétrées (RN/RR/RU signifient quelque chose d'officiel) | **non** — périmètre non défini (P5-04) | décision D1–D2 |
| 2 | Jonctions connues (nœuds partagés identifiés, croisements explicités) | **non** — croisements non nodés, 0 jonction interclasse | construction topologique après périmètre |
| 3 | Composantes expliquées (chaque composante résiduelle a une cause documentée) | **partiel** — 1 composante géométrique, mais l'explication par lot (RES vs RN vs OSM-direct) est établie | re-mesure après noding |
| 4 | Connexions interclasses validées (décision humaine par raccordement) | **non** — aucun raccordement à ce jour | tous les raccords à décider un par un |
| 5 | Géométries cohérentes (valides, SRID homogène) | **oui** — 1 690/1 690 valides, 4326 | — |
| 6 | Nœuds constructibles sans inventer de jonctions | **non** — noding aux croisements = invention de jonctions tant que non validées | plan de noding + validation |

---

## 3. Le chemin proposé vers TOPOLOGY_READY (aucun exécution en Phase 5)

1. **Décision de périmètre** (P5-04 D1–D2) — sinon on construit la topologie
   d'un réseau dont 63 % du linéaire est de provenance inconnue.
2. **Plan de noding documenté** : pour chaque croisement interclasse, proposer le
   nœud (position exacte, classes concernées), le faire valider par lot, puis
   l'écrire — chaque écriture audité (règle 3 d'AGENTS.md), dans une migration
   réversible.
3. **Re-mesure** : composantes après noding ; l'objectif n'est pas « 1 composante »
   à tout prix — un réseau réel a des composantes légitimes (îles, pistes isolées)
   — mais des composantes **expliquées**.
4. **Alors seulement** choisir le moteur (l'indication pgRouting, donnée en
   Phase 4 pour la cohérence PostGIS, reste une indication).

---

## 4. La règle intangible en attendant

Déjà posée en Phase 4 et maintenue : **une distance à vol d'oiseau ne sera
jamais présentée comme un itinéraire**. L'interface ne le promet pas ; aucune
donnée ne le laisse croire.

**Statut** : mesures MEASURED ; conditions de sortie spécifiées ; leur
réalisation REQUIRES_BUSINESS_VALIDATION (périmètre d'abord).

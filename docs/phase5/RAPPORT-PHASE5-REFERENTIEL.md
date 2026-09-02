# RAPPORT PHASE 5 — RÉFÉRENTIEL NATIONAL PRÊT POUR DÉCISION

**Période** : 2 septembre 2026
**Base** : branche `phase5` (dépôt `tidiokamsar/ageroute-geoportail`), coupée du HEAD Phase 4 `da86392`
**Environnement** : toutes les mesures sur copie restaurée (conteneur `phase5-analyse`, sauvegarde `bdri_20260902_030001`), lecture seule — **aucune écriture en production, aucune donnée métier modifiée, aucun déploiement**.

---

## 0. Ce que la phase a produit

| Livrable | Contenu |
|---|---|
| `RES-LOT-ANALYSIS.md` | autopsie des 1 028 RES-* : typologie, morphologie, géographie |
| `OSM-BDRI-DEEP-COMPARISON.md` | matrice par famille — l'hypothèse RN=primary/RR=secondary/RU=tertiary testée et rejetée |
| `OSM-MISSING-NETWORK.md` | les routes OSM absentes, catégorisées (6 947 km candidats) |
| `REFERENTIEL-PERIMETRE-BDRI-PHASE5.md` | l'état factuel du périmètre |
| `REFERENTIEL-ADMINISTRATIF-SPEC.md` | spécification du référentiel manquant |
| `CHANTIER-PROPOSALS-PHASE5.md` | parcours de validation humaine des localisations |
| `MATRICE-CONFIANCE-DONNEES.md` | ce que nous savons et pourquoi nous le savons |
| `TOPOLOGY-READINESS.md` | conditions de sortie vers le routage |
| `INTEGRATION-AGEROUTE.md` | la BDRI référentiel, pas ERP |
| `BACKUP-KEY-DECISION.md` | la clé de sauvegarde : options, décision attendue |
| `REFERENTIEL-ARCHITECTURE-CIBLE.md` | ROAD_OBJECT, versionné, sourcé |
| `REGISTRE-VERITE-BDRI.md` | **le registre central** |
| `donnees/*.tsv` | mesures brutes reproductibles (4 fichiers) |
| `infra/phase5/*.sh`, `infra/osm/extraire-chemin-wkt.py`, `infra/phase5/visualisation-res.html` | scripts reproductibles + outil de visualisation hors production |

Méthode commune : échantillonnage 100 m, seuils explicites et modifiables,
lecture de la source legacy `sig_routier` (vivante) plutôt que déduction,
statut systématique `MEASURED / INFERRED / EXTERNAL_SOURCE / UNKNOWN /
REQUIRES_BUSINESS_VALIDATION`.

---

## 1. Les huit questions du cadrage

### QUESTION 1 — Que sont les `RES-*` ?

Des lignes de géométrie pure importées dans l'ancien SIG (`reseau_routier_import`)
sans aucun attribut ni provenance — même la base legacy ne savait rien d'elles
(0 nom, 0 région, 0 état sur 1 028, colonnes `source`/`origine`/`date` vides).
Devenues RR par défaut à la migration (code de repli `RES-<ogc_fid>`).
Elles ne décrivent **ni** les routes OSM classées (0 à 3 % selon la nature),
**ni** les pistes OSM (1 024/1 028 sous 20 % de proximité) : c'est un référentiel
distinct, dense, schématique (2,1 sommets/km), interconnecté (96 % croisent un
autre tronçon), concentré sur Kankan/Labé/Kindia. 245 d'entre eux (3 144 km)
n'ont **rien** de connu à 250 m. L'institution d'origine reste **UNKNOWN** —
enquête Direction Technique requise. *(Résultat utile : la question a une
formulation précise à poser, et 1 028 fiches pour y répondre.)*

### QUESTION 2 — Pourquoi RR BDRI et OSM ne se recouvrent-ils presque pas ?

Parce que le lot RR est à 98,8 % composé des RES-*, qui viennent d'un référentiel
qu'OSM 2023 ne cartographie pas comme routes classées — et que la matrice par
famille écarte l'explication par une simple différence de nomenclature
(l'hypothèse « RR = secondary/tertiary » est testée et rejetée : RES-* 0,2–1,5 %
sur ces natures). Ce n'est pas un problème de précision : à 250 m de tolérance,
79,4 % du linéaire RES reste hors du réseau OSM classé.

### QUESTION 3 — Que représentent les 9 500 km OSM absents ?

Mesure segment par segment : **6 947 km POTENTIAL_BDRI_MISSING** (1 009 segments,
dont primaire A7 — 67 km, Nzérékoré —, A12, et des secondaires de 30–43 km dans
l'intérieur du pays), 3 764 km de tertiaires partiels, 802 km de dessertes locales
courtes. Appartient-ce au réseau AGEROUTE ? **Décision métier** — OSM ne fait pas
autorité, et l'import non validé est précisément ce qui a créé le problème RES-*.

### QUESTION 4 — Quel est le périmètre officiel du réseau BDRI ?

**Il n'est défini nulle part.** Le contenu actuel est la superposition de quatre
imports dont le plus lourd (63 % du linéaire) est sans provenance. Décision
fondatrice attendue (D1–D3 du `REFERENTIEL-PERIMETRE-BDRI-PHASE5.md`).

### QUESTION 5 — Quelle source administrative retenir ?

Aucun référentiel fin n'existe (préfectures/communes : 0/1 690). Spécification
complète livrée avec validité temporelle obligatoire ; la source (INS ou service
compétent) est à désigner par la Direction Technique — avec géométries, sinon
tout rattachement redevient de la saisie manuelle.

### QUESTION 6 — Quelles données peuvent déjà être utilisées ?

RN (géométrie + longueurs + PK, provenance documentée), RU, régions, géométries
valides 100 %, ouvrages/points noirs/postes localisés, audit des écritures,
sauvegardes éprouvées. Les KPI par région **sur le seul réseau RN** sont
défendables ; tout ratio incluant le linéaire RES doit porter la mention
« dont 63 % de provenance inconnue ».

### QUESTION 7 — Quelles données doivent rester explicitement inconnues ?

L'origine du lot RES-* ; la signification de `KA/MA/DI/RO` ; le revêtement
(valeur BITUME importée non vérifiée — à ne pas corriger sans relevé) ;
l'état patrimonial fin ; l'appartenance des 6 947 km OSM ; toute donnée
administrative sous la région ; la position exacte de 299 chantiers.

### QUESTION 8 — Quelles décisions humaines sont nécessaires avant modification ?

| # | Décision | Livrable d'appui |
|---|---|---|
| D1 | Périmètre officiel (que doit contenir la BDRI ?) | REFERENTIEL-PERIMETRE |
| D2 | Statut du lot RES-* (13 296 km) | RES-LOT-ANALYSIS |
| D3 | Sort des 6 947 km OSM manquants (A7 en tête) | OSM-MISSING-NETWORK |
| D4 | Source du référentiel administratif | REFERENTIEL-ADMINISTRATIF-SPEC |
| D5 | Identifiant patrimonial national | REFERENTIEL-ARCHITECTURE-CIBLE |
| D6 | Gestion de la clé de sauvegarde | BACKUP-KEY-DECISION |
| D7 | Validation des 33 propositions de localisation chantiers | CHANTIER-PROPOSALS |
| D8 | Ordre d'intégration des applications AGEROUTE | INTEGRATION-AGEROUTE |

---

## 2. Critère de réussite

> **Voici ce que représente chaque partie du réseau BDRI** — RN établi et
> sourcé ; RES-* : référentiel distinct non identifié, fiché tronçon par
> tronçon ; RU établi ; le reste d'OSM caractérisé et en attente de décision.

et pour chaque objet important :

> **sa source, sa méthode, sa date, son niveau de confiance et ce que nous
> ignorons encore** — dans `REGISTRE-VERITE-BDRI.md` et `MATRICE-CONFIANCE-DONNEES.md`.

La mission n'était pas de rendre la BDRI plus remplie. Elle est de rendre son
référentiel de vérité **défendable devant la Direction Technique, la Direction
Générale et un auditeur externe**. Avec ce rapport, chaque affirmation est soit
démontrable par un script du dépôt, soit explicitement marquée inconnue.

---

## 3. Arrêt de phase

Conformément au cadrage §21 : **aucun déploiement, aucune modification de
production, aucune fusion de `phase4` (la branche `phase5` en est issue et
contient uniquement ajouts de scripts et de documentation), aucune donnée métier
créée ou modifiée.** Les décisions D1–D8 appartiennent à AGEROUTE.

**PHASE 5 — RÉFÉRENTIEL NATIONAL PRÊT POUR DÉCISION**

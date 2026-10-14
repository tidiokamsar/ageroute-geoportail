# Plan de test de l'interopérabilité ONR / BDR

> Livrable 8 du § B.6. Couvre les huit flux du § 7.15 et les critères **A23**, **B11**, **B12**.
> **Rédigé le 14/10/2026.**
>
> 🔒 État réel : **un seul flux est partiellement testable aujourd'hui** (IO-04, sections
> fixes). Tous les autres attendent des formats non publiés, un export approuvé ou une décision.
> Ce plan dit ce qui devra passer, pas ce qui passe.

## 1. Couverture par flux

| Flux | Objet | Tests | État au 14/10 |
|---|---|---|---|
| IO-01 | Import nomenclature et tracés ONR, propositions d'écart | `BDR_IMPORT_ACCEPTANCE_TESTS.md` T-01 à T-12 | **bloqué** : aucun export, codification absente (D-06) |
| IO-02 | Export observations au format L²R Mesure, données validées seulement | X-01 à X-04 ci-dessous | **bloqué** : format non publié ; pivot testable |
| IO-03 | Notes UEMOA sur sections fixes | U-01 | **bloqué** : texte de la directive absent |
| IO-04 | Vue sections fixes 100/200 m | `backend/prisma/tests/sections_fixes.test.sql`, **14 assertions passées** | **partiel** — B11 tenu sauf la note |
| IO-05 | Import mesures d'uni (Uni Box) | contrat d'import, T-03, T-11 | bloqué : aucune mesure |
| IO-06 | Import trafic et charges | contrat d'import | bloqué : aucune source |
| IO-07 | Échange de pré-programmes avec L²R Programme | — | bloqué : moteur de programmation absent |
| IO-08 | Extraits pour l'annuaire statistique, reproductibles et versionnés | S-01, S-02 | **partiel** : API publique avec `methode` et `calculeeA` |
| IO-10 | Table de correspondance des catalogues, éditable sans code | C-01 à C-03 | absent |

## 2. Tests d'export (IO-02, IO-08)

| # | Test | Critère |
|---|---|---|
| X-01 | **Données validées uniquement** | un export ne contient **aucune** ligne `A_VALIDER` ; test avec 3 propositions et 2 validées → 2 lignes |
| X-02 | **Pivot ouvert** | CSV + GeoPackage + GeoJSON produits depuis la même requête ; **mêmes comptes** dans les trois |
| X-03 | **SRID 4326** et longueurs `geography` | contrôle sur 10 tronçons contre `ST_Length(geom::geography)`, écart < 0,1 % |
| X-04 | **Rejeu sans effet de bord** (A13) | exporter deux fois : aucun audit d'écriture, fichiers identiques à l'horodatage près |
| S-01 | **Reproductibilité** d'un extrait statistique | même périmètre, même version, même date de référence → octets identiques |
| S-02 | **Périmètre affiché** | chaque extrait dit « réseau classé saisi, *n* km », jamais « réseau national » (leçon de D-06 : 48 % du réseau annoncé) |

## 3. Tests des sections fixes (IO-03, IO-04, B11)

| # | Test | État |
|---|---|---|
| B11.1 | somme des sections = longueur du tronçon, aux pas 100, 200, 37, 5 000 m | **passé** |
| B11.2 | état de la portion **dominante**, pas de la première | **passé** (80 % contre 20 %) |
| B11.3 | **aucune saisie au niveau section** | **passé par construction** : aucune table |
| U-01 | note UEMOA par section, **neuf indices** conformes à la directive | **non écrit** — texte absent, formule inventée interdite |

## 4. Tests de correspondance (IO-10, B12)

| # | Test | Critère |
|---|---|---|
| C-01 | changement de correspondance **versionné et daté** | nouvelle ligne, ancienne close par `valideAu`, version incrémentée — aucune ligne modifiée |
| C-02 | **export antérieur reproductible** avec l'ancienne version | octets identiques après dix changements |
| C-03 | **éditable sans code** | modification par un rôle habilité, auditée, sans déploiement |

## 5. Ce qui débloque quoi

| Réponse attendue | Tests qu'elle libère |
|---|---|
| Formats L²R (Mesure, Base, Programme) | X-01 à X-04 en format cible ; IO-07 |
| Texte de la directive 11/2009 | U-01, puis la réapprobation du RCI (D-01) |
| Premier export approuvé (ONR ou ANASUR) | T-01 à T-12 en entier |
| Codification nationale (D-06) | IO-01 ; sans elle, l'étape 1 du rapprochement n'existe pas |

# Aide à la décision : dictionnaire des indicateurs

Branche `feat/aide-decision`, lot 2 (indicateurs, dictionnaire, qualité). Ce document est écrit **à partir du code**, jamais l'inverse : les définitions vivent dans `backend/src/aide-decision/dictionnaire.ts`, les formules dans `kpi.noyau.ts` et `kpi.depot.ts`. En cas d'écart, le code fait foi et ce document est à corriger. Le même contenu est servi par `GET /api/v2/aide-decision/dictionnaire` (voir `API-SYNTHESE.md`).

**Toutes les définitions sont PROVISOIRES** (`statutDefinition: "PROVISOIRE"`). Aucune n'a été validée par AGEROUTE. Le responsable métier n'est jamais nommé : « À confirmer par la Direction technique » (indicateurs de réseau, de chantier, de qualité) ou « par la Direction financière » (indicateurs budgétaires). Les indicateurs sont **consultatifs, non engageants**.

## 1. Ce que ce lot remplace

`GET /api/dashboard/decision` (`backend/src/modules/dashboard/dashboard.routes.ts`, lignes 275 à 383) calculait :

| Indicateur hérité | Défaut | Remplacement |
|---|---|---|
| « réseau dégradé » | numérateur : somme des longueurs de **tous** les tronçons non supprimés (voirie promue comprise) ; dénominateur : longueur du réseau classé. Un pourcentage pouvait dépasser 100 %. Les non évalués restaient au dénominateur. | `reseau_degrade_pct` : même population au numérateur et au dénominateur, non évalués à part |
| chantiers en cours / en retard | calculés sur `take: 50` | `chantiers_en_cours`, `chantiers_en_retard` (registre, aucun plafond) |
| « budget engagé » | somme de `montantGnf` de tous les chantiers, tous statuts | `budget_engage_gnf` : **NON_DISPONIBLE** (B-08, ADR-003) |
| « marchés recensés » | nombre de chantiers | `marches_recenses` : nombre de lignes de `marches` |
| valeurs absentes | `0` | `valeur: null` et un état qui dit pourquoi |

## 2. Paramètres PROVISOIRES (`PARAMETRES_KPI`, version `kpi-provisoire-1`)

Le mécanisme de paramètres versionnés existant (`parametres_programmation`, `programmation/parametres.noyau.ts`) porte des pondérations de risque et une correspondance état vers risque, mais aucune notion de classe « dégradée » ni de « critique » : l'étendre demanderait de modifier son noyau et une migration (hors du périmètre de ce lot). Les paramètres vivent donc **en code**, nommés, versionnés, rendus dans chaque réponse (`parametres`) et dans le dictionnaire.

| Paramètre | Valeur | Origine |
|---|---|---|
| `classesDegradees` | `MAUVAIS`, `CRITIQUE` | convention du contrat AD (§5), jamais décidée par la Direction technique |
| `classesCritiques` | `CRITIQUE` | idem |
| `exigenceEtat` | `OBSERVE_SEULEMENT` | règle la plus prudente et sourcée (voir §3) |
| `limiteBailleurs` | 20 | borne de la ventilation budgétaire, pas une norme |

## 3. Qu'est-ce qu'un « état valide » ?

Question tranchée par la lecture du schéma et du code, **décision PROVISOIRE réversible**. Un tronçon du périmètre a un état valide si et seulement si :

1. `troncons.etat` est `BON`, `MOYEN`, `MAUVAIS` ou `CRITIQUE` (`NON_EVALUE`, absent ou hors nomenclature : **non évalué**) ;
2. `troncons.statutValidation` n'est ni `REJETE` ni `A_CORRIGER` ;
3. la ligne de qualité de l'état (`valeurs_qualite`, `entityType = 'Troncon'`, `champ = 'etat'`) n'est ni `CONFLICTING` ni `UNKNOWN` ;
4. avec l'exigence par défaut `OBSERVE_SEULEMENT` : cette ligne est `OBSERVED` **et** porte une date de constat (`observedAt`).

**Pourquoi cette règle, avec ses sources :**

- `lib/qualite.ts` : à l'import, un état connu est `IMPORTED_UNVERIFIED`, de confiance `LOW`, « sans aucune date de constat » ; un état `NON_EVALUE` est `UNKNOWN`.
- `modules/inspections/inspections.service.ts` : « une inspection est le SEUL événement de la base qui produise une valeur réellement constatée : datée, attribuée, et de méthode connue » ; elle écrit la ligne `OBSERVED`, avec `observedAt`.
- migration `20260902110000_valeurs_qualite` : « un BON de cette année et un BON d'il y a dix ans occupent la même case » ; sans date, un état n'est pas un constat.
- `modules/troncons/troncons.service.ts` : « un état DÉCLARÉ n'est pas un état CONSTATÉ ; l'absence de ligne ne vaut pas vérification ».
- Mesure citée dans le schéma (01/09/2026) : 647 tronçons à état connu sur 1 690, tous importés non vérifiés.

**Conséquence à connaître :** tant que peu de tronçons ont été inspectés, `reseau_degrade_pct` est `NON_DISPONIBLE` ou porte sur une petite fraction du réseau, avec une couverture basse. C'est l'état réel des données, dit tel quel. Les états importés non vérifiés ne sont pas perdus : ils sont rendus à part (`repartitionEtat.etatNonValide`, par classe et par motif).

**Alternative PROVISOIRE disponible** : `exigenceEtat = "NON_CONTESTE"` accepte tout état renseigné que rien ne contredit (importé non vérifié, dérivé, sans ligne). Elle se change en une ligne dans `PARAMETRES_KPI` ; les tests et le banc rejouent les deux règles.

**Limite connue, non détectée :** un état modifié à la main après un constat garde sa ligne `OBSERVED` ; seul le journal d'audit le montre.

## 4. Longueur « connue »

`troncons.longueurKm` est un `Float` obligatoire dont l'absence se lit `0`. Une longueur est **connue** si et seulement si elle est finie, strictement positive, et non marquée `DERIVED` dans `valeurs_qualite` (champ `longueurKm`) : une longueur calculée sur la géométrie n'est pas la longueur métier (`lib/reseau.ts`). Sinon elle est **inconnue** : le tronçon est compté (dans `tronconsSansLongueurMetier`), sa longueur n'est jamais additionnée, la longueur géométrique ne la remplace jamais. `NaN` est écarté explicitement (PostgreSQL le tient pour plus grand que tout nombre).

## 5. Périmètre commun

`PERIMETRES.RESEAU_CLASSE_SAISI` du registre (`lib/reseau.ts`, `fragmentPerimetre("reference")`) : tronçons non supprimés dont `sourceReference` n'est ni `voirie_locale:` ni `hors_territoire:`. La voirie promue (environ 185 000 km dans la base de production selon le rapport du lot 0) ne peut donc entrer ni au numérateur ni au dénominateur. Ce n'est pas le réseau officiel annoncé : la base n'en porte qu'une fraction (D-06).

Constat : la colonne `troncons.perimetre` (`NATIONAL`, `HORS_TERRITOIRE_NATIONAL`, `VOIRIE_LOCALE`) existe au schéma, mais le prédicat de `lib/reseau.ts`, source unique du registre, est encore le préfixe de `sourceReference`. Ce lot suit le registre ; un tronçon marqué `HORS_TERRITOIRE_NATIONAL` sans préfixe y serait compté. À arbitrer avec le lot qui fera migrer le prédicat.

## 6. Les indicateurs

Chaque ligne : code, unité, formule exacte, source, conditions. Les colonnes, filtres, limites et règles d'exclusion complètes sont dans `dictionnaire.ts` et dans la réponse de `/dictionnaire`.

### Réseau (périmètre : réseau classé saisi)

| Code | Unité | Formule exacte |
|---|---|---|
| `reseau_degrade_pct` | % | `100 × Σ longueurKm (longueur connue, état valide, état ∈ classesDegradees) ÷ Σ longueurKm (longueur connue, état valide)`, arrondi à 0,1. Même population des deux côtés ; `null` si le dénominateur est nul |
| `reseau_critique_km` | km | `Σ longueurKm (longueur connue, état valide, état ∈ classesCritiques)`, arrondi à 0,01 ; `null` si aucun état valide à longueur connue |
| `reseau_critique_pct` | % | `100 × Σ longueurKm (état valide, critique) ÷ Σ longueurKm (état valide)`, arrondi à 0,1 |
| `longueur_reseau_reference_km` | km | `Σ longueurKm (longueur connue, tous états)`, arrondi à 0,01. Égale à `longueur_metier_km` du registre ; borne basse, jamais complétée par la géométrique |
| `longueur_geometrique_km` | km | `Σ ST_Length(geom::geography) ÷ 1000`, repris du registre (`longueur_geometrique_km`), non ventilé par classe. **Séparé** de la longueur métier |
| `couverture_etat_part` | part (0 à 1) | `Σ longueurKm (état valide) ÷ Σ longueurKm (longueur connue, tous états)`, arrondie à 0,0001 |

**Couverture rendue avec chaque taux** (`couverture`), vocabulaire du contrat AD §5 :

- `eligibleKm` : dénominateur des taux = longueur des tronçons à état **valide** ;
- `evalueKm` : longueur des tronçons à état **renseigné** (valide ou non) ;
- `nonEvalueKm` : longueur des tronçons `NON_EVALUE` ou sans état ;
- `partNonEvaluee` : `nonEvalueKm ÷ (evalueKm + nonEvalueKm)` ;
- additifs : `etatNonValideKm` (= `evalueKm − eligibleKm`), `tronconsNonEvalues`, `tronconsEtatNonValide`, `tronconsSansLongueurMetier`.

Les taux sont `PARTIEL` dès que des tronçons du périmètre sont non évalués, à état non valide ou sans longueur métier ; `NON_DISPONIBLE` quand `eligibleKm = 0`.

### Chantiers (périmètre : chantiers au registre)

| Code | Unité | Formule exacte |
|---|---|---|
| `chantiers_en_cours` | nombre | `COUNT(chantiers) WHERE deletedAt IS NULL AND statut = 'EN_COURS' AND regionId ∈ portée` (registre, sans `take`) |
| `chantiers_en_retard` | nombre | `… AND dateFinPrevue < maintenant` (registre). La règle **ignore les suspensions et les avenants**, dit dans les avertissements. Les chantiers `EN_COURS` sans date de fin prévue ne sont ni en retard ni à l'heure : leur nombre est rendu et l'état est `PARTIEL` |

Si aucun chantier n'existe dans le périmètre, la valeur est `null` (`NON_DISPONIBLE`), pas `0`. Des chantiers existent mais aucun n'est en cours : `0` est un vrai compte.

### Budget (en GNF, **toujours des chaînes**)

| Code | Formule exacte | État |
|---|---|---|
| `budget_engage_gnf` | aucune | **toujours `NON_DISPONIBLE`** : « source financière de référence non validée (B-08, ADR-003) ». Jamais la somme des chantiers, jamais celle des marchés |
| `budget_contractuel_gnf` | `Σ marches.montantTotal WHERE deletedAt IS NULL AND devise = 'GNF'` dans la portée | `PARTIEL` si des marchés n'ont pas de montant (comptés à part, jamais `0`) ou sont en USD/EUR (exclus, aucun taux de change validé), et pour tout périmètre régional. `NON_DISPONIBLE` sans marché ou sans montant GNF |
| `budget_decaisse_gnf` | `Σ decomptes.montantGnf WHERE deletedAt IS NULL AND statut = 'PAYE'` des marchés de la portée | `NON_DISPONIBLE` sans décompte payé (le décaissé est inconnu, pas nul). Avertissements : payés sans date, retenues de garantie incluses (comme `/api/decaissements`), émis non comptés |
| `budget_previsionnel_gnf` | `Σ programmes_budgetaires.montantPrevuGnf WHERE statut = 'RETENU'`, région du tronçon rattaché | repris du registre (`previsions_retenues_gnf`) ; toutes années ; une ligne sans tronçon n'est pas communiquée à un périmètre régional |
| `budget_contractuel_par_bailleur_gnf` | contractuel et décaissé par `marches.bailleurId` → `bailleurs`, jamais par `chantiers.bailleur` (texte libre) | limité à `limiteBailleurs` lignes ; au-delà, `tronque: true`, le total de bailleurs et un agrégat « autres » |

**Marchés et territoire.** Un marché n'a pas de région propre. Pour un compte régional (ou un filtre de région), un marché n'est communiqué que s'il est rattaché à au moins un chantier non supprimé **et** que tous ses chantiers non supprimés sont dans la portée. Un marché sans chantier, à cheval sur une région hors portée, ou rattaché seulement à un chantier supprimé n'est pas communiqué : le lui rendre ferait fuiter un montant d'une autre région. Un compte national voit tous les marchés non supprimés.

**Droits financiers.** Les montants exigent en plus le module `marches` (contractuel, décaissé, bailleurs) ou `programmation` (prévisionnel). Sans lui, l'état est `NON_AUTORISE` et aucun montant n'est rendu. Les comptages (marchés recensés) ne sont pas conditionnés.

| Code | Unité | Formule exacte |
|---|---|---|
| `marches_recenses` | nombre | `COUNT(marches) WHERE deletedAt IS NULL AND dans la portée`. « Recensés », jamais « actifs ». Aucun marché : `null` |

### Qualité

| Code | Unité | Formule exacte |
|---|---|---|
| `donnees_a_confirmer` | éléments | `(tronçons NON_EVALUE ou sans état) + Σ nombre d'anomalies par code des détecteurs, hors ETAT_NON_EVALUE, ETAT_ABSENT, ETAT_INCONNU`. Nombre d'**éléments**, pas de tronçons distincts : un tronçon à plusieurs anomalies compte plusieurs fois. Dans la **synthèse**, seules les familles `PK`, `LONGUEUR`, `GEOMETRIE`, `ETAT` sont exécutées (coût) : l'indicateur est `PARTIEL`, borne basse. `GET /qualite` exécute les six familles |

Les détecteurs sont ceux de `backend/src/qualite` (26 codes, seuils PROVISOIRES), exécutés en lecture seule (transaction `READ ONLY`), sur le même périmètre (`reseau: "reference"`), avec `plafondParCode: 0` : la réponse porte des **comptes**, jamais des listes de tronçons. La synthèse n'exécute pas `REGION` ni `DOUBLON` (un balayage entier chacune, durées dans le rapport du lot) ; elle le dit dans `qualite.famillesNonExecutees`.

## 7. Période, fraîcheur

Les indicateurs sont des **instantanés** calculés à la date de la requête (aucun historique d'état dans la base) : `periode.depuis = periode.jusqua = date du calcul`. Les filtres `depuis` et `jusqua` sont acceptés puis rendus **non appliqués**, avec la raison. `fraicheur` donne la date de l'évaluation la plus récente et la plus ancienne parmi les tronçons à état valide et l'âge en jours de la plus récente, **sans verdict** : aucun seuil de fraîcheur n'est validé.

## 8. Ce que le métier n'a pas tranché (rien n'est inventé)

1. Définition officielle des classes « dégradées » et de « critique », et de leur version (D-01).
2. Règle d'« état valide » et seuil de fraîcheur d'un constat.
3. Périmètre et source de la longueur du réseau de référence (D-06) ; migration du prédicat vers `troncons.perimetre`.
4. Source financière de référence et définition du budget engagé (B-08, ADR-003).
5. Unité du bailleur : texte libre sur `chantiers` et `programmes_budgetaires`, clé étrangère sur `marches`. Seule la clé étrangère est ventilée ici.
6. Traitement des devises étrangères (aucun taux de change validé) ; inclusion des retenues de garantie dans le décaissé.
7. Échéance de référence applicable au retard d'un chantier ; traitement des suspensions et des avenants ; définition d'un marché « actif ».
8. Confidentialité financière des comptes de lecture (D-C1-1) : ce lot refuse les montants sans le module `marches` ou `programmation`, par prudence ; la règle est à confirmer.
9. Ce qui compte comme « donnée à confirmer » (cahier 9.2) et les seuils des détecteurs (provisoires).
10. Rattachement des comptes à une région (D-11) : un compte sans région est national (`perimetreDeRegions`).

## 9. Ce que les détecteurs ne couvrent pas (`nonCouvert`)

Repris tels quels de `GET /qualite` : contradictions entre référentiel, inspections, chantiers et source contractuelle ; source inconnue (`sourceType`, `sourceReference`) ; date de mesure absente hors état ; données trop anciennes (aucun seuil) ; absence de validation terrain ; associations marché-chantier-tronçon manquantes ou ambiguës ; contrôle des montants ; valeurs uniformes improbables ; couverture par axe (aucune entité « axe »). Plus la liste du service des détecteurs (ouvrages, chantiers, portions non examinés, PK, longueur, région par le nom, doublons, état déclaré non comparé aux portions ni aux inspections, seuils provisoires).

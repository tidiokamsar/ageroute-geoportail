# Aide à la décision : API de synthèse, dictionnaire et qualité

Branche `feat/aide-decision`, lot 2 (backend). Routeur : `backend/src/api-v2/aide-decision.synthese.routes.ts`, exporté sous le nom `aideDecisionSyntheseRouter`. **Il n'est pas monté** : l'orchestrateur l'ajoute à `backend/src/api-v2/index.ts` sous `/aide-decision`.

```ts
import { aideDecisionSyntheseRouter } from "./aide-decision.synthese.routes";
apiV2Router.use("/aide-decision", aideDecisionSyntheseRouter);
```

Chaque route porte ses propres gardes (`requireAuth` puis `requireModuleAccess("decision")`) : le routeur peut cohabiter avec les autres routeurs du préfixe `/aide-decision` (interventions, contractuel, scénarios, exports) sans que ses gardes s'appliquent à eux. Il remplace `GET /api/dashboard/decision` (voir `DICTIONNAIRE-KPI.md`, section 1).

| Route | Contenu |
|---|---|
| `GET /api/v2/aide-decision/synthese` | indicateurs (contrat AD §5), répartition de l'état, dégradation par région, budget, qualité, fraîcheur, couverture, avertissements |
| `GET /api/v2/aide-decision/dictionnaire` | définitions, formules exactes, unités, périmètres, sources, conditions, limites, règles d'exclusion, responsable métier à confirmer, statut, décisions ouvertes |
| `GET /api/v2/aide-decision/qualite` | anomalies du périmètre (détecteurs existants en lecture seule), couverture et taux de non évalués par région, ce qui n'est pas couvert |

Lecture seule : rien n'est écrit, donc rien n'est audité. Toutes les réponses portent `Cache-Control: no-store` (données territoriales et financières).

## Accès

| Cas | Réponse |
|---|---|
| sans jeton, jeton forgé ou expiré, compte inconnu ou désactivé | `401` `{ error, code: "NON_AUTHENTIFIE" }` (ou `COMPTE_INACTIF`) |
| compte sans le module `decision` | `403` `{ error }` |
| filtre invalide | `400` `{ error: "Filtres invalides", code: "FILTRE_INVALIDE", details: [{ champ, message }] }` |
| région hors périmètre **ou** inexistante | `404` `{ error: "Région introuvable", code: "INTROUVABLE" }`, corps identique dans les deux cas |
| panne de la lecture de l'état | `500` `{ error: "Erreur interne du serveur", code: "ERREUR_INTERNE" }`, sans détail |

**Périmètre.** Il vient du compte (`perimetreDe`), jamais de la requête. Un compte rattaché à une ou plusieurs régions ne reçoit que ces régions : le libellé du périmètre les nomme (« Région X », « Régions du périmètre : X, Y »), jamais « pays », et la réponse porte l'avertissement « Aucun total national n'est communiqué ». Un compte sans rattachement (ou ADMIN) est national. `regionId` ne peut que **réduire** la portée. Aucun paramètre ne l'élargit : `national=true`, `regions=…` et toute clé inconnue sont refusées (400).

**Droits financiers (prudence PROVISOIRE).** Les montants exigent en plus le droit sur les montants contractuels (fonction unique `droitMontantsContractuels` : ADMIN, module `marches` ou `chantiers`) pour le contractuel, le décaissé et les bailleurs, ou le module `programmation` (prévisionnel). Sans lui : `etat: "NON_AUTORISE"`, `valeurGnf: null`, aucune valeur. Les indicateurs d'état du réseau et les comptages restent servis. À confirmer (D-C1-1).

## Filtres (`FiltresDecision`, contrat AD §3)

Paramètres de requête identiques sur les trois routes. Listes : `classe=RN,RR` ou `classe=RN&classe=RR` (10 éléments au plus, valeurs de l'énumération).

| Filtre | `/synthese` | `/qualite` |
|---|---|---|
| `regionId` (entier > 0) | **appliqué** | **appliqué** |
| `classe` (`RN`, `RR`, `RU`, `PISTE`, `NON_CLASSEE`) | **appliqué** aux indicateurs de tronçons (numérateur et dénominateur) ; la longueur géométrique devient `NON_DISPONIBLE` ; ne qualifie ni chantiers ni marchés | non appliqué, dit |
| `etat`, `statutChantier`, `depuis`, `jusqua` | valides, **non appliqués**, rendus dans `filtres.nonAppliques` avec la raison | idem |

Une valeur hors nomenclature, vide, une date impossible (`2026-02-30`), `depuis` > `jusqua`, une clé inconnue, un tableau là où un scalaire est attendu, une chaîne de plus de 200 caractères : `400`.

## `GET /synthese`

Forme (champs du contrat AD §5 et **champs additifs**, notés *(+)*) :

```jsonc
{
  "calculeLe": "2026-10-26T12:00:00.000Z",
  "perimetre": { "national": false, "libelle": "Région Boké", "regionId": 1, "regions": [{ "id": 1, "nom": "Boké" }] },   // (+)
  "filtres": { "appliques": { "regionId": 1 }, "nonAppliques": [{ "nom": "etat", "raison": "Non appliqué : …" }] },        // (+)
  "parametres": { "version": "kpi-provisoire-1", "statutDefinition": "PROVISOIRE", "classesDegradees": ["MAUVAIS","CRITIQUE"], "classesCritiques": ["CRITIQUE"], "exigenceEtat": "OBSERVE_SEULEMENT", "origine": "…" },  // (+)
  "kpis": [ /* Kpi, voir ci-dessous, dans l'ordre */ ],
  "repartitionEtat": { … },
  "degradationParRegion": { "mention": "…PAS un score de priorité…", "regions": [ … ] },
  "budget": { "mention": "…", "contractuel": MontantEtat, "engage": MontantEtat, "decaisse": MontantEtat, "previsionnel": MontantEtat, "parBailleur": { … } },
  "qualite": { … },
  "fraicheur": { … },
  "couverture": { … },
  "avertissements": ["…"],
  "consultatif": "Indicateurs consultatifs, non engageants : …"
}
```

### `kpis` : douze indicateurs, dans cet ordre

`reseau_degrade_pct`, `reseau_critique_km`, `reseau_critique_pct`, `longueur_reseau_reference_km`, `longueur_geometrique_km`, `couverture_etat_part`, `chantiers_en_cours`, `chantiers_en_retard`, `budget_engage_gnf`, `budget_contractuel_gnf`, `marches_recenses`, `donnees_a_confirmer`.

```jsonc
{
  "code": "reseau_degrade_pct", "libelle": "Réseau dégradé",
  "valeur": 25,                       // null quand l'état n'est ni DISPONIBLE ni PARTIEL : jamais 0
  "valeurTexte": "9007199254740993",  // (+) montants GNF seulement : valeur exacte en chaîne
  "unite": "%",                       // "%", "km", "part", "nombre", "GNF", "éléments"
  "etat": "PARTIEL",                  // DISPONIBLE | PARTIEL | NON_DISPONIBLE (PERIME et DEFINITION_NON_VALIDEE ne sont pas émis : voir plus bas)
  "statutDefinition": "PROVISOIRE",
  "periode": { "depuis": "2026-10-26", "jusqua": "2026-10-26" },   // instantané ; null pour le budget (toutes périodes)
  "perimetre": { "libelle": "Région Boké : réseau classé saisi", "regionId": 1 },
  "source": "…", "calculeLe": "…",
  "couverture": { "evalueKm": 700, "eligibleKm": 200, "nonEvalueKm": 100, "partNonEvaluee": 0.125,
                  "etatNonValideKm": 500, "tronconsNonEvalues": 10, "tronconsEtatNonValide": 5, "tronconsSansLongueurMetier": 2 },   // (+) pour les 4 derniers
  "definition": "…", "formule": "…",   // repris du dictionnaire
  "avertissements": ["…"],
  "ouvre": { "onglet": "carte", "filtres": { "regionId": 1, "etat": ["MAUVAIS", "CRITIQUE"] } }
}
```

- `valeur` des montants GNF : nombre **seulement s'il est exactement représentable** (≤ 2^53 − 1), sinon `null` ; la source de vérité est `valeurTexte`. Les montants ne passent jamais par un nombre approximatif.
- `PERIME` n'est pas émis : aucun seuil de fraîcheur n'est validé. `DEFINITION_NON_VALIDEE` n'est pas émis : les valeurs PROVISOIRES sont rendues avec `statutDefinition: "PROVISOIRE"` et leurs avertissements, pour que l'écran les montre étiquetées plutôt que vides.
- `couverture` est `null` quand le périmètre n'a aucune longueur métier connue.
- `ouvre.onglet` vaut `carte` (réseau), `contractuel` (chantiers, budget, marchés) ou `rapports` (données à confirmer).
- `budget_engage_gnf` : toujours `etat: "NON_DISPONIBLE"`, `valeur: null`, avertissement « source financière de référence non validée (B-08, ADR-003) ».

### `repartitionEtat`

```jsonc
{
  "unite": "km", "base": "…", "eligibleKm": 200, "perimetreKm": 800, "troncons": 37,
  "classes": [ { "classe": "BON", "km": 70, "troncons": 9, "partPct": 35 }, … ],   // BON, MOYEN, MAUVAIS, CRITIQUE ; partPct rapporté aux seuls états valides, somme 100 ; null si eligibleKm = 0
  "nonEvalue": { "km": 100, "troncons": 10, "partDuPerimetre": 0.125 },            // à part
  "etatNonValide": { "km": 500, "troncons": 5, "partDuPerimetre": 0.625, "parClasse": { … }, "parMotif": { "ETAT_NON_CONSTATE": { "km": 500, "troncons": 5 } } },
  "longueurMetierAbsente": { "troncons": 2 }
}
```

Motifs de `parMotif` : `TRONCON_REJETE_OU_A_CORRIGER`, `ETAT_EN_CONFLIT`, `ETAT_INCOHERENT_AVEC_LA_QUALITE`, `ETAT_NON_CONSTATE`, `CONSTAT_SANS_DATE`.

### `degradationParRegion`

Pour chaque région où des tronçons existent (triées par nom) : `regionId`, `regionNom`, `regionNonRenseignee`, `partDegradeePct` (`null` sans état valide), `degradeKm`, `eligibleKm`, `nonEvalueKm`, `partNonEvaluee`, `troncons`, `tronconsNonEvalues`, `tronconsSansLongueurMetier`, `etat`. **C'est une part d'état, pas un score de priorité** : une priorité se calcule dans le moteur de programmation, avec ses paramètres approuvés. Le champ ne s'appelle donc pas `prioritesRegion` (nom du contrat §4, qui prêtait à confusion).

### `budget`

```jsonc
"contractuel": { "etat": "PARTIEL", "valeurGnf": "9007199254740993", "source": "marches.montantTotal (saisie applicative ; …)", "avertissement": "1 marché sans montant saisi (non comptés comme 0) ; …" },
"engage":      { "etat": "NON_DISPONIBLE", "valeurGnf": null, "source": null, "avertissement": "source financière de référence non validée (B-08, ADR-003). …" },
"decaisse":    { "etat": "DISPONIBLE", "valeurGnf": "1000", "source": "decomptes.montantGnf au statut PAYE (saisie applicative)", "avertissement": null },
"previsionnel":{ "etat": "DISPONIBLE", "valeurGnf": "777", "source": "programmes_budgetaires au statut RETENU (toutes années)", "avertissement": null },
"parBailleur": {
  "etat": "PARTIEL", "critere": "marches.bailleurId vers bailleurs.id (jamais le texte libre de chantiers.bailleur)",
  "limite": 20, "totalBailleurs": 30, "tronque": true, "message": "Liste limitée aux 20 bailleurs aux plus gros montants contractuels sur 30 : 10 autres bailleurs sont agrégés dans « autres ».",
  "lignes": [ { "bailleurId": 5, "bailleur": "…", "marches": 2, "contractuelGnf": "…" /* null = aucun marché de ce bailleur n'a de montant GNF (sans montant ou en devise étrangère) : inconnu, jamais "0" */, "marchesAvecMontantGnf": 2, "decaisseGnf": "…" /* null = aucun paiement */, "marchesSansMontant": 0, "marchesHorsGnf": 0 } ],
  "autres": { "bailleurs": 10, "marches": 7, "contractuelGnf": "600" /* null si aucun marché regroupé n'a de montant GNF */ },
  "avertissement": "…"
}
```

`MontantEtat.etat` : `DISPONIBLE`, `PARTIEL`, `NON_DISPONIBLE`, **`NON_AUTORISE`** (additif : droit financier absent). Un montant inconnu est `null`, **jamais `"0"`**. Contractuel, engagé, décaissé et prévisionnel sont quatre notions distinctes : aucune n'est déduite d'une autre.

### `qualite`

`etat`, `population` (tronçons examinés), `total` (anomalies), `parGravite` (`BLOQUANTE`, `A_TRAITER`, `A_SURVEILLER`), `tronconsNonEvalues`, `donneesAConfirmer`, `famillesNonExecutees`, `couvertureParRegion` (voir `/qualite`), `avertissements`, `lien`.

**La synthèse n'exécute que quatre familles de détecteurs** (`PK`, `LONGUEUR`, `GEOMETRIE`, `ETAT` : un passage borné par tronçon). `REGION` (intersection avec les limites administratives) et `DOUBLON` (auto-jointure spatiale) coûtent un balayage entier : elles sont réservées à `GET /qualite` et rendues **non exécutées** dans la synthèse (`famillesNonExecutees: ["REGION", "DOUBLON"]`). `donnees_a_confirmer` et `qualite.etat` sont alors `PARTIEL`, le nombre est une **borne basse**, et il peut être inférieur à `donneesAConfirmer.valeur` de `/qualite`, qui exécute les six familles. Voir les durées mesurées dans le rapport du lot.

### `fraicheur`

`calculeLe`, `derniereEvaluationLe` et `plusAncienneEvaluationLe` (parmi les tronçons à état valide), `ageJours` (de la plus récente ; `null` sans date, jamais 0), `note` : aucun seuil de fraîcheur n'est validé, aucun verdict.

### `couverture`

`eligibleKm`, `evalueKm`, `nonEvalueKm`, `partNonEvaluee`, `etatNonValideKm`, `tronconsTotal`, `tronconsNonEvalues`, `tronconsEtatNonValide`, `tronconsSansLongueurMetier`.

## `GET /qualite`

```jsonc
{
  "calculeLe": "…", "statutDefinition": "PROVISOIRE",
  "perimetre": { … }, "filtres": { "appliques": { … }, "nonAppliques": [ … ] },
  "reseau": { "code": "RESEAU_CLASSE_SAISI", "libelle": "Réseau classé saisi", "definition": "…" },
  "detecteurs": {
    "etat": "DISPONIBLE" | "PARTIEL" | "NON_DISPONIBLE",    // PARTIEL si une famille n'a pas pu s'exécuter (REGION sans limite administrative en base) ; NON_DISPONIBLE si les détecteurs ont échoué
    "population": 37, "total": 13,
    "parGravite": { "BLOQUANTE": 0, "A_TRAITER": 3, "A_SURVEILLER": 10 },
    "parCode": [ { "code": "GEOM_INVALIDE", "famille": "GEOMETRIE", "gravite": "BLOQUANTE", "description": "…", "correctionProposee": "…", "nombre": 2, "part": 0.0541 } ],
    "codesSansAnomalie": [ … ], "famillesExecutees": [ … six familles ], "famillesNonExecutees": [ … ], "seuils": [ { "nom": "…", "valeur": 0.1, "unite": "…", "statut": "PROVISOIRE", "origine": "…" } ], "avertissements": [ … ]
  },
  "couvertureParRegion": [ { "regionId": 1, "regionNom": "Boké", "regionNonRenseignee": false, "troncons": 27, "tronconsNonEvalues": 10, "tauxNonEvalues": 0.3704, "tronconsEtatNonValide": 5,
                             "tronconsSansLongueurMetier": 2, "longueurConnueKm": 700, "nonEvalueKm": 100, "partNonEvalueeKm": 0.1429, "eligibleKm": 100,
                             "anomalies": 12, "anomaliesHorsEtatNonEvalue": 2 } ],
  "etatDuReseau": { "troncons": …, "tronconsNonEvalues": …, "tronconsEtatNonValide": …, "tronconsSansLongueurMetier": …, "longueurConnueKm": …, "eligibleKm": …, "nonEvalueKm": …, "partNonEvaluee": … },
  "donneesAConfirmer": { "valeur": 13, "formule": "…" },
  "nonCouvert": [ "Contradictions entre le referentiel, les inspections, …", … ],
  "avertissements": [ … ], "consultatif": "…"
}
```

- Les détecteurs sont ceux de `backend/src/qualite/detecteurs.service.ts`, exécutés par `lancerEnLectureSeule` (transaction `READ ONLY` : la base refuserait une écriture). **Comptes seuls** (`plafondParCode: 0`) : aucune liste de tronçons, donc aucun identifiant d'un tronçon d'une autre région.
- Un compte à plusieurs régions est servi région par région ; seule la ligne de la région examinée est retenue à chaque passage, ce qui évite de compter deux fois une anomalie de chaînage de PK entre deux régions du périmètre.
- `couvertureParRegion` rend **toutes** les régions de la portée : une région sans tronçon saisi apparaît avec `troncons: 0` et `tauxNonEvalues: null` (un trou de couverture est une information). La pseudo-région « Non renseigné » n'apparaît que si elle porte des tronçons.
- Coût : un balayage par appel. Deux appels simultanés de même portée partagent le même calcul ; le suivant recalcule (aucun cache).

## Ce qui n'est pas dans ce lot

Cartes, interventions, scénarios, contractuel détaillé, exports, barèmes, séparation des tâches : lots 3 à 7 du contrat. Le frontend de la synthèse (`lib/aideDecisionApi.ts`) lit les champs ci-dessus ; les champs *(+)* sont additifs et ne cassent pas les types du lot 1.

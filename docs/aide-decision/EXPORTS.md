# Exports gouvernés, rapports et journal

Lot 6 de l'Aide à la décision. Code : `backend/src/aide-decision/export.{noyau,service,fournisseurs}.ts`, `rapport.regions.ts`, `backend/src/api-v2/aide-decision.exports.routes.ts` (non monté), `backend/src/api-v2/export.routes.ts` (durci), table `exports_journal`. Interface : `OngletRapports`, `BoutonExportDecision` (`frontend/src/components/decision/rapports/`).

Tous les exports sont **consultatifs, non engageants**. Aucune donnée n'est modifiée (hors journal et audit).

## Routes (préfixe `/api/v2/aide-decision`, à monter par l'orchestrateur)

| Route | Droit | Contenu |
|---|---|---|
| `POST /exports` | rôle ADMIN ou GESTIONNAIRE **et** module `rapports` (+ `programmation` pour `interventions` et `scenario`) | le fichier est la réponse (CSV ou JSON) |
| `GET /exports` | même garde | journal : ADMIN voit tout, les autres leurs exports |
| `GET /rapports/regions` | module `rapports` | état du réseau par région (aperçu de l'onglet) |
| `GET /baremes`, `GET /baremes/:id/historique` | module `decision` | voir `BAREMES.md` |

Corps de `POST /exports` : `{ type, format, filtres?, scenarioId? }`, strict. `type` : `synthese`, `reseau_regions`, `interventions`, `scenario`. `format` : `csv`, `json`. `filtres` : les `FiltresDecision` du contrat (§3). Réponses : 400 corps invalide ou `SCENARIO_REQUIS`, 403 droit ou `HORS_PERIMETRE`, 404 scénario introuvable ou hors périmètre (même corps), **413 `EXPORT_TROP_VOLUMINEUX`**. En-têtes : `X-Export-Id`, `X-Export-Empreinte-Sha256`, `X-Export-Nb-Lignes`, `Content-Disposition`.

**PDF : non fourni.** Aucune bibliothèque de génération PDF côté serveur n'existe dans le dépôt (`jspdf` n'est présent que dans le frontend) et aucune nouvelle bibliothèque n'a été ajoutée.

## Types d'export

| Type | Source | Remarque |
|---|---|---|
| `synthese` | `composerSynthese` (lot 2) | les mêmes indicateurs que l'écran, une ligne par indicateur ; les indicateurs en GNF sont retirés sans droit financier |
| `reseau_regions` | `lireEtatReseau` + `agregerEtat` + `indicateursReseau` (lot 2) via `rapport.regions.ts` | km par état, **non évalué à part**, taux sur les seuls états valides, même population au numérateur et au dénominateur ; réseau classé (voirie promue et hors territoire exclues, dit dans le fichier) |
| `interventions` | scénario scellé (`scenarios_programmation`) | lignes classées par rang de priorité ; **le lot 3 n'existait pas** : à brancher via l'interface `Fournisseurs.interventions` |
| `scenario` | scénario scellé | toutes les lignes, retenues et écartées avec motif ; **le lot 4 n'existait pas** : à brancher via `Fournisseurs.scenario` |

`rapport.regions.ts` est un adaptateur mince : aucune formule n'est dupliquée (les formules et la requête SQL viennent du lot 2). Dupliqué en revanche : la table des filtres pris en charge par type (`export.noyau.ts`, miroir dans `lib/aideDecisionRapports.ts`) ; le fichier remis, qui liste filtres appliqués et non appliqués, fait foi.

## Ce que porte chaque fichier

Date de génération, auteur, `exportId`, périmètre, **filtres appliqués**, **filtres non appliqués avec la raison** (période sur un instantané, état sur le rapport par état...), **filtres indisponibles** (préfecture, axe/projet, bailleur, gravité, type d'intervention : aucune donnée structurée), unités, sources et dates de référence, définitions des indicateurs (celles du lot 2, statut PROVISOIRE), avertissements sur les données partielles, colonnes financières retirées, nombre de lignes, mention « consultatif, non engageant ». En CSV : bloc `# clé;valeur`, ligne vide, tableau (BOM UTF-8, point-virgule, point décimal). En JSON : `{ metadonnees, colonnes, lignes }`.

Une valeur inconnue reste **vide** (`null`), jamais 0. Une cellule texte commençant par `= + - @` est préfixée d'une apostrophe (injection de formule).

## Gouvernance

- **Périmètre territorial côté serveur** : un compte régional n'exporte que ses régions ; `regionId` ne peut que réduire la portée (autre région : 403 `HORS_PERIMETRE`) ; scénario hors périmètre, national ou inexistant : même 404.
- **Droit financier (PROVISOIRE)** : la fonction unique `droitMontantsContractuels` (ADMIN, module `marches` ou module `chantiers`, voir `SECURITE.md` §6), la même pour les lectures de chantiers, la synthèse, le suivi contractuel, `POST /exports`, `GET /scenarios/:id/export` et `POST /export/selection`. Sans lui, colonnes financières retirées de l'en-tête **et** des lignes (jamais lues pour l'export par sélection), nommées dans le fichier. Dans les exports `scenario` et `interventions`, `justification` et `motif_exclusion_detail` sont des colonnes financières : ces textes citent le coût, le reste de l'enveloppe et le plafond. Dans l'export par sélection, `entreprise` (titulaire) est une colonne financière comme le montant. À valider par le métier (D-C1-1).
- **Lignes archivées** (`deletedAt`) exclues de la sélection.
- **Plafond** : 10 000 lignes (PROVISOIRE, `LIMITE_LIGNES_EXPORT`) ; au-delà, 413 et aucun fichier tronqué.
- **Journal avant remise** : journal + audit écrits dans une transaction avant l'envoi ; si l'écriture échoue, aucun fichier ne part. L'empreinte SHA-256 du journal est celle du fichier remis.
- **Injection** : noms de table et de colonne uniquement issus de listes blanches (vérifiées au chargement), valeurs liées (`$1`, `$2`).

## Durcissement de `/api/v2/export/selection`

Contrat de requête inchangé (`{ table, format, ids }`). Corrigé : contrôle territorial **par ligne** en base (un marché exige que tous ses chantiers soient dans la portée ; sans chantier il n'a pas de région : non remis à un compte régional), colonnes explicites au lieu de `row_to_json(t.*)`, lignes archivées exclues, en-tête et journal, GeoJSON valide (l'opérateur `-` sur du texte faisait échouer le SQL), garde de module qui répond au lieu de laisser la promesse pendante. **Changement de comportement** : l'export des marchés exige désormais le rôle ADMIN ou GESTIONNAIRE (un LECTEUR avec le module `marches` ne l'a plus) ; le patrimoine reste exportable selon le module de la table.

## Rapport par région : longueurs inconnues (revue du 27/10/2026)

Un groupe de tronçons dont **aucun** n'a de longueur métier n'a pas « 0 km » : ses km sont `null` (vides dans le fichier). Cela vaut pour chaque classe d'état valide (`km_bon`, `km_moyen`, `km_mauvais`, `km_critique`), pour `km_etat_non_valide`, `km_non_evalue`, `km_eligible` et `km_perimetre`. Une classe qui n'a aucun tronçon vaut bien 0. Une somme partielle (certains tronçons sans longueur) reste un nombre minorant. Deux champs le disent par région : `tronconsValidesSansLongueur` et `longueurDisponibilite` (`COMPLETE`, `PARTIELLE`, `ABSENTE`, `SANS_OBJET`), en plus de `tronconsSansLongueurMetier` et de `disponibilite` (le taux). Le CSV ajoute les colonnes `troncons_valides_sans_longueur` et `longueur_disponibilite`.

## Limites et décisions ouvertes

- Le droit financier est un choix de conduite (`droitMontantsContractuels`), pas une règle officielle.
- `POST /export/selection` n'exige pas le module `rapports` ni un rôle d'export (contrat paragraphe 2) : seulement le module de la table (et ADMIN ou GESTIONNAIRE pour les marchés). L'exiger changerait le comportement des pages de listes qui exportent une sélection de patrimoine ; décision à prendre.
- `interventions` et `scenario` lisent le scénario scellé faute des lots 3 et 4.
- Le journal d'un gestionnaire ne montre que ses propres exports.
- Non mesuré : durée et mémoire d'un export de 10 000 lignes sur la base réelle.

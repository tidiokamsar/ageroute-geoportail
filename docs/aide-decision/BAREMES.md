# Barèmes de coût : versions, historique, séparation des tâches

Lot 6 de l'Aide à la décision (branche `feat/aide-decision`). Code : `backend/src/api-v2/baremes.routes.ts`, table `baremes_historique` (migration `20261029300000_ad_baremes_historique`), écran `frontend/src/pages/BaremesPage.tsx`. Les définitions et prix restent PROVISOIRES : aucune valeur de prix n'est décidée ici.

## Ce qui a changé

| Défaut constaté (audit LOT-AD-00) | Correction |
|---|---|
| Une ligne était modifiée sur place (`version` + 1), aucune trace de l'avant | Table `baremes_historique` en ajout seul (déclencheur : UPDATE et DELETE refusés). Une ligne par modification et par approbation, écrite dans la **même transaction** que la mutation et l'audit |
| Tout PATCH remettait l'approbation à zéro, même pour un libellé | Seuls les champs qui changent le calcul la remettent à zéro (voir ci-dessous) |
| L'audit ne portait ni libellé ni commentaire | L'audit porte toutes les valeurs avant/après, le motif et les champs modifiés |
| Un ADMIN approuvait ses propres barèmes | `AUTO_VALIDATION` (403) : l'approbateur n'est jamais l'auteur de la version |
| Devise et unité implicites | `devise` (GNF) et `uniteCout` (KM) exposées, fermées (le moteur de coût ne lit que GNF par kilomètre) ; fenêtre de validité éditable |

## Règle : ce qui change le calcul

Décidée, testée (`baremes.routes.test.ts`, banc B5) :

| Champ | Effet d'un changement de valeur |
|---|---|
| `coutKmGnf`, `uniteCout`, `devise`, `anneeReference`, `largeurChausseeM`, `validDe`, `validA`, `source` | version + 1, approbation retirée, `modifieCalcul = true` dans l'historique |
| `libelle`, `commentaire` | historisé ; **ni la version ni l'approbation ne bougent** |

La comparaison porte sur la **valeur** : un champ renvoyé à l'identique n'est pas une modification (l'écran envoie des corps complets). Un corps où rien ne change est refusé (`AUCUN_CHANGEMENT`, 400) : pas de version fantôme. Une fenêtre de validité inversée est refusée (`VALIDITE_INCOHERENTE`).

## Séparation des tâches

- **Auteur d'une version** = auteur de la dernière modification qui a changé le calcul pour la version courante (lu dans `baremes_historique`, jamais dans le corps de la requête).
- L'approbation passe par `approbationPermise` (`backend/src/governance/separation-taches.ts`, lot 7) avec le même code stable `AUTO_VALIDATION` et le même texte que `validationPermise`. La fonction existante `validationPermise` n'a pas été réutilisée telle quelle : `BaremeIntervention` n'est pas dans `ENTITES_VALIDABLES` (domaines de délégation), voir la note de ce fichier.
- Un ADMIN qui a seulement corrigé un libellé peut approuver (il n'a pas posé le prix).
- Les neuf lignes d'origine (`standard_initial`) n'ont **pas d'auteur** : n'importe quel ADMIN peut les approuver une fois millésime et largeur posés (même exception que les ouvrages importés sans auteur).
- Rôles : modifier = ADMIN ou GESTIONNAIRE ; approuver = ADMIN.

## Contrat d'API

| Route | Corps / réponse |
|---|---|
| `GET /api/v2/baremes`, `GET /api/v2/aide-decision/baremes` | lignes : unité, devise, prix (chaîne), source, validité, version, statut d'approbation |
| `GET /api/v2/baremes/:id/historique`, `GET /api/v2/aide-decision/baremes/:id/historique` | événements du plus récent au plus ancien : version, champs modifiés, valeurs avant/après, auteur, motif, commentaire, statut d'approbation |
| `PATCH /api/v2/baremes/:id` | champs à changer + `motif` (obligatoire, 5 caractères au moins) ; `versionAttendue` facultatif (verrou optimiste, 409 `CONFLIT_VERSION`) ; `POST /:id/approuver` : `versionAttendue` **obligatoire** (400 sinon), `motif` et `commentaire` obligatoires |
| `POST /api/v2/baremes/:id/approuver` | `motif` et `commentaire` obligatoires ; 403 `AUTO_VALIDATION`, 409 `DEJA_APPROUVEE` / `CONFLIT_VERSION`, 422 `PRIX_ILLISIBLE` |

**Changement de contrat** : `PATCH` exige désormais `motif`, `POST /approuver` exige `motif` et `commentaire` (avant : aucun corps). Le seul client connu est `BaremesPage`, mis à jour.

## Scénarios déjà calculés

Un scénario embarque la copie des barèmes qu'il a utilisés dans ses entrées scellées (`scenarios_programmation.entreesCanoniques`, empreinte SHA-256 vérifiée en base, déclencheur d'immutabilité). Modifier un barème n'altère donc aucun scénario passé. Prouvé en Vitest (copie stockée relue, rejeu identique, contre-épreuve avec le nouveau prix) et par le banc PostGIS (B10 : entrées, résultat et empreintes identiques après modification, rejeu identique, réécriture refusée par la base).

## Audit

Entité `BaremeIntervention`, actions `UPDATE` (modification) et `VALIDATE` (approbation), avec valeurs avant/après. `lib/access.ts` (`MODULE_PAR_ENTITE`) ne mappe pas encore ce type : tant que le lot 7 ne l'ajoute pas, `/api/audit` le refuse (échec fermé). Demande : `BaremeIntervention: "decision"`.

## Limites

- Les prix restent ceux de `standard_initial` : aucun n'est approuvé (D-07). Ce lot ne pose aucun prix.
- Pas de « retrait d'approbation » explicite : seule une modification du calcul la retire.
- Le verrou optimiste (`versionAttendue`) est facultatif pour modifier et **obligatoire pour approuver** depuis la revue du 27/10/2026 (on approuve la version lue, pas celle qui a pu changer ; l'écran l'envoie toujours dans les deux cas).
- L'identifiant de ligne est borné à l'entier 32 bits : mal formé ou nul, 404 comme une ligne inconnue ; au-delà de 2147483647, 400 `ID_HORS_PLAGE` (jamais d'erreur SQL).
- Identités : l'historique et la liste portent l'adresse e-mail des auteurs et de l'approbateur. Pour un compte qui n'est ni ADMIN ni GESTIONNAIRE, elle est remplacée par un identifiant minimal (première lettre et « *** », par exemple « g*** »), y compris dans la valeur `approuvePar` des événements d'approbation ; l'identifiant opaque du compte, le motif et les valeurs avant/après restent lisibles.
- L'historique rendu est borné à 500 événements par ligne.

# Dictionnaire des données — noyau patrimonial

> Livrable 4 du § B.6. Décrit les tables **réellement présentes**, relevées le 14/10/2026 par
> `information_schema` sur une base construite depuis les 54 migrations du dépôt. Aucune colonne
> n'est décrite qui n'existe pas.
>
> **Périmètre** : le noyau patrimonial et de collecte — douze tables sur la centaine du schéma.
> Les objets contractuels gelés (ADR-003) en sont exclus à dessein : ils appartiennent à
> DigitalRoad et ne font pas partie du dictionnaire des données **routières**.
>
> Les **taux de remplissage** ne sont plus mesurables depuis le gel de la production (§ A.5.1) ;
> les comptes cités datent des 13 et 14/10.

## Conventions communes à toutes les tables

| Convention | Colonnes | Sens |
|---|---|---|
| **Suppression logique** | `deletedAt` | jamais de `DELETE` sur le patrimoine (AGENTS.md règle 2) |
| **Horodatage système** | `createdAt`, `updatedAt` | quand le système a enregistré — distinct de quand on a regardé et de quand c'est vrai |
| **Idempotence hors ligne** | `clientOperationId` (unique) | clé générée par l'appareil avant envoi ; un renvoi ne crée pas de doublon |
| **Validation** | `statutValidation` : `A_VALIDER` par défaut, `VALIDE`, … | une proposition n'est jamais officielle sans un tiers (A9) |
| **Provenance de l'enregistrement** | `sourceType`, `sourceReference`, `sourceConfidence`, `sourceDetectedAt` | `IMPORT_CODE_PATTERN` = **déduit** du code ; `IMPORT_DOCUMENTE` = **retrouvé** ; les confondre ferait passer une inférence pour un fait |
| **Géométries** | `geom` PostGIS, SRID **4326** | `Unsupported` pour Prisma ; longueurs en `geography` (§ 7.1) |

## Énumérations partagées

| Type | Valeurs | Remarque |
|---|---|---|
| `ClasseRoute` | RN, RR, RU, PISTE, NON_CLASSEE | **aucune valeur** pour les routes communautaires (D-06) ; `RR` n'existe pas au décret D/2017/331 |
| `Revetement` | BITUME, TERRE, LATERITE, PAVE, NON_RENSEIGNE | enum sur `troncons` (261 387 l. en dépendent) ; `portions.revetement` est un **référentiel**, lui |
| `EtatPatrimoine` | — | état déclaré ; sur 1 691 tronçons classés, **un seul** observé |
| `StatutValeur` | OBSERVED, IMPORTED_UNVERIFIED, DERIVED, CONFLICTING, UNKNOWN | ce que l'on sait **réellement** d'une valeur |
| `PerimetreReseau` | NATIONAL, HORS_TERRITOIRE_NATIONAL, VOIRIE_LOCALE | 6 573 tronçons hors territoire classés, intacts (D-03) |
| `SourceType` | IMPORT_CODE_PATTERN, IMPORT_DOCUMENTE, SAISIE_APPLICATIVE, RECUPERATION_AUDIT, INCONNUE | — |
| `FamilleDefaut` | CHAUSSEE, ACCOTEMENT, ASSAINISSEMENT, OUVRAGE, SIGNALISATION, SECURITE, ENVIRONNEMENT | — |
| `TypeOuvrage` | PONT, DALOT, BUSE, RADIER, PONCEAU, MUR_SOUTENEMENT, TUNNEL, PASSERELLE, VIADUC, FOSSE, CANIVEAU, SIGNALISATION, GLISSIERE | — |
| `CanalSignalement` / `StatutSignalement` | PWA, SMS_USSD, AGENT / NOUVEAU, EN_QUALIFICATION, VALIDE, REJETE, DOUBLON, **CONVERTI_OT**, RESOLU | `CONVERTI_OT` mène au module gelé des OT |
| `StatutTacheInterne` | OUVERTE, EN_COURS, CLOTUREE, ABANDONNEE | — |

---

## `troncons` — 261 387 lignes

L'unité du référentiel routier. **Vérité de la géométrie et de l'identité**, pas de l'état :
l'état vit dans `portions` et `valeurs_qualite`.

| Colonne | Type | Sens | Remarque |
|---|---|---|---|
| `id` | text | technique | — |
| `code` | text | identifiant métier : `GN N*`, `RES-*`, `*-OSM-*` | **pas un code national** |
| `nom`, `classe`, `regionId`, `prefecture`, `commune` | — | identité administrative | 1 028 `RR` sur 1 029 ont pour nom leur code (D-05) |
| `longueurKm` | double | longueur **déclarée** | peut diverger de la géométrie ; `reseau_sections_fixes` rend les deux |
| `pkDebut`, `pkFin`, `sectionPk` | — | PK officiels | nuls → `TRONCON_SANS_PK`, jamais un PK dérivé |
| `revetement`, `etat` | enum | **valeurs d'import** | BITUME sur 1 690 sans exception (C-4) |
| `traficMoyenJma`, `traficDateComptage` | int, ts | trafic | **aucun flux** ; remplissage non mesurable |
| `criticiteStrategique`, `coutRehabEstime` | int, numeric | nombres **orphelins** : ni méthode, ni version, ni date | à migrer vers le contrat des moteurs (`MAINTENANCE_PROGRAMMING_DESIGN.md` § 2) |
| `dateDerniereEvaluation` | ts | — | **nulle sur 261 387 lignes** |
| `sourceType` … `sourceDetectedAt` | — | provenance | absente sur les 1 691 classés, présente sur 259 696 |
| `perimetre`, `paysTerritoire`, `motifPerimetre`, `perimetreClasseA` | — | hors territoire (D-03) | classement, jamais suppression |
| `statutValidation`, `geom`, `observations` | — | — | — |

## `portions` — 0 ligne

**La vérité de l'état** (arbitrage D6). Une portion qualifie une emprise `[debutM, finM)` d'un
tronçon ; les sections fixes en sont dérivées.

| Colonne | Sens | Remarque |
|---|---|---|
| `debutM`, `finM` | abscisses **sur la géométrie** | semi-ouvert ; `finM > debutM` |
| `revetement`, `etat`, `praticabilite` | **codes de référentiel**, pas enums | FK vers `referentiel_*` ; `praticabilite` vide (D-02) |
| `praticabiliteCause`, `praticabiliteDepuis`, `praticabiliteDureeJours`, `praticabiliteTonnageMaxT` | contexte P1–P4 | migration en attente |
| `largeurM` | — | — |
| `source`, `observeeLe`, `confiance` | provenance | `observeeLe` = quand on a **regardé** |
| `valideDu`, `valideAu` | **axe terrain** | depuis quand c'est **vrai**, jusqu'à quand (exclu) |
| `remplaceeLe` | **axe système** | lignage ; distinct de `valideAu` (ADR-007) |
| `origine` | SAISIE_TERRAIN, DECOUPE, FUSION, REQUALIFICATION, IMPORT | — |
| `observationId`, `creeParId`, `clientOperationId`, `statutValidation`, `geom` | — | — |
| **contrainte** `portion_validee_sans_chevauchement` | exclusion sur (tronçon, emprise, **période**) | corrigée le 14/10 : ignorait l'axe terrain |

## `valeurs_qualite` — 1 820 694 lignes

Ce que l'on sait **réellement** de chaque valeur de chaque champ.

| Colonne | Sens |
|---|---|
| `entityType`, `entityId`, `champ` | la cellule qualifiée |
| `statut` | `StatutValeur` |
| `source`, `methode`, `observedAt`, `observedById`, `confiance`, `note` | provenance et méthode de la valeur |

## `missions`, `observations`, `defauts`, `medias_defaut` — 0 ligne chacune

La chaîne de collecte, écrite et testée, vide.

| Table | Colonnes clés | Remarque |
|---|---|---|
| `missions` | `code`, `type`, `statut`, `createurId`, `assigneId`, `appareilId`, `regionId`, `vehicule`, `equipe`, `debutPrevu`/`finPrevue`/`debutReel`/`finReelle`, `emprise`, `itineraire` | `chantierId` : lien vers un objet gelé, hérité |
| `observations` | `type`, `statut`, `gravite`, `tronconId`/`ouvrageId`, `pk`, `lat`/`lon`/`precisionM`/`geom`, `confianceAppariement`, `observeA`, `valideeA`, `validateurId`, `motifRejet`, `version` | position brute **toujours** conservée (§ 7.3.6) |
| `defauts` | `catalogueId`, `abscisseM`, `confianceAppariement`, `emprise`, `nombre`/`longueurM`/`largeurM`/`profondeurM`, `quantiteSaisie`/`quantite`/`uniteQuantite`/`methodeQuantite`, `gravite`, `etendue`, `etat`, `constateA`, `constateParId`, `traiteA`, `version` | quantité **saisie** distincte de quantité **retenue** |
| `medias_defaut` | `chemin`, `cheminVignette`, `sha256`, `mimeType`, `tailleOctets`, `lat`/`lon`/`precisionM`/`cap`, `capturedA` ; `analyseeLe`, `analyseModele`, `analyseVersion`, `analyseResultat`, `analyseConfiance` | contrainte `media_analyse_coherente` : aucune détection sans date ni modèle |

## `catalogue_defauts` — 13 lignes

| Colonne | Sens |
|---|---|
| `code`, `libelle`, `famille`, `parentId` | hiérarchie |
| `unite`, `mesuresRequises`, `graviteMax`, `seuils`, `coefficientUnitaire` | règles de métré |
| `source`, `version`, `actif` | administrable, versionné |

Plancher § 7.16 : **≥ 21 types**, revêtu / non revêtu. Table, donc extensible sans migration.

## `ouvrages` — 1 172 lignes · `inspections`

| Colonne | Sens | Remarque |
|---|---|---|
| `code` | **`Route-Type-PK`** | la clé d'échange **en service** vers DigitalRoad |
| `type`, `etat`, `regionId`, `tronconId`, `pk`, `abscisseDebutM`/`abscisseFinM`, `geom`, `geomLigne` | position | positions 2016 non vérifiées ; `doc_dtoaa:` servies `aValider` |
| `ficheNumero`, `longueurM`, `largeurM`, `hauteurM`, `gabaritT`, `nbTravees`, `longueurTravee`, `materiau*`, `anneeConstruction` | fiche | — |
| `derniereInspectionDate`, `travauxAPrevoir`, `remarques`, `photos` | — | historique d'état **non structuré** |
| `inspections` : `inspecteurId`, `dateInspection`, `etatObserve`, `defautsConstates`, `recommandations`, `photos`, `lat`/`lon`/`precisionM`, `clientInspectionId` | inspection générale | inspection typée **post-travaux** absente |

## `points_noirs` · `signalements_citoyens`

| Table | Colonnes clés | Remarque |
|---|---|---|
| `points_noirs` | `gravite`, `nbAccidents`, `causes`, `mesuresCorrectives`, `tronconId`, `pk`, `geom`, `statutValidation` | — |
| `signalements_citoyens` | `numeroPublic`, `canal`, `typeProbleme`, `description`, `lat`/`lon`/`localisationTexte`, `tronconId`, `photoFileName`, `statut`, `motifRejet`, `signalementParentId` (doublons), `contactTel`, `qualifieParId`/`qualifieLe`, `resoluLe` | **existe**, trois canaux ; `CONVERTI_OT` vers le module gelé ; `contactTel` = donnée personnelle → G-4, L/2016/037/AN |

## `taches_internes` — créée le 14/10, 0 ligne

Voir la migration `20261014210000` : `reference` stable, `nature` (référentiel), rattachement
(`tronconId` + `debutM`/`finM`, `ouvrageId`, `defautId`, `geom`) dont **au moins un**,
`responsableId`, `echeanceLe`, `statut`, `quantiteConstatee` + `quantiteUnite`, `preuveAvant*`,
`preuveApres*`, `clotureeLe`/`clotureeParId`, `abandonMotif`. **Aucune colonne de montant** —
garde-fou de 17 tests.

## Dérivé, sans table

`reseau_sections_fixes(pas_m, troncon_ids, a_la_date)` : sections fixes depuis les portions,
`longueurTronconM` géométrique et `longueurDeclareeM` côte à côte, état et revêtement de la
portion **dominante**, couverture. Aucune saisie possible au niveau section.

## Ce que ce dictionnaire ne couvre pas

Les tables de gouvernance (`users`, `audit_logs`, `operations_sync`, `conflits_sync`), les
référentiels normatifs (`regles_condition`, `baremes_intervention`, `matrices_degradation`,
`referentiel_*`), `limites_admin` (hors `schema.prisma`, provenance inconnue), et les objets
contractuels gelés. Chacun est décrit là où il compte : `DATA_SOURCE_OF_TRUTH.md`,
`DECISIONS_PENDING.md`, `MIGRATION_PLAN.md`.

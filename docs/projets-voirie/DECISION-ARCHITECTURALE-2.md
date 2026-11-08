# Décision architecturale 2 : module national, configurable, multi-sources, tolérant aux documents manquants

Date : 08/11/2026. Auteur : architecte du projet (session Claude). Statut : décidé, applicable à tous les lots suivants. Complète la décision 1 (import SIG progressif) et le cahier v2. Instruction du DSI du 08/11/2026 : autonomie des décisions techniques, Kissidougou pilote et non limite, aucune ville, concessionnaire, CRS ni type de réseau codé en dur.

## 1. Constat sur le code actuel (audit du 08/11/2026, branche feat/vague2-integration)

| Élément | État | Décision |
|---|---|---|
| Territoire d'un projet | `ProjetVoirie.commune` et `prefecture` en texte libre, `regionId` vers le référentiel `Region` existant | Remplacer par un référentiel `territoires_voirie` hiérarchique (voir 2), les champs texte deviennent dérivés et conservés pour compatibilité |
| Types de réseau | `enum TypeReseauTiers` Prisma (TELECOM, EAU_POTABLE, ELECTRICITE, ASSAINISSEMENT, GAZ_HYDROCARBURES, AUTRE) codé en dur | Table de référentiel `types_reseau_voirie` administrable ; l'enum reste comme famille technique (pour les règles de conflit par famille) et chaque type configurable pointe vers une famille |
| Emprise de plausibilité | `BBOX_GUINEE` constante (longitude -15,2 à -7,5 ; latitude 7,1 à 12,8) | Devient une configuration nationale (valeur par défaut identique) ; chaque territoire porte sa propre emprise optionnelle, utilisée pour la plausibilité et la carte |
| CRS métrique de calcul | `epsgPourLongitude` : 32628 si longitude < -12, sinon 32629 | Reste la règle par défaut ; chaque territoire peut imposer son CRS métrique (parmi la liste blanche) ; la liste blanche existe déjà en configuration |
| Liste blanche des CRS d'import | Configurable (4326, 32628, 32629 par défaut) | Inchangé, administrable par l'interface au lieu de la seule variable d'environnement |
| Concessionnaires | Table `concessionnaires_reseau`, indépendante du territoire | Inchangé ; un concessionnaire peut intervenir dans plusieurs territoires ; le rattachement d'un référent reste (compte, concessionnaire, projet) |
| Largeurs d'emprise et de chaussée | Par projet (15 m / 7 m pour Kissidougou saisis à la création) | Inchangé ; des valeurs par défaut par catégorie de projet deviennent configurables |
| Règles de tolérance des conflits | Versionnées, approuvées, par famille de réseau | Inchangé ; une règle peut être nationale ou propre à un territoire (le territoire l'emporte) |
| Formats, statuts de jeu, confidentialité, classes de précision | Enums Prisma | Inchangés : ce sont des constantes du contrat, pas des données métier de territoire |

## 2. Modèle territorial

Un référentiel unique `territoires_voirie`, hiérarchique par `parentId`, avec `niveau` ∈ {NATION, REGION, PREFECTURE, COMMUNE, QUARTIER, SECTEUR, ZONE}, `code` unique, `nom`, `emprise` (geometry polygone WGS 84, optionnelle), `crsMetriqueEpsg` optionnel, `regionId` optionnel vers `Region` existante (pour le périmètre régional des comptes, qui reste la base du contrôle d'accès), `actif`, `createdAt`, `deletedAt` (suppression logique). Un projet pointe vers un territoire (`territoireId`), obligatoire pour les nouveaux projets, et les projets existants reçoivent par migration un territoire créé à partir de leur commune ou préfecture. La création d'un territoire est une opération d'administration (ADMIN, auditée), jamais de code. Kissidougou est créé par la migration (NATION Guinée, REGION Faranah, PREFECTURE Kissidougou, COMMUNE Kissidougou) avec l'emprise approximative de la ville ; les autres villes citées (Conakry, Kankan, Kindia, Labé, Boké, Faranah, N'Zérékoré) sont des données de DÉMONSTRATION créées par une graine, pas par la migration.

Droits : le périmètre régional existant (regions du compte) reste la règle ; un territoire hors des régions du compte rend 404 masqué. Les rattachements de référents restent par projet.

## 3. Référentiels configurables

Une table générique `referentiels_voirie` (domaine, code, libellé, ordre, actif, paramètres JSON validés par schéma par domaine, version, approuvé par, date) pour : types de réseau (avec famille technique), catégories de projet (avec largeurs par défaut), types de document attendu, méthodes d'acquisition, statuts de qualité. Les listes de choix de l'interface se chargent depuis `GET /api/v2/projets-voirie/referentiels/:domaine`. Une valeur désactivée reste lisible sur les objets qui la portent. Les écritures sont ADMIN, auditées, avec historique en ajout seul.

## 4. Sources et comparaison multi-sources

Chaque jeu porte déjà fournisseur (concessionnaire), format, empreinte, CRS déclaré et retenu, précision déclarée, origine, date. On ajoute `methodeAcquisition` (référentiel) et `dateDonnees` (date de validité de la donnée, distincte de la date de dépôt). Le statut « source unique, comparaison indisponible » est l'état normal d'un réseau qui n'a qu'un jeu : aucune divergence n'est calculée, aucun avertissement d'erreur.

Dès qu'un second jeu AUTORISÉ décrit le même réseau (même concessionnaire et même type, dans le même projet ou territoire), une comparaison peut être lancée : appariement par corridor, règle versionnée et approuvée comme les règles de conflit, par famille de réseau : corridor = max(précision déclarée A, précision déclarée B) + marge (1 m par défaut), seulement si les deux précisions sont connues et exprimées en mètres horizontaux ; sinon résultat `RAPPROCHEMENT_INCERTAIN` sans mesure de divergence. Résultats par objet : CONCORDANCE, DIVERGENCE (avec distance de Hausdorff et longueur hors corridor), RAPPROCHEMENT_INCERTAIN, SANS_CORRESPONDANCE_A, SANS_CORRESPONDANCE_B. Les géométries d'origine ne sont jamais modifiées ni fusionnées. La comparaison est persistée (versions, règle, algorithme) et rejouable comme une analyse de conflits.

## 5. Connectivité

Le modèle des relations (lot B1) reçoit un type de relation `CONNECTE_A` avec statut de preuve : `CONFIRMEE_PAR_FOURNISSEUR`, `INCONNUE`. Aucun calcul ne déduit une connexion d'une proximité. Un écran et une route n'affichent que ce qui a été fourni. Rien d'autre n'est construit tant qu'un concessionnaire ne fournit pas de topologie autorisée.

## 6. Complétude documentaire

Un dossier de projet porte des `documents_projet_voirie` : type attendu (référentiel), statut ∈ {ATTENDU, RECU, EN_ANALYSE, EXPLOITABLE, INCOMPLET, A_CORRIGER, REMPLACE, VALIDE, REJETE}, versions, lien optionnel vers un jeu de données (quand le document est un plan importé) ou vers une pièce référencée (référence et empreinte seulement : aucun stockage de fichier binaire hors du mécanisme existant du fichier d'origine), justification, acteur, dates ; historique en ajout seul. La fiche projet affiche « ce que les documents disponibles permettent » : analyse 2D possible dès qu'un jeu d'axes et un jeu de réseau sont autorisés ; comparaison multi-sources dès deux jeux du même réseau ; récolement dès une décision de déplacement ; et liste des pièces manquantes avec la fonction qu'elles débloqueraient. Aucune pièce manquante ne bloque une fonction indépendante.

## 7. Formats d'ingénierie

GDAL (lot B2) reste la voie de GeoPackage, Shapefile et DXF, désactivée par défaut, activée par configuration en préproduction puis en production après décision. LandXML : lecteur XML dédié (noyau existant sans entité) pour `Alignments` (axes en plan : lignes, arcs discrétisés, spirales refusées avec code typé) et `CgPoints` ; `Surfaces` ignorées et comptées ; CRS jamais déduit (déclaré par l'utilisateur). DWG : pas de convertisseur propriétaire ; l'interface explique comment exporter en DXF et conserve le DWG comme document (statut RECU, non exploitable). PDF : document de référence joint (référence, empreinte), jamais importé comme géométrie.

## 8. Exports, rapports, tableaux de bord

Export d'un dossier technique de projet : archive ZIP produite par le backend, bornée, auditée, réservée aux décideurs : fiche projet (JSON et PDF texte simple), agrégats d'analyse, dossiers de conflit (CSV existant), journal des documents, et GeoJSON des jeux AUTORISÉS seulement si le niveau de confidentialité le permet et si l'acteur a le droit d'export (jamais pour CONFIDENTIEL_CONCESSIONNAIRE ni INFRASTRUCTURE_SENSIBLE sans dérogation ADMIN tracée). Tableau de bord national et par territoire : nombre de projets, jeux par statut, conflits par statut, documents manquants, référents actifs ; agrégats seulement, filtrés par périmètre du compte.

## 9. Ce qui reste hors périmètre, décidé

Connectivité calculée, 3D et profondeurs déduites, DWG natif, IFC, LAS, services OGC en écriture, envoi de messages aux concessionnaires par l'application, création automatique d'ordres ou de déplacements. Tout cela est optionnel ou interdit par le cahier.

## 10. Plan des lots (vague 3), ordre et dépendances

| Lot | Contenu | Migration | Dépend de |
|---|---|---|---|
| T1 | Territoires hiérarchiques, référentiels configurables, configuration nationale (emprise, CRS), graine de démonstration multi-villes, tests « nouvelle ville sans code » | 20261103100000 | aucun |
| D1 | Complétude documentaire, documents attendus, « ce que les documents permettent », LandXML (axes), DWG et PDF comme documents | 20261103200000 | T1 (référentiel des types de document) : T1 livre son contrat d'abord |
| S1 | Multi-sources : méthode d'acquisition, date des données, comparaison persistée et versionnée, relation CONNECTE_A déclarative | 20261103300000 | B1 (déjà fusionné) |
| X1 | Export de dossier technique, tableaux de bord national et par territoire | 20261103400000 | T1 |
| UI-C | Interface : administration des territoires et référentiels, documents du projet, comparaison, tableau de bord, export | aucune | contrats de T1, D1, S1, X1 |
| C1 bis | Tests de bout en bout multi-territoires (scénarios du point 7 de l'instruction) | aucune | tout |

Chaque lot : fixtures synthétiques, revue indépendante avant fusion, mêmes gardes que le socle, inventaire des accès, migrations additives avec descente, aucun nom de ville dans la logique métier (les noms ne vivent que dans les données de la migration Kissidougou et de la graine de démonstration).

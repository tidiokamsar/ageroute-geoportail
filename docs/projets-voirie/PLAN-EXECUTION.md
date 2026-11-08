# Plan d'exécution du mandat « Réseaux concessionnaires, axes, emprises et conflits »

Date : 01/11/2026. Références : cahier des charges v2.0 (28/10/2026), prompt maître V2, décision architecturale 1 (import SIG progressif), `LOT-RC-00-RAPPORT.md`, `LOT-RC-01B-GDAL-RAPPORT.md`, revue de sécurité du 01/11/2026. Branche de base : `feat/reseaux-integration`.

## 0. État au 08/11/2026 (mise à jour, le reste du document garde sa date)

| Lot | Contenu | État |
|---|---|---|
| Vague 0 | Socle, revue de sécurité, corrections M1 à M4 | Fait, revu |
| RC-3 | Dossiers de conflit (backend et interface), revue, corrections | Fait, revu |
| A1 | KMZ, CSV/TSV/TXT, GPX, CRS en liste blanche, inventaire, mapping, delta, retour arrière | Fait, revu, corrigé |
| A2 | Assistant d'import en 7 étapes | Fait, testé sur API simulée, non essayé contre le vrai backend |
| B1 | Réseaux physiques et circuits logiques, classes de précision (backend) | Fait, revu, corrigé |
| B3 | Workflow concessionnaire, rôles, récolement (backend) | Fait, revu, corrigé |
| UI-B | Interface des réseaux et du workflow | Interrompu, branche `feat/ui-reseaux-workflow` non vérifiée |
| B2 | GDAL branché, asynchrone (GeoPackage, Shapefile ZIP, DXF) | Interrompu, branche `feat/gdal-branche` non vérifiée |
| C1 | Tests de bout en bout Playwright | Non commencé |
| C2 | Pilote sur copie de données | Non commencé, exige l'autorisation de manipuler les vrais fichiers hors production |
| C3 | Deuxième revue de sécurité (vagues 1 et 2) | Revue de la vague 1 faite ; à refaire sur UI-B et B2 |
| Vague 4 | Formats d'ingénierie, 3D, exploitation | Non commencé, sur besoin confirmé |

Déploiement : D1 (socle) et D2 (conflits, import, réseaux, workflow) sont préparés ensemble, 5 migrations, ordre dans `DEPLOIEMENT-MODULE.md`. D3 (GDAL, interface réseaux et workflow) reste à faire.

## 1. Où on en est

Fait : audit et preuve de CRS (RC-0) ; socle (RC-1 et RC-2 partiels : projets, jeux en quarantaine, KML et GeoJSON, carte, analyse 2D indicative, export CSV d'agrégats, interface) ; chaîne GDAL isolée testée en banc (RC-1 bis, non branchée) ; revue de sécurité indépendante (0 critique, 4 majeurs en cours de correction, 9 mineurs). Rien du module n'est encore en production.

## 2. Règles communes à tous les agents

1. Un worktree par agent, sur C: tant que F: n'est pas réparé, une branche par agent, `git add` de chemins explicites, commits fréquents avec le trailer `Co-Authored-By`. Le coordinateur pousse sur GitHub (sauvegarde) ; les agents ne poussent pas.
2. Aucune donnée réelle (Orange, MC GROUPE) dans le dépôt : fixtures synthétiques. Aucune écriture dans le référentiel officiel. Aucune modification de l'infrastructure de production. Aucun déploiement par un agent.
3. Chaque lot se termine par : tests exécutés et chiffrés (jamais « supporté » sans test réel), `tsc`, `eslint`, build, rapport `docs/reports/LOT-RC-xx-RAPPORT.md`, mise à jour de `ETAT-GLOBAL-PROJET.md`.
4. Chaque vague se termine par une **revue indépendante** (agent distinct, lecture seule, preuves fichier:ligne) puis par la correction de ses défauts majeurs avant tout déploiement.
5. Chaque déploiement : archive reproductible, empreinte, script `infra/deployer-console.sh`, confirmation humaine `DEPLOYER` à l'étape 9.
6. Parallélisme limité à 3 agents actifs (limites d'usage atteintes le 31/10 ; chaque agent consomme plusieurs centaines de milliers de jetons).

## 3. Vagues, agents, critères de sortie

### Vague 0 : fermer le socle (en cours)
| Agent | Mission | Critère de sortie |
|---|---|---|
| Backend (en cours) | Corriger M1 à M4 et les mineurs de la revue | Tests de non-régression chronométrés, banc PostGIS, suite backend complète verte |
| Coordinateur | Fusion, suites complètes, archive | **Déploiement D1** (clé de module, import KML/GeoJSON, carte, analyse) ; migration `20261030100000` |

### Vague 1 : formats simples, assistant d'import, conflits persistés (3 agents en parallèle, après D1)
| Agent | Périmètre | Fichiers cibles | Critères de sortie |
|---|---|---|---|
| A1 Import backend | KMZ (archive bornée : zip-slip, bombe, entrées), CSV/TSV/TXT (délimiteur, colonnes de coordonnées, CRS explicite), GPX ; choix du CRS source parmi une liste blanche (EPSG:4326, 32628, 32629, autres à valider) transformé par PostGIS ; inventaire des couches ; mapping de champs ; échantillon ; conservation du fichier d'origine (politique de rétention) ; retour arrière d'une version ; traitement hors du processus de l'API pour les gros fichiers | `backend/src/projets-voirie/lecture.*`, nouveau `import/`, migration additive | Fichiers nominaux, malformés, CRS absent, ZIP dangereux, doublons, version avec suppressions, utilisateur sans droits ; rejeu de la descente |
| A2 Assistant d'import (interface) | Étapes : dépôt, détection, inventaire, CRS et unités, mapping, contrôles, aperçu cartographique et échantillon, approbation, promotion, retour arrière | `frontend/src/components/projets-voirie/assistant/` | Tests de composants, axe-core, parcours clavier, rien de stocké hors ligne |
| A3 Conflits persistés (RC-3) backend | Modèle : `RegleConflit` versionnée (par famille de réseau, tolérances approuvées), `AnalyseConflit` reproductible (versions des données, des règles, de l'algorithme), `DossierConflit` (sources, mesure, règle, statut, preuve, responsable, échéance, action proposée), décisions séparées de la proposition, journal ; superposition avec les tronçons, ouvrages et emprises (LIMITES_ROUTE) ; incertitude de position ; zones à investiguer ; divergences de sources | `backend/src/projets-voirie/conflits/`, migration additive | Statuts du cahier (À investiguer, Conflit potentiel, Conflit confirmé, Infirmé, Traitement décidé, Clôturé), recalcul reproductible, aucun ordre automatique, séparation des tâches |
| A3b Conflits (interface) | Liste et fiche de conflit, filtres, pièces, historique, comparaison entre deux analyses | `frontend/.../conflits/` | Après A3 pour le contrat ; tests et axe |

Fin de vague : revue indépendante, correction, **déploiement D2**.

### Vague 2 : réseaux, GDAL branché, workflow (3 agents)
| Agent | Périmètre | Condition préalable |
|---|---|---|
| B1 Réseaux physiques et circuits logiques | Infrastructure physique, circuit logique, équipement, relations, classes de précision A à E, qualité par objet ; connectivité reportée | Mapping de l'assistant (A1/A2) |
| B2 GDAL branché | Spool partagé, table de jobs, statuts, relance, nettoyage ; GeoPackage, Shapefile ZIP, DXF (CRS jamais déduit) ; interrupteur de configuration désactivé par défaut ; préproduction | **Décisions** : plafonds de production, hébergement et mise à jour de l'image, seccomp, scan de vulnérabilités, antivirus |
| B3 Workflow et rôles (RC-4) | Rôles du cahier (référent concessionnaire, auditeur, agent terrain, observateur, responsable de validation) mappés sur les rôles et clés de module existants, accès par organisation, demandes aux concessionnaires, tâches, preuves, récolement avec historisation | **Décision** : correspondance des rôles |

Fin de vague : revue indépendante, **déploiement D3** (activation du conteneur GDAL en production seulement sur autorisation explicite).

### Vague 3 : qualité de bout en bout et pilote
| Agent | Mission | Critère |
|---|---|---|
| C1 QA de bout en bout | Scénarios Playwright du cahier (12.1 et 22.3 : KIS-IMP-01, KIS-CRS-01, KIS-SEC-01, KIS-LOG-01, KIS-CLASH-01, KIS-LOGIC-01, KIS-REV-01) sur le harnais `e2e/` existant | Passages consécutifs verts, rapport |
| C2 Pilote sur copie contrôlée | Restauration d'une sauvegarde vérifiée dans une base jetable, chargement des vrais fichiers par le module, mesure de performance (50 000 objets, carte, analyse), procédure de retour arrière documentée | **Autorisation** de manipuler les vrais fichiers hors production ; aucune écriture en production |
| C3 Sécurité 2 | Deuxième revue indépendante des vagues 1 et 2 | 0 critique, 0 majeur |

### Vague 4 : formats d'ingénierie, 3D, nationalisation, exploitation (après le pilote, sur besoin confirmé)
Chaque format n'est activé qu'avec son test réel, son guide et son rapport de limites : LandXML, GML, GeoTIFF/COG, services OGC/ArcGIS en lecture seule ; DWG/DGN, FileGDB, MapInfo via convertisseur approuvé et licence vérifiée ; IFC, LAS/LAZ ; profondeur, altitude, références verticales et connectivité qualifiées ; catalogue des sources par concessionnaire et standards d'échange ; supervision, quotas, sauvegardes, monitoring, procédure de livraison.

## 4. Décisions qui bloquent ou orientent le plan

1. Conteneur GDAL en production : plafonds (50 000 objets, 50 Mo, 1 Go sont des valeurs de départ), hébergement et cadence de mise à jour de l'image, seccomp, scan, antivirus.
2. Rôles du cahier et leur correspondance avec les rôles et les clés de module.
3. Qui approuve les règles de conflit et leurs tolérances, avec quelle séparation des tâches.
4. Source CAO du plan d'axes (DXF, DWG, LandXML ou GeoPackage), datum, longueur de l'axe 28, largeurs réelles d'emprise et de chaussée par axe.
5. Politique de conservation des fichiers d'origine et des dérivés.
6. Liste blanche des systèmes de coordonnées proposés à l'utilisateur.
7. Priorité des formats : le pilote dépend surtout de ce que fournissent les concessionnaires et l'entreprise (KML aujourd'hui, DXF et Shapefile demain) : l'ordre KMZ/CSV/GPX puis GDAL peut être inversé si les fichiers à venir sont du DXF ou du Shapefile.

## 5. Points de déploiement

D1 socle, D2 formats simples et conflits persistés, D3 réseaux, GDAL et workflow, D4 exploitation. Chacun : revue indépendante, suites complètes, sauvegarde vérifiée, procédure de retour arrière, validation humaine à l'étape 9.

## 6. Vague 3 (decidee le 08/11/2026, voir `DECISION-ARCHITECTURALE-2.md`)

Module national configurable, multi-sources, tolerant aux documents manquants. Lots T1 (territoires et referentiels), D1 (completude documentaire, LandXML, DWG et PDF comme documents), S1 (multi-sources, comparaison, connectivite declarative), X1 (export de dossier technique, tableaux de bord), UI-C (interface), C1 bis (tests de bout en bout multi-territoires). Ordre, migrations et dependances : section 10 de la decision. Les decisions techniques sont prises par l'architecte et documentees ; seules les actions irreversibles sur la production restent soumises a l'autorisation du DSI.

# Rapport du lot S1 : sources multiples, comparaison entre sources, connectivité déclarative

Date : 08 et 09/11/2026. Branche `feat/multi-sources` (issue de `feat/vague2-integration`, base `cfe8e4e`). Worktree `C:\ageroute-secours\w-s1-sources`. Contrat : `docs/projets-voirie/CONTRAT-SOURCES.md` (écrit et commité en premier) ; référence d'API : `API.md`, section « Sources multiples, comparaison entre sources et connectivité déclarative (lot S1) » ; accès : `docs/securite/CONTROLE-ACCES.md` ; extensions : `CONTRAT-CONFLITS.md` section 9 points 42 à 46, `CONTRAT-RESEAUX.md` section 12. Un seul agent (S1), aucun sous-agent. Aucun push, aucun déploiement, aucun frontend.

## 1. Ce qui est fait

- **Sources** : `JeuDonneesProjet.methodeAcquisition` (code court ; forme vérifiée par la base, liste `METHODES_ACQUISITION` de `config.ts`, reliable au référentiel `METHODE_ACQUISITION` du lot T1 sans migration) ; `dateDonnees`, `precisionHorizontaleM` et `classePrecision` existaient : rien n'est dupliqué. La méthode est demandée au dépôt et peut venir du mapping.
- **Clé de version** : pour un réseau de concessionnaire, deux méthodes d'acquisition font **deux sources** (aucune ne remplace l'autre) ; pour un plan d'axes ou des limites de route, la méthode ne sépare pas les lignées (une nouvelle livraison reste une version). Même règle dans les index partiels de la base et dans le service (`sources/cle-version.noyau.ts`, utilisé par le dépôt, l'autorisation, le retrait, le retour arrière et la référence de la revue des suppressions).
- **Vue « sources »** (`GET /:id/sources`) : groupes de jeux `AUTORISE` par réseau (concessionnaire, type) et pour le plan d'axes ; `SOURCE_UNIQUE_COMPARAISON_INDISPONIBLE` (état normal, sans avertissement d'erreur) ou `COMPARABLE` ; versions candidates montrées aux seuls décideurs.
- **Règles de rapprochement** versionnées et approuvées (même mécanisme que RC-3, noyau d'approbation réutilisé) ; règle par défaut `S1-CORRIDOR-0.1` créée par la migration (marge 1 m, rayon 10 m, concordance stricte, précisions par classe `{ A: 0.5, B: 1, C: 2, D: 5 }` reprises de B1, provisoires).
- **Comparaison persistée et rejouable** (algorithme `S1-CORRIDOR-UTM-1`) : corridor `max(pA, pB) + marge` seulement si les deux précisions sont connues (descripteur B1, sinon jeu, sinon classe convertie par la règle, sinon inconnue) ; appariement PostGIS en UTM (même choix que l'analyse 2D) ; résultats `CONCORDANCE`, `DIVERGENCE` (Hausdorff, longueur et part hors corridor), `RAPPROCHEMENT_INCERTAIN` (aucune mesure), `SANS_CORRESPONDANCE_A`, `SANS_CORRESPONDANCE_B` ; jeux, versions, empreintes, règle, algorithme, instantané, durée, acteur enregistrés ; géométries d'origine ni modifiées ni fusionnées ; plafond d'objets, `statement_timeout` (budget partagé), verrou consultatif propre, limiteur, cadence 60 s, erreurs typées 422/429/503/504 avec ligne `ECHEC` pour un dépassement.
- **Deux versions d'un même axe** (demande du coordinateur du 09/11) : mode `VERSION_CANDIDATE` (jeu en contrôle face au jeu autorisé qu'il remplacera), pour les plans d'axes comme pour les réseaux ; méthode `PLAN_CAO` ajoutée ; cas synthétique PDF de classe C puis livraison du bureau d'études dans le banc.
- **Dossier de divergence** : `POST /:id/comparaisons/:cmpId/dossiers-conflit`, action humaine justifiée seulement, depuis un résultat `DIVERGENCE` ; dossier RC-3 `DIVERGENCE_SOURCES`, `A_INVESTIGUER`, sans analyse, lié à sa comparaison ; ignoré par le recalcul RC-3 (extension minimale, `CONTRAT-CONFLITS.md` points 42 à 46).
- **Connectivité déclarative** : `CONNECTE_A` avec `preuve` (`CONFIRMEE_PAR_FOURNISSEUR`, `INCONNUE`) obligatoire, créée par saisie humaine (route B1) ou par import (mapping `connecteA`, résolution par le nom dans le même fichier, origine `IMPORT_DECLARATIF`) ; état de connexion `CONFIRMEE`, `INCONNUE`, `NON_FOURNIE` sur la fiche d'un objet ; test statique qui fait échouer toute écriture de `CONNECTE_A` appuyée sur un prédicat spatial (mutation incluse).

## 2. Fichiers

**Nouveaux** : `backend/src/projets-voirie/sources/` (`types.noyau.ts`, `regle-rapprochement.noyau.ts`, `classification-sources.noyau.ts`, `eligibilite.noyau.ts`, `cle-version.noyau.ts`, `comparaison.depot.ts`, `comparaison.service.ts`, `regles-rapprochement.service.ts`, `sources.service.ts`, quatre fichiers de tests dont `connectivite.statique.test.ts`) ; `backend/src/api-v2/projets-voirie.sources.routes.ts` et son test ; migration `backend/prisma/migrations/20261103300000_multi_sources_comparaison/migration.sql` et descente `backend/prisma/descentes/20261103300000_multi_sources_comparaison.sql` ; banc `backend/tests-integration/sources-comparaison.integration.mts` ; `docs/projets-voirie/CONTRAT-SOURCES.md` ; ce rapport.

**Fichiers partagés modifiés (à surveiller à la fusion)** :

| Fichier | Modification |
|---|---|
| `backend/prisma/schema.prisma` | `methodeAcquisition` (jeu), valeurs `CONNECTE_A` et `IMPORT_DECLARATIF`, `preuve` (relation), analyses nullables et `comparaisonId` (conflit) ; **fin de fichier** : 2 enums, 3 modèles (clés étrangères en base seulement, comme `JobImportProjet`) |
| `backend/src/projets-voirie/config.ts` | **fin de fichier** : deux réglages, `METHODES_ACQUISITION` |
| `backend/src/api-v2/projets-voirie.routes.ts` | deux `import`, champ `methodeAcquisition` du dépôt, `monterRoutesSources` **en fin de fichier** |
| `backend/src/lib/access.ts` | deux types d'entité d'audit (`RegleRapprochementSources`, `ComparaisonSources`) |
| `backend/src/projets-voirie/consultation.ts` | route `sources` dans l'union |
| `projets.service.ts`, `formats/versions.depot.ts`, `formats/revue-versions.service.ts`, `import.service.ts` | clé de version commune (`filtreCleVersion`) ; dépôt : méthode et connexions déclarées |
| `formats/mapping.noyau.ts`, `formats/puits.noyau.ts`, `lecture.types.ts`, `vues.ts`, `api-v2/projets-voirie.import.routes.ts` | champs de mapping `methodeAcquisition` et `connecteA`, avertissement `CONNEXIONS_NON_RESOLUES`, méthode rendue |
| `reseaux/types.noyau.ts`, `relations.noyau.ts`, `relations.service.ts`, `reseaux.depot.ts`, `vues.ts`, `descripteurs.service.ts`, `api-v2/projets-voirie.reseaux.routes.ts` | `CONNECTE_A`, `preuve`, connexions déclarées, état de connexion |
| `conflits/analyse-conflits.service.ts`, `conflits/dossiers.service.ts` | recalcul sans les dossiers de divergence ; analyses nullables ; `comparaisonId` rendu |
| `securite/inventaire-acces.test.ts`, `projets-voirie/isolation.test.ts` | 9 routes, 3 tables, 3 délégués, fichier de routes |
| `tests-integration/run.sh`, `README.md`, `conflits-projets-voirie.integration.mts`, `reseau-physique-logique.integration.mts` | banc S1 ; migration S1 appliquée aux clones de non-régression |
| `docs/projets-voirie/{API,CONTRAT-CONFLITS,CONTRAT-RESEAUX}.md`, `docs/securite/CONTROLE-ACCES.md` | **ajouts** seulement |

**Client Prisma partagé** (junction vers `w-pv`) : régénéré. Le client avait été régénéré entre-temps par le lot T1 avec son schéma ; mon premier `prisma generate` a retiré les modèles de T1 ; je l'ai aussitôt **régénéré depuis un schéma d'union** (mon schéma plus le diff de T1 sur `schema.prisma`, `backend/prisma/schema.union.prisma`, fichier temporaire **non suivi**, supprimé à la fin), pour que les deux lots compilent. `prisma generate` finit en `EPERM` sur le renommage du moteur `query_engine-windows.dll.node` (fichier verrouillé par un processus en cours) : les fichiers JS et de types sont écrits (vérifié : `index.d.ts` et `index.js` portent les modèles des deux lots), le moteur reste celui de la même version 5.22.0. **Conséquence pour les bancs** : avec ce client d'union, une base doit porter les migrations des deux lots ; j'ai donc appliqué la migration de T1 (`20261103100000_territoires_referentiels`, lue dans son worktree, non copiée) à la `replay` de mon conteneur jetable. Après fusion, régénérer le client depuis le schéma fusionné.

## 3. Tests exécutés (chiffres réels)

Conteneur jetable `s1-sources-db` (postgis/postgis:17-3.5, port 5480), base `replay` reconstruite par les 100 migrations du worktree (pont D-10), plus la migration de T1 (voir section 2) ; `bdri-dev-db` non touché ; conteneur et volumes supprimés à la fin.

| Test | Résultat |
|---|---|
| `npx tsc --noEmit` (backend) | 0 erreur |
| Suite backend complète `npx vitest run` | **316 fichiers, 6 577 tests réussis, 1 ignoré, 0 échec** (première exécution : 2 échecs dans `projets.service.suppressions.test.ts`, lignes simulées sans la colonne `methodeAcquisition` ; corrigé dans le test) |
| Noyaux du lot (`sources/*.noyau.test.ts`) | 34 tests : règle et corridor (13), classification, clé stable, instantané, rejeu idempotent, état de connexion (14), éligibilité et clé de version (7) |
| Test statique de connectivité | 4 tests, dont deux mutations détectées (écriture de `CONNECTE_A` par `ST_DWithin`, ou hors des fonctions autorisées, ou avec `&&`) |
| Routes (`projets-voirie.sources.routes.test.ts`) | 12 tests (9 routes : 401, 403, lecteur, gestionnaire, ADMIN, 404 masqué, validation, erreurs typées, `CONNECTE_A` et sa preuve) |
| Inventaire des accès, isolation | verts (9 routes, rôles exacts, garde territoriale ; 3 tables, 3 délégués) |
| **Mutation des gardes** (rôle retiré de deux écritures, garde territoriale retirée d'une lecture) | **6 tests échouent** (routes 2, inventaire 4) ; fichier restauré |
| Banc PostGIS `sources-comparaison` | **55/55** (source unique, seconde source, concordance, divergence 3 m sur corridor 2 m, sans correspondance, incertain, rejeu idempotent, géométries inchangées, règle versionnée et approuvée, lecteur et gestionnaire, pagination, cadence, plan d'axes PDF puis bureau d'études en version candidate, dossier de divergence par action humaine seulement, analyse RC-3 sans effet, jeu retiré, connectivité déclarée, plafond et ligne `ECHEC`, déclencheurs, isolation, audit, projet supprimé) |
| Banc des descentes (`verifier.sh --seulement 20261103300000...`) | **6/6** (schéma identique, aller-retour, garde avec dérogation, garde sans dérogation sur `CONNECTE_A`) ; première exécution : 2 échecs (contrainte liée à l'ancien type d'origine), corrigé |
| Non-régression, migration S1 appliquée au clone | `conflits-projets-voirie` **169/169**, `reseau-physique-logique` **130/130** |
| Octets NUL | aucun dans les 53 fichiers du lot |

Défauts trouvés et corrigés par les bancs : liaison d'un tableau `float8[]` de nombres entiers refusée par PostgreSQL (22P03) ; transactions d'écriture au délai Prisma par défaut (5 s) dépassé sur un poste chargé (500) ; descente qui recréait une contrainte avant la reconstruction du type.

**Non exécuté** : le reste de `tests-integration/run.sh` (bancs hors du module) ; un 504 sur un calcul réellement trop long ; un volume au-delà de 120 objets.

## 4. Sécurité

Gardes identiques au socle (inventaire : 9 routes, rôle exact de chaque écriture, garde territoriale à 404 masqué sur toutes) ; lecteur limité aux comparaisons dont les deux jeux sont `AUTORISE` (filtre SQL de la liste, 404 sur le détail et les objets) ; version candidate et quarantaine jamais montrées à un lecteur, ni leur existence (vue des sources) ; jeu `RETIRE` : données masquées à tous ; projet supprimé : 404 à tous ; consultation des noms d'objets de jeux confidentiels tracée (route `sources`) avant la remise ; écritures auditées sans géométrie ; `instantane` jamais lu par la liste ni le détail (revue RC-3, M2) ; curseurs bornés ; cadence ; aucune route de fusion, de connexion calculée ni d'ordre (test d'inventaire) ; aucune donnée réelle (fixtures inventées en UTM 29N).

## 5. Performances

Non mesurées à volume : le banc compare au plus 120 objets (plafond éprouvé à 100). L'appariement utilise l'index GiST (`&&` sur une boîte élargie du rayon) puis `ST_DWithin` en UTM, comme l'association B1, dont le banc de volume donnait 3 000 circuits en 3 à 13 s. Plafond par défaut 20 000 objets linéaires et délai de 20 s côté base : à mesurer sur un banc de volume (non fait).

## 6. Décisions prises (hors contrat initial, documentées)

1. Méthode d'acquisition dans la clé de version **des réseaux seulement** ; plan d'axes comparé en **version candidate** (deux plans d'axes autorisés doubleraient les axes de RC-3 et de l'analyse 2D).
2. Mode `VERSION_CANDIDATE` : la mission parlait de jeux `AUTORISE` ; j'ai ajouté la comparaison d'un jeu en contrôle face à la version qu'il remplacera, réservée de fait aux décideurs, pour le cas PDF puis DXF demandé par le coordinateur.
3. Précision attribuée à une classe sans précision métrique, par la règle (table `precisionParClasseM`) : la mission dit « sinon de la classe du jeu » ; une table versionnée et approuvée plutôt qu'une constante.
4. Concordance stricte par défaut (part hors corridor 0, tolérance numérique de 1 cm) ; rayon d'appariement 10 m.
5. Dossier de divergence : rattaché au jeu de référence (A), géométrie copiée de l'objet A, sans analyse ; `jeuAxesId` pour un plan d'axes.
6. Connectivité déclarée par import résolue par le **nom** dans le même fichier ; ambigu ou introuvable : rien créé, compté.

## 7. Non fait, limites

- Aucun 504 provoqué sur un calcul réellement trop long (le délai est le mécanisme `Budget` du socle, prouvé par les bancs RC-3 et du socle).
- Pas de comparaison entre projets ou territoires ; pas de fusion ni de « source de référence » ; l'analyse 2D et RC-3 prennent toutes les sources autorisées (double compte possible de longueur dans `parConcessionnaire`, dossiers par source).
- Pas de banc de volume ; pas d'interface (lot UI-C).
- Commits : les premiers portent la mention `Claude Fable 5.1`, les suivants `Claude Opus 5.5` (consigne d'attribution modifiée en cours de lot).

## 8. Décisions à prendre (DSI)

Valeurs par défaut de la règle `S1-CORRIDOR-0.1` ; clé de version par méthode (réseaux) ; source de référence par réseau pour l'analyse ; repointage d'un dossier de divergence après remplacement de la version de référence ; ouverture d'un dossier depuis un rapprochement incertain ; qui approuve les règles de rapprochement (ADMIN seul aujourd'hui).

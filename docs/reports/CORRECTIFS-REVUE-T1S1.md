# Correctifs de la revue indépendante des lots T1 et S1

Rapport du 10/11/2026. Branche `fix/vague3-revue-t1s1`, issue de `feat/vague3-integration` (`c8049df`), avec `239e33d` reporté (bancs S1 et volume avec le territoire par défaut du lot T1). Revue corrigée : `C:\ageroute-secours\REVUE-VAGUE3-T1S1.md` (09/11/2026). **Aucun push, aucun déploiement, aucune donnée réelle** : fixtures synthétiques seulement.

Migration de correction : `20261103400000_correctifs_sources_territoires` (additive, idempotente, rejouable après elle-même et avant ou après les migrations T1 et S1 rejouées par les bancs) ; descente `backend/prisma/descentes/20261103400000_correctifs_sources_territoires.sql`. Attention au plan des lots de la décision 2 : l'horodatage `20261103400000` y était prévu pour X1 ; le mandat de correction l'impose ici, X1 devra en prendre un autre (D1 utilise `20261104100000`).

Contrats mis à jour : `docs/projets-voirie/CONTRAT-SOURCES.md`, `CONTRAT-TERRITOIRES.md`, `API.md` (section « Correctifs après la revue T1+S1 »), `docs/securite/CONTROLE-ACCES.md` ; décisions consignées dans `C:\ageroute-secours\mandat\DECISION-ARCHITECTURALE-2.md`, section « Précisions après revue T1+S1 (09/11/2026) » (ajout seul). Aucune route ajoutée ni retirée : l'inventaire des accès (`backend/src/securite/inventaire-acces.test.ts`) n'a pas changé et passe.

## Constat par constat

| Constat | État | Correction | Preuve (test qui échoue avant) | Commit |
|---|---|---|---|---|
| **B1** dossier `DIVERGENCE_SOURCES` qui révèle un jeu B illisible | corrigé | colonne `conflits_projet.jeuSourceBId` (renseignée depuis la comparaison, figée, égale au jeu B de la comparaison par déclencheur) ; statut de B dans `statutsLies`, les filtres de liste, compteurs, export, vue concessionnaire, comptes par territoire ; trace de consultation des deux jeux | `conflits/divergence-visibilite.test.ts` (8 tests, 5 échouent sans la correction : mutation ci-dessous) ; banc S1 : lecteur 404 et absent de la liste avec B en contrôle, B retiré : ADMIN sans mesure, géométrie, objet ni nom de B dans la fiche, la liste et le CSV ; base : jeu B figé (23001) | `02a47ff` |
| **B2** création de projet impossible depuis l'interface actuelle | ouvert, documenté | aucune modification d'interface (lot UI-C, autre worktree) ni repli serveur. **T1 ne part en production qu'avec UI-C** (écrit dans `CONTRAT-TERRITOIRES.md`, en tête) | sans objet | sans objet |
| **M1** CRS codé en dur dans la comparaison | corrigé | `contexteSpatialDuProjet` lu avant le calcul (rafraîchit aussi la configuration) ; `epsgPour` / `epsgDefaut` ; CRS persisté (`epsg`) avec son origine (`resume.crs`) | `sources/crs-comparaison.statique.test.ts` (échoue sur le code d'avant) ; banc : territoire qui impose 32628, comparaison en 32628 origine `TERRITOIRE` | `f9ea34a` |
| **M2** deux sources de vérité pour la méthode d'acquisition | corrigé | liste codée supprimée ; route et mapping : forme seule ; dépôt : valeur active du référentiel (422 `METHODE_ACQUISITION_INCONNUE`) ; base : déclencheur `referentiels_voirie_exige` ; 9 codes S1 ajoutés au référentiel (aucune valeur T1 perdue, correspondance `LEVE_TOPOGRAPHIQUE` = `TOPOGRAPHIE` documentée) ; retrait compté (409 `VALEUR_UTILISEE`) | `formats/methode-acquisition.test.ts`, test de route (LIDAR, GNSS) ; banc : GNSS accepté, LIDAR refusé puis accepté après ajout ADMIN puis refusé désactivé, valeur désactivée lisible, retrait 409, base 23503 | `c975eeb` |
| **M3** identité d'un réseau sans le type configurable | corrigé | clé de version et éligibilité avec le type (code, sinon famille) ; index partiels recréés (`pv_identite_type_reseau`) ; regroupement des sources par type | `eligibilite.noyau.test.ts` (3 tests M3) ; banc : deux types TELECOM, même concessionnaire, même méthode : version 1, aucun remplacement, deux réseaux, 409 `RESEAU_DIFFERENT` | `129ad52` |
| **M4** analyse 2D et comptage gardaient une source par concessionnaire | corrigé (toutes les sources comptent) | une seule règle `retenirJeux` (clé de lignée) pour l'analyse 2D et le comptage, comme RC-3 ; double compte dit (`sourcesMultiples`, une limite) ; `CONTRAT-SOURCES.md` 7.2 réécrit | `vues-curseurs-jeux.test.ts` (3 tests M4) ; banc : mêmes jeux réseau dans l'analyse 2D, le comptage et RC-3, sources multiples signalées | `1ddde08` |
| **M5** résultats de même nom perdus | corrigé | clé de résultat = projet et identifiants des objets A et B ; plus aucun résultat écarté (doublon = erreur du calcul) ; clé de dossier avec les identifiants | `classification-sources.noyau.test.ts` (deux « C1 » : une concordance, une divergence de 6 m) ; banc : deux « Fourreau » par source, deux résultats, rejeu identique | `6158b6f` |
| **M6** barème par classe appliqué sans approbation humaine | corrigé (décision de l'architecte) | règle système `S1-CORRIDOR-0.2` sans barème ; `S1-CORRIDOR-0.1` retirée sans modification de contenu ; barème appliqué seulement s'il est approuvé par un ADMIN autre que l'auteur (409 sans dérogation possible ; contraintes `rrs_bareme_personne`, `rrs_bareme_separation`) ; réponse et comparaison persistée : `regle.bareme`, `resume.bareme` (règle, version, approbateur), une limite | `regle-rapprochement.noyau.test.ts` (5 tests M6) ; banc : plan PDF classe C incertain sans distance avec la règle système, règle à barème refusée à son auteur même avec dérogation (409, base 23514), approuvée par l'ADMIN : corridor depuis le barème, dit avec la version | `dddedf0`, `302d9d4` |
| **m1** `/territoires/comptes` sans délai ni cadence | corrigé | `READ ONLY`, délai côté base (504), limiteur (503), cadence par compte (429), agrégat par projet puis cumul par chemin | `limiteurs.cadence.test.ts`, test de route 429 ; banc : comptes égaux à un oracle SQL indépendant, cadence 429 avec `Retry-After` | `87cbc03` |
| **m2** emprises complètes dans la liste | corrigé | liste : `bbox` et `aEmprise`, emprise sur la fiche | banc : aucune coordonnée dans la liste, emprise sur la fiche | `87cbc03` |
| **m3** oracle d'existence d'un territoire | corrigé | garde masquée avant la garde de région : même 404 `TERRITOIRE_INTROUVABLE` (inconnu, autre région, sans région) | tests de routes (deux fichiers) ; banc : trois cas, même corps, rien créé | `87cbc03` |
| **m4** changement de région d'un territoire | corrigé | région propre = région du parent (400) ; 409 `TERRITOIRE_REGION_PROJETS` / `TERRITOIRE_REGION_DESCENDANTS` | banc : région K vers A refusée (409), commune de K vers A refusée (400), rien changé | `87cbc03` |
| **m5** rattachements incohérents de la migration T1 | ouvert | ne se corrige pas sans réécrire la migration T1 (interdit) ni sans données ; m4 empêche désormais d'aggraver l'incohérence. À faire par une requête de contrôle après migration en préproduction et un rapprochement par l'administrateur | sans objet | sans objet |
| **m6** surcharge de famille refusée | corrigé | sans code demandé et famille différente du concessionnaire : code non hérité | banc : surcharge EAU_POTABLE acceptée, sans code | `295d47f` |
| **m7** famille d'un type modifiable malgré ses usages | corrigé | 409 `FAMILLE_FIGEE` si le code est porté | banc : famille refusée, couleur acceptée | `87cbc03` |
| **m8** état de connexion qui compte des liens illisibles | corrigé | jointure sur le jeu de l'autre bout, statuts lisibles du rôle | banc : lien vers un jeu en contrôle invisible au lecteur (INCONNUE), visible au gestionnaire (CONFIRMEE) | `295d47f` |
| **m9** CRS imposé ignoré sans avertissement | corrigé | 409 `CRS_NON_AUTORISE` (`territoires`) au retrait de la liste blanche | banc : 409 puis 200 une fois l'imposition levée | `87cbc03` |
| **m10** commune périmée après déplacement | corrigé | commune et préfecture dérivées, sinon envoyées, sinon nulles | banc : déplacement vers le corridor, commune et préfecture nulles | `87cbc03` |
| **m11** course création de projet et retrait de territoire | corrigé sans test automatisé | `FOR SHARE` à la création ou au déplacement, `FOR UPDATE` avant le comptage du retrait | aucun test de concurrence (lecture du code seulement) : **non prouvé par l'exécution** | `87cbc03` |
| **m12** graine DEMO, région non rattachée | corrigé | rapprochement sans accents, casse, apostrophes ni espaces | requête vérifiée sur PostGIS (`N'Zérékoré` = `Nzérékoré`) ; graine non rejouée | `87cbc03` |

### Ajouts demandés par l'architecte en cours de lot (10/11/2026, après la livraison de UI-C)

| Demande | État | Correction | Preuve | Commit |
|---|---|---|---|---|
| `GET /:id/sources` : `typeReseauCode` et son libellé | fait | `typeReseauLibelle` lu dans le référentiel `TYPE_RESEAU` (valeur désactivée comprise) | banc S1 (3 ter) : `FIBRE_BANC` « Fibre optique (banc) », `TELECOM` « Télécommunications » | `f12193d` |
| provenance explicite du corridor | fait | `resume.corridor.origine` (`PRECISIONS_METRES`, `BAREME_APPROUVE` + `regleBareme`, `INCERTAIN`), `parOrigine` ; `origineCorridor` par résultat | `sources/origine-corridor.test.ts` ; banc S1 (sections 2, 7) | `f12193d` |
| aucune auto-approbation d'une règle de rapprochement | fait | 409 `SEPARATION_DES_TACHES` pour l'auteur, champ `derogation` refusé (400), contrainte `rrs_auteur_approbateur` (NOT VALID) dans la migration | test de route ; banc S1 (sections 5, 7 ; base 23514) | `f12193d` |
| justification obligatoire de `PUT /configuration/:cle` | fait | 422 `JUSTIFICATION_REQUISE` sous 10 caractères, avant toute lecture | `territoires/configuration.justification.test.ts` ; banc T1 (section 12) | `f12193d` |
| `CATEGORIE_INCONNUE`, `TYPE_RESEAU_INCONNU` dans la section 8 de `CONTRAT-TERRITOIRES.md` ; `METHODE_ACQUISITION_INCONNUE` réellement émis | fait | codes documentés ; la route ne vérifie plus la forme de la méthode : tout code absent, inactif, retiré ou mal formé rend 422 au dépôt | test de route (`gnss-rtk` arrive au dépôt), `methode-acquisition.test.ts` (422 sans requête), banc S1 (11 bis : LIDAR 422) | `f12193d` |

Observation de la revue (ordre des migrations D1 / S1) : hors de ce lot ; la migration de correction ne suppose rien de D1.

## Mutations (les tests détectent le défaut réintroduit)

Chaque mutation est appliquée au code, la suite ciblée relancée, puis le fichier rétabli (aucune mutation commitée).

| Mutation | Fichier | Résultat |
|---|---|---|
| B1 : `statutsLies` sans le jeu B | `conflits/dossiers.service.ts` | `divergence-visibilite.test.ts` : **5 échecs** sur 8 |
| M3 : identité du type réduite à la famille (`identiteTypeReseau` sans le code) | `sources/cle-version.noyau.ts` | `eligibilite.noyau.test.ts` et `vues-curseurs-jeux.test.ts` : **3 échecs** sur 27 |
| M3 : clé de version sans la composante de type (`filtreCleVersion` sans `AND`) | `sources/cle-version.noyau.ts` | `eligibilite.noyau.test.ts` : **2 échecs** sur 10 |
| M6 : barème appliqué sans séparation des tâches (`baremeApprouve` sans le contrôle auteur / approbateur) | `sources/regle-rapprochement.noyau.ts` | `regle-rapprochement.noyau.test.ts` : **1 échec** sur 17 |
| M6 : règle de repli du code avec le barème provisoire | `sources/regle-rapprochement.noyau.ts` | `regle-rapprochement.noyau.test.ts` : **1 échec** sur 17 |

M1 : le test statique `crs-comparaison.statique.test.ts` a été exécuté contre le service d'avant la correction : **2 échecs** sur 2.

## Exécutions (chiffres réels)

Base de test : conteneur jetable `fix-postgis` (`postgis/postgis:17-3.5`, port local 5483, mot de passe aléatoire lu par `docker inspect`, jamais affiché ni écrit), `replay` fabriquée par une copie de `fabriquer-replay.sh` (racine de ce worktree) : d'abord 102 migrations (sans celle-ci, que les bancs appliquent au clone), puis reconstruite avec les **103 migrations** avant le passage final.

| Contrôle | Résultat | Sur quel code |
|---|---|---|
| `npx tsc --noEmit` | 0 erreur | `538e49e` (code de `f12193d`) |
| `npx vitest run` (suite backend complète) | **329 fichiers, 6 699 tests réussis, 1 ignoré**, 0 échec | `538e49e` |
| banc `sources-comparaison` | **73/73** (55 avant ce lot) | `f12193d` |
| banc `territoires-referentiels` | **85/85** (78 avant ce lot) | `f12193d` |
| banc `projets-voirie` | **141/141** (vérification 12 adaptée à m3 : 404 masqué au lieu de 403) | `f12193d` |
| banc `reseau-physique-logique` | **130/130** | `f12193d` |
| banc `import-formats` | **89/89** lancé seul ; **88/89** deux fois quand d'autres bancs tournaient en parallèle (vérification 13, performance : dépôt de 20 000 points en 22 et 25 s pour un seuil de 20 s) | `f12193d` |
| banc `conflits-projets-voirie` | **169/169** | `87cbc03` |
| banc `workflow-roles` | **132/132** | `87cbc03` |
| banc `gdal-jobs` | **100/100** | `87cbc03` |
| banc `reseau-physique-logique-volume` | **6/6** | `87cbc03` |
| banc `territoire` | **97/97** | `87cbc03` |
| banc `conflits-sync` | **43/43** | `87cbc03` |
| banc des descentes `verifier.sh --seulement 20261103400000_correctifs_sources_territoires` (103 migrations rejouées) | **6/6** : schéma identique après la descente, aller-retour identique, garde avec autorisation, garde sans dérogation possible | `f12193d` |
| dérive du schéma `verifier-derive-schema.ts --reconstruire` | aucune dérive sur un objet de cette migration (160 dérives préexistantes sur la chaîne, voir `docs/securite/DERIVE-SCHEMA.md`, 7 bis) | `f12193d` |

Les six bancs du bas n'ont pas été relancés après `f12193d` : ce commit ne touche que les sources, les règles de rapprochement, la configuration et la méthode d'acquisition, qu'aucun de ces bancs n'appelle (vérifié par recherche des routes dans les bancs).

**Non exécuté** : le frontend (aucune modification) ; la graine de démonstration (m12 vérifié par la seule requête de rapprochement) ; un test de concurrence de m11 ; la production (aucun accès).

## Décisions et limites

1. **M4** : toutes les sources autorisées comptent ; le double compte est dit, pas évité. Une « source de référence » par réseau reste une décision du DSI.
2. **M6** : les règles de personnes créées avant la correction portent la table que le service écrivait par défaut (`{ A: 0.5, B: 1, C: 2, D: 5 }`) ; celles qui ont été approuvées par un autre ADMIN gardent leur barème (il était visible à l'approbation) ; celles qui ont été approuvées par leur auteur avec dérogation n'appliquent plus de barème. À revoir par le DSI. La contrainte `rrs_bareme_separation` est `NOT VALID` (les règles approuvées sont immuables) et vaut pour toute ligne écrite désormais.
3. **M3** : `pv_identite_type_reseau` est déclarée `IMMUTABLE` alors que la conversion d'une valeur d'énumération en texte ne l'est pas pour PostgreSQL (un libellé peut être renommé) : renommer une famille `TypeReseauTiers` exigerait de reconstruire les deux index.
4. **M5** : la clé faite des identifiants d'objets rend deux comparaisons comparables entre elles seulement si elles portent sur les mêmes jeux (rejeu) ; deux versions d'une source ne partagent plus de clés.
5. **M2** : `LEVE_TOPOGRAPHIQUE` et `TOPOGRAPHIE`, `GNSS` et les trois codes GNSS du lot S1 restent tous actifs ; le DSI désactive par administration ceux qu'il ne veut plus proposer. Descente : les valeurs ajoutées au référentiel restent (des jeux les portent ; aucune suppression physique).
6. **B2** : production de T1 seulement avec UI-C.
7. **Bancs** : `sources-comparaison` et `territoires-referentiels` appliquent la migration de correction à leur clone ; `replay` a été reconstruite avec les 103 migrations (dont celle-ci) avant le passage final.

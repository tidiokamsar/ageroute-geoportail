# Rapport du lot B1 : réseaux physiques et circuits logiques, classes de précision, qualité par objet

Date : 08/11/2026. Branche `feat/reseaux-physiques-logiques` (issue de `feat/rc3-integration`, base `34b2d66`). Worktree `C:\ageroute-secours\w-b1-reseaux`. Contrat : `docs/projets-voirie/CONTRAT-RESEAUX.md` ; référence d'API : `API.md` (section « Réseaux physiques et circuits logiques (lot B1) ») ; accès : `docs/securite/CONTROLE-ACCES.md` ; extension de RC-3 : `CONTRAT-CONFLITS.md` section 9, points 35 à 41. Un seul agent (B1), aucun sous-agent.

## 1. Ce qui est fait

- **Modèle** (migration additive `20261101200000_reseaux_physiques_logiques`, descente `backend/prisma/descentes/20261101200000_reseaux_physiques_logiques.sql`) : deux tables, `reseau_objets_descripteurs` (nature, type, classe de précision déclarée, précisions H et V, méthode, date de constat, niveau de confiance, statut de qualité, profondeur, altitude, référence verticale, justification) et `reseau_relations` (circuit porté par infrastructure, équipement contenu dans une chambre ; proposée, validée, refusée, révoquée). Les objets importés restent **immuables** ; source (jeu, version) et confidentialité sont celles du jeu.
- **Règles de comptage** (noyau pur testé) : trois circuits superposés ne sont jamais trois câbles ; « trace fusionnée », « somme des longueurs de circuits » et « nombre d'infrastructures déclarées » sont des grandeurs distinctes ; **aucun total ne mélange les natures** ; scénario KIS-LOGIC-01 en fixtures synthétiques.
- **Association** circuit logique vers infrastructure physique par superposition PostGIS, tolérance liée à la classe (maximum, jamais somme), présentée comme **proposition** (statut `PROPOSEE`), jamais appliquée sans validation humaine justifiée et auditée ; une refusée n'est jamais reproposée.
- **API** : 10 routes sous `/api/v2/projets-voirie/:id/reseau/...` (objets, fiche, descripteur, relations, déclaration manuelle, validation, refus, révocation, proposition, comptage), mêmes gardes que le socle. Aucune interface, aucune route d'ordre, aucune géométrie rendue.
- **Extension minimale de RC-3 et du socle** : dossiers (`cible` : infrastructure physique, circuit porté, simple circuit logique), classe de précision **déclarée par l'objet** dans l'analyse persistée, analyse 2D et carte (nature et classe par objet, totaux par nature), export CSV (deux colonnes avant `cle`).
- **Connectivité** : non implémentée (le cahier la reporte) ; ce qu'il faudrait est dans `CONTRAT-RESEAUX.md`, section 9.

## 2. Audit du socle : écarts avec le cahier v2 (relus dans le code, pas supposés)

| # | Constat | Traitement |
|---|---|---|
| E1 | `natureObjets` n'existe qu'**au niveau du jeu** et n'est lue ni par l'analyse 2D ni par RC-3 (`grep` : aucune lecture hors dépôt et vues) | descripteur par objet ; héritage du jeu ; nature rendue partout |
| E2 | Aucune relation entre objets (circuit porté par infrastructure, équipement dans chambre), cahier 20.1 et 22.2 point 5 | `reseau_relations` |
| E3 | `reseaux.parType` et `parConcessionnaire` **somment** `nbObjets` (points et polygones compris) et `longueurTraceFusionneM` de tous les jeux d'un type de réseau, **natures mélangées** | `reseaux.parNature` et `conflits.total.parNature` **ajoutés** ; `parType` et `parConcessionnaire` **non réécrits** (contrat des clients) : écart connu |
| E4 | `longueurTraceFusionneM` d'un jeu est l'union de **tous** ses objets linéaires, quelle que soit leur nature | comptage exact par nature par objet (`GET /reseau/comptage`) ; la valeur du jeu est inchangée |
| E5 | RC-3 calcule par objet **brut** : N circuits superposés donnent **N dossiers**, rien ne distingue un conflit avec un support physique d'un conflit avec un circuit | `cible` et `tracePartagee` ; **dossiers non regroupés** (la clé changerait) : décision à prendre |
| E6 | Classe de précision : par jeu seulement (conforme : A à E, nulle = inconnue, jamais inventée, seuils non interprétés) ; pas par objet (cahier 5.2, 20.2) | classe de l'objet, sinon du jeu, sinon inconnue ; RC-3 l'utilise ; rejeu existant |
| E7 | Précisions H et V, méthode, date de constat : par jeu seulement ; la bande de proximité de RC-3 n'utilise que la précision **du jeu** | par objet dans le descripteur ; **bande de proximité de RC-3 non modifiée** (décision à prendre) |
| E8 | Aucune profondeur, altitude ni référence verticale (cahier 5.3, 20.1) | nullables par objet, jamais déduites ; **aucune évaluation 3D** |
| E9 | Pas de niveau de confiance ni de statut de qualité (cahier 5.2) ; pas de « validation » (auteur, date, preuve) | `niveauConfiance`, `statutQualite` ajoutés ; la validation par le propriétaire du réseau n'est pas modélisée (auteur, date et justification de la déclaration seulement) |
| E10 | Pas de licence ni de restriction de réutilisation par source (cahier 20.1, 23) | hors lot, non traité |
| E11 | La carte ne portait pas nature ni classe par objet (cahier 20.2 : lignes distinctes) | `properties.nature`, `origineNature`, `typeObjet`, `classePrecision`, `origineClasse` |
| E12 | Classe E « sans géométrie » : le socle **écarte** à l'import les objets sans géométrie (`OBJETS_SANS_GEOMETRIE`) ; aucune liste des données manquantes | non traité ; la classe E est déclarable mais **exclue** de l'association automatique |
| E13 | Objets ponctuels et surfaciques (chambres, équipements) : aucun dossier RC-3 (déjà documenté) | inchangé ; les natures permettent de les caractériser |
| E14 | Connectivité absente | reportée par le cahier ; documentée |

Constat de revue de mes propres choix : la classe d'un objet est une **déclaration humaine** (justification obligatoire, auditée), pas une mesure ; elle peut relever un dossier de `A_INVESTIGUER` à `POTENTIEL` (point 37 de RC-3).

## 3. Fichiers

**Nouveaux** : `backend/src/projets-voirie/reseaux/` (`types.noyau.ts`, `qualite.noyau.ts`, `comptage.noyau.ts`, `relations.noyau.ts`, `cible.noyau.ts`, `curseurs.noyau.ts`, `config.ts`, `commun.ts`, `vues.ts`, `reseaux.depot.ts`, `descripteurs.service.ts`, `relations.service.ts`, `associations.service.ts`, `comptage.service.ts`, `cibles.service.ts`, trois fichiers de tests) ; `backend/src/api-v2/projets-voirie.reseaux.routes.ts` et son test ; migration et descente ; `backend/tests-integration/reseau-physique-logique.integration.mts` et `...-volume.integration.mts` ; `docs/projets-voirie/CONTRAT-RESEAUX.md`.

**Fichiers partagés modifiés (à surveiller à la fusion)** :

| Fichier | Modification |
|---|---|
| `backend/prisma/schema.prisma` | **fin de fichier** : 5 enums et 2 modèles ; **champs inverses** ajoutés dans `User` (4), `ProjetVoirie` (1), `JeuDonneesProjet` (1), `ObjetProjet` (3) |
| `backend/src/api-v2/projets-voirie.routes.ts` | un `import` et un appel `monterRoutesReseaux(...)` **en fin de fichier** |
| `backend/src/projets-voirie/consultation.ts` | la route `reseau` ajoutée à l'union de `ContexteConsultation` |
| `backend/src/lib/access.ts` | trois types d'entité d'audit (`ReseauObjetDescripteur`, `ReseauRelation`, `AssociationsReseau`) |
| `backend/src/projets-voirie/carte.service.ts` | jointure du descripteur, propriétés par feature (**la carte dépend désormais de ma migration**) |
| `backend/src/projets-voirie/analyse.service.ts` | nature et classe par objet listé, `parNature`, `natures` ; `qualifDe` retiré (inutilisé) |
| `backend/src/projets-voirie/conflits/dossiers.service.ts` | `cible` (liste, fiche), deux colonnes CSV avant `cle` |
| `backend/src/projets-voirie/conflits/analyse-conflits.service.ts` | classe effective de l'objet (une lecture des descripteurs) |
| `backend/src/securite/inventaire-acces.test.ts`, `backend/src/projets-voirie/isolation.test.ts` | routes, tables et fichier de routes du lot |
| `backend/tests-integration/{projets-voirie,conflits-projets-voirie,projets-voirie-charge}.integration.mts`, `run.sh`, `README.md` | la migration B1 est appliquée au clone ; lignes ajoutées |
| `docs/projets-voirie/{API,CONTRAT-CONFLITS}.md`, `docs/securite/CONTROLE-ACCES.md` | **ajouts** seulement (section 9 de RC-3 : points 35 à 41) |

**Client Prisma partagé** : `npx prisma generate` n'a **pas** été lancé. Le code du lot lit et écrit ses deux tables en SQL brut paramétré et ne dépend pas du client régénéré ; `prisma validate` passe. Le client partagé (junction vers `w-pv`) n'a donc pas été modifié. Après fusion, régénérer le client est sans risque.

**Dépendance de déploiement** : la carte, l'analyse persistée, l'analyse 2D et les dossiers lisent la table des descripteurs : **la migration doit être appliquée avec (ou avant) le code**. `infra/deployer-console.sh` exige un nombre exact de migrations en attente (deux depuis `34b2d66`) : il passera à **trois** après la fusion de B1. Je n'ai pas touché ce script.

## 4. Tests exécutés (chiffres réels, 08/11/2026)

Conteneur jetable `b1-postgis` (postgis/postgis:17-3.5, port 5472), base `replay` reconstruite par les 96 migrations (pont D-10 appliqué) ; supprimé à la fin. `bdri-dev-db` n'a pas été touché.

| Contrôle | Résultat |
|---|---|
| `npx tsc --noEmit` (backend) | 0 erreur |
| `npx vitest run` complet (backend, depuis le worktree) | **282 fichiers, 6 069 tests, tous passants** (avant le dernier ajustement de l'ordre des colonnes CSV) ; relance ciblée après ce changement (`src/projets-voirie`, `src/api-v2/projets-voirie`, `src/securite`) : 32 fichiers, 737 tests, tous passants |
| Tests du lot (unitaires) | noyaux (`comptage.noyau.test.ts` 21, `reseaux.noyau.test.ts` 44, `vues-curseurs-jeux.test.ts`), routes supertest (`projets-voirie.reseaux.routes.test.ts` 25 : gardes, 404 masqué, validation, erreurs typées), inventaire des accès (10 routes, rôles), isolation (tables du module), `sql-parametre` |
| Banc PostGIS `reseau-physique-logique` | **122 / 122** (clone `essai_reseau_pl`) |
| Banc de volume `reseau-physique-logique-volume` | 6 / 6 (3 000 circuits et 3 000 gaines) |
| Banc de descente (`verifier.sh --seulement 20261101200000_...`, 97 migrations rejouées) | **6 vérifications, 0 échec** : descente identique, aller-retour, deux gardes avec et sans autorisation |
| Bancs existants rejoués (carte, analyse, dossiers modifiés) | `projets-voirie` **139 / 139** ; `conflits-projets-voirie` **169 / 169** ; `projets-voirie-charge` **9 / 9** |
| `securite:balayer` | 0 trouvaille non excusée |

Un premier passage du banc `conflits-projets-voirie` a donné 166 / 169 : deux causes, corrigées ou écartées. (1) Le test cherche la ligne CSV d'un dossier par `endsWith(";cle")` : mes deux colonnes ajoutées après `cle` le cassaient ; elles sont maintenant **avant `cle`, qui reste la dernière**. (2) Une analyse a répondu 504 sur un poste saturé (CPU à 100 % par d'autres travaux) : elle a passé au rejeu (169 / 169). Je n'ai **pas** rejoué la base de comparaison (la création d'un worktree de base avec jonction `node_modules` a été refusée) : l'imputation du 504 à la charge est une hypothèse cohérente avec le rejeu vert, pas une preuve.


## 5. Ce qui n'a pas été exécuté ou prouvé

- **Lint** : aucun script `lint` dans `backend/package.json`, non exécuté. `npm run build` (= `tsc -p tsconfig.json`) : équivalent au `tsc --noEmit` exécuté.
- **Frontend** : non touché, non testé ; les réponses ne gagnent que des champs ; aucune interface n'a été écrite (consigne).
- **Outil de dérive** `verifier-derive-schema.ts` : non exécuté ; les contraintes CHECK, déclencheurs et fonctions des deux tables sont hors `schema.prisma` (comme pour RC-3, voir `DERIVE-SCHEMA.md`).
- **Volume de production** : non prouvé. Le banc de volume a été mesuré sur un poste **saturé** par d'autres agents (CPU à 100 %) ; les durées sont des ordres de grandeur.
- **Propositions au-delà de 3 000 circuits** : mesurées seulement à 10 000 (8 à 21 s) et 20 000 (22 s, tronqué à 10 000 propositions) avant le plafonnement ; non rejouées avec le plafond relevé.
- **Pertinence métier** des tolérances et du seuil de couverture : valeurs **provisoires**, non validées.

## 6. Sécurité

- Mêmes gardes et même ordre que le socle (inventaire des accès à jour : 10 routes, rôles prouvés) ; 404 masqué hors périmètre, y compris avec un corps invalide ; projet supprimé : 404 pour tous (administrateur national compris) ; **lecteur limité aux jeux `AUTORISE`, jeu retiré montré à personne** (objets, fiche, relations, comptage, filtre par jeu), prouvé par le banc ; quarantaine du comptage réservée à ADMIN et GESTIONNAIRE (403).
- Aucune géométrie rendue, exportée ni écrite dans l'audit (balayage `coordinates|LINESTRING` de l'audit du lot : 0 ligne). Lecture des objets de jeux sensibles tracée (`ConsultationJeuProjet`, route `reseau`).
- SQL : uniquement `$queryRaw` étiqueté (test `sql-parametre` et isolation verts) ; identifiants `bigint` validés (18 chiffres), curseurs relus et refusés si forgés, `strpos` plutôt que LIKE (pas de joker : point 33 de la revue RC-3 non reproduit). Refus de la base traduits en 422/409, jamais en 500. Cadence par projet (429), plafond de circuits (422), délai côté base (504), limiteur de calculs, verrou du projet (503) : les défauts relevés par la revue RC-3 (cadence, curseurs non bornés, instantanés chargés pour rien, fuite de jeux non autorisés, projet supprimé lisible) ne sont pas reproduits.
- Écritures : transaction qui verrouille le projet, audit dans la même transaction. Aucune écriture hors des deux tables du lot et `audit_logs` (comptes de toutes les tables avant/après, empreinte md5 des tronçons du référentiel intacte).

## 7. Performances

Banc de volume (3 000 circuits × 3 000 gaines, une proposition exacte par circuit) : proposition 3 s (poste peu chargé) à 13 s (poste saturé), rejeu 3 à 7 s, comptage de 6 000 objets 0,4 à 1,1 s, page de 200 objets ou de 200 relations 0,15 à 0,9 s. Avant plafonnement : 10 000 circuits en 8 à 21 s, 20 000 en 22 s. D'où le plafond **par défaut de 3 000 circuits par exécution** (réglable, avec relèvement du délai de la base). Une première version de la requête de candidats évaluait une sous-requête de bornes **à chaque circuit** (plan observé par `EXPLAIN`, plusieurs minutes à 10 000) : corrigée (`MATERIALIZED`, tolérances en expressions plutôt qu'en jointure) ; la leçon est que ces requêtes sont sensibles aux estimations de l'optimiseur sur les CTE.

## 8. Risques

- **Descripteurs et relations suivent l'objet** : une nouvelle version d'un jeu crée de nouveaux objets sans descripteur ni relation ; il faut les ressaisir (ou reporter par le delta, à décider).
- **Classe déclarée par l'objet** : un compte qui décide peut relever la classe d'un objet (justifiée, auditée) ; il n'y a pas de seconde validation (séparation des tâches non appliquée à cette déclaration).
- **Dépendance carte, analyse, dossiers vers la migration** (voir 3) ; **N dossiers pour N circuits superposés** persistent.
- **`parType` et `parConcessionnaire`** de l'analyse 2D continuent de mélanger les natures.
- La `cible` d'un dossier est lue à la demande : elle change quand une relation est validée ou révoquée, sans nouvelle analyse (reproductibilité).

## 9. Décisions que le DSI doit prendre

1. Tolérances par classe (`A=0,5 m`, `B=1`, `C=2`, `D=5`, `inconnue=2`), couverture minimale 0,9, 5 propositions par circuit, plafond 3 000 circuits : **valeurs provisoires** à valider ou à remplacer.
2. Regrouper ou non les dossiers RC-3 de circuits superposés (aujourd'hui N dossiers) ; figer ou non la `cible` à l'analyse ; utiliser ou non la précision de l'objet dans la bande de proximité.
3. Reporter ou non automatiquement descripteurs et relations à la nouvelle version d'un jeu (par empreinte), sous forme de propositions.
4. Séparation des tâches pour la déclaration d'une classe de précision (A, B, C la rendent « potentielle »).
5. Réécrire ou non `parType` et `parConcessionnaire` de l'analyse 2D par nature (changement de contrat des clients).
6. Mettre à jour `infra/deployer-console.sh` (trois migrations en attente) avant le déploiement ; confirmer l'ordre migration puis code.
7. Licence et restrictions de réutilisation par source (E10) ; liste des données sans géométrie (classe E, E12) ; modèle de « validation par le propriétaire du réseau » (E9).
8. Connectivité (lot 7) : à lancer quand des sources déclarant les raccordements existeront.

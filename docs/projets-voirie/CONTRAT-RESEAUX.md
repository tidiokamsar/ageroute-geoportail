# Réseaux physiques et circuits logiques : contrat d'interface (lot B1)

Statut : contrat du lot B1 du 07/11/2026, commun au backend et à la future interface. Complète `CONTRAT.md` (socle) et `CONTRAT-CONFLITS.md` (dossiers de conflit). Référence : cahier des charges v2.0, sections 5.2, 5.3, 20.1, 20.2, 20.3 et 22.2 (point 5), scénario KIS-LOGIC-01. Base : `feat/rc3-integration` (commit `34b2d66`). Migration : `20261101200000_reseaux_physiques_logiques` (additive, avec descente). Référence des formes de réponse : `API.md`, section « Réseaux physiques et circuits logiques (lot B1) ».

## 1. Principe

Le nombre de lignes d'un fichier n'est pas un nombre d'équipements physiques : plusieurs **circuits logiques** (liaison, fibre, service) peuvent suivre le même **support physique** (gaine, câble, conduite). Le socle ne connaissait la nature d'un objet qu'au niveau du jeu, sans relation entre objets, sans qualité ni profondeur par objet. Ce lot ajoute, **sans toucher aux objets importés (qui restent immuables)** :

- un **descripteur** par objet qui le précise : nature, type, qualité déclarée, profondeur et altitude **seulement si fournies** ;
- des **relations** entre objets : un circuit logique *porté par* une infrastructure physique, un équipement *contenu dans* une chambre ;
- une **proposition d'association** par superposition géométrique, qui n'est **jamais** appliquée sans validation humaine ;
- des **règles de comptage** qui ne mélangent jamais les natures ;
- une **extension minimale** des dossiers de conflit RC-3 et de l'analyse 2D : on peut distinguer un conflit avec une infrastructure physique d'un conflit avec un simple circuit logique.

## 2. Règles non négociables

Celles de `CONTRAT.md` section 2 et de `CONTRAT-CONFLITS.md` section 2 (aucune donnée réelle, suppression logique, écritures auditées sans géométrie, migration additive avec descente, aucune écriture dans le référentiel officiel, aucun ordre ni déplacement créé), plus :

1. **Rien n'est inventé.** Une classe de précision, une précision, une profondeur, une altitude absentes restent **nulles** (inconnues). Aucune valeur « standard » ni déduite d'un nom de fichier.
2. **Aucune conclusion 3D.** L'évaluation verticale n'existe pas dans ce lot : l'état vertical d'un objet est `ABSENTE`, `INCOMPLETE` ou `FOURNIE`, et `evaluable` vaut **toujours faux**, `conclusion3D` toujours nul, même quand toutes les données sont fournies.
3. **Une proposition n'est pas une association.** Une relation automatique naît `PROPOSEE`, n'a aucun effet (le comptage ne la prend pas pour un support valide) tant qu'une personne identifiée ne l'a pas `VALIDEE` avec une justification de 10 caractères au moins. Une proposition `REFUSEE` n'est jamais reproposée.
4. **Aucun total ne mélange les natures** (section 6).
5. **Lisibilité identique au socle et à RC-3** : un jeu `RETIRE` n'est montré à personne ; un jeu autre que `AUTORISE` n'est montré qu'à `ADMIN` et `GESTIONNAIRE` ; un projet retiré répond 404 à tous ; hors périmètre, 404 masqué.
6. **Confidentialité héritée du jeu** : un objet n'a pas de niveau propre. La lecture des objets d'un jeu `CONFIDENTIEL_CONCESSIONNAIRE` ou `INFRASTRUCTURE_SENSIBLE` est tracée (`ConsultationJeuProjet`, route `reseau`). **Aucune route de ce lot ne rend ni n'exporte de géométrie.**

## 3. Modèle de données

Enums nouveaux : `TypeRelationReseau` (`PORTE_PAR`, `CONTENU_DANS`), `StatutRelationReseau` (`PROPOSEE`, `VALIDEE`, `REFUSEE`, `REVOQUEE`), `OrigineRelationReseau` (`AUTOMATIQUE`, `MANUELLE`), `NiveauConfianceObjet` (`ELEVE`, `MOYEN`, `FAIBLE`), `StatutQualiteObjet` (`OBSERVE`, `IMPORTE_NON_VERIFIE`, `DERIVE`, `CONTREDIT`, `INCONNU`). Les enums `NatureObjetReseau` et `ClassePrecision` du socle sont réutilisés.

### 3.1 `reseau_objets_descripteurs`

Au plus **un descripteur par objet** de `projets_voirie_objets` (clé `objetId`). Il **précise** l'objet ; ce qu'il ne dit pas est **hérité du jeu**, jamais inventé.

| Colonne | Sens |
|---|---|
| `objetId` (bigint), `jeuId` | objet décrit ; `jeuId` est rempli par la base (la source de vérité est l'objet) |
| `nature` | nul = hérite de `natureObjets` du jeu ; sinon `ACTIF_PHYSIQUE`, `CIRCUIT_LOGIQUE` ou `EQUIPEMENT` (AXE, EMPRISE et INCONNUE ne se déclarent pas) |
| `typeObjet` | code (`CONDUITE`, `GAINE`, `CABLE`, `CHAMBRE`, `LIAISON`, `FIBRE`, `VANNE`...). La **forme** est contrainte par la base, la **liste par nature** par le service (voir 3.3) : l'étendre ne demande aucune migration. Nul = type inconnu (autorisé) |
| `classePrecision` | A à E **déclarée** ; nulle = inconnue |
| `precisionHorizontaleM`, `precisionVerticaleM` | `Decimal(8,2)`, strictement positives, au plus 100 000 ; nulles tant que non fournies |
| `methodeCollecte`, `dateConstat` | méthode (200 caractères) et date du fait observé |
| `niveauConfiance` | `ELEVE`, `MOYEN`, `FAIBLE` ; nul = inconnu |
| `statutQualite` | `OBSERVE`, `IMPORTE_NON_VERIFIE`, `DERIVE`, `CONTREDIT`, `INCONNU` (défaut) |
| `profondeurM`, `altitudeM`, `referenceVerticale` | profondeur (m, positive vers le bas, 0 à 10 000), altitude (-500 à 9 000), repère (texte, 120 caractères). **Nulles tant que non fournies** ; une référence sans valeur est refusée |
| `justification` | motif de la déclaration (10 à 2 000 caractères) : « inconnus autorisés avec motif » (cahier 20.1) |
| `declareParId`, `declareLe`, `modifieParId`, `updatedAt` | auteur de la création (figé), dernier modificateur ; l'historique des valeurs est dans `audit_logs` (`before` / `after`) |

**Source et confidentialité** : celles du jeu de l'objet (jeu, version, concessionnaire, date des données, niveau de confidentialité), rendues dans `source` de chaque vue. Aucune colonne ne les duplique.

**Héritage** (noyau `types.noyau.ts`, testé) : la nature effective est celle du descripteur, sinon celle du jeu, sinon `INCONNUE` ; la classe effective est celle du descripteur, sinon celle du jeu, sinon nulle ; idem pour la précision horizontale. L'origine (`OBJET`, `JEU` ou `INCONNUE`) est rendue (`origineNature`, `origineClasse`).

### 3.2 `reseau_relations`

Relation entre deux objets du **même projet**.

| Colonne | Sens |
|---|---|
| `typeRelation` | `PORTE_PAR` : circuit logique (ligne) → infrastructure physique (ligne) ; `CONTENU_DANS` : équipement (point) → infrastructure physique (point ou polygone : chambre, regard) |
| `sourceObjetId`, `cibleObjetId` | le circuit ou l'équipement ; l'infrastructure qui le porte ou le contient |
| `statut`, `origine` | voir ci-dessous |
| `proposition` | JSON immuable de la proposition automatique : méthode, version, tolérance, composantes, couverture, seuil, projection ; **sans géométrie** |
| `decideParId`, `decideLe`, `justificationDecision` | dernier acte humain (validation, refus ou révocation) ; les actes précédents sont dans l'audit |
| `creeParId`, `createdAt`, `updatedAt` | qui a lancé la proposition ou déclaré la relation |

**Un seul enregistrement par couple** `(typeRelation, source, cible)`, **quel que soit son statut** : c'est ce qui empêche de reproposer une proposition refusée.

**États** : `PROPOSEE` (aucun effet), `VALIDEE`, `REFUSEE`, `REVOQUEE`. Transitions (noyau `relations.noyau.ts`, testé) : `valider` : `PROPOSEE`, `REFUSEE` ou `REVOQUEE` vers `VALIDEE` (une personne reconsidère ; l'acte précédent reste dans l'audit) ; `refuser` : `PROPOSEE` vers `REFUSEE` ; `revoquer` : `VALIDEE` vers `REVOQUEE`. Toute autre : 409 `TRANSITION_INTERDITE`. Justification de 10 caractères au moins : 422 `JUSTIFICATION_REQUISE`. Une relation `MANUELLE` est créée directement `VALIDEE` (c'est une décision humaine), avec son auteur et sa justification.

### 3.3 Types d'objet proposés (service, extensibles)

| Nature | Types |
|---|---|
| `ACTIF_PHYSIQUE` | `CONDUITE`, `GAINE`, `FOURREAU`, `CABLE`, `CANALISATION`, `COLLECTEUR`, `CHAMBRE`, `REGARD`, `POTEAU`, `AUTRE` |
| `CIRCUIT_LOGIQUE` | `LIAISON`, `FIBRE`, `RESEAU`, `SERVICE`, `AUTRE` |
| `EQUIPEMENT` | `VANNE`, `TRANSFORMATEUR`, `BOITE`, `JONCTION`, `ARMOIRE`, `COMPTEUR`, `BORNE`, `AUTRE` |

Un type exige une nature connue (déclarée ou héritée du jeu) : 422 `TYPE_OBJET_SANS_NATURE`.

### 3.4 États incohérents refusés par la base (et pas seulement par le service)

Descripteur sur un objet d'un plan d'axes ou de limites de route ; circuit logique non linéaire ; équipement non ponctuel ; type sans nature ; nature autre que les trois déclarables ; précision nulle ou négative ; profondeur négative ; référence verticale sans valeur ; justification courte. Relation d'un objet à lui-même, entre deux projets, ou dont les natures ou géométries ne conviennent pas au type ; décision sans auteur, sans date ou sans justification ; proposition décidée ; relation manuelle encore « proposée » ; changement de **nature effective** d'un objet qui porte une relation `PROPOSEE` ou `VALIDEE` ; modification des extrémités, du type, de l'origine ou de la proposition d'une relation. `DELETE` et `TRUNCATE` sont refusés sur les deux tables (suppression logique uniquement : un descripteur se corrige, une relation se révoque).

Ce qui n'est garanti que par le service (pas par la base) : la liste des types par nature, le statut du jeu (un objet d'un jeu `REJETE`, `REMPLACE` ou `RETIRE` ne se qualifie ni ne se relie plus : 409 `JEU_NON_QUALIFIABLE`), les transitions d'état des relations.

## 4. Qualité et vertical d'un objet

- **Qualité effective** (noyau `qualite.noyau.ts`) : classe, précisions horizontale et verticale, méthode, date : descripteur d'abord, jeu ensuite, sinon inconnu.
- **État vertical** : `ABSENTE` (ni profondeur ni altitude : « Profondeur et altitude absentes : aucune conclusion 3D. »), `INCOMPLETE` (une valeur sans référence verticale : un nombre sans repère ne se compare à rien), `FOURNIE` (une valeur et sa référence : les données existent, **l'évaluation 3D n'est pas implémentée**). `evaluable` est toujours faux et `conclusion3D` toujours nul.
- La classe **E** (« inconnue / sans géométrie », cahier 20.2) peut être déclarée mais **n'entre jamais dans une association automatique** (pas de faux tracé).

## 5. API

Préfixe `/api/v2/projets-voirie`, mêmes gardes et même ordre que le socle (authentification, clé de module, octet NUL, identifiants, rôle, projet désigné à 404 masqué, validation, service). Écritures : `ADMIN` et `GESTIONNAIRE`. Lecture : toute personne qui a la clé de module, limitée aux jeux qu'elle peut lire. Dix routes (formes de réponse : `API.md`) :

| Route | Rôle | Contenu |
|---|---|---|
| `GET /:id/reseau/objets` | lecture | objets des réseaux (nature et qualité effectives, source, vertical), filtres `jeuId`, `nature`, `typeObjet`, `q`, curseur, `limite` ≤ 200 ; **aucune géométrie** |
| `GET /:id/reseau/objets/:objetId` | lecture | fiche : objet, relations (rôle SOURCE ou CIBLE), circuits à la trace strictement identique |
| `PUT /:id/reseau/objets/:objetId/descripteur` | écriture | crée (201) ou **remplace** (200) le descripteur ; une valeur omise est inconnue |
| `GET /:id/reseau/relations` | lecture | relations dont les **deux bouts** sont lisibles ; filtres `statut` (liste), `type`, `objetId`, `origine`, curseur |
| `POST /:id/reseau/relations` | écriture | déclaration manuelle (créée `VALIDEE`) |
| `POST /:id/reseau/relations/:relId/valider` / `refuser` / `revoquer` | écriture | corps `{ justification }` |
| `POST /:id/reseau/associations/proposer` | écriture | propositions par superposition (section 7) ; 201 |
| `GET /:id/reseau/comptage` | lecture | comptage par nature (section 6) ; `jeuId` ; `inclureNonAutorises` (ADMIN et GESTIONNAIRE : 403 `QUARANTAINE_RESERVEE` sinon) |

Aucune route de suppression, d'export, d'ordre ni de déplacement. Les écritures sont auditées dans la transaction qui les porte (`ReseauObjetDescripteur`, `ReseauRelation`, `AssociationsReseau`), sans géométrie.

## 6. Règles de comptage

Noyau pur `comptage.noyau.ts` (fonction `comptabiliser` sur géométrie plane, oracle de tests ; `assemblerComptage` sur mesures PostGIS : même forme de réponse).

- `infrastructuresPhysiques.nombreDeclare` : **nombre d'infrastructures déclarées** (objets déclarés `ACTIF_PHYSIQUE`, sans dédoublonnage géométrique ; une chambre y compte) ; `longueurTraceFusionneM` : **longueur de trace fusionnée** (union des tracés) ; `longueurSommeM` : somme.
- `circuitsLogiques.nombreDeclare` : circuits déclarés (**pas un nombre de câbles**) ; `sommeLongueursCircuitsM` : **somme des longueurs de circuits** (un tracé partagé par N circuits y compte N fois : ce n'est pas une longueur de câble) ; `longueurTraceFusionneM` ; `tracesPartagees` (groupes de tracé strictement identique, sens de lecture indifférent) ; `supportPhysique` : circuits avec support validé, avec proposition seule, sans support connu.
- `equipements`, `natureInconnue` : à part. Un objet de nature inconnue n'est compté **ni comme infrastructure ni comme circuit**.
- **Il n'existe aucun total « tous objets »** ni aucune somme qui mélange les natures. Chaque grandeur porte son libellé (`libelles`). `avertissements` rappelle que les circuits ne sont pas des câbles et que le support physique non validé est inconnu, jamais supposé.
- **Fixtures synthétiques KIS-LOGIC-01** : trois circuits au même tracé (dont un à l'envers) et un câble physique distinct : 1 infrastructure, 3 circuits, somme 450 m, trace fusionnée 150 m, 80 m de câble, groupe de tracé identique = 1 (tests `comptage.noyau.test.ts` et banc PostGIS).
- Jeux comptés : par défaut les jeux `AUTORISE` ; avec `inclureNonAutorises`, un jeu en attente **remplace** celui de même rôle et concessionnaire (jamais deux fois le même réseau).

## 7. Association circuit logique vers infrastructure physique (propositions)

`POST /:id/reseau/associations/proposer` (corps facultatif : `jeuId`, `couvertureMin` 0,5 à 1, `parCircuitMax` 1 à 20, `tolerances` par classe 0,01 à 100 m). Méthode, enregistrée dans chaque proposition :

1. jeux **`AUTORISE`** seulement ; circuits et infrastructures **linéaires** de **même type de réseau** ; classe **E exclue** ;
2. **tolérance du couple = maximum** de la tolérance de la classe de chaque objet et de leurs précisions horizontales déclarées (jamais leur somme : cahier 21.1) ;
3. un circuit est proposé pour une infrastructure si au moins `couvertureMin` de sa longueur est à moins de cette tolérance (UTM, `ST_Buffer` à 8 segments par quart de cercle, index GiST) ;
4. au plus `parCircuitMax` propositions par circuit (les mieux couvertes) ; un humain choisit.

**Valeurs par défaut PROVISOIRES, à valider par la DSI** (le cahier 20.2 demande de ne pas attribuer une précision standard : ce sont des tolérances de **rapprochement**, pas des précisions attribuées aux données) : `A=0,5 m`, `B=1 m`, `C=2 m`, `D=5 m`, `INCONNUE=2 m` ; couverture minimale 0,9 ; 5 propositions par circuit ; 3 000 circuits au plus par exécution (422 `TROP_DE_CIRCUITS` ; mesuré sur le banc de volume : 3 000 circuits en 3 à 13 s selon la charge du poste, 10 000 en 8 à 21 s, 20 000 en 22 s, pour un délai de la base de 20 s ; pour davantage, restreindre à un jeu et relever `PROJETS_VOIRIE_DELAI_ANALYSE_MS`) ; 10 000 propositions au plus (`tronque`) ; une exécution toutes les 30 s par projet (429 `ASSOCIATION_TROP_FREQUENTE`). Réglables par `PROJETS_VOIRIE_ASSOC_TOLERANCES_M`, `_COUVERTURE_MIN`, `_PAR_CIRCUIT_MAX`, `_CIRCUITS_MAX`, `_INTERVALLE_S` (bornés ; hors bornes : défaut).

Gardes : verrou du projet (503 `PROJET_OCCUPE`), 3 calculs simultanés par processus (503 `SERVICE_OCCUPE`), délai côté base (504 `ASSOCIATION_TROP_LONGUE`), une exécution simultanée à la fois par projet (la seconde voit l'audit de la première : 429).

## 8. Extension minimale de RC-3 et de l'analyse 2D

Détail et décisions : `CONTRAT-CONFLITS.md`, section 9, points 35 à 41. Résumé : (a) chaque dossier porte `cible` (nature effective, qualification : infrastructure physique, circuit porté par une infrastructure validée, simple circuit logique sans support validé, équipement, nature inconnue ; support physique ; circuits superposés) ; (b) l'analyse persistée prend la classe de précision **déclarée par l'objet**, sinon celle du jeu ; (c) l'analyse 2D du socle et la carte portent la nature et la classe effectives par objet, et des totaux **par nature** à la granularité du jeu. **La classification, la clé stable et la mesure des dossiers ne changent pas.**

## 9. Connectivité du réseau : NON implémentée, ce qu'il faudrait

Le cahier (20.3, lot 7) reporte la connectivité : « une simple proximité géométrique ne prouve pas que deux câbles ou conduites sont connectés ». Ce lot ne crée ni nœud, ni arête, ni trace amont ou aval. Pour la faire, il faudrait :

1. des **nœuds explicites** (chambres, jonctions, boîtes, transformateurs, vannes) et des **segments** d'infrastructure entre nœuds, issus d'une source qui déclare les raccordements (pas déduits de la proximité) ;
2. une table de **règles de connectivité par type de réseau** (quel type d'équipement peut se raccorder à quel type de segment ; exceptions explicites et auditées), versionnée et approuvée comme les règles de conflit ;
3. des **raccordements** déclarés, avec statut et validation humaine comme les relations de ce lot, et la gestion des ruptures (réseau discontinu) en rapport d'anomalies, sans raccord automatique ;
4. des **références verticales** fiables (profondeur et altitude qualifiées) pour toute conclusion qui dépend de la 3D ;
5. les fonctions de trace (amont, aval, portions isolables) **après** validation des connectivités, et leurs tests sur des réseaux synthétiques.

Les relations `PORTE_PAR` et `CONTENU_DANS` de ce lot en sont un **préalable**, pas un substitut.

## 10. Limites connues et décisions à prendre

Voir `docs/reports/LOT-B1-RAPPORT.md`. En résumé : tolérances et seuil de couverture à valider ; les descripteurs et relations suivent l'**objet**, donc ne se reportent pas automatiquement à une nouvelle version d'un jeu (le delta par empreinte pourrait les proposer) ; la classe d'un objet est une déclaration humaine (justifiée, auditée), pas une mesure ; les totaux de l'analyse 2D restent au niveau du jeu ; `parType` et `parConcessionnaire` du socle somment toujours les natures d'un même type de réseau (ajouter `parNature`, ne pas les réécrire) ; la proposition ne porte que sur des jeux autorisés.

## 11. Corrections de la revue de la vague 1 et constats documentés (ajouts)

Cette section complète les sections 5, 6 et 8 ; en cas de divergence, elle l'emporte.

### 11.1 Un support ne se compte que sur un jeu AUTORISE, pour tous les rôles (m3)

Le **support physique d'un circuit** (blocs `circuitsLogiques.supportPhysique` du comptage et `cible.supportPhysique` des dossiers de conflit) ne compte une relation `PORTE_PAR` (validée ou proposée) que si la **cible** appartient à un jeu `AUTORISE`, quel que soit le rôle du compte. Avant : la cible était filtrée par les statuts lisibles du rôle, ce qui faisait compter à un `ADMIN` ou `GESTIONNAIRE` un support d'un jeu `REMPLACE` ou `REJETE` que le lecteur ne comptait pas (deux chiffres sur la même page). Conséquence assumée : quand l'infrastructure est remplacée par une nouvelle version, ses relations ne comptent plus tant que le support n'est pas de nouveau associé à la version autorisée (les descripteurs et relations suivent l'objet, section 10). Les listes de relations (`GET .../reseau/relations`) restent, elles, filtrées par la lisibilité du rôle : un décideur y voit aussi les relations dont un bout est dans un jeu `REMPLACE`.

### 11.2 Consultation des relations et du comptage tracée (m4)

Comme la lecture des objets, trois lectures sont **tracées** (`ConsultationJeuProjet`, action `SECURITY_EVENT`, route `reseau`, une ligne au plus par compte, jeu et fenêtre de 15 minutes, sans géométrie ni nom d'objet, écrite **avant** la remise des données) pour chaque jeu `CONFIDENTIEL_CONCESSIONNAIRE` ou `INFRASTRUCTURE_SENSIBLE` rendu :

- `GET /:id/reseau/relations` : les jeux des **deux bouts** de chaque relation de la page ;
- `GET /:id/reseau/objets/:objetId` : le jeu de l'objet **et** ceux des objets de l'autre bout de ses relations ;
- `GET /:id/reseau/comptage` : chaque jeu retenu (le comptage rend nom de fichier, concessionnaire et longueurs par jeu).

Les réponses d'écriture (déclarer, valider, refuser, révoquer) sont déjà auditées par leur propre ligne d'audit.

### 11.3 Constats documentés, non corrigés

- **Verrou du projet tenu par une association en échec** : une proposition d'association interrompue par le délai de la base (504 `ASSOCIATION_TROP_LONGUE`, jusqu'à 20 s) tient le verrou du projet pendant ce délai, sans cadence entre deux échecs consécutifs ; les écritures concurrentes du projet attendent puis répondent 503 `PROJET_OCCUPE` (voir `CONTRAT-WORKFLOW.md`, 9 bis). La cadence n'est appliquée qu'aux exécutions qui réussissent. Décision à prendre : cadence aussi sur les échecs, ou verrou consultatif propre à l'association comme pour l'analyse de conflits.
- **O7** : un descripteur modifie la classe ou la précision effective d'un jeu `AUTORISE` utilisée par la détection de conflits (RC-3), par un seul `GESTIONNAIRE`, sans contrôle à quatre yeux. Décision réservée au DSI : droits de descripteur et double validation.
- **O11** : voir `CONTRAT-WORKFLOW.md`, section 11 (statut `RETIRE` rendu aux seuls comptes qui décident, comme le socle).

## 12. Connectivité déclarative (lot S1, ajout du 09/11/2026)

La section 9 reste vraie : **aucune connectivité n'est calculée**. Le lot S1 (`CONTRAT-SOURCES.md`, section 3.5) ajoute seulement ce qu'une source **déclare** :

- type de relation `CONNECTE_A` (deux objets **physiques** : infrastructure ou équipement, toute géométrie ; un circuit logique ne se connecte pas, il est porté) et colonne `preuve` (`CONFIRMEE_PAR_FOURNISSEUR`, `INCONNUE`), **obligatoire pour `CONNECTE_A` et interdite pour les autres types** (contrainte `rr_preuve_connexion`), figée (déclencheur) ;
- origine `IMPORT_DECLARATIF` : au dépôt, le champ de mapping `connecteA` (portée objet) désigne la colonne qui porte le **nom** de l'objet connecté **dans le même fichier** ; une relation `VALIDEE`, preuve `CONFIRMEE_PAR_FOURNISSEUR`, est créée pour chaque nom résolu sans ambiguïté ; un nom introuvable ou ambigu ne crée rien (avertissement `CONNEXIONS_NON_RESOLUES`) ; le jeu doit déclarer une nature physique (422 `CONNECTE_A_NATURE_REQUISE`) ;
- saisie humaine : `POST /:id/reseau/relations` avec `type: "CONNECTE_A"`, `preuve`, `justification` (créée `VALIDEE`, origine `MANUELLE`) ; `preuve` manquante pour `CONNECTE_A` ou donnée pour un autre type : 400 `CHAMPS_INVALIDES` ;
- la fiche d'un objet (`GET /:id/reseau/objets/:objetId`) porte `connexions` : `{ etat: CONFIRMEE | INCONNUE | NON_FOURNIE, nbConfirmees, nbInconnues, libelle }` ; « non fournie » ne veut pas dire « isolé » ; il n'existe aucun état « continu » ;
- **garde statique** : `backend/src/projets-voirie/sources/connectivite.statique.test.ts` fait échouer toute écriture de `CONNECTE_A` appuyée sur un prédicat spatial (`ST_DWithin`, `ST_Intersects`, `ST_Distance`, `&&`...) et toute fonction, hors des deux autorisées, qui en écrirait (mutation prouvée par le test).

Ce n'est toujours **pas** une topologie : ni nœuds, ni segments, ni traces amont ou aval (section 9, points 1 à 5, inchangés).


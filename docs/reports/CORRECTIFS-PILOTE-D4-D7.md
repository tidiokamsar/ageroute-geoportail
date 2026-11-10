# Correctifs du pilote local : D4 (capacité des calculs lourds) et D7 (un dossier de couverture par axe)

Date : 10/11/2026. Branche `fix/pilote-d4-d7` (worktree `w-d4d7`), partie de `feat/vague3-integration` @ `3c90e96`. Défauts constatés par le pilote local du 09/11/2026 (rapport de recette hors dépôt, sections 4, 7 et 8). Aucune donnée réelle : toutes les mesures portent sur des jeux **synthétiques** fabriqués par les bancs. Aucune migration. Aucune connexion à la production, aucun déploiement, aucun envoi.

## 0. Conditions de mesure

Poste de développement partagé avec d'autres agents : **charge processeur de l'hôte relevée à 100 %** pendant toutes les mesures (comme au pilote). Conteneur jetable `postgis/postgis:17-3.5` (`d4-postgis`, 127.0.0.1:5485), réglages par défaut de l'image ; le module pose `jit = off` par transaction (correctif D2, déjà présent dans la branche). Les durées absolues varient du simple au triple d'une série à l'autre selon la charge des autres agents ; **les comparaisons avant / après sont faites côte à côte** (même base, même minute, requêtes alternées : voir 1.3), et les plafonds par défaut sont tirés des durées **sur ce poste chargé**.

Jeu synthétique (banc `projets-voirie-capacite`, graine fixe) : 12 axes de 8 km (6 est-ouest, 6 nord-sud, un sommet tous les 100 m) dans un carré d'environ 8 km, et N lignes de réseau aléatoires de 2 à 6 sommets (pas de 10 à 60 m, directions au hasard, départs uniformes), environ 4 sommets par ligne comme le jeu du pilote (50 000 lignes, 199 720 sommets). C'est un cas **défavorable** : les lignes couvrent tout le carré et se croisent beaucoup (la fusion de 20 000 lignes donne 69 296 morceaux). Les axes et une première ligne passent par l'API (dépôt, autorisation) ; les N − 1 autres lignes sont insérées en SQL dans le jeu autorisé (le dépôt de 50 000 objets est déjà mesuré par le pilote).

## 1. D4 : capacité

### 1.1 Mesure d'avant (code de `3c90e96`, délai porté à 300 s pour connaître la durée réelle)

| Objets de réseau (sommets) | Analyse 2D | Comptage | Analyse persistée (dossiers) |
|---|---|---|---|
| 1 000 (3 999) | 1,9 s | 0,2 s | 1,2 s (408) |
| 5 000 (19 973) | 7,8 s | 0,7 s | 5,0 s (1 787) |
| 20 000 (80 103) | **52,9 s** | 3,3 s | 20,5 s (7 039) |
| 50 000 (200 310) | **299,8 s** | **35,2 s** | **104,1 s** (17 378) |

Avec le délai par défaut de 20 s, tout ce qui dépasse 20 s de calcul répond 504 (ou 500 avant D3). Étapes de l'analyse 2D à 50 000 objets : par jeu 93,7 s, par axe 39,1 s, par objet 13,5 s, croisements 34,9 s, zones 116,3 s. Cause trouvée par la mesure : **chacune des quatre requêtes « par jeu », « par axe », « croisements » et « zones » refusionnait TOUT le réseau** (`ST_UnaryUnion` de 50 000 lignes : 5,5 s à elle seule pour 20 000 lignes), alors que seules les parties à moins de la demi-emprise d'un axe entrent dans les mesures ; et les calculs par objet transformaient et examinaient tous les objets, avec un tampon recalculé sur des morceaux d'axe de 6,4 km (64 sommets levés tous les 100 m).

### 1.2 Restructuration faite (sans risque : résultats identiques, prouvés)

1. **Préfiltre des objets voisins** (`analyse.depot.ts`, `proches`) : par l'index GiST existant de `projets_voirie_objets.geom`, ne garder que les objets dont la boîte touche celle d'un morceau d'axe (64 sommets) élargie de `distance × 1,1 + 1 m`, convertie en degrés par le plus petit degré de latitude et par le degré de longitude au bord du morceau le plus éloigné de l'équateur. La boîte élargie contient tout point à moins de `distance` de l'axe : aucun objet qui peut contribuer n'est écarté ; un objet écarté a une intersection vide avec toute bande de ce rayon. Coût : 0,19 s pour 20 000 lignes (2 811 retenues, 14 %). Appliqué à la fusion du réseau (`res`) des quatre requêtes, au calcul par objet de l'analyse 2D et au calcul des candidats de l'analyse persistée (à demi-emprise + tolérance de proximité).
2. **Découpe des morceaux d'axe à la boîte de l'objet** (`ST_ClipByBox2D`, boîte de l'objet élargie de deux fois le rayon + 1 m) avant les tampons, dans le calcul par objet et dans les candidats ; et découpe du réseau fusionné à la boîte de la bande de chaque axe dans « par axe ». Le point de l'axe le plus proche d'un point de l'objet à moins du rayon est dans la boîte, à plus d'un rayon de son bord : intersections inchangées, tampons bien plus petits.
3. **« Hors emprise »** : calculé avec `longueurTraceFusionneM` du jeu, mesurée au dépôt avec la même définition (`ST_Length(ST_UnaryUnion(ST_Collect(geom))::geography)`), au lieu de refusionner tout le réseau à chaque analyse. La couche d'affichage `zones.hors` ajoute les objets éloignés simplifiés à 2 m un par un, **non fusionnés entre eux** (seul changement visible : des tracés éloignés superposés y figurent deux fois ; la couche reste disjointe des deux autres, aucun objet éloigné ne touche une bande).

**Non fait, et pourquoi** : la fusion de tout le réseau par le **comptage** (longueur de tracé fusionné par nature) est sa mesure même ; une fusion par tuiles additionnerait deux fois les tracés posés exactement sur une limite de tuile (risque d'écart sans contrôle simple) ; le comptage est donc seulement protégé par le comptage préalable. L'écriture des dossiers de l'analyse persistée (environ 1 s pour 1 000 dossiers sur ce poste) n'est pas modifiée : elle est hors du budget de calcul, sous le délai de dépôt par requête. Un traitement asynchrone des très gros projets reste à décider (recommandation 3 du pilote).

### 1.3 Mesure avant / après côte à côte (même base, même minute)

Requêtes d'avant (copie du code de `3c90e96`) et d'après exécutées en alternance (après, avant, après) dans une transaction `jit = off` ; **résultats comparés un à un** (longueurs arrondies au centimètre, croisements, objets, types, cellules des candidats). À 1 000, 5 000 et 20 000 objets : **identiques pour les six requêtes**. À 50 000 objets : identiques pour « par objet », « croisements », « zones » (tailles des couches) et les candidats de l'analyse persistée ; « par jeu » et « par axe » diffèrent du **bruit flottant** de la fusion (le réseau fusionné n'a pas les mêmes noeuds hors des bandes quand on ne fusionne que les objets voisins) : 0,01 et 0,02 m sur 53 954 m et 115 694 m pour le jeu, au plus 3 mm (chaussée) et 6,5 mm (emprise) par axe, croisements identiques (4 894).

| Requête | 5 000 objets avant / après | 20 000 objets avant / après | 50 000 objets avant / après |
|---|---|---|---|
| par jeu | 5,1 s / 1,7 à 2,2 s | 28,6 s / 3,5 à 6,2 s | 127,0 s / 14,0 à 19,9 s |
| par axe | 3,7 s / 1,5 à 1,7 s | 22,8 s / 7,0 à 7,4 s | 78,6 s / 18,0 à 23,8 s |
| par objet | 3,8 s / 2,4 à 2,6 s | 8,9 s / 6,2 à 7,0 s | 21,9 s / 13,6 à 15,2 s |
| croisements | 2,6 s / 1,2 à 1,3 s | 9,8 s / 2,2 à 3,6 s | 73,1 s / 6,7 à 6,9 s |
| zones | 6,2 s / 3,0 s | 37,4 s / 8,8 à 12,8 s | 186,1 s / 35,5 à 41,7 s |
| candidats (analyse persistée) | 4,8 s / 2,3 à 4,0 s | 19,1 s / 6,5 à 9,4 s | 41,7 s / 28,0 s |

Gain : un facteur 1,3 (par objet) à 8 (par jeu) à 20 000 objets, 1,4 (par objet) à 11 (croisements) à 50 000 ; somme des cinq requêtes de l'analyse 2D à 50 000 objets : 487 s avant, 88 à 107 s après ; à 1 000 objets, aucun gain mesurable (0,5 à 1 s par requête, dans le bruit de la charge). Le calcul par objet (environ 3 ms par objet voisin sur ce poste : tampons et intersections GEOS) reste linéaire en nombre d'objets voisins.

### 1.4 Comptage préalable et refus immédiat

Les trois calculs (analyse 2D `GET /:id/analyse` et son export CSV, comptage `GET /:id/reseau/comptage`, analyse persistée `POST /:id/analyses`) commencent par le même comptage (`analyse.depot.ts`, `volumes`) : objets **linéaires** et sommets des jeux retenus (même règle de retenue qu'avant, `CONTRAT-SOURCES.md` 7.2), lus dans les objets eux-mêmes (`count(*)`, `ST_NPoints`, aucun calcul géométrique ; 0,2 s pour 50 000 objets et 200 000 sommets ; jamais le compteur `nbObjets` du jeu). Au-delà d'un plafond : **422 `ANALYSE_TROP_VOLUMINEUSE`** (le code de RC-3, réutilisé pour les trois calculs), avec `calcul` (`ANALYSE_2D`, `COMPTAGE`, `ANALYSE_CONFLITS`), `objets`, `sommets`, `objetsMax`, `sommetsMax` et le détail axes / réseaux ; l'analyse persistée laisse une ligne `ECHEC` (règle existante des refus de volume). Jamais un 500. Code : `backend/src/projets-voirie/capacite.ts`.

Réglages (bornés ; hors bornes ou illisible : le défaut) : `PROJETS_VOIRIE_ANALYSE_OBJETS_MAX` **défaut 5 000** (bornes 100 à 200 000), `PROJETS_VOIRIE_ANALYSE_SOMMETS_MAX` **défaut 200 000** (bornes 1 000 à 4 000 000). Les anciens plafonds de 500 000 sommets d'axes et 3 000 000 de sommets de réseau (aucune mesure derrière, et 200 000 sommets passaient sans refus) ne s'appliquent plus à ces trois calculs ; le second reste celui de la comparaison de sources (non touchée).

### 1.5 Mesure d'après (code final, délai porté à 300 s et plafonds à leur borne haute pour mesurer)

| Objets de réseau (sommets) | Analyse 2D | Comptage | Analyse persistée (dossiers ; dont candidats) |
|---|---|---|---|
| 1 000 (3 999) | 6,3 s (1,9 s dans le banc de vérification) | 0,8 s | 2,6 s (408 ; 0,8 s) |
| 5 000 (19 973) | 9,7 s | 2,8 s | 8,8 s (1 787 ; 1,9 s) |
| 5 000 denses (221 851, environ 44 par ligne) | 8,0 s | 4,1 s | 8,9 s (1 787 ; 2,9 s) |
| 20 000 (80 103) | 32,0 s | 7,0 s | 40,8 s (7 039 ; 11,8 s) |
| 50 000 (200 310) | 90,6 s (avant : 299,8 s) | 29,2 s (avant : 35,2 s, non restructuré) | 75,1 s (17 378 ; 20,4 s ; avant : 104,1 s) |

Mêmes nombres de dossiers avant et après à chaque taille (408, 1 787, 7 039, 17 378). Le comptage n'a pas changé (ses écarts sont ceux de la charge). Pour une analyse persistée, la durée totale inclut l'écriture des dossiers (hors budget de calcul de 20 s, sous le délai de dépôt par requête) : 7 039 dossiers prennent environ 28 s d'écriture sur ce poste.

### 1.6 Plafonds par défaut et leur justification

Sur ce poste chargé, avec le délai par défaut de 20 s, le calcul le plus lent (analyse 2D) tient en 8 à 10 s à 5 000 objets (20 000 ou 222 000 sommets) et dépasse le délai à 20 000 objets (32 s). Défauts retenus : **5 000 objets linéaires et 200 000 sommets** (axes et réseaux des jeux retenus), soit une marge d'un facteur 2 sous le délai sur un poste chargé, pour chacun des trois calculs. Les cas réels du pilote en sont loin (36 axes et 16 lignes ; 128 et 52 lignes d'axes ; 183 et 38 points). Le jeu de 50 000 objets du pilote est refusé en 0,2 à 0,4 s par les trois calculs, avec son volume et les plafonds (banc de vérification, section 3). Un serveur plus rapide peut relever les plafonds (bornes 200 000 et 4 000 000) après mesure par le banc (`PV_CAPACITE_MESURE=1`) ; un projet au-delà relève d'un traitement asynchrone, non fait (décision à prendre).

**Décisions à prendre (DSI)** : valeur des plafonds en production après mesure sur le serveur réel ; traitement asynchrone des très gros projets ; découpage d'un projet par zone (aujourd'hui : refus avec un message qui le conseille).

## 2. D7 : un dossier de couverture insuffisante par axe

**Avant** : `couvertureDesAxes` rendait une ligne par OBJET du plan d'axes, et chaque objet non couvert devenait un dossier (clé : nom d'axe et cellule de son milieu) ; un corridor découpé en 128 feuilles faisait 128 dossiers.

**Décision appliquée (architecte, 10/11/2026)** : un seul dossier par axe du plan d'axes (`conflits/couverture.noyau.ts`, noyau pur) :
- identité de l'axe : valeur de la colonne `identifiant` du mapping du jeu (`resume.import.mapping.identifiant`) si elle existe et n'est pas vide pour l'objet, sinon nom normalisé (`normaliserNom`, la normalisation de la clé stable) ; un objet sans nom ni identifiant garde son propre dossier, **avec la clé, la mesure et la géométrie d'avant** (même dossier au rejeu) ;
- seuls les morceaux **non couverts** entrent ; géométrie : leur réunion (`ST_UnaryUnion` puis `ST_LineMerge`, `conflits.depot.ts` `geometriesCouverture`), un seul morceau : sa géométrie telle quelle ;
- mesure : `longueurPieceM` = longueur de la réunion ; `morceaux` = nombre, longueur totale, détail par morceau (objet, rang, nom, longueur ; 1 000 lignes au plus, `detailTronque`) : aucune perte d'information ; la **liste** des dossiers ne porte que le nombre, la longueur totale et `detailTronque`, la **fiche** le détail ; l'interface (fiche d'un dossier) affiche « N morceaux du plan d'axes, X m au total » et la liste dépliable des morceaux ;
- clé stable : SHA-256 de (`couverture-axe-v1`, projet, identité, type), sans cellule, espace de clés distinct de `cleConflit` ; même entrée, même clé ; un morceau ajouté, retiré ou redécoupé garde la clé et change la mesure (empreinte : nombre, longueur totale, longueur de chaque morceau ; les identifiants d'objet n'y entrent pas) ;
- historique en ajout seul : rien ne change à son mécanisme (lignes `CREATION`, `MESURE_MODIFIEE`, `REEXAMEN`, `RETROUVE` du rejeu existant) ;
- version de l'algorithme `RC3-2D-UTM-2` ; résumé : `axesNonCouverts` = dossiers de couverture, `morceauxNonCouverts` (nouveau) = objets non couverts ; les dossiers des autres types sont inchangés (clés et mesures : banc `conflits-projets-voirie`, comparaison côte à côte de la section 1.3).

**Effet sur les analyses existantes** (le module n'est pas en production : aucune migration de données) : une analyse `RC3-2D-UTM-1` rejouée reste cohérente par les règles du rejeu. Ses dossiers de couverture **par objet** ne sont plus retrouvés : ils restent en base, statut, verdict humain, responsable, preuves, décisions et historique intacts, marqués `aReexaminer` (`NON_RETROUVE`) ; leur ligne `REEXAMEN` porte en plus `regroupeDans: { conflitId, cle }`, le dossier regroupé de leur axe (même nom normalisé), pour que la personne reporte son verdict. Les dossiers regroupés sont créés. Une comparaison avant / après montre les anciens en `disparus` et les nouveaux en `apparus`. Un objet sans nom n'est pas concerné. Prouvé par le banc `conflits-couverture-axes` (section 4 du banc : un dossier par objet au statut INFIRME, verdict humain, inséré tel que l'écrivait l'ancien algorithme).

**Limite** : le regroupement suit le nom ; deux axes distincts de même nom (sans identifiant mappé) sont réunis en un dossier, comme ils l'étaient déjà dans la clé d'un dossier de conflit (nom normalisé). Le mapping `identifiant` les sépare (banc, section 5).

## 3. Constat en cours de route : `updatedAt` d'un dossier de couverture regroupé

Le banc de non-régression `conflits-projets-voirie` (vérification m11) a échoué une fois après le premier correctif D7 : sur une nouvelle version du plan d'axes, un dossier de couverture regroupé **inchangé** voyait son `updatedAt` changer, parce que `majConflitsRetrouves` comparait le JSON de la mesure et que le détail des morceaux porte les identifiants d'objet (qui changent à chaque version). Corrigé : `updatedAt` change si et seulement si l'**empreinte** de la mesure change (décision du rejeu, `mesureModifiee`), ce qui est équivalent pour tous les autres dossiers ; le détail est repointé sur les objets de la version courante. Vérification ajoutée au banc D7 (axe inchangé : `NOUVELLE_VERSION_DONNEES`, `updatedAt` inchangé, détail sur un objet du jeu autorisé) ; la mutation (comparaison du JSON rétablie) la fait échouer.

## 4. Tests (chiffres réels du 10/11/2026)

| Contrôle | Résultat |
|---|---|
| `npx tsc --noEmit` backend | code 0 |
| `npx tsc --noEmit` frontend | code 0 |
| Suite backend complète `npx vitest run` | 343 fichiers, 6 853 tests réussis, 1 ignoré (code 0) |
| Tests unitaires nouveaux | `capacite.test.ts` 9 (plafonds bornés, refus 422 et sa forme, preuve statique que les trois calculs appellent le comptage préalable avant leur premier calcul lourd) ; `conflits/couverture.noyau.test.ts` 15 (identité, regroupement, objets sans nom, mapping, ordre, détail borné, clé stable, clé d'avant pour un objet sans nom, empreinte, relecture) |
| Frontend (composants et pages du module, `lib/projetsVoirie*`, accessibilité) | 32 fichiers, 1 244 tests réussis, dont 3 nouveaux (lecture des morceaux ; fiche : nombre, longueur, détail, mention de troncature ; aucun morceau pour un autre dossier) |
| Banc `projets-voirie-capacite` (nouveau, réglages par défaut) | **55/55** : 1 000 objets calculés (200/201) ; 5 012, 20 012 et 50 012 objets refusés en 0,1 à 0,4 s par les trois calculs, volume et plafonds dans la réponse, ligne `ECHEC` sans dossier, aucune requête active ensuite |
| Banc `conflits-couverture-axes` (nouveau) | **19/19** |
| `projets-voirie` | 141/141 |
| `conflits-projets-voirie` | 169/169 (après le correctif de la section 3 ; 168/169 avant) |
| `reseau-physique-logique` | 130/130 |
| `sources-comparaison` | 73/73 |
| `exports-tableaux` | 54/54 |
| `documents-projet` | 47/47 |
| `projets-voirie-charge` | 10/10 (il échouait dès sa première requête depuis le lot T1, faute de territoire : enveloppe `territoire-par-defaut` ajoutée ; il porte les plafonds à leur borne haute pour éprouver les délais, et vérifie en plus le refus 422 immédiat, 1,2 s, avec les plafonds par défaut) |

**Mutations** (toutes rétablies, `git diff` vide ensuite) :
- retrait du comptage préalable (`exigerCapacite` neutralisé) : banc `projets-voirie-capacite` 14/18 (20 000 objets : analyse 2D **504** après 21 s, comptage et analyse persistée calculés au lieu du refus) ; test statique : 1 échec par calcul neutralisé ;
- clé de regroupement par objet (un groupe par objet) : `couverture.noyau.test.ts` 8 échecs sur 15 ; banc `conflits-couverture-axes` 11/18 (63 dossiers au lieu de 4, aucun regroupement par identifiant, nouveau dossier au lieu de `MESURE_MODIFIEE`) ;
- `updatedAt` sur l'égalité du JSON : banc `conflits-couverture-axes` 18/19.

**Non exécuté** : la suite `run.sh` complète des bancs (hors module) ; une mesure sur un serveur de préproduction (configuration PostgreSQL réelle, poste non partagé) ; des données réelles (jamais lues ni recherchées). Le comptage n'a pas été restructuré (section 1.2). L'inventaire des accès et le test d'isolation ne changent pas : aucune route n'est ajoutée ni modifiée.

## 5. Fichiers

Code : `backend/src/projets-voirie/capacite.ts` (nouveau), `analyse.depot.ts`, `analyse.service.ts`, `reseaux/comptage.service.ts`, `conflits/couverture.noyau.ts` (nouveau), `conflits/classification.noyau.ts`, `conflits/types.noyau.ts`, `conflits/conflits.depot.ts`, `conflits/analyse-conflits.service.ts`, `conflits/dossiers.service.ts` ; interface : `frontend/src/lib/projetsVoirieConflitsApi.ts`, `components/projets-voirie/FicheConflit.tsx`. Tests : `capacite.test.ts`, `conflits/couverture.noyau.test.ts`, bancs `projets-voirie-capacite`, `conflits-couverture-axes` (nouveaux), `conflits-projets-voirie` (version d'algorithme attendue), `projets-voirie-charge` (territoire, plafonds), tests frontend. Documentation : `API.md` (capacité, réglages, erreurs, couverture par axe, rejeu), `CONTRAT-CONFLITS.md` (points 47 à 52), `CONTRAT-SOURCES.md` (7.2), `backend/tests-integration/README.md`. Aucune migration (aucun changement de schéma) : `DERIVE-SCHEMA.md` inchangé.

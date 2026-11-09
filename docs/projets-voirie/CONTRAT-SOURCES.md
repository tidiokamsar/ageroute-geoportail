# Sources multiples d'un réseau, comparaison entre sources et connectivité déclarative : contrat d'interface (lot S1)

Statut : contrat du lot S1 du 08/11/2026, commun au backend et à la future interface (UI-C). Complète `CONTRAT.md` (socle), `CONTRAT-CONFLITS.md` (dossiers de conflit, RC-3), `CONTRAT-RESEAUX.md` (descripteurs et relations, B1) et `CONTRAT-IMPORT.md` (A1). Référence : décision architecturale 2 (08/11/2026), sections 4 et 5 ; cahier des charges v2.0, sections 6.1 (« Conflit de données : plusieurs sources donnent des tracés différents pour un réseau ; dossier de divergence, chaque source préservée »), 20.3 (connectivité : « une simple proximité géométrique ne prouve pas que deux câbles sont connectés »), 21.1 (« ne pas additionner les précisions arbitrairement sans méthode documentée »), scénarios KIS-LOGIC-01 et KIS-REV-01. Base : `feat/vague2-integration` (commit `cfe8e4e`). Migration : `20261103300000_multi_sources_comparaison` (additive, avec descente). Référence des formes de réponse : `API.md`, section « Sources multiples, comparaison et connectivité (lot S1) ».

## 1. Principe

Un réseau de concessionnaire peut être décrit par **plusieurs sources** (plan du concessionnaire, relevé GNSS, détection, numérisation d'un plan papier). Le socle ne connaissait que des **versions** d'une même source (une nouvelle livraison remplace la précédente). Ce lot distingue les deux :

- une **source** est un jeu de données caractérisé par son concessionnaire, son type de réseau et sa **méthode d'acquisition** ; deux jeux de même concessionnaire et de même type mais de méthodes différentes sont deux sources du **même réseau** ;
- une **version** reste une nouvelle livraison de la **même source** (même concessionnaire, même méthode) : elle remplace la précédente à son autorisation, avec le delta et la revue des suppressions du lot A1, inchangés.

Le même mécanisme compare **deux versions d'un même plan d'axes** (rôle `AXES_TRAVAUX`) : par exemple un axe tracé depuis un plan PDF (classe C), puis le même axe livré en DXF par le bureau d'études. Un plan d'axes n'a jamais deux sources autorisées en même temps (elles doubleraient les axes de l'analyse) : la nouvelle livraison est une **version candidate**, en contrôle, que l'on compare à la version autorisée **avant de l'autoriser** (mode `VERSION_CANDIDATE`, ajout du 09/11/2026, section 4.1).

Un réseau qui n'a qu'une source est dans l'état **normal** `SOURCE_UNIQUE_COMPARAISON_INDISPONIBLE` : aucune divergence n'est calculée, aucun avertissement d'erreur n'est émis. Dès qu'un réseau a deux sources `AUTORISE`, il est `COMPARABLE` : une comparaison peut être lancée. **Une comparaison n'est jamais une décision** : elle produit une synthèse par objet (concordance, divergence mesurée, rapprochement incertain, sans correspondance) ; les géométries d'origine ne sont **ni modifiées ni fusionnées** ; seule une **action humaine justifiée** ouvre, à partir d'une divergence, un dossier de conflit RC-3 de type `DIVERGENCE_SOURCES`, à investiguer.

La **connectivité** d'un réseau n'est **jamais calculée** : une relation `CONNECTE_A` entre deux objets physiques n'existe que si une source la **déclare** (colonne d'un fichier importé) ou si une personne la **saisit** avec justification. Aucune fonction ne déduit une connexion d'une proximité, et un test statique l'interdit. L'état de connexion d'un objet est `CONFIRMEE`, `INCONNUE` ou `NON_FOURNIE`, jamais « continue ».

## 2. Règles non négociables

Celles de `CONTRAT.md` section 2, de `CONTRAT-CONFLITS.md` section 2 et de `CONTRAT-RESEAUX.md` section 2 (aucune donnée réelle, suppression logique, écritures auditées sans géométrie, migration additive avec descente, aucune écriture dans le référentiel officiel, aucun ordre ni déplacement), plus :

1. **Aucune source n'est privilégiée, aucune n'est fusionnée.** Une comparaison lit les deux jeux et écrit ses résultats dans ses propres tables ; les objets, les jeux et leurs géométries ne changent pas.
2. **Aucun seuil inventé.** Le corridor de rapprochement d'un couple d'objets est `max(précision déclarée A, précision déclarée B) + marge` ; il n'est calculé que si les **deux** précisions sont connues et exprimées en mètres horizontaux ; sinon le résultat est `RAPPROCHEMENT_INCERTAIN`, **sans mesure de divergence**. La marge (1 m par défaut), le rayon d'appariement et la part hors corridor tolérée sont des paramètres d'une **règle versionnée et approuvée** (même mécanisme que les règles de conflit) ; les valeurs par défaut sont **provisoires, à valider par le DSI**.
3. **Une comparaison est persistée, reproductible et rejouable** : versions et empreintes des deux jeux, règle et version, version de l'algorithme, instantané, durée, acteur. Rejouer avec les mêmes entrées redonne les mêmes résultats (test).
4. **Un résultat n'est pas une décision** : aucune route de ce lot ne change un statut, n'écrit dans un jeu ni ne crée d'ordre. Le seul effet « métier » possible est l'ouverture d'un dossier RC-3 `DIVERGENCE_SOURCES`, sur action humaine justifiée, statut initial `A_INVESTIGUER`.
5. **Aucun calcul de connectivité.** `CONNECTE_A` naît d'une déclaration (import) ou d'une saisie humaine, avec une **preuve** (`CONFIRMEE_PAR_FOURNISSEUR` ou `INCONNUE`). Le test statique `connectivite.statique.test.ts` fait échouer toute fonction qui écrirait `CONNECTE_A` à partir d'un prédicat spatial.
6. **Lisibilité identique au socle, à RC-3 et à B1** : un jeu `RETIRE` n'est montré à personne ; un jeu autre que `AUTORISE` n'est montré qu'à `ADMIN` et `GESTIONNAIRE` ; un projet retiré répond 404 à tous ; hors périmètre, 404 masqué ; la consultation de jeux `CONFIDENTIEL_CONCESSIONNAIRE` ou `INFRASTRUCTURE_SENSIBLE` est tracée (`ConsultationJeuProjet`, route `sources`). **Aucune route de ce lot ne rend ni n'exporte de géométrie.**

## 3. Modèle de données

### 3.1 Jeux : méthode d'acquisition et date des données

- `JeuDonneesProjet.methodeAcquisition` (texte court, nul = non renseignée) : code validé par la liste `METHODES_ACQUISITION` de `backend/src/projets-voirie/config.ts` : `GNSS_RTK`, `GNSS_DIFFERENTIEL`, `GNSS_AUTONOME`, `TOPOGRAPHIE`, `DETECTION_ELECTROMAGNETIQUE`, `GEORADAR`, `NUMERISATION_PLAN`, `RECOLEMENT_TRAVAUX`, `DECLARATIF_FOURNISSEUR`, `PLAN_CAO` (dessin de conception livré en DAO/CAO, par exemple le DXF d'un bureau d'études ; ajouté le 09/11/2026), `INCONNUE`. La base ne contraint que la **forme** (`^[A-Z][A-Z0-9_]{1,39}$`) ; la liste est celle du service, pour que le lot T1 (référentiels configurables, domaine `METHODE_ACQUISITION`) puisse la relier à son référentiel sans migration. Renseignée au dépôt (champ `methodeAcquisition`) ou par le mapping (champ cible `methodeAcquisition`, portée jeu, valeur unique de la colonne).
- `dateDonnees` existe déjà dans le socle : c'est la **date de validité de la donnée** (levé, fourniture), distincte de `createdAt` (dépôt). Aucune colonne n'est ajoutée pour cela. `precisionHorizontaleM` et `classePrecision` existent déjà : rien n'est dupliqué.
- **Clé de version** (décision de ce lot, précisée le 09/11/2026) : les deux index uniques partiels du socle (`un seul AUTORISE`, `un seul dépôt en attente` par projet, rôle, concessionnaire) sont recréés avec, en quatrième composante, la méthode d'acquisition **pour le rôle `RESEAU_TIERS` seulement** (`CASE WHEN role = 'RESEAU_TIERS' THEN COALESCE("methodeAcquisition", '') ELSE '' END`). Le dépôt, l'autorisation, le retrait, le retour arrière et la référence de la revue des suppressions utilisent la même clé (`sources/cle-version.noyau.ts`). Conséquences : pour un réseau, un second fichier du même concessionnaire **avec une autre méthode** est une **nouvelle source** (version 1, aucun remplacement) ; avec la même méthode (ou sans méthode, comme avant), c'est une **nouvelle version**. Pour un plan d'axes (et des limites de route), la méthode est enregistrée mais **ne sépare pas les lignées** : une nouvelle livraison est toujours une version, qui remplace la précédente à son autorisation. Les jeux existants, sans méthode, gardent le comportement du socle.

### 3.2 `regles_rapprochement_sources` (règles versionnées, approuvées)

| Colonne | Sens |
|---|---|
| `id`, `projetId?` (nul = règle générale), `famille?` (`TypeReseauTiers`, nul = toutes), `code`, `version` (croissante par projet, famille, code ; index unique `NULLS NOT DISTINCT`) | identité et portée, comme `regles_conflit_projet` |
| `margeM` | marge ajoutée au maximum des précisions (0 à 100 m ; **défaut 1 m**) |
| `rayonAppariementM` | distance au-delà de laquelle deux objets ne sont même plus candidats à l'appariement (0,01 à 1 000 m ; **défaut 10 m, provisoire**) |
| `partHorsCorridorMax` | part de la longueur de A hors du corridor de B tolérée pour une concordance (0 à 1 ; **défaut 0** : concordance stricte, à 1 cm près de tolérance numérique) |
| `precisionParClasseM` | JSON `{ A, B, C, D }` : précision en mètres **attribuée à un objet qui déclare une classe sans précision métrique** (**défaut `{ A: 0.5, B: 1, C: 2, D: 5 }`, provisoire, mêmes valeurs que les tolérances d'association de B1**) ; la classe E n'a pas de valeur (inconnue) |
| `statut` (`BROUILLON`, `APPROUVEE`, `RETIREE` : enum `StatutRegleConflit` réutilisé), `justification`, `creeParId?`, `approuveParId?`, `approuveLe?`, `motifApprobation?`, `derogationApprobation?`, `createdAt` | cycle de vie, identique à RC-3 : brouillon jamais appliqué, approbation `ADMIN`, l'auteur n'approuve pas sans dérogation motivée, règle approuvée **immuable** (déclencheur), `DELETE` et `TRUNCATE` refusés |

Règle par défaut créée par la migration : `S1-CORRIDOR-0.1`, version 0, générale, `APPROUVEE`, sans auteur (`creeParId` nul), avec les défauts ci-dessus. Règle effective d'une famille : même résolution que RC-3 (projet et famille, projet, générale et famille, générale, défaut ; la plus récemment approuvée).

### 3.3 `comparaisons_sources_projet` (immuable)

| Colonne | Sens |
|---|---|
| `id`, `projetId`, `numero` (séquence par projet), `statut` (`TERMINEE`, `ECHEC` : enum `StatutAnalyseConflit` réutilisé) | identité |
| `mode` (`SOURCES`, `VERSION_CANDIDATE`), `role` (`RESEAU_TIERS`, `AXES_TRAVAUX`) | choisis par le serveur (section 4.1), jamais par la requête |
| `jeuAId`, `jeuBId` | les deux jeux comparés, **ordonnés** par le serveur quel que soit l'ordre de la demande : A = la référence (le jeu autorisé ; en mode `SOURCES`, le dépôt le plus ancien) |
| `concessionnaireId`, `typeReseau` | le réseau |
| `regle` (JSON : id, code, version, portée, paramètres), `jeux` (JSON : pour A et B : `jeuId`, `sha256`, `version`, `methodeAcquisition`, `dateDonnees`, `classePrecision`, `precisionHorizontaleM`, `nbObjets`, `nomFichier`), `versionAlgorithme` (`S1-CORRIDOR-UTM-1`), `epsg` (CRS métrique de calcul) | reproductibilité |
| `resume` (JSON : `totaux` par statut de résultat, `objetsA`, `objetsB`, `nonEvalues` (objets non linéaires), `corridor` (min, max, nb de couples sans corridor), `limites`), `instantane` (JSON `{ clé du résultat : statut|empreinte de mesure }`) | synthèse et comparaison de deux comparaisons ; `instantane` n'est jamais lu par la liste ni par le détail (revue RC-3, M2) |
| `declencheParId`, `duree` (ms), `createdAt` | acteur et durée |

`UPDATE`, `DELETE` et `TRUNCATE` refusés. Une comparaison qui échoue par délai ou volume laisse une ligne `ECHEC` (résumé : code et message de l'erreur).

### 3.4 `comparaisons_sources_resultats` (un résultat par objet, ajout seul)

| Colonne | Sens |
|---|---|
| `id`, `comparaisonId`, `projetId`, `ordre` (1, 2, 3 : ordre déterministe, support du curseur), `cle` (SHA-256 stable : projet, identité de l'objet A et de l'objet B, nom normalisé sinon empreinte de géométrie, jamais les identifiants) | identité |
| `statut` | `CONCORDANCE`, `DIVERGENCE`, `RAPPROCHEMENT_INCERTAIN`, `SANS_CORRESPONDANCE_A`, `SANS_CORRESPONDANCE_B` (enum `StatutResultatComparaison`) |
| `objetAId?`, `objetBId?`, `nomA?`, `nomB?` | les objets (A seul pour `SANS_CORRESPONDANCE_A`, B seul pour `SANS_CORRESPONDANCE_B`) |
| `precisionAM?`, `precisionBM?`, `origineA`, `origineB` (`OBJET`, `JEU`, `CLASSE`, `INCONNUE`), `corridorM?` | précisions retenues et corridor (nul si incertain) |
| `mesure?` (JSON : `hausdorffM`, `longueurAM`, `longueurBM`, `longueurRecouvrementM`, `longueurHorsCorridorM`, `partHorsCorridor`, `distanceMinM`) | **nulle** pour `RAPPROCHEMENT_INCERTAIN` et pour les sans correspondance (seule `longueurAM` ou `longueurBM` y est renseignée) |
| `conflitId?` | dossier RC-3 `DIVERGENCE_SOURCES` ouvert depuis ce résultat (une seule écriture possible : de nul vers une valeur ; tout le reste est figé) |

### 3.5 Relations : `CONNECTE_A` et preuve

- `TypeRelationReseau` reçoit la valeur `CONNECTE_A` ; `OrigineRelationReseau` reçoit `IMPORT_DECLARATIF`.
- `reseau_relations.preuve` (`PreuveConnexionReseau` : `CONFIRMEE_PAR_FOURNISSEUR`, `INCONNUE`) : **obligatoire pour `CONNECTE_A`, interdite pour les autres types** (contrainte), figée (déclencheur).
- Natures admises pour `CONNECTE_A` (service et déclencheur) : les deux objets sont des infrastructures physiques ou des équipements (`ACTIF_PHYSIQUE`, `EQUIPEMENT`), de même projet ; toute géométrie. Un circuit logique ne se « connecte » pas : il est porté (`PORTE_PAR`).
- Création : (a) `POST /:id/reseau/relations` avec `type: "CONNECTE_A"`, `preuve`, `justification` : origine `MANUELLE`, créée `VALIDEE` ; (b) import déclaratif : champ de mapping `connecteA` (portée objet) désignant la colonne qui porte le **nom** de l'objet connecté dans le même fichier ; au dépôt, une relation `CONNECTE_A` `VALIDEE`, origine `IMPORT_DECLARATIF`, preuve `CONFIRMEE_PAR_FOURNISSEUR`, est créée pour chaque objet dont la colonne désigne un objet du même jeu (un objet non retrouvé est compté dans l'avertissement `CONNEXIONS_NON_RESOLUES`, rien n'est deviné) ; le jeu doit déclarer une nature physique (`natureObjets` `ACTIF_PHYSIQUE` ou `EQUIPEMENT`), sinon 422 `CONNECTE_A_NATURE_REQUISE` avant toute insertion. Les transitions (`valider`, `refuser`, `revoquer`) sont celles de B1.
- **État de connexion d'un objet** (fiche `GET /:id/reseau/objets/:objetId`, bloc `connexions`) : `CONFIRMEE` si au moins une relation `CONNECTE_A` `VALIDEE` de preuve `CONFIRMEE_PAR_FOURNISSEUR` le touche ; `INCONNUE` si ses connexions validées n'ont que la preuve `INCONNUE` ; `NON_FOURNIE` sinon. Avec les nombres par preuve et un libellé qui rappelle qu'aucune connexion n'est déduite.

### 3.6 Extension minimale de RC-3

`conflits_projet` : `premiereAnalyseId` et `derniereAnalyseId` deviennent **nullables** ; colonne `comparaisonId?` ajoutée. Contrainte : un dossier `DIVERGENCE_SOURCES` porte `comparaisonId` et aucune analyse ; tout autre type porte ses deux analyses et aucune comparaison. Le recalcul RC-3 **ignore** les dossiers `DIVERGENCE_SOURCES` (jamais `NON_RETROUVE`). Détail : `CONTRAT-CONFLITS.md`, section 9, points 42 et suivants.

## 4. Algorithme de comparaison (`S1-CORRIDOR-UTM-1`)

1. **Entrées** : deux jeux distincts du projet, de même rôle (`RESEAU_TIERS` ou `AXES_TRAVAUX`), de même concessionnaire et de même type de réseau (tous deux nuls pour un plan d'axes), dans l'un des deux modes de la section 4.1 (sinon 409 `JEUX_NON_COMPARABLES` avec le motif `MEME_JEU`, `ROLE`, `RESEAU_DIFFERENT`, `STATUT` ou `LIGNEE_DIFFERENTE`) ; la règle de rapprochement effective de la famille ; le CRS métrique choisi comme l'analyse 2D (`epsgPourLongitude` sur le centre de l'étendue des deux jeux). Seuls les objets **linéaires** sont comparés ; les autres sont comptés (`nonEvalues`).
2. **Précision d'un objet** : `precisionHorizontaleM` du descripteur B1, sinon celle du jeu, sinon la valeur de `precisionParClasseM` pour la classe effective (descripteur, sinon jeu), sinon inconnue. L'origine est rendue (`OBJET`, `JEU`, `CLASSE`, `INCONNUE`).
3. **Corridor d'un couple** : `max(précision A, précision B) + margeM`, seulement si les deux précisions sont connues ; sinon le corridor est inconnu.
4. **Appariement** : pour chaque objet a de A, les objets b de B à moins de `rayonAppariementM` (`ST_DWithin` en UTM, géométries simplifiées à 0,05 m comme le socle) sont candidats ; le candidat retenu est celui dont la longueur de a comprise dans le tampon de b (de rayon le corridor, ou le rayon d'appariement si le corridor est inconnu) est la plus grande, puis la distance de Hausdorff la plus petite, puis l'identifiant le plus petit. Plusieurs objets de A peuvent retenir le même b.
5. **Résultat** par objet de A : corridor connu : `longueurHorsCorridorM = longueur(a) - longueur(a dans tampon(b, corridor))`, `partHorsCorridor`, `hausdorffM`, `distanceMinM` ; `CONCORDANCE` si `partHorsCorridor <= partHorsCorridorMax` (tolérance numérique de 1 cm sur la longueur), sinon `DIVERGENCE` ; corridor inconnu : `RAPPROCHEMENT_INCERTAIN`, aucune mesure ; aucun candidat : `SANS_CORRESPONDANCE_A`. Chaque objet de B qui n'est le candidat retenu d'aucun a : `SANS_CORRESPONDANCE_B`.
6. **Bornes** : `PROJETS_VOIRIE_COMPARAISON_OBJETS_MAX` objets linéaires au plus pour A et B réunis (défaut 20 000, bornes 100 à 200 000 ; 422 `COMPARAISON_TROP_VOLUMINEUSE`) ; délai côté base `PROJETS_VOIRIE_DELAI_ANALYSE_MS` par budget partagé (504 `COMPARAISON_TROP_LONGUE`, ligne `ECHEC`) ; une comparaison à la fois par projet (verrou consultatif propre, 503 `PROJET_OCCUPE`) ; 3 calculs par processus (limiteur des analyses, 503 `SERVICE_OCCUPE`) ; cadence `PROJETS_VOIRIE_COMPARAISON_INTERVALLE_S` entre deux comparaisons **terminées** d'un projet (défaut 60 s, bornes 0 à 3 600, 0 réservé aux bancs ; 429 `COMPARAISON_TROP_FREQUENTE` avec `retryAfterS` et `Retry-After`).
7. **Rejeu** : les mêmes jeux et la même règle redonnent les mêmes clés, statuts et mesures (empreinte de mesure au centimètre) ; l'instantané des deux comparaisons est identique.

### 4.1 Modes (ajout du 09/11/2026 : deux versions d'un même axe de projet)

- `SOURCES` : deux jeux `AUTORISE` du même réseau de concessionnaire (deux méthodes d'acquisition). A = le dépôt le plus ancien.
- `VERSION_CANDIDATE` : un jeu en contrôle (`RECU`, `CONTROLE`) face au jeu `AUTORISE` **qu'il remplacera** (`remplaceId`, même lignée de versions), pour un réseau comme pour un **plan d'axes**. A = la version autorisée, B = la candidate. C'est la comparaison « avant d'autoriser » : le plan d'axes tracé depuis un PDF (classe C : précision attribuée par la règle, 2 m par défaut) face au même axe livré en DXF par le bureau d'études (précision déclarée), corridor `max(2, pB) + 1 m`.
- La quarantaine n'est lisible que des rôles qui décident : un lecteur ne voit pas une comparaison dont un jeu n'est pas `AUTORISE` (404, absente de sa liste), ni la version candidate dans la vue des sources ; après l'autorisation de la candidate, la version 1 passe `REMPLACE` et la comparaison reste visible des seuls décideurs (même règle que RC-3).
- Un dossier de divergence ouvert depuis un plan d'axes est rattaché au plan d'axes de référence par `jeuAxesId` (et non `jeuReseauId`), comme un dossier de couverture insuffisante ; il n'a pas de concessionnaire. Il ne s'ouvre que tant que le jeu de référence (A) est `AUTORISE`.

## 5. API

Préfixe `/api/v2/projets-voirie`, mêmes gardes et même ordre que le socle (jeton, clé de module `projets-voirie`, octet NUL, identifiants UUID, rôle, projet désigné à 404 masqué, validation stricte, service). Neuf routes nouvelles, formes de réponse dans `API.md`. Le corps de `POST /:id/comparaisons` ne choisit ni le mode ni la référence : le serveur les déduit des statuts (section 4.1).

| Route | Rôle | Contenu |
|---|---|---|
| `GET /:id/sources` | lecture | groupes du projet : un par réseau `(concessionnaire, typeReseau)` de jeux `AUTORISE` de rôle `RESEAU_TIERS`, et un pour le plan d'axes (`role: AXES_TRAVAUX`), avec `statut` (`SOURCE_UNIQUE_COMPARAISON_INDISPONIBLE` ou `COMPARABLE`), les sources (jeu, version, méthode, date des données, précision, classe) et la dernière comparaison `SOURCES` terminée ; pour ADMIN et GESTIONNAIRE seulement, `versionsCandidates` (jeux en contrôle qui remplaceront une source) ; un lecteur ne reçoit ni ces jeux ni la clé |
| `GET /:id/regles-rapprochement` | lecture | règles du projet et générales, règle effective par famille |
| `POST /:id/regles-rapprochement` | ADMIN, GESTIONNAIRE | crée une règle `BROUILLON` (`famille?`, `code`, `margeM`, `rayonAppariementM`, `partHorsCorridorMax`, `precisionParClasseM`, `justification`) |
| `POST /:id/regles-rapprochement/:regleId/approuver` | ADMIN | `{ justification, derogation? }` ; 409 `REGLE_IMMUABLE`, 409 `SEPARATION_DES_TACHES` |
| `POST /:id/comparaisons` | ADMIN, GESTIONNAIRE | `{ jeuAId, jeuBId }` ; 201 `{ comparaison, resume }` |
| `GET /:id/comparaisons` | lecture | historique (curseur par numéro, `limite` 1 à 100) ; filtre `jeuId` |
| `GET /:id/comparaisons/:cmpId` | lecture | détail (jeux, règle, résumé), sans l'instantané |
| `GET /:id/comparaisons/:cmpId/objets` | lecture | résultats paginés (`statut` liste, `limite` 1 à 200, curseur borné sur `ordre`) ; aucune géométrie |
| `POST /:id/comparaisons/:cmpId/dossiers-conflit` | ADMIN, GESTIONNAIRE | `{ resultatId, justification }` : ouvre un dossier RC-3 `DIVERGENCE_SOURCES` (`A_INVESTIGUER`) pour un résultat `DIVERGENCE` ; 409 `RESULTAT_NON_DIVERGENT`, 409 `DOSSIER_DEJA_OUVERT` (avec `conflitId`) ; 201 `{ conflit }` |

Routes B1 étendues : `POST /:id/reseau/relations` accepte `type: "CONNECTE_A"` avec `preuve` (400 `CHAMPS_INVALIDES` si `preuve` manque pour `CONNECTE_A` ou est donnée pour un autre type) ; `GET /:id/reseau/relations?type=CONNECTE_A` ; la vue d'une relation porte `preuve` ; la fiche d'un objet porte `connexions`. Dépôt : champ `methodeAcquisition` et champs de mapping `methodeAcquisition`, `connecteA`.

**Visibilité des comparaisons** (visibilite.noyau de RC-3, mêmes règles) : un compte qui ne décide pas ne voit une comparaison que si ses **deux** jeux sont `AUTORISE` (sinon absente de la liste, 404 `COMPARAISON_INTROUVABLE` sur le détail et les objets) ; un compte qui décide la voit toujours, mais si un jeu est `RETIRE`, les données tirées des jeux (noms d'objets, nom de fichier, empreinte, précisions, mesures) sont masquées (`donneesMasquees: true`, liste d'objets vide avec `masque: true`) ; le résumé (agrégats figés au calcul) n'est pas filtré (même choix que RC-3, point 17). La consultation des jeux sensibles rendus est tracée (route `sources`) avant la remise.

Codes d'erreur ajoutés : 404 `COMPARAISON_INTROUVABLE`, `RESULTAT_INTROUVABLE`, `REGLE_INTROUVABLE`, `JEU_INTROUVABLE` ; 409 `JEUX_NON_COMPARABLES` (`motif` : `MEME_JEU`, `STATUT`, `ROLE`, `RESEAU_DIFFERENT`), `RESULTAT_NON_DIVERGENT`, `DOSSIER_DEJA_OUVERT`, `REGLE_IMMUABLE`, `SEPARATION_DES_TACHES`, `COMPARAISON_NON_TERMINEE` ; 422 `JUSTIFICATION_REQUISE`, `COMPARAISON_TROP_VOLUMINEUSE`, `CONNECTE_A_NATURE_REQUISE`, `METHODE_ACQUISITION_INCONNUE` ; 429 `COMPARAISON_TROP_FREQUENTE` ; 503 `PROJET_OCCUPE`, `SERVICE_OCCUPE` ; 504 `COMPARAISON_TROP_LONGUE` ; 400 `CURSEUR_INVALIDE`, `CHAMPS_INVALIDES`, `IDENTIFIANT_INVALIDE`.

Audit (sans géométrie) : `RegleRapprochementSources` (création, approbation), `ComparaisonSources` (création, échec), `ConflitProjet` (ouverture d'un dossier depuis une comparaison), `ReseauRelation` (déclaration `CONNECTE_A`, y compris par import : une ligne par dépôt avec le nombre de connexions créées), `JeuDonneesProjet` (la méthode d'acquisition est dans l'audit du dépôt).

## 6. Tests exigés

Unitaires (noyau pur) : corridor et compatibilité des précisions (connues, inconnues, classe sans métrique, classe E), résolution de la règle effective et versions, classification des résultats (concordance stricte, divergence, incertain, sans correspondance A et B, part tolérée), clé stable et empreinte de mesure, idempotence du rejeu (deux calculs sur les mêmes mesures donnent le même instantané), état de connexion, liste des méthodes d'acquisition, mapping `connecteA` et `methodeAcquisition`. Routes (gardes, validation, erreurs typées, 404 masqué, lecteur refusé en écriture, `preuve` exigée pour `CONNECTE_A`). Test statique de connectivité (mutation : un extrait qui écrit `CONNECTE_A` avec `ST_DWithin` fait échouer le détecteur). Banc PostGIS `sources-comparaison.integration.mts` (fixtures synthétiques) : source unique (statut explicite, aucune comparaison, 409 si on la force), seconde source concordante (décalage 0,5 m, corridor 2 m), divergente (décalage 3 m sur un corridor de 2 m : Hausdorff, longueur hors corridor), précision inconnue (incertain, aucune mesure), sans correspondance A et B, rejeu idempotent (instantanés identiques, mêmes clés), lecteur vs gestionnaire, jeu retiré (données masquées pour tous), projet supprimé (404 partout), ouverture d'un dossier `DIVERGENCE_SOURCES` par action humaine seulement (aucun dossier sans l'appel, doublon 409, recalcul RC-3 sans effet sur lui), `CONNECTE_A` déclarée par import et par saisie, état de connexion, refus de la base (preuve manquante, nature logique), isolation (comptes de toutes les tables, référentiel intact, aucune géométrie dans l'audit). Descente rejouée par le banc des descentes. Non-régression : bancs `conflits-projets-voirie` et `reseau-physique-logique` avec la migration S1 appliquée au clone.

## 7. Limites connues et décisions à prendre (DSI)

1. **Clé de version étendue à la méthode d'acquisition, pour les réseaux seulement** (3.1) : c'est ce qui rend possible une seconde source sans remplacer la première ; une re-livraison par la **même** méthode reste une version ; un plan d'axes n'a jamais deux sources autorisées (la seconde est une version candidate, section 4.1). Alternative non retenue : un code de source libre. À valider.
2. **L'analyse 2D du socle et l'analyse persistée RC-3 prennent tous les jeux `AUTORISE`** : avec deux sources d'un réseau, `parConcessionnaire` additionne les deux (double compte de longueur) et chaque source produit ses propres dossiers de conflit. Aucune source n'est privilégiée dans ce lot ; une « source de référence » par réseau est une décision à prendre.
3. **Valeurs par défaut provisoires** de la règle `S1-CORRIDOR-0.1` : marge 1 m (décision 2), rayon d'appariement 10 m, part hors corridor 0, précisions par classe `{ A: 0.5, B: 1, C: 2, D: 5 }` (reprises de B1, elles-mêmes provisoires). La règle effective est la plus récemment approuvée (même limite que RC-3, point 31).
4. **Appariement un à un côté A** : plusieurs objets de A peuvent retenir le même objet de B (circuits superposés) ; les objets de B jamais retenus sont `SANS_CORRESPONDANCE_B`. Les objets non linéaires ne sont pas comparés (comptés).
5. **Dossier de divergence** : ouvert seulement depuis un résultat `DIVERGENCE` (pas depuis un rapprochement incertain) ; il dépend du jeu A pour la lisibilité (le jeu B est dans la mesure) ; sa géométrie est celle de l'objet A (copie, jamais une fusion) ; il n'a pas d'axe (libellé fixe « Divergence de sources »).
6. **Connectivité déclarée** : la résolution par import se fait par le **nom** de l'objet dans le même fichier ; aucune résolution entre jeux, aucune par proximité. La preuve d'une déclaration saisie à la main est celle que la personne affirme (`INCONNUE` par défaut dans l'interface est recommandé).
8. **Version candidate** : la comparaison porte sur un jeu non autorisé ; elle ne vaut pas autorisation et ne change rien au jeu ; si la candidate est rejetée, la comparaison reste (immuable) et n'est visible que des décideurs. Le dossier de divergence ouvert depuis une version candidate dépend du jeu de référence : après l'autorisation de la candidate, il n'est plus montré au lecteur (jeu `REMPLACE`), comme tout dossier RC-3 ; à décider : le repointer sur la nouvelle version.
7. **Comparaison entre projets ou territoires** (décision 2, « dans le même projet ou territoire ») : non faite ; les deux jeux doivent être du même projet.

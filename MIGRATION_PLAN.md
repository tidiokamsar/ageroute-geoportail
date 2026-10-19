# Plan de migrations

> Fichier canonique exigé par le § A.9 du prompt maître V10. Il remplace
> `docs/rai-v3/PLAN_MIGRATIONS_PRODUCTION.md`, dont il conserve l'historique Git.
>
> Le § A.8 exige, pour chaque migration : objectif, dépendances, nature additive ou
> destructive, données concernées, compatibilité avec la version de production, tests,
> **rollback réellement exécuté** sur base représentative, contrôles post-migration,
> compatibilité frontend et backend, et évolution par étapes si nécessaire.
>
> 🔒 **Aucun déploiement de production sans autorisation explicite** (§ A.5.1, § A.8).

Réconcilié le **14/10/2026**. Méthode : comparaison des dossiers locaux avec
`_prisma_migrations` en lecture seule, plus `prisma migrate status` depuis le conteneur.

---

## 1. État réconcilié, et il corrige l'état de référence du mandat

Le § A.4 du prompt maître V10 annonce « 41 migrations signalées comme appliquées » et « quatre
migrations supplémentaires en attente ». Le mandat demande lui-même de vérifier ces chiffres
(« ne présume pas que ces mesures sont encore actuelles »). **Ils sont périmés de neuf
migrations.**

| Mesure | Valeur |
|---|---|
| Dossiers de migration locaux | **62** (au 19/10) |
| Appliquées en production | **50** |
| **En attente** | **12** |
| Appliquées sans fichier local (orphelines) | **0** |
| Lignes de `_prisma_migrations` inachevées ou annulées | 1, **expliquée au § 5** |

Les quatre migrations que le § A.4 donnait en attente — `portions_homogenes`,
`referentiels_configurables`, `portions_ecriture`, `actifs_lineaires` — **ont été appliquées le
13/10/2026 à 18:21**, avec cinq autres. Six migrations supplémentaires ont suivi le 14/10.

`prisma migrate status`, exécuté dans le conteneur, répond « **Database schema is up to date!** »
pour les 50 migrations que son image contient. Ce verdict est exact et incomplet : voir § 4.

---

## 2. La migration en attente

### `20261014170000_historisation_bitemporelle`

| Champ exigé par le § A.8 | Contenu |
|---|---|
| **Objectif** | Ajouter l'**axe terrain** de l'historisation bitemporelle (§ 7.2) : `valideDu` / `valideAu` sur `portions`, distincts des dates système `createdAt` et `remplaceeLe`. Anticiper au modèle le contexte de praticabilité (T-07) et les champs d'inférence sur `medias_defaut` (T-03), comme le § 14 l'exige dès le lot 2 |
| **Dépendances** | `20261013180000_portions_homogenes` (table `portions`) et la table `medias_defaut`, toutes deux **appliquées** |
| **Nature** | **strictement additive** : 11 colonnes ajoutées, 6 contraintes `CHECK`, 2 index, 3 commentaires de colonne. Aucun `DROP`, aucun changement de type, aucun `UPDATE`, aucun `INSERT` |
| **Données concernées** | **aucune ligne écrite ni modifiée.** `portions` et `medias_defaut` comptaient **0 ligne** en production au 14/10 |
| **Compatibilité avec la version déployée** | **compatible dans les deux sens.** Toutes les colonnes ajoutées sont nullables ou ont une valeur par défaut : le code actuellement déployé, qui les ignore, continue de fonctionner. Et le code qui les lit fonctionne sur une base où elles valent `NULL` |
| **Tests** | Les **règles** sont éprouvées sans base : `reseau/bitemporel.ts`, **32 tests**, dont les deux axes de temps répondant différemment à la même date de terrain. `prisma generate` valide le schéma. Suite complète : **1 145 tests backend**, 0 échec |
| **Rollback réellement exécuté** | **OUI, le 14/10/2026**, aller-retour vérifié sur base PostGIS locale. Voir § 3 |
| **Contrôles post-migration** | listés au § 6 |
| **Compatibilité frontend** | **aucun impact** : aucun écran ne lit encore ces colonnes |
| **Évolution par étapes** | sans objet : la migration est additive et tient en une étape. Le schéma *expand → migrate → contract* ne s'applique pas, il n'y a pas de phase *contract* |

**Script de descente** : `backend/prisma/descentes/20261014170000_historisation_bitemporelle.sql`.
Il vit hors du dossier de migration, par prudence asymétrique
([ADR-008](TECHNICAL_DECISIONS.md)) : Prisma lit `migration.sql`, et un second `.sql` y est très
probablement ignoré, mais je n'ai pas pu l'établir avec certitude. Si je me trompais, il
supprimerait en production les colonnes que la migration vient d'ajouter.

---

## 3. Le rollback, exécuté et vérifié le 14/10/2026

**B-13 est levé.** Docker a démarré sur le poste, et une base de développement isolée a été
montée : `postgis/postgis:17-3.5` — la **même image que la production** —, conteneur
`bdri-dev-db`, port `127.0.0.1:5434`, identifiants locaux jetables. PostgreSQL **17.5**, PostGIS
**3.5** avec GEOS, PROJ et STATS.

### Méthode, et pourquoi elle est en trois temps

Le § A.8 demande un rollback « réellement exécuté ». Un script de descente qui s'exécute sans
erreur ne prouve pourtant qu'une moitié : il faut aussi que la **remontée** redonne exactement
l'état de départ. Une descente qui retire une colonne en oubliant sa contrainte laisse une base
qui *semble* propre et refusera la remontée.

L'état comparé n'est donc pas « la migration a tourné » mais l'inventaire des **20 objets** que
la montée crée : 11 colonnes avec leur type, 6 contraintes `CHECK`, 3 index, relevés par requête
sur `information_schema`, `pg_constraint` et `pg_indexes`.

| Temps | Geste | Objets relevés | Code de sortie |
|---|---|---|---|
| 1 | état après la montée | **20** | — |
| 2 | **exécution de la descente** | **0** | **0** |
| 3 | **remontée** | **20** | **0** |

**L'état 3 est identique à l'état 1**, comparaison objet par objet, type par type. Aucun résidu
après la descente, aucun manque après la remontée.

Ce temps 3 établit en prime que le script de montée est **rejouable**, ce que le § A.8 ne
demandait pas explicitement mais dont toute récupération dépend.

### Ce que ce test ne couvre pas

**Il porte sur une base vide.** La descente retire des colonnes : sur une base peuplée, elle
détruirait leur contenu sans recours. Le script porte en tête les requêtes de comptage à
exécuter avant toute descente réelle, et cette exigence est intacte.

**Il ne porte que sur une migration des cinquante et une.** C'est la seule qui possède un script
de descente : `backend/prisma/descentes/` ne contient qu'un fichier. Les cinquante autres sont
appliquées en production et n'ont **aucun retour arrière écrit**. L'exigence du § A.8 est donc
tenue pour la migration en attente, et non pour l'historique.

---

## 2 bis. Les deux autres migrations en attente, écrites le 14/10 au soir

### `20261014190000_sections_fixes_derivees` — IO-04

| Champ du § A.8 | Contenu |
|---|---|
| **Objectif** | La vue dérivée des **sections fixes** que l'arbitrage **D6** impose : « portions homogènes = vérité, sections fixes = vue dérivée paramétrable ». Fonction `reseau_sections_fixes(pas_m, troncon_ids, a_la_date)` |
| **Nature** | **additive, et sans aucune table.** Elle crée une fonction. Aucune ligne écrite, aucune table existante touchée |
| **Pourquoi aucune table** | Une table de sections serait un second endroit où l'état du réseau existe, donc où il peut diverger — et elle rendrait **techniquement possible** la saisie au niveau section, que D6 interdit. Une interdiction tenue par l'absence de l'objet vaut mieux qu'une interdiction tenue par une consigne |
| **Tests** | `backend/prisma/tests/sections_fixes.test.sql`, **14 assertions**, toutes passées. Détail au § 2 ter |
| **Rollback exécuté** | **OUI.** La descente ne peut rien détruire : elle retire une fonction. C'est le seul retour arrière de ce dépôt dont on puisse le dire sans compter de lignes au préalable |
| **Compatibilité** | aucun impact sur le code déployé : rien ne l'appelle encore |

**Ce qu'elle ne fait pas** : la **note UEMOA**. Le critère B11 attend que chaque section porte
« l'état de la portion dominante **et la note UEMOA** ». La première moitié est livrée, la
seconde est **volontairement absente** : [RCI_METHOD_DECISION.md](RCI_METHOD_DECISION.md) a
établi que le texte de la directive n° 11/2009 et ses neuf indices ne sont pas en ma possession.
Une colonne remplie par une formule devinée serait pire qu'absente — elle aurait l'air d'une note
sous-régionale comparable. **IO-04 est livré, IO-03 reste suspendu** à la demande D-01.

### `20261014200000_exclusion_portions_bitemporelle` — un défaut trouvé en testant

| Champ du § A.8 | Contenu |
|---|---|
| **Objectif** | Corriger la contrainte d'exclusion de `portions`, qui **ignorait l'axe terrain** |
| **Dépendances** | `20261014170000_historisation_bitemporelle`, qui crée `valideDu` et `valideAu`. **Les deux doivent être déployées ensemble, dans cet ordre** |
| **Nature** | la contrainte est remplacée par une **strictement plus permissive**. Tout état qui satisfaisait l'ancienne satisfait la nouvelle, donc la recréation ne peut pas échouer sur des données existantes. `portions` comptait 0 ligne au 14/10 |
| **Rollback exécuté** | **OUI**, aller-retour vérifié : la contrainte revient à sa forme d'origine à deux opérandes, puis la troisième réapparaît |

**Le défaut, et il était silencieux.** La contrainte créée par `20261013180000_portions_homogenes`
porte sur `("tronconId", numrange("debutM","finM"))` seulement. Soit une portion
[120 m, 400 m) en bon état du 1ᵉʳ janvier au 1ᵉʳ juin, reprise ensuite, donc mauvaise à partir du
1ᵉʳ juin : **ce sont deux faits qui ne se contredisent pas**, portant sur des périodes de terrain
disjointes, tous deux crus aujourd'hui. Aucun ne remplace l'autre.

La contrainte les refusait. Le seul contournement était de poser `remplaceeLe` sur l'ancienne
version — employer une date **système** pour exprimer une succession **terrain**, en confondant
précisément les deux axes que l'[ADR-007](TECHNICAL_DECISIONS.md) a séparés.

**Conséquence** : l'axe terrain existait en colonnes, se testait dans `reseau/bitemporel.ts` par
32 tests sans base, et **aucune donnée ne pouvait l'exercer en base.** Le défaut n'est apparu
qu'en écrivant le banc d'essai des sections fixes, qui a tenté d'insérer les deux versions.

La correction ajoute un troisième opérande, `daterange("valideDu","valideAu",'[)')` : deux
versions ne se heurtent plus que si elles se chevauchent **sur les deux axes**. Une borne nulle
vaut l'infini et chevauche donc tout — lecture voulue et la plus prudente, puisqu'une portion
dont personne ne sait depuis quand elle est vraie revendique implicitement toute l'histoire.

**Et la descente de celle-ci peut légitimement échouer**, seule de tout le dépôt : elle restaure
une contrainte **plus stricte**, qu'une base exploitant l'axe terrain peut refuser. Le script
porte en tête la requête de comptage des conflits. Un échec y dirait « j'exploite l'axe terrain,
vous ne pouvez plus revenir sans choisir quoi perdre » — et ce choix est humain, jamais
automatique (§ A.5.8).

---

### `20261014210000_taches_internes` — TI-01

| Champ du § A.8 | Contenu |
|---|---|
| **Objectif** | Les **tâches d'intervention internes, non contractuelles** que l'arbitrage **D1** fait entrer au périmètre : régie, cantonnage, vérifications, nettoyage d'ouvrages, inspections périodiques |
| **Nature** | **additive** : un type, deux tables, cinq lignes de référentiel semées. Aucune table existante modifiée, aucune donnée patrimoniale touchée |
| **Tests** | `backend/prisma/tests/taches_internes.test.sql`, **22 assertions**, toutes passées ; `src/field/taches-internes.garde.test.ts`, **17 tests** |
| **Rollback exécuté** | **OUI**, aller-retour vérifié : table et type retirés, **référentiel conservé** — voir ci-dessous |
| **Compatibilité** | aucun impact sur le code déployé ; rien ne lit encore ces tables |

**La frontière DigitalRoad est tenue par l'absence des colonnes.** `taches_internes` n'a aucun
montant, prix, marché, entreprise, décompte ni paiement, et aucune clé étrangère vers `marches` :
dès qu'un prestataire ou un marché intervient, l'objet **n'est pas représentable** et doit vivre
dans DigitalRoad. La règle est donc structurelle plutôt que documentaire.

Mais une absence ne se défend pas toute seule — rien n'empêcherait d'ajouter un jour
`montantEstime` « juste pour information ». `taches-internes.garde.test.ts` balaie le modèle et
la migration, et **il a été éprouvé par injection** : un champ `montantEstimeGnf` ajouté
temporairement fait bien échouer la suite, avec le motif et la référence à D1. Le test vérifie
aussi la **présence** des champs que le § 14.12 exige, sans quoi il passerait sur un modèle vide.

Les **quantités constatées** sont autorisées, et la nuance est le cœur de TI-01 : « 40 m³ de
latérite reprise » est un constat de terrain, « 12 millions GNF » est un engagement.

**Le critère A29 est tenu par la base, et non par le service.** « Une tâche interne clôturée
possède des preuves avant/après » croise deux tables si les preuves vivent dans une table de
médias, et un tel invariant ne s'exprime pas en `CHECK` : il faudrait un **déclencheur, le
premier de ce dépôt**, invisible à Prisma et au lecteur. En plaçant la paire sur la ligne,
l'invariant devient local et déclaratif — et c'est aussi plus juste métier, avant/après étant une
paire et non un album.

**La nature est un référentiel, pas une énumération**, et c'est la leçon de D-06 : `ALTER TYPE
ADD VALUE` est irréversible, et `ClasseRoute` n'a toujours aucune valeur pour les 19 846 km de
routes communautaires. Les cinq natures semées portent `source = 'mandat_v10'` et ne sont **pas
déclarées approuvées** : ce sont celles que le mandat énonce, pas une nomenclature officielle
d'AGEROUTE.

**Sa descente détruit des données si la table en porte** — elle supprime la trace de ce
qu'AGEROUTE exécute elle-même. Le script porte les requêtes de comptage en tête. En revanche il
**conserve le référentiel des natures** : si quelqu'un y a ajouté des natures propres depuis le
semis, les effacer serait une perte invisible, et une table de vocabulaire orpheline ne gêne rien.

---

### `20261014220000_catalogue_traitements` — § 7.7, étape 2

| Champ du § A.8 | Contenu |
|---|---|
| **Objectif** | le **catalogue des traitements** et sa matrice d'orientation (état × revêtement × trafic → traitement), étape 2 de `MAINTENANCE_PROGRAMMING_DESIGN.md` — la seule du § 7.7 qui ne dépende pas de D-07 |
| **Nature** | **additive** : deux tables, **douze lignes semées depuis `baremes_intervention`** par requête, et non recopiées — trois traitements (`entretien_periodique`, `rehabilitation`, `reconstruction`) et neuf conditions. **Rien d'inventé** : durée de vie, effet sur l'indice, fenêtre de réalisation et classe de trafic sont **nuls**, et aucun traitement n'est approuvé |
| **Pourquoi aucune clé étrangère depuis les barèmes** | `baremes_intervention` est peuplée en production, où ses valeurs ne sont plus vérifiables depuis le gel : un `ADD CONSTRAINT` pourrait y échouer et bloquer tout `migrate deploy`. Le banc d'essai vérifie la correspondance à la place |
| **Tests** | `prisma/tests/catalogue_traitements.test.sql`, **12 assertions**, toutes passées |
| **Rollback exécuté** | **OUI**, aller-retour vérifié, deux fois — avant et après la correction ci-dessous |

**Un défaut trouvé par le banc d'essai, et corrigé avant tout commit.** La contrainte
`UNIQUE (famille, état, classeTrafic)` **ne jouait pas** : en SQL deux `NULL` sont distincts, et
`classeTrafic` est nulle sur les neuf conditions semées. `(bitume, MOYEN)` acceptait donc deux
traitements — la matrice n'était une fonction que sur le papier. Correction par
`UNIQUE NULLS NOT DISTINCT` (PostgreSQL 15+, la production est en 17), vérifiée par
`pg_get_constraintdef` puis par la contre-épreuve qui échouait. Prisma ne sait pas exprimer
cette clause : la migration SQL fait foi, et le modèle le dit.

### `20261014230000_lots_import` — le contrat d'import unique

| Champ du § A.8 | Contenu |
|---|---|
| **Objectif** | les tables `lots_import` et `lignes_import` de `ROAD_SURVEY_IMPORT_SPEC.md` (§ E.3), socle des trois options d'échange avec l'ONR et ANASUR |
| **Nature** | **additive** : deux types, deux tables, aucune donnée |
| **Ce que la base tient elle-même** | **A28 par contrainte** : `lignesLues = importées + rejetées + en conflit + ignorées`, un importateur qui perd une ligne ne peut pas clore son lot ; **idempotence par contrainte** : empreinte SHA-256 unique par source, le même fichier est refusé avant toute écriture ; un rejet porte son motif, un import porte sa cible ; la charge originale est conservée ; **aucun chemin de suppression** |
| **Tests** | `prisma/tests/lots_import.test.sql`, **15 assertions** (refus et contre-épreuves) ; noyau `src/import/pivot.noyau.ts` **sans aucun import**, 27 tests ; orchestration `import.service.ts` + route `/api/v2/imports`, **14 tests** |
| **Rollback exécuté** | **OUI**, aller-retour vérifié — deux fois, avant et après l'ajout du statut `VALIDEE` |

**Un statut ajouté pendant que la migration est encore en attente.** À l'étape de validation du
schéma, une ligne conforme n'est **ni importée ni rejetée** : elle attend l'application. Sans
statut pour le dire, l'orchestration aurait dû mentir sur l'un des deux, ou violer A28. `VALIDEE`
et le compteur `lignesValidees` ont été ajoutés **dans la migration en attente**, nulle part
appliquée hors de la base de développement — un `ALTER TYPE ADD VALUE` ultérieur aurait été
irréversible (leçon D-06). La contrainte de cohérence interdit en outre à un lot `VALIDE_SCHEMA`
d'avoir une ligne importée, et à une ligne `VALIDEE` de porter un objet cible : **validée veut
dire pas encore appliquée**, et la base le tient.

**Écart consigné** : le **GeoPackage** du pivot (§ 7.15) n'est pas produit — aucune dépendance
SQLite dans le paquet, et en ajouter une sans l'avoir choisie serait une décision prise en
passant. CSV et GeoJSON suffisent à l'option A d'échange de fichiers, celle que le TDR de l'ONR
décrit lui-même.

---

### `20261015000000_praticabilite_p1_p4_provisoire` — D-02, proposition semée

| Champ du § A.8 | Contenu |
|---|---|
| **Objectif** | semer les quatre niveaux **tels que le § 7.17 les énonce**, `source = 'mandat_v10_proposition'`, `approuveeLe` nul. Le mécanisme devient éprouvable — une portion peut porter P4 — sans qu'aucun niveau fasse foi |
| **Nature** | additive, quatre lignes de référentiel. Critères d'attribution, tonnage de P3, autorité et durée de validité **restent à décider** (D-02) : rien n'est comblé |
| **Rollback** | **OUI**, ciblé par source et par absence d'approbation : une ligne ajoutée ou approuvée par AGEROUTE depuis n'est pas touchée. **Attention** : `portions.praticabilite` est en `ON DELETE SET NULL` — compter avant |

### `20261015010000_main_courante` — § 7.17, EX-01

| Champ du § A.8 | Contenu |
|---|---|
| **Objectif** | la **main courante du réseau**, journal d'exploitation **en ajout seul**, à valeur probatoire : « ce qu'AGEROUTE savait et à quel moment » |
| **Modèle** | un événement est une **chaîne d'entrées** (déclaration, statut, complément, rectification) ; son statut courant est rendu par la vue `evenements_exploitation`, qui calcule aussi délais de prise en compte et durée (EX-08). Une erreur se corrige par une entrée rectificative qui cite l'entrée fautive — les deux restent |
| **Le premier déclencheur du dépôt** | l'immutabilité ne se tient ni par une contrainte (une ligne à la fois), ni par une absence de route (protège du code, pas d'un accès direct), ni par un `REVOKE` (le rôle applicatif est superuser en production). Le déclencheur `main_courante_ajout_seul` refuse `UPDATE`, `DELETE` et toute `enregistreLe` fournie par l'appelant : l'heure du serveur se constate. Admis **une fois**, nommé, commenté, éprouvé |
| **Tests** | `prisma/tests/main_courante.test.sql`, **14 assertions** ; noyau du cycle de vie + service + route, tests TS |
| **Rollback** | **OUI**, aller-retour vérifié. C'est la descente qui efface le plus : un journal probatoire ne se reconstitue pas — compter avant, et se demander pourquoi on descend une table conçue pour ne rien perdre |

---

### `20261015020000_catalogue_defauts_applicabilite` et `20261015030000_inspections_typees`

| Migration | Nature | Rollback |
|---|---|---|
| **applicabilité** du catalogue des défauts (REVETU / NON_REVETU / TOUS) | une colonne à défaut `TOUS`, texte contraint ; les 18 nouveaux types sont semés par le **script idempotent**, pas par la migration | **OUI**, aller-retour ; perd les valeurs posées par l'administration — compter avant |
| **inspections typées** : `type`, `interventionRef`, `iriEstime`, `iriMethode` | colonnes nullables ou à défaut `GENERALE` ; la contrainte POST_TRAVAUX ne peut pas échouer sur les lignes existantes, aucune ne porte ce type | **OUI**, aller-retour ; perd des constats de terrain — compter avant |

L'inspection **post-travaux** du § 7.7 est un **constat d'état du patrimoine, pas une réception** :
la base exige la référence de l'intervention, un état mesuré et au moins une photo, et le modèle
ne porte aucun champ de réception, de réserve ni de montant. C'est par elle que le cycle de vie
des interventions passera en `ÉVALUÉ` (origine `INSPECTION_POST_TRAVAUX`).

---

### `20261019000000_patrouilles_programmees`

| Rubrique | Contenu |
|---|---|
| **Objectif** | patrouilles programmées du § 7.17 (EX-03) : un programme (itinéraire, périodicité, mois actifs) engendre des missions SURVEILLANCE ordinaires ; dispatch de vérification sur un signalement |
| **Nature** | **additive** : tables `programmes_patrouille` et `programme_troncons`, deux colonnes nullables sur `missions` (`programmeId`, `signalementId`), fonctions `mois_actifs_valides` et `couverture_patrouille`. Aucune ligne existante modifiée ; `classeAxe` réutilise l'enum `ClasseRoute` sans lui ajouter de valeur |
| **Données semées** | **aucune**. Le mandat donne un exemple (« RN stratégiques hebdomadaires en saison des pluies ») ; périodicité et saisons sont saisies par AGEROUTE, les saisons différant selon les régions |
| **Tests** | banc `patrouilles.test.sql` : périodicité 0, mois 13, mois en double et tronçon en double refusés, chacun avec sa contre-épreuve ; couverture mesurée sur une géométrie connue (A 100 %, B 52 %, C 0 %, écart hors itinéraire 527 m) ; tolérance 0 refusée ; mission sans trace rendue à 0 sur ses trois tronçons |
| **Défaut trouvé** | la première version calculait `ST_Intersection(tronçon, tampon de la trace)`. Sous **GEOS 3.9**, elle a rendu une ligne **vide** pour un tronçon que la trace suivait exactement, alors que `ST_Covers` disait le tronçon couvert. Remplacée par un échantillonnage géodésique (segments ≤ 10 m, `ST_DWithin` en geography) : aucune opération d'overlay. Le banc garde ce cas |
| **Rollback** | **OUI**, aller-retour vérifié le 19/10. Perd les programmes et le lien mission → programme / signalement ; les missions, traces et observations restent. Compter avant |

---

### `20261019010000_info_route_bulletin`

| Rubrique | Contenu |
|---|---|
| **Objectif** | Info Route publique (EX-05) et bulletin routier quotidien (EX-06) du § 7.17 |
| **Nature** | **additive** : tables `publications_info_route` et `bulletins_routiers`, vue `info_route_courante`, deux déclencheurs. Aucune ligne existante touchée, la main courante n'est pas modifiée |
| **Invariants en base** | publications en **ajout seul** (UPDATE / DELETE refusés, heure serveur imposée), événement existant dans la main courante, séquence PUBLICATION → MISE_A_JOUR → RETRAIT sous verrou consultatif par événement, **niveau de praticabilité publiable seulement s'il est approuvé** ; bulletins figés, empreinte SHA-256 du texte **vérifiée par contrainte** |
| **Données semées** | aucune |
| **Tests** | banc `info_route.test.sql`, 20 assertions, chaque refus avec sa contre-épreuve (l'approbation de P4 n'est accordée que dans la transaction annulée ; vérifié ensuite : P1–P4 toujours non approuvés) |
| **Rollback** | **OUI**, aller-retour vérifié le 19/10. Perd ce qui a été annoncé au public et l'archive des bulletins : valeur probatoire, compter avant |

---

## 2 ter. Le banc d'essai des sections fixes, et ce qu'il établit

`backend/prisma/tests/sections_fixes.test.sql`, exécuté dans une transaction **annulée**, donc
sans rien écrire de durable. Un `RAISE EXCEPTION` sur la première assertion fausse fait échouer
la commande : le fichier est utilisable en intégration continue dès qu'une base y sera
disponible.

**14 assertions, toutes passées.** Le jeu de test emploie une géométrie dont la longueur est
**volontairement non ronde** — 995,449 m — et une `longueurKm` déclarée **volontairement fausse**
de 1,2 km, soit 20,5 % d'écart.

| Propriété éprouvée | Résultat |
|---|---|
| **B11.1** somme des sections = longueur du tronçon | vrai aux pas de **100, 200, 37 et 5 000 m** — 10, 5, 27 et 1 sections, somme toujours 995,449 m |
| La dernière section est un **reste** | 95,449 m au pas de 100 m |
| **B11.2** état de la portion **dominante** | section [100, 200) : 20 m de mauvais contre 80 m de bon → **bon**, dominance 80 %. C'est le piège du critère : la majorité gagne, pas la portion qui commence la première |
| Une section **non couverte** apparaît quand même | état nul, couverture 0, 0 portion. La disparaître se lirait comme une route sans existence, alors que c'est l'observation qui manque |
| La couverture ne dépasse **jamais** 1 | garanti par construction — le filtre est celui de la contrainte d'exclusion, donc sans chevauchement, et les intervalles sont semi-ouverts |
| **A9** une proposition non validée n'a aucun effet | une portion `A_VALIDER` couvrant tout le tronçon : **zéro influence** |
| La **géométrie** fait foi, pas la longueur déclarée | les deux sont rendues côte à côte, écart de 20,5 % visible et non masqué |
| Un tronçon **sans géométrie** est exclu | 0 section, aucun repli sur la longueur déclarée |
| Un pas nul ou négatif **échoue bruyamment** | et non rendu comme un résultat vide, qu'un appelant lirait « ce tronçon n'a pas de section » |
| L'axe **terrain** répond à la date | section [200, 300) : bon au 1ᵉʳ mars, mauvais au 1ᵉʳ septembre |
| **Contre-épreuve** : la contrainte refuse encore | un chevauchement sur les deux axes, et un chevauchement métrique à période commune |

Cette dernière ligne compte autant que les autres : sans elle, **supprimer purement la contrainte
aurait fait passer le test**. Les deux premières assertions bitemporelles prouvent qu'elle
accepte ce qu'elle doit accepter ; seule la contre-épreuve prouve qu'elle refuse encore.

---

## 3 bis. 🔴 Ce que le rejoue a révélé : la chaîne ne reconstruit pas la base

En montant la base de développement, j'ai découvert un fait que personne n'avait mesuré, et qui
compte davantage que le rollback.

**`prisma migrate deploy` échoue sur une base vierge.** Mesuré en rejouant les 51 fichiers un par
un sur une base neuve :

| Mesure | Valeur |
|---|---|
| Migrations rejouées sans erreur | **49** |
| En échec | **2**, dont **une seule réelle** |

| Migration | Erreur |
|---|---|
| `20260702140000_decomptes` | `foreign key constraint "decomptes_marcheId_fkey" cannot be implemented` — `marcheId` est `uuid`, `marches.id` est `text` |
| `20260902140000_p1_soft_delete_decomptes_bailleurs` | `relation "decomptes" does not exist` — **conséquence** de la précédente |

### La cause, et elle est instructive

| Source | Type de `marches.id` |
|---|---|
| `schema.prisma`, ligne 742 | `String @id @default(uuid()) @db.Uuid` → **`uuid`** |
| `20260702110000_marches_bailleurs_avancement`, ligne 31 | `"id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text` → **`text`** |

Les deux se contredisent, et **aucune migration ne change jamais ce type**.

Si la production fonctionne, c'est que cette migration déclare `CREATE TABLE **IF NOT EXISTS**
"marches"` : la table existait déjà, créée depuis `schema.prisma`, donc avec un `id` en `uuid`.
Le corps de la migration a été **sauté**, et la clé étrangère de `decomptes` a trouvé le type
qu'elle attendait.

Dix-sept `CREATE TABLE IF NOT EXISTS` figurent dans ces migrations, contre trente-deux sans
garde. Cette garde, qui ressemble à de la prudence, a ici **masqué une divergence pendant trois
mois**.

### La conséquence, qui est la vraie découverte

**La chaîne de migrations n'est pas le chemin de reconstruction de cette base.** Elle en est une
trace partielle, ce que `AGENTS.md` disait déjà des origines du dépôt : « le commit initial est
un instantané, pas une reconstruction de l'historique réel ».

Donc, et il faut l'écrire sans adoucir :

- **aucun environnement neuf** — développement, préproduction, reprise après sinistre — ne peut
  être monté par `migrate deploy` seul ;
- **le plan de reprise doit reposer sur une sauvegarde `pg_dump`**, pas sur les migrations. Les
  trois archives des 13 et 14/10 prennent donc un rang qu'elles n'avaient pas : elles ne sont pas
  un filet, elles sont **le seul chemin** ;
- un correctif n'est pas anodin. Prisma enregistre une **empreinte de chaque fichier** dans
  `_prisma_migrations` : corriger `20260702110000` ferait échouer le prochain `migrate deploy` en
  production sur une erreur d'empreinte. Et comme l'échec survient *avant* toute migration
  ultérieure, aucune migration de réparation placée après ne peut aider.

**C'est donc une décision, pas une correction**, et elle vous revient. Trois options, leurs
conséquences et ma recommandation sont consignées en **D-10** dans
[DECISIONS_PENDING.md](DECISIONS_PENDING.md).

**Ce que je n'ai pas fait** : toucher aux fichiers de migration. Les corriger silencieusement
aurait réparé la reconstruction locale en armant une erreur d'empreinte au prochain déploiement
de production.

---

## 4. La dérive de schéma préexistante, et l'interdiction qu'elle impose

🔒 **`prisma migrate dev` ne doit JAMAIS être lancé contre une base portant des données.**

La table `limites_admin` et treize index créés en SQL brut **ne figurent pas dans
`schema.prisma`**. Du point de vue de Prisma, ce sont des objets inattendus. `migrate dev`
compare le schéma au fichier et **proposerait de les supprimer**, ce qui détruirait les limites
administratives — dont dépendent le rattachement régional, le détecteur hors territoire et
l'audit des axes régionaux.

**Seul `prisma migrate deploy` est admissible**, car il exécute les fichiers de migration sans
comparer le schéma.

C'est aussi pourquoi le verdict « Database schema is up to date! » doit être lu avec prudence :
il porte sur les migrations enregistrées, pas sur l'absence d'écart entre le schéma réel et
`schema.prisma`. Cet écart existe, il est connu, et il est **voulu** — les géométries PostGIS ne
sont pas gérées nativement par Prisma, ce que le § 7.1 du mandat reconnaît en prescrivant
`Unsupported("geometry(...)")` et des migrations SQL versionnées.

---

## 5. La ligne anormale de `_prisma_migrations`, expliquée

Une ligne porte `finished_at` nulle **et** `rolled_back_at` renseignée :
`20260623000000_init`, `applied_steps_count = 0`.

Prisma documente `migrate resolve --rolled-back` comme marquant une migration « pour qu'elle
puisse être réappliquée ». Cette ligne laisse donc craindre qu'un `migrate deploy` rejoue un
`init` contre une base peuplée.

**Ce n'est pas le cas, et la raison est que `_prisma_migrations` a `id` pour clé, pas
`migration_name`.** Il existe **deux lignes** pour ce nom :

| Tentative | Horodatage | Issue |
|---|---|---|
| Première | 23/06/2026 09:46:38 | échec, puis marquée annulée à 09:47:00 |
| Seconde | 23/06/2026 09:48:22 | **réussie**, `applied_steps_count = 1` |

Prisma voit donc `init` comme appliquée. Incident clos depuis juin, et `migrate deploy` a tourné
avec succès plusieurs fois depuis — dont deux fois le 14/10.

**À ne pas « corriger ».** Supprimer la ligne annulée effacerait la trace d'un incident réel, et
le § A.5.8 proscrit les suppressions silencieuses.

---

## 6. Liste de contrôle de déploiement

À exécuter **par une personne autorisée**, dans cet ordre. Chaque étape a un critère d'arrêt.

### Avant

1. **Sauvegarde vérifiée.** `pg_dump -Fc`, puis `pg_restore -l` pour contrôler que l'archive est
   lisible. **Ne pas se contenter de l'existence du fichier** (§ A.7). Les trois archives des 13
   et 14/10 font 292 Mo et l'une a été contrôlée : 470 entrées listées.
2. **Place disque.** Le serveur était à 85 % le 14/10, 14 Go libres. Une construction d'image
   peut remplir un disque qui porte dix services : `docker builder prune` avant.
3. **Compteurs de référence**, à relever et à comparer après : `troncons`, `ouvrages`,
   `points_noirs`, `valeurs_qualite`, `audit_logs`, `users`, et les tables touchées — ici
   `portions` et `medias_defaut`, à 0.
4. **`prisma migrate status`** juste avant, car l'état peut changer entre-temps.
5. **Empreinte des deux `.env`**, avant et après le transfert. Ils ne sont pas dans Git et ne
   doivent jamais être écrasés ; `git archive` ne les contient pas, ce qui protège par
   construction.
6. **Vérifier l'absence de suppression** : `git diff --name-status main...HEAD | grep "^D"`.
   L'extraction a lieu **en place**, donc un fichier supprimé dans la branche ne disparaîtrait
   pas du serveur. Mesuré le 14/10 : **aucune suppression**.

### Pendant

7. **Le nom du répertoire de déploiement ne doit pas changer.** Le projet Compose en dérive, et
   les noms de volumes avec lui. Un répertoire renommé donnerait des volumes **vides** : une
   base neuve à la place de la production. Le projet vivant est `console-bdri`, dans
   `/opt/console-bdri`.
8. `docker compose up -d --build`, puis attendre que `db` soit `healthy`.
9. `docker compose exec backend npm run prisma:deploy`. **Jamais `prisma:migrate`**, qui est
   `migrate dev` : voir § 4.

### Après

10. **Compteurs identiques** à ceux de l'étape 3, hors `audit_logs` qui peut croître.
11. **Colonnes et contraintes présentes**, avec leurs valeurs par défaut.
12. `/api/health` : `status: ok`, et **`audit.echecsDepuisDemarrage` à 0**. S'il devient non nul,
    les audits échouent en silence et la comparaison avant/après le dira.
13. **Journal backend sans erreur** depuis le redémarrage.
14. **Routes protégées en 401 et non en 404** : un 404 signifierait que le code neuf n'est pas
    servi.

### Si une migration échoue

`migrate deploy` s'arrête sur elle ; les précédentes restent appliquées. **Ne jamais marquer une
migration comme appliquée artificiellement** (§ A.5.2), et n'employer aucun mécanisme équivalent
à `--fake`. Diagnostiquer, corriger le fichier, puis rejouer.

### Récupération

La descente est documentée au § 2. Avant de l'exécuter un jour, **compter les lignes portant une
valeur dans chaque colonne retirée** : une date d'effet terrain ne se recalcule pas depuis les
dates système, et un résultat d'analyse ne se reconstitue pas. Si un comptage n'est pas nul, la
descente exige une sauvegarde vérifiée et une autorisation explicite (§ A.5.2), et le § A.5.8
interdit toute suppression silencieuse de données.

Retirer aussi la ligne de `_prisma_migrations`, sans quoi `migrate deploy` considérera la
migration comme appliquée et ne la rejouera jamais. Ce geste est **volontairement absent** du
script de descente : il doit être conscient, pas un effet de bord.

---

## 7. Ce qui bloque le déploiement, et dans quel ordre le lever

| # | Blocage | État au 14/10 au soir |
|---|---|---|
| 1 | **Rollback non éprouvé** | ✅ **levé** — exécuté et vérifié en aller-retour (§ 3). B-13 clos |
| 2 | **L'image du conteneur ne contient pas cette migration** | ouvert. Elle a été construite avant ; la livrer exige un `--build`, donc un déploiement |
| 3 | **Autorisation explicite** du responsable AGEROUTE | ouvert, § A.5.1 et § A.8 |

Le seul que je pouvais lever moi-même l'est. Les deux autres vous appartiennent.

**Et un quatrième point est apparu**, qui ne bloque pas *ce* déploiement mais qu'il serait
malhonnête de ne pas placer ici : la chaîne de migrations ne reconstruit pas la base (§ 3 bis).
La migration en attente, elle, reste strictement additive et sans risque pour la production —
les deux faits sont indépendants, et le second ne doit pas servir de prétexte à retarder le
premier.

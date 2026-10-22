# Cahier des charges consolidé — Système national de gestion du patrimoine routier

**Version 1.1, 22/10/2026** (version 1.0 du 14/10/2026). Exigé par le § 13.3 du mandat v2.1.

La colonne « État » du § 5, le § 6 et le § 7 ont été remis à l'état du code et des tests le 22/10/2026.
En cas d'écart, [REQUIREMENTS_TRACEABILITY.md](../../REQUIREMENTS_TRACEABILITY.md) fait foi : elle porte la
commande, le résultat et la réserve de chaque ligne.

Ce document fusionne en une seule référence : le cahier RAI V3.1, l'exigence « vision
nationale » à dix points, l'addendum critique V4.1, les décisions du commanditaire des 13 et
14/10/2026, et le mandat v2.1. **En cas de conflit, la hiérarchie du § 0 du mandat v2.1
s'applique** : garde-fous 🔒, puis intégrité des données, puis exigences métier, puis
conventions du dépôt, puis préférences techniques.

Il ne réécrit pas les spécifications techniques du mandat v2.1 : celles-ci font foi et sont
citées. Son objet est de **trancher les contradictions** entre les documents successifs, de
**nommer ce qui est décidé** et de **séparer ce qui attend un arbitrage**.

---

## 1. Périmètre

### 1.1 Dans le périmètre

Référentiel routier géospatial ; portions homogènes ; ouvrages et équipements ; dégradations,
points noirs, incidents et praticabilité ; inspections et missions ; collecte terrain y compris
**en roulage** ; qualité des données ; évaluation de l'état ; prévision ; priorisation ;
**programmation pluriannuelle et annuelle de l'entretien** ; tableau de bord national ;
Géoportail public et console métier ; intégrations.

La chaîne va de l'observation à la **fiche d'intervention programmée** transmise à DigitalRoad,
et reçoit en retour, **en lecture seule**, les faits d'exécution nécessaires au suivi de l'état.

### 1.2 Hors périmètre, et ce que cela implique pour l'existant

Marchés, contrats, chantiers, ordres de travaux, décomptes et paiements vivent **exclusivement
dans DigitalRoad** (mandat § 1.2).

**Le dépôt les contient et la production les porte** : `chantiers` (496 lignes), `marches`,
`ordres_travaux`, `decomptes`, `marches_chantiers`, `avancement_marche`, `ot_historique`,
`ot_photos`, les routes `/api/marches` et `/api/ordres-travaux`, les pages `/marches` et
`/ordres-travaux`.

**Décision** ([ADR-003](../../TECHNICAL_DECISIONS.md)) : maintenus en fonctionnement, **gelés**, non
étendus. Leur transfert éventuel est une décision institutionnelle (B-08).

🔒 **Aucune estimation ni programmation ne crée de décompte, de certification de paiement ou
d'engagement financier.** Cette règle figurait déjà au § 13 du cahier RAI V3.1 et au § 7.7 du
mandat v2.1. La table `decomptes` existe, vide : elle doit le rester côté Géoportail.

---

## 2. Contradictions entre documents, et ce qui est retenu

C'est la raison d'être de ce document. Sept conflits ont été identifiés et tranchés.

| # | Conflit | Retenu | Motif |
|---|---|---|---|
| C-01 | **Pondérations du RCI** : cahier § 13 à huit composantes (signalisation 10) contre liste du commanditaire à neuf (environnement 5 + autres 5) | **Cahier § 13** | La signalisation est inventoriable et constitue une famille d'actif ; « autres critères » n'est définissable par rien. [ADR-004](../../TECHNICAL_DECISIONS.md) |
| C-02 | **Technologie mobile** : PWA + Capacitor (13/10) contre React Native (mandat § 7.8) | **React Native** | Le § 7.13 est irréalisable en PWA, et le § 7.8 tranche lui-même. [ADR-002](../architecture/ADR-002-TECHNOLOGIE-MOBILE.md) |
| C-03 | **Travaux et ordres de travaux** : prévus par les versions antérieures, exclus par le mandat § 1.2 | **Exclus** | Décision du commanditaire |
| C-04 | **Opérations de production** : mandats antérieurs autorisaient le déploiement, § 2.1 🔒 l'interdit | **Interdit** depuis le 14/10 14:23 | Garde-fou non négociable. [ADR-001](../../TECHNICAL_DECISIONS.md) |
| C-05 | **Découpage administratif** : mandat § 1.1 énonce 8 régions et 33 préfectures ; la table `regions` porte 11 lignes dont `Siguiri`, `Beyla` et `Non renseigné` | **non tranché** | Décision institutionnelle (B-06). `limites_admin` niveau 1 couvre bien le pays (244 785 km² sur ≈ 245 857), mais avec les mêmes 10 entités |
| C-06 | **Linéaire du réseau** : mandat § 1.1 annonce ≈ 44 000 km classés ; la base mesure **21 156,6 km** | **la base fait foi**, l'écart est localisé ci-dessous | Mandat § 1.2 : « si un élément du dépôt contredit ce contexte, le dépôt fait foi » |
| C-07 | **Nomenclature des classes** : mandat § 1.1 parle de RN, RP (préfectorales), RC (communautaires) ; l'énumération `ClasseRoute` porte RN, **RR**, RU, PISTE, NON_CLASSEE | **non tranché** | À aligner sur le classement officiel (B-07). Il manque une valeur, pas seulement un libellé |

### C-06 et C-07 mesurés : l'écart n'est pas diffus, il est localisé

Mesure du 14/10/2026 sur le réseau classé, par classe de route :

| Classe | Base mesurée | Mandat § 1.1 | Écart |
|---|---|---|---|
| **RN** — nationales | **7 824,4 km** (621 tronçons) | ≈ 7 500 km | **+4 %, concordance** |
| **RR** — régionales | **13 295,6 km** (1 029 tronçons) | ≈ 16 000 km de préfectorales | **−17 %** |
| **RC** — communautaires | **la valeur n'existe pas dans l'énumération** | ≈ 20 000 km | **−20 000 km** |
| RU — voiries urbaines | 36,6 km (41 tronçons) | — | — |

Trois lectures, et elles n'appellent pas les mêmes actions.

**Le réseau national est essentiellement complet.** 7 824 km mesurés contre 7 500 annoncés :
l'écart de 4 % est de l'ordre de la précision des géométries et des arrondis d'un classement.
C'est la meilleure nouvelle de ce cahier — le référentiel des RN, qui porte l'essentiel du
trafic et des enjeux, tient.

**Le réseau régional manque d'un sixième.** 13 296 km contre 16 000 : soit 2 700 km non encore
saisis, soit une différence de définition entre « régionale » et « préfectorale ». À établir.

**Les routes communautaires n'existent pas dans le modèle.** Ce n'est pas qu'elles sont
absentes des données : `ClasseRoute` ne porte **aucune valeur** pour les accueillir (RN, RR,
RU, PISTE, NON_CLASSEE). Les 20 000 km annoncés n'ont donc nulle part où être enregistrés, et
aucune saisie ne pourrait les y mettre aujourd'hui.

**C-07 est donc plus lourd qu'un renommage.** Aligner la nomenclature demande d'ajouter une
valeur `RC` — `ALTER TYPE ... ADD VALUE`, irréversible — et de décider si `RR` devient `RP`,
ce qui est une migration de données sur 1 029 tronçons. Les deux gestes doivent attendre le
classement officiel (B-07), sous peine de figer une nomenclature inventée.

**Conséquence immédiate pour le tableau de bord.** Tout taux de couverture publié aujourd'hui
porterait sur 21 156,6 km, soit **48 % du réseau annoncé**. Le § 7.12 🔒 exige que chaque
indicateur affiche son périmètre : ce périmètre doit dire « réseau classé saisi », jamais
« réseau national ».

---

## 3. État réel au 14/10/2026 — ce qui est acquis

Ces éléments sont en production, testés, et ne sont pas à refaire (mandat § 4 : « Ne refais
jamais un audit déjà consigné »). Preuves dans
[21_TABLEAU_CONFORMITE.md](../rai-v3/21_TABLEAU_CONFORMITE.md) et
[TESTS.md](../../TEST_EVIDENCE.md).

| Domaine | Acquis |
|---|---|
| Appariement GPS | score de confiance à deux facteurs, seuil 0,35, candidats en cas d'ambiguïté, position brute toujours conservée |
| Portions homogènes | modèle, table, création, découpe, fusion, requalification, lignage ; **non-chevauchement garanti par contrainte d'exclusion `btree_gist`** ; abscisse relative sans dépendance au PK |
| Dégradations | catalogue de 13 types administrable, gravité et étendue séparées, métré par longueur, surface, volume et coefficient unitaire |
| Validation | pas d'auto-validation, contrôle côté serveur, audit transactionnel, délégation par domaine |
| Qualité | 9 familles d'anomalies, agrégées, **aucune correction ne propose de supprimer** |
| RCI | moteur, collecte, normalisation, classes ; règle `rci-2026.1` **approuvée** |
| Barèmes de coût | provenance, approbation, millésime, largeur, devise, fenêtre de validité ; 9 coûts **non approuvés** |
| Couverture réseau | agrégation SQL, 212 ms sur le réseau classé |
| Hors ligne | file idempotente, conflits explicites, service worker à deux caches |
| Tests | **1 349** (1 067 backend, 282 frontend) |

---

## 4. Le verrou, qui n'est pas technique

Mesuré en production le 14/10 : `missions` **0**, `observations` **0**, `defauts` **0**,
`portions` **0**, `evaluations_condition` **0**, `referentiel_praticabilites` **0**.

**Toute la chaîne de collecte est écrite, testée, déployée — et vide.** Sur 1 691 tronçons du
réseau classé, 649 portent un état déclaré et **un seul** porte un état réellement observé
(`RES-857`). `troncons.dateDerniereEvaluation` est nulle sur les 261 387 lignes.

Trois conséquences pour ce cahier :

1. **Aucun indicateur ne sortira d'un développement supplémentaire.** Le RCI est approuvé et
   refuse chaque score, la couverture maximale atteignable étant 0,45 pour un seuil de 0,5.
2. **La priorité fonctionnelle est la collecte**, et le § 7.13 (roulage) est le moyen le moins
   coûteux de couvrir le réseau — d'où son rang de priorité M.
3. **Les jeux de données de test deviennent indispensables**, le § 2.1 coupant l'accès à la
   production (B-26). Sans eux, les critères A2, A5, A15 et A18 ne sont pas éprouvables.

---

## 5. Exigences consolidées, et leur source

Le détail technique n'est pas recopié : le mandat v2.1 fait foi. Ce tableau donne la
correspondance et l'état.

| Domaine | Référence | État |
|---|---|---|
| Conventions géospatiales | § 7.1 🔒 | 🟠 longueurs en `geography` ; concaténation SQL corrigée ([ADR-005](../../TECHNICAL_DECISIONS.md)) ; **UTM 28N/29N employé** par `metre_utm` (écart de 0,04 à 0,18 % à l'ellipsoïde, sur géométries connues) ; index GiST sur toutes les colonnes géométriques ; `ST_IsValid` contrôlé sur les tronçons seulement |
| Référencement linéaire | § 7.2 | 🟡 portions, lignage, exclusion et **bitemporalité à deux axes** faits ; date d'effet saisissable depuis le 22/10 ; codification nationale absente (D-06) |
| Map-matching | § 7.3 | 🟡 ponctuel complet ; **HMM de trace** et **graphe du réseau** faits et branchés à `POST /api/v2/geo/trace` ; tolérance de fusion réelle, sens uniques et performance nationale non mesurés |
| Catalogue et métrés | § 7.4 | ✅ sauf photos de référence par gravité |
| Workflow de validation | § 7.5 | ✅ |
| Moteur de qualité | § 7.6 | ✅ |
| Évaluation, prévision, programmation | § 7.7 | 🟠 RCI écrit et **désapprouvé** (D-00) ; catalogue des traitements ; moteur de coût qui refuse d'estimer sans barème ; risque et programmation : voir la ligne 7.7 de la matrice |
| Mobile | § 7.8 | ❌ PWA seule ; Capacitor retenu (ADR-009), non commencé ; aucun APK compilable ici (B-10) |
| Sécurité | § 7.9 | 🟠 RBAC fait ; **contrôle territorial des écritures sur les huit domaines livré** (T-32), **sans effet tant qu'aucun compte n'a de périmètre** (D-11) ; réduction des privilèges de `bdri_app` scriptée et éprouvée sur base jetable (T-33), non exécutée en production ; risques B-18 à B-21 ouverts — *22/10* |
| Intégrations | § 7.10 | ⛔ aucun accès (B-11, B-12) |
| Interface web | § 7.11 | 🟠 lint d'accessibilité opérationnel ; WCAG 2.1 AA mesuré par axe-core sur 8 écrans, 0 violation ; contraste, géoportail et tableau de bord non mesurés |
| Tableau de bord | § 7.12 | 🟠 périmètre, portions validées et qualité affichés (15/10) ; Control Tower et Fiche 360° absents |
| Collecte en roulage | § 7.13 | 🟠 **côté serveur seulement** : analyse d'une trace GPX ou CSV importée et écran « Relevé en véhicule » ; l'enregistrement sur le téléphone n'est pas commencé |
| Excellence référentiel et Géoportail | § 7.14 | 🟠 faits : déviation routée sur le graphe, permaliens, curseur temporel, métadonnées ISO 19115 (XML non validé contre les XSD). Absents : codification nationale, gazetier, vue de route, carte des années futures. Services OGC et tuiles vectorielles écartés par la mesure (voir [LOGIROAD_BENCHMARK.md](../../LOGIROAD_BENCHMARK.md)) |

Les 70 fonctions étendues du § 14 (T-, E-, PR-, R-, D-, P-, G-, X-) sont intégrées par
référence, avec leurs priorités MoSCoW et leurs lots. Conformément au § 14, **même les fonctions
C doivent être anticipées dans le modèle de données dès le lot 2**.

---

## 6. Décisions du commanditaire, consolidées

| Date | Décision |
|---|---|
| 13/10 | Correspondance état → score : **BON 90, MOYEN 65, MAUVAIS 35, CRITIQUE 10**. `NON_EVALUE` volontairement absent : c'est une absence d'état |
| 13/10 | **Six classes** de score, 0 à 100, bornes inclusives |
| 13/10 | **Seuil de couverture 0,5**, en connaissance de cause : il rend zéro score tant que la collecte n'a pas tourné |
| 13/10 | 6 573 tronçons hors territoire : **conserver, classifier, n'exclure que selon une règle de périmètre validée** |
| 13/10 | 42 doublons : **fiche de comparaison par paire, sans fusion automatique** |
| 13/10 | 1 029 axes régionaux : **référentiel provisoire, sans inventer les longueurs** |
| 14/10 | **Règle `rci-2026.1` approuvée**, avec la fraîcheur à 365 jours et les confiances `HIGH`/`MEDIUM` ; **désapprouvée le jour même à 16 h 19** (D-00, option B) en attendant la confrontation à VIZIR et à la directive UEMOA |
| 14/10 | Barèmes de coût : **conserver les valeurs comme défauts, les rendre paramétrables** |
| 14/10 | **Mandat v2.1** : gel de la production, périmètre réduit, exigences de roulage et d'excellence |

---

## 7. Ce qui attend un arbitrage

Repris de [BLOCKERS.md](../../BLOCKERS.md), car aucun développement ne les contourne. Les options, impacts et
recommandations techniques des décisions D-01, D-02, D-06, D-07, D-09, D-10 et D-11 sont réunis dans
[DECISIONS-SYNTHESE-ARBITRAGE.md](../pilotage/DECISIONS-SYNTHESE-ARBITRAGE.md).

**Décisions institutionnelles** : valeurs de praticabilité (B-01) ; millésime et largeur des
barèmes (B-02) ; rattachement des `RES-nnnn` aux axes (B-03) ; règle de périmètre hors
territoire (B-04) ; arbitrage des 42 doublons (B-05) ; référentiel administratif officiel
(B-06) ; codification nationale (B-07) ; sort des modules contractuels (B-08) ; résidence des
données (B-09) ; **écart de 23 000 km sur le linéaire classé (C-06)** ; **nomenclature RR ou RP
(C-07)**.

**Accès** : chaîne Android (B-10) ; API DigitalRoad (B-11) ; SharePoint et Entra ID (B-12) ;
**base de développement (B-13)** ; signature et distribution mobile (B-14).

**Sécurité, cinq risques ouverts** : dépôt public portant une IP de production (B-17) ; mot de
passe ADMIN jamais changé (B-18) ; `bdri_app` superuser et seul rôle de connexion (B-19) ;
quatre comptes ADMIN actifs (B-20) ; clé de sauvegarde sans copie hors serveur (B-21).

---

## 8. Critères d'acceptation

Les 22 scénarios A1 à A22 du § 10 et les 10 scénarios B1 à B10 du § 14.9 du mandat v2.1 font
foi sans modification. Leur état d'éprouvabilité est tenu dans
[TESTS.md](../../TEST_EVIDENCE.md), qui distingue ce qui est testé de ce qui ne l'est pas — et
dit pourquoi.

**Définition de « terminé » 🔒** (§ 9) : compilation sans erreur de typage ; tests unitaires,
d'intégration et API du lot passants, **commande et résultat consignés** ; autorisations serveur
testées ; aucune régression ; documentation et matrice à jour ; aucune donnée factice dans un
parcours présenté comme réel.

# Architecture de différencation — la machine à décider prouvable

> Proposition d'architecture, 22/10/2026, ZCode. Répondre à « aller plus loin » : au-delà
> des améliorations d'écrans (voir AMELIORATIONS discutées le 22/10), voici le saut
> architectural. Chaque brique s'appuie sur des tables et moteurs DÉJÀ présents dans le
> dépôt — la liste « ce qui existe / ce qui manque » est vérifiable.

## Thèse

Les concurrents (ANASUR Collect, L²R, PRISM, CityLogix) sont des outils de **saisir**,
**calculer** ou **visualiser**. Aucun n'est un outil de **prouver**. Le dépôt AGEROUTE
possède déjà, dispersées, les trois primitives d'une « machine à décider prouvable » :
l'audit transactionnel, la gouvernance à validation, la bitemporalité. Il faut les
élever au rang d'ARCHITECTURE — que la preuve ne soit plus une table d'annexe mais la
matière première de chaque écran.

## Les trois primitives

### 1. LA PREUVE — chaque chiffre justifié et REJOUABLE

Existe : `audit_logs`, `validations` (gouvernance polymorphe), barèmes versionnés et
approuvés, estimations refusables avec motif, `methodes` versionnées (IRI, RCI en
attente D-06).

Manque :
- une table `preuves` (ou une vue unifiée) : tout agrégat publié (KPI, estimation,
  score, programme) enregistre sa recette — requête ou moteur, version, empreinte des
  données d'entrée, auteur, date ;
- l'API `/pourquoi/{objet}` qui remonte le graphe : chiffre → recette → entrées →
  validateurs ;
- le REJEU : recalculer un chiffre ancien sur les données du moment et DIFFÉRENCIER —
  « ce KPI a bougé depuis hier car 12 portions ont été validées ».

Effet : le bouton « Justifier » partout (modal + PDF), et surtout la NARRATION DU
CHANGEMENT — aucun outil du marché ne sait dire ce qui a fait bouger un chiffre.
C'est l'argument bailleur absolu : auditer la décision, pas seulement la donnée.

### 2. LE RÉSEAU VERSIONNÉ — des demandes de fusion sur le patrimoine

Existe : portions bitemporelles avec lignage, dates de validité, curseur temporel,
gouvernance à validateurs désignés, lots d'import avec rejets, observations « importées
≠ officielles ».

Manque : le PARCOURS DE FUSION — présenter toute proposition de changement (terrain,
import, future IA) comme une DIFF visualisée (géométrie avant/après sur la carte,
attributs modifiés ligne à ligne), avec relecteurs, discussion, fusion = validation.
« Le premier gestionnaire de patrimoine routier avec des demandes de fusion » : la
gouvernance existante, racontée en interface moderne.

Effet : l'import ANASUR/BDR futur devient un cas particulier (une grosse demande de
fusion), et plus aucun changement ne passe sans diff lu par un humain.

### 3. LA CHRONOLOGIE — la mémoire d'un lieu

Existe : main courante en ajout seul, inspections typées (dont POST_TRAVAUX avec photos
obligatoires), chantiers, marchés, publications Info Route figées et horodatées,
prévisions, patrouilles.

Manque : la frise UNIVERSELLE — une API « chronologie d'une portion / d'une route /
d'un secteur » qui ordonne tout (constats, validations, travaux, prévisions, budgets,
publications) et l'écran qui la rend : la vie d'une route, du relevé de 2019 au
programme 2028.

Effet : c'est la Fiche 360° poussée dans le temps ; combinée à la preuve, elle donne
« du franc à la chaussée » en natif : budget → travaux → état avant/après → photo,
sur UNE frise.

## Les capacités dérivées (une fois les primitives en place)

1. **Simulateur budgétaire à deux sens** — aller : budget + stratégie → portions choisies
   par le moteur de programmation existant, carte de l'état résultant, hypothèses
   affichées ; RETOUR : objectif d'état réseau 2029 → budget requis par stratégie.
   Étiqueté expérimental tant que D-07 n'est pas tranché (prix ONR).
2. **Dossier de programmation exportable** — par bailleur, par année : prévisions,
   arbitrages, justification des priorités, chaîne de preuve. Généré, signé par sa
   recette.
3. **Alertes avec destinataire et règle** — moteur unique sur les tables existantes
   (retards de marché, inspection échue, événement OUVERT non pris en charge,
   escalade de veille) ; canal in-app d'abord, courriel via le relais existant.
4. **Passerelle d'intégration sortante** — bâtir sur l'outbox que la session Claude
   est en train de merger : webhooks versionnés et idempotents pour DigitalRoad
   (puis ANASUR si autorisé). Le V9 § 18 l'exige ; la graine est dans la branche.
5. **Data takeout / annuaire statistique** — export reproductible et périmétré des jeux
   publics (métadonnées ISO déjà servies) : la souveraineté de la donnée comme
   produit, exigence croissante des bailleurs.
6. **QR patrimoine** — étiquettes imprimables par actif vers la fiche + saisie immédiate
   (terrain sans re-saisie).

## Séquencement

- **Phase 1 (2 semaines, deux agents)** : preuve unifiée (table + API /pourquoi +
  bouton « Justifier » sur les KPI) ; frise universelle (API + écran) ; les
  améliorations CRUD du 22/10 en parallèle.
- **Phase 2 (2 semaines)** : parcours de fusion (diff géométrique + relecture) sur les
  propositions existantes (imports, portions) ; simulateur aller ; QR patrimoine.
- **Phase 3 (2 semaines)** : simulateur retour ; dossiers de programmation exportables ;
  moteur d'alertes ; passerelle outbox → webhooks.
- Les décisions métier (D-02, D-06, D-07, corridor pilote) ne bloquent aucune phase :
  tout résultat non approuvé s'affiche PROVISOIRE avec ses hypothèses — c'est la loi
  du dépôt.

## Volet Vision — la caméra du téléphone (décision utilisateur du 22/10)

L'utilisateur a tranché : « ce qui est possible, on le prend ». La caméra détecte et
classe, depuis le téléphone ou la tablette, SANS dérogation à la doctrine (aucune
dépense, aucun service cloud, l'IA propose et l'agent tranche — V9 § 24.6).

L'ASTUCE D'ARCHITECTURE : **le site est une PWA — la caméra fonctionne dans le
navigateur dès aujourd'hui**, sans débloquer B-10 (pas besoin d'APK). Le parcours
défauts terrain et la file hors ligne existent ; il manque la capture caméra et la
classification assistée.

- **Phase A — Collecte et corpus organique (immédiat)** : capture caméra dans l'écran
  de défauts (getUserMedia / `capture="environment"`), GPS et horodatage automatiques,
  rafale multi-photos, sélection rapide dans le catalogue (recherche par nom), file
  hors ligne existante. CHAQUE photo confirmée porte type + gravité + géoloc + date +
  opérateur : le corpus guinéen exigé par le V9 § 23.5 se construit comme sous-produit
  de la première patrouille. Aucun modèle nécessaire.
- **Phase B — Classification assistée sur l'appareil (quand le corpus existe)** :
  petit modèle open-source (TensorFlow.js dans la PWA, exécution locale, zéro coût,
  zéro données sorties) affinant ses propositions au fil des confirmations ; les
  détections sont des PROPOSITIONS avec score, jamais des défauts validés.
- **Phase C — Roulage** : flux vidéo échantillonné, propositions regroupées, revue
  humaine par seuil de confiance. Le pilote rugosité smartphone (V9 § 23.3) partage le
  même effort mobile.

## Ce qu'on ne construit toujours pas

Pas de LiDAR ni d'achat de matériel (l'analyse comparative V9 § 24.5 reste la règle
avant tout engagement), pas de services de vision payants ni d'API cloud (les images
restent en Guinée), pas de 3D décorative, pas de microservices/Kafka, pas de
réécriture. La vision vient de l'appareil que les agents ont déjà en main.

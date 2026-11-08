# PLAN MAÎTRE D'EXÉCUTION — Console BDRI à deux agents

> Écrit le 22/10/2026 par ZCode. Intègre et étend : le plan de coordination du 22/10
> matin, le catalogue d'améliorations CRUD, l'architecture de différenciation
> (preuve/version/frise) et le volet Vision décidé par l'utilisateur le 22/10 soir.
> Document vivant : chaque agent y consigne ses prises de lot (§ Suivi).
> État d'ancrage : 72 migrations en production (0703c6a), incident compromission remédié,
> branche en mouvement (Control Tower, Fiche 360°, outbox en cours de fusion côté Claude).

## Principes (intangibles)

La loi du dépôt s'applique à tout le plan : rien d'inventé, preuve avant affirmation,
propositions IA jamais validées automatiquement, suppression logique seule, tout écrit
audité, essai sur copie avant tout geste production, déploiement par la procédure
éprouvée (un seul déployeur), suites jamais en parallèle sur le poste (L-00), secrets
nulle part. Aucun résultat non approuvé ne s'affiche comme officiel.

## Les onze chantiers

### WS-0 · Sécurité P0 — **pilote ZCode**
Clore S-1..S-4 avec preuves (SECURITY_REMEDIATION.md) : S-4 exécuter les scripts de
réduction `bdri_app` préparés par Claude (contrôles type déploiement + retour arrière) ;
rotation de TOUTES les clés 131↔132 + redépôt des clés de sauvegarde (coupera les
sauvegardes une nuit — à planifier) ; GLPI à jour ; décommission des fichiers Maarch ;
retour sur le serveur 134 hors ligne.
Acceptation : chaque alerte porte sa preuve post-correction, ou son blocage documenté.

### WS-1 · Réconciliation V9 + livraison de la branche — **écriture Claude, déploiement ZCode**
Réécrire le § 2 du PROMPT MAÎTRE V9 sur l'état réel ; absorber le commit 0703c6a dans
la branche ; qualifier (portes complètes en worktree) puis déployer Control Tower,
Fiche 360°, curseur temporel, moteur de risque/programmation, outbox.
Acceptation : V9 § 2 conforme au réel ; déploiement aux contrôles verts.

### WS-2 · CRUD et gestion (le catalogue du 22/10) — **pilote ZCode, revue frontend par agent**
Lot 2a (listes patrimoniales) : actions groupées, colonnes configurables mémorisées,
export CSV **et GeoJSON** de la sélection, duplication d'objet.
Lot 2b : vues sauvegardées nommées partageables, corbeille avec motif + restauration.
Lot 2c (Programmation) : modal d'édition avec fil d'historique, priorités par
glisser-déposer, copie d'année (PROPOSE jamais RETENU), comparateur prévu/réalisé sur
données réelles, export PDF par bailleur.
Acceptation : parcours testés (frontend + API), LECTEUR sans aucun bouton d'écriture.

### WS-3 · La Preuve unifiée — **noyau ZCode, écran Claude**
Table `preuves` (recette de tout agrégat publié : requête/moteur, versions, empreinte
des entrées, auteur, date) ; API `/pourquoi/{objet}` remontant le graphe ; bouton
« Justifier » + export PDF sur les KPI du tableau de bord et les estimations ;
**rejeu différé** (« ce chiffre a bougé depuis hier car… »).
Acceptation : pour 3 KPI réels, la chaîne complète est exportable et rejouable.

### WS-4 · La Frise universelle — **pilote Claude**
API « chronologie d'une portion / route / secteur » ordonnant constats, validations,
travaux, marchés, inspections (dont POST_TRAVAUX), prévisions, budgets, publications ;
écran frise + bascule carte aux dates (s'appuie sur le curseur temporel livré).
Acceptation : la frise d'un secteur réel raconte avant/après travaux avec photos.

### WS-5 · Demandes de fusion sur le réseau — **diff géométrique Claude, données ZCode**
Toute proposition (terrain, import, IA future) = diff avant/après (géométrie sur carte
+ attributs ligne à ligne), relecteurs désignés, fusion = validation (gouvernance
existante). L'import ANASUR/BDR futur devient un cas particulier.
Acceptation : un lot d'import réel passe par diff relu, idempotent, rejets exportés.

### WS-6 · Simulateur budgétaire bidirectionnel — **moteur Claude, données réelles ZCode**
Aller : budget + stratégie → portions retenues, carte résultante, hypothèses affichées.
Retour : objectif d'état → budget requis par stratégie. Dossiers de programmation
exportables (par bailleur/année), signés par leur recette (WS-3).
Étiqueté expérimental tant que D-07 n'est pas tranché — l'écran Barèmes existe :
la saisie des prix ONR par AGEROUTE débloque le calcul réel sans développement.

### WS-7 · Vision caméra (décision utilisateur 22/10) — **Phase A ZCode, Phase B Claude, Phase C à deux**
A (immédiat) : capture caméra PWA dans l'écran défauts terrain (GPS + horodatage
auto, rafale, catalogue rapide, file hors ligne existante) — chaque photo confirmée
= donnée étiquetée : le corpus guinéen se récolte en patrouillant.
B : modèle open-source local (TensorFlow.js, zéro cloud, zéro coût) proposant type +
confiance, l'agent tranche, les corrections nourrissent le modèle.
C : roulage (flux échantillonné, regroupement, revue par seuil) + pilote rugosité
smartphone (même socle mobile).
Acceptation : jamais de validation automatique ; aucune image hors du pays ; chaque
détection porte modèle + version + score + décision humaine.

### WS-8 · Alertes et passerelle — **pilote Claude**
Moteur d'alertes à règles/destinataires/fréquences sur les tables existantes (retards
marchés, inspections échues, OUVERT non pris, escalades de veille) ; webhooks sortants
versionnés et idempotents bâtis sur l'outbox en cours de fusion.
Acceptation : une alerte règlée + un webhook DigitalRoad rejoué sans doublon.

### WS-9 · QR patrimoine + Data takeout — **pilote ZCode**
Étiquettes QR imprimables par actif → fiche + saisie immédiate ; exports publics
reproductibles et périmétrés (annuaire statistique, métadonnées ISO déjà servies).
Acceptation : une étiquette collée sur un ouvrage ouvre la fiche au terrain.

### WS-10 · Décisions métier — **l'utilisateur seul (aucun agent ne décide)**
D-02 praticabilité · D-06 RCI/codification · D-07 barèmes (saisir prix ONR + approuver)
· trame rapport bailleur · périmètre du corridor pilote (P4/P5 du V9).
Chaque agent prépare les fiches d'options ; rien n'attend ces décisions pour livrer
les chantiers ci-dessus (tout résultat non approuvé = provisoire étiqueté).

## Phasage (chemins parallèles, jalons de déploiement)

| Phase | Semaines | ZCode | Claude | Jalon |
|---|---|---|---|---|
| 1 | S1-S2 | WS-0 sécurité ; WS-2a/2b CRUD ; WS-7A caméra | WS-1 réconciliation V9 + absorption 0703c6a ; WS-4 frise | **Déploiement J1** (branche qualifiée) |
| 2 | S3-S4 | WS-2c programmation ; WS-3 noyau preuve ; WS-9 QR | WS-3 écran Justifier ; WS-5 diff de fusion ; WS-8 alertes | **Déploiement J2** |
| 3 | S5-S6 | WS-6 données réelles + réconciliation financière | WS-6 simulateur ; WS-7B modèle local ; WS-8 webhooks | **Déploiement J3** + pilote corridor si décidé |
| 4 | S7+ | WS-7C roulage + rugosité (si corridor) | idem + dossier exportables | selon décisions métier |

Chaque jalon : portes complètes en worktree isolé, essai sur copie de la base réelle,
déploiement par la procédure, contrôles d'après, retour arrière archivé.

## Agents spécialisés (revues de jalons)

Avant chaque jalon, chaque pilote mobilise ses relecteurs : sécurité (S-4, rotation,
webhooks), backend (moteurs, preuves), frontend (CRUD, accessibilité — axe-core
operationnel), données/SIG (migrations, bancs PostGIS), livraison (auditeur de jalon :
preuves de test, conformité tracker). Les relectures sont bloquantes : un jalon ne se
déploie pas avec une revue rouge non tranchée.

## Règles de coopération (rappel, éprouvées)

1. Le tracker est l'unique vérité ; on n'écrit que ses lignes.
2. Un seul déployeur à la fois (ZCode par défaut, procédure éprouvée).
3. Suites jamais en parallèle ; jamais de commit pendant la fusion de l'autre ; on ne
   résout pas les conflits de l'autre.
4. Toute donnée de production passe par l'essai sur copie.
5. Les secrets ne transitent jamais (ni chat, ni dépôt, ni entre agents).
6. Prise de lot : une ligne datée ci-dessous avant de commencer.

## Suivi des prises de lot

- 22/10 ZCode : déploiements 0703c6a (72 migrations) ; plan maître écrit ; prend WS-0,
  WS-2, WS-3 (noyau), WS-7A, WS-9.
- 22/10 ZCode (soir, « Go » phase 1) : **WS-7A** — la capture caméra EXISTAIT déjà
  dans l'écran terrain (capture="environment", GPS, SHA-256 — crédit à l'autre
  session) ; ajoutés les boutons dédiés « Photographier sur le vif » / « Choisir »
  (tactile, test vert). **WS-0** — Maarch vérifié sur le 131 : plus AUCUN fichier web
  (répertoire absent, aucun vhost, apache inactif) ; reste S-4, rotation des clés,
  GLPI, serveur 134. **WS-2a (tranche 1)** — export DE LA SÉLECTION en CSV
  (point-virgule + BOM, Excel francophone) et GeoJSON (WGS84, toutes colonnes en
  propriétés) : route `/api/v2/export/selection` sur liste blanche (troncons,
  ouvrages, points_noirs, postes, chantiers, marches sans géométrie → CSV seul,
  contrôle de module par table, plafond 2000 ids, 5 tests verts), boutons dans la
  barre de sélection des listes ouvrages/points noirs/postes/chantiers, tsc ×2
  propres. Découvertes : la sélection multiple et les actions groupées
  archiver/restaurer EXISTAIENT déjà — le catalogue WS-2 se réduit à : colonnes
  configurables, vues sauvegardées, motif d'archivage, duplication. Non committé
  (fusion Claude en cours) : part au prochain cycle avec le lot.
- 22/10 Claude : fusion moteur risque/programmation + Control Tower/Fiche 360° + outbox
  en cours ; prend WS-1, WS-4, WS-5, WS-6 (moteur), WS-7B, WS-8.
- En attente utilisateur : D-02, D-06, D-07 (prix ONR), trame bailleur, corridor.

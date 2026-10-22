# Plan de coordination à deux agents — Z.AI (ZCode) et Claude

> Écrit le 22/10/2026 par ZCode, après confrontation du PROMPT MAÎTRE V9 à l'état réel
> du dépôt et de la production. Les deux agents travaillent sur le même dépôt, la même
> branche `lot/03-map-matching` et les mêmes serveurs. Chacun peut travailler seul ou
> avec l'autre ; ce document fixe qui mène quoi, et les règles de cohabitation tirées
> de la semaine du 20 au 22 octobre (elles ont toutes été éprouvées).

## 1. Verdict d'alignement au PROMPT MAÎTRE V9 (22/10/2026)

**La doctrine est alignée ; l'état de référence factuel du document a deux mois de retard.**
Le V9 décrit un état « 41 migrations en production, 4 en attente, moteurs absents ».
La réalité : **72 migrations appliquées en production** (dernier déploiement 22/10
11 h 46, commit 0703c6a), et la plupart des modules dits absents existent :

| Le V9 dit | Réalité au 22/10 | Écart |
|---|---|---|
| 41 migrations appliquées, 4 en attente | 72 appliquées, 0 en attente | doc périmée |
| Cost Engine absent | `engines/cout.noyau.ts` + écran barèmes livré le 22/10 | comblé |
| Programming Engine absent | moteur de programmation + saisie manuelle livrés le 22/10 | comblé |
| Risk Engine absent | moteur de risque fusionné le 22/10 (branche) | à déployer |
| Control Tower, Fiche 360° absents | fusionnés (be51458), non déployés | à qualifier/déployer |
| RCI : config rci-2026.1 non approuvée | inchangé — décision D-06 attend AGEROUTE/ONR | bloqué métier |
| Praticabilité non approuvée | inchangé — D-02 (P1–P4 provisoires) | bloqué métier |
| Exploitation/patrouilles (§ 24.2) à évaluer | lot 12 livré : main courante, patrouilles programmées, Info Route, cellule de veille | en avance |
| Imagerie 360°, LiDAR, vision IA (§ 24.4-24.6) | absents — conformes au « seulement après pilote » du V9 | conforme |
| 4 alertes sécurité P0 | S-1 analysé (IP jamais commitée), S-2 bloqué, S-3 traité à reconfirmer, S-4 préparé (scripts en revue) | en cours |
| — (le V9 l'ignore) | incident compromission 131/132 (juin→21/10), remédié, reste rotation des clés + GLPI | nouveau |

**Conséquence** : le V9 reste valable comme DOCTRINE (rien inventer, preuve avant
affirmation, gouvernance, jamais de paiement automatique, idempotence, autorisation
serveur). Son § 2 doit être réécrit sur l'état réel avant d'y répondre point par point.

## 2. Qui mène quoi

**ZCode (Z.AI) — production, sécurité, données réelles, déploiements.**
Atouts prouvés cette semaine : accès root 131 (Docker) et 132 (LXD), procédure de
déploiement éprouvée deux fois avec essai sur copie réelle, réponse à incident.

**Claude — fonctionnel, cadence de livraison, contrats et bancs.**
Atouts prouvés : curseur temporel, analyse de trace, métadonnées ISO, moteur de
risque/programmation, Control Tower, bancs d'intégration versionnés.

| Lot (numérotation V9) | Pilote | Contenu | État |
|---|---|---|---|
| P0 sécurité | **ZCode** | clore S-1..S-4 avec preuves (S-4 : exécuter les scripts préparés par Claude avec contrôles déploiement) ; rotation des clés 131↔132 (+ redépôt sauvegardes) ; GLPI à jour ; décommissionner fichiers Maarch | en cours |
| P0.5 réconciliation | **Claude** | réécrire le § 2 du V9 sur l'état réel (72 migrations, moteurs, incident) dans PROJECT_STATUS.md ; absorber 0703c6a dans la branche | à faire |
| P1 socle | Claude écrit, ZCode exécute | anomalies géospatiales (6 565 hors territoire, 42 doublons, 1 029 régionales) : recompter sur les données de production, fiches de décision ; identifiants stables (ROAD_IDENTITY_AND_LINEAGE.md) | à faire |
| P2 intégration | **Claude** | contrats DigitalRoad entrante (B-11/12 : accès manquant), options ANASUR A/B/C + questionnaires (V9 § 22), livrables ONR/BDR restants | partiel |
| P3 pilotage | **Claude** écrit, **ZCode** déploie | qualifier Control Tower + Fiche 360° (suites complètes, worktree), déploiement suivant ; trame rapport bailleur (attendue de l'utilisateur) | fusionné |
| P4/P5 mesure/IA | les deux, documents seulement | specs rugosité smartphone, corpus vision, pilote corridor — AUCUNE dépense ni service externe sans autorisation | conformes au V9 : attendre décision corridor |
| Décisions métier | **l'utilisateur seul** | D-02 praticabilité, D-06 RCI/codification, D-07 barèmes (l'écran existe : saisir les prix ONR puis approuver suffit à débloquer coût+programmation), périmètre pilote corridor | en attente |

## 3. Règles de cohabitation (éprouvées du 20 au 22 octobre)

1. **Le tracker est l'unique vérité** (`AUTONOMOUS_EXECUTION_TRACKER.md`) : chacun
   écrit SES lignes, ne retouche jamais celles de l'autre (précédent respecté dans
   6fc04c6).
2. **Un seul déploie à la fois.** Le déployeur gèle un commit, passe les portes dans
   un **worktree isolé** (tsc ×2, suites complètes seules, contre-épreuve de chaque
   échec — protocole L-00), fabrique l'archive `git archive` **depuis la racine**,
   l'exécute avec le script `infra/deployer-console.sh`. L'autre n'initialise pas de
   déploiement ni de geste production en parallèle.
3. **Jamais de suites en parallèle sur le poste** (L-00) ; jamais de commit pendant
   la fusion de l'autre (attendre MERGE_HEAD disparu) ; on ne résout pas les
   conflits de l'autre.
4. **Toute donnée de production passe par l'essai sur copie** (le banc de veille a
   prouvé le 22/10 que des données réelles légitimes cassent des hypothèses de banc).
5. **Les secrets ne transitent jamais** ni en chat, ni dans le dépôt, ni entre agents.
6. Coordination rapide par l'utilisateur (coller le message de l'un à l'autre) ou par
   ce fichier : toute prise de lot s'y inscrit d'une ligne datée ci-dessous.

## 4. Prises de lot (à tenir à jour par chaque agent)

- 22/10 ZCode : déploiement 0703c6a fait (72 migrations en prod) ; suit P0.
- 22/10 Claude : fusion moteur risque/programmation + Control Tower/Fiche 360 dans la
  branche ; S-4 scripts écrits ; absorption de 0703c6a et réécriture du § 2 du V9 à faire.

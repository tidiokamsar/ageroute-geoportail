# Déploiement de la Console BDRI : pas à pas (commit 747ac38)

Date : 27/10/2026. Ce document ne déploie rien. Il décrit ce qu'un humain (le DSI) lance, avec les empreintes à vérifier. Le script `infra/deployer-console.sh` refuse de modifier quoi que ce soit avant son étape 9 et s'arrête au premier contrôle qui échoue.

Cette version remplace celle du commit `0b902e7` : le commit `747ac38` ajoute au script une racine de sauvegardes configurable (`RACINE_SAUVEGARDES`), sans toucher au reste du code applicatif.

## 1. Ce qu'on déploie

| Élément | Valeur |
|---|---|
| Commit | `747ac3811581aa541abf9a2a6a9faf1d1b9f874b` (branche `lot/03-map-matching`) |
| Archive | `bdri-747ac38.tar.gz`, produite par `git archive` (reproductible) |
| SHA-256 de l'archive | `5429d9879a9ac2d6fda5c5eb090e38b9703b5b043521cef677774ae97fa5dfad` |
| Serveur applicatif | celui vers lequel pointe `carte.ageroute.gov.gn` (résolution DNS du 27/10 : 102.211.199.131, alias SSH `gec`), répertoire `/opt/console-bdri` |
| Migrations apportées | le script attend `ATTENDUES_EN_ATTENTE=2` (`20261027100000_medias_observation_analyse` et `20261027110000_composante_rci_valeurs`). Relevé en lecture seule le 27/10 : 82 migrations appliquées, dernière `20261026410000_correspondances_identifiants`, dernier déploiement le 24/10 à 13 h 03 (commit `6ed05e1`). Si le nombre trouvé diffère, le script s'arrête sans rien modifier |

## 2. Commandes

L'archive est déjà copiée dans `/tmp` sur le serveur (empreinte vérifiée le 27/10). Sinon, depuis le poste du DSI :

```bash
scp bdri-747ac38.tar.gz gec:/tmp/
```

Sur le serveur, les fichiers de `/opt/console-bdri` appartiennent à root (déploiements précédents faits avec `sudo`) : l'extraction et le script se lancent donc avec `sudo`.

```bash
cd /opt/console-bdri
sha256sum /tmp/bdri-747ac38.tar.gz     # doit afficher 5429d9879a9ac2d6fda5c5eb090e38b9703b5b043521cef677774ae97fa5dfad
sudo tar -xzf /tmp/bdri-747ac38.tar.gz --strip-components=1 bdri-747ac38/infra/deployer-console.sh
sudo bash infra/deployer-console.sh 747ac3811581aa541abf9a2a6a9faf1d1b9f874b 5429d9879a9ac2d6fda5c5eb090e38b9703b5b043521cef677774ae97fa5dfad /tmp/bdri-747ac38.tar.gz
```

On lance le script **extrait de l'archive**, pas l'ancien du serveur : seul celui-ci attend le bon nombre de migrations.

Les sauvegardes vont par défaut dans `/var/backups/bdri-deploiement/<horodatage>`. Pour un autre emplacement : `sudo RACINE_SAUVEGARDES=/chemin bash infra/deployer-console.sh ...`.

## 3. Ce que le script contrôle avant d'écrire quoi que ce soit

Projet Compose `console-bdri`, sauvegarde du jour et sa restaurabilité (`pg_restore -l`), espace disque supérieur à 15 % (relevé le 27/10 : 80 % utilisé, 19 Go libres), compteurs de référence, historique des migrations (aucune inachevée, aucune orpheline, exactement 2 en attente), une descente pour chaque migration en attente, absence d'index déjà présents, empreintes des `.env`, archive vérifiée, migrations essayées sur une copie restaurée. Puis **une confirmation humaine** (étape 9) : c'est à ce moment que le DSI décide, en tapant `DEPLOYER`. Après : compteurs, santé, audit, réponse 401 des routes protégées, `.env` inchangés. Aucun retour arrière automatique : la procédure s'affiche, la décision reste humaine.

## 4. Avant de confirmer l'étape 9

- `docker-compose.yml` et `nginx.conf` de l'archive ont été comparés à ceux du serveur le 27/10 : les seules différences sont celles voulues. Le dossier `./mobile` est monté dans le backend (l'APK est servi derrière l'authentification, plus par nginx), et `nginx.conf` ajoute `Cache-Control: no-cache` pour `sw.js`, `sw-policy.js`, `precache-manifest.json` et `manifest.webmanifest`.
- Le serveur contient des fichiers absents de l'archive (`backend/src/field/observations.regles.ts` et son test, `docs/rai-v3/*`) : inoffensifs, l'extraction ne les touche pas.
- Variables facultatives (valeurs par défaut en place) : `EVENEMENTS_LOCAUX_MAX_PAR_JOUR`, `MOBILE_DIR`.
- Prévenir les agents de terrain : les écrans de saisie exigent désormais un **code PIN**, créé à la première connexion ; un PIN oublié fait perdre les saisies non envoyées de ce téléphone.

## 5. Ce qui n'est PAS vérifié

La WebView Android de l'APK ; un téléphone réel ; Safari et Firefox ; le vrai nginx. Voir `docs/reports/LOT-01-RAPPORT.md`, section E. L'état de la production a été lu en lecture seule le 27/10 (migrations, conteneurs, disque) : il se revérifie à l'étape 5 du script.

## 6. Retour arrière

Le script affiche la procédure en cas d'échec d'un contrôle d'après (code d'avant : `tar -xzf <sauvegardes>/code-avant.tar.gz -C /opt/console-bdri`). Chaque migration a sa descente dans `backend/prisma/descentes/` (`20261027100000_medias_observation_analyse.sql` refuse de s'exécuter si une photo d'observation porte une analyse, `20261027110000_composante_rci_valeurs.sql` refuse si une composante porte l'une des deux valeurs ajoutées).

## 7. Ce déploiement ne contient pas la branche d'intégration

`integration/depuis-vendredi` (Observation de la Terre, Aide à la décision, lots 17 et 18, tabulation des cartes) est une autre livraison, avec 14 migrations en attente et son propre réglage du script. Elle n'est pas déployable avec cette procédure.

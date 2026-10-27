# Déploiement de la Console BDRI : pas à pas (commit 0b902e7)

Date : 27/10/2026. Ce document ne déploie rien. Il décrit ce qu'un humain (le DSI) lance, avec les empreintes à vérifier. Le script `infra/deployer-console.sh` refuse de modifier quoi que ce soit avant son étape 9 et s'arrête au premier contrôle qui échoue.

## 1. Ce qu'on déploie

| Élément | Valeur |
|---|---|
| Commit | `0b902e77e927acffc606a549693e204f3686bd62` (branche `lot/03-map-matching`) |
| Archive | `bdri-0b902e7.tar.gz`, 5 005 703 octets, produite par `git archive` (reproductible) |
| SHA-256 de l'archive | `e221165746cfdf18ba1ba73ed12fcd7f2bdee5c1973acf0c7f0a5795cf3bb60e` |
| Serveur applicatif | celui vers lequel pointe `carte.ageroute.gov.gn` (résolution DNS du 27/10 : 102.211.199.131, alias SSH `gec`) |
| Migrations apportées depuis le dernier déploiement consigné | à lire sur le serveur (étape 5 du script) ; le script attend `ATTENDUES_EN_ATTENTE=2` (migrations `20261027100000` et `20261027110000`) : s'il en trouve un autre nombre, il s'arrête sans rien modifier |

## 2. Commandes (depuis le poste du DSI, puis sur le serveur)

Copier l'archive (elle est aussi dans `Téléchargements`) :

```bash
scp bdri-0b902e7.tar.gz gec:/tmp/
```

Sur le serveur, dans `/opt/console-bdri` :

```bash
cd /opt/console-bdri
sha256sum /tmp/bdri-0b902e7.tar.gz     # doit afficher e221165746cfdf18ba1ba73ed12fcd7f2bdee5c1973acf0c7f0a5795cf3bb60e
tar -xzf /tmp/bdri-0b902e7.tar.gz --strip-components=1 bdri-0b902e7/infra/deployer-console.sh
sudo bash infra/deployer-console.sh 0b902e77e927acffc606a549693e204f3686bd62 e221165746cfdf18ba1ba73ed12fcd7f2bdee5c1973acf0c7f0a5795cf3bb60e /tmp/bdri-0b902e7.tar.gz
```

On lance le script **extrait de l'archive**, pas l'ancien du serveur : seul celui-ci attend le bon nombre de migrations.

## 3. Ce que le script contrôle avant d'écrire quoi que ce soit

Projet Compose `console-bdri`, sauvegarde du jour et sa restaurabilité (`pg_restore -l`), espace disque supérieur à 15 %, compteurs de référence, historique des migrations (aucune inachevée, aucune orpheline, exactement 2 en attente), une descente pour chaque migration en attente, absence d'index déjà présents, empreintes des `.env`, archive vérifiée, migrations essayées sur une copie restaurée. Puis **une confirmation humaine** (étape 9) : c'est à ce moment que le DSI décide. Après : compteurs, santé, audit, réponse 401 des routes protégées, `.env` inchangés. Aucun retour arrière automatique : la procédure s'affiche, la décision reste humaine.

## 4. Avant de confirmer l'étape 9

- Comparer `docker-compose.yml` de l'archive à celui du serveur : cette version monte le dossier `./mobile` dans le backend (l'APK est servi derrière l'authentification, plus par nginx) et `nginx.conf` ajoute `Cache-Control: no-cache` pour `sw.js`, `sw-policy.js`, `precache-manifest.json` et `manifest.webmanifest`.
- Variables facultatives (valeurs par défaut en place) : `EVENEMENTS_LOCAUX_MAX_PAR_JOUR`, `MOBILE_DIR`.
- Prévenir les agents de terrain : les écrans de saisie exigent désormais un **code PIN**, créé à la première connexion ; un PIN oublié fait perdre les saisies non envoyées de ce téléphone.

## 5. Ce qui n'est PAS vérifié

La production (état réel des migrations, des sauvegardes, des variables d'environnement) ; la WebView Android de l'APK ; un téléphone réel ; Safari et Firefox ; le vrai nginx. Voir `docs/reports/LOT-01-RAPPORT.md`, section E.

## 6. Retour arrière

Le script affiche la procédure en cas d'échec d'un contrôle d'après (code d'avant : `tar -xzf <sauvegardes>/code-avant.tar.gz -C /opt/console-bdri`). Chaque migration a sa descente dans `backend/prisma/descentes/` (`20261027100000_medias_observation_analyse.sql` refuse de s'exécuter si une photo d'observation porte une analyse, `20261027110000_composante_rci_valeurs.sql` refuse si une composante porte l'une des deux valeurs ajoutées).

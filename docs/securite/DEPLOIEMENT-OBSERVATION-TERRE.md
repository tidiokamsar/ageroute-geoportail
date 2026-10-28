# Déploiement de la Console BDRI avec Observation de la Terre : pas à pas

Date : 28/10/2026. Ce document ne déploie rien. Il décrit ce qu'un humain (le DSI) lance sur le serveur. Le script `infra/deployer-console.sh` ne modifie rien avant son étape 9 et s'arrête au premier contrôle qui échoue. Il remplace, pour cette livraison, `DEPLOIEMENT-PAS-A-PAS.md` (commit `747ac38`, déjà déployé le 28/10 d'après le relevé de production ci-dessous).

## 1. Ce qu'on déploie

| Élément | Valeur |
|---|---|
| Branche | `fusion/observation-terre` (Lot 1 + relevés envoyés + Observation de la Terre) |
| Commit | voir `COMMIT.txt` remis avec l'archive (le commit qui contient ce fichier ne peut pas se citer lui-même) |
| Archive | `bdri-<7 premiers caractères>.tar.gz`, produite par `git archive` (reproductible) |
| Serveur | celui de `carte.ageroute.gov.gn`, répertoire `/opt/console-bdri` |
| Migrations apportées | 4, toutes d'Observation de la Terre : `20261028100000_eo_produits_sources`, `20261028110000_eo_propositions_workflow`, `20261028120000_eo_qualite_methodes`, `20261028130000_eo_gardes_journal`. Chacune a une descente dans `backend/prisma/descentes/` |

Relevé de production du 28/10 (lecture seule, fait par une autre session, non revérifié par celle-ci) : 84 migrations appliquées, toutes présentes dans cet arbre (88 au total). Le script attend exactement 4 migrations en attente et s'arrête sans rien modifier si le nombre lu diffère. Dans ce cas, ne pas forcer : relever le nombre réel, corriger `ATTENDUES_EN_ATTENTE` en le lisant.

## 2. Commandes

Depuis le poste du DSI, copier l'archive :

```bash
scp bdri-<commit7>.tar.gz gec:/tmp/
```

Sur le serveur (fichiers de `/opt/console-bdri` appartenant à root, d'où `sudo`) :

```bash
cd /opt/console-bdri
sha256sum /tmp/bdri-<commit7>.tar.gz      # doit afficher l'empreinte de COMMIT.txt
sudo tar -xzf /tmp/bdri-<commit7>.tar.gz --strip-components=1 bdri-<commit7>/infra/deployer-console.sh
sudo bash infra/deployer-console.sh <commit-complet> <sha256-de-l-archive> /tmp/bdri-<commit7>.tar.gz
```

On lance le script extrait de l'archive, pas l'ancien : seul celui-ci attend les 4 migrations. Autre emplacement de sauvegardes : `sudo RACINE_SAUVEGARDES=/chemin bash infra/deployer-console.sh ...`.

## 3. Ce que le script contrôle avant d'écrire

Projet Compose `console-bdri`, sauvegarde du jour et sa restaurabilité, disque libre supérieur à 15 %, compteurs de référence, historique des migrations (aucune inachevée, aucune orpheline, exactement 4 en attente), une descente par migration, empreintes des `.env`, archive vérifiée, migrations essayées sur une copie restaurée. Puis la confirmation humaine (étape 9, on tape `DEPLOYER`). Après : compteurs, santé, audit, 401 des routes protégées, `.env` inchangés. Aucun retour arrière automatique.

## 4. Après le déploiement : ce que voit l'utilisateur

- Le module Observation de la Terre n'apparaît que pour ADMIN. La clé de module `teledetection` n'est attribuée à aucun profil : un administrateur doit l'attribuer aux profils voulus.
- Le registre est vide : aucune source configurée, aucune proposition, aucune image. Les indicateurs affichent 0 ou « non renseigné », jamais de valeur inventée. Rien n'est détecté automatiquement : il n'existe aucun moteur de traitement d'image.
- Les sources Copernicus ou autres ne passent « active » qu'après configuration et essai réel ; l'accès sortant du serveur vers ces services n'a pas été vérifié.
- La CSP de nginx n'autorise pas Esri ni unpkg (défaut existant) : les aperçus d'images externes peuvent être bloqués par le navigateur.

## 5. Ce qui n'est PAS vérifié

La production (hors relevé du 28/10) ; la WebView Android ; un téléphone réel ; Safari et Firefox ; le vrai nginx ; la suite backend complète après le dernier commit de fusion (958 tests ciblés réussis). Preuves exécutées en local : bancs PostGIS (eo-api 93/93, eo-workflow 163/163, teledetection 10/10, descentes 314 vérifications), harnais de bout en bout `e2e-eo` 48/48. Voir `docs/reports/EARTH_OBSERVATION_LOT_01.md`.

## 6. Retour arrière

Le script affiche la procédure : code d'avant dans `<sauvegardes>/code-avant.tar.gz`, images `console-bdri-*:avant-<horodatage>`, sauvegarde de base. Les descentes des 4 migrations sont dans `backend/prisma/descentes/`. Elles retirent les tables, colonnes, contraintes et déclencheurs ajoutés (la table `earth_observation_products` existait déjà : seules ses colonnes ajoutées sont retirées) et refusent de s'exécuter (`DESCENTE REFUSEE`) si des données du module existent. Ne pas contourner ce refus sans sauvegarde vérifiée.

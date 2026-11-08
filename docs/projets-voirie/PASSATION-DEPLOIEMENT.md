# Passation du déploiement du module « Projets de voirie et réseaux » (vague 1)

Document pour la personne ou l'outil qui exécute le déploiement. Les valeurs propres à un déploiement (identifiant de commit complet, empreinte de l'archive) sont fournies à part par le coordinateur ; aucune adresse, aucun mot de passe, aucun jeton ne figure ici ni ne doit être ajouté.

## Ce que le déploiement apporte

Le module « Projets de voirie et réseaux » (clé de module `projets-voirie`, routes `/api/v2/projets-voirie`) : socle, dossiers de conflit, import (KMZ, CSV/TSV/TXT, GPX, choix du CRS, assistant en 7 étapes), réseaux physiques et circuits logiques, workflow concessionnaire. **Aucune donnée existante n'est modifiée.** Le conteneur GDAL n'est pas déployé. Rien n'est envoyé aux concessionnaires par l'application. Aucun conflit ne déclenche de déplacement.

## État de la production relevé en lecture seule le 08/11/2026

94 migrations terminées, 0 orpheline, module absent. Cinq migrations en attente, toutes additives avec descente, dans cet ordre : `20261030100000_projets_voirie_reseaux`, `20261031100000_conflits_projets_voirie`, `20261101100000_import_formats_versions`, `20261101200000_reseaux_physiques_logiques`, `20261101300000_workflow_roles_recolement`. Le script `infra/deployer-console.sh` est réglé à `ATTENDUES_EN_ATTENTE=5` et refuse tout autre nombre : si la production a changé depuis, **il s'arrête sans rien modifier**. Ne pas contourner : réaligner la constante après relevé.

## Règles

1. Le déploiement se fait avec `infra/deployer-console.sh <commit-complet> <sha256-archive> <archive>`, lancé depuis `/opt/console-bdri`, avec `sudo` (des fichiers y appartiennent à root). L'archive est produite par `git archive` avec le préfixe `bdri-<commit court>/` ; son empreinte est exigée.
2. **Étape 9 : confirmation humaine `DEPLOYER` (majuscules).** Elle porte l'attestation du responsable (conditions GLPI : serveur de rebond corrigé, cause de l'arrêt de sshd établie, secrets renouvelés). Elle doit être saisie par ce responsable. Un outil ne doit ni la saisir à sa place ni la contourner.
3. Les migrations passent **avant** le code (le script le fait). Un code déployé avant la migration `20261101300000` fait échouer tout le module pour les comptes non administrateurs (échec fermé).
4. Aucun retour arrière automatique : après l'étape 9, un échec d'un contrôle d'après arrête le script ; la procédure de retour est affichée par le script (sauvegarde du jour, code d'avant). Pour retirer le workflow par une descente, retirer d'abord la clé de module `projets-voirie` aux comptes référents.
5. Un contrôle des compteurs peut donner une fausse alerte si `audit_logs` reçoit des écritures pendant le déploiement : relancer à un moment calme avant de conclure à un défaut.
6. Ne jamais lancer `docker volume prune`. Si l'espace disque est juste : `docker builder prune` seulement.

## Contrôles après déploiement (lecture seule)

- `_prisma_migrations` : 99 terminées, 0 inachevée active.
- `GET /api/v2/projets-voirie` sans jeton : **401** (et non 404).
- `GET /health` (ou la route de santé existante) : OK ; compteurs de référence inchangés (tronçons, ouvrages, valeurs de qualité, utilisateurs).
- Se connecter avec un compte ADMIN : l'entrée « Projets de voirie » apparaît ; la liste des projets est vide ; aucune erreur dans les journaux du backend.

## Ensuite (hors déploiement, par le DSI)

- Accorder la clé de module `projets-voirie` aux profils concernés.
- Rattacher les éventuels comptes référents concessionnaires (administrateur seulement, via l'API du workflow : l'interface correspondante n'est pas livrée).
- Les décisions en attente (voir `docs/reports/ETAT-GLOBAL-PROJET.md`, section du 08/11/2026) peuvent changer des réglages sans migration.

Pas à pas détaillé des migrations, descentes et vérifications : `DEPLOIEMENT-MODULE.md`.

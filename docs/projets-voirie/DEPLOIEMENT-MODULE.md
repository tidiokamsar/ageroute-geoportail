# Module « Projets de voirie et réseaux » : pas-à-pas de déploiement des migrations

Ce document dit dans quel ordre appliquer, vérifier et, si besoin, défaire les migrations du module, et pourquoi l'ordre compte. Il ne contient ni adresse de serveur, ni identifiant, ni secret. Il ne remplace pas le script de déploiement de la Console (`infra/deployer-console.sh`), qui relève l'état exact de la production avant tout geste (`AGENTS.md`, règle 5 : **aucun déploiement depuis ce dépôt sans validation humaine explicite**). Rien dans ce document n'a été exécuté sur une base de production.

## 1. Les migrations du module, dans l'ordre

Ordre d'application = ordre des horodatages (c'est celui de `prisma migrate deploy`). Descente = script de `backend/prisma/descentes/`, du même nom.

| Ordre | Migration | Lot | Ce qu'elle crée | Ce que perd sa descente (si les tables portent des lignes) |
|---|---|---|---|---|
| 1 | `20261030100000_projets_voirie_reseaux` | socle | `projets_voirie`, `concessionnaires_reseau`, `projets_voirie_jeux`, `projets_voirie_objets` | tout le module : projets, jeux et objets (données confidentielles) |
| 2 | `20261031100000_conflits_projets_voirie` | RC-3 | règles, analyses persistées, dossiers de conflit, historique, preuves, décisions ; la règle par défaut `RC-2D-0.1` (version 0) | règles saisies, analyses, dossiers, décisions humaines |
| 3 | `20261101100000_import_formats_versions` | A1 | trois valeurs `KMZ`, `GPX`, `CSV` du type `FormatJeuProjet` ; `projets_voirie_import_evenements` ; `projets_voirie_fichiers_origine` | événements de revue et de retour arrière, fichiers d'origine conservés ; **refuse sans dérogation** si un jeu porte l'un des trois formats |
| 4 | `20261101200000_reseaux_physiques_logiques` | B1 | `reseau_objets_descripteurs`, `reseau_relations` | descripteurs et relations (décisions humaines) |
| 5 | `20261101300000_workflow_roles_recolement` | B3 | `referents_concessionnaire`, `demandes_concessionnaire`, `taches_projet_voirie`, `recolements_projet_voirie`, `preuves_workflow_projet`, `workflow_projet_historique` | **les rattachements des référents** (voir 4), demandes, tâches, récolements, preuves, historique |

Toutes sont additives et idempotentes. La livraison de correction de la vague 1 (branche `feat/vague1-corrections`) **n'ajoute aucune migration et ne touche pas `schema.prisma`** : le client Prisma est inchangé.

## 2. Règle d'ordre : les migrations AVANT le code (O10)

**Appliquer les cinq migrations, dans l'ordre, avant de démarrer la version du code qui les utilise.** L'inverse échoue, et pas toujours de la façon attendue :

- Code déployé **avant** la migration 5 : la garde du référent (`gardeReferent`, montée sur tout le routeur du module) lit `referents_concessionnaire` à chaque requête d'un compte non `ADMIN`. La table absente donne une erreur de base, donc un **500 sur tout le module pour tous les comptes non `ADMIN`** (échec fermé : aucune donnée n'est exposée, mais le module est inutilisable). Le même défaut touche, pour un compte qui porte la clé `projets-voirie`, `GET /api/audit` sur les types du module et `GET /api/dashboard/activity` (ce dernier appelle la même lecture, correction m5).
- Code déployé **avant** la migration 4 : les routes `/:id/reseau/...`, le comptage et la qualification de la cible des dossiers de conflit échouent (tables absentes ; déduit de la lecture du code, non essayé sur une base).
- Code déployé **avant** la migration 3 : le dépôt d'un fichier KMZ, GPX ou CSV échoue (la valeur d'énumération n'existe pas) ; la revue des suppressions et le retour arrière échouent (table absente) (déduit de la lecture du code, non essayé sur une base).
- Code retiré (retour à l'ancienne version) **sans** avoir défait les migrations : sans effet néfaste, les tables restent inutilisées (les migrations sont additives).

## 3. Pas-à-pas

1. **Relever l'état** : migrations appliquées (`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY 1`), migrations inachevées (doit donner 0 ligne), sauvegarde de la base prise et sa restauration essayée ailleurs. Le script de déploiement fait ce relevé ; ne pas y déroger.
2. **Vérifier que chaque migration du lot a sa descente** (`backend/prisma/descentes/<migration>.sql`), comme le fait le script de déploiement.
3. **Appliquer les migrations** par l'outil du déploiement (`prisma migrate deploy`), qui les prend dans l'ordre du tableau. Ne jamais utiliser `db push` ni marquer une migration appliquée à la main.
4. **Contrôles après migration, avant d'ouvrir le trafic** (lecture seule) :
   - les cinq lignes figurent dans `_prisma_migrations` avec `finished_at` renseigné ;
   - les tables du tableau existent (`SELECT to_regclass('public.referents_concessionnaire'), to_regclass('public.reseau_relations'), to_regclass('public.projets_voirie_import_evenements')` : aucune valeur nulle) ;
   - `SELECT enum_range(NULL::"FormatJeuProjet")` contient `KMZ`, `GPX` et `CSV` ;
   - la règle par défaut existe : `SELECT count(*) FROM regles_conflit_projet WHERE code = 'RC-2D-0.1' AND version = 0` rend 1 ;
   - aucune ligne n'a changé dans `troncons`, `ouvrages`, `chantiers` (comptes avant et après).
5. **Démarrer le code**, puis contrôler avec un compte `ADMIN`, un compte `GESTIONNAIRE` de périmètre et un compte `LECTEUR` : liste des projets (200), `GET /api/v2/projets-voirie/:id/import/options` (200, `ADMIN` et `GESTIONNAIRE`), `GET /api/v2/projets-voirie/workflow/mon-profil` (200), `GET /api/dashboard/activity` (200). Un 500 sur l'un de ces appels pour un compte non `ADMIN` signale presque toujours une migration manquante (voir 2).
6. **Réglages serveur** : les variables `PROJETS_VOIRIE_*` ont des valeurs par défaut documentées (`CONTRAT-IMPORT.md`, section 12, avec `PROJETS_VOIRIE_CSV_CELLULES_MAX` ajoutée par la correction O5 ; `CONTRAT-WORKFLOW.md`, section 9). Aucune n'est requise ; `PROJETS_VOIRIE_CONSERVER_ORIGINAL` reste à `non` tant que la rétention du fichier d'origine n'est pas décidée.

## 4. Descentes (retour arrière), ordre inverse

À ne faire qu'après décision humaine, sauvegarde vérifiée et **retrait du code qui lit les tables** (sinon le module répond 500 pendant et après la descente).

Ordre : `20261101300000`, puis `20261101200000`, puis `20261101100000`, puis `20261031100000`, puis `20261030100000`. Chaque descente s'exécute dans une seule transaction (`psql -v ON_ERROR_STOP=1 -1 -f backend/prisma/descentes/<migration>.sql`), refuse de s'exécuter si ses tables portent des lignes (`DESCENTE REFUSEE`, avec le nombre), et ne passe outre que sous `SET LOCAL bdri.perte_autorisee = 'OUI'` dans la même transaction, après sauvegarde. Après chaque descente réussie, retirer la ligne de `_prisma_migrations` (la commande est en bas du fichier de descente).

Deux points d'attention propres à ce lot :

- **Avant la descente de `20261101300000` (workflow) : retirer la clé de module `projets-voirie` aux comptes référents** (O10). La descente supprime les rattachements (`referents_concessionnaire`) : un compte `LECTEUR` jusque-là confiné au workflow redeviendrait, avec sa clé de module, un lecteur ordinaire du socle et des dossiers de conflit de tous les projets de son périmètre. Marche à suivre : lister les comptes rattachés actifs (`SELECT DISTINCT "userId" FROM referents_concessionnaire WHERE "revoqueLe" IS NULL`), retirer la clé `projets-voirie` de chacun par l'administration des comptes, vérifier qu'ils n'ouvrent plus le module, puis seulement descendre. La révocation d'un rattachement ne retire pas la clé automatiquement (décision à prendre, `CONTRAT-WORKFLOW.md`, section 10, point 7).
- **Avant la descente de `20261101100000` (formats)** : si un jeu porte le format `KMZ`, `GPX` ou `CSV`, la descente refuse même avec la dérogation (retirer la valeur obligerait à inventer un format de remplacement). Il faut d'abord décider du sort de ces jeux (retrait logique, sans suppression physique) ; aucune conversion automatique n'est prévue.

## 4 bis. Vague 3 : six migrations de plus (branche `feat/vague3-integration`, 10/11/2026)

La vague 3 ajoute au module les lots B2 (GDAL), T1 (territoires, référentiels, configuration), S1 (sources multiples), les correctifs de la revue T1+S1, D1 (documents) et X1 (exports, tableaux de bord). Avec les cinq de la vague 1, **onze migrations du module** sont en attente sur une production restée à 94 migrations (relevé du 08/11/2026 : 105 au total après la vague 3). Le script de déploiement relève l'état exact au moment du geste ; sa constante `ATTENDUES_EN_ATTENTE` doit être réglée sur le nombre réellement relevé, jamais sur ce document.

| Ordre | Migration | Lot | Ce qu'elle crée | Garde de la descente |
|---|---|---|---|---|
| 6 | `20261102200000_import_jobs_gdal` | B2 | valeurs `GPKG`, `SHAPEFILE`, `DXF` du type `FormatJeuProjet` ; `projets_voirie_import_jobs` (machine à états imposée par la base) | refuse si des jobs existent |
| 7 | `20261103100000_territoires_referentiels` | T1 | `territoires_voirie`, `referentiels_voirie`, `configuration_voirie` et leurs historiques ; nation, région Faranah, préfecture et commune de Kissidougou ; rattachement des projets existants ; colonnes `territoireId`, `categorieCode`, `typeReseauCode` | refuse si un administrateur a créé ou modifié un territoire, une valeur ou une configuration |
| 8 | `20261103300000_multi_sources_comparaison` | S1 | `methodeAcquisition` des jeux (index de version recréés), `regles_rapprochement_sources`, `comparaisons_sources_projet` et leurs résultats, relation `CONNECTE_A` | refuse s'il existe des dossiers `DIVERGENCE_SOURCES` ou des relations `CONNECTE_A` (le second refus ne se lève pas : décision métier) |
| 9 | `20261103400000_correctifs_sources_territoires` | correctifs T1+S1 | `conflits_projet.jeuSourceBId` ; méthodes d'acquisition de S1 versées au référentiel ; type de réseau dans la clé de version ; règle système `S1-CORRIDOR-0.2` sans barème, `S1-CORRIDOR-0.1` retirée | refuse si des jeux ne se distinguent que par le type de réseau, ou si des règles et comparaisons postérieures existent ; les valeurs versées au référentiel restent |
| 10 | `20261104100000_completude_documentaire` | D1 | valeur `LANDXML` ; `documents_projet_voirie` et son historique (ajout seul, écrit par la base) | refuse s'il existe des documents ; refuse sans dérogation possible si un jeu est au format `LANDXML` |
| 11 | `20261104200000_exports_tableaux_de_bord` | X1 | `exports_dossier_projet_voirie` (journal des tentatives), `derogations_export_projet_voirie` (séparation des tâches par contrainte) | refuse s'il existe des lignes de journal ou des dérogations |

**Ordre de mise en service (en plus de la règle O10 de la section 2).**
- Les onze migrations s'appliquent avant le code de la vague 3. Le code de la vague 3 lit `territoireId` à chaque lecture de projet : sans la migration 7, tout le module répond 500.
- **L'interface et le backend de la vague 3 partent ensemble** (même commit). Le backend de T1 exige `territoireId` à la création d'un projet (400 `TERRITOIRE_REQUIS`). Seule l'interface du lot UI-C l'envoie : un backend de la vague 3 avec l'interface de la vague 1 rendrait la création de projet impossible.
- GDAL reste désactivé (`PROJETS_VOIRIE_GDAL` absent). La migration 6 n'exige ni le conteneur ni le spool. Les formats GeoPackage, Shapefile et DXF répondent 415 `FORMAT_GDAL_DESACTIVE`, ce qui est normal.

**Contrôles après migration, avant d'ouvrir le trafic (lecture seule), en plus de la section 3.**
- Les onze lignes figurent dans `_prisma_migrations`, avec `finished_at` renseigné.
- `SELECT code, niveau FROM territoires_voirie WHERE "deletedAt" IS NULL AND code LIKE 'GN%' ORDER BY code` rend la nation et la chaîne de Kissidougou.
- `SELECT count(*) FROM projets_voirie WHERE "territoireId" IS NULL AND "deletedAt" IS NULL` rend 0.
- Les rattachements à contrôler (constat m5 de la revue) : `SELECT p.code, t.code FROM projets_voirie p JOIN territoires_voirie t ON t.id = p."territoireId" WHERE t.code = 'NON_RENSEIGNE' OR t.code LIKE 'MIG-%'`. Chaque ligne est à rattacher par l'administration, par `PATCH` du projet.
- `SELECT code, statut FROM regles_rapprochement_sources WHERE code LIKE 'S1-CORRIDOR-%' ORDER BY code` rend `0.1` RETIREE et `0.2` APPROUVEE.
- `SELECT domaine, count(*) FROM referentiels_voirie WHERE "deletedAt" IS NULL GROUP BY 1` : les cinq domaines sont présents.
- Aucune ligne n'a changé dans `troncons`, `ouvrages` et `chantiers`.

**Descentes, ordre inverse** : `20261104200000`, `20261104100000`, `20261103400000`, `20261103300000`, `20261103100000`, `20261102200000`, puis celles de la section 4. Mêmes règles qu'en section 4 : code retiré d'abord, sauvegarde vérifiée, une transaction par descente, ligne de `_prisma_migrations` retirée ensuite. Ce qui est perdu, même avec l'autorisation :
- descente de T1 : le rattachement des projets à leur territoire (`commune` et `prefecture` restent) et les codes de type de réseau (la famille reste) ;
- descente des correctifs : les valeurs versées au référentiel restent, car des jeux les portent et rien n'est supprimé physiquement.

**Sauvegarde.** Tout ce que le module conserve est dans PostgreSQL : jeux, objets, fichiers d'origine (colonne `contenu`, quand la conservation est activée), documents (références et empreintes seulement), journaux. La sauvegarde de la Console (`docs/securite/SAUVEGARDE-RESTAURATION.md`, `pg_dump` complet) le couvre sans réglage particulier. Le spool GDAL n'est pas une donnée : il est transitoire, purgé après consommation, et ne se sauvegarde pas (`CHAINE-GDAL.md`). Après une restauration, refaire les contrôles ci-dessus.

**Nouvelle ville** : par l'administration, sans code ni migration. Voir `GUIDE-NOUVELLE-VILLE.md`.

## 5. Ce qui change pour les utilisateurs après la livraison de correction

Utile au support, aucune action d'exploitation :

- retirer un jeu autorisé pendant qu'une nouvelle version l'attend répond 409 `DEPOT_EN_ATTENTE` : rejeter ou retirer d'abord le dépôt en attente (`CONTRAT-IMPORT.md`, 14.1) ;
- accepter les suppressions d'une version dont la revue a été refusée répond 409 `SUPPRESSIONS_REFUSEES` (14.2) ;
- un 503 `PROJET_OCCUPE` pendant un dépôt ou une proposition d'association est normal : réessayer après quelques secondes (`CONTRAT-WORKFLOW.md`, 9 bis) ;
- un compte qui n'a que la clé `dashboard` ne voit plus, dans le flux d'activité de l'accueil, les lignes d'audit des modules qu'il n'a pas (m5) ;
- le comptage des supports physiques ne compte que les jeux autorisés, pour tous les rôles : le chiffre d'un administrateur peut baisser par rapport à avant (`CONTRAT-RESEAUX.md`, 11.1).

# Sauvegardes et restauration de la Console BDRI

Chantier C2 du Lot 1. Document du 26/10/2026. Outil de preuve locale : `infra/verifier-restauration.sh`.
Sources lues : `infra/backup/*.sh`, `docs/audit-2026/RESTAURATION-BDRI.md`, `docs/phase5/BACKUP-KEY-DECISION.md`,
`docs/audit-2026/PHASE-3-BDRI-FIABILISATION.md`, `docs/bdri-2/BDRI-2-BACKLOG.md`, `SECURITY_REMEDIATION.md` (S-5),
`infra/deployer-console.sh`.

Convention : **"a decider"** signale une valeur qu'aucun document du depot ne fixe. Aucun chiffre n'est invente.

## 1. En bref

- Les scripts de sauvegarde, de verification et de bilan existent et sont soignes. Ce que le depot **ne prouve pas** : que
  la sauvegarde tourne (installation du crontab non prouvee), que la copie hors serveur existe, et que la derniere
  restauration complete date de moins de huit semaines (derniere documentee : 02/09/2026).
- **La cle de chiffrement existe en un seul exemplaire**, sur le serveur sauvegarde (decision P5-13 non prise). Perdre le
  serveur, c'est perdre toutes les sauvegardes, qui existent encore mais ne se dechiffrent plus.
- Un poste local peut maintenant **prouver la chaine complete** (sauvegarde, chiffrement, restauration, comparaison du
  contenu et des geometries) en une commande reproductible : section 4. Cela prouve les **scripts et la methode**, pas
  les sauvegardes de production.
- Aucun RPO ni RTO n'est decide : section 6.
- La liste de ce que seule la DSI peut verifier cote serveur est en section 8.

## 2. Ce qui existe (lu dans le code)

| Element | Fichier | Fait |
|---|---|---|
| Sauvegarde | `infra/backup/sauvegarde-bdri.sh` | `pg_dump -Fc --no-owner --no-acl` de `console_bdri` (conteneur `console-bdri-db-1`, role `bdri_app`) ; archive `tar.gz` du volume `console-bdri_bdri_uploads` ; chiffrement ; manifeste (migrations, comptes de lignes, SHA-256) ; rotation locale ; copie par `scp` vers `HOTE_DISTANT` (variable obligatoire : plus d'adresse en dur). |
| Verification | `infra/backup/verifier-restauration-bdri.sh` | derniere archive : empreinte comparee au manifeste, dechiffrement, restauration dans un conteneur `postgis/postgis:17-3.5` jetable **sans reseau**, controles de contenu (plus de 20 tables, troncons, geometries valides, comptes, cles etrangeres, historique des migrations), comparaison au manifeste. |
| Bilan | `infra/backup/etat-sauvegardes-bdri.sh` | lecture seule : age de la derniere sauvegarde (alerte au-dela de 30 h), chiffrement, copie hors serveur, derniere restauration verifiee (alerte au-dela de 14 jours), coherence base et fichiers. |
| Avant deploiement | `infra/deployer-console.sh` etape 2 et 8c | `pg_dump` du jour, `pg_restore -l` (plus de 50 entrees), puis **restauration complete dans un conteneur jetable** et migrations essayees dessus, avec comparaison de 5 compteurs. C'est la seule restauration reellement exercee a chaque deploiement. |

## 3. Chiffrement et cle

| Question | Reponse etablie par le code ou les documents |
|---|---|
| Algorithme | `openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt`, secret lu dans un fichier (`-pass file:`) : `sauvegarde-bdri.sh:112`, `verifier-restauration-bdri.sh:84`. |
| Ou est la cle | Cherchee dans `/etc/bdri/cle-sauvegarde`, `$HOME/.bdri/cle-sauvegarde`, `$HOME/.config/bdri/cle-sauvegarde` ; en pratique `~/.bdri/cle-sauvegarde` sur le serveur applicatif (`BACKUP-KEY-DECISION.md`, verifie le 02/09/2026 ; **non reverifie depuis**). |
| Combien d'exemplaires | **Un.** Pas de copie sur le serveur de depot (volontaire : la placer a cote des archives annulerait le chiffrement), pas de copie hors site (verifie le 02/09/2026). |
| Consequence | La perte du serveur applicatif (disque, incendie, ransomware, erreur) rend toutes les archives du depot indechiffrables. "Un chiffrement sans plan de continuite de la cle n'est pas une sauvegarde, c'est une destruction differee." |
| Decision | **Non prise.** `BACKUP-KEY-DECISION.md` presente quatre options (A coffre physique, B coffre numerique partage, C copie rechiffree GPG, D mecanisme institutionnel) et **recommande A + D** avec deux detenteurs nommes. Statut du document : decision "REQUIRES_BUSINESS_VALIDATION". |
| Si pas de cle | Le script **continue** : il archive en clair, interdit la copie hors serveur et ecrit une alerte dans son journal (`sauvegarde-bdri.sh:119-127`). Les archives en clair restent sur le serveur jusqu'a la rotation (14 jours). |

Observations de ce chantier (a decider, rien n'est modifie) :

1. **Pas de chiffrement authentifie.** AES-CBC avec PBKDF2 ne protege pas l'integrite : une archive modifiee peut se
   dechiffrer en donnees alterees. La parade actuelle est le SHA-256 du manifeste, mais le manifeste est **a cote** des
   archives, sur les memes supports : qui peut ecrire l'un peut ecrire l'autre. Option : chiffrement authentifie (age, GPG)
   ou signature du manifeste. A decider.
2. **Archive en clair conservee 14 jours** si la cle manque : exposition de donnees personnelles (comptes, courriels, noms)
   plutot qu'echec de la sauvegarde. A decider : refuser plutot que continuer en clair.
3. **Reproductibilite du dechiffrement** : la commande exige les memes options (`-pbkdf2 -iter 200000`) ; elles figurent
   dans `RESTAURATION-BDRI.md`. Verifie ici avec OpenSSL 3.5.9 : dechiffrement identique au clair (SHA-256 egal) et
   **echec avec une mauvaise cle** (section 4).
4. **L'alerte n'est qu'une ligne de journal.** `alerter()` (`sauvegarde-bdri.sh:60`) appelle `tracer`. Personne n'est
   prevenu par ce script ; `BACKUP-KEY-DECISION.md` recommande un courriel hebdomadaire du bilan, non constate.

## 4. Preuve de restauration reproductible, en local

### 4.1 Pourquoi un script de plus, et pourquoi en bash

`verifier-restauration-bdri.sh` tourne sur le serveur sur la derniere archive reelle. Il compare des comptes, pas le
contenu, et traite `pg_restore` en echec comme un avertissement (`:143`). Le nouveau script comble ce qui se prouve sans
serveur : la comparaison de **contenu** et de **geometries**, avec une source connue. Choix **bash** : comme le reste de
`infra/`, memes outils que la sauvegarde (`pg_dump`, `openssl`, `pg_restore`), utilisable sur le serveur, en WSL ou en Git
Bash. Un `.ps1` ne tournerait que sous Windows.

### 4.2 Ce qu'il fait

```bash
bash infra/verifier-restauration.sh                  # preuve nominale
bash infra/verifier-restauration.sh --contre-epreuve # altere la restauration et exige que la comparaison le voie
bash infra/verifier-restauration.sh --garder         # garde les deux bases et le repertoire temporaire pour examen
bash infra/verifier-restauration.sh --lignes 20000   # volume du jeu synthetique (defaut 2000 troncons)
```

0. **Garde** : le conteneur (`bdri-dev-db`) doit tourner et publier son port **uniquement** sur `127.0.0.1` / `[::1]` ;
   les seules bases touchees sont `essai_source_restauration` et `essai_restauration`.
1. **Source** : clone de `replay` (schema complet des migrations) rempli d'un jeu **synthetique deterministe** : 2 000
   troncons (1 900 avec geometrie, 100 `NULL`), 400 ouvrages (points et lignes), 100 chantiers, 10 multipolygones
   `limites_admin`, 300 audits, accents et caracteres hors ASCII. Aucune donnee reelle, aucun secret (le "hachage" de mot
   de passe est une chaine factice).
2. **Sauvegarde** : `pg_dump -Fc --no-owner --no-acl`, memes options que la production, puis `pg_restore --list`.
3. **Chiffrement** : aller-retour AES-256-CBC pbkdf2 200000 avec une cle **temporaire tiree au hasard** (jamais la cle de
   production), SHA-256 avant et apres, et **contre-epreuve** : une mauvaise cle ne redonne pas le dump.
4. **Restauration** dans `essai_restauration`, creee depuis `template0` : PostGIS est recree **par le dump**, comme sur un
   serveur neuf. `pg_restore --exit-on-error` : la moindre erreur arrete le script.
5. **Comparaison source contre restauration** : (a) schema complet (`instantane-schema.sql` : 2 275 objets) ; (b) pour
   **chacune des 83 tables** : nombre de lignes et MD5 de toutes les lignes (geometrie en EWKB comprise) ; (c) pour
   **chacune des 24 colonnes geometry** : lignes renseignees, SRID, validite, nombre de sommets, etendue, MD5 des octets
   EWKB ; (d) sequences ; (e) contraintes validees, declencheurs actifs ; (f) index GiST utilisable : meme nombre de
   resultats avec et sans l'index.
6. **Nettoyage** (piege `EXIT`) : les deux bases, le dump, sa version chiffree et la cle (ecrasee par `shred`) sont
   supprimes quoi qu'il arrive.

### 4.3 Resultats reels (poste local, 26/10/2026, jeu synthetique de 2 000 troncons)

Execution nominale, code 0 :

| Controle | Resultat |
|---|---|
| Source | 2 000 troncons (1 900 avec geometrie), 400 ouvrages, 100 chantiers, 10 limites, 300 audits |
| Archive | environ 566 000 octets (varie legerement d'une execution a l'autre), 858 entrees lues par `pg_restore --list` |
| Chiffrement | dump identique avant chiffrement et apres dechiffrement (SHA-256 egal) ; mauvaise cle : pas de dump |
| Restauration | sans erreur (`--exit-on-error`) |
| 83 tables | lignes **et** sommes de controle identiques |
| 24 colonnes geometry | identiques. Ex. `troncons.geom` : 1 900 renseignees, SRID 4326, 0 invalide, 5 700 sommets ; `ouvrages.geom` : 400 ; `limites_admin.geom` : 10 multipolygones, 50 sommets |
| Schema | 2 275 objets identiques, sauf **2 CHECK dont le texte est re-parenthese** par PostgreSQL au rechargement |
| Index GiST des troncons | 861 resultats avec l'index, 861 sans ; le plan utilise bien un index |

**Les 2 CHECK** (`matrices_degradation.matrice_probabilites_bornees`, `plans_pluriannuels.ppe_horizon_borne`) : `pg_dump`
ecrit `(((a AND b) AND (c AND d)))`, `pg_restore` relit et PostgreSQL re-associe en `((a AND b AND (c AND d)))`. Ce n'est
pas une perte, mais le script ne l'admet pas sur la foi d'une regle de parentheses : il le **prouve**. Le texte de la
source est relu par PostgreSQL sur la base restauree (contrainte d'essai ajoutee puis retiree dans une transaction
annulee) et doit redonner **exactement** le texte restaure. Toute autre difference de schema, ou un CHECK dont la relecture
ne concorde pas, fait echouer le script.

**Contre-epreuve** (`--contre-epreuve`, code 0 = reussie) : apres restauration, la geometrie du troncon `t7` est decalee de
0,000001 degre et la ligne `o5` de `ouvrages` supprimee. La comparaison signale la difference d'empreinte des tables
`troncons` et `ouvrages` **et** celle de `troncons.geom`; le script conclut "CONTRE-EPREUVE REUSSIE". Un decalage de 0,1
metre environ est donc vu.

Durees mesurees : sauvegarde 1,1 a 6,0 s, restauration 3,3 a 26,9 s selon la charge de la machine. **Ce ne sont pas des
mesures de RTO** : jeu synthetique de 2 000 troncons, machine partagee, base vide de tout autre usage.

### 4.4 Ce que ce script ne prouve pas

- Que les sauvegardes de **production** existent, sont chiffrees avec la bonne cle ou se restaurent.
- Le temps de restauration a 261 387 troncons et au volume de production.
- Les fichiers televerses (documents, photos) : le script ne couvre que la base. Leur archive est seulement testee en
  lecture par `verifier-restauration-bdri.sh`.
- La remise en service complete d'un serveur vierge (`RESTAURATION-BDRI.md` 3.3 a 3.6, "jamais executees de bout en bout").
- La copie hors serveur (`scp`), le crontab, la rotation.
- Un incident reel : corruption silencieuse, disque plein pendant le dump, versions differentes de PostgreSQL ou de PostGIS
  entre production et poste (ici PostgreSQL 17.5, PostGIS 3.5.2).

## 5. Retention, frequence, tests periodiques

| Element | Valeur etablie | Source | Remarque |
|---|---|---|---|
| Frequence de la sauvegarde | quotidienne, 3 h | crontab propose dans `PHASE-3-BDRI-FIABILISATION.md` §5 | **Installation non prouvee** (LOT-00 E10 ; "propose", "a valider"). |
| Verification de restauration automatique | hebdomadaire, dimanche 4 h | idem | idem. Elle teste la **derniere** archive seulement. |
| Retention locale | 14 jours | `RETENTION_JOURS` defaut 14, `sauvegarde-bdri.sh:21,163-165` | Appliquee sur le serveur seulement. |
| Retention sur le serveur de depot | **contradictoire** | `BACKUP-KEY-DECISION.md` : "retention 14 jours" ; `RESTAURATION-BDRI.md` : "selon la politique du serveur distant" | Le script n'applique **aucune rotation distante** (`find` ne s'applique qu'au repertoire local). A verifier (section 8). A decider : retention cible. |
| Retention longue (mensuelle, annuelle) | aucune | - | A decider. |
| Test de restauration periodique | recommande : trimestriel consigne (`BACKUP-KEY-DECISION.md` §4) ; exercice complet annuel (`RESTAURATION-BDRI.md` §6) | recommandations | **Aucun exercice complet documente apres le 02/09/2026.** A decider : calendrier et responsable. |
| Restauration exercee a chaque deploiement | oui, 8c de `deployer-console.sh` | code | Deploiements consignes : 21/10 et 22/10/2026. |

## 6. RPO et RTO

| Indicateur | Etat | Ce qu'on peut dire sans l'inventer |
|---|---|---|
| RPO (perte de donnees maximale tolerable) | **a decider** | Aucun document ne le fixe. **Borne observable, pas un objectif** : si le crontab quotidien est installe, la perte maximale subie serait d'environ la periode entre deux sauvegardes (24 h), et `etat-sauvegardes-bdri.sh` alerte au-dela de 30 h. Cette borne n'est valable que si la sauvegarde tourne reellement. |
| RTO (duree maximale d'indisponibilite tolerable) | **a decider** | Aucun document ne le fixe et **aucune mesure de restauration de production** n'est consignee. Les durees de la section 4.3 ne sont pas representatives. La mesure se fait en section 8, point 9. |
| Destination hors site | a decider | `HOTE_DISTANT` : un second serveur. Pas de copie hors du perimetre AGEROUTE documentee. |

## 7. Ce que les sauvegardes ne couvrent pas (rappel de `RESTAURATION-BDRI.md` §4)

`backend/.env` (jamais sauvegarde, delibere : a recreer depuis `.env.example`, valeurs aupres du responsable infrastructure),
certificats TLS (Traefik), configuration Traefik, journaux applicatifs. Les secrets de production doivent donc avoir leur
**propre** sauvegarde : a decider. Le plan de reprise suppose qu'ils sont disponibles.

## 8. Checklist DSI : ce que seule la DSI peut verifier cote serveur

A executer depuis le compte de service, en **lecture seule** sauf mention contraire. Consigner pour chaque ligne la date,
la commande, le resultat. Rien de ceci n'a ete lance depuis ce depot. Ne jamais afficher le contenu de la cle.

| # | Verification | Commande ou geste | Resultat attendu |
|---|---|---|---|
| 1 | Le crontab est installe | `crontab -l` (compte de service) et `grep -i bdri /etc/cron.d/* 2>/dev/null` | les deux lignes de `PHASE-3` §5 (3 h quotidien, 4 h le dimanche), ou une minuterie equivalente |
| 2 | Bilan global | `bash ~/bdri-infra/backup/etat-sauvegardes-bdri.sh` | "Sauvegardes en bon etat" ; sinon, copier la sortie |
| 3 | Les sauvegardes sont chiffrees | `ls -l ~/sauvegardes-bdri/` | fichiers `bdri_*.dump.enc` et `uploads_*.tar.gz.enc`, aucun `*.dump` en clair |
| 4 | Combien d'archives, depuis quand | `ls -l --time-style=long-iso ~/sauvegardes-bdri/ \| head -40` | une par jour sur la retention voulue, pas de trou |
| 5 | Les archives existent aussi sur le serveur de depot | `ssh <depot> 'ls -l --time-style=long-iso ~/ageroute-depots/bdri-sauvegardes/ \| tail -20; df -h ~'` | memes horodatages que le point 4 ; espace libre suffisant |
| 6 | Retention reellement appliquee sur le depot | meme listing : la plus ancienne archive, et le nombre | coherent avec la retention decidee (aujourd'hui : contradictoire) |
| 7 | Le fichier de cle : presence, droits, empreinte | `stat -c '%a %U %s' ~/.bdri/cle-sauvegarde ; sha256sum ~/.bdri/cle-sauvegarde` | droits `600`, proprietaire du compte de service ; noter l'**empreinte** (jamais la cle) |
| 8 | **Existe-t-il une 2e copie de la cle ?** | comparer l'empreinte du point 7 a celle de la copie sequestre, calculee **hors du serveur** | empreintes egales ; sinon, risque majeur P5-13 toujours ouvert |
| 9 | **Restauration depuis la seule copie de la cle, sur une autre machine** | copier une archive du depot et la cle sequestre sur un poste, `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in bdri_<h>.dump.enc -out bdri.dump -pass file:<cle>` puis restaurer dans une base PostGIS jetable (voir `RESTAURATION-BDRI.md` 3.4) en **chronometrant** | restauration reussie : c'est le premier chiffre de RTO reel, et la preuve que la cle de secours marche |
| 10 | Derniere verification hebdomadaire | `grep 'Restauration VERIFIEE' ~/sauvegardes-bdri/verification-restauration.log \| tail -3` | une ligne datee de moins de 8 jours ; sinon `etat-sauvegardes` l'a signale |
| 11 | Ce que verifie la production est coherent avec la sauvegarde | comparer `manifeste_<h>.txt` (comptes, migrations) a `psql -tAc "SELECT count(*) FROM troncons"` du jour | ecart explique par l'activite depuis la sauvegarde |
| 12 | Les fichiers televerses | taille et nombre de l'archive `uploads_*` contre `docker run --rm -v console-bdri_bdri_uploads:/s:ro alpine sh -c 'find /s -type f \| wc -l'` | nombres coherents |
| 13 | Qui est prevenu en cas d'echec | consulter la destination des alertes (le script n'ecrit que dans son journal) | un humain nomme recoit le bilan, par un canal qui ne depend pas du serveur sauvegarde |
| 14 | Compatibilite des versions | `docker compose exec -T db psql -U bdri_app -d console_bdri -tAc "select version(), postgis_full_version()"` | memes versions majeures que l'image de verification `postgis/postgis:17-3.5` |
| 15 | Sauvegarde des secrets d'exploitation | demander ou sont les `.env` et la configuration Traefik sauvegardes | un emplacement distinct des archives, avec son propre sequestre |
| 16 | Les archives ne contiennent pas de secret | `tar tzf` de l'archive des televersements deja dechiffree : pas de `.env`, pas de cle | aucun |

## 9. Decisions necessaires

1. **Cle de chiffrement** : option retenue parmi A, B, C, D de `BACKUP-KEY-DECISION.md` (recommandation : A + D), deux
   detenteurs nommes, date limite. Tant qu'elle manque, tout le reste est une illusion de securite.
2. **RPO, RTO, retention** (locale, depot, longue duree), destination hors site.
3. **Chiffrement authentifie ou signature du manifeste**, et **refus d'archiver en clair** quand la cle manque.
4. **Calendrier de l'exercice complet** (trimestriel pour la restauration, annuel pour la remise en service) et
   responsable.
5. **Destinataire des alertes** et canal.
6. **Sauvegarde des secrets** (`.env`, Traefik).

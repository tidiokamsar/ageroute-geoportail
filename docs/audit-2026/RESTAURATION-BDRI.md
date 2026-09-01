# Restaurer la Console BDRI

Procédure de récupération après perte du serveur. À conserver **hors du serveur**
qu'elle permet de restaurer.

---

## 1. Le point à traiter en priorité — la clé de chiffrement

Les sauvegardes sont chiffrées en AES-256-CBC. Sans la clé, **elles ne valent rien**.

La clé se trouve sur le serveur `gec` :

```
/home/agergec/.bdri/cle-sauvegarde     droits 600, propriétaire agergec
```

**Elle n'est copiée nulle part ailleurs.** C'est délibéré pour la copie distante — la
placer à côté des archives qu'elle protège annulerait le chiffrement — mais cela crée
une faille tant qu'aucune copie n'existe sous une autre forme :

> **Si le serveur `gec` est détruit aujourd'hui, les archives déposées sur
> `102.211.199.132` sont irrécupérables.**

### Ce qu'il faut faire

Récupérer la clé et la conserver hors ligne. La commande, à exécuter par une personne
habilitée :

```bash
ssh gec "cat ~/.bdri/cle-sauvegarde"
```

Puis la déposer dans **au moins deux** des emplacements suivants, jamais sur `gec` :

- un gestionnaire de mots de passe d'entreprise ;
- un coffre physique, imprimée, sous pli scellé ;
- le poste d'un second responsable désigné.

**À décider par AGEROUTE** : qui détient une copie, sous quelle forme, et qui peut y
accéder en cas d'absence. Ce n'est pas une question technique.

**Ne jamais** faire transiter la clé par courriel, messagerie instantanée, ni ticket.

---

## 2. Où se trouvent les sauvegardes

| Emplacement | Contenu | Rétention |
|---|---|---|
| `gec:~/sauvegardes-bdri/` | Copie locale, chiffrée | 14 jours |
| `agerdb@102.211.199.132:~/ageroute-depots/bdri-sauvegardes/` | Copie hors serveur, chiffrée | Selon la politique du serveur distant |

Trois fichiers par sauvegarde :

- `bdri_<horodatage>.dump.enc` — la base
- `uploads_<horodatage>.tar.gz.enc` — les documents et photos
- `manifeste_<horodatage>.txt` — volumétrie, migrations, empreintes SHA-256

Une tâche quotidienne les produit à 3 h. Une vérification de restauration s'exécute le
dimanche à 4 h ; son journal se lit dans
`~/sauvegardes-bdri/verification-restauration.log`.

---

## 3. Restauration complète

### 3.1 Vérifier l'intégrité avant toute chose

Le manifeste porte les empreintes. Les comparer **avant** de restaurer : une archive
altérée produirait une base incohérente qu'on croirait valide.

```bash
cd <répertoire des sauvegardes>
grep -A3 "SHA-256" manifeste_<horodatage>.txt
sha256sum bdri_<horodatage>.dump.enc uploads_<horodatage>.tar.gz.enc
```

### 3.2 Déchiffrer

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in bdri_<horodatage>.dump.enc \
  -out bdri.dump \
  -pass file:<chemin de la clé>

openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in uploads_<horodatage>.tar.gz.enc \
  -out uploads.tar.gz \
  -pass file:<chemin de la clé>
```

Si le déchiffrement échoue, **la clé ne correspond pas à l'archive**. Ne pas
insister : vérifier qu'il s'agit bien de la clé du bon serveur et de la bonne période.

### 3.3 Reconstruire l'application

```bash
git clone https://github.com/tidiokamsar/ageroute-geoportail.git
cd ageroute-geoportail
```

Recréer `backend/.env` — **il n'est jamais sauvegardé**, délibérément : un secret n'a
rien à faire dans une archive destinée à sortir du serveur. Se référer à
`backend/.env.example` pour la liste des variables. Les valeurs de production sont à
obtenir auprès du responsable de l'infrastructure.

```bash
docker compose up -d db
```

### 3.4 Restaurer la base

L'image **doit porter PostGIS** : le dump contient des colonnes géométriques, et une
image PostgreSQL ordinaire échouerait sur le type `geometry`.

```bash
docker cp bdri.dump console-bdri-db-1:/tmp/
docker exec console-bdri-db-1 pg_restore -U bdri_app -d console_bdri \
  --no-owner --no-acl /tmp/bdri.dump
```

Des avertissements sur les rôles absents sont **attendus** et sans conséquence.

### 3.5 Restaurer les fichiers

```bash
docker volume create console-bdri_bdri_uploads
docker run --rm -v console-bdri_bdri_uploads:/dst -v "$PWD:/src:ro" \
  alpine tar xzf /src/uploads.tar.gz -C /dst
```

### 3.6 Démarrer et vérifier

```bash
docker compose up -d
```

| Contrôle | Attendu |
|---|---|
| `curl -s localhost:8081/api/health` | `{"status":"ok"}` — la sonde vérifie base **et** stockage |
| `docker exec console-bdri-db-1 psql -U bdri_app -d console_bdri -tAc "SELECT count(*) FROM troncons"` | Conforme au manifeste |
| `npx prisma migrate status` | `Database schema is up to date!` |
| `~/bdri-infra/infra/controle-fichiers-bdri.sh` | Aucune référence cassée |

---

## 4. Ce que la procédure ne couvre pas

| Élément | Pourquoi | Conséquence |
|---|---|---|
| `backend/.env` | Un secret ne doit pas entrer dans une archive | À recréer à partir de `.env.example` |
| Certificats TLS | Gérés par Traefik | Réémis automatiquement par Let's Encrypt |
| Configuration Traefik | Hors du périmètre BDRI | À restaurer avec le reverse proxy |
| Journaux applicatifs | Non sauvegardés | Perdus — sans conséquence sur les données |

---

## 5. Ce qui a été vérifié, et ce qui ne l'a pas été

**Vérifié le 1<sup>er</sup> septembre 2026**, sur une archive réelle, dans un
conteneur jetable sans réseau :

| Contrôle | Résultat |
|---|---|
| Empreinte conforme au manifeste | Oui |
| Déchiffrement | Réussi |
| `pg_restore` | 28 tables |
| Tronçons | 1 690, dont 1 690 géométries valides |
| Ouvrages · Chantiers · Comptes · Documents | 126 · 496 · 6 · 1 |
| Migrations · Clés étrangères | 17 · 35 |

**Non vérifié** : la remise en service complète sur une machine neuve. Les étapes 3.3
à 3.6 sont écrites à partir de la configuration réelle mais n'ont jamais été exécutées
de bout en bout sur un serveur vierge. **Un exercice de restauration complète reste à
programmer** — c'est le seul moyen de découvrir ce qui manque à cette procédure avant
d'en avoir besoin.

---

## 6. Rappel

Une sauvegarde jamais restaurée n'est pas une sauvegarde. La vérification hebdomadaire
automatique couvre la base et l'intégrité des archives ; elle ne couvre pas la remise
en service. **Programmer un exercice complet au moins une fois par an**, et consigner
ce qu'il révèle.

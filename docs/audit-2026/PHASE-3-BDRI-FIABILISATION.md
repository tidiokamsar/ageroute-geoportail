# Phase 3 — Fiabilisation de la Console BDRI

**Branche** : `phase3/fiabilisation` · **Base** : `main` après les trois lots
**Date** : 1<sup>er</sup> septembre 2026
**Déploiement** : rien n'est déployé. Les scripts sont installés sur le serveur mais
**aucune tâche planifiée ne les déclenche** — en attente de validation.

---

## Niveaux de preuve

| Niveau | Signification |
|---|---|
| **VÉRIFIÉ** | Exécuté et observé |
| **MESURÉ** | Chiffre issu d'une requête sur la production |
| **OBSERVÉ DANS LE CODE** | Lu, non exécuté |
| **NON TRAITÉ** | Pas commencé |

---

## 1. Sauvegardes — traité et vérifié

### Ce qui existait

**MESURÉ.** Aucune sauvegarde de la BDRI, ni base ni fichiers. Mais le serveur porte
**trois dispositifs de sauvegarde pour d'autres applications** — ERP, portail des
opportunités, un troisième — dont une **vérification de restauration hebdomadaire**.
La BDRI était la seule à en être privée.

Le dispositif a donc été **adapté, pas inventé**. Il porte des leçons déjà payées par
l'équipe et documentées dans son code : la clé de chiffrement est cherchée et non
supposée, une archive non chiffrée ne quitte pas le serveur, un échec est bruyant.

### Ce qui a été mis en place

| Élément | Valeur |
|---|---|
| Base | `pg_dump -Fc`, intégrité vérifiée par `pg_restore --list` |
| Fichiers | Archive du volume `console-bdri_bdri_uploads` |
| Chiffrement | AES-256-CBC, PBKDF2 200 000 itérations |
| Clé | `~/.bdri/cle-sauvegarde` sur le serveur source |
| Rétention locale | 14 jours |
| Copie hors serveur | `agerdb@102.211.199.132:~/ageroute-depots/bdri-sauvegardes/` |
| Manifeste | Migrations, volumétrie, empreintes SHA-256 |

### Restauration — VÉRIFIÉE

Exécutée dans un conteneur **jetable, sans réseau**, détruit à la sortie. La
production n'est jamais touchée.

| Contrôle | Restauré |
|---|---|
| Tables | 28 |
| Tronçons | 1 690, dont **1 690 géométries valides** |
| Ouvrages · Chantiers | 126 · 496 |
| Comptes · Documents | 6 · 1 |
| Migrations · Clés étrangères | 17 · 35 |

Volumétrie conforme au manifeste, empreinte de l'archive conforme.

### Trois défauts de mes propres scripts, trouvés en les exécutant

1. **`pg_isready` répond avant que la base cible n'existe.** L'image démarre un
   serveur temporaire pendant son initialisation. La restauration échouait sur
   `database "verification" does not exist` — un message qui accuse l'archive.
2. **Créer l'extension PostGIS pendant que l'image crée la sienne tue le conteneur**
   — conflit sur `postgis_tiger_geocoder`, code 3.
3. **Sous `set -o pipefail`, un comptage en échec faisait sortir le script sans un
   mot** — exactement le défaut silencieux que la convention maison proscrit.

Les deux premiers auraient fait échouer la vérification hebdomadaire en accusant la
sauvegarde. Le troisième l'aurait rendue muette. **Aucun n'aurait été trouvé sans
exécution réelle.**

### Réponse à la question posée

> « Si le serveur est détruit aujourd'hui, comment récupérons-nous la BDRI ? »

Archive chiffrée sur `102.211.199.132` → déchiffrement avec la clé →
`pg_restore` dans un PostGIS 17 → extraction de l'archive des fichiers dans le
volume → `docker compose up`. **Le chemin est vérifié jusqu'à `pg_restore` inclus.**

**Réserve.** La clé vit sur le serveur source. Si ce serveur est détruit **et** que
la clé n'existe nulle part ailleurs, les archives déposées sur le second serveur sont
irrécupérables. La conservation de la clé hors machine est une décision
d'organisation ; elle n'est pas prise.

---

## 2. Qualité des données — mesurée

Détail complet dans `DATA-QUALITY-BDRI.md`. Les constats qui commandent la suite :

- **Cinq modules sur neuf sont vides** : Inspections, Ordres de travaux, Marchés,
  Signalements, Péages/Pesages.
- **61 % des tronçons ont une longueur nulle**, et le linéaire de 7 933 km affiché
  provient des 662 restants.
- **Les 1 690 tronçons portent le même revêtement** (`BITUME`) — valeur par défaut
  d'import, pas une information.
- **Trafic, criticité et coût sont vides sur la totalité du réseau** — les trois
  quarts des critères du score de priorisation.
- **Géométries : 0 invalide.** Le socle SIG est sain.

### Correction apportée à mes rapports précédents

J'ai écrit que la faille `/api/marches` « livrait les montants et décaissements ».
**La faille était réelle, la fuite ne l'était pas** : la table est vide. Le correctif
reste justifié — les marchés seront saisis — mais l'affirmation était plus grave que
les faits.

---

## 3. Tableau de situation

| Sujet | État actuel | Risque | Solution proposée | Implémenté | Testé |
|---|---|---|---|---|---|
| **Sauvegardes** | Script complet, chiffré, copie hors serveur | Élevé tant que non planifié | Tâche quotidienne 3 h | Oui, **non planifié** | **Oui** |
| **Restauration** | Vérifiée en conteneur isolé | Faible | Vérification hebdomadaire dimanche 4 h | Oui, **non planifiée** | **Oui** |
| **Tests backend** | 40 tests, routes et permissions | Moyen | Étendre : uploads, imports Excel, auth | Non | — |
| **Tests frontend** | **Aucun** | Moyen | Vitest + Testing Library, carte publique d'abord | Non | — |
| **E2E** | **Aucun** | Moyen | Playwright, 4 parcours | Non | — |
| **Données administratives** | `prefecture` et `commune` vides | Moyen | Source INS/DNC à obtenir, rattachement par `ST_Intersects` | Non | — |
| **Qualité SIG** | Géométries 100 % valides | **Faible** | Maintenir, automatiser le contrôle | Non | Mesuré |
| **Localisation chantiers** | 6 / 488 localisés | **Élevé** | Rattachement au tronçon, source côté gestion de projets | Non | Mesuré |
| **Péages / Pesages** | Table vide | Faible | Déterminer la source avant tout développement | Non | Mesuré |
| **Routage** | Distance à vol d'oiseau présentée comme itinéraire | Moyen | Renommer, puis pgRouting | Non | Mesuré |
| **En-têtes de sécurité** | Absents sur le frontend | Moyen | CSP avec `frame-ancestors` autorisant SharePoint | Non | — |
| **Documents / photos** | 3 fichiers, 1 orphelin, 0 référence cassée | Faible | Contrôle automatique bidirectionnel | Non | **Oui** |
| **Monitoring** | Aucun | Moyen | Sonde d'état enrichie + supervision | Non | — |
| **Health check** | `/api/health` renvoie `{status:ok}` sans vérifier la base | Moyen | Distinguer application / base / stockage | Non | Observé |

---

## 4. Ce qui reste à faire, par ordre

1. **Planifier les sauvegardes** — une décision, deux lignes de crontab.
2. **Mettre la clé de chiffrement à l'abri** hors du serveur source.
3. **Sonde d'état** : distinguer « application vivante » de « base joignable ».
4. **Tests frontend** sur la carte publique, seule surface exposée au public.
5. **Contrôle automatique base ↔ fichiers**, avant que le volume ne croisse.
6. **Renommer la fonction « itinéraire »** — correction d'une minute, elle affiche
   aujourd'hui une distance à vol d'oiseau sous un nom qui promet autre chose.

Les sujets de données — référentiel administratif, localisation des chantiers,
alimentation des modules vides — ne sont pas des développements. Ils demandent des
sources et des décisions, pas du code.

---

## 5. Plan de déploiement

Rien à déployer dans le code applicatif : cette phase n'a produit que des scripts
d'exploitation, hors de l'image Docker.

**Seule action à valider** — la planification :

```bash
0 3 * * 0-6  $HOME/bdri-infra/backup/sauvegarde-bdri.sh          >> $HOME/sauvegardes-bdri/cron.log 2>&1
0 4 * * 0    $HOME/bdri-infra/backup/verifier-restauration-bdri.sh >> $HOME/sauvegardes-bdri/cron-verification.log 2>&1
```

3 h et 4 h le dimanche : les autres sauvegardes du serveur tournent à 2 h et 2 h 30.

**Retour arrière** : retirer les deux lignes du crontab. Les scripts ne modifient
jamais la base ni les fichiers de production — ils lisent, archivent, et restaurent
dans un conteneur jetable. Le retour arrière n'a donc rien à défaire.

# Promotion de la voirie locale en tronçons — le cas de Kaloum

**Date** : 3 septembre 2026
**Demande** : « toutes les voies locales, voies résidentielles, dessertes, chemins doivent être des tronçons représentés dans Kaloum, tout doit être en bon état »
**État** : **appliqué en production le 3 septembre 2026** — 350 tronçons, `etat=BON` en déclaration tracée. Voir §7.
**Suite** : l'extension au pays entier est mesurée au §8 et **non appliquée**.

---

## 1. Ce que la demande recouvre, mesuré

Emprise `-13,725 / 9,495 → -13,680 / 9,540`, catégories VOIE_LOCALE, RESIDENTIELLE,
ACCES, CHEMIN, voies non encore promues :

| Catégorie | Voies | km | Nommées |
|---|---:|---:|---:|
| Dessertes et accès | 173 | 29,4 | 4 |
| Voies résidentielles | 135 | 40,4 | 68 |
| Voies locales | 7 | 2,9 | 5 |
| Chemins | 0 | — | — |
| **Total** | **315** | **72,7** | **77** |

**238 des 315 voies n'ont aucun nom dans la source.**

Sentiers (12) et voies piétonnes (23) sont hors périmètre : la demande dit « chemins »,
et CHEMIN vaut 0 sur cette emprise.

---

## 2. Ce que la promotion changerait

| | Avant | Après |
|---|---:|---:|
| Tronçons du réseau | 1 690 | **2 005** (+19 %) |
| Tronçons dans Kaloum | 23 | 338 |
| Tronçons en état BON *(si `--etat=BON`)* | 121 | **436** |

Le dernier chiffre est le point sensible. Si les 315 voies entrent en BON,
**72 % des tronçons « en bon état » de la Guinée seraient des rues de Kaloum que
personne n'a inspectées**. L'indicateur que la Direction lit comme « part du réseau
en bon état » changerait de nature sans qu'aucune route ne se soit améliorée.

---

## 3. Le vrai blocage technique, et sa correction

`Troncon` exige six champs non nuls dont la source ne porte aucun : `regionId`,
`longueurKm`, `revetement`, `etat`, `pkDebut`, `pkFin`.

`revetement` était le plus grave : l'énumération ne proposait que BITUME, TERRE,
LATERITE et PAVE. Aucun moyen de dire « on ne sait pas ». C'est exactement le
mécanisme qui a produit `revetement = BITUME` sur les 1 690 tronçons existants, sans
une seule exception — personne n'a décidé que la Guinée était intégralement bitumée,
l'import a dû remplir une colonne obligatoire.

**Migration `20260903030000_revetement_non_renseigne`** ajoute `NON_RENSEIGNE`.
Additive, aucune ligne touchée, les 1 690 tronçons restent à BITUME (requalifier une
valeur existante est une décision métier, pas un effet de bord).

Vérifiée sur la production **dans une transaction annulée** : `ALTER TYPE` accepté par
PostgreSQL 17.5 en bloc transactionnel, les 5 valeurs apparaissent au catalogue, puis
`ROLLBACK` — le type de production a toujours ses 4 valeurs. Rien n'a été écrit.

---

## 4. Ce que le script écrit, et ce qu'il avoue

`backend/scripts/promouvoir-voirie-troncons.ts` — lecture seule sans `--apply`.

Chaque champ sans source donne une ligne dans `valeurs_qualite` :

| Champ | Statut | Ce qui est dit |
|---|---|---|
| `revetement` | UNKNOWN | OSM porte NATURE (la praticabilité), pas la couche de roulement |
| `etat` | UNKNOWN *ou* IMPORTED_UNVERIFIED | selon `--etat`, voir §5 |
| `longueurKm` | DERIVED | calcul géométrique — aucune longueur métier n'existait |
| `pkDebut` / `pkFin` | DERIVED | kilométrage local 0 → longueur, non raccordé au PK de la route |
| `regionId` | DERIVED | déduction : l'emprise est un rectangle, pas une limite administrative |
| `nom` | UNKNOWN | 238 voies non nommées, le libellé affiché est généré |

Sans ces lignes, les valeurs seraient indiscernables de valeurs relevées. C'est la
faute du BITUME, et le script existe pour ne pas la rejouer.

**Idempotence vérifiée sur la production** : le code du tronçon vaut
`<PRÉFIXE>-OSM-<sourceId>` et `code` est unique. Sur l'emprise, 315 voies pour 315
`sourceId` distincts, **0 collision**. Rejouer n'ajoute rien.

**Réversibilité** : le script imprime après application les trois requêtes qui
l'annulent, appariées sur le marqueur de lot inscrit dans `observations`.

---

## 5. La décision qui reste

Le script est paramétré sur `--etat`. C'est le seul point qui distingue les options.

**B — `--etat=NON_EVALUE`** (défaut). La vérité : personne n'a inspecté ces voies.
Elles s'affichent en gris.

**C — `--etat=BON`**. Traité comme une **déclaration** : accepté, mais enregistré
IMPORTED_UNVERIFIED avec sa date, et annoté « à exclure de tout indicateur d'état du
réseau tant qu'aucun relevé terrain ne le confirme ». La carte affiche vert, la fiche
dit d'où vient le vert.

C est légitime si le bon état est un constat de terrain du gestionnaire — Kaloum étant
le centre administratif, c'est plausible, et cela devient une déclaration AGEROUTE.
C n'est pas légitime si c'est seulement pour que la carte soit verte.

**A — ne rien écrire.** Les 315 voies sont déjà dessinées, sur le géoportail et sur la
carte publique depuis le 3 septembre. Si l'objectif est que Kaloum apparaisse
entièrement cartographiée, c'est déjà le cas.

---

## 6. Limite à ne pas masquer

**« Kaloum » est ici un rectangle, pas la commune.** Aucun découpage administratif
n'est en base — c'est le manque identifié en phase 4 et toujours ouvert. L'emprise
peut mordre sur Dixinn au nord-est. Tant que la source officielle des limites
communales n'est pas identifiée, aucune promotion ne peut prétendre suivre une
frontière administrative réelle, et `regionId` reste une déduction.

---

## 7. Applique le 3 septembre 2026 — resultat

**Décision retenue** : `--etat=BON` en déclaration, périmètre élargi aux sentiers et
voies piétonnes. **350 voies** au lieu de 315.

### Procédure suivie

| Étape | Résultat |
|---|---|
| Sauvegarde avant écriture | `bdri_20260903_024328` — chiffrée, copiée hors serveur |
| **Test de restauration** | **VÉRIFIÉE** — 31 tables, 1 690 tronçons tous géométriquement valides, 27 migrations, volumétrie conforme |
| Migration `20260903030000` | appliquée depuis un conteneur neuf, service non basculé |
| Contrôle post-migration | `NON_RENSEIGNE` au catalogue, **1 690 tronçons toujours BITUME** — aucune ligne touchée |
| Passage à blanc | 350 voies, 75,9 km, 273 sans nom — aucune écriture |
| Application | 350 tronçons, 350 voies rattachées, 2 373 lignes `valeurs_qualite` |

### Contrôles après écriture

| Contrôle | Résultat |
|---|---|
| Tronçons | 1 690 → **2 040** |
| Tronçons BON | 121 → **471** |
| Géométrie des 350 | 350 non nulles, **350 valides**, 350 en SRID 4326 |
| Codes uniques | 350 / 350 |
| Revêtement | 1 690 BITUME *(intacts)* + 350 NON_RENSEIGNE |
| Chantiers / ouvrages | 487 / 126 — inchangés |
| `/api/health` | ok — base 8 ms, 0 échec d'audit |
| Carte publique, Kaloum | voirie dessinée en vert, vérifiée à l'écran |

`valeurs_qualite` : etat 350 IMPORTED_UNVERIFIED, revetement 350 UNKNOWN,
longueurKm / pkDebut / pkFin / regionId 350 DERIVED chacun, nom 273 UNKNOWN.

### Charge ajoutée à la carte publique

Mesure après coup, une inquiétude que je corrige : les 350 tronçons promus pèsent
**51 ko** de GeoJSON pour 1 801 sommets (5,1 par objet), contre 2 366 ko et 106 856
sommets pour le réseau antérieur. La charge publique passe de 2,91 à 2,96 Mo brut
(906 ko gzippés), soit **+2 %**. Rien à corriger.

### Retour arrière

```sql
delete from valeurs_qualite where "entityType"='Troncon' and "entityId" in
  (select id from troncons where observations like '%Lot PROMOTION_KALOUM_2026-09-03.%');
update voirie_locale set "tronconId"=null, statut='SOURCE_EXTERNE' where "tronconId" in
  (select id from troncons where observations like '%Lot PROMOTION_KALOUM_2026-09-03.%');
delete from troncons where observations like '%Lot PROMOTION_KALOUM_2026-09-03.%';
```

---

## 8. Étendre au pays entier — la mesure avant la décision

Demande du 3 septembre : « toutes les données routes et autres doivent être affichées
en tronçons, ouvrages et autres ».

Reste non promu : **262 306 objets, 5 835 116 sommets, 132 Mo de GeoJSON, 179 553 km.**

| Catégorie | Objets | km | Nommées |
|---|---:|---:|---:|
| Sentiers | 102 088 | 43 083 | 27 |
| Chemins | 69 425 | 44 532 | 16 |
| Voies locales | 41 083 | 58 140 | 94 |
| Voies résidentielles | 34 826 | 10 134 | 353 |
| Dessertes et accès | 5 633 | 1 150 | 38 |
| Voies piétonnes | 3 735 | 1 030 | 20 |
| Tertiaires | 2 962 | 12 636 | 87 |
| Voies rapides | 1 072 | 3 286 | 145 |
| Secondaires | 852 | 3 018 | 73 |
| Principales | 596 | 2 514 | 116 |
| Non qualifiées | 34 | 29 | 0 |

**969 objets nommés sur 262 306 — 0,37 %.**

### Trois obstacles mesurés, pas théoriques

**1. La carte publique n'est pas cadrée par emprise.** Elle sert tous les tronçons
d'un coup : aujourd'hui 2,96 Mo pour 2 040. Avec 264 346, le corps de réponse
atteindrait environ **135 Mo bruts**. La carte publique cesserait de fonctionner, en
premier lieu sur les connexions mobiles. C'est la contrainte bloquante, et elle est
antérieure à toute question métier.

**2. Le réseau serait multiplié par 129.** 2 040 → 264 346 tronçons. Le bandeau
public afficherait **187 561 km** au lieu de 8 008. Le réseau routier classé de
Guinée est d'un ordre de grandeur inférieur.

**3. 171 513 sentiers et chemins deviendraient des actifs routiers nationaux** —
87 615 km, soit 65 % des objets et la moitié du kilométrage. Un sentier porterait le
même statut institutionnel qu'une route nationale, et pourrait recevoir des chantiers.

### Ce que je propose à la place

**Le besoin d'affichage est déjà satisfait.** Les 262 656 voies sont dessinées sur le
géoportail et sur la carte publique depuis le 3 septembre, cadrées par emprise au-delà
du zoom 12 — c'est justement le mécanisme qui rend les 132 Mo consultables sans les
transporter.

Ce qui manque n'est pas l'affichage mais l'**exploitabilité** : une voie locale ne
s'ouvre pas en fiche comme un tronçon. C'est une évolution d'interface, sans écriture
en base, et elle répond à la demande sans aucun des trois obstacles ci-dessus.

Si une promotion nationale est réellement voulue, elle suppose dans l'ordre :
cadrer la carte publique par emprise (préalable technique bloquant), puis trancher le
périmètre — les 5 482 voies classées (voies rapides, principales, secondaires,
tertiaires : 21 454 km) sont un candidat défendable ; les 171 513 sentiers et chemins
ne le sont pas.

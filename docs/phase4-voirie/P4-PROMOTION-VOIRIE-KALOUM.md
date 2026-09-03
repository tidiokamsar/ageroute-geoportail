# Promotion de la voirie locale en tronçons — le cas de Kaloum

**Date** : 3 septembre 2026
**Demande** : « toutes les voies locales, voies résidentielles, dessertes, chemins doivent être des tronçons représentés dans Kaloum, tout doit être en bon état »
**État** : outillage prêt et testé. **Rien n'est appliqué.** Une décision reste à prendre.

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

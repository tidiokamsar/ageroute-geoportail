# Provenance des données — Phase 4

**Ticket** : T2
**État** : livré et testé, script de remplissage **non exécuté en production**

---

## 1. Le point de départ

Le journal d'audit contient 1 155 modifications de tronçons et **zéro création**. Les
1 690 tronçons sont entrés par un chemin qui n'écrit pas dans le journal. Leur origine
n'était consignée nulle part, et aucune des six questions du §21 — d'où vient cette
donnée, qui l'a saisie, quand, quelle source, est-elle vérifiée, quand — n'avait de
réponse.

---

## 2. Ce que le code trahit

La provenance est lisible dans le champ `code`, qui porte la marque de son lot
d'import. Déduction éprouvée sur les 1 690 codes réels :

| Référence | Tronçons | Classe | Confiance | Ce que la famille révèle |
|---|---:|---|---|---|
| `RES-*` | 1 028 | RR | HIGH | aucune longueur saisie, aucun PK, 2,1 pts/km |
| `GN N*` | 551 | RN | HIGH | seule famille aux PK exploitables |
| `OSM` | 90 | RN, RU | HIGH | 70 en `*-OSM-*`, 20 en suffixe `-w<id de way>` |
| `KA*`, `MA*`, `DI*`, `RO*` | 20 | RU | MEDIUM | préfixes communaux, signification non établie |
| inconnue | 1 | RR | LOW | l'enregistrement d'essai |

**1 689 tronçons sur 1 690** rattachés à une famille. Le décalage n'est pas
cosmétique : il explique entièrement le problème des longueurs nulles, qui coïncide
exactement avec `RES-*`, et celui des PK, exploitables sur la seule famille `GN N*`.

### Trois choses apprises en éprouvant la règle sur tout

- Le suffixe `-w<chiffres>` est un identifiant de way OpenStreetMap : les 20 urbaines
  qui le portent viennent d'OSM elles aussi, par un nommage différent des nationales.
  Le script `merge:osm-routes` du dépôt corrobore.
- La règle des préfixes urbains ne visait d'abord que `DI`. Sur les 1 690 codes,
  seize de même forme restaient non reconnus — `KA`, `MA`, `RO`. C'est la raison de
  tester une règle de déduction sur la totalité des données, pas sur un échantillon.
- Le tronçon codé `test` porte le nom « RN2 », la classe RR et 56,4 km. **C'est
  l'unique régionale avec une longueur saisie.** Les 56 km que j'attribuais aux
  régionales viennent entièrement d'un enregistrement d'essai laissé en production.

---

## 3. Déduit n'est pas documenté

C'est la distinction qui porte tout le ticket, et le modèle la rend obligatoire :

| `sourceType` | Sens |
|---|---|
| `IMPORT_CODE_PATTERN` | provenance **déduite** du préfixe du code |
| `IMPORT_DOCUMENTE` | provenance **confirmée** par un document source |
| `SAISIE_APPLICATIVE` | créé dans l'application |
| `RECUPERATION_AUDIT` | repris depuis le journal d'audit |
| `INCONNUE` | rien de reconnu |

Ce que le préfixe désigne est un **lot d'import**, pas une source primaire. Ce que
recouvre réellement « RES-* » — quelle institution, quel fichier, quelle date — reste à
établir auprès d'AGEROUTE. La confiance HIGH porte sur le rattachement au lot, pas sur
l'identification de la source. Confondre les deux ferait passer une inférence pour un
fait.

**Aucun tronçon ne recevra `IMPORT_DOCUMENTE` par ce script.** Les tests l'interdisent.

---

## 4. Structure

Quatre colonnes sur `troncons`, aucune donnée existante modifiée :

| Colonne | Exemple |
|---|---|
| `sourceType` | `IMPORT_CODE_PATTERN` |
| `sourceReference` | `RES-*` |
| `sourceConfidence` | `HIGH` |
| `sourceDetectedAt` | date de la déduction |

Migration `20260902100000_troncon_provenance`, éprouvée sur la structure de
production restaurée : appliquée, rejouable, réversible sans perte.

---

## 5. Remplissage

`npm run backfill:provenance` — à blanc par défaut, `--apply` pour écrire.

Idempotent : un tronçon déjà porteur de cette provenance n'est pas réécrit, ce qui
préserve la date de la déduction d'origine. La logique de planification vit dans
`lib/provenance.ts`, où elle est testée sans base — 18 tests.

---

## 6. Ce qui reste sans réponse

| Question | État |
|---|---|
| Qui a créé les tronçons ? | toujours aucune trace : le chemin d'import n'écrit pas dans le journal |
| Que recouvre `RES-*` ? | à établir auprès d'AGEROUTE |
| Que signifient `KA`, `MA`, `DI`, `RO` ? | vraisemblablement des communes ; non établi |
| Que faire du tronçon `test` ? | à examiner — il fausse le total des régionales |

Le premier point demande de faire passer les imports par un chemin qui trace : c'est
un changement de pratique, pas de schéma.

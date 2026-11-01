# Spécification de la table de correspondance des identifiants BDR ↔ Géoportail

> Livrable 13 du § B.6, fondé sur les règles de rapprochement du § B.4 et sur le critère **B12**
> du § 14.9 : « un changement de correspondance est **versionné, daté**, et les exports
> antérieurs restent **reproductibles avec l'ancienne version** ». **Rédigé le 14/10/2026.**
>
> 🔒 Rien de ce qui suit n'existe dans le code. C'est une **spécification**, étiquetée
> proposition, à implémenter après l'audit et les premiers échantillons approuvés.

## 1. Les cinq règles du § B.4, et ce qu'elles interdisent

Ordre de rapprochement, **du plus sûr au moins sûr**, chaque étape ne s'appliquant qu'à défaut de
la précédente :

| Étape | Critère | Ce qu'il donne |
|---|---|---|
| 1 | **identifiant institutionnel officiel** | correspondance certaine |
| 2 | **code de route et nomenclature** (décret D/2017/331) | correspondance forte |
| 3 | **relation géométrique calculée**, avec tolérances et **score** | candidat, jamais certitude |
| 4 | **attributs de corroboration** (longueur, classe, nom) | renforce ou affaiblit le candidat |
| 5 | **revue humaine** si ambiguïté | décision |

**Jamais** : une correspondance sur le **seul nom** ou la **seule proximité** ; une **fusion** ou
une **suppression** automatique. Le dépôt en porte déjà la preuve du bien-fondé : les 42 doublons
géométriques de D-04 ont chacun un membre classé et un membre OSM, et deux d'entre eux portent
des qualifications contradictoires — une fusion automatique aurait choisi au hasard.

## 2. Modèle proposé

Table `correspondances_identifiants` — proposition, non créée.

| Colonne | Rôle |
|---|---|
| `id` | technique |
| `systemeSource` | `ONR_BDR`, `ANASUR_COLLECT`, `L2R`… — **vocabulaire administrable**, pas une énumération (leçon D-06) |
| `typeObjet` | route, tronçon, portion, dégradation, ouvrage |
| `identifiantSource` | tel que reçu, **jamais retouché** |
| `identifiantCible` | `troncons.id`, `ouvrages.id`, `portions.id`… |
| `methode` | laquelle des cinq étapes a tranché |
| `score` | 0–1 ; **1 n'est atteint que par l'étape 1** |
| `tolerancesM` | celles appliquées à l'étape 3, pour la reproductibilité |
| `attributsCorroborants` | JSON des valeurs comparées à l'étape 4 |
| `decisionReviseurId`, `decisionLe`, `decisionMotif` | étape 5, obligatoires quand `methode = REVUE_HUMAINE` |
| `versionTable` | **version de la table de correspondance** (critère B12) |
| `valideDu`, `valideAu` | période de validité **semi-ouverte**, même convention que `portions` |
| `lotImportId` | le lot qui l'a produite |
| `createdAt` | — |

**Aucune suppression** : une correspondance corrigée est **close** (`valideAu`) et une nouvelle
ouverte. C'est ce qui rend le critère B12 tenable sans archive parallèle.

## 3. Le versionnement, et pourquoi il est le cœur de B12

Un export vers l'ONR daté du 1ᵉʳ mars doit pouvoir être **régénéré à l'identique** le
1ᵉʳ septembre, même si cinquante correspondances ont changé entre-temps. Donc :

- chaque export enregistre la **`versionTable`** avec laquelle il a été produit ;
- une requête « telle qu'enregistrée à la version *n* » rend exactement les lignes valides à
  cette version — c'est le même mécanisme que `telQuEnregistreA` dans `reseau/bitemporel.ts`,
  déjà écrit et testé pour les portions ;
- un changement de correspondance **incrémente** la version ; il ne modifie jamais une ligne.

**Test d'acceptation B12** : produire un export en version *n*, changer dix correspondances,
produire l'export en version *n* à nouveau — **octets identiques** ; en version *n+1* — les dix
lignes diffèrent, et rien d'autre.

## 4. Contraintes à poser en base — proposition

- `CHECK (score <= 1 AND (methode <> 'IDENTIFIANT_OFFICIEL' OR score = 1))` ;
- `CHECK (methode <> 'REVUE_HUMAINE' OR decisionReviseurId IS NOT NULL)` ;
- exclusion sur (`systemeSource`, `typeObjet`, `identifiantSource`, période) : **un identifiant
  source ne pointe qu'une cible à la fois** — même outil que `portion_validee_sans_chevauchement`,
  dont la correction du 14/10 a précisément montré qu'il faut inclure la période.

## 5. Ce qui manque, et sans quoi la table reste vide

- Un **identifiant institutionnel officiel** : il n'existe pas encore côté Géoportail (D-06), et
  son existence côté ONR est à confirmer (question E1).
- Le **premier échantillon approuvé** (§ B.4). La table est vide tant qu'il n'est pas fourni, et
  le § B.6 l'impose : « les modèles restent vides ou fictifs tant qu'aucun export approuvé n'a
  été fourni ».

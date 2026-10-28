# Avancement

> Fichier de reprise exigé par le § 4 du mandat v2.1. **À lire en premier à chaque session**,
> avec [BLOCAGES.md](BLOCAGES.md), puis reprendre à la « prochaine action ».

## Lot en cours

**Lot 2 — référentiel linéaire**, branche `lot/02-referentiel`. Lots 0 et 1 terminés.

## Ce que le mandat v2.1 change par rapport à ce qui a été fait

Le mandat v2.1 est arrivé le 14/10/2026 à 14:20, **après** un déploiement en production
terminé et vérifié le même jour à 14:23.

| Règle v2.1 | Effet |
|---|---|
| § 2.1 🔒 aucune opération sur la production | **Le déploiement du 14/10 était le dernier.** Travail local uniquement |
| § 2.5 🔒 branche par lot, Conventional Commits | Adopté depuis `lot/00-pilotage` |
| § 1.2 périmètre exclu | Marchés, contrats, chantiers, ordres de travaux, décomptes **gelés** ([ADR-003](DECISIONS.md)) |
| § 7.1 🔒 SQL paramétré | Violation trouvée dans du code du 14/10 et corrigée ([ADR-005](DECISIONS.md)) |

## Lot 0 — pilotage, terminé

Mandat lu en entier, confronté au dépôt. Mémoire de travail du § 4 créée. Cahier consolidé
([CDC-CONSOLIDE.md](../specs/CDC-CONSOLIDE.md), sept contradictions tranchées) et **ADR
mobile** ([ADR-002](../architecture/ADR-002-TECHNOLOGIE-MOBILE.md), React Native).

Deux écarts de référentiel découverts et mesurés : **les routes communautaires n'existent pas
dans l'énumération `ClasseRoute`** (B-27, ≈ 20 000 km annoncés sans place dans le modèle) et le
réseau régional manque d'un sixième (B-28). Le réseau national, lui, concorde à 4 % près.

## Lot 1 — socle, terminé

- **Bogue de formatage des PK corrigé**, celui que cite le § 1 du mandat. Il existait en
  **deux exemplaires** avec deux sorties différentes. `Math.round` pouvait rendre 1000 :
  `1,9999 km` s'affichait **`PK 1+1000`** au lieu de `PK 2+000`. Unifié dans `lib/pk.ts`,
  calcul en mètres entiers, **12 tests**.
- **Quatre familles d'actifs s'affichaient en code brut** (`GLISSIERE`) : j'avais ajouté les
  valeurs à l'énumération le 13/10 sans compléter la table de libellés. Corrigé.
- **CI réparée.** Elle existait — mon entrée B-24 était fausse — mais ne se déclenchait que sur
  `push` vers `main` et sur les PR : sous la discipline du § 2.5, elle ne tournait **plus
  jamais**. Déclencheurs étendus, plus deux contrôles locaux (dossiers de migration complets,
  scan de secrets).
- **Garde de conformité au § 7.1** : `lib/sql-parametre.test.ts`, 6 tests. Elle a échoué à son
  premier lancement et signalé deux fichiers que je n'avais pas examinés.

## Lot 2 — référentiel linéaire, fait et prouvé

- **Historisation bitemporelle** (§ 7.2). Le modèle portait trois dates — `observeeLe`,
  `createdAt`, `remplaceeLe` — et il manquait la **date d'effet de fin**. Une route reprise le
  15 mars et relevée le 2 avril : la base ne pouvait dire que le 2 avril. `valideDu` /
  `valideAu` ajoutées, intervalle **semi-ouvert** garanti par contrainte.
- **Les règles, et non seulement les colonnes** : `reseau/bitemporel.ts`, **32 tests**, sans
  base. Les deux axes répondent séparément, et un test vérifie qu'ils donnent des réponses
  **différentes** pour la même date de terrain.
- **Anticipation exigée par le § 14** : contexte de praticabilité (T-07, M) et champs
  d'inférence sur `medias_defaut` (T-03), avec la distinction « non analysé » / « analysé sans
  détection » garantie par contrainte.
- **Script de descente écrit**, sorti du dossier de migration ([ADR-008](DECISIONS.md)).
- `observeeLe` **non renommé** en `valideDu` : ce sont deux choses ([ADR-007](DECISIONS.md)).

### Ce que le lot 2 ne tient pas, et je ne le déclare pas tenu

**La migration n'a été éprouvée ni en montée ni en descente.** Le § 9.4 l'exige « sur une base
de développement » ; il n'en existe aucune. Mesuré le 14/10 : aucun `psql`, aucun service ni
installation PostgreSQL, Docker Desktop injoignable et absent du chemin standard. C'est B-13,
et le § 2.1 interdit d'utiliser la production.

**Codification nationale, topologie routable (pgRouting) et gazetier des localités** restent au
lot 2 mais sont **bloqués** par B-06, B-07 et B-27 : les écrire sans le classement officiel
figerait une nomenclature inventée.

## État des données en production au 14/10/2026

Le constat central, et il n'est pas technique : **toute la chaîne de collecte est écrite,
testée, déployée — et vide.**

| Table | Lignes |
|---|---|
| `troncons` | 261 387 (dont **1 691** au réseau classé, 21 156,6 km) |
| `valeurs_qualite` | 1 820 694 |
| `ouvrages` | 1 172 |
| `catalogue_defauts` | 13 |
| `baremes_intervention` | 9, **aucun approuvé** |
| `matrices_degradation` | 9 |
| `referentiel_revetements` / `_etats_chaussee` | 8 / 5 |
| `regles_condition` | 1, **approuvée** |
| `missions`, `observations`, `defauts`, `portions`, `evaluations_condition` | **0** |
| `referentiel_praticabilites` | **0** — décision institutionnelle attendue |

Sur 1 691 tronçons du réseau classé, 649 portent un état déclaré et **un seul** un état
réellement observé. Aucun développement supplémentaire ne produira d'indicateur tant qu'aucune
donnée de terrain n'entre.

## Tests

Dernière exécution : backend **1 105 passés**, frontend **294 passés**, TypeScript sans erreur.
Détail, et ce qui n'est pas testé : [TESTS.md](TESTS.md).

## Restant, par lot du § 8

| Lot | État |
|---|---|
| 0 audit, conformité, architecture cible | **terminé** |
| 1 socle, SRID, CI | **terminé** |
| 2 référentiel linéaire | historisation **faite** ; codification, pgRouting, gazetier **bloqués** |
| 3 map-matching ponctuel et de trace HMM | ponctuel fait ; **continuité et HMM absents** |
| 4 dégradations, métrés, ouvrages | faits ; **fiche d'inspection d'ouvrage T-04 absente**, praticabilité T-07 anticipée au modèle mais bloquée (B-01) |
| 5 validation, audit, qualité | faits |
| 6 mobile en ligne + écran roulage | **React Native décidé, non commencé** |
| 7 hors ligne, packs, roulage complet | sync faite ; **packs, IRI, photo continue, HMM embarqué absents** |
| 8 indices, prévision, programmation | RCI fait ; **risque, traitement, coût, programmation absents** — barèmes et matrices présents, lus par aucun code |
| 9 tableau de bord, Géoportail d'excellence | partiels |
| 10 intégrations | **bloqué, aucun accès** |
| 11 durcissement | partiel |

## Prochaine action

**Lot 3 — map-matching ponctuel et de trace.** Prochain lot non bloqué, et il commence par ce
que le lot 1 lui a renvoyé :

1. **Jeu de points GPS annotés** (B-26), condition du critère A2 (« ≥ 95 % de bon candidat en
   tête quand la confiance est haute »). Construits de façon **synthétique** — routes
   parallèles à moins de 50 m, carrefours, chaussées séparées, précision dégradée — parce que
   la vérité terrain y est alors connue **par construction**, ce qu'un extrait de production ne
   donne pas. Et parce que le § 2.1 a coupé l'accès à la production.
2. **Continuité du déplacement** dans l'appariement : cap et position précédente. Mesuré le
   14/10 : `heading` compte **zéro occurrence** dans le dépôt, alors que le § 7.3 en fait un
   des cinq facteurs du score de confiance.
3. **Map-matching de trace par modèle de Markov caché** (§ 7.3.7, Newson & Krumm), noyau
   TypeScript partagé serveur et mobile. C'est la pièce qui tranche les cas ambigus par la
   continuité du parcours, et elle conditionne le critère A18 (≥ 97 % des points sur le bon
   tronçon).

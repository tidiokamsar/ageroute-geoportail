# Avancement

> Fichier de reprise exigé par le § 4 du mandat v2.1. **À lire en premier à chaque session**,
> avec [BLOCAGES.md](BLOCAGES.md), puis reprendre à la « prochaine action ».

## Lot en cours

**Lot 0 — pilotage et mise en conformité au mandat v2.1**, branche `lot/00-pilotage`.

## Ce que le mandat v2.1 change par rapport à ce qui a été fait

Le mandat v2.1 est arrivé le 14/10/2026 à 14:20, **après** un déploiement en production
terminé et vérifié le même jour à 14:23. Trois de ses règles modifient la conduite des
travaux, et une invalide une pratique en cours.

| Règle v2.1 | Effet |
|---|---|
| § 2.1 🔒 aucune opération sur la production | **Le déploiement du 14/10 était le dernier.** Travail local uniquement désormais |
| § 2.5 🔒 branche par lot, Conventional Commits | Adopté à partir de `lot/00-pilotage` |
| § 1.2 périmètre exclu | Marchés, contrats, chantiers, ordres de travaux, décomptes **gelés** — le dépôt en contient |
| § 7.1 🔒 SQL paramétré, jamais de concaténation | **Violation trouvée dans du code du 14/10 et corrigée** (voir ADR-005) |

## Fait, et prouvé

Travail antérieur au mandat v2.1, conservé parce que § 4 interdit de refaire un audit déjà
consigné. Les preuves sont dans [../rai-v3/](../rai-v3/).

- **Audit et matrice de conformité** : `../rai-v3/21_TABLEAU_CONFORMITE.md` (format exigé par
  le § 5 : exigence, état, preuve, écart, action, priorité, dépendances, test).
- **Chaîne de collecte complète et déployée** : appariement GPS avec score de confiance et
  refus sous seuil, contexte terrain en une requête, portions homogènes (créer, scinder,
  fusionner, requalifier, lignage), contrainte d'exclusion `btree_gist` contre les
  chevauchements, écran de terrain, écran de validation, idempotence hors ligne.
- **Moteur de qualité** : 9 familles d'anomalies, aucune correction ne propose de supprimer.
- **RCI** : moteur, collecte, normalisation, classes. Règle `rci-2026.1` **approuvée le
  14/10/2026** — et qui ne produit aucun score, la couverture maximale atteignable étant 0,45
  pour un seuil arbitré à 0,5.
- **Barèmes de coût rendus paramétrables** : provenance, approbation, millésime, largeur,
  devise, fenêtre de validité ; les 9 coûts inchangés et non approuvés.
- **Couverture du réseau agrégée en SQL** : 212 ms sur le réseau classé, fusion des
  recouvrements éprouvée contre 8 cas calculés à la main.
- **Sept audits mesurés** : RCI, hors territoire, doublons géométriques, axes régionaux,
  qualité, sécurité du dépôt, migrations.

Dernière exécution de la suite : `npx vitest run` → **1 067 passés, 0 échec**, TypeScript sans
erreur. Détail dans [TESTS.md](TESTS.md).

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

Aucun développement supplémentaire ne produira d'indicateur tant qu'aucune donnée de terrain
n'entre. C'est le verrou du programme.

## Restant, par lot du § 8

| Lot | État |
|---|---|
| 0 audit, conformité, architecture cible | audit fait ; **CDC consolidé et ADR mobile à écrire** |
| 1 socle, SRID, CI | SRID conformes (`geography`), **CI absente** |
| 2 référentiel linéaire, codification, topologie, gazetier | portions faites ; **codification nationale, pgRouting, gazetier absents** |
| 3 map-matching ponctuel et de trace HMM | ponctuel fait ; **HMM absent** |
| 4 dégradations, métrés, ouvrages | faits ; **fiche d'inspection d'ouvrage T-04 et praticabilité T-07 absentes** |
| 5 validation, audit, qualité | faits |
| 6 mobile en ligne + écran roulage | **PWA seule ; écran roulage absent** |
| 7 hors ligne, packs, roulage complet | sync faite ; **packs, IRI, photo continue, HMM embarqué absents** |
| 8 indices, prévision, programmation | RCI fait ; **risque, traitement, coût, programmation absents** |
| 9 tableau de bord, Géoportail d'excellence | partiels |
| 10 intégrations | **bloqué, aucun accès** |
| 11 durcissement | partiel |

## Prochaine action

Écrire `docs/specs/CDC-CONSOLIDE.md` et l'**ADR de technologie mobile** (ADR-002), qui
conditionne les lots 6 et 7 : le § 7.13 exige un service de premier plan Android, une trace
GNSS à 1 Hz en arrière-plan, l'accéléromètre et la photo continue — ce qu'une PWA ne peut pas
tenir. Cette décision doit être tranchée et motivée avant toute ligne de code mobile.

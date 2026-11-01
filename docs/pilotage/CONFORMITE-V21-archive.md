# Matrice de conformité

> Exigée par les § 4 et § 5 du mandat v2.1.

## Où elle vit

La matrice détaillée est **[../rai-v3/21_TABLEAU_CONFORMITE.md](../rai-v3/21_TABLEAU_CONFORMITE.md)**,
rafraîchie le 14/10/2026. Elle porte déjà les colonnes exigées par le § 5 — exigence, état,
preuve dans le code, écart, action, priorité, dépendances, test d'acceptation — et le barème à
six états.

Elle n'est pas déplacée : voir [ADR-006](DECISIONS.md). Vingt-huit documents de `docs/rai-v3/`
sont cités par des commits et par du code.

## Ce que le mandat v2.1 ajoute et qu'elle ne couvre pas encore

La matrice a été écrite contre le cahier RAI V3.1 et ses addenda. Le mandat v2.1 introduit des
exigences nouvelles, à y intégrer au lot 0 :

| Exigence v2.1 | État |
|---|---|
| § 7.13 collecte en roulage (T-12, priorité M) | ❌ absente — conditionne l'ADR mobile |
| § 7.14 niveau d'excellence du référentiel et du Géoportail | ❌ absente : codification nationale, ISO 19148, topologie routable, gazetier, métadonnées ISO 19115, réconciliation OSM |
| § 7.7 programmation pluriannuelle (PPE/PAE, PR-01 à PR-14) | ❌ absente — les barèmes et matrices existent, aucun moteur ne les lit |
| § 7.1 conventions SRID, UTM 28N/29N | 🟠 partielle : les longueurs passent par `geography`, conforme ; une concaténation SQL subsistait et est corrigée (ADR-005) |
| T-01 IRI par accéléromètre | ❌ absente |
| T-04 fiche d'inspection d'ouvrage structurée (M) | ❌ absente |
| T-07 praticabilité saisonnière (M) | ⛔ bloquée (B-01) |
| T-11 anti-fraude de collecte (M) | ❌ absente |
| X-09 paramétrage métier sans code (M) | 🟠 partielle : référentiels, catalogue, règle RCI et barèmes sont administrables en base ; aucune interface ne les édite |
| X-11 routage et déviations, pgRouting (M) | ❌ absente |
| X-12 gazetier national des localités (M) | ❌ absente |
| A22 programmation reproductible | ❌ sans objet tant qu'il n'y a pas de moteur |

## Rappel de périmètre

Le § 1.2 exclut marchés, contrats, chantiers, ordres de travaux, décomptes et paiements. Les
lignes de la matrice qui les concernent sont **gelées** et non comptées comme écarts à combler
(voir [ADR-003](DECISIONS.md)).

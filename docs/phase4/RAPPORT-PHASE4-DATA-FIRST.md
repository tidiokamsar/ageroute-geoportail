# Rapport de Phase 4 — Data First

**Projet** : Console BDRI, AGEROUTE Guinée
**Branche** : `phase4` — **PRÊTE POUR VALIDATION, NON DÉPLOYÉE**
**Période** : 1er et 2 septembre 2026
**Règle suivie** : DATA FIRST — MEASURE FIRST — NO FICTION

---

## A. Ce qui a été corrigé

| Ticket | Objet | Statut | Tests | Production |
|---|---|---|---:|---|
| T1 | Longueur saisie et longueur calculée, séparées | livré | 17 | non déployé |
| T2 | Provenance déduite du code, 1 689 / 1 690 | livré | 18 | non déployé |
| T3 | Revêtement marqué importé non vérifié | livré | 35 (avec T4) | non déployé |
| T4 | Statut, source, méthode et date par champ | livré | — | non déployé |
| T5 | Propositions de localisation depuis les intitulés | livré, **rattachement automatique impossible** | 28 | non déployé |
| T6 | Chantiers sans localisation retirés de la carte | livré | 19 | non déployé |
| T7 | Synchronisation idempotente, date de constat | livré, **terrain non testé** | 9 (+9 phase 3) | non déployé |
| T8 | Score refusant de calculer sur des critères absents | livré | 14 | non déployé |
| T9 | Six postes récupérés, trafics non restaurés | livré | 9 | non déployé |
| T10 | Diagnostic topologique reproductible | mesuré | — | lecture seule |
| §14 | Recouvrement spatial OSM / BDRI | mesuré | — | lecture seule |

**Tests** : backend 45 → **174**, frontend 30 → **50**. Typecheck des scripts créé —
il n'existait pas. Aucun test supprimé. Tout est vert à la remise.

**Migrations** : six, éprouvées sur la structure de production restaurée dans un
conteneur jetable — appliquées, rejouables, rollback vérifié à 310 colonnes, 1 690
géométries intactes. Aucune n'écrit une valeur.

---

## B. Ce qui est mesuré

Uniquement des chiffres vérifiés sur la base de production, en lecture seule.

### Réseau

| Mesure | Valeur |
|---|---:|
| Longueur saisie | 7 933 km sur 662 tronçons |
| Longueur calculée depuis la géométrie | 21 156 km sur 1 690 |
| Régionales sans longueur saisie | 1 028 sur 1 029 |
| L'unique régionale avec longueur | l'enregistrement `test` |
| Géométries valides, SRID 4326 | 1 690 / 1 690 |
| Extrémités connectées à 1 m | 77,0 % |
| Connexions entre classes RN / RR / RU | **0** |
| Croisements inter-classes sans jonction | 324 |
| PK exploitables | 551 / 1 690, tous `GN N*` |
| Routes dont un PK de départ est dupliqué | 24 / 42 |

### Recouvrement OSM 2023

| Classe BDRI | Linéaire à moins de 25 m d'OSM classé | à 250 m |
|---|---:|---:|
| RN | 90,7 % | 94,5 % |
| RU | 98,7 % | 100 % |
| RR | 2,5 % | 20,6 % |

Régionales sans aucune correspondance à 250 m : **240 tronçons, 2 358 km**.

### Qualité

| Mesure | Valeur |
|---|---:|
| Valeurs de décision `OBSERVED` | **0** sur 10 140 |
| Dates de constat | 0 sur 1 690 tronçons |
| `revetement` distinct | 1 valeur, `BITUME` |
| `etat` = `NON_EVALUE` | 1 043 / 1 690 |
| Chantiers sans localisation, affichés à Conakry | 50 → **0** |

### Chantiers

| Mesure | Valeur |
|---|---:|
| Intitulés avec route et PK | 36 |
| Emprises extractibles | 14 |
| Emprises trouvant un tronçon couvrant | **0** |
| Propositions instruites en attente d'un agent | 33 |

---

## C. Ce qui reste absent

| Donnée | Ampleur | Voie de production |
|---|---|---|
| Trafic | 0 / 1 690 tronçons | comptages — aucun n'existe dans le système |
| Criticité stratégique | 0 / 1 690 | critères à arrêter par AGEROUTE, puis saisie |
| Coût de réhabilitation | 0 / 1 690 | devis ou barème documenté |
| Date de constat de l'état | 0 / 647 états connus | inspections terrain, désormais datées |
| Préfecture, commune | 0 / 1 690 | référentiel administratif |
| Longueur saisie des régionales | 0 / 1 028 | à établir — la valeur calculée est disponible à côté |
| Inspections | 1 en trois mois | plan d'inspection — décision d'organisation |
| Marchés, ordres de travaux, signalements | 0 | jamais alimentés, aucune trace d'audit |

Aucune de ces absences n'a été comblée par une valeur de repli. L'interface les montre
désormais comme absentes.

---

## D. Ce qui reste douteux

| Donnée | Doute | Marquage |
|---|---|---|
| `revetement` = `BITUME` | valeur unique sur 1 690 ; 29 intitulés décrivent des routes en terre | `IMPORTED_UNVERIFIED`, LOW, contradiction en note |
| `etat` renseigné | 647 valeurs, aucune datée, source inconnue | `IMPORTED_UNVERIFIED`, LOW |
| Localisation régionale des chantiers | 432 au centroïde régional | `APPROXIMATIVE`, dit tel quel sur la carte |
| Conakry, 224 chantiers | 46 % du total, non vérifié contre une source externe | signalé, non corrigé |
| Trafics des postes récupérés | deux fois 3 200 exactement, montants ronds, aucune coordonnée | **non restaurés**, motif en note |
| Longueur des régionales | grossièreté à 2,1 pts/km, aucune validation externe possible | valeur calculée, jamais écrite en base |
| Provenance `RES-*` | désigne un lot d'import, pas une source | `IMPORT_CODE_PATTERN`, jamais `IMPORT_DOCUMENTE` |
| Tronçon `test` | enregistrement d'essai en production, 56,4 km | signalé `INCONNUE`, à examiner |

---

## E. Ce qui attend une décision

| Décision | Depuis | Ce qu'elle bloque |
|---|---|---|
| **Clé de chiffrement** — qui en détient une copie hors serveur | phase 3 | toute restauration si le serveur source disparaît |
| **Autorisation de déploiement** de la branche `phase4` | maintenant | les dix tickets, et la migration `lat`/`lon` de phase 3 |
| **Référentiel administratif officiel** — quelle source, avec quelles géométries | phase 3 | 299 chantiers à localiser par nom de lieu, soit 61 % |
| **Validation terrain** — qui, avec quel appareil, sur quel tronçon | phase 3 | la clôture de T7 ; 17 tests marqués NON TESTÉ |
| **Politique d'utilisation d'OSM** — donnée contributive dans un référentiel national | maintenant | tout usage au-delà de la validation des nationales |
| **Périmètre du réseau** — les 9 500 km de tertiaires OSM absents de la BDRI en font-ils partie ? | maintenant | la définition même de « la longueur du réseau » |
| **Que recouvre `RES-*`** — quelle institution, quel fichier, quelle date | maintenant | 13 296 km qu'aucun autre jeu ne décrit |
| **Cohérence des PK** — un kilométrage continu par route | maintenant | T5, et toute localisation linéaire |
| **Garde de module sur les lectures** de chantiers, tronçons, ouvrages | maintenant | rien aujourd'hui ; tout le jour où un compte sera restreint |

---

## F. Ce qui nécessite une source externe

### `BLOCKED_BY_DATA` — le code est prêt, la donnée manque

| Sujet | Source requise |
|---|---|
| Localisation de 299 chantiers par nom de lieu | référentiel administratif avec géométries |
| Trafic sur les tronçons | campagne de comptage, ou données d'exploitant |
| Criticité stratégique | critères arrêtés par AGEROUTE |
| Coût de réhabilitation | barème ou devis documentés |
| Revêtement réel | relevé terrain — aucune source disponible ne le porte, OSM inclus |
| Trafic réel des six postes | archives de l'exploitant |
| Densification des régionales | aucune : OSM ne les couvre qu'à 20 % |

### `BLOCKED_BY_CODE` — la donnée existe, le code manque

| Sujet | Ce qui manque |
|---|---|
| Raccordement des 324 croisements inter-classes | examen cartographique puis création de jonctions, avec sauvegarde |
| Composantes connexes après raccordement | relancer le diagnostic après le point précédent |
| Distance de tracé BDRI / OSM | une requête correctement posée — Hausdorff vers l'union, pas vers un segment |
| Cohérence des PK par route | reconstruction du kilométrage — dépend d'une décision, mais le code suivra |
| Garde de module sur les lectures | ajouter `requireModuleAccess` aux routes de lecture, avec tests |
| Trois scripts d'import sur `xlsx` | porter sur `exceljs` |

### Ni l'un ni l'autre — décision pure

Périmètre du réseau, politique OSM, plan d'inspection, clé de chiffrement.

---

## G. Ce qui est prêt

Prêt signifie : code écrit, testé, typechecké, migration éprouvée sur la structure de
production, rollback vérifié, script à blanc par défaut.

| Fonctionnalité | Prêt | Réserve |
|---|---|---|
| Deux longueurs au tableau de bord et au géoportail | oui | aucune |
| Provenance sur 1 689 tronçons | oui | `RES-*` reste à documenter |
| Badges de qualité sur la fiche tronçon | oui | aucune valeur ne sera `OBSERVED` avant la première inspection |
| Tableau de bord qualité, `GET /api/qualite/repartition` | oui | pas encore d'écran dédié — l'API seule |
| Carte sans les 50 chantiers non localisés | oui | 50 chantiers disparaissent de la carte, il faut l'expliquer |
| Liste des chantiers sans localisation | oui | aucune |
| File de propositions de localisation | oui | 33 propositions, **zéro rattachement automatique** |
| Score « Non calculable » sur critères absents | oui | tous les scores seront non calculables tant que trafic, criticité et coût sont vides — c'est le but |
| Simulateur budgétaire refusant sans coût réel | oui | il ne simulera rien avant la saisie de coûts |
| Idempotence des inspections | oui | non éprouvée sur appareil réel |
| Récupération des six postes | oui | validation par un agent après |
| Diagnostic topologique | oui, lecture seule | aucune |
| Mesure de recouvrement OSM | oui, lecture seule | la mesure de distance de tracé est à refaire |

---

## H. Ce que je retiens contre moi

Cinq affirmations fausses dans mes propres livrables, corrigées en cours de phase.
Toutes ont la même forme : **vérifier qu'un chiffre existe plutôt que vérifier ce
qu'il mesure.**

1. « Le référencement linéaire existe déjà, 1 690 / 1 690. » — 1 069 tronçons portent
   `pkDebut = pkFin = 0`. Après avoir décrit ce piège comme le principal de la base.
2. « De 6 à 42 chantiers localisés, sept fois plus. » — zéro rattachement automatique
   possible. Estimation faite sans avoir testé le rattachement.
3. « La réserve est levée : 21 490 km ≈ 21 156 km. » — publié, puis défait par le
   recouvrement spatial. Le cadrage l'avait écrit noir sur blanc ; je l'ai lu, et j'ai
   conclu quand même.
4. « OSM offre un gain de huit fois sur la densité des régionales. » — accessible pour
   une régionale sur cinq.
5. Un typecheck annoncé vert qui lisait le code de sortie de `head`, et un `scripts/`
   qui n'était typechecké nulle part.

Et une mesure mal posée, la distance de Hausdorff, que le premier réflexe aurait été
de publier telle quelle. Deux contrôles qui se contredisent doivent faire réexaminer
la méthode, pas se faire moyenner.

---

## I. Documents produits

```
docs/phase4/
├── DATA-PROVENANCE-PHASE4.md
├── DATA-QUALITY-PHASE4.md
├── CHANTIER-GEOLOCATION-PHASE4.md
├── FIELD-INSPECTION-PHASE4.md
├── TOPOLOGY-AUDIT-PHASE4.md
├── OSM-BDRI-COVERAGE-PHASE4.md
├── RECOVERED-TOLL-SITES-PHASE4.md
├── DEPLOYMENT-PHASE4.md
└── RAPPORT-PHASE4-DATA-FIRST.md
```

Et trois documents antérieurs corrigés : `TRONCONS-DATA-AUDIT.md`,
`BDRI-SOURCE-OSM-2023.md`, `BDRI-CHANTIERS-GEOLOCALISATION.md`.

---

# PHASE 4 PRÊTE POUR VALIDATION

Rien n'a été déployé. La procédure, la liste exacte des changements et le rollback
sont dans `DEPLOYMENT-PHASE4.md`. La validation de production est à donner séparément.

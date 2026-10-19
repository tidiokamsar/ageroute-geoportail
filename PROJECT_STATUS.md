# État du projet

> Fichier canonique exigé par le § A.9 du prompt maître V10. **À lire en premier à chaque
> session**, avec [BLOCKERS.md](BLOCKERS.md) et [DECISIONS_PENDING.md](DECISIONS_PENDING.md),
> puis reprendre à la « prochaine action ».
>
> Le § A.9 interdit de refaire un audit déjà consigné : **le mettre à jour**.

**Vérifié le 14/10/2026.** Branche de travail : `lot/03-map-matching`. Toute mesure porte sa
date et sa méthode ; ce qui n'est pas vérifié est dit comme tel (§ A.5.7).

---

## 1. Production

| Élément | État vérifié |
|---|---|
| Domaine | `carte.ageroute.gov.gn`, HTTP **200** |
| Dernier déploiement | **14/10/2026 à 14:23**, images construites à 14:17 |
| Migrations | **50 appliquées**, « Database schema is up to date! » |
| Santé | `/api/health` 200, base 5 ms, stockage 2 ms, `echecsDepuisDemarrage` **0** |
| Journal backend | **0 erreur** depuis le redémarrage |
| API publique | `/api/public/carte/geo` sert 785 Ko en 0,36 s |
| PWA | `/sw.js` 200 |

**Depuis le 14/10 à 14:23, aucune opération de production** autre que la désapprobation de la
règle RCI à 16:19, explicitement autorisée. Le § A.5.1 l'exige.

---

## 2. Ce que la base contient, et le constat qui domine tout

| Table | Lignes |
|---|---|
| `troncons` | 261 387, dont **1 691 au réseau classé** (21 156,6 km) |
| `valeurs_qualite` | 1 820 694 |
| `ouvrages` | 1 172 |
| `chantiers` | 496 — **module gelé** (§ A.3) |
| `refresh_tokens` | 799 |
| `catalogue_defauts` | 13 |
| `baremes_intervention` | 9, **aucun approuvé** |
| `matrices_degradation` | 9, **lues par aucun code** |
| `referentiel_revetements` / `_etats_chaussee` | 8 / 5 |
| `regles_condition` | 1, **désapprouvée le 14/10 à 16:19** |
| `missions`, `observations`, `defauts`, `portions`, `evaluations_condition` | **0** |
| `referentiel_praticabilites` | **0** — décision institutionnelle attendue |

**Toute la chaîne de collecte est écrite, testée, déployée — et vide.** C'est le constat
central, et il n'est pas technique.

Sur les 1 691 tronçons du réseau classé, **649 portent un état déclaré** et **un seul** un état
réellement observé (`RES-857`). `troncons.dateDerniereEvaluation` est **nulle sur les 261 387
lignes**. Aucune mesure de déflexion, aucune mesure d'IRI.

**Aucun développement supplémentaire ne produira d'indicateur tant qu'aucune donnée de terrain
n'entre.**

### Le réseau, contre les chiffres officiels

Mesuré contre les chiffres que le § A.2 cite (TDR de la BDR nationale, 2020) :

| Classe officielle | Officiel | Mesuré | Écart |
|---|---|---|---|
| Nationales | 7 576 km | **7 824,4 km** | **+3,3 %** |
| Préfectorales | 15 879 km | 13 295,6 km (classe `RR`) | −16,3 % |
| **Communautaires** | 19 846 km | **valeur inexistante dans l'énumération** | — |
| Voiries urbaines | ≈ 2 000 km | **36,6 km** | −98 % |
| Total | ≈ 45 300 km | 21 156,6 km | **48 %** |

Le réseau national est essentiellement complet. Les communautaires n'ont **aucune valeur
d'énumération** pour exister, et les voiries urbaines sont quasi absentes. Voir D-06 dans
[DECISIONS_PENDING.md](DECISIONS_PENDING.md).

---

## 3. Tests

| Suite | Résultat, 14/10/2026 |
|---|---|
| Backend `npx vitest run` | **1 145 passés**, 0 échec |
| Frontend `npx vitest run` | **294 passés**, 0 échec |
| `tsc --noEmit`, les deux paquets | aucune erreur |

Détail, et **ce qui n'est pas testé**, dans [TEST_EVIDENCE.md](TEST_EVIDENCE.md).

---

## 4. Fait depuis l'arrivée du mandat V10

| # | Travail | Preuve |
|---|---|---|
| § A.7 | **Sécurité P0 vérifiée** : aucun secret ni IP de production jamais committé sur 225 commits. Le dépôt est bien public, mais rien n'a fuité — **aucune rotation nécessaire** | [SECURITY_REMEDIATION.md](SECURITY_REMEDIATION.md) |
| § A.9 | Huit **fichiers de suivi canoniques** à la racine, renommés depuis les miens pour ne pas créer de concurrents | historique Git préservé |
| § 15 | **ADR-009** : Capacitor figé, ADR-002 (React Native) remplacée, avec ce que mon analyse avait juste et faux | [TECHNICAL_DECISIONS.md](TECHNICAL_DECISIONS.md) |
| § A.6.1 | **`rci-2026.1` désapprouvée** par un geste audité, et `RCI_METHOD_DECISION.md` écrit | [RCI_METHOD_DECISION.md](RCI_METHOD_DECISION.md) |
| § A.8 | **Migrations réconciliées** : 51 locales, 50 appliquées, 1 en attente. L'état de référence du § A.4 était périmé de neuf migrations | [MIGRATION_PLAN.md](MIGRATION_PLAN.md) |
| § K.4 | **Mandat V10 lu en entier**, parties A à K. Les critères d'acceptation vont à **A30**, non A24 | — |
| § A.9 | **Matrice de conformité refaite** contre les trente scénarios : 9 terminés et testés, 3 tests partiels, 3 partiels, 3 non testés, 4 bloqués, 8 absents. **Aucune case « à vérifier »** | [REQUIREMENTS_TRACEABILITY.md](REQUIREMENTS_TRACEABILITY.md) |
| § D | **Quinze ADR** des arbitrages D1–D15, dont deux corrigent mes décisions antérieures : D14 amende ADR-006, D6 referme l'écart É-4 du RCI | [TECHNICAL_DECISIONS.md](TECHNICAL_DECISIONS.md) |
| § 7.17 | **Praticabilité : une proposition existait et je la déclarais absente.** Le mandat propose lui-même P1 à P4 ; la fiche D-02 la porte désormais, avec les quatre manques qui subsistent | [DECISIONS_PENDING.md](DECISIONS_PENDING.md) |
| § D4 | **Nouvelle décision en attente D-09** : l'arbitrage D4 impose « aucun second annuaire » alors que la table `utilisateurs` en est un. Aucun OIDC n'existe — vérifié | [DECISIONS_PENDING.md](DECISIONS_PENDING.md) |
| § 7.3.7 | **Map-matching de trace HMM** écrit et mesuré : critère **A18 à 130 points justes sur 130**, exigé ≥ 97 %, 8 sorties du référentiel détectées sur 8, 7 200 points sans débordement | `geo/appariement.trace.ts`, 25 tests |
| § A.8 | **Rollback exécuté et vérifié** : B-13 levé, base PostGIS 17-3.5 isolée, aller-retour 20 objets → 0 → 20, états identiques. **La porte de la phase 0 est franchie** | [MIGRATION_PLAN.md](MIGRATION_PLAN.md) § 3 |
| § A.8 | **Et le rejoue a révélé B-16** : la chaîne de migrations ne reconstruit pas la base, 49 sur 51. La reprise après sinistre repose sur `pg_dump` seul | [MIGRATION_PLAN.md](MIGRATION_PLAN.md) § 3 bis, arbitrage D-10 |

---

## 5. Fait avant le mandat V10, et qui tient

Chaîne de collecte complète et déployée : appariement GPS avec confiance et refus sous seuil,
contexte terrain en une requête, portions homogènes (créer, scinder, fusionner, requalifier,
lignage, contrainte d'exclusion `btree_gist`), écran de terrain, écran de validation,
idempotence hors ligne, moteur de qualité à 9 familles, PWA renforcée, 13 types de défauts,
4 familles d'actifs linéaires, fiche 360°.

Et trois travaux des lots 1 à 3 :

- **Bogue des PK corrigé** — il existait en deux exemplaires et rendait `PK 1+1000` pour
  1,9999 km. Unifié dans `lib/pk.ts`, 12 tests.
- **Historisation bitemporelle** — `reseau/bitemporel.ts`, 32 tests, les deux axes de temps
  répondant différemment à la même date de terrain.
- **Noyau d'appariement partageable** — `geo/appariement.noyau.ts`, sans aucun import, avec les
  deux facteurs manquants du § 7.3.3 (cap, continuité) et les trois issues du § 7.3.4. Critère
  **A2 mesuré sur 23 cas annotés : 100 %**, exigé ≥ 95 %, et **0 rattachement automatique sous
  le seuil**.

Le § 15 ayant figé Capacitor, ce noyau devient plus utile encore : c'est le même JavaScript qui
tournera dans la coque.

---

## 6. Restant, par lot du § F.2

| Lot | État |
|---|---|
| Audit, conformité, architecture | **fait**, tenu à jour |
| Socle, SRID, CI | **fait** |
| Référentiel linéaire | historisation **faite** ; codification, pgRouting, gazetier **bloqués** par D-06 |
| Map-matching | ponctuel, scoring et **trace HMM faits** (A18 130/130 sur jeu synthétique) ; graphe réseau absent |
| Dégradations, métrés, ouvrages | faits ; **fiche d'inspection d'ouvrage T-04 absente** |
| Validation, audit, qualité | **faits** |
| Mobile et écran de roulage | **Capacitor figé, non commencé** ; plugins Kotlin à écrire |
| Hors ligne, packs, roulage complet | sync faite ; **packs, IRI, photo continue absents** |
| Indices, prévision, programmation | RCI écrit mais **désapprouvé** ; **risque, traitement, coût, programmation absents** — barèmes et matrices présents, lus par aucun code |
| Tableau de bord, Control Tower, Géoportail d'excellence | partiels |
| Écosystème ONR / BDR / ANASUR (partie B) | les 15 livrables du § B.6 **produits** ; pivot CSV/GeoJSON et import étape 1 faits ; étape 2 **bloquée** (échantillon approuvé) ; formats L²R non publiés |
| Exploitation et information routière (§ 7.17) | main courante, P1–P4 provisoires, **patrouilles programmées, Info Route et bulletin faits** (19/10) ; cellule de veille et statistiques **absentes** ; Waze/CIFS, DATEX II et diffusion du bulletin **bloqués** (aucun partenaire ni canal autorisé) |
| Observation de la Terre (partie E) | **non commencé** — palier 0 gratuit, aucune dépense requise |
| Tâches internes et rapprochement (TI-01 à TI-03) | TI-01 **fait** (table, contraintes, garde-fou de frontière) ; TI-03 **fait** (`DATA_SOURCE_OF_TRUTH.md`) ; TI-02 **bloqué** (B-11) |
| Intégrations DigitalRoad, SharePoint | **bloquées, aucun accès** |
| Durcissement, observabilité | partiel |

---

## 7. Prochaine action

**La porte de la phase 0 est franchie.** Les quatre preuves du § F.1 sont acquises : sécurité
prouvée, matrice sans case « à vérifier », décisions consignées, et **rollback exécuté et
vérifié** le 14/10 — B-13 levé en démarrant Docker et en montant une base PostGIS 17-3.5
isolée, la même image que la production.

**Mais franchir la porte a révélé un risque plus grave que celui qu'elle gardait.** La chaîne de
migrations **ne reconstruit pas la base** : 49 des 51 se rejouent sur une base vierge, un défaut
de type `uuid` contre `text` masqué depuis juillet par un `CREATE TABLE IF NOT EXISTS`. Aucun
environnement neuf ne peut être monté par `migrate deploy`, et la reprise après sinistre repose
donc entièrement sur `pg_dump`. C'est **B-16**, et l'arbitrage est **D-10**.

**Ensuite**, par ordre de valeur et sans dépendre d'une décision institutionnelle :

1. ~~Map-matching de trace HMM~~ — **fait le 14/10** : `geo/appariement.trace.ts`, 25 tests,
   critère **A18 mesuré à 130/130** sur 4 traces annotées. Reste le graphe de réseau, sans lequel
   le HMM retombe sur la distance seule entre tronçons différents.
2. ~~Vue dérivée des sections fixes~~ — **fait le 14/10** : `reseau_sections_fixes`, 14
   assertions SQL, critère **B11** tenu sur ses deux moitiés mesurables. Aucune table créée, donc
   la saisie au niveau section est impossible et non seulement interdite. La **note UEMOA
   (IO-03) reste absente**, faute du texte de la directive. Et le banc d'essai a révélé un défaut
   que la correction `20261014200000` répare : la contrainte d'exclusion de `portions` ignorait
   l'axe terrain, donc la bitemporalité était inexploitable en base.
3. **Benchmark cartographique sur les 261 387 tronçons** — l'arbitrage D3 en fait une « porte de
   décision ». Tant qu'il n'existe pas, « Leaflet suffit » est une hypothèse.
4. ~~TI-01, tâches internes~~ — **fait le 14/10** : `taches_internes`, 9 contraintes `CHECK`,
   22 assertions SQL, 17 tests de garde-fou. **A29 est tenu par la base**, et la frontière
   DigitalRoad par l'absence des colonnes — garde-fou éprouvé par injection. TI-02 reste bloqué
   faute de données DigitalRoad, TI-03 est un document.

**Donc, désormais** :

1. **Benchmark cartographique** (D3) — « porte de décision » du mandat, mais **bloqué par les
   données** : la base de développement est vide et la production gelée. Il faudrait soit une
   autorisation de lecture, soit un jeu synthétique de 261 387 tronçons, dont la valeur
   probante serait moindre.
2. ~~TI-03~~ — **fait le 14/10** : `DATA_SOURCE_OF_TRUTH.md`, sept rubriques par champ, **quatre
   contradictions nommées** (objets contractuels en deux copies, documents locaux contre
   SharePoint, `users` contre « aucun second annuaire », BITUME partout contre 29 chantiers
   « en terre »). Et une correction : **une intégration sortante existe**, l'API publique étant
   lue par l'intranet SharePoint depuis le 06/10.
3. ~~Les 15 livrables du § B.6~~ — **écrits le 14/10**, dans l'ordre du mandat. Tous étiquetés
   « proposition » là où ils recommandent ; `BDR_FIELD_MAPPING_TEMPLATE.csv` **vide par
   construction** (§ B.6) ; aucune fonction décrite comme existante sans l'être. Deux faits
   corrigés en les écrivant : `signalements_citoyens` **existe** avec trois canaux et un chemin
   `CONVERTI_OT` vers le module gelé ; et `troncons` porte des nombres **orphelins**
   (`coutRehabEstime`, `criticiteStrategique`) sans méthode ni version.

**Les trois actions suivantes, faites le 14/10 au soir** :

1. ~~Le pivot ouvert et l'importateur~~ — `src/import/pivot.noyau.ts` sans aucun import, CSV et
   GeoJSON, SRID 4326 seul, 24 tests ; tables `lots_import` / `lignes_import` où **A28 est tenu
   par la base** (somme des statuts contrainte, empreinte unique par source), 9 assertions.
   **GeoPackage en écart consigné** : aucune dépendance SQLite, et en ajouter une serait une
   décision prise en passant. L'orchestration (service, route) reste à écrire.
2. ~~Lire les pages sources~~ — six pages lues. **Trois corrections** à l'analyse ONR : L²R
   **a été déployé** à l'ONR (L²R Base remplace Visage en juillet 2018, 7 351 km décrits) ;
   l'ONR parle lui-même de sections « homogènes » ; le TDR fait de la nomenclature une entrée
   « donnée par le gestionnaire », ce qui nuance l'hypothèse du § B.1. Et deux absences : ONR et
   AGEROUTE **absents** des deux articles sur l'atelier ANASUR Collect ; l'éditeur d'ANASUR
   Collect absent des deux.
3. ~~Le catalogue des traitements~~ — mais **depuis les barèmes, pas depuis les matrices** :
   `matrices_degradation` sont les **lois de vieillissement** (probabilités markoviennes par
   revêtement × trafic), ce que ma conception de l'après-midi avait manqué. Trois traitements,
   neuf conditions, **rien d'inventé** — durée de vie, effet, fenêtre, trafic nuls — et un défaut
   trouvé par le banc d'essai : `UNIQUE` ignorait les `NULL`, corrigé par `NULLS NOT DISTINCT`.

4. ~~L'orchestration de l'import, étape 1~~ — **fait le 14/10 au soir** : `import.service.ts` et
   `/api/v2/imports`, 14 tests. L'empreinte est calculée **sur les octets reçus**, jamais fournie ;
   le même fichier renvoyé rend le lot existant **sans aucune écriture, pas même un audit** ;
   chaque ligne finit `VALIDEE`, `REJETEE` ou `IGNOREE` (doublon interne au lot, la première
   conservée) ; un CRS refusé donne un lot `REJETE` **enregistré avec son motif**, pas un 400 ;
   les erreurs s'exportent en CSV avec la charge originale. **Aucune fonction d'application
   n'est exportée** : une promesse dans une API est une dette. Et un statut `VALIDEE` ajouté à
   la migration **pendant qu'elle est encore en attente**, pour ne pas avoir à mentir entre
   « importée » et « rejetée ».

5. ~~Le garde-fou de transition~~ — **fait le 14/10 au soir** : `programmation/cycle-vie.noyau.ts`,
   sans aucun import, 18 tests. Les huit statuts du § 7.7 ; les quatre statuts post-`TRANSMIS`
   exigent une **origine externe identifiée** — un message DigitalRoad, ou pour `ÉVALUÉ`
   l'inspection post-travaux d'AGEROUTE — et **aucun chemin n'y mène depuis le Géoportail**. La
   version figée est exigée à la transmission ; rien ne recule après. Un test balaie tout le code
   backend : aucun fichier ne pose un statut reçu à la main. Écrit **avant la table**, comme le
   noyau d'appariement l'a été avant l'écran de roulage : le jour où la programmation existera,
   la route ne pourra pas inventer un passage en exécution, la fonction ne le lui donnera pas.
6. ~~Un écran de suivi des lots~~ — **fait le 14/10 au soir** : `/imports` dans la console, rôles
   ADMIN et GESTIONNAIRE, 10 tests. Réception multipart, liste, détail, erreurs téléchargeables
   par l'API authentifiée. L'écran dit ce que l'API dit : **recevoir n'est pas importer**, un
   fichier déjà reçu n'écrit rien, un lot rejeté est un résultat avec son motif. **Non vérifié
   dans un navigateur** : le backend local exige un `.env` qui n'existe pas sur ce poste.

**Ce qui reste actionnable sans accès ni décision** :

1. **Poser à l'ONR, par le canal institutionnel**, les deux questions que les pages ont fait
   naître : L²R Base est-il toujours la base nationale, et ANASUR Collect l'alimente-t-il ou s'y
   substitue-t-il ?
2. **Un `.env` local de développement** (valeurs jetables, jamais commitées) pour vérifier les
   écrans dans un navigateur contre la base PostGIS isolée — aujourd'hui, tout le frontend n'est
   éprouvé que par ses 304 tests.
3. **La fiche d'intervention** (table + route) sur le garde-fou existant — mais elle n'a de sens
   qu'après D-07, sinon ses coûts estimés n'auraient ni millésime ni largeur.

**Ce qui attend un échantillon approuvé** : l'étape 2 de l'import — le rapprochement des
identifiants et la création de propositions `A_VALIDER`. Elle ne doit pas être écrite avant :
sans rapprochement, elle créerait des objets sans lien avec le référentiel, c'est-à-dire les
doublons que le § B.4 interdit.

Le constat du § 2 continue de dominer : rien de tout cela ne produira d'indicateur tant qu'aucune
donnée de terrain n'entre.

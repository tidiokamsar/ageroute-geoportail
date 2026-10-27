# Simulateur budgétaire et scénarios (aide à la décision, lot 4)

Branche `feat/aide-decision`. Ce document décrit ce que le simulateur calcule, ce qu'il refuse, ses paramètres PROVISOIRES, son API et ce qui n'est pas vérifié. Une simulation est **consultative et non engageante** : elle ne constitue ni une autorisation de dépense ni un ordre de travaux. Aucun résultat n'est officiel tant que les paramètres, les barèmes et la logique ne sont pas approuvés par le métier.

## 1. Principes

1. **Le simulateur bâtit sur le moteur v2** (`programmation/scenario.noyau.ts`, tables `scenarios_programmation`, `parametres_programmation`). Aucun second moteur, aucun second référentiel, aucune migration.
2. **Aucune écriture dans les données officielles** (AD-08). La seule table écrite est `scenarios_programmation` (et l'audit). Le banc le prouve par un déclencheur « fil » qui lève une exception à la moindre écriture dans `programmes_budgetaires`, `chantiers`, `marches`, `decomptes`, `baremes_intervention` (et sept autres tables : catalogue, conditions, matrices, tronçons, points noirs, paramètres, régions) pendant que le banc simule, enregistre, compare, exporte, rejoue et supprime.
3. **Aucun coup de pouce silencieux.** Une contrainte impossible est rendue dans `contraintesInsatisfaisables` ; l'enveloppe n'est jamais dépassée, un coût n'est jamais raccourci, un manque n'est jamais comblé (cahier 7.2 : « ne pas ajuster les coûts silencieusement »).
4. **Un coût manquant ou périmé n'est pas simulé comme fiable** (AD-09). L'intervention est écartée avec son motif (`COUT_NON_ESTIMABLE`, `COUT_PERIME`), son coût n'est pas valorisé, l'avertissement est en évidence, et le déficit est dit **minorant**.
5. **Tout montant est un BigInt en entrée et une chaîne de chiffres en sortie** (GNF au-delà de 2^53). Aucun flottant sur un montant ; les proportions des barres se calculent en BigInt côté frontend.

## 2. Ce que le simulateur calcule

Entrées : enveloppe (GNF entiers, non négative, 18 chiffres au plus), période (`debut`, `fin`, jours réels, l'année du début est l'année du programme), logique de priorité, périmètre (région, classe, sélection d'interventions), barèmes, contraintes, version des paramètres.

Pour chaque tronçon candidat, le noyau fait ce que fait le moteur v2 (risque, traitement, coût par barème, projection de dégradation) puis **la sélection change** : obligatoires, plancher régional, ordre d'arbitrage (`contraintes.noyau.ts`).

### 2.1 Logiques de priorité (`logiques.noyau.ts`)

| Code | Règle | Statut |
|---|---|---|
| `ratio_cout_impact` | risque attendu / coût décroissant (produit croisé exact en BigInt) ; départage : risque courant, coût croissant, code, identifiant | historique (identique à `construireScenario`, test d'équivalence sur 400 tronçons) |
| `urgence` | état décroissant (CRITIQUE, MAUVAIS, MOYEN, BON), puis aggravation attendue (risque attendu moins risque courant), puis risque courant, coût, code, identifiant | **PROVISOIRE** : aucune ancienneté de défaut ni date de constat n'existe dans le modèle |
| `criticite` | risque courant décroissant sans le coût, puis risque attendu, coût, code, identifiant | non provisoire (même indice que la priorité technique du moteur) |
| `equilibre_territorial` | plancher de dépense par région, puis ratio (règle 2.2) | **PROVISOIRE** |
| `personnalise` | liste d'identifiants de tronçons fournie (sans doublon, tous candidats) ; les non listés passent après, par ratio | non provisoire |

Tous les ordres sont **totaux** : mélanger l'entrée ne change pas la sortie.

**Priorité technique et ordre d'arbitrage sont deux champs distincts de chaque ligne** (`simulation.prioriteTechnique`, `simulation.ordreArbitrage`). Le simulateur n'écrit jamais la priorité technique : il l'affiche. **Interface attendue du lot 3** : `entrees.simulation.rangsTechniques`, un objet `{ "<idTroncon>": rang }` (rang >= 1, 1 = le plus prioritaire) fourni par `priorite*.ts` ; absent, la ligne affiche le rang du moteur v2 (risque courant décroissant, `source = "moteur_v2_risque_courant"`) ; présent, `source = "lot3_priorite_technique"` et un tronçon sans rang affiche `null` (jamais une valeur inventée). Les rangs fournis n'influencent pas l'ordre d'arbitrage. Branchement à faire côté service par l'orchestrateur : `comparaison.service.preparerEntrees` pose `rangsTechniques: null` aujourd'hui.

### 2.2 Contraintes (`contraintes.noyau.ts`)

Ordre de traitement : (1) obligatoires, (2) plancher régional, (3) ordre d'arbitrage. Chaque ligne retenue porte sa phase.

* **Interventions obligatoires** : examinées en premier, dans l'ordre d'arbitrage. Une obligatoire qui ne tient pas (enveloppe ou plafond régional) n'est **pas retenue** : elle est écartée avec son vrai motif et rendue en `OBLIGATOIRE_NON_FINANCEE`. Sans coût fiable : `OBLIGATOIRE_NON_CHIFFRABLE` (avec la cause : `COUT_NON_ESTIMABLE`, `COUT_PERIME`, `RISQUE_NON_CALCULABLE`...). Absente des candidats : `OBLIGATOIRE_HORS_CANDIDATS`. Limite : une obligatoire sans risque calculable n'est pas financée (le coût n'est calculé qu'après le risque).
* **Coûts non divisibles** : le moteur n'a pas de portion, donc une intervention n'est jamais fractionnée. En plus, un **groupe non divisible** est un ensemble de tronçons financé en entier ou pas du tout ; son coût est la somme de ses membres ; un membre non chiffrable ou absent écarte tout le groupe (`EXCLUE_CONTRAINTE`) ; un groupe qui contient une obligatoire est obligatoire en entier. **PROVISOIRE** : « non divisible » n'est pas défini par le cahier au-delà de son nom.
* **Plafonds régionaux** : plafond de dépense par région (existant), appliqué à la somme d'un groupe.
* **Périmètres** : région et classe de route (filtres du chargement des candidats), sélection d'un sous-ensemble d'interventions. Une sélection hors périmètre est refusée (`SELECTION_INVALIDE`) avec le même message qu'un identifiant inexistant.
* **Règles de financement** : **non modélisées**. Aucune règle de financement n'existe dans le modèle de données (source de financement en texte libre sur le chantier, clé étrangère sur le marché). Le simulateur le dit (`limites`, écran).
* **Équilibre territorial** (règle explicite, testée) : soit p la part minimale (entier de 1 à 100) et E l'enveloppe ; le plancher d'une région est `floor(E x p / 100)`. Pour chaque région candidate, par numéro croissant, tant que sa dépense (obligatoires comprises) est inférieure à son plancher, on retient la prochaine intervention de la région dans l'ordre ratio qui tient dans le reste et les plafonds. Le plancher peut être **dépassé** par la dernière intervention retenue (un coût ne se divise pas) : c'est un minimum. Une intervention qui ne tient pas n'est pas écartée à ce stade, elle est re-examinée à l'étape 3. Le plancher est un classement prioritaire, pas un budget bloqué. Une région qui ne l'atteint pas (pas assez de candidats chiffrables, enveloppe épuisée par les régions précédentes) est rendue en `EQUILIBRE_NON_ATTEINT` ou `EQUILIBRE_REGION_SANS_CANDIDAT_CHIFFRABLE`. p x (nombre de régions) <= 100 sinon les entrées sont refusées. Les tronçons sans région ne participent pas aux planchers. Limite connue : les régions sont traitées par numéro croissant, une région peut épuiser l'enveloppe au détriment des suivantes ; c'est dit, pas corrigé.

### 2.2 bis Chargement des candidats : une seule règle avec la liste priorisée (revue du 27/10/2026)

`moteur.depot.chargerCandidats` (simulateur, moteur v2, plan pluriannuel) reprenait l'ancien chargement : `CASE WHEN EXISTS (registre non vide) ... ELSE NULL` donnait **0 point noir à tout tronçon sans point noir** dès que le registre national n'était pas vide, et comptait les alertes `A_VALIDER` et les points rejetés. La liste de priorités (lot 3) appliquait la bonne règle, donc le simulateur et la liste donnaient deux risques différents pour un même tronçon. Le dépôt relève maintenant trois comptes (confirmés du tronçon, non confirmés, confirmés du registre de la **région**) et applique **`resoudreSecurite`** : zéro n'est une donnée que si le registre de la région compte au moins `registrePointsNoirsMinimum` points confirmés (minimum de la version de paramètres, 5 en amorçage, PROVISOIRE), sinon le facteur est absent. La longueur passe par `candidatDepuisMesures`, la même fonction que la liste (colonne métier si positive, sinon géométrie, avec l'origine ; le drapeau « dérivée » de `valeurs_qualite` est conservé pour l'affichage). **Effet à connaître** : un tronçon dont la région n'a pas de registre exploité n'a plus de facteur sécurité, donc souvent moins de trois facteurs disponibles : il est écarté `RISQUE_NON_CALCULABLE` (motif donné), au lieu d'être classé avec un zéro inventé. Sur le réseau réel, où le registre est petit, beaucoup de tronçons seront dans ce cas : c'est l'état des données. Les scénarios déjà scellés ne bougent pas (ils rejouent leurs propres entrées stockées ; le chargement ne change que les nouveaux calculs). Preuves : `moteur.depot.candidats.test.ts` (équivalence liste / simulateur sur un jeu mixte), banc `aide-decision-priorites` (même équivalence sur PostGIS réel).

### 2.3 Bilan et déficit (`deficit.noyau.ts`)

* `consomme` = somme des coûts retenus ; `reste` = enveloppe moins consommé (jamais négatif).
* `besoinTotal` = somme des coûts **fiables** de tous les candidats chiffrables (retenus ou non).
* `deficit` = besoin moins enveloppe si positif, sinon `0` ; `excedent` symétrique ; `solde` = enveloppe moins besoin, **signé** (`"-3700000000"`), jamais masqué par un maximum avec zéro.
* `deficitMinorant` est vrai (et `nbCoutsNonFiables` > 0) quand des candidats n'ont pas de coût fiable : le besoin réel est au moins celui affiché. Un déficit nul avec des coûts inconnus ne veut pas dire « tout est financé ».
* Cas testés à la main : enveloppe nulle, négative (refusée), exactement égale au besoin, un franc de moins (déficit 1, solde -1), deficit, coût manquant, coût périmé.

### 2.4 Période, coûts périmés et version des barèmes (`comparaison.baremes.noyau.ts`)

* La **période** est explicite (`periode.debut`, `periode.fin`) et stockée dans les entrées scellées. L'enveloppe couvre toute la période ; aucune répartition annuelle (voir le plan pluriannuel).
* Un coût est **périmé** si la fenêtre de validité de sa ligne de barème (`validDe`, `validA`) ne couvre pas toute la période. Une borne absente ne périme pas (on ne devine pas de date). Convention **PROVISOIRE** (couverture totale exigée).
* Le chargeur (`comparaison.depot.chargerBaremesSimulation`) choisit, par (famille, état, type), la version qui couvre la période (la plus récente) ; à défaut la dernière version, qui sera déclarée périmée : un coût périmé est signalé, pas retiré en silence. `baremeIds` restreint le choix aux lignes désignées.
* **Version des barèmes = identifiant stable** : `simulation.baremes = { empreinte, liste }` ; la liste porte, pour chaque ligne, id, code, version, famille, état, type, coût au km, unité, devise, millésime, approbation, fenêtre de validité ; `empreinte` est le SHA-256 de cette liste canonique. Elle est enregistrée dans les entrées scellées, recalculée à chaque validation (liste retouchée ou empreinte fausse = refus), et elle suit la base (banc : une version 2 insérée change l'empreinte, l'ancien scénario se rejoue toujours identique).

## 3. Rétrocompatibilité (`scenario.noyau.ts`)

Le champ `EntreesScenario.simulation` est **optionnel et versionné** (`version: 1`). Absent, `construireScenario`, `entreesVersJson` et `entreesDepuisJson` produisent les **mêmes octets qu'avant** : un scénario déjà scellé se rejoue identique. Preuve : `contraintes.retrocompat.test.ts` épingle les empreintes SHA-256 (entrées et résultat) de sept scénarios relevées **avant** toute modification du noyau (commit `1af3e6e`) ; le banc rejoue un scénario hérité créé par le service historique. Présent, le résultat porte un bloc `simulation` (bilan, avertissements, contraintes, kilomètres, risque couvert, distribution régionale, version des barèmes) et des codes d'exclusion supplémentaires (`COUT_PERIME`, `EXCLUE_CONTRAINTE`). Le rejeu générique (`moteur.service.rejouer`) fonctionne pour les deux familles sans modification.

Modification hors liste, nécessaire : `scenario.noyau.test.ts` énumère les imports autorisés du noyau (« n'importe que des noyaux purs ») ; quatre noyaux voisins purs y sont ajoutés (`comparaison.baremes.noyau`, `contraintes.noyau`, `deficit.noyau`, `logiques.noyau`).

## 4. API (`api-v2/aide-decision.scenarios.routes.ts`, monté par l'orchestrateur sous `/api/v2/aide-decision`)

Gardes, dans cet ordre : authentification, modules `decision` ET `programmation`, rôle, ressource désignée (404 identique si inexistante, supprimée, hors périmètre ou mal formée), validation (400), service.

| Route | Droit | Rôle |
|---|---|---|
| `GET /scenarios/options?debut&fin` | lecture | logiques, versions de paramètres, barèmes avec statut et couverture de la période, mention |
| `GET /scenarios/candidats?regionId&classe` | lecture ; compte régional : région de son périmètre obligatoire | interventions candidates (longueur métier et géométrique séparées ; une colonne `longueurKm` dérivée de la géométrie porte `longueurMetierDerivee: true`) |
| `POST /scenarios/simuler` | ADMIN, GESTIONNAIRE ; périmètre (calcul national refusé à un compte régional, 403) | calcule **sans rien écrire** |
| `POST /scenarios` | idem | calcule et enregistre (audit `CREATE ScenarioProgrammation`, `origine = simulateur`) |
| `GET /scenarios?annee&q&logique&page&pageSize` | lecture, filtrée par périmètre | période, logique, déficit lus dans les textes scellés (nuls pour un scénario hérité) |
| `POST /scenarios/comparer` `{ ids }` (2 à 5) | lecture | tableau côte à côte ; aucune écriture |
| `GET /scenarios/:id` | lecture, 404 masqué | résumé, résultat, options relues du texte scellé |
| `POST /scenarios/:id/rejouer` | lecture, 404 masqué | recalcule depuis les seules entrées et compare octet pour octet |
| `POST /scenarios/:id/supprimer` | ADMIN, GESTIONNAIRE | suppression logique (refusée si une fiche figée le cite), auditée |
| `GET /scenarios/:id/export?format=csv\|json` | module `rapports` ET rôle ADMIN ou GESTIONNAIRE ; **montants retirés sans le droit sur les montants contractuels** (§6) | export journalisé, `Cache-Control: no-store` |

Corps strict : un champ inconnu, une enveloppe négative, décimale, en nombre, vide ou de plus de 18 chiffres, une date impossible (31 février), une période inversée, une part d'équilibre hors de 1 à 100, un groupe d'un seul tronçon : **400**. Un refus métier (périmètre trop large, sélection hors périmètre, planchers cumulés supérieurs à 100 %, ordre personnalisé inconnu) : **422**. Comparaison de périodes ou de devises différentes : **422** `PERIODES_INCOMPATIBLES` / `DEVISES_INCOMPATIBLES` avec un message ; scénario hérité : **422** `SCENARIO_SANS_SIMULATION`.

## 5. Comparaison (`comparaison.noyau.ts`)

2 à 5 scénarios de même période et de même devise, sinon refus. **Périmètre** : la région, la classe de route et la sélection d'interventions de chaque scénario sont des hypothèses comparées (lignes `region`, `classe`, `selection`) ; quand elles diffèrent, la réponse porte `perimetresIdentiques: false` et un avertissement (`avertissements`) : ce n'est pas un refus, comparer la région 1 à la région 2 est légitime, mais les déficits et les nombres d'interventions ne portent pas sur les mêmes tronçons. Un périmètre non lisible est dit « non précisé », jamais lu comme national (revue du 27/10/2026). Le tableau donne : enveloppe, consommé, reste, besoin, déficit (signé, minorant), nombre d'interventions, kilomètres (longueur **métier** ; si absente : « longueur métier absente », la géométrique est donnée à part et jamais substituée), risque couvert, distribution régionale, exclusions par motif, versions des paramètres et des barèmes, contraintes insatisfaisables, et les **hypothèses qui diffèrent** (logique, enveloppe, paramètres, barèmes, plafonds, obligatoires, groupes, équilibre, ordre, candidats). Plus : nombre d'interventions communes à tous et propres à chacun. Aucun classement ni score n'est inventé.

## 6. Export (`export-scenario.noyau.ts`)

Contenu : la **mention** « SIMULATION NON ENGAGEANTE : ne constitue ni une autorisation de dépense ni un ordre de travaux. » en première ligne/clé, date de génération, auteur de l'export (session), auteur et date du scénario, filtres demandés et territoire appliqué, unités, versions (méthode, paramètres, barèmes avec empreinte et liste), hypothèses, définitions des termes, avertissements, bilan, contraintes insatisfaisables, une ligne par tronçon. CSV : point-virgule, BOM UTF-8, neutralisation des formules (`=`, `+`, `-`, `@`, tabulation, retour chariot ; un nombre pur comme `-1200` reste intact). JSON : `format = "ad-simulation-export"`, `version = 1`. Le frontend refuse de remettre un export qui ne porte pas la mention.

**Journal d'export** : écrit par le service dans la transaction (`audit_logs`, `entityType = ExportScenario`, `action = CREATE`, `after = { format, genereLe, scenario, periode, perimetre, territoire, nbLignes, provisoire }`). Sans trace, pas d'export.

**Droit financier (revue du 27/10/2026).** L'export applique la **même règle de retrait que `POST /exports`** : sans le droit sur les montants contractuels (`droitMontantsContractuels`, ADMIN ou module `marches` ou `chantiers`, voir `SECURITE.md` §6), aucun montant ne sort : ni enveloppe, ni bilan, ni coût, ni reste, ni plafond, ni prix de barème, ni texte qui cite un montant (justification, détail d'un motif ou d'une contrainte, message de déficit). Le fichier le dit (`droitFinancier`, `champsFinanciersRetires`, ligne « Droit financier » du CSV) et porte, comme tous les exports du module, la mention consultative (`mentionConsultative`) en plus de « SIMULATION NON ENGAGEANTE ». L'audit d'export enregistre le droit et le nombre de champs retirés. L'écran de simulation, lui, reste lisible par `decision` + `programmation` : écart signalé à trancher (SECURITE.md §7).

**Compatibilité avec le moteur d'export du lot 6** : `construireExport(scenario, meta)` rend un objet JSON stable que le moteur général peut embarquer ou rendre en PDF ; `versCsv(export)` est la forme tableur ; la route peut être remplacée par un appel à `POST /exports` sans toucher au noyau. Le droit d'export (module `rapports` + rôle) est celui du contrat AD §2. **Décision nécessaire** : le contrat §6 demande « aucune colonne financière pour un compte sans droit financier » ; ce droit est maintenant défini, à titre PROVISOIRE, par `droitMontantsContractuels` (D-C1-1). Les montants d'un export de scénario sont des **estimations de simulation** (pas des montants contractuels), servis aux rôles ADMIN et GESTIONNAIRE ayant le module `rapports`.

## 7. Ancienne chaîne à retirer à la recette (non supprimée par ce lot)

`POST /api/simulateur/budget` (enveloppe par défaut de 2000 Md inventée) et le simulateur client de l'ancienne `DecisionPage` (curseur, formule maison, pied de page « 800 M GNF/km »). L'écran `/programmation/moteur` (`MoteurProgrammationPage`) reste l'écran du scénario annuel historique ; les onglets `OngletSimulation` et `OngletScenarios` le remplacent pour la simulation, et réutilisent ses composants (`LignesScenario`/`DetailLigne`, `BandeauProvisoire`, `PerimetreChamps`).

## 8. Ce qui n'est pas vérifié

* Aucun jeu de données de production n'a été lu. Les bancs tournent sur un clone de `replay` (vide) avec des tronçons écrits pour eux ; le comportement et la durée sur 261 387 tronçons ne sont pas mesurés. Plafond : 3000 candidats par simulation.
* Le résultat sur le réseau réel est **inconnu** : il dépend des facteurs réellement disponibles. Tant que seul l'état est renseigné, la plupart des tronçons seront écartés `RISQUE_NON_CALCULABLE` (refus motivés, jamais de valeur inventée).
* Les définitions de « urgence », « non divisible », « équilibre territorial » et la règle de péremption sont des conventions provisoires, à valider.
* Aucune optimisation (PLNE) : l'algorithme reste glouton.
* Le workflow de **validation** d'un scénario (distinct, sans engagement automatique) n'est pas construit ici : un scénario n'a pas de statut d'approbation.
* Le lot 3 (`priorite*.ts`) n'est pas branché : voir 2.1.
* (revue du 27/10/2026) Le total de kilomètres « métier » d'un résultat de simulation (`kilometres.metierKm`) additionne encore les longueurs d'origine `LONGUEUR_KM`, y compris celles que `valeurs_qualite` dit dérivées de la géométrie : le drapeau `longueurMetierDerivee` n'est pas sérialisé dans les entrées scellées (c'est ce qui garde les empreintes inchangées) et n'est exposé que par `GET /scenarios/candidats`. Le rendre exact dans les résultats exigerait un champ versionné des candidats.
* (revue du 27/10/2026) Les scénarios scellés avant cette date ont été calculés avec l'ancienne règle des points noirs (zéro dès que le registre national n'était pas vide). Leur rejeu est inchangé, mais leur ordre peut différer de celui de la liste priorisée pour les tronçons concernés.

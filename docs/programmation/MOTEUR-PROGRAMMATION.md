# Moteur de risque et de programmation (§ 7.7, scénario A22)

Rédigé le 22/10/2026. Ce document décrit ce qui est **calculé**, les paramètres **provisoires**, ce qui
**reste à approuver** et ce qui **n'est pas vérifié**. Rien ici n'est officiel : « aucun calcul normatif
n'est activé comme officiel avant approbation des paramètres » (§ 7.7). Conception d'origine :
[MAINTENANCE_PROGRAMMING_DESIGN.md](../../MAINTENANCE_PROGRAMMING_DESIGN.md).

## 1. Ce qui est calculé

Une simulation prend un millésime, une enveloppe budgétaire en GNF et un périmètre (région, classe de
route). Elle lit les tronçons candidats (réseau classé de référence, non supprimés, ni rejetés ni à
corriger) et, pour chacun :

| Étape | Module | Règle |
|---|---|---|
| Risque | `engines/risque.noyau.ts` | somme pondérée renormalisée des facteurs **disponibles** : état, trafic ou importance, sécurité (points noirs), climat, population. Valeurs normalisées sur 0 à 100 et arrondies à 4 décimales avant agrégation. |
| Traitement | `engines/traitement.noyau.ts` | `conditions_traitement` (famille de coût, état, classe de trafic) vers `catalogue_traitements`. La matrice est une fonction : deux traitements possibles = refus. |
| Coût | `engines/cout.noyau.ts` (inchangé) | quantités du référentiel x barème, BigInt, classe de précision `RESEAU_30`. **Refuse** sans ligne de barème. |
| Projection | `engines/traitement.noyau.ts` | `matrices_degradation` : probabilité annuelle de passer à l'état suivant (CRITIQUE est absorbant), sur l'horizon des paramètres. Absente sans comptage de trafic. |
| Risque attendu | `programmation/scenario.noyau.ts` | `risque + p(horizon) x (risque à l'état suivant - risque)` ; sans projection, risque attendu = risque courant. |
| Classement et enveloppe | `programmation/scenario.noyau.ts` | rapport `risque attendu / coût` décroissant, comparé **exactement** en BigInt (produit croisé). Départage : risque courant décroissant, coût croissant, code croissant, identifiant croissant. Glouton : un tronçon trop cher est écarté (`BUDGET_INSUFFISANT`), les suivants restent examinés. Plafond régional optionnel (`PLAFOND_REGIONAL`). |
| Fiche | `programmation/fiche.noyau.ts` | une fiche par ligne **retenue** : JSON canonique sans horodatage, empreinte SHA-256. |

Chaque ligne, retenue ou écartée, porte : ses entrées, le détail des facteurs, les formules en clair, le
traitement et sa condition, le coût et son calcul, la version des paramètres, un motif d'exclusion
(`RISQUE_NON_CALCULABLE`, `SOUS_SEUIL_RISQUE`, `AUCUN_TRAITEMENT`, `COUT_NON_ESTIMABLE`,
`BUDGET_INSUFFISANT`, `PLAFOND_REGIONAL`), une phrase de justification et l'étiquette
« PROVISOIRE, non approuvé » tant que l'une des briques n'est pas approuvée.

**Le moteur refuse plutôt que de deviner.** Un état non évalué n'est pas un état bon ; une absence n'est
jamais un zéro ; sans barème, rien n'est chiffré ; sans comptage de trafic, aucune classe de trafic ni
projection ; avec moins de trois facteurs disponibles (valeur du paramètre), pas de risque. **En l'état de
la base, ce dernier garde-fou écarte probablement tous les tronçons** : seul l'état est renseigné (trafic,
climat et population n'ont aucune source ; le registre des points noirs n'est pas prouvé exhaustif). C'est
voulu (conception § 3.2). Baisser `facteursMinimum` est un acte de paramétrage visible et audité.

## 2. Paramètres : tous provisoires

Table `parametres_programmation`, administrable par l'API. Une version est **immuable** (déclencheur) :
modifier une valeur crée une nouvelle version. Seule l'approbation (`approuveeLe`, `approuveeParId`,
ADMIN) et la suppression logique varient. La version d'amorçage `prog-provisoire-1` est semée par la
migration, `source = amorcage_provisoire`, jamais approuvée ; son jeu de valeurs est identique à
`VALEURS_AMORCAGE_PROVISOIRES` (un test le vérifie dans le fichier SQL, le banc d'intégration en base).

| Paramètre | Valeur d'amorçage | Origine |
|---|---|---|
| Poids du risque : état, trafic ou importance, sécurité, climat, population | 40, 25, 15, 10, 10 | **sans source** |
| Correspondance état vers risque : BON, MOYEN, MAUVAIS, CRITIQUE | 10, 35, 65, 90 | complément à 100 de la correspondance du RCI arrêtée au titre de D-01 (90, 65, 35, 10), elle-même désapprouvée : **provisoire** |
| Plafond de trafic (veh/j), de points noirs, de population | 5000, 3, 100000 | **sans source** |
| Classes de trafic : T1 sous, T2 sous, sinon T3 (veh/j) | 500, 2000 | **sans source** (les matrices existantes nomment les classes, pas leurs bornes) |
| Facteurs disponibles minimum / couverture minimale du poids | 3 / 0,5 | 3 : proposition de la conception ; 0,5 : **sans source** |
| Horizon de projection | 1 an | PAE annuel |
| Seuil de risque minimal | aucun (`null`) | aucun seuil inventé |

Le scénario est provisoire dès qu'un maillon l'est : paramètres non approuvés, ligne de barème non
approuvée / sans millésime / sans largeur, traitement du catalogue non approuvé, matrice de dégradation non
approuvée, longueur calculée sur la géométrie. Approuver les paramètres seuls ne le rend donc pas officiel.
**Version par défaut** : la version approuvée la plus récemment, sinon l'unique version ; avec plusieurs
versions provisoires et aucune approuvée, le moteur ne choisit pas (`PARAMETRES_A_PRECISER`).

## 3. Reproductibilité et fiche figée

* **Rejeu** : un scénario stocke ses entrées complètes (parametres, candidats, barèmes, catalogue,
  conditions, matrices) et son résultat sous forme canonique (clés triées, montants en chaînes, aucun
  horodatage). `POST /simulations/:id/rejouer` recalcule depuis les seules entrées stockées et compare
  octet pour octet. L'ordre des tableaux d'entrée n'a aucune influence (test dédié, 2000 candidats).
  Un rejeu différent signale que le **code** du moteur a changé depuis ; le résultat stocké reste ce qui a
  été décidé.
* **Scellé en base** : `empreinteEntrees` et `empreinteResultat` sont contraintes (CHECK) à être le SHA-256
  des textes stockés ; des CHECK exigent que budget, année, version des paramètres et totaux disent la
  même chose que le texte. Un scénario ne se modifie pas (seule la suppression logique, refusée si une fiche
  le cite).
* **Fiche** : `fiches_intervention` ne souffre ni UPDATE ni DELETE (déclencheur). Elle embarque la **copie
  intégrale** des paramètres. L'instant du gel est une colonne posée par le serveur, hors du contenu, pour
  que « mêmes entrées, même fiche » reste vrai. L'empreinte est la « version figée » qu'exige
  `cycle-vie.noyau.ts` à l'entrée en TRANSMIS.
* **Cycle de vie** : `fiches_intervention_statuts`, en ajout seul. Depuis le Géoportail, de BROUILLON à
  APPROUVE seulement. TRANSMIS, EN_EXECUTION, ACHEVE, EVALUE sont refusés par `transiter()` (403
  `ORIGINE_INTERDITE`) **et** par des contraintes de la table (origine, message ou inspection identifié,
  empreinte à la transmission).

## 4. API v2 (`/api/v2/programmation/moteur`, module `programmation`)

Lecture : tout compte du module. Écriture : ADMIN et GESTIONNAIRE ; approbation : ADMIN. Auteur pris sur la
session, jamais dans le corps ; corps `strict` ; montants en chaînes de chiffres ; chaque écriture est
auditée dans sa transaction. Aucune route PUT, PATCH ou DELETE.

`GET|POST /parametres`, `POST /parametres/:id/approuver|desapprouver`, `GET|POST /simulations`,
`GET /simulations/:id`, `POST /simulations/:id/rejouer|supprimer|fiches`, `GET /fiches`, `GET /fiches/:id`,
`GET /fiches/:id/verification`, `POST /fiches/:id/statut`. Plafond de 3000 tronçons candidats par scénario
(`PERIMETRE_TROP_LARGE` au-delà : restreindre la région ou la classe).

## 5. Ce qui reste à approuver

* **D-01 (état et indice)** : la correspondance état vers risque dérive d'une règle RCI désapprouvée ; le
  risque est un indice distinct de l'état, ce qui rejoint l'option B de `RCI_METHOD_DECISION.md`, mais
  c'est à confirmer. Le poids de chaque facteur et la forme de l'agrégation (somme pondérée et non produit)
  sont à arrêter. Aucune source n'existe pour trafic, climat, population.
* **D-07 (barèmes)** : millésime, largeur de chaussée, approbation des neuf lignes ; traitement du béton.
  Tant que D-07 n'est pas tranchée, tout montant est « estimation réseau plus ou moins 30 %, provisoire ».
* **D-02 (praticabilité)** : **non branchée**. Un niveau P3 ou P4 ne retire pas un tronçon du programme et
  n'influe sur aucun facteur ; la fenêtre de réalisation saisonnière du catalogue est nulle et non lue.
* **Catalogue des traitements** : `dureeVieAttendueAns`, `effetSurIndice`, `fenetreRealisation` sont nuls ;
  le moteur suppose qu'un traitement lève le risque qu'il traite. **Matrices de dégradation** : valeurs
  HDM-4 simplifiées à valider, pas de temps lu comme annuel (non documenté en base).

## 6. Ce qui n'est PAS vérifié

* Aucun jeu de données de production n'a été lu ni calculé. Les bancs tournent sur une base de rejeu vide
  avec des fixtures écrites pour eux ; les volumes réels (261 387 tronçons au registre complet) et les
  durées de calcul ne sont pas mesurés. Un scénario de plus de 3000 candidats est refusé.
* Le résultat sur le réseau réel est **inconnu** : il dépend des facteurs réellement disponibles.
* L'oracle SQL du banc valide l'arithmétique du moteur, pas le bien-fondé métier des coefficients.
* La portée est le tronçon entier : `portions` compte zéro ligne, donc aucune plage linéaire fine.
* Le rejeu n'est prouvé que sur le même code ; aucune comparaison inter-versions du moteur n'est faite.
* Le classement glouton n'est pas un optimum ; aucune optimisation (PLNE), aucun PPE pluriannuel, aucune
  équité régionale minimale ni enveloppes par source de financement : seulement un plafond régional optionnel.
* Aucun échange avec DigitalRoad : les statuts reçus ne sont pas alimentés (B-11), la boucle de retour
  (suivi, évaluation après travaux) n'existe pas.
* Aucune interface utilisateur (frontend) n'a été écrite pour ces routes.

## 7. Vérifications

```
cd backend && npx tsc --noEmit -p .
npx vitest run                        # 149 tests propres au moteur (noyaux et routes)
DATABASE_URL=postgresql://<utilisateur>:<motdepasse>@127.0.0.1:5434/replay npx tsx tests-integration/programmation.integration.mts
docker exec <conteneur> bash <chemin>/prisma/descentes/verifier.sh --seulement 20261023100000_moteur_programmation
```

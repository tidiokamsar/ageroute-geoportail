# État du projet au 14/10/2026

Livrable demandé par l'addendum V4.1. Chaque chiffre de ce document est mesuré contre la
production ou le dépôt, à la date indiquée. Rien n'y est estimé.

## 1. Ce qui est en production, et vérifié

| Élément | État |
|---|---|
| Domaine | `carte.ageroute.gov.gn`, HTTP 200 |
| Déploiement | 13/10/2026, images construites à 18:17:26, conteneurs démarrés à 18:19:27 |
| Migrations | **48 dossiers, toutes appliquées**, « Database schema is up to date! » |
| Santé | `/api/health` 200, base 8 ms, stockage 4 ms, `echecsDepuisDemarrage` **0** |
| Journal backend | **0 erreur** depuis le redémarrage |
| API publique | `/api/public/carte/geo` 200, 785 Ko en 0,36 s |
| PWA | `/sw.js` 200 |
| Routes protégées | `/api/v2/portions`, `/qualite/anomalies`, `/sync/status`, `/referentiels`, `/missions`, `/observations`, `/devices`, `/field/current-context`, `/defauts/catalogue` répondent **401** |

Un 401 est la bonne preuve ici : il établit que la route existe **et** qu'elle est fermée.
Un 404 aurait voulu dire non déployée.

## 2. Ce que la base contient réellement

| Table | Lignes |
|---|---|
| `troncons` | 261 387 |
| `valeurs_qualite` | 1 820 694 |
| `ouvrages` | 1 172 |
| `chantiers` | 496 |
| `audit_logs` | 1 491 |
| `postes` | 10 |
| `users` | 9 |
| `points_noirs` | 2 |
| `inspections` | **1** |
| `defauts` | **0** |
| `missions` | **0** |
| `observations` | **0** |
| `portions` | **0** |
| `referentiel_etats_chaussee` | **0** |
| `referentiel_revetements` | **0** |
| `referentiel_praticabilites` | **0** |
| `regles_condition` | **0** |
| `evaluations_condition` | **0** |

**C'est le constat central de ce document.** Toute la chaîne de collecte terrain est écrite,
testée, déployée — et vide. Aucune mission, aucune observation, aucun défaut, aucune portion.
Les trois référentiels configurables livrés le 13/10 sont vides. La règle RCI n'existe pas.

**Le verrou du projet n'est donc pas le code, c'est l'alimentation.** Aucun développement
supplémentaire ne produira un indicateur tant qu'aucune donnée de terrain n'entre.

### Le réseau, en deux périmètres qu'il ne faut pas confondre

| Périmètre | Tronçons | Km |
|---|---|---|
| Registre complet (`tout`) | 261 387 | 185 264,4 |
| **Réseau classé** (`reference`) | **1 691** | **21 156,6** |
| Voirie locale reprise d'OSM | 259 696 | 164 107,8 |

L'API publique publie le réseau classé. **Les 261 387 tronçons sont donc dominés à 99,4 % par
la voirie locale importée** : le réseau qui porte les statistiques officielles n'en compte que
1 691. Confondre les deux fait varier tout pourcentage d'un facteur neuf en kilomètres et de
plus de cent en nombre de tronçons — erreur que j'ai commise deux fois le 13/10, dans l'audit
hors territoire puis dans l'audit RCI, avant de la corriger.

### Les états, par périmètre

| Périmètre | Avec un état | Non évalués | Part |
|---|---|---|---|
| **Réseau classé** | **649** | 1 042 | **38,4 %** |
| Voirie locale | 6 191 | 253 505 | 2,4 % |

| État déclaré | Réseau classé | Voirie locale |
|---|---|---|
| MOYEN | 296 | 5 454 |
| MAUVAIS | **133** | 1 |
| BON | 125 | 735 |
| CRITIQUE | **95** | 1 |

**Les états dégradés sont tous dans le réseau classé**, ce qui est cohérent : 133 mauvais et
95 critiques y sont déclarés, contre un seul de chaque sur 259 696 voies locales. La campagne
de déclaration qui n'a produit que du moyen et du bon concerne la voirie locale, pas le réseau
national.

**Mais un seul état observé s'y trouve** : `RES-857`, moyen, 04/09/2026. Les trois autres
états réellement observés du pays portent des codes OSM et sont donc de la voirie locale.

## 3. Ce qui est construit mais ne peut rien produire encore

**Le RCI ne rend aucun score, et c'est le comportement correct.** `regles_condition` est vide,
donc rien n'est calculable. Même alimentée, la couverture maximale atteignable est **0,45**
pour un seuil arbitré à **0,5** : le moteur refuserait chaque score avec
`COUVERTURE_INSUFFISANTE`. Voir [AUDIT_RCI.md](AUDIT_RCI.md).

**Sur les dix composantes du modèle, une seule a une source**, et elle est faible :

| Composante | Données sur le réseau classé |
|---|---|
| CHAUSSEE | **649 états déclarés sur 1 691**, dont **un seul réellement observé** |
| OUVRAGES | 126 ouvrages lisibles sur 1 172 |
| TRAFIC, DRAINAGE, SIGNALISATION, SECURITE | **0** |
| HISTORIQUE, INCIDENTS, ENVIRONNEMENT, AUTRES | **aucune source** |

Et `troncons.dateDerniereEvaluation` est **nulle sur les 261 387 lignes** : par la règle du
moteur, les 6 840 états sont tous périmés.

## 4. Ce qui n'existe pas du tout

`backend/src/engines/` ne contient que le moteur de condition et sa collecte. **Les moteurs
Risque, Traitement, Coût et Programmation du cahier n'ont aucun code** — alors que la route
`/programmation` est déclarée dans `App.tsx`.

Une page dont le moteur n'existe pas n'est pas une fonctionnalité livrée. Un tableau de
conformité qui la compterait comme faite serait faux, et c'est le piège principal de ce genre
de document.

### Mais leurs données existent, et j'avais écrit le contraire

Mesuré le 14/10/2026. J'avais affirmé « aucune table de prix » : c'est faux.

| Table | Lignes | Contenu | Lue par du code ? |
|---|---|---|---|
| `baremes_intervention` | **9** | famille de revêtement × état de départ → type d'intervention et **coût au km en GNF** | **non** |
| `matrices_degradation` | **9** | probabilités de transition BON→MOYEN→MAUVAIS→CRITIQUE par famille et classe de trafic | **non** |

Les barèmes couvrent bitume, terre-latérite et pavé, pour les états moyen, mauvais et
critique, avec des coûts de **350 millions à 3,5 milliards GNF au kilomètre**. Les trois
moteurs aval ne partent donc pas de rien : il leur manque le code, pas les référentiels.

**Et un défaut grave s'y cache.** `BaremeIntervention` porte **cinq colonnes** — identifiant,
famille, état, type d'intervention, coût — et **ni `source`, ni `version`, ni approbation**,
là où `MatriceDegradation` trace les trois. Un coût de 3,5 milliards GNF au kilomètre que
personne ne peut attribuer est exactement le genre de nombre qui finit dans un document
officiel sans que quiconque puisse dire qui l'a fixé.

**Tracer l'origine de ces prix doit précéder l'écriture du moteur de coûts**, pas le suivre.
Le cahier exige par ailleurs qu'« une estimation de coûts ne crée jamais automatiquement un
décompte » — et la table `decomptes` existe, vide.

## 5. Les défauts mesurés, et non corrigés

**72 km de routes nationales hors territoire comptent dans le réseau classé.** Sept tronçons,
six RN4 vers Gabú et une RN1 vers le Sénégal, entre 224 m et 4 282 m hors limites.
`lib/reseau.ts` déclare depuis le 07/10/2026 un préfixe `hors_territoire:` pour les exclure :
en base, ce préfixe compte **zéro ligne**. Le mécanisme existe, il n'a jamais été appliqué.
Voir [AUDIT_TRONCONS_HORS_TERRITOIRE.md](AUDIT_TRONCONS_HORS_TERRITOIRE.md).

**Dérive Prisma préexistante.** La table `limites_admin` et treize index créés en SQL brut ne
figurent pas dans `schema.prisma`. Conséquence opérationnelle : `prisma migrate dev` ne doit
**jamais** être lancé contre la production, il proposerait de les supprimer. Seul
`migrate deploy` est admis. Voir [PLAN_MIGRATIONS_PRODUCTION.md](PLAN_MIGRATIONS_PRODUCTION.md).

**`bdri_app` est SUPERUSER et c'est le seul rôle de connexion.** Réduire ses privilèges exige
d'abord un rôle de secours, sans quoi la réduction coupe le service.
Voir [AUDIT_SECURITE_DEPOT_PUBLIC.md](AUDIT_SECURITE_DEPOT_PUBLIC.md).

## 6. Les décisions qui vous attendent

Aucune ne demande de développement. Toutes bloquent une mise en service.

| Sujet | Décision attendue |
|---|---|
| Pondérations RCI | le cahier §13 (avec signalisation 10) ou votre liste à neuf composantes (avec environnement 5 + autres 5) |
| « Autres critères » | la définir, ou retirer ses 5 points : sans définition elle est du poids mort renormalisé |
| Fraîcheur | 365 jours proposés, non arbitrés |
| Confiances acceptées | `HIGH` et `MEDIUM` proposées, non arbitrées |
| **Approbation de la règle** | **le seul geste rendant un score publiable** |
| `dateDerniereEvaluation` | doit-elle être alimentée, et par quoi — pas par `valeurs_qualite.observedAt`, qui porte des dates de reprise |
| Praticabilité | valeurs du référentiel à approuver avant usage officiel |
| Hors territoire | ne rien exclure, exclure les 7 (−0,340 %), ou exclure au-delà d'un seuil |
| Fusion `main` | la branche est en avance de **51 commits** sur le tronc |

## 7. Ce que je n'ai pas fait

**Rien n'a été appliqué sans votre arbitrage.** Aucun tronçon supprimé, aucune géométrie
modifiée, aucune `sourceReference` écrite, aucune règle approuvée, aucun seuil appliqué.

**Trois livrables des cinq décisions du 13/10 manquent encore** : les fiches de comparaison
des 42 doublons géométriques, le référentiel provisoire des 1 029 axes régionaux, et la règle
de périmètre validée. Les deux premiers sont du travail de production de documents ; le
troisième est votre décision.

**Et trois choses me sont matériellement impossibles ici** : construire un APK (ni `adb`, ni
`gradle`, ni `java` sur ce poste), vérifier les contrats d'intégration DigitalRoad (aucun
accès), et mesurer le coût d'un import de masse autrement qu'en le lançant.

## 8. Divergences avec la documentation existante

**`AGENTS.md` annonce 21 routes applicatives contre 13 déployées.** Le dépôt en déclare
aujourd'hui 29 dans `App.tsx`, dont `/login`, `/carte` et `/embed/carte` qui ne sont pas des
pages de l'application. L'écart tient surtout aux pages ajoutées le 13/10. Cette note est à
rafraîchir.

**`AGENTS.md` donne la PWA et l'API publique comme non déployées.** Elles le sont depuis le
13/10 : `/sw.js` et `/api/public/carte/geo` répondent 200.

Le dépôt porte 26 documents dans `docs/rai-v3/`, dont 19 numérotés, et 1 329 tests
automatisés (1 047 backend sur 76 fichiers, 282 frontend sur 22).

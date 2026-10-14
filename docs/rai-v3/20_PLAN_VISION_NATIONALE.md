# Plan pour la vision nationale — les dix exigences

**Rafraîchi le 14/10/2026.** Première rédaction le 13/10, avant le déploiement. Trois lignes
ont changé d'état depuis, et une mesure nouvelle déplace le verrou principal.

## Où en est chacune des dix

| # | Exigence | État au 14/10 | Ce qui existe, et ce qui manque |
|---|---|---|---|
| 1 | Historique temporel et versionné des portions | **mécanisme fait, non alimenté** | `remplaceeLe`, `portions_lignage`, `observeeLe` **déployés le 13/10** ; `portions` porte **0 ligne** |
| 2 | Contrôle qualité et détection d'incohérences | **fait** | `qualite/anomalies.ts`, **9 familles**, 23 + 14 tests, **401 en production** |
| 3 | Suivi des missions et couverture réelle inspectée | **partiel** | `missions`, `traces`, `couverture()` par tronçon ; **`missions` porte 0 ligne**, et l'agrégation réseau manque |
| 4 | Gestion complète des ouvrages et actifs | **largement fait** | `TypeOuvrage` passé de **9 à 13 valeurs** ; les 4 manques nommés le 13/10 sont comblés |
| 5 | Indicateurs état, risque, maintenance explicables | **bloqué sur décision** | RCI complet — moteur, collecte, normalisation, classes — mais `regles_condition` est **vide** et la règle **non approuvée** |
| 6 | Traitements, quantités, coûts, programmation | **un quart** | moteur de quantités dans `field/defauts.regles.ts` (49 tests) ; `traitement.ts`, `cout.ts`, `programmation.ts` **absents** |
| 7 | État avant travaux → intervention → état après | **absent** | mesuré le 14/10 : `etatAvant`/`etatApres` **0 occurrence** dans tout le dépôt |
| 8 | Alertes et listes d'actions en attente | **partiel** | `jobs/alertes-contractuelles.ts` : alertes **contractuelles**, liées aux marchés, **pas patrimoniales** |
| 9 | Architecture prête pour la vision par ordinateur | **absent** | `medias_defaut` porte un `sha256`, rien de plus |
| 10 | Intégration DigitalRoad et SharePoint | **partiel** | API publique **déployée et servante** (785 Ko en 0,36 s), carte embarquée, `PUBLIC_CORS_ORIGINS` ; contrats DigitalRoad **non vérifiables sans accès** |

Deux précisions conservées de la première rédaction, parce que je m'étais trompé en mesurant.
Les alertes **existent** mais elles sont contractuelles, pas patrimoniales. Et le moteur de
quantités **existe** : seuls les traitements, les coûts et la programmation manquent sur les
quatre que le point 6 réunit.

## Ce qui a changé depuis le 13/10

| Point | Avant | Après |
|---|---|---|
| 2 — contrôle qualité | partiel | **fait**, 9 familles déployées |
| 4 — actifs | 9 types sur les 15 demandés | **13 types**, les 4 manques nommés comblés |
| 1 — historique versionné | partiel | **mécanisme déployé**, en attente de données |
| 5 — indicateurs | partiel | **complété côté code**, bloqué sur l'approbation |

## Le graphe de dépendances

Chaque flèche est une impossibilité technique, pas une préférence.

```
GPS + troncon actif  (fait)
        v
PORTIONS HOMOGENES  (modele, table, ecriture, referentiels : DEPLOYES le 13/10)
        v
PREMIERE CAMPAGNE DE COLLECTE  <-- nous sommes ici, et c'est le verrou
   l'ecran de terrain existe, la table est vide
        v
   +----+----------------+------------------+
   v                     v                  v
(1) historique      (3) couverture     (5) indicateurs  <-- + approbation
    versionne           reelle             d'etat             de la regle
                        du reseau              v
                                        moteur de RISQUE
                                               v
                                        (6) traitements
                                               v
                                            couts
                                               v
                                        programmation
                                               v
                                        (7) etat avant/apres
                                        (8) alertes patrimoniales
```

## Les trois verrous, et aucun n'est du code

**La collecte.** C'est le changement d'analyse le plus important de ce rafraîchissement. Le
13/10, le verrou était « la qualification terrain » parce que l'écran manquait. L'écran existe
depuis, testé et déployé. Mesure du 14/10 : `portions` **0**, `missions` **0**,
`observations` **0**, `defauts` **0**. **Le verrou n'est plus l'outil, c'est son usage.** Aucun
développement supplémentaire ne produira un indicateur tant que personne n'a relevé une
portion.

**L'approbation de la règle RCI.** `regles_condition` est vide. Même peuplée, la couverture
maximale atteignable est 0,45 pour un seuil arbitré à 0,5, donc le moteur refuserait chaque
score — et c'est le comportement voulu. Les points 5, 6, 7 et 8 en dépendent en cascade.

**Les valeurs de praticabilité et le référentiel des axes régionaux.** Deux décisions de
métier que le cahier ne tranche pas.

## Ce que votre liste change dans l'architecture

Le point 7 — état avant, intervention, état après — est le seul qui demande une relation que
le modèle ne porte pas encore. Il se construit sur `portions_lignage`, déjà déployé : une
intervention lie deux versions d'une même portion, l'ancienne `remplaceeLe` et la nouvelle.
Rien n'est à inventer, mais rien n'est écrit.

Le point 9 ne demande pas de vision par ordinateur, il demande que l'architecture y soit
**prête**. Le `sha256` sur `medias_defaut` est le bon début : il rend une photo identifiable
et déduplicable. Manquent un stockage adressable et un champ de résultat d'inférence qui
distingue « non analysé » de « analysé sans détection » — la même distinction que le moteur de
condition tient entre une absence et un zéro.

## L'étape en cours

Le code de la moitié amont est fait. Ce qui reste à produire sans attendre personne est listé
dans [23_PLAN_ACHEVEMENT.md](23_PLAN_ACHEVEMENT.md), phase 0.

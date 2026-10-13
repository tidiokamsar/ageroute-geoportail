# Les dix exigences de la vision nationale, mesurées et ordonnées

Mesuré le 13/10/2026 contre le code réel. Votre bloc dit de ne pas tout implémenter
simultanément, d'identifier les dépendances et de partir du GPS, du tronçon actif, des
portions et de la qualification terrain. C'est ce que fait ce document.

## Où en est chacune des dix

| # | Exigence | État mesuré | Ce qui existe déjà |
|---|---|---|---|
| 1 | Historique temporel et versionné des portions | **partiel** | `remplaceeLe`, `portions_lignage`, `observeeLe` |
| 2 | Contrôle qualité et détection d'incohérences | **partiel** | `valeurs_qualite`, `conflits_sync`, `chevauchements()` |
| 3 | Suivi des missions et couverture réelle inspectée | **partiel** | `missions`, `traces`, `couverture()` par tronçon |
| 4 | Gestion complète des ouvrages et actifs | **partiel** | `ouvrages`, 9 types sur les 15 demandés |
| 5 | Indicateurs état, risque, maintenance explicables | **partiel** | Condition Engine écrit, non approuvé ; `indicateurs()` |
| 6 | Traitements, quantités, coûts, programmation | **un quart** | moteur de quantités dans `field/defauts.regles.ts` |
| 7 | État avant travaux → intervention → état après | **absent** | mesuré : zéro occurrence de `etatAvant`/`etatApres` |
| 8 | Alertes et listes d'actions en attente | **partiel** | `jobs/alertes-contractuelles.ts`, `marches/alertes.service.ts` |
| 9 | Architecture prête pour la vision par ordinateur | **absent** | `medias_defaut` porte un `sha256`, rien de plus |
| 10 | Intégration DigitalRoad et SharePoint | **partiel** | API publique, carte embarquée, `PUBLIC_CORS_ORIGINS` |

Deux précisions sur ce tableau, parce que je me suis trompé en le mesurant la première
fois. Les alertes **existent** mais elles sont contractuelles, liées aux marchés, pas
patrimoniales. Et le moteur de quantités **existe** : seuls les traitements, les coûts et
la programmation manquent sur les quatre que le point 6 réunit.

## Le graphe de dépendances

Rien de ce qui suit n'est un choix d'ordre arbitraire : chaque flèche est une impossibilité
technique, pas une préférence.

```
GPS + troncon actif  (fait)
        v
PORTIONS HOMOGENES  (modele, table, referentiels : faits)
        v
QUALIFICATION TERRAIN  <-- nous sommes ici
   API de contexte, ecriture de portions, decoupage, fusion
        v
   +----+----------------+------------------+
   v                     v                  v
(1) historique      (3) couverture     (5) indicateurs
    versionne           reelle             d'etat
                        du reseau              v
                                        (6) traitements
                                            puis couts
                                                v
                                        (6) programmation
                                                v
                                        (7) avant / apres travaux
```

Et hors de cette chaîne, parce qu'ils n'en dépendent pas :

- **(2) le contrôle qualité** peut avancer dès maintenant : il travaille sur des données
  qui existent déjà, et `chevauchements()` en est le premier morceau.
- **(4) les quatre familles d'actifs manquantes** (fossés, caniveaux, signalisation,
  glissières) sont une migration additive indépendante.
- **(8) les alertes patrimoniales** attendent les indicateurs : une alerte sur un état
  qu'on ne calcule pas encore n'aurait rien à annoncer.
- **(9) la vision par ordinateur** attend surtout un corpus de photos qualifiées, donc la
  qualification terrain tournant pour de vrai.
- **(10) l'intégration** est une affaire de contrats d'API, pas de modèle.

## Les trois verrous, et aucun n'est du code

**Les coefficients du RCI.** Sans eux, pas d'indicateur d'état publiable, donc pas de
risque, pas de traitement, pas de programmation. Le point 5 commande les points 6 et 7.

**Les valeurs de praticabilité.** Le référentiel existe et sort vide, le cahier n'en énonce
aucune valeur. Aucune portion ne peut en porter avant votre décision.

**Le répertoire des routes régionales.** 1 029 tronçons régionaux portent 1 029 noms
distincts sans structure de route : leurs PK ne sont pas calculables. L'abscisse locale
contourne le problème pour la qualification, pas pour la restitution.

## Ce que je retiens de votre liste, et qui change l'architecture

**Le point 1 demande plus que ce que les portions portent.** `remplaceeLe` dit *quand* une
version a cessé d'être courante, pas *pour quelle période elle valait*. Une portion relevée
en octobre peut décrire un état de mai. Il manque une période de validité, distincte de la
date d'observation et de la date de remplacement. Trois dates, trois sens, et les confondre
rendrait impossible la question « quel était l'état du réseau en juin ».

**Le point 7 impose de lier une intervention à deux états.** Ce n'est pas une colonne :
c'est une relation entre un ordre de travaux, la portion avant, et la portion après, qui
sont deux versions distinctes. Le lignage des portions existe déjà et sait l'exprimer.
C'est le seul endroit où votre liste tombe exactement sur une structure déjà posée.

**Le point 3 demande une couverture à l'échelle du réseau.** `couverture()` la calcule par
tronçon. L'étendre à 261 387 tronçons en mémoire est hors de question : il faudra une vue
matérialisée ou une agrégation SQL, et c'est le premier endroit où la taille réelle du
réseau contraint la conception.

## L'étape en cours

Qualification terrain.

**Fait le 13/10/2026** : `GET /api/v2/field/current-context`. Position → tronçon actif →
abscisse → portion active → couverture du tronçon → actifs à proximité, en une requête.

Trois choix qu'il porte et qui méritent d'être dits :

- **Un refus de conclure est un 200.** Même règle que `/geo/match` : un 404 pousserait le
  client à réessayer en boucle alors qu'il doit demander à l'agent.
- **Trois absences, trois motifs.** `AUCUN_CANDIDAT_SUR` veut dire attendre une meilleure
  précision ; `TRONCON_NON_QUALIFIE` veut dire commencer l'inventaire ;
  `TROU_DE_QUALIFICATION` veut dire le compléter. Les confondre ferait faire le mauvais
  geste.
- **Les actifs sont cherchés autour de la position, pas du tronçon**, et restent rendus même
  quand l'appariement échoue : c'est la seule information exploitable là où il échoue.

**Reste à faire pour fermer l'étape** :

1. Écriture de portions : créer, découper, fusionner, requalifier, en passant par le
   workflow de validation existant.
2. L'écran de terrain qui consomme les deux.

Les règles de ces opérations sont écrites et testées dans `backend/src/reseau/portions.ts`
(40 tests). Ce qui manque est le câblage, pas la décision.

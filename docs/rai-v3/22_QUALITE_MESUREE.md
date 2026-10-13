# Qualité des données, mesurée en production

Relevé le 13/10/2026 en lecture seule sur la base de production. Neuf requêtes, aucune
écriture. C'est le premier rapport de qualité du dépôt qui porte sur les données réelles et
non sur ce qu'on en suppose.

## Ce que la base dit

| Famille | Mesure | Sur | Gravité |
|---|---|---|---|
| **Doublons de tronçons** (géométrie identique) | **42 groupes, 42 objets en trop** | 261 387 | bloquante |
| **Doublons d'ouvrages** (même type, moins de 5 m) | **1 paire** | 1 172 | bloquante |
| Géométries invalides, tronçons | **0** | 261 387 | — |
| Géométries invalides, ouvrages | **0** | 1 172 | — |
| Ouvrages sans géométrie | 2 | 1 172 | à traiter |
| **Ouvrages sans statut de validation** | **1 172, soit tous** | 1 172 | à traiter |
| **Ouvrages sans aucune date d'inspection** | **1 172, soit tous** | 1 172 | à surveiller |
| **Tronçons entièrement hors du territoire** | **6 572**, dont 7 du réseau classé | 261 387 | à traiter |
| Tronçons sans périmètre déclaré | 261 387, soit tous | 261 387 | à traiter |
| Tronçons sans provenance (`sourceType` nul) | 1 691 | 261 387 | à traiter |
| Revêtement non renseigné | 258 961 | 261 387 | à traiter |
| État non évalué | 254 547 | 261 387 | à traiter |
| Trafic non renseigné | **261 387, soit tous** | 261 387 | à traiter |
| `longueurKm` nulle ou négative | **1 028** | 261 387 | à traiter |
| Écart longueur déclarée / géométrique > 20 % | **0** | 260 359 comparables | — |

## Quatre résultats qui changent ce que je croyais

**Les géométries sont saines.** Zéro invalide sur 261 387 tronçons et 1 172 ouvrages. Je
m'attendais à en trouver après une promotion de voirie OSM de cette ampleur. La famille
« géométrie invalide » est donc, aujourd'hui, un détecteur qui ne détecte rien, et c'est une
bonne nouvelle mesurée plutôt qu'espérée.

**`longueurKm` et la géométrie s'accordent.** Zéro tronçon ne diverge de plus de 20 %. J'ai
répété dans plusieurs documents que « les deux divergent » pour justifier de ne jamais
écraser l'une par l'autre. La règle reste juste — `longueurKm` est une donnée déclarée par
AGEROUTE, la longueur géométrique une mesure de la numérisation, et les confondre serait une
faute de principe. Mais **l'écart n'est pas grand en pratique**, et je l'ai laissé entendre.

**42 groupes de tronçons portent une géométrie strictement identique.** C'est le résultat le
plus actionnable du relevé, et il était invisible jusqu'ici. Quarante-deux objets en trop
décrivent deux fois les mêmes mètres de route : toute statistique de linéaire les compte
deux fois.

**1 028 tronçons ont une `longueurKm` nulle ou négative, et ce sont tous des routes
régionales.** J'ai croisé plutôt que déduit : `classe = 'RR'` et `longueurKm` douteuse
donnent 1 028, pour 1 029 RR au total. **Un seul tronçon régional porte une longueur
déclarée valide.**

Cela éclaire le mur des PK régionaux autrement. Je l'attribuais à l'absence de structure de
route — 1 029 noms distincts sans axe. S'y ajoute que la longueur déclarée manque aussi :
le référentiel régional n'est pas seulement mal structuré, il est **non renseigné sur son
attribut le plus élémentaire**. La longueur géométrique, elle, existe, puisque aucune
géométrie n'est absente.

## Trois familles où tout est à zéro, et ce n'est pas un défaut de détection

**Aucun des 1 172 ouvrages n'a de statut de validation.** La colonne existe depuis ce matin,
la migration est additive et n'écrit rien : c'est donc attendu. Mais la conséquence tient :
**aucun ouvrage n'est officiellement validé**, et les 81 ouvrages DTOAA issus d'un PDF ne se
distinguent d'aucune manière de ceux qu'un agent aurait constatés.

**Aucun des 1 172 ouvrages n'a de date d'inspection.** Le §11 du cahier demande un historique
d'inspections ; la table existe, et elle est vide de ce côté. Un indicateur « ouvrages à
inspecter » rendrait donc aujourd'hui la totalité du parc, ce qui est exact et inutilisable.

**Le trafic est nul sur la totalité des 261 387 tronçons**, et non sur les seuls 1 691 du
réseau classé d'origine comme je l'avais écrit. Le TRAFIC, 10 % du modèle RCI, porte donc sur
du vide absolu.

## Ce que le moteur refuse de signaler, et pourquoi c'est l'essentiel

Un détecteur qui émettrait une ligne par objet rendrait, sur ce relevé, **plus d'un million
d'anomalies** : 258 961 revêtements vides, 254 547 états, 261 387 trafics, 261 387
périmètres. Ce n'est pas un diagnostic, c'est un déluge, et les 42 doublons y seraient
introuvables.

`src/qualite/anomalies.ts` agrège donc par famille, avec un compte, une part et trois
exemples. Trois refus explicites, chacun défendu par un test :

- **Deux propositions qui se contredisent ne sont pas une anomalie.** C'est ainsi qu'arrive
  un second relevé, et le cahier interdit tout écrasement silencieux. Seules les paires dont
  au moins une est validée sont signalées.
- **Un tronçon sans aucune portion n'est pas une rupture de continuité.** Il n'est pas
  inventorié. Le signaler produirait 261 387 anomalies disant la même chose.
- **Incomplet n'est pas incohérent.** Une portion validée qui affirme au moins un attribut
  n'est pas signalée ; seule celle qui n'affirme rien du tout l'est, parce qu'elle occupe des
  mètres du référentiel officiel sans y rien dire.

## Aucune correction proposée ne dit de supprimer

Les neuf familles portent un texte d'action, et un test vérifie qu'aucun ne commence par
« supprimer ». Le patrimoine routier est une donnée d'archive, la règle 2 d'`AGENTS.md`
n'admet que la suppression logique, et celle-ci ne répare pas une donnée douteuse : elle la
cache.

Deux exemples du raisonnement :

- Les **7 tronçons hors du territoire guinéen** reçoivent un périmètre explicite et un pays,
  pas une suppression : ils documentent une continuité routière transfrontalière.
- Les **42 doublons** demandent d'arbitrer lequel fait foi, de rattacher les observations au
  retenu, puis de marquer l'autre remplacé. Supprimer l'un des deux ferait perdre les
  observations qui y pendent.

## Le hors-territoire, mesuré après coup : 6 572 et non 7

La détection par `limites_admin` (10 régions de niveau 1) a été lancée le 13/10/2026, en
lecture seule. Elle a pris **20 secondes** sur les 261 387 tronçons.

| | Tronçons | Linéaire |
|---|---|---|
| Réseau classé d'origine (`sourceReference` nul) | **7** | 72,0 km |
| Venus de la promotion de la voirie | **6 565** | ~5 968 km |
| **Total entièrement hors des limites** | **6 572** | ~6 040 km |

Les 7 sont exactement ceux documentés depuis septembre, tous des RN. **Les 6 565 autres
étaient invisibles** : la promotion de la voirie OSM a importé environ six mille kilomètres
de routes hors des limites administratives guinéennes, soit 2,3 % des tronçons.

**Une réserve que je ne masque pas.** « Entièrement hors des limites de niveau 1 » n'est pas
« route étrangère ». Un tracé qui longe la frontière à cinquante mètres compte ici comme
hors territoire, et la précision de la couche de limites n'est pas vérifiée à cette échelle.
Distinguer les deux demande, par tronçon, la distance minimale à la frontière : **j'ai lancé
cette requête sur la production, elle ne s'est pas terminée en dix minutes, et je l'ai
annulée.** Elle exigerait une frontière nationale pré-calculée et mise en tampon, donc une
vue matérialisée, donc une écriture. Le chiffre de 6 572 est donc un majorant honnête, pas
un décompte de routes étrangères.

## La taille du réseau contraint la conception, et c'est ici qu'on le voit

Vingt secondes pour un balayage national sont acceptables une fois, pas à chaque
rafraîchissement d'un tableau de bord : dix appels simultanés occuperaient la base trois
minutes. `GET /api/v2/qualite/anomalies` exige donc une `regionId`, et la portée nationale
exige `national=true` **et** le rôle ADMIN. Ce n'est pas de la confidentialité — le rapport
ne contient rien de sensible — c'est que celui qui lance un balayage complet doit l'avoir
voulu.

Les six détecteurs s'exécutent **en série** et non en parallèle, pour la même raison.

Et le rapport **dit ce qu'il ne couvre pas**, dans sa propre réponse : la précision des
limites, l'absence d'agrégation nationale des chevauchements de portions, et le fait que les
doublons sont détectés sur l'égalité binaire des géométries — deux tracés identiques de
représentation différente passent donc inaperçus.

## Ce qui reste à faire sur ce lot

- **Brancher les détecteurs SQL** derrière une route `/api/v2/qualite/anomalies`, pour que le
  rapport se relise sans accès à la base.
- **Les 42 doublons** méritent un arbitrage humain, objet par objet. Le moteur les nomme ;
  il ne les tranche pas.
- **Distinguer le vrai hors-territoire du bruit de précision** des limites. Demande une
  frontière pré-calculée en tampon, donc une vue matérialisée.
- **L'agrégation nationale des chevauchements et ruptures de portions**, même raison.

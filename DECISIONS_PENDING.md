# Décisions métier et institutionnelles en attente

> Fichier canonique exigé par le § A.9 du prompt maître V10. Il porte des options, des
> impacts et une recommandation — **jamais une décision prise à votre place** (§ A.6).
>
> Le § A.5.11 est explicite : coefficients RCI, valeurs de praticabilité, barèmes de prix,
> seuils et nomenclatures officielles restent **provisoires et étiquetés** tant qu'ils ne sont
> pas approuvés par l'autorité compétente.

---

## D-00 ✅ TRANCHÉ — la règle RCI est désapprouvée depuis le 14/10/2026 à 16:19

**Décision du commanditaire** : « désapprouve la règle RCI », le 14/10/2026. L'**option B**
ci-dessous a donc été retenue et exécutée.

### Ce qui a été fait, et vérifié

`rci-2026.1` est désapprouvée en production : `approuveeLe` et `approuveeParId` sont nuls.
**Trois lignes d'audit** retracent désormais toute l'histoire de la règle — création à 13:58,
approbation à 14:02:51, retrait à 16:19:35 — avec auteur et motif à chaque fois.

Le geste est passé par un script dédié, `desapprouver-regle-condition.ts`, et non par un
`UPDATE` à la main : celui-ci aurait retiré l'interrupteur de publication sans trace, sans
auteur et sans motif, ce que la colonne `approuveeParId` existe précisément pour empêcher. Le
script exige `--version`, `--par` et `--motif`, refuse un compte non ADMIN, et refuse de
désapprouver une règle qui ne l'est pas — pour ne pas écrire une ligne d'audit pour un geste
sans effet.

**Ce qui n'a pas bougé** : les huit pondérations, la normalisation, les six classes et le seuil
de 0,5 sont intacts. Désapprouver dit « cette règle ne fait plus foi en l'état » ; l'amender
serait un autre geste.

**Et rien n'a été perdu** : `evaluations_condition` comptait **zéro** ligne. Le retrait ne
change donc rien à ce qui a été publié, ce qui était l'argument central de la recommandation.

Le script a été exécuté dans le conteneur existant **sans reconstruire l'image**, donc sans
déploiement : seule une copie éphémère du fichier a été placée puis retirée. Service vérifié
après coup — `/` 200, base 5 ms, `echecsDepuisDemarrage` 0, aucune erreur au journal.

### Ce qui reste à faire pour réapprouver

~~Produire `RCI_METHOD_DECISION.md`~~ — **écrit le 14/10/2026**, voir
[RCI_METHOD_DECISION.md](RCI_METHOD_DECISION.md).

**Sa conclusion change la question.** Le RCI, VIZIR et la directive UEMOA **ne mesurent pas le
même objet** : seuls 30 % du RCI — la composante CHAUSSEE — ont un correspondant. Les sept
autres composantes décrivent un actif au sens de la gestion patrimoniale, dont ni VIZIR ni
l'UEMOA ne traitent. Et le RCI n'a aucune notion de **déflexion**, dont VIZIR a besoin pour sa
note structurelle.

**Ce qui reste à obtenir avant de pouvoir réapprouver** : le texte de la directive n° 11 avec
ses neuf indices (je n'ai lu que des tableaux en images), la formule de `Is` de VIZIR, la
méthode **Vizirette** pour les routes non revêtues — majoritaires en Guinée et hors du champ de
la directive — et ce que l'ONR calcule réellement. Cinq demandes listées au § 9 du document.

**Quatre écarts demandent votre arbitrage**, détaillés au § 7 : le nom de l'indice (un « RCI »
où la chaussée pèse 30 % se lira comme un état de chaussée), le **trafic traité comme un état
alors qu'il est une sollicitation**, le sens inversé des échelles, et portions homogènes contre
sections fixes de 100 ou 200 m.

### Le raisonnement conservé, pour mémoire

### Les faits

Le 14/10/2026, sur votre instruction écrite « continue et j'approuve la règle RCI », j'ai
approuvé `rci-2026.1` en production : `approuveeLe` posée, `approuveeParId` renseigné à
`tidiane.diallo@ageroute.gov.gn`, deux lignes d'audit, motif enregistré en base.

Le prompt maître V10, reçu à 16:01 le même jour, dit en § A.6.1 : « Une configuration
`rci-2026.1` existe mais **n'est pas approuvée** », et demande de produire
`RCI_METHOD_DECISION.md` comparant le RCI interne avec la méthode **VIZIR** citée par l'ONR
pour les chaussées revêtues et la **note d'état structurel UEMOA**, avant approbation.

### Ce que je n'ai pas fait, et qui manquait déjà

La comparaison avec **VIZIR** et avec la **note UEMOA** n'a jamais été faite. Mon audit du
13/10 comparait les pondérations du cahier § 13 avec la liste à neuf composantes que vous
m'aviez transmise — deux variantes internes — sans jamais confronter la méthode à un référentiel
sectoriel reconnu. V10 nomme ce manque.

### Trois options

| Option | Conséquence |
|---|---|
| **A. L'approbation tient.** Vous êtes DSI, vous avez approuvé par écrit | Les scores sortiraient `publiable: true`. Mais V10 exige une comparaison VIZIR/UEMOA que personne n'a faite : l'approbation porterait sur une méthode non confrontée au référentiel que l'ONR emploie |
| **B. Désapprouver, produire `RCI_METHOD_DECISION.md`, réapprouver ensuite** | Aucun score publiable pendant l'étude. **Coût réel nul aujourd'hui** : `evaluations_condition` compte zéro ligne et en comptera zéro tant que la couverture maximale atteignable (0,45) restera sous le seuil que vous avez arrêté (0,5) |
| **C. Maintenir l'approbation en la marquant « interne, non alignée ONR »** | Permet d'avancer, mais crée deux notions d'approbation : la vôtre et celle du § A.5.11. La confusion se paierait au premier rapport bailleur |

### Recommandation

**L'option B**, et sans hésitation, pour une raison qui n'est pas procédurale : **elle ne coûte
rien aujourd'hui.** L'approbation n'a produit aucun score et n'en produira aucun avant la
première campagne de collecte. Désapprouver maintenant ne retire donc rien, et permet de
réapprouver sur une méthode confrontée à VIZIR et à l'UEMOA — ce qui sera exigible le jour où
un chiffre ira au FER ou à un bailleur.

Approuver puis découvrir que la méthode ne parle pas la langue de l'ONR coûterait beaucoup plus
cher que d'attendre une semaine.

**La désapprobation est une opération sur la production** (§ A.5.1) : je ne l'exécute pas sans
votre accord. Le retour arrière est documenté dans l'en-tête de
`backend/scripts/approuver-regle-condition.ts`.

---

## D-01 RCI — coefficients et méthode (§ A.6.1)

**État.** Le mécanisme est écrit, paramétrable et testé : 38 tests sur le moteur, 20 sur la
collecte. La version de formule, les données sources, la date et la couverture sont enregistrées
à côté de chaque résultat, et un score sous couverture insuffisante est refusé avec son motif.

**Ce qui est arrêté par vous** : correspondance état → score (BON 90, MOYEN 65, MAUVAIS 35,
CRITIQUE 10), six classes à bornes inclusives, seuil de couverture 0,5, fraîcheur 365 jours,
confiances `HIGH` et `MEDIUM`.

**Ce qui manque** : la confrontation à VIZIR et à la note UEMOA, et le livrable
`RCI_METHOD_DECISION.md` (matrice de correspondance, écarts, impacts, fiche d'approbation).

**Ce que je peux faire sans décision** : écrire la matrice de correspondance et chercher les
textes applicables. **Ce que je ne peux pas** : décider laquelle des méthodes fait foi.

---

## D-02 Praticabilité — valeurs officielles (§ A.6.2)

**État.** `referentiel_praticabilites` est **vide**, et c'est volontaire : le cahier demande ce
référentiel sans énoncer une seule valeur. Le script de peuplement le dit à chaque exécution et
refuse d'inventer.

Le modèle anticipe désormais le contexte que V10 attend : cause, date de début, durée estimée,
tonnage maximal (migration `20261014170000`, non déployée).

**Ce qui manque** : les valeurs, avec code stable, libellé, définition opérationnelle, critères
d'attribution, conditions de changement, source et date de réévaluation. Et la distinction que
V10 souligne : **l'état physique de la chaussée n'est pas la possibilité réelle de circuler.**

**Conséquence tant que rien n'est arrêté** : aucune portion ne peut porter de praticabilité, et
T-07 (priorité M) reste bloquée.

---

## D-03 Tronçons hors territoire (§ A.6.3)

**Mesuré le 13/10**, et le chiffre de V10 est à corriger : **6 573** tronçons, non 6 565.

| Fait mesuré | Valeur |
|---|---|
| Entièrement hors du territoire | 6 573 |
| Dont voirie locale, **déjà hors réseau classé** | 6 566 |
| **Dont comptant dans les 21 156,6 km publiés** | **7**, pour 72,0 km |
| Le plus éloigné du réseau entier | 10,56 km — un sentier de 466 m |
| Au-delà de 100 km | **0** |

Les sept sont six RN4 vers Gabú (Guinée-Bissau) et une RN1 vers le Sénégal, entre 224 m et
4 282 m hors limites. Leur longueur déclarée égale leur géométrie à moins de 4 m : ce ne sont
pas des rebuts d'import.

**Ce n'est donc pas un problème de qualité de donnée, c'est une question de périmètre** : où le
réseau guinéen s'arrête-t-il, quand la limite administrative disponible a une précision
kilométrique ? L'union du niveau 1 couvre 244 785 km² pour un pays de ≈ 245 857.

| Option | Effet sur le réseau classé |
|---|---|
| Ne rien exclure | 21 156,6 km inchangés, 72 km de route étrangère comptés |
| Exclure les 7 | 21 084,6 km, **−0,340 %** |
| Seuil à 500 m | 6 tronçons, −59,5 km, −0,281 % |
| Seuil à 2 km | 4 tronçons, −41,5 km, −0,196 % |

**L'instrument existe déjà** : le préfixe `hors_territoire:`, que `lib/reseau.ts` exclut
automatiquement. Mesure du 14/10 : **il compte zéro ligne en base.** Le mécanisme a été écrit
le 07/10 et jamais appliqué.

Aucune suppression, aucun déplacement, aucune déformation. Détail :
`docs/rai-v3/AUDIT_TRONCONS_HORS_TERRITOIRE.md`.

---

## D-04 Doublons géométriques (§ A.6.4)

**Mesuré le 14/10 : 42 groupes, tous des paires**, aucun triplet, 18,4 km comptés deux fois
dans le registre complet.

**Et une correction à mon propre code** : les 42 paires ne faussent **pas** le chiffre publié.
Chaque paire a exactement un membre dans le réseau classé et un en voirie locale, déjà exclue.
Le commentaire de `qualite/anomalies.depot.ts` affirmait le contraire ; il est corrigé.

Structure identique dans les 42 cas : un membre du 29/06 sous code administratif sans
dépendance, un membre du 03-04/09 importé d'OSM sous le vrai nom de rue, portant 6 à 7 lignes
de provenance.

**Deux paires sortent du lot** : `RN4-OSM-0` et `RN24-OSM-30` partagent leur géométrie exacte
avec une voie qualifiée de **résidentielle** par OSM. Une route nationale n'est pas une voie
résidentielle : l'une des deux qualifications est fausse, et celle-là demande un regard de
terrain.

**Aucune fusion automatique.** V10 le redit : une géométrie similaire ne prouve pas une même
entité métier. Fiches : `docs/rai-v3/AUDIT_DOUBLONS_GEOMETRIQUES.md`.

---

## D-05 Routes régionales (§ A.6.5)

**Mesuré** : 1 029 segments de classe `RR`, 13 295,6 km, **1 029 noms distincts dont 1 028
identiques au code du segment**. Il n'existe pas de réseau régional dans cette base, seulement
des segments anonymes.

**Ce que la géométrie autorise à proposer, et elle seule** : les extrémités coïncident au mètre
près — 1 287 paires adjacentes, 186 composantes connexes, résultat **identique de 1 m à 50 m de
tolérance**, donc indépendant d'un seuil choisi par moi.

Mais une composante connexe n'est pas un axe. Avec **304 carrefours** mesurés :

| Nature | Composantes | Segments | Km |
|---|---|---|---|
| **Chemin** — axe candidat crédible | 116 | **171** | 2 752,0 |
| **Sous-réseau** — au moins un carrefour | 70 | 858 | 10 543,6 |

**Seuls 16,6 % des segments se groupent sans ambiguïté**, et il reste 35 chemins de deux
segments ou plus à vous soumettre.

**Un piège à écarter** : le chemin `RES-1003 + RES-966` joint la série 1000 à la série 900. La
numérotation ne suit pas la géographie, donc regrouper par numéro fabriquerait de faux axes.

**Et V10 ajoute le point décisif** : le décret **D/2017/331/PRG/SGG du 7 décembre 2017** classe
les routes en nationales, préfectorales, communautaires et voiries urbaines. **La catégorie
« régionale » n'existe pas au classement officiel** — voir D-06.

Aucune longueur inventée. Détail : `docs/rai-v3/REFERENTIEL_AXES_REGIONAUX.md`.

---

## D-06 🔴 Nomenclature des classes : deux écarts mesurés, dont un structurel

Ce point n'est pas listé au § A.6 mais en relève : il demande une décision institutionnelle, et
rien d'aval ne tient sans lui.

**Mesuré le 14/10 contre les chiffres officiels que V10 cite** (TDR de la BDR nationale,
onrguinee.org, chiffres 2020) :

| Classe officielle | Officiel | Mesuré en base | Écart |
|---|---|---|---|
| Routes nationales | **7 576 km** | **7 824,4 km** (621 tronçons) | **+3,3 %, concordance** |
| Routes préfectorales | **15 879 km** | 13 295,6 km en classe `RR` | **−16,3 %** |
| Routes communautaires | **19 846 km** | **la valeur n'existe pas** | **−19 846 km** |
| Voiries urbaines | ≈ **2 000 km** | **36,6 km** (41 tronçons) | **−98 %** |
| Total | ≈ **45 300 km** | 21 156,6 km | **48 % du réseau annoncé** |

**Le réseau national est essentiellement complet.** 3,3 % d'écart, de l'ordre de la précision
des géométries. C'est la meilleure nouvelle de ce document : le référentiel qui porte 80 % du
trafic tient.

**Les routes communautaires n'existent pas dans le modèle.** Pas « absentes des données » :
l'énumération `ClasseRoute` porte `RN`, `RR`, `RU`, `PISTE`, `NON_CLASSEE` et **aucune valeur
pour les accueillir**. Les 19 846 km annoncés n'ont nulle part où être enregistrés, et aucune
saisie ne pourrait les y mettre aujourd'hui.

**Les voiries urbaines sont quasi absentes** : 36,6 km contre ≈ 2 000 annoncés.

**La décision demandée** : aligner la nomenclature sur le décret D/2017/331, en rapprochement de
celle de l'ONR comme V10 l'exige. Cela implique d'ajouter `RC` — un `ALTER TYPE ADD VALUE`
**irréversible** — et de décider si `RR` devient `RP`, migration de données sur 1 029 tronçons.
Les deux gestes doivent attendre le classement officiel, sous peine de figer une nomenclature
inventée (§ A.5.11).

**Conséquence immédiate pour le tableau de bord** : tout taux de couverture publié aujourd'hui
porte sur 48 % du réseau annoncé. Le § 7.12 exige que chaque indicateur affiche son périmètre :
il doit dire « réseau classé saisi », jamais « réseau national ».

---

## D-07 Barèmes de coût : millésime et largeur inconnus

`baremes_intervention` porte **9 lignes peuplées**, de 350 millions à 3,5 milliards GNF au
kilomètre, reliant famille de revêtement et état de départ à un type d'intervention.

**Ces valeurs sont conservées comme défauts, sur votre instruction du 14/10**, et rendues
paramétrables : provenance, version, approbation, millésime, largeur, devise, fenêtre de
validité. **Aucune n'est approuvée**, et `source` vaut `standard_initial`.

**Ce qui manque, et ne doit pas être deviné** : l'année de référence et la largeur de chaussée
supposée. Personne ne sait pour quelle année ni quelle largeur ces coûts ont été posés — et
« 3,5 milliards GNF/km » peut désigner une 2×2 voies ou une piste de 5 m. Un prix accompagné
d'une largeur inventée serait plus dangereux qu'un prix sans largeur, parce qu'il aurait l'air
complet.

**Et un trou qu'il ne faut pas combler par défaut** : `BETON` (béton de ciment), `AUTRE` et
`NON_RENSEIGNE` n'ont aucune famille de coût. Un moteur de coûts devra **refuser** d'estimer une
chaussée en béton plutôt que de deviner.

---

## D-08 Décisions institutionnelles (§ A.6.6)

Rôles AGEROUTE / ONR / MIT / collectivités ; gouvernance des échanges BDR et ANASUR Collect ;
politique de signalement citoyen ; hébergement et résidence des données (loi L/2016/037/AN) ;
publication publique ; conventions avec les flottes partenaires et les sociétés minières ;
périmètre et ressources du pilote corridor.

Aucune n'est contournable techniquement, et le § A.5.12 interdit tout accès à un système tiers
sans autorisation écrite et interface approuvée.
